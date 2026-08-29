import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, type Stats } from 'node:fs'
import { constants, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { writeFileAtomic } from '../../utils/atomicWrite.js'
import { decodeHostedControlAuthority, decodeHostedTaskMutationCommand, fingerprintHostedTaskCommand } from './protocol.js'
import type { HostedControlAuthority, HostedTaskMutationCommand, HostedTaskMutationCommittedResult, HostedTaskMutationReceipt } from './protocol.js'

const MAX_WAL_BYTES = 8 * 1024 * 1024
const PROCESS_START_IDENTITY = readProcessStartIdentity(process.pid) ??
  `start_${createHash('sha256').update(`${process.pid}\0${Math.floor(Date.now() - process.uptime() * 1000)}`).digest('hex')}`
export const HOSTED_MUTATION_RETRY_AFTER_MS = 5_000
export type HostedMutationDedupeScope = { teamId: string; sourceGeneration: string; idempotencyKey: string }
export type HostedMutationFileImage = { existed: boolean; sha256: string | null; contentBase64: string | null; stat?: { device: number; inode: number; size: number; mtimeMs: number } }
export type HostedMutationWrite = { target: string; before: HostedMutationFileImage; after: HostedMutationFileImage }
export type HostedMutationIntent = {
  recordType: 'intent'; walId: string; createdAtMs: number; scope: HostedMutationDedupeScope
  commandId: string; payloadFingerprint: string; expectedRevision: string
  committedResult: HostedTaskMutationCommittedResult; writes: HostedMutationWrite[]
  directories: { team: [number, number]; tasks: [number, number] }
  taskMembership: string[]
  rosterGuard: string
  fenceToken: string
  authority: HostedControlAuthority
  command: HostedTaskMutationCommand
  canonicalScope: { claudeRoot: string; teamDirectory: string; tasksDirectory: string }
}
type Prepared = { schemaVersion: 3; phase: 'prepared'; intent: HostedMutationIntent }
type Terminal = { schemaVersion: 3; phase: 'terminal'; intent: HostedMutationIntent; completedAtMs: number; result: HostedTaskMutationCommittedResult }
type State = Prepared | Terminal
export type HostedMutationWalLookup = { kind: 'none' } | { kind: 'ambiguous'; intent: HostedMutationIntent } | { kind: 'terminal'; intent: HostedMutationIntent; result: HostedTaskMutationCommittedResult }

export async function fsyncDirectoryPath(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
  try { const stat = await handle.stat(); if (!stat.isDirectory()) throw new Error('Unsafe fsync directory'); await handle.sync() } finally { await handle.close() }
}
export async function fsyncFileAndParent(path: string): Promise<void> {
  const parentPath = dirname(path)
  const parent = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
  try {
    const parentIdentity = await parent.stat()
    if (!parentIdentity.isDirectory()) throw new Error('Unsafe fsync directory')
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const fileIdentity = await handle.stat()
      const [currentFile, currentParent] = await Promise.all([lstat(path), lstat(parentPath)])
      if (!fileIdentity.isFile() || !currentFile.isFile() || currentFile.isSymbolicLink() ||
        currentFile.dev !== fileIdentity.dev || currentFile.ino !== fileIdentity.ino ||
        !currentParent.isDirectory() || currentParent.isSymbolicLink() ||
        currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) {
        throw new Error('Hosted fsync path was substituted')
      }
      await handle.sync()
      await parent.sync()
    } finally { await handle.close() }
  } finally { await parent.close() }
}

export type HostedTaskMutationWalOptions = {
  processIdentity?: { processInstanceId: string; processStartIdentity: string }
  isProcessIdentityAlive?: (pid: number, processStartIdentity: string) => boolean
  getProcessStartIdentity?: (pid: number) => string | null
}

export class HostedTaskMutationWal {
  readonly #path: string
  readonly #fencePath: string
  #activeFenceToken: string | null = null
  #activeFenceIdentity: { device: number; inode: number } | null = null
  readonly #processInstanceId: string
  readonly #processStartIdentity: string
  readonly #isProcessIdentityAlive: (pid: number, processStartIdentity: string) => boolean
  constructor(private readonly directory: string, private readonly teamId: string, options: string | HostedTaskMutationWalOptions = {}) {
    const identity = typeof options === 'string'
      ? { processInstanceId: options, processStartIdentity: defaultProcessStartIdentity() }
      : options.processIdentity ?? { processInstanceId: `process_${randomUUID()}`, processStartIdentity: defaultProcessStartIdentity() }
    this.#processInstanceId = identity.processInstanceId
    this.#processStartIdentity = identity.processStartIdentity
    this.#isProcessIdentityAlive = typeof options === 'string'
      ? processIdentityAlive
      : options.isProcessIdentityAlive ?? ((pid, recorded) => {
        const current = (options.getProcessStartIdentity ?? readProcessStartIdentity)(pid)
        return current !== null && current === recorded
      })
    this.#path = join(directory, 'hosted-task-board-mutation.wal.v1.json')
    this.#fencePath = join(directory, 'hosted-task-board-mutation.fence.v1.json')
  }
  get path(): string { return this.#path }
  get fencePath(): string { return this.#fencePath }
  async ownsActiveFence(): Promise<boolean> {
    if (!this.#activeFenceToken || !this.#activeFenceIdentity) return false
    const handle = await open(this.#fencePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null); if (!handle) return false
    try {
      const stat = await handle.stat(); const current = await lstat(this.#fencePath).catch(() => null)
      if (!isPrivateOwnedFile(stat) || !current?.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || stat.dev !== this.#activeFenceIdentity.device || stat.ino !== this.#activeFenceIdentity.inode) return false
      const value = JSON.parse(await handle.readFile('utf8')) as { nonce?: string; teamId?: string; pid?: number; processInstanceId?: string; processStartIdentity?: string }
      return value.nonce === this.#activeFenceToken && value.teamId === this.teamId && value.pid === process.pid && value.processInstanceId === this.#processInstanceId && value.processStartIdentity === this.#processStartIdentity
    } catch { return false } finally { await handle.close() }
  }
  async matchesIntent(intent: HostedMutationIntent): Promise<boolean> { const state = await this.#read(); return !!state && isDeepStrictEqual(state.intent, intent) }

  async withFence<T>(action: () => Promise<T>): Promise<T | undefined> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await assertPrivateDirectory(this.directory)
    const nonce = randomUUID()
    const record = { schemaVersion: 2 as const, teamId: this.teamId, nonce, pid: process.pid, processInstanceId: this.#processInstanceId, processStartIdentity: this.#processStartIdentity, acquiredAtMs: Date.now() }
    let handle = await this.#acquireFence(nonce, record)
    if (!handle) return undefined
    try {
      const fenceStat = await handle.stat()
      if (!isPrivateOwnedFile(fenceStat)) throw new Error('Unsafe hosted fence')
      this.#activeFenceIdentity = { device: fenceStat.dev, inode: fenceStat.ino }
      await fsyncDirectoryPath(this.directory)
      this.#activeFenceToken = nonce
      return await action()
    } finally {
      this.#activeFenceToken = null
      await handle?.close(); handle = undefined
      const identity = this.#activeFenceIdentity; this.#activeFenceIdentity = null
      const current = await readNoFollowFile(this.#fencePath).catch(() => null)
      let ownsPath = false
      try { const value = JSON.parse(current?.text ?? '') as { nonce?: string; teamId?: string; processInstanceId?: string; processStartIdentity?: string }; ownsPath = !!identity && current?.device === identity.device && current.inode === identity.inode && value.nonce === nonce && value.teamId === this.teamId && value.processInstanceId === this.#processInstanceId && value.processStartIdentity === this.#processStartIdentity } catch {}
      if (ownsPath) { await unlink(this.#fencePath).catch(() => {}); await fsyncDirectoryPath(this.directory) }
    }
  }
  async #acquireFence(nonce: string, record: Record<string, unknown>) {
    const published = await this.#publishFence(nonce, record)
    if (published) return published
    const handle = await open(this.#fencePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null)
    if (!handle) return null
    let stale = false; let before
    try {
      before = await handle.stat(); const current = await lstat(this.#fencePath).catch(() => null)
      if (!isPrivateOwnedFile(before) || !current?.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) return null
      const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>
      exactKeys(value, ['schemaVersion', 'teamId', 'nonce', 'pid', 'processInstanceId', 'processStartIdentity', 'acquiredAtMs'], 'fence')
      if (value.schemaVersion !== 2 || value.teamId !== this.teamId || typeof value.nonce !== 'string' || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.acquiredAtMs !== 'number' || !Number.isFinite(value.acquiredAtMs) || typeof value.processInstanceId !== 'string' || typeof value.processStartIdentity !== 'string') return null
      if (Date.now() - value.acquiredAtMs < HOSTED_MUTATION_RETRY_AFTER_MS || this.#isProcessIdentityAlive(value.pid as number, value.processStartIdentity)) return null
      stale = true
    } catch { return null } finally { await handle.close() }
    if (!stale || !before) return null
    const quarantine = `${this.#fencePath}.stale.${nonce}`
    try { await rename(this.#fencePath, quarantine) } catch { return null }
    const moved = await lstat(quarantine).catch(() => null)
    if (!moved || moved.dev !== before.dev || moved.ino !== before.ino) {
      const sentinel = await open(this.#fencePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600).catch(() => null)
      if (sentinel) { try { await sentinel.writeFile(JSON.stringify({ schemaVersion: 1, teamId: this.teamId, ambiguous: true })) ; await sentinel.sync() } finally { await sentinel.close() }; await fsyncDirectoryPath(this.directory) }
      return null
    }
    // Keep the inode-stable quarantine as crash/audit evidence. Deleting by path
    // after validation would reopen a substitution race against an attacker.
    await fsyncDirectoryPath(this.directory)
    return this.#publishFence(nonce, record)
  }
  async #publishFence(nonce: string, record: Record<string, unknown>) {
    const temporary = `${this.#fencePath}.candidate.${nonce}`
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      await handle.writeFile(JSON.stringify(record))
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    await handle.close()
    try {
      await link(temporary, this.#fencePath)
      await fsyncDirectoryPath(this.directory)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw error
    }
    await unlink(temporary)
    await fsyncDirectoryPath(this.directory)
    return open(this.#fencePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  }
  async lookup(scope: HostedMutationDedupeScope): Promise<HostedMutationWalLookup> {
    const state = await this.#read(); if (!state || key(state.intent.scope) !== key(scope)) return { kind: 'none' }
    return state.phase === 'prepared' ? { kind: 'ambiguous', intent: state.intent } : { kind: 'terminal', intent: state.intent, result: state.result }
  }
  async listAmbiguous(): Promise<HostedMutationIntent[]> { const state = await this.#read(); return state?.phase === 'prepared' ? [state.intent] : [] }
  async appendIntent(input: Omit<HostedMutationIntent, 'recordType' | 'walId' | 'createdAtMs' | 'fenceToken'>): Promise<HostedMutationIntent> {
    const existing = await this.#read(); if (existing?.phase === 'prepared') throw new Error('Prepared hosted mutation requires recovery')
    if (!this.#activeFenceToken || !(await this.ownsActiveFence())) throw new Error('Hosted WAL prepare requires active fence')
    const intent: HostedMutationIntent = { recordType: 'intent', walId: randomUUID(), createdAtMs: Date.now(), ...input, fenceToken: this.#activeFenceToken }
    await this.#write({ schemaVersion: 3, phase: 'prepared', intent }); return intent
  }
  async appendTerminal(walId: string, result: HostedTaskMutationCommittedResult): Promise<void> {
    if (!this.#activeFenceToken || !(await this.ownsActiveFence())) throw new Error('Hosted WAL terminal requires active fence')
    const state = await this.#read(); if (!state || state.intent.walId !== walId || !isDeepStrictEqual(state.intent.committedResult, result)) throw new Error('Hosted WAL identity changed')
    await this.#write({ schemaVersion: 3, phase: 'terminal', intent: state.intent, completedAtMs: Date.now(), result })
  }
  async #write(state: State): Promise<void> {
    const text = JSON.stringify(state); if (Buffer.byteLength(text) > MAX_WAL_BYTES) throw new Error('Hosted WAL exceeds 8MiB')
    if (!(await this.ownsActiveFence())) throw new Error('Hosted WAL write requires active fence')
    await assertPrivateDirectory(this.directory)
    await writeFileAtomic(this.#path, text, { mode: 0o600 }); await fsyncFileAndParent(this.#path)
  }
  async #read(): Promise<State | null> {
    const handle = await open(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }); if (!handle) return null
    let text: string; try {
      await assertPrivateDirectory(this.directory)
      const stat = await handle.stat(); const current = await lstat(this.#path)
      if (!isPrivateOwnedFile(stat) || !current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('Unsafe hosted WAL')
      if (stat.size > MAX_WAL_BYTES) throw new Error('Hosted WAL exceeds 8MiB')
      text = await handle.readFile('utf8')
    } finally { await handle.close() }
    if (Buffer.byteLength(text) > MAX_WAL_BYTES) throw new Error('Hosted WAL exceeds 8MiB')
    return decodeWalState(JSON.parse(text), this.teamId)
  }
}
function key(scope: HostedMutationDedupeScope): string { return `${scope.teamId}\0${scope.sourceGeneration}\0${scope.idempotencyKey}` }
function processIdentityAlive(pid: number, processStartIdentity: string): boolean {
  const current = readProcessStartIdentity(pid)
  return current !== null && current === processStartIdentity
}
function readProcessStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    // Linux field 22 is the kernel start tick and is invariant for the lifetime
    // of a process, including across PID reuse.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    const startTicks = afterCommand[19]
    if (startTicks && /^\d+$/.test(startTicks)) return hashProcessStart(pid, `proc:${startTicks}`)
  } catch {}
  try {
    // macOS and other POSIX hosts expose the immutable process start timestamp.
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    }).trim()
    return started ? hashProcessStart(pid, `ps:${started}`) : null
  } catch { return null }
}
function hashProcessStart(pid: number, source: string): string {
  return `start_${createHash('sha256').update(`${pid}\0${source}`).digest('hex')}`
}
function defaultProcessStartIdentity(): string {
  return PROCESS_START_IDENTITY
}
function isPrivateOwnedFile(stat: Stats): boolean { return stat.isFile() && (stat.mode & 0o077) === 0 && (process.getuid?.() === undefined || stat.uid === process.getuid?.()) }
async function assertPrivateDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)); try { const stat = await handle.stat(); const current = await lstat(path); if (!stat.isDirectory() || !current.isDirectory() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || (stat.mode & 0o022) !== 0 || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) throw new Error('Unsafe hosted WAL directory') } finally { await handle.close() } }
async function readNoFollowFile(path: string): Promise<{ text: string; device: number; inode: number }> { const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { const stat = await handle.stat(); const current = await lstat(path); if (!isPrivateOwnedFile(stat) || !current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('Unsafe hosted file'); return { text: await handle.readFile('utf8'), device: stat.dev, inode: stat.ino } } finally { await handle.close() } }

function object(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid hosted WAL ${name}`); return value as Record<string, unknown> }
function exactKeys(value: Record<string, unknown>, keys: string[], name: string): void { const a = Object.keys(value).sort(); const b = [...keys].sort(); if (a.length !== b.length || a.some((key, index) => key !== b[index])) throw new Error(`Invalid hosted WAL ${name} keys`) }
function str(value: unknown, name: string, pattern?: RegExp): string { if (typeof value !== 'string' || (pattern && !pattern.test(value))) throw new Error(`Invalid hosted WAL ${name}`); return value }
function integer(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid hosted WAL ${name}`); return value as number }
function tuple(value: unknown, name: string): [number, number] { if (!Array.isArray(value) || value.length !== 2) throw new Error(`Invalid hosted WAL ${name}`); return [integer(value[0], name), integer(value[1], name)] }
function decodeImage(value: unknown): HostedMutationFileImage {
  const image = object(value, 'image'); const hasStat = Object.hasOwn(image, 'stat'); exactKeys(image, ['existed', 'sha256', 'contentBase64', ...(hasStat ? ['stat'] : [])], 'image')
  if (typeof image.existed !== 'boolean') throw new Error('Invalid hosted WAL image.existed')
  if (!image.existed) { if (image.sha256 !== null || image.contentBase64 !== null || hasStat) throw new Error('Invalid hosted WAL missing image'); return { existed: false, sha256: null, contentBase64: null } }
  const sha256 = str(image.sha256, 'image.sha256', /^[0-9a-f]{64}$/); const contentBase64 = str(image.contentBase64, 'image.contentBase64', /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  if (createHash('sha256').update(Buffer.from(contentBase64, 'base64')).digest('hex') !== sha256) throw new Error('Invalid hosted WAL image hash')
  let stat: HostedMutationFileImage['stat']; if (hasStat) { const raw = object(image.stat, 'image.stat'); exactKeys(raw, ['device', 'inode', 'size', 'mtimeMs'], 'image.stat'); stat = { device: integer(raw.device, 'device'), inode: integer(raw.inode, 'inode'), size: integer(raw.size, 'size'), mtimeMs: typeof raw.mtimeMs === 'number' && Number.isFinite(raw.mtimeMs) ? raw.mtimeMs : (() => { throw new Error('Invalid hosted WAL mtimeMs') })() } }
  return { existed: true, sha256, contentBase64, ...(stat ? { stat } : {}) }
}
function decodeReceipt(value: unknown): HostedTaskMutationReceipt { const v = object(value, 'receipt'); exactKeys(v, ['schemaVersion', 'outcome', 'commandId', 'teamId', 'sourceGeneration', 'revision', 'affectedTaskIds'], 'receipt'); if (v.schemaVersion !== 1 || v.outcome !== 'committed' || !Array.isArray(v.affectedTaskIds)) throw new Error('Invalid hosted WAL receipt'); const affectedTaskIds = v.affectedTaskIds.map(id => str(id, 'affectedTaskId', /^task_[0-9a-f]{32}$/)); if (affectedTaskIds.length > 100 || new Set(affectedTaskIds).size !== affectedTaskIds.length || affectedTaskIds.some((id, index) => index > 0 && affectedTaskIds[index - 1]! > id)) throw new Error('Invalid hosted WAL affectedTaskIds'); return { schemaVersion: 1, outcome: 'committed', commandId: str(v.commandId, 'receipt.commandId'), teamId: str(v.teamId, 'receipt.teamId'), sourceGeneration: str(v.sourceGeneration, 'receipt.sourceGeneration', /^generation_/), revision: str(v.revision, 'receipt.revision', /^revision_/), affectedTaskIds } }
function decodeCommitted(value: unknown): HostedTaskMutationCommittedResult { const v = object(value, 'committedResult'); exactKeys(v, ['kind', 'currentSourceGeneration', 'payloadFingerprint', 'receipt'], 'committedResult'); if (v.kind !== 'committed') throw new Error('Invalid hosted WAL committed kind'); return { kind: 'committed', currentSourceGeneration: str(v.currentSourceGeneration, 'currentSourceGeneration'), payloadFingerprint: str(v.payloadFingerprint, 'payloadFingerprint', /^[A-Za-z0-9_-]{43}$/), receipt: decodeReceipt(v.receipt) } }
function decodeIntent(value: unknown, teamId: string): HostedMutationIntent {
  const v = object(value, 'intent'); exactKeys(v, ['recordType', 'walId', 'createdAtMs', 'scope', 'commandId', 'payloadFingerprint', 'expectedRevision', 'committedResult', 'writes', 'directories', 'taskMembership', 'rosterGuard', 'fenceToken', 'authority', 'command', 'canonicalScope'], 'intent'); if (v.recordType !== 'intent') throw new Error('Invalid hosted WAL recordType')
  const scope = object(v.scope, 'scope'); exactKeys(scope, ['teamId', 'sourceGeneration', 'idempotencyKey'], 'scope')
  const command = decodeHostedTaskMutationCommand(v.command); const authority = decodeHostedControlAuthority(v.authority); const committedResult = decodeCommitted(v.committedResult)
  const directories = object(v.directories, 'directories'); exactKeys(directories, ['team', 'tasks'], 'directories'); const canonical = object(v.canonicalScope, 'canonicalScope'); exactKeys(canonical, ['claudeRoot', 'teamDirectory', 'tasksDirectory'], 'canonicalScope')
  if (!Array.isArray(v.taskMembership) || !Array.isArray(v.writes)) throw new Error('Invalid hosted WAL arrays')
  const intent: HostedMutationIntent = { recordType: 'intent', walId: str(v.walId, 'walId'), createdAtMs: integer(v.createdAtMs, 'createdAtMs'), scope: { teamId: str(scope.teamId, 'scope.teamId'), sourceGeneration: str(scope.sourceGeneration, 'scope.sourceGeneration'), idempotencyKey: str(scope.idempotencyKey, 'scope.idempotencyKey') }, commandId: str(v.commandId, 'commandId'), payloadFingerprint: str(v.payloadFingerprint, 'payloadFingerprint', /^[A-Za-z0-9_-]{43}$/), expectedRevision: str(v.expectedRevision, 'expectedRevision'), committedResult, writes: v.writes.map(raw => { const write = object(raw, 'write'); exactKeys(write, ['target', 'before', 'after'], 'write'); const target = str(write.target, 'write.target', /^(?:kanban|ledger|task:[A-Za-z0-9_-]+\.json)$/); return { target, before: decodeImage(write.before), after: decodeImage(write.after) } }), directories: { team: tuple(directories.team, 'team directory'), tasks: tuple(directories.tasks, 'tasks directory') }, taskMembership: v.taskMembership.map(name => str(name, 'taskMembership', /^[A-Za-z0-9_-]+\.json$/)), rosterGuard: str(v.rosterGuard, 'rosterGuard', /^[0-9a-f]{64}$/), fenceToken: str(v.fenceToken, 'fenceToken'), authority, command, canonicalScope: { claudeRoot: str(canonical.claudeRoot, 'claudeRoot'), teamDirectory: str(canonical.teamDirectory, 'teamDirectory'), tasksDirectory: str(canonical.tasksDirectory, 'tasksDirectory') } }
  const targets = intent.writes.map(write => write.target); const taskTargets = targets.filter(target => target.startsWith('task:'))
  if (targets.at(-1) !== 'ledger' || new Set(targets).size !== targets.length || taskTargets.some((target, index) => index > 0 && taskTargets[index - 1]! > target) || targets.some((target, index) => target.startsWith('task:') && index !== taskTargets.indexOf(target)) || targets.filter(target => target === 'kanban').length > 1 || (targets.includes('kanban') && targets.indexOf('kanban') !== targets.length - 2)) throw new Error('Invalid hosted WAL write layout')
  if (intent.scope.teamId !== teamId || command.teamId !== teamId || command.commandId !== intent.commandId || command.expectedRevision !== intent.expectedRevision || command.expectedSourceGeneration !== intent.scope.sourceGeneration || command.idempotencyKey !== intent.scope.idempotencyKey || authority.teamId !== teamId || fingerprintHostedTaskCommand(command) !== intent.payloadFingerprint || committedResult.payloadFingerprint !== intent.payloadFingerprint || committedResult.currentSourceGeneration !== intent.scope.sourceGeneration || committedResult.receipt.commandId !== command.commandId || committedResult.receipt.teamId !== teamId || committedResult.receipt.sourceGeneration !== intent.scope.sourceGeneration) throw new Error('Invalid hosted WAL binding')
  return intent
}
function decodeWalState(value: unknown, teamId: string): State { const v = object(value, 'state'); if (v.phase === 'prepared') { exactKeys(v, ['schemaVersion', 'phase', 'intent'], 'prepared'); if (v.schemaVersion !== 3) throw new Error('Invalid hosted WAL version'); return { schemaVersion: 3, phase: 'prepared', intent: decodeIntent(v.intent, teamId) } } if (v.phase === 'terminal') { exactKeys(v, ['schemaVersion', 'phase', 'intent', 'completedAtMs', 'result'], 'terminal'); if (v.schemaVersion !== 3) throw new Error('Invalid hosted WAL version'); const intent = decodeIntent(v.intent, teamId); const result = decodeCommitted(v.result); if (!isDeepStrictEqual(result, intent.committedResult)) throw new Error('Invalid hosted WAL terminal result'); return { schemaVersion: 3, phase: 'terminal', intent, completedAtMs: integer(v.completedAtMs, 'completedAtMs'), result } } throw new Error('Invalid hosted WAL phase') }
