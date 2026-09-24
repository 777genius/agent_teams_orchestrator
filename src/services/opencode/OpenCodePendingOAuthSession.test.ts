import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
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
import { normalizeOpenCodeProjectIdentity } from './OpenCodeProjectIdentity.js'
import { readOpenCodeAuthCredential, upsertOpenCodeAuthCredential, type OpenCodeOAuthNativeSessionOwner } from './OpenCodeAuthStore.js'
import type { OpenCodeHostHandle, OpenCodePreparedProfile, OpenCodeSessionRecord } from './types.js'

const c0 = { type: 'oauth', access: 'TEST-C0', refresh: 'single-use-C0', expires: 4000000000000, accountId: 'TEST' }
const c1 = { ...c0, access: 'TEST-C1', refresh: 'single-use-C1', expires: 4000003600000 }
const terminalMessages = (messageId: string) => [
  { info: { id: messageId, role: 'user' }, parts: [] },
  { info: { id: 'assistant', role: 'assistant', parentID: messageId, providerID: 'xai', modelID: 'grok-4.3', time: { completed: 1 } }, parts: [] },
]
const leaseKeyFor = (record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName' | 'opencodeSessionId'>) =>
  `${record.teamId}::${record.laneId}::${record.memberName}::session:${record.opencodeSessionId}`

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
    const leaseKey = leaseKeyFor(record)
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

  test('relay recovery observes both owned sessions while the shared OAuth writer is pending', async () => {
    // The selected members share the native host and one saved-publication slot.
    const other = { ...owner.record, memberName: 'other', runId: 'run-2', opencodeSessionId: 'other-session' }
    await sessionStore.upsert(other)
    const leases = registry.hosts[owner.record.hostKey].leases
    leases[leaseKeyFor(other)] = { ...leases[leaseKeyFor(owner.record)],
      leaseKey: leaseKeyFor(other), memberName: other.memberName, runId: other.runId, sessionId: other.opencodeSessionId }
    await saveRegistry()
    await arm()
    status = { type: 'busy' }
    messages = terminalMessages(owner.messageId)
    messages[1].info.finish = 'tool-calls'
    const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
    const receipt = await readFile(receiptPath, 'utf8')
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    const nativeAuth = await readFile(profile.managedAuthPath, 'utf8')
    const observationBridge = new OpenCodeSessionBridge({
      hostManager: new OpenCodeHostManager({ persistentRegistryPath: registryPath }), sessionStore,
      clientFactory: { create: () => ({ getSessionStatus: () => readStatusMap(),
        getPermissions: async () => [], getSessionMessages: async (id: string) => id === other.opencodeSessionId ? [] : messages,
      }) as never },
      prepareProfile: async () => { throw new Error('Observation must not prepare or reconcile native credentials') },
    })
    // Source resolution in the baseline uses ambient paths; isolate those too.
    const savedEnv = { ...process.env }
    Object.assign(process.env, env)
    try {
      const observed = await observationBridge.reconcileSession(owner.record)
      expect(observed.summary.rawStatus).toBe('busy')
      await observationBridge.reconcileSession(other)
      expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
      expect(await readFile(profile.managedAuthPath, 'utf8')).toBe(nativeAuth)
      expect(await readSaved()).toEqual(c0)
      // Reading the first turn must not admit a second credential consumer.
      let submissions = 0
      await expect(manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
        operation: async () => { submissions += 1 },
      })).rejects.toThrow('pending')
      expect(submissions).toBe(0)
      await expect(resolve()).rejects.toThrow('pending')
      // A terminal assistant after the tool step is still insufficient while busy.
      messages.push({ ...terminalMessages(owner.messageId)[1], info: {
        ...terminalMessages(owner.messageId)[1].info, id: 'terminal-assistant', finish: 'stop',
      } })
      await expect(resolve()).rejects.toThrow('pending')
      status = 'idle'
      await resolve()
      expect(await readSaved()).toEqual(c1)
      expect(await Bun.file(receiptPath).exists()).toBe(false)
      await observationBridge.reconcileSession(owner.record)
      // The original exact stored session/run survives observation and recovery.
      expect((await sessionStore.get('TEST', 'primary', 'owner'))?.opencodeSessionId).toBe(owner.record.opencodeSessionId)
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
      Object.assign(process.env, savedEnv)
    }
  })

  test.each(['ok', 'no-reply', 'rotated', 'persist-race', 'rotated-account', 'rotated-source', 'rotated-native', 'rotated-host', 'rotated-run', 'rotated-session', 'rotated-proof', 'rotated-peer', 'rotated-cas', 'rotated-config', 'rotated-model', 'rotated-provider', 'rotated-permission', 'rotated-mcp', 'rotated-project', 'lease', 'birth', 'session', 'capability', 'cancel-entry', 'cancel-read', 'lease-read', 'birth-read', 'session-read', 'cancel-observe', 'lease-observe', 'birth-observe', 'session-observe'])
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
    let onMcp: (() => Promise<void>) | undefined
    let onHistory: (() => Promise<void>) | undefined
    const histories = new Map<string, any[]>()
    const statuses: Record<string, unknown> = {}
    const mcp = { 'agent-teams': { status: 'connected' } }
    let liveDrift = false
    const client = { getSessionStatus: async () => statuses,
      getSessionMessages: async (id: string) => { await onHistory?.(); return histories.get(id) ?? [] }, getPermissions: async () => [],
      getMcp: async () => { await onMcp?.(); return mcp },
      getConfig: async () => {
        const config = JSON.parse(JSON.stringify(profile.managedConfig).replace(/\{env:([^}]+)\}/g, (_match, name) => profile.env[name] || ''))
        if (liveDrift && scenario === 'rotated-model') config.model = 'xai/foreign'
        if (liveDrift && scenario === 'rotated-provider') config.provider.xai = { ...config.provider.xai, options: { baseURL: 'https://example.invalid' } }
        if (liveDrift && scenario === 'rotated-permission') config.permission = { bash: 'deny' }
        if (liveDrift && scenario === 'rotated-mcp') config.mcp['agent-teams'] = { type: 'remote', url: 'http://127.0.0.1:2/mcp' }
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
      leases[leaseKeyFor(other)] = { ...leases[leaseKeyFor(owner.record)], leaseKey: leaseKeyFor(other),
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
      const capability = `opencode:${hashStable({ version: 'TEST', projectPath: normalizeOpenCodeProjectIdentity(project),
        projectBehaviorFingerprint: profile.projectBehaviorFingerprint, managedConfigFingerprint: profile.managedConfigFingerprint,
        mcpServers: ['agent-teams'], providers: [] }).slice(0, 32)}`
      const call = (command: string, member = 'owner', extra: Record<string, unknown> = {}, signal?: AbortSignal) => execute({
        schemaVersion: 1, command, requestId: `TEST-${command}-${member}`, cwd: project,
        startedAt: new Date().toISOString(),
        // The production path issues several real PowerShell process-identity
        // probes on Windows. Keep the fixture command budget above their cold
        // runner latency; production deadlines are unchanged.
        timeoutMs: process.platform === 'win32' ? 30_000 : 10_000,
        body: { teamId: 'TEST', laneId: 'primary', runId: 'run-1', memberName: member,
          // Keep each member's delivery identity stable from blocked send through retry.
          deliveryAttemptId: `attempt-${member}`,
          expectedCapabilitySnapshotId: capability, messageId: member === 'owner' ? 'inbox-TEST' : 'inbox-other',
          runtimePromptMessageId: owner.messageId, sessionId: member === 'owner' ? 'native-session' : 'other-session',
          text: 'synthetic followup', settlementMode: 'acceptance', ...(scenario === 'no-reply' ? { noReply: true } : {}), ...extra },
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
      if (!['ok', 'no-reply', 'persist-race'].includes(scenario) && !scenario.startsWith('rotated')) {
        const controller = new AbortController()
        const mutate = async () => {
          if (scenario.startsWith('lease')) registry.hosts[owner.record.hostKey].leases = {}
          if (scenario.startsWith('birth')) registry.hosts[owner.record.hostKey].processStartedAtMs += 1
          if (scenario.startsWith('session')) {
            const stored = JSON.parse(await readFile(sessionPath, 'utf8'))
            for (const record of Object.values(stored.records) as any[]) if (record.memberName === 'owner') record.opencodeSessionId = 'replacement'
            await writeFile(sessionPath, JSON.stringify(stored))
          }
          if (scenario.startsWith('cancel')) controller.abort(new Error('TEST cancelled'))
          await saveRegistry()
        }
        if (scenario.endsWith('-read')) onMcp = mutate
        else if (scenario.endsWith('-observe')) onHistory = mutate
        else await mutate()
        const result = await call(scenario.endsWith('-observe') ? 'opencode.observeMessageDelivery' : 'opencode.handshake', 'owner', { requiredCommand: 'opencode.sendMessage',
          ...(scenario === 'capability' ? { expectedCapabilitySnapshotId: 'opencode:' + '0'.repeat(32) } : {}),
        }, controller.signal)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.message).toMatch(/ownership|no longer active|authority changed|cancelled|precondition mismatch/)
        expect(posts).toBe(0)
        expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
        expect(await readFile(profile.managedAuthPath, 'utf8')).toBe(nativeAuth)
        expect(await readSaved()).toEqual(c0)
        return
      }
      if (scenario === 'persist-race') {
        let injected = false
        const original = sessionStore.upsert.bind(sessionStore)
        restores.push(spyOn(sessionStore, 'upsert').mockImplementation(async (...args) => {
          if (!injected) {
            injected = true
            await original({ ...(await sessionStore.get('TEST', 'primary', 'owner'))!, expectedBehaviorFingerprint: 'a'.repeat(64) })
          }
          return original(...args)
        }))
        expect((await call('opencode.observeMessageDelivery', 'owner')).ok).toBe(false)
        expect(injected).toBe(true)
        expect((await sessionStore.get('TEST', 'primary', 'owner'))?.expectedBehaviorFingerprint).toBe('a'.repeat(64))
        expect(posts).toBe(0)
        expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
        expect(await readFile(profile.managedAuthPath, 'utf8')).toBe(nativeAuth)
        return
      }
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
        liveDrift = true
        if (scenario === 'rotated-config') await writeFile(path.join(project, 'opencode.json'), JSON.stringify({ model: 'xai/foreign' }))
        if (scenario === 'rotated-project') await writeFile(path.join(project, 'AGENTS.md'), 'Changed project instructions')
        if (scenario === 'rotated-source') await writeFile(global, JSON.stringify({ xai: { ...c1, refresh: 'new-login' } }))
        if (scenario === 'rotated-native') await writeFile(profile.managedAuthPath, JSON.stringify({ xai: { ...c1, refresh: 'unowned-native' } }))
        if (scenario === 'rotated-host') { registry.hosts[owner.record.hostKey].processStartedAtMs += 1; await saveRegistry() }
        if (['rotated-run', 'rotated-session', 'rotated-proof', 'rotated-peer'].includes(scenario)) {
          const stored = JSON.parse(await readFile(sessionPath, 'utf8'))
          for (const record of Object.values(stored.records) as OpenCodeSessionRecord[]) {
            if (record.memberName !== (scenario === 'rotated-peer' ? 'other' : 'owner')) continue
            if (scenario === 'rotated-run' || scenario === 'rotated-peer') record.runId = 'newer-run'
            if (scenario === 'rotated-session') record.opencodeSessionId = 'newer-session'
            if (scenario === 'rotated-proof') record.expectedBehaviorFingerprint = 'a'.repeat(64)
          }
          await writeFile(sessionPath, JSON.stringify(stored))
          if (scenario === 'rotated-peer') {
            registry.hosts[owner.record.hostKey].leases[leaseKeyFor(other)].runId = 'newer-run'
            await saveRegistry()
            expect(await manager.readCompletedSessionOAuthRotation((await sessionStore.get('TEST', 'primary', 'other'))!, env)).toBeNull()
            expect((await call('opencode.sendMessage', 'other', { runId: 'newer-run' })).ok).toBe(false)
            expect(posts).toBe(0)
            return
          }
        }
        if (scenario === 'rotated-cas') {
          // Competing publication between the operation's captured proof and arm.
          const original = outcomes.upsert.bind(outcomes)
          restores.push(spyOn(outcomes, 'upsert').mockImplementation(async (...args) => {
            const result = await original(...args)
            if (args[0].status === 'prompt_submitting') {
              const file = `${global}.agent-teams-xai-oauth-successor.json`
              const competing = JSON.parse(await readFile(file, 'utf8'))
              competing.operationId = 'newer-publication'
              await writeFile(file, JSON.stringify(competing))
            }
            return result
          }))
        }
        const savedBefore = await readFile(global, 'utf8')
        const managedBefore = await readFile(profile.managedAuthPath, 'utf8')
        expect((await call('opencode.sendMessage', 'owner')).ok).toBe(false)
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
            startedAt: new Date().toISOString(), timeoutMs: process.platform === 'win32' ? 30000 : 10000,
            body: { teamId: 'TEST', laneId: 'primary', runId: 'run-1', memberName: 'owner', expectedCapabilitySnapshotId: ${JSON.stringify(capability)},
              deliveryAttemptId: requestId === 'TEST-third' ? 'attempt-third' : 'attempt-owner',
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
    // This multi-command integration scenario performs real process-birth queries.
    // Windows starts PowerShell for each query; keep the test harness deadline
    // separate from the unchanged per-command and process-query deadlines.
  }, process.platform === 'win32' ? 180_000 : 30_000)

  test.each(['tool-calls', 'unknown', 'empty-error'])('relay recovery retains a completed %s step until the terminal assistant', async finish => {
    await arm()
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    messages = terminalMessages(owner.messageId)
    messages[1].info.finish = finish === 'empty-error' ? 'tool-calls' : finish
    if (finish === 'empty-error') messages[1].info.error = {}
    await expect(resolve()).rejects.toThrow('pending')
    expect(await readSaved()).toEqual(c0)
    messages.push({ info: { ...terminalMessages(owner.messageId)[1].info, id: 'terminal', finish: 'stop' }, parts: [] })
    await resolve()
    expect(await readSaved()).toEqual(c1)
  })

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
    const script = `import { spyOn } from 'bun:test';
      const { openCodeClientFactory } = await import(${JSON.stringify(path.join(import.meta.dir, 'OpenCodeClientFactory.ts'))});
      spyOn(openCodeClientFactory, 'create').mockImplementation(() => ({ getSessionStatus: async () => ({ 'native-session': 'idle' }),
        getSessionMessages: async () => ${JSON.stringify(terminalMessages(owner.messageId))} }));
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
    if (mutation === 'lease-run') host.leases[leaseKeyFor(owner.record)].runId = 'foreign'
    if (mutation === 'lease-session') host.leases[leaseKeyFor(owner.record)].sessionId = 'foreign'
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

  test.each(['success', 'provider-error', 'uncertain-submit'])('scoped readiness preserves native sparse-map outcome: %s', async outcome => {
    let submissions = 0
    const clientFactory = new OpenCodeClientFactory({ fetchImpl: (async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/session' && init?.method === 'POST') return Response.json({ id: 'native-session' })
      if (url.pathname === '/session/native-session/prompt_async') {
        submissions += 1
        const prompt = JSON.parse(String(init?.body))
        messages = terminalMessages(prompt.messageID)
        await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
        if (outcome === 'uncertain-submit') {
          messages.pop()
          throw new Error('TEST connection reset after submission')
        }
        if (outcome === 'provider-error') {
          messages[1].info.error = { name: 'APIError', data: { message: 'TEST provider denied model access', statusCode: 403 } }
        } else messages[1].parts = [{ type: 'text', text: 'PONG' }]
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/session/status') return Response.json({})
      if (url.pathname === '/session/native-session/message') return Response.json(messages)
      if (url.pathname.startsWith('/session/native-session/message/')) return Response.json(messages[0])
      if (url.pathname === '/session/native-session/abort') return Response.json(true)
      throw new Error(`Unexpected TEST request: ${init?.method ?? 'GET'} ${url.pathname}`)
    }) as typeof fetch })
    const host: OpenCodeHostHandle = { hostKey: owner.record.hostKey, profileRootKey: profile.profileRootKey,
      projectPath: project, projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      baseUrl: owner.baseUrl, port: 43210, pid: owner.pid, processStartedAtMs: owner.processStartedAtMs,
      version: '1.18.4-fixture', state: 'healthy', profile,
      resolvedConfigFingerprint: profile.managedConfigFingerprint, diagnostics: [] }
    const probe = new OpenCodeExecutionProbe({ hostManager: {
      // These OAuth tests supply synthetic hosts; registry concurrency has its own fixtures.
      ensureHost: async () => { throw new Error('Synthetic OAuth fixture cannot spawn a host') },
      releaseHost: async () => {},
      withHostOperation: async (_host, _owner, operation) => operation(),
    },  clientFactory, pollIntervalMs: 1, probeTimeoutMs: 1000 })
    const run = () => probe.probeModelOnHost({ host, projectPath: project, selectedModel: 'xai/grok-4.3' })
    if (outcome === 'uncertain-submit') {
      await expect(run()).rejects.toThrow('settlement is unconfirmed')
      const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
      const receipt = await readFile(receiptPath, 'utf8')
      await expect(run()).rejects.toThrow('pending')
      expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
      expect(await readSaved()).toEqual(c0)
    } else {
      const result = await run()
      // Preserve the existing classifier's HTTP 403 result and provider reason.
      expect(result.outcome).toBe(outcome === 'success' ? 'available' : 'not_authenticated')
      if (outcome === 'success') expect(result.reason).toBeNull()
      else expect(result.reason).toContain('TEST provider denied model access')
      expect(await readSaved()).toEqual(c1)
      expect(await Bun.file(`${global}.agent-teams-xai-oauth-save.json`).exists()).toBe(false)
    }
    expect(submissions).toBe(1)
  })

  describe.each(['probe', 'session'] as const)('native sparse status map: %s', kind => {
    const armPending = () => manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
      operation: async (armSession, armProbe) => {
        if (kind === 'session') await armSession(owner)
        else await armProbe({ projectPath: project, scopeToken: profile.scopeToken!, profileRootKey: profile.profileRootKey,
          hostKey: owner.record.hostKey, baseUrl: owner.baseUrl, pid: owner.pid, processStartedAtMs: owner.processStartedAtMs,
          selectedModel: owner.record.selectedModel, sessionId: owner.record.opencodeSessionId, messageId: owner.messageId })
      }, isNativeSettled: () => false, allowNativeContinuation: true })

    test.each(['empty', 'other-busy', 'provider-error'])('publishes exact terminal prompt with omitted idle entry: %s', async variant => {
      await armPending()
      await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
      messages = terminalMessages(owner.messageId)
      // OpenCode v1.18.4 SessionStatus.set(idle) deletes the entry; the HTTP
      // handler returns Object.fromEntries(list()), including only active sessions.
      readStatusMap = async () => variant === 'other-busy' ? { other: { type: 'busy' } } : {}
      if (variant === 'provider-error') {
        delete messages[1].info.time.completed
        messages[1].info.error = { name: 'APIError', data: { message: 'TEST provider rejected request', statusCode: 403 } }
      }
      await resolve()
      expect(await readSaved()).toEqual(c1)
      expect(await Bun.file(`${global}.agent-teams-xai-oauth-save.json`).exists()).toBe(false)
    })

    test.each(['user-only', 'wrong-parent', 'wrong-model', 'wrong-provider', 'no-user', 'step-only',
      'busy', 'retry', 'null-entry', 'undefined-entry', 'unknown-entry', 'null-map', 'array-map', 'string-map',
      'undefined-map', 'status-failed', 'busy-after-history', 'status-failed-after-history', 'owner-changed',
    ])('retains receipt and fences resubmission without settlement proof: %s', async mutation => {
      await armPending()
      const receiptPath = `${global}.agent-teams-xai-oauth-save.json`
      const receipt = await readFile(receiptPath, 'utf8')
      await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
      messages = terminalMessages(owner.messageId)
      readStatusMap = async () => ({})
      if (mutation === 'user-only') messages.pop()
      if (mutation === 'wrong-parent') messages[1].info.parentID = 'foreign'
      if (mutation === 'wrong-model') messages[1].info.modelID = 'foreign'
      if (mutation === 'wrong-provider') messages[1].info.providerID = 'foreign'
      if (mutation === 'no-user') messages.shift()
      if (mutation === 'step-only') { delete messages[1].info.time.completed; messages[1].parts = [{ type: 'step-finish' }] }
      if (mutation === 'busy' || mutation === 'retry') readStatusMap = async () => ({ 'native-session': { type: mutation } })
      if (mutation === 'null-entry') readStatusMap = async () => ({ 'native-session': null })
      if (mutation === 'undefined-entry') readStatusMap = async () => ({ 'native-session': undefined })
      if (mutation === 'unknown-entry') readStatusMap = async () => ({ 'native-session': { type: 'unknown' } })
      if (mutation === 'null-map') readStatusMap = async () => null
      if (mutation === 'array-map') readStatusMap = async () => []
      if (mutation === 'string-map') readStatusMap = async () => 'idle'
      if (mutation === 'undefined-map') readStatusMap = async () => undefined
      if (mutation === 'status-failed') readStatusMap = async () => { throw new Error('TEST status unavailable') }
      if (mutation === 'busy-after-history') onRead = async () => { readStatusMap = async () => ({ 'native-session': { type: 'busy' } }) }
      if (mutation === 'status-failed-after-history') onRead = async () => { readStatusMap = async () => { throw new Error('TEST status unavailable') } }
      if (mutation === 'owner-changed') onRead = async () => {
        if (kind === 'session') await sessionStore.upsert({ ...owner.record, runId: 'replacement' })
        else owner.processStartedAtMs += 1
      }
      // Probe ownership comes from the persisted receipt, not this mutable test
      // object. Change its observed OS birth only through an exact process read.
      const birthSpy = mutation === 'owner-changed' && kind === 'probe'
        ? spyOn(await import('../../utils/processKill.js'), 'readProcessStartTimeMs')
          .mockImplementation(async () => owner.processStartedAtMs)
        : undefined
      try {
        await expect(resolve()).rejects.toThrow()
        let submissions = 0
        await expect(manager.withOwnedOAuthRefresh({ profile, assertHostOwnership: async () => {},
          operation: async () => { submissions += 1 },
        })).rejects.toThrow()
        expect(submissions).toBe(0)
        expect(await readSaved()).toEqual(c0)
        expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
      } finally { birthSpy?.mockRestore() }
    })
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
    expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey].leases[leaseKeyFor(owner.record)]).toBeDefined()
    expect((await sessionStore.get('TEST', 'primary', 'owner'))?.stoppedAt).toBeUndefined()
    expect(await readSaved()).toEqual(mutation === 'new-saved-successor' ? replacement : c0)
  })

  test('stopping a different run does not claim or cancel the pending native owner', async () => {
    await arm()
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    const peer = { ...owner.record, memberName: 'peer', runId: 'peer-run', opencodeSessionId: 'peer-session' }
    await sessionStore.upsert(peer)
    registry.hosts[owner.record.hostKey].leases[leaseKeyFor(peer)] = {
      ...registry.hosts[owner.record.hostKey].leases[leaseKeyFor(owner.record)], leaseKey: leaseKeyFor(peer),
      memberName: 'peer', runId: peer.runId, sessionId: peer.opencodeSessionId,
    }
    await saveRegistry()
    const before = await readFile(`${global}.agent-teams-xai-oauth-save.json`, 'utf8')
    await bridge.releaseSession(peer, { strictLeaseRelease: true })
    expect(abortCalls).toBe(0)
    expect(await readFile(`${global}.agent-teams-xai-oauth-save.json`, 'utf8')).toBe(before)
    expect(await readSaved()).toEqual(c0)
    expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey].leases[leaseKeyFor(owner.record)]).toBeDefined()
  })

  test('fresh-process Stop saves owned C1 before revoking its lease and new resolution reuses C1', async () => {
    await arm()
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    const script = `import { spyOn } from 'bun:test';
      const { openCodeClientFactory } = await import(${JSON.stringify(path.join(import.meta.dir, 'OpenCodeClientFactory.ts'))});
      spyOn(openCodeClientFactory, 'create').mockImplementation(() => ({ getSessionStatus: async () => ({ 'native-session': 'idle' }),
        getSessionMessages: async () => ${JSON.stringify(terminalMessages(owner.messageId).slice(0, 1))}, abortSession: async () => true }));
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
    expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[owner.record.hostKey].leases[leaseKeyFor(owner.record)]).toBeUndefined()
  })

  test('uncertain HTTP failure leaves native ownership available for later terminal recovery', async () => {
    await expect(arm(true)).rejects.toThrow('uncertain HTTP')
    await writeFile(profile.managedAuthPath, JSON.stringify({ xai: c1 }))
    messages = terminalMessages(owner.messageId)
    await resolve()
    expect(await readSaved()).toEqual(c1)
  })
})
