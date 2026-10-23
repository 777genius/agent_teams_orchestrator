import {
  readOpenCodeAuthority, requireOpenCodeAuthority, isKnownHostRegistry,
  normalizeKnownHostRegistry, normalizePersistentHostLeases, type PersistentHostRegistryShape,
  type PersistentHostRegistryRecord, type PersistentHostLeaseRecord,
} from './OpenCodeAuthorityStoreRead.js'
import { createHash, randomUUID } from 'node:crypto'
import { type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { Dirent } from 'node:fs'
import net from 'node:net'
import { mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as lockfile from '../../utils/lockfile.js'
import { withOpenCodeRegistryLockDiagnostics, type RegistryLockOperation } from './OpenCodeRegistryLockDiagnostics.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { sleep } from '../../utils/sleep.js'
import {
  hasPendingStartupTaskkill,
  pendingStartupTaskkill,
  pendingStartupTaskkillPids,
  killProcessTreeForStartup,
  killProcessTree,
  killProcessTreeAndWait,
  readProcessCommandLine,
  readProcessStartTimeMs,
} from '../../utils/processKill.js'
import { OpenCodeStartupCleanupBudget } from './OpenCodeStartupCleanupBudget.js'
import { reapCursorAgents, parseCursorAgentReapInput, type CursorAgentReapResult } from './OpenCodeCursorAgentAtomicReap.js'
import type { CursorAgentNativePorts } from './OpenCodeCursorAgentTreeKill.js'
import { readAttributionRecords } from './OpenCodeProcessAttributionStore.js'
import { spawnPortableCli } from '../../utils/portableCli.js'
import { OPEN_CODE_MANAGED_HOST_CONFIG_GENERATION, buildOpenCodeHostTransportIdentity, resolveOpenCodeBinaryHostIdentity } from './OpenCodeHostIdentity.js'
export { resolveOpenCodeBinaryHostIdentity } from './OpenCodeHostIdentity.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import { prewarmOpenCodeManagedSubscriptionPlugins } from './OpenCodeInventoryService.js'
import {
  assertOpenCodePreparedProfileScope,
  openCodeProfileManager,
} from './OpenCodeProfileManager.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import { ensureWindowsPrivateDirectories, hasWindowsPrivateProfileDirectoryDelivery } from './profile/OpenCodePrivateDirectories.js'
import {
  buildProcessAttributionSpawnEnv,
  mintProcessAttributionId,
  pruneStaleAttributionRecords,
  resolveProcessAttributionDirectory,
  retireHostAttributionRecords,
  writeHostAttributionRecord,
  type OpenCodeHostAttributionOwner,
} from './OpenCodeProcessAttributionStore.js'
import {
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
const OPEN_CODE_STALE_TEMP_DYLIB_AGE_MS = 24 * 60 * 60 * 1000
export const OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID = '__opencode_preflight__'
const OPEN_CODE_PREFLIGHT_HOST_LEASE_LANE_ID = 'preflight'
// Bun/OpenTUI temp dylib prefixes vary between builds (.bbb, .bbc, .b9dd, ...).
// Keep the match constrained to hidden hexadecimal dylibs inside the app-owned
// profile tmp directory so unrelated user files are never removed.
const OPENTUI_TEMP_DYLIB_RE = /^\.b[0-9a-f]+-[0-9a-f]+\.dylib$/i

export type OpenCodeHostLifetime = 'persistent' | 'process'


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

export function shouldRetryPersistentHostStartupLock(
  error: unknown,
  attempt: number,
  hasAbortSignal: boolean,
): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return code === 'ELOCKED'
    && (hasAbortSignal || attempt < PERSISTENT_HOST_STARTUP_LOCK_RETRIES)
}

type ManagedHostEntry = {
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
  prepareProfile?: (
    projectPath?: string | null,
    options?: OpenCodePrepareProfileOptions,
  ) => Promise<OpenCodePreparedProfile>
  allocateLoopbackPort?: () => Promise<number>
  fetchJson?: (url: string, init?: RequestInit) => Promise<FetchJsonResult>
  spawnHostProcess?: (profile: OpenCodePreparedProfile, port: number) => ChildProcess
  sleepMs?: (ms: number) => Promise<void>
  isProcessAlive?: (pid: number) => boolean
  inspectProcessLiveness?: (pid: number) => Promise<'alive' | 'gone' | 'unknown'>
  readProcessCommandLine?: (pid: number, timeoutMs?: number) => Promise<string | null>
  readProcessStartTimeMs?: (pid: number, timeoutMs?: number) => Promise<number | null>
  killProcess?: (pid: number, signal: NodeJS.Signals) => void
  now?: () => Date
  persistentRegistryPath?: string | null
  processAttributionDirectory?: string | null
  cursorAgentNativePorts?: Partial<CursorAgentNativePorts>
}

export type OpenCodeHostLeaseInput = {
  teamId: string
  laneId?: string | null
  memberName: string
  runId?: string | null
  sessionId?: string | null
}

type PersistentHostProcessIdentity = {
  state: 'confirmed' | 'gone' | 'changed' | 'unverified'
  startedAtMs: number | null
}

/** The registered host process is provably absent, not merely unreadable.
 * Stop-path callers may treat this as physical closure evidence; every other
 * identity failure stays fail-closed. */
export class OpenCodeHostProcessGoneError extends Error {
  readonly code = 'host_process_gone'
  constructor(readonly pid: number | null = null) {
    super('OpenCode existing host process is gone')
    this.name = 'OpenCodeHostProcessGoneError'
  }
}

export function isOpenCodeHostProcessGoneError(
  error: unknown,
): error is OpenCodeHostProcessGoneError {
  return error instanceof OpenCodeHostProcessGoneError
}

export type OpenCodePersistentHostReconcileOptions = {
  startupBudget?: OpenCodeStartupCleanupBudget
  mode?: 'stale' | 'force'
  reason?: 'startup' | 'shutdown' | 'manual' | string
  projectPath?: string | null
  staleAgeMs?: number | null
  leaseStaleAgeMs?: number | null
  preflightLeaseStaleAgeMs?: number | null
}

export type OpenCodePersistentHostReconcileResult = {
  startupCleanup?: {
    completion: 'drained' | 'unknown'
    coverage: 'complete' | 'partial'
    survivingPids: number[]
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
      | 'kept_pending_oauth'
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
      return normalized.sort((left, right) => {
        const leftJson = JSON.stringify(left)
        const rightJson = JSON.stringify(right)
        return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0
      })
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
  return `${teamId}::${laneId}::${memberName}`
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
    runId: null,
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
  options: {
    lifetime?: OpenCodeHostLifetime
    attributionId?: string | null
    attributionDirectory?: string | null
  } = {},
): SpawnOptions {
  const lifetime = options.lifetime ?? 'persistent'
  // Attribution belongs to this spawn, not to the profile: the host key is
  // derived from profile.env, so a per-spawn value there would fork the key.
  const attributionEnv = options.attributionId
    ? buildProcessAttributionSpawnEnv({
      directory: options.attributionDirectory ?? null,
      attributionId: options.attributionId,
    })
    : {}
  return {
    cwd: profile.workingDirectoryPath ?? profile.projectPath,
    env: Object.keys(attributionEnv).length > 0
      ? { ...profile.env, ...attributionEnv }
      : profile.env,
    detached: lifetime === 'persistent' || platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  }
}

/**
 * A caller-supplied host key skips key derivation entirely, so every identity the
 * derived key encodes has to be re-checked here. Readiness is the one that moves
 * on its own: the account can sign out while the host keeps running.
 */
export function assertOpenCodeHostReuseIdentity(
  explicitHostKey: string | undefined,
  profile: OpenCodePreparedProfile,
): void {
  if (!explicitHostKey) return
  if (profile.scopeToken && !explicitHostKey.includes(`::scope:${profile.scopeToken}::`)) {
    throw new Error('OpenCode host reuse rejected because the profile scope token changed')
  }
  const readiness = profile.env.AGENT_TEAMS_CURSOR_READINESS?.trim() || 'absent'
  const retainedReadiness = /::readiness:([^:]*)$/.exec(explicitHostKey)?.[1] || 'absent'
  if (readiness !== retainedReadiness) {
    throw new Error('OpenCode host reuse rejected because Cursor readiness changed')
  }
}

export function buildOpenCodeHostProfileIdentity(
  profile: OpenCodePreparedProfile,
  binaryHostIdentity: string,
): string {
  const authIdentity = profile.profileScope?.selectedAuthIdentity
    ?? profile.managedAuthFingerprint
    ?? 'absent'
  // Capability fingerprints intentionally omit MCP URLs/environment. Host reuse
  // must still bind to the current transport, including the app-instance marker.
  const transportIdentity = buildOpenCodeHostTransportIdentity(profile.managedConfig)
  // Cursor readiness is a live identity: the signed-in account, the real binary,
  // the staged assets and the retained proxy port. A running host outlives all of
  // them, so it has to be part of reuse or a signed-out account keeps serving.
  const readiness = profile.env.AGENT_TEAMS_CURSOR_READINESS ?? 'absent'
  return `${profile.projectPath}::${profile.profileRootKey}::${profile.projectBehaviorFingerprint}::${profile.managedConfigFingerprint}::auth:${authIdentity}::scope:${profile.scopeToken ?? 'unscoped'}::${OPEN_CODE_MANAGED_HOST_CONFIG_GENERATION}::binary:${binaryHostIdentity}::mcp:${transportIdentity}::readiness:${readiness}`
}

export class OpenCodeHostManager {
  private readonly startupLockReleases = new Set<Promise<void>>()
  private readonly pendingLifecycleCleanups = new Set<Promise<void>>()

  async drainStartupCleanupLockReleases(): Promise<void> {
    await Promise.all(this.startupLockReleases)
  }

  async drainPendingLifecycleCleanups(): Promise<void> {
    while (this.pendingLifecycleCleanups.size > 0) {
      await Promise.all(this.pendingLifecycleCleanups)
    }
  }

  private readonly hosts = new Map<string, ManagedHostEntry>()
  private readonly pendingHosts = new Map<string, Promise<OpenCodeHostHandle>>()
  private readonly pendingRefCounts = new Map<string, number>()
  private readonly pendingHostHealthTimeoutMs = new Map<string, number>()

  constructor(private readonly deps: OpenCodeHostManagerDeps = {}) {}

  private async prepareProfile(
    projectPath?: string | null,
    options?: OpenCodePrepareProfileOptions,
  ): Promise<OpenCodePreparedProfile> {
    const prepareProfile =
      this.deps.prepareProfile ?? openCodeProfileManager.prepareProfile.bind(openCodeProfileManager)
    return prepareProfile(projectPath, options)
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<FetchJsonResult> {
    return (this.deps.fetchJson ?? fetchJson)(url, init)
  }

  private async fetchJsonWithTimeout(
    url: string,
    timeoutMs: number,
    init?: RequestInit,
  ): Promise<FetchJsonResult> {
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

  /**
   * The runtime advertises resolveProcessAttributionDirectory() to the app as
   * the place it writes its records, so the process entry point resolves that
   * once and injects it rather than repeating the resolution here. A caller
   * that pins its own registry and no directory keeps its records beside that
   * registry, where only that caller prunes them.
   */
  private get processAttributionDirectory(): string | null {
    if (this.deps.processAttributionDirectory !== undefined) {
      return this.deps.processAttributionDirectory
    }
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return null
    }
    return path.join(path.dirname(registryPath), 'process-attribution')
  }

  private buildHostAttributionOwners(
    leases: Record<string, PersistentHostLeaseRecord>,
  ): OpenCodeHostAttributionOwner[] {
    return Object.values(leases).map(lease => ({
      teamId: lease.teamId,
      laneId: lease.laneId,
      memberName: lease.memberName,
      runId: lease.runId,
      sessionId: lease.sessionId,
      createdAt: lease.createdAt,
      updatedAt: lease.updatedAt,
    }))
  }

  /**
   * Attribution is evidence about a process tree, never authority over it: a
   * failed write leaves the app exactly as blind as it is today, so it must not
   * fail the operation that produced it.
   */
  private async syncHostAttributionRecord(
    record: PersistentHostRegistryRecord,
    leases: Record<string, PersistentHostLeaseRecord>,
  ): Promise<void> {
    const directory = this.processAttributionDirectory
    if (!directory || !record.attributionId) {
      return
    }
    await writeHostAttributionRecord({
      directory,
      attributionId: record.attributionId,
      hostPid: record.pid,
      hostStartedAtNative: record.processStartedAtMs ?? null,
      projectPath: record.projectPath,
      owners: this.buildHostAttributionOwners(leases),
      now: () => this.now(),
    }).catch(() => undefined)
  }

  /**
   * A host leaving the registry retires its records rather than deleting them:
   * the agent trees it spawned may outlive it, and their records - and the
   * host record naming the teams behind them - stay until the last of them is
   * gone. Only dead agent records go here.
   */
  private async retireHostAttributionRecords(
    attributionId: string | null | undefined,
  ): Promise<void> {
    const directory = this.processAttributionDirectory
    if (!directory || !attributionId) {
      return
    }
    await retireHostAttributionRecords(directory, attributionId, {
      now: () => this.now().getTime(),
      isProcessAlive: pid => this.isProcessAlive(pid),
      readProcessStartTimeMs: pid => this.readProcessStartTimeMs(pid),
    }).catch(() => undefined)
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

  private killProcess(pid: number, signal: NodeJS.Signals): void {
    if (this.deps.killProcess) {
      this.deps.killProcess(pid, signal)
      return
    }
    killProcessTree(pid, signal)
  }

  private async readProcessStartTimeMs(pid: number, budget?: OpenCodeStartupCleanupBudget): Promise<number | null> {
    if (this.deps.readProcessStartTimeMs) {
      return this.deps.readProcessStartTimeMs(pid, budget?.cap(6_000))
    }
    return readProcessStartTimeMs(pid, process.platform, budget?.cap(6_000))
  }

  private async readProcessCommandLine(pid: number, budget?: OpenCodeStartupCleanupBudget): Promise<string | null> {
    if (this.deps.readProcessCommandLine) {
      return this.deps.readProcessCommandLine(pid, budget?.cap(6_000))
    }
    return readProcessCommandLine(pid, process.platform, budget?.cap(6_000))
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
    budget?: OpenCodeStartupCleanupBudget,
  ): Promise<number> {
    if (!Number.isFinite(startedAtMs) || startedAtMs === null) {
      throw new Error(`OpenCode host pid ${record.pid} has no verifiable process start time`)
    }
    const startedAtMsBeforeProbe = await this.readProcessStartTimeMs(record.pid, budget).catch(() => null)
    if (startedAtMsBeforeProbe !== startedAtMs) {
      throw new Error(`OpenCode host pid ${record.pid} identity changed before legacy migration`)
    }
    const command = await this.readProcessCommandLine(record.pid, budget).catch(() => null)
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
    const currentFingerprint = await this.getResolvedConfigFingerprint(record.baseUrl, budget)
    if (!currentFingerprint || currentFingerprint !== record.resolvedConfigFingerprint) {
      throw new Error(
        `OpenCode host pid ${record.pid} resolved config fingerprint changed during migration`,
      )
    }
    const startedAtMsAfterProbe = await this.readProcessStartTimeMs(record.pid, budget).catch(() => null)
    if (startedAtMsAfterProbe !== startedAtMs) {
      throw new Error(`OpenCode host pid ${record.pid} identity changed during legacy migration`)
    }
    return startedAtMs
  }

  private async inspectPersistentHostProcessIdentity(
    record: PersistentHostRegistryRecord,
    budget?: OpenCodeStartupCleanupBudget,
  ): Promise<PersistentHostProcessIdentity> {
    if (!this.isProcessAlive(record.pid)) {
      return { state: 'gone', startedAtMs: null }
    }

    // A single failed OS read is not proof of an unverifiable process. Retry
    // briefly while the pid stays alive so a transient read failure cannot
    // reject an otherwise exact existing authority.
    let startedAtMs: number | null = null
    for (
      let attempt = 0;
      attempt < OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_ATTEMPTS;
      attempt += 1
    ) {
      startedAtMs = await this.readProcessStartTimeMs(record.pid, budget).catch(() => null)
      if (Number.isFinite(startedAtMs) && startedAtMs !== null) {
        break
      }
      if (!this.isProcessAlive(record.pid)) {
        return { state: 'gone', startedAtMs: null }
      }
      if (attempt + 1 < OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_ATTEMPTS) {
        await this.sleepMs(OPEN_CODE_HOST_PROCESS_IDENTITY_CAPTURE_RETRY_MS)
      }
    }
    if (!Number.isFinite(startedAtMs) || startedAtMs === null) {
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
    return killProcessTreeAndWait(pid, signal, { timeoutMs, expectedStartedAtMs })
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
    for (const entry of this.hosts.values()) {
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

  private async cleanupOpenTuiTempArtifactsIfUnused(tempPath: string, pid?: number): Promise<void> {
    if (typeof pid === 'number' && pid > 0 && this.isProcessAlive(pid)) {
      return
    }
    if (this.hasTrackedAliveHostUsingTempPath(tempPath, pid)) {
      return
    }
    await cleanupOpenTuiTempDylibs(tempPath).catch(() => undefined)
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
      const entries = await readdir(tmpPath, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !OPENTUI_TEMP_DYLIB_RE.test(entry.name)) {
          continue
        }
        const filePath = path.join(tmpPath, entry.name)
        const metadata = await stat(filePath).catch(() => null)
        if (!metadata || metadata.mtimeMs > staleBeforeMs) {
          continue
        }
        await unlink(filePath).catch(() => undefined)
        const stillExists = await stat(filePath).then(() => true).catch(() => false)
        if (!stillExists) {
          removed += 1
          bytes += metadata.size
        }
      }
    }

    return { removed, bytes }
  }

  private async readPersistentRegistryUnlocked(): Promise<PersistentHostRegistryShape> {
    if (!this.persistentRegistryPath) return { schemaVersion: 1, hosts: {} }
    const result = await readOpenCodeAuthority(this.persistentRegistryPath, isKnownHostRegistry)
    return normalizeKnownHostRegistry(requireOpenCodeAuthority(result, 'host', () => ({ schemaVersion: 1, hosts: {} })))
  }

  private async writePersistentRegistryUnlocked(
    registry: PersistentHostRegistryShape,
  ): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }
    await writeJsonFileAtomic(registryPath, {
      ...registry,
      processIdentityFormat: 'platform-native-v2',
    }, { indent: 2 })
  }

  private buildPersistentHostRecord(
    handle: OpenCodeHostHandle,
    previous?: PersistentHostRegistryRecord,
    newGeneration = false,
  ): PersistentHostRegistryRecord {
    const sameGeneration = previous?.pid === handle.pid
      && previous?.processStartedAtMs === handle.processStartedAtMs
      && previous?.attributionId === handle.attributionId
    return {
      ...previous,
      ...(newGeneration || (sameGeneration && previous?.cursorAgentReapContractVersion === 1)
        ? { cursorAgentReapContractVersion: 1 as const } : {}),
      hostKey: handle.hostKey,
      profileRootKey: handle.profileRootKey,
      projectPath: handle.projectPath,
      projectBehaviorFingerprint: handle.projectBehaviorFingerprint,
      managedConfigFingerprint: handle.profile.managedConfigFingerprint,
      baseUrl: handle.baseUrl,
      port: handle.port,
      pid: handle.pid,
      processStartedAtMs: handle.processStartedAtMs,
      attributionId: handle.attributionId ?? previous?.attributionId ?? null,
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
    if (path.relative(defaultPersistentRegistryPath(), path.resolve(registryPath)) === '' &&
      await hasWindowsPrivateProfileDirectoryDelivery()) {
      await ensureWindowsPrivateDirectories([resolveClaudeMultimodelPaths().data, path.dirname(registryPath)])
    }
    await mkdir(path.dirname(registryPath), { recursive: true, mode: 0o700 })
    const lockPath = `${registryPath}.lock`
    await writeFile(lockPath, '', { flag: 'a' })
    return lockPath
  }

  private async withPersistentRegistryLock<T>(operation: RegistryLockOperation, callback: () => Promise<T>, onCompromised?: (error: Error) => void): Promise<T> {
    const lockPath = await this.ensurePersistentRegistryLockFile()
    if (!lockPath) {
      return callback()
    }

    return withOpenCodeRegistryLockDiagnostics(operation, lockPath, () => lockfile.lock(lockPath,
      onCompromised ? { ...PERSISTENT_REGISTRY_LOCK_OPTIONS, onCompromised } : PERSISTENT_REGISTRY_LOCK_OPTIONS), callback)
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
    await mkdir(lockDir, { recursive: true, mode: 0o700 })
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
        if (!shouldRetryPersistentHostStartupLock(error, attempt, Boolean(abortSignal))) {
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

  private async tryAcquirePersistentHostStartupLock(
    hostKey: string,
  ): Promise<(() => Promise<void>) | null> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) return async () => {}
    const lockDir = path.join(path.dirname(registryPath), 'host-startup-locks')
    await mkdir(lockDir, { recursive: true, mode: 0o700 })
    const lockPath = path.join(lockDir, `${hashText(hostKey)}.lock`)
    await writeFile(lockPath, '', { flag: 'a' })
    try {
      return await lockfile.lock(lockPath, PERSISTENT_HOST_STARTUP_LOCK_OPTIONS)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code : undefined
      if (code === 'ELOCKED') return null
      throw error
    }
  }

  private async upsertPersistentHost(handle: OpenCodeHostHandle, newGeneration = false): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath || handle.pid <= 0) {
      return
    }
    await this.withPersistentRegistryLock('upsert_host', async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      const previous = registry.hosts[handle.hostKey]
      if (previous && await this.hasPendingOAuthHost(handle.hostKey)
        && (previous.pid !== handle.pid || previous.processStartedAtMs !== handle.processStartedAtMs)) {
        throw new Error('OpenCode host owns a pending OAuth publication')
      }
      if (!previous && !newGeneration) throw new Error('OpenCode persistent host record disappeared')
      const record = this.buildPersistentHostRecord(handle, previous, newGeneration)
      registry.hosts[handle.hostKey] = record
      await this.writePersistentRegistryUnlocked(registry)
      await this.syncHostAttributionRecord(record, normalizePersistentHostLeases(record.leases))
    })
  }

  // Registry lifetime follows the admitted OAuth operation, including ordinary
  // child exit and stale cleanup. This preserves evidence; it never grants
  // recovery authority when birth/run/session/lease comparisons fail.
  private async hasPendingOAuthHost(hostKey: string, lease?: OpenCodeHostLeaseInput): Promise<boolean> {
    if (!this.persistentRegistryPath) return false
    try {
      const receipt = JSON.parse(await readFile(path.join(path.dirname(this.persistentRegistryPath),
        'auth.json.agent-teams-xai-oauth-save.json'), 'utf8'))
      if (receipt?.version !== 1 || typeof receipt.operationId !== 'string'
        || !receipt.owner || !('successor' in receipt)) {
        throw new Error('OpenCode pending OAuth cleanup owner is invalid')
      }
      if (lease) {
        const owner = receipt.nativeSession?.record
        return owner?.hostKey === hostKey && owner.teamId === lease.teamId
          && owner.laneId === (lease.laneId?.trim() || 'primary') && owner.memberName === lease.memberName
          && owner.runId === lease.runId && owner.opencodeSessionId === lease.sessionId
      }
      return receipt.nativeSession?.record?.hostKey === hostKey
        || receipt.nativeProbe?.hostKey === hostKey
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
      throw error // Corrupt/unreadable ownership must not authorize cleanup.
    }
  }

  private async removePersistentHost(
    hostKey: string,
    expectedIdentity?: { pid: number; startedAtMs: number | null | undefined },
  ): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }
    await this.withPersistentRegistryLock('remove_host', async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      const record = registry.hosts[hostKey]
      if (!record
        || (expectedIdentity && (record.pid !== expectedIdentity.pid
          || record.processStartedAtMs !== expectedIdentity.startedAtMs))) {
        return
      }
      if (await this.hasPendingOAuthHost(hostKey)) return
      delete registry.hosts[hostKey]
      await this.retireHostAttributionRecords(record.attributionId)
      if (Object.keys(registry.hosts).length === 0 && Object.keys(registry).every(key => ['schemaVersion', 'processIdentityFormat', 'hosts'].includes(key))) {
        await unlink(registryPath).catch(() => undefined)
        return
      }
      await this.writePersistentRegistryUnlocked(registry)
    })
  }

  /** Cleanup resolves only an existing exact lease. No profile, status probe,
   * asset verification, host spawn, or arbitrary caller-supplied endpoint. */
  async resolveOwnedSessionEndpoint(
    hostKey: string,
    input: OpenCodeHostLeaseInput & { projectPath: string; expectedProcessStartedAtMs?: number },
    abortSignal?: AbortSignal,
  ): Promise<{ baseUrl: string; pid: number }> {
    if (abortSignal?.aborted) throwOpenCodeAbortReason(abortSignal)
    if (!input.runId || !input.sessionId) throw new Error('OpenCode cleanup requires exact run and session')
    const readQualifiedOwner = async () => {
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
      // Registry metadata is not permission to contact a remote/arbitrary URL.
      if (!Number.isSafeInteger(record.port) || record.port <= 0 || record.port > 65535
        || record.baseUrl !== `http://127.0.0.1:${record.port}`) {
        throw new Error('OpenCode cleanup endpoint is invalid')
      }
      return { record, lease }
    }
    const snapshot = await this.withPersistentRegistryLock('endpoint_snapshot', readQualifiedOwner)
    // OS inspection can take seconds. It must not hold the shared registry gate
    // while independent members are retaining or releasing their exact leases.
    if ((await raceOpenCodeAbortSignal(
      this.inspectPersistentHostProcessIdentity(snapshot.record), abortSignal,
    )).state !== 'confirmed') {
      throw new Error('OpenCode cleanup host process ownership is unavailable')
    }
    return this.withPersistentRegistryLock('endpoint_confirm', async () => {
      const current = await readQualifiedOwner()
      const identity = (value: typeof snapshot) => JSON.stringify({
        hostKey: value.record.hostKey, projectPath: value.record.projectPath,
        pid: value.record.pid, processStartedAtMs: value.record.processStartedAtMs,
        baseUrl: value.record.baseUrl, port: value.record.port,
        lease: { leaseKey: value.lease.leaseKey, teamId: value.lease.teamId,
          laneId: value.lease.laneId, memberName: value.lease.memberName,
          runId: value.lease.runId, sessionId: value.lease.sessionId, createdAt: value.lease.createdAt },
      })
      if (identity(current) !== identity(snapshot)) {
        throw new Error('OpenCode cleanup host ownership changed during process inspection')
      }
      if (abortSignal?.aborted) throwOpenCodeAbortReason(abortSignal)
      return { baseUrl: current.record.baseUrl, pid: current.record.pid }
    })
  }

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
      await this.withPersistentRegistryLock('cursor_reap', async () => {
        guard()
        const read = await readOpenCodeAuthority(registryPath, isKnownHostRegistry)
        if (read.kind === 'missing') { result.diagnostics.push('Registry missing'); return }
        const raw = requireOpenCodeAuthority(read, 'host', () => ({ schemaVersion: 1, hosts: {} }))
        guard()
        const records = await readAttributionRecords(directory)
        guard()
        await reapCursorAgents(input, raw, records, {
          deadline, guard, profileScope: process.env.CLAUDE_TEAM_APP_PROFILE_SCOPE,
          pendingOAuth: key => this.hasPendingOAuthHost(key),
          processLifetime: key => this.hosts.get(key)?.lifetime === 'process',
          native: this.deps.cursorAgentNativePorts,
        }, result)
        guard()
      }, error => { compromised = error })
    } catch (error) {
      result.status = 'incomplete'
      result.diagnostics.push(error instanceof Error ? error.message : String(error))
    }
    return result
  }

  /** A distinct durable lease protects delayed callbacks without inventing UI owners.
   * Pins use ordinary lease fields so existing normalizers and raw reapers retain
   * their veto. Only this wrapper removes pins, under the registry gate.
   */
  async withHostOperation<T>(
    host: Pick<OpenCodeHostHandle, 'hostKey' | 'pid' | 'processStartedAtMs' | 'baseUrl'>,
    owner: OpenCodeHostLeaseInput | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.hosts.get(host.hostKey)?.lifetime === 'process') return operation()
    if (!this.persistentRegistryPath) throw new Error('OpenCode operation registry is unavailable')
    const identity = { ...host }
    const input = owner ? { ...owner } : createOpenCodePreflightHostLeaseInput('operation')
    const ownerKey = buildLeaseKey(input)
    const pinKey = `${ownerKey}::operation:${randomUUID()}`
    const matchesHost = (record: PersistentHostRegistryRecord) =>
      record.hostKey === identity.hostKey && record.pid === identity.pid
      && record.processStartedAtMs === identity.processStartedAtMs
      && record.baseUrl === identity.baseUrl
    let original: PersistentHostLeaseRecord | undefined
    await this.withPersistentRegistryLock('operation_pin', async () => {
      const registry = await this.readPersistentRegistryUnlocked()
      const record = registry.hosts[identity.hostKey]
      if (!record || !matchesHost(record)) throw new Error('OpenCode operation host generation is unavailable')
      const leases = normalizePersistentHostLeases(record.leases)
      original = leases[ownerKey]
      if (owner && (!original || original.teamId !== input.teamId.trim()
        || original.laneId !== (input.laneId?.trim() || 'primary')
        || original.memberName !== input.memberName.trim()
        || original.runId !== (input.runId?.trim() || null)
        || original.sessionId !== (input.sessionId?.trim() || null))) {
        throw new Error('OpenCode operation session lease is unavailable')
      }
      const now = this.nowIso()
      leases[pinKey] = {
        leaseKey: pinKey, teamId: input.teamId.trim(),
        laneId: input.laneId?.trim() || 'primary', memberName: input.memberName.trim(),
        runId: input.runId?.trim() || null, sessionId: input.sessionId?.trim() || null,
        createdAt: now, updatedAt: now,
      }
      record.leases = leases
      await this.writePersistentRegistryUnlocked(registry)
    })
    let failed = true
    try {
      const result = await operation()
      failed = false
      return result
    } finally {
      await this.withPersistentRegistryLock('operation_unpin', async () => {
        const registry = await this.readPersistentRegistryUnlocked()
        const record = registry.hosts[identity.hostKey]
        // Missing/unreadable evidence cannot establish successful pin removal.
        if (!record) throw new Error('OpenCode operation completion registry is unavailable')
        const leases = normalizePersistentHostLeases(record.leases)
        const current = leases[ownerKey]
        const uncertain = failed || !matchesHost(record) || !leases[pinKey]
          || Boolean(owner && (!current || current.createdAt !== original?.createdAt
            || current.runId !== original?.runId || current.sessionId !== original?.sessionId))
        if (uncertain) {
          delete record.cursorAgentReapContractVersion
          // Persist revocation first. A failed second write leaves a vetoing pin.
          await this.writePersistentRegistryUnlocked(registry)
        }
        delete leases[pinKey]
        record.leases = leases
        await this.writePersistentRegistryUnlocked(registry)
      })
    }
  }

  async retainHostLease(hostKey: string, input: OpenCodeHostLeaseInput): Promise<void> {
    if (this.hosts.get(hostKey)?.lifetime === 'process') return
    const registryPath = this.persistentRegistryPath
    if (!registryPath) throw new Error('OpenCode persistent lease registry is unavailable')

    await this.withPersistentRegistryLock('retain_lease', async () => {
      const leaseKey = buildLeaseKey(input)
      const registry = await this.readPersistentRegistryUnlocked()
      const record = registry.hosts[hostKey]
      if (!record || record.hostKey !== hostKey) {
        throw new Error('OpenCode persistent host lease requires an existing registry record')
      }

      const nowDate = this.now()
      const now = nowDate.toISOString()
      const nowMs = nowDate.getTime()
      const leases = normalizePersistentHostLeases(record.leases)
      const previous = leases[leaseKey]
      const requestedRunId = input.runId?.trim() || null
      const requestedSessionId = input.sessionId?.trim() || null
      if ((previous?.runId && requestedRunId && previous.runId !== requestedRunId)
        || (previous?.sessionId && requestedSessionId
          && previous.sessionId !== requestedSessionId)) {
        throw new Error('OpenCode host lease belongs to a different run or session')
      }
      const runId = requestedRunId || previous?.runId || null
      const sessionId = requestedSessionId || previous?.sessionId || null
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
        ...previous,
        leaseKey,
        teamId: input.teamId.trim(),
        laneId: input.laneId?.trim() || 'primary',
        memberName: input.memberName.trim(),
        runId,
        sessionId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      }
      const updated = { ...record, leases, updatedAt: now }
      registry.hosts[hostKey] = updated
      await this.writePersistentRegistryUnlocked(registry)
      await this.syncHostAttributionRecord(updated, leases)
    })
  }

  async releaseHostLease(hostKey: string, input: OpenCodeHostLeaseInput): Promise<void> {
    await this.releaseHostLeaseExact(hostKey, input, false)
  }

  async releaseHostLeaseStrict(hostKey: string, input: OpenCodeHostLeaseInput): Promise<boolean> {
    return this.releaseHostLeaseExact(hostKey, input, true)
  }

  private async releaseHostLeaseExact(
    hostKey: string,
    input: OpenCodeHostLeaseInput,
    strict: boolean,
  ): Promise<boolean> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return false
    }

    return this.withPersistentRegistryLock('release_lease', async () => {
      const leaseKey = buildLeaseKey(input)
      const registry = await this.readPersistentRegistryUnlocked()
      const record = registry.hosts[hostKey]
      if (!record) {
        return false
      }
      const leases = normalizePersistentHostLeases(record.leases)
      const lease = leases[leaseKey]
      if (!lease) return false
      const expectedRunId = input.runId?.trim()
      const expectedSessionId = input.sessionId?.trim()
      if (strict && (!expectedRunId || !expectedSessionId
        || lease.runId !== expectedRunId || lease.sessionId !== expectedSessionId)) return false
      // Every persisted identity field must be qualified independently. A
      // caller supplying only one identity cannot release a lease qualified by both.
      if ((lease.runId && (!expectedRunId || lease.runId !== expectedRunId))
        || (lease.sessionId && (!expectedSessionId || lease.sessionId !== expectedSessionId))) return false
      if (await this.hasPendingOAuthHost(hostKey, input)) return false
      // Releasing and then restoring an identical session must not erase the
      // fact that Stop overlapped a delayed operation. Revocation is monotonic.
      if (Object.keys(leases).some(key => key.startsWith(`${leaseKey}::operation:`))) {
        delete record.cursorAgentReapContractVersion
      }
      delete leases[leaseKey]
      const updated = { ...record, leases, updatedAt: this.nowIso() }
      registry.hosts[hostKey] = updated
      await this.writePersistentRegistryUnlocked(registry)
      // Releasing the last lease leaves the host process running and registered
      // - preflight probes retain and release a lease around every run - so the
      // record is rewritten rather than deleted: the released lease moves to
      // its released owners, which is what still names the team behind an
      // agent tree that outlives the lane. Only a host leaving the registry
      // retires its records, and even that keeps them while such a tree lives.
      await this.syncHostAttributionRecord(updated, leases)
      return true
    })
  }

  private async checkHealthyHostOnce(baseUrl: string, budget?: OpenCodeStartupCleanupBudget): Promise<{ version: string | null } | null> {
    try {
      const result = await this.fetchJsonWithTimeout(
        `${baseUrl}/global/health`,
        budget?.cap(OPEN_CODE_HOST_HEALTH_REQUEST_TIMEOUT_MS) ?? OPEN_CODE_HOST_HEALTH_REQUEST_TIMEOUT_MS,
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
    resolveConfigFingerprint: boolean,
  ): Promise<OpenCodeHostHandle | null> {
    const record = (await this.readPersistentRegistry()).hosts[hostKey]
    if (!record) {
      return null
    }
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

    const handle: OpenCodeHostHandle = {
      hostKey,
      profileRootKey: record.profileRootKey,
      projectPath: record.projectPath,
      projectBehaviorFingerprint: record.projectBehaviorFingerprint,
      baseUrl: record.baseUrl,
      port: record.port,
      pid: record.pid,
      processStartedAtMs,
      attributionId: record.attributionId ?? null,
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
    this.hosts.set(hostKey, {
      handle,
      child: null,
      refCount: this.pendingRefCounts.get(hostKey) ?? 1,
      ownedByProcess: false,
      lifetime: 'persistent',
    })
    await this.upsertPersistentHost(handle).catch(() => undefined)
    return handle
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

  private async getResolvedConfigFingerprint(baseUrl: string, budget?: OpenCodeStartupCleanupBudget): Promise<string | null> {
    try {
      const [config, configProviders, agents, mcp] = await Promise.all([
        this.fetchJsonWithTimeout(
          `${baseUrl}/config`,
          budget?.cap(OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS) ?? OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS,
        ),
        this.fetchJsonWithTimeout(
          `${baseUrl}/config/providers`,
          budget?.cap(OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS) ?? OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS,
        ),
        this.fetchJsonWithTimeout(
          `${baseUrl}/agent`,
          budget?.cap(OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS) ?? OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS,
        ),
        this.fetchJsonWithTimeout(
          `${baseUrl}/mcp`,
          budget?.cap(OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS) ?? OPEN_CODE_RESOLVED_CONFIG_FINGERPRINT_REQUEST_TIMEOUT_MS,
        ),
      ])

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

      if (
        fingerprintSource.config === null ||
        fingerprintSource.configProviders === null ||
        fingerprintSource.agents === null ||
        fingerprintSource.mcp === null
      ) {
        return null
      }
      return hashJson(fingerprintSource)
    } catch {
      return null
    }
  }

  private spawnHost(
    profile: OpenCodePreparedProfile,
    port: number,
    lifetime: OpenCodeHostLifetime,
    attributionId: string | null,
  ): ChildProcess {
    if (this.deps.spawnHostProcess) {
      return this.deps.spawnHostProcess(profile, port)
    }

    return spawnPortableCli(
      resolveOpenCodeBinaryPath() ?? 'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      buildOpenCodeHostSpawnOptions(profile, process.platform, {
        lifetime,
        attributionId,
        attributionDirectory: this.processAttributionDirectory,
      }),
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
      if (this.hosts.get(hostKey) !== entry) {
        return
      }

      if (entry.handle.state !== 'disposed') {
        entry.handle.state = 'degraded'
        pushDiagnostic(
          `process exited${typeof code === 'number' ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}`,
        )
      }

      this.hosts.delete(hostKey)
      this.pendingHosts.delete(hostKey)
      const cleanup = this.removePersistentHost(hostKey, {
        pid: entry.handle.pid,
        startedAtMs: entry.handle.processStartedAtMs,
      }).catch(() => undefined)
      this.pendingLifecycleCleanups.add(cleanup)
      void cleanup.finally(() => { this.pendingLifecycleCleanups.delete(cleanup) })
      void this.cleanupOpenTuiTempArtifactsIfUnused(
        entry.handle.profile.tmpPath,
        entry.handle.pid,
      ).catch(() => undefined)
    })
  }

  private async forceKillSpawnedHostProcess(child: ChildProcess): Promise<void> {
    const pid = child.pid
    try {
      if (pid) {
        if (await this.killProcessAndWait(pid, 'SIGTERM', OPEN_CODE_HOST_PROCESS_TERM_TIMEOUT_MS)) {
          return
        }
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      // Best effort.
    }

    if (!pid) {
      return
    }

    try {
      await this.killProcessAndWait(pid, 'SIGKILL', OPEN_CODE_HOST_PROCESS_KILL_TIMEOUT_MS)
    } catch {
      // Best effort.
    }
  }

  private async createHost(
    hostKey: string,
    profile: OpenCodePreparedProfile,
    lifetime: OpenCodeHostLifetime,
    resolveConfigFingerprint: boolean,
    abortSignal?: AbortSignal,
  ): Promise<OpenCodeHostHandle> {
    const port = await this.allocateLoopbackPort()
    const baseUrl = `http://127.0.0.1:${port}`
    await this.cleanupOpenTuiTempArtifactsIfUnused(profile.tmpPath).catch(() => undefined)
    // Minted before the spawn so every process below this host inherits it,
    // including the cursor-agent trees the runtime never sees.
    const attributionId = mintProcessAttributionId()
    const child = this.spawnHost(profile, port, lifetime, attributionId)

    const diagnostics: string[] = []
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
      baseUrl,
      port,
      pid: child.pid ?? -1,
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
    this.hosts.set(hostKey, entry)
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
      if (lifetime === 'persistent') {
        await this.upsertPersistentHost(handle, true)
      }
      return handle
    } catch (error) {
      handle.state = 'degraded'
      const message = error instanceof Error ? error.message : String(error)
      diagnostics.push(message)
      this.hosts.delete(hostKey)
      await this.forceKillSpawnedHostProcess(child)
      await this.cleanupOpenTuiTempArtifactsIfUnused(profile.tmpPath, child.pid)
      if (abortSignal?.aborted && abortSignal.reason instanceof Error) {
        throw abortSignal.reason
      }
      const diagnosticSuffix =
        diagnostics.length > 0 ? ` Diagnostics: ${diagnostics.join(' | ')}` : ''
      throw new Error(`${message}${diagnosticSuffix}`)
    }
  }

  // A new launch can retire an orphaned record only while startup of its old
  // exact host is excluded. A matching dead registry entry is removed only after
  // terminal CAS evidence; absence is never inferred from health or registry errors.
  async withConfirmedAbsentHostAuthority<T>(
    record: { hostKey: string; runtimePid?: number | null; expectedProcessStartedAtMs?: number
      expectedSession?: OpenCodeHostLeaseInput & { projectPath: string } },
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath || !record.hostKey.trim()
      || !Number.isSafeInteger(record.runtimePid) || (record.runtimePid ?? 0) <= 0) {
      throw new Error('OpenCode dead runtime recovery requires exact host and process authority')
    }
    return this.withPersistentHostStartupLock(record.hostKey, async () => {
      return this.withPersistentRegistryLock('absent_recovery', async () => {
        const registry = requireOpenCodeAuthority(await readOpenCodeAuthority(registryPath, isKnownHostRegistry),
          'host', () => ({ schemaVersion: 1, hosts: {} }))
        const hosts = registry.hosts
        const registered = hosts[record.hostKey]
        if (record.expectedProcessStartedAtMs !== undefined && (!registered || typeof registered !== 'object'
          || !('processStartedAtMs' in registered) || registered.processStartedAtMs !== record.expectedProcessStartedAtMs)) {
          throw new Error('OpenCode dead runtime recovery original process birth differs')
        }
        if (record.expectedSession) {
          const expected = record.expectedSession
          const host = registry.hosts[record.hostKey]
          const lease = host && normalizePersistentHostLeases(host.leases)[buildLeaseKey(expected)]
          if (!expected.runId || !expected.sessionId || host?.projectPath !== expected.projectPath
            || !lease || lease.teamId !== expected.teamId || lease.laneId !== (expected.laneId?.trim() || 'primary')
            || lease.memberName !== expected.memberName || lease.runId !== expected.runId || lease.sessionId !== expected.sessionId) {
            throw new Error('OpenCode dead runtime recovery session lease changed')
          }
        }
        if (Object.hasOwn(hosts, record.hostKey) && (!registered || typeof registered !== 'object'
          || !('pid' in registered) || registered.pid !== record.runtimePid
          || !('hostKey' in registered) || registered.hostKey !== record.hostKey
          || !('processStartedAtMs' in registered) || typeof registered.processStartedAtMs !== 'number'
          || !Number.isFinite(registered.processStartedAtMs) || registered.processStartedAtMs <= 0)) {
          throw new Error('OpenCode dead runtime recovery registry process identity differs or is unverified')
        }
        const assertAbsent = () => {
          if (this.hosts.has(record.hostKey)
            || this.pendingHosts.has(record.hostKey)) {
            throw new Error('OpenCode dead runtime recovery found existing host authority')
          }
        }
        assertAbsent()
        const inspect = async (): Promise<'alive' | 'gone' | 'unknown'> => {
          if (this.deps.inspectProcessLiveness) return this.deps.inspectProcessLiveness(record.runtimePid!)
          try {
            process.kill(record.runtimePid!, 0)
            return 'alive'
          } catch (error) {
            return error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'
              ? 'gone' : 'unknown'
          }
        }
        const liveness = await raceOpenCodeAbortSignal(inspect(), signal)
        if (liveness !== 'gone') throw new Error('OpenCode old runtime process is alive or unverified')
        assertAbsent()
        if (signal?.aborted) throwOpenCodeAbortReason(signal)
        const result = await operation()
        // The callback returns terminal CAS evidence. A rejected CAS leaves the
        // exact dead registry record and its leases intact for the winner.
        if (registered && result != null && result !== false && !await this.hasPendingOAuthHost(record.hostKey)) {
          delete registry.hosts[record.hostKey]
          await writeJsonFileAtomic(registryPath, registry, { indent: 2 })
        }
        return result
      })
    }, signal)
  }

  // Stop may retain an exact existing authority, but must never create, migrate,
  // dispose, or remove a host as a side effect of discovering that authority.
  private async retainExistingHost(
    hostKey: string,
    profile: OpenCodePreparedProfile,
    abortSignal?: AbortSignal,
  ): Promise<OpenCodeHostHandle> {
    return this.withPersistentHostStartupLock(hostKey, async () => {
      const cached = this.hosts.get(hostKey)
      const record = cached
        ? this.buildPersistentHostRecord(cached.handle)
        : (await this.readPersistentRegistry()).hosts[hostKey]
      if (!record || record.hostKey !== hostKey
        || record.projectPath !== profile.projectPath
        || record.profileRootKey !== profile.profileRootKey
        || record.projectBehaviorFingerprint !== profile.projectBehaviorFingerprint
        || record.managedConfigFingerprint !== profile.managedConfigFingerprint
        || record.resolvedConfigFingerprint !== profile.managedConfigFingerprint
        || !Number.isFinite(record.processStartedAtMs)
        || record.processStartedAtMs == null
        || (cached && cached.handle.state !== 'healthy')) {
        throw new Error('OpenCode existing host authority is unavailable or changed')
      }
      const before = await raceOpenCodeAbortSignal(this.inspectPersistentHostProcessIdentity(record), abortSignal)
      if (before.state === 'gone') {
        throw new OpenCodeHostProcessGoneError(record.pid)
      }
      if (before.state !== 'confirmed' || before.startedAtMs !== record.processStartedAtMs) {
        throw new Error('OpenCode existing host process identity is unavailable or changed')
      }
      const health = await raceOpenCodeAbortSignal(this.checkHealthyHostOnce(record.baseUrl), abortSignal)
      const after = await raceOpenCodeAbortSignal(this.inspectPersistentHostProcessIdentity(record), abortSignal)
      if (after.state === 'gone') {
        throw new OpenCodeHostProcessGoneError(record.pid)
      }
      if (!health || after.state !== 'confirmed' || after.startedAtMs !== record.processStartedAtMs) {
        throw new Error('OpenCode existing host is unhealthy or its process identity changed')
      }
      if (abortSignal?.aborted) throwOpenCodeAbortReason(abortSignal)
      if (cached) {
        // Another holder may release the entry while the bounded health probe runs.
        if (this.hosts.get(hostKey) !== cached || cached.handle.state !== 'healthy') {
          throw new Error('OpenCode existing host authority changed during acquisition')
        }
        cached.refCount += 1
        return cached.handle
      }
      const handle: OpenCodeHostHandle = {
        hostKey,
        profileRootKey: record.profileRootKey,
        projectPath: record.projectPath,
        projectBehaviorFingerprint: record.projectBehaviorFingerprint,
        baseUrl: record.baseUrl,
        port: record.port,
        pid: record.pid,
        processStartedAtMs: record.processStartedAtMs,
        version: health.version ?? record.version,
        state: 'healthy',
        profile,
        resolvedConfigFingerprint: record.resolvedConfigFingerprint,
        diagnostics: [`retained existing OpenCode host pid=${record.pid}`],
      }
      this.hosts.set(hostKey, {
        handle, child: null, refCount: 1, ownedByProcess: false, lifetime: 'persistent',
      })
      return handle
    }, abortSignal)
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
      prewarmManagedSubscriptionPlugins?: boolean
      existingOnly?: boolean
      abortSignal?: AbortSignal
    } = {},
  ): Promise<OpenCodeHostHandle> {
    if (params.abortSignal?.aborted) {
      throwOpenCodeAbortReason(params.abortSignal)
    }
    await this.withPersistentRegistryLock('ensure_read', async () => { await this.readPersistentRegistryUnlocked() })
    const profile = params.preparedProfile ?? await raceOpenCodeAbortSignal(
      this.prepareProfile(params.projectPath, {
        ...params.profileOptions,
        abortSignal: params.abortSignal,
      }),
      params.abortSignal,
    )
    await assertOpenCodePreparedProfileScope(profile, params.projectPath)
    if (params.existingOnly) {
      const hostKey = params.hostKey?.trim()
      if (!hostKey || (profile.scopeToken && !hostKey.includes(`::scope:${profile.scopeToken}::`))) {
        throw new Error('OpenCode existing host requires an exact matching scoped host key')
      }
      return this.retainExistingHost(hostKey, profile, params.abortSignal)
    }
    const binaryPath = resolveOpenCodeBinaryPath()
    const preparedBinaryIdentity = profile.env.AGENT_TEAMS_CURSOR_HOST_BINARY_IDENTITY
    const needsBinaryIdentity = Boolean(preparedBinaryIdentity) || !params.hostKey?.trim()
    const binaryHostIdentity = binaryPath && needsBinaryIdentity
      ? await raceOpenCodeAbortSignal(
          resolveOpenCodeBinaryHostIdentity(binaryPath),
          params.abortSignal,
        )
      : 'missing-binary'
    if (preparedBinaryIdentity && preparedBinaryIdentity !== binaryHostIdentity) {
      throw new Error('OpenCode binary changed after Cursor port generation preparation')
    }
    if (binaryPath && params.prewarmManagedSubscriptionPlugins !== false) {
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
      const baseHostKey = buildOpenCodeHostProfileIdentity(profile, binaryHostIdentity)
      return hostLifetime === 'process'
        ? `${baseHostKey}::process:${process.pid}:${randomUUID()}`
        : baseHostKey
    })()
    assertOpenCodeHostReuseIdentity(explicitHostKey, profile)
    const healthTimeoutMs = normalizeOpenCodeHostHealthTimeoutMs(params.healthTimeoutMs)
    const resolveConfigFingerprint = params.resolveConfigFingerprint !== false
    if (params.abortSignal?.aborted) {
      throwOpenCodeAbortReason(params.abortSignal)
    }
    const existing = this.hosts.get(hostKey)
    if (existing && !existing.ownedByProcess && (
      existing.handle.state === 'degraded'
      || (existing.handle.state === 'healthy' && !this.isProcessAlive(existing.handle.pid))
    )) {
      existing.handle.state = 'degraded'
      // Releases identify hosts by key, so old holders must drain before a
      // replacement can occupy that key and receive their late releases.
      if (existing.refCount > 0) {
        throw new Error(`OpenCode host pid ${existing.handle.pid} terminated while retained; release existing host references before retrying`)
      }
      this.hosts.delete(hostKey)
    }
    if (existing && existing.handle.state === 'healthy') {
      existing.refCount += 1
      return existing.handle
    }

    const pending = this.pendingHosts.get(hostKey)
    if (pending) {
      this.pendingHostHealthTimeoutMs.set(
        hostKey,
        Math.max(this.pendingHostHealthTimeoutMs.get(hostKey) ?? 0, healthTimeoutMs),
      )
      const handle = await raceOpenCodeAbortSignal(pending, params.abortSignal)
      const pendingEntry = this.hosts.get(hostKey)
      if (pendingEntry) {
        pendingEntry.refCount += 1
      }
      return handle
    }

    this.pendingRefCounts.set(hostKey, 1)
    this.pendingHostHealthTimeoutMs.set(hostKey, healthTimeoutMs)
    const createPromise = (async () => {
      return this.withPersistentHostStartupLock(hostKey, async () => {
        const adopted =
          hostLifetime === 'persistent'
            ? await this.adoptPersistentHost(hostKey, profile, resolveConfigFingerprint)
            : null
        return adopted ?? this.createHost(
          hostKey,
          profile,
          hostLifetime,
          resolveConfigFingerprint,
          params.abortSignal,
        )
      }, params.abortSignal)
    })().finally(() => {
      this.pendingHosts.delete(hostKey)
      this.pendingRefCounts.delete(hostKey)
      this.pendingHostHealthTimeoutMs.delete(hostKey)
    })
    this.pendingHosts.set(hostKey, createPromise)
    return createPromise
  }

  getHost(hostKey: string): OpenCodeHostHandle | null {
    return this.hosts.get(hostKey)?.handle ?? null
  }

  async refreshResolvedConfigFingerprint(hostKey: string): Promise<string | null> {
    await this.withPersistentRegistryLock('refresh_read', async () => { await this.readPersistentRegistryUnlocked() })
    const entry = this.hosts.get(hostKey)
    if (!entry) {
      return null
    }

    const fingerprint = await this.getResolvedConfigFingerprint(entry.handle.baseUrl)
    entry.handle.resolvedConfigFingerprint = fingerprint
    return fingerprint
  }

  private async terminatePersistentHostRecord(
    record: PersistentHostRegistryRecord,
    options: { force: boolean; startupBudget?: OpenCodeStartupCleanupBudget },
  ): Promise<void> {
    const entry = this.hosts.get(record.hostKey)
    const baseUrl = entry?.handle.baseUrl ?? record.baseUrl
    const pid = entry?.handle.pid ?? record.pid
    let terminated = false

    const processIdentity = await this.inspectPersistentHostProcessIdentity({
      ...record,
      processStartedAtMs: entry?.handle.processStartedAtMs ?? record.processStartedAtMs,
    }, options.startupBudget)
    options.startupBudget?.assertAvailable()
    if (processIdentity.state === 'gone') {
      terminated = true
    } else if (processIdentity.state !== 'confirmed') {
      throw new Error(
        processIdentity.state === 'changed'
          ? `OpenCode host pid ${pid} identity changed; refusing to terminate a reused pid`
          : `OpenCode host pid ${pid} identity could not be verified; refusing unsafe termination`,
      )
    }

    if (options.startupBudget && !terminated) {
      const result = await killProcessTreeForStartup(pid, processIdentity.startedAtMs!, options.startupBudget, {
        readIdentity: (target, timeoutMs) => this.deps.readProcessStartTimeMs
          ? this.deps.readProcessStartTimeMs(target, timeoutMs)
          : readProcessStartTimeMs(target, 'win32', timeoutMs),
        alive: target => this.isProcessAlive(target),
      })
      if (!result.helperTerminated || !result.rootGone || !result.treeKillSucceeded) {
        throw new Error(`Startup termination incomplete: helperTerminated=${result.helperTerminated}, rootGone=${result.rootGone}, treeKillSucceeded=${result.treeKillSucceeded}`)
      }
      terminated = true
    }

    if (!terminated) {
      try {
        await this.fetchJsonWithTimeout(
          `${baseUrl}/global/dispose`,
          OPEN_CODE_HOST_DISPOSE_TIMEOUT_MS,
          {
            method: 'POST',
          },
        )
      } catch {
        // Best effort.
      }
    }

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
    } else if (!terminated && entry?.child) {
      entry.child.kill('SIGTERM')
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
    this.hosts.delete(record.hostKey)
    this.pendingHosts.delete(record.hostKey)
    await this.cleanupOpenTuiTempArtifactsIfUnused(
      entry?.handle.profile.tmpPath ?? this.getPersistentProfileTmpPath(record.profileRootKey),
      pid,
    )
  }

  async disposeHost(hostKey: string): Promise<boolean> {
    await this.withPersistentRegistryLock('dispose_read', async () => { await this.readPersistentRegistryUnlocked() })
    const entry = this.hosts.get(hostKey)
    if (!entry) {
      return false
    }

    return this.withPersistentHostStartupLock(hostKey, async () => {
      return this.withPersistentRegistryLock('dispose_host', async () => {
        const registry = await this.readPersistentRegistryUnlocked()
        const persisted = registry.hosts[hostKey] ?? null
        if (persisted && Object.keys(normalizePersistentHostLeases(persisted.leases)).length > 0) {
          return false
        }
        const record = persisted ?? {
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
        }
        await this.terminatePersistentHostRecord(record, { force: true })
        // Delete only the exact record we terminated; a concurrent startup or
        // registry writer must not have its replacement removed.
        const current = (await this.readPersistentRegistryUnlocked()).hosts[hostKey]
        if (current && !await this.hasPendingOAuthHost(hostKey) && current.pid === record.pid
          && current.processStartedAtMs === record.processStartedAtMs) {
          const latest = await this.readPersistentRegistryUnlocked()
          delete latest.hosts[hostKey]
          if (Object.keys(latest.hosts).length === 0 && Object.keys(latest).every(key => ['schemaVersion', 'processIdentityFormat', 'hosts'].includes(key))) {
            await unlink(this.persistentRegistryPath!).catch(() => undefined)
          } else {
            await this.writePersistentRegistryUnlocked(latest)
          }
        }
        return true
      })
    })
  }

  async disposeUnregisteredOwnedHosts(): Promise<{
    disposed: number
    kept: number
    diagnostics: string[]
  }> {
    try {
      const registry = await this.readPersistentRegistry()
      let disposed = 0
      let kept = 0
      const diagnostics: string[] = []

      for (const [hostKey, entry] of Array.from(this.hosts.entries())) {
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
    } finally {
      // Child exit can start a registry acquisition during disposal. Drain it
      // even when the initial registry read fails, before the CLI may exit.
      await this.drainPendingLifecycleCleanups()
    }
  }

  async reconcilePersistentHosts(
    options: OpenCodePersistentHostReconcileOptions = {},
  ): Promise<OpenCodePersistentHostReconcileResult> {
    const budget = options.startupBudget
    budget?.assertAvailable()
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return {
        cleaned: 0,
        remaining: 0,
        hosts: [],
        diagnostics: ['OpenCode host registry is disabled'],
        ...(budget
          ? {
              startupCleanup: {
                completion: pendingStartupTaskkillPids().length
                  ? ('unknown' as const)
                  : ('drained' as const),
                coverage: 'partial' as const,
                survivingPids: pendingStartupTaskkillPids(),
              },
            }
          : {}),
      }
    }

    return (async () => {
      let registry = await this.withPersistentRegistryLock('reconcile_snapshot', () =>
        this.readPersistentRegistryUnlocked(),
      )
      const hosts: OpenCodePersistentHostReconcileResult['hosts'] = []
      const diagnostics: string[] = []
      let cleaned = 0
      const mode = options.mode ?? 'stale'
      const force = mode === 'force'
      const nowMs = this.now().getTime()
      const projectPathFilter = options.projectPath?.trim()
      const normalizedProjectPathFilter = projectPathFilter
        ? await normalizeProjectPathForComparison(projectPathFilter)
        : null

      const skipStartupRecord = (record: PersistentHostRegistryRecord, reserveMs = 0): boolean => {
        if (!budget) return false
        const reason = hasPendingStartupTaskkill(record.pid)
          ? 'Startup termination is still pending; retry must observe the existing operation'
          : budget.remaining() <= reserveMs
            ? 'Startup cleanup deadline exhausted'
            : null
        if (!reason) return false
        diagnostics.push(`Startup cleanup skipped ${record.hostKey}: ${reason}`)
        hosts.push({
          hostKey: record.hostKey,
          projectPath: record.projectPath,
          pid: record.pid,
          port: record.port,
          action: 'failed',
          reason,
          leaseCount: Object.keys(record.leases ?? {}).length,
        })
        return true
      }

      for (const [hostKey, observedRecord] of Object.entries(registry.hosts)) {
        if (skipStartupRecord(observedRecord, 1_000)) continue
        // Slow OS/HTTP qualification is observation, never registry authority.
        // A concurrent lease or generation change invalidates all of these results.
        const normalizedRecordProjectPath = normalizedProjectPathFilter
          ? await normalizeProjectPathForComparison(observedRecord.projectPath)
          : null
        const filtered = Boolean(
          normalizedProjectPathFilter &&
          normalizedRecordProjectPath !== normalizedProjectPathFilter,
        )
        const observedPendingOAuth = await this.hasPendingOAuthHost(hostKey)
        const observedIdentity =
          filtered || observedPendingOAuth
            ? null
            : await this.inspectPersistentHostProcessIdentity(observedRecord, budget)
        const observedHealth =
          observedIdentity?.state === 'unverified'
            ? await this.checkHealthyHostOnce(observedRecord.baseUrl, budget)
            : null
        let legacyBirth: number | undefined
        let legacyFailure: unknown
        if (observedIdentity?.state === 'unverified' && observedHealth) {
          try {
            legacyBirth = await this.verifyLegacyPersistentHostIdentity(
              observedRecord,
              observedIdentity.startedAtMs,
              budget,
            )
          } catch (error) {
            legacyFailure = error
          }
        }
        await this.withPersistentRegistryLock('reconcile_host', async () => {
          const currentRegistry = await this.readPersistentRegistryUnlocked()
          const record = currentRegistry.hosts[hostKey]
          if (!record || JSON.stringify(record) !== JSON.stringify(observedRecord)) {
            hosts.push({
              hostKey,
              projectPath: observedRecord.projectPath,
              pid: observedRecord.pid,
              port: observedRecord.port,
              action: 'kept_active',
              reason: 'host ownership changed during reconciliation qualification',
              leaseCount: Object.keys(record?.leases ?? {}).length,
            })
            return
          }
          registry = currentRegistry
          let changed = false
          try {
            if (skipStartupRecord(record, 1_000)) return
            const pendingOAuth = await this.hasPendingOAuthHost(hostKey)
            if (skipStartupRecord(record)) return
            const leases = normalizePersistentHostLeases(record.leases)
            let droppedStaleLeaseCount = 0
            const dropStaleLeases = (
              staleAgeMs: number | null | undefined,
              predicate: (lease: PersistentHostLeaseRecord) => boolean,
            ): number => {
              if (pendingOAuth || force || typeof staleAgeMs !== 'number' || staleAgeMs <= 0) {
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
              // Age-based reconciliation is not an explicit release by the owner.
              delete record.cursorAgentReapContractVersion
              registry.hosts[hostKey] = {
                ...record,
                leases,
                updatedAt: budget ? record.updatedAt : this.nowIso(),
              }
              record.leases = leases
              changed = true
              diagnostics.push(
                `Dropped ${droppedStaleLeaseCount} stale OpenCode host lease(s) for ${hostKey}`,
              )
            }
            const leaseCount = Object.keys(leases).length
            const entry = this.hosts.get(hostKey)
            if (skipStartupRecord(record)) return
            if (
              normalizedProjectPathFilter &&
              normalizedRecordProjectPath !== normalizedProjectPathFilter
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
              return
            }

            const releaseStartupLock = await this.tryAcquirePersistentHostStartupLock(hostKey)
            if (!releaseStartupLock) {
              hosts.push({
                hostKey,
                projectPath: record.projectPath,
                pid: record.pid,
                port: record.port,
                action: 'kept_active',
                reason: 'host startup or adoption is in progress',
                leaseCount,
              })
              return
            }

            try {
              if (skipStartupRecord(record)) return
              if (pendingOAuth) {
                // Retention is evidence lifetime, never a liveness assertion or a
                // veto of an explicit Stop. The normal identity-checked terminator
                // still refuses a reused/unverified PID; keep the original record
                // and leases even after a successful force stop.
                let reason =
                  'pending OAuth publication retains exact owner evidence; liveness not asserted'
                if (force) {
                  try {
                    await this.terminatePersistentHostRecord(record, {
                      force: true,
                      startupBudget: budget,
                    })
                    reason =
                      'owned process stopped; pending OAuth publication retains exact owner evidence'
                  } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    diagnostics.push(`Failed to stop pending OpenCode host ${hostKey}: ${message}`)
                    hosts.push({
                      hostKey,
                      projectPath: record.projectPath,
                      pid: record.pid,
                      port: record.port,
                      action: 'failed',
                      reason: message,
                      leaseCount,
                    })
                    return
                  }
                }
                hosts.push({
                  hostKey,
                  projectPath: record.projectPath,
                  pid: record.pid,
                  port: record.port,
                  action: 'kept_pending_oauth',
                  reason,
                  leaseCount,
                })
                return
              }
              if (!this.isProcessAlive(record.pid)) {
                delete registry.hosts[hostKey]
                await this.retireHostAttributionRecords(record.attributionId)
                cleaned += 1
                changed = true
                if (!budget)
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
                return
              }

              const processIdentity = observedIdentity
              if (!processIdentity) {
                hosts.push({
                  hostKey,
                  projectPath: record.projectPath,
                  pid: record.pid,
                  port: record.port,
                  action: 'kept_active',
                  reason: 'host qualification changed during reconciliation',
                  leaseCount,
                })
                return
              }
              if (skipStartupRecord(record)) return
              if (processIdentity.state === 'gone' || processIdentity.state === 'changed') {
                delete registry.hosts[hostKey]
                await this.retireHostAttributionRecords(record.attributionId)
                cleaned += 1
                changed = true
                if (!budget)
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
                  reason:
                    processIdentity.state === 'changed'
                      ? 'registered pid was reused by a different process'
                      : 'registered host process exited during identity verification',
                  leaseCount,
                })
                return
              }
              if (processIdentity.state === 'unverified') {
                const health = observedHealth
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
                  return
                }
                try {
                  if (legacyFailure) throw legacyFailure
                  if (legacyBirth === undefined)
                    throw new Error('OpenCode legacy host qualification unavailable')
                  const processStartedAtMs = legacyBirth
                  if (skipStartupRecord(record)) return
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
                  return
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
                return
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
                return
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
                  return
                }
              }

              try {
                await this.terminatePersistentHostRecord(record, { force, startupBudget: budget })
                delete registry.hosts[hostKey]
                await this.retireHostAttributionRecords(record.attributionId)
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
            } finally {
              const pending = budget && pendingStartupTaskkill(record.pid)
              if (pending) {
                const release = pending.then(() => releaseStartupLock()).catch(() => undefined)
                this.startupLockReleases.add(release)
                void release.then(() => this.startupLockReleases.delete(release))
              } else {
                await releaseStartupLock().catch(() => undefined)
              }
            }
          } finally {
            if (changed) {
              if (
                Object.keys(registry.hosts).length === 0 &&
                Object.keys(registry).every(key =>
                  ['schemaVersion', 'processIdentityFormat', 'hosts'].includes(key),
                )
              ) {
                await unlink(registryPath).catch(() => undefined)
              } else {
                await this.writePersistentRegistryUnlocked(registry)
              }
            }
          }
        })
      }

      registry = await this.readPersistentRegistry()

      if (options.reason === 'startup' && !budget) {
        await this.withPersistentRegistryLock('reconcile_artifacts', async () => {
          registry = await this.readPersistentRegistryUnlocked()
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

          const attributionDirectory = this.processAttributionDirectory
          if (attributionDirectory) {
            // A crashed or SIGKILLed process leaves its record behind. It is
            // identity, never liveness, so the runtime reaps what it wrote.
            const pruned = await pruneStaleAttributionRecords(attributionDirectory, {
              now: () => this.nowMs(),
              isProcessAlive: pid => this.isProcessAlive(pid),
              readProcessStartTimeMs: pid => this.readProcessStartTimeMs(pid),
            }).catch(error => {
              diagnostics.push(
                `Failed to prune OpenCode process attribution records: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              )
              return null
            })
            if (
              pruned &&
              (pruned.prunedHosts > 0 || pruned.prunedAgents > 0 || pruned.prunedCorrupt > 0)
            ) {
              diagnostics.push(
                `Pruned OpenCode process attribution records (hosts=${pruned.prunedHosts}, ` +
                  `agents=${pruned.prunedAgents}, corrupt=${pruned.prunedCorrupt})`,
              )
            }
          }
        })
      }

      return {
        cleaned,
        remaining: Object.keys(registry.hosts).length,
        hosts,
        diagnostics,
        ...(budget
          ? {
              startupCleanup: {
                completion:
                  pendingStartupTaskkillPids().length > 0
                    ? ('unknown' as const)
                    : ('drained' as const),
                coverage: hosts.some(
                  host => host.action === 'failed' || host.action === 'kept_active',
                )
                  ? ('partial' as const)
                  : ('complete' as const),
                survivingPids: [
                  ...new Set([
                    ...Object.values(registry.hosts).map(record => record.pid),
                    ...pendingStartupTaskkillPids(),
                  ]),
                ],
              },
            }
          : {}),
      }
    })()
  }

  async releaseHost(
    hostKey: string,
    options: { keepPersistentAlive?: boolean } = {},
  ): Promise<void> {
    await this.withPersistentRegistryLock('release_read', async () => { await this.readPersistentRegistryUnlocked() })
    const entry = this.hosts.get(hostKey)
    if (!entry) {
      return
    }

    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount === 0) {
      if (entry.lifetime === 'persistent' && options.keepPersistentAlive) {
        return
      }
      if (entry.ownedByProcess) {
        await this.disposeHost(hostKey)
      } else {
        this.hosts.delete(hostKey)
      }
    }
  }
}

export const openCodeHostManager = new OpenCodeHostManager({
  // The bridge advertises this same resolution to the app in its runtime
  // precondition snapshot; resolving it once here keeps the directory the
  // runtime writes to and the directory the app reads identical.
  processAttributionDirectory: resolveProcessAttributionDirectory(),
})
