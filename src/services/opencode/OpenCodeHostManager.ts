import { createHash } from 'node:crypto'
import { type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import envPaths from 'env-paths'

import { sleep } from '../../utils/sleep.js'
import { killProcessTree } from '../../utils/processKill.js'
import { spawnPortableCli } from '../../utils/portableCli.js'
import { openCodeProfileManager } from './OpenCodeProfileManager.js'

import type { OpenCodeHostHandle, OpenCodePreparedProfile } from './types.js'

const OPEN_CODE_HOST_HEALTH_TIMEOUT_MS = 15_000
const OPEN_CODE_HOST_HEALTH_POLL_MS = 250
const OPEN_CODE_HOST_LEASE_REFRESH_INTERVAL_MS = 60_000

type ManagedHostEntry = {
  handle: OpenCodeHostHandle
  child: ChildProcess | null
  refCount: number
  ownedByProcess: boolean
}

type FetchJsonResult = {
  status: number
  data: unknown
}

type OpenCodeHostManagerDeps = {
  prepareProfile?: (projectPath?: string | null) => Promise<OpenCodePreparedProfile>
  allocateLoopbackPort?: () => Promise<number>
  fetchJson?: (url: string, init?: RequestInit) => Promise<FetchJsonResult>
  spawnHostProcess?: (profile: OpenCodePreparedProfile, port: number) => ChildProcess
  sleepMs?: (ms: number) => Promise<void>
  isProcessAlive?: (pid: number) => boolean
  killProcess?: (pid: number, signal: NodeJS.Signals) => void
  now?: () => Date
  persistentRegistryPath?: string | null
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
  version: string | null
  resolvedConfigFingerprint: string | null
  updatedAt: string
  leases?: Record<string, PersistentHostLeaseRecord>
}

type PersistentHostRegistryShape = {
  schemaVersion: 1
  hosts: Record<string, PersistentHostRegistryRecord>
}

export type OpenCodePersistentHostReconcileOptions = {
  mode?: 'stale' | 'force'
  reason?: 'startup' | 'shutdown' | 'manual' | string
  projectPath?: string | null
  staleAgeMs?: number | null
  leaseStaleAgeMs?: number | null
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

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex')
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
        JSON.stringify(left).localeCompare(JSON.stringify(right)))
    }
    return normalized
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const record = value as Record<string, unknown>
  return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
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

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<FetchJsonResult> {
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
  const paths = envPaths('claude-multimodel')
  return path.join(paths.data, 'opencode', 'host-registry.json')
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

function normalizePersistentHostLeases(
  value: unknown,
): Record<string, PersistentHostLeaseRecord> {
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
      typeof lease.teamId !== 'string'
      || typeof lease.laneId !== 'string'
      || typeof lease.memberName !== 'string'
      || typeof lease.createdAt !== 'string'
      || typeof lease.updatedAt !== 'string'
    ) {
      continue
    }
    const leaseKey = typeof lease.leaseKey === 'string' && lease.leaseKey.trim()
      ? lease.leaseKey
      : key
    leases[leaseKey] = {
      leaseKey,
      teamId: lease.teamId,
      laneId: lease.laneId,
      memberName: lease.memberName,
      runId: typeof lease.runId === 'string' && lease.runId.trim() ? lease.runId : null,
      sessionId: typeof lease.sessionId === 'string' && lease.sessionId.trim()
        ? lease.sessionId
        : null,
      createdAt: lease.createdAt,
      updatedAt: lease.updatedAt,
    }
  }
  return leases
}

export class OpenCodeHostManager {
  private readonly hosts = new Map<string, ManagedHostEntry>()
  private readonly pendingHosts = new Map<string, Promise<OpenCodeHostHandle>>()
  private readonly pendingRefCounts = new Map<string, number>()

  constructor(private readonly deps: OpenCodeHostManagerDeps = {}) {}

  private async prepareProfile(projectPath?: string | null): Promise<OpenCodePreparedProfile> {
    const prepareProfile = this.deps.prepareProfile
      ?? openCodeProfileManager.prepareProfile.bind(openCodeProfileManager)
    return prepareProfile(projectPath)
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<FetchJsonResult> {
    return (this.deps.fetchJson ?? fetchJson)(url, init)
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

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private async readPersistentRegistry(): Promise<PersistentHostRegistryShape> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return { schemaVersion: 1, hosts: {} }
    }

    try {
      const parsed = JSON.parse(await readFile(registryPath, 'utf8')) as Partial<PersistentHostRegistryShape>
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

  private async writePersistentRegistry(registry: PersistentHostRegistryShape): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }
    await mkdir(path.dirname(registryPath), { recursive: true })
    const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    await rename(tempPath, registryPath)
  }

  private async upsertPersistentHost(handle: OpenCodeHostHandle): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath || handle.pid <= 0) {
      return
    }
    const registry = await this.readPersistentRegistry()
    const previous = registry.hosts[handle.hostKey]
    registry.hosts[handle.hostKey] = {
      hostKey: handle.hostKey,
      profileRootKey: handle.profileRootKey,
      projectPath: handle.projectPath,
      projectBehaviorFingerprint: handle.projectBehaviorFingerprint,
      managedConfigFingerprint: handle.profile.managedConfigFingerprint,
      baseUrl: handle.baseUrl,
      port: handle.port,
      pid: handle.pid,
      version: handle.version,
      resolvedConfigFingerprint: handle.resolvedConfigFingerprint,
      updatedAt: this.nowIso(),
      leases: normalizePersistentHostLeases(previous?.leases),
    }
    await this.writePersistentRegistry(registry)
  }

  private async removePersistentHost(hostKey: string): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }
    const registry = await this.readPersistentRegistry()
    if (!registry.hosts[hostKey]) {
      return
    }
    delete registry.hosts[hostKey]
    if (Object.keys(registry.hosts).length === 0) {
      await unlink(registryPath).catch(() => undefined)
      return
    }
    await this.writePersistentRegistry(registry)
  }

  async retainHostLease(hostKey: string, input: OpenCodeHostLeaseInput): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }

    const leaseKey = buildLeaseKey(input)
    let registry = await this.readPersistentRegistry()
    let record = registry.hosts[hostKey]
    if (!record) {
      const entry = this.hosts.get(hostKey)
      if (!entry) {
        return
      }
      await this.upsertPersistentHost(entry.handle)
      registry = await this.readPersistentRegistry()
      record = registry.hosts[hostKey]
      if (!record) {
        return
      }
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
      previous
      && previous.runId === runId
      && previous.sessionId === sessionId
      && Number.isFinite(previousUpdatedAtMs)
      && nowMs - previousUpdatedAtMs < OPEN_CODE_HOST_LEASE_REFRESH_INTERVAL_MS
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
    await this.writePersistentRegistry(registry)
  }

  async releaseHostLease(hostKey: string, input: OpenCodeHostLeaseInput): Promise<void> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return
    }

    const leaseKey = buildLeaseKey(input)
    const registry = await this.readPersistentRegistry()
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
    await this.writePersistentRegistry(registry)
  }

  private async checkHealthyHostOnce(baseUrl: string): Promise<{ version: string | null } | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1_000)
    try {
      const result = await this.fetchJson(`${baseUrl}/global/health`, {
        signal: controller.signal,
      })
      const data = result.data as { healthy?: boolean; version?: string }
      if (result.status === 200 && data?.healthy === true) {
        return {
          version: typeof data.version === 'string' ? data.version : null,
        }
      }
      return null
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  private async adoptPersistentHost(
    hostKey: string,
    profile: OpenCodePreparedProfile,
  ): Promise<OpenCodeHostHandle | null> {
    const record = (await this.readPersistentRegistry()).hosts[hostKey]
    if (!record) {
      return null
    }
    if (
      record.projectPath !== profile.projectPath
      || record.profileRootKey !== profile.profileRootKey
      || record.projectBehaviorFingerprint !== profile.projectBehaviorFingerprint
      || record.managedConfigFingerprint !== profile.managedConfigFingerprint
      || !this.isProcessAlive(record.pid)
    ) {
      await this.removePersistentHost(hostKey).catch(() => undefined)
      return null
    }
    const health = await this.checkHealthyHostOnce(record.baseUrl)
    if (!health) {
      await this.removePersistentHost(hostKey).catch(() => undefined)
      return null
    }

    const handle: OpenCodeHostHandle = {
      hostKey,
      profileRootKey: record.profileRootKey,
      projectPath: record.projectPath,
      projectBehaviorFingerprint: record.projectBehaviorFingerprint,
      baseUrl: record.baseUrl,
      port: record.port,
      pid: record.pid,
      version: health.version ?? record.version,
      state: 'healthy',
      profile,
      resolvedConfigFingerprint: record.resolvedConfigFingerprint,
      diagnostics: [`adopted persistent OpenCode host pid=${record.pid}`],
    }
    handle.resolvedConfigFingerprint = await this.getResolvedConfigFingerprint(handle.baseUrl)
      ?? record.resolvedConfigFingerprint
    this.hosts.set(hostKey, {
      handle,
      child: null,
      refCount: this.pendingRefCounts.get(hostKey) ?? 1,
      ownedByProcess: false,
    })
    await this.upsertPersistentHost(handle).catch(() => undefined)
    return handle
  }

  private async waitForHealthyHost(baseUrl: string): Promise<{ version: string | null }> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < OPEN_CODE_HOST_HEALTH_TIMEOUT_MS) {
      try {
        const result = await this.fetchJson(`${baseUrl}/global/health`)
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
    }

    throw new Error(
      `OpenCode host did not become healthy within ${OPEN_CODE_HOST_HEALTH_TIMEOUT_MS}ms`,
    )
  }

  private async getResolvedConfigFingerprint(baseUrl: string): Promise<string | null> {
    try {
      const [config, configProviders, agents, mcp] = await Promise.all([
        this.fetchJson(`${baseUrl}/config`),
        this.fetchJson(`${baseUrl}/config/providers`),
        this.fetchJson(`${baseUrl}/agent`),
        this.fetchJson(`${baseUrl}/mcp`),
      ])

      const fingerprintSource = {
        config:
          config.status === 200
            ? normalizeResolvedFingerprintValue(config.data, 'config')
            : null,
        configProviders:
          configProviders.status === 200
            ? normalizeResolvedFingerprintValue(configProviders.data, 'configProviders')
            : null,
        agents:
          agents.status === 200
            ? normalizeResolvedFingerprintValue(agents.data, 'agents')
            : null,
        mcp:
          mcp.status === 200
            ? normalizeResolvedFingerprintValue(mcp.data, 'mcp')
            : null,
      }

      if (
        fingerprintSource.config === null
        && fingerprintSource.configProviders === null
        && fingerprintSource.agents === null
        && fingerprintSource.mcp === null
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
  ): ChildProcess {
    if (this.deps.spawnHostProcess) {
      return this.deps.spawnHostProcess(profile, port)
    }

    return spawnPortableCli(
      Bun.which('opencode') ?? 'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      {
        cwd: profile.projectPath,
        env: profile.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
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
      void this.removePersistentHost(hostKey).catch(() => undefined)
    })
  }

  private async createHost(
    hostKey: string,
    profile: OpenCodePreparedProfile,
  ): Promise<OpenCodeHostHandle> {
    const port = await this.allocateLoopbackPort()
    const baseUrl = `http://127.0.0.1:${port}`
    const child = this.spawnHost(profile, port)

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
    }
    this.hosts.set(hostKey, entry)
    this.bindHostLifecycle(hostKey, entry)

    try {
      const health = await this.waitForHealthyHost(baseUrl)
      handle.version = health.version
      handle.resolvedConfigFingerprint = await this.getResolvedConfigFingerprint(baseUrl)
      handle.state = 'healthy'
      await this.upsertPersistentHost(handle).catch(() => undefined)
      return handle
    } catch (error) {
      handle.state = 'degraded'
      diagnostics.push(error instanceof Error ? error.message : String(error))
      this.hosts.delete(hostKey)
      if (child.pid) {
        this.killProcess(child.pid, 'SIGTERM')
      } else {
        child.kill('SIGTERM')
      }
      throw error
    }
  }

  async ensureHost(params: {
    projectPath?: string | null
    hostKey?: string | null
  } = {}): Promise<OpenCodeHostHandle> {
    const profile = await this.prepareProfile(params.projectPath)
    const hostKey =
      params.hostKey?.trim()
      || `${profile.projectPath}::${profile.profileRootKey}::${profile.projectBehaviorFingerprint}::${profile.managedConfigFingerprint}`
    const existing = this.hosts.get(hostKey)
    if (existing && existing.handle.state === 'healthy') {
      existing.refCount += 1
      return existing.handle
    }

    const pending = this.pendingHosts.get(hostKey)
    if (pending) {
      const pendingEntry = this.hosts.get(hostKey)
      if (pendingEntry) {
        pendingEntry.refCount += 1
      } else {
        this.pendingRefCounts.set(hostKey, (this.pendingRefCounts.get(hostKey) ?? 0) + 1)
      }
      return pending
    }

    this.pendingRefCounts.set(hostKey, 1)
    const createPromise = (async () => {
      const adopted = await this.adoptPersistentHost(hostKey, profile)
      return adopted ?? this.createHost(hostKey, profile)
    })().finally(() => {
      this.pendingHosts.delete(hostKey)
      this.pendingRefCounts.delete(hostKey)
    })
    this.pendingHosts.set(hostKey, createPromise)
    return createPromise
  }

  getHost(hostKey: string): OpenCodeHostHandle | null {
    return this.hosts.get(hostKey)?.handle ?? null
  }

  async refreshResolvedConfigFingerprint(hostKey: string): Promise<string | null> {
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
    options: { force: boolean },
  ): Promise<void> {
    const entry = this.hosts.get(record.hostKey)
    const baseUrl = entry?.handle.baseUrl ?? record.baseUrl
    const pid = entry?.handle.pid ?? record.pid

    try {
      await this.fetchJson(`${baseUrl}/global/dispose`, {
        method: 'POST',
      })
    } catch {
      // Best effort.
    }

    if (entry?.child) {
      if (entry.child.pid) {
        this.killProcess(entry.child.pid, 'SIGTERM')
      } else {
        entry.child.kill('SIGTERM')
      }
    } else if (pid > 0 && this.isProcessAlive(pid)) {
      try {
        this.killProcess(pid, 'SIGTERM')
      } catch {
        // Best effort.
      }
    }

    if (options.force && pid > 0) {
      await this.sleepMs(250)
      if (this.isProcessAlive(pid)) {
        try {
          this.killProcess(pid, 'SIGKILL')
        } catch {
          // Best effort.
        }
      }
    }

    if (entry) {
      entry.handle.state = 'disposed'
    }
    this.hosts.delete(record.hostKey)
    this.pendingHosts.delete(record.hostKey)
  }

  async disposeHost(hostKey: string): Promise<boolean> {
    const entry = this.hosts.get(hostKey)
    if (!entry) {
      return false
    }

    await this.terminatePersistentHostRecord(
      {
        hostKey,
        profileRootKey: entry.handle.profileRootKey,
        projectPath: entry.handle.projectPath,
        projectBehaviorFingerprint: entry.handle.projectBehaviorFingerprint,
        baseUrl: entry.handle.baseUrl,
        port: entry.handle.port,
        pid: entry.handle.pid,
        version: entry.handle.version,
        resolvedConfigFingerprint: entry.handle.resolvedConfigFingerprint,
        updatedAt: this.nowIso(),
        leases: {},
      },
      { force: false },
    )
    await this.removePersistentHost(hostKey).catch(() => undefined)
    return true
  }

  async reconcilePersistentHosts(
    options: OpenCodePersistentHostReconcileOptions = {},
  ): Promise<OpenCodePersistentHostReconcileResult> {
    const registryPath = this.persistentRegistryPath
    if (!registryPath) {
      return {
        cleaned: 0,
        remaining: 0,
        hosts: [],
        diagnostics: ['OpenCode host registry is disabled'],
      }
    }

    const registry = await this.readPersistentRegistry()
    const hosts: OpenCodePersistentHostReconcileResult['hosts'] = []
    const diagnostics: string[] = []
    let cleaned = 0
    let changed = false
    const mode = options.mode ?? 'stale'
    const force = mode === 'force'
    const nowMs = this.now().getTime()

    for (const [hostKey, record] of Object.entries(registry.hosts)) {
      const leases = normalizePersistentHostLeases(record.leases)
      if (!force && typeof options.leaseStaleAgeMs === 'number' && options.leaseStaleAgeMs > 0) {
        let droppedStaleLeaseCount = 0
        for (const [leaseKey, lease] of Object.entries(leases)) {
          const updatedAtMs = Date.parse(lease.updatedAt)
          const ageMs = Number.isFinite(updatedAtMs)
            ? nowMs - updatedAtMs
            : Number.POSITIVE_INFINITY
          if (ageMs > options.leaseStaleAgeMs) {
            delete leases[leaseKey]
            droppedStaleLeaseCount += 1
          }
        }
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
      }
      const leaseCount = Object.keys(leases).length
      const entry = this.hosts.get(hostKey)
      const projectPath = options.projectPath?.trim()
      if (projectPath && record.projectPath !== projectPath) {
        hosts.push({
          hostKey,
          projectPath: record.projectPath,
          pid: record.pid,
          port: record.port,
          action: 'kept_filtered',
          reason: `project path does not match ${projectPath}`,
          leaseCount,
        })
        continue
      }

      if (!this.isProcessAlive(record.pid)) {
        delete registry.hosts[hostKey]
        cleaned += 1
        changed = true
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

      if (!force && typeof options.staleAgeMs === 'number' && options.staleAgeMs > 0) {
        const updatedAtMs = Date.parse(record.updatedAt)
        const ageMs = Number.isFinite(updatedAtMs) ? nowMs - updatedAtMs : Number.POSITIVE_INFINITY
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
        await this.writePersistentRegistry(registry)
      }
    }

    return {
      cleaned,
      remaining: Object.keys(registry.hosts).length,
      hosts,
      diagnostics,
    }
  }

  async releaseHost(hostKey: string): Promise<void> {
    const entry = this.hosts.get(hostKey)
    if (!entry) {
      return
    }

    entry.refCount = Math.max(0, entry.refCount - 1)
    if (entry.refCount === 0) {
      if (entry.ownedByProcess) {
        await this.disposeHost(hostKey)
      } else {
        this.hosts.delete(hostKey)
      }
    }
  }
}

export const openCodeHostManager = new OpenCodeHostManager()
