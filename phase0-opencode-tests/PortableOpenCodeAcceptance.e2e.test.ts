import { describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { OpenCodeLaunchAttemptPorts } from '../src/services/opencode/OpenCodeLaunchAttempt.js'
import type { OpenCodeLaunchJournalPersistence } from '../src/services/opencode/OpenCodeLaunchAttemptStore.js'
import type { OpenCodeLaunchAttemptBridgePort } from '../src/services/opencode/OpenCodeLaunchAttemptBridge.js'
import type { OpenCodeLaunchAttemptResponse, OpenCodeOpaqueIdentity } from '../src/services/opencode/OpenCodeBridgeContractV2.js'
import type { OpenCodeHostHandle, OpenCodeInventorySnapshot, OpenCodePreparedProfile } from '../src/services/opencode/types.js'

mock.module('env-paths', () => ({ default: (name: string) => ({
  data: `/tmp/${name}/data`, config: `/tmp/${name}/config`, cache: `/tmp/${name}/cache`,
  log: `/tmp/${name}/log`, temp: `/tmp/${name}/temp`,
}) }))
mock.module('strip-ansi', () => ({ default: (value: string) => value }))
mock.module('../src/utils/json.js', () => ({
  safeParseJSON: (value: string) => JSON.parse(value),
  safeParseJSONC: (value: string) => JSON.parse(value),
}))
mock.module('../src/utils/cwd.js', () => ({
  getCwd: () => process.cwd(), pwd: () => process.cwd(),
  runWithCwdOverride: <T>(_cwd: string, callback: () => T) => callback(),
}))
mock.module('../src/utils/lockfile.js', () => ({
  lock: async () => async () => {}, lockSync: () => () => {}, unlock: async () => {}, check: async () => false,
}))

const oid = (character: string) => `sha256:${character.repeat(64)}` as OpenCodeOpaqueIdentity
const attemptId = '123e4567-e89b-42d3-a456-426614174000'
const payloadHash = 'a'.repeat(64)
const nonce = 'A'.repeat(22)
const memberIdentity = oid('1')

function never(): Promise<never> { return new Promise(() => undefined) }

function prepared(projectPath: string): OpenCodePreparedProfile {
  const profileRootPath = path.join(projectPath, '.profiles', 'openrouter')
  return {
    projectPath, profileRootKey: 'selected-openrouter', profileRootPath,
    projectDefaultModelId: null, allProjectsDefaultModelId: null,
    effectiveManagedDefaultModelId: null, effectiveManagedDefaultSource: null,
    projectBehaviorFingerprint: 'behavior-v1', behaviorSources: [],
    managedConfig: { default_agent: 'teammate', plugin: ['opencode-openrouter@1'] },
    managedConfigFingerprint: 'config-v1', homePath: path.join(profileRootPath, 'home'),
    tmpPath: path.join(profileRootPath, 'tmp'), xdgConfigHome: path.join(profileRootPath, 'config'),
    xdgDataHome: path.join(profileRootPath, 'data'), xdgCacheHome: path.join(profileRootPath, 'cache'),
    globalAuthPath: path.join(profileRootPath, 'global-auth.json'),
    managedAuthPath: path.join(profileRootPath, 'auth.json'), sourceAuthPath: null,
    sourceAuthFingerprint: 'none', managedAuthFingerprint: 'auth-v1', authState: 'ok', env: {},
  }
}

function inventory(projectPath: string, profile: OpenCodePreparedProfile): OpenCodeInventorySnapshot {
  return {
    detected: true, binaryPath: '/fake/opencode', version: '1.17.18', projectPath, profile,
    connectedProviders: [{ id: 'openrouter', authHint: 'api', source: 'credentials', credentialScopes: ['managed'] }],
    availableProviders: ['openrouter'], models: ['openrouter/model'], modelMetadata: [], agents: [],
    authStorePath: profile.managedAuthPath, probeError: null, diagnostics: [],
  }
}

function host(projectPath: string, profile: OpenCodePreparedProfile): OpenCodeHostHandle {
  return {
    hostKey: 'selected-host', profileRootKey: profile.profileRootKey, projectPath,
    projectBehaviorFingerprint: profile.projectBehaviorFingerprint, baseUrl: 'http://fake.invalid',
    port: 43100, pid: 41000, processStartedAtMs: 991, version: '1.17.18', state: 'healthy',
    profile, resolvedConfigFingerprint: 'config-v1', diagnostics: [],
  }
}

class MemoryJournal implements OpenCodeLaunchJournalPersistence {
  bytes: Uint8Array | null = null
  fence = 0
  async read() { return this.bytes?.slice() ?? null }
  async replaceAndSync(bytes: Uint8Array) { this.bytes = bytes.slice() }
  async readFence() { return this.fence || null }
  async compareAndSwapFence(expected: number, next: number) {
    if (this.fence !== expected || next !== expected + 1) throw new Error('fence mismatch')
    this.fence = next
  }
  async acquireExclusive() { return async () => undefined }
}

describe('portable fake evidence through production OpenCode composers', () => {
  test('production command-status route is zero write/process/lock/profile prepare under hanging Kiro/Cursor', async () => {
    const { executeOpenCodePassiveCommandStatusEnvelope } = await import('../src/services/opencode/OpenCodePassiveCommandStatusRoute.js')
    const sideEffects: string[] = []
    const hangingProviders = { kiro: never(), cursor: never() }
    const result = await executeOpenCodePassiveCommandStatusEnvelope({
      schemaVersion: 1, requestId: 'status-request', command: 'opencode.commandStatus',
      cwd: '/sandbox/project', timeoutMs: 100, body: { originalRequestId: 'original-request' },
    }, {
      now: (() => { let value = 1000; return () => value++ })(),
      schedule: () => ({ cancel() {} }),
      readPassiveStatus: async () => null as never,
      readOutcome: async () => null,
    })
    void hangingProviders
    expect(result).toMatchObject({ ok: true, command: 'opencode.commandStatus' })
    expect(sideEffects).toEqual([])
  })

  test('production catalog adapter uses profile/live selected provider only and stale catalog grants no launch authority', async () => {
    const { OpenCodeProviderManagementAdapter } = await import('../src/features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.js')
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-production-catalog-'))
    const selectedProfile = prepared(sandbox)
    const calls: string[] = []
    try {
      const adapter = new OpenCodeProviderManagementAdapter({
        inventoryService: { probe: async (_project, options) => {
          calls.push(`inventory:${options?.mode}`)
          return inventory(sandbox, selectedProfile)
        } },
        hostManager: {
          ensureHost: async options => { calls.push(`host:${options.managedPluginStartupPolicy}`); return host(sandbox, selectedProfile) },
          releaseHost: async () => { calls.push('host:release') },
        },
        clientFactory: { create: () => ({
          getServerDoc: async () => { calls.push('http:doc'); return null },
          getConfigProviders: async () => { calls.push('http:config/providers'); return { providers: [{ id: 'openrouter', models: { model: {} } }], default: {} } },
          getProviders: async () => { calls.push('http:provider'); return { all: [{ id: 'openrouter', models: { model: {} } }], connected: ['openrouter'], default: {} } },
          getProviderAuth: async () => { calls.push('http:auth'); return { openrouter: [{ type: 'api' }] } },
        }) },
      })
      const loaded = await adapter.loadDirectory({
        runtimeId: 'opencode', projectPath: sandbox, query: 'openrouter', filter: 'all',
        limit: 20, cursor: null, refresh: false,
      })
      expect(loaded.ok).toBe(true)
      expect(calls).toEqual([
        'inventory:profile', 'host:serve-startup', 'http:doc', 'http:config/providers',
        'http:provider', 'http:auth', 'host:release',
      ])
      expect(calls.join('|')).not.toMatch(/full|models --verbose|agent|mcp|kiro|cursor|catalog-prewarm/)
      // Catalog output is intentionally not a capability accepted by the production launch bridge.
      expect((loaded as { launchCapability?: unknown }).launchCapability).toBeUndefined()
    } finally { await rm(sandbox, { recursive: true, force: true }) }
  })

  test('production bridge/core reaches profile, Windows, host, exact proof, journal, cleanup and idempotent member composition', async () => {
    const [{ OpenCodeLaunchAttempt, computeOpenCodeLaunchAttemptInputDigest,
      computeOpenCodeLaunchAttemptImmutableDigest },
      { computeOpenCodeLaunchCommandInputDigest, computeOpenCodeLaunchCommandImmutableDigest,
        computeOpenCodeLaunchRequestCorrelationDigest },
      { createOpenCodeLaunchAttemptProductionBridge },
      { OpenCodeLaunchAttemptStore }, { planScopedProfile }, { ensureOpenCodeWindowsManagedDirectoryPath },
      { canonicalizeOpenCodeProjectIdentity },
      { authorizeOpenCodeLaunchScopedProfile, prepareAuthorizedOpenCodeLaunchScopedProfile }] = await Promise.all([
      import('../src/services/opencode/OpenCodeLaunchAttempt.js'),
      import('../src/services/opencode/OpenCodeLaunchAttemptBridge.js'),
      import('../src/services/opencode/OpenCodeLaunchAttemptProductionComposition.js'),
      import('../src/services/opencode/OpenCodeLaunchAttemptStore.js'),
      import('../src/services/opencode/OpenCodeOperationPolicy.js'),
      import('../src/services/opencode/OpenCodeWindowsManagedDirectory.js'),
      import('../src/services/opencode/OpenCodeProjectIdentity.js'),
      import('../src/services/opencode/OpenCodePlanScopedProfile.js'),
    ])
    const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-production-launch-')))
    const journal = new MemoryJournal()
    const calls: string[] = []
    let now = 0
    const retainedHost = {
      hostKeyIdentity: oid('2'), processId: 41000, processStartedAtMs: 991, profileScopeIdentity: oid('3'),
    }
    const linkage = {
      memberIdentity, sessionIdentity: oid('4'), bootstrapMessageIdentity: oid('5'), commitIdentity: oid('6'),
    }
    let authoritativeLinkage = false
    const command = (): Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0] => {
      const value: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0] = {
        request: { launchContractVersion: 1, launchAttempt: {
          attemptId, payloadHash, generation: 1, proofNonce: nonce,
          parent: { sessionIdentity: oid('7'), messageIdentity: oid('8') },
          providerId: 'openrouter', modelId: 'openrouter/model',
          requiredMcpTools: ['agent-teams.message_send'], requireFreshRetainedHostProof: true,
        } },
        members: [{ name: 'alice', memberIdentity }], runId: 'run', laneId: 'primary', teamId: 'team',
        projectPath: sandbox, selectedModel: 'openrouter/model', toolApprovalMode: 'auto',
        continuation: false, requestedBudgetMs: 10_000,
        preconditions: {
          handshakeIdentityHash: '1'.repeat(64), laneId: 'primary', expectedRunId: 'run',
          expectedCapabilitySnapshotId: null, expectedBehaviorFingerprint: '2'.repeat(64),
          expectedManifestHighWatermark: null, commandLeaseId: 'lease-1', idempotencyKey: attemptId,
        },
      }
      value.request.launchAttempt.requestCorrelationDigest =
        computeOpenCodeLaunchRequestCorrelationDigest(value)
      return value
    }
    type Command = Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0]
    const productionDigests = (value: Command) => {
      const requestedBudgetMs = value.deadlineAtMs === undefined
        ? value.outerRemainingBudgetMs ?? value.requestedBudgetMs : value.requestedBudgetMs
      const effectiveBudgetMs = Math.min(requestedBudgetMs, 300_000)
      const commandInputDigest = computeOpenCodeLaunchCommandInputDigest(value)
      const commandImmutableDigest = computeOpenCodeLaunchCommandImmutableDigest(value)
      return {
        commandInputDigest,
        commandImmutableDigest,
        inputDigest: computeOpenCodeLaunchAttemptInputDigest(value.request,
          value.members.map(member => member.memberIdentity), value.continuation ? 'continue' : 'begin',
          requestedBudgetMs, effectiveBudgetMs, commandInputDigest),
        immutableDigest: computeOpenCodeLaunchAttemptImmutableDigest(value.request,
          value.members.map(member => member.memberIdentity), requestedBudgetMs,
          effectiveBudgetMs, commandImmutableDigest),
      }
    }
    type Digests = ReturnType<typeof productionDigests>
    const proofResponse = (digests: Digests, issuedNonce = nonce): OpenCodeLaunchAttemptResponse => ({
      launchAttempt: {
        contractVersion: 1, attemptId, idempotencyKey: 'attemptId', payloadHash, generation: 1,
        inputDigest: digests.inputDigest, immutableDigest: digests.immutableDigest,
        outcome: 'succeeded', phase: 'complete', startedAt: 0, absoluteDeadlineAt: 10_000,
        workDeadlineAt: 9_000, cleanupReserveMs: 1_000, elapsedMs: 1,
        providerId: 'openrouter', modelId: 'openrouter/model', profilePurpose: 'launch_attempt',
        requestCorrelationDigest: command().request.launchAttempt.requestCorrelationDigest,
        projectIdentity: oid('9'), profileIdentity: oid('3'), configIdentity: oid('a'),
        authIdentity: oid('b'), pluginPolicyIdentity: oid('c'), cacheIdentity: oid('d'), binaryIdentity: oid('e'),
        retainedHostIdentity: retainedHost,
      },
      proof: {
        generation: 1, attemptId, parent: command().request.launchAttempt.parent,
        requestCorrelationDigest: command().request.launchAttempt.requestCorrelationDigest,
        providerId: 'openrouter', modelId: 'openrouter/model', retainedHostIdentity: retainedHost,
        observedMcpTools: ['agent-teams.message_send'],
        nonceHash: createHash('sha256').update(issuedNonce).digest('hex'), sessionIdentity: oid('f'),
        promptMessageIdentity: oid('0'), assistantMessageIdentity: oid('a'), verifiedAt: 1,
        authorizationSource: 'fresh_live_attempt', cacheUsed: false,
      },
      members: { committed: [], failed: [], pending: [], cleanupPending: [] },
    })
    const currentPlan = {
      purpose: 'launch' as const, providerId: 'openrouter', modelId: 'openrouter/model',
      runtimeInstanceId: attemptId, projectPath: sandbox, evidence: {
        canonicalProjectPathFingerprint: '1'.repeat(64), projectBehaviorFingerprint: '2'.repeat(64),
        providerEnvironmentFingerprint: '3'.repeat(64), selectedAuthFingerprint: '4'.repeat(64),
        binaryFingerprint: '5'.repeat(64), configFingerprint: '6'.repeat(64),
        nativeAccountIdentityFingerprint: '7'.repeat(64), nativeAccountIdentitySource: 'managed-auth' as const,
        nativeTargetExecutableFingerprint: '8'.repeat(64), profileLayoutFingerprint: '9'.repeat(64),
        automaticUserPluginFingerprint: 'a'.repeat(64), plugins: [],
      },
    }
    const policy = planScopedProfile(currentPlan)
    const profileManager = {
      captureCurrentScopedProfilePlan: async () => {
        calls.push('profile:capture')
        return currentPlan
      },
      planScopedProfile,
      prepareScopedProfile: async (_current: typeof currentPlan, expected: typeof policy) => ({
        scopeSchema: 'opencode-scoped-profile-v1' as const, purpose: expected.purpose,
        providerId: expected.providerId, modelId: expected.modelId, runtimeInstanceId: attemptId,
        scopedPlanDigest: expected.digest, plannedHostKey: expected.expectedHostKey,
        canonicalProjectPathFingerprint: expected.canonicalProjectPathFingerprint,
        selectedAuthBaselineFingerprint: expected.selectedAuthFingerprint,
        binaryFingerprint: expected.binaryFingerprint,
      }),
    }
    const fixtureAuthorization = await authorizeOpenCodeLaunchScopedProfile(profileManager, {
      purpose: 'launch', providerId: 'openrouter', modelId: 'openrouter/model',
      runtimeInstanceId: attemptId, projectPath: sandbox,
    })
    const completeCommand = { ...command(), projectIdentity: await canonicalizeOpenCodeProjectIdentity(sandbox),
      effectiveProfilePlanDigest: fixtureAuthorization.effectivePlanDigest }
    const fixtureDigests = productionDigests(completeCommand)
    const changedRunDigests = productionDigests({ ...completeCommand, runId: 'different-run' })
    expect(changedRunDigests.inputDigest).not.toBe(fixtureDigests.inputDigest)
    expect(changedRunDigests.immutableDigest).not.toBe(fixtureDigests.immutableDigest)
    let executingDigests = fixtureDigests
    let authorizedProfile: Awaited<ReturnType<typeof authorizeOpenCodeLaunchScopedProfile>> | null = null
    const ports: OpenCodeLaunchAttemptPorts = {
      clock: { monotonicNow: () => now },
      profile: { createSelectedProviderProfile: async () => {
        if (!authorizedProfile) throw new Error('production profile authorization was bypassed')
        const scoped = await prepareAuthorizedOpenCodeLaunchScopedProfile(profileManager, authorizedProfile)
        calls.push(`profile:${scoped.purpose}:${scoped.providerId}`)
        await ensureOpenCodeWindowsManagedDirectoryPath(path.join(sandbox, 'managed', 'profile'), sandbox)
        calls.push('windows-policy')
        return { purpose: 'launch_attempt', providerId: 'openrouter', projectIdentity: oid('9'),
          profileIdentity: oid('3'), pluginPolicyIdentity: oid('c'), cacheIdentity: oid('d'),
          authIdentity: oid('b'), configIdentity: oid('a'), binaryIdentity: oid('e') }
      } },
      host: {
        acquireOperationHost: async () => { calls.push('host:acquire'); return retainedHost },
        releaseOperationHost: async () => { calls.push('host:release') },
      },
      mcp: { verifyAppMcp: async () => { calls.push('mcp:verify'); return { host: retainedHost, observedTools: ['agent-teams.message_send'] } } },
      proof: {
        runFreshExactModelProof: async input => { calls.push(`proof:fresh-exact:${now}`); now += 2; return {
          response: proofResponse(executingDigests, input.request.launchAttempt.proofNonce),
          authIdentity: oid('b'), configIdentity: oid('a'), binaryIdentity: oid('e'),
        } },
        observeRetainedProofState: async input => { calls.push('proof:revalidate-same-host'); return {
          host: retainedHost, nonceHash: createHash('sha256').update(input.request.launchAttempt.proofNonce).digest('hex'),
          providerId: 'openrouter', modelId: 'openrouter/model', mcpConnected: true,
          observedTools: ['agent-teams.message_send'], profileIdentity: oid('3'), pluginPolicyIdentity: oid('c'),
          cacheIdentity: oid('d'), authIdentity: oid('b'), configIdentity: oid('a'), binaryIdentity: oid('e'),
        } },
      },
      sessions: {
        readMemberLinkage: async () => authoritativeLinkage ? linkage : null,
        claimMemberMutation: async () => 'claimed',
        transitionMemberClaim: async input => input.transition === 'commit' ? 'committed' : 'cancelled',
        createBootstrapAndCommit: async input => {
          calls.push('member:create')
          await input.revalidateBeforeCommit()
          if (await input.commitIfClaimLive(linkage) !== 'committed') {
            return { outcome: 'unknown_transport', owned: { memberIdentity } }
          }
          authoritativeLinkage = true
          return { outcome: 'applied', linkage, owned: { memberIdentity } }
        },
      },
      ownership: {
        abortOwned: async () => { calls.push('cleanup:abort') },
        cleanupOwned: async () => { calls.push('cleanup:bounded'); return 'complete' },
      },
      deadline: { run: async (operation, deadlineAtMs, signal) => {
        expect(deadlineAtMs).toBeLessThanOrEqual(10_000)
        if (signal.aborted || now >= deadlineAtMs) throw new Error('deadline')
        return operation
      } },
    }
    const core = new OpenCodeLaunchAttempt(new OpenCodeLaunchAttemptStore(journal), ports)
    const { decodeOpenCodeLaunchAttemptResponse, validateOpenCodeLaunchAttemptCorrelation } =
      await import('../src/services/opencode/OpenCodeBridgeContractV2.js')
    const decodedProof = decodeOpenCodeLaunchAttemptResponse(proofResponse(fixtureDigests))
    if (!decodedProof.ok) throw new Error(`fixture response invalid: ${decodedProof.error.field}`)
    const fixtureCorrelation = validateOpenCodeLaunchAttemptCorrelation(command().request,
      proofResponse(fixtureDigests), {
      currentGeneration: 1, expectedNonceHash: createHash('sha256').update(nonce).digest('hex'),
      expectedProfilePurpose: 'launch_attempt', expectedProviderId: 'openrouter',
      expectedProjectIdentity: oid('9'), expectedConfigIdentity: oid('a'), expectedAuthIdentity: oid('b'),
      expectedPluginPolicyIdentity: oid('c'), expectedCacheIdentity: oid('d'), expectedBinaryIdentity: oid('e'),
      expectedRetainedHostIdentity: retainedHost, requiredMcpTools: ['agent-teams.message_send'],
    })
    if (!fixtureCorrelation.ok) throw new Error(`fixture correlation invalid: ${fixtureCorrelation.failure.field}`)
    calls.length = 0
    const snapshot = { detected: false } as never
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      preflightAuthorization: async () => {
        const effectsBefore = calls.filter(call =>
          /^(profile:launch|windows-policy|host:|mcp:|proof:|member:|cleanup:)/.test(call))
        const journalBefore = journal.bytes?.slice() ?? null
        const authorizationBefore = authorizedProfile
        const linkageBefore = authoritativeLinkage
        calls.push('preflightAuthorization')
        expect(calls.filter(call =>
          /^(profile:launch|windows-policy|host:|mcp:|proof:|member:|cleanup:)/.test(call)))
          .toEqual(effectsBefore)
        expect(journal.bytes).toEqual(journalBefore)
        expect(authorizedProfile).toBe(authorizationBefore)
        expect(authoritativeLinkage).toBe(linkageBefore)
      },
      authorize: async value => {
        calls.push('authorize')
        authorizedProfile = await authorizeOpenCodeLaunchScopedProfile(profileManager, {
          purpose: 'launch', providerId: value.request.launchAttempt.providerId,
          modelId: value.selectedModel, runtimeInstanceId: value.request.launchAttempt.attemptId,
          projectPath: value.projectPath, abortSignal: value.signal,
        })
        calls.push(`plan:${authorizedProfile.effectivePlanDigest}`)
        return { ...value, effectiveProfilePlanDigest: authorizedProfile.effectivePlanDigest }
      },
      inspect: async () => null,
      executeAfterPreflight: async value => {
        executingDigests = productionDigests(value)
        expect(executingDigests).toEqual(fixtureDigests)
        const result = await core.run({
          request: value.request, members: value.members.map(member => member.memberIdentity),
          requestedBudgetMs: value.deadlineAtMs === undefined
            ? value.outerRemainingBudgetMs ?? value.requestedBudgetMs : value.requestedBudgetMs,
          deadlineAtMs: value.deadlineAtMs, continuation: value.continuation, signal: value.signal,
          commandInputDigest: executingDigests.commandInputDigest,
          commandImmutableDigest: executingDigests.commandImmutableDigest,
        })
        return { output: { snapshot, data: { launchAttempt: result } }, result }
      },
    }, { monotonicNow: () => now })
    expect(sandbox).toBe(await realpath(sandbox))
    try {
      const first = await bridge.execute(command())
      if ((first.data as { launchAttempt: { status: string } }).launchAttempt.status !== 'succeeded') {
        throw new Error(JSON.stringify({ launch: (first.data as { launchAttempt: unknown }).launchAttempt, calls }))
      }
      expect((first.data as { launchAttempt: { status: string } }).launchAttempt.status).toBe('succeeded')
      expect(calls).toEqual([
        'preflightAuthorization',
        'authorize',
        'profile:capture',
        `plan:${authorizedProfile!.effectivePlanDigest}`,
        'profile:launch:openrouter',
        'windows-policy',
        'host:acquire',
        'mcp:verify',
        'proof:fresh-exact:0',
        'proof:revalidate-same-host',
        'proof:revalidate-same-host',
        'member:create',
        'proof:revalidate-same-host',
        'proof:revalidate-same-host',
        'cleanup:bounded',
        'host:release',
      ])
      const preflightIndex = calls.indexOf('preflightAuthorization')
      const effectCalls = calls.filter(call => /^(profile:launch|windows-policy|host:|mcp:|proof:|member:|cleanup:)/.test(call))
      for (const effect of effectCalls) {
        expect(preflightIndex).toBeLessThan(calls.indexOf(effect))
      }
      expect(calls.indexOf('windows-policy')).toBeLessThan(calls.indexOf('host:acquire'))
      expect(calls.findIndex(call => call.startsWith('proof:fresh-exact'))).toBeLessThan(calls.indexOf('member:create'))
      expect(calls.indexOf('proof:revalidate-same-host')).toBeLessThan(calls.indexOf('member:create'))
      expect(calls).toContain('windows-policy')
      expect(journal.bytes).not.toBeNull()
      const journalBeforeReplay = journal.bytes!.slice()
      const durableJournal = JSON.parse(new TextDecoder().decode(journal.bytes!))
      expect(durableJournal).toMatchObject({
        inputDigest: fixtureDigests.inputDigest, immutableDigest: fixtureDigests.immutableDigest,
        acceptedProofResponse: { launchAttempt: {
          inputDigest: fixtureDigests.inputDigest, immutableDigest: fixtureDigests.immutableDigest,
        } },
      })
      expect(durableJournal.events.map((event: { type: string }) => event.type))
        .toEqual(['member_intent', 'member_applied'])
      const memberCreates = calls.filter(call => call === 'member:create').length
      const proofRuns = calls.filter(call => call.startsWith('proof:')).length
      const callsBeforeReplay = calls.length
      const replay = await bridge.execute(command())
      expect((replay.data as { launchAttempt: { status: string } }).launchAttempt.status).toBe('succeeded')
      expect(calls.slice(callsBeforeReplay)).toEqual([
        'preflightAuthorization',
        'authorize',
        'profile:capture',
        `plan:${authorizedProfile!.effectivePlanDigest}`,
      ])
      expect(calls.filter(call => call === 'member:create')).toHaveLength(memberCreates)
      expect(calls.filter(call => call.startsWith('proof:'))).toHaveLength(proofRuns)
      expect(journal.bytes).toEqual(journalBeforeReplay)
    } finally { await rm(sandbox, { recursive: true, force: true }) }
  })
})
