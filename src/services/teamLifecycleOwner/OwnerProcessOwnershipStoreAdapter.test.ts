import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AnchorProcessSupervisorAdapter,
  commitProcessOwnership,
  completeOwnedProcessStop,
  computeCanonicalPolicyDigest,
  beginOwnedProcessStop,
  initializeProcessOwnershipState,
  markProcessOwnershipUnclassified,
  parseAnchorChannelRef,
  parseAnchorIdentityRef,
  parseExecutionUnitId,
  parseLaneId,
  parseMainProcessIdentityRef,
  parseMemberId,
  parseOwnedProcessRef,
  parseOwningProcessIdentityRef,
  parseProcessControllerInstanceId,
  parseProcessSupervisionSha256,
  parseRunId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
  parseSpawnNonce,
  parseTeamId,
  parseWorkspaceId,
  spawnNonceDigest,
  type CompositeRuntimePlanHash,
  type ProcessOwnerBinding,
  type ProcessOwnershipScope,
  type ProcessOwnershipState,
  type ProcessOwnershipStoreContext,
  type ProcessOwnershipStorePort,
  type ResolvedEnvironmentAuthorityRef,
  type ResolvedExecutableAuthorityRef,
  type ResolvedWorkdirAuthorityRef,
  type RuntimeCancellationId,
  type WorkspaceExecutionGrantId,
} from '@agent-teams/owner-anchor-library'
import type { NativeAcquisitionPreparedExpectation } from './NativeProcessAcquisition.js'
import { computeNativeProductPlanRefDigest } from './NativeProcessAcquisition.js'
import { createAttemptKey, createTeamLifecycleEffectJournal } from './TeamLifecycleEffectJournal.js'
import {
  assertDurableStateCapacity,
  cloneJson,
  createInitialDurableState,
  stringifyDurableState,
  type AttemptFence,
  type DurableAttempt,
} from './TeamLifecycleDurableState.js'
import { TeamLifecycleJournalTransactions } from './TeamLifecycleJournalTransactions.js'
import { createOwnerProcessOwnershipStoreAdapter } from './OwnerProcessOwnershipStoreAdapter.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const digest = (hex: string) => parseProcessSupervisionSha256(`sha256:${hex.repeat(64)}`)
const STORE_RUN_ID = `run_${'2'.repeat(32)}`
const STORE_TEAM_ID = `team_${'1'.repeat(32)}`

const ownerBinding: ProcessOwnerBinding = { authorityId: 'authority-fixture', bootId: 'boot-fixture' }
const controllerInstanceId = parseProcessControllerInstanceId('controller-fixture-0001')
const scope: ProcessOwnershipScope = { planRef: { teamId: parseTeamId(STORE_TEAM_ID), runId: parseRunId(STORE_RUN_ID),
  generation: 4, planHash: `sha256:${'3'.repeat(64)}` as CompositeRuntimePlanHash }, executionUnitId: parseExecutionUnitId('unit-fixture') }

function storeContext(): ProcessOwnershipStoreContext {
  return { deadline: { startedAt: 0, expiresAt: 100 }, clock: { now: () => 1 },
    cancellation: { cancellationId: 'cancellation-fixture' as RuntimeCancellationId, isCancellationRequested: () => false } }
}

function expectation(ordinal = 0, unitScope = scope): { expected: NativeAcquisitionPreparedExpectation; fence: AttemptFence } {
  const ownerPlanGeneration = 'owner-plan-store'
  const key = createAttemptKey({ ownerPlanGeneration, runId: STORE_RUN_ID, originalLaneId: 'lane-store', globalOrdinal: ordinal, attemptOrdinal: 0 })
  const fence: AttemptFence = { key, runId: STORE_RUN_ID, ownerIncarnation: 'owner-store', controllerInstanceId,
    ownerPlanGeneration, operationEpoch: 1, attemptOrdinal: 0 }
  const binaryPolicy = { policy: 'registered_exact_binary' as const, binaryId: parseRuntimeBinaryId('binary'),
    binaryRevision: 1, binaryHash: digest('4') }
  const environmentPolicy = { policy: 'explicit_allowlist' as const, variables: [] }
  const resourcePolicy = { maxRuntimeMs: 60_000, gracefulStopMs: 1_000, maxOutputBytes: 65_536, maxProcessCount: 1 }
  const workspaceGrant = { grantId: 'workspace-grant-store' as WorkspaceExecutionGrantId,
    workspaceId: parseWorkspaceId(`workspace_${'5'.repeat(32)}`),
    registrationRevision: 2, bindingGeneration: 3, mountGeneration: 4, permission: 'execute_process' as const }
  const laneId = parseLaneId('lane-store')
  const memberId = `member_${(ordinal + 6).toString(16).padStart(32, '0')}`
  const expected: NativeAcquisitionPreparedExpectation = { version: 1, role: 'native-worker', publicTeamId: STORE_TEAM_ID, legacyKey: 'fixture', runId: STORE_RUN_ID,
    attemptSetId: 'set', attemptToken: `attempt-store-${ordinal}-0000`, memberOrdinal: ordinal, laneId: 'lane-store', displayName: `worker-${ordinal}`,
    agentId: memberId, provider: 'anthropic', model: 'model', ownerBootId: ownerBinding.bootId,
    ownerControllerInstanceId: controllerInstanceId, ownerPlanGeneration, productPlanGeneration: 4,
    productPlanRef: computeNativeProductPlanRefDigest(unitScope.planRef),
    materialDigest: 'material', recipeDigest: `recipe-${ordinal}`, profileDigest: 'profile', binding: {
      ownerPlanGeneration, ownerUnitBindingId: `binding-${ordinal}`, orderedMembers: [{ ordinal, memberId }],
      executionUnit: { executionUnitId: unitScope.executionUnitId, laneId, memberIds: [parseMemberId(memberId)],
        backendBinding: { backend: 'provisioning_cli', bindingId: parseRuntimeBackendBindingId(`binding-${ordinal}`), bindingRevision: 1 },
        binaryPolicy, environmentPolicy, credentialExposureSet: { secretRefs: [] }, credentialIsolation: 'dedicated_execution_unit', resourcePolicy },
      launchSpec: { planRef: unitScope.planRef, executionUnitId: unitScope.executionUnitId,
        backend: 'provisioning_cli', argvAuthority: { executableRef: 'executable-authority-store' as ResolvedExecutableAuthorityRef,
          argv: ['worker'], argvHash: digest('7'), binaryPolicy },
        workdirAuthority: { workdirRef: 'workdir-authority-store' as ResolvedWorkdirAuthorityRef, grant: workspaceGrant },
        environmentAuthority: { environmentRef: 'environment-authority-store' as ResolvedEnvironmentAuthorityRef, policy: environmentPolicy },
        resourcePolicy },
    } }
  return { expected, fence }
}

function spawnIntent(relayScopeDigest = expectedRelayScopeDigest()): ProcessOwnershipState {
  const environmentPolicy = { policy: 'explicit_allowlist' as const, variables: [] }
  return initializeProcessOwnershipState({
    intentVersion: 1, scope, processRef: parseOwnedProcessRef('owner-process:fixture'), spawnNonce: parseSpawnNonce('owner-spawn:fixture'),
    workspaceBinding: { workspaceId: parseWorkspaceId(`workspace_${'5'.repeat(32)}`), registrationRevision: 2, bindingGeneration: 3, mountGeneration: 4 },
    binaryBinding: { policy: 'registered_exact_binary', binaryId: parseRuntimeBinaryId('binary'), binaryRevision: 1,
      binaryHash: digest('4') },
    argvDigest: digest('7'), argvCount: 1,
    environmentPolicyDigest: computeCanonicalPolicyDigest(environmentPolicy), relayScopeDigest,
  })
}

function expectedRelayScopeDigest() {
  const executionUnit = expectation().expected.binding.executionUnit
  return computeCanonicalPolicyDigest({ laneId: executionUnit.laneId, memberIds: executionUnit.memberIds })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'owner-store-'))
  roots.push(root)
  const transactions = new TeamLifecycleJournalTransactions(join(root, 'execution.json'))
  const base = createInitialDurableState('a'.repeat(64), 'auto')
  await transactions.initialize({ ...base, phase: 'launching', runId: STORE_RUN_ID, ownerIncarnation: 'owner-store', operationEpoch: 1 })
  const journal = createTeamLifecycleEffectJournal({ transactions })
  const admitted = expectation()
  await journal.recorder(admitted.fence).armAttempt(admitted.expected)
  return { transactions, journal, store: createOwnerProcessOwnershipStoreAdapter({ transactions, ownerBinding, controllerInstanceId }) }
}

async function publishOwned(store: ProcessOwnershipStorePort) {
  const intent = spawnIntent()
  const initialized = await store.compareAndSwap({ scope, expectedRevision: null, next: intent, context: storeContext() })
  if (initialized.status !== 'applied') throw new Error(`Fixture intent publication failed: ${initialized.status}`)
  const nonceDigest = spawnNonceDigest(intent.intent.spawnNonce)
  const ownerAttestation = { attestationVersion: 1 as const, ...ownerBinding, processRef: intent.intent.processRef, scope,
    workspaceBinding: intent.intent.workspaceBinding, spawnNonceDigest: nonceDigest,
    channelRef: parseAnchorChannelRef('channel-reference-fixture'),
    owningProcessIdentityRef: parseOwningProcessIdentityRef('owner-identity-fixture'),
    anchorIdentityRef: parseAnchorIdentityRef('anchor-identity-fixture') }
  const transition = commitProcessOwnership(intent, { processRef: intent.intent.processRef, scope,
    workspaceBinding: intent.intent.workspaceBinding, spawnNonceDigest: nonceDigest, controllerInstanceId,
    ownerAttestation, mainProcessIdentityRef: parseMainProcessIdentityRef('main-process-identity'), statusSequence: 1 })
  if (transition.status !== 'accepted') throw new Error(`Fixture ownership transition rejected: ${transition.reason}`)
  const committed = await store.compareAndSwap({ scope, expectedRevision: intent.revision, next: transition.next,
    context: storeContext() })
  if (committed.status !== 'applied') throw new Error(`Fixture ownership publication failed: ${committed.status}`)
  return { intent, owned: transition.next, ownerAttestation, nonceDigest }
}

function productSupervisor(store: ProcessOwnershipStorePort, binding = ownerBinding) {
  return new AnchorProcessSupervisorAdapter({
    store,
    ownerBinding: binding,
    controllerInstanceId,
    identities: {
      createProcessRef: () => parseOwnedProcessRef('owner-process:unused'),
      createSpawnNonce: () => parseSpawnNonce('owner-spawn:unused'),
    },
    spawner: { spawn: async () => ({ status: 'unavailable' as const }) },
    clock: { now: () => 1 },
    launchTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    recoveryTimeoutMs: 1_000,
  })
}

describe('OwnerProcessOwnershipStoreAdapter', () => {
  test('loads by exact scope/ref and CASes Product revision independently of Owner revision', async () => {
    const { transactions, store } = await fixture()
    const beforeOwnerRevision = await transactions.read(state => state.revision)
    expect(await store.load(scope, storeContext())).toEqual({ status: 'missing' })
    const intent = spawnIntent()
    const first = await store.compareAndSwap({ scope, expectedRevision: null, next: intent, context: storeContext() })
    expect(first).toMatchObject({ status: 'applied', state: { revision: 1, phase: 'spawn_intent' } })
    expect(await transactions.read(state => state.revision)).toBe(beforeOwnerRevision + 1)
    expect(await store.loadByProcessRef(intent.intent.processRef, storeContext())).toMatchObject({ status: 'found', state: { revision: 1 } })

    const conflict = await store.compareAndSwap({ scope, expectedRevision: 9, next: intent, context: storeContext() })
    expect(conflict).toEqual({ status: 'conflict' })
    const loaded = await store.load(scope, storeContext())
    expect(loaded.status).toBe('found')
    if (loaded.status === 'found') {
      expect(Object.isFrozen(loaded.state)).toBeTrue()
      const snapshot = cloneJson(loaded.state)
      expect(Reflect.set(loaded.state, 'revision', 99)).toBeFalse()
      expect(loaded.state).toEqual(snapshot)
      expect(await store.load(scope, storeContext())).toEqual({ status: 'found', state: snapshot })
    }
  })

  test('joins the first published relay digest to the admitted execution unit', async () => {
    const valid = await fixture()
    expect((await valid.store.compareAndSwap({ scope, expectedRevision: null, next: spawnIntent(), context: storeContext() })).status)
      .toBe('applied')

    const substituted = await fixture()
    const wrongDigest = expectedRelayScopeDigest() === digest('9') ? digest('8') : digest('9')
    expect((await substituted.store.compareAndSwap({ scope, expectedRevision: null, next: spawnIntent(wrongDigest),
      context: storeContext() })).status).toBe('unavailable')
  })

  test('runs actual Product stop with expanded scope and preserves stopping/effect/terminal ordering', async () => {
    const { store } = await fixture()
    const published = await publishOwned(store)
    const expandedScope = { ...scope, processRef: published.intent.intent.processRef, ...ownerBinding,
      mode: 'graceful' as const, timeoutMs: 1_000,
      cancellation: { cancellationId: 'cancellation-expanded-load' as RuntimeCancellationId,
        isCancellationRequested: () => false } }
    expect(await store.load(expandedScope, storeContext())).toMatchObject({ status: 'found', state: { phase: 'owned' } })

    const publications: string[] = []
    const observedStore: ProcessOwnershipStorePort = {
      load: (requestedScope, context) => store.load(requestedScope, context),
      loadByProcessRef: (processRef, context) => store.loadByProcessRef(processRef, context),
      compareAndSwap: async request => {
        expect(request.scope).toMatchObject(expandedScope)
        const result = await store.compareAndSwap(request)
        if (result.status === 'applied') publications.push(`cas:${result.state.phase}`)
        return result
      },
    }
    const supervisor = productSupervisor(observedStore)
    let effectObservedStopping = false
    supervisor.stopAndDrain = async request => {
      const duringEffect = await store.loadByProcessRef(request.ownership.processRef, storeContext())
      expect(duringEffect).toMatchObject({ status: 'found', state: { phase: 'stopping', revision: 3 } })
      effectObservedStopping = true
      publications.push('effect:stopping')
      return { status: 'drained', proof: {
        processRef: request.ownership.processRef,
        scope: request.ownership.scope,
        spawnNonceDigest: request.ownership.spawnNonceDigest,
        ownerAttestation: request.ownership.ownerAttestation,
        ownedProcessEof: { processRef: request.ownership.processRef,
          ownerAttestation: request.ownership.ownerAttestation, observed: true },
        statusSequence: request.ownership.lastStatusSequence + 1,
        outcome: 'drained',
        residuals: [],
      } }
    }
    expect(await supervisor.stop({ planRef: scope.planRef, executionUnitId: scope.executionUnitId,
      processRef: published.intent.intent.processRef as never, mode: 'graceful',
      cancellation: expandedScope.cancellation })).toEqual({ status: 'drained' })
    expect(effectObservedStopping).toBeTrue()
    expect(publications).toEqual(['cas:stopping', 'effect:stopping', 'cas:drained'])
    const terminal = await store.loadByProcessRef(published.intent.intent.processRef, storeContext())
    expect(terminal).toMatchObject({ status: 'found', state: { phase: 'drained', revision: 4 } })
    if (terminal.status === 'found') expect(terminal.state.intent.scope).toEqual(scope)
  })

  test('actual Product stop rejects substituted scope, reference, or owner before process control', async () => {
    const cases: ReadonlyArray<{
      name: string
      request: ProcessOwnershipScope & { processRef?: ReturnType<typeof parseOwnedProcessRef> }
      binding: ProcessOwnerBinding
    }> = [
      { name: 'plan ref', request: { planRef: { ...scope.planRef, generation: scope.planRef.generation + 1 },
        executionUnitId: scope.executionUnitId }, binding: ownerBinding },
      { name: 'execution unit', request: { planRef: scope.planRef,
        executionUnitId: parseExecutionUnitId('unit-foreign') }, binding: ownerBinding },
      { name: 'process ref', request: { planRef: scope.planRef, executionUnitId: scope.executionUnitId,
        processRef: parseOwnedProcessRef('owner-process:foreign') }, binding: ownerBinding },
      { name: 'authority', request: { planRef: scope.planRef, executionUnitId: scope.executionUnitId },
        binding: { ...ownerBinding, authorityId: 'authority-foreign' } },
      { name: 'boot', request: { planRef: scope.planRef, executionUnitId: scope.executionUnitId },
        binding: { ...ownerBinding, bootId: 'boot-foreign' } },
    ]
    for (const candidate of cases) {
      const { store } = await fixture()
      const published = await publishOwned(store)
      const supervisor = productSupervisor(store, candidate.binding)
      let effectCalled = false
      supervisor.stopAndDrain = async () => {
        effectCalled = true
        return { status: 'unavailable' }
      }
      expect(await supervisor.stop({ planRef: candidate.request.planRef, executionUnitId: candidate.request.executionUnitId,
        processRef: (candidate.request.processRef ?? published.intent.intent.processRef) as never, mode: 'graceful',
        cancellation: { cancellationId: `cancellation-${candidate.name}` as RuntimeCancellationId,
          isCancellationRequested: () => false } })).toEqual({ status: 'unclassified_residual' })
      expect(effectCalled).toBeFalse()
      expect(await store.loadByProcessRef(published.intent.intent.processRef, storeContext()))
        .toMatchObject({ status: 'found', state: { phase: 'owned', revision: 2 } })
    }
  })

  test('accepts the immutable Product owned transition and rejects controller substitution', async () => {
    const { store } = await fixture()
    const intent = spawnIntent()
    expect((await store.compareAndSwap({ scope, expectedRevision: null, next: intent, context: storeContext() })).status).toBe('applied')
    const nonceDigest = spawnNonceDigest(intent.intent.spawnNonce)
    const ownerAttestation = { attestationVersion: 1 as const, ...ownerBinding, processRef: intent.intent.processRef, scope,
      workspaceBinding: intent.intent.workspaceBinding, spawnNonceDigest: nonceDigest, channelRef: parseAnchorChannelRef('channel-reference-fixture'),
      owningProcessIdentityRef: parseOwningProcessIdentityRef('owner-identity-fixture'),
      anchorIdentityRef: parseAnchorIdentityRef('anchor-identity-fixture') }
    const substitutedTransition = commitProcessOwnership(intent, { processRef: intent.intent.processRef, scope,
      workspaceBinding: intent.intent.workspaceBinding, spawnNonceDigest: nonceDigest,
      controllerInstanceId: parseProcessControllerInstanceId('controller-other-00001'), ownerAttestation,
      mainProcessIdentityRef: parseMainProcessIdentityRef('main-process-identity'), statusSequence: 1 })
    if (substitutedTransition.status !== 'accepted') throw new Error(`Fixture substitution transition rejected: ${substitutedTransition.reason}`)
    expect((await store.compareAndSwap({ scope, expectedRevision: 1, next: substitutedTransition.next, context: storeContext() })).status).toBe('unavailable')
    const transition = commitProcessOwnership(intent, { processRef: intent.intent.processRef, scope,
      workspaceBinding: intent.intent.workspaceBinding, spawnNonceDigest: nonceDigest, controllerInstanceId,
      ownerAttestation, mainProcessIdentityRef: parseMainProcessIdentityRef('main-process-identity'), statusSequence: 1 })
    if (transition.status !== 'accepted') throw new Error(`Fixture ownership transition rejected: ${transition.reason}`)
    expect((await store.compareAndSwap({ scope, expectedRevision: 1, next: transition.next, context: storeContext() })).status).toBe('applied')
  })

  test('rejects first ownership with a non-Product nonce digest or foreign attestation workspace', async () => {
    for (const substitution of ['nonce', 'attestation-workspace'] as const) {
      const { store } = await fixture()
      const intent = spawnIntent()
      expect((await store.compareAndSwap({ scope, expectedRevision: null, next: intent, context: storeContext() })).status).toBe('applied')
      const nonceDigest = spawnNonceDigest(intent.intent.spawnNonce)
      const ownerAttestation = { attestationVersion: 1 as const, ...ownerBinding, processRef: intent.intent.processRef, scope,
        workspaceBinding: intent.intent.workspaceBinding, spawnNonceDigest: nonceDigest,
        channelRef: parseAnchorChannelRef('channel-reference-fixture'),
        owningProcessIdentityRef: parseOwningProcessIdentityRef('owner-identity-fixture'),
        anchorIdentityRef: parseAnchorIdentityRef('anchor-identity-fixture') }
      const transition = commitProcessOwnership(intent, { processRef: intent.intent.processRef, scope,
        workspaceBinding: intent.intent.workspaceBinding, spawnNonceDigest: nonceDigest, controllerInstanceId,
        ownerAttestation, mainProcessIdentityRef: parseMainProcessIdentityRef('main-process-identity'), statusSequence: 1 })
      if (transition.status !== 'accepted') throw new Error(`Fixture ownership transition rejected: ${transition.reason}`)
      const next = substitution === 'nonce'
        ? substitute(transition.next, ['ownership', 'spawnNonceDigest'], digest('c'))
        : substitute(transition.next, ['ownership', 'ownerAttestation', 'workspaceBinding'], {
          ...intent.intent.workspaceBinding, mountGeneration: 99,
        })
      expect((await store.compareAndSwap({ scope, expectedRevision: intent.revision, next, context: storeContext() })).status)
        .toBe('unavailable')
    }
  })

  test('rejects first CAS after run, incarnation, epoch, controller, or owner-boot substitution', async () => {
    for (const mutation of [
      { runId: `run_${'9'.repeat(32)}` },
      { ownerIncarnation: 'owner-replaced' },
      { operationEpoch: 2 },
    ]) {
      const { transactions, store } = await fixture()
      await transactions.update(state => ({ state: { ...state, ...mutation }, value: undefined }))
      expect((await store.compareAndSwap({ scope, expectedRevision: null, next: spawnIntent(), context: storeContext() })).status)
        .toBe('unavailable')
    }
    const { transactions } = await fixture()
    const foreignController = createOwnerProcessOwnershipStoreAdapter({ transactions, ownerBinding,
      controllerInstanceId: parseProcessControllerInstanceId('controller-foreign-0001') })
    const foreignBoot = createOwnerProcessOwnershipStoreAdapter({ transactions,
      ownerBinding: { ...ownerBinding, bootId: 'boot-foreign' }, controllerInstanceId })
    expect((await foreignController.compareAndSwap({ scope, expectedRevision: null, next: spawnIntent(), context: storeContext() })).status)
      .toBe('unavailable')
    expect((await foreignBoot.compareAndSwap({ scope, expectedRevision: null, next: spawnIntent(), context: storeContext() })).status)
      .toBe('unavailable')
  })

  test('permits exact stale cleanup but rejects it through a foreign owner', async () => {
    const { transactions, store } = await fixture()
    const intent = spawnIntent()
    expect((await store.compareAndSwap({ scope, expectedRevision: null, next: intent, context: storeContext() })).status).toBe('applied')
    await transactions.update(state => ({ state: { ...state, operationEpoch: 2 }, value: undefined }))
    const cleanup = markProcessOwnershipUnclassified(intent, 'stale exact cleanup')
    expect((await store.compareAndSwap({ scope, expectedRevision: intent.revision, next: cleanup, context: storeContext() })).status).toBe('applied')

    const foreign = createOwnerProcessOwnershipStoreAdapter({ transactions,
      ownerBinding: { ...ownerBinding, bootId: 'boot-foreign' }, controllerInstanceId })
    expect((await foreign.load(scope, storeContext())).status).toBe('unavailable')
  })

  test('rejects substitution of every immutable ownership and attestation field', async () => {
    const { store } = await fixture()
    const intent = spawnIntent()
    expect((await store.compareAndSwap({ scope, expectedRevision: null, next: intent, context: storeContext() })).status).toBe('applied')
    const nonceDigest = spawnNonceDigest(intent.intent.spawnNonce)
    const ownerAttestation = { attestationVersion: 1 as const, ...ownerBinding, processRef: intent.intent.processRef, scope,
      workspaceBinding: intent.intent.workspaceBinding, spawnNonceDigest: nonceDigest,
      channelRef: parseAnchorChannelRef('channel-reference-fixture'),
      owningProcessIdentityRef: parseOwningProcessIdentityRef('owner-identity-fixture'),
      anchorIdentityRef: parseAnchorIdentityRef('anchor-identity-fixture') }
    const transition = commitProcessOwnership(intent, { processRef: intent.intent.processRef, scope,
      workspaceBinding: intent.intent.workspaceBinding, spawnNonceDigest: nonceDigest, controllerInstanceId,
      ownerAttestation, mainProcessIdentityRef: parseMainProcessIdentityRef('main-process-identity'), statusSequence: 1 })
    if (transition.status !== 'accepted') throw new Error(`Fixture ownership transition rejected: ${transition.reason}`)
    expect((await store.compareAndSwap({ scope, expectedRevision: intent.revision, next: transition.next, context: storeContext() })).status).toBe('applied')
    const stopping = beginOwnedProcessStop(transition.next, { processRef: intent.intent.processRef, ...scope, ...ownerBinding })
    if (stopping.status !== 'accepted') throw new Error(`Fixture stopping transition rejected: ${stopping.reason}`)
    const substitutions: ReadonlyArray<readonly [readonly string[], unknown]> = [
      [['ownership', 'recordVersion'], 2],
      [['ownership', 'processRef'], parseOwnedProcessRef('owner-process:foreign')],
      [['ownership', 'scope'], { ...scope, executionUnitId: parseExecutionUnitId('unit-foreign') }],
      [['ownership', 'workspaceBinding'], { ...intent.intent.workspaceBinding, mountGeneration: 99 }],
      [['ownership', 'spawnNonceDigest'], digest('b')],
      [['ownership', 'controllerInstanceId'], parseProcessControllerInstanceId('controller-foreign-0001')],
      [['ownership', 'mainProcessIdentityRef'], parseMainProcessIdentityRef('main-process-identity-foreign')],
      [['ownership', 'ownerAttestation', 'attestationVersion'], 2],
      [['ownership', 'ownerAttestation', 'authorityId'], 'authority-foreign'],
      [['ownership', 'ownerAttestation', 'bootId'], 'boot-foreign'],
      [['ownership', 'ownerAttestation', 'processRef'], parseOwnedProcessRef('owner-process:foreign')],
      [['ownership', 'ownerAttestation', 'scope'], { ...scope, executionUnitId: parseExecutionUnitId('unit-foreign') }],
      [['ownership', 'ownerAttestation', 'workspaceBinding'], { ...intent.intent.workspaceBinding, mountGeneration: 99 }],
      [['ownership', 'ownerAttestation', 'spawnNonceDigest'], digest('b')],
      [['ownership', 'ownerAttestation', 'channelRef'], parseAnchorChannelRef('channel-reference-foreign')],
      [['ownership', 'ownerAttestation', 'owningProcessIdentityRef'], parseOwningProcessIdentityRef('owner-identity-foreign')],
      [['ownership', 'ownerAttestation', 'anchorIdentityRef'], parseAnchorIdentityRef('anchor-identity-foreign')],
    ]
    for (const [path, value] of substitutions) {
      const substituted = substitute(stopping.next, path, value)
      expect((await store.compareAndSwap({ scope, expectedRevision: transition.next.revision, next: substituted,
        context: storeContext() })).status).toBe('unavailable')
    }
    expect((await store.compareAndSwap({ scope, expectedRevision: transition.next.revision, next: stopping.next,
      context: storeContext() })).status).toBe('applied')
    const drained = completeOwnedProcessStop(stopping.next, {
      processRef: intent.intent.processRef,
      scope,
      spawnNonceDigest: nonceDigest,
      ownerAttestation,
      ownedProcessEof: { processRef: intent.intent.processRef, ownerAttestation, observed: true },
      statusSequence: 2,
      outcome: 'drained',
      residuals: [],
    })
    if (drained.status !== 'accepted') throw new Error(`Fixture drain transition rejected: ${drained.reason}`)
    expect((await store.compareAndSwap({ scope, expectedRevision: stopping.next.revision, next: drained.next,
      context: storeContext() })).status).toBe('applied')
  })

  test('fails closed for duplicate admitted scope and missing initialized storage', async () => {
    const { transactions, journal, store } = await fixture()
    const duplicate = expectation(1)
    await expect(journal.recorder(duplicate.fence).armAttempt(duplicate.expected))
      .rejects.toThrow('Native attempt scope is already reserved')

    const corrupted = await transactions.read(state => {
      const result = cloneJson(state)
      result.attempts[duplicate.fence.key] = armedAttempt(duplicate)
      return result
    })
    // Deliberately bypass only the private fixture writer. The real parser/codec remains on the
    // store read path and must reject this duplicate-scope persisted document fail closed.
    await writeFile(transactions.statePath, `${stringifyDurableState(corrupted)}\n`, { mode: 0o600 })
    expect(await store.load(scope, storeContext())).toEqual({ status: 'unavailable' })
    await rm(transactions.statePath)
    expect(await store.load(scope, storeContext())).toEqual({ status: 'unavailable' })
  })

  test('routes bulk attempt growth through the centralized byte reserve before publication', async () => {
    const { transactions } = await fixture()
    const admittedCount = await transactions.read(state => {
      let candidate = cloneJson(state)
      for (let ordinal = 1; ordinal < 4096; ordinal += 1) {
        const admitted = expectation(ordinal, scopeForOrdinal(ordinal))
        const next = { ...candidate, revision: state.revision + 1, attempts: {
          ...candidate.attempts,
          [admitted.fence.key]: armedAttempt(admitted),
        } }
        try {
          assertDurableStateCapacity(next)
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('terminal byte reserve')) throw error
          return Object.keys(candidate.attempts).length
        }
        candidate = next
      }
      throw new Error('Derived attempt charge did not reach physical capacity')
    })
    await transactions.update(state => {
      const attempts = { ...state.attempts }
      for (let ordinal = 1; ordinal < admittedCount; ordinal += 1) {
        const admitted = expectation(ordinal, scopeForOrdinal(ordinal))
        attempts[admitted.fence.key] = armedAttempt(admitted)
      }
      return { state: { ...state, attempts }, value: undefined }
    })
    expect(await transactions.read(state => Object.keys(state.attempts).length)).toBe(admittedCount)
    const before = await readFile(transactions.statePath, 'utf8')
    await expect(transactions.update(state => {
      const attempts = { ...state.attempts }
      const admitted = expectation(admittedCount, scopeForOrdinal(admittedCount))
      attempts[admitted.fence.key] = armedAttempt(admitted)
      return { state: { ...state, attempts }, value: undefined }
    })).rejects.toThrow('Team lifecycle terminal byte reserve unavailable')
    expect(await readFile(transactions.statePath, 'utf8')).toBe(before)
  })

  test('reserves the last terminal slot and rejects a second outstanding attempt', () => {
    const first = expectation(0, scopeForOrdinal(0))
    const state = {
      ...createInitialDurableState('a'.repeat(64), 'auto'),
      phase: 'launching' as const,
      runId: STORE_RUN_ID,
      ownerIncarnation: 'owner-store',
      operationEpoch: 1,
      attempts: { [first.fence.key]: armedAttempt(first) },
    }
    // Slot arithmetic is isolated from encoded-byte pressure here; physical publications exercise
    // both bounds together through validateDurableStateForWrite in the preceding regression.
    Reflect.set(state, 'tombstones', Array.from({ length: 8191 }, () => Object.freeze({})))
    expect(() => assertDurableStateCapacity(state, 0)).not.toThrow()
    const second = expectation(1, scopeForOrdinal(1))
    Reflect.set(state, 'attempts', { ...state.attempts, [second.fence.key]: armedAttempt(second) })
    expect(() => assertDurableStateCapacity(state, 0)).toThrow('slot')
  })
})

function scopeForOrdinal(ordinal: number): ProcessOwnershipScope {
  return { ...scope, executionUnitId: parseExecutionUnitId(`unit-fixture-${ordinal}`) }
}

function armedAttempt(input: ReturnType<typeof expectation>): DurableAttempt {
  return { key: input.fence.key, kind: 'native', phase: 'armed', fence: input.fence, expected: input.expected }
}

function substitute(state: ProcessOwnershipState, path: readonly string[], value: unknown): ProcessOwnershipState {
  const result = cloneJson(state)
  let target: object = result
  for (const name of path.slice(0, -1)) {
    const child = Reflect.get(target, name)
    if (!child || typeof child !== 'object') throw new Error(`Invalid substitution path ${path.join('.')}`)
    target = child
  }
  const name = path.at(-1)
  if (!name || !Reflect.set(target, name, value)) throw new Error(`Failed substitution ${path.join('.')}`)
  return result
}
