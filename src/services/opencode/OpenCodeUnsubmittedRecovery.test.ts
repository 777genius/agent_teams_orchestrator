import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readProcessStartTimeMs } from '../../utils/processKill.js'
import { OpenCodeProfileManager, resolveOpenCodeProfileScope } from './OpenCodeProfileManager.js'
import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { OpenCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { readOpenCodeAuthCredential, upsertOpenCodeAuthCredential, type OpenCodeOAuthNativeSessionOwner } from './OpenCodeAuthStore.js'
import type { OpenCodeHostHandle, OpenCodePreparedProfile, OpenCodeSessionRecord } from './types.js'

const c0 = { type: 'oauth', access: 'TEST-C0', refresh: 'single-use-C0', expires: 4000000000000, accountId: 'TEST' }
const c1 = { ...c0, access: 'TEST-C1', refresh: 'single-use-C1', expires: 4000003600000 }
const terminalMessages = (messageId: string) => [
  { info: { id: messageId, role: 'user' }, parts: [] },
  { info: { id: 'assistant', role: 'assistant', parentID: messageId, providerID: 'xai', modelID: 'grok-4.3', time: { completed: 1 } }, parts: [] },
]

describe('pending native OAuth session authority', () => {
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
      hostManager: new OpenCodeHostManager({ persistentRegistryPath: registryPath }), sessionStore,
      clientFactory: { create: () => ({ getSessionStatus: () => readStatusMap(),
        getSessionMessages: async () => { await onRead?.(); return messages }, abortSession: async () => { abortCalls += 1; await onAbort?.(); return abortAcknowledged } }) as never },
    })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test.each(['rotated-cas', 'lost-response', 'synchronous-transport-throw', 'persistence-failure', 'replaced-outcome-owner'])('owned unsubmitted recovery: %s', async scenario => {
    const { executeOpenCodeBridgeCommandEnvelope: execute } = await import('./OpenCodeBridgeCommandHandler.js')
    const { openCodeSessionStore } = await import('./OpenCodeSessionStore.js')
    const { openCodeSessionBridge } = await import('./OpenCodeSessionBridge.js')
    const { openCodeClientFactory } = await import('./OpenCodeClientFactory.js')
    const { openCodeProvisioningProbe, OpenCodeProvisioningProbe } = await import('./OpenCodeProvisioningProbe.js')
    const { openCodeCommandOutcomeStore, OpenCodeCommandOutcomeStore } = await import('./OpenCodeCommandOutcomeStore.js')
    const { createHash } = await import('node:crypto')
    const hashStable = (value: Record<string, unknown>) => createHash('sha256')
      .update(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))).digest('hex')
    const { buildOpenCodeExpectedBehaviorEvidence } = await import('./OpenCodeExpectedBehaviorFingerprint.js')
    const { effectiveAgentsFixture } = await import('./OpenCodeEffectiveAgents.test-support.js')
    const savedEnv = { ...process.env }
    const restores: Array<{ mockRestore(): void }> = []
    Object.assign(process.env, env)
    let posts = 0
    let onMcp: (() => Promise<void>) | undefined
    let onHistory: (() => Promise<void>) | undefined
    const histories = new Map<string, any[]>()
    const statuses: Record<string, unknown> = {}
    const mcp = { 'agent-teams': { status: 'connected' } }
    const client = { getSessionStatus: async () => statuses,
      getSessionMessages: async (id: string) => { await onHistory?.(); return histories.get(id) ?? [] }, getPermissions: async () => [],
      getMcp: async () => { await onMcp?.(); return mcp },
      getConfig: async () => {
        const config = JSON.parse(JSON.stringify(profile.managedConfig).replace(/\{env:([^}]+)\}/g, (_match, name) => profile.env[name] || ''))
        return config
      },
      listAgents: async () => effectiveAgentsFixture(profile.managedConfig, profile.xdgDataHome),
      promptSessionAsync: (id: string, body: any) => {
        posts += 1
        if (scenario === 'synchronous-transport-throw') throw new Error('TEST native client threw at invocation')
        expect(body.model).toEqual({ providerID: 'xai', modelID: 'grok-4.3' })
        histories.set(id, [...(histories.get(id) ?? []), { info: { id: body.messageID, role: 'user' }, parts: body.parts }])
        statuses[id] = { type: 'busy' }
        if (scenario === 'lost-response') return Promise.reject(new Error('TEST lost response after synthetic admission'))
        return Promise.resolve()
      },
    }
    try {
      owner.record = { ...owner.record, toolApprovalMode: 'auto', opencodeVersion: 'TEST',
        expectedBehaviorFingerprint: (await buildOpenCodeExpectedBehaviorEvidence({ profile, fullModelId: owner.record.selectedModel,
          effectiveConfigFingerprint: profile.managedConfigFingerprint })).expectedBehaviorFingerprint,
        resolvedBehaviorFingerprint: profile.managedConfigFingerprint }
      await sessionStore.upsert(owner.record)
      const other = { ...owner.record, memberName: 'other', opencodeSessionId: 'other-session' }
      await sessionStore.upsert(other)
      const leases = registry.hosts[owner.record.hostKey].leases
      leases['TEST::primary::other'] = { ...leases['TEST::primary::owner'], leaseKey: 'TEST::primary::other',
        memberName: 'other', sessionId: other.opencodeSessionId }
      await saveRegistry()
      const hosts = new OpenCodeHostManager({ persistentRegistryPath: registryPath })
      const hostFor = (prepared: OpenCodePreparedProfile): OpenCodeHostHandle => ({
        hostKey: owner.record.hostKey, profileRootKey: prepared.profileRootKey, projectPath: project,
        projectBehaviorFingerprint: prepared.projectBehaviorFingerprint, baseUrl: owner.baseUrl, port: 43210,
        pid: process.pid, processStartedAtMs: owner.processStartedAtMs, version: 'TEST', state: 'healthy',
        profile: prepared, resolvedConfigFingerprint: prepared.managedConfigFingerprint, diagnostics: [],
      })
      // Only process acquisition / native transport are synthetic. Scope recovery,
      // preparation, publication, bridge admission and outcome writes are real.
      restores.push(spyOn(hosts, 'ensureHost').mockImplementation(async input => hostFor(input.preparedProfile!)))
      restores.push(spyOn(hosts, 'releaseHost').mockImplementation(async () => {}))
      const mcpManager = { ensureAppMcp: async () => ({ mcp, summary: { status: 'present', connected: true, matchedServerName: 'agent-teams', diagnostics: [] } }) }
      const productionProbe = new OpenCodeProvisioningProbe({ hostManager: hosts,
        inventoryService: { probe: async (_project: any, options: any) => ({ detected: true, projectPath: project,
          models: [], diagnostics: [], profile: await manager.prepareProfile(project, options) }) } as never,
        mcpManager: mcpManager as never })
      const productionBridge = new OpenCodeSessionBridge({ hostManager: hosts, sessionStore,
        clientFactory: { create: () => client as never }, mcpManager: mcpManager as never,
        oauthRefreshCoordinator: new (await import('./OpenCodeOAuthRefreshCoordinator.js')).OpenCodeOAuthRefreshCoordinator() })
      let outcomes = new OpenCodeCommandOutcomeStore(path.join(root, 'outcomes.json'))
      restores.push(spyOn(openCodeCommandOutcomeStore, 'upsert').mockImplementation((...args) => outcomes.upsert(...args)))
      restores.push(spyOn(openCodeSessionStore, 'list').mockImplementation(() => sessionStore.list()))
      restores.push(spyOn(openCodeSessionStore, 'get').mockImplementation((...args) => sessionStore.get(...args)))
      restores.push(spyOn(openCodeClientFactory, 'create').mockImplementation(() => client as never))
      restores.push(spyOn(openCodeProvisioningProbe, 'probeRetainingHost').mockImplementation((...args) => productionProbe.probeRetainingHost(...args)))
      for (const method of ['reconcileSession', 'ensureSessionAppMcpReady', 'promptAsyncUntilAccepted', 'promptAsync'] as const) {
        restores.push(spyOn(openCodeSessionBridge, method).mockImplementation(productionBridge[method].bind(productionBridge) as never))
      }
      // Added entrypoint remains real; only bind its synthetic persistent roots.
      restores.push(spyOn(openCodeSessionBridge, 'withOwnedOAuthSessionObservation')
        .mockImplementation(productionBridge.withOwnedOAuthSessionObservation.bind(productionBridge)))
      const capability = `opencode:${hashStable({ version: 'TEST', projectPath: project,
        projectBehaviorFingerprint: profile.projectBehaviorFingerprint, managedConfigFingerprint: profile.managedConfigFingerprint,
        mcpServers: ['agent-teams'], providers: [] }).slice(0, 32)}`
      const call = (command: string, member = 'owner', extra: Record<string, unknown> = {}, signal?: AbortSignal) => execute({
        schemaVersion: 1, command, requestId: `TEST-${command}-${member}`, cwd: project,
        startedAt: new Date().toISOString(), timeoutMs: 10_000,
        body: { teamId: 'TEST', laneId: 'primary', runId: 'run-1', memberName: member,
          expectedCapabilitySnapshotId: capability, messageId: 'inbox-TEST',
          runtimePromptMessageId: owner.messageId, sessionId: member === 'owner' ? 'native-session' : 'other-session',
          text: 'synthetic followup', settlementMode: 'acceptance',  ...extra },
      }, { signal })
      await arm()
      await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
      histories.set('native-session', terminalMessages(owner.messageId))
      await resolveOpenCodeProfileScope({ projectPath: project, selectedModel: owner.record.selectedModel,
        purpose: 'launch_runtime', env })
      const evidencePath = `${global}.agent-teams-xai-oauth-successor.json`
      const retained = await readFile(evidencePath, 'utf8')
      let transitionCalls = 0
      const attempted = scenario === 'lost-response' || scenario === 'synchronous-transport-throw'
      let race = !attempted
      const originalUpsert = outcomes.upsert.bind(outcomes)
      restores.push(spyOn(outcomes, 'upsert').mockImplementation(async (patch, options) => {
        if ((options as any)?.definitelyUnsubmitted) {
          transitionCalls += 1
          expect(posts).toBe(0)
          expect(patch.runtimePromptMessageId).toBe((options as any).definitelyUnsubmitted.runtimePromptMessageId)
          if (scenario === 'persistence-failure') throw new Error('TEST durable transition unavailable')
          if (scenario === 'replaced-outcome-owner') {
            // Model a competing committed writer, without weakening the API.
            const file = path.join(root, 'outcomes.json')
            const stored = JSON.parse(await readFile(file, 'utf8'))
            stored.records[patch.requestId].runtimePromptMessageId = 'TEST-competing-native-owner'
            await writeFile(file, JSON.stringify(stored))
          }
        }
        const result = await originalUpsert(patch, options)
        if (race && patch.status === 'prompt_submitting') {
          race = false
          const competing = JSON.parse(await readFile(evidencePath, 'utf8'))
          competing.operationId = 'newer-publication'
          await writeFile(evidencePath, JSON.stringify(competing))
        }
        return result
      }))
      restores.push(spyOn(openCodeCommandOutcomeStore, 'query').mockImplementation((...args) => outcomes.query(...args)))
      const first = await call('opencode.sendMessage')
      expect(first.ok).toBe(false)
      const expectedPosts = attempted ? 1 : 0
      expect(posts).toBe(expectedPosts)
      expect(transitionCalls).toBe(attempted ? 0 : 1)
      if (scenario === 'rotated-cas' && !first.ok) expect(first.error.message).not.toContain('settlement is unconfirmed')
      const before = (await outcomes.query({ requestId: 'TEST-opencode.sendMessage-owner' })).record!
      expect(before.runtimePromptMessageId).toBeTruthy()
      // A reopened actual store, and then an independent Bun process, must both
      // answer through the production commandStatus handler.
      outcomes = new OpenCodeCommandOutcomeStore(path.join(root, 'outcomes.json'))
      const query = await call('opencode.commandStatus', 'owner', { originalRequestId: before.requestId })
      expect(query.ok).toBe(true)
      const retryable = scenario === 'rotated-cas'
      if (query.ok) {
        expect((query.data as any).accepted).toBe(false)
        expect((query.data as any).safeToRetry).toBe(retryable)
      }
      const script = `
        import { spyOn } from 'bun:test';
        import { openCodeCommandOutcomeStore, OpenCodeCommandOutcomeStore } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeCommandOutcomeStore.ts'))};
        import { executeOpenCodeBridgeCommandEnvelope } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeBridgeCommandHandler.ts'))};
        const store = new OpenCodeCommandOutcomeStore(${JSON.stringify(path.join(root, 'outcomes.json'))});
        spyOn(openCodeCommandOutcomeStore, 'query').mockImplementation((...args) => store.query(...args));
        const result = await executeOpenCodeBridgeCommandEnvelope({schemaVersion:1, command:'opencode.commandStatus',
          requestId:'TEST-fresh-status',cwd:${JSON.stringify(project)},startedAt:new Date().toISOString(),timeoutMs:10000,
          body:{originalRequestId:${JSON.stringify(before.requestId)}}});
        process.stdout.write(JSON.stringify(result));`
      const child = Bun.spawn([process.execPath, '-e', script], { env, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(code).toBe(0); expect(stderr).toBe('')
      const fresh = JSON.parse(stdout)
      expect(fresh.ok).toBe(true)
      expect(fresh.data.safeToRetry).toBe(retryable)
      expect(fresh.data.accepted).toBe(false)
      expect(fresh.data.runtimePromptMessageId).toBe(before.runtimePromptMessageId)
      console.log('UNSUBMITTED recovery', JSON.stringify({scenario, posts, transitionCalls, status:fresh.data.status, safeToRetry:fresh.data.safeToRetry}))
      if (retryable) {
        // Restore the fixture's legitimate retained authority, never remove a
        // receipt or delivery fence. The retry uses the SAME request/payload.
        await writeFile(evidencePath, retained)
        const modulePath = (name: string) => JSON.stringify(path.join(import.meta.dir, name))
        const script = `import { spyOn } from 'bun:test';
          import { OpenCodeProfileManager, resolveOpenCodeProfileScope } from ${modulePath('OpenCodeProfileManager.ts')};
          import { openCodeSessionStore } from ${modulePath('OpenCodeSessionStore.ts')};
          import { openCodeHostManager } from ${modulePath('OpenCodeHostManager.ts')};
          import { openCodeClientFactory } from ${modulePath('OpenCodeClientFactory.ts')};
          import { openCodeMcpManager } from ${modulePath('OpenCodeMcpManager.ts')};
          import { OpenCodeCommandOutcomeStore, openCodeCommandOutcomeStore } from ${modulePath('OpenCodeCommandOutcomeStore.ts')};
          import { effectiveAgentsFixture } from ${modulePath('OpenCodeEffectiveAgents.test-support.ts')};
          import { executeOpenCodeBridgeCommandEnvelope as execute } from ${modulePath('OpenCodeBridgeCommandHandler.ts')};
          const record = await openCodeSessionStore.get('TEST', 'primary', 'owner');
          await resolveOpenCodeProfileScope({ projectPath: record.projectPath, selectedModel: record.selectedModel, purpose: 'launch_runtime' });
          const manager = new OpenCodeProfileManager();
          const profile = await manager.prepareOwnedOAuthSessionProfile(record);
          if (!profile || !manager.hasOwnedOAuthSessionProfile(record, profile)) throw new Error('missing continuity');
          let posts = 0; const history = []; const status = {};
          const mcp = { 'agent-teams': { status: 'connected' } };
          const client = { getMcp: async () => mcp, getConfig: async () => profile.managedConfig,
            listAgents: async () => effectiveAgentsFixture(profile.managedConfig, profile.xdgDataHome),
            getSessionStatus: async () => status, getSessionMessages: async () => history, getPermissions: async () => [],
            promptSessionAsync: async (id, body) => { posts++; history.push({ info: { id: body.messageID, role: 'user' }, parts: [] }); status[id] = 'busy'; } };
          spyOn(openCodeClientFactory, 'create').mockImplementation(() => client);
          spyOn(openCodeMcpManager, 'ensureAppMcp').mockImplementation(async () => ({ mcp,
            summary: { matchedServerName: 'agent-teams', connected: true, status: 'present', diagnostics: [] } }));
          spyOn(openCodeHostManager, 'ensureHost').mockImplementation(async input => ({
            ...${JSON.stringify({ hostKey: owner.record.hostKey, profileRootKey: profile.profileRootKey, projectPath: project,
              projectBehaviorFingerprint: profile.projectBehaviorFingerprint, baseUrl: owner.baseUrl, port: 43210,
              pid: owner.pid, processStartedAtMs: owner.processStartedAtMs, version: 'TEST', state: 'healthy',
              resolvedConfigFingerprint: profile.managedConfigFingerprint, diagnostics: [] })}, profile: input.preparedProfile }));
          spyOn(openCodeHostManager, 'releaseHost').mockImplementation(async () => {});
          const outcomes = new OpenCodeCommandOutcomeStore(${JSON.stringify(path.join(root, 'outcomes.json'))});
          spyOn(openCodeCommandOutcomeStore, 'upsert').mockImplementation((...args) => outcomes.upsert(...args));
          const call = requestId => execute({ schemaVersion: 1, command: 'opencode.sendMessage', requestId, cwd: record.projectPath,
            startedAt: new Date().toISOString(), timeoutMs: 10000,
            body: { teamId: 'TEST', laneId: 'primary', runId: 'run-1', memberName: 'owner', expectedCapabilitySnapshotId: ${JSON.stringify(capability)},
              messageId: requestId === 'TEST-third' ? 'inbox-third' : 'inbox-TEST', text: 'synthetic followup', settlementMode: 'acceptance' } });
          const retry = await call('TEST-opencode.sendMessage-owner');
          if (!retry.ok || posts !== 1) throw new Error(retry.ok ? 'wrong post count' : retry.error.message);
          const duplicate = await call('TEST-opencode.sendMessage-owner');
          if (duplicate.ok || posts !== 1) throw new Error('duplicate retry admitted after restart');
          process.stdout.write(JSON.stringify({ posts, saved: await manager.readSavedOAuthCredential(profile) }));`
        const retrier = Bun.spawn([process.execPath, '-e', script], { env, stdout: 'pipe', stderr: 'pipe' })
        const [retryOut, retryError, retryCode] = await Promise.all([new Response(retrier.stdout).text(), new Response(retrier.stderr).text(), retrier.exited])
        expect(retryError).toBe(''); expect(retryCode).toBe(0)
        expect(JSON.parse(retryOut).posts).toBe(1)
        console.log('UNSUBMITTED fresh-process retry', retryOut)
        const after = (await outcomes.query({requestId:before.requestId})).record!
        expect(after.runtimePromptMessageId).not.toBe(before.runtimePromptMessageId)
        expect(after.safeToRetry).toBe(false)
      }
      expect((await call('opencode.sendMessage')).ok).toBe(false)
      expect(posts).toBe(expectedPosts) // successful retry occurred only in the child
      if (!retryable) expect((await outcomes.query({requestId:before.requestId})).record!.runtimePromptMessageId).toBe(before.runtimePromptMessageId)
    } finally {
      for (const mock of restores.reverse()) mock.mockRestore()
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
      Object.assign(process.env, savedEnv)
    }
  })
})
