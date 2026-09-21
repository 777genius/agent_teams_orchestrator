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
import { writeJsonFileAtomic, type AtomicWriteContext } from '../../utils/atomicWrite.js'
import { errorMessage } from '../../utils/errors.js'
import { sleep } from '../../utils/sleep.js'
import {
  buildExactProcessTreeSpawn,
  captureProcessTreeIdentity,
  getProcessTreeContainmentCapability,
  killProcessTreeAndWait,
  pendingStartupTaskkillPids,
  readProcessCommandLine,
  readProcessStartTimeMs,
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
  buildProcessAttributionSpawnEnv,
  isProcessAttributionId,
  mintProcessAttributionId,
  resolveProcessAttributionDirectory,
  writeHostAttributionRecord,
} from './OpenCodeProcessAttributionStore.js'
import { readAttributionRecords } from './OpenCodeProcessAttributionStore.js'
import { parseCursorAgentReapInput, reapCursorAgents, type CursorAgentReapResult } from './OpenCodeCursorAgentAtomicReap.js'
import type { CursorAgentNativePorts } from './OpenCodeCursorAgentTreeKill.js'
import { buildOpenCodeHostTransportIdentity } from './OpenCodeHostIdentity.js'
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
export const OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID = '__opencode_preflight__'
const OPEN_CODE_PREFLIGHT_HOST_LEASE_LANE_ID = 'preflight'
// Bun/OpenTUI temp dylib prefixes vary between builds (.bbb, .bbc, .b9dd, ...).
// Keep the match constrained to hidden hexadecimal dylibs inside the app-owned
// profile tmp directory so unrelated user files are never removed.
const OPENTUI_TEMP_DYLIB_RE = /^\.b[0-9a-f]+-[0-9a-f]+\.dylib$/i

type StaleTempCleanupResult = {
  removed: number
  bytes: number
  unresolvedPaths: string[]
  diagnostics: string[]
}

function cleanupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingPathError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Lock acquisition has a distinct failure domain from reconciliation.  In
 * particular AbortError has no stable message across runtimes, so callers
 * must classify a cancelled lock wait by type/context rather than text.
 */
class PersistentRegistryLockContentionInterruptedError extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super('OpenCode persistent registry lock acquisition interrupted')
    this.name = 'PersistentRegistryLockContentionInterruptedError'
    this.cause = cause
  }
}

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
export function shouldRetryPersistentHostStartupLock(error: unknown, attempt: number, hasAbortSignal: boolean): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
  return code === 'ELOCKED' && (hasAbortSignal || attempt < PERSISTENT_HOST_STARTUP_LOCK_RETRIES)
}

type ManagedHostEntry = {
  supervisor?: { custody: TrustedOpenCodeCustody; leases: Set<string> }
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
  readProcessCommandLine?: (pid: number, timeoutMs?: number) => Promise<string | null>
  /** Injected readers receive the optional operation timeout, not a platform override. */
  readProcessStartTimeMs?: typeof readProcessStartTimeMs
  killProcess?: (pid: number, signal: NodeJS.Signals) => void
  killProcessTreeAndWait?: typeof killProcessTreeAndWait
  now?: () => Date
  persistentRegistryPath?: string | null
  processAttributionDirectory?: string | null
  cursorAgentNativePorts?: Partial<CursorAgentNativePorts>
  beforeTempOwnershipMarkerPublish?: () => Promise<void>
  resolveOpenCodeArtifactDigest?: (binaryPath: string) => OpenCodeArtifactDigest | null
}

export type OpenCodeHostLeaseInput = {
  teamId: string
  laneId?: string | null
  memberName: string
  runId?: string | null
  sessionId?: string | null
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
  /** The launch-boundary receipt used for safe whole-tree termination. */
  processOsIdentity?: string | null
  /** Present only for the generation with durable Cursor-agent reap evidence. */
  attributionId?: string
  cursorAgentReapContractVersion?: 1
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
  /** Startup callers supply the shared budget; reconciliation never exceeds it. */
  startupBudget?: {
    remaining(): number
    cap(ms: number): number
    assertAvailable(reserveMs?: number): void
  }
  /** Cancellation of the enclosing startup command must also stop lock retry. */
  signal?: AbortSignal
  /** Live command budget.  Stop reconciliation must not outlive its command. */
  remainingMs?: () => number
}

export type OpenCodePersistentHostReconcileResult = {
  startupCleanup?: {
    completion: 'drained' | 'unknown'
    coverage: 'complete' | 'partial'
    survivingPids: number[]
    /** Files/profiles that could not be conclusively swept under the shared budget. */
    unresolvedPaths?: string[]
    cleanupDiagnostics?: string[]
  }
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

function hashJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? '')
    .digest('hex')
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

function normalizeResolvedFingerprintValue(
  value: unknown,
  scope: 'config' | 'configProviders' | 'agents' | 'mcp',
): unknown {
  if (scope === 'mcp') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value
    }
    return Object.keys(value as Record<string, unknown>).sort()
  }

  if (Array.isArray(value)) {
    const normalized = value.map(item => normalizeResolvedFingerprintValue(item, scope))
    if (scope === 'configProviders' || scope === 'agents') {
      return normalized.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      )
    }
    return normalized
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const record = value as Record<string, unknown>
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      // Host transport details like loopback port and inherited environment
      // are expected to drift across host restarts and must not stale sessions.
      if (key === 'environment' || key === 'server') {
        return acc
      }
      acc[key] = normalizeResolvedFingerprintValue(record[key], scope)
      return acc
    }, {})
}

/** Shared endpoint projection used for host retention and admitted fixtures. */
export function fingerprintOpenCodeResolvedConfigEndpoints(input: {
  config: unknown
  configProviders: unknown
  agents: unknown
  mcp: unknown
}): string {
  return hashJson({
    config: normalizeResolvedFingerprintValue(input.config, 'config'),
    configProviders: normalizeResolvedFingerprintValue(input.configProviders, 'configProviders'),
    agents: normalizeResolvedFingerprintValue(input.agents, 'agents'),
    mcp: normalizeResolvedFingerprintValue(input.mcp, 'mcp'),
  })
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

async function cleanupOpenTuiTempDylibs(
  tempPath: string,
  context: OpenCodeClientRequestContext = {},
): Promise<void> {
  const assertAvailable = () => {
    if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
    if (context.remainingMs && context.remainingMs() <= 0) {
      throw new Error('OpenCode temp cleanup deadline exhausted')
    }
  }
  assertAvailable()
  let entries: Dirent<string>[]
  try {
    entries = await readdir(tempPath, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }

  for (const entry of entries) {
    assertAvailable()
    if (!entry.isFile() || !OPENTUI_TEMP_DYLIB_RE.test(entry.name)) continue
    await rm(path.join(tempPath, entry.name), { force: true })
  }
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

export function createOpenCodePreflightHostLeaseInput(scope: string): OpenCodeHostLeaseInput {
  const normalizedScope =
    scope
      .trim()
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || 'probe'
  return {
    teamId: OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID,
    laneId: OPEN_CODE_PREFLIGHT_HOST_LEASE_LANE_ID,
    memberName: `${normalizedScope}-${process.pid}-${randomUUID()}`,
    runId: `preflight_${process.pid}_${randomUUID()}`,
    sessionId: null,
  }
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
  options: { lifetime?: OpenCodeHostLifetime; attributionId?: string | null; attributionDirectory?: string | null } = {},
): SpawnOptions {
  const lifetime = options.lifetime ?? 'persistent'
  const attributionEnv = options.attributionId
    ? buildProcessAttributionSpawnEnv({
      directory: options.attributionDirectory ?? resolveProcessAttributionDirectory(profile.env),
      attributionId: options.attributionId,
    })
    : {}
  return {
    cwd: profile.workingDirectoryPath ?? profile.projectPath,
    env: Object.keys(attributionEnv).length > 0 ? { ...profile.env, ...attributionEnv } : profile.env,
    detached: lifetime === 'persistent' || platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  }
}
export function assertOpenCodeHostReuseIdentity(explicitHostKey: string | undefined, profile: OpenCodePreparedProfile): void {
  if (!explicitHostKey) return
  if (profile.scopeToken && !explicitHostKey.includes(`::scope:${profile.scopeToken}::`)) throw new Error('OpenCode host reuse rejected because the profile scope token changed')
  const readiness = profile.env.AGENT_TEAMS_CURSOR_READINESS?.trim() || 'absent'
  if (readiness !== (/::readiness:([^:]*)$/.exec(explicitHostKey)?.[1] || 'absent')) throw new Error('OpenCode host reuse rejected because Cursor readiness changed')
}

function assertHealthyOpenCodeHostReuse(
  explicitHostKey: string | undefined,
  requested: OpenCodePreparedProfile,
  existing: OpenCodeHostHandle,
): void {
  assertOpenCodeHostReuseIdentity(explicitHostKey, requested)
  const current = existing.profile
  // A caller-supplied host key is an identity assertion, never permission to
  // cross profile scopes.  Compare the scope/auth/readiness inputs directly
  // as well as the key: legacy keys may not encode every modern component.
  const requestedScope = requested.profileScope
  const currentScope = current.profileScope
  const requestedReadiness = requested.env.AGENT_TEAMS_CURSOR_READINESS?.trim() || 'absent'
  const currentReadiness = current.env.AGENT_TEAMS_CURSOR_READINESS?.trim() || 'absent'
  if (requestedScope?.providerId === 'cursor-acp' && requestedReadiness === 'absent') {
    throw new Error('OpenCode host reuse rejected because Cursor readiness is unavailable')
  }
  if (existing.projectPath !== requested.projectPath
    || existing.profileRootKey !== requested.profileRootKey
    || current.projectBehaviorFingerprint !== requested.projectBehaviorFingerprint
    || current.managedConfigFingerprint !== requested.managedConfigFingerprint
    || current.managedAuthFingerprint !== requested.managedAuthFingerprint
    || current.scopeToken !== requested.scopeToken
    || currentReadiness !== requestedReadiness
    || currentScope?.purpose !== requestedScope?.purpose
    || currentScope?.providerId !== requestedScope?.providerId
    || currentScope?.scopeToken !== requestedScope?.scopeToken
    || currentScope?.selectedAuthIdentity !== requestedScope?.selectedAuthIdentity) {
    throw new Error('OpenCode host reuse rejected because the requested profile identity changed')
  }
}
export function buildOpenCodeHostProfileIdentity(profile: OpenCodePreparedProfile, binaryHostIdentity: string): string {
  const authIdentity = profile.profileScope?.selectedAuthIdentity ?? profile.managedAuthFingerprint ?? 'absent'
  return `${profile.projectPath}::${profile.profileRootKey}::${profile.projectBehaviorFingerprint}::${profile.managedConfigFingerprint}::auth:${authIdentity}::scope:${profile.scopeToken ?? 'unscoped'}::${OPEN_CODE_MANAGED_HOST_CONFIG_GENERATION}::binary:${binaryHostIdentity}::mcp:${buildOpenCodeHostTransportIdentity(profile.managedConfig)}::readiness:${profile.env.AGENT_TEAMS_CURSOR_READINESS ?? 'absent'}`
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
  private readonly startupLockReleases = new Set<Promise<void>>()
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

  async drainStartupCleanupLockReleases(): Promise<void> {
    await Promise.all(this.startupLockReleases)
  }

  isBoundToCustody(custody: TrustedOpenCodeCustody): boolean { return this.custody === custody }

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
    if (context?.signal?.aborted) throwOpenCodeAbortReason(context.signal)
    const remaining = context?.remainingMs?.()
    if (remaining !== undefined && (!Number.isFinite(remaining) || remaining <= 0)) {
      throw new Error(`OpenCode host request deadline exhausted for ${url}`)
    }
    const controller = new AbortController()
    const boundedTimeoutMs = Math.max(1, Math.min(
      timeoutMs,
      context?.requestTimeoutMs ?? Number.POSITIVE_INFINITY,
      remaining === undefined ? Number.POSITIVE_INFINITY : Math.floor(remaining),
    ))
    let timedOut = false
    let rejectTimeout!: (error: Error) => void
    const deadline = new Promise<never>((_, reject) => {
      rejectTimeout = reject
    })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
      rejectTimeout(new Error(`OpenCode host request timed out after ${boundedTimeoutMs}ms for ${url}`))
    }, boundedTimeoutMs)
    let rejectAbort: ((error: unknown) => void) | undefined
    const abortFromContext = () => {
      controller.abort(context?.signal?.reason)
      rejectAbort?.(context?.signal?.reason ?? new Error('OpenCode host request aborted'))
    }
    const aborted = context?.signal
      ? new Promise<never>((_, reject) => {
          rejectAbort = reject
          context.signal!.addEventListener('abort', abortFromContext, { once: true })
        })
      : undefined

    try {
      return await Promise.race([
        this.fetchJson(url, {
          ...init,
          signal: controller.signal,
        }),
        deadline,
        ...(aborted ? [aborted] : []),
      ])
    } catch (error) {
      if (context?.signal?.aborted) throwOpenCodeAbortReason(context.signal)
      if (timedOut || controller.signal.aborted) {
        throw new Error(`OpenCode host request timed out after ${boundedTimeoutMs}ms for ${url}`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
      context?.signal?.removeEventListener('abort', abortFromContext)
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

  private get processAttributionDirectory(): string | null {
    if (this.deps.processAttributionDirectory !== undefined) {
      return this.deps.processAttributionDirectory
    }
    const registryPath = this.persistentRegistryPath
    return registryPath ? path.join(path.dirname(registryPath), 'process-attribution') : null
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

  private async readProcessStartTimeMs(
    pid: number,
    platform?: NodeJS.Platform,
    timeoutMs?: number,
  ): Promise<number | null> {
    if (this.deps.readProcessStartTimeMs) {
      return this.deps.readProcessStartTimeMs(pid, timeoutMs)
    }
    return readProcessStartTimeMs(pid, platform, timeoutMs)
  }

  private async readProcessCommandLine(pid: number, timeoutMs?: number): Promise<string | null> {
    if (this.deps.readProcessCommandLine) {
      return this.deps.readProcessCommandLine(pid, timeoutMs)
    }
    return readProcessCommandLine(pid, process.platform, timeoutMs)
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
    context: OpenCodeClientRequestContext = {},
  ): Promise<number> {
    const capIdentityRead = (): number | undefined => {
      const remaining = context.remainingMs?.()
      if (remaining === undefined) return undefined
      if (!Number.isFinite(remaining) || remaining <= 0) {
        throw new Error('OpenCode legacy host identity deadline exhausted')
      }
      return Math.min(6_000, Math.floor(remaining))
    }
    if (!Number.isFinite(startedAtMs) || startedAtMs === null) {
      throw new Error(`OpenCode host pid ${record.pid} has no verifiable process start time`)
    }
    if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
    const startedAtMsBeforeProbe = await this.readProcessStartTimeMs(
      record.pid,
      process.platform,
      capIdentityRead(),
    ).catch(() => null)
    if (startedAtMsBeforeProbe !== startedAtMs) {
      throw new Error(`OpenCode host pid ${record.pid} identity changed before legacy migration`)
    }
    if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
    const command = await this.readProcessCommandLine(record.pid, capIdentityRead()).catch(() => null)
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
    if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
    const currentFingerprint = await this.getResolvedConfigFingerprint(record.baseUrl, context)
    if (!currentFingerprint || currentFingerprint !== record.resolvedConfigFingerprint) {
      throw new Error(
        `OpenCode host pid ${record.pid} resolved config fingerprint changed during migration`,
      )
    }
    if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
    const startedAtMsAfterProbe = await this.readProcessStartTimeMs(
      record.pid,
      process.platform,
      capIdentityRead(),
    ).catch(() => null)
    if (startedAtMsAfterProbe !== startedAtMs) {
      throw new Error(`OpenCode host pid ${record.pid} identity changed during legacy migration`)
    }
    return startedAtMs
  }

  private async inspectPersistentHostProcessIdentity(
    record: PersistentHostRegistryRecord,
    context: OpenCodeClientRequestContext = {},
  ): Promise<PersistentHostProcessIdentity> {
    if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
    if (!this.isProcessAlive(record.pid)) {
      return { state: 'gone', startedAtMs: null }
    }

    let queryTimeoutMs: number | undefined
    try {
      const remaining = context.remainingMs?.()
      if (remaining !== undefined) {
        if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('OpenCode host identity deadline exhausted')
        queryTimeoutMs = Math.min(6_000, Math.floor(remaining))
      }
    } catch {
      // The caller reports this as a bounded, unverified survivor; never turn
      // an exhausted startup budget into an unbounded identity probe.
      return { state: 'unverified', startedAtMs: null }
    }
    const startedAtMs = await this.readProcessStartTimeMs(
      record.pid,
      process.platform,
      queryTimeoutMs,
    ).catch(() => null)
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
    context: OpenCodeClientRequestContext = {},
  ): Promise<'confirmed' | 'gone'> {
    const expectedRecord = Number.isFinite(expectedStartedAtMs) && expectedStartedAtMs !== null
      ? { ...record, processStartedAtMs: expectedStartedAtMs }
      : record
    const identity = await this.inspectPersistentHostProcessIdentity(expectedRecord, context)
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
    expectedOsIdentity?: string | null,
    context: OpenCodeClientRequestContext = {},
  ): Promise<boolean> {
    if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
    const remaining = context.remainingMs?.()
    if (remaining !== undefined && (!Number.isFinite(remaining) || remaining <= 0)) {
      throw new Error('OpenCode host termination deadline exhausted')
    }
    const boundedTimeoutMs = Math.max(1, Math.min(timeoutMs, remaining === undefined ? timeoutMs : Math.floor(remaining)))
    if (this.deps.killProcess) {
      // An injected numeric signal hook is useful to model the kernel in
      // deterministic tests, but it is never authority for a legacy or
      // cooperative record.  Real cleanup must use the identity-bound tree
      // primitive below; do not reintroduce PID-only Windows fallback here.
      if (
        !Number.isFinite(expectedStartedAtMs) ||
        getProcessTreeContainmentCapability(expectedOsIdentity ?? undefined, process.platform) !== 'exact'
      ) return false
      if (context.signal?.aborted || (context.remainingMs && context.remainingMs() <= 0)) {
        if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
        throw new Error('OpenCode host termination deadline exhausted')
      }
      // Keep this immediately adjacent to the destructive callback: a prior
      // identity read or verification wait is not a live cancellation check.
      this.deps.killProcess(pid, signal)
      const verificationWaitMs = Math.min(boundedTimeoutMs, 250)
      // Keep the injectable wait used by deterministic process-control tests,
      // while its companion timer guarantees that no implementation can wait
      // past the request budget.
      await Promise.race([
        this.sleepMs(verificationWaitMs),
        waitForOpenCodeAbortableDelay(verificationWaitMs, context.signal),
      ])
      if (context.remainingMs && context.remainingMs() <= 0) {
        throw new Error('OpenCode host termination deadline exhausted')
      }
      return !this.isProcessAlive(pid)
    }
    const terminated = (this.deps.killProcessTreeAndWait ?? killProcessTreeAndWait)(pid, signal, {
      timeoutMs: boundedTimeoutMs,
      expectedStartedAtMs,
      expectedOsIdentity,
      signal: context.signal,
      remainingMs: context.remainingMs,
      dependencies: {
        isProcessAlive: this.deps.isProcessAlive,
        readProcessStartTimeMs: this.deps.readProcessStartTimeMs
          ? (targetPid, queryTimeoutMs) => this.deps.readProcessStartTimeMs!(targetPid, queryTimeoutMs)
          : undefined,
        // Tree termination owns both signaling and the completion receipt;
        // do not downgrade this to root-only PID signaling.
      },
    })
    return raceOpenCodeAbortSignal(terminated, context.signal)
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
    context: OpenCodeClientRequestContext = {},
  ): Promise<T> {
    const assertAvailable = () => {
      if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
      const remaining = context.remainingMs?.()
      if (remaining !== undefined && (!Number.isFinite(remaining) || remaining <= 0)) {
        throw new Error('OpenCode profile cleanup deadline exhausted')
      }
    }
    assertAvailable()
    await mkdir(tempPath, { recursive: true })
    assertAvailable()
    const lockPath = path.join(tempPath, '.opencode-host-owners.lock')
    await writeFile(lockPath, '', { flag: 'a' })
    let release: (() => Promise<void>) | undefined
    try {
      // Do not give every profile an independent retry schedule. The shared
      // startup context bounds lock contention, profile enumeration and the
      // eventual ownership probe as one cleanup request.
      for (;;) {
        assertAvailable()
        try {
          release = await lockfile.lock(lockPath, { realpath: false, stale: 30_000, retries: 0 })
          break
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined
          if (code !== 'ELOCKED') throw error
          const remaining = context.remainingMs?.()
          await waitForOpenCodeAbortableDelay(Math.max(1, Math.min(50, remaining ?? 50)), context.signal)
        }
      }
      assertAvailable()
      return await callback()
    } finally {
      if (release) await release()
    }
  }

  private async publishTempOwnershipMarker(
    tempPath: string,
    pid: number,
    context: OpenCodeClientRequestContext = {},
  ): Promise<void> {
    if (pid <= 0) return
    await this.withTempOwnershipLock(tempPath, async () => {
      await this.publishTempOwnershipMarkerUnlocked(tempPath, pid, context)
    })
  }

  private async publishTempOwnershipMarkerUnlocked(
    tempPath: string,
    pid: number,
    context: OpenCodeClientRequestContext = {},
  ): Promise<void> {
    if (pid <= 0) throw new Error('OpenCode host did not publish a process id')
    this.assertPersistenceAuthority(context)
    const markerDir = this.getTempOwnershipMarkerPath(tempPath)
    await mkdir(markerDir, { recursive: true })
    this.assertPersistenceAuthority(context)
    await writeJsonFileAtomic(path.join(markerDir, `${pid}.json`), {
      pid,
      startedAtMs: await this.readProcessStartTimeMs(pid).catch(() => null),
    }, { context: this.atomicWriteContext(context) })
  }

  private async hasLiveTempOwnershipMarker(
    tempPath: string,
    context: OpenCodeClientRequestContext = {},
  ): Promise<boolean> {
    if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
    const markerDir = this.getTempOwnershipMarkerPath(tempPath)
    let markers: string[]
    try {
      markers = await readdir(markerDir)
    } catch (error) {
      if (isMissingPathError(error)) return false
      throw error
    }
    for (const name of markers) {
      if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
      if (context.remainingMs && context.remainingMs() <= 0) {
        throw new Error('OpenCode profile cleanup deadline exhausted')
      }
      let marker: { pid?: unknown; startedAtMs?: unknown }
      try {
        marker = JSON.parse(await readFile(path.join(markerDir, name), 'utf8')) as {
          pid?: unknown
          startedAtMs?: unknown
        }
      } catch (error) {
        throw new Error(`OpenCode temp ownership marker ${name} could not be verified: ${cleanupErrorMessage(error)}`)
      }
      if (typeof marker.pid !== 'number' || !this.isProcessAlive(marker.pid)) continue
      if (typeof marker.startedAtMs !== 'number') return true
      const remaining = context.remainingMs?.()
      if ((await this.readProcessStartTimeMs(
        marker.pid,
        process.platform,
        remaining === undefined ? undefined : Math.max(1, Math.min(6_000, Math.floor(remaining))),
      ).catch(() => null)) === marker.startedAtMs) return true
    }
    return false
  }

  private async cleanupOpenTuiTempArtifactsIfUnused(
    tempPath: string,
    pid?: number,
    context: OpenCodeClientRequestContext = {},
  ): Promise<void> {
    await this.withTempOwnershipLock(tempPath, async () => {
      if (typeof pid === 'number' && pid > 0 && this.isProcessAlive(pid)) return
      if (this.hasTrackedAliveHostUsingTempPath(tempPath, pid)) return
      if (await this.hasLiveTempOwnershipMarker(tempPath, context)) return
      // Final recheck is under the same ownership lock used by publishers.
      if (this.hasTrackedAliveHostUsingTempPath(tempPath, pid)) return
      if (await this.hasLiveTempOwnershipMarker(tempPath, context)) return
      await cleanupOpenTuiTempDylibs(tempPath, context)
    }, context)
  }

  private async cleanupStaleManagedProfileTempDylibs(
    activeProfileRootKeys: ReadonlySet<string>,
    context: OpenCodeClientRequestContext = {},
  ): Promise<StaleTempCleanupResult> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return { removed: 0, bytes: 0, unresolvedPaths: [], diagnostics: [] }
    }
    const profilesRootPath = path.join(path.dirname(registryPath), 'profiles')
    if (context.signal?.aborted || (context.remainingMs && context.remainingMs() <= 0)) {
      return {
        removed: 0,
        bytes: 0,
        unresolvedPaths: [profilesRootPath],
        diagnostics: [context.signal?.aborted
          ? 'OpenCode profile cleanup cancelled before enumeration'
          : 'OpenCode profile cleanup deadline exhausted before enumeration'],
      }
    }
    let profiles: Dirent<string>[]
    try {
      profiles = await readdir(profilesRootPath, { withFileTypes: true })
    } catch (error) {
      if (isMissingPathError(error)) {
        return { removed: 0, bytes: 0, unresolvedPaths: [], diagnostics: [] }
      }
      return {
        removed: 0,
        bytes: 0,
        unresolvedPaths: [profilesRootPath],
        diagnostics: [`Unable to enumerate stale OpenCode profiles: ${cleanupErrorMessage(error)}`],
      }
    }
    if (context.signal?.aborted || (context.remainingMs && context.remainingMs() <= 0)) {
      return {
        removed: 0,
        bytes: 0,
        unresolvedPaths: [profilesRootPath],
        diagnostics: [context.signal?.aborted
          ? 'OpenCode profile cleanup cancelled during enumeration'
          : 'OpenCode profile cleanup deadline exhausted during enumeration'],
      }
    }
    const staleBeforeMs = this.nowMs() - OPEN_CODE_STALE_TEMP_DYLIB_AGE_MS
    let removed = 0
    let bytes = 0
    const unresolvedPaths: string[] = []
    const diagnostics: string[] = []

    for (let index = 0; index < profiles.length; index += 1) {
      const profile = profiles[index]!
      if (context.signal?.aborted || (context.remainingMs && context.remainingMs() <= 0)) {
        const reason = context.signal?.aborted
          ? 'OpenCode profile cleanup cancelled'
          : 'OpenCode profile cleanup deadline exhausted'
        diagnostics.push(reason)
        for (const remainingProfile of profiles.slice(index)) {
          if (remainingProfile.isDirectory() && !activeProfileRootKeys.has(remainingProfile.name)) {
            unresolvedPaths.push(path.join(profilesRootPath, remainingProfile.name, 'tmp'))
          }
        }
        break
      }
      if (!profile.isDirectory() || activeProfileRootKeys.has(profile.name)) {
        continue
      }
      const tmpPath = path.join(profilesRootPath, profile.name, 'tmp')
      try {
        await this.withTempOwnershipLock(tmpPath, async () => {
          if (await this.hasLiveTempOwnershipMarker(tmpPath, context)) return
          let entries: Dirent<string>[]
          try {
            entries = await readdir(tmpPath, { withFileTypes: true })
          } catch (error) {
            if (isMissingPathError(error)) return
            throw error
          }
          for (const entry of entries) {
            if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
            if (context.remainingMs && context.remainingMs() <= 0) {
              throw new Error('OpenCode profile cleanup deadline exhausted')
            }
            if (!entry.isFile() || !OPENTUI_TEMP_DYLIB_RE.test(entry.name)) continue
            const filePath = path.join(tmpPath, entry.name)
            let metadata: Awaited<ReturnType<typeof stat>>
            try {
              metadata = await stat(filePath)
            } catch (error) {
              // A raced-away file is harmless.  Every other inspection error
              // means cleanup coverage is unknown: do not silently turn an
              // unreadable candidate into a clean inventory.
              if (!isMissingPathError(error)) {
                unresolvedPaths.push(filePath)
                diagnostics.push(`Unable to inspect stale OpenCode temp dylib ${filePath}: ${cleanupErrorMessage(error)}`)
              }
              continue
            }
            if (metadata.mtimeMs > staleBeforeMs) continue
            if (await this.hasLiveTempOwnershipMarker(tmpPath, context)) return
            try {
              await unlink(filePath)
              removed += 1
              bytes += metadata.size
            } catch (error) {
              if (!isMissingPathError(error)) {
                unresolvedPaths.push(filePath)
                diagnostics.push(`Unable to remove stale OpenCode temp dylib ${filePath}: ${cleanupErrorMessage(error)}`)
              }
            }
          }
        }, context)
      } catch (error) {
        unresolvedPaths.push(tmpPath)
        diagnostics.push(`Unable to clean stale OpenCode profile ${tmpPath}: ${cleanupErrorMessage(error)}`)
        if (context.signal?.aborted || (context.remainingMs && context.remainingMs() <= 0)) {
          for (const remainingProfile of profiles.slice(index + 1)) {
            if (remainingProfile.isDirectory() && !activeProfileRootKeys.has(remainingProfile.name)) {
              unresolvedPaths.push(path.join(profilesRootPath, remainingProfile.name, 'tmp'))
            }
          }
          break
        }
      }
    }

    return { removed, bytes, unresolvedPaths: [...new Set(unresolvedPaths)], diagnostics }
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
    context: OpenCodeClientRequestContext = {},
  ): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }
    // Publish the host-side evidence before making a reap-eligible registry
    // record visible. A missing identity or failed attribution write leaves the
    // registry unchanged, so cursor cleanup remains fail-closed.
    this.assertPersistenceAuthority(context)
    await Promise.all(Object.values(registry.hosts).map(record =>
      this.writePersistentHostAttributionRecord(record, context)))
    this.assertPersistenceAuthority(context)
    await writeJsonFileAtomic(registryPath, registry, {
      indent: 2,
      context: this.atomicWriteContext(context),
    })
  }

  private atomicWriteContext(context: OpenCodeClientRequestContext): AtomicWriteContext {
    return {
      signal: context.signal,
      remainingMs: context.remainingMs,
      throwIfExpired: () => this.assertPersistenceAuthority(context),
    }
  }

  private assertPersistenceAuthority(context: OpenCodeClientRequestContext = {}): void {
    if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
    if (context.remainingMs && context.remainingMs() <= 0) {
      throw new Error('OpenCode persistent publication deadline exhausted')
    }
  }

  private async writePersistentHostAttributionRecord(
    record: PersistentHostRegistryRecord,
    context: OpenCodeClientRequestContext = {},
  ): Promise<void> {
    const directory = this.processAttributionDirectory
    if (!directory || !isProcessAttributionId(record.attributionId)
      || record.cursorAgentReapContractVersion !== 1
      || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || !Number.isFinite(record.processStartedAtMs) || (record.processStartedAtMs ?? 0) <= 0) {
      return
    }
    await writeHostAttributionRecord({
      directory,
      attributionId: record.attributionId,
      hostPid: record.pid,
      hostStartedAtNative: record.processStartedAtMs,
      projectPath: record.projectPath,
      owners: Object.values(normalizePersistentHostLeases(record.leases)),
      now: () => this.now(),
      context: this.atomicWriteContext(context),
    })
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
      processOsIdentity: handle.processOsIdentity,
      ...(isProcessAttributionId(handle.attributionId)
        && Number.isFinite(handle.processStartedAtMs)
        && (handle.processStartedAtMs ?? 0) > 0
        // Never promote an already-persisted generation that did not opt in
        // to atomic reaping. Only a freshly created record gets this contract.
        && (!previous || previous.cursorAgentReapContractVersion === 1)
        ? { attributionId: handle.attributionId, cursorAgentReapContractVersion: 1 as const }
        : {}),
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

  private async withPersistentRegistryLock<T>(
    callback: () => Promise<T>,
    options: {
      signal?: AbortSignal
      remainingMs?: () => number
      onCompromised?: (error: Error) => void
      /** A completed bounded cleanup receipt remains publishable at its exact deadline. */
      preserveCompletedCallbackAtDeadline?: boolean
    } = {},
  ): Promise<T> {
    const resolvedOptions = options
    let compromised: Error | undefined
    const assertAvailable = () => {
      if (compromised) throw new Error(`OpenCode persistent registry lock compromised: ${compromised.message}`)
      if (resolvedOptions.signal?.aborted) throwOpenCodeAbortReason(resolvedOptions.signal)
      if (resolvedOptions.remainingMs && resolvedOptions.remainingMs() <= 0) {
        throw new Error('OpenCode persistent registry lock deadline exhausted')
      }
    }
    assertAvailable()
    const lockPath = await this.ensurePersistentRegistryLockFile()
    if (!lockPath) {
      assertAvailable()
      return callback()
    }

    let release: (() => Promise<void>) | undefined
    try {
      // proper-lockfile's built-in retry sequence cannot observe an abort
      // signal. Acquire one attempt at a time so stop deadlines include lock
      // contention rather than starting only after endpoint resolution.
      for (;;) {
        assertAvailable()
        try {
          release = await lockfile.lock(lockPath, {
            ...PERSISTENT_REGISTRY_LOCK_OPTIONS,
            retries: 0,
            onCompromised: error => {
              compromised = error
              resolvedOptions.onCompromised?.(error)
            },
          })
          break
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined
          if (code !== 'ELOCKED') throw error
          // From this point until the next lock attempt, an abort/deadline is
          // specifically lock contention. Preserve that fact structurally so
          // startup cleanup can publish partial scope evidence regardless of
          // an AbortError's (or a platform error's) message text.
          try {
            assertAvailable()
            const remaining = resolvedOptions.remainingMs?.()
            await waitForOpenCodeAbortableDelay(
              Math.max(1, Math.min(100, remaining ?? 100)),
              resolvedOptions.signal,
            )
            assertAvailable()
          } catch (interruption) {
            throw new PersistentRegistryLockContentionInterruptedError(interruption)
          }
        }
      }
      assertAvailable()
      const value = await callback()
      // A startup cleanup callback returns structured survivor/coverage evidence.
      // Do not replace that completed receipt with a lock-only deadline error
      // merely because its shared observation deadline elapsed while unwinding.
      if (!resolvedOptions.preserveCompletedCallbackAtDeadline) assertAvailable()
      return value
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

  private async upsertPersistentHost(
    handle: OpenCodeHostHandle,
    context: OpenCodeClientRequestContext = {},
  ): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath || handle.pid <= 0) {
      return
    }
    await this.withPersistentRegistryLock(async () => {
      this.assertPersistenceAuthority(context)
      const registry = await this.readPersistentRegistryUnlocked()
      const previous = registry.hosts[handle.hostKey]
      registry.hosts[handle.hostKey] = this.buildPersistentHostRecord(handle, previous)
      await this.writePersistentRegistryUnlocked(registry, context)
    }, context)
  }

  private async upsertPersistentHostWithLease(
    handle: OpenCodeHostHandle,
    lease: OpenCodeHostLeaseInput,
    context: OpenCodeClientRequestContext = {},
  ): Promise<void> {
    if (!this.persistentRegistryPath || handle.pid <= 0) return
    await this.withPersistentRegistryLock(async () => {
      this.assertPersistenceAuthority(context)
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
      await this.writePersistentRegistryUnlocked(registry, context)
    }, context)
  }

  private async removePersistentHost(
    hostKey: string,
    context: OpenCodeClientRequestContext = {},
  ): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }
    await this.withPersistentRegistryLock(async () => {
      this.assertPersistenceAuthority(context)
      const registry = await this.readPersistentRegistryUnlocked()
      if (!registry.hosts[hostKey]) {
        return
      }
      delete registry.hosts[hostKey]
      if (Object.keys(registry.hosts).length === 0) {
        this.assertPersistenceAuthority(context)
        await unlink(registryPath).catch(() => undefined)
        return
      }
      await this.writePersistentRegistryUnlocked(registry, context)
    }, context)
  }

  async retainHostLease(
    hostKey: string,
    input: OpenCodeHostLeaseInput,
    options: OpenCodeClientRequestContext = {},
  ): Promise<void> {
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
      this.assertPersistenceAuthority(options)
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
      await this.writePersistentRegistryUnlocked(registry, options)
    }, options)
  }

  async releaseHostLease(
    hostKey: string,
    input: OpenCodeHostLeaseInput,
    options: { signal?: AbortSignal; remainingMs?: () => number } = {},
  ): Promise<void> {
    input = Object.freeze({ ...input })
    if (this.custody) {
      this.#hosts.get(hostKey)?.supervisor?.leases.delete(buildLeaseKey(input))
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
      await this.writePersistentRegistryUnlocked(registry, options)
    }, options)
  }

  async resolveOwnedSessionEndpoint(
    hostKey: string,
    input: OpenCodeHostLeaseInput & { projectPath: string; expectedProcessStartedAtMs?: number },
    options: { signal?: AbortSignal; remainingMs?: () => number } = {},
  ): Promise<{ baseUrl: string; pid: number }> {
    if (options.signal?.aborted) throwOpenCodeAbortReason(options.signal)
    if (options.remainingMs && options.remainingMs() <= 0) {
      throw new Error('OpenCode cleanup endpoint deadline exhausted')
    }
    if (!input.runId || !input.sessionId) throw new Error('OpenCode cleanup requires exact run and session')
    return this.withPersistentRegistryLock(async () => {
      const record = (await this.readPersistentRegistryUnlocked()).hosts[hostKey]
      const lease = record && normalizePersistentHostLeases(record.leases)[buildLeaseKey(input)]
      if (!record || record.hostKey !== hostKey || record.projectPath !== input.projectPath
        || (input.expectedProcessStartedAtMs !== undefined
          && (!Number.isFinite(input.expectedProcessStartedAtMs) || input.expectedProcessStartedAtMs <= 0
            || record.processStartedAtMs !== input.expectedProcessStartedAtMs))
        || !lease || lease.teamId !== input.teamId
        || lease.laneId !== (input.laneId?.trim() || 'primary')
        || lease.memberName !== input.memberName
        || lease.runId !== input.runId || lease.sessionId !== input.sessionId) {
        throw new Error('OpenCode cleanup host ownership is unavailable')
      }
      if (!Number.isSafeInteger(record.port) || record.port <= 0 || record.port > 65535
        || record.baseUrl !== `http://127.0.0.1:${record.port}`) {
        throw new Error('OpenCode cleanup endpoint is invalid')
      }
      if ((await this.inspectPersistentHostProcessIdentity(record)).state !== 'confirmed') {
        throw new Error('OpenCode cleanup host process ownership is unavailable')
      }
      if (options.signal?.aborted) throwOpenCodeAbortReason(options.signal)
      if (options.remainingMs && options.remainingMs() <= 0) {
        throw new Error('OpenCode cleanup endpoint deadline exhausted')
      }
      return { baseUrl: record.baseUrl, pid: record.pid }
    }, options)
  }

  /** Reap only positively attributed, unleased Cursor descendants under the
   * registry lock. Ambiguous or unavailable OAuth evidence is fail-closed. */
  async reapUnleasedCursorAgentTrees(body: unknown): Promise<CursorAgentReapResult> {
    const input = parseCursorAgentReapInput(body)
    const result: CursorAgentReapResult = { contractVersion: 1, status: 'kept', killedPids: [], diagnostics: [] }
    const registryPath = this.persistentRegistryPath
    const directory = this.processAttributionDirectory
    if (!registryPath || !directory) {
      result.diagnostics.push('Persistent registry or attribution directory unavailable')
      return result
    }
    const deadline = Date.now() + 10_000
    let compromised: Error | undefined
    const guard = () => {
      if (compromised) throw new Error(`Registry lock compromised: ${compromised.message}`)
      if (Date.now() >= deadline) throw new Error('Cursor reap deadline exhausted')
    }
    try {
      await this.withPersistentRegistryLock(async () => {
        guard()
        let raw: unknown
        try { raw = JSON.parse(await readFile(registryPath, 'utf8')) } catch {
          result.diagnostics.push('Registry missing, unreadable or corrupt')
          return
        }
        const records = await readAttributionRecords(directory)
        guard()
        await reapCursorAgents(input, raw, records, {
          deadline,
          guard,
          profileScope: process.env.CLAUDE_TEAM_APP_PROFILE_SCOPE,
          // This branch has no durable pending-publication registry; do not
          // claim such an owner absent evidence.
          pendingOAuth: async () => false,
          processLifetime: key => this.#hosts.get(key)?.lifetime === 'process',
          native: this.deps.cursorAgentNativePorts,
        }, result)
      }, { onCompromised: error => { compromised = error } })
    } catch (error) {
      result.status = 'incomplete'
      result.diagnostics.push(error instanceof Error ? error.message : String(error))
    }
    return result
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
    abortSignal?: AbortSignal,
  ): Promise<OpenCodeHostHandle | null> {
    const persistenceContext: OpenCodeClientRequestContext = abortSignal ? { signal: abortSignal } : {}
    let leaseReserved = false
    const record = lease && this.persistentRegistryPath
      ? await this.withPersistentRegistryLock(async () => {
          this.assertPersistenceAuthority(persistenceContext)
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
          await this.writePersistentRegistryUnlocked(registry, persistenceContext)
          leaseReserved = true
          return candidate
        }, persistenceContext)
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
        await this.removePersistentHost(hostKey, persistenceContext).catch(() => undefined)
        return null
      }
    const processIdentity = await this.inspectPersistentHostProcessIdentity(record, persistenceContext)
    if (processIdentity.state === 'gone' || processIdentity.state === 'changed') {
      await this.removePersistentHost(hostKey, persistenceContext).catch(() => undefined)
      return null
    }
    const health = await this.checkHealthyHostOnce(record.baseUrl, persistenceContext)
    if (!health) {
      if (processIdentity.state === 'unverified') {
        throw new Error(
          `OpenCode host pid ${record.pid} is unhealthy and its legacy identity ` +
          'could not be verified; refusing to launch a duplicate persistent host',
        )
      }
      await this.terminatePersistentHostRecord(record, { force: true, ...persistenceContext })
      await this.removePersistentHost(hostKey, persistenceContext).catch(() => undefined)
      return null
    }
    if (processIdentity.state === 'confirmed') {
      const identityAfterHealth = await this.inspectPersistentHostProcessIdentity({
        ...record,
        processStartedAtMs: processIdentity.startedAtMs,
      }, persistenceContext)
      if (identityAfterHealth.state === 'gone' || identityAfterHealth.state === 'changed') {
        await this.removePersistentHost(hostKey, persistenceContext).catch(() => undefined)
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
      ? await this.verifyLegacyPersistentHostIdentity(record, processIdentity.startedAtMs, persistenceContext)
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
      processOsIdentity: record.processOsIdentity,
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

      if (this.custody && (
        !config.data || typeof config.data !== 'object' || Array.isArray(config.data) ||
        !configProviders.data || typeof configProviders.data !== 'object' || Array.isArray(configProviders.data) ||
        !Array.isArray(agents.data) || !mcp.data || typeof mcp.data !== 'object' || Array.isArray(mcp.data)
      )) return null

      const fingerprintSource = {
        config:
          config.status === 200 ? normalizeResolvedFingerprintValue(config.data, 'config') : null,
        configProviders:
          configProviders.status === 200
            ? normalizeResolvedFingerprintValue(configProviders.data, 'configProviders')
            : null,
        agents:
          agents.status === 200 ? normalizeResolvedFingerprintValue(agents.data, 'agents') : null,
        mcp: mcp.status === 200 ? normalizeResolvedFingerprintValue(mcp.data, 'mcp') : null,
      }

      if (this.custody && Object.values(fingerprintSource).some(value => value === null || value === undefined)) {
        return null
      }

      if (
        fingerprintSource.config === null &&
        fingerprintSource.configProviders === null &&
        fingerprintSource.agents === null &&
        fingerprintSource.mcp === null
      ) {
        return null
      }
      return fingerprintOpenCodeResolvedConfigEndpoints(fingerprintSource)
    } catch {
      return null
    }
  }

  private spawnHost(
    profile: OpenCodePreparedProfile,
    port: number,
    lifetime: OpenCodeHostLifetime,
    attributionId: string | null = null,
  ): { child: ChildProcess; processOsIdentity: string | null } {
    if (this.deps.spawnHostProcess) {
      return { child: this.deps.spawnHostProcess(profile, port), processOsIdentity: null }
    }

    const launch = buildExactProcessTreeSpawn(
      resolveOpenCodeBinaryPath() ?? 'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      buildOpenCodeHostSpawnOptions(profile, process.platform, {
        lifetime,
        attributionId,
        attributionDirectory: resolveProcessAttributionDirectory(profile.env),
      }),
    )
    return {
      child: spawnPortableCli(launch.command, launch.args, launch.options),
      processOsIdentity: launch.osIdentity,
    }
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

      // A root exit is not whole-tree exhaustion: detached descendants can
      // still hold files or inherited sockets.  Keep both the in-memory and
      // persistent ownership record until reconciliation has an exact cleanup
      // receipt; never turn a root-only observation into a deletion.
      pushDiagnostic('root exit retained pending exact whole-tree reconciliation')
      const controller = new AbortController()
      const deadlineAt = Date.now() + 2_000
      const timer = setTimeout(() => controller.abort(new Error('root exit reconciliation budget exhausted')), 2_000)
      timer.unref?.()
      void this.reconcilePersistentHosts({
        mode: 'stale', reason: 'root_exit', staleAgeMs: 0,
        leaseStaleAgeMs: null, preflightLeaseStaleAgeMs: null,
        signal: controller.signal,
        remainingMs: () => controller.signal.aborted ? 0 : Math.max(0, deadlineAt - Date.now()),
      }).catch(() => undefined).finally(() => clearTimeout(timer))
    })
  }

  private async forceKillSpawnedHostProcess(
    child: ChildProcess,
    expectedStartedAtMs?: number | null,
    expectedOsIdentity?: string | null,
    context: OpenCodeClientRequestContext = {},
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
            expectedOsIdentity,
            context,
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
        expectedOsIdentity,
        context,
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
    const persistenceContext: OpenCodeClientRequestContext = abortSignal ? { signal: abortSignal } : {}
    const port = await this.allocateLoopbackPort()
    const baseUrl = `http://127.0.0.1:${port}`
    const diagnostics: string[] = []
    // Mint before spawning so every Cursor descendant inherits the exact host
    // attribution marker, even if it outlives the direct OpenCode process.
    const attributionId = mintProcessAttributionId()
    let child: ChildProcess | null = null
    let processOsIdentity: string | null = null
    try {
      // Sweep and spawn use the same cross-process lock, so no OpenTUI dylib
      // can be removed between process creation and ownership publication.
      child = await this.withTempOwnershipLock(profile.tmpPath, async () => {
        const spawned = this.spawnHost(profile, port, lifetime, attributionId)
        child = spawned.child
        processOsIdentity = spawned.processOsIdentity
        await this.deps.beforeTempOwnershipMarkerPublish?.()
        await this.publishTempOwnershipMarkerUnlocked(profile.tmpPath, child.pid ?? -1, persistenceContext)
        return child
      })
    } catch (error) {
      const terminated = child
        ? await this.forceKillSpawnedHostProcess(
            child,
            child.pid
              ? await this.captureProcessStartTimeMs(child.pid).catch(() => null)
              : null,
            processOsIdentity,
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
          processOsIdentity,
          attributionId,
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
      processOsIdentity,
      attributionId,
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
      if (handle.processOsIdentity === 'unix-pgid:pending') {
        handle.processOsIdentity = await captureProcessTreeIdentity(handle.pid).catch(() => null)
      }
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
        if (lease) await this.upsertPersistentHostWithLease(handle, lease, persistenceContext)
        else await this.upsertPersistentHost(handle, persistenceContext)
      }
      return handle
    } catch (error) {
      handle.state = 'degraded'
      const message = error instanceof Error ? error.message : String(error)
      diagnostics.push(message)
      const expectedStartedAtMs =
        handle.processStartedAtMs ??
        (await this.captureProcessStartTimeMs(handle.pid).catch(() => null))
      const terminated = await this.forceKillSpawnedHostProcess(
        child,
        expectedStartedAtMs,
        handle.processOsIdentity,
        { ...(abortSignal ? { signal: abortSignal } : {}) },
      )
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
    assertOpenCodeHostReuseIdentity(explicitHostKey, profile)
    const binaryHostIdentity = openCodeArtifactDigest ?? (binaryPath
      ? await raceOpenCodeAbortSignal(resolveOpenCodeBinaryHostIdentity(binaryPath), params.abortSignal)
      : 'missing-binary')
    const baseHostKey = buildOpenCodeHostProfileIdentity(profile, binaryHostIdentity)
    const hostKey = explicitHostKey || (hostLifetime === 'process'
      ? `${baseHostKey}::process:${process.pid}:${randomUUID()}`
      : baseHostKey)
    const healthTimeoutMs = normalizeOpenCodeHostHealthTimeoutMs(params.healthTimeoutMs)
    const resolveConfigFingerprint = params.resolveConfigFingerprint !== false
    const existing = this.#hosts.get(hostKey)
    if (existing && existing.handle.state === 'healthy') {
      if (explicitHostKey) assertHealthyOpenCodeHostReuse(explicitHostKey, profile, existing.handle)
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
      if (explicitHostKey) assertHealthyOpenCodeHostReuse(explicitHostKey, profile, handle)
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
            ? await this.adoptPersistentHost(hostKey, profile, openCodeArtifactDigest, resolveConfigFingerprint, params.lease, params.abortSignal)
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
  }, context: OpenCodePhaseContext): Promise<OpenCodeHostHandle> {
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
        existing.supervisor.leases.add(leaseKey)
        existing.refCount += 1
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
      this.#hosts.set(custody.hostKey, { handle, child: null, refCount: 1, ownedByProcess: false,
        lifetime: 'process', supervisor: { custody, leases: new Set([leaseKey]) } })
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
    options: {
      force: boolean
      startupBudget?: OpenCodePersistentHostReconcileOptions['startupBudget']
      signal?: AbortSignal
      remainingMs?: () => number
    },
  ): Promise<void> {
    if (this.custody) throw new Error('OpenCode supervisor retains process cleanup authority')
    const entry = this.#hosts.get(record.hostKey)
    const pid = entry?.handle.pid ?? record.pid
    let terminated = false

    const context: OpenCodeClientRequestContext = {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.remainingMs ? { remainingMs: options.remainingMs } : {}),
    }
    if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
    if (context.remainingMs && context.remainingMs() <= 0) {
      throw new Error('OpenCode host termination deadline exhausted')
    }
    const processIdentity = await this.inspectPersistentHostProcessIdentity({
      ...record,
      processStartedAtMs: entry?.handle.processStartedAtMs ?? record.processStartedAtMs,
    }, context)
    if (processIdentity.state === 'gone') {
      throw new Error(`OpenCode host pid ${pid} exited before owned whole-tree cleanup could be confirmed`)
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
        context,
      )
      if (identityBeforeKill === 'gone') {
        throw new Error(`OpenCode host pid ${pid} exited before owned whole-tree cleanup could be confirmed`)
      } else if (entry?.child?.pid) {
        terminated = await this.killProcessAndWait(
          entry.child.pid,
          'SIGTERM',
          OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
          processIdentity.startedAtMs,
          entry.handle.processOsIdentity ?? record.processOsIdentity,
          context,
        )
      } else {
        terminated = await this.killProcessAndWait(
          pid,
          'SIGTERM',
          OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS,
          processIdentity.startedAtMs,
          record.processOsIdentity,
          context,
        )
      }
    }

    if (options.force && pid > 0 && !terminated && this.isProcessAlive(pid)) {
      const identityBeforeForceKill = await this.assertPersistentHostProcessIdentity(
        record,
        processIdentity.startedAtMs,
        context,
      )
      terminated =
        identityBeforeForceKill !== 'gone' &&
        (await this.killProcessAndWait(
          pid,
          'SIGKILL',
          OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS,
          processIdentity.startedAtMs,
          entry?.handle.processOsIdentity ?? record.processOsIdentity,
          context,
        ))
    }

    if (!terminated) {
      throw new Error(
        `OpenCode host pid ${pid} has no owned whole-tree termination receipt after ${options.force ? 'forced ' : ''}cleanup`,
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
    if (context.signal?.aborted) throwOpenCodeAbortReason(context.signal)
    if (context.remainingMs && context.remainingMs() <= 0) {
      throw new Error('OpenCode host termination deadline exhausted before temp cleanup')
    }
    await this.cleanupOpenTuiTempArtifactsIfUnused(
      entry?.handle.profile.tmpPath ?? this.getPersistentProfileTmpPath(record.profileRootKey),
      pid,
      context,
    )
  }

  async disposeHost(
    hostKey: string,
    options: { signal?: AbortSignal; remainingMs?: () => number } = {},
  ): Promise<boolean> {
    if (options.signal?.aborted) throwOpenCodeAbortReason(options.signal)
    if (options.remainingMs && options.remainingMs() <= 0) {
      throw new Error('OpenCode host disposal deadline exhausted')
    }
    if (this.custody) {
      const entry = this.#hosts.get(hostKey)
      if (!entry?.supervisor) {
        if (hostKey === this.custody.hostKey) await this.custody.closeOwnerResources()
        return false
      }
      entry.handle.state = 'disposed'
      entry.supervisor.leases.clear()
      this.#hosts.delete(hostKey)
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
            processOsIdentity: entry.handle.processOsIdentity,
            version: entry.handle.version,
            resolvedConfigFingerprint: entry.handle.resolvedConfigFingerprint,
            updatedAt: this.nowIso(),
            leases: {},
          },
          { force: true, signal: options.signal, remainingMs: options.remainingMs },
        )
      } catch (error) {
        entry.handle.state = 'degraded'
        throw error
      }
      const registry = await this.readPersistentRegistryUnlocked()
      if (registry.hosts[hostKey]) {
        delete registry.hosts[hostKey]
        this.assertPersistenceAuthority(options)
        await this.writePersistentRegistryUnlocked(registry, options)
      }
      return true
    }
    return this.persistentRegistryPath
      ? this.withPersistentRegistryLock(dispose, options)
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

  /**
   * Startup lock contention is an observation failure, not an untyped command
   * failure. This deliberately takes a read-only best-effort snapshot without
   * claiming a lock: each PID is retained as a survivor and no registry state
   * is mutated until a future owner can acquire the lock.
   */
  private async startupRegistryLockFailureReceipt(
    error: unknown,
    context: OpenCodeClientRequestContext = {},
  ): Promise<OpenCodePersistentHostReconcileResult> {
    const reason = error instanceof Error ? error.message : String(error)
    // Once the shared deadline is exhausted, even a best-effort registry read
    // would be a new unbounded operation. Preserve an explicitly partial
    // receipt instead of discovering PIDs after the caller's authority ended.
    const mayReadSnapshot = !context.signal?.aborted && (context.remainingMs?.() ?? 1) > 0
    const registry = mayReadSnapshot
      ? await this.readPersistentRegistryUnlocked().catch(() => ({ schemaVersion: 1 as const, hosts: {} }))
      : { schemaVersion: 1 as const, hosts: {} }
    const hosts = Object.entries(registry.hosts).map(([hostKey, record]) => ({
      hostKey,
      projectPath: record.projectPath,
      pid: record.pid,
      port: record.port,
      action: 'failed' as const,
      reason: `startup registry lock unavailable: ${reason}`,
      leaseCount: Object.keys(normalizePersistentHostLeases(record.leases)).length,
    }))
    const survivingPids = [...new Set(hosts.filter(host => host.pid > 0).map(host => host.pid))]
    const profilesRootPath = this.persistentRegistryPath
      ? path.join(path.dirname(this.persistentRegistryPath), 'profiles')
      : null
    const unresolvedPaths = [...new Set([
      // The locked registry itself is unresolved scope when cancellation wins
      // lock contention before a safe snapshot can be read.
      ...(this.persistentRegistryPath ? [this.persistentRegistryPath] : []),
      ...(profilesRootPath ? [profilesRootPath] : []),
      ...Object.values(registry.hosts).map(record => this.getPersistentProfileTmpPath(record.profileRootKey)),
    ])]
    return {
      cleaned: 0,
      remaining: hosts.length,
      hosts,
      diagnostics: [`OpenCode startup reconciliation could not acquire the persistent registry lock: ${reason}`],
      startupCleanup: {
        completion: 'unknown',
        coverage: 'partial',
        survivingPids,
        ...(unresolvedPaths.length ? {
          unresolvedPaths,
          cleanupDiagnostics: [`OpenCode startup cleanup did not run because registry lock acquisition failed: ${reason}`],
        } : {}),
      },
    }
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

    try {
      return await this.withPersistentRegistryLock(async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      const hosts: OpenCodePersistentHostReconcileResult['hosts'] = []
      const diagnostics: string[] = []
      let cleaned = 0
      let changed = false
      const mode = options.mode ?? 'stale'
      const force = mode === 'force'
      const requestContext: OpenCodeClientRequestContext = {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.remainingMs ? { remainingMs: options.remainingMs } : options.startupBudget ? { remainingMs: () => options.startupBudget!.remaining() } : {}),
      }
      const nowMs = this.now().getTime()
      const projectPathFilter = options.projectPath?.trim()
      const normalizedProjectPathFilter = projectPathFilter
        ? await normalizeProjectPathForComparison(projectPathFilter)
        : null

      const registryEntries = Object.entries(registry.hosts)
      for (let index = 0; index < registryEntries.length; index += 1) {
        const [hostKey, record] = registryEntries[index]!
        try {
          if (options.signal?.aborted) throwOpenCodeAbortReason(options.signal)
          options.startupBudget?.assertAvailable()
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          diagnostics.push(reason)
          for (const [remainingHostKey, remainingRecord] of registryEntries.slice(index)) {
            hosts.push({
              hostKey: remainingHostKey,
              projectPath: remainingRecord.projectPath,
              pid: remainingRecord.pid,
              port: remainingRecord.port,
              action: 'failed',
              reason,
              leaseCount: Object.keys(normalizePersistentHostLeases(remainingRecord.leases)).length,
            })
          }
          break
        }
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
          // Root absence alone cannot prove that an owned process tree is
          // empty. Retain the record so a later owned cleanup can report or
          // prove descendant exhaustion instead of certifying coverage.
          hosts.push({
            hostKey,
            projectPath: record.projectPath,
            pid: record.pid,
            port: record.port,
            action: 'failed',
            reason: 'registered host root is gone but descendant coverage is unproven',
            leaseCount,
          })
          continue
        }

        const processIdentity = await this.inspectPersistentHostProcessIdentity(
          record,
          requestContext,
        )
        if (processIdentity.state === 'gone' || processIdentity.state === 'changed') {
          hosts.push({
            hostKey,
            projectPath: record.projectPath,
            pid: record.pid,
            port: record.port,
            action: 'failed',
            reason: processIdentity.state === 'changed'
              ? 'registered host root was replaced and descendant coverage is unproven'
              : 'registered host root exited during identity verification; descendant coverage is unproven',
            leaseCount,
          })
          continue
        }
        if (processIdentity.state === 'unverified') {
          try {
            options.startupBudget?.assertAvailable()
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            diagnostics.push(`Failed to verify OpenCode host ${hostKey}: ${reason}`)
            hosts.push({ hostKey, projectPath: record.projectPath, pid: record.pid, port: record.port,
              action: 'failed', reason, leaseCount })
            continue
          }
          const health = await this.checkHealthyHostOnce(record.baseUrl, requestContext)
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
              requestContext,
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
          await this.terminatePersistentHostRecord(record, {
            force,
            startupBudget: options.startupBudget,
            signal: options.signal,
            remainingMs: requestContext.remainingMs,
          })
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
          this.assertPersistenceAuthority(requestContext)
          await unlink(registryPath).catch(() => undefined)
        } else {
          await this.writePersistentRegistryUnlocked(registry, requestContext)
        }
      }

      let staleTempCleanup: StaleTempCleanupResult | null = null
      if (options.reason === 'startup') {
        const activeProfileRootKeys = new Set(
          // A dead root without whole-tree proof is still an unresolved owner.
          // Keep its temp path protected until coverage is actually proven.
          Object.values(registry.hosts).map(record => record.profileRootKey),
        )
        staleTempCleanup = await this.cleanupStaleManagedProfileTempDylibs(
          activeProfileRootKeys,
          requestContext,
        )
        if (staleTempCleanup.removed > 0) {
          diagnostics.push(
            `Removed ${staleTempCleanup.removed} stale OpenCode profile temp dylib(s) (${staleTempCleanup.bytes} bytes)`,
          )
        }
        diagnostics.push(...staleTempCleanup.diagnostics)
      }

      const survivingPids = [...new Set(hosts
        .filter(host => host.pid > 0 && host.action !== 'disposed' && host.action !== 'removed_dead')
        .map(host => host.pid))]
      return {
        cleaned,
        remaining: Object.keys(registry.hosts).length,
        hosts,
        diagnostics,
        ...(options.reason === 'startup' ? {
          startupCleanup: {
            completion: pendingStartupTaskkillPids().length === 0 ? 'drained' as const : 'unknown' as const,
            coverage: survivingPids.length === 0 && staleTempCleanup?.unresolvedPaths.length === 0
              ? 'complete' as const
              : 'partial' as const,
            survivingPids,
            ...(staleTempCleanup?.unresolvedPaths.length
              ? {
                unresolvedPaths: staleTempCleanup.unresolvedPaths,
                cleanupDiagnostics: staleTempCleanup.diagnostics,
              }
              : {}),
          },
        } : {}),
      }
      }, {
        signal: options.signal,
        remainingMs: options.remainingMs ?? (options.startupBudget ? () => options.startupBudget!.remaining() : undefined),
        preserveCompletedCallbackAtDeadline: options.reason === 'startup',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (options.reason === 'startup' && (
        error instanceof PersistentRegistryLockContentionInterruptedError ||
        options.signal?.aborted ||
        (options.startupBudget?.remaining() ?? 1) <= 0
      )) {
        return this.startupRegistryLockFailureReceipt(error, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.startupBudget ? { remainingMs: () => options.startupBudget!.remaining() } : {}),
        })
      }
      throw error
    }
  }

  async releaseHost(
    hostKey: string,
    options: { keepPersistentAlive?: boolean; signal?: AbortSignal; remainingMs?: () => number } = {},
  ): Promise<void> {
    if (options.signal?.aborted) throwOpenCodeAbortReason(options.signal)
    if (options.remainingMs && options.remainingMs() <= 0) {
      throw new Error('OpenCode host release deadline exhausted')
    }
    if (this.custody) {
      const entry = this.#hosts.get(hostKey)
      if (!entry?.supervisor) return
      entry.refCount = Math.max(0, entry.refCount - 1)
      if (entry.refCount === 0 && entry.supervisor.leases.size === 0) this.#hosts.delete(hostKey)
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
        if (options.signal?.aborted) throwOpenCodeAbortReason(options.signal)
        if (options.remainingMs && options.remainingMs() <= 0) {
          throw new Error('OpenCode host release deadline exhausted')
        }
        if (registryRecord && Object.keys(normalizePersistentHostLeases(registryRecord.leases)).length > 0) {
          return
        }
      }
      if (entry.ownedByProcess) {
        await this.disposeHost(hostKey, options)
      } else {
        this.#hosts.delete(hostKey)
      }
    }
  }
}

export const openCodeHostManager = new OpenCodeHostManager()
