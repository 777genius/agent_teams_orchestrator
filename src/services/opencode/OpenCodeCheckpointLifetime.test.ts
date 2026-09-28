import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildExactProcessTreeSpawn, captureProcessTreeIdentity, isProcessAlive, readProcessStartTimeMs } from '../../utils/processKill.js'
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
    // Capture fixture identity before the lifetime behavior begins. A cold
    // Windows runner can exceed the production query budget during this setup;
    // subsequent ownership checks still use the unchanged production deadline.
    const birth = await readProcessStartTimeMs(process.pid, process.platform,
      process.platform === 'win32' ? 15_000 : undefined)
    expect(birth).toBeGreaterThan(0)
    owner = { record, baseUrl: 'http://127.0.0.1:43210', pid: process.pid, processStartedAtMs: birth!,
      messageId: 'msg-TEST', noReply: false }
    const leaseKey = `${record.teamId}::${record.laneId}::${record.memberName}::session:${record.opencodeSessionId}`
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

  test.each(['retained-control', 'exit-listener', 'force-stop', 'force-stop-exit-after-reconcile'])('owned child exit preserves recovery lease evidence: %s', async mode => {
    const cleanup = mode !== 'retained-control'
    const { spawn } = await import('node:child_process')
    const releasePath = path.join(root, 'release-child')
    const command = buildExactProcessTreeSpawn(process.execPath,
      ['-e', 'while (!(await Bun.file(process.argv[1]).exists())) await Bun.sleep(20)', releasePath],
      { stdio: ['ignore', 'ignore', 'ignore'] })
    const child = spawn(command.command, command.args, command.options)
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
    let removed: Promise<void> | undefined
    let treeConfirmedOnForceStop = false
    let releaseRemoval!: () => void
    const removalGate = new Promise<void>(resolve => { releaseRemoval = resolve })
    try {
      const birth = await readProcessStartTimeMs(child.pid!)
      expect(birth).toBeGreaterThan(0)
      const processTreeIdentity = command.osIdentity === 'unix-pgid:pending'
        ? await captureProcessTreeIdentity(child.pid!) : command.osIdentity
      expect(processTreeIdentity).toBeTruthy()
      owner = { ...owner, pid: child.pid!, processStartedAtMs: birth!, record: { ...owner.record, runtimePid: child.pid! } }
      await sessionStore.upsert(owner.record)
      Object.assign(registry.hosts[owner.record.hostKey], { pid: child.pid, processStartedAtMs: birth, processTreeIdentity })
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
      let deliverExit: (() => void) | undefined
      let removalFinished = false
      const removalCalls: unknown[][] = []
      let lifecycleManager: any
      if (cleanup) {
        const hostManager: any = lifecycleManager = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
          fetchJson: async () => ({ status: 200, data: {} }) })
        const original = hostManager.removePersistentHost.bind(hostManager)
        hostManager.removePersistentHost = (...args: unknown[]) => {
          removalCalls.push(args)
          removed = (async () => {
            // Child exit is not completion of the fire-and-forget registry work.
            if (mode === 'exit-listener') await removalGate
            await original(...args)
            removalFinished = true
          })()
          return removed
        }
        hostManager.cleanupOpenTuiTempArtifactsIfUnused = async () => {}
        const entry = { child, handle: { hostKey: owner.record.hostKey, state: 'healthy', diagnostics: [],
          pid: child.pid, processStartedAtMs: birth, processTreeIdentity, profile, baseUrl: owner.baseUrl },
          lifetime: 'persistent', ownedByProcess: true, refCount: 1 }
        hostManager.hosts.set(owner.record.hostKey, entry)
        hostManager.bindHostLifecycle(owner.record.hostKey, entry)
        if (mode === 'force-stop-exit-after-reconcile') {
          // Deliver the real lifecycle callback after reconciliation has deleted
          // the entry, reproducing Windows event ordering without delaying death.
          const lifecycleExit = child.listeners('exit').at(-1)!
          child.removeListener('exit', lifecycleExit)
          child.once('exit', (code, signal) => {
            deliverExit = () => lifecycleExit.call(child, code, signal)
          })
        }
        await expect(hostManager.upsertPersistentHost({ ...entry.handle,
          processStartedAtMs: birth! + 1 })).rejects.toThrow('pending OAuth publication')
        expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey]).toEqual(
          registry.hosts[owner.record.hostKey])
      }
      if (mode.startsWith('force-stop')) {
        const stopped = await lifecycleManager.reconcilePersistentHosts({ mode: 'force', reason: 'shutdown' })
        expect(stopped.hosts[0].action).toBe('kept_pending_oauth')
        treeConfirmedOnForceStop = stopped.hosts[0].reason.includes('owned process tree stopped')
        if (process.platform !== 'win32') expect(treeConfirmedOnForceStop).toBe(false)
        expect(stopped.hosts[0].reason).toContain(treeConfirmedOnForceStop
          ? 'owned process tree stopped; pending OAuth publication retains exact owner evidence'
          : 'host root stopped; unconfirmed tree and pending OAuth owner evidence retained')
        const exitCode = await exited
        // The sentinel is absent: only the owned force-stop may end this
        // child, and its death must be observed.
        expect(await Bun.file(releasePath).exists()).toBe(false)
        expect(isProcessAlive(child.pid!)).toBe(false)
        if (process.platform === 'win32') {
          expect(child.signalCode).toBeNull()
          expect(exitCode).toBeNumber()
          expect(exitCode).not.toBe(0)
        } else {
          expect(child.signalCode).toBe('SIGTERM')
          expect(exitCode).toBeNull()
        }
        expect(lifecycleManager.getHost(owner.record.hostKey)?.state ?? null).toBe(
          treeConfirmedOnForceStop ? null : 'degraded')
        if (mode === 'force-stop-exit-after-reconcile') {
          expect(deliverExit).toBeDefined()
          expect(removed).toBeUndefined()
          deliverExit!()
          // The delayed listener cannot retire persistent owner evidence.
          expect(removed).toBeUndefined()
          expect(removalCalls).toEqual([])
        }
      } else {
        await writeFile(releasePath, '')
        expect(await exited).toBe(0)
      }
      if (mode === 'exit-listener') {
        expect(removed).toBeUndefined()
        expect(removalFinished).toBe(false)
        expect(removalCalls).toEqual([])
        expect(lifecycleManager.getHost(owner.record.hostKey)?.state).toBe('degraded')
        releaseRemoval()
      }
      // Only confirmed tree cleanup removes an in-memory entry. Root exit keeps
      // the degraded entry and registry; no exit callback may delete evidence.
      if (removed) {
        expect(removalCalls).toEqual([[owner.record.hostKey, { pid: child.pid, startedAtMs: birth }]])
        await removed
        expect(removalFinished).toBe(true)
      }
      if (cleanup) expect(lifecycleManager.getHost(owner.record.hostKey)?.state ?? null).toBe(
        treeConfirmedOnForceStop ? null : 'degraded')
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
        const result = await lifecycleManager.reconcilePersistentHosts({ mode: 'stale' })
        if (process.platform !== 'win32') {
          expect(result.hosts[0].action).toBe('failed')
          expect(result.hosts[0].reason).toContain('terminal owner authority is required')
          expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey].leases).toEqual(
            registry.hosts[owner.record.hostKey].leases)
        } else if (result.hosts[0].action === 'removed_dead') {
          expect(await Bun.file(registryPath).exists()).toBe(false)
        } else {
          expect(result.hosts[0].action).toBe('failed')
          expect(result.hosts[0].reason).toContain('terminal owner authority is required')
          expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey].leases).toEqual(
            registry.hosts[owner.record.hostKey].leases)
        }
      }
    } finally { releaseRemoval(); await writeFile(releasePath, ''); await exited; await removed }
  })
})
