import { createHash } from 'node:crypto'
import { constants, lstat, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import * as lockfile from '../../utils/lockfile.js'
import { fsyncFileAndParent } from './HostedTaskMutationWal.js'

const MAX_WAL_BYTES = 8 * 1024 * 1024
const LOCK_OPTIONS = { realpath: false, retries: { retries: 10, minTimeout: 5, maxTimeout: 100 } } as const

type HostedLifecycleWalAppendHandle = {
  stat(): Promise<{ isFile(): boolean; mode: number; size: number }>
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>
  truncate(length: number): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export type HostedLifecycleAuthorityWalOptions = {
  openAppend?: (path: string, flags: number, mode: number) => Promise<HostedLifecycleWalAppendHandle>
}

export type HostedLifecycleDurableAuthorization = {
  grantId: string
  authorizationGeneration: string
  deploymentId: string
  bootId: string
  resourceRevision: string
  actorId: string
  workspaceId: string
  teamId: string
  restoreGeneration: number
}
export type HostedLifecycleDurableCommand = {
  schemaVersion: 1
  action: 'launch' | 'cancel' | 'stop' | 'recover'
  commandId: string
  idempotencyKey: string
  workspaceId: string
  teamId: string
  expectedRevision: string
  runId?: string
}
export type HostedLifecycleDurableBinding = {
  actorId: string
  sessionId: string
  deploymentId: string
  bootId: string
  authorizedScope: string
  restoreGeneration: number
}
export type HostedLifecyclePublicResult = Record<string, unknown>
export type HostedLifecycleWalEntry =
  | { schemaVersion: 1; kind: 'grant'; fingerprint: string; command: HostedLifecycleDurableCommand; binding: HostedLifecycleDurableBinding; authorization: HostedLifecycleDurableAuthorization }
  | { schemaVersion: 1; kind: 'started'; fingerprint: string; command: HostedLifecycleDurableCommand; authorization: HostedLifecycleDurableAuthorization }
  | { schemaVersion: 1; kind: 'completed'; fingerprint: string; command: HostedLifecycleDurableCommand; authorization: HostedLifecycleDurableAuthorization; result: HostedLifecyclePublicResult }
  | { schemaVersion: 1; kind: 'released'; grantId: string }

export type HostedLifecycleWalState = {
  grants: Map<string, Extract<HostedLifecycleWalEntry, { kind: 'grant' }>>
  commands: Map<string, Extract<HostedLifecycleWalEntry, { kind: 'started' | 'completed' }>>
  released: Set<string>
}

export class HostedLifecycleAuthorityWal {
  readonly path: string
  readonly lockPath: string
  readonly #openAppend: NonNullable<HostedLifecycleAuthorityWalOptions['openAppend']>
  #lockHeld = false
  constructor(
    private readonly directory: string,
    private readonly teamId: string,
    options: HostedLifecycleAuthorityWalOptions = {},
  ) {
    if (!/^team_[0-9a-f]{32}$/.test(teamId)) throw new TypeError('Invalid hosted lifecycle WAL team')
    this.path = join(directory, 'hosted-lifecycle-authority.wal.v1.jsonl')
    this.lockPath = join(directory, 'hosted-lifecycle-authority.lock')
    this.#openAppend = options.openAppend ?? (async (path, flags, mode) => open(path, flags, mode))
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T | undefined> {
    await this.#prepareDirectory()
    let release: (() => Promise<void>) | undefined
    try { release = await lockfile.lock(this.lockPath, LOCK_OPTIONS) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return undefined
      throw error
    }
    try {
      // O_APPEND would otherwise place the next valid record after a corrupt
      // suffix forever. Repair only while the cross-process writer lock is held.
      await this.#repairTornTail()
      this.#lockHeld = true
      return await operation()
    } finally {
      this.#lockHeld = false
      await release()
    }
  }

  async load(): Promise<HostedLifecycleWalState> {
    const state: HostedLifecycleWalState = { grants: new Map(), commands: new Map(), released: new Set() }
    const handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!handle) return state
    try {
      const stat = await handle.stat(); const current = await lstat(this.path)
      if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() || stat.dev !== current.dev ||
        stat.ino !== current.ino || (stat.mode & 0o077) !== 0 || stat.size > MAX_WAL_BYTES) {
        throw new Error('Unsafe hosted lifecycle WAL')
      }
      const text = await handle.readFile('utf8')
      if (Buffer.byteLength(text) > MAX_WAL_BYTES) throw new Error('Hosted lifecycle WAL exceeds 8MiB')
      const lines = text.split('\n')
      // A record is durable only when its terminating newline is present. This
      // also avoids inventing a valid-looking record whose newline write tore.
      lines.pop()
      for (const line of lines) {
        if (!line) continue
        const entry = decodeEntry(JSON.parse(line), this.teamId)
        if (entry.kind === 'grant') state.grants.set(entry.authorization.grantId, entry)
        else if (entry.kind === 'released') state.released.add(entry.grantId)
        else state.commands.set(entry.command.idempotencyKey, entry)
      }
      return state
    } finally { await handle.close() }
  }

  async append(entry: HostedLifecycleWalEntry): Promise<void> {
    if (!this.#lockHeld) throw new Error('Hosted lifecycle WAL append requires writer lock')
    const line = Buffer.from(`${JSON.stringify(entry)}\n`)
    const handle = await this.#openAppend(
      this.path,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    let originalSize = 0
    try {
      const stat = await handle.stat()
      originalSize = stat.size
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size + line.byteLength > MAX_WAL_BYTES) {
        throw new Error('Unsafe or oversized hosted lifecycle WAL')
      }
      try {
        let offset = 0
        while (offset < line.byteLength) {
          const remaining = line.byteLength - offset
          const { bytesWritten } = await handle.write(line, offset, remaining)
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
            throw new Error('Hosted lifecycle WAL write did not complete')
          }
          offset += bytesWritten
        }
        await handle.sync()
      } catch (error) {
        try { await handle.truncate(originalSize); await handle.sync() } catch {}
        throw error
      }
    } finally { await handle.close() }
    await fsyncFileAndParent(this.path)
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const handle = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat(); const current = await lstat(this.directory)
      if (!stat.isDirectory() || !current.isDirectory() || current.isSymbolicLink() || stat.dev !== current.dev ||
        stat.ino !== current.ino || (stat.mode & 0o022) !== 0) throw new Error('Unsafe hosted lifecycle WAL directory')
    } finally { await handle.close() }
  }

  async #repairTornTail(): Promise<void> {
    const handle = await open(
      this.path,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    ).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!handle) return
    let repaired = false
    try {
      const stat = await handle.stat(); const current = await lstat(this.path)
      if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() || stat.dev !== current.dev ||
        stat.ino !== current.ino || (stat.mode & 0o077) !== 0 || stat.size > MAX_WAL_BYTES ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
        throw new Error('Unsafe hosted lifecycle WAL')
      }
      const bytes = await handle.readFile()
      if (bytes.length === 0 || bytes.at(-1) === 0x0a) return
      const lastNewline = bytes.lastIndexOf(0x0a)
      await handle.truncate(lastNewline + 1)
      await handle.sync()
      repaired = true
    } finally { await handle.close() }
    if (repaired) await fsyncFileAndParent(this.path)
  }
}

function decodeEntry(value: unknown, teamId: string): HostedLifecycleWalEntry {
  const raw = object(value, 'entry')
  const entry = raw as HostedLifecycleWalEntry
  if (entry.schemaVersion !== 1 || !['grant', 'started', 'completed', 'released'].includes(entry.kind)) throw new Error('Invalid hosted lifecycle WAL entry')
  if (entry.kind === 'released') {
    exact(raw, ['schemaVersion', 'kind', 'grantId'], 'release')
    pattern(entry.grantId, /^grant_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'release grant')
    return entry
  }
  exact(raw, entry.kind === 'completed'
    ? ['schemaVersion', 'kind', 'fingerprint', 'command', 'authorization', 'result']
    : entry.kind === 'started'
      ? ['schemaVersion', 'kind', 'fingerprint', 'command', 'authorization']
      : ['schemaVersion', 'kind', 'fingerprint', 'command', 'binding', 'authorization'], entry.kind)
  const command = decodeCommand(entry.command, teamId)
  const authorization = decodeAuthorization(entry.authorization, command)
  pattern(entry.fingerprint, /^[0-9a-f]{64}$/, 'fingerprint')
  if (entry.kind === 'grant') {
    const binding = decodeBinding(entry.binding)
    const expected = createHash('sha256').update(JSON.stringify({ command, binding })).digest('hex')
    if (entry.fingerprint !== expected || binding.actorId !== authorization.actorId ||
      binding.deploymentId !== authorization.deploymentId || binding.bootId !== authorization.bootId ||
      binding.restoreGeneration !== authorization.restoreGeneration) {
      throw new Error('Invalid hosted lifecycle WAL grant binding')
    }
  }
  if (entry.kind === 'completed') decodeResult(entry.result, command)
  if (entry.command?.teamId !== teamId || entry.authorization?.teamId !== teamId) {
    throw new Error('Invalid hosted lifecycle WAL scope')
  }
  return entry
}

function decodeCommand(value: unknown, teamId: string): HostedLifecycleDurableCommand {
  const raw = object(value, 'command'); const action = raw.action
  if (!['launch', 'cancel', 'stop', 'recover'].includes(String(action))) throw new Error('Invalid hosted lifecycle WAL action')
  exact(raw, action === 'launch'
    ? ['schemaVersion', 'action', 'commandId', 'idempotencyKey', 'workspaceId', 'teamId', 'expectedRevision']
    : ['schemaVersion', 'action', 'commandId', 'idempotencyKey', 'workspaceId', 'teamId', 'expectedRevision', 'runId'], 'command')
  if (raw.schemaVersion !== 1 || raw.teamId !== teamId) throw new Error('Invalid hosted lifecycle WAL command scope')
  pattern(raw.commandId, /^lifecycle-command_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'commandId')
  pattern(raw.idempotencyKey, /^idempotency_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'idempotencyKey')
  nonEmpty(raw.workspaceId, 'workspaceId'); pattern(raw.expectedRevision, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'expectedRevision')
  if (action !== 'launch') pattern(raw.runId, /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/, 'runId')
  return value as HostedLifecycleDurableCommand
}
function decodeAuthorization(value: unknown, command: HostedLifecycleDurableCommand): HostedLifecycleDurableAuthorization {
  const raw = object(value, 'authorization')
  exact(raw, ['grantId', 'authorizationGeneration', 'deploymentId', 'bootId', 'resourceRevision', 'actorId', 'workspaceId', 'teamId', 'restoreGeneration'], 'authorization')
  pattern(raw.grantId, /^grant_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'grantId')
  pattern(raw.authorizationGeneration, /^authorization-generation_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'authorizationGeneration')
  for (const key of ['deploymentId', 'bootId', 'actorId', 'workspaceId', 'teamId'] as const) nonEmpty(raw[key], key)
  pattern(raw.resourceRevision, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'authorization revision')
  if (!Number.isSafeInteger(raw.restoreGeneration) || (raw.restoreGeneration as number) < 0 ||
    raw.workspaceId !== command.workspaceId || raw.teamId !== command.teamId || raw.resourceRevision !== command.expectedRevision) {
    throw new Error('Invalid hosted lifecycle WAL authorization scope')
  }
  return value as HostedLifecycleDurableAuthorization
}
function decodeBinding(value: unknown): HostedLifecycleDurableBinding {
  const raw = object(value, 'binding')
  exact(raw, ['actorId', 'sessionId', 'deploymentId', 'bootId', 'authorizedScope', 'restoreGeneration'], 'binding')
  for (const key of ['actorId', 'sessionId', 'deploymentId', 'bootId', 'authorizedScope'] as const) nonEmpty(raw[key], key)
  if (!Number.isSafeInteger(raw.restoreGeneration) || (raw.restoreGeneration as number) < 0) throw new Error('Invalid hosted lifecycle WAL binding')
  return value as HostedLifecycleDurableBinding
}
function decodeResult(value: unknown, command: HostedLifecycleDurableCommand): void {
  const raw = object(value, 'result')
  exact(raw, ['schemaVersion', 'kind', 'action', 'commandId', 'workspaceId', 'teamId', 'runId', 'resourceRevision'], 'result')
  if (raw.schemaVersion !== 1 || raw.kind !== 'accepted' || raw.action !== command.action ||
    raw.commandId !== command.commandId || raw.workspaceId !== command.workspaceId || raw.teamId !== command.teamId) {
    throw new Error('Invalid hosted lifecycle WAL result scope')
  }
  pattern(raw.runId, /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/, 'result runId')
  pattern(raw.resourceRevision, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'result revision')
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid hosted lifecycle WAL ${field}`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: string[], field: string): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`Invalid hosted lifecycle WAL ${field} keys`)
}
function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid hosted lifecycle WAL ${field}`)
  return value
}
function pattern(value: unknown, regex: RegExp, field: string): string {
  const parsed = nonEmpty(value, field); if (!regex.test(parsed)) throw new Error(`Invalid hosted lifecycle WAL ${field}`); return parsed
}
