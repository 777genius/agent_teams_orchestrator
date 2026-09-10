// Adapted from the independent reviewer retained-evidence fixture; synthetic transport only.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readProcessStartTimeMs } from '../../utils/processKill.js'
import { OpenCodeProfileManager, resolveOpenCodeProfileScope } from './OpenCodeProfileManager.js'
import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
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

describe('retained completed OAuth continuation evidence', () => {
  let root: string, project: string, global: string, registryPath: string, sessionPath: string
  let env: NodeJS.ProcessEnv, profile: OpenCodePreparedProfile, owner: OpenCodeOAuthNativeSessionOwner
  let registry: any
  let sessionStore: OpenCodeSessionStore
  const manager = new OpenCodeProfileManager()
  const readSaved = () => manager.readSavedOAuthCredential(profile)
  const saveRegistry = () => writeFile(registryPath, JSON.stringify(registry))
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
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test.each(['rotated', 'rotated-missing-message', 'rotated-missing-noReply', 'rotated-missing-completion', 'rotated-old-format', 'rotated-missing-file', 'rotated-malformed-json', 'rotated-unrelated-owner', 'rotated-unrelated-predecessor', 'rotated-revoked', 'rotated-missing-cohort', 'rotated-missing-binding', 'rotated-bad-binding', 'rotated-bad-binding-version', 'rotated-empty-message', 'rotated-bad-noReply', 'rotated-null-record', 'rotated-foreign-cohort-host', 'rotated-foreign-cohort-scope', 'rotated-duplicate-cohort', 'rotated-null-cohort-member', 'rotated-bad-pid', 'rotated-bad-birth', 'rotated-bad-operation', 'rotated-bad-launch', 'rotated-null-launch'])
    ('production relay handshake -> observe -> send: %s', async scenario => {
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
        expect(body.model).toEqual({ providerID: 'xai', modelID: 'grok-4.3' })
        histories.set(id, [...(histories.get(id) ?? []), { info: { id: body.messageID, role: 'user' }, parts: body.parts }])
        statuses[id] = { type: 'busy' }
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
      const call = (command: string, member = 'owner', extra: Record<string, unknown> = {}, signal?: AbortSignal) => execute({
        schemaVersion: 1, command, requestId: `TEST-${command}-${member}`, cwd: project,
        startedAt: new Date().toISOString(), timeoutMs: 10_000,
        body: { teamId: 'TEST', laneId: 'primary', runId: 'run-1', memberName: member,
          expectedCapabilitySnapshotId: capability, messageId: 'inbox-TEST',
          runtimePromptMessageId: owner.messageId, sessionId: member === 'owner' ? 'native-session' : 'other-session',
          text: 'synthetic followup', settlementMode: 'acceptance', ...extra },
      }, { signal })
      await arm()
      histories.set('native-session', terminalMessages(owner.messageId))
      histories.get('native-session')![1].info.finish = 'tool-calls'
      statuses['native-session'] = { type: 'busy' }
      statuses['other-session'] = { type: 'busy' }
      if (scenario.startsWith('rotated')) await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
      const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
      const receipt = await readFile(receiptPath, 'utf8')
      const nativeAuth = await readFile(profile.managedAuthPath, 'utf8')
      for (const member of ['owner', 'other']) {
        for (const requiredCommand of ['opencode.sendMessage', 'opencode.observeMessageDelivery']) {
          const handshake = await call('opencode.handshake', member, { requiredCommand })
          expect(handshake.ok ? null : handshake.error.message).toBeNull()
          if (handshake.ok) expect(handshake.runtime.capabilitySnapshotId).toBe(capability)
        }
        const observed = await call('opencode.observeMessageDelivery', member)
        expect(observed.ok ? null : observed.error.message).toBeNull()
        if (observed.ok) expect(observed.runtime.capabilitySnapshotId).toBe(capability)
      }
      expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
      expect(await readFile(profile.managedAuthPath, 'utf8')).toBe(nativeAuth)
      expect(await readSaved()).toEqual(c0)
      const blocked = await call('opencode.sendMessage', 'other')
      expect(blocked.ok).toBe(false)
      if (!blocked.ok) expect(blocked.error.message).toContain('pending')
      expect(posts).toBe(0)
      delete statuses['native-session']
      for (const info of [
        { ...terminalMessages('foreign-parent')[1].info, id: 'foreign-parent-terminal', finish: 'stop' },
        { ...terminalMessages(owner.messageId)[1].info, id: 'foreign-model-terminal', modelID: 'foreign-model', finish: 'stop' },
      ]) {
        histories.get('native-session')!.push({ info, parts: [] })
        const refused = await call('opencode.sendMessage', 'other')
        expect(refused.ok).toBe(false)
        if (!refused.ok) expect(refused.error.message).toContain('pending')
        expect(posts).toBe(0)
        expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
        expect(await readSaved()).toEqual(c0)
      }
      histories.get('native-session')!.push({ info: { ...terminalMessages(owner.messageId)[1].info,
        id: 'terminal', finish: 'stop' }, parts: [{ type: 'text', text: 'done' }] })
      // Another session's busy status cannot invalidate the exact owner's idle.
      delete statuses['native-session']
      if (scenario.startsWith('rotated-')) {
        if (scenario === 'rotated-account') await writeFile(profile.managedAuthPath, JSON.stringify({ xai: { ...c1, accountId: 'foreign' } }))
        else await resolveOpenCodeProfileScope({ projectPath: project, selectedModel: owner.record.selectedModel, purpose: 'launch_runtime', env })
        const evidencePath = `${global}.agent-teams-xai-oauth-successor.json`
        const retained = JSON.parse(await readFile(evidencePath, 'utf8'))
        if (scenario === 'rotated-missing-message') delete retained.completion.nativeSession.messageId
        if (scenario === 'rotated-missing-noReply') delete retained.completion.nativeSession.noReply
        if (scenario === 'rotated-missing-completion') delete retained.completion
        if (scenario === 'rotated-old-format') { delete retained.completion.nativeSession.sessionAuthorities; delete retained.owner.credentialBinding }
        if (scenario === 'rotated-unrelated-owner') retained.completion.nativeSession.record.runId = 'unrelated-completing-run'
        if (scenario === 'rotated-unrelated-predecessor') retained.predecessor = { ...c1, refresh: 'unrelated-predecessor', access: 'unrelated-predecessor' }
        if (scenario === 'rotated-missing-cohort') delete retained.completion.nativeSession.sessionAuthorities
        if (scenario === 'rotated-missing-binding') delete retained.owner.credentialBinding
        if (scenario === 'rotated-bad-binding') retained.owner.credentialBinding.fingerprint = 'f'.repeat(64)
        if (scenario === 'rotated-bad-binding-version') retained.owner.credentialBinding.version = 2
        if (scenario === 'rotated-empty-message') retained.completion.nativeSession.messageId = ' '
        if (scenario === 'rotated-bad-noReply') retained.completion.nativeSession.noReply = 'false'
        if (scenario === 'rotated-null-record') retained.completion.nativeSession.record = null
        if (scenario === 'rotated-foreign-cohort-host') retained.completion.nativeSession.sessionAuthorities[1].hostKey = 'foreign'
        if (scenario === 'rotated-foreign-cohort-scope') retained.completion.nativeSession.sessionAuthorities[1].profileScope.scopeToken = 'f'.repeat(64)
        if (scenario === 'rotated-duplicate-cohort') retained.completion.nativeSession.sessionAuthorities.push(retained.completion.nativeSession.sessionAuthorities[0])
        if (scenario === 'rotated-null-cohort-member') retained.completion.nativeSession.sessionAuthorities.push(null)
        if (scenario === 'rotated-bad-pid') retained.completion.nativeSession.pid = -1
        if (scenario === 'rotated-bad-birth') retained.completion.nativeSession.processStartedAtMs = 0
        if (scenario === 'rotated-bad-operation') retained.operationId = ''
        if (scenario === 'rotated-null-launch') retained.owner.launchCredential = null
        if (scenario === 'rotated-bad-launch') retained.owner.launchCredential = { ...c0, refresh: 'unproven-launch' }
        await writeFile(evidencePath, JSON.stringify(retained))
        if (scenario === 'rotated-missing-file') await rm(evidencePath)
        if (scenario === 'rotated-malformed-json') await writeFile(evidencePath, '{')
        if (scenario === 'rotated-revoked') await writeFile(`${receiptPath}.revoked-${createHash('sha256').update(c0.refresh).digest('hex')}`, '{}')
        let freshAllowed: boolean | undefined
        {
          const script = `import { OpenCodeProfileManager } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeProfileManager.ts'))};
            import { OpenCodeSessionStore } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeSessionStore.ts'))};
            const record = await new OpenCodeSessionStore(${JSON.stringify(sessionPath)}).get('TEST','primary','owner');
            let allowed = false;
            try { allowed = !!await new OpenCodeProfileManager().prepareOwnedOAuthSessionProfile(record); } catch {}
            process.stdout.write(JSON.stringify({allowed}));`;
          const child = Bun.spawn([process.execPath, '-e', script], {env, stdout:'pipe',stderr:'pipe'});
          const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
          console.log('fresh-process retained evidence', JSON.stringify({ scenario, code, out, err }));
          expect(code).toBe(0); expect(err).toBe(''); freshAllowed = JSON.parse(out).allowed;
        }
        const savedBefore = await readFile(global, 'utf8')
        const managedBefore = await readFile(profile.managedAuthPath, 'utf8')
        const admitted = await call('opencode.sendMessage', 'owner')
        console.log('retained evidence', JSON.stringify({scenario, ok: admitted.ok, posts, error: admitted.ok ? null : admitted.error.message}))
        expect(freshAllowed).toBe(false)
        expect(admitted.ok).toBe(false)
        expect(posts).toBe(0)
        expect(await readFile(global, 'utf8')).toBe(savedBefore)
        expect(await readFile(profile.managedAuthPath, 'utf8')).toBe(managedBefore)
        return
      }
      const sent = await call('opencode.sendMessage', 'owner')
      expect(sent.ok ? null : sent.error.message).toBeNull()
      expect(posts).toBe(1)
      if (sent.ok) expect(sent.runtime.capabilitySnapshotId).toBe(capability)
      expect(await readSaved()).toEqual(scenario === 'rotated' ? c1 : c0)
      const nextReceipt = JSON.parse(await readFile(receiptPath, 'utf8'))
      expect(nextReceipt.nativeSession.record.opencodeSessionId).toBe('native-session')
      expect(nextReceipt.nativeSession.messageId).not.toBe(owner.messageId)
      const accepted = JSON.parse(await readFile(path.join(root, 'outcomes.json'), 'utf8'))
      expect(JSON.stringify(accepted)).toContain(nextReceipt.nativeSession.messageId)
      // Observe/retry while the newly admitted turn owns the fence: no duplicate POST.
      expect((await call('opencode.observeMessageDelivery', 'owner', { runtimePromptMessageId: nextReceipt.nativeSession.messageId })).ok).toBe(true)
      expect((await call('opencode.sendMessage', 'owner')).ok).toBe(false)
      expect(posts).toBe(1)
      histories.get('native-session')!.push({ info: { ...terminalMessages(nextReceipt.nativeSession.messageId)[1].info,
        id: 'followup-terminal', finish: 'stop' }, parts: [] })
      delete statuses['native-session']
      delete statuses['other-session']
      // Terminal settlement is not permission to reuse a delivery attempt.
      expect((await call('opencode.sendMessage', 'owner')).ok).toBe(false)
      expect(posts).toBe(1)
      expect((await outcomes.query({ requestId: 'TEST-opencode.sendMessage-owner' })).record?.runtimePromptMessageId)
        .toBe(nextReceipt.nativeSession.messageId)
      const c2 = { ...c1, access: 'TEST-C2', refresh: 'single-use-C2', expires: c1.expires + 3600000 }
      if (scenario === 'rotated') await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c2 }))
      const second = await call('opencode.sendMessage', 'other', { messageId: 'inbox-other' })
      expect(second.ok ? null : second.error.message).toBeNull()
      expect(posts).toBe(2)
      const secondReceipt = JSON.parse(await readFile(receiptPath, 'utf8'))
      expect(secondReceipt.nativeSession.record.opencodeSessionId).toBe('other-session')
      expect(secondReceipt.nativeSession.messageId).not.toBe(nextReceipt.nativeSession.messageId)
      if (scenario === 'rotated') {
        expect(await readSaved()).toEqual(c2)
        expect(secondReceipt.predecessor).toEqual(c2)
        expect(secondReceipt.owner.launchCredential).toEqual(c0)
        expect(secondReceipt.nativeSession.sessionAuthorities).toHaveLength(2)
        const c3 = { ...c2, access: 'TEST-C3', refresh: 'single-use-C3', expires: c2.expires + 3600000 }
        await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c3 }))
        histories.get('other-session')!.push({ info: { ...terminalMessages(secondReceipt.nativeSession.messageId)[1].info,
          id: 'other-terminal', finish: 'stop' }, parts: [] })
        delete statuses['other-session']
        const atomic = await import('../../utils/atomicWrite.js')
        const originalWrite = atomic.writeJsonFileAtomic
        const crash = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation(async (...args) => {
          await originalWrite(...args)
          if (args[0] === `${global}.agent-teams-xai-oauth-successor.json`) throw new Error('TEST crash after publication')
        })
        try {
          await expect(resolveOpenCodeProfileScope({ projectPath: project, selectedModel: owner.record.selectedModel,
            purpose: 'launch_runtime', env })).rejects.toThrow('TEST crash after publication')
        } finally { crash.mockRestore() }
        expect(await Bun.file(receiptPath).exists()).toBe(true)
        // The restarted command has neither resolver snapshots nor in-memory
        // continuity. Recover the committed receipt and send through the CLI's
        // production handler using synthetic native transport only.
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
          if (retry.ok || posts !== 0) throw new Error('duplicate delivery admitted after restart');
          const sent = await call('TEST-third');
          if (!sent.ok || posts !== 1) throw new Error(sent.ok ? 'wrong post count' : sent.error.message);
          process.stdout.write(JSON.stringify({ posts, saved: await manager.readSavedOAuthCredential(profile) }));`
        const child = Bun.spawn([process.execPath, '-e', script], { env, stdout: 'pipe', stderr: 'pipe' })
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        expect(stderr).toBe(''); expect(code).toBe(0)
        expect(JSON.parse(stdout)).toEqual({ posts: 1, saved: c3 })
        expect(await readSaved()).toEqual(c3)
        const thirdReceipt = JSON.parse(await readFile(receiptPath, 'utf8'))
        expect(thirdReceipt.predecessor).toEqual(c3)
        expect(thirdReceipt.nativeSession.record.opencodeSessionId).toBe('native-session')
        expect(thirdReceipt.nativeSession.messageId).not.toBe(nextReceipt.nativeSession.messageId)
        expect((await outcomes.query({ requestId: 'TEST-third' })).record?.runtimePromptMessageId).toBe(thirdReceipt.nativeSession.messageId)
      }
      expect((await sessionStore.get('TEST', 'primary', 'owner'))?.opencodeSessionId).toBe('native-session')
    } finally {
      for (const mock of restores.reverse()) mock.mockRestore()
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
      Object.assign(process.env, savedEnv)
    }
  })

})
