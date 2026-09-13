import { isDeepStrictEqual } from 'node:util'
import type {
  NativeAcquisitionFailedAttempt,
  NativeAcquisitionRecorder,
  NativeAcquisitionPreparedExpectation,
  OwnedNativeProcessIdentity,
} from './NativeProcessAcquisition.js'
import {
  assertCleanupCompletionCapacity,
  assertDrainProofCapacity,
  assertDurableAttemptAdmissionBounds,
  assertDurableStateCapacity,
  assertNoEffectProofCapacity,
  cloneJson,
  createAttemptKey,
  drainEvidenceSemanticallyEqual,
  expectedAttemptScope,
  identitiesMatchEffect,
  ownedProcessRefsEqual,
  safeDurableJsonByteLength,
  TEAM_LIFECYCLE_ATTEMPT_CAPACITY,
  TEAM_LIFECYCLE_CLEANUP_FAILURE_CAPACITY,
  TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES,
  TEAM_LIFECYCLE_UNCERTAIN_EVIDENCE_CAPACITY,
  type AttemptFence,
  type DurableAttempt,
  type DurableNativeUncertainEvidence,
  type DurableStateV5,
  type NativeCleanupCompletion,
  type NativeCleanupFailure,
  type NativeCleanupOperation,
} from './TeamLifecycleDurableState.js'
import type { TeamLifecycleJournalTransactionPort } from './TeamLifecycleJournalTransactions.js'

export {
  createAttemptKey,
} from './TeamLifecycleDurableState.js'
export type {
  AStopSuccess,
  AttemptFence,
  AttemptPhase,
  DurableAttempt,
  DurableAttemptTombstone,
  DurableStateV5,
  NativeCleanupCompletion,
  NativeCleanupFailure,
  NativeCleanupOperation,
} from './TeamLifecycleDurableState.js'
export type { TeamLifecycleJournalTransactionPort } from './TeamLifecycleJournalTransactions.js'

export type RunDisposition = Readonly<{
  runId: string
  operationEpoch: number
  status: 'pending' | 'delivered' | 'retired'
  reason: string
  evidence?: unknown
}>

export type RunEvidence = Readonly<{
  runId: string
  ownerRevision: number
  operationEpoch: number
  attempts: readonly Readonly<DurableAttempt>[]
  tombstones: DurableStateV5['tombstones']
  disposition: unknown | null
  legacyUnresolved: DurableStateV5['legacyUnresolved']
}>

export interface TeamLifecycleEffectJournal {
  recorder(fence: AttemptFence): NativeAcquisitionRecorder
  finalizeNativeDrain(input: NativeCleanupCompletion): Promise<void>
  recordNativeCleanupFailure(input: Readonly<{
    fence: AttemptFence
    identity: OwnedNativeProcessIdentity
    operation: NativeCleanupOperation
    reason: string
  }>): Promise<void>
  snapshotRun(runId: string): Promise<RunEvidence>
  recordDisposition(input: RunDisposition): Promise<void>
}

export function createTeamLifecycleEffectJournal(input: {
  transactions: TeamLifecycleJournalTransactionPort
}): TeamLifecycleEffectJournal {
  if (!input.transactions) {
    throw new TypeError('Team lifecycle journal transactions are required')
  }
  const transactions = input.transactions
  return Object.freeze({
    recorder: (fence: AttemptFence) => createRecorder(transactions, freezeClone(fence)),
    finalizeNativeDrain: (completion: NativeCleanupCompletion) =>
      finalizeNativeDrain(transactions, freezeClone(completion)),
    recordNativeCleanupFailure: (
      failure: Readonly<{
        fence: AttemptFence
        identity: OwnedNativeProcessIdentity
        operation: NativeCleanupOperation
        reason: string
      }>,
    ) => recordNativeCleanupFailure(transactions, freezeClone(failure)),
    snapshotRun: async (runId: string) => transactions.read(state => freezeClone({
      runId,
      ownerRevision: state.revision,
      operationEpoch: state.operationEpoch,
      attempts: Object.values(state.attempts)
        .filter(attempt => attempt.fence.runId === runId),
      tombstones: state.tombstones
        .filter(tombstone => tombstone.fence.runId === runId),
      disposition: state.disposition,
      legacyUnresolved:
        state.legacyUnresolved?.runId === runId ? state.legacyUnresolved : null,
    })),
    recordDisposition: async (disposition: RunDisposition) =>
      transactions.update(state => {
        if (
          state.operationEpoch !== disposition.operationEpoch ||
          state.runId !== disposition.runId
        ) throw new Error('Stale team lifecycle disposition')
        return {
          state: { ...state, disposition: cloneJson(disposition) },
          value: undefined,
        }
      }),
  })
}

function createRecorder(
  transactions: TeamLifecycleJournalTransactionPort,
  fence: AttemptFence,
): NativeAcquisitionRecorder {
  return Object.freeze({
    armAttempt: async expected => transactions.update(state => {
      assertActiveFence(state, fence)
      assertExpectation(fence, expected)
      const proposed: DurableAttempt = {
        key: fence.key,
        kind: 'native',
        phase: 'armed',
        fence,
        expected: cloneJson(expected),
      }
      const existing = state.attempts[fence.key]
      if (existing) {
        if (!isDeepStrictEqual(existing, proposed)) {
          throw new Error('Conflicting native attempt arm replay')
        }
        return { state, value: undefined }
      }
      if (Object.keys(state.attempts).length >= TEAM_LIFECYCLE_ATTEMPT_CAPACITY) {
        throw new Error('Team lifecycle journal capacity unavailable')
      }
      const scope = expectedAttemptScope(expected)
      if (state.tombstones.some(item =>
        item.key === fence.key || isDeepStrictEqual(item.scope, scope))) {
        throw new Error('Native attempt scope was already terminal')
      }
      if (Object.values(state.attempts).some(item =>
        item.key !== fence.key &&
        isDeepStrictEqual(expectedAttemptScope(item.expected), scope))) {
        throw new Error('Native attempt scope is already reserved')
      }
      assertEvidenceBound(expected, 'native expectation')
      assertDurableAttemptAdmissionBounds(expected)
      const nextState = {
        ...state,
        attempts: { ...state.attempts, [fence.key]: proposed },
      }
      assertDurableStateCapacity(nextState)
      return { state: nextState, value: undefined }
    }),
    recordAcquired: async identity =>
      updateAttempt(transactions, fence, 'acquired', attempt => {
        if (!identityMatchesExpectation(identity, attempt.expected)) {
          throw new Error('Native acquired identity substitution')
        }
        assertEvidenceBound(identity, 'native acquired identity')
        return { ...attempt, identity: cloneJson(identity) }
      }, true),
    recordReady: async value =>
      updateAttempt(transactions, fence, 'ready', attempt => {
        if (
          !identityMatchesExpectation(value.identity, attempt.expected) ||
          !attempt.identity ||
          !identitiesMatchEffect(value.identity, attempt.identity)
        ) throw new Error('Native readiness identity substitution')
        if (
          value.identity.readiness === undefined ||
          !isDeepStrictEqual(value.identity.readiness, value.readinessProof) ||
          value.identity.runtimeSessionId === undefined
        ) throw new Error('Native readiness proof does not join enriched identity')
        assertEvidenceBound(value.identity, 'native ready identity')
        assertEvidenceBound(value.readinessProof, 'native readiness proof')
        return {
          ...attempt,
          identity: cloneJson(value.identity),
          readinessProof: cloneJson(value.readinessProof),
        }
      }),
    recordUncertain: async value =>
      recordUncertain(transactions, fence, value),
    recordDrained: async proof =>
      recordAnchorTerminal(transactions, fence, proof),
    recordNoEffect: async proof =>
      recordNoEffect(transactions, fence, proof),
  })
}

async function recordUncertain(
  transactions: TeamLifecycleJournalTransactionPort,
  fence: AttemptFence,
  value: Parameters<NativeAcquisitionRecorder['recordUncertain']>[0],
): Promise<void> {
  await transactions.update(state => {
    const attempt = requireAttempt(state, fence, true)
    if (attempt.phase === 'drained' || attempt.phase === 'noeffect') {
      throw new Error(`Illegal native uncertainty after ${attempt.phase}`)
    }
    if (!isDeepStrictEqual(value.attempt.expected, attempt.expected)) {
      throw new Error('Native uncertain attempt substitution')
    }
    if (
      value.attempt.processRef &&
      attempt.identity &&
      value.attempt.processRef !== attempt.identity.processRef
    ) throw new Error('Native uncertain process reference substitution')
    const evidence = sanitizeUncertainty(value)
    assertEvidenceBound(evidence, 'native uncertainty')
    const existing = attempt.uncertainEvidence ?? []
    if (existing.some(item => isDeepStrictEqual(item, evidence))) {
      return { state, value: undefined }
    }
    if (existing.length >= TEAM_LIFECYCLE_UNCERTAIN_EVIDENCE_CAPACITY) {
      throw new Error('Native uncertainty evidence capacity unavailable')
    }
    const identity = attempt.identity ?? (
      value.attempt.processRef
        ? bareIdentity(attempt.expected, value.attempt.processRef)
        : undefined
    )
    const phase = attempt.phase === 'anchor-terminal-pending'
      ? attempt.phase
      : 'uncertain'
    return {
      state: {
        ...state,
        attempts: {
          ...state.attempts,
          [fence.key]: {
            ...attempt,
            phase,
            ...(identity ? { identity } : {}),
            uncertainEvidence: [...existing, evidence],
          },
        },
      },
      value: undefined,
    }
  })
}

async function recordAnchorTerminal(
  transactions: TeamLifecycleJournalTransactionPort,
  fence: AttemptFence,
  proof: Parameters<NativeAcquisitionRecorder['recordDrained']>[0],
): Promise<void> {
  await transactions.update(state => {
    const attempt = requireAttempt(state, fence, true)
    if (![
      'armed', 'acquired', 'ready', 'uncertain', 'anchor-terminal-pending',
    ].includes(attempt.phase)) {
      throw new Error(
        `Illegal native attempt terminal transition ${attempt.phase} -> anchor-terminal-pending`,
      )
    }
    if (
      !identityMatchesExpectation(proof.identity, attempt.expected) ||
      (
        attempt.identity &&
        !identitiesMatchEffect(proof.identity, attempt.identity)
      ) ||
      !['drained', 'already_drained'].includes(proof.adapterResult.status) ||
      attempt.processOwnership?.phase !== 'drained' ||
      !ownedProcessRefsEqual(
        attempt.processOwnership.intent.processRef,
        proof.identity.processRef,
      ) ||
      !isDeepStrictEqual(
        attempt.processOwnership.intent.scope,
        expectedAttemptScope(attempt.expected),
      )
    ) throw new Error('Invalid native anchor terminal evidence')
    assertDrainProofCapacity(proof)
    if (attempt.anchorTerminalEvidence) {
      if (!drainEvidenceSemanticallyEqual(attempt.anchorTerminalEvidence, proof)) {
        throw new Error('Conflicting native anchor terminal replay')
      }
      return { state, value: undefined }
    }
    const identity = preferEnrichedIdentity(attempt.identity, proof.identity)
    return {
      state: {
        ...state,
        attempts: {
          ...state.attempts,
          [fence.key]: {
            ...attempt,
            phase: 'anchor-terminal-pending',
            identity,
            anchorTerminalEvidence: cloneJson(proof),
            cleanupSettlement: { status: 'pending' },
          },
        },
      },
      value: undefined,
    }
  })
}

async function finalizeNativeDrain(
  transactions: TeamLifecycleJournalTransactionPort,
  completion: NativeCleanupCompletion,
): Promise<void> {
  await transactions.update(state => {
    const attempt = requireAttempt(state, completion.fence, true)
    if (
      attempt.fence.controllerInstanceId !== completion.identity
        .ownerControllerInstanceId ||
      attempt.fence.ownerIncarnation !== state.ownerIncarnation
    ) throw new Error('Native cleanup completion is not from the live controller')
    if (
      !['stopOwnedNativeProcess', 'reconcileFailedAttempt'].includes(
        completion.operation,
      ) ||
      !['drained', 'already_drained'].includes(completion.result.status) ||
      !identityMatchesExpectation(completion.identity, attempt.expected)
    ) throw new Error('Invalid native cleanup completion')
    assertCleanupCompletionCapacity(completion, completion.fence)
    if (attempt.phase === 'drained') {
      const existing = attempt.cleanupSettlement?.status === 'completed'
        ? attempt.cleanupSettlement.completion
        : undefined
      if (
        !existing ||
        !completionEquivalent(existing, completion)
      ) throw new Error('Conflicting native cleanup completion replay')
      return { state, value: undefined }
    }
    if (
      attempt.phase !== 'anchor-terminal-pending' ||
      !attempt.anchorTerminalEvidence ||
      attempt.cleanupSettlement?.status !== 'pending' ||
      attempt.processOwnership?.phase !== 'drained' ||
      !ownedProcessRefsEqual(
        attempt.processOwnership.intent.processRef,
        completion.identity.processRef,
      ) ||
      !identitiesMatchEffect(
        attempt.anchorTerminalEvidence.identity,
        completion.identity,
      )
    ) throw new Error('Native drain cannot finalize before anchor terminal publication')
    const durableCompletion = cloneJson(completion)
    const tombstone = {
      key: attempt.key,
      fence: cloneJson(attempt.fence),
      expected: cloneJson(attempt.expected),
      scope: expectedAttemptScope(attempt.expected),
      processRef: completion.identity.processRef,
      terminalPhase: 'drained',
      terminalEvidence: cloneJson(attempt.anchorTerminalEvidence),
      cleanupCompletion: durableCompletion,
    } as const
    const existingTombstone = state.tombstones.find(item => item.key === attempt.key)
    if (existingTombstone && !tombstoneEquivalent(existingTombstone, tombstone)) {
      throw new Error('Conflicting native drained tombstone')
    }
    const nextAttempt: DurableAttempt = {
      ...attempt,
      phase: 'drained',
      cleanupSettlement: {
        status: 'completed',
        completion: durableCompletion,
      },
    }
    const nextState = {
      ...state,
      attempts: { ...state.attempts, [attempt.key]: nextAttempt },
      tombstones: existingTombstone
        ? state.tombstones
        : [...state.tombstones, tombstone],
    }
    assertDurableStateCapacity(nextState)
    return { state: nextState, value: undefined }
  })
}

async function recordNativeCleanupFailure(
  transactions: TeamLifecycleJournalTransactionPort,
  input: Readonly<{
    fence: AttemptFence
    identity: OwnedNativeProcessIdentity
    operation: NativeCleanupOperation
    reason: string
  }>,
): Promise<void> {
  await transactions.update(state => {
    const attempt = requireAttempt(state, input.fence, true)
    if (
      attempt.phase !== 'anchor-terminal-pending' ||
      !attempt.anchorTerminalEvidence ||
      !identitiesMatchEffect(attempt.anchorTerminalEvidence.identity, input.identity) ||
      !['stopOwnedNativeProcess', 'reconcileFailedAttempt'].includes(input.operation)
    ) throw new Error('Native cleanup failure has no matching pending terminal')
    if (
      input.reason.length === 0 ||
      Buffer.byteLength(input.reason, 'utf8') > 4096 ||
      input.reason.includes('\0')
    ) throw new Error('Invalid native cleanup failure reason')
    const failure: NativeCleanupFailure = {
      operation: input.operation,
      reason: input.reason,
    }
    const failures = attempt.cleanupFailures ?? []
    if (failures.some(item => isDeepStrictEqual(item, failure))) {
      return { state, value: undefined }
    }
    if (failures.length >= TEAM_LIFECYCLE_CLEANUP_FAILURE_CAPACITY) {
      throw new Error('Native cleanup failure evidence capacity unavailable')
    }
    return {
      state: {
        ...state,
        attempts: {
          ...state.attempts,
          [attempt.key]: {
            ...attempt,
            cleanupFailures: [...failures, cloneJson(failure)],
          },
        },
      },
      value: undefined,
    }
  })
}

async function recordNoEffect(
  transactions: TeamLifecycleJournalTransactionPort,
  fence: AttemptFence,
  proof: Parameters<NativeAcquisitionRecorder['recordNoEffect']>[0],
): Promise<void> {
  await transactions.update(state => {
    const attempt = requireAttempt(state, fence, true)
    if (!['armed', 'noeffect'].includes(attempt.phase)) {
      throw new Error(
        `Illegal native attempt terminal transition ${attempt.phase} -> noeffect`,
      )
    }
    if (
      proof.kind !== 'pre-start-failure' ||
      proof.startWasNeverCalled !== true ||
      proof.claimSettled !== true ||
      !isDeepStrictEqual(proof.expected, attempt.expected)
    ) throw new Error('Invalid native noeffect evidence')
    assertNoEffectProofCapacity(proof, attempt.expected)
    if (attempt.phase === 'noeffect') {
      if (!noEffectEquivalent(attempt.terminalEvidence, proof)) {
        throw new Error('Conflicting native noeffect replay')
      }
      return { state, value: undefined }
    }
    const tombstone = {
      key: attempt.key,
      fence: cloneJson(attempt.fence),
      expected: cloneJson(attempt.expected),
      scope: expectedAttemptScope(attempt.expected),
      terminalPhase: 'noeffect',
      terminalEvidence: cloneJson(proof),
    } as const
    const existing = state.tombstones.find(item => item.key === attempt.key)
    if (existing && !noEffectEquivalent(existing.terminalEvidence, proof)) {
      throw new Error('Conflicting native no-effect tombstone')
    }
    const nextAttempt: DurableAttempt = {
      ...attempt,
      phase: 'noeffect',
      terminalEvidence: cloneJson(proof),
    }
    const nextState: DurableStateV5 = {
      ...state,
      attempts: {
        ...state.attempts,
        [attempt.key]: nextAttempt,
      },
      tombstones: existing ? state.tombstones : [...state.tombstones, tombstone],
    }
    assertDurableStateCapacity(nextState)
    return { state: nextState, value: undefined }
  })
}

async function updateAttempt(
  transactions: TeamLifecycleJournalTransactionPort,
  fence: AttemptFence,
  phase: 'acquired' | 'ready',
  transform: (attempt: DurableAttempt) => DurableAttempt,
  allowStale = false,
): Promise<void> {
  await transactions.update(state => {
    const attempt = requireAttempt(state, fence, allowStale)
    const predecessors = phase === 'acquired'
      ? ['armed', 'acquired']
      : ['acquired', 'ready']
    if (!predecessors.includes(attempt.phase)) {
      throw new Error(`Illegal native attempt transition ${attempt.phase} -> ${phase}`)
    }
    const next = { ...transform(attempt), phase }
    if (attempt.phase === phase) {
      if (!isDeepStrictEqual(attempt, next)) {
        throw new Error(`Conflicting native ${phase} replay`)
      }
      return { state, value: undefined }
    }
    return {
      state: {
        ...state,
        attempts: { ...state.attempts, [fence.key]: next },
      },
      value: undefined,
    }
  })
}

function requireAttempt(
  state: DurableStateV5,
  fence: AttemptFence,
  allowStale: boolean,
): DurableAttempt {
  const attempt = state.attempts[fence.key]
  if (!attempt || !isDeepStrictEqual(attempt.fence, fence)) {
    throw new Error('Native attempt fence is not armed')
  }
  if (!allowStale) assertActiveFence(state, fence)
  return attempt
}

function assertActiveFence(state: DurableStateV5, fence: AttemptFence): void {
  if (
    state.runId !== fence.runId ||
    state.ownerIncarnation !== fence.ownerIncarnation ||
    state.operationEpoch !== fence.operationEpoch
  ) throw new Error('Stale team lifecycle attempt fence')
}

function assertExpectation(
  fence: AttemptFence,
  expected: NativeAcquisitionPreparedExpectation,
): void {
  if (
    expected.runId !== fence.runId ||
    expected.ownerControllerInstanceId !== fence.controllerInstanceId ||
    expected.ownerPlanGeneration !== fence.ownerPlanGeneration ||
    fence.key !== createAttemptKey({
      ownerPlanGeneration: expected.ownerPlanGeneration,
      runId: expected.runId,
      originalLaneId: expected.laneId,
      globalOrdinal: expected.memberOrdinal,
      attemptOrdinal: fence.attemptOrdinal,
    })
  ) throw new Error('Native attempt expectation does not match fence')
}

function identityMatchesExpectation(
  identity: OwnedNativeProcessIdentity,
  expected: NativeAcquisitionPreparedExpectation,
): boolean {
  const {
    kind,
    processRef,
    runtimeSessionId: _runtimeSessionId,
    readiness: _readiness,
    diagnostics: _diagnostics,
    ...actualExpectation
  } = identity
  return kind === 'hosted-anchor' &&
    typeof processRef === 'string' &&
    processRef.length > 0 &&
    isDeepStrictEqual(actualExpectation, expected)
}

function preferEnrichedIdentity(
  known: OwnedNativeProcessIdentity | undefined,
  terminalIdentity: OwnedNativeProcessIdentity,
): OwnedNativeProcessIdentity {
  if (
    known &&
    identitiesMatchEffect(known, terminalIdentity) &&
    known.readiness &&
    !terminalIdentity.readiness
  ) return cloneJson(known)
  return cloneJson(terminalIdentity)
}

function sanitizeUncertainty(
  value: Parameters<NativeAcquisitionRecorder['recordUncertain']>[0],
): DurableNativeUncertainEvidence {
  return {
    attempt: {
      version: 1,
      kind: value.attempt.kind,
      expected: cloneJson(value.attempt.expected),
      ...(value.attempt.processRef
        ? { processRef: String(value.attempt.processRef) }
        : {}),
      startResult: sanitizeAdapterResult(value.attempt.startResult),
    },
    phase: value.phase,
    adapterResult: sanitizeAdapterResult(value.adapterResult),
  }
}

function sanitizeAdapterResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (key === 'stdio') continue
    result[key] = cloneJson(item)
  }
  return result
}

function bareIdentity(
  expected: NativeAcquisitionPreparedExpectation,
  processRef: NonNullable<NativeAcquisitionFailedAttempt['processRef']>,
): OwnedNativeProcessIdentity {
  return {
    ...cloneJson(expected),
    kind: 'hosted-anchor',
    processRef,
  }
}

function completionEquivalent(
  left: NativeCleanupCompletion,
  right: NativeCleanupCompletion,
): boolean {
  return isDeepStrictEqual(left.fence, right.fence) &&
    identitiesMatchEffect(left.identity, right.identity) &&
    ['drained', 'already_drained'].includes(left.result.status) &&
    ['drained', 'already_drained'].includes(right.result.status)
}

function tombstoneEquivalent(
  left: DurableStateV5['tombstones'][number],
  right: DurableStateV5['tombstones'][number],
): boolean {
  return left.terminalPhase === 'drained' &&
    right.terminalPhase === 'drained' &&
    left.key === right.key &&
    isDeepStrictEqual(left.fence, right.fence) &&
    isDeepStrictEqual(left.expected, right.expected) &&
    isDeepStrictEqual(left.scope, right.scope) &&
    left.processRef === right.processRef &&
    drainEvidenceSemanticallyEqual(
      left.terminalEvidence as Parameters<typeof drainEvidenceSemanticallyEqual>[0],
      right.terminalEvidence as Parameters<typeof drainEvidenceSemanticallyEqual>[1],
    ) &&
    left.cleanupCompletion !== undefined &&
    right.cleanupCompletion !== undefined &&
    completionEquivalent(left.cleanupCompletion, right.cleanupCompletion)
}

function noEffectEquivalent(
  left: DurableAttempt['terminalEvidence'] | DurableStateV5['tombstones'][number]['terminalEvidence'] | undefined,
  right: Parameters<NativeAcquisitionRecorder['recordNoEffect']>[0],
): boolean {
  if (!left || left.kind !== 'pre-start-failure') return false
  return isDeepStrictEqual(left.expected, right.expected) &&
    left.startWasNeverCalled &&
    left.claimSettled &&
    right.startWasNeverCalled &&
    right.claimSettled &&
    left.reason === right.reason
}

function assertEvidenceBound(value: unknown, label: string): void {
  if (safeDurableJsonByteLength(value) > TEAM_LIFECYCLE_TERMINAL_EVIDENCE_MAX_BYTES) {
    throw new Error(`Team lifecycle ${label} exceeds bounded evidence capacity`)
  }
}

function freezeClone<T>(value: T): T {
  const result = cloneJson(value)
  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || Object.isFrozen(candidate)) return
    for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child)
    Object.freeze(candidate)
  }
  freeze(result)
  return result
}
