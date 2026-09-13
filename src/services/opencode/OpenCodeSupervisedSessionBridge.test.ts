import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { canonicalHostedApprovalDigest, canonicalHostedApprovalJson, OpenCodeClientFactory } from './OpenCodeClientFactory.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeSessionBridge, OpenCodePermissionEffectNotAuthorizedError,
  OpenCodePermissionEffectUnavailableError, OpenCodeHostedSessionCleanupPendingError } from './OpenCodeSessionBridge.js'
import { OpenCodeSessionStore, retainHostedSessionPublicationStore } from './OpenCodeSessionStore.js'
import { supervisedFixture, supervisedLease, supervisedTestStage,
  supervisedTestWait } from './OpenCodeSupervisedCustody.test-fixture.js'
import type { OpenCodeSessionRecord } from './types.js'
import type { OpenCodeHostedSessionAttemptBinding, OpenCodeHostedSessionAttemptHandle } from './OpenCodeSessionBridge.js'
import { createOpenCodeSupervisedProviderBundle } from './OpenCodeSupervisedProviderBundle.js'
import { HostedApprovalRuntimeBindingFenceRegistry } from '../hostedControl/HostedApprovalRuntimeBindingFence.js'

function sessionRecord(fixture: Awaited<ReturnType<typeof supervisedFixture>>, hostKey: string): OpenCodeSessionRecord {
  return {
    teamId: supervisedLease.teamId, laneId: supervisedLease.laneId, memberName: supervisedLease.memberName,
    runId: supervisedLease.runId, opencodeSessionId: supervisedLease.sessionId,
    providerId: 'opencode', selectedModel: 'test/model', toolApprovalMode: 'manual',
    hostKey, profileRootKey: fixture.profile.profileRootKey, projectPath: fixture.profile.projectPath,
    openCodeArtifactDigest: `sha256:${fixture.expected.executable.sha256}`,
    projectBehaviorFingerprint: fixture.profile.projectBehaviorFingerprint,
    managedConfigFingerprint: fixture.profile.managedConfigFingerprint,
    sourceAuthFingerprint: fixture.profile.sourceAuthFingerprint, managedAuthFingerprint: fixture.profile.managedAuthFingerprint,
    resolvedBehaviorFingerprint: fixture.expected.profile.resolvedConfigFingerprint,
    lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: null,
    staleReason: null, createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z',
  }
}

describe.skipIf(process.platform !== 'linux')('OpenCode supervised session bridge', () => {
  test('actual supervised bundle creates, conditionally publishes, and exactly releases a hosted attempt', async () => {
    const fixture = await supervisedFixture({ handle(request, response) {
      if (request.method === 'POST' && request.url === '/session') {
        response.end('{"id":"ses_test"}')
        return
      }
      const result = request.url === '/global/health' ? { healthy: true } :
        request.url === '/agent' ? [] :
        request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
      response.end(canonicalHostedApprovalJson(result))
    } })
    try {
      const custody = await fixture.acquire()
      const bundle = createOpenCodeSupervisedProviderBundle(
        custody,
        `${fixture.profile.profileRootPath}/bundle-sessions.json`,
      )
      const events: string[] = []
      const context = bundle.hostedAttempts.createContext({
        attemptId: 'actual-bundle-attempt',
        fence: { ownerPlanGeneration: 'generation-1', ownerIncarnation: 'incarnation-1',
          operationEpoch: 1, attemptOrdinal: 0 },
        binding: {
          teamId: supervisedLease.teamId, runId: supervisedLease.runId,
          ownerLaneId: supervisedLease.laneId, memberName: supervisedLease.memberName,
          profileRootKey: fixture.profile.profileRootKey, hostKey: custody.hostKey,
          openCodeArtifactDigest: `sha256:${fixture.expected.executable.sha256}`,
        },
        validateAttempt: () => true,
        armAttempt: async () => { events.push('armed') },
        recordCreated: async () => { events.push('created') },
        recordUncertain: async () => { events.push('uncertain') },
      })
      const record = await bundle.lifecycle.bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName, runId: supervisedLease.runId,
        selectedModel: 'test/model', preparedProfile: fixture.profile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: context,
      })
      expect(record.opencodeSessionId).toBe(supervisedLease.sessionId)
      expect(events).toEqual(['armed', 'created'])
      expect(context.handle.snapshot()).toMatchObject({
        phase: 'created', metadata: 'applied', effectInFlight: false,
        cleanupPending: { provisionalLease: false, sessionLease: true, hostReference: true },
      })
      await bundle.hostedAttempts.release(context.handle)
      expect(context.handle.snapshot().cleanupPending).toEqual({
        provisionalLease: false, sessionLease: false, hostReference: false,
      })
    } finally { await fixture.close() }
  }, 120_000)

  for (const cleanupPoint of ['arm', 'created'] as const) {
    test(`reentrant ${cleanupPoint} cleanup is immediately pending and sticky across late replies`, async () => {
      let createCalls = 0
      const fixture = await supervisedFixture({ handle(request, response) {
        if (request.method === 'POST' && request.url === '/session') {
          createCalls += 1
          response.end('{"id":"ses_test"}')
          return
        }
        const result = request.url === '/global/health' ? { healthy: true } :
          request.url === '/agent' ? [] :
          request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
        response.end(canonicalHostedApprovalJson(result))
      } })
      try {
        const custody = await fixture.acquire()
        const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
        const manager = new OpenCodeHostManager({ acquisitionPolicy })
        const store = new OpenCodeSessionStore(`${fixture.profile.profileRootPath}/reentrant-${cleanupPoint}.json`)
        const bridge = new OpenCodeSessionBridge({ acquisitionPolicy, hostManager: manager,
          clientFactory: new OpenCodeClientFactory({ acquisitionPolicy }), sessionStore: store,
          hostedSessionPublicationStore: retainHostedSessionPublicationStore(store) })
        let handle!: OpenCodeHostedSessionAttemptHandle
        const pendingErrors: unknown[] = []
        const requestCleanup = async () => {
          try { await bridge.releaseHostedSessionAttempt(handle) } catch (error) { pendingErrors.push(error) }
        }
        const context = bridge.createHostedSessionAttemptContext({
          attemptId: `reentrant-${cleanupPoint}`,
          fence: { ownerPlanGeneration: 'generation-1', ownerIncarnation: 'incarnation-1',
            operationEpoch: 1, attemptOrdinal: 0 },
          binding: {
            teamId: supervisedLease.teamId, runId: supervisedLease.runId,
            ownerLaneId: supervisedLease.laneId, memberName: supervisedLease.memberName,
            profileRootKey: fixture.profile.profileRootKey, hostKey: custody.hostKey,
            openCodeArtifactDigest: `sha256:${fixture.expected.executable.sha256}`,
          },
          validateAttempt: () => true,
          armAttempt: async () => { if (cleanupPoint === 'arm') await requestCleanup() },
          recordCreated: async () => { if (cleanupPoint === 'created') await requestCleanup() },
          recordUncertain: async () => {},
        })
        handle = context.handle
        await expect(bridge.ensureSession({
          teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
          memberName: supervisedLease.memberName, runId: supervisedLease.runId,
          selectedModel: 'test/model', preparedProfile: fixture.profile,
          toolApprovalMode: 'manual', fresh: true, hostedAttempt: context,
        })).rejects.toThrow()
        expect(pendingErrors).toHaveLength(1)
        expect(pendingErrors[0]).toBeInstanceOf(OpenCodeHostedSessionCleanupPendingError)
        expect(createCalls).toBe(cleanupPoint === 'arm' ? 0 : 1)
        expect(handle.snapshot()).toMatchObject({
          cleanupRequested: true, effectInFlight: false,
          returnedSessionId: cleanupPoint === 'created' ? supervisedLease.sessionId : null,
          metadata: 'not_started',
        })
        expect(await retainHostedSessionPublicationStore(store).readExact({
          teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
          memberName: supervisedLease.memberName,
        })).toBeNull()
        await Promise.all([
          bridge.releaseHostedSessionAttempt(handle),
          bridge.releaseHostedSessionAttempt(handle),
        ])
        expect(handle.snapshot().cleanupPending).toEqual({
          provisionalLease: false, sessionLease: false, hostReference: false,
        })
        expect(manager.getHost(custody.hostKey)).toBeNull()
      } finally { await fixture.close() }
    }, 120_000)
  }

  test('a deterministic post-create microtask makes cleanup sticky before metadata CAS starts', async () => {
    let createCalls = 0
    const fixture = await supervisedFixture({ handle(request, response) {
      if (request.method === 'POST' && request.url === '/session') {
        createCalls += 1
        response.end('{"id":"ses_pre_cas_microtask"}')
        return
      }
      const result = request.url === '/global/health' ? { healthy: true } :
        request.url === '/agent' ? [] :
        request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
      response.end(canonicalHostedApprovalJson(result))
    } })
    try {
      const custody = await fixture.acquire()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      const manager = new OpenCodeHostManager({ acquisitionPolicy })
      const store = new OpenCodeSessionStore(`${fixture.profile.profileRootPath}/pre-cas-microtask.json`)
      const bridge = new OpenCodeSessionBridge({ acquisitionPolicy, hostManager: manager,
        clientFactory: new OpenCodeClientFactory({ acquisitionPolicy }), sessionStore: store,
        hostedSessionPublicationStore: retainHostedSessionPublicationStore(store) })
      let cleanupResult: Promise<void> | undefined
      let cleanupError: unknown
      const context = bridge.createHostedSessionAttemptContext({
        attemptId: 'pre-cas-microtask',
        fence: { ownerPlanGeneration: 'generation-1', ownerIncarnation: 'incarnation-1',
          operationEpoch: 1, attemptOrdinal: 0 },
        binding: { teamId: supervisedLease.teamId, runId: supervisedLease.runId,
          ownerLaneId: supervisedLease.laneId, memberName: supervisedLease.memberName,
          profileRootKey: fixture.profile.profileRootKey, hostKey: custody.hostKey,
          openCodeArtifactDigest: `sha256:${fixture.expected.executable.sha256}` },
        validateAttempt: () => true,
        armAttempt: async () => {},
        recordCreated: async () => {
          queueMicrotask(() => {
            cleanupResult = bridge.releaseHostedSessionAttempt(context.handle)
              .catch(error => { cleanupError = error })
          })
        },
        recordUncertain: async () => {},
      })
      await expect(bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName, runId: supervisedLease.runId,
        selectedModel: 'test/model', preparedProfile: fixture.profile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: context,
      })).rejects.toThrow('persistence or lease promotion failed')
      await cleanupResult
      expect(cleanupError).toBeInstanceOf(OpenCodeHostedSessionCleanupPendingError)
      expect(createCalls).toBe(1)
      expect(context.handle.snapshot()).toMatchObject({
        cleanupRequested: true, effectInFlight: false, metadata: 'not_started',
        returnedSessionId: 'ses_pre_cas_microtask',
      })
      expect(await retainHostedSessionPublicationStore(store).readExact({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName,
      })).toBeNull()
      await bridge.releaseHostedSessionAttempt(context.handle)
      expect(manager.getHost(custody.hostKey)).toBeNull()
    } finally { await fixture.close() }
  }, 120_000)

  test('reentrant validation cleanup cancels an unused context before strict read or acquisition', async () => {
    const fixture = await supervisedFixture()
    try {
      const custody = await fixture.acquire()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      const manager = new OpenCodeHostManager({ acquisitionPolicy })
      const storePath = `${fixture.profile.profileRootPath}/validate-cleanup.json`
      const store = new OpenCodeSessionStore(storePath)
      const bridge = new OpenCodeSessionBridge({ acquisitionPolicy, hostManager: manager,
        clientFactory: new OpenCodeClientFactory({ acquisitionPolicy }), sessionStore: store,
        hostedSessionPublicationStore: retainHostedSessionPublicationStore(store) })
      let handle!: OpenCodeHostedSessionAttemptHandle
      let pendingError: unknown
      const context = bridge.createHostedSessionAttemptContext({
        attemptId: 'validate-cleanup',
        fence: { ownerPlanGeneration: 'generation-1', ownerIncarnation: 'incarnation-1',
          operationEpoch: 1, attemptOrdinal: 0 },
        binding: { teamId: supervisedLease.teamId, runId: supervisedLease.runId,
          ownerLaneId: supervisedLease.laneId, memberName: supervisedLease.memberName,
          profileRootKey: fixture.profile.profileRootKey, hostKey: custody.hostKey,
          openCodeArtifactDigest: `sha256:${fixture.expected.executable.sha256}` },
        validateAttempt: async () => {
          try { await bridge.releaseHostedSessionAttempt(handle) } catch (error) { pendingError = error }
          return true
        },
        armAttempt: async () => { throw new Error('arm must not run') },
        recordCreated: async () => { throw new Error('created must not run') },
        recordUncertain: async () => {},
      })
      handle = context.handle
      const requestsBefore = fixture.requests.length
      await expect(bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName, runId: supervisedLease.runId,
        selectedModel: 'test/model', preparedProfile: fixture.profile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: context,
      })).rejects.toBeInstanceOf(OpenCodeHostedSessionCleanupPendingError)
      expect(pendingError).toBeInstanceOf(OpenCodeHostedSessionCleanupPendingError)
      expect(fixture.requests).toHaveLength(requestsBefore)
      expect(manager.getHost(custody.hostKey)).toBeNull()
      expect(handle.snapshot()).toMatchObject({ cleanupRequested: true, effectInFlight: false,
        record: null, returnedSessionId: null, metadata: 'not_started' })
      await bridge.releaseHostedSessionAttempt(handle)
      await expect(readFile(storePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await fixture.close() }
  }, 120_000)

  test('two actual bridge/store instances select one absent-row CAS winner without releasing either sibling', async () => {
    let sessionOrdinal = 0
    let createdCount = 0
    let bothCreated!: () => void
    const created = new Promise<void>(resolve => { bothCreated = resolve })
    const fixture = await supervisedFixture({
      mutateBundle(bundle) {
        const original = bundle.prepareLeaseToken
        const effect = bundle.prepareEffectToken
        bundle.prepareLeaseToken = async lease => lease.sessionId?.startsWith('ses_race_')
          ? effect()
          : original(lease)
      },
      handle(request, response) {
        if (request.url === '/global/health') {
          response.end('{"healthy":true}')
          return
        }
        if (request.method === 'POST' && request.url === '/session') {
          response.end(JSON.stringify({ id: `ses_race_${++sessionOrdinal}` }))
          return
        }
        const result = request.url === '/agent' ? [] :
          request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
        response.end(canonicalHostedApprovalJson(result))
      },
    })
    try {
      const custody = await fixture.acquire()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      const filePath = `${fixture.profile.profileRootPath}/race.json`
      const makeBridge = () => {
        const manager = new OpenCodeHostManager({ acquisitionPolicy })
        const store = new OpenCodeSessionStore(filePath)
        return { manager, store, bridge: new OpenCodeSessionBridge({
          acquisitionPolicy, hostManager: manager,
          clientFactory: new OpenCodeClientFactory({ acquisitionPolicy }), sessionStore: store,
          hostedSessionPublicationStore: retainHostedSessionPublicationStore(store),
        }) }
      }
      const left = makeBridge()
      const right = makeBridge()
      const makeContext = (bridge: OpenCodeSessionBridge, ordinal: number) =>
        bridge.createHostedSessionAttemptContext({
          attemptId: `race-${ordinal}`,
          fence: { ownerPlanGeneration: 'generation-1', ownerIncarnation: 'incarnation-1',
            operationEpoch: 1, attemptOrdinal: ordinal },
          binding: {
            teamId: supervisedLease.teamId, runId: supervisedLease.runId,
            ownerLaneId: supervisedLease.laneId, memberName: supervisedLease.memberName,
            profileRootKey: fixture.profile.profileRootKey, hostKey: custody.hostKey,
            openCodeArtifactDigest: `sha256:${fixture.expected.executable.sha256}`,
          },
          validateAttempt: () => true,
          armAttempt: async () => {},
          recordCreated: async () => {
            if (++createdCount === 2) bothCreated()
            await supervisedTestWait(created, 'both absent-row race session creates', 30_000)
          },
          recordUncertain: async () => {},
        })
      const leftContext = makeContext(left.bridge, 0)
      const rightContext = makeContext(right.bridge, 1)
      const outcomes = await Promise.allSettled([
        left.bridge.ensureSession({ teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
          memberName: supervisedLease.memberName, runId: supervisedLease.runId,
          selectedModel: 'test/model', preparedProfile: fixture.profile,
          toolApprovalMode: 'manual', fresh: true, hostedAttempt: leftContext }),
        right.bridge.ensureSession({ teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
          memberName: supervisedLease.memberName, runId: supervisedLease.runId,
          selectedModel: 'test/model', preparedProfile: fixture.profile,
          toolApprovalMode: 'manual', fresh: true, hostedAttempt: rightContext }),
      ])
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
      const snapshots = [leftContext.handle.snapshot(), rightContext.handle.snapshot()]
      expect(snapshots.map(snapshot => snapshot.metadata).sort()).toEqual(['applied', 'conflict'])
      const winner = await retainHostedSessionPublicationStore(new OpenCodeSessionStore(filePath)).readExact({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName,
      })
      expect(['ses_race_1', 'ses_race_2']).toContain(winner?.opencodeSessionId)
      expect(left.manager.getHost(custody.hostKey)).not.toBeNull()
      expect(right.manager.getHost(custody.hostKey)).not.toBeNull()
      await Promise.all([
        left.bridge.releaseHostedSessionAttempt(leftContext.handle),
        right.bridge.releaseHostedSessionAttempt(rightContext.handle),
      ])
      expect(left.manager.getHost(custody.hostKey)).toBeNull()
      expect(right.manager.getHost(custody.hostKey)).toBeNull()
      expect((await retainHostedSessionPublicationStore(new OpenCodeSessionStore(filePath)).readExact({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName,
      }))?.opencodeSessionId).toBe(winner?.opencodeSessionId)
    } finally { await fixture.close() }
  }, 120_000)

  test('validates populated sibling identity before acquisition and releases only the exact predecessor generation', async () => {
    let sessionOrdinal = 0
    const fixture = await supervisedFixture({
      mutateBundle(bundle) {
        const effect = bundle.prepareEffectToken
        bundle.prepareLeaseToken = async lease =>
          lease.teamId === supervisedLease.teamId && lease.runId === supervisedLease.runId
            ? effect()
            : lease.teamId === supervisedLease.teamId && Boolean(lease.sessionId?.startsWith('ses_generation_'))
              ? effect()
              : null
      },
      handle(request, response) {
        if (request.method === 'POST' && request.url === '/session') {
          response.end(JSON.stringify({ id: `ses_generation_${++sessionOrdinal}` }))
          return
        }
        const result = request.url === '/global/health' ? { healthy: true } :
          request.url === '/agent' ? [] :
          request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
        response.end(canonicalHostedApprovalJson(result))
      },
    })
    try {
      const custody = await fixture.acquire()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      const manager = new OpenCodeHostManager({ acquisitionPolicy })
      const store = new OpenCodeSessionStore(`${fixture.profile.profileRootPath}/generations.json`)
      const bridge = new OpenCodeSessionBridge({ acquisitionPolicy, hostManager: manager,
        clientFactory: new OpenCodeClientFactory({ acquisitionPolicy }), sessionStore: store,
        hostedSessionPublicationStore: retainHostedSessionPublicationStore(store) })
      const context = (attemptId: string, memberName: string, attemptOrdinal: number,
        bindingOverrides: Partial<OpenCodeHostedSessionAttemptBinding> = {}) =>
        bridge.createHostedSessionAttemptContext({
          attemptId,
          fence: { ownerPlanGeneration: 'generation-1', ownerIncarnation: 'incarnation-1',
            operationEpoch: 1, attemptOrdinal },
          binding: { teamId: supervisedLease.teamId, runId: supervisedLease.runId,
            ownerLaneId: supervisedLease.laneId, memberName,
            profileRootKey: fixture.profile.profileRootKey, hostKey: custody.hostKey,
            openCodeArtifactDigest: `sha256:${fixture.expected.executable.sha256}`,
            ...bindingOverrides },
          validateAttempt: () => true,
          armAttempt: async () => {}, recordCreated: async () => {}, recordUncertain: async () => {},
        })
      const mismatched = context('mismatched-alice', 'worker', 0)
      const requestCount = fixture.requests.length
      await expect(bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: 'bob', runId: supervisedLease.runId,
        selectedModel: 'test/model', preparedProfile: fixture.profile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: mismatched,
      })).rejects.toThrow('binding or actual capability is unavailable')
      expect(fixture.requests).toHaveLength(requestCount)
      expect(manager.getHost(custody.hostKey)).toBeNull()

      const first = context('generation-one', supervisedLease.memberName, 1)
      const firstRecord = await bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName, runId: supervisedLease.runId,
        selectedModel: 'test/model', preparedProfile: fixture.profile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: first,
      })
      const sibling = context('generation-sibling', 'bob', 2)
      const siblingRecord = await bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: 'bob', runId: supervisedLease.runId,
        selectedModel: 'test/model', preparedProfile: fixture.profile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: sibling,
      })
      const metadataBytes = await readFile(`${fixture.profile.profileRootPath}/generations.json`)
      const requestsBeforeMismatch = fixture.requests.length
      const mismatches: Array<Partial<OpenCodeHostedSessionAttemptBinding>> = [
        { memberName: 'bob' },
        { runId: 'run-other' },
        { ownerLaneId: 'lane-other' },
      ]
      for (const [index, mismatch] of mismatches.entries()) {
        const stale = context(`populated-mismatch-${index}`, supervisedLease.memberName, 10 + index, mismatch)
        await expect(bridge.ensureSession({
          teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
          memberName: supervisedLease.memberName, runId: supervisedLease.runId,
          selectedModel: 'test/model', preparedProfile: fixture.profile,
          toolApprovalMode: 'manual', fresh: true, hostedAttempt: stale,
        })).rejects.toThrow('binding or actual capability is unavailable')
        expect(stale.handle.snapshot()).toMatchObject({ phase: 'no_effect', effectInFlight: false })
      }
      expect(fixture.requests).toHaveLength(requestsBeforeMismatch)
      expect(await readFile(`${fixture.profile.profileRootPath}/generations.json`)).toEqual(metadataBytes)
      const mismatchedProfile = structuredClone(fixture.profile)
      mismatchedProfile.profileRootKey = 'profile-root-substituted'
      const profileMismatch = context('profile-mismatch', supervisedLease.memberName, 20)
      await expect(bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName, runId: supervisedLease.runId,
        selectedModel: 'test/model', preparedProfile: mismatchedProfile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: profileMismatch,
      })).rejects.toThrow('prepared profile does not match supervisor admission')
      const primitiveMismatch = context('primitive-mismatch', supervisedLease.memberName, 21)
      await expect(bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName, runId: supervisedLease.runId,
        selectedModel: ' test/model', preparedProfile: fixture.profile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: primitiveMismatch,
      })).rejects.toThrow('request primitives invalid')
      expect(fixture.requests).toHaveLength(requestsBeforeMismatch)
      expect(await readFile(`${fixture.profile.profileRootPath}/generations.json`)).toEqual(metadataBytes)
      const replacement = context('generation-two', supervisedLease.memberName, 3)
      const replacementRecord = await bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName, runId: supervisedLease.runId,
        selectedModel: 'test/model', preparedProfile: fixture.profile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: replacement,
      })
      expect(firstRecord.opencodeSessionId).toBe('ses_generation_1')
      expect(siblingRecord.opencodeSessionId).toBe('ses_generation_2')
      expect(replacementRecord.opencodeSessionId).toBe('ses_generation_3')
      expect(first.handle.snapshot().cleanupPending).toEqual({
        provisionalLease: false, sessionLease: false, hostReference: false,
      })
      expect(sibling.handle.snapshot().cleanupPending.hostReference).toBe(true)
      expect(replacement.handle.snapshot().cleanupPending.hostReference).toBe(true)
      await bridge.releaseHostedSessionAttempt(first.handle)
      expect(manager.getHost(custody.hostKey)).not.toBeNull()
      await bridge.releaseSession(firstRecord)
      await bridge.releaseSession(firstRecord, { strictHosted: true })
      await manager.retainHostLease(custody.hostKey, {
        teamId: siblingRecord.teamId, laneId: siblingRecord.laneId,
        memberName: siblingRecord.memberName, runId: siblingRecord.runId,
        sessionId: siblingRecord.opencodeSessionId,
      })
      await bridge.releaseSession(siblingRecord)
      await bridge.releaseSession(siblingRecord)
      await bridge.releaseSession(siblingRecord, { strictHosted: true })
      await bridge.releaseHostedSessionAttempt(sibling.handle)
      await expect(bridge.releaseSession({ ...siblingRecord, hostKey: 'wrong-host' }))
        .rejects.toThrow('does not match its retained acquisition')
      expect(manager.getHost(custody.hostKey)).not.toBeNull()
      await manager.releaseHostLease(custody.hostKey, {
        teamId: siblingRecord.teamId, laneId: siblingRecord.laneId,
        memberName: siblingRecord.memberName, runId: siblingRecord.runId,
        sessionId: siblingRecord.opencodeSessionId,
      })
      await bridge.releaseHostedSessionAttempt(replacement.handle)
      expect(manager.getHost(custody.hostKey)).toBeNull()
      expect((await retainHostedSessionPublicationStore(store).readExact({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName,
      }))?.opencodeSessionId).toBe(replacementRecord.opencodeSessionId)
    } finally { await fixture.close() }
  }, 120_000)

  test('an accepted create with a dropped response is once-only uncertainty and reentrant recording cannot settle it', async () => {
    let createCalls = 0
    const fixture = await supervisedFixture({ handle(request, response) {
      if (request.method === 'POST' && request.url === '/session') {
        createCalls += 1
        response.destroy()
        return
      }
      const result = request.url === '/global/health' ? { healthy: true } :
        request.url === '/agent' ? [] :
        request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
      response.end(canonicalHostedApprovalJson(result))
    } })
    try {
      const custody = await fixture.acquire()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      const manager = new OpenCodeHostManager({ acquisitionPolicy })
      const store = new OpenCodeSessionStore(`${fixture.profile.profileRootPath}/unknown-create.json`)
      const bridge = new OpenCodeSessionBridge({ acquisitionPolicy, hostManager: manager,
        clientFactory: new OpenCodeClientFactory({ acquisitionPolicy }), sessionStore: store,
        hostedSessionPublicationStore: retainHostedSessionPublicationStore(store) })
      let handle!: OpenCodeHostedSessionAttemptHandle
      let reentrantError: unknown
      const context = bridge.createHostedSessionAttemptContext({
        attemptId: 'unknown-create',
        fence: { ownerPlanGeneration: 'generation-1', ownerIncarnation: 'incarnation-1',
          operationEpoch: 1, attemptOrdinal: 0 },
        binding: { teamId: supervisedLease.teamId, runId: supervisedLease.runId,
          ownerLaneId: supervisedLease.laneId, memberName: supervisedLease.memberName,
          profileRootKey: fixture.profile.profileRootKey, hostKey: custody.hostKey,
          openCodeArtifactDigest: `sha256:${fixture.expected.executable.sha256}` },
        validateAttempt: () => true,
        armAttempt: async () => {}, recordCreated: async () => {},
        recordUncertain: async () => {
          try { await bridge.releaseHostedSessionAttempt(handle) } catch (error) { reentrantError = error }
        },
      })
      handle = context.handle
      await expect(bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName, runId: supervisedLease.runId,
        selectedModel: 'test/model', preparedProfile: fixture.profile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: context,
      })).rejects.toThrow('outcome is uncertain')
      expect(createCalls).toBe(1)
      expect(reentrantError).toBeInstanceOf(OpenCodeHostedSessionCleanupPendingError)
      expect(handle.snapshot()).toMatchObject({
        phase: 'uncertain', record: null, returnedSessionId: null,
        cleanupRequested: true, effectInFlight: false, metadata: 'not_started',
        cleanupPending: { provisionalLease: true, sessionLease: false, hostReference: true },
      })
      await bridge.releaseHostedSessionAttempt(handle)
      expect(manager.getHost(custody.hostKey)).toBeNull()
      expect(await retainHostedSessionPublicationStore(store).readExact({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName,
      })).toBeNull()
    } finally { await fixture.close() }
  }, 120_000)

  test('two same-bridge replacements that read one live predecessor publish one winner before predecessor release', async () => {
    let sessionOrdinal = 0
    const fixture = await supervisedFixture({
      mutateBundle(bundle) {
        const effect = bundle.prepareEffectToken
        bundle.prepareLeaseToken = async lease =>
          lease.teamId === supervisedLease.teamId &&
          (lease.runId === supervisedLease.runId || Boolean(lease.sessionId?.startsWith('ses_predecessor_')))
            ? effect()
            : null
      },
      handle(request, response) {
        if (request.method === 'POST' && request.url === '/session') {
          response.end(JSON.stringify({ id: `ses_predecessor_${++sessionOrdinal}` }))
          return
        }
        const result = request.url === '/global/health' ? { healthy: true } :
          request.url === '/agent' ? [] :
          request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
        response.end(canonicalHostedApprovalJson(result))
      },
    })
    try {
      const custody = await fixture.acquire()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      const manager = new OpenCodeHostManager({ acquisitionPolicy })
      const fences = new HostedApprovalRuntimeBindingFenceRegistry()
      const filePath = `${fixture.profile.profileRootPath}/predecessor-race.json`
      const store = new OpenCodeSessionStore(filePath, fences)
      const bridge = new OpenCodeSessionBridge({ acquisitionPolicy, hostManager: manager,
        clientFactory: new OpenCodeClientFactory({ acquisitionPolicy }), sessionStore: store,
        hostedSessionPublicationStore: retainHostedSessionPublicationStore(store) })
      const makeContext = (attemptId: string, attemptOrdinal: number, created?: () => void) =>
        bridge.createHostedSessionAttemptContext({
          attemptId,
          fence: { ownerPlanGeneration: 'generation-1', ownerIncarnation: 'incarnation-1',
            operationEpoch: 1, attemptOrdinal },
          binding: { teamId: supervisedLease.teamId, runId: supervisedLease.runId,
            ownerLaneId: supervisedLease.laneId, memberName: supervisedLease.memberName,
            profileRootKey: fixture.profile.profileRootKey, hostKey: custody.hostKey,
            openCodeArtifactDigest: `sha256:${fixture.expected.executable.sha256}` },
          validateAttempt: () => true,
          armAttempt: async () => {}, recordCreated: async () => { created?.() },
          recordUncertain: async () => {},
        })
      const ensure = (context: ReturnType<typeof makeContext>) => bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName, runId: supervisedLease.runId,
        selectedModel: 'test/model', preparedProfile: fixture.profile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: context,
      })
      const predecessor = makeContext('predecessor', 0)
      const predecessorRecord = await ensure(predecessor)
      expect(predecessorRecord.opencodeSessionId).toBe('ses_predecessor_1')

      const pin = fences.forTeam(supervisedLease.teamId).tryAcquirePin()
      if (!pin) throw new Error('expected team binding pin')
      let createdCount = 0
      let bothCreated!: () => void
      const created = new Promise<void>(resolve => { bothCreated = resolve })
      const noteCreated = () => { if (++createdCount === 2) bothCreated() }
      const left = makeContext('replacement-left', 1, noteCreated)
      const right = makeContext('replacement-right', 2, noteCreated)
      const leftPending = ensure(left)
      const rightPending = ensure(right)
      await supervisedTestStage(created, Promise.allSettled([leftPending, rightPending]), 'both replacement creates')
      expect(predecessor.handle.snapshot().cleanupPending.hostReference).toBe(true)
      pin.release()
      const outcomes = await Promise.allSettled([leftPending, rightPending])
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
      expect(predecessor.handle.snapshot().cleanupPending).toEqual({
        provisionalLease: false, sessionLease: false, hostReference: false,
      })
      const snapshots = [left.handle.snapshot(), right.handle.snapshot()]
      expect(snapshots.map(snapshot => snapshot.metadata).sort()).toEqual(['applied', 'conflict'])
      const conflict = snapshots.find(snapshot => snapshot.metadata === 'conflict')!
      const applied = snapshots.find(snapshot => snapshot.metadata === 'applied')!
      expect(conflict.metadataCurrent?.opencodeSessionId).toBe(applied.record?.opencodeSessionId)
      expect(conflict.metadataImages.expected?.opencodeSessionId).toBe(predecessorRecord.opencodeSessionId)
      expect(applied.metadataImages.expected?.opencodeSessionId).toBe(predecessorRecord.opencodeSessionId)
      expect((await retainHostedSessionPublicationStore(new OpenCodeSessionStore(filePath)).readExact({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName,
      }))?.opencodeSessionId).toBe(applied.record?.opencodeSessionId)
      await Promise.all([
        bridge.releaseHostedSessionAttempt(predecessor.handle),
        bridge.releaseHostedSessionAttempt(left.handle),
        bridge.releaseHostedSessionAttempt(right.handle),
      ])
      expect(manager.getHost(custody.hostKey)).toBeNull()
    } finally { await fixture.close() }
  }, 120_000)

  test('cleanup requested while CAS holds the actual store lock waits for truthful publication and preserves predecessor ownership', async () => {
    let sessionOrdinal = 0
    let gatePublication = false
    let publicationEntered!: () => void
    let releasePublication!: () => void
    const entered = new Promise<void>(resolve => { publicationEntered = resolve })
    const gate = new Promise<void>(resolve => { releasePublication = resolve })
    const fixture = await supervisedFixture({
      mutateBundle(bundle) {
        const effect = bundle.prepareEffectToken
        bundle.prepareLeaseToken = async lease =>
          lease.teamId === supervisedLease.teamId &&
          (lease.runId === supervisedLease.runId || Boolean(lease.sessionId?.startsWith('ses_cas_cleanup_')))
            ? effect()
            : null
      },
      handle(request, response) {
        if (request.method === 'POST' && request.url === '/session') {
          response.end(JSON.stringify({ id: `ses_cas_cleanup_${++sessionOrdinal}` }))
          return
        }
        const result = request.url === '/global/health' ? { healthy: true } :
          request.url === '/agent' ? [] :
          request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
        response.end(canonicalHostedApprovalJson(result))
      },
    })
    try {
      const custody = await fixture.acquire()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      const manager = new OpenCodeHostManager({ acquisitionPolicy })
      const filePath = `${fixture.profile.profileRootPath}/cas-cleanup.json`
      const store = new OpenCodeSessionStore(filePath, undefined, {
        beforeRename: async () => {
          if (!gatePublication) return
          publicationEntered()
          await gate
        },
      })
      const bridge = new OpenCodeSessionBridge({ acquisitionPolicy, hostManager: manager,
        clientFactory: new OpenCodeClientFactory({ acquisitionPolicy }), sessionStore: store,
        hostedSessionPublicationStore: retainHostedSessionPublicationStore(store) })
      const makeContext = (attemptId: string, ordinal: number) =>
        bridge.createHostedSessionAttemptContext({
          attemptId,
          fence: { ownerPlanGeneration: 'generation-1', ownerIncarnation: 'incarnation-1',
            operationEpoch: 1, attemptOrdinal: ordinal },
          binding: { teamId: supervisedLease.teamId, runId: supervisedLease.runId,
            ownerLaneId: supervisedLease.laneId, memberName: supervisedLease.memberName,
            profileRootKey: fixture.profile.profileRootKey, hostKey: custody.hostKey,
            openCodeArtifactDigest: `sha256:${fixture.expected.executable.sha256}` },
          validateAttempt: () => true,
          armAttempt: async () => {}, recordCreated: async () => {}, recordUncertain: async () => {},
        })
      const ensure = (context: ReturnType<typeof makeContext>) => bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName, runId: supervisedLease.runId,
        selectedModel: 'test/model', preparedProfile: fixture.profile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: context,
      })
      const predecessor = makeContext('cas-cleanup-predecessor', 0)
      const predecessorRecord = await ensure(predecessor)
      gatePublication = true
      const replacement = makeContext('cas-cleanup-replacement', 1)
      const pending = ensure(replacement)
      await supervisedTestStage(entered, pending, 'hosted metadata CAS lock')
      await expect(bridge.releaseHostedSessionAttempt(replacement.handle))
        .rejects.toBeInstanceOf(OpenCodeHostedSessionCleanupPendingError)
      expect(replacement.handle.snapshot()).toMatchObject({
        effectInFlight: true, cleanupRequested: true, metadata: 'not_started',
      })
      releasePublication()
      await expect(pending).rejects.toThrow('metadata publication or predecessor cleanup failed')
      expect(replacement.handle.snapshot()).toMatchObject({
        effectInFlight: false, cleanupRequested: true, metadata: 'applied', phase: 'uncertain',
      })
      expect(predecessor.handle.snapshot().cleanupPending.hostReference).toBe(true)
      const published = await retainHostedSessionPublicationStore(new OpenCodeSessionStore(filePath)).readExact({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName,
      })
      expect(published?.opencodeSessionId).toBe('ses_cas_cleanup_2')
      expect(predecessorRecord.opencodeSessionId).toBe('ses_cas_cleanup_1')
      await Promise.all([
        bridge.releaseHostedSessionAttempt(replacement.handle),
        bridge.releaseHostedSessionAttempt(predecessor.handle),
      ])
      expect(manager.getHost(custody.hostKey)).toBeNull()
    } finally { releasePublication?.(); await fixture.close() }
  }, 120_000)

  test('cleanup requested during actual receipt promotion cannot settle or publish metadata', async () => {
    let promotionEntered!: () => void
    let releasePromotion!: () => void
    const entered = new Promise<void>(resolve => { promotionEntered = resolve })
    const gate = new Promise<void>(resolve => { releasePromotion = resolve })
    const fixture = await supervisedFixture({
      mutateBundle(bundle) {
        const effect = bundle.prepareEffectToken
        bundle.prepareLeaseToken = async lease => {
          if (lease.sessionId === supervisedLease.sessionId) {
            promotionEntered()
            await gate
          }
          return lease.teamId === supervisedLease.teamId &&
            (lease.runId === supervisedLease.runId || lease.sessionId === supervisedLease.sessionId)
            ? effect()
            : null
        }
      },
      handle(request, response) {
        if (request.method === 'POST' && request.url === '/session') {
          response.end(JSON.stringify({ id: supervisedLease.sessionId }))
          return
        }
        const result = request.url === '/global/health' ? { healthy: true } :
          request.url === '/agent' ? [] :
          request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
        response.end(canonicalHostedApprovalJson(result))
      },
    })
    try {
      const custody = await fixture.acquire()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      const manager = new OpenCodeHostManager({ acquisitionPolicy })
      const filePath = `${fixture.profile.profileRootPath}/promotion-cleanup.json`
      const store = new OpenCodeSessionStore(filePath)
      const bridge = new OpenCodeSessionBridge({ acquisitionPolicy, hostManager: manager,
        clientFactory: new OpenCodeClientFactory({ acquisitionPolicy }), sessionStore: store,
        hostedSessionPublicationStore: retainHostedSessionPublicationStore(store) })
      const context = bridge.createHostedSessionAttemptContext({
        attemptId: 'promotion-cleanup',
        fence: { ownerPlanGeneration: 'generation-1', ownerIncarnation: 'incarnation-1',
          operationEpoch: 1, attemptOrdinal: 0 },
        binding: { teamId: supervisedLease.teamId, runId: supervisedLease.runId,
          ownerLaneId: supervisedLease.laneId, memberName: supervisedLease.memberName,
          profileRootKey: fixture.profile.profileRootKey, hostKey: custody.hostKey,
          openCodeArtifactDigest: `sha256:${fixture.expected.executable.sha256}` },
        validateAttempt: () => true,
        armAttempt: async () => {}, recordCreated: async () => {}, recordUncertain: async () => {},
      })
      const pending = bridge.ensureSession({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName, runId: supervisedLease.runId,
        selectedModel: 'test/model', preparedProfile: fixture.profile,
        toolApprovalMode: 'manual', fresh: true, hostedAttempt: context,
      })
      await supervisedTestStage(entered, pending, 'hosted receipt promotion')
      await expect(bridge.releaseHostedSessionAttempt(context.handle))
        .rejects.toBeInstanceOf(OpenCodeHostedSessionCleanupPendingError)
      expect(context.handle.snapshot()).toMatchObject({
        effectInFlight: true, cleanupRequested: true, returnedSessionId: supervisedLease.sessionId,
        acquisition: { promotionState: 'inflight', pending: { provisional: true, session: false } },
      })
      releasePromotion()
      await expect(pending).rejects.toThrow('persistence or lease promotion failed')
      expect(context.handle.snapshot()).toMatchObject({
        effectInFlight: false, metadata: 'not_started',
        acquisition: { promotionState: 'present', pending: { provisional: false, session: true } },
      })
      expect(await retainHostedSessionPublicationStore(store).readExact({
        teamId: supervisedLease.teamId, laneId: supervisedLease.laneId,
        memberName: supervisedLease.memberName,
      })).toBeNull()
      await bridge.releaseHostedSessionAttempt(context.handle)
      expect(manager.getHost(custody.hostKey)).toBeNull()
    } finally { releasePromotion?.(); await fixture.close() }
  }, 120_000)

  test('bootstrap injection proceeds after a complete authenticated missing-message 404', async () => {
    const text = 'admitted bootstrap context'
    const messageID = 'msg_bootstrap'
    const message = { info: { id: messageID, role: 'user' }, parts: [{ type: 'text', text }] }
    let injected = false
    const fixture = await supervisedFixture({ handle(request, response) {
      if (request.method === 'POST' && request.url === '/session/ses_test/message') {
        injected = true; response.end(JSON.stringify(message)); return
      }
      if (request.url === `/session/ses_test/message/${messageID}`) {
        if (!injected) { response.statusCode = 404; response.end(); return }
        response.end(JSON.stringify(message)); return
      }
      const result = request.url?.startsWith('/session/ses_test/message') ? injected ? [message] : [] :
        request.url === '/global/health' ? { healthy: true } : request.url === '/agent' ? [] :
        request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
      response.end(canonicalHostedApprovalJson(result))
    } })
    try {
      const custody = await fixture.acquire()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      const store = new OpenCodeSessionStore(`${fixture.profile.profileRootPath}/sessions.json`)
      const bridge = new OpenCodeSessionBridge({ acquisitionPolicy, sessionStore: store,
        hostedSessionPublicationStore: retainHostedSessionPublicationStore(store),
        hostManager: new OpenCodeHostManager({ acquisitionPolicy }),
        clientFactory: new OpenCodeClientFactory({ acquisitionPolicy }),
        oauthRefreshCoordinator: { ensureFreshForPrompt: async () => ({ checked: false, refreshed: false }) },
      })
      const record = sessionRecord(fixture, custody.hostKey)
      await store.upsert(record)
      const contextHash = createHash('sha256').update(text).digest('hex')
      expect(await bridge.injectAppManagedBootstrapContext(record, {
        messageID, text, contextHash, briefingHash: 'fixture-briefing',
      })).toMatchObject({ messageID, runtimeSessionId: 'ses_test', alreadyPresent: false, contextHash })
      const posts = fixture.requests.filter(request => request.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(JSON.parse(posts[0]!.body.toString())).toMatchObject({ messageID, noReply: true, parts: message.parts })
      expect(fixture.requests.filter(request => request.url === `/session/ses_test/message/${messageID}`)).toHaveLength(2)
      await bridge.releaseSession(record)
    } finally { await fixture.close() }
  }, 120_000)

  test('snapshots the session and bound dependencies while host acquisition awaits health', async () => {
    let healthStarted!: () => void
    let releaseHealth!: () => void
    const started = new Promise<void>(resolve => { healthStarted = resolve })
    const healthGate = new Promise<void>(resolve => { releaseHealth = resolve })
    const fixture = await supervisedFixture({ handle(request, response) {
      if (request.url === '/global/health') {
        healthStarted(); void healthGate.then(() => response.end('{"healthy":true}')); return
      }
      const result = request.url === '/agent' ? [] : request.url?.endsWith('/abort') ? true :
        request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
      response.end(canonicalHostedApprovalJson(result))
    } })
    try {
      const custody = await fixture.acquire()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      const manager = new OpenCodeHostManager({ acquisitionPolicy })
      const factory = new OpenCodeClientFactory({ acquisitionPolicy })
      const store = new OpenCodeSessionStore(`${fixture.profile.profileRootPath}/sessions.json`)
      const deps = { acquisitionPolicy, hostManager: manager, clientFactory: factory, sessionStore: store,
        hostedSessionPublicationStore: retainHostedSessionPublicationStore(store) }
      const bridge = new OpenCodeSessionBridge(deps)
      const record = sessionRecord(fixture, custody.hostKey)
      const pending = bridge.abort(record)
      await supervisedTestStage(started, pending, 'bridge acquisition health')
      record.opencodeSessionId = 'ses_substituted'
      record.memberName = 'substituted'
      deps.hostManager = new OpenCodeHostManager()
      deps.clientFactory = new OpenCodeClientFactory({ fetchImpl: async () => { throw new Error('substituted') } })
      expect(Reflect.set(manager, 'ensureHost', async () => { throw new Error('substituted') })).toBe(false)
      expect(Reflect.set(factory, 'create', () => { throw new Error('substituted') })).toBe(false)
      releaseHealth()
      await expect(pending).resolves.toBe(true)
      expect(fixture.requests.at(-1)!.url).toBe('/session/ses_test/abort')
      expect(fixture.connections.some(connection => Buffer.concat(connection.chunks).includes(Buffer.from('ses_substituted')))).toBe(false)
      expect(manager.getHost(custody.hostKey)).toBeNull()
      const before = fixture.requests.length
      await expect(bridge.reconcileSession(sessionRecord(fixture, custody.hostKey), { sessionId: 'ses_unadmitted' }))
        .rejects.toThrow('not the admitted session')
      expect(fixture.requests).toHaveLength(before)
      await bridge.releaseSession(sessionRecord(fixture, custody.hostKey))
    } finally { releaseHealth?.(); await fixture.close() }
  }, 120_000)

  for (const mode of ['success', 'profile-rotation', 'session-rotation'] as const) {
    test(`actual supervised observe/reply preserves final fences: ${mode}`, async () => {
      const raw = { id: 'per_test', sessionID: 'ses_test', permission: 'bash', patterns: ['echo test'],
        always: [], metadata: {} }
      const permission = { requestId: raw.id, sessionId: raw.sessionID,
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
        permissionDigest: canonicalHostedApprovalDigest(raw), rawPermission: raw }
      const fixture = await supervisedFixture({ handle(request, response) {
        const hosted = fixture.expected.hosted
        const runtime = { schemaVersion: hosted.schemaVersion, protocol: hosted.protocol,
          runtimeInstanceId: hosted.runtimeInstanceId, configGeneration: hosted.configGeneration }
        const result = request.url === '/global/health' ? { healthy: true } :
          request.url === '/agent' ? [] : request.url?.endsWith('hosted-approval-capability') ? hosted :
          request.url?.endsWith('/permissions') ? { ...runtime, sessionId: raw.sessionID, permissions: [permission] } :
          request.url?.endsWith('/reply') ? { ...runtime, status: 'applied', requestId: raw.id, sessionId: raw.sessionID,
            sessionIncarnation: permission.sessionIncarnation, requestIncarnation: permission.requestIncarnation,
            permissionDigest: permission.permissionDigest, decision: 'allow_once' } : {}
        response.end(canonicalHostedApprovalJson(result))
      } })
      let release!: () => void
      try {
        const custody = await fixture.acquire()
        const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
        const manager = new OpenCodeHostManager({ acquisitionPolicy })
        const store = new OpenCodeSessionStore(`${fixture.profile.profileRootPath}/sessions.json`)
        const bridge = new OpenCodeSessionBridge({ acquisitionPolicy, hostManager: manager,
          clientFactory: new OpenCodeClientFactory({ acquisitionPolicy }), sessionStore: store,
          hostedSessionPublicationStore: retainHostedSessionPublicationStore(store) })
        const record = sessionRecord(fixture, custody.hostKey)
        await store.upsert(record)
        const [observed] = await bridge.observeHostedApprovalPermissions(record)
        expect(observed!.permission).toEqual(permission)
        let prepared!: () => void
        const ready = new Promise<void>(resolve => { prepared = resolve })
        const gate = new Promise<void>(resolve => { release = resolve })
        const params = {
          requestId: raw.id, decision: 'allow' as const, requireAtomicConfigReply: true,
          expectedPermissionRaw: raw, expectedHostedPermission: observed!,
          validatePreparedEffect: async ({ record: snapshot }: { record: OpenCodeSessionRecord }) =>
            store.prepareEffectToken(snapshot.teamId, snapshot.laneId!, snapshot.memberName, snapshot),
          authorizeEffect: async ({ record: snapshot }: { record: OpenCodeSessionRecord }) => {
            expect(Reflect.set(snapshot, 'opencodeSessionId', 'ses_callback_substitution')).toBe(false)
            prepared(); await gate
            return custody.prepareLeaseToken({ ...supervisedLease })
          },
        }
        const pending = bridge.answerPermission(record, params).then(value => ({ value }), error => ({ error }))
        await supervisedTestStage(ready, pending, `${mode} bridge effect authority`)
        if (mode === 'profile-rotation') await writeFile(fixture.profile.managedAuthPath, 'rotated')
        if (mode === 'session-rotation') await store.upsert({ ...record, opencodeSessionId: 'ses_recreated' })
        record.opencodeSessionId = 'ses_caller_substitution'
        params.requestId = 'per_caller_substitution'
        release()
        const result = await supervisedTestWait(pending, `${mode} bridge result`, 60_000)
        const posts = fixture.requests.filter(request => request.url.endsWith('/reply'))
        if (mode === 'success') {
          expect('value' in result && result.value).toMatchObject({ status: 'applied', sessionId: 'ses_test', requestId: 'per_test' })
          expect(posts).toHaveLength(1)
          expect(Object.keys(JSON.parse(posts[0]!.body.toString()))).toHaveLength(10)
        } else {
          expect('error' in result && result.error).toBeInstanceOf(mode === 'profile-rotation'
            ? OpenCodePermissionEffectNotAuthorizedError : OpenCodePermissionEffectUnavailableError)
          expect(posts).toHaveLength(0)
          await supervisedTestWait(Promise.all(fixture.connections.map(connection => connection.closed)),
            `${mode} actual TCP socket closure`)
          const wire = Buffer.concat(fixture.connections.flatMap(connection => connection.chunks)).toString()
          expect(wire).not.toContain('POST ')
        }
        for (const request of fixture.requests) {
          expect(request.headers.authorization).toBe(`Basic ${Buffer.from('opencode:fixture-secret').toString('base64')}`)
        }
        fixture.assertSocketCustody()
        expect(fixture.observations.filter(observation => observation.phase === 'response')
          .every(observation => observation.peerOperationNonce === null && observation.correlation === 'unavailable')).toBe(true)
        await bridge.releaseSession(sessionRecord(fixture, custody.hostKey))
      } finally { release?.(); await fixture.close() }
    }, 120_000)
  }
})
