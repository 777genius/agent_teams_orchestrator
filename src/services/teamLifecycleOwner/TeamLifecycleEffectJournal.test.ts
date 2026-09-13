import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import * as OwnerAnchorLibrary from '@agent-teams/owner-anchor-library'
import {
  computeCanonicalPolicyDigest,
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
  type HostedChildEnvironmentPolicy,
  type NodeAnchorLaunchAuthorityCatalog,
  type NodeAnchorProviderStdio,
  type ObserveProcessExecutionUnitRequest,
  type OwnedProcessRef,
  type ProcessOwnerBinding,
  type ProcessOwnershipRecord,
  type ProcessOwnershipState,
  type ProcessOwnershipStorePort,
  type ResolvedEnvironmentAuthorityRef,
  type ResolvedExecutableAuthorityRef,
  type ResolvedWorkdirAuthorityRef,
  type RuntimeCancellationId,
  type SupervisedProcessRef,
  type WorkspaceExecutionGrantId,
} from '@agent-teams/owner-anchor-library'
import { computeHostedNativeEnvelopeDigest, type HostedNativeLaunchEnvelope } from 'src/services/teamBootstrap/hostedNativeLaunch.js'
import { buildResolvedNativeProcessEnv, buildResolvedNativeProcessFlags } from 'src/utils/swarm/spawnUtils.js'
import * as canonicalTeamHelpers from 'src/utils/swarm/teamHelpers.js'
import type {
  NativeAcquisitionDrainProof,
  NativeAcquisitionPreparedExpectation,
  NativeAcquisitionRecorder,
  NativeAttemptEffectAuthorization,
  NativeProcessReadinessProof,
  OwnedNativeProcessIdentity,
} from './NativeProcessAcquisition.js'
import {
  computeNativeLaunchCatalogDigest,
  computeNativeProductPlanRefDigest,
  createNativeProcessAcquisition,
  NativeProcessAcquisitionFailure,
  prepareNativeProcessAcquisition,
  type NativePreparedAttemptInput,
} from './NativeProcessAcquisition.js'
import type { HostedOwnerAnchorLibrary, LoadedHostedOwnerAnchorLibrary } from './HostedOwnerAnchorLibrary.js'
import { resolveNativeProcessLaunchMaterial } from './NativeProcessLaunchMaterial.js'
import { createOwnerProcessOwnershipStoreAdapter } from './OwnerProcessOwnershipStoreAdapter.js'
import { createAttemptKey, createTeamLifecycleEffectJournal } from './TeamLifecycleEffectJournal.js'
import {
  assertDurableStateCapacity,
  createInitialDurableState,
  decodeDurableState,
  durableAttemptReservationBytes,
  durableAttemptSettlementEnvelopeBytes,
  ownedProcessRefsEqual,
  parseDurableStateJson,
  safeDurableJsonByteLength,
  stringifyDurableState,
  TEAM_LIFECYCLE_CLEANUP_FAILURE_CAPACITY,
  TEAM_LIFECYCLE_STATE_MAX_BYTES,
  TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES,
  TEAM_LIFECYCLE_UNCERTAIN_EVIDENCE_CAPACITY,
  type AttemptFence,
  type DurableAttempt,
} from './TeamLifecycleDurableState.js'
import { TeamLifecycleJournalTransactions } from './TeamLifecycleJournalTransactions.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const digest = (hex: string) => parseProcessSupervisionSha256(`sha256:${hex.repeat(64)}`)
const JOURNAL_RUN_ID = `run_${'4'.repeat(32)}`
const JOURNAL_TEAM_ID = `team_${'3'.repeat(32)}`
const JOURNAL_MEMBER_ID = `member_${'2'.repeat(32)}`

function fixture() {
  const runId = JOURNAL_RUN_ID
  const ownerPlanGeneration = 'owner-generation-journal'
  const key = createAttemptKey({ ownerPlanGeneration, runId, originalLaneId: 'lane-a', globalOrdinal: 2, attemptOrdinal: 0 })
  const fence: AttemptFence = { key, runId, ownerIncarnation: 'owner_fixture', controllerInstanceId: 'controller-fixture-0001',
    ownerPlanGeneration, operationEpoch: 1, attemptOrdinal: 0 }
  const executionUnitId = parseExecutionUnitId('unit-a')
  const laneId = parseLaneId('lane-a')
  const planRef = {
    teamId: parseTeamId(JOURNAL_TEAM_ID),
    runId: parseRunId(runId),
    generation: 7,
    planHash: `sha256:${'5'.repeat(64)}` as CompositeRuntimePlanHash,
  }
  const binaryPolicy = { policy: 'registered_exact_binary' as const, binaryId: parseRuntimeBinaryId('binary-a'),
    binaryRevision: 1, binaryHash: digest('b') }
  const environmentPolicy = { policy: 'explicit_allowlist' as const, variables: [] }
  const resourcePolicy = { maxRuntimeMs: 60_000, gracefulStopMs: 1_000, maxOutputBytes: 65_536, maxProcessCount: 1 }
  const workspaceGrant = { grantId: 'workspace-grant-a' as WorkspaceExecutionGrantId,
    workspaceId: parseWorkspaceId(`workspace_${'1'.repeat(32)}`),
    registrationRevision: 1, bindingGeneration: 1, mountGeneration: 1, permission: 'execute_process' as const }
  const expected: NativeAcquisitionPreparedExpectation = {
    version: 1, role: 'native-worker', publicTeamId: JOURNAL_TEAM_ID, legacyKey: 'fixture', runId,
    attemptSetId: 'attempt-set', attemptToken: 'attempt-token-000000', memberOrdinal: 2, laneId: 'lane-a',
    displayName: 'worker', agentId: JOURNAL_MEMBER_ID, provider: 'codex', model: 'model', ownerBootId: 'boot',
    ownerControllerInstanceId: fence.controllerInstanceId, ownerPlanGeneration, productPlanGeneration: 7,
    productPlanRef: computeNativeProductPlanRefDigest(planRef), materialDigest: 'material', recipeDigest: 'recipe', profileDigest: 'profile',
    binding: {
      ownerPlanGeneration, ownerUnitBindingId: 'unit-binding', orderedMembers: [{ ordinal: 2, memberId: JOURNAL_MEMBER_ID }],
      executionUnit: { executionUnitId, laneId, memberIds: [parseMemberId(JOURNAL_MEMBER_ID)],
        backendBinding: { backend: 'provisioning_cli', bindingId: parseRuntimeBackendBindingId('binding-a'), bindingRevision: 1 },
        binaryPolicy, environmentPolicy, credentialExposureSet: { secretRefs: [] }, credentialIsolation: 'dedicated_execution_unit', resourcePolicy },
      launchSpec: { planRef, executionUnitId, backend: 'provisioning_cli',
        argvAuthority: { executableRef: 'executable-authority-a' as ResolvedExecutableAuthorityRef, binaryPolicy, argv: ['worker'],
          argvHash: digest('6') },
        workdirAuthority: { workdirRef: 'workdir-authority-a' as ResolvedWorkdirAuthorityRef, grant: workspaceGrant },
        environmentAuthority: { environmentRef: 'environment-authority-a' as ResolvedEnvironmentAuthorityRef, policy: environmentPolicy },
        resourcePolicy },
    },
  }
  return { runId, key, fence, expected }
}

function capacityArgv(argvBytes: number): string[] {
  const argv: string[] = []
  let remaining = Math.max(1, argvBytes)
  let character = 0
  while (remaining > 0) {
    const bytes = Math.min(remaining, 16 * 1024)
    argv.push(String.fromCharCode(120 + character % 3).repeat(bytes))
    remaining -= bytes
    character += 1
  }
  return argv
}

function capacityFixture(ordinal: number, argvBytes = 48 * 1024) {
  const original = fixture()
  const canonicalPayload = ordinal.toString(16).padStart(32, '0')
  const memberId = `member_${canonicalPayload}`
  const laneId = `lane-${canonicalPayload}`
  const executionUnitId = parseExecutionUnitId(`unit-${canonicalPayload}`)
  const argv = capacityArgv(argvBytes)
  const expected: NativeAcquisitionPreparedExpectation = {
    ...original.expected,
    memberOrdinal: ordinal,
    agentId: memberId,
    laneId,
    binding: {
      ...original.expected.binding,
      orderedMembers: [{ ordinal, memberId }],
      executionUnit: {
        ...original.expected.binding.executionUnit,
        executionUnitId,
        laneId: parseLaneId(laneId),
        memberIds: [parseMemberId(memberId)],
      },
      launchSpec: {
        ...original.expected.binding.launchSpec,
        executionUnitId,
        argvAuthority: {
          ...original.expected.binding.launchSpec.argvAuthority,
          argv,
          argvHash: OwnerAnchorLibrary.computeCanonicalArgvDigest(argv),
        },
      },
    },
  }
  const key = createAttemptKey({
    ownerPlanGeneration: expected.ownerPlanGeneration,
    runId: expected.runId,
    originalLaneId: expected.laneId,
    globalOrdinal: ordinal,
    attemptOrdinal: ordinal,
  })
  const fence = { ...original.fence, key, attemptOrdinal: ordinal }
  return { ...original, key, fence, expected }
}

function capacityProductTransitions(
  expected: NativeAcquisitionPreparedExpectation,
  processRefValue: string,
) {
  const scope = { planRef: expected.binding.launchSpec.planRef,
    executionUnitId: expected.binding.executionUnit.executionUnitId }
  const grant = expected.binding.launchSpec.workdirAuthority.grant
  const processRef = parseOwnedProcessRef(processRefValue)
  const spawnNonce = parseSpawnNonce('owner-spawn:capacity-fixture')
  const intent = OwnerAnchorLibrary.initializeProcessOwnershipState({
    intentVersion: 1,
    scope,
    processRef,
    spawnNonce,
    workspaceBinding: { workspaceId: grant.workspaceId,
      registrationRevision: grant.registrationRevision,
      bindingGeneration: grant.bindingGeneration,
      mountGeneration: grant.mountGeneration },
    binaryBinding: expected.binding.launchSpec.argvAuthority.binaryPolicy,
    argvDigest: expected.binding.launchSpec.argvAuthority.argvHash,
    argvCount: expected.binding.launchSpec.argvAuthority.argv.length,
    environmentPolicyDigest: computeCanonicalPolicyDigest(
      expected.binding.executionUnit.environmentPolicy,
    ),
    relayScopeDigest: computeCanonicalPolicyDigest({
      laneId: expected.binding.executionUnit.laneId,
      memberIds: expected.binding.executionUnit.memberIds,
    }),
  })
  const nonceDigest = spawnNonceDigest(spawnNonce)
  const ownerAttestation = { attestationVersion: 1 as const,
    ...ACTUAL_A_OWNER_BINDING, processRef, scope,
    workspaceBinding: intent.intent.workspaceBinding,
    spawnNonceDigest: nonceDigest,
    channelRef: parseAnchorChannelRef('channel-reference-capacity'),
    owningProcessIdentityRef: parseOwningProcessIdentityRef('owning-identity-capacity'),
    anchorIdentityRef: parseAnchorIdentityRef('anchor-identity-capacity') }
  const committed = OwnerAnchorLibrary.commitProcessOwnership(intent, {
    processRef,
    scope,
    workspaceBinding: intent.intent.workspaceBinding,
    spawnNonceDigest: nonceDigest,
    controllerInstanceId: parseProcessControllerInstanceId(
      expected.ownerControllerInstanceId,
    ),
    ownerAttestation,
    mainProcessIdentityRef: parseMainProcessIdentityRef('main-identity-capacity'),
    statusSequence: 1,
  })
  if (committed.status !== 'accepted') {
    throw new Error(`Capacity Product ownership commit was ${committed.reason}`)
  }
  const stopping = OwnerAnchorLibrary.beginOwnedProcessStop(committed.next, {
    processRef,
    ...scope,
    ...ACTUAL_A_OWNER_BINDING,
  })
  if (stopping.status !== 'accepted') {
    throw new Error(`Capacity Product stopping transition was ${stopping.reason}`)
  }
  const drained = OwnerAnchorLibrary.completeOwnedProcessStop(stopping.next, {
    processRef,
    scope,
    spawnNonceDigest: nonceDigest,
    ownerAttestation,
    ownedProcessEof: { processRef, ownerAttestation, observed: true },
    statusSequence: 2,
    outcome: 'drained',
    residuals: [],
  })
  if (drained.status !== 'accepted') {
    throw new Error(`Capacity Product drain transition was ${drained.reason}`)
  }
  return { scope, intent, owned: committed.next, stopping: stopping.next,
    drained: drained.next }
}

const byteDigest = (bytes: string): string =>
  createHash('sha256').update(bytes).digest('hex')

function capacityNoEffectPair(ordinal: number, argvBytes = 48 * 1024) {
  const { key, fence, expected } = capacityFixture(ordinal, argvBytes)
  const terminalEvidence = {
    kind: 'pre-start-failure' as const,
    expected,
    startWasNeverCalled: true as const,
    claimSettled: true as const,
    observedAt: `capacity-terminal-${ordinal}`,
    reason: 'bounded pre-start terminal custody',
  }
  return {
    attempt: { key, kind: 'native' as const, phase: 'noeffect' as const,
      fence, expected, terminalEvidence },
    tombstone: { key, fence, expected,
      scope: { planRef: expected.binding.launchSpec.planRef,
        executionUnitId: expected.binding.executionUnit.executionUnitId },
      terminalPhase: 'noeffect' as const, terminalEvidence },
  }
}

function nativeIdentity(expected: NativeAcquisitionPreparedExpectation, processRef: string): OwnedNativeProcessIdentity {
  return { ...expected, kind: 'hosted-anchor', processRef: supervisedProcessRef(processRef) }
}

function supervisedProcessRef(value: string | OwnedProcessRef): SupervisedProcessRef {
  const parsed = parseOwnedProcessRef(value)
  return parsed as string as SupervisedProcessRef
}

function workerReadiness(expected: NativeAcquisitionPreparedExpectation, runtimeSessionId: string): NativeProcessReadinessProof {
  const base = { version: 1 as const, timestamp: '2026-01-01T00:00:00.000Z', pid: 101,
    teamName: expected.legacyKey, agentName: expected.displayName, agentId: expected.agentId,
    runId: runtimeSessionId, bootstrapRunId: expected.runId }
  return { kind: 'hosted-worker-runtime', runtimeReady: { ...base, type: 'runtime_ready' },
    inboxPollerReady: { ...base, type: 'inbox_poller_ready' },
    bootstrapAccepted: { ...base, type: 'bootstrap_submitted', bootstrapProofToken: 'proof', bootstrapMirrorId: 'message' },
    mailboxMessageId: 'message', runtimeSessionId, diagnosticPid: 101 }
}

async function initializedTransactions(root: string): Promise<TeamLifecycleJournalTransactions> {
  const transactions = new TeamLifecycleJournalTransactions(join(root, 'execution.json'))
  const base = createInitialDurableState('a'.repeat(64), 'auto')
  await transactions.initialize({ ...base, phase: 'launching', runId: JOURNAL_RUN_ID, ownerIncarnation: 'owner_fixture', operationEpoch: 1 })
  return transactions
}

const ACTUAL_A_CAPABILITY_HASH =
  'sha256:8ef0fab620172bdb761af87fc471cb3a1abb46710f148037762cee5d403720b5' as const
const ACTUAL_A_OWNER_BINDING: ProcessOwnerBinding = { authorityId: 'authority', bootId: 'boot' }
const actualAProduct = {
  expected: undefined as NativeAcquisitionPreparedExpectation | undefined,
  materialDigest: undefined as string | undefined,
  stdio: undefined as NodeAnchorProviderStdio | undefined,
  ownership: undefined as ProcessOwnershipState | undefined,
  stops: 0,
}

let actualACanonicalFixtureInstalled = false
function installActualACanonicalFixture(): void {
  if (actualACanonicalFixtureInstalled) return
  actualACanonicalFixtureInstalled = true
  mock.module('src/utils/swarm/teamHelpers.js', () => ({
    ...canonicalTeamHelpers,
    updateTeamFileAtCanonicalRoot: async (canonicalTeamRoot: string, legacyKey: string,
      mutator: (teamFile: canonicalTeamHelpers.TeamFile) => unknown | Promise<unknown>) => {
      const configPath = join(canonicalTeamRoot, 'config.json')
      let current: canonicalTeamHelpers.TeamFile
      try {
        current = JSON.parse(await readFile(configPath, 'utf8')) as canonicalTeamHelpers.TeamFile
      } catch {
        return { status: 'missing', teamFile: null }
      }
      if (current.name !== legacyKey) throw new Error('Actual A fixture canonical team identity mismatch')
      const callback = await mutator(current) as {
        changed: boolean
        teamFile: canonicalTeamHelpers.TeamFile | { changed: boolean; teamFile: canonicalTeamHelpers.TeamFile }
      }
      const next = callback.changed && 'changed' in callback.teamFile ? callback.teamFile : callback
      if (!next.changed) return { status: 'unchanged', teamFile: current }
      await writeFile(configPath, JSON.stringify(next.teamFile), { mode: 0o600 })
      return { status: 'updated', teamFile: next.teamFile }
    },
  }))
}

class ActualAJournalSpawner extends OwnerAnchorLibrary.NodeAnchorSpawner {
  override providerStdioFor(processRef: string): NodeAnchorProviderStdio | undefined {
    return actualAProduct.stdio?.processRef === processRef ? actualAProduct.stdio : undefined
  }

  override closeProviderStdio(): void {}
}

class ActualAJournalSupervisor extends OwnerAnchorLibrary.AnchorProcessSupervisorAdapter {
  readonly #store: ProcessOwnershipStorePort

  constructor(options: ConstructorParameters<typeof OwnerAnchorLibrary.AnchorProcessSupervisorAdapter>[0]) {
    super(options)
    this.#store = options.store
  }

  override async start(
    request: OwnerAnchorLibrary.StartProcessExecutionUnitRequest,
  ): Promise<OwnerAnchorLibrary.StartProcessExecutionUnitResult> {
    const expected = actualAProduct.expected
    if (!expected) throw new Error('Actual A journal fixture expectation is unavailable')
    if (
      request.cancellation.isCancellationRequested() ||
      !isDeepStrictEqual(request.executionUnit, expected.binding.executionUnit) ||
      !isDeepStrictEqual(request.launchSpec, expected.binding.launchSpec) ||
      expected.ownerControllerInstanceId !== 'controller-fixture-0001' ||
      expected.ownerBootId !== ACTUAL_A_OWNER_BINDING.bootId ||
      expected.materialDigest !== actualAProduct.materialDigest
    ) {
      throw new Error('Actual A journal fixture Product start request is not the exact admitted material')
    }
    const context = actualAStoreContext()
    const stdio = actualAProduct.stdio
    if (!stdio) throw new Error('Actual A journal fixture Product process reference is unavailable')
    const processRef = parseOwnedProcessRef(stdio.processRef)
    const spawnNonce = parseSpawnNonce('owner-spawn:fixture')
    const scope = { planRef: request.launchSpec.planRef, executionUnitId: request.launchSpec.executionUnitId }
    const grant = request.launchSpec.workdirAuthority.grant
    const intent = OwnerAnchorLibrary.initializeProcessOwnershipState({
      intentVersion: 1,
      scope,
      processRef,
      spawnNonce,
      workspaceBinding: { workspaceId: grant.workspaceId, registrationRevision: grant.registrationRevision,
        bindingGeneration: grant.bindingGeneration, mountGeneration: grant.mountGeneration },
      binaryBinding: request.launchSpec.argvAuthority.binaryPolicy,
      argvDigest: request.launchSpec.argvAuthority.argvHash,
      argvCount: request.launchSpec.argvAuthority.argv.length,
      environmentPolicyDigest: computeCanonicalPolicyDigest(request.executionUnit.environmentPolicy),
      relayScopeDigest: computeCanonicalPolicyDigest({ laneId: request.executionUnit.laneId,
        memberIds: request.executionUnit.memberIds }),
    })
    const nonceDigest = spawnNonceDigest(spawnNonce)
    const ownerAttestation = {
      attestationVersion: 1 as const,
      ...ACTUAL_A_OWNER_BINDING,
      processRef,
      scope,
      workspaceBinding: intent.intent.workspaceBinding,
      spawnNonceDigest: nonceDigest,
      channelRef: parseAnchorChannelRef('channel-reference-fixture'),
      owningProcessIdentityRef: parseOwningProcessIdentityRef('owning-identity-fixture'),
      anchorIdentityRef: parseAnchorIdentityRef('anchor-identity-fixture'),
    }
    const committed = OwnerAnchorLibrary.commitProcessOwnership(intent, {
      processRef,
      scope,
      workspaceBinding: intent.intent.workspaceBinding,
      spawnNonceDigest: nonceDigest,
      controllerInstanceId: parseProcessControllerInstanceId(expected.ownerControllerInstanceId),
      ownerAttestation,
      mainProcessIdentityRef: parseMainProcessIdentityRef('main-identity-fixture'),
      statusSequence: 1,
    })
    if (committed.status !== 'accepted') {
      throw new Error(`Actual A journal fixture Product ownership commit was ${committed.reason}`)
    }
    await requireApplied(this.#store.compareAndSwap({
      scope,
      expectedRevision: null,
      next: intent,
      context,
    }))
    await requireApplied(this.#store.compareAndSwap({
      scope,
      expectedRevision: intent.revision,
      next: committed.next,
      context,
    }))
    actualAProduct.ownership = committed.next
    return { status: 'started', processRef: supervisedProcessRef(processRef) }
  }

  override async stop(
    request: OwnerAnchorLibrary.StopProcessExecutionUnitRequest,
  ): Promise<OwnerAnchorLibrary.StopProcessExecutionUnitResult> {
    const expected = actualAProduct.expected
    if (!expected) throw new Error('Actual A journal fixture expectation is unavailable')
    const owned = actualAProduct.ownership
    if (!owned || owned.phase !== 'owned') throw new Error('Actual A journal fixture ownership is not owned')
    if (
      request.cancellation.isCancellationRequested() ||
      !ownedProcessRefsEqual(request.processRef, owned.intent.processRef) ||
      request.executionUnitId !== owned.intent.scope.executionUnitId ||
      !isDeepStrictEqual(request.planRef, owned.intent.scope.planRef) ||
      !isDeepStrictEqual(expected.binding.launchSpec.planRef, request.planRef)
    ) {
      throw new Error('Actual A journal fixture Product stop request is not the exact acquired scope')
    }
    const context = actualAStoreContext()
    actualAProduct.stops += 1
    const stopping = OwnerAnchorLibrary.beginOwnedProcessStop(owned, {
      processRef: owned.intent.processRef,
      ...owned.intent.scope,
      ...ACTUAL_A_OWNER_BINDING,
    })
    if (stopping.status !== 'accepted') {
      throw new Error(`Actual A journal fixture Product stop transition was ${stopping.reason}`)
    }
    await requireApplied(this.#store.compareAndSwap({
      scope: owned.intent.scope,
      expectedRevision: owned.revision,
      next: stopping.next,
      context,
    }))
    const drained = OwnerAnchorLibrary.completeOwnedProcessStop(stopping.next, {
      processRef: owned.intent.processRef,
      scope: owned.intent.scope,
      spawnNonceDigest: owned.ownership.spawnNonceDigest,
      ownerAttestation: owned.ownership.ownerAttestation,
      ownedProcessEof: { processRef: owned.intent.processRef,
        ownerAttestation: owned.ownership.ownerAttestation, observed: true },
      statusSequence: owned.ownership.lastStatusSequence + 1,
      outcome: 'drained',
      residuals: [],
    })
    if (drained.status !== 'accepted') {
      throw new Error(`Actual A journal fixture Product drain transition was ${drained.reason}`)
    }
    await requireApplied(this.#store.compareAndSwap({
      scope: owned.intent.scope,
      expectedRevision: stopping.next.revision,
      next: drained.next,
      context,
    }))
    actualAProduct.ownership = drained.next
    const stdio = actualAProduct.stdio
    if (stdio) {
      ;(stdio.stdout as PassThrough).end()
      ;(stdio.stderr as PassThrough).end()
    }
    return { status: 'drained' }
  }

  override async observe(
    _request: ObserveProcessExecutionUnitRequest,
  ): Promise<{ readonly status: 'ready' }> {
    return { status: 'ready' }
  }
}

function actualAStoreContext(): OwnerAnchorLibrary.ProcessOwnershipStoreContext {
  const clock = { now: () => Date.now() }
  return {
    deadline: OwnerAnchorLibrary.createProcessSupervisionDeadline(clock, 5_000),
    clock,
    cancellation: {
      cancellationId: 'cancel:actual-a-journal-fixture' as RuntimeCancellationId,
      isCancellationRequested: () => false,
    },
  }
}

async function requireApplied(
  operation: Promise<OwnerAnchorLibrary.ProcessOwnershipCompareAndSwapResult>,
): Promise<void> {
  const result = await operation
  if (result.status !== 'applied') {
    throw new Error(`Actual A journal fixture Product CAS was ${result.status}`)
  }
}

const actualAOwnerLibrary = {
  ...OwnerAnchorLibrary,
  NodeAnchorSpawner: ActualAJournalSpawner,
  AnchorProcessSupervisorAdapter: ActualAJournalSupervisor,
} satisfies HostedOwnerAnchorLibrary

async function actualAWorkerFixture() {
  installActualACanonicalFixture()
  const data = await mkdtemp(join(tmpdir(), 'actual-a-journal-'))
  roots.push(data)
  await chmod(data, 0o700)
  const legacyKey = 'fixture'
  const team = join(data, 'teams', legacyKey)
  const tasks = join(data, 'tasks', legacyKey)
  const cwd = join(data, 'cwd')
  await Promise.all([team, tasks, cwd].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const settingsPath = join(data, 'settings.json')
  const mcpPath = join(data, 'mcp.json')
  const executablePath = join(data, 'fixture-cli')
  const executableBytes = '#!/bin/sh\nexit 127\n'
  await writeFile(settingsPath, '{}', { mode: 0o600 })
  await writeFile(mcpPath, '{}', { mode: 0o600 })
  await writeFile(executablePath, executableBytes, { mode: 0o700 })
  const tagged = (bytes: string): `sha256:${string}` =>
    `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const plain = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
  const ownerPlanGeneration = 'owner-generation-journal'
  const planRef = {
    teamId: parseTeamId(JOURNAL_TEAM_ID),
    runId: parseRunId(JOURNAL_RUN_ID),
    generation: 7,
    planHash: `sha256:${'5'.repeat(64)}` as CompositeRuntimePlanHash,
  }
  const material = await resolveNativeProcessLaunchMaterial({
    publicTeamId: JOURNAL_TEAM_ID,
    legacyKey,
    canonicalDataRoot: data,
    canonicalTeamRoot: team,
    canonicalTasksRoot: tasks,
    canonicalCwd: cwd,
    runId: JOURNAL_RUN_ID,
    attemptSetId: 'attempt-set',
    ownerBootId: 'boot',
    ownerControllerInstanceId: 'controller-fixture-0001',
    ownerPlanGeneration,
    productPlanGeneration: 7,
    productPlanRef: computeNativeProductPlanRefDigest(planRef),
    workdirRef: 'workdir-authority-a',
    primaryOrdinal: 0,
    members: [
      { ordinal: 0, laneId: 'lane-lead', displayName: 'lead', agentId: `member_${'1'.repeat(32)}`,
        provider: 'anthropic', model: 'lead-model', prompt: 'lead' },
      { ordinal: 1, laneId: 'lane-a', displayName: 'worker', agentId: JOURNAL_MEMBER_ID,
        provider: 'codex', model: 'model', prompt: 'worker', agentType: 'implementer' },
    ],
    cli: { executable: { canonicalPath: executablePath, sha256: tagged(executableBytes),
      executableRef: 'executable-authority-a', binaryId: 'binary-a', binaryRevision: 1,
      binaryHash: tagged(executableBytes) }, argv: [], argvKind: 'executable-only' },
    settings: { canonicalPath: settingsPath, sha256: tagged('{}') },
    mcpConfig: { canonicalPath: mcpPath, sha256: tagged('{}') },
    permissionMode: 'bypassPermissions',
    disallowedTools: ['TeamCreate'],
    strictMcpConfig: true,
    profiles: [
      { provider: 'anthropic', selectedBackendId: 'selected-lead', resolvedBackendId: 'resolved-lead',
        resolvedLaunchModel: 'lead-model', endpointIdentity: 'endpoint:lead', configurationIdentity: 'configuration:lead',
        authHandleRevision: 'auth:lead', accessAdmissionId: 'access:lead', environmentRef: 'environment:lead',
        frozenEnv: { PATH: '/admitted/bin' } },
      { provider: 'codex', selectedBackendId: 'selected-worker', resolvedBackendId: 'resolved-worker',
        resolvedLaunchModel: 'model', endpointIdentity: 'endpoint:worker', configurationIdentity: 'configuration:worker',
        authHandleRevision: 'auth:worker', accessAdmissionId: 'access:worker', environmentRef: 'environment:worker',
        frozenEnv: { PATH: '/worker/bin' } },
    ],
    anchorCapability: { admissionId: 'admission:owner-anchor', version: 1, hash: ACTUAL_A_CAPABILITY_HASH },
  })
  const leadToken = 'attempt:lead:journal-0001'
  const leadDir = join(data, 'attempts', leadToken)
  await mkdir(leadDir, { recursive: true, mode: 0o700 })
  const envelopePath = join(leadDir, 'launch.json')
  const readyAckPath = join(leadDir, 'ready.json')
  const bootstrapSpecPath = join(leadDir, 'bootstrap.json')
  const userPromptFilePath = join(leadDir, 'prompt.txt')
  await writeFile(bootstrapSpecPath, '{"members":[]}', { mode: 0o600 })
  await writeFile(userPromptFilePath, 'lead', { mode: 0o600 })
  const authority = { version: 1 as const, registrationId: 'registration-journal', storageGeneration: 'storage-journal',
    admittedWriterImage: 'writer-journal', registryRoot: data, anchorName: 'anchor', bindingRecordName: 'binding' }
  const primary = material.members[0]!
  const unsigned = { version: 1 as const, role: 'native-lead' as const, publicTeamId: material.publicTeamId,
    legacyKey, canonicalDataRoot: data, canonicalTeamRoot: team, canonicalTasksRoot: tasks, canonicalCwd: cwd,
    dataRootIdentity: 'data-journal', teamRootIdentity: 'team-journal', tasksRootIdentity: 'tasks-journal', runId: material.runId,
    primary: { displayName: primary.displayName, agentId: primary.agentId, provider: 'anthropic' as const, model: primary.model },
    primaryAlias: 'team-lead' as const, launchIdentityToken: leadToken, materialDigest: material.materialDigest,
    profileDigest: primary.profileDigest, settingsDigest: plain('{}'), mcpDigest: plain('{}'), settingsPath,
    mcpConfigPath: mcpPath, bootstrapSpecPath, bootstrapSpecDigest: plain('{"members":[]}'), userPromptFilePath,
    userPromptDigest: plain('lead'), permissionMode: 'bypassPermissions' as const, readyAckPath, canonicalAuthority: authority }
  const envelope: HostedNativeLaunchEnvelope = { ...unsigned, envelopeDigest: computeHostedNativeEnvelopeDigest(unsigned) }
  await writeFile(envelopePath, JSON.stringify(envelope), { mode: 0o600 })
  const binaryPolicy = { policy: 'registered_exact_binary' as const, binaryId: parseRuntimeBinaryId('binary-a'),
    binaryRevision: 1, binaryHash: tagged(executableBytes) }
  const resourcePolicy = { maxRuntimeMs: 60_000, gracefulStopMs: 1_000, maxOutputBytes: 65_536, maxProcessCount: 1 }
  const workspaceGrant = { grantId: 'workspace-grant-a' as WorkspaceExecutionGrantId,
    workspaceId: parseWorkspaceId(`workspace_${'1'.repeat(32)}`), registrationRevision: 1,
    bindingGeneration: 1, mountGeneration: 1, permission: 'execute_process' as const }
  const leadEnv = buildResolvedNativeProcessEnv({ provider: 'anthropic', canonicalDataRoot: data,
    frozenEnv: { PATH: '/admitted/bin' } })
  const workerEnv = buildResolvedNativeProcessEnv({ provider: 'codex', canonicalDataRoot: data,
    frozenEnv: { PATH: '/worker/bin' }, runtimeEnv: {
      CLAUDE_CODE_TEAMMATE_RUNTIME: 'headless',
      CLAUDE_CODE_TEAMMATE_RUNTIME_EVENTS_PATH: join(team, 'attempt:worker:journal-0001', 'runtime.jsonl'),
      CLAUDE_CODE_BOOTSTRAP_PROOF_TOKEN: 'proof:worker:journal-0001',
      CLAUDE_CODE_BOOTSTRAP_RUN_ID: material.runId,
    } })
  const environmentPolicy = (values: Readonly<Record<string, string>>): HostedChildEnvironmentPolicy => ({
    policy: 'explicit_allowlist',
    variables: Object.keys(values).sort().map(name => ({
      name,
      provenance: name === 'PATH' ? 'provider_static' : 'runtime_metadata',
    })),
  })
  const leadEnvironmentPolicy = environmentPolicy(leadEnv)
  const workerEnvironmentPolicy = environmentPolicy(workerEnv)
  const leadFlags = buildResolvedNativeProcessFlags({ model: primary.model, settingsPath, mcpConfigPath: mcpPath,
    disallowedTools: ['TeamCreate'], strictMcpConfig: true })
  const leadArgv = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--team-bootstrap-spec', bootstrapSpecPath, '--team-bootstrap-user-prompt-file', userPromptFilePath,
    '--hosted-native-launch', envelopePath, '--hosted-native-launch-identity', leadToken,
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', ...leadFlags]
  const workerToken = 'attempt:worker:journal-0001'
  const runtimeEventsPath = join(team, workerToken, 'runtime.jsonl')
  await mkdir(join(team, workerToken), { recursive: true, mode: 0o700 })
  const workerFlags = buildResolvedNativeProcessFlags({ model: 'model', settingsPath, mcpConfigPath: mcpPath,
    disallowedTools: ['TeamCreate'], strictMcpConfig: true })
  const workerArgv = ['--teammate-runtime', 'headless', '--agent-id', JOURNAL_MEMBER_ID, '--agent-name', 'worker',
    '--team-name', legacyKey, '--parent-session-id', material.runId, '--process-owner-token', workerToken,
    '--agent-type', 'implementer', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', ...workerFlags]
  const executionUnit = (ordinal: 0 | 1, environmentPolicy: typeof leadEnvironmentPolicy | typeof workerEnvironmentPolicy) => ({
    executionUnitId: parseExecutionUnitId(ordinal === 0 ? 'unit-lead' : 'unit-a'),
    laneId: parseLaneId(ordinal === 0 ? 'lane-lead' : 'lane-a'),
    memberIds: [parseMemberId(ordinal === 0 ? primary.agentId : JOURNAL_MEMBER_ID)],
    backendBinding: { backend: 'provisioning_cli' as const,
      bindingId: parseRuntimeBackendBindingId(ordinal === 0 ? 'binding-lead' : 'binding-a'), bindingRevision: 1 },
    binaryPolicy, environmentPolicy, credentialExposureSet: { secretRefs: [] },
    credentialIsolation: 'dedicated_execution_unit' as const, resourcePolicy,
  })
  const binding = (ordinal: 0 | 1, argv: string[], environmentPolicy: typeof leadEnvironmentPolicy | typeof workerEnvironmentPolicy) => {
    const unit = executionUnit(ordinal, environmentPolicy)
    return { ownerPlanGeneration, ownerUnitBindingId: ordinal === 0 ? 'unit-binding-lead' : 'unit-binding-worker',
      orderedMembers: [{ ordinal, memberId: ordinal === 0 ? primary.agentId : JOURNAL_MEMBER_ID }], executionUnit: unit,
      launchSpec: { planRef, executionUnitId: unit.executionUnitId, backend: 'provisioning_cli' as const,
        argvAuthority: { executableRef: 'executable-authority-a' as ResolvedExecutableAuthorityRef, binaryPolicy,
          argv, argvHash: OwnerAnchorLibrary.computeCanonicalArgvDigest(argv) },
        workdirAuthority: { workdirRef: 'workdir-authority-a' as ResolvedWorkdirAuthorityRef, grant: workspaceGrant },
        environmentAuthority: { environmentRef: (ordinal === 0 ? 'environment:lead' : 'environment:worker') as ResolvedEnvironmentAuthorityRef,
          policy: environmentPolicy }, resourcePolicy } }
  }
  const admittedLibrary: LoadedHostedOwnerAnchorLibrary = { library: actualAOwnerLibrary,
    anchorExecutablePath: executablePath, admission: { admissionId: material.anchorCapability.admissionId, packageRoot: data,
      expectedProvenanceSha256: tagged('provenance'), expectedNativeSha256: tagged(executableBytes) } }
  const leadAttempt: NativePreparedAttemptInput = { memberOrdinal: 0, role: 'native-lead' as const, attemptToken: leadToken,
    binding: binding(0, leadArgv, leadEnvironmentPolicy), lead: { envelopePath, readyAckPath, envelope,
      protectedRegistration: { recordVersion: 1 as const, protocolVersion: 1 as const,
        registrationId: authority.registrationId, publicTeamId: material.publicTeamId, legacyKey,
        storageGeneration: authority.storageGeneration, admittedWriterImage: authority.admittedWriterImage,
        canonicalTeamRoot: team, root: { dev: 1, ino: 1, mountId: 1 },
        rootParent: { dev: 2, ino: 2, mountId: 2 }, anchor: { dev: 3, ino: 3, mountId: 3 },
        anchorParent: { dev: 4, ino: 4, mountId: 4 }, registration: authority,
        launch: (({ canonicalAuthority: _authority, ...launch }) => launch)(envelope) } } }
  const workerAttempt: NativePreparedAttemptInput = { memberOrdinal: 1, role: 'native-worker' as const, attemptToken: workerToken,
    binding: binding(1, workerArgv, workerEnvironmentPolicy), runtimeEventsPath,
    bootstrapProofToken: 'proof:worker:journal-0001', bootstrapRunId: material.runId }
  const catalog: NodeAnchorLaunchAuthorityCatalog = { executables: [{ executableRef: 'executable-authority-a' as ResolvedExecutableAuthorityRef,
    executablePath, binaryPolicy }], workdirs: [{ workdirRef: 'workdir-authority-a' as ResolvedWorkdirAuthorityRef,
    workdirPath: cwd, grant: workspaceGrant,
    registeredRootEvidence: { device: 1n, inode: 1n, mountId: 1n } }], environments: [
      { environmentRef: 'environment:lead' as ResolvedEnvironmentAuthorityRef, policy: leadEnvironmentPolicy, values: leadEnv },
      { environmentRef: 'environment:worker' as ResolvedEnvironmentAuthorityRef, policy: workerEnvironmentPolicy, values: workerEnv },
    ] }
  const prepared = await prepareNativeProcessAcquisition({ material, admittedLibrary, launchCatalog: catalog,
    nativeAttempts: [leadAttempt, workerAttempt], openCodeMembers: [] })
  const expected = prepared.recipes.find(recipe => recipe.expected.role === 'native-worker')!.expected
  actualAProduct.expected = expected
  actualAProduct.materialDigest = material.materialDigest
  actualAProduct.stops = 0
  actualAProduct.ownership = undefined
  const processRef = parseOwnedProcessRef('owner-process:fixture')
  actualAProduct.stdio = { processRef, capabilityVersion: 1, capabilityHash: ACTUAL_A_CAPABILITY_HASH,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), maxOutputBytes: 65_536, close() {} }
  const statePath = join(data, 'execution.json')
  const transactions = new TeamLifecycleJournalTransactions(statePath)
  const base = createInitialDurableState('a'.repeat(64), 'auto')
  await transactions.initialize({ ...base, phase: 'launching', runId: material.runId,
    ownerIncarnation: 'owner_fixture', operationEpoch: 1 })
  const fence: AttemptFence = { key: createAttemptKey({ ownerPlanGeneration, runId: material.runId,
    originalLaneId: expected.laneId, globalOrdinal: expected.memberOrdinal, attemptOrdinal: 0 }),
    runId: material.runId, ownerIncarnation: 'owner_fixture', controllerInstanceId: expected.ownerControllerInstanceId,
    ownerPlanGeneration, operationEpoch: 1, attemptOrdinal: 0 }
  const journal = createTeamLifecycleEffectJournal({ transactions })
  const store = createOwnerProcessOwnershipStoreAdapter({ transactions, ownerBinding: ACTUAL_A_OWNER_BINDING,
    controllerInstanceId: parseProcessControllerInstanceId(expected.ownerControllerInstanceId) })
  const acquisition = createNativeProcessAcquisition({ admittedLibrary, store, ownerBinding: ACTUAL_A_OWNER_BINDING,
    controllerInstanceId: parseProcessControllerInstanceId(expected.ownerControllerInstanceId), launchCatalog: catalog,
    launchCatalogDigest: computeNativeLaunchCatalogDigest(catalog), neutralWorkingDirectory: cwd,
    launchTimeoutMs: 500, stopTimeoutMs: 100, recoveryTimeoutMs: 100, readinessPollMs: 2, prepared })
  const configPath = join(team, 'config.json')
  await writeFile(configPath, JSON.stringify({ name: legacyKey, createdAt: 1, leadAgentId: primary.agentId,
    leadSessionId: 'lead-session', members: [{ agentId: primary.agentId, name: primary.displayName, joinedAt: 1,
      tmuxPaneId: 'hosted-anchor:lead', cwd, subscriptions: [], sessionId: 'lead-session' }],
    hostedNative: { version: 1, publicTeamId: material.publicTeamId, legacyKey, primaryDisplayName: primary.displayName,
      primaryAgentId: primary.agentId, primaryAlias: 'team-lead', launchIdentityToken: envelope.launchIdentityToken,
      envelopeDigest: envelope.envelopeDigest, materialDigest: material.materialDigest, profileDigest: primary.profileDigest,
      permissionMode: 'bypassPermissions', canonicalDataRoot: data, canonicalTeamRoot: team, canonicalTasksRoot: tasks,
      runId: material.runId, role: 'native-lead', readyAckPath, mailboxCustody: 'hosted-lead-pump' } }), { mode: 0o600 })
  const authorization: NativeAttemptEffectAuthorization = { authorizationId: 'authorization-actual-a', ownerBootId: expected.ownerBootId,
    ownerControllerInstanceId: expected.ownerControllerInstanceId, attemptToken: expected.attemptToken,
    deadlineMs: Date.now() + 5_000, assertCurrent() {} }
  return { acquisition, authorization, configPath, fence, journal, expected, processRef, statePath }
}

describe('TeamLifecycleEffectJournal', () => {
  test('round trips modeled accepted A recorder shapes and reopens the same state file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-journal-'))
    roots.push(root)
    const transactions = await initializedTransactions(root)
    const journal = createTeamLifecycleEffectJournal({ transactions })
    const { runId, fence, expected, key } = fixture()
    const recorder = journal.recorder(fence)
    await recorder.armAttempt(expected)
    await transactions.update(state => ({ state: { ...state, attempts: { ...state.attempts,
      [key]: { ...state.attempts[key]!, processOwnership: ownedOwnership(expected) },
    } }, value: undefined }))
    const identity = nativeIdentity(expected, 'owner-process:fixture')
    await recorder.recordAcquired(identity)
    const readinessProof = workerReadiness(expected, 'session-fixture')
    const readyIdentity: OwnedNativeProcessIdentity = {
      ...identity,
      runtimeSessionId: 'session-fixture',
      readiness: readinessProof,
      diagnostics: { pid: 101 },
    }
    await recorder.recordReady({ identity: readyIdentity, readinessProof })

    const reopened = createTeamLifecycleEffectJournal({ transactions: new TeamLifecycleJournalTransactions(join(root, 'execution.json')) })
    const evidence = await reopened.snapshotRun(runId)
    expect(evidence.attempts).toHaveLength(1)
    expect(evidence.attempts[0]).toMatchObject({ key, phase: 'ready', identity: { processRef: 'owner-process:fixture' } })
    expect(Object.isFrozen(evidence)).toBeTrue()
    expect(() => ((evidence.attempts[0] as { phase: string }).phase = 'armed')).toThrow()
  })

  test('persists terminal tombstones across plan rotation and rejects scope reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-journal-tombstone-'))
    roots.push(root)
    const transactions = await initializedTransactions(root)
    const journal = createTeamLifecycleEffectJournal({ transactions })
    const { fence, expected, runId, key } = fixture()
    const recorder = journal.recorder(fence)
    await recorder.armAttempt(expected)
    await transactions.update(state => ({ state: { ...state, attempts: { ...state.attempts,
      [key]: { ...state.attempts[key]!, processOwnership: ownedOwnership(expected) },
    } }, value: undefined }))
    const identity = nativeIdentity(expected, 'owner-process:fixture')
    await recorder.recordAcquired(identity)
    await transactions.update(state => ({ state: { ...state, attempts: { ...state.attempts,
      [key]: { ...state.attempts[key]!, processOwnership: drainedOwnership(expected) },
    } }, value: undefined }))
    const drainProof: NativeAcquisitionDrainProof = {
      kind: 'exact-anchor-terminal', identity, adapterResult: { status: 'drained' }, observedAt: 'now',
    }
    await recorder.recordDrained(drainProof)
    expect((await journal.snapshotRun(runId)).attempts[0]).toMatchObject({
      phase: 'anchor-terminal-pending',
      cleanupSettlement: { status: 'pending' },
    })
    expect((await journal.snapshotRun(runId)).tombstones).toEqual([])
    await journal.finalizeNativeDrain({
      fence,
      identity,
      operation: 'stopOwnedNativeProcess',
      result: { status: 'drained' },
    })
    await transactions.update(state => ({ state: { ...createInitialDurableState('b'.repeat(64), 'auto', {
      revision: state.revision, operationEpoch: state.operationEpoch + 1,
      attempts: state.attempts, tombstones: state.tombstones,
    }) }, value: undefined }))
    const evidence = await journal.snapshotRun(runId)
    expect(evidence.attempts).toMatchObject([{ key, phase: 'drained' }])
    expect(evidence.tombstones).toMatchObject([{ key, terminalPhase: 'drained', processRef: 'owner-process:fixture' }])
  })

  test('retains truthful late acquisition but fences stale readiness publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-journal-late-effect-'))
    roots.push(root)
    const transactions = await initializedTransactions(root)
    const { fence, expected, key } = fixture()
    const recorder = createTeamLifecycleEffectJournal({ transactions }).recorder(fence)
    await recorder.armAttempt(expected)
    await transactions.update(state => ({ state: { ...state, attempts: { ...state.attempts,
      [key]: { ...state.attempts[key]!, processOwnership: ownedOwnership(expected, 'owner-process:late') },
    } }, value: undefined }))
    await transactions.update(state => ({ state: { ...state, operationEpoch: 2 }, value: undefined }))
    const identity = nativeIdentity(expected, 'owner-process:late')
    await expect(recorder.recordAcquired(identity)).resolves.toBeUndefined()
    const readinessProof = workerReadiness(expected, 'late-session')
    await expect(recorder.recordReady({ identity: {
      ...identity,
      runtimeSessionId: 'late-session',
      readiness: readinessProof,
      diagnostics: { pid: 101 },
    }, readinessProof }))
      .rejects.toThrow('Stale')
    expect(await transactions.read(state => state.attempts[key]?.phase)).toBe('acquired')
  })

  test('accepts only Product stop progress that can precede the accepted A recorder callback', () => {
    const { fence, expected, key } = fixture()
    const identity = nativeIdentity(expected, 'owner-process:fixture')
    const readinessProof = workerReadiness(expected, 'session-fixture')
    const readyIdentity: OwnedNativeProcessIdentity = {
      ...identity,
      runtimeSessionId: 'session-fixture',
      readiness: readinessProof,
      diagnostics: { pid: 101 },
    }
    const base = {
      ...createInitialDurableState('a'.repeat(64), 'auto'),
      phase: 'launching' as const,
      runId: JOURNAL_RUN_ID,
      ownerIncarnation: 'owner_fixture',
      operationEpoch: 1,
    }
    const attempt = (phase: 'acquired' | 'ready', processOwnership: ProcessOwnershipState) => ({
      key,
      kind: 'native' as const,
      phase,
      fence,
      expected,
      identity: phase === 'ready' ? readyIdentity : identity,
      ...(phase === 'ready' ? { readinessProof } : {}),
      processOwnership,
    })

    for (const processOwnership of [
      ownedOwnership(expected),
      stoppingOwnership(expected),
      unclassifiedOwnership(expected),
      drainedOwnership(expected),
    ]) {
      expect(decodeDurableState({ ...base, attempts: { [key]: attempt('acquired', processOwnership) } })
        .attempts[key]?.processOwnership?.phase).toBe(processOwnership.phase)
      expect(decodeDurableState({ ...base, attempts: { [key]: attempt('ready', processOwnership) } })
        .attempts[key]?.processOwnership?.phase).toBe(processOwnership.phase)
    }

    const owned = ownedOwnership(expected)
    if (owned.phase !== 'owned') throw new Error('Fixture ownership is not owned')
    const spawnIntent: ProcessOwnershipState = {
      stateVersion: 1,
      revision: 0,
      phase: 'spawn_intent',
      intent: owned.intent,
    }
    expect(() => decodeDurableState({ ...base, attempts: { [key]: attempt('acquired', spawnIntent) } }))
      .toThrow('compatible exact Product ownership')
    expect(() => decodeDurableState({ ...base, attempts: { [key]: attempt('ready', spawnIntent) } }))
      .toThrow('compatible exact Product ownership')

    const unownedResidual: ProcessOwnershipState = {
      ...spawnIntent,
      revision: 1,
      phase: 'unclassified_residual',
      terminalReason: 'pre-ownership start outcome is uncertain',
    }
    expect(() => decodeDurableState({ ...base, attempts: { [key]: attempt('acquired', unownedResidual) } }))
      .toThrow('compatible exact Product ownership')
    expect(() => decodeDurableState({ ...base, attempts: { [key]: attempt('ready', unownedResidual) } }))
      .toThrow('compatible exact Product ownership')
  })

  test('migrates idle schema 2 while preserving revision and records active legacy state as unresolved', () => {
    const idle = decodeDurableState({ schemaVersion: 2, revision: 8, planFingerprint: 'a'.repeat(64), toolApprovalMode: 'manual',
      phase: 'idle', runId: null, recoverable: false })
    expect(idle).toMatchObject({ schemaVersion: 5, revision: 8, operationEpoch: 0, attempts: {}, tombstones: [], legacyUnresolved: null })
    const active = decodeDurableState({ schemaVersion: 4, revision: 9, planFingerprint: 'b'.repeat(64), toolApprovalMode: 'auto',
      phase: 'running', runId: 'run_legacy', recoverable: false, ownerIncarnation: 'owner_legacy',
      recoveryBindings: { lane: `session-set_${'c'.repeat(64)}` } })
    expect(active.legacyUnresolved).toMatchObject({ schemaVersion: 4, runId: 'run_legacy', phase: 'running' })
    expect(active.attempts).toEqual({})
  })

  test('rejects unknown schemas and malformed nested attempts', () => {
    expect(() => decodeDurableState({ schemaVersion: 6 })).toThrow('Unsupported')
    const state = createInitialDurableState('a'.repeat(64), 'auto')
    expect(() => decodeDurableState({ ...state, attempts: { bad: { key: 'substituted' } } })).toThrow()
  })

  test('rejects persisted Product references outside the Product opaque-reference grammar', () => {
    const { fence, expected, key } = fixture()
    const identity = nativeIdentity(expected, 'owner-process:fixture')
    const ownership = ownedOwnership(expected)
    if (ownership.phase !== 'owned') throw new Error('Fixture ownership is not owned')
    const base = {
      ...createInitialDurableState('a'.repeat(64), 'auto'),
      phase: 'launching' as const,
      runId: JOURNAL_RUN_ID,
      ownerIncarnation: 'owner_fixture',
      operationEpoch: 1,
    }
    const decodeAcquired = (candidateIdentity: unknown, candidateOwnership: unknown) =>
      decodeDurableState({
        ...base,
        attempts: {
          [key]: {
            key,
            kind: 'native',
            phase: 'acquired',
            fence,
            expected,
            identity: candidateIdentity,
            processOwnership: candidateOwnership,
          },
        },
      })

    expect(() => decodeAcquired({ ...identity, processRef: 'short' }, ownership))
      .toThrow('owned-process-ref-invalid')
    expect(() => decodeAcquired(identity, {
      ...ownership,
      intent: { ...ownership.intent, processRef: 'short' },
    })).toThrow('owned-process-ref-invalid')
    expect(() => decodeAcquired(identity, {
      ...ownership,
      intent: { ...ownership.intent, spawnNonce: 'short' },
    })).toThrow('spawn-nonce-invalid')

    const ownershipReferences = [
      { substitution: { mainProcessIdentityRef: 'short' }, errorCode: 'main-process-identity-ref-invalid' },
      { substitution: { ownerAttestation: { ...ownership.ownership.ownerAttestation, channelRef: 'short' } },
        errorCode: 'anchor-channel-ref-invalid' },
      { substitution: { ownerAttestation: {
        ...ownership.ownership.ownerAttestation,
        owningProcessIdentityRef: 'short',
      } }, errorCode: 'owning-process-identity-ref-invalid' },
      { substitution: { ownerAttestation: {
        ...ownership.ownership.ownerAttestation,
        anchorIdentityRef: 'short',
      } }, errorCode: 'anchor-identity-ref-invalid' },
    ]
    for (const { substitution, errorCode } of ownershipReferences) {
      expect(() => decodeAcquired(identity, {
        ...ownership,
        ownership: { ...ownership.ownership, ...substitution },
      })).toThrow(errorCode)
    }
  })

  test('keeps anchor-terminal pending across cleanup failure and finalizes a retry with no recorder callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-journal-pending-'))
    roots.push(root)
    const transactions = await initializedTransactions(root)
    const journal = createTeamLifecycleEffectJournal({ transactions })
    const { fence, expected, key, runId } = fixture()
    const recorder = journal.recorder(fence)
    await recorder.armAttempt(expected)
    await transactions.update(state => ({ state: { ...state, attempts: { ...state.attempts,
      [key]: { ...state.attempts[key]!, processOwnership: ownedOwnership(expected) },
    } }, value: undefined }))
    const identity = nativeIdentity(expected, 'owner-process:fixture')
    await recorder.recordAcquired(identity)
    await transactions.update(state => ({ state: { ...state, attempts: {
      ...state.attempts,
      [key]: { ...state.attempts[key]!, processOwnership: drainedOwnership(expected) },
    } }, value: undefined }))
    await recorder.recordDrained({
      kind: 'exact-anchor-terminal',
      identity,
      adapterResult: { status: 'drained' },
      observedAt: 'first-observation',
    })
    await journal.recordNativeCleanupFailure({
      fence,
      identity,
      operation: 'reconcileFailedAttempt',
      reason: 'modeled A worker claim settlement rejected',
    })

    const reopened = createTeamLifecycleEffectJournal({
      transactions: new TeamLifecycleJournalTransactions(join(root, 'execution.json')),
    })
    expect((await reopened.snapshotRun(runId)).attempts[0]).toMatchObject({
      phase: 'anchor-terminal-pending',
      cleanupSettlement: { status: 'pending' },
      cleanupFailures: [{ reason: 'modeled A worker claim settlement rejected' }],
    })

    // This modeled retained-terminal retry follows accepted A's no-second-recorder-
    // callback behavior. The trusted caller publishes a modeled fulfilled result.
    await reopened.finalizeNativeDrain({
      fence,
      identity,
      operation: 'reconcileFailedAttempt',
      result: { status: 'drained' },
    })
    const settled = await reopened.snapshotRun(runId)
    expect(settled.attempts[0]).toMatchObject({ phase: 'drained' })
    expect(settled.tombstones).toHaveLength(1)
  })

  test('runs accepted A worker removal failure through the same journal and retries without a fresh callback', async () => {
    const value = await actualAWorkerFixture()
    const recorder = value.journal.recorder(value.fence)
    const displacedConfig = `${value.configPath}.removal-failure`
    let identity: OwnedNativeProcessIdentity | undefined
    const failingRecorder: NativeAcquisitionRecorder = {
      armAttempt: expected => recorder.armAttempt(expected),
      async recordAcquired(acquired) {
        identity = acquired
        await recorder.recordAcquired(acquired)
        throw new Error('actual A fixture forces acquired compensation')
      },
      recordReady: ready => recorder.recordReady(ready),
      recordUncertain: uncertain => recorder.recordUncertain(uncertain),
      async recordDrained(proof) {
        await recorder.recordDrained(proof)
        await rename(value.configPath, displacedConfig)
      },
      recordNoEffect: proof => recorder.recordNoEffect(proof),
    }
    const cancellation = {
      cancellationId: 'cancel:actual-a-journal-fixture' as RuntimeCancellationId,
      isCancellationRequested: () => false,
    }
    const failure = await value.acquisition.launchOwnedNativeWorker({ memberOrdinal: value.expected.memberOrdinal,
      recorder: failingRecorder, cancellation, effectAuthorization: value.authorization }).then(
      () => { throw new Error('Actual A worker fixture expected cleanup failure') },
      error => error,
    )
    expect(failure).toBeInstanceOf(NativeProcessAcquisitionFailure)
    if (!(failure instanceof NativeProcessAcquisitionFailure) || !identity) {
      throw new Error('Actual A worker fixture did not retain its exact failure and identity')
    }
    const reopened = createTeamLifecycleEffectJournal({
      transactions: new TeamLifecycleJournalTransactions(value.statePath),
    })
    const pending = await reopened.snapshotRun(value.expected.runId)
    expect(pending.attempts[0]).toMatchObject({
      phase: 'anchor-terminal-pending',
      anchorTerminalEvidence: { identity: { processRef: value.processRef } },
      cleanupSettlement: { status: 'pending' },
      processOwnership: { phase: 'drained' },
    })
    expect(pending.attempts[0]?.uncertainEvidence).toHaveLength(1)
    expect(pending.tombstones).toEqual([])
    await rename(displacedConfig, value.configPath)

    let retryCallbacks = 0
    const noFreshCallback: NativeAcquisitionRecorder = {
      async armAttempt() { retryCallbacks += 1 },
      async recordAcquired() { retryCallbacks += 1 },
      async recordReady() { retryCallbacks += 1 },
      async recordUncertain() { retryCallbacks += 1 },
      async recordDrained() { retryCallbacks += 1 },
      async recordNoEffect() { retryCallbacks += 1 },
    }
    const result = await value.acquisition.reconcileFailedAttempt({ attempt: failure.attempt, mode: 'immediate',
      cancellation, recorder: noFreshCallback })
    expect(result).toEqual({ status: 'drained' })
    if (result.status !== 'drained' && result.status !== 'already_drained') {
      throw new Error('Actual A worker retry did not prove terminal cleanup')
    }
    expect(retryCallbacks).toBe(0)
    expect(actualAProduct.stops).toBe(1)
    const publicTeam = JSON.parse(await readFile(value.configPath, 'utf8')) as { members: Array<{ agentId: string }> }
    expect(publicTeam.members.map(member => member.agentId)).not.toContain(value.expected.agentId)
    expect((await reopened.snapshotRun(value.expected.runId)).attempts[0]?.phase).toBe('anchor-terminal-pending')

    await reopened.finalizeNativeDrain({ fence: value.fence, identity,
      operation: 'reconcileFailedAttempt', result })
    const settled = await reopened.snapshotRun(value.expected.runId)
    expect(settled.attempts[0]?.phase).toBe('drained')
    expect(settled.tombstones).toHaveLength(1)
  })

  test('rejects duplicate raw members and idle publication with pending custody', () => {
    const state = createInitialDurableState('a'.repeat(64), 'auto')
    expect(() => parseDurableStateJson(
      stringifyDurableState(state).replace(
        '"schemaVersion":5',
        '"schemaVersion":5,"schemaVersion":5',
      ),
    )).toThrow('Duplicate')

    const { fence, expected, key } = fixture()
    const identity = nativeIdentity(expected, 'owner-process:fixture')
    const pending = {
      ...state,
      attempts: {
        [key]: {
          key,
          kind: 'native' as const,
          phase: 'anchor-terminal-pending' as const,
          fence,
          expected,
          identity,
          anchorTerminalEvidence: {
            kind: 'exact-anchor-terminal' as const,
            identity,
            adapterResult: { status: 'drained' as const },
            observedAt: 'now',
          },
          cleanupSettlement: { status: 'pending' as const },
          processOwnership: drainedOwnership(expected),
        },
      },
    }
    expect(() => decodeDurableState(pending)).toThrow('idle')
  })

  test('retains compacted terminal custody while fencing every standalone tombstone field', () => {
    const { fence, expected, key, runId } = fixture()
    const proof = {
      kind: 'pre-start-failure' as const,
      expected,
      startWasNeverCalled: true as const,
      claimSettled: true as const,
      observedAt: 'standalone-tombstone',
      reason: 'effect was never authorized',
    }
    const tombstone = {
      key,
      fence,
      expected,
      scope: { planRef: expected.binding.launchSpec.planRef,
        executionUnitId: expected.binding.executionUnit.executionUnitId },
      terminalPhase: 'noeffect' as const,
      terminalEvidence: proof,
    }
    const compacted = {
      ...createInitialDurableState('a'.repeat(64), 'auto'),
      phase: 'launching' as const,
      runId,
      ownerIncarnation: fence.ownerIncarnation,
      operationEpoch: fence.operationEpoch,
      tombstones: [tombstone],
    }
    expect(() => decodeDurableState(compacted)).not.toThrow()
    for (const changedFence of [
      { ...fence, runId: `${runId}-substituted` },
      { ...fence, controllerInstanceId: `${fence.controllerInstanceId}-substituted` },
      { ...fence, ownerPlanGeneration: `${fence.ownerPlanGeneration}-substituted` },
    ]) {
      expect(() => decodeDurableState({
        ...compacted,
        tombstones: [{ ...tombstone, fence: changedFence }],
      })).toThrow('tombstone mapping')
    }
  })

  test('joins retained uncertainty refs and rejects phase-evidence reserve bypasses', () => {
    const { fence, expected, key, runId } = fixture()
    const identity = nativeIdentity(expected, 'owner-process:fixture')
    const acquired = {
      key,
      kind: 'native' as const,
      phase: 'acquired' as const,
      fence,
      expected,
      identity,
      processOwnership: drainedOwnership(expected),
    }
    const base = {
      ...createInitialDurableState('a'.repeat(64), 'auto'),
      phase: 'launching' as const,
      runId,
      ownerIncarnation: fence.ownerIncarnation,
      operationEpoch: fence.operationEpoch,
      attempts: { [key]: acquired },
    }
    // Actual A may leave acquired/ready custody while Product has already reached drained.
    expect(() => decodeDurableState(base)).not.toThrow()
    const readinessProof = workerReadiness(expected, 'runtime-session-phase-evidence')
    const readyIdentity = { ...identity, runtimeSessionId: 'runtime-session-phase-evidence',
      readiness: readinessProof }
    expect(() => decodeDurableState({
      ...base,
      attempts: { [key]: { ...acquired, phase: 'ready' as const, identity: readyIdentity,
        readinessProof } },
    })).not.toThrow()
    expect(() => decodeDurableState({
      ...base,
      attempts: { [key]: { ...acquired, cleanupSettlement: { status: 'pending' as const } } },
    })).toThrow('optional phase evidence')
    expect(() => decodeDurableState({
      ...base,
      attempts: { [key]: {
        ...acquired,
        phase: 'uncertain' as const,
        uncertainEvidence: [{
          attempt: { version: 1 as const, kind: 'known-anchor-ref' as const, expected,
            processRef: 'owner-process:substituted', startResult: { status: 'started' } },
          phase: 'stop',
          adapterResult: { status: 'uncertain' },
        }],
      } },
    })).toThrow('uncertainty process reference substitution')
  })

  test('derives a bounded envelope that covers the former 192 KiB terminal counterexample', () => {
    const { fence, expected, key } = capacityFixture(7)
    const identity = nativeIdentity(expected, 'owner-process:capacity-fixture')
    const anchorTerminalEvidence = {
      kind: 'exact-anchor-terminal' as const,
      identity,
      adapterResult: { status: 'already_drained' as const },
      observedAt: '\u0001'.repeat(256),
    }
    const pending = {
      key,
      kind: 'native' as const,
      phase: 'anchor-terminal-pending' as const,
      fence,
      expected,
      identity,
      anchorTerminalEvidence,
      cleanupSettlement: { status: 'pending' as const },
      processOwnership: drainedOwnership(expected, 'owner-process:capacity-fixture'),
    }
    const completion = { fence, identity, operation: 'reconcileFailedAttempt' as const,
      result: { status: 'already_drained' as const } }
    const settled = { ...pending, phase: 'drained' as const,
      cleanupSettlement: { status: 'completed' as const, completion } }
    const tombstone = { key, fence, expected,
      scope: { planRef: expected.binding.launchSpec.planRef,
        executionUnitId: expected.binding.executionUnit.executionUnitId },
      processRef: identity.processRef, terminalPhase: 'drained' as const,
      terminalEvidence: anchorTerminalEvidence, cleanupCompletion: completion }
    const actualTerminalDelta = safeDurableJsonByteLength(settled) -
      safeDurableJsonByteLength(pending) + safeDurableJsonByteLength(tombstone) + 1
    expect(actualTerminalDelta).toBeGreaterThan(192 * 1024)
    expect(durableAttemptSettlementEnvelopeBytes(pending)).toBeGreaterThanOrEqual(
      safeDurableJsonByteLength(settled) + safeDurableJsonByteLength(tombstone),
    )
  })

  test('admits a maximum bounded identity inside its larger proof and completion wrappers', async () => {
    const processRefValue = `p${'x'.repeat(255)}`
    let low = 0
    let high = 70 * 1024
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const candidate = capacityFixture(70, middle)
      const identity = nativeIdentity(candidate.expected, processRefValue)
      if (
        safeDurableJsonByteLength(candidate.expected) <=
          TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES &&
        safeDurableJsonByteLength(identity) <=
          TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES
      ) low = middle
      else high = middle - 1
    }
    const { fence, expected, key, runId } = capacityFixture(70, low)
    const identity = nativeIdentity(expected, processRefValue)
    const proof = { kind: 'exact-anchor-terminal' as const, identity,
      adapterResult: { status: 'already_drained' as const },
      observedAt: '\u0001'.repeat(256) }
    const completion = { fence, identity,
      operation: 'reconcileFailedAttempt' as const,
      result: { status: 'already_drained' as const } }
    expect(safeDurableJsonByteLength(identity)).toBeLessThanOrEqual(
      TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES,
    )
    expect(safeDurableJsonByteLength(proof)).toBeGreaterThan(
      TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES,
    )
    expect(safeDurableJsonByteLength(completion)).toBeGreaterThan(
      TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES,
    )
    const pending = { key, kind: 'native' as const,
      phase: 'anchor-terminal-pending' as const, fence, expected, identity,
      anchorTerminalEvidence: proof,
      cleanupSettlement: { status: 'pending' as const },
      processOwnership: drainedOwnership(expected, processRefValue) }
    const settled = { ...pending, phase: 'drained' as const,
      cleanupSettlement: { status: 'completed' as const, completion } }
    const tombstone = { key, fence, expected,
      scope: { planRef: expected.binding.launchSpec.planRef,
        executionUnitId: expected.binding.executionUnit.executionUnitId },
      processRef: identity.processRef, terminalPhase: 'drained' as const,
      terminalEvidence: proof, cleanupCompletion: completion }
    const state = { ...createInitialDurableState('a'.repeat(64), 'auto'),
      phase: 'launching' as const, runId,
      ownerIncarnation: fence.ownerIncarnation,
      operationEpoch: fence.operationEpoch,
      attempts: { [key]: settled }, tombstones: [tombstone] }
    expect(() => decodeDurableState(state)).not.toThrow()
    expect(durableAttemptSettlementEnvelopeBytes(pending)).toBeGreaterThanOrEqual(
      safeDurableJsonByteLength(settled) + safeDurableJsonByteLength(tombstone),
    )

    const oversized = capacityFixture(71, low + 1)
    expect(safeDurableJsonByteLength(
      nativeIdentity(oversized.expected, processRefValue),
    )).toBeGreaterThan(TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES)
    const root = await mkdtemp(join(tmpdir(), 'team-journal-capacity-arm-'))
    roots.push(root)
    const transactions = await initializedTransactions(root)
    const recorder = createTeamLifecycleEffectJournal({ transactions })
      .recorder(oversized.fence)
    await expect(recorder.armAttempt(oversized.expected)).rejects.toThrow()
    expect(await transactions.read(current => Object.keys(current.attempts)))
      .toEqual([])
  })

  test('physically settles a near-limit arm through Product, journal pending, and finalization', async () => {
    const targetFixture = capacityFixture(0, 32)
    const target = { key: targetFixture.key, kind: 'native' as const, phase: 'armed' as const,
      fence: targetFixture.fence, expected: targetFixture.expected }
    const attempts: Record<string, typeof target | ReturnType<typeof capacityNoEffectPair>['attempt']> = {
      [target.key]: target,
    }
    const tombstones: Array<ReturnType<typeof capacityNoEffectPair>['tombstone']> = []
    const state = {
      ...createInitialDurableState('a'.repeat(64), 'auto'),
      revision: 99,
      phase: 'launching' as const,
      runId: targetFixture.runId,
      ownerIncarnation: targetFixture.fence.ownerIncarnation,
      operationEpoch: targetFixture.fence.operationEpoch,
      attempts,
      tombstones,
    }
    let physicalBytes = safeDurableJsonByteLength(state) + 1
    const targetReserve = durableAttemptReservationBytes(target)
    const revisionHeadroom = 16 - safeDurableJsonByteLength(state.revision)
    const pairBytes = (pair: ReturnType<typeof capacityNoEffectPair>) =>
      safeDurableJsonByteLength(pair.attempt.key) + 1 +
      safeDurableJsonByteLength(pair.attempt) + 1 +
      safeDurableJsonByteLength(pair.tombstone) + (tombstones.length === 0 ? 0 : 1)
    const admittedPairBytes: number[] = []
    let ordinal = 1
    for (; ordinal < 1000; ordinal += 1) {
      const pair = capacityNoEffectPair(ordinal)
      const bytes = pairBytes(pair)
      if (physicalBytes + bytes + revisionHeadroom + targetReserve >
        TEAM_LIFECYCLE_STATE_MAX_BYTES) break
      attempts[pair.attempt.key] = pair.attempt
      tombstones.push(pair.tombstone)
      admittedPairBytes.push(bytes)
      physicalBytes += bytes
    }
    expect(tombstones.length).toBeGreaterThan(100)
    let slack = TEAM_LIFECYCLE_STATE_MAX_BYTES -
      (physicalBytes + revisionHeadroom + targetReserve)
    const minimumPairBytes = pairBytes(capacityNoEffectPair(ordinal, 0))
    if (slack > 3 && slack < minimumPairBytes) {
      const removed = tombstones.pop()
      if (!removed) throw new Error('Near-limit fixture has no removable terminal pair')
      delete attempts[removed.key]
      physicalBytes -= admittedPairBytes.pop()!
      slack = TEAM_LIFECYCLE_STATE_MAX_BYTES -
        (physicalBytes + revisionHeadroom + targetReserve)
    }
    while (slack >= pairBytes(capacityNoEffectPair(ordinal, 0))) {
      let low = 0
      let high = 48 * 1024
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (pairBytes(capacityNoEffectPair(ordinal, middle)) <= slack) low = middle
        else high = middle - 1
      }
      const pair = capacityNoEffectPair(ordinal, low)
      const bytes = pairBytes(pair)
      attempts[pair.attempt.key] = pair.attempt
      tombstones.push(pair.tombstone)
      physicalBytes += bytes
      slack -= bytes
      ordinal += 1
    }
    expect(slack).toBeLessThanOrEqual(3)
    const encoded = `${stringifyDurableState(state)}\n`
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(physicalBytes)
    assertDurableStateCapacity(state, physicalBytes)
    expect(() => parseDurableStateJson(encoded)).not.toThrow()
    expect(() => parseDurableStateJson(encoded.replace('{', '{    ')))
      .toThrow('terminal byte reserve unavailable')

    const root = await mkdtemp(join(tmpdir(), 'team-journal-capacity-physical-'))
    roots.push(root)
    const statePath = join(root, 'execution.json')
    const transactions = new TeamLifecycleJournalTransactions(statePath)
    await transactions.initialize(state)
    const reopenedTransactions = new TeamLifecycleJournalTransactions(statePath)
    const journal = createTeamLifecycleEffectJournal({
      transactions: reopenedTransactions,
    })
    const recorder = journal.recorder(targetFixture.fence)
    const store = createOwnerProcessOwnershipStoreAdapter({
      transactions: reopenedTransactions,
      ownerBinding: ACTUAL_A_OWNER_BINDING,
      controllerInstanceId: parseProcessControllerInstanceId(
        targetFixture.expected.ownerControllerInstanceId,
      ),
    })
    const product = capacityProductTransitions(
      targetFixture.expected,
      'owner-process:capacity-physical',
    )
    const identity = nativeIdentity(
      targetFixture.expected,
      'owner-process:capacity-physical',
    )
    const attemptMeasure = async () => reopenedTransactions.read(current => {
      const attempt = current.attempts[target.key]
      if (!attempt) throw new Error('Physical capacity target disappeared')
      return { revision: current.revision,
        rowBytes: safeDurableJsonByteLength(attempt),
        reserveBytes: durableAttemptReservationBytes(attempt),
        phase: attempt.phase }
    })
    const beforeIntent = await attemptMeasure()
    expect((await store.compareAndSwap({ scope: product.scope,
      expectedRevision: null, next: product.intent,
      context: actualAStoreContext() })).status).toBe('applied')
    const afterIntent = await attemptMeasure()
    expect(afterIntent.revision).toBe(100)
    expect(beforeIntent.reserveBytes - afterIntent.reserveBytes)
      .toBe(afterIntent.rowBytes - beforeIntent.rowBytes)
    expect((await store.compareAndSwap({ scope: product.scope,
      expectedRevision: product.intent.revision, next: product.owned,
      context: actualAStoreContext() })).status).toBe('applied')
    await recorder.recordAcquired(identity)
    expect((await store.compareAndSwap({ scope: product.scope,
      expectedRevision: product.owned.revision, next: product.stopping,
      context: actualAStoreContext() })).status).toBe('applied')
    expect((await store.compareAndSwap({ scope: product.scope,
      expectedRevision: product.stopping.revision, next: product.drained,
      context: actualAStoreContext() })).status).toBe('applied')
    await recorder.recordDrained({ kind: 'exact-anchor-terminal', identity,
      adapterResult: { status: 'drained' }, observedAt: 'capacity-boundary' })
    const pending = await attemptMeasure()
    expect(pending.phase).toBe('anchor-terminal-pending')
    expect(pending.reserveBytes).toBeLessThan(beforeIntent.reserveBytes)

    const unchangedBeforeDisposition = await readFile(statePath, 'utf8')
    await expect(journal.recordDisposition({ runId: targetFixture.runId,
      operationEpoch: targetFixture.fence.operationEpoch, status: 'pending',
      reason: 'unrelated disposition must not consume terminal reserve' }))
      .rejects.toThrow('terminal byte reserve unavailable')
    expect(byteDigest(await readFile(statePath, 'utf8')))
      .toBe(byteDigest(unchangedBeforeDisposition))
    const sibling = capacityFixture(5_000, 32)
    await expect(journal.recorder(sibling.fence).armAttempt(sibling.expected))
      .rejects.toThrow('terminal byte reserve unavailable')
    expect(byteDigest(await readFile(statePath, 'utf8')))
      .toBe(byteDigest(unchangedBeforeDisposition))

    await journal.finalizeNativeDrain({ fence: targetFixture.fence, identity,
      operation: 'stopOwnedNativeProcess', result: { status: 'drained' } })
    const finalState = await new TeamLifecycleJournalTransactions(statePath)
      .read(current => current)
    expect(finalState.attempts[target.key]?.phase).toBe('drained')
    expect(finalState.tombstones.find(item => item.key === target.key))
      .toMatchObject({ terminalPhase: 'drained',
        processRef: 'owner-process:capacity-physical' })
    expect(Buffer.byteLength(await readFile(statePath, 'utf8'), 'utf8'))
      .toBeLessThanOrEqual(TEAM_LIFECYCLE_STATE_MAX_BYTES)
  }, 120_000)

  test('physically enforces prepaid uncertainty and cleanup-failure slots before finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-journal-capacity-slots-'))
    roots.push(root)
    const transactions = await initializedTransactions(root)
    const journal = createTeamLifecycleEffectJournal({ transactions })
    const { fence, expected, key } = capacityFixture(6_000, 32)
    const recorder = journal.recorder(fence)
    await recorder.armAttempt(expected)
    const store = createOwnerProcessOwnershipStoreAdapter({ transactions,
      ownerBinding: ACTUAL_A_OWNER_BINDING,
      controllerInstanceId: parseProcessControllerInstanceId(
        expected.ownerControllerInstanceId,
      ) })
    const product = capacityProductTransitions(expected, 'owner-process:capacity-slots')
    const identity = nativeIdentity(expected, 'owner-process:capacity-slots')
    expect((await store.compareAndSwap({ scope: product.scope,
      expectedRevision: null, next: product.intent,
      context: actualAStoreContext() })).status).toBe('applied')
    expect((await store.compareAndSwap({ scope: product.scope,
      expectedRevision: product.intent.revision, next: product.owned,
      context: actualAStoreContext() })).status).toBe('applied')
    await recorder.recordAcquired(identity)

    const uncertaintyStdio: NodeAnchorProviderStdio = {
      processRef: identity.processRef,
      capabilityVersion: 1,
      capabilityHash: ACTUAL_A_CAPABILITY_HASH,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      maxOutputBytes: 65_536,
      close() {},
    }
    const uncertainty = (ordinal: number): Parameters<
      NativeAcquisitionRecorder['recordUncertain']
    >[0] => ({
      attempt: { version: 1 as const, kind: 'known-anchor-ref' as const,
        expected, processRef: identity.processRef,
        startResult: { status: 'started', processRef: identity.processRef,
          anchorReady: 'committed_ownership_and_anchor_handshake_only',
          stdio: uncertaintyStdio } },
      phase: `bounded-uncertainty-${ordinal}`,
      adapterResult: { status: 'ready' },
    })
    for (let ordinal = 0;
      ordinal < TEAM_LIFECYCLE_UNCERTAIN_EVIDENCE_CAPACITY;
      ordinal += 1) await recorder.recordUncertain(uncertainty(ordinal))
    await recorder.recordUncertain(uncertainty(0))
    expect(await transactions.read(current =>
      current.attempts[key]?.uncertainEvidence?.length))
      .toBe(TEAM_LIFECYCLE_UNCERTAIN_EVIDENCE_CAPACITY)
    const beforeUncertaintyOverflow = await readFile(
      join(root, 'execution.json'),
      'utf8',
    )
    await expect(recorder.recordUncertain(uncertainty(
      TEAM_LIFECYCLE_UNCERTAIN_EVIDENCE_CAPACITY,
    ))).rejects.toThrow('uncertainty evidence capacity unavailable')
    expect(byteDigest(await readFile(join(root, 'execution.json'), 'utf8')))
      .toBe(byteDigest(beforeUncertaintyOverflow))

    expect((await store.compareAndSwap({ scope: product.scope,
      expectedRevision: product.owned.revision, next: product.stopping,
      context: actualAStoreContext() })).status).toBe('applied')
    expect((await store.compareAndSwap({ scope: product.scope,
      expectedRevision: product.stopping.revision, next: product.drained,
      context: actualAStoreContext() })).status).toBe('applied')
    await recorder.recordDrained({ kind: 'exact-anchor-terminal', identity,
      adapterResult: { status: 'drained' }, observedAt: 'bounded-slots' })
    for (let ordinal = 0;
      ordinal < TEAM_LIFECYCLE_CLEANUP_FAILURE_CAPACITY;
      ordinal += 1) await journal.recordNativeCleanupFailure({ fence, identity,
      operation: 'reconcileFailedAttempt',
      reason: `bounded cleanup failure ${ordinal}` })
    await journal.recordNativeCleanupFailure({ fence, identity,
      operation: 'reconcileFailedAttempt', reason: 'bounded cleanup failure 0' })
    const pending = await transactions.read(current => current.attempts[key]!)
    expect(pending.cleanupFailures).toHaveLength(
      TEAM_LIFECYCLE_CLEANUP_FAILURE_CAPACITY,
    )
    expect(durableAttemptReservationBytes(pending)).toBeGreaterThan(0)
    expect(durableAttemptSettlementEnvelopeBytes(pending))
      .toBeGreaterThan(safeDurableJsonByteLength(pending))
    const beforeFailureOverflow = await readFile(join(root, 'execution.json'), 'utf8')
    await expect(journal.recordNativeCleanupFailure({ fence, identity,
      operation: 'reconcileFailedAttempt',
      reason: `bounded cleanup failure ${TEAM_LIFECYCLE_CLEANUP_FAILURE_CAPACITY}` }))
      .rejects.toThrow('cleanup failure evidence capacity unavailable')
    expect(byteDigest(await readFile(join(root, 'execution.json'), 'utf8')))
      .toBe(byteDigest(beforeFailureOverflow))
    await journal.finalizeNativeDrain({ fence, identity,
      operation: 'reconcileFailedAttempt', result: { status: 'drained' } })
    const settled = await new TeamLifecycleJournalTransactions(
      join(root, 'execution.json'),
    ).read(current => current)
    expect(settled.attempts[key]?.phase).toBe('drained')
    expect(settled.attempts[key]?.uncertainEvidence)
      .toHaveLength(TEAM_LIFECYCLE_UNCERTAIN_EVIDENCE_CAPACITY)
    expect(settled.attempts[key]?.cleanupFailures)
      .toHaveLength(TEAM_LIFECYCLE_CLEANUP_FAILURE_CAPACITY)
  })

  test('physically records no-effect and keeps semantic replay stable across revision widths', async () => {
    const first = capacityNoEffectPair(8_000, 32)
    const firstRoot = await mkdtemp(join(tmpdir(), 'team-journal-noeffect-replay-'))
    roots.push(firstRoot)
    const firstPath = join(firstRoot, 'execution.json')
    const firstTransactions = new TeamLifecycleJournalTransactions(firstPath)
    const firstArmed: DurableAttempt = { key: first.attempt.key, kind: 'native',
      phase: 'armed', fence: first.attempt.fence, expected: first.attempt.expected }
    await firstTransactions.initialize({
      ...createInitialDurableState('a'.repeat(64), 'auto'),
      revision: 8,
      phase: 'launching',
      runId: first.attempt.fence.runId,
      ownerIncarnation: first.attempt.fence.ownerIncarnation,
      operationEpoch: first.attempt.fence.operationEpoch,
      attempts: { [firstArmed.key]: firstArmed },
    })
    const firstRecorder = createTeamLifecycleEffectJournal({
      transactions: firstTransactions,
    }).recorder(first.attempt.fence)
    await firstRecorder.recordNoEffect(first.attempt.terminalEvidence)
    const atNine = await firstTransactions.read(current => current)
    expect(atNine.revision).toBe(9)
    expect(atNine.attempts[first.attempt.key]?.phase).toBe('noeffect')
    expect(atNine.tombstones).toHaveLength(1)
    await firstRecorder.recordNoEffect(first.attempt.terminalEvidence)
    const atTen = await new TeamLifecycleJournalTransactions(firstPath)
      .read(current => current)
    expect(atTen.revision).toBe(10)
    expect({ ...atTen, revision: 9 }).toEqual(atNine)

    const second = capacityNoEffectPair(8_001, 32)
    const secondRoot = await mkdtemp(join(tmpdir(), 'team-journal-noeffect-replay-'))
    roots.push(secondRoot)
    const secondPath = join(secondRoot, 'execution.json')
    const secondTransactions = new TeamLifecycleJournalTransactions(secondPath)
    await secondTransactions.initialize({
      ...createInitialDurableState('b'.repeat(64), 'auto'),
      revision: 99,
      phase: 'launching',
      runId: second.attempt.fence.runId,
      ownerIncarnation: second.attempt.fence.ownerIncarnation,
      operationEpoch: second.attempt.fence.operationEpoch,
      attempts: { [second.attempt.key]: second.attempt },
      tombstones: [second.tombstone],
    })
    const atNinetyNine = await secondTransactions.read(current => current)
    await createTeamLifecycleEffectJournal({ transactions: secondTransactions })
      .recorder(second.attempt.fence)
      .recordNoEffect(second.attempt.terminalEvidence)
    const atOneHundred = await new TeamLifecycleJournalTransactions(secondPath)
      .read(current => current)
    expect(atOneHundred.revision).toBe(100)
    expect({ ...atOneHundred, revision: 99 }).toEqual(atNinetyNine)
    expect(atOneHundred.tombstones).toHaveLength(1)
  })

  test('safe codec round trips accepted Product bigint inode evidence without permitting tag substitution', () => {
    const state = createInitialDurableState('a'.repeat(64), 'auto')
    const withEvidence = {
      ...state,
      phase: 'launching' as const,
      runId: JOURNAL_RUN_ID,
      ownerIncarnation: 'owner_fixture',
      operationEpoch: 1,
      disposition: {
        runId: JOURNAL_RUN_ID,
        operationEpoch: 1,
        status: 'pending',
        reason: 'registered Product root evidence awaits delivery',
        evidence: { registeredRootEvidence: { device: 12n, inode: 34n, mountId: 56n } },
      },
    }
    expect(parseDurableStateJson(stringifyDurableState(withEvidence)).disposition).toEqual(withEvidence.disposition)
    const substitutedTag = stringifyDurableState(withEvidence).replace(
      '{"$teamLifecycleBigInt":"12"}',
      '{"$teamLifecycleBigInt":"12","extra":"substitution"}',
    )
    expect(() => parseDurableStateJson(substitutedTag)).toThrow('bigint')
  })

  test('physically publishes idle migration to schema 5 in the private file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-journal-migration-'))
    roots.push(root)
    const path = join(root, 'execution.json')
    await writeFile(path, `${JSON.stringify({ schemaVersion: 3, revision: 3, planFingerprint: 'a'.repeat(64),
      toolApprovalMode: 'manual', phase: 'idle', runId: null, recoverable: false, ownerIncarnation: null })}\n`, { mode: 0o600 })
    const transactions = new TeamLifecycleJournalTransactions(path)
    await transactions.migrateLegacyIfNeeded()
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schemaVersion: 5, revision: 4, tombstones: [] })
  })
})

function drainedOwnership(
  expected: NativeAcquisitionPreparedExpectation,
  processRefValue = 'owner-process:fixture',
): ProcessOwnershipState {
  const scope = { planRef: expected.binding.launchSpec.planRef, executionUnitId: expected.binding.executionUnit.executionUnitId }
  const grant = expected.binding.launchSpec.workdirAuthority.grant
  const workspaceBinding = { workspaceId: grant.workspaceId, registrationRevision: grant.registrationRevision,
    bindingGeneration: grant.bindingGeneration, mountGeneration: grant.mountGeneration }
  const processRef = parseOwnedProcessRef(processRefValue)
  const intent = { intentVersion: 1 as const, scope, processRef, spawnNonce: parseSpawnNonce('owner-spawn:fixture'), workspaceBinding,
    binaryBinding: expected.binding.launchSpec.argvAuthority.binaryPolicy,
    argvDigest: expected.binding.launchSpec.argvAuthority.argvHash,
    argvCount: expected.binding.launchSpec.argvAuthority.argv.length,
    environmentPolicyDigest: computeCanonicalPolicyDigest(expected.binding.executionUnit.environmentPolicy),
    relayScopeDigest: computeCanonicalPolicyDigest({
      laneId: expected.binding.executionUnit.laneId,
      memberIds: expected.binding.executionUnit.memberIds,
    }) }
  const ownerAttestation = { attestationVersion: 1 as const, authorityId: 'authority', bootId: 'boot', processRef: intent.processRef, scope,
    workspaceBinding, spawnNonceDigest: spawnNonceDigest(intent.spawnNonce), channelRef: parseAnchorChannelRef('channel-reference-fixture'),
    owningProcessIdentityRef: parseOwningProcessIdentityRef('owning-identity-fixture'),
    anchorIdentityRef: parseAnchorIdentityRef('anchor-identity-fixture') }
  const ownership: ProcessOwnershipRecord = { recordVersion: 1 as const, processRef: intent.processRef, scope, workspaceBinding,
    spawnNonceDigest: spawnNonceDigest(intent.spawnNonce), controllerInstanceId: parseProcessControllerInstanceId('controller-fixture-0001'),
    ownerAttestation, mainProcessIdentityRef: parseMainProcessIdentityRef('main-identity-fixture'), lastStatusSequence: 2 }
  return { stateVersion: 1, revision: 3, phase: 'drained', intent, ownership, terminalReason: 'fixture-drained' }
}

function ownedOwnership(
  expected: NativeAcquisitionPreparedExpectation,
  processRefValue = 'owner-process:fixture',
): ProcessOwnershipState {
  const drained = drainedOwnership(expected, processRefValue)
  if (drained.phase !== 'drained') throw new Error('Fixture ownership is not drained')
  const { terminalReason: _terminalReason, ...owned } = drained
  return { ...owned, revision: 2, phase: 'owned' }
}

function stoppingOwnership(expected: NativeAcquisitionPreparedExpectation): ProcessOwnershipState {
  const owned = ownedOwnership(expected)
  if (owned.phase !== 'owned') throw new Error('Fixture ownership is not owned')
  return { ...owned, revision: owned.revision + 1, phase: 'stopping' }
}

function unclassifiedOwnership(expected: NativeAcquisitionPreparedExpectation): ProcessOwnershipState {
  const stopping = stoppingOwnership(expected)
  if (stopping.phase !== 'stopping') throw new Error('Fixture ownership is not stopping')
  return {
    ...stopping,
    revision: stopping.revision + 1,
    phase: 'unclassified_residual',
    terminalReason: 'fixture stop outcome is uncertain',
  }
}
