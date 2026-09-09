import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
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

  test.each(['source-paths', 'config', 'new-login'])('revoked pending owner fences C0 while unrelated new authority can execute: %s', async mutation => {
    await arm()
    const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
    const receipt = await readFile(receiptPath, 'utf8')
    if (mutation === 'source-paths') env.XDG_DATA_HOME = path.join(root, 'new-source')
    if (mutation === 'config') env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { xai: {
      options: { baseURL: 'http://test.invalid/new-authority' },
    } } })
    if (mutation !== 'new-login') {
      const fresh = await manager.prepareProfile(project, { profileScope: await resolve() })
      let calls = 0
      await expect(manager.withOwnedOAuthRefresh({ profile: fresh, assertHostOwnership: async () => {},
        operation: async () => { calls += 1 },
      })).rejects.toThrow('pending')
      expect(calls).toBe(0)
    }
    const cnew = { ...c0, access: 'TEST-new-login', refresh: 'TEST-new-login-refresh' }
    await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: cnew })
    const fresh = await manager.prepareProfile(project, { profileScope: await resolve() })
    const cnext = { ...cnew, access: 'TEST-next', refresh: 'TEST-next-refresh' }
    await manager.withOwnedOAuthRefresh({ profile: fresh, assertHostOwnership: async () => {},
      operation: () => writeFile(fresh.managedAuthPath, JSON.stringify({ xai: cnext })),
    })
    expect(await manager.readSavedOAuthCredential(fresh)).toEqual(cnext)
    // A late old writer and reintroduction of its C0 cannot escape the original
    // admission fence by changing source/config or logging into another account.
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    await upsertOpenCodeAuthCredential({ authPath: global, providerId: 'xai', credential: c0 })
    const other = path.join(root, 'other-project'); await mkdir(other)
    const oldCredential = await manager.prepareProfile(other, { profileScope: await resolveOpenCodeProfileScope({
      projectPath: other, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env,
    }) })
    let oldCalls = 0
    await expect(manager.withOwnedOAuthRefresh({ profile: oldCredential, assertHostOwnership: async () => {},
      operation: async () => { oldCalls += 1 },
    })).rejects.toThrow('pending')
    expect(oldCalls).toBe(0)
    expect(await readSaved()).toEqual(c0)
    const { createHash } = await import('node:crypto')
    const revokedPath = `${receiptPath}.revoked-${createHash('sha256').update(c0.refresh).digest('hex')}`
    expect(await readFile(revokedPath, 'utf8')).toBe(receipt)
  })

  test('fresh child finishes armed native ownership using persisted lease, OS process birth and session record', async () => {
    await arm()
    await expect(resolve()).rejects.toThrow('pending')
    expect(await readSaved()).toEqual(c0)
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    // Only the synthetic canonical native transport is mocked in the fresh child.
    // Default ProfileManager recovery constructs real HostManager and SessionStore
    // from the captured data root and reads the live parent process birth.
    const script = `import { mock } from 'bun:test';
      mock.module(${JSON.stringify(path.join(import.meta.dir, 'OpenCodeClientFactory.ts'))}, () => ({
        openCodeClientFactory: { create: () => ({ getSessionStatus: async () => ({ 'native-session': 'idle' }),
          getSessionMessages: async () => ${JSON.stringify(terminalMessages(owner.messageId))} }) } }));
      const { resolveOpenCodeProfileScope, OpenCodeProfileManager } = await import(${JSON.stringify(path.join(import.meta.dir, 'OpenCodeProfileManager.ts'))});
      const scope = await resolveOpenCodeProfileScope({ projectPath: process.argv[1], selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime' });
      const manager = new OpenCodeProfileManager();
      const profile = await manager.prepareProfile(process.argv[1], { profileScope: scope });
      const auth = await Bun.file(profile.managedAuthPath).json();
      if (auth.xai.refresh !== 'single-use-C1') throw new Error('fresh process did not select C1');
      await manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
        operation: async () => {
          await Bun.write(profile.managedAuthPath, JSON.stringify({ xai: { ...auth.xai, access: 'TEST-C2', refresh: 'single-use-C2' } }));
        } });
      process.stdout.write('C1->C2');`
    const child = Bun.spawn([process.execPath, '-e', script, project], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe(''); expect(code).toBe(0); expect(stdout).toBe('C1->C2')
    const c2 = { ...c1, access: 'TEST-C2', refresh: 'single-use-C2' }
    expect(await readSaved()).toEqual(c2)
    expect(await sessionStore.get('TEST', 'primary', 'owner')).toEqual(owner.record)
    const next = await manager.prepareProfile(project, { profileScope: await resolve() })
    expect(await readOpenCodeAuthCredential({ authPath: next.managedAuthPath, providerId: 'xai' })).toEqual(c2)
  })

  test.each(['busy', 'null-status', 'wrong-parent', 'wrong-model', 'no-user', 'step-only'])('requires exact settled native prompt: %s', async mutation => {
    await arm()
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    messages = terminalMessages(owner.messageId)
    if (mutation === 'busy') status = { type: 'busy' }
    if (mutation === 'null-status') status = null
    if (mutation === 'wrong-parent') messages[1].info.parentID = 'foreign'
    if (mutation === 'wrong-model') messages[1].info.modelID = 'foreign'
    if (mutation === 'no-user') messages.shift()
    if (mutation === 'step-only') { delete messages[1].info.time.completed; messages[1].parts = [{ type: 'step-finish' }] }
    await expect(resolve()).rejects.toThrow('pending')
    expect(await readSaved()).toEqual(c0)
    status = 'idle'; messages = terminalMessages(owner.messageId)
    await resolve()
    expect(await readSaved()).toEqual(c1)
  })

  test.each(['lease-run', 'lease-session', 'birth', 'endpoint', 'proof', 'model', 'stopped'])('rejects pending owner replacement: %s', async mutation => {
    await arm()
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    messages = terminalMessages(owner.messageId)
    const host = registry.hosts[owner.record.hostKey]
    if (mutation === 'lease-run') host.leases['TEST::primary::owner'].runId = 'foreign'
    if (mutation === 'lease-session') host.leases['TEST::primary::owner'].sessionId = 'foreign'
    if (mutation === 'birth') host.processStartedAtMs += 1
    if (mutation === 'endpoint') host.baseUrl = 'https://example.invalid'
    if (mutation === 'proof') await sessionStore.upsert({ ...owner.record, expectedBehaviorFingerprint: 'foreign' })
    if (mutation === 'model') await sessionStore.upsert({ ...owner.record, selectedModel: 'xai/foreign' })
    if (mutation === 'stopped') await sessionStore.upsert({ ...owner.record, stoppedAt: new Date().toISOString() })
    await saveRegistry()
    await expect(resolve()).rejects.toThrow()
    expect(await readSaved()).toEqual(c0)
    expect(await Bun.file(`${global}.agent-teams-xai-oauth-save.json`).exists()).toBe(true)
  })

  test('armed process-host probe waits for exact terminal output and then saves C1', async () => {
    await manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
      operation: async (_armSession, armProbe) => {
        await armProbe({ projectPath: project, scopeToken: profile.scopeToken!, profileRootKey: profile.profileRootKey,
          hostKey: owner.record.hostKey, baseUrl: owner.baseUrl, pid: owner.pid, processStartedAtMs: owner.processStartedAtMs,
          selectedModel: owner.record.selectedModel, sessionId: owner.record.opencodeSessionId, messageId: owner.messageId })
      }, isNativeSettled: () => false, allowNativeContinuation: true })
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    await expect(resolve()).rejects.toThrow('pending')
    expect(await readSaved()).toEqual(c0)
    messages = terminalMessages(owner.messageId)
    status = null
    await expect(resolve()).rejects.toThrow('pending')
    status = 'idle'
    await resolve()
    expect(await readSaved()).toEqual(c1)
  })

  test.each([
    ['probe', false], ['probe', true],
    ['session', false], ['session', true],
    ['revoked-session', false], ['replaced-birth-session', false],
    ['cancelled-probe', false], ['cancelled-session', false],
    ['wrong-parent-probe', false], ['wrong-parent-session', false],
    ['wrong-model-probe', false], ['wrong-model-session', false],
    ['wrong-provider-probe', false], ['wrong-provider-session', false],
    ['incomplete-probe', false], ['incomplete-session', false],
    ['relaunch-session', false], ['relaunch-session', true],
    ['relaunch-cancelled-session', false], ['unsubmitted-probe', false],
    ['unsubmitted-session', false], ['unsubmitted-probe-missing-history', false],
    ['unsubmitted-session-missing-history', false], ['unsubmitted-probe-unsupported-history', false],
    ['unsubmitted-session-unsupported-history', false], ['unsubmitted-probe-changed-auth', false],
    ['unsubmitted-session-changed-auth', false], ['unsubmitted-probe-wrong-directory', false],
    ['unsubmitted-session-wrong-directory', false], ['unsubmitted-probe-oversized', false],
    ['unsubmitted-session-oversized', false], ['unsubmitted-probe-message-cap', false],
    ['unsubmitted-session-message-cap', false],
  ] as const)('exited %s requires exact committed terminal history (wrong parent: %s)', async (kind, wrongParent) => {
    const isProbe = kind.includes('probe')
    const unsubmitted = kind.startsWith('unsubmitted-')
    const child = Bun.spawn([process.execPath, '-e', 'await Bun.stdin.text()'], { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' })
    try {
      const birth = await readProcessStartTimeMs(child.pid)
      expect(birth).toBeGreaterThan(0)
      if (!isProbe) {
        owner = { ...owner, pid: child.pid, processStartedAtMs: birth!, record: { ...owner.record, runtimePid: child.pid } }
        await sessionStore.upsert(owner.record)
        Object.assign(registry.hosts[owner.record.hostKey], { pid: child.pid, processStartedAtMs: birth })
        await saveRegistry()
      }
      await manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
        operation: async (armSession, armProbe) => {
          if (!isProbe) { await armSession(owner); return }
          await armProbe({ projectPath: project, scopeToken: profile.scopeToken!, profileRootKey: profile.profileRootKey,
            hostKey: owner.record.hostKey, baseUrl: owner.baseUrl, pid: child.pid, processStartedAtMs: birth!,
            selectedModel: owner.record.selectedModel, sessionId: owner.record.opencodeSessionId, messageId: owner.messageId })
        }, isNativeSettled: () => false, allowNativeContinuation: true })
      if (!unsubmitted || kind.endsWith('changed-auth')) await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
      const db = new Database(path.join(path.dirname(profile.managedAuthPath), 'opencode.db'))
      try {
        db.exec(`create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
          create table part (id text, message_id text, session_id text, time_created integer, time_updated integer, data text);
          create table session (id text, project_id text, directory text);
          create table project (id text, worktree text, vcs text);`)
        db.query('insert into session values (?, ?, ?)').run(owner.record.opencodeSessionId, 'project-TEST', project)
        db.query('insert into project values (?, ?, ?)').run('project-TEST', project, 'git')
        const history = terminalMessages(wrongParent ? 'foreign-message' : owner.messageId)
        if (kind.includes('cancelled-')) history.splice(1)
        if (kind.startsWith('wrong-parent-')) history[1]!.info.parentID = 'foreign-message'
        if (kind.startsWith('wrong-model-')) history[1]!.info.modelID = 'foreign-model'
        if (kind.startsWith('wrong-provider-')) history[1]!.info.providerID = 'foreign-provider'
        if (kind.startsWith('incomplete-')) delete (history[1]!.info as any).time
        if (unsubmitted) history.splice(0)
        for (const [index, message] of history.entries()) {
          db.query('insert into message values (?, ?, ?, ?, ?)').run(message.info.id, owner.record.opencodeSessionId, index + 1, null, JSON.stringify(message.info))
        }
        if (kind.endsWith('oversized')) db.query('insert into message values (?, ?, ?, ?, ?)').run(
          owner.messageId, owner.record.opencodeSessionId, 1, null,
          JSON.stringify({ role: 'user', padding: 'x'.repeat(300000) }))
        if (kind.endsWith('message-cap')) db.query(`with recursive seq(x) as (select 1 union all select x+1 from seq where x < 20001)
          insert into message select 'msg-' || x, ?, x, null, '{"role":"user"}' from seq`).run(owner.record.opencodeSessionId)
        if (kind.endsWith('missing-history')) db.exec('drop table session')
        if (kind.endsWith('unsupported-history')) db.exec('drop table part')
        if (kind.endsWith('wrong-directory')) db.query('update session set directory = ?').run(path.join(root, 'foreign'))
      } finally { db.close() }
      child.stdin.end()
      expect(await child.exited).toBe(0)
      if (kind === 'revoked-session') { registry.hosts[owner.record.hostKey].leases = {}; await saveRegistry() }
      if (kind === 'replaced-birth-session') { registry.hosts[owner.record.hostKey].processStartedAtMs += 1; await saveRegistry() }
      const fresh = () => resolveOpenCodeProfileScope({ projectPath: project, selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env })
      if (kind.startsWith('relaunch-')) {
        // Direct public launch: no standalone resolver or receipt recovery first.
        const { executeOpenCodeBridgeCommandEnvelope } = await import('./OpenCodeBridgeCommandHandler.js')
        const { openCodeSessionStore } = await import('./OpenCodeSessionStore.js')
        const { openCodeHostManager } = await import('./OpenCodeHostManager.js')
        const { openCodeProvisioningProbe } = await import('./OpenCodeProvisioningProbe.js')
        const hosts = new OpenCodeHostManager({ persistentRegistryPath: registryPath })
        const restores: Array<{ mockRestore(): void }> = []
        let provisioned = false
        try {
          restores.push(spyOn(openCodeSessionStore, 'list').mockImplementation(() => sessionStore.list()))
          restores.push(spyOn(openCodeSessionStore, 'retireAbsentRuntimeIfSession').mockImplementation(
            (...args) => sessionStore.retireAbsentRuntimeIfSession(...args)))
          restores.push(spyOn(openCodeHostManager, 'withConfirmedAbsentHostAuthority').mockImplementation(
            (...args) => hosts.withConfirmedAbsentHostAuthority(...args)))
          restores.push(spyOn(openCodeProvisioningProbe, 'probeRetainingHost').mockImplementation(async () => {
            provisioned = true
            const reopened = await manager.prepareProfile(project, { profileScope: await fresh() })
            expect(await readOpenCodeAuthCredential({ authPath: reopened.managedAuthPath, providerId: 'xai' })).toEqual(c1)
            expect((await sessionStore.get('TEST', 'primary', 'owner'))?.stoppedAt).toBeDefined()
            expect(await Bun.file(`${global}.agent-teams-xai-oauth-save.json`).exists()).toBe(false)
            // Provisioning is the next process boundary; this fixture launches no provider.
            throw new Error('TEST reached fresh C1 provisioning')
          }))
          const result = await executeOpenCodeBridgeCommandEnvelope({ schemaVersion: 1, requestId: 'TEST-relaunch',
            command: 'opencode.launchTeam', cwd: project, startedAt: new Date().toISOString(), timeoutMs: 20_000,
            body: { teamId: 'TEST', laneId: 'primary', runId: 'run-2', selectedModel: 'xai/grok-4.3',
              members: [{ name: 'owner' }], preconditions: { handshakeIdentityHash: 'TEST-handshake',
                laneId: 'primary', expectedRunId: 'run-2', expectedCapabilitySnapshotId: null,
                expectedBehaviorFingerprint: 'b'.repeat(64), expectedManifestHighWatermark: 0,
                commandLeaseId: 'TEST-lease', idempotencyKey: 'TEST-relaunch' } } })
          expect(result.ok).toBe(false)
          if (wrongParent || kind.includes('cancelled')) {
            expect(provisioned).toBe(false)
            expect((await sessionStore.get('TEST', 'primary', 'owner'))?.stoppedAt).toBeUndefined()
            expect(await Bun.file(`${global}.agent-teams-xai-oauth-save.json`).exists()).toBe(true)
            expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey]).toBeDefined()
          } else {
            expect(provisioned).toBe(true)
            if (!result.ok) expect(result.error.message).toBe('TEST reached fresh C1 provisioning')
            expect(await readSaved()).toEqual(c1)
            expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey]).toBeUndefined()
          }
        } finally { for (const mock of restores.reverse()) mock.mockRestore() }
        return
      }
      if (wrongParent || /^(cancelled|wrong-parent|wrong-provider|wrong-model|incomplete)-/.test(kind) || kind === 'revoked-session' || kind === 'replaced-birth-session' || /missing-history|unsupported-history|changed-auth|wrong-directory|oversized|message-cap/.test(kind)) {
        await expect(fresh()).rejects.toThrow()
        expect(await readSaved()).toEqual(c0)
      } else {
        const reopened = await manager.prepareProfile(project, { profileScope: await fresh() })
        expect(await readSaved()).toEqual(unsubmitted ? c0 : c1)
        expect(await readOpenCodeAuthCredential({ authPath: reopened.managedAuthPath, providerId: 'xai' })).toEqual(unsubmitted ? c0 : c1)
        expect(await Bun.file(`${global}.agent-teams-xai-oauth-save.json`).exists()).toBe(false)
      }
    } finally { child.stdin.end(); await child.exited }
  })

  test('rechecks lease ownership after canonical settlement reads', async () => {
    await arm()
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    messages = terminalMessages(owner.messageId)
    onRead = async () => { registry.hosts[owner.record.hostKey].leases = {}; await saveRegistry() }
    await expect(resolve()).rejects.toThrow('ownership')
    expect(await readSaved()).toEqual(c0)
  })

  test('confirmed stop of a live persistent native owner must preserve saved C1 for a new launch', async () => {
    await arm()
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    // The native refresh committed, then cancellation left only the accepted
    // user row and explicit idle. The real stop path releases this exact lease
    // before its terminal SessionStore CAS. Neither operation may strand C1.
    messages = terminalMessages(owner.messageId).slice(0, 1)
    await bridge.releaseSession(owner.record, { strictLeaseRelease: true })
    expect(await sessionStore.markStoppedIfSession(owner.record)).not.toBeNull()
    const profileScope = await resolveOpenCodeProfileScope({ projectPath: project,
      selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime', env })
    const reopened = await manager.prepareProfile(project, { profileScope })
    expect(await readOpenCodeAuthCredential({ authPath: reopened.managedAuthPath, providerId: 'xai' })).toEqual(c1)
  })

  test.each(['busy', 'missing-status', 'wrong-user', 'abort-rejected', 'changed-proof', 'new-saved-successor'])('Stop retains native ownership when cleanup cannot publish: %s', async mutation => {
    await arm()
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    messages = terminalMessages(owner.messageId).slice(0, 1)
    if (mutation === 'busy') status = { type: 'busy' }
    if (mutation === 'missing-status') status = null
    if (mutation === 'wrong-user') messages[0].info.id = 'foreign'
    if (mutation === 'abort-rejected') abortAcknowledged = false
    if (mutation === 'changed-proof') onAbort = () => sessionStore.upsert({ ...owner.record, expectedBehaviorFingerprint: 'replacement' }).then(() => {})
    const replacement = { ...c1, refresh: 'NEW-SAVED-SUCCESSOR' }
    if (mutation === 'new-saved-successor') onAbort = () => writeFile(global, JSON.stringify({ xai: replacement }))
    await expect(bridge.releaseSession(owner.record, { strictLeaseRelease: true })).rejects.toThrow()
    expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey].leases['TEST::primary::owner']).toBeDefined()
    expect((await sessionStore.get('TEST', 'primary', 'owner'))?.stoppedAt).toBeUndefined()
    expect(await readSaved()).toEqual(mutation === 'new-saved-successor' ? replacement : c0)
  })

  test('stopping a different run does not claim or cancel the pending native owner', async () => {
    await arm()
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    const peer = { ...owner.record, memberName: 'peer', runId: 'peer-run', opencodeSessionId: 'peer-session' }
    await sessionStore.upsert(peer)
    registry.hosts[owner.record.hostKey].leases['TEST::primary::peer'] = {
      ...registry.hosts[owner.record.hostKey].leases['TEST::primary::owner'], leaseKey: 'TEST::primary::peer',
      memberName: 'peer', runId: peer.runId, sessionId: peer.opencodeSessionId,
    }
    await saveRegistry()
    const before = await readFile(`${global}.agent-teams-xai-oauth-save.json`, 'utf8')
    await bridge.releaseSession(peer, { strictLeaseRelease: true })
    expect(abortCalls).toBe(0)
    expect(await readFile(`${global}.agent-teams-xai-oauth-save.json`, 'utf8')).toBe(before)
    expect(await readSaved()).toEqual(c0)
    expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey].leases['TEST::primary::owner']).toBeDefined()
  })

  test('fresh-process Stop saves owned C1 before revoking its lease and new resolution reuses C1', async () => {
    await arm()
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    const script = `import { mock } from 'bun:test';
      mock.module(${JSON.stringify(path.join(import.meta.dir, 'OpenCodeClientFactory.ts'))}, () => ({
        openCodeClientFactory: { create: () => ({ getSessionStatus: async () => ({ 'native-session': 'idle' }),
          getSessionMessages: async () => ${JSON.stringify(terminalMessages(owner.messageId).slice(0, 1))}, abortSession: async () => true }) } }));
      const { OpenCodeSessionBridge } = await import(${JSON.stringify(path.join(import.meta.dir, 'OpenCodeSessionBridge.ts'))});
      const { openCodeSessionStore } = await import(${JSON.stringify(path.join(import.meta.dir, 'OpenCodeSessionStore.ts'))});
      const { resolveOpenCodeProfileScope, OpenCodeProfileManager } = await import(${JSON.stringify(path.join(import.meta.dir, 'OpenCodeProfileManager.ts'))});
      const record = await openCodeSessionStore.get('TEST', 'primary', 'owner');
      await new OpenCodeSessionBridge().releaseSession(record, { strictLeaseRelease: true });
      await openCodeSessionStore.markStoppedIfSession(record);
      const scope = await resolveOpenCodeProfileScope({ projectPath: process.argv[1], selectedModel: 'xai/grok-4.3', purpose: 'launch_runtime' });
      const profile = await new OpenCodeProfileManager().prepareProfile(process.argv[1], { profileScope: scope });
      process.stdout.write((await Bun.file(profile.managedAuthPath).json()).xai.refresh);`
    const child = Bun.spawn([process.execPath, '-e', script, project], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe(''); expect(code).toBe(0); expect(stdout).toBe(c1.refresh)
    expect((await sessionStore.get('TEST', 'primary', 'owner'))?.stoppedAt).toBeDefined()
    expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey].leases['TEST::primary::owner']).toBeUndefined()
  })

  test('uncertain HTTP failure leaves native ownership available for later terminal recovery', async () => {
    await expect(arm(true)).rejects.toThrow('uncertain HTTP')
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    messages = terminalMessages(owner.messageId)
    await resolve()
    expect(await readSaved()).toEqual(c1)
  })
})
