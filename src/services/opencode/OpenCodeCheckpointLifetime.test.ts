import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readProcessStartTimeMs } from '../../utils/processKill.js'
import { OpenCodeProfileManager, resolveOpenCodeProfileScope } from './OpenCodeProfileManager.js'
import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { OpenCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { readOpenCodeAuthCredential, upsertOpenCodeAuthCredential, type OpenCodeOAuthNativeSessionOwner } from './OpenCodeAuthStore.js'
import type { OpenCodePreparedProfile, OpenCodeSessionRecord } from './types.js'

const c0 = { type: 'oauth', access: 'TEST-C0', refresh: 'single-use-C0', expires: 1000, accountId: 'TEST' }
const c1 = { ...c0, access: 'TEST-C1', refresh: 'single-use-C1', expires: 500 }
const terminalMessages = (messageId: string) => [
  { info: { id: messageId, role: 'user' }, parts: [] },
  { info: { id: 'assistant', role: 'assistant', parentID: messageId, providerID: 'xai', modelID: 'grok-4.3', time: { completed: 1 } }, parts: [] },
]

describe('pending native OAuth session authority', () => {
  let root: string, project: string, global: string, registryPath: string, sessionPath: string
  let env: NodeJS.ProcessEnv, profile: OpenCodePreparedProfile, owner: OpenCodeOAuthNativeSessionOwner
  let registry: any, status: unknown, messages: any[], onRead: (() => Promise<void>) | undefined
  let abortAcknowledged: boolean, abortCalls: number, onAbort: (() => Promise<void>) | undefined
  let sessionStore: OpenCodeSessionStore, bridge: OpenCodeSessionBridge
  const manager = new OpenCodeProfileManager()
  const readSaved = () => manager.readSavedOAuthCredential(profile)
  const saveRegistry = () => writeFile(registryPath, JSON.stringify(registry))
  const resolve = () => resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3',
    purpose: 'launch_runtime', env, isOAuthNativeSessionSettled: value => bridge.isOwnedOAuthNativeSessionSettled(value),
    isOAuthNativeProbeSettled: value => new OpenCodeExecutionProbe({ clientFactory: { create: () => ({
      getSessionStatus: async () => ({ 'native-session': status }), getSessionMessages: async () => messages,
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
    abortAcknowledged = true; abortCalls = 0; onAbort = undefined
    bridge = new OpenCodeSessionBridge({
      hostManager: new OpenCodeHostManager({ persistentRegistryPath: registryPath }), sessionStore,
      clientFactory: { create: () => ({ getSessionStatus: async () => ({ 'native-session': status }),
        getSessionMessages: async () => { await onRead?.(); return messages }, abortSession: async () => { abortCalls += 1; await onAbort?.(); return abortAcknowledged } }) as never },
    })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test.each(['retained-control', 'exit-listener', 'force-stop'])('owned child exit preserves recovery lease evidence: %s', async mode => {
    const cleanup = mode !== 'retained-control'
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['-e', 'await Bun.stdin.text()'], { stdio: ['pipe', 'ignore', 'ignore'] })
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
    try {
      const birth = await readProcessStartTimeMs(child.pid!)
      expect(birth).toBeGreaterThan(0)
      owner = { ...owner, pid: child.pid!, processStartedAtMs: birth!, record: { ...owner.record, runtimePid: child.pid! } }
      await sessionStore.upsert(owner.record)
      Object.assign(registry.hosts[owner.record.hostKey], { pid: child.pid, processStartedAtMs: birth })
      await saveRegistry()
      await arm() // Successfully returns a pending admitted operation; no throw or crash before submission.
      await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
      const db = new Database(path.join(path.dirname(profile.managedAuthPath), 'opencode.db'))
      try {
        db.exec(`create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
          create table part (id text, message_id text, session_id text, time_created integer, time_updated integer, data text);
          create table session (id text, project_id text, directory text);
          create table project (id text, worktree text, vcs text);`)
        db.query('insert into session values (?, ?, ?)').run(owner.record.opencodeSessionId, 'project-TEST', project)
        db.query('insert into project values (?, ?, ?)').run('project-TEST', project, 'git')
        for (const [index, message] of terminalMessages(owner.messageId).entries()) {
          db.query('insert into message values (?, ?, ?, ?, ?)').run(message.info.id, owner.record.opencodeSessionId, index + 1, null, JSON.stringify(message.info))
        }
      } finally { db.close() }
      let removed: Promise<void> | undefined
      let lifecycleManager: any
      if (cleanup) {
        const hostManager: any = lifecycleManager = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
          fetchJson: async () => ({ status: 200, data: {} }) })
        const original = hostManager.removePersistentHost.bind(hostManager)
        hostManager.removePersistentHost = (...args: unknown[]) => { removed = original(...args); return removed }
        hostManager.cleanupOpenTuiTempArtifactsIfUnused = async () => {}
        const entry = { child, handle: { hostKey: owner.record.hostKey, state: 'healthy', diagnostics: [],
          pid: child.pid, processStartedAtMs: birth, profile, baseUrl: owner.baseUrl }, lifetime: 'persistent', ownedByProcess: true, refCount: 1 }
        hostManager.hosts.set(owner.record.hostKey, entry)
        hostManager.bindHostLifecycle(owner.record.hostKey, entry)
        await expect(hostManager.upsertPersistentHost({ ...entry.handle,
          processStartedAtMs: birth! + 1 })).rejects.toThrow('pending OAuth publication')
        expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey]).toEqual(
          registry.hosts[owner.record.hostKey])
      }
      if (mode === 'force-stop') {
        const stopped = await lifecycleManager.reconcilePersistentHosts({ mode: 'force', reason: 'shutdown' })
        expect(stopped.hosts[0].action).toBe('kept_pending_oauth')
        expect(stopped.hosts[0].reason).toContain('owned process stopped')
        await exited
        expect(child.signalCode).toBe('SIGTERM')
        expect(lifecycleManager.getHost(owner.record.hostKey)).toBeNull()
      } else {
        child.stdin.end()
        expect(await exited).toBe(0)
      }
      if (cleanup) { expect(removed).toBeDefined(); await removed }
      const fresh = () => resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env })
      expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey].leases).toEqual(
        registry.hosts[owner.record.hostKey].leases)
      if (cleanup) {
        const lease = { teamId: owner.record.teamId, laneId: owner.record.laneId,
          memberName: owner.record.memberName, runId: owner.record.runId, sessionId: owner.record.opencodeSessionId }
        expect(await lifecycleManager.releaseHostLeaseStrict(owner.record.hostKey, lease)).toBe(false)
        for (const mode of ['stale', 'force']) {
          const result = await lifecycleManager.reconcilePersistentHosts({ mode, leaseStaleAgeMs: 1 })
          expect(result.hosts[0].action).toBe('kept_pending_oauth')
          expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey]).toEqual(
            registry.hosts[owner.record.hostKey])
        }
      }
      await fresh()
      expect(await readSaved()).toEqual(c1)
      expect(await Bun.file(`${global}.agent-teams-xai-oauth-save.json`).exists()).toBe(false)
      if (cleanup) {
        await lifecycleManager.reconcilePersistentHosts({ mode: 'stale' })
        expect(await Bun.file(registryPath).exists()).toBe(false)
      }
    } finally { child.stdin.end(); await exited }
  })
})
