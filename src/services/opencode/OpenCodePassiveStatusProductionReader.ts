import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  createOpenCodePassiveReadFailure,
  createOpenCodePassiveReadSuccess,
  OpenCodePassiveStatusReader,
  type OpenCodeCanonicalProjectScopeResult,
  type OpenCodePassiveReadHandoff,
  type OpenCodePassiveStatusReaderPorts,
} from './OpenCodePassiveStatusReader.js'
import {
  decodeOpenCodeRedactedSnapshotV1,
  encodeOpenCodeRedactedSnapshotV1,
  OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES,
  type OpenCodeRedactedSnapshotV1,
} from './OpenCodeRedactedStatusSnapshot.js'
import { OpenCodeSafePublicationDirectory } from './OpenCodeSafePublication.js'
import { getOpenCodePassiveSnapshotPersistenceCapability } from './OpenCodePassiveSnapshotPersistencePolicy.js'
import {
  openCodePassiveDatabaseExists,
  readOpenCodePassiveSnapshot,
} from './OpenCodePassiveSnapshotStore.js'
import {
  decodeOpenCodePassiveSnapshotCommit,
  OPEN_CODE_PASSIVE_COMMIT_MAX_BYTES,
  OPEN_CODE_PASSIVE_COMMIT_NAME_PATTERN,
  OPEN_CODE_PASSIVE_COMMIT_TEMP_PATTERN,
  OPEN_CODE_PASSIVE_COMMITS,
  OPEN_CODE_PASSIVE_GENERATION_BINARY,
  OPEN_CODE_PASSIVE_GENERATION_PROJECT,
  OPEN_CODE_PASSIVE_GENERATIONS,
  OPEN_CODE_PASSIVE_LEGACY_MANIFEST,
  OPEN_CODE_PASSIVE_SCOPES,
  OPEN_CODE_PASSIVE_TRANSACTION_MARKER,
  OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT,
  OPEN_CODE_PASSIVE_TRANSACTION_MARKER_MAX_BYTES,
} from './OpenCodePassiveSnapshotTransaction.js'
export const OPEN_CODE_PASSIVE_STATUS_DEFAULT_TIMEOUT_MS = 250
export const OPEN_CODE_PASSIVE_STATUS_STORE_DIRECTORY = 'opencode/passive-status/v1'
export const OPEN_CODE_PASSIVE_STATUS_MAX_CACHED_SCOPES = 32

type LoadedSnapshot = Readonly<{
  text: string
  value: OpenCodeRedactedSnapshotV1
}>

type DirectObservation = Readonly<{
  authority: string
  freshness: string
  condition: string
  issueCode: string
  observedAt: number | null
  validUntil: number | null
}>

type ProductionReaderDeps = Readonly<{
  platform?: NodeJS.Platform
  rootDirectory?: string
  now?: () => number
  schedule?: OpenCodePassiveStatusReaderPorts['clock']['schedule']
  canonicalizePath?: (projectPath: string, signal: AbortSignal) => Promise<string>
  readBoundedText?: (filePath: string, signal: AbortSignal) => Promise<string | null>
  afterCommittedTransactionSelected?: () => void | Promise<void>
}>

/**
 * Read-only production boundary for passive OpenCode status. It reads only the
 * app-owned redacted snapshot store; it has no inventory, host, process, launch,
 * provider API, network, profile preparation, or writer dependency. Native
 * Windows deliberately returns unsupported/unknown without disk I/O or legacy
 * fallback until a handle-relative persistence implementation exists.
 */
export class OpenCodePassiveStatusProductionReader {
  readonly reader: OpenCodePassiveStatusReader
  readonly #rootDirectory: string
  readonly #platform: NodeJS.Platform
  readonly #now: () => number
  readonly #canonicalizePath: (projectPath: string, signal: AbortSignal) => Promise<string>
  readonly #readBoundedText: (filePath: string, signal: AbortSignal) => Promise<string | null>
  readonly #transactionalStorage: boolean
  readonly #afterCommittedTransactionSelected: () => void | Promise<void>
  readonly #snapshotLoads = new WeakMap<AbortSignal, Map<string, Promise<LoadedSnapshot | null>>>()
  readonly #storeStates = new WeakMap<AbortSignal, Promise<'immutable' | 'legacy' | 'corrupt'>>()
  readonly #scopeWaiters = new WeakMap<AbortSignal, { promise: Promise<`sha256:${string}`>; resolve: (scope: `sha256:${string}`) => void }>()
  readonly #lastSnapshots = new Map<`sha256:${string}`, LoadedSnapshot>()

  constructor(deps: ProductionReaderDeps = {}) {
    this.#platform = deps.platform ?? process.platform
    const persistenceSupported = getOpenCodePassiveSnapshotPersistenceCapability(
      this.#platform,
    ).supported
    this.#rootDirectory = persistenceSupported
      ? deps.rootDirectory ?? getOpenCodePassiveStatusRootDirectory()
      : ''
    this.#now = deps.now ?? Date.now
    this.#canonicalizePath = deps.canonicalizePath ?? (this.#platform === 'win32'
      ? async () => { throw new Error('Passive transactional persistence is unsupported on native Windows') }
      : canonicalizeOpenCodePassiveProjectPath)
    this.#readBoundedText = deps.readBoundedText ?? readBoundedSnapshotText
    this.#transactionalStorage = deps.readBoundedText === undefined
    this.#afterCommittedTransactionSelected = deps.afterCommittedTransactionSelected ?? (() => undefined)

    const snapshotRead = (
      projectScope: `sha256:${string}`,
      signal: AbortSignal,
      handoff: OpenCodePassiveReadHandoff<string | null>,
    ) => {
      const cached = this.#lastSnapshots.get(projectScope)
      // A committed snapshot is authoritative historical evidence. Hand it off
      // immediately while the direct ports independently attempt a fresh
      // transaction. Timeout/transient failures can then degrade this history
      // instead of synthesizing all-unknown status. It never grants readiness.
      if (cached) {
        handoff(createOpenCodePassiveReadSuccess(cached.text, cached.value.capturedAt, Number.MAX_SAFE_INTEGER))
        return
      }
      void this.#loadSnapshot(projectScope, signal).then(
        loaded => handoff(loaded
          ? createOpenCodePassiveReadSuccess(loaded.text, loaded.value.capturedAt, Number.MAX_SAFE_INTEGER)
          : createOpenCodePassiveReadSuccess(null, this.#safeNow(), Number.MAX_SAFE_INTEGER)),
        () => handoff(createOpenCodePassiveReadFailure(signal.aborted ? 'cancelled' : 'transient')),
      )
    }

    const ports: OpenCodePassiveStatusReaderPorts = {
      projectScope: {
        canonicalize: (projectPath, signal, handoff) => {
          void this.#canonicalizePath(projectPath, signal).then(
            canonicalPath => {
              if (signal.aborted) {
                handoff(createOpenCodePassiveReadFailure('cancelled'))
                return
              }
              const identity = opaqueInputPathIdentity(projectPath)
              this.#scopeWaiter(signal).resolve(`sha256:${createHash('sha256')
                .update('opencode-project-scope-v1\0').update(canonicalPath).digest('hex')}`)
              const result: OpenCodeCanonicalProjectScopeResult = { canonicalPath, inputPathIdentity: identity }
              handoff(createOpenCodePassiveReadSuccess(result, this.#safeNow(), Number.MAX_SAFE_INTEGER))
            },
            () => handoff(createOpenCodePassiveReadFailure(signal.aborted ? 'cancelled' : 'transient')),
          )
        },
      },
      binaryMetadata: {
        read: (signal, handoff) => {
          void this.#loadBinary(signal).then(
            loaded => {
              if (signal.aborted) {
                handoff(createOpenCodePassiveReadFailure('cancelled'))
                return
              }
              const observation = loaded?.value.binary
              if (!observation || observation.value.presence === 'unknown'
                || !isDirectObservation(observation, 'binary_metadata')
                || observation.validUntil === null || observation.validUntil < this.#safeNow()) {
                handoff(observation ? observationFailure(observation) : createOpenCodePassiveReadFailure('invalid'))
                return
              }
              handoff(createOpenCodePassiveReadSuccess({
                present: observation.value.presence === 'present',
                version: observation.value.version,
              }, observation.observedAt!, observation.validUntil!))
            },
            () => handoff(createOpenCodePassiveReadFailure(signal.aborted ? 'cancelled' : 'transient')),
          )
        },
      },
      snapshots: { read: snapshotRead },
      configMetadata: {
        read: (providerId, scope, signal, handoff) => this.#readProvider(
          providerId,
          scope,
          signal,
          handoff,
          provider => provider.configured,
          observation => observation.value === 'unknown'
            ? null
            : { configured: observation.value === 'configured' },
          'config_metadata',
        ),
      },
      authMetadata: {
        read: (providerId, scope, signal, handoff) => this.#readProvider(
          providerId,
          scope,
          signal,
          handoff,
          provider => provider.lastConnected,
          observation => observation.value.state === 'unknown'
            ? null
            : { lastConnectedAt: observation.value.state === 'connected' ? observation.value.at : null },
          'auth_metadata',
        ),
      },
      catalogMetadata: {
        read: (providerId, scope, signal, handoff) => this.#readProvider(
          providerId,
          scope,
          signal,
          handoff,
          provider => provider.catalogAvailable,
          (observation, provider) => observation.value === 'unknown'
            ? null
            : { available: observation.value === 'available', catalogIdentity: provider.catalogIdentity ?? null },
          'catalog_snapshot',
        ),
      },
      executionMetadata: {
        read: (providerId, scope, signal, handoff) => this.#readProvider(
          providerId,
          scope,
          signal,
          handoff,
          provider => provider.executionVerified,
          observation => observation.value === 'unknown'
            ? null
            : { verified: observation.value === 'verified' },
          'execution_snapshot',
        ),
      },
      clock: {
        now: this.#now,
        schedule: deps.schedule ?? ((callback, delayMs) => {
          const timer = setTimeout(callback, delayMs)
          return { cancel: () => clearTimeout(timer) }
        }),
      },
    }
    if (!persistenceSupported) {
      const unsupported = <T>(handoff: OpenCodePassiveReadHandoff<T>) => {
        handoff(createOpenCodePassiveReadFailure('unsupported'))
      }
      ports.projectScope.canonicalize = (_projectPath, _signal, handoff) => unsupported(handoff)
      ports.binaryMetadata.read = (_signal, handoff) => unsupported(handoff)
      ports.snapshots.read = (_scope, _signal, handoff) => unsupported(handoff)
      ports.configMetadata.read = (_providerId, _scope, _signal, handoff) => unsupported(handoff)
      ports.authMetadata.read = (_providerId, _scope, _signal, handoff) => unsupported(handoff)
      ports.catalogMetadata.read = (_providerId, _scope, _signal, handoff) => unsupported(handoff)
      ports.executionMetadata.read = (_providerId, _scope, _signal, handoff) => unsupported(handoff)
    }
    this.reader = new OpenCodePassiveStatusReader(ports)
  }

  #safeNow(): number {
    const value = this.#now()
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  #readProvider<T extends DirectObservation, U>(
    providerId: string,
    scope: `sha256:${string}`,
    signal: AbortSignal,
    handoff: OpenCodePassiveReadHandoff<U>,
    select: (provider: OpenCodeRedactedSnapshotV1['providers'][number]) => T,
    project: (observation: T, provider: OpenCodeRedactedSnapshotV1['providers'][number]) => U | null,
    authority: string,
  ): void {
    void this.#loadSnapshot(scope, signal).then(
      loaded => {
        if (signal.aborted) {
          handoff(createOpenCodePassiveReadFailure('cancelled'))
          return
        }
        const provider = loaded?.value.providers.find(candidate => candidate.providerId === providerId)
        if (!provider) {
          handoff(createOpenCodePassiveReadFailure('invalid'))
          return
        }
        const observation = select(provider)
        const value = isDirectObservation(observation, authority) ? project(observation, provider) : null
        if (value === null || observation.observedAt === null || observation.validUntil === null
          || observation.validUntil < this.#safeNow()) {
          handoff(value === null && observation.authority === authority
            ? observationFailure(observation)
            : createOpenCodePassiveReadFailure('invalid'))
          return
        }
        handoff(createOpenCodePassiveReadSuccess(value, observation.observedAt, observation.validUntil))
      },
      () => handoff(createOpenCodePassiveReadFailure(signal.aborted ? 'cancelled' : 'transient')),
    )
  }

  #loadSnapshot(scope: `sha256:${string}`, signal: AbortSignal): Promise<LoadedSnapshot | null> {
    if (signal.aborted) return Promise.reject(cancelledError())
    let byScope = this.#snapshotLoads.get(signal)
    if (!byScope) {
      byScope = new Map()
      if (signal.aborted) return Promise.reject(cancelledError())
      this.#snapshotLoads.set(signal, byScope)
    }
    let load = byScope.get(scope)
    if (!load) {
      load = (this.#transactionalStorage
        ? this.#readCommitted(scope, false, signal)
        : this.#readAndDecode(snapshotPath(this.#rootDirectory, scope), signal, scope)).then(loaded => {
        if (signal.aborted) throw new Error('cancelled')
        const now = this.#safeNow()
        if (signal.aborted) throw new Error('cancelled')
        if (loaded && snapshotIsFreshForCache(loaded.value, now)) {
          if (!this.#lastSnapshots.has(scope) && this.#lastSnapshots.size >= OPEN_CODE_PASSIVE_STATUS_MAX_CACHED_SCOPES) {
            const oldest = this.#lastSnapshots.keys().next().value
            if (signal.aborted) throw new Error('cancelled')
            if (oldest !== undefined) this.#lastSnapshots.delete(oldest)
          }
          if (signal.aborted) throw new Error('cancelled')
          this.#lastSnapshots.delete(scope)
          if (signal.aborted) throw new Error('cancelled')
          this.#lastSnapshots.set(scope, loaded)
        }
        return loaded
      })
      if (signal.aborted) return load
      byScope.set(scope, load)
    }
    return load
  }

  #loadBinary(signal: AbortSignal): Promise<LoadedSnapshot | null> {
    if (signal.aborted) return Promise.reject(cancelledError())
    if (!this.#transactionalStorage) return this.#readAndDecode(
      path.join(this.#rootDirectory, 'binary.snapshot.json'), signal, null,
    )
    return this.#scopeWaiter(signal).promise.then(scope => this.#loadSnapshot(scope, signal))
  }

  #scopeWaiter(signal: AbortSignal): { promise: Promise<`sha256:${string}`>; resolve: (scope: `sha256:${string}`) => void } {
    let waiter = this.#scopeWaiters.get(signal)
    if (!waiter) {
      let resolve!: (scope: `sha256:${string}`) => void
      const promise = new Promise<`sha256:${string}`>(done => { resolve = done })
      waiter = { promise, resolve }
      this.#scopeWaiters.set(signal, waiter)
    }
    return waiter
  }

  #storeState(signal: AbortSignal): Promise<'immutable' | 'legacy' | 'corrupt'> {
    let state = this.#storeStates.get(signal)
    if (!state) {
      state = readTransactionalStoreState(this.#rootDirectory, signal)
      this.#storeStates.set(signal, state)
    }
    return state
  }

  async #readCommitted(scope: `sha256:${string}`, _binary: boolean, signal: AbortSignal): Promise<LoadedSnapshot | null> {
    if (this.#platform === 'win32') throw new Error('Passive transactional persistence is unsupported on native Windows')
    if (await openCodePassiveDatabaseExists(this.#rootDirectory)) {
      const selected = await readOpenCodePassiveSnapshot(this.#rootDirectory, scope, signal, {
        platform: this.#platform,
        afterSelected: this.#afterCommittedTransactionSelected,
      })
      return selected && Object.freeze({ text: selected.text, value: selected.value })
    }
    const state = await this.#storeState(signal)
    if (signal.aborted) throw cancelledError()
    if (state === 'legacy') return this.#readAndDecode(snapshotPath(this.#rootDirectory, scope), signal, scope)
    if (state === 'corrupt') return null
    let root: OpenCodeSafePublicationDirectory | null = null
    let scopes: OpenCodeSafePublicationDirectory | null = null
    let scoped: OpenCodeSafePublicationDirectory | null = null
    let commits: OpenCodeSafePublicationDirectory | null = null
    let generations: OpenCodeSafePublicationDirectory | null = null
    let generation: OpenCodeSafePublicationDirectory | null = null
    try {
      root = await OpenCodeSafePublicationDirectory.open(this.#rootDirectory)
      // Opening the marker proves that a same-named symlink/junction cannot be
      // treated as legacy migration state.
      if (await root.readBoundedRegularFile(
        OPEN_CODE_PASSIVE_TRANSACTION_MARKER, OPEN_CODE_PASSIVE_TRANSACTION_MARKER_MAX_BYTES, signal,
      ) !== OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT) return null
      scopes = await root.openChildDirectory(OPEN_CODE_PASSIVE_SCOPES)
      try { scoped = await scopes.openChildDirectory(scope.slice(7)) }
      catch (error) { if (isMissingFile(error)) return null; throw error }
      commits = await scoped.openChildDirectory(OPEN_CODE_PASSIVE_COMMITS)
      const names = (await commits.childNames()).filter(name => !OPEN_CODE_PASSIVE_COMMIT_TEMP_PATTERN.test(name))
      if (names.some(name => !OPEN_CODE_PASSIVE_COMMIT_NAME_PATTERN.test(name))) return null
      const candidates: Array<{ generation: string; domainGeneration: number }> = []
      for (const name of names) {
        const text = await commits.readBoundedRegularFile(name, OPEN_CODE_PASSIVE_COMMIT_MAX_BYTES, signal)
        if (text === null) return null
        const commit = decodeOpenCodePassiveSnapshotCommit(text)
        if (!commit || commit.scope !== scope
          || name !== `${String(commit.domainGeneration).padStart(16, '0')}.${commit.generation}.json`) return null
        candidates.push(commit)
      }
      candidates.sort((left, right) => right.domainGeneration - left.domainGeneration
        || right.generation.localeCompare(left.generation))
      if (candidates.length === 0) return null
      await this.#afterCommittedTransactionSelected()
      if (signal.aborted) throw cancelledError()
      generations = await scoped.openChildDirectory(OPEN_CODE_PASSIVE_GENERATIONS)
      const committed: Array<{ sequence: number; value: OpenCodeRedactedSnapshotV1 }> = []
      for (const candidate of candidates) {
        generation = await generations.openChildDirectory(candidate.generation)
        const [projectText, binaryText] = await Promise.all([
          generation.readBoundedRegularFile(OPEN_CODE_PASSIVE_GENERATION_PROJECT, OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES, signal),
          generation.readBoundedRegularFile(OPEN_CODE_PASSIVE_GENERATION_BINARY, OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES, signal),
        ])
        await generation.close(); generation = null
        if (projectText === null || binaryText === null || projectText !== binaryText) return null
        const project = decodeOpenCodeRedactedSnapshotV1(projectText)
        if (!project.ok || project.value.projectScope !== scope) return null
        committed.push({ sequence: candidate.domainGeneration, value: project.value })
      }
      const value = mergeCommittedSnapshots(scope, committed)
      const encoded = encodeMergedSnapshot(value)
      return encoded === null ? null : { text: encoded, value }
    } finally {
      await generation?.close().catch(() => undefined)
      await generations?.close().catch(() => undefined)
      await commits?.close().catch(() => undefined)
      await scoped?.close().catch(() => undefined)
      await scopes?.close().catch(() => undefined)
      await root?.close().catch(() => undefined)
    }
  }

  async #readAndDecode(
    filePath: string,
    signal: AbortSignal,
    expectedScope: `sha256:${string}` | null,
  ): Promise<LoadedSnapshot | null> {
    if (signal.aborted) throw new Error('cancelled')
    const text = await this.#readBoundedText(filePath, signal)
    if (signal.aborted) throw new Error('cancelled')
    if (text === null) return null
    const decoded = decodeOpenCodeRedactedSnapshotV1(text)
    if (signal.aborted) throw new Error('cancelled')
    if (!decoded.ok || (expectedScope !== null && decoded.value.projectScope !== expectedScope)) return null
    return Object.freeze({ text, value: decoded.value })
  }
}

async function readTransactionalStoreState(
  rootPath: string,
  signal: AbortSignal,
): Promise<'immutable' | 'legacy' | 'corrupt'> {
  try { await lstat(rootPath) }
  catch (error) { if (isMissingFile(error)) return 'legacy'; throw error }
  let root: OpenCodeSafePublicationDirectory | null = null
  try {
    root = await OpenCodeSafePublicationDirectory.open(rootPath)
    if (signal.aborted) throw cancelledError()
    const names = await root.childNames()
    if (names.includes(OPEN_CODE_PASSIVE_TRANSACTION_MARKER)) {
      try {
        if (await root.readBoundedRegularFile(
          OPEN_CODE_PASSIVE_TRANSACTION_MARKER, OPEN_CODE_PASSIVE_TRANSACTION_MARKER_MAX_BYTES, signal,
        ) !== OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT) return 'corrupt'
      } catch { return 'corrupt' }
      return 'immutable'
    }
    // Any transactional artifact, including the retired v1 manifest, fences
    // compatibility fallback. Only a genuinely marker-free legacy mirror store
    // is eligible for migration reads.
    if (names.includes(OPEN_CODE_PASSIVE_LEGACY_MANIFEST)
      || names.includes(OPEN_CODE_PASSIVE_SCOPES)) return 'corrupt'
    return 'legacy'
  } catch (error) {
    if (isMissingFile(error)) return 'legacy'
    throw error
  } finally { await root?.close().catch(() => undefined) }
}

export function getOpenCodePassiveSnapshotPath(
  rootDirectory: string,
  scope: `sha256:${string}`,
): string {
  return snapshotPath(rootDirectory, scope)
}

export function getOpenCodePassiveStatusRootDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.CLAUDE_MULTIMODEL_DATA_HOME
  if (configured && path.isAbsolute(configured)) {
    return path.join(path.normalize(configured), OPEN_CODE_PASSIVE_STATUS_STORE_DIRECTORY)
  }
  // Matches env-paths('claude-multimodel') used by OpenCodeManagedPaths.
  const applicationName = 'claude-multimodel-nodejs'
  const dataRoot = platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support', applicationName)
    : platform === 'win32'
      ? path.join(env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), applicationName, 'Data')
      : path.join(
          env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
            ? env.XDG_DATA_HOME
            : path.join(homedir(), '.local', 'share'),
          applicationName,
        )
  return path.join(dataRoot, OPEN_CODE_PASSIVE_STATUS_STORE_DIRECTORY)
}

function snapshotPath(rootDirectory: string, scope: `sha256:${string}`): string {
  return path.join(rootDirectory, 'snapshots', `${scope.slice('sha256:'.length)}.json`)
}

export async function canonicalizeOpenCodePassiveProjectPath(projectPath: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('cancelled')
  const windowsPath = /^[a-zA-Z]:[\\/]/.test(projectPath) || projectPath.startsWith('\\\\')
  if (windowsPath) {
    const absolute = path.win32.resolve(projectPath)
    if (process.platform !== 'win32') {
      throw Object.assign(new Error('Windows project paths require Windows canonicalization'), { code: 'EINVAL' })
    }
    try {
      const resolved = await realpath(absolute)
      if (signal.aborted) throw cancelledError()
      return normalizeWindowsProjectPath(resolved)
    } catch (error) {
      if (!isMissingFile(error)) throw error
      await verifyStableMissingPath(absolute, signal, path.win32)
      return normalizeWindowsProjectPath(absolute)
    }
  }
  const absolute = path.resolve(projectPath)
  try {
    const resolved = await realpath(absolute)
    if (signal.aborted) throw cancelledError()
    return resolved
  } catch (error) {
    if (!isMissingFile(error)) throw error
    return verifyStableMissingPath(absolute, signal, path)
  }
}

async function verifyStableMissingPath(
  absolute: string,
  signal: AbortSignal,
  pathApi: typeof path | typeof path.win32,
): Promise<string> {
  if (signal.aborted) throw cancelledError()
  try {
    await lstat(absolute)
    throw Object.assign(new Error('Project path changed while canonicalizing'), { code: 'EAGAIN' })
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  const missingParts: string[] = []
  let cursor = absolute
  let canonicalAncestor: string | null = null
  while (canonicalAncestor === null) {
    if (signal.aborted) throw cancelledError()
    const parent = pathApi.dirname(cursor)
    if (parent === cursor) throw Object.assign(new Error('No stable project ancestor'), { code: 'ENOENT' })
    missingParts.unshift(pathApi.basename(cursor))
    cursor = parent
    try {
      canonicalAncestor = await realpath(cursor)
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
  }
  if (signal.aborted) throw cancelledError()
  try {
    await lstat(absolute)
    throw Object.assign(new Error('Project path changed while canonicalizing'), { code: 'EAGAIN' })
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  return pathApi.normalize(pathApi.join(canonicalAncestor, ...missingParts))
}

function cancelledError(): Error {
  return Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' })
}

function normalizeWindowsProjectPath(projectPath: string): string {
  const normalized = path.win32.normalize(projectPath)
  const root = path.win32.parse(normalized).root
  const withoutTrailingSeparators = normalized.length > root.length
    ? normalized.replace(/\\+$/, '')
    : normalized
  return withoutTrailingSeparators.toLowerCase()
}

export async function readBoundedSnapshotText(filePath: string, signal: AbortSignal): Promise<string | null> {
  if (process.platform === 'win32') throw new Error('Passive transactional persistence is unsupported on native Windows')
  const isBinary = path.basename(filePath) === 'binary.snapshot.json'
  const rootPath = isBinary ? path.dirname(filePath) : path.dirname(path.dirname(filePath))
  try { await lstat(rootPath) }
  catch (error) { if (isMissingFile(error)) return null; throw error }
  let root: OpenCodeSafePublicationDirectory | null = null
  let snapshots: OpenCodeSafePublicationDirectory | null = null
  try {
    if (await openCodePassiveDatabaseExists(rootPath)) {
      if (isBinary) return null
      const scope = `sha256:${path.basename(filePath, '.json')}` as const
      return (await readOpenCodePassiveSnapshot(rootPath, scope, signal))?.text ?? null
    }
    root = await OpenCodeSafePublicationDirectory.open(rootPath)
    if (signal.aborted) throw cancelledError()
    const names = await root.childNames()
    if (names.includes(OPEN_CODE_PASSIVE_TRANSACTION_MARKER)) {
      if (isBinary) return null
      const scope = `sha256:${path.basename(filePath, '.json')}` as const
      return await readImmutableProjectText(root, scope, signal)
    }
    if (names.includes(OPEN_CODE_PASSIVE_LEGACY_MANIFEST) || names.includes(OPEN_CODE_PASSIVE_SCOPES)) return null
    if (isBinary) return await root.readBoundedRegularFile('binary.snapshot.json', OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES, signal)
    try { snapshots = await root.openChildDirectory('snapshots') }
    catch (error) { if (isMissingFile(error)) return null; throw error }
    return await snapshots.readBoundedRegularFile(path.basename(filePath), OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES, signal)
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  } finally {
    await snapshots?.close().catch(() => undefined)
    await root?.close().catch(() => undefined)
  }
}

async function readImmutableProjectText(
  root: OpenCodeSafePublicationDirectory,
  scope: `sha256:${string}`,
  signal: AbortSignal,
): Promise<string | null> {
  let scopes: OpenCodeSafePublicationDirectory | null = null
  let scoped: OpenCodeSafePublicationDirectory | null = null
  let commits: OpenCodeSafePublicationDirectory | null = null
  let generations: OpenCodeSafePublicationDirectory | null = null
  let generation: OpenCodeSafePublicationDirectory | null = null
  try {
    if (await root.readBoundedRegularFile(
      OPEN_CODE_PASSIVE_TRANSACTION_MARKER, OPEN_CODE_PASSIVE_TRANSACTION_MARKER_MAX_BYTES, signal,
    ) !== OPEN_CODE_PASSIVE_TRANSACTION_MARKER_CONTENT) return null
    scopes = await root.openChildDirectory(OPEN_CODE_PASSIVE_SCOPES)
    scoped = await scopes.openChildDirectory(scope.slice(7))
    commits = await scoped.openChildDirectory(OPEN_CODE_PASSIVE_COMMITS)
    const names = (await commits.childNames()).filter(name => !OPEN_CODE_PASSIVE_COMMIT_TEMP_PATTERN.test(name))
    if (names.some(name => !OPEN_CODE_PASSIVE_COMMIT_NAME_PATTERN.test(name))) return null
    const candidates: Array<{ generation: string; domainGeneration: number }> = []
    for (const name of names) {
      const text = await commits.readBoundedRegularFile(name, OPEN_CODE_PASSIVE_COMMIT_MAX_BYTES, signal)
      if (text === null) return null
      const commit = decodeOpenCodePassiveSnapshotCommit(text)
      if (!commit || commit.scope !== scope
        || name !== `${String(commit.domainGeneration).padStart(16, '0')}.${commit.generation}.json`) return null
      candidates.push(commit)
    }
    candidates.sort((a, b) => b.domainGeneration - a.domainGeneration || b.generation.localeCompare(a.generation))
    if (!candidates[0]) return null
    generations = await scoped.openChildDirectory(OPEN_CODE_PASSIVE_GENERATIONS)
    const committed: Array<{ sequence: number; value: OpenCodeRedactedSnapshotV1 }> = []
    for (const candidate of candidates) {
      generation = await generations.openChildDirectory(candidate.generation)
      const [project, binary] = await Promise.all([
        generation.readBoundedRegularFile(OPEN_CODE_PASSIVE_GENERATION_PROJECT, OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES, signal),
        generation.readBoundedRegularFile(OPEN_CODE_PASSIVE_GENERATION_BINARY, OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES, signal),
      ])
      await generation.close(); generation = null
      if (project === null || binary === null || project !== binary) return null
      const decoded = decodeOpenCodeRedactedSnapshotV1(project)
      if (!decoded.ok || decoded.value.projectScope !== scope) return null
      committed.push({ sequence: candidate.domainGeneration, value: decoded.value })
    }
    return encodeMergedSnapshot(mergeCommittedSnapshots(scope, committed))
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  } finally {
    await generation?.close().catch(() => undefined)
    await generations?.close().catch(() => undefined)
    await commits?.close().catch(() => undefined)
    await scoped?.close().catch(() => undefined)
    await scopes?.close().catch(() => undefined)
  }
}

function snapshotIsFreshForCache(snapshot: OpenCodeRedactedSnapshotV1, now: number): boolean {
  const observations = [
    snapshot.binary,
    ...snapshot.providers.flatMap(provider => [
      provider.configured,
      provider.lastConnected,
      provider.catalogAvailable,
      provider.executionVerified,
    ]),
  ]
  return snapshot.capturedAt <= now && observations.every(observation =>
    observation.authority === 'none'
      || (observation.observedAt !== null && observation.validUntil !== null
        && observation.observedAt <= now && observation.validUntil >= now),
  )
}

function mergeCommittedSnapshots(
  scope: `sha256:${string}`,
  committed: readonly { sequence: number; value: OpenCodeRedactedSnapshotV1 }[],
): OpenCodeRedactedSnapshotV1 {
  const newest = committed.reduce((selected, item) => item.sequence > selected.sequence ? item : selected)
  const result = structuredClone(newest.value)
  result.projectScope = scope
  result.capturedAt = Math.max(...committed.map(item => item.value.capturedAt))
  result.binary = selectEvidence(committed.map(item => ({ sequence: item.sequence, value: item.value.binary })))
  const providerIds = [...new Set(committed.flatMap(item => item.value.providers.map(provider => provider.providerId)))].sort()
  result.providers = providerIds.map(providerId => {
    const sources = committed.flatMap(item => {
      const provider = item.value.providers.find(candidate => candidate.providerId === providerId)
      return provider ? [{ sequence: item.sequence, provider }] : []
    })
    const catalogSource = selectEvidenceSource(sources.map(source => ({
      sequence: source.sequence, value: source.provider.catalogAvailable, source: source.provider,
    })))
    const newestProvider = sources.reduce((selected, item) => item.sequence > selected.sequence ? item : selected).provider
    return {
      providerId,
      configured: selectEvidence(sources.map(source => ({ sequence: source.sequence, value: source.provider.configured }))),
      lastConnected: selectEvidence(sources.map(source => ({ sequence: source.sequence, value: source.provider.lastConnected }))),
      catalogAvailable: structuredClone(catalogSource.value),
      executionVerified: selectEvidence(sources.map(source => ({ sequence: source.sequence, value: source.provider.executionVerified }))),
      ...(newestProvider.fingerprint === undefined ? {} : { fingerprint: newestProvider.fingerprint }),
      ...(catalogSource.source.modelIds === undefined ? {} : { modelIds: [...catalogSource.source.modelIds] }),
      ...(catalogSource.source.modelIdsTotal === undefined ? {} : {
        modelIdsTotal: catalogSource.source.modelIdsTotal,
        modelIdsTruncated: catalogSource.source.modelIdsTruncated,
        modelIdsFingerprint: catalogSource.source.modelIdsFingerprint,
      }),
    }
  })
  return result
}

function selectEvidence<T>(items: readonly { sequence: number; value: T & { evidenceGeneration?: number } }[]): T {
  return structuredClone(selectEvidenceSource(items.map(item => ({ ...item, source: item.value }))).value)
}

function selectEvidenceSource<T, S>(items: readonly { sequence: number; value: T & { evidenceGeneration?: number }; source: S }[]) {
  return items.reduce((selected, item) => {
    const left = item.value.evidenceGeneration ?? item.sequence
    const right = selected.value.evidenceGeneration ?? selected.sequence
    if (left !== right) return left > right ? item : selected
    if (item.sequence !== selected.sequence) return item.sequence > selected.sequence ? item : selected
    // A malformed duplicate sequence cannot use a random generation identity as authority.
    return JSON.stringify(item.value) > JSON.stringify(selected.value) ? item : selected
  })
}

function encodeMergedSnapshot(value: OpenCodeRedactedSnapshotV1): string | null {
  const encoded = encodeOpenCodeRedactedSnapshotV1(value)
  return encoded.ok && encoded.bytes ? new TextDecoder().decode(encoded.bytes) : null
}

function isDirectObservation(
  observation: {
    authority: string
    freshness: string
    condition: string
    issueCode: string
    observedAt: number | null
    validUntil: number | null
  },
  authority: string,
): boolean {
  return observation.authority === authority
    && observation.freshness === 'fresh'
    && observation.condition === 'normal'
    && observation.issueCode === 'none'
    && observation.observedAt !== null
    && observation.validUntil !== null
}

function observationFailure(
  observation: { issueCode: string },
): ReturnType<typeof createOpenCodePassiveReadFailure> {
  if (observation.issueCode === 'read_timeout') return createOpenCodePassiveReadFailure('timeout')
  if (observation.issueCode === 'read_cancelled') return createOpenCodePassiveReadFailure('cancelled')
  return createOpenCodePassiveReadFailure('transient')
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')
}

function opaqueInputPathIdentity(projectPath: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update('opencode-project-input-v1\0').update(projectPath).digest('hex')}`
}
