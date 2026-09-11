import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readProcessStartTimeMs } from '../../utils/processKill.js'
import { OpenCodeProfileManager, resolveOpenCodeProfileScope } from './OpenCodeProfileManager.js'
import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { upsertOpenCodeAuthCredential, type OpenCodeOAuthNativeSessionOwner } from './OpenCodeAuthStore.js'
import type { OpenCodeHostHandle, OpenCodePreparedProfile, OpenCodeSessionRecord } from './types.js'

const c0 = { type: 'oauth', access: 'TEST-C0', refresh: 'single-use-C0', expires: 4000000000000, accountId: 'TEST' }
const terminalMessages = (messageId: string) => [
  { info: { id: messageId, role: 'user' }, parts: [] },
  { info: { id: 'assistant', role: 'assistant', parentID: messageId, providerID: 'xai', modelID: 'grok-4.3', time: { completed: 1 } }, parts: [] },
]

// Adapted from the independent no-reply acceptance reproducer: real admission,
// OAuth ownership and persistent outcomes, with synthetic host/transport only.
describe('noReply command acceptance persistence', () => {
  let root: string, project: string, global: string, registryPath: string, sessionPath: string
  let env: NodeJS.ProcessEnv, profile: OpenCodePreparedProfile, owner: OpenCodeOAuthNativeSessionOwner
  let registry: any
  let sessionStore: OpenCodeSessionStore
  const manager = new OpenCodeProfileManager()
  const saveRegistry = () => writeFile(registryPath, JSON.stringify(registry))
  const arm = () => manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
    operation: async armNative => {
      await armNative(owner)
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
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test.each(['normal', 'no-reply', 'no-reply-observed', 'lost-response', 'persistence-failure', 'replaced-owner'])
    ('native send, restart and duplicate: %s', async scenario => {
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
    let postedPrompt = ''
    const histories = new Map<string, any[]>()
    const statuses: Record<string, unknown> = {}
    const mcp = { 'agent-teams': { status: 'connected' } }
    const client = { getSessionStatus: async () => statuses,
      getSessionMessages: async (id: string) => { return histories.get(id) ?? [] }, getPermissions: async () => [],
      getMcp: async () => { return mcp },
      getConfig: async () => {
        const config = JSON.parse(JSON.stringify(profile.managedConfig).replace(/\{env:([^}]+)\}/g, (_match, name) => profile.env[name] || ''))
        return config
      },
      listAgents: async () => effectiveAgentsFixture(profile.managedConfig, profile.xdgDataHome),
      promptSessionAsync: async (id: string, body: any) => {
        posts += 1
        expect(body.noReply).toBe(scenario !== 'normal')
        postedPrompt = body.messageID
        expect(body.model).toEqual({ providerID: 'xai', modelID: 'grok-4.3' })
        histories.set(id, [...(histories.get(id) ?? []), { info: { id: body.messageID, role: 'user' }, parts: body.parts }])
        statuses[id] = { type: 'busy' }
        if (scenario === 'lost-response') throw new Error('TEST lost HTTP response after native submission')
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
      const outcomes = new OpenCodeCommandOutcomeStore(path.join(root, 'outcomes.json'))
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
      const call = (command: Parameters<typeof execute>[0]['command'], member = 'owner', extra: Record<string, unknown> = {}, signal?: AbortSignal) => execute({
        schemaVersion: 1, command, requestId: `TEST-${command}-${member}`, cwd: project,
        startedAt: new Date().toISOString(), timeoutMs: 10_000,
        body: { teamId: 'TEST', laneId: 'primary', runId: 'run-1', memberName: member,
          expectedCapabilitySnapshotId: capability, messageId: 'inbox-TEST',
          runtimePromptMessageId: owner.messageId, sessionId: member === 'owner' ? 'native-session' : 'other-session',
          text: 'synthetic followup', settlementMode: 'acceptance', noReply: scenario !== 'normal', ...extra },
      }, { signal })
      // Finish the prior exact native turn before admitting this delivery.
      await arm()
      histories.set('native-session', terminalMessages(owner.messageId))
      histories.get('native-session')![1].info.finish = 'stop'
      statuses['native-session'] = 'idle'
      expect((await call('opencode.handshake', 'owner', { requiredCommand: 'opencode.sendMessage' })).ok).toBe(true)
      expect((await call('opencode.observeMessageDelivery', 'owner')).ok).toBe(true)

      let persistenceFailures = 0
      const atomic = await import('../../utils/atomicWrite.js')
      const originalWrite = atomic.writeJsonFileAtomic
      restores.push(spyOn(atomic, 'writeJsonFileAtomic').mockImplementation(async (...args) => {
        if (scenario === 'persistence-failure' && posts > 0 && args[0] === path.join(root, 'outcomes.json')) {
          persistenceFailures += 1
          throw new Error('TEST outcome persistence failure')
        }
        return originalWrite(...args)
      }))
      let replacementInjected = false
      const upsert = outcomes.upsert.bind(outcomes)
      restores.push(spyOn(outcomes, 'upsert').mockImplementation(async (...args) => {
        if (scenario === 'replaced-owner' && args[0].status === 'reconciled') {
          const disk = JSON.parse(await readFile(path.join(root, 'outcomes.json'), 'utf8'))
          disk.records['TEST-opencode.sendMessage-owner'].runtimePromptMessageId = 'msg-TEST-replacement'
          await writeFile(path.join(root, 'outcomes.json'), JSON.stringify(disk))
          replacementInjected = true
        }
        return upsert(...args)
      }))
      const sent = await call('opencode.sendMessage', 'owner', {
        settlementMode: scenario === 'no-reply-observed' ? 'observed' : 'acceptance',
      })
      expect(sent.ok).toBe(scenario !== 'lost-response')
      expect(posts).toBe(1)
      expect(postedPrompt).toBeTruthy()
      if (sent.ok) expect(sent.data).toMatchObject({ accepted: true, runtimePromptMessageId: postedPrompt })
      else expect(sent.error.message).toContain('lost HTTP response')
      if (scenario === 'persistence-failure') expect(persistenceFailures).toBe(1)
      if (scenario === 'replaced-owner') expect(replacementInjected).toBe(true)
      const durableAcceptance = !['lost-response', 'persistence-failure', 'replaced-owner'].includes(scenario)
      const expectedPrompt = scenario === 'replaced-owner' ? 'msg-TEST-replacement' : postedPrompt
      const expectedStatus = durableAcceptance ? (scenario === 'normal' ? 'prompt_accepted' : 'reconciled') : 'prompt_submitting'
      // Reopen the actual file; do not rely on a live store or native transcript.
      const reopened = new OpenCodeCommandOutcomeStore(path.join(root, 'outcomes.json'))
      const stored = (await reopened.query({ requestId: 'TEST-opencode.sendMessage-owner' })).record!
      expect(stored).toMatchObject({ status: expectedStatus, safeToRetry: false,
        runtimePromptMessageId: expectedPrompt, sessionId: 'native-session', runId: 'run-1' })
      if (durableAcceptance) {
        expect(stored.acceptedAt).toBeTruthy()
        expect(stored.sendMessageData).toMatchObject({ accepted: true, runtimePromptMessageId: postedPrompt,
          sessionId: 'native-session', memberName: 'owner', runtimePid: process.pid })
        if (scenario !== 'normal') {
          expect(stored.completedAt).toBeTruthy()
          expect(stored.turnObservedAt).toBeNull()
        }
      } else {
        expect(stored.acceptedAt).toBeNull()
        expect(stored.sendMessageData).toBeUndefined()
      }
      const modulePath = (name: string) => JSON.stringify(path.join(import.meta.dir, name))
      const script = `
        import { openCodeCommandOutcomeStore, OpenCodeCommandOutcomeStore } from ${modulePath('OpenCodeCommandOutcomeStore.ts')};
        import { executeOpenCodeBridgeCommandEnvelope as execute } from ${modulePath('OpenCodeBridgeCommandHandler.ts')};
        import { openCodeHostManager } from ${modulePath('OpenCodeHostManager.ts')};
        import { openCodeClientFactory } from ${modulePath('OpenCodeClientFactory.ts')};
        import { openCodeProvisioningProbe } from ${modulePath('OpenCodeProvisioningProbe.ts')};
        const store = new OpenCodeCommandOutcomeStore(${JSON.stringify(path.join(root, 'outcomes.json'))});
        openCodeCommandOutcomeStore.query = store.query.bind(store);
        openCodeCommandOutcomeStore.upsert = store.upsert.bind(store);
        let nativeCalls = 0;
        openCodeHostManager.ensureHost = async () => { nativeCalls += 1; throw new Error('TEST must not launch host'); };
        openCodeClientFactory.create = () => { nativeCalls += 1; throw new Error('TEST must not contact native transport'); };
        openCodeProvisioningProbe.probeRetainingHost = async () => { nativeCalls += 1; throw new Error('TEST must not provision'); };
        const result = await execute({ schemaVersion: 1, requestId: 'query-after-restart', command: 'opencode.commandStatus',
          cwd: ${JSON.stringify(project)}, startedAt: new Date().toISOString(), timeoutMs: 10000,
          body: { originalRequestId: 'TEST-opencode.sendMessage-owner' } });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        // Duplicate admission is rejected from the durable outcome, even without
        // capability preflight or a live host in this fresh process.
        const duplicate = await execute({ schemaVersion: 1, requestId: 'TEST-opencode.sendMessage-owner',
          command: 'opencode.sendMessage', cwd: ${JSON.stringify(project)}, startedAt: new Date().toISOString(), timeoutMs: 10000,
          body: { teamId: 'TEST', laneId: 'primary', memberName: 'owner', runId: 'run-1',
            messageId: 'inbox-TEST', text: 'synthetic followup', noReply: ${scenario !== 'normal'} } });
        if (duplicate.ok || !duplicate.error.message.includes('already submitted')) throw new Error(JSON.stringify(duplicate));
        if (nativeCalls !== 0) throw new Error('TEST status/duplicate consulted native host');
        process.stdout.write(JSON.stringify(result.data));`
      const child = Bun.spawn([process.execPath, '-e', script], { env, stdout: 'pipe', stderr: 'pipe' })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(code).toBe(0)
      expect(err).toBe('')
      const recovered = JSON.parse(out)
      expect(recovered).toMatchObject({ status: expectedStatus, accepted: durableAcceptance,
        safeToRetry: false, runtimePromptMessageId: expectedPrompt, originalRequestId: stored.requestId })
      if (durableAcceptance) expect(recovered.sendMessageData).toEqual(stored.sendMessageData)
      // All terminal/uncertain outcomes remain fenced against duplicate POSTs.
      restores.push(spyOn(openCodeCommandOutcomeStore, 'query').mockImplementation((...args) => reopened.query(...args)))
      const duplicate = await call('opencode.sendMessage', 'owner')
      expect(duplicate.ok).toBe(false)
      if (!duplicate.ok) expect(duplicate.error.message).toContain('already submitted')
      expect(posts).toBe(1)
      const afterDuplicate = (await reopened.query({ requestId: stored.requestId })).record!
      expect(afterDuplicate.status).toBe(expectedStatus)
      expect(afterDuplicate.runtimePromptMessageId).toBe(expectedPrompt)
      const mismatch = await call('opencode.commandStatus', 'owner', {
        originalRequestId: stored.requestId, runId: 'foreign-run',
      })
      expect(mismatch.ok).toBe(true)
      if (mismatch.ok) expect(mismatch.data).toMatchObject({ accepted: false, safeToRetry: false, status: 'precondition_mismatch' })
    } finally {
      for (const mock of restores.reverse()) mock.mockRestore()
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
      Object.assign(process.env, savedEnv)
    }
  })
})
