import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readProcessStartTimeMs } from '../../../utils/processKill.js'
import { OpenCodeProfileManager, resolveOpenCodeProfileScope } from '../OpenCodeProfileManager.js'
import { OpenCodeSessionBridge } from '../OpenCodeSessionBridge.js'
import { OpenCodeExecutionProbe } from '../OpenCodeExecutionProbe.js'
import { OpenCodeClientFactory } from '../OpenCodeClientFactory.js'
import { OpenCodeHostManager } from '../OpenCodeHostManager.js'
import { OpenCodeSessionStore } from '../OpenCodeSessionStore.js'
import { readOpenCodeAuthCredential, upsertOpenCodeAuthCredential, type OpenCodeOAuthNativeSessionOwner } from '../OpenCodeAuthStore.js'
import type { OpenCodeHostHandle, OpenCodePreparedProfile, OpenCodeSessionRecord } from '../types.js'

const c0 = { type: 'oauth', access: 'TEST-C0', refresh: 'single-use-C0', expires: 1000, accountId: 'TEST' }
const c1 = { ...c0, access: 'TEST-C1', refresh: 'single-use-C1', expires: 500 }
const terminalMessages = (messageId: string) => [
  { info: { id: messageId, role: 'user' }, parts: [] },
  { info: { id: 'assistant', role: 'assistant', parentID: messageId, providerID: 'xai', modelID: 'grok-4.3', time: { completed: 1 } }, parts: [] },
]

describe('independent production Stop contract (setup adapted from existing pending suite)', () => {
  let root: string, project: string, global: string, registryPath: string, sessionPath: string
  let env: NodeJS.ProcessEnv, profile: OpenCodePreparedProfile, owner: OpenCodeOAuthNativeSessionOwner
  let registry: any, status: unknown, messages: any[], onRead: (() => Promise<void>) | undefined
  let readStatusMap: () => Promise<any>
  let abortAcknowledged: boolean, abortCalls: number, onAbort: (() => Promise<void>) | undefined
  let sessionStore: OpenCodeSessionStore, bridge: OpenCodeSessionBridge
  const manager = new OpenCodeProfileManager()
  const readSaved = () => manager.readSavedOAuthCredential(profile)
  const saveRegistry = () => writeFile(registryPath, JSON.stringify(registry))
  const resolve = () => resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3',
    purpose: 'launch_runtime', env, isOAuthNativeSessionSettled: value => bridge.isOwnedOAuthNativeSessionSettled(value),
    isOAuthNativeProbeSettled: value => new OpenCodeExecutionProbe({ clientFactory: { create: () => ({
      getSessionStatus: () => readStatusMap(), getSessionMessages: async () => { await onRead?.(); return messages },
    }) as never } }).isOwnedOAuthNativeProbeSettled(value) })
  const arm = (throwAfter = false) => manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
    operation: async armNative => {
      await armNative(owner)
      if (throwAfter) throw new Error('TEST uncertain HTTP outcome')
    }, isNativeSettled: () => false, allowNativeContinuation: true })
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-pending-native-TEST-')))
    project = path.join(root, 'project')
    await mkdir(project)
    env = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'cache'),
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:1/mcp' }
    global = path.join(root, 'app-data', 'opencode', 'auth.json')
    registryPath = path.join(path.dirname(global), 'host-registry.json')
    sessionPath = path.join(path.dirname(global), 'session-store.json')
    await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: c0 })
    profile = await manager.prepareProfile(project, { profileScope: await resolveOpenCodeProfileScope({
      projectPath: project, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env }) })
    const now = new Date().toISOString()
    const record: OpenCodeSessionRecord = { teamId: 'TEST', laneId: 'primary', memberName: 'owner',
      runId: 'run-1', providerId: 'opencode', selectedModel: 'xai/grok-4.3', projectPath: project,
      profileRootKey: profile.profileRootKey, hostKey: `host::scope:${profile.scopeToken}::TEST`,
      profileScope: profile.profileScope, runtimePid: process.pid, resolvedBehaviorFingerprint: 'TEST-behavior',
      opencodeSessionId: 'native-session', lastCanonicalCursor: null, lastKnownRawStatus: null,
      lastKnownDurableState: null, sourceAuthFingerprint: profile.sourceAuthFingerprint,
      managedAuthFingerprint: profile.managedAuthFingerprint, projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      managedConfigFingerprint: profile.managedConfigFingerprint, expectedBehaviorFingerprint: 'TEST-proof',
      staleReason: null, createdAt: now, updatedAt: now }
    const birth = await readProcessStartTimeMs(process.pid)
    expect(birth).toBeGreaterThan(0)
    owner = { record, baseUrl: 'http://127.0.0.1:43210', pid: process.pid, processStartedAtMs: birth!,
      messageId: 'msg-TEST', noReply: false }
    const leaseKey = 'TEST::primary::owner'
    registry = { schemaVersion: 1, processIdentityFormat: 'platform-native-v2', hosts: { [record.hostKey]: {
      ...record, baseUrl: owner.baseUrl, port: 43210, pid: owner.pid, processStartedAtMs: birth,
      version: 'TEST', resolvedConfigFingerprint: profile.managedConfigFingerprint,
      leases: { [leaseKey]: { leaseKey, teamId: record.teamId, laneId: record.laneId, memberName: record.memberName,
        runId: record.runId, sessionId: record.opencodeSessionId, createdAt: now, updatedAt: now } },
    } } }
    await saveRegistry()
    sessionStore = new OpenCodeSessionStore(sessionPath)
    await sessionStore.upsert(record)
    status = 'idle'; messages = []; onRead = undefined
    readStatusMap = async () => ({ 'native-session': status })
    abortAcknowledged = true; abortCalls = 0; onAbort = undefined
    bridge = new OpenCodeSessionBridge({
      hostManager: new OpenCodeHostManager({ persistentRegistryPath: registryPath,
        fetchJson: async () => { throw new Error('Synthetic Stop fixture must not contact HTTP') },
      }), sessionStore,
      clientFactory: { create: () => ({ getSessionStatus: () => readStatusMap(),
        getSessionMessages: async () => { await onRead?.(); return messages }, abortSession: async () => { abortCalls += 1; await onAbort?.(); return abortAcknowledged } }) as never },
    })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })


  test('F2 strict Stop must retain lease when abort rejects and source changes during abort', async () => {
    await arm()
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    messages = terminalMessages(owner.messageId).slice(0, 1)
    abortAcknowledged = false
    onAbort = () => writeFile(global, JSON.stringify({ xai: { ...c0, refresh: 'INDEPENDENT-NEW-LOGIN', accountId: 'INDEPENDENT-NEW-ACCOUNT' } }))
    let failure: unknown
    try { await bridge.releaseSession(owner.record, { strictLeaseRelease: true }) }
    catch (error) { failure = error }
    const persisted = JSON.parse(await readFile(registryPath, 'utf8'))
    const lease = persisted.hosts[owner.record.hostKey]?.leases?.['TEST::primary::owner']
    console.log(JSON.stringify({ abortCalls, abortAcknowledged, threw: !!failure, leaseRetained: !!lease,
      receiptRetained: await Bun.file(`${global}.agent-teams-xai-oauth-save.json`).exists() }))
    expect(abortCalls).toBe(1)
    expect(failure).toBeDefined()
    expect(lease).toBeDefined()
    expect(await Bun.file(`${global}.agent-teams-xai-oauth-save.json`).exists()).toBe(true)
  })
  for (const restore of [false, true]) test(`revoked strict Stop retains lease on retry then releases after terminal proof restore=${restore}`, async () => {
    await arm()
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    messages = terminalMessages(owner.messageId).slice(0, 1)
    abortAcknowledged = false
    onAbort = () => writeFile(global, JSON.stringify({ xai: { ...c0, refresh: 'new-login', accountId: 'new-account' } }))
    await expect(bridge.releaseSession(owner.record, { strictLeaseRelease: true })).rejects.toThrow()
    onAbort = undefined
    if (restore) await writeFile(global, JSON.stringify({ xai: c0 }))
    await expect(bridge.releaseSession(owner.record, { strictLeaseRelease: true })).rejects.toThrow()
    const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
    expect((await Bun.file(receiptPath).json()).publicationRevoked).toBe(true)
    expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey].leases['TEST::primary::owner']).toBeDefined()
    messages = terminalMessages(owner.messageId)
    await bridge.releaseSession(owner.record, { strictLeaseRelease: true })
    expect(await Bun.file(receiptPath).exists()).toBe(false)
    expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey]?.leases?.['TEST::primary::owner']).toBeUndefined()
    expect(await readOpenCodeAuthCredential({ authPath: profile.managedAuthPath, providerId: 'xai' })).toEqual(c1)
  })

})
