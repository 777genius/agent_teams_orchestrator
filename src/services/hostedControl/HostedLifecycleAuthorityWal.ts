import { createHash, randomUUID } from 'node:crypto'
import { constants, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as lockfile from '../../utils/lockfile.js'

const MAX_WAL_BYTES = 8 * 1024 * 1024
const DEFAULT_COMPLETED_RETENTION = 2_048
const LOCK_OPTIONS = { realpath: false, retries: { retries: 10, minTimeout: 5, maxTimeout: 100 } } as const

type HostedLifecycleWalAppendHandle = {
  stat(): Promise<{ isFile(): boolean; mode: number; size: number; dev: number | bigint; ino: number | bigint; uid: number }>
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>
  truncate(length: number): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}
type HostedLifecycleWalDirectoryHandle = {
  stat(): Promise<{ isDirectory(): boolean; mode: number; dev: number | bigint; ino: number | bigint; uid: number }>
  sync(): Promise<void>
  close(): Promise<void>
}

export type HostedLifecycleAuthorityWalOptions = {
  openAppend?: (path: string, flags: number, mode: number) => Promise<HostedLifecycleWalAppendHandle>
  openDirectory?: (path: string, flags: number) => Promise<HostedLifecycleWalDirectoryHandle>
  /** Test seam; production always uses the 8 MiB hard ceiling. */
  compactionThresholdBytes?: number
  completedRetentionEntries?: number
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
  mountGeneration: number
  ownerEffectFence: { grantRevision: string; identityChecksum: string }
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
  mountGeneration: number
  ownerEffectFence: { grantRevision: string; identityChecksum: string }
}
export type HostedLifecyclePublicResult = Record<string, unknown>
export type HostedLifecycleWireDurableCommand = Record<string, unknown>
export type HostedLifecycleWalEntry =
  | { schemaVersion: 1; kind: 'grant'; fingerprint: string; command: HostedLifecycleDurableCommand; binding: HostedLifecycleDurableBinding; authorization: HostedLifecycleDurableAuthorization }
  | { schemaVersion: 1; kind: 'started'; fingerprint: string; command: HostedLifecycleDurableCommand; durableCommand: HostedLifecycleWireDurableCommand; authorization: HostedLifecycleDurableAuthorization }
  | { schemaVersion: 1; kind: 'completed'; fingerprint: string; command: HostedLifecycleDurableCommand; durableCommand: HostedLifecycleWireDurableCommand; authorization: HostedLifecycleDurableAuthorization; result: HostedLifecyclePublicResult }
  | { schemaVersion: 1; kind: 'released'; grantId: string }

type HostedLifecycleWalSnapshot = {
  schemaVersion: 1
  kind: 'snapshot'
  retention: { policy: 'latest-completed-v1'; completedLimit: number }
  grants: Extract<HostedLifecycleWalEntry, { kind: 'grant' }>[]
  commands: Extract<HostedLifecycleWalEntry, { kind: 'started' | 'completed' }>[]
  released: string[]
}

export type HostedLifecycleWalState = {
  grants: Map<string, Extract<HostedLifecycleWalEntry, { kind: 'grant' }>>
  commands: Map<string, Extract<HostedLifecycleWalEntry, { kind: 'started' | 'completed' }>>
  released: Set<string>
}

export function createHostedLifecycleGrantFingerprint(
  command: HostedLifecycleDurableCommand,
  binding: HostedLifecycleDurableBinding,
): string {
  return createHash('sha256').update(JSON.stringify([
    'agent-teams.hosted-lifecycle-authorization/v1',
    command.schemaVersion,
    command.action,
    command.commandId,
    command.idempotencyKey,
    command.workspaceId,
    command.teamId,
    command.expectedRevision,
    command.action === 'launch' ? null : command.runId,
    binding.actorId,
    binding.sessionId,
    binding.deploymentId,
    binding.bootId,
    binding.authorizedScope,
    binding.restoreGeneration,
    binding.mountGeneration,
    binding.ownerEffectFence.grantRevision,
    binding.ownerEffectFence.identityChecksum,
  ])).digest('hex')
}

export class HostedLifecycleAuthorityWal {
  readonly path: string
  readonly lockPath: string
  readonly #openAppend: NonNullable<HostedLifecycleAuthorityWalOptions['openAppend']>
  readonly #openDirectory: NonNullable<HostedLifecycleAuthorityWalOptions['openDirectory']>
  readonly #compactionThresholdBytes: number
  readonly #completedRetentionEntries: number
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
    this.#openDirectory = options.openDirectory ?? (async (path, flags) => open(path, flags))
    this.#compactionThresholdBytes = options.compactionThresholdBytes ?? MAX_WAL_BYTES
    this.#completedRetentionEntries = options.completedRetentionEntries ?? DEFAULT_COMPLETED_RETENTION
    if (!Number.isSafeInteger(this.#compactionThresholdBytes) || this.#compactionThresholdBytes < 1_024 ||
      this.#compactionThresholdBytes > MAX_WAL_BYTES || !Number.isSafeInteger(this.#completedRetentionEntries) ||
      this.#completedRetentionEntries < 1) throw new TypeError('Invalid hosted lifecycle WAL compaction policy')
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
        const record = decodeRecord(JSON.parse(line), this.teamId)
        if (record.kind === 'snapshot') {
          if (state.grants.size || state.commands.size || state.released.size) {
            throw new Error('Invalid hosted lifecycle WAL snapshot ordering')
          }
          restoreSnapshot(state, record)
        } else {
          applyEntry(state, record)
        }
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
    let closed = false
    try {
      const stat = await handle.stat()
      originalSize = stat.size
      await this.#assertCurrentWalHandle(stat)
      if (stat.size + line.byteLength > this.#compactionThresholdBytes) {
        await handle.close()
        closed = true
        await this.#compactAndAppend(entry)
        return
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
        await this.#assertCurrentWalHandle(stat)
        await this.#syncDirectory()
        await this.#assertCurrentWalHandle(stat)
      } catch (error) {
        try { await handle.truncate(originalSize); await handle.sync() } catch {}
        throw error
      }
    } finally { if (!closed) await handle.close() }
  }

  async #compactAndAppend(entry: HostedLifecycleWalEntry): Promise<void> {
    const state = await this.load()
    applyEntry(state, entry)
    const snapshot = compactSnapshot(state, this.#completedRetentionEntries)
    const serialized = `${JSON.stringify(snapshot)}\n`
    if (Buffer.byteLength(serialized) > MAX_WAL_BYTES) {
      throw new Error('Hosted lifecycle WAL active state exceeds 8MiB')
    }
    const tempPath = `${this.path}.snapshot-${process.pid}-${randomUUID()}`
    try {
      const handle = await open(
        tempPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      let replacementIdentity: Awaited<ReturnType<typeof handle.stat>>
      try {
        await handle.writeFile(serialized, 'utf8')
        await handle.sync()
        replacementIdentity = await handle.stat()
      } finally {
        await handle.close()
      }
      await rename(tempPath, this.path)
      // The replacement inode, not merely whatever currently occupies the
      // pathname, must remain installed across the directory durability
      // boundary. This closes rename/substitution races during rotation.
      await this.#assertCurrentWalHandle(replacementIdentity)
      await this.#syncDirectory()
      await this.#assertCurrentWalHandle(replacementIdentity)
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  async #assertCurrentWalHandle(stat: Awaited<ReturnType<HostedLifecycleWalAppendHandle['stat']>>): Promise<void> {
    const current = await lstat(this.path)
    const uid = process.getuid?.()
    if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() || stat.dev !== current.dev ||
      stat.ino !== current.ino || stat.uid !== current.uid || stat.mode !== current.mode || (stat.mode & 0o077) !== 0 ||
      (current.mode & 0o077) !== 0 || (uid !== undefined && (stat.uid !== uid || current.uid !== uid))) {
      throw new Error('Unsafe hosted lifecycle WAL path-handle correlation')
    }
  }

  async #syncDirectory(): Promise<void> {
    const handle = await this.#openDirectory(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    )
    try {
      const stat = await handle.stat()
      await this.#assertCurrentDirectoryHandle(stat)
      await handle.sync()
      await this.#assertCurrentDirectoryHandle(stat)
    } finally { await handle.close() }
  }

  async #assertCurrentDirectoryHandle(
    stat: Awaited<ReturnType<HostedLifecycleWalDirectoryHandle['stat']>>,
  ): Promise<void> {
    const current = await lstat(this.directory)
    if (!stat.isDirectory() || !current.isDirectory() || current.isSymbolicLink() || stat.dev !== current.dev ||
      stat.ino !== current.ino || stat.uid !== current.uid || stat.mode !== current.mode || (stat.mode & 0o022) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
      throw new Error('Unsafe hosted lifecycle WAL directory sync')
    }
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
      await this.#syncDirectory()
    } finally { await handle.close() }
  }
}

function compactSnapshot(
  state: HostedLifecycleWalState,
  completedLimit: number,
): HostedLifecycleWalSnapshot {
  const ambiguous = [...state.commands.values()].filter(command => command.kind === 'started')
  const allCompleted = [...state.commands.values()]
    .filter((command): command is Extract<HostedLifecycleWalEntry, { kind: 'completed' }> =>
      command.kind === 'completed')
  const retainedCompletedKeys = new Set([
    ...allCompleted.slice(-completedLimit),
    ...allCompleted.filter(command => !state.released.has(command.authorization.grantId)),
  ].map(command => walCommandKey(command.command, command.authorization)))
  const completed = allCompleted.filter(command =>
    retainedCompletedKeys.has(walCommandKey(command.command, command.authorization)))
  const retainedGrantIds = new Set<string>([
    ...[...state.grants.keys()].filter(grantId => !state.released.has(grantId)),
    ...ambiguous.map(command => command.authorization.grantId),
    ...completed.map(command => command.authorization.grantId),
  ])
  return {
    schemaVersion: 1,
    kind: 'snapshot',
    retention: { policy: 'latest-completed-v1', completedLimit },
    grants: [...state.grants.values()].filter(grant => retainedGrantIds.has(grant.authorization.grantId)),
    commands: [
      ...ambiguous,
      ...completed.flatMap(command => [startedFromCompleted(command), command]),
    ],
    released: [...state.released].filter(grantId => retainedGrantIds.has(grantId)),
  }
}

function restoreSnapshot(state: HostedLifecycleWalState, snapshot: HostedLifecycleWalSnapshot): void {
  for (const grant of snapshot.grants) {
    if (state.grants.has(grant.authorization.grantId) || [...state.grants.values()].some(existing =>
      walCommandKey(existing.command, existing.authorization) === walCommandKey(grant.command, grant.authorization))) {
      throw new Error('Invalid duplicate hosted lifecycle WAL snapshot grant')
    }
    state.grants.set(grant.authorization.grantId, grant)
  }
  for (const command of snapshot.commands) {
    applyEntry(state, command)
  }
  for (const grantId of snapshot.released) {
    const grant = state.grants.get(grantId)
    if (!grant || state.released.has(grantId) ||
      state.commands.get(walCommandKey(grant.command, grant.authorization))?.kind === 'started') {
      throw new Error('Invalid hosted lifecycle WAL snapshot release')
    }
    state.released.add(grantId)
  }
}

function startedFromCompleted(
  command: Extract<HostedLifecycleWalEntry, { kind: 'completed' }>,
): Extract<HostedLifecycleWalEntry, { kind: 'started' }> {
  return {
    schemaVersion: 1,
    kind: 'started',
    fingerprint: command.fingerprint,
    command: command.command,
    durableCommand: command.durableCommand,
    authorization: command.authorization,
  }
}

function applyEntry(state: HostedLifecycleWalState, entry: HostedLifecycleWalEntry): void {
  if (entry.kind === 'grant') {
    if (state.grants.has(entry.authorization.grantId) || [...state.grants.values()].some(existing =>
      walCommandKey(existing.command, existing.authorization) === walCommandKey(entry.command, entry.authorization))) {
      throw new Error('Invalid duplicate hosted lifecycle WAL grant')
    }
    state.grants.set(entry.authorization.grantId, entry)
    return
  }
  if (entry.kind === 'released') {
    if (!state.grants.has(entry.grantId) || state.released.has(entry.grantId)) {
      throw new Error('Invalid hosted lifecycle WAL release ordering')
    }
    const grant = state.grants.get(entry.grantId)!
    if (state.commands.get(walCommandKey(grant.command, grant.authorization))?.kind === 'started') {
      throw new Error('Invalid hosted lifecycle WAL ambiguous release')
    }
    state.released.add(entry.grantId)
    return
  }
  const grant = state.grants.get(entry.authorization.grantId)
  if (!grant || state.released.has(entry.authorization.grantId) ||
    !isSameJson(grant.command, entry.command) || !isSameJson(grant.authorization, entry.authorization)) {
    throw new Error('Invalid hosted lifecycle WAL command ordering')
  }
  const key = walCommandKey(entry.command, entry.authorization)
  const prior = state.commands.get(key)
  if (entry.kind === 'started') {
    if (prior) throw new Error('Invalid duplicate hosted lifecycle WAL start')
    state.commands.set(key, entry)
    return
  }
  if (!prior || prior.kind !== 'started' || prior.fingerprint !== entry.fingerprint ||
    !isSameJson(prior.durableCommand, entry.durableCommand) ||
    !isSameJson(prior.authorization, entry.authorization)) {
    throw new Error('Invalid hosted lifecycle WAL completion ordering')
  }
  state.commands.set(key, entry)
}

function isSameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right)
}

function walCommandKey(
  command: HostedLifecycleDurableCommand,
  authorization: HostedLifecycleDurableAuthorization,
): string {
  return `${authorization.deploymentId}\0${authorization.actorId}\0${command.action}\0${command.idempotencyKey}`
}

function decodeRecord(value: unknown, teamId: string): HostedLifecycleWalEntry | HostedLifecycleWalSnapshot {
  const raw = object(value, 'entry')
  if (raw.kind !== 'snapshot') return decodeEntry(value, teamId)
  exact(raw, ['schemaVersion', 'kind', 'retention', 'grants', 'commands', 'released'], 'snapshot')
  const retention = object(raw.retention, 'snapshot retention')
  exact(retention, ['policy', 'completedLimit'], 'snapshot retention')
  if (raw.schemaVersion !== 1 || retention.policy !== 'latest-completed-v1' ||
    !Number.isSafeInteger(retention.completedLimit) || (retention.completedLimit as number) < 1 ||
    !Array.isArray(raw.grants) || !Array.isArray(raw.commands) || !Array.isArray(raw.released)) {
    throw new Error('Invalid hosted lifecycle WAL snapshot')
  }
  const grants = raw.grants.map(entry => decodeEntry(entry, teamId))
  const commands = raw.commands.map(entry => decodeEntry(entry, teamId))
  if (grants.some(entry => entry.kind !== 'grant') ||
    commands.some(entry => entry.kind !== 'started' && entry.kind !== 'completed') ||
    raw.released.some(grantId => typeof grantId !== 'string')) {
    throw new Error('Invalid hosted lifecycle WAL snapshot records')
  }
  return {
    schemaVersion: 1,
    kind: 'snapshot',
    retention: retention as HostedLifecycleWalSnapshot['retention'],
    grants: grants as HostedLifecycleWalSnapshot['grants'],
    commands: commands as HostedLifecycleWalSnapshot['commands'],
    released: raw.released as string[],
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
    ? ['schemaVersion', 'kind', 'fingerprint', 'command', 'durableCommand', 'authorization', 'result']
    : entry.kind === 'started'
      ? ['schemaVersion', 'kind', 'fingerprint', 'command', 'durableCommand', 'authorization']
      : ['schemaVersion', 'kind', 'fingerprint', 'command', 'binding', 'authorization'], entry.kind)
  const command = decodeCommand(entry.command, teamId)
  const authorization = decodeAuthorization(entry.authorization, command)
  pattern(entry.fingerprint, /^[0-9a-f]{64}$/, 'fingerprint')
  if (entry.kind === 'started' || entry.kind === 'completed') {
    decodeWireDurableCommand(entry.durableCommand, command, authorization)
  }
  if (entry.kind === 'grant') {
    const binding = decodeBinding(entry.binding)
    const expected = createHostedLifecycleGrantFingerprint(command, binding)
    if (entry.fingerprint !== expected || binding.actorId !== authorization.actorId ||
      binding.deploymentId !== authorization.deploymentId || binding.bootId !== authorization.bootId ||
      binding.restoreGeneration !== authorization.restoreGeneration ||
      binding.mountGeneration !== authorization.mountGeneration ||
      !isDeepStrictEqual(binding.ownerEffectFence, authorization.ownerEffectFence)) {
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
  exact(raw, ['grantId', 'authorizationGeneration', 'deploymentId', 'bootId', 'resourceRevision', 'actorId', 'workspaceId', 'teamId', 'restoreGeneration', 'mountGeneration', 'ownerEffectFence'], 'authorization')
  pattern(raw.grantId, /^grant_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'grantId')
  pattern(raw.authorizationGeneration, /^authorization-generation_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'authorizationGeneration')
  for (const key of ['deploymentId', 'bootId', 'actorId', 'workspaceId', 'teamId'] as const) nonEmpty(raw[key], key)
  pattern(raw.resourceRevision, /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/, 'authorization revision')
  decodeFence(raw.ownerEffectFence)
  if (!Number.isSafeInteger(raw.restoreGeneration) || (raw.restoreGeneration as number) < 0 ||
    !Number.isSafeInteger(raw.mountGeneration) || (raw.mountGeneration as number) < 1 ||
    raw.workspaceId !== command.workspaceId || raw.teamId !== command.teamId || raw.resourceRevision !== command.expectedRevision) {
    throw new Error('Invalid hosted lifecycle WAL authorization scope')
  }
  return value as HostedLifecycleDurableAuthorization
}
function decodeBinding(value: unknown): HostedLifecycleDurableBinding {
  const raw = object(value, 'binding')
  exact(raw, ['actorId', 'sessionId', 'deploymentId', 'bootId', 'authorizedScope', 'restoreGeneration', 'mountGeneration', 'ownerEffectFence'], 'binding')
  for (const key of ['actorId', 'sessionId', 'deploymentId', 'bootId', 'authorizedScope'] as const) nonEmpty(raw[key], key)
  decodeFence(raw.ownerEffectFence)
  if (!Number.isSafeInteger(raw.restoreGeneration) || (raw.restoreGeneration as number) < 0 ||
    !Number.isSafeInteger(raw.mountGeneration) || (raw.mountGeneration as number) < 1) throw new Error('Invalid hosted lifecycle WAL binding')
  return value as HostedLifecycleDurableBinding
}
function decodeFence(value: unknown): void {
  const raw = object(value, 'ownerEffectFence')
  exact(raw, ['grantRevision', 'identityChecksum'], 'ownerEffectFence')
  pattern(raw.grantRevision, /^[0-9a-f]{64}$/, 'grantRevision')
  pattern(raw.identityChecksum, /^[0-9a-f]{64}$/, 'identityChecksum')
}
function decodeWireDurableCommand(
  value: unknown,
  command: HostedLifecycleDurableCommand,
  authorization: HostedLifecycleDurableAuthorization,
): void {
  const raw = object(value, 'durableCommand')
  exact(raw, ['schemaVersion', 'commandFingerprint', 'idempotency', 'resource'], 'durableCommand')
  if (raw.schemaVersion !== 1) throw new Error('Invalid hosted lifecycle durable command')
  const fingerprint = object(raw.commandFingerprint, 'commandFingerprint')
  exact(fingerprint, ['algorithm', 'version', 'digest'], 'commandFingerprint')
  if (fingerprint.algorithm !== 'sha256' || fingerprint.version !== 1) throw new Error('Invalid hosted lifecycle command fingerprint')
  pattern(fingerprint.digest, /^[0-9a-f]{64}$/, 'command fingerprint')
  const idempotency = object(raw.idempotency, 'idempotency')
  exact(idempotency, ['deploymentId', 'actorId', 'action', 'idempotencyKey'], 'idempotency')
  const resource = object(raw.resource, 'resource')
  exact(resource, ['bootId', 'workspaceId', 'teamId', 'runId', 'expectedRevision', 'restoreGeneration', 'mountGeneration', 'ownerEffectFence'], 'resource')
  decodeFence(resource.ownerEffectFence)
  if (idempotency.deploymentId !== authorization.deploymentId || idempotency.actorId !== authorization.actorId ||
    idempotency.action !== command.action || idempotency.idempotencyKey !== command.idempotencyKey ||
    resource.bootId !== authorization.bootId || resource.workspaceId !== command.workspaceId ||
    resource.teamId !== command.teamId || resource.runId !== (command.action === 'launch' ? null : command.runId) ||
    resource.expectedRevision !== command.expectedRevision || resource.restoreGeneration !== authorization.restoreGeneration ||
    resource.mountGeneration !== authorization.mountGeneration ||
    !isDeepStrictEqual(resource.ownerEffectFence, authorization.ownerEffectFence)) {
    throw new Error('Invalid hosted lifecycle durable command scope')
  }
  const expectedFingerprint = createHash('sha256').update(JSON.stringify([
    'agent-teams.hosted-lifecycle-command/v1', command.schemaVersion, command.action,
    command.commandId, command.idempotencyKey, command.workspaceId, command.teamId,
    command.expectedRevision, command.action === 'launch' ? null : command.runId,
    authorization.ownerEffectFence.grantRevision, authorization.ownerEffectFence.identityChecksum,
  ])).digest('hex')
  if (fingerprint.digest !== expectedFingerprint) {
    throw new Error('Invalid hosted lifecycle durable command fingerprint')
  }
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
