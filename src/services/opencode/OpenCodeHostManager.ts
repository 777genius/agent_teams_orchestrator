import { OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID } from './OpenCodePreflightLease.js'
export { OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID, createOpenCodePreflightHostLeaseInput } from './OpenCodePreflightLease.js'
import { buildResolvedConfigFingerprint } from './OpenCodeResolvedConfigFingerprint.js'
import { createHash, randomUUID } from 'node:crypto'
import { type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { Dirent } from 'node:fs'
import net from 'node:net'
import { mkdir, readlink, readdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { OpenCodeClientFactory, type OpenCodeClientRequestContext } from './OpenCodeClientFactory.js'
import { assertTrustedOpenCodeCustody, type OpenCodeHostAcquisitionPolicy,
  type OneUseFence, type TrustedOpenCodeCustody } from './OpenCodeSupervisedHostCustody.js'

import * as lockfile from '../../utils/lockfile.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { errorMessage } from '../../utils/errors.js'
import { sleep } from '../../utils/sleep.js'
import {
  killProcessTreeAndWait,
  readProcessCommandLine,
  readProcessStartTimeMs,
  signalExpectedProcessStable,
} from '../../utils/processKill.js'
import { spawnPortableCli } from '../../utils/portableCli.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import {
  prepareExecutingOpenCodeArtifactDigestToken,
  resolveOpenCodeArtifactDigest,
  resolveExecutingOpenCodeArtifactDigest,
  type OpenCodeArtifactDigest,
} from './OpenCodeArtifactDigest.js'
import { prewarmOpenCodeManagedSubscriptionPlugins } from './OpenCodeInventoryService.js'
import { openCodeProfileManager } from './OpenCodeProfileManager.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import {
  OpenCodeRuntimeDeadline,
  type OpenCodePhaseContext,
  raceOpenCodeAbortSignal,
  throwOpenCodeAbortReason,
  waitForOpenCodeAbortableDelay,
} from './OpenCodeRuntimeDeadline.js'

import type {
  OpenCodeHostHandle,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
} from './types.js'

const OPEN_CODE_HOST_HEALTH_TIMEOUT_MS = 30_000
const OPEN_CODE_HOST_HEALTH_TIMEOUT_MAX_MS = 60_000
const OPEN_CODE_HOST_HEALTH_POLL_MS = 250
const OPEN_CODE_HOST_HEALTH_REQUEST_TIMEOUT_MS = 1_000
const OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS = 2_500
const OPEN_CODE_HOST_DISPOSE_TIMEOUT_MS = 2_000
const OPEN_CODE_HOST_LEASE_REFRESH_INTERVAL_MS = 60_000
const OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS = 750
const OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS = 2_500
const OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_ATTEMPTS = 5
const OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_RETRY_MS = 50
const OPEN_CODE_MANAGED_HOST_CONFIG_GENERATION = 'provider-plugins-v1'
const OPEN_CODE_STALE_TEMP_DYLIB_AGE_MS = 24 * 60 * 60 * 1000
// Bun/OpenTUI temp dylib prefixes vary between builds (.bbb, .bbc, .b9dd, ...).
// Keep the match constrained to hidden hexadecimal dylibs inside the app-owned
// profile tmp directory so unrelated user files are never removed.
const OPENTUI_TEMP_DYLIB_RE = /^\.b[0-9a-f]+-[0-9a-f]+\.dylib$/i

export type OpenCodeHostLifetime = 'persistent' | 'process'

export async function resolveOpenCodeBinaryHostIdentity(binaryPath: string): Promise<string> {
  let resolvedPath = path.resolve(binaryPath)
  try {
    const target = await readlink(resolvedPath)
    resolvedPath = path.resolve(path.dirname(resolvedPath), target)
  } catch {
    // The executable is not a symlink or cannot be resolved. Its absolute path
    // remains a stable part of the identity.
  }
  const metadata = await stat(resolvedPath).catch(() => null)
  const source = [
    resolvedPath,
    metadata?.size ?? 'unknown-size',
    metadata?.mtimeMs ?? 'unknown-mtime',
  ].join('\0')
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

const PERSISTENT_REGISTRY_LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
}
const PERSISTENT_HOST_STARTUP_LOCK_OPTIONS = {
  stale: 30_000,
  update: 5_000,
  retries: 0,
}
const PERSISTENT_HOST_STARTUP_LOCK_RETRIES = 120
const PERSISTENT_HOST_STARTUP_LOCK_MIN_RETRY_MS = 100
const PERSISTENT_HOST_STARTUP_LOCK_MAX_RETRY_MS = 500

type ManagedHostEntry = {
  supervisor?: {
    custody: TrustedOpenCodeCustody
    leases: Set<string>
    hostedHoldings: Map<object, { provisional: boolean; sessionId: string | null }>
    operationHoldings: Set<object>
  }
  handle: OpenCodeHostHandle
  child: ChildProcess | null
  refCount: number
  ownedByProcess: boolean
  lifetime: OpenCodeHostLifetime
}

type FetchJsonResult = {
  status: number
  data: unknown
}

type OpenCodeHostManagerDeps = {
  acquisitionPolicy?: OpenCodeHostAcquisitionPolicy
  prepareProfile?: (
    projectPath?: string | null,
    options?: OpenCodePrepareProfileOptions,
  ) => Promise<OpenCodePreparedProfile>
  allocateLoopbackPort?: () => Promise<number>
  fetchJson?: (url: string, init?: RequestInit) => Promise<FetchJsonResult>
  spawnHostProcess?: (profile: OpenCodePreparedProfile, port: number) => ChildProcess
  sleepMs?: (ms: number) => Promise<void>
  isProcessAlive?: (pid: number) => boolean
  readProcessCommandLine?: (pid: number) => Promise<string | null>
  readProcessStartTimeMs?: (pid: number) => Promise<number | null>
  killProcess?: (pid: number, signal: NodeJS.Signals) => void
  killProcessTreeAndWait?: typeof killProcessTreeAndWait
  now?: () => Date
  persistentRegistryPath?: string | null
  beforeTempOwnershipMarkerPublish?: () => Promise<void>
  resolveOpenCodeArtifactDigest?: (binaryPath: string) => OpenCodeArtifactDigest | null
  /** Deterministic lower-boundary fault injection after receipt commit. */
  afterHostedAcquisitionCommitForTest?: () => void
  /** Deterministic lower-boundary fault injection after operation commit. */
  afterSupervisedOperationCommitForTest?: () => void
}

export type OpenCodeHostLeaseInput = {
  teamId: string
  laneId?: string | null
  memberName: string
  runId?: string | null
  sessionId?: string | null
}

export type OpenCodeSupervisedHostOperationInput = Readonly<{
  projectPath?: string | null
  hostKey?: string | null
  profileOptions?: OpenCodePrepareProfileOptions
  preparedProfile?: OpenCodePreparedProfile
  healthTimeoutMs?: number | null
  abortSignal?: AbortSignal
  lease: OpenCodeHostLeaseInput
}>

type SupervisedOperationState = {
  readonly identity: object
  entry: ManagedHostEntry | null
}

declare const openCodeHostedAcquisitionBrand: unique symbol
export type OpenCodeHostedAcquisition = Readonly<{ [openCodeHostedAcquisitionBrand]: true }>

export type OpenCodeHostedAcquisitionTuple = Readonly<{
  teamId: string
  runId: string
  laneId: string
  memberName: string
  profileRootKey: string
  hostKey: string
  openCodeArtifactDigest: string | null
}>

export type OpenCodeHostedPreparedHostInput = Readonly<{
  projectPath: string
  preparedProfile: OpenCodePreparedProfile
  healthTimeoutMs?: number | null
  abortSignal?: AbortSignal
}>

export type OpenCodeHostedAcquisitionSnapshot = Readonly<{
  actualTuple: OpenCodeHostedAcquisitionTuple
  host: OpenCodeHostHandle | null
  acquireState: 'reserved' | 'inflight' | 'not_acquired' | 'acquired'
  promotionState: 'absent' | 'inflight' | 'present'
  sessionId: string | null
  pending: Readonly<{ provisional: boolean; session: boolean; reference: boolean }>
}>

export class OpenCodeHostedAcquisitionCleanupPendingError extends Error {
  constructor() {
    super('OpenCode hosted acquisition cleanup is pending while an effect is in flight')
    this.name = 'OpenCodeHostedAcquisitionCleanupPendingError'
  }
}

type HostedAcquisitionState = {
  receipt: OpenCodeHostedAcquisition
  tuple: OpenCodeHostedAcquisitionTuple
  released: boolean
  entry: ManagedHostEntry | null
  host: OpenCodeHostHandle | null
  acquireState: OpenCodeHostedAcquisitionSnapshot['acquireState']
  promotionState: OpenCodeHostedAcquisitionSnapshot['promotionState']
  sessionId: string | null
  provisionalPending: boolean
  sessionPending: boolean
  referencePending: boolean
}

type PersistentHostLeaseRecord = {
  leaseKey: string
  teamId: string
  laneId: string
  memberName: string
  runId: string | null
  sessionId: string | null
  createdAt: string
  updatedAt: string
}

type PersistentHostRegistryRecord = {
  hostKey: string
  profileRootKey: string
  projectPath: string
  projectBehaviorFingerprint: string
  managedConfigFingerprint?: string | null
  baseUrl: string
  port: number
  pid: number
  processStartedAtMs?: number | null
  version: string | null
  resolvedConfigFingerprint: string | null
  updatedAt: string
  leases?: Record<string, PersistentHostLeaseRecord>
}

type PersistentHostRegistryShape = {
  schemaVersion: 1
  hosts: Record<string, PersistentHostRegistryRecord>
}

type PersistentHostProcessIdentity = {
  state: 'confirmed' | 'gone' | 'changed' | 'unverified'
  startedAtMs: number | null
}

export type OpenCodePersistentHostReconcileOptions = {
  mode?: 'stale' | 'force'
  reason?: 'startup' | 'shutdown' | 'manual' | string
  projectPath?: string | null
  staleAgeMs?: number | null
  leaseStaleAgeMs?: number | null
  preflightLeaseStaleAgeMs?: number | null
}

export type OpenCodePersistentHostReconcileResult = {
  cleaned: number
  remaining: number
  hosts: Array<{
    hostKey: string
    projectPath: string
    pid: number
    port: number
    action:
      | 'disposed'
      | 'removed_dead'
      | 'kept_active'
      | 'kept_leased'
      | 'kept_recent'
      | 'kept_filtered'
      | 'failed'
    reason: string
    leaseCount: number
  }>
  diagnostics: string[]
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function normalizeProjectPathForComparison(projectPath: string): Promise<string> {
  const resolved = path.resolve(projectPath)
  const canonical = await realpath(resolved).catch(() => resolved)
  const normalized = path.normalize(canonical)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate loopback port')))
        return
      }

      const port = address.port
      server.close(error => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

async function fetchJson(url: string, init?: RequestInit): Promise<FetchJsonResult> {
  const response = await fetch(url, init)
  const text = await response.text()

  let data: unknown = null
  if (text.trim().length > 0) {
    try {
      data = JSON.parse(text) as unknown
    } catch {
      data = text
    }
  }

  return {
    status: response.status,
    data,
  }
}

function defaultPersistentRegistryPath(): string {
  const paths = resolveClaudeMultimodelPaths()
  return path.join(paths.data, 'opencode', 'host-registry.json')
}

function getOpenCodeProfileTmpPath(profileRootKey: string): string {
  const paths = resolveClaudeMultimodelPaths()
  return path.join(paths.data, 'opencode', 'profiles', profileRootKey, 'tmp')
}

async function cleanupOpenTuiTempDylibs(tempPath: string): Promise<void> {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(tempPath, { withFileTypes: true })
  } catch {
    return
  }

  await Promise.all(
    entries
      .filter(entry => entry.isFile() && OPENTUI_TEMP_DYLIB_RE.test(entry.name))
      .map(entry => rm(path.join(tempPath, entry.name), { force: true }).catch(() => undefined)),
  )
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function buildLeaseKey(input: OpenCodeHostLeaseInput): string {
  const teamId = input.teamId.trim()
  const laneId = input.laneId?.trim() || 'primary'
  const memberName = input.memberName.trim()
  if (!teamId || !memberName) {
    throw new Error('OpenCode host lease requires teamId and memberName')
  }
  const sessionId = input.sessionId?.trim()
  if (sessionId) return `${teamId}::${laneId}::${memberName}::session:${sessionId}`
  const runId = input.runId?.trim()
  if (!runId) {
    throw new Error('Provisional OpenCode host lease requires an exact runId')
  }
  return `${teamId}::${laneId}::${memberName}::run:${runId}::__pre_session__`
}

function snapshotHostedAcquisitionTuple(input: OpenCodeHostedAcquisitionTuple): OpenCodeHostedAcquisitionTuple {
  const tuple = {
    teamId: input.teamId,
    runId: input.runId,
    laneId: input.laneId,
    memberName: input.memberName,
    profileRootKey: input.profileRootKey,
    hostKey: input.hostKey,
    openCodeArtifactDigest: input.openCodeArtifactDigest,
  }
  for (const [name, value] of Object.entries({
    teamId: tuple.teamId, runId: tuple.runId, laneId: tuple.laneId,
    memberName: tuple.memberName, profileRootKey: tuple.profileRootKey,
  })) {
    if (!value || value !== value.trim() || value.includes('::')) {
      throw new Error(`OpenCode hosted acquisition ${name} is not canonical`)
    }
  }
  if (tuple.openCodeArtifactDigest !== null &&
    (!tuple.openCodeArtifactDigest || tuple.openCodeArtifactDigest !== tuple.openCodeArtifactDigest.trim())) {
    throw new Error('OpenCode hosted acquisition artifact is not canonical')
  }
  if (tuple.laneId !== (tuple.laneId.trim() || 'primary')) {
    throw new Error('OpenCode hosted acquisition lane is not canonical')
  }
  return Object.freeze(tuple)
}

function normalizeOpenCodeHostHealthTimeoutMs(timeoutMs?: number | null): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return OPEN_CODE_HOST_HEALTH_TIMEOUT_MS
  }
  return Math.min(Math.max(Math.trunc(timeoutMs), 1), OPEN_CODE_HOST_HEALTH_TIMEOUT_MAX_MS)
}

function isExpectedPersistentOpenCodeHostCommand(
  command: string,
  record: PersistentHostRegistryRecord,
): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim()
  if (
    !/(?:^|[\s/\\])opencode(?:\.exe)?(?=["'\s]|$)/i.test(normalized) ||
    !/(?:^|\s)serve(?=\s|$)/i.test(normalized)
  ) {
    return false
  }
  const hasExpectedPort = new RegExp(
    `(?:^|\\s)--port(?:=|\\s+)${record.port}(?=\\s|$)`,
    'i',
  ).test(normalized)
  const hasLoopbackHostname =
    /(?:^|\s)--hostname(?:=|\s+)(?:127\.0\.0\.1|localhost|::1)(?=\s|$)/i.test(normalized)
  return hasExpectedPort && hasLoopbackHostname
}

function isOpenCodePreflightHostLease(lease: PersistentHostLeaseRecord): boolean {
  return lease.teamId === OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID
}

type UnrefableHandle = { unref?: () => void } | null | undefined

function unrefHandle(handle: UnrefableHandle): void {
  handle?.unref?.()
}

function unrefChildProcessHandle(child: ChildProcess): void {
  unrefHandle(child)
  unrefHandle(child.stdout as UnrefableHandle)
  unrefHandle(child.stderr as UnrefableHandle)
  unrefHandle(child.stdin as UnrefableHandle)
}

export function shouldUnrefOpenCodeHostProcess(
  lifetime: OpenCodeHostLifetime,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return lifetime === 'persistent' || platform !== 'win32'
}

export function buildOpenCodeHostSpawnOptions(
  profile: OpenCodePreparedProfile,
  platform: NodeJS.Platform = process.platform,
  options: { lifetime?: OpenCodeHostLifetime } = {},
): SpawnOptions {
  const lifetime = options.lifetime ?? 'persistent'
  return {
    cwd: profile.projectPath,
    env: profile.env,
    detached: lifetime === 'persistent' || platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  }
}

function normalizePersistentHostLeases(value: unknown): Record<string, PersistentHostLeaseRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const leases: Record<string, PersistentHostLeaseRecord> = {}
  for (const [key, rawLease] of Object.entries(value as Record<string, unknown>)) {
    if (!rawLease || typeof rawLease !== 'object' || Array.isArray(rawLease)) {
      continue
    }
    const lease = rawLease as Partial<PersistentHostLeaseRecord>
    if (
      typeof lease.teamId !== 'string' ||
      typeof lease.laneId !== 'string' ||
      typeof lease.memberName !== 'string' ||
      typeof lease.createdAt !== 'string' ||
      typeof lease.updatedAt !== 'string'
    ) {
      continue
    }
    const leaseKey =
      typeof lease.leaseKey === 'string' && lease.leaseKey.trim() ? lease.leaseKey : key
    leases[leaseKey] = {
      leaseKey,
      teamId: lease.teamId,
      laneId: lease.laneId,
      memberName: lease.memberName,
      runId: typeof lease.runId === 'string' && lease.runId.trim() ? lease.runId : null,
      sessionId:
        typeof lease.sessionId === 'string' && lease.sessionId.trim() ? lease.sessionId : null,
      createdAt: lease.createdAt,
      updatedAt: lease.updatedAt,
    }
  }
  return leases
}

const custodyManagers = new WeakMap<object, TrustedOpenCodeCustody>()
export function isOpenCodeHostManagerBoundToCustody(value: object, custody: TrustedOpenCodeCustody): boolean {
  return custodyManagers.get(value) === custody
}

export class OpenCodeHostManager {
  readonly #hosts = new Map<string, ManagedHostEntry>()
  readonly #hostedAcquisitions = new WeakMap<object, HostedAcquisitionState>()
  readonly #unsettledHostedAcquisitions = new Set<HostedAcquisitionState>()
  private readonly pendingHosts = new Map<string, Promise<OpenCodeHostHandle>>()
  private readonly pendingRefCounts = new Map<string, number>()
  private readonly pendingHostHealthTimeoutMs = new Map<string, number>()
  private installedArtifact: { binaryPath: string; digest: OpenCodeArtifactDigest | null } | null = null

  private readonly custody?: TrustedOpenCodeCustody
  private readonly supervisedClientFactory?: OpenCodeClientFactory
  #supervisedTail: Promise<unknown> = Promise.resolve()
  private readonly deps: OpenCodeHostManagerDeps

  constructor(deps: OpenCodeHostManagerDeps = {}) {
    deps = { ...deps }
    this.deps = Object.freeze({ ...deps })
    const policy = deps.acquisitionPolicy
    if (policy && policy.mode !== 'desktop') {
      if (policy.mode !== 'supervisor-adopt-only') throw new Error('OpenCode acquisition policy invalid')
      const custody = policy.custody
      assertTrustedOpenCodeCustody(custody)
      if (new.target !== OpenCodeHostManager) throw new Error('OpenCode supervised manager must use the admitted implementation')
      this.deps = Object.freeze({ ...deps, acquisitionPolicy: Object.freeze({ mode: 'supervisor-adopt-only', custody }) })
      this.custody = custody
      this.supervisedClientFactory = new OpenCodeClientFactory({
        acquisitionPolicy: { mode: 'supervisor-adopt-only', custody },
      })
      // Supervised consumers retain these exact operations. Neither subclasses
      // nor later instance/prototype assignments can replace a validated fence.
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(OpenCodeHostManager.prototype))) {
        if (name !== 'constructor' && typeof descriptor.value === 'function') {
          Object.defineProperty(this, name, { value: descriptor.value.bind(this) })
        } else if (descriptor.get) {
          Object.defineProperty(this, name, { get: descriptor.get.bind(this) })
        }
      }
      custodyManagers.set(this, custody)
      Object.freeze(this)
    }
  }

  isBoundToCustody(custody: TrustedOpenCodeCustody): boolean { return this.custody === custody }

  reserveHostedAcquisition(actual: OpenCodeHostedAcquisitionTuple): OpenCodeHostedAcquisition {
    if (!this.custody) throw new Error('OpenCode hosted acquisition requires the sealed supervised manager')
    const tuple = snapshotHostedAcquisitionTuple(actual)
    if (tuple.hostKey !== this.custody.hostKey ||
      tuple.profileRootKey !== this.custody.expected.profile.profileRootKey ||
      tuple.openCodeArtifactDigest !== `sha256:${this.custody.expected.executable.sha256}`) {
      throw new Error('OpenCode hosted acquisition tuple does not match custody')
    }
    const receipt = Object.freeze({}) as OpenCodeHostedAcquisition
    const state: HostedAcquisitionState = {
      receipt, tuple, released: false, entry: null, host: null,
      acquireState: 'reserved', promotionState: 'absent',
      sessionId: null, provisionalPending: false, sessionPending: false, referencePending: false,
    }
    this.#hostedAcquisitions.set(receipt, state)
    this.#unsettledHostedAcquisitions.add(state)
    return receipt
  }

  inspectHostedAcquisition(receipt: OpenCodeHostedAcquisition): OpenCodeHostedAcquisitionSnapshot {
    const state = this.#hostedAcquisitions.get(receipt)
    if (!state) throw new Error('OpenCode hosted acquisition receipt was not issued by this manager')
    return Object.freeze({
      actualTuple: state.tuple,
      host: state.host,
      acquireState: state.acquireState,
      promotionState: state.promotionState,
      sessionId: state.sessionId,
      pending: Object.freeze({
        provisional: state.provisionalPending,
        session: state.sessionPending,
        reference: state.referencePending,
      }),
    })
  }

  async acquireHostedHost(
    receipt: OpenCodeHostedAcquisition,
    input: OpenCodeHostedPreparedHostInput,
  ): Promise<OpenCodeHostHandle> {
    const state = this.#hostedAcquisitions.get(receipt)
    if (!this.custody || !state || state.released || state.acquireState !== 'reserved') {
      throw new Error('OpenCode hosted acquisition receipt is unavailable or already used')
    }
    const projectPath = input.projectPath
    const preparedProfile = structuredClone(input.preparedProfile)
    const healthTimeoutMs = input.healthTimeoutMs
    const abortSignal = input.abortSignal
    if (abortSignal !== undefined && !(abortSignal instanceof AbortSignal)) {
      throw new Error('OpenCode hosted acquisition requires a native AbortSignal')
    }
    if (projectPath !== this.custody.expected.profile.projectPath ||
      preparedProfile.projectPath !== projectPath || preparedProfile.profileRootKey !== state.tuple.profileRootKey) {
      throw new Error('OpenCode hosted prepared host input does not match its receipt')
    }
    const deadline = new OpenCodeRuntimeDeadline(normalizeOpenCodeHostHealthTimeoutMs(healthTimeoutMs))
    const abort = () => deadline.abort(abortSignal?.reason)
    let abortListenerInstalled = false
    let releaseOwnerResource: (() => void) | null = null
    state.acquireState = 'inflight'
    try {
      if (abortSignal) {
        abortSignal.addEventListener('abort', abort, { once: true })
        abortListenerInstalled = true
        if (abortSignal.aborted) abort()
      }
      releaseOwnerResource = this.custody.retainOwnerResource(() =>
        deadline.abort(new Error('OpenCode supervised custody lost')))
      const previous = this.#supervisedTail
      const pending = deadline.runPhase('host_start', async context => {
        await raceOpenCodeAbortSignal(previous, context.signal)
        context.throwIfExpired()
        return context
      }).then(context => this.adoptSupervisedHost({
        projectPath,
        hostKey: state.tuple.hostKey,
        preparedProfile,
        abortSignal,
        lease: {
          teamId: state.tuple.teamId,
          laneId: state.tuple.laneId,
          memberName: state.tuple.memberName,
          runId: state.tuple.runId,
        },
      }, context, state))
      this.#supervisedTail = previous.then(() => pending).catch(() => undefined)
      const handle = await pending
      this.deps.afterHostedAcquisitionCommitForTest?.()
      return handle
    } catch (error) {
      if (!state.entry) state.acquireState = 'not_acquired'
      throw error
    } finally {
      let finalizerError: unknown = null
      try { deadline.dispose() } catch (error) { finalizerError = error }
      try {
        if (abortListenerInstalled) abortSignal?.removeEventListener('abort', abort)
      } catch (error) {
        finalizerError ??= error
      }
      try { releaseOwnerResource?.() } catch (error) { finalizerError ??= error }
      if (finalizerError !== null) throw finalizerError
    }
  }

  async promoteHostedAcquisition(receipt: OpenCodeHostedAcquisition, sessionIdInput: string): Promise<void> {
    const state = this.#hostedAcquisitions.get(receipt)
    const sessionId = sessionIdInput.trim()
    if (!this.custody || !state || state.released || state.acquireState !== 'acquired' || !state.entry || !sessionId ||
      sessionId !== sessionIdInput) throw new Error('OpenCode hosted acquisition promotion unavailable')
    if (state.promotionState === 'present') {
      if (state.sessionId === sessionId) return
      throw new Error('OpenCode hosted acquisition was promoted to a different session')
    }
    if (state.promotionState === 'inflight') throw new OpenCodeHostedAcquisitionCleanupPendingError()
    state.promotionState = 'inflight'
    try {
      const token = await this.custody.prepareLeaseToken({
        teamId: state.tuple.teamId, laneId: state.tuple.laneId,
        memberName: state.tuple.memberName, sessionId,
      })
      const entry = state.entry
      const supervisor = entry.supervisor
      if (!token || !token.consume() || this.#hosts.get(state.tuple.hostKey) !== entry ||
        supervisor?.hostedHoldings.get(receipt)?.provisional !== true) {
        throw new Error('OpenCode hosted session admission unavailable')
      }
      const holding = supervisor.hostedHoldings.get(receipt)!
      holding.provisional = false
      holding.sessionId = sessionId
      state.provisionalPending = false
      state.sessionPending = true
      state.sessionId = sessionId
      state.promotionState = 'present'
    } catch (error) {
      if (state.promotionState === 'inflight') state.promotionState = 'absent'
      throw error
    }
  }

  async releaseHostedAcquisition(receipt: OpenCodeHostedAcquisition): Promise<void> {
    const state = this.#hostedAcquisitions.get(receipt)
    if (!state) throw new Error('OpenCode hosted acquisition receipt was not issued by this manager')
    if (state.acquireState === 'inflight' || state.promotionState === 'inflight') {
      throw new OpenCodeHostedAcquisitionCleanupPendingError()
    }
    if (state.released) return
    if (!state.referencePending) {
      if (state.acquireState === 'reserved') state.acquireState = 'not_acquired'
      state.released = true
      this.#unsettledHostedAcquisitions.delete(state)
      return
    }
    const entry = state.entry
    const supervisor = entry?.supervisor
    if (!entry || !supervisor || this.#hosts.get(state.tuple.hostKey) !== entry ||
      supervisor.hostedHoldings.get(receipt) === undefined) {
      throw new Error('OpenCode hosted acquisition entry generation is unavailable')
    }
    supervisor.hostedHoldings.delete(receipt)
    state.provisionalPending = false
    state.sessionPending = false
    entry.refCount = Math.max(0, entry.refCount - 1)
    state.referencePending = false
    state.released = true
    if (this.#hosts.get(state.tuple.hostKey) === entry && entry.refCount === 0 &&
      supervisor.leases.size === 0 && supervisor.hostedHoldings.size === 0 &&
      supervisor.operationHoldings.size === 0) this.#hosts.delete(state.tuple.hostKey)
    this.#unsettledHostedAcquisitions.delete(state)
  }

  /** Retains one exact supervised host entry only for the lifetime of callback. */
  async withSupervisedHostOperation<T>(
    input: OpenCodeSupervisedHostOperationInput,
    callback: (host: OpenCodeHostHandle) => Promise<T>,
  ): Promise<T> {
    if (!this.custody) throw new Error('OpenCode supervised host operation requires the sealed supervised manager')
    if (typeof callback !== 'function') throw new Error('OpenCode supervised host operation callback unavailable')
    if (input.abortSignal !== undefined && !(input.abortSignal instanceof AbortSignal)) {
      throw new Error('OpenCode supervised host operation requires a native AbortSignal')
    }
    const params = Object.freeze({
      projectPath: input.projectPath,
      hostKey: input.hostKey,
      profileOptions: input.profileOptions ? Object.freeze({ ...input.profileOptions }) : undefined,
      preparedProfile: input.preparedProfile
        ? Object.freeze(structuredClone(input.preparedProfile)) as OpenCodePreparedProfile
        : undefined,
      healthTimeoutMs: input.healthTimeoutMs,
      abortSignal: input.abortSignal,
      lease: Object.freeze({ ...input.lease }),
    })
    const operation: SupervisedOperationState = { identity: Object.freeze({}), entry: null }
    const deadline = new OpenCodeRuntimeDeadline(normalizeOpenCodeHostHealthTimeoutMs(params.healthTimeoutMs))
    const abort = () => deadline.abort(params.abortSignal?.reason)
    let abortListenerInstalled = false
    let releaseOwnerResource: (() => void) | null = null
    try {
      let host: OpenCodeHostHandle
      try {
        if (params.abortSignal) {
          params.abortSignal.addEventListener('abort', abort, { once: true })
          abortListenerInstalled = true
          if (params.abortSignal.aborted) abort()
        }
        releaseOwnerResource = this.custody.retainOwnerResource(() =>
          deadline.abort(new Error('OpenCode supervised custody lost')))
        const previous = this.#supervisedTail
        const pending = deadline.runPhase('host_start', async context => {
          await raceOpenCodeAbortSignal(previous, context.signal)
          context.throwIfExpired()
          return context
        }).then(context => this.adoptSupervisedHost(params, context, undefined, operation))
        this.#supervisedTail = previous.then(() => pending).catch(() => undefined)
        host = await pending
        this.deps.afterSupervisedOperationCommitForTest?.()
      } finally {
        let finalizerError: unknown = null
        try { deadline.dispose() } catch (error) { finalizerError = error }
        try {
          if (abortListenerInstalled) params.abortSignal?.removeEventListener('abort', abort)
        } catch (error) { finalizerError ??= error }
        try { releaseOwnerResource?.() } catch (error) { finalizerError ??= error }
        if (finalizerError !== null) throw finalizerError
      }
      // Acquisition serialization ends at commit; callbacks may reenter the
      // manager or remain pending without blocking later adoptions.
      return await callback(host)
    } finally {
      const entry = operation.entry
      const supervisor = entry?.supervisor
      if (entry && supervisor && this.#hosts.get(this.custody.hostKey) === entry &&
        supervisor.operationHoldings.delete(operation.identity) && entry.refCount === 0 &&
        supervisor.leases.size === 0 && supervisor.hostedHoldings.size === 0 &&
        supervisor.operationHoldings.size === 0) {
        this.#hosts.delete(this.custody.hostKey)
      }
    }
  }

  private resolveInstalledArtifact(binaryPath: string | null): OpenCodeArtifactDigest | null {
    if (!binaryPath || this.deps.spawnHostProcess || process.platform !== 'linux') return null
    // A manager retains one resolved production launcher. Re-proving the source
    // belongs at the effect edge; repeated ensureHost calls must not rehash it.
    if (this.installedArtifact?.binaryPath === binaryPath) return this.installedArtifact.digest
    const digest = (this.deps.resolveOpenCodeArtifactDigest ?? resolveOpenCodeArtifactDigest)(binaryPath)
    this.installedArtifact = { binaryPath, digest }
    return digest
  }

  private async prepareProfile(
    projectPath?: string | null,
    options?: OpenCodePrepareProfileOptions,
  ): Promise<OpenCodePreparedProfile> {
    const prepareProfile =
      this.deps.prepareProfile ?? openCodeProfileManager.prepareProfile.bind(openCodeProfileManager)
    return prepareProfile(projectPath, options)
  }

  private async fetchJson(url: string, init?: RequestInit, requestTimeoutMs?: number,
    context?: OpenCodeClientRequestContext): Promise<FetchJsonResult> {
    if (this.custody) {
      const base = this.custody.expected.endpoint.baseUrl
      const client = this.supervisedClientFactory!.create(base, {
        ...context, signal: context?.signal ?? init?.signal ?? undefined, requestTimeoutMs,
      })
      const reads: Record<string, () => Promise<unknown>> = {
        [`${base}/global/health`]: () => client.getHealth!(),
        [`${base}/config`]: () => client.getConfig(),
        [`${base}/config/providers`]: () => client.getConfigProviders(),
        [`${base}/agent`]: () => client.listAgents(),
        [`${base}/mcp`]: () => client.getMcp(),
      }
      const read = reads[url]
      if (!read) throw new Error('OpenCode supervised host observation unavailable')
      return { status: 200, data: await read() }
    }
    return (this.deps.fetchJson ?? fetchJson)(url, init)
  }

  private async fetchJsonWithTimeout(
    url: string,
    timeoutMs: number,
    init?: RequestInit,
    context?: OpenCodeClientRequestContext,
  ): Promise<FetchJsonResult> {
    // The supervised transport separately bounds proof preparation and response
    // time. An outer desktop timer would expire while synchronous hashing runs.
    if (this.custody) return this.fetchJson(url, init, timeoutMs, context)
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    try {
      return await this.fetchJson(url, {
        ...init,
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`OpenCode host request timed out after ${timeoutMs}ms for ${url}`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private async allocateLoopbackPort(): Promise<number> {
    return (this.deps.allocateLoopbackPort ?? allocateLoopbackPort)()
  }

  private async sleepMs(ms: number): Promise<void> {
    return (this.deps.sleepMs ?? ((delay: number) => sleep(delay)))(ms)
  }

  private get persistentRegistryPath(): string | null {
    return this.deps.persistentRegistryPath === undefined
      ? defaultPersistentRegistryPath()
      : this.deps.persistentRegistryPath
  }

  private getPersistentProfileTmpPath(profileRootKey: string): string {
    const registryPath = this.persistentRegistryPath
    return registryPath
      ? path.join(path.dirname(registryPath), 'profiles', profileRootKey, 'tmp')
      : getOpenCodeProfileTmpPath(profileRootKey)
  }

  private isProcessAlive(pid: number): boolean {
    return (this.deps.isProcessAlive ?? isProcessAlive)(pid)
  }

  private async readProcessStartTimeMs(pid: number): Promise<number | null> {
    if (this.deps.readProcessStartTimeMs) {
      return this.deps.readProcessStartTimeMs(pid)
    }
    return readProcessStartTimeMs(pid)
  }

  private async readProcessCommandLine(pid: number): Promise<string | null> {
    if (this.deps.readProcessCommandLine) {
      return this.deps.readProcessCommandLine(pid)
    }
    return readProcessCommandLine(pid)
  }

  private async captureProcessStartTimeMs(
    pid: number,
    abortSignal?: AbortSignal,
  ): Promise<number | null> {
    if (this.deps.spawnHostProcess && !this.deps.readProcessStartTimeMs) {
      return null
    }
    for (
      let attempt = 0;
      attempt < OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_ATTEMPTS;
      attempt += 1
    ) {
      if (abortSignal?.aborted) {
        throwOpenCodeAbortReason(abortSignal)
      }
      const startedAtMs = await this.readProcessStartTimeMs(pid).catch(() => null)
      if (Number.isFinite(startedAtMs) && startedAtMs !== null) {
        return startedAtMs
      }
      if (!this.isProcessAlive(pid)) {
        return null
      }
      if (attempt + 1 < OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_ATTEMPTS) {
        await waitForOpenCodeAbortableDelay(
          OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_RETRY_MS,
          abortSignal,
        )
      }
    }
    return null
  }

  private async verifyLegacyPersistentHostIdentity(
    record: PersistentHostRegistryRecord,
    startedAtMs: number | null,
  ): Promise<number> {
    if (!Number.isFinite(startedAtMs) || startedAtMs === null) {
      throw new Error(`OpenCode host pid ${record.pid} has no verifiable process start time`)
    }
    const startedAtMsBeforeProbe = await this.readProcessStartTimeMs(record.pid).catch(() => null)
    if (startedAtMsBeforeProbe !== startedAtMs) {
      throw new Error(`OpenCode host pid ${record.pid} identity changed before legacy migration`)
    }
    const command = await this.readProcessCommandLine(record.pid).catch(() => null)
    if (!command || !isExpectedPersistentOpenCodeHostCommand(command, record)) {
      throw new Error(
        `OpenCode host pid ${record.pid} command does not match the registered serve endpoint`,
      )
    }
    if (!record.resolvedConfigFingerprint) {
      throw new Error(
        `OpenCode host pid ${record.pid} has no resolved config fingerprint for safe migration`,
      )
    }
    const currentFingerprint = await this.getResolvedConfigFingerprint(record.baseUrl)
    if (!currentFingerprint || currentFingerprint !== record.resolvedConfigFingerprint) {
      throw new Error(
        `OpenCode host pid ${record.pid} resolved config fingerprint changed during migration`,
      )
    }
    const startedAtMsAfterProbe = await this.readProcessStartTimeMs(record.pid).catch(() => null)
    if (startedAtMsAfterProbe !== startedAtMs) {
      throw new Error(`OpenCode host pid ${record.pid} identity changed during legacy migration`)
    }
    return startedAtMs
  }

  private async inspectPersistentHostProcessIdentity(
    record: PersistentHostRegistryRecord,
  ): Promise<PersistentHostProcessIdentity> {
    if (!this.isProcessAlive(record.pid)) {
      return { state: 'gone', startedAtMs: null }
    }

    const startedAtMs = await this.readProcessStartTimeMs(record.pid).catch(() => null)
    if (!Number.isFinite(startedAtMs) || startedAtMs === null) {
      if (!this.isProcessAlive(record.pid)) {
        return { state: 'gone', startedAtMs: null }
      }
      // Unit tests commonly inject synthetic process control without creating a
      // real OS process. Production cleanup remains fail-closed when identity
      // cannot be read.
      const syntheticProcessControl =
        !this.deps.readProcessStartTimeMs &&
        Boolean(this.deps.isProcessAlive || this.deps.killProcess)
      return {
        state: syntheticProcessControl ? 'confirmed' : 'unverified',
        startedAtMs: null,
      }
    }

    if (
      Number.isFinite(record.processStartedAtMs) &&
      record.processStartedAtMs !== null &&
      record.processStartedAtMs !== undefined
    ) {
      return {
        state: record.processStartedAtMs === startedAtMs ? 'confirmed' : 'changed',
        startedAtMs,
      }
    }

    // A legacy PID-only record has no immutable baseline. updatedAt is not a
    // safe substitute because lease refreshes can move it past a PID reuse.
    return { state: 'unverified', startedAtMs }
  }

  private async assertPersistentHostProcessIdentity(
    record: PersistentHostRegistryRecord,
    expectedStartedAtMs?: number | null,
  ): Promise<'confirmed' | 'gone'> {
    const expectedRecord = Number.isFinite(expectedStartedAtMs) && expectedStartedAtMs !== null
      ? { ...record, processStartedAtMs: expectedStartedAtMs }
      : record
    const identity = await this.inspectPersistentHostProcessIdentity(expectedRecord)
    if (identity.state === 'gone') {
      return 'gone'
    }
    if (identity.state !== 'confirmed') {
      throw new Error(
        identity.state === 'changed'
          ? `OpenCode host pid ${record.pid} identity changed; refusing to terminate a reused pid`
          : `OpenCode host pid ${record.pid} identity could not be verified; refusing unsafe termination`,
      )
    }
    return 'confirmed'
  }

  private async killProcessAndWait(
    pid: number,
    signal: NodeJS.Signals,
    timeoutMs: number,
    expectedStartedAtMs?: number | null,
  ): Promise<boolean> {
    if (this.deps.killProcess) {
      this.deps.killProcess(pid, signal)
      await this.sleepMs(Math.min(timeoutMs, 250)).catch(() => undefined)
      return !this.isProcessAlive(pid)
    }
    return (this.deps.killProcessTreeAndWait ?? killProcessTreeAndWait)(pid, signal, {
      timeoutMs,
      expectedStartedAtMs,
      dependencies: {
        isProcessAlive: this.deps.isProcessAlive,
        readProcessStartTimeMs: this.deps.readProcessStartTimeMs,
        signalExpectedProcess: signalExpectedProcessStable,
      },
    })
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  private nowMs(): number {
    return this.now().getTime()
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private async readPersistentRegistry(): Promise<PersistentHostRegistryShape> {
    return this.readPersistentRegistryUnlocked()
  }

  private hasTrackedAliveHostUsingTempPath(tempPath: string, ignoredPid?: number): boolean {
    for (const entry of this.#hosts.values()) {
      const pid = entry.handle.pid
      if (entry.handle.profile.tmpPath !== tempPath) {
        continue
      }
      if (typeof ignoredPid === 'number' && pid === ignoredPid) {
        continue
      }
      if (pid > 0 && this.isProcessAlive(pid)) {
        return true
      }
    }
    return false
  }

  private getTempOwnershipMarkerPath(tempPath: string): string {
    return path.join(tempPath, '.opencode-host-owners')
  }

  private async withTempOwnershipLock<T>(
    tempPath: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    await mkdir(tempPath, { recursive: true })
    const lockPath = path.join(tempPath, '.opencode-host-owners.lock')
    await writeFile(lockPath, '', { flag: 'a' })
    const release = await lockfile.lock(lockPath, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 80, minTimeout: 5, maxTimeout: 50 },
    })
    try {
      return await callback()
    } finally {
      await release()
    }
  }

  private async publishTempOwnershipMarker(tempPath: string, pid: number): Promise<void> {
    if (pid <= 0) return
    await this.withTempOwnershipLock(tempPath, async () => {
      await this.publishTempOwnershipMarkerUnlocked(tempPath, pid)
    })
  }

  private async publishTempOwnershipMarkerUnlocked(tempPath: string, pid: number): Promise<void> {
    if (pid <= 0) throw new Error('OpenCode host did not publish a process id')
    const markerDir = this.getTempOwnershipMarkerPath(tempPath)
    await mkdir(markerDir, { recursive: true })
    await writeJsonFileAtomic(path.join(markerDir, `${pid}.json`), {
      pid,
      startedAtMs: await this.readProcessStartTimeMs(pid).catch(() => null),
    })
  }

  private async hasLiveTempOwnershipMarker(tempPath: string): Promise<boolean> {
    const markerDir = this.getTempOwnershipMarkerPath(tempPath)
    const markers = await readdir(markerDir).catch(() => [])
    for (const name of markers) {
      const marker = await readFile(path.join(markerDir, name), 'utf8').then(value => JSON.parse(value) as {
        pid?: unknown
        startedAtMs?: unknown
      }).catch(() => null)
      if (!marker || typeof marker.pid !== 'number' || !this.isProcessAlive(marker.pid)) continue
      if (typeof marker.startedAtMs !== 'number') return true
      if ((await this.readProcessStartTimeMs(marker.pid).catch(() => null)) === marker.startedAtMs) return true
    }
    return false
  }

  private async cleanupOpenTuiTempArtifactsIfUnused(tempPath: string, pid?: number): Promise<void> {
    await this.withTempOwnershipLock(tempPath, async () => {
      if (typeof pid === 'number' && pid > 0 && this.isProcessAlive(pid)) return
      if (this.hasTrackedAliveHostUsingTempPath(tempPath, pid)) return
      if (await this.hasLiveTempOwnershipMarker(tempPath)) return
      // Final recheck is under the same ownership lock used by publishers.
      if (this.hasTrackedAliveHostUsingTempPath(tempPath, pid)) return
      if (await this.hasLiveTempOwnershipMarker(tempPath)) return
      await cleanupOpenTuiTempDylibs(tempPath).catch(() => undefined)
    })
  }

  private async cleanupStaleManagedProfileTempDylibs(
    activeProfileRootKeys: ReadonlySet<string>,
  ): Promise<{ removed: number; bytes: number }> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return { removed: 0, bytes: 0 }
    }
    const profilesRootPath = path.join(path.dirname(registryPath), 'profiles')
    const profiles = await readdir(profilesRootPath, { withFileTypes: true }).catch(() => [])
    const staleBeforeMs = this.nowMs() - OPEN_CODE_STALE_TEMP_DYLIB_AGE_MS
    let removed = 0
    let bytes = 0

    for (const profile of profiles) {
      if (!profile.isDirectory() || activeProfileRootKeys.has(profile.name)) {
        continue
      }
      const tmpPath = path.join(profilesRootPath, profile.name, 'tmp')
      await this.withTempOwnershipLock(tmpPath, async () => {
        if (await this.hasLiveTempOwnershipMarker(tmpPath)) return
        const entries = await readdir(tmpPath, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (!entry.isFile() || !OPENTUI_TEMP_DYLIB_RE.test(entry.name)) continue
          const filePath = path.join(tmpPath, entry.name)
          const metadata = await stat(filePath).catch(() => null)
          if (!metadata || metadata.mtimeMs > staleBeforeMs) continue
          if (await this.hasLiveTempOwnershipMarker(tmpPath)) return
          await unlink(filePath).catch(() => undefined)
          const stillExists = await stat(filePath).then(() => true).catch(() => false)
          if (!stillExists) {
            removed += 1
            bytes += metadata.size
          }
        }
      })
    }

    return { removed, bytes }
  }

  private async readPersistentRegistryUnlocked(): Promise<PersistentHostRegistryShape> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return { schemaVersion: 1, hosts: {} }
    }

    try {
      const parsed = JSON.parse(
        await readFile(registryPath, 'utf8'),
      ) as Partial<PersistentHostRegistryShape>
      if (parsed.schemaVersion !== 1 || !parsed.hosts || typeof parsed.hosts !== 'object') {
        return { schemaVersion: 1, hosts: {} }
      }
      const hosts = Object.fromEntries(
        Object.entries(parsed.hosts as Record<string, PersistentHostRegistryRecord>).map(
          ([hostKey, record]) => [
            hostKey,
            {
              ...record,
              leases: normalizePersistentHostLeases(record.leases),
            },
          ],
        ),
      )
      return { schemaVersion: 1, hosts }
    } catch {
      return { schemaVersion: 1, hosts: {} }
    }
  }

  private async writePersistentRegistryUnlocked(
    registry: PersistentHostRegistryShape,
  ): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }
    await writeJsonFileAtomic(registryPath, registry, { indent: 2 })
  }

  private buildPersistentHostRecord(
    handle: OpenCodeHostHandle,
    previous?: PersistentHostRegistryRecord,
  ): PersistentHostRegistryRecord {
    return {
      hostKey: handle.hostKey,
      profileRootKey: handle.profileRootKey,
      projectPath: handle.projectPath,
      projectBehaviorFingerprint: handle.projectBehaviorFingerprint,
      managedConfigFingerprint: handle.profile.managedConfigFingerprint,
      baseUrl: handle.baseUrl,
      port: handle.port,
      pid: handle.pid,
      processStartedAtMs: handle.processStartedAtMs,
      version: handle.version,
      resolvedConfigFingerprint: handle.resolvedConfigFingerprint,
      updatedAt: this.nowIso(),
      leases: normalizePersistentHostLeases(previous?.leases),
    }
  }

  private async ensurePersistentRegistryLockFile(): Promise<string | null> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return null
    }
    await mkdir(path.dirname(registryPath), { recursive: true })
    const lockPath = `${registryPath}.lock`
    await writeFile(lockPath, '', { flag: 'a' })
    return lockPath
  }

  private async withPersistentRegistryLock<T>(callback: () => Promise<T>): Promise<T> {
    const lockPath = await this.ensurePersistentRegistryLockFile()
    if (!lockPath) {
      return callback()
    }

    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(lockPath, PERSISTENT_REGISTRY_LOCK_OPTIONS)
      return await callback()
    } finally {
      if (release) {
        await release()
      }
    }
  }

  private async withPersistentHostStartupLock<T>(
    hostKey: string,
    callback: () => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return callback()
    }

    const lockDir = path.join(path.dirname(registryPath), 'host-startup-locks')
    await mkdir(lockDir, { recursive: true })
    const lockPath = path.join(lockDir, `${hashText(hostKey)}.lock`)
    await writeFile(lockPath, '', { flag: 'a' })

    let release: (() => Promise<void>) | undefined
    try {
      release = await this.acquirePersistentHostStartupLock(lockPath, abortSignal)
      if (abortSignal?.aborted) {
        throwOpenCodeAbortReason(abortSignal)
      }
      return await callback()
    } finally {
      if (release) {
        await release()
      }
    }
  }

  private async acquirePersistentHostStartupLock(
    lockPath: string,
    abortSignal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    let retryDelayMs = PERSISTENT_HOST_STARTUP_LOCK_MIN_RETRY_MS
    for (let attempt = 0; ; attempt += 1) {
      if (abortSignal?.aborted) {
        throwOpenCodeAbortReason(abortSignal)
      }
      try {
        return await lockfile.lock(lockPath, PERSISTENT_HOST_STARTUP_LOCK_OPTIONS)
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined
        if (code !== 'ELOCKED' || attempt >= PERSISTENT_HOST_STARTUP_LOCK_RETRIES) {
          throw error
        }
      }
      await waitForOpenCodeAbortableDelay(retryDelayMs, abortSignal)
      retryDelayMs = Math.min(
        PERSISTENT_HOST_STARTUP_LOCK_MAX_RETRY_MS,
        retryDelayMs * 2,
      )
    }
  }

  private async upsertPersistentHost(handle: OpenCodeHostHandle): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath || handle.pid <= 0) {
      return
    }
    await this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      const previous = registry.hosts[handle.hostKey]
      registry.hosts[handle.hostKey] = this.buildPersistentHostRecord(handle, previous)
      await this.writePersistentRegistryUnlocked(registry)
    })
  }

  private async upsertPersistentHostWithLease(
    handle: OpenCodeHostHandle,
    lease: OpenCodeHostLeaseInput,
  ): Promise<void> {
    if (!this.persistentRegistryPath || handle.pid <= 0) return
    await this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      const previous = registry.hosts[handle.hostKey]
      const record = this.buildPersistentHostRecord(handle, previous)
      const now = this.nowIso()
      const leaseKey = buildLeaseKey(lease)
      record.leases[leaseKey] = {
        leaseKey,
        teamId: lease.teamId.trim(),
        laneId: lease.laneId?.trim() || 'primary',
        memberName: lease.memberName.trim(),
        runId: lease.runId?.trim() || null,
        sessionId: lease.sessionId?.trim() || null,
        createdAt: record.leases[leaseKey]?.createdAt ?? now,
        updatedAt: now,
      }
      registry.hosts[handle.hostKey] = { ...record, updatedAt: now }
      await this.writePersistentRegistryUnlocked(registry)
    })
  }

  private async removePersistentHost(hostKey: string): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }
    await this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      if (!registry.hosts[hostKey]) {
        return
      }
      delete registry.hosts[hostKey]
      if (Object.keys(registry.hosts).length === 0) {
        await unlink(registryPath).catch(() => undefined)
        return
      }
      await this.writePersistentRegistryUnlocked(registry)
    })
  }

  async retainHostLease(hostKey: string, input: OpenCodeHostLeaseInput): Promise<void> {
    input = Object.freeze({ ...input })
    if (this.custody) {
      const entry = this.#hosts.get(hostKey)
      const token = await this.custody.prepareLeaseToken(input)
      const valid = token?.consume() ?? false
      if (!valid || !entry?.supervisor || this.#hosts.get(hostKey) !== entry) {
        throw new Error('OpenCode supervised lease unavailable')
      }
      entry.supervisor.leases.add(buildLeaseKey(input))
      return
    }
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }
    if (this.#hosts.get(hostKey)?.lifetime === 'process') return

    await this.withPersistentRegistryLock(async () => {
      const leaseKey = buildLeaseKey(input)
      const registry = await this.readPersistentRegistryUnlocked()
      let record = registry.hosts[hostKey]
      if (!record) {
        const entry = this.#hosts.get(hostKey)
        if (!entry) {
          throw new Error(`OpenCode host ${hostKey} is unavailable for lease publication`)
        }
        if (entry.lifetime !== 'persistent') {
          return
        }
        const identity = await this.inspectPersistentHostProcessIdentity({
          ...this.buildPersistentHostRecord(entry.handle),
          processStartedAtMs: entry.handle.processStartedAtMs,
        })
        if (identity.state !== 'confirmed') {
          throw new Error(
            `OpenCode host ${hostKey} cannot publish a lease because its process identity is ${identity.state}`,
          )
        }
        record = this.buildPersistentHostRecord(entry.handle)
        registry.hosts[hostKey] = record
      }

      const nowDate = this.now()
      const now = nowDate.toISOString()
      const nowMs = nowDate.getTime()
      const leases = normalizePersistentHostLeases(record.leases)
      const previous = leases[leaseKey]
      const runId = input.runId?.trim() || previous?.runId || null
      const sessionId = input.sessionId?.trim() || previous?.sessionId || null
      const previousUpdatedAtMs = previous ? Date.parse(previous.updatedAt) : 0
      if (
        previous &&
        previous.runId === runId &&
        previous.sessionId === sessionId &&
        Number.isFinite(previousUpdatedAtMs) &&
        nowMs - previousUpdatedAtMs < OPEN_CODE_HOST_LEASE_REFRESH_INTERVAL_MS
      ) {
        return
      }
      leases[leaseKey] = {
        leaseKey,
        teamId: input.teamId.trim(),
        laneId: input.laneId?.trim() || 'primary',
        memberName: input.memberName.trim(),
        runId,
        sessionId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      }
      registry.hosts[hostKey] = {
        ...record,
        leases,
        updatedAt: now,
      }
      await this.writePersistentRegistryUnlocked(registry)
    })
  }

  async releaseHostLease(hostKey: string, input: OpenCodeHostLeaseInput): Promise<void> {
    input = Object.freeze({ ...input })
    if (this.custody) {
      const entry = this.#hosts.get(hostKey)
      entry?.supervisor?.leases.delete(buildLeaseKey(input))
      if (entry?.supervisor && this.#hosts.get(hostKey) === entry && entry.refCount === 0 &&
        entry.supervisor.leases.size === 0 && entry.supervisor.hostedHoldings.size === 0 &&
        entry.supervisor.operationHoldings.size === 0) this.#hosts.delete(hostKey)
      return
    }
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }

    await this.withPersistentRegistryLock(async () => {
      const leaseKey = buildLeaseKey(input)
      const registry = await this.readPersistentRegistryUnlocked()
      const record = registry.hosts[hostKey]
      if (!record) {
        return
      }
      const leases = normalizePersistentHostLeases(record.leases)
      if (!leases[leaseKey]) {
        return
      }
      delete leases[leaseKey]
      registry.hosts[hostKey] = {
        ...record,
        leases,
        updatedAt: this.nowIso(),
      }
      await this.writePersistentRegistryUnlocked(registry)
    })
  }

  private async checkHealthyHostOnce(baseUrl: string, context?: OpenCodeClientRequestContext): Promise<{ version: string | null } | null> {
    try {
      const result = await this.fetchJsonWithTimeout(
        `${baseUrl}/global/health`,
        OPEN_CODE_HOST_HEALTH_REQUEST_TIMEOUT_MS,
        undefined, context,
      )
      const data = result.data as { healthy?: boolean; version?: string }
      if (result.status === 200 && data?.healthy === true) {
        return {
          version: typeof data.version === 'string' ? data.version : null,
        }
      }
      return null
    } catch {
      return null
    }
  }

  private async adoptPersistentHost(
    hostKey: string,
    profile: OpenCodePreparedProfile,
    openCodeArtifactDigest: OpenCodeArtifactDigest | null,
    resolveConfigFingerprint: boolean,
    lease?: OpenCodeHostLeaseInput,
  ): Promise<OpenCodeHostHandle | null> {
    let leaseReserved = false
    const record = lease && this.persistentRegistryPath
      ? await this.withPersistentRegistryLock(async () => {
          const registry = await this.readPersistentRegistryUnlocked()
          const candidate = registry.hosts[hostKey]
          if (!candidate) return null
          const now = this.nowIso()
          const leaseKey = buildLeaseKey(lease)
          candidate.leases[leaseKey] = {
            leaseKey,
            teamId: lease.teamId.trim(),
            laneId: lease.laneId?.trim() || 'primary',
            memberName: lease.memberName.trim(),
            runId: lease.runId?.trim() || null,
            sessionId: lease.sessionId?.trim() || null,
            createdAt: candidate.leases[leaseKey]?.createdAt ?? now,
            updatedAt: now,
          }
          candidate.updatedAt = now
          await this.writePersistentRegistryUnlocked(registry)
          leaseReserved = true
          return candidate
        })
      : (await this.readPersistentRegistry()).hosts[hostKey]
    if (!record) {
      return null
    }
    try {
      if (
      record.projectPath !== profile.projectPath ||
      record.profileRootKey !== profile.profileRootKey ||
      record.projectBehaviorFingerprint !== profile.projectBehaviorFingerprint ||
      record.managedConfigFingerprint !== profile.managedConfigFingerprint ||
      !this.isProcessAlive(record.pid)
      ) {
        await this.removePersistentHost(hostKey).catch(() => undefined)
        return null
      }
    const processIdentity = await this.inspectPersistentHostProcessIdentity(record)
    if (processIdentity.state === 'gone' || processIdentity.state === 'changed') {
      await this.removePersistentHost(hostKey).catch(() => undefined)
      return null
    }
    const health = await this.checkHealthyHostOnce(record.baseUrl)
    if (!health) {
      if (processIdentity.state === 'unverified') {
        throw new Error(
          `OpenCode host pid ${record.pid} is unhealthy and its legacy identity ` +
          'could not be verified; refusing to launch a duplicate persistent host',
        )
      }
      await this.terminatePersistentHostRecord(record, { force: true })
      await this.removePersistentHost(hostKey).catch(() => undefined)
      return null
    }
    if (processIdentity.state === 'confirmed') {
      const identityAfterHealth = await this.inspectPersistentHostProcessIdentity({
        ...record,
        processStartedAtMs: processIdentity.startedAtMs,
      })
      if (identityAfterHealth.state === 'gone' || identityAfterHealth.state === 'changed') {
        await this.removePersistentHost(hostKey).catch(() => undefined)
        return null
      }
      if (identityAfterHealth.state !== 'confirmed') {
        throw new Error(
          `OpenCode host pid ${record.pid} identity could not be reverified after health probe; ` +
          'refusing to launch a duplicate persistent host',
        )
      }
    }
    const processStartedAtMs = processIdentity.state === 'unverified'
      ? await this.verifyLegacyPersistentHostIdentity(record, processIdentity.startedAtMs)
      : processIdentity.startedAtMs ?? record.processStartedAtMs
    const executingArtifactMatches = !!openCodeArtifactDigest && process.platform === 'linux' &&
      resolveExecutingOpenCodeArtifactDigest(record.pid) === openCodeArtifactDigest

    const handle: OpenCodeHostHandle = {
      hostKey,
      profileRootKey: record.profileRootKey,
      projectPath: record.projectPath,
      projectBehaviorFingerprint: record.projectBehaviorFingerprint,
      openCodeArtifactDigest: executingArtifactMatches ? openCodeArtifactDigest : null,
      baseUrl: record.baseUrl,
      port: record.port,
      pid: record.pid,
      processStartedAtMs,
      version: health.version ?? record.version,
      state: 'healthy',
      profile,
      resolvedConfigFingerprint: record.resolvedConfigFingerprint,
      diagnostics: [`adopted persistent OpenCode host pid=${record.pid}`],
    }
    if (resolveConfigFingerprint) {
      handle.resolvedConfigFingerprint =
        (await this.getResolvedConfigFingerprint(handle.baseUrl)) ??
        record.resolvedConfigFingerprint
    }
    this.#hosts.set(hostKey, {
      handle,
      child: null,
      refCount: this.pendingRefCounts.get(hostKey) ?? 1,
      ownedByProcess: false,
      lifetime: 'persistent',
    })
      if (!leaseReserved) {
        if (lease) await this.upsertPersistentHostWithLease(handle, lease)
        else await this.upsertPersistentHost(handle).catch(() => undefined)
      }
      return handle
    } catch (error) {
      this.#hosts.delete(hostKey)
      if (leaseReserved && lease) {
        await this.releaseHostLease(hostKey, lease).catch(() => undefined)
      }
      throw error
    }
  }

  private async waitForHealthyHost(
    baseUrl: string,
    getHealthTimeoutMs: () => number = () => OPEN_CODE_HOST_HEALTH_TIMEOUT_MS,
    abortSignal?: AbortSignal,
  ): Promise<{ version: string | null }> {
    const startedAt = this.nowMs()
    let healthTimeoutMs = normalizeOpenCodeHostHealthTimeoutMs(getHealthTimeoutMs())

    while (this.nowMs() - startedAt < healthTimeoutMs) {
      if (abortSignal?.aborted) {
        throw abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error('OpenCode host startup aborted')
      }
      try {
        const result = await this.fetchJsonWithTimeout(
          `${baseUrl}/global/health`,
          OPEN_CODE_HOST_HEALTH_REQUEST_TIMEOUT_MS,
        )
        const data = result.data as { healthy?: boolean; version?: string }
        if (result.status === 200 && data?.healthy === true) {
          return {
            version: typeof data.version === 'string' ? data.version : null,
          }
        }
      } catch {
        // Retry until the deadline expires.
      }

      await this.sleepMs(OPEN_CODE_HOST_HEALTH_POLL_MS)
      healthTimeoutMs = normalizeOpenCodeHostHealthTimeoutMs(getHealthTimeoutMs())
    }

    throw new Error(`OpenCode host did not become healthy within ${healthTimeoutMs}ms`)
  }

  private async getResolvedConfigFingerprint(baseUrl: string, context?: OpenCodeClientRequestContext): Promise<string | null> {
    try {
      const paths = ['/config', '/config/providers', '/agent', '/mcp']
      const read = (pathname: string) => this.fetchJsonWithTimeout(
        baseUrl + pathname, OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS, undefined, context)
      const results: FetchJsonResult[] = []
      if (this.custody) {
        // Each proof hashes the actual executable at preparation and consumption.
        // Serialize these four probes; do not share cached authority or start four
        // response timers competing with the same synchronous proof work.
        for (const pathname of paths) results.push(await read(pathname))
      } else results.push(...await Promise.all(paths.map(read)))
      const [config, configProviders, agents, mcp] = results as [FetchJsonResult, FetchJsonResult, FetchJsonResult, FetchJsonResult]

      return buildResolvedConfigFingerprint({ config, configProviders, agents, mcp }, !!this.custody)
    } catch {
      return null
    }
  }

  private spawnHost(
    profile: OpenCodePreparedProfile,
    port: number,
    lifetime: OpenCodeHostLifetime,
  ): ChildProcess {
    if (this.deps.spawnHostProcess) {
      return this.deps.spawnHostProcess(profile, port)
    }

    return spawnPortableCli(
      resolveOpenCodeBinaryPath() ?? 'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      buildOpenCodeHostSpawnOptions(profile, process.platform, { lifetime }),
    )
  }

  private bindHostLifecycle(hostKey: string, entry: ManagedHostEntry): void {
    if (!entry.child) {
      return
    }
    const pushDiagnostic = (message: string): void => {
      entry.handle.diagnostics.push(message)
      if (entry.handle.diagnostics.length > 20) {
        entry.handle.diagnostics.splice(0, entry.handle.diagnostics.length - 20)
      }
    }

    entry.child.once('error', error => {
      pushDiagnostic(`process error: ${error instanceof Error ? error.message : String(error)}`)
    })

    entry.child.once('exit', (code, signal) => {
      if (this.#hosts.get(hostKey) !== entry) {
        return
      }

      if (entry.handle.state !== 'disposed') {
        entry.handle.state = 'degraded'
        pushDiagnostic(
          `process exited${typeof code === 'number' ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}`,
        )
      }

      this.#hosts.delete(hostKey)
      this.pendingHosts.delete(hostKey)
      void this.removePersistentHost(hostKey).catch(() => undefined)
      void this.cleanupOpenTuiTempArtifactsIfUnused(
        entry.handle.profile.tmpPath,
        entry.handle.pid,
      ).catch(() => undefined)
    })
  }

  private async forceKillSpawnedHostProcess(
    child: ChildProcess,
    expectedStartedAtMs?: number | null,
  ): Promise<boolean> {
    const pid = child.pid
    try {
      if (pid) {
        if (
          await this.killProcessAndWait(
            pid,
            'SIGTERM',
            OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
            expectedStartedAtMs,
          )
        ) {
          return true
        }
      }
    } catch {
      // Best effort.
    }

    if (!pid) {
      return child.exitCode !== null || child.signalCode !== null
    }

    try {
      return await this.killProcessAndWait(
        pid,
        'SIGKILL',
        OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS,
        expectedStartedAtMs,
      )
    } catch {
      return false
    }
  }

  private async createHost(
    hostKey: string,
    profile: OpenCodePreparedProfile,
    openCodeArtifactDigest: OpenCodeArtifactDigest | null,
    lifetime: OpenCodeHostLifetime,
    resolveConfigFingerprint: boolean,
    abortSignal?: AbortSignal,
    lease?: OpenCodeHostLeaseInput,
  ): Promise<OpenCodeHostHandle> {
    const port = await this.allocateLoopbackPort()
    const baseUrl = `http://127.0.0.1:${port}`
    const diagnostics: string[] = []
    let child: ChildProcess | null = null
    try {
      // Sweep and spawn use the same cross-process lock, so no OpenTUI dylib
      // can be removed between process creation and ownership publication.
      child = await this.withTempOwnershipLock(profile.tmpPath, async () => {
        child = this.spawnHost(profile, port, lifetime)
        await this.deps.beforeTempOwnershipMarkerPublish?.()
        await this.publishTempOwnershipMarkerUnlocked(profile.tmpPath, child.pid ?? -1)
        return child
      })
    } catch (error) {
      const terminated = child
        ? await this.forceKillSpawnedHostProcess(
            child,
            child.pid
              ? await this.captureProcessStartTimeMs(child.pid).catch(() => null)
              : null,
          ).catch(() => false)
        : true
      if (child && !terminated) {
        const recoveryHandle: OpenCodeHostHandle = {
          hostKey,
          profileRootKey: profile.profileRootKey,
          projectPath: profile.projectPath,
          projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
          openCodeArtifactDigest,
          baseUrl,
          port,
          pid: child.pid ?? -1,
          version: null,
          state: 'degraded',
          profile,
          resolvedConfigFingerprint: null,
          diagnostics: [
            `ownership publication failed: ${errorMessage(error)}`,
            'spawned process termination was not confirmed',
          ],
        }
        const recoveryEntry: ManagedHostEntry = {
          handle: recoveryHandle,
          child,
          refCount: 0,
          ownedByProcess: true,
          lifetime,
        }
        this.#hosts.set(hostKey, recoveryEntry)
        this.bindHostLifecycle(hostKey, recoveryEntry)
      }
      throw new Error(
        `OpenCode host ownership publication failed: ${errorMessage(error)}; ` +
        `spawned process termination ${terminated ? 'confirmed' : 'not confirmed'}`,
      )
    }
    if (!child) throw new Error('OpenCode host spawn returned no process')
    const captureOutput = (source: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
      const message = chunk.toString('utf8').trim()
      if (!message) {
        return
      }
      diagnostics.push(`${source}: ${message}`)
      if (diagnostics.length > 20) {
        diagnostics.splice(0, diagnostics.length - 20)
      }
    }

    child.stdout?.on('data', captureOutput('stdout'))
    child.stderr?.on('data', captureOutput('stderr'))

    const handle: OpenCodeHostHandle = {
      hostKey,
      profileRootKey: profile.profileRootKey,
      projectPath: profile.projectPath,
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      openCodeArtifactDigest,
      baseUrl,
      port,
      pid: child.pid ?? -1,
      version: null,
      state: 'starting',
      profile,
      resolvedConfigFingerprint: null,
      diagnostics,
    }

    const entry: ManagedHostEntry = {
      handle,
      child,
      refCount: this.pendingRefCounts.get(hostKey) ?? 1,
      ownedByProcess: true,
      lifetime,
    }
    this.#hosts.set(hostKey, entry)
    this.bindHostLifecycle(hostKey, entry)
    if (shouldUnrefOpenCodeHostProcess(lifetime)) {
      unrefChildProcessHandle(child)
    }

    try {
      const health = await this.waitForHealthyHost(
        baseUrl,
        () => this.pendingHostHealthTimeoutMs.get(hostKey) ?? OPEN_CODE_HOST_HEALTH_TIMEOUT_MS,
        abortSignal,
      )
      handle.version = health.version
      handle.resolvedConfigFingerprint = resolveConfigFingerprint
        ? await this.getResolvedConfigFingerprint(baseUrl)
        : profile.managedConfigFingerprint
      handle.state = 'healthy'
      handle.processStartedAtMs = await this.captureProcessStartTimeMs(handle.pid, abortSignal)
      if (handle.processStartedAtMs === null && !this.deps.spawnHostProcess) {
        throw new Error(
          `OpenCode host pid ${handle.pid} process identity could not be captured after startup`,
        )
      }
      if (!openCodeArtifactDigest || this.deps.spawnHostProcess || process.platform !== 'linux' ||
        resolveExecutingOpenCodeArtifactDigest(handle.pid) !== openCodeArtifactDigest) {
        // Ordinary startup remains available, but only a direct Linux executable
        // whose installed and executed immutable bytes match publishes authority.
        handle.openCodeArtifactDigest = null
      }
      if (lifetime === 'persistent') {
        if (lease) await this.upsertPersistentHostWithLease(handle, lease)
        else await this.upsertPersistentHost(handle)
      }
      return handle
    } catch (error) {
      handle.state = 'degraded'
      const message = error instanceof Error ? error.message : String(error)
      diagnostics.push(message)
      const expectedStartedAtMs =
        handle.processStartedAtMs ??
        (await this.captureProcessStartTimeMs(handle.pid).catch(() => null))
      const terminated = await this.forceKillSpawnedHostProcess(child, expectedStartedAtMs)
      if (terminated) {
        this.#hosts.delete(hostKey)
        await this.cleanupOpenTuiTempArtifactsIfUnused(profile.tmpPath, child.pid)
      } else {
        diagnostics.push(
          `OpenCode host pid ${handle.pid} termination was not confirmed; retaining recovery state`,
        )
      }
      if (abortSignal?.aborted && abortSignal.reason instanceof Error) {
        throw abortSignal.reason
      }
      const diagnosticSuffix =
        diagnostics.length > 0 ? ` Diagnostics: ${diagnostics.join(' | ')}` : ''
      throw new Error(`${message}${diagnosticSuffix}`)
    }
  }

  async ensureHost(
    params: {
      projectPath?: string | null
      hostKey?: string | null
      profileOptions?: OpenCodePrepareProfileOptions
      preparedProfile?: OpenCodePreparedProfile
      healthTimeoutMs?: number | null
      hostLifetime?: OpenCodeHostLifetime
      resolveConfigFingerprint?: boolean
      abortSignal?: AbortSignal
      lease?: OpenCodeHostLeaseInput
    } = {},
  ): Promise<OpenCodeHostHandle> {
    // This branch precedes ALL desktop profile, binary, plugin, port and registry work.
    if (this.custody) {
      if (params.abortSignal?.aborted) throwOpenCodeAbortReason(params.abortSignal)
      params = { ...params, lease: params.lease ? Object.freeze({ ...params.lease }) : undefined,
        profileOptions: params.profileOptions ? { ...params.profileOptions } : undefined,
        preparedProfile: params.preparedProfile ? structuredClone(params.preparedProfile) : undefined }
      const deadline = new OpenCodeRuntimeDeadline(normalizeOpenCodeHostHealthTimeoutMs(params.healthTimeoutMs))
      const abort = () => deadline.abort(params.abortSignal?.reason)
      params.abortSignal?.addEventListener('abort', abort, { once: true })
      if (params.abortSignal?.aborted) abort()
      const release = this.custody.retainOwnerResource(() => deadline.abort(new Error('OpenCode supervised custody lost')))
      const previous = this.#supervisedTail
      const pending = deadline.runPhase('host_start', async context => {
        await raceOpenCodeAbortSignal(previous, context.signal)
        context.throwIfExpired()
        return context
      }).then(context => this.adoptSupervisedHost(params, context))
      // Serialize live acquisitions, not an abandoned authority provider's
      // unresolved promise. Queued callers have their own abort/deadline race.
      this.#supervisedTail = previous.then(() => pending).catch(() => undefined)
      try { return await pending } finally {
        deadline.dispose()
        params.abortSignal?.removeEventListener('abort', abort)
        release()
      }
    }
    if (params.abortSignal?.aborted) {
      throwOpenCodeAbortReason(params.abortSignal)
    }
    const profile = params.preparedProfile ?? await raceOpenCodeAbortSignal(
      this.prepareProfile(params.projectPath, {
        ...params.profileOptions,
        abortSignal: params.abortSignal,
      }),
      params.abortSignal,
    )
    const binaryPath = resolveOpenCodeBinaryPath()
    // Test/custom process factories do not prove which executable they run;
    // only the production resolver/spawn path may publish artifact identity.
    const openCodeArtifactDigest = this.resolveInstalledArtifact(binaryPath)
    if (binaryPath) {
      const pluginPrewarm = await prewarmOpenCodeManagedSubscriptionPlugins({
        binaryPath,
        profile,
        abortSignal: params.abortSignal,
      })
      if (pluginPrewarm && pluginPrewarm.code !== 0) {
        throw new Error(
          pluginPrewarm.error ||
            pluginPrewarm.stderr.trim() ||
            'Failed to install managed OpenCode provider plugins',
        )
      }
    }
    const hostLifetime = params.hostLifetime ?? 'persistent'
    const explicitHostKey = params.hostKey?.trim()
    const hostKey = explicitHostKey || await (async () => {
      const binaryHostIdentity = openCodeArtifactDigest ?? (binaryPath
        ? await raceOpenCodeAbortSignal(
            resolveOpenCodeBinaryHostIdentity(binaryPath),
            params.abortSignal,
          )
        : 'missing-binary')
      const baseHostKey = `${profile.projectPath}::${profile.profileRootKey}::${profile.projectBehaviorFingerprint}::${profile.managedConfigFingerprint}::auth:${profile.managedAuthFingerprint}::${OPEN_CODE_MANAGED_HOST_CONFIG_GENERATION}::binary:${binaryHostIdentity}`
      return hostLifetime === 'process'
        ? `${baseHostKey}::process:${process.pid}:${randomUUID()}`
        : baseHostKey
    })()
    const healthTimeoutMs = normalizeOpenCodeHostHealthTimeoutMs(params.healthTimeoutMs)
    const resolveConfigFingerprint = params.resolveConfigFingerprint !== false
    const existing = this.#hosts.get(hostKey)
    if (existing && existing.handle.state === 'healthy') {
      existing.refCount += 1
      if (params.lease) {
        try {
          await this.retainHostLease(hostKey, params.lease)
          if (this.#hosts.get(hostKey)?.handle !== existing.handle) {
            throw new Error(`OpenCode host ${hostKey} was disposed before its lease was published`)
          }
        } catch (error) {
          existing.refCount = Math.max(0, existing.refCount - 1)
          throw error
        }
      }
      return existing.handle
    }
    const pending = this.pendingHosts.get(hostKey)
    if (pending) {
      this.pendingHostHealthTimeoutMs.set(
        hostKey,
        Math.max(this.pendingHostHealthTimeoutMs.get(hostKey) ?? 0, healthTimeoutMs),
      )
      const handle = await raceOpenCodeAbortSignal(pending, params.abortSignal)
      const pendingEntry = this.#hosts.get(hostKey)
      if (pendingEntry) {
        pendingEntry.refCount += 1
      }
      if (params.lease) {
        try {
          await this.retainHostLease(hostKey, params.lease)
          if (this.#hosts.get(hostKey)?.handle !== handle) {
            throw new Error(`OpenCode host ${hostKey} was disposed before its lease was published`)
          }
        } catch (error) {
          if (pendingEntry) pendingEntry.refCount = Math.max(0, pendingEntry.refCount - 1)
          throw error
        }
      }
      return handle
    }

    if (existing) {
      try {
        await this.disposeHost(hostKey)
      } catch (error) {
        throw new Error(
          `OpenCode host ${hostKey} has retained recovery state and could not be safely replaced: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    this.pendingRefCounts.set(hostKey, 1)
    this.pendingHostHealthTimeoutMs.set(hostKey, healthTimeoutMs)
    const createPromise = (async () => {
      return this.withPersistentHostStartupLock(hostKey, async () => {
        const adopted =
          hostLifetime === 'persistent'
            ? await this.adoptPersistentHost(hostKey, profile, openCodeArtifactDigest, resolveConfigFingerprint, params.lease)
            : null
        const handle = adopted ?? await this.createHost(
          hostKey,
          profile,
          openCodeArtifactDigest,
          hostLifetime,
          resolveConfigFingerprint,
          params.abortSignal,
          params.lease,
        )
        return handle
      }, params.abortSignal)
    })().finally(() => {
      this.pendingHosts.delete(hostKey)
      this.pendingRefCounts.delete(hostKey)
      this.pendingHostHealthTimeoutMs.delete(hostKey)
    })
    this.pendingHosts.set(hostKey, createPromise)
    return createPromise
  }

  private async adoptSupervisedHost(params: {
    projectPath?: string | null; hostKey?: string | null
    preparedProfile?: OpenCodePreparedProfile; profileOptions?: OpenCodePrepareProfileOptions
    abortSignal?: AbortSignal; lease?: OpenCodeHostLeaseInput
  }, context: OpenCodePhaseContext, hostedAcquisition?: HostedAcquisitionState,
  operation?: SupervisedOperationState): Promise<OpenCodeHostHandle> {
    const custody = this.custody!
    assertTrustedOpenCodeCustody(custody)
    const e = custody.expected
    context.throwIfExpired()
    const unconsumed = new Set<OneUseFence>()
    let finished = false
    const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
      context.throwIfExpired()
      const pending = operation()
      // A provider can synchronously abort while returning its promise. The
      // abort helper then exits before observing it; still handle late failure.
      void pending.catch(() => undefined)
      const result = await raceOpenCodeAbortSignal(pending, context.signal)
      context.throwIfExpired()
      return result
    }
    const prepare = (operation: () => Promise<OneUseFence | null>) => wait(() =>
      operation().then(token => {
        if (token) {
          if (finished || context.signal.aborted || context.remainingMs() <= 0) {
            try { token.consume() } catch {}
            return null
          }
          unconsumed.add(token)
        }
        return token
      }))
    const consume = (token: OneUseFence | null) => {
      if (!token) return false
      unconsumed.delete(token)
      return token.consume()
    }
    try {
      if ((params.projectPath != null && params.projectPath !== e.profile.projectPath) ||
        (params.hostKey != null && params.hostKey !== custody.hostKey) || !params.lease ||
        (params.profileOptions?.toolApprovalMode && params.profileOptions.toolApprovalMode !== 'manual') ||
        Object.keys(params.profileOptions ?? {}).some(key => !['toolApprovalMode', 'abortSignal'].includes(key))) {
        throw new Error('OpenCode supervised project, profile or lease mismatch')
      }
      const leaseKey = buildLeaseKey(params.lease)
      const initialLease = await prepare(() => custody.prepareLeaseToken(params.lease!))
      if (!consume(initialLease)) throw new Error('OpenCode supervised session admission unavailable')
      const profile = await wait(() => custody.readPreparedProfile())
      if (params.preparedProfile && ['projectPath', 'profileRootKey', 'profileRootPath',
        'projectBehaviorFingerprint', 'managedConfigFingerprint', 'managedAuthFingerprint',
        'sourceAuthFingerprint', 'sourceAuthSources'].some(key =>
          JSON.stringify(params.preparedProfile![key as keyof OpenCodePreparedProfile]) !==
          JSON.stringify(profile[key as keyof OpenCodePreparedProfile]))) {
        throw new Error('OpenCode supervised prepared profile substitution')
      }
      if (!consume(await prepare(() => custody.prepareEffectToken()))) throw new Error('OpenCode supervised custody lost')
      const health = await wait(() => this.checkHealthyHostOnce(e.endpoint.baseUrl, context))
      const fingerprint = await wait(() => this.getResolvedConfigFingerprint(e.endpoint.baseUrl, context))
      if (!health || fingerprint !== e.profile.resolvedConfigFingerprint) {
        throw new Error('OpenCode supervised health or resolved config mismatch')
      }
      await wait(() => this.supervisedClientFactory!.create(e.endpoint.baseUrl, context).getHostedApprovalCapability!())
      const lease = await prepare(() => custody.prepareLeaseToken(params.lease!))
      const fence = await prepare(() => custody.prepareEffectToken())
      let valid = true
      try { valid = consume(lease) && valid } catch { valid = false }
      try { valid = consume(fence) && valid } catch { valid = false }
      context.throwIfExpired()
      if (!valid) throw new Error('OpenCode supervised admission lost before publication')
      // No await between exact first lease and handle publication; acquisitions are serialized.
      const existing = this.#hosts.get(custody.hostKey)
      if (existing) {
        if (existing.supervisor?.custody !== custody) throw new Error('OpenCode supervised handle replaced')
        if (operation) {
          existing.supervisor.operationHoldings.add(operation.identity)
          operation.entry = existing
        } else if (hostedAcquisition) {
          existing.supervisor.hostedHoldings.set(hostedAcquisition.receipt, {
            provisional: true,
            sessionId: null,
          })
          hostedAcquisition.entry = existing
          hostedAcquisition.host = existing.handle
          hostedAcquisition.provisionalPending = true
          hostedAcquisition.referencePending = true
          hostedAcquisition.acquireState = 'acquired'
        } else {
          existing.supervisor.leases.add(leaseKey)
        }
        if (!operation) existing.refCount += 1
        return existing.handle
      }
      const handle: OpenCodeHostHandle = {
        custody: 'supervisor', hostKey: custody.hostKey, profileRootKey: profile.profileRootKey,
        projectPath: profile.projectPath, projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
        openCodeArtifactDigest: `sha256:${e.executable.sha256}`, baseUrl: e.endpoint.baseUrl,
        port: e.endpoint.port, pid: e.process.pid, processStartedAtMs: Number(e.process.startTicks),
        version: health.version, state: 'healthy', profile, resolvedConfigFingerprint: fingerprint, diagnostics: [],
      }
      Object.freeze(handle.diagnostics)
      for (const key of Object.keys(handle)) {
        if (key !== 'state') Object.defineProperty(handle, key, { writable: false, configurable: false })
      }
      Object.seal(handle)
      const entry: ManagedHostEntry = { handle, child: null, refCount: operation ? 0 : 1, ownedByProcess: false,
        lifetime: 'process', supervisor: { custody,
          leases: new Set(hostedAcquisition || operation ? [] : [leaseKey]), hostedHoldings: new Map(),
          operationHoldings: new Set(operation ? [operation.identity] : []) } }
      if (operation) {
        operation.entry = entry
      } else if (hostedAcquisition) {
        entry.supervisor!.hostedHoldings.set(hostedAcquisition.receipt, { provisional: true, sessionId: null })
        hostedAcquisition.entry = entry
        hostedAcquisition.host = handle
        hostedAcquisition.provisionalPending = true
        hostedAcquisition.referencePending = true
        hostedAcquisition.acquireState = 'acquired'
      }
      this.#hosts.set(custody.hostKey, entry)
      return handle
    } finally {
      finished = true
      for (const token of unconsumed) { try { token.consume() } catch {} }
      unconsumed.clear()
    }
  }

  getHost(hostKey: string): OpenCodeHostHandle | null {
    return this.#hosts.get(hostKey)?.handle ?? null
  }

  async refreshResolvedConfigFingerprint(hostKey: string): Promise<string | null> {
    const entry = this.#hosts.get(hostKey)
    if (!entry) {
      return null
    }

    const fingerprint = await this.getResolvedConfigFingerprint(entry.handle.baseUrl)
    if (this.custody && (fingerprint !== this.custody.expected.profile.resolvedConfigFingerprint ||
      !(await this.custody.assertCurrent()))) throw new Error('OpenCode supervised resolved config changed')
    if (fingerprint && !this.custody) {
      entry.handle.resolvedConfigFingerprint = fingerprint
    }
    return entry.handle.resolvedConfigFingerprint
  }

  /**
   * Freshly proves the exact process and resolved configuration immediately
   * before a security-sensitive provider effect. Cached handle fields are not
   * sufficient here: both PID reuse and in-place configuration drift must fail
   * closed.
   */
  async verifyEffectHost(input: {
    hostKey: string
    pid: number
    processStartedAtMs: number | null
    resolvedConfigFingerprint: string | null
    openCodeArtifactDigest?: `sha256:${string}` | null
  }): Promise<boolean> {
    input = Object.freeze({ ...input })
    if (this.custody && !(await this.custody.assertCurrent())) return false
    const entry = this.#hosts.get(input.hostKey)
    if (this.custody && (entry?.supervisor?.custody !== this.custody ||
      input.pid !== this.custody.expected.process.pid ||
      input.processStartedAtMs !== Number(this.custody.expected.process.startTicks) ||
      input.resolvedConfigFingerprint !== this.custody.expected.profile.resolvedConfigFingerprint ||
      entry.handle.baseUrl !== this.custody.expected.endpoint.baseUrl)) return false
    if (!entry || entry.handle.pid !== input.pid || input.processStartedAtMs === null ||
      input.resolvedConfigFingerprint === null || !this.isProcessAlive(input.pid)) return false
    if (!input.openCodeArtifactDigest || process.platform !== 'linux' ||
      entry.handle.openCodeArtifactDigest !== input.openCodeArtifactDigest ||
      resolveExecutingOpenCodeArtifactDigest(input.pid) !== input.openCodeArtifactDigest) return false
    const startedBefore = await this.readProcessStartTimeMs(input.pid).catch(() => null)
    if (startedBefore !== input.processStartedAtMs) return false
    if (!(await this.checkHealthyHostOnce(entry.handle.baseUrl))) return false
    const fingerprint = await this.getResolvedConfigFingerprint(entry.handle.baseUrl)
    if (!fingerprint || fingerprint !== input.resolvedConfigFingerprint) return false
    const startedAfter = await this.readProcessStartTimeMs(input.pid).catch(() => null)
    return startedAfter === input.processStartedAtMs && this.isProcessAlive(input.pid)
  }

  /**
   * Re-proves the OS process/config identity and returns a synchronous,
   * one-use invocation token. The token prevents an in-process host rotation
   * from being interleaved between the last proof and provider invocation.
   */
  async prepareEffectHostToken(input: {
    hostKey: string
    pid: number
    processStartedAtMs: number | null
    resolvedConfigFingerprint: string | null
    openCodeArtifactDigest?: `sha256:${string}` | null
  }): Promise<{ consume(): boolean } | null> {
    input = Object.freeze({ ...input })
    const entry = this.#hosts.get(input.hostKey)
    if (!entry || !input.openCodeArtifactDigest || !(await this.verifyEffectHost(input))) return null
    const executingToken = prepareExecutingOpenCodeArtifactDigestToken(
      input.pid,
      input.openCodeArtifactDigest,
    )
    if (!executingToken) return null
    let custodyToken: Awaited<ReturnType<TrustedOpenCodeCustody['prepareEffectToken']>> = null
    try { custodyToken = this.custody ? await this.custody.prepareEffectToken() : null }
    catch (error) { executingToken.consume(); throw error }
    if (this.custody && !custodyToken) { executingToken.consume(); return null }
    const handle = entry.handle
    let consumed = false
    return {
      consume: () => {
        if (consumed) return false
        consumed = true
        const live = this.#hosts.get(input.hostKey)
        const retained = live === entry && live.handle === handle &&
          handle.pid === input.pid && handle.processStartedAtMs === input.processStartedAtMs &&
          handle.resolvedConfigFingerprint === input.resolvedConfigFingerprint &&
          handle.openCodeArtifactDigest === input.openCodeArtifactDigest &&
          this.isProcessAlive(input.pid)
        let executingCurrent = false
        let custodyCurrent = !this.custody
        try { executingCurrent = executingToken.consume() } catch {}
        try { if (custodyToken) custodyCurrent = custodyToken.consume() } catch {}
        return retained && executingCurrent && custodyCurrent
      },
    }
  }

  private async terminatePersistentHostRecord(
    record: PersistentHostRegistryRecord,
    options: { force: boolean },
  ): Promise<void> {
    if (this.custody) throw new Error('OpenCode supervisor retains process cleanup authority')
    const entry = this.#hosts.get(record.hostKey)
    const pid = entry?.handle.pid ?? record.pid
    let terminated = false

    const processIdentity = await this.inspectPersistentHostProcessIdentity({
      ...record,
      processStartedAtMs: entry?.handle.processStartedAtMs ?? record.processStartedAtMs,
    })
    if (processIdentity.state === 'gone') {
      terminated = true
    } else if (processIdentity.state !== 'confirmed') {
      throw new Error(
        processIdentity.state === 'changed'
          ? `OpenCode host pid ${pid} identity changed; refusing to terminate a reused pid`
          : `OpenCode host pid ${pid} identity could not be verified; refusing unsafe termination`,
      )
    }

    // Do not call /global/dispose: loopback port ownership can change between
    // process identity validation and HTTP delivery. OS-identity-fenced
    // signaling below is the only safe termination primitive.

    if (!terminated && pid > 0 && this.isProcessAlive(pid)) {
      const identityBeforeKill = await this.assertPersistentHostProcessIdentity(
        record,
        processIdentity.startedAtMs,
      )
      if (identityBeforeKill === 'gone') {
        terminated = true
      } else if (entry?.child?.pid) {
        terminated = await this.killProcessAndWait(
          entry.child.pid,
          'SIGTERM',
          OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
          processIdentity.startedAtMs,
        )
      } else {
        terminated = await this.killProcessAndWait(
          pid,
          'SIGTERM',
          OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
          processIdentity.startedAtMs,
        )
      }
    }

    if (options.force && pid > 0 && !terminated && this.isProcessAlive(pid)) {
      const identityBeforeForceKill = await this.assertPersistentHostProcessIdentity(
        record,
        processIdentity.startedAtMs,
      )
      terminated =
        identityBeforeForceKill === 'gone' ||
        (await this.killProcessAndWait(
          pid,
          'SIGKILL',
          OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS,
          processIdentity.startedAtMs,
        ))
    }

    if (pid > 0 && !terminated && this.isProcessAlive(pid)) {
      throw new Error(
        `OpenCode host pid ${pid} remained alive after ${options.force ? 'forced ' : ''}cleanup`,
      )
    }

    if (entry) {
      entry.child?.stdout?.destroy()
      entry.child?.stderr?.destroy()
      entry.child?.stdin?.destroy()
      entry.handle.state = 'disposed'
    }
    this.#hosts.delete(record.hostKey)
    this.pendingHosts.delete(record.hostKey)
    await this.cleanupOpenTuiTempArtifactsIfUnused(
      entry?.handle.profile.tmpPath ?? this.getPersistentProfileTmpPath(record.profileRootKey),
      pid,
    )
  }

  async disposeHost(hostKey: string): Promise<boolean> {
    if (this.custody) {
      const entry = this.#hosts.get(hostKey)
      if (!entry?.supervisor) {
        if (hostKey === this.custody.hostKey) await this.custody.closeOwnerResources()
        return false
      }
      entry.handle.state = 'disposed'
      // Disposal ends custody/effect authority, but local ownership bookkeeping
      // remains until each legacy or receipt owner releases its own exact hold.
      // Deleting it here would make a committed receipt unable to settle, or
      // tempt a later release to debit an unrelated entry generation.
      if (this.#hosts.get(hostKey) === entry && entry.refCount === 0 &&
        entry.supervisor.leases.size === 0 && entry.supervisor.hostedHoldings.size === 0 &&
        entry.supervisor.operationHoldings.size === 0) this.#hosts.delete(hostKey)
      await this.custody.closeOwnerResources()
      return true
    }
    const entry = this.#hosts.get(hostKey)
    if (!entry) {
      return false
    }

    const dispose = async (): Promise<boolean> => {
      const registered = (await this.readPersistentRegistryUnlocked()).hosts[hostKey]
      if (registered && Object.keys(normalizePersistentHostLeases(registered.leases)).length > 0) {
        return false
      }
      try {
        await this.terminatePersistentHostRecord(
          {
            hostKey,
            profileRootKey: entry.handle.profileRootKey,
            projectPath: entry.handle.projectPath,
            projectBehaviorFingerprint: entry.handle.projectBehaviorFingerprint,
            baseUrl: entry.handle.baseUrl,
            port: entry.handle.port,
            pid: entry.handle.pid,
            processStartedAtMs: entry.handle.processStartedAtMs,
            version: entry.handle.version,
            resolvedConfigFingerprint: entry.handle.resolvedConfigFingerprint,
            updatedAt: this.nowIso(),
            leases: {},
          },
          { force: true },
        )
      } catch (error) {
        entry.handle.state = 'degraded'
        throw error
      }
      const registry = await this.readPersistentRegistryUnlocked()
      if (registry.hosts[hostKey]) {
        delete registry.hosts[hostKey]
        await this.writePersistentRegistryUnlocked(registry)
      }
      return true
    }
    return this.persistentRegistryPath
      ? this.withPersistentRegistryLock(dispose)
      : dispose()
  }

  async disposeUnregisteredOwnedHosts(): Promise<{
    disposed: number
    kept: number
    diagnostics: string[]
  }> {
    if (this.custody) {
      const disposed = this.#hosts.size
      for (const key of this.#hosts.keys()) await this.disposeHost(key)
      await this.custody.closeOwnerResources()
      return { disposed, kept: 0, diagnostics: [] }
    }
    const registry = await this.readPersistentRegistry()
    let disposed = 0
    let kept = 0
    const diagnostics: string[] = []

    for (const [hostKey, entry] of Array.from(this.#hosts.entries())) {
      if (!entry.ownedByProcess) {
        kept += 1
        continue
      }
      if (registry.hosts[hostKey]) {
        kept += 1
        continue
      }

      try {
        if (await this.disposeHost(hostKey)) {
          disposed += 1
        }
      } catch (error) {
        diagnostics.push(error instanceof Error ? error.message : String(error))
      }
    }

    return { disposed, kept, diagnostics }
  }

  async reconcilePersistentHosts(
    options: OpenCodePersistentHostReconcileOptions = {},
  ): Promise<OpenCodePersistentHostReconcileResult> {
    if (this.custody) {
      const close = options.mode === 'force' || options.reason === 'shutdown'
      const result = close ? await this.disposeUnregisteredOwnedHosts() : null
      return { cleaned: result?.disposed ?? 0, remaining: this.#hosts.size, hosts: [], diagnostics: [] }
    }
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return {
        cleaned: 0,
        remaining: 0,
        hosts: [],
        diagnostics: ['OpenCode host registry is disabled'],
      }
    }

    return this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      const hosts: OpenCodePersistentHostReconcileResult['hosts'] = []
      const diagnostics: string[] = []
      let cleaned = 0
      let changed = false
      const mode = options.mode ?? 'stale'
      const force = mode === 'force'
      const nowMs = this.now().getTime()
      const projectPathFilter = options.projectPath?.trim()
      const normalizedProjectPathFilter = projectPathFilter
        ? await normalizeProjectPathForComparison(projectPathFilter)
        : null

      for (const [hostKey, record] of Object.entries(registry.hosts)) {
        const leases = normalizePersistentHostLeases(record.leases)
        let droppedStaleLeaseCount = 0
        const dropStaleLeases = (
          staleAgeMs: number | null | undefined,
          predicate: (lease: PersistentHostLeaseRecord) => boolean,
        ): number => {
          if (force || typeof staleAgeMs !== 'number' || staleAgeMs <= 0) {
            return 0
          }
          let dropped = 0
          for (const [leaseKey, lease] of Object.entries(leases)) {
            if (!predicate(lease)) {
              continue
            }
            const updatedAtMs = Date.parse(lease.updatedAt)
            const ageMs = Number.isFinite(updatedAtMs)
              ? nowMs - updatedAtMs
              : Number.POSITIVE_INFINITY
            if (ageMs > staleAgeMs) {
              delete leases[leaseKey]
              dropped += 1
            }
          }
          return dropped
        }

        const preflightDropped = dropStaleLeases(
          options.preflightLeaseStaleAgeMs,
          isOpenCodePreflightHostLease,
        )
        const genericDropped = dropStaleLeases(options.leaseStaleAgeMs, () => true)
        droppedStaleLeaseCount = preflightDropped + genericDropped

        if (droppedStaleLeaseCount > 0) {
          registry.hosts[hostKey] = {
            ...record,
            leases,
            updatedAt: this.nowIso(),
          }
          record.leases = leases
          changed = true
          diagnostics.push(
            `Dropped ${droppedStaleLeaseCount} stale OpenCode host lease(s) for ${hostKey}`,
          )
        }
        const leaseCount = Object.keys(leases).length
        const entry = this.#hosts.get(hostKey)
        const normalizedRecordProjectPath = normalizedProjectPathFilter
          ? await normalizeProjectPathForComparison(record.projectPath)
          : null
        if (
          normalizedProjectPathFilter
          && normalizedRecordProjectPath !== normalizedProjectPathFilter
        ) {
          hosts.push({
            hostKey,
            projectPath: record.projectPath,
            pid: record.pid,
            port: record.port,
            action: 'kept_filtered',
            reason: `project path does not match ${projectPathFilter}`,
            leaseCount,
          })
          continue
        }

        if (!this.isProcessAlive(record.pid)) {
          delete registry.hosts[hostKey]
          cleaned += 1
          changed = true
          await this.cleanupOpenTuiTempArtifactsIfUnused(
            this.getPersistentProfileTmpPath(record.profileRootKey),
            record.pid,
          )
          hosts.push({
            hostKey,
            projectPath: record.projectPath,
            pid: record.pid,
            port: record.port,
            action: 'removed_dead',
            reason: 'registered host process is not alive',
            leaseCount,
          })
          continue
        }

        const processIdentity = await this.inspectPersistentHostProcessIdentity(record)
        if (processIdentity.state === 'gone' || processIdentity.state === 'changed') {
          delete registry.hosts[hostKey]
          cleaned += 1
          changed = true
          await this.cleanupOpenTuiTempArtifactsIfUnused(
            this.getPersistentProfileTmpPath(record.profileRootKey),
            record.pid,
          )
          hosts.push({
            hostKey,
            projectPath: record.projectPath,
            pid: record.pid,
            port: record.port,
            action: 'removed_dead',
            reason: processIdentity.state === 'changed'
              ? 'registered pid was reused by a different process'
              : 'registered host process exited during identity verification',
            leaseCount,
          })
          continue
        }
        if (processIdentity.state === 'unverified') {
          const health = await this.checkHealthyHostOnce(record.baseUrl)
          if (!health) {
            const reason =
              `OpenCode host pid ${record.pid} is unhealthy and its legacy identity ` +
              'could not be verified'
            diagnostics.push(`Failed to verify OpenCode host ${hostKey}: ${reason}`)
            hosts.push({
              hostKey,
              projectPath: record.projectPath,
              pid: record.pid,
              port: record.port,
              action: 'failed',
              reason,
              leaseCount,
            })
            continue
          }
          try {
            const processStartedAtMs = await this.verifyLegacyPersistentHostIdentity(
              record,
              processIdentity.startedAtMs,
            )
            record.processStartedAtMs = processStartedAtMs
            registry.hosts[hostKey] = record
            changed = true
            diagnostics.push(`Upgraded legacy OpenCode host process identity for ${hostKey}`)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            diagnostics.push(`Failed to verify OpenCode host ${hostKey}: ${reason}`)
            hosts.push({
              hostKey,
              projectPath: record.projectPath,
              pid: record.pid,
              port: record.port,
              action: 'failed',
              reason,
              leaseCount,
            })
            continue
          }
        }

        if (!force && entry && entry.refCount > 0) {
          hosts.push({
            hostKey,
            projectPath: record.projectPath,
            pid: record.pid,
            port: record.port,
            action: 'kept_active',
            reason: `host has active in-process refCount=${entry.refCount}`,
            leaseCount,
          })
          continue
        }

        if (!force && leaseCount > 0) {
          hosts.push({
            hostKey,
            projectPath: record.projectPath,
            pid: record.pid,
            port: record.port,
            action: 'kept_leased',
            reason: `host has ${leaseCount} active lease${leaseCount === 1 ? '' : 's'}`,
            leaseCount,
          })
          continue
        }

        if (
          !force &&
          droppedStaleLeaseCount === 0 &&
          typeof options.staleAgeMs === 'number' &&
          options.staleAgeMs > 0
        ) {
          const updatedAtMs = Date.parse(record.updatedAt)
          const ageMs = Number.isFinite(updatedAtMs)
            ? nowMs - updatedAtMs
            : Number.POSITIVE_INFINITY
          if (ageMs < options.staleAgeMs) {
            hosts.push({
              hostKey,
              projectPath: record.projectPath,
              pid: record.pid,
              port: record.port,
              action: 'kept_recent',
              reason: `host updated ${Math.max(0, ageMs)}ms ago`,
              leaseCount,
            })
            continue
          }
        }

        try {
          await this.terminatePersistentHostRecord(record, { force })
          delete registry.hosts[hostKey]
          cleaned += 1
          changed = true
          hosts.push({
            hostKey,
            projectPath: record.projectPath,
            pid: record.pid,
            port: record.port,
            action: 'disposed',
            reason: force
              ? `force cleanup during ${options.reason ?? 'manual'}`
              : `stale host has no active leases during ${options.reason ?? 'manual'}`,
            leaseCount,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          diagnostics.push(`Failed to dispose OpenCode host ${hostKey}: ${message}`)
          hosts.push({
            hostKey,
            projectPath: record.projectPath,
            pid: record.pid,
            port: record.port,
            action: 'failed',
            reason: message,
            leaseCount,
          })
        }
      }

      if (changed) {
        if (Object.keys(registry.hosts).length === 0) {
          await unlink(registryPath).catch(() => undefined)
        } else {
          await this.writePersistentRegistryUnlocked(registry)
        }
      }

      if (options.reason === 'startup') {
        const activeProfileRootKeys = new Set(
          Object.values(registry.hosts)
            .filter(record => this.isProcessAlive(record.pid))
            .map(record => record.profileRootKey),
        )
        const tempCleanup = await this.cleanupStaleManagedProfileTempDylibs(
          activeProfileRootKeys,
        ).catch(error => {
          diagnostics.push(
            `Failed to clean stale OpenCode profile temp dylibs: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
          return { removed: 0, bytes: 0 }
        })
        if (tempCleanup.removed > 0) {
          diagnostics.push(
            `Removed ${tempCleanup.removed} stale OpenCode profile temp dylib(s) (${tempCleanup.bytes} bytes)`,
          )
        }
      }

      return {
        cleaned,
        remaining: Object.keys(registry.hosts).length,
        hosts,
        diagnostics,
      }
    })
  }

  async releaseHost(
    hostKey: string,
    options: { keepPersistentAlive?: boolean } = {},
  ): Promise<void> {
    if (this.custody) {
      const entry = this.#hosts.get(hostKey)
      if (!entry?.supervisor) return
      entry.refCount = Math.max(0, entry.refCount - 1)
      if (this.#hosts.get(hostKey) === entry && entry.refCount === 0 &&
        entry.supervisor.leases.size === 0 && entry.supervisor.hostedHoldings.size === 0 &&
        entry.supervisor.operationHoldings.size === 0) this.#hosts.delete(hostKey)
      return
    }
    const entry = this.#hosts.get(hostKey)
    if (!entry) {
      return
    }

    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount === 0) {
      if (entry.lifetime === 'persistent' && options.keepPersistentAlive) {
        return
      }
      if (entry.lifetime === 'persistent') {
        const registryRecord = (await this.readPersistentRegistry()).hosts[hostKey]
        if (registryRecord && Object.keys(normalizePersistentHostLeases(registryRecord.leases)).length > 0) {
          return
        }
      }
      if (entry.ownedByProcess) {
        await this.disposeHost(hostKey)
      } else {
        this.#hosts.delete(hostKey)
      }
    }
  }
}

export const openCodeHostManager = new OpenCodeHostManager()
