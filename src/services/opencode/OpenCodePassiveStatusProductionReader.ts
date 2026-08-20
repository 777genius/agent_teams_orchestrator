import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
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
  OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES,
  type OpenCodeRedactedSnapshotV1,
} from './OpenCodeRedactedStatusSnapshot.js'
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
  rootDirectory?: string
  now?: () => number
  schedule?: OpenCodePassiveStatusReaderPorts['clock']['schedule']
  canonicalizePath?: (projectPath: string, signal: AbortSignal) => Promise<string>
  readBoundedText?: (filePath: string, signal: AbortSignal) => Promise<string | null>
}>

/**
 * Read-only production boundary for passive OpenCode status. It reads only the
 * app-owned redacted snapshot store; it has no inventory, host, process, launch,
 * provider API, network, profile preparation, or writer dependency.
 */
export class OpenCodePassiveStatusProductionReader {
  readonly reader: OpenCodePassiveStatusReader
  readonly #rootDirectory: string
  readonly #now: () => number
  readonly #canonicalizePath: (projectPath: string, signal: AbortSignal) => Promise<string>
  readonly #readBoundedText: (filePath: string, signal: AbortSignal) => Promise<string | null>
  readonly #snapshotLoads = new WeakMap<AbortSignal, Map<string, Promise<LoadedSnapshot | null>>>()
  readonly #binaryLoads = new WeakMap<AbortSignal, Promise<LoadedSnapshot | null>>()
  readonly #lastSnapshots = new Map<`sha256:${string}`, LoadedSnapshot>()

  constructor(deps: ProductionReaderDeps = {}) {
    this.#rootDirectory = deps.rootDirectory ?? getOpenCodePassiveStatusRootDirectory()
    this.#now = deps.now ?? Date.now
    this.#canonicalizePath = deps.canonicalizePath ?? canonicalizeOpenCodePassiveProjectPath
    this.#readBoundedText = deps.readBoundedText ?? readBoundedSnapshotText

    const snapshotRead = (
      projectScope: `sha256:${string}`,
      signal: AbortSignal,
      handoff: OpenCodePassiveReadHandoff<string | null>,
    ) => {
      const cached = this.#lastSnapshots.get(projectScope)
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
          observation => observation.value === 'unknown'
            ? null
            : { available: observation.value === 'available' },
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
    project: (observation: T) => U | null,
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
        const value = isDirectObservation(observation, authority) ? project(observation) : null
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
      load = this.#readAndDecode(snapshotPath(this.#rootDirectory, scope), signal, scope).then(loaded => {
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
    let load = this.#binaryLoads.get(signal)
    if (!load) {
      load = this.#readAndDecode(path.join(this.#rootDirectory, 'binary.snapshot.json'), signal, null)
      if (signal.aborted) return load
      this.#binaryLoads.set(signal, load)
    }
    return load
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

async function readBoundedSnapshotText(filePath: string, signal: AbortSignal): Promise<string | null> {
  let handle
  try {
    handle = await open(filePath, 'r')
    if (signal.aborted) throw cancelledError()
    const metadata = await handle.stat()
    if (signal.aborted) throw cancelledError()
    if (!metadata.isFile() || metadata.size > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES) return null
    const bytes = new Uint8Array(OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES + 1)
    const result = await handle.read(bytes, 0, bytes.byteLength, 0)
    if (signal.aborted) throw new Error('cancelled')
    if (result.bytesRead > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead))
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
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
