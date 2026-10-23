import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  isOpenCodeHostProcessGoneError,
  OpenCodeHostManager,
  OpenCodeHostProcessGoneError,
} from './OpenCodeHostManager.js'
import { executeOpenCodeBridgeCommandEnvelope } from './OpenCodeBridgeCommandHandler.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'
import { openCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { openCodeProvisioningProbe, OpenCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import { buildManagedConfigFingerprint } from './OpenCodeProfileManager.js'
import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import type { OpenCodeHostHandle, OpenCodePreparedProfile, OpenCodeSessionRecord } from './types.js'

const baseProfile: OpenCodePreparedProfile = {
  projectPath: '/tmp/project',
  canonicalProjectPath: '/tmp/project',
  workingDirectoryPath: '/tmp/project',
  scopeToken: null,
  profileRootKey: 'profile-root',
  profileRootPath: '/tmp/profile-root',
  projectBehaviorFingerprint: 'behavior-v1',
  behaviorSources: ['AGENTS.md', 'opencode.json'],
  managedConfig: {
    default_agent: 'teammate',
    share: 'disabled',
    autoupdate: false,
    snapshot: true,
  },
  managedConfigFingerprint: 'managed-config-v1',
  homePath: '/tmp/profile-root/home',
  tmpPath: '/tmp/profile-root/tmp',
  xdgConfigHome: '/tmp/profile-root/config',
  xdgDataHome: '/tmp/profile-root/data',
  xdgCacheHome: '/tmp/profile-root/cache',
  managedAuthPath: '/tmp/profile-root/data/opencode/auth.json',
  sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
  sourceAuthFingerprint: 'source-auth',
  managedAuthFingerprint: 'managed-auth',
  authState: 'ok',
  env: {},
}

const host: OpenCodeHostHandle = {
  hostKey: 'host-key',
  profileRootKey: 'profile-root',
  projectPath: '/tmp/project',
  projectBehaviorFingerprint: 'behavior-v1',
  baseUrl: 'http://127.0.0.1:4096',
  port: 4096,
  pid: 123,
  version: '1.4.0',
  state: 'healthy',
  profile: baseProfile,
  resolvedConfigFingerprint: 'resolved-fingerprint',
  diagnostics: [],
}

function buildRecord(overrides: Partial<OpenCodeSessionRecord> = {}): OpenCodeSessionRecord {
  return {
    teamId: 'team-a',
    laneId: 'primary',
    memberName: 'alice',
    providerId: 'opencode',
    selectedModel: 'openai/gpt-5.4-mini',
    projectPath: '/tmp/project',
    profileRootKey: 'profile-root',
    hostKey: 'host-key',
    profileScope: baseProfile.profileScope ?? null,
    resolvedBehaviorFingerprint: 'resolved-fingerprint',
    opencodeSessionId: 'session-1',
    lastCanonicalCursor: null,
    lastKnownRawStatus: null,
    lastKnownDurableState: null,
    sourceAuthFingerprint: 'source-auth',
    managedAuthFingerprint: 'managed-auth',
    projectBehaviorFingerprint: 'behavior-v1',
    staleReason: null,
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
    ...overrides,
  }
}


let isolatedRoot: string
let savedEnvironment: Record<string, string | undefined>
beforeEach(async () => {
  isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-stop-test-'))
  const overrides = {
    HOME: isolatedRoot,
    XDG_DATA_HOME: isolatedRoot,
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(isolatedRoot, 'data'),
    CLAUDE_MULTIMODEL_CACHE_HOME: path.join(isolatedRoot, 'cache'),
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: path.join(isolatedRoot, 'mcp.js'),
  }
  savedEnvironment = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
  Object.assign(process.env, overrides)
  await writeFile(overrides.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY, '')
  await mkdir(path.join(isolatedRoot, 'opencode'))
  await writeFile(path.join(isolatedRoot, 'opencode', 'auth.json'), JSON.stringify({ openai: { type: 'api', key: 'test-only-key' } }))
})
afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(isolatedRoot, { recursive: true, force: true })
})

// Only synthetic process identity and loopback responses; no runtime is launched.
test('existing-only host retention verifies identity and never spawns or cleans up rejected authorities', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-stop-existing-'))
  const registryPath = path.join(root, 'hosts.json')
  const profile = { ...baseProfile, projectPath: root, canonicalProjectPath: root, workingDirectoryPath: root }
  const record = {
    ...host, profile: undefined, projectPath: root,
    managedConfigFingerprint: profile.managedConfigFingerprint,
    resolvedConfigFingerprint: profile.managedConfigFingerprint,
    processStartedAtMs: 1000, updatedAt: new Date().toISOString(),
  }
  let spawned = 0
  let killed = 0
  try {
    for (const failure of ['none', 'missing', 'dead', 'reused', 'legacy', 'unhealthy', 'changed-during-health', 'foreign-config']) {
      let identityReads = 0
      const stored = { ...record,
        ...(failure === 'legacy' ? { processStartedAtMs: null } : {}),
        ...(failure === 'foreign-config' ? { managedConfigFingerprint: 'foreign' } : {}),
      }
      await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, processIdentityFormat: 'platform-native-v2', hosts: failure === 'missing' ? {} : { [host.hostKey]: stored } }))
      const before = await readFile(registryPath, 'utf8')
      const manager = new OpenCodeHostManager({
        persistentRegistryPath: registryPath,
        spawnHostProcess: () => { spawned++; throw new Error('must not spawn') },
        killProcess: () => { killed++ },
        isProcessAlive: () => failure !== 'dead',
        readProcessStartTimeMs: async () => {
          identityReads++
          return failure === 'reused' || (failure === 'changed-during-health' && identityReads > 1) ? 2000 : 1000
        },
        fetchJson: async url => {
          expect(url.endsWith('/global/health')).toBe(true)
          return { status: 200, data: { healthy: failure !== 'unhealthy' } }
        },
      })
      const acquire = () => manager.ensureHost({ projectPath: root, preparedProfile: profile, hostKey: host.hostKey, existingOnly: true })
      if (failure === 'none') {
        expect((await acquire()).pid).toBe(host.pid)
        expect((await acquire()).pid).toBe(host.pid) // cached path also rechecks identity
        await manager.releaseHost(host.hostKey, { keepPersistentAlive: true })
        await manager.releaseHost(host.hostKey, { keepPersistentAlive: true })
      } else {
        await expect(acquire()).rejects.toThrow('OpenCode existing host')
      }
      expect(await readFile(registryPath, 'utf8')).toBe(before)
    }
    expect(spawned).toBe(0)
    expect(killed).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('existing-only retention types a dead registered process as gone only on ESRCH proof', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-stop-gone-'))
  const registryPath = path.join(root, 'hosts.json')
  const profile = { ...baseProfile, projectPath: root, canonicalProjectPath: root, workingDirectoryPath: root }
  try {
    await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, processIdentityFormat: 'platform-native-v2',
      hosts: { [host.hostKey]: { ...host, profile: undefined, projectPath: root,
        managedConfigFingerprint: profile.managedConfigFingerprint,
        resolvedConfigFingerprint: profile.managedConfigFingerprint,
        processStartedAtMs: 1000, updatedAt: new Date().toISOString() } } }))
    // isProcessAlive=false is any failed signal, including EPERM on a live
    // process. Only the kernel's ESRCH may become closure evidence.
    for (const liveness of ['gone', 'unknown', 'alive'] as const) {
      const manager = new OpenCodeHostManager({
        persistentRegistryPath: registryPath,
        spawnHostProcess: () => { throw new Error('must not spawn') },
        killProcess: () => { throw new Error('must not kill') },
        isProcessAlive: () => false,
        inspectProcessLiveness: async () => liveness,
        readProcessStartTimeMs: async () => 1000,
        fetchJson: async () => { throw new Error('must not probe a dead host') },
      })
      let caught: unknown = null
      try {
        await manager.ensureHost({ projectPath: root, preparedProfile: profile, hostKey: host.hostKey, existingOnly: true })
      } catch (error) {
        caught = error
      }
      expect(isOpenCodeHostProcessGoneError(caught)).toBe(liveness === 'gone')
      if (liveness === 'gone') {
        expect((caught as Error).message).toBe('OpenCode existing host process is gone')
        expect((caught as { code?: string }).code).toBe('host_process_gone')
        expect((caught as OpenCodeHostProcessGoneError).pid).toBe(host.pid)
      } else {
        expect((caught as Error).message).toBe('OpenCode existing host process identity is unavailable or changed')
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('existing-only retention retries a transient identity read failure instead of rejecting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-stop-identity-retry-'))
  const registryPath = path.join(root, 'hosts.json')
  const profile = { ...baseProfile, projectPath: root, canonicalProjectPath: root, workingDirectoryPath: root }
  let identityReads = 0
  try {
    await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, processIdentityFormat: 'platform-native-v2',
      hosts: { [host.hostKey]: { ...host, profile: undefined, projectPath: root,
        managedConfigFingerprint: profile.managedConfigFingerprint,
        resolvedConfigFingerprint: profile.managedConfigFingerprint,
        processStartedAtMs: 1000, updatedAt: new Date().toISOString() } } }))
    const manager = new OpenCodeHostManager({
      persistentRegistryPath: registryPath,
      spawnHostProcess: () => { throw new Error('must not spawn') },
      killProcess: () => { throw new Error('must not kill') },
      isProcessAlive: () => true,
      readProcessStartTimeMs: async () => {
        identityReads += 1
        if (identityReads === 1) throw new Error('transient identity read failure')
        return 1000
      },
      sleepMs: async () => {},
      fetchJson: async () => ({ status: 200, data: { healthy: true, version: '1.4.0' } }),
    })
    const acquired = await manager.ensureHost({ projectPath: root, preparedProfile: profile, hostKey: host.hostKey, existingOnly: true })
    expect(acquired.pid).toBe(host.pid)
    expect(identityReads).toBeGreaterThanOrEqual(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Cursor Stop uses exact persisted ownership without fresh authority and repeats idempotently', async () => {
  const scope = {
    purpose: 'launch_runtime' as const, providerId: 'cursor-acp', scopeToken: 'test-scope',
    configFingerprint: 'config', selectedAuthIdentity: 'known:auth' as const,
  }
  const records = ['lead', 'Alice', 'Bob'].map(memberName => buildRecord({
    memberName, runId: 'run', selectedModel: 'cursor-acp/auto', toolApprovalMode: 'auto', profileScope: scope,
    runtimePid: host.pid, managedConfigFingerprint: baseProfile.managedConfigFingerprint,
    expectedBehaviorFingerprint: 'a'.repeat(64), resolvedBehaviorFingerprint: baseProfile.managedConfigFingerprint,
    staleReason: memberName === 'lead' ? 'managed_config_changed' : null,
  }))
  let current: OpenCodeSessionRecord | null = records[0]
  let processStartedAtMs = 1000
  let endpointCalls = 0
  let prepareCalls = 0
  let acquireCalls = 0
  let spawnCalls = 0
  let replaceDuringResolution: Partial<OpenCodeSessionRecord> | null = null
  const aborted: string[] = []
  const registryPath = path.join(isolatedRoot, 'cursor-owned-hosts.json')
  const now = new Date().toISOString()
  const leases = Object.fromEntries(records.map(record => {
    const leaseKey = `${record.teamId}::${record.laneId}::${record.memberName}`
    return [leaseKey, { leaseKey, teamId: record.teamId, laneId: record.laneId,
      memberName: record.memberName, runId: record.runId, sessionId: record.opencodeSessionId,
      createdAt: now, updatedAt: now }]
  }))
  await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, processIdentityFormat: 'platform-native-v2',
    hosts: { [host.hostKey]: { ...host, profile: undefined,
      managedConfigFingerprint: baseProfile.managedConfigFingerprint,
      processStartedAtMs, updatedAt: now, leases } } }))
  const before = await readFile(registryPath, 'utf8')
  const prepareProfile = async (): Promise<OpenCodePreparedProfile> => {
    prepareCalls++
    throw new Error('Cursor signed out/assets missing/config changed')
  }
  const manager = new OpenCodeHostManager({
    persistentRegistryPath: registryPath, prepareProfile,
    isProcessAlive: () => true,
    readProcessStartTimeMs: async pid => { expect(pid).toBe(host.pid); return processStartedAtMs },
    spawnHostProcess: () => { spawnCalls++; throw new Error('must not spawn') },
    killProcess: () => { throw new Error('must not kill') },
    fetchJson: async () => { throw new Error('must not probe fresh authority') },
  })
  const bridge = new OpenCodeSessionBridge({
    prepareProfile,
    hostManager: {
      ensureHost: async () => { acquireCalls++; throw new Error('must not acquire') },
      releaseHost: async () => { throw new Error('must not release an unacquired reference') },
      resolveOwnedSessionEndpoint: async (key, lease, signal) => {
        endpointCalls++
        const endpoint = await manager.resolveOwnedSessionEndpoint(key, lease, signal)
        if (replaceDuringResolution) current = { ...records[0], ...replaceDuringResolution }
        return endpoint
      },
    },
    sessionStore: { get: async () => current } as never,
    clientFactory: { create: (url: string) => {
      expect(url).toBe(host.baseUrl)
      return { abortSession: async (id: string) => { aborted.push(id); return true } }
    } } as never,
    mcpManager: { ensureAppMcp: async () => { throw new Error('MCP disconnected') } },
  })
  for (const record of records) { current = record; expect(await bridge.abort(record)).toBe(true) }
  expect(aborted).toEqual(records.map(record => record.opencodeSessionId))
  expect(endpointCalls).toBe(3)
  expect(records[0].staleReason).toBe('managed_config_changed')
  // Historical launch fingerprints cannot prevent cleanup of the same stored owner.
  for (const change of [
    { managedConfigFingerprint: 'rotated' }, { managedAuthFingerprint: 'rotated' },
    { projectBehaviorFingerprint: 'changed' }, { profileScope: { ...scope, scopeToken: 'foreign' } },
  ]) {
    current = { ...records[0], ...change }
    expect(await bridge.abort(current)).toBe(true)
  }
  expect(aborted).toHaveLength(7)
  const ownershipChanges = [
    { runId: 'replacement' }, { opencodeSessionId: 'replacement' },
    { hostKey: 'foreign' }, { projectPath: '/foreign' },
  ]
  for (const stoppedAt of [undefined, now]) {
    for (const change of ownershipChanges) {
      current = { ...records[0], ...change, stoppedAt }
      await expect(bridge.abort(records[0])).rejects.toThrow('ownership changed')
    }
  }
  current = null
  await expect(bridge.abort(records[0])).rejects.toThrow('ownership changed')
  current = { ...records[0], runId: undefined }
  await expect(bridge.abort(current)).rejects.toThrow('ownership changed')
  expect(endpointCalls).toBe(7)
  // Even matching session-store data cannot authorize a foreign persistent lease.
  for (const change of ownershipChanges) {
    current = { ...records[0], ...change }
    await expect(bridge.abort(current)).rejects.toThrow('host ownership is unavailable')
  }
  // Reused PID: the real resolver compares the persisted process start identity.
  current = records[0]
  processStartedAtMs = 2000
  await expect(bridge.abort(records[0])).rejects.toThrow('process ownership is unavailable')
  processStartedAtMs = 1000
  for (const change of [...ownershipChanges, { stoppedAt: now }]) {
    current = records[0]
    replaceDuringResolution = change
    await expect(bridge.abort(records[0])).rejects.toThrow('no longer active')
  }
  replaceDuringResolution = null
  const resolvedBeforeRepeat = endpointCalls
  current = { ...records[0], stoppedAt: now }
  expect(await bridge.abort(records[0])).toBe(true)
  expect(await bridge.abort(current)).toBe(true)
  expect(endpointCalls).toBe(resolvedBeforeRepeat)
  expect(aborted).toHaveLength(7)
  expect(prepareCalls).toBe(0)
  expect(acquireCalls).toBe(0)
  expect(spawnCalls).toBe(0)
  expect(await readFile(registryPath, 'utf8')).toBe(before)
})

test('new work still rejects stale selected authority and a replacement runtime PID', async () => {
  const scope = {
    purpose: 'launch_runtime' as const, providerId: 'openai', scopeToken: 'test-scope',
    configFingerprint: 'config', selectedAuthIdentity: 'known:auth' as const,
  }
  const profile = { ...baseProfile, profileScope: scope, scopeToken: scope.scopeToken }
  let current = buildRecord({ runId: 'run', toolApprovalMode: 'auto', profileScope: scope,
    runtimePid: host.pid, managedConfigFingerprint: profile.managedConfigFingerprint,
    expectedBehaviorFingerprint: 'a'.repeat(64), resolvedBehaviorFingerprint: profile.managedConfigFingerprint,
    staleReason: 'managed_config_changed' })
  let prepared = profile
  let acquired = 0
  let released = 0
  const bridge = new OpenCodeSessionBridge({
    prepareProfile: async () => prepared,
    hostManager: {
      ensureHost: async options => {
        expect(options?.existingOnly).toBe(true)
        acquired++
        return { ...host, profile, pid: host.pid + 1, resolvedConfigFingerprint: profile.managedConfigFingerprint }
      },
      releaseHost: async (_key, options) => { expect(options?.keepPersistentAlive).toBe(true); released++ },
    },
    sessionStore: { get: async () => current } as never,
    clientFactory: { create: () => { throw new Error('must not send new work') } } as never,
    mcpManager: { ensureAppMcp: async () => { throw new Error('must not attach MCP') } },
  })
  await expect(bridge.promptAsync(current, { text: 'must not send' })).rejects.toThrow('authority is stale')
  current = { ...current, staleReason: null }
  for (const change of [
    { managedConfigFingerprint: 'rotated' }, { managedAuthFingerprint: 'rotated' },
    { projectBehaviorFingerprint: 'changed' }, { profileScope: { ...scope, scopeToken: 'foreign' } },
  ]) {
    prepared = { ...profile, ...change }
    await expect(bridge.promptAsync(current, { text: 'must not send' })).rejects.toThrow('authority is stale')
  }
  expect(acquired).toBe(0)
  prepared = profile
  await expect(bridge.promptAsync(current, { text: 'must not bind replacement process' }))
    .rejects.toThrow(`runtime process changed (expected pid=${host.pid}, actual pid=${host.pid + 1})`)
  expect(acquired).toBe(1)
  expect(released).toBe(1)
})

test('existing-only acquisition honors cancellation during process and health verification without mutation', async () => {
  const registryPath = path.join(isolatedRoot, 'cancel-hosts.json')
  const profile = { ...baseProfile, projectPath: isolatedRoot, canonicalProjectPath: isolatedRoot, workingDirectoryPath: isolatedRoot }
  const record = {
    ...host, projectPath: isolatedRoot, managedConfigFingerprint: profile.managedConfigFingerprint,
    resolvedConfigFingerprint: profile.managedConfigFingerprint, processStartedAtMs: 1000,
    updatedAt: new Date().toISOString(),
  }
  await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, processIdentityFormat: 'platform-native-v2', hosts: { [host.hostKey]: record } }))
  const before = await readFile(registryPath, 'utf8')
  for (const phase of ['before', 'health', 'after']) {
    const controller = new AbortController()
    let reads = 0
    const stall = () => {
      controller.abort(new Error('stop deadline expired'))
      return new Promise<never>(() => {})
    }
    const manager = new OpenCodeHostManager({
      persistentRegistryPath: registryPath,
      spawnHostProcess: () => { throw new Error('must not spawn') },
      killProcess: () => { throw new Error('must not kill') },
      isProcessAlive: () => true,
      readProcessStartTimeMs: async () => {
        reads++
        return (phase === 'before' && reads === 1) || (phase === 'after' && reads === 2) ? stall() : 1000
      },
      fetchJson: async () => phase === 'health' ? stall() : { status: 200, data: { healthy: true } },
    })
    await expect(manager.ensureHost({ projectPath: isolatedRoot, preparedProfile: profile, hostKey: host.hostKey, existingOnly: true, abortSignal: controller.signal })).rejects.toThrow('stop deadline expired')
    expect(manager.getHost(host.hostKey)).toBeNull()
    expect(await readFile(registryPath, 'utf8')).toBe(before)
  }
})


for (const attachAppMcp of [false, true]) {
for (const wrongPid of [false, true]) {
test(`existing-session preflight MCP attach=${attachAppMcp}, wrong PID=${wrongPid}`, async () => {
  let prepared: OpenCodePreparedProfile
  let released = false
  let mcpCalls = 0
  let leaseCalls = 0
  const probe = new OpenCodeProvisioningProbe({
    inventoryService: { probe: async (_project, options) => {
      const scope = options?.profileScope!
      prepared = {
        ...baseProfile, projectPath: isolatedRoot, canonicalProjectPath: isolatedRoot,
        workingDirectoryPath: isolatedRoot, scopeToken: scope.scopeToken, profileScope: scope,
        selectedSourceAuthIdentity: scope.selectedAuthIdentity,
        selectedManagedAuthIdentity: scope.selectedAuthIdentity,
        managedConfigFingerprint: buildManagedConfigFingerprint(baseProfile.managedConfig, baseProfile.env),
      }
      return { detected: true, projectPath: isolatedRoot, profile: prepared, models: [], diagnostics: [] } as never
    } },
    hostManager: {
      ensureHost: async options => {
        expect(options?.hostKey).toBe(host.hostKey)
        expect(options?.existingOnly).toBe(true)
        return { ...host, pid: host.pid + (wrongPid ? 1 : 0), profile: prepared, projectPath: isolatedRoot, resolvedConfigFingerprint: prepared.managedConfigFingerprint }
      },
      releaseHost: async (_key, options) => { expect(options?.keepPersistentAlive).toBe(true); released = true },
      refreshResolvedConfigFingerprint: async () => { throw new Error('must not refresh authority') },
      retainHostLease: async () => { leaseCalls++ },
    },
    mcpManager: { ensureAppMcp: async options => {
      mcpCalls++
      expect(options.attachIfMissing).toBe(attachAppMcp)
      return { mcp: { 'agent-teams': { status: 'disconnected' } }, summary: {
        serverName: 'agent-teams', matchedServerName: 'agent-teams', status: 'present',
        connected: false, launchSource: null, availableServerNames: ['agent-teams'], diagnostics: [],
      } }
    } },
  })
  const pending = probe.probeRetainingHost(isolatedRoot, {
    selectedModel: 'openai/gpt-5.4-mini', toolApprovalMode: 'auto', existingHostKey: host.hostKey, expectedRuntimePid: host.pid, attachAppMcp,
  })
  if (wrongPid) {
    await expect(pending).rejects.toThrow('runtime process changed')
    expect(released).toBe(true)
    expect(mcpCalls).toBe(0)
    expect(leaseCalls).toBe(0)
    return
  }
  const result = await pending
  expect(result.host?.hostKey).toBe(host.hostKey)
  expect(Object.keys(result.snapshot.mcp ?? {})).toEqual(['agent-teams'])
  await result.release()
  expect(released).toBe(true)
})

}
}

for (const [command, requiredCommand] of [
  ['opencode.stopTeam', 'opencode.stopTeam'],
  ['opencode.handshake', 'opencode.stopTeam'],
  ['opencode.handshake', 'opencode.sendMessage'],
  ['opencode.handshake', 'opencode.reconcileTeam'],
]) {
for (const sameTick of [false, true]) {
test(`strict ${command}/${requiredCommand} preflight cancellation releases a retained host once (same tick: ${sameTick})`, async () => {
  const list = openCodeSessionStore.list
  const probe = openCodeProvisioningProbe.probeRetainingHost
  const abort = openCodeSessionBridge.abort
  let resolveProbe!: (value: Awaited<ReturnType<typeof probe>>) => void
  const pending = new Promise<Awaited<ReturnType<typeof probe>>>(resolve => { resolveProbe = resolve })
  let resolveReleased!: () => void
  const released = new Promise<void>(resolve => { resolveReleased = resolve })
  let releases = 0
  let effects = 0
  let probeStarted = false
  const controller = new AbortController()
  const retained = { snapshot: {} as never, host, release: async (keepAlive?: boolean) => {
    expect(keepAlive).toBe(true); releases++; resolveReleased()
  } }
  try {
    const record = buildRecord({ projectPath: isolatedRoot, runId: 'run', runtimePid: host.pid, toolApprovalMode: 'auto',
      profileScope: { purpose: 'launch_runtime', providerId: 'openai', scopeToken: 'scope',
        configFingerprint: 'config', selectedAuthIdentity: 'absent' } })
    openCodeSessionStore.list = async () => [record]
    openCodeProvisioningProbe.probeRetainingHost = async (_project, options) => {
      probeStarted = true
      expect(options?.existingHostKey).toBe(record.hostKey)
      expect(options?.expectedRuntimePid).toBe(record.runtimePid)
      if (sameTick) setTimeout(() => {
        resolveProbe(retained)
        controller.abort(new Error('cancelled after acquisition'))
      }, 0)
      return pending
    }
    openCodeSessionBridge.abort = async () => { effects++; return true }
    const started = performance.now()
    const result = await executeOpenCodeBridgeCommandEnvelope({
      schemaVersion: 1, requestId: 'test-stop-deadline', command,
      cwd: isolatedRoot, startedAt: new Date().toISOString(), timeoutMs: 100,
      body: { teamId: record.teamId, laneId: record.laneId, runId: record.runId,
        ...(command === 'opencode.handshake' ? { requiredCommand, expectedRunId: record.runId } : {}),
        expectedCapabilitySnapshotId: 'selected' },
    }, { signal: controller.signal })
    expect(probeStarted).toBe(true)
    expect(result.ok).toBe(false)
    if (!sameTick && 'error' in result) expect(result.error.kind).toBe('timeout')
    expect(performance.now() - started).toBeLessThan(1500)
    expect(effects).toBe(0)
    if (!sameTick) resolveProbe(retained)
    await released
    expect(releases).toBe(1)
    expect(effects).toBe(0)
  } finally {
    openCodeSessionStore.list = list
    openCodeProvisioningProbe.probeRetainingHost = probe
    openCodeSessionBridge.abort = abort
  }
})
}
}
