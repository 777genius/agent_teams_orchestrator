import { describe, expect, test } from 'bun:test'
import {
  computeCanonicalPolicyDigest,
  spawnNonceDigest,
  type SpawnNonce,
} from '@agent-teams/owner-anchor-library'
import {
  computeNativeProductPlanRefDigest,
  type NativeAcquisitionPreparedExpectation,
} from './NativeProcessAcquisition.js'
import {
  cloneJson,
  createAttemptKey,
  decodeDurableState,
  expectedAttemptScope,
  validateDurableStateForWrite,
  type DurableStateV5,
} from './TeamLifecycleDurableState.js'

type UnknownRecord = Record<string, unknown>

const runId = `run_${'2'.repeat(32)}`
const teamId = `team_${'1'.repeat(32)}`
const ownerPlanGeneration = 'owner-plan-enum-codec'
const controllerInstanceId = 'controller-enum-codec-0001'
const processRef = 'owner-process:enum-codec-fixture'
const spawnNonce = 'owner-spawn:enum-codec-fixture'
const digest = (hex: string) => `sha256:${hex.repeat(64)}`

function record(value: unknown): UnknownRecord {
  return value as UnknownRecord
}

function fixture() {
  const memberId = `member_${'6'.repeat(32)}`
  const planRef = { teamId, runId, generation: 4, planHash: digest('3') }
  const binaryPolicy = {
    policy: 'registered_exact_binary',
    binaryId: 'binary-enum-codec',
    binaryRevision: 1,
    binaryHash: digest('4'),
  }
  const environmentPolicy = {
    policy: 'explicit_allowlist',
    variables: [{ name: 'STATIC_TOKEN', provenance: 'provider_static' }],
  }
  const resourcePolicy = {
    maxRuntimeMs: 60_000,
    gracefulStopMs: 1_000,
    maxOutputBytes: 65_536,
    maxProcessCount: 1,
  }
  const workspaceGrant = {
    grantId: 'workspace-grant-enum-codec',
    workspaceId: `workspace_${'5'.repeat(32)}`,
    registrationRevision: 2,
    bindingGeneration: 3,
    mountGeneration: 4,
    permission: 'execute_process',
  }
  const expected = {
    version: 1,
    role: 'native-worker',
    publicTeamId: teamId,
    legacyKey: 'enum-codec-fixture',
    runId,
    attemptSetId: 'enum-codec-set',
    attemptToken: 'enum-codec-attempt-token',
    memberOrdinal: 0,
    laneId: 'lane-enum-codec',
    displayName: 'enum-codec-worker',
    agentId: memberId,
    provider: 'anthropic',
    model: 'fixture-model',
    ownerBootId: 'boot-enum-codec',
    ownerControllerInstanceId: controllerInstanceId,
    ownerPlanGeneration,
    productPlanGeneration: 4,
    productPlanRef: computeNativeProductPlanRefDigest(planRef as never),
    materialDigest: 'material-enum-codec',
    recipeDigest: 'recipe-enum-codec',
    profileDigest: 'profile-enum-codec',
    binding: {
      ownerPlanGeneration,
      ownerUnitBindingId: 'owner-unit-enum-codec',
      orderedMembers: [{ ordinal: 0, memberId }],
      executionUnit: {
        executionUnitId: 'unit-enum-codec',
        backendBinding: {
          backend: 'provisioning_cli',
          bindingId: 'binding-enum-codec',
          bindingRevision: 1,
        },
        laneId: 'lane-enum-codec',
        memberIds: [memberId],
        binaryPolicy,
        environmentPolicy,
        credentialExposureSet: { secretRefs: [] },
        credentialIsolation: 'dedicated_execution_unit',
        resourcePolicy,
      },
      launchSpec: {
        planRef,
        executionUnitId: 'unit-enum-codec',
        backend: 'provisioning_cli',
        argvAuthority: {
          executableRef: 'executable-authority-enum-codec',
          binaryPolicy,
          argv: ['worker'],
          argvHash: digest('7'),
        },
        workdirAuthority: {
          workdirRef: 'workdir-authority-enum-codec',
          grant: workspaceGrant,
        },
        environmentAuthority: {
          environmentRef: 'environment-authority-enum-codec',
          policy: environmentPolicy,
        },
        resourcePolicy,
      },
    },
  } as unknown as NativeAcquisitionPreparedExpectation
  const key = createAttemptKey({
    ownerPlanGeneration,
    runId,
    originalLaneId: expected.laneId,
    globalOrdinal: 0,
    attemptOrdinal: 0,
  })
  const fence = {
    key,
    runId,
    ownerIncarnation: 'owner-enum-codec',
    controllerInstanceId,
    ownerPlanGeneration,
    operationEpoch: 1,
    attemptOrdinal: 0,
  }
  const scope = expectedAttemptScope(expected)
  const workspaceBinding = {
    workspaceId: workspaceGrant.workspaceId,
    registrationRevision: workspaceGrant.registrationRevision,
    bindingGeneration: workspaceGrant.bindingGeneration,
    mountGeneration: workspaceGrant.mountGeneration,
  }
  const intent = {
    intentVersion: 1,
    scope,
    processRef,
    spawnNonce,
    workspaceBinding,
    binaryBinding: binaryPolicy,
    argvDigest: expected.binding.launchSpec.argvAuthority.argvHash,
    argvCount: 1,
    environmentPolicyDigest: computeCanonicalPolicyDigest(environmentPolicy as never),
    relayScopeDigest: computeCanonicalPolicyDigest({
      laneId: expected.binding.executionUnit.laneId,
      memberIds: expected.binding.executionUnit.memberIds,
    }),
  }
  const nonceDigest = spawnNonceDigest(spawnNonce as SpawnNonce)
  const ownership = {
    recordVersion: 1,
    processRef,
    scope,
    workspaceBinding,
    spawnNonceDigest: nonceDigest,
    controllerInstanceId,
    ownerAttestation: {
      attestationVersion: 1,
      authorityId: 'authority-enum-codec',
      bootId: expected.ownerBootId,
      processRef,
      scope,
      workspaceBinding,
      spawnNonceDigest: nonceDigest,
      channelRef: 'channel-reference-enum-codec',
      owningProcessIdentityRef: 'owning-process-identity-enum-codec',
      anchorIdentityRef: 'anchor-identity-enum-codec',
    },
    mainProcessIdentityRef: 'main-process-identity-enum-codec',
    lastStatusSequence: 1,
  }
  const identity = { ...expected, kind: 'hosted-anchor', processRef }
  const armedAttempt = {
    key,
    kind: 'native',
    phase: 'armed',
    fence,
    expected,
    uncertainEvidence: [{
      attempt: {
        version: 1,
        kind: 'uncertain-start-without-ref',
        expected,
        startResult: { status: 'unavailable' },
      },
      phase: 'start',
      adapterResult: { status: 'unavailable' },
    }],
    cleanupFailures: [{ operation: 'reconcileFailedAttempt', reason: 'cleanup failed' }],
    processOwnership: {
      stateVersion: 1,
      revision: 1,
      phase: 'unclassified_residual',
      intent,
      ownership,
      terminalReason: 'classification pending',
    },
  }
  const raw: UnknownRecord = {
    schemaVersion: 5,
    revision: 1,
    planFingerprint: 'a'.repeat(64),
    toolApprovalMode: 'auto',
    phase: 'launching',
    runId,
    recoverable: true,
    ownerIncarnation: 'owner-enum-codec',
    recoveryBindings: {},
    operationEpoch: 1,
    attempts: { [key]: armedAttempt },
    tombstones: [],
    disposition: {
      runId,
      operationEpoch: 1,
      status: 'pending',
      reason: 'fixture disposition',
    },
    legacyUnresolved: {
      schemaVersion: 4,
      runId,
      phase: 'launching',
      recoveryBindings: {},
    },
  }
  return { raw, key, expected, fence, identity, intent, ownership }
}

function validArmedState(): DurableStateV5 {
  return decodeDurableState(fixture().raw)
}

function validDrainedState(): DurableStateV5 {
  const { raw, key, expected, fence, identity, intent, ownership } = fixture()
  const terminalEvidence = {
    kind: 'exact-anchor-terminal',
    identity,
    adapterResult: { status: 'drained' },
    observedAt: '2026-09-13T00:00:00.000Z',
  }
  const completion = {
    fence,
    identity,
    operation: 'stopOwnedNativeProcess',
    result: { status: 'drained' },
  }
  const attempt = record(record(raw.attempts)[key])
  attempt.phase = 'drained'
  delete attempt.uncertainEvidence
  attempt.anchorTerminalEvidence = terminalEvidence
  attempt.cleanupSettlement = { status: 'completed', completion }
  attempt.processOwnership = {
    stateVersion: 1,
    revision: 4,
    phase: 'drained',
    intent,
    ownership,
    terminalReason: 'native process drained',
  }
  raw.tombstones = [{
    key,
    fence,
    expected,
    scope: expectedAttemptScope(expected),
    processRef,
    terminalPhase: 'drained',
    terminalEvidence,
    cleanupCompletion: completion,
  }]
  return decodeDurableState(raw)
}

function rejectsReadAndWrite(candidate: unknown): void {
  expect(() => decodeDurableState(candidate)).toThrow()
  expect(() => validateDurableStateForWrite(candidate as DurableStateV5)).toThrow()
}

function attemptOf(state: UnknownRecord, key: string): UnknownRecord {
  return record(record(state.attempts)[key])
}

function expectationCopies(state: UnknownRecord, key: string): UnknownRecord[] {
  const attempt = attemptOf(state, key)
  const evidence = record((attempt.uncertainEvidence as unknown[])[0])
  return [record(attempt.expected), record(record(evidence.attempt).expected)]
}

function setEnvironmentProvenance(expected: UnknownRecord, value: unknown): void {
  const binding = record(expected.binding)
  const unitPolicy = record(record(binding.executionUnit).environmentPolicy)
  record((unitPolicy.variables as unknown[])[0]).provenance = value
  const launchSpec = record(binding.launchSpec)
  const launchPolicy = record(record(launchSpec.environmentAuthority).policy)
  record((launchPolicy.variables as unknown[])[0]).provenance = value
}

describe('TeamLifecycleDurableState primitive enum strictness', () => {
  test('round-trips legitimate primitive enum values on both codec boundaries', () => {
    for (const state of [validArmedState(), validDrainedState()]) {
      expect(decodeDurableState(cloneJson(state))).toEqual(state)
      expect(validateDurableStateForWrite(state)).toEqual(state)
    }
  })

  test('rejects arrays, nested arrays, and non-strings for every string enum family', () => {
    const { key } = fixture()
    const cases: Array<{
      name: string
      valid: string
      state: () => DurableStateV5
      set: (state: UnknownRecord, value: unknown) => void
    }> = [
      { name: 'attempt phase', valid: 'ready', state: validArmedState,
        set: (state, value) => { attemptOf(state, key).phase = value } },
      { name: 'expectation role', valid: 'native-worker', state: validArmedState,
        set: (state, value) => {
          for (const expected of expectationCopies(state, key)) expected.role = value
        } },
      { name: 'expectation provider', valid: 'anthropic', state: validArmedState,
        set: (state, value) => {
          for (const expected of expectationCopies(state, key)) expected.provider = value
        } },
      { name: 'cleanup completion operation', valid: 'stopOwnedNativeProcess', state: validDrainedState,
        set: (state, value) => {
          const settlement = record(attemptOf(state, key).cleanupSettlement)
          record(settlement.completion).operation = value
        } },
      { name: 'cleanup failure operation', valid: 'reconcileFailedAttempt', state: validArmedState,
        set: (state, value) => {
          record((attemptOf(state, key).cleanupFailures as unknown[])[0]).operation = value
        } },
      { name: 'uncertainty kind', valid: 'uncertain-start-without-ref', state: validArmedState,
        set: (state, value) => {
          const evidence = record((attemptOf(state, key).uncertainEvidence as unknown[])[0])
          record(evidence.attempt).kind = value
        } },
      { name: 'Product phase', valid: 'unclassified_residual', state: validArmedState,
        set: (state, value) => { record(attemptOf(state, key).processOwnership).phase = value } },
      { name: 'disposition status', valid: 'pending', state: validArmedState,
        set: (state, value) => { record(state.disposition).status = value } },
      { name: 'legacy phase', valid: 'launching', state: validArmedState,
        set: (state, value) => { record(state.legacyUnresolved).phase = value } },
      { name: 'approval mode', valid: 'auto', state: validArmedState,
        set: (state, value) => { state.toolApprovalMode = value } },
      { name: 'environment provenance', valid: 'provider_static', state: validArmedState,
        set: (state, value) => {
          for (const expected of expectationCopies(state, key)) {
            setEnvironmentProvenance(expected, value)
          }
        } },
    ]

    for (const codecCase of cases) {
      for (const invalid of [[codecCase.valid], [[codecCase.valid]], 1]) {
        const state = cloneJson(codecCase.state()) as unknown as UnknownRecord
        codecCase.set(state, invalid)
        try {
          rejectsReadAndWrite(state)
        } catch (error) {
          throw new Error(`${codecCase.name} accepted ${JSON.stringify(invalid)}`, { cause: error })
        }
      }
    }

    for (const invalid of [['idle'], [['idle']], false]) {
      const idle = {
        schemaVersion: 5,
        revision: 0,
        planFingerprint: 'a'.repeat(64),
        toolApprovalMode: 'auto',
        phase: invalid,
        runId: null,
        recoverable: false,
        ownerIncarnation: null,
        recoveryBindings: {},
        operationEpoch: 0,
        attempts: {},
        tombstones: [],
        disposition: null,
        legacyUnresolved: null,
      }
      rejectsReadAndWrite(idle)
    }
  })
})
