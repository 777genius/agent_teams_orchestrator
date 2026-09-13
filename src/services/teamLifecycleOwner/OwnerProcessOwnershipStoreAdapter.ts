import { isDeepStrictEqual } from 'node:util'
import type {
  OwnedProcessRef,
  ProcessControllerInstanceId,
  ProcessOwnerBinding,
  ProcessOwnershipCompareAndSwapRequest,
  ProcessOwnershipCompareAndSwapResult,
  ProcessOwnershipLoadResult,
  ProcessOwnershipRecord,
  ProcessOwnershipScope,
  ProcessOwnershipState,
  ProcessOwnershipStoreContext,
  ProcessOwnershipStorePort,
} from '@agent-teams/owner-anchor-library'
import {
  computeCanonicalPolicyDigest,
  initializeProcessOwnershipState,
  isExactProcessOwnershipScope,
  spawnNonceDigest,
} from '@agent-teams/owner-anchor-library'
import { cloneJson, type DurableAttempt, type DurableStateV5 } from './TeamLifecycleDurableState.js'
import type { TeamLifecycleJournalTransactionPort } from './TeamLifecycleJournalTransactions.js'

export function createOwnerProcessOwnershipStoreAdapter(input: {
  transactions: TeamLifecycleJournalTransactionPort
  ownerBinding: ProcessOwnerBinding
  controllerInstanceId: ProcessControllerInstanceId
}): ProcessOwnershipStorePort {
  if (!input.transactions || !input.ownerBinding || !input.controllerInstanceId) {
    throw new TypeError('Owner process ownership store requires transactions and exact owner identity')
  }
  const ownerBinding = cloneJson(input.ownerBinding)
  const controllerInstanceId = input.controllerInstanceId
  const adapter: ProcessOwnershipStorePort = {
    load: (scope: ProcessOwnershipScope, context: ProcessOwnershipStoreContext) => load(input.transactions, context, ownerBinding, controllerInstanceId, state => {
      if (state.tombstones.some(item => isExactProcessOwnershipScope(item.scope, scope))) throw new Error('Ownership scope is tombstoned')
      return matchingScope(state, scope)
    }),
    loadByProcessRef: (processRef: OwnedProcessRef, context: ProcessOwnershipStoreContext) => load(input.transactions, context, ownerBinding, controllerInstanceId, state => {
      if (state.tombstones.some(item => item.processRef === processRef)) throw new Error('Ownership reference is tombstoned')
      return matchingRef(state, processRef)
    }),
    compareAndSwap: (request: ProcessOwnershipCompareAndSwapRequest) =>
      compareAndSwap(input.transactions, ownerBinding, controllerInstanceId, request),
  }
  return Object.freeze(adapter)
}

async function load(
  transactions: TeamLifecycleJournalTransactionPort,
  context: ProcessOwnershipStoreContext,
  ownerBinding: ProcessOwnerBinding,
  controllerInstanceId: ProcessControllerInstanceId,
  select: (state: DurableStateV5) => DurableAttempt[],
): Promise<ProcessOwnershipLoadResult> {
  try {
    return await transactions.read(state => {
      const found = select(state)
      if (found.length > 1) return unavailableLoad()
      const attempt = found[0]
      if (attempt && !storeOwnsAttempt(attempt, ownerBinding, controllerInstanceId)) return unavailableLoad()
      const ownership = attempt?.processOwnership
      return ownership ? { status: 'found', state: immutableSnapshot(ownership) } : { status: 'missing' }
    }, context)
  } catch {
    return { status: 'unavailable' }
  }
}

function storeOwnsAttempt(
  attempt: DurableAttempt,
  ownerBinding: ProcessOwnerBinding,
  controllerInstanceId: ProcessControllerInstanceId,
): boolean {
  if (
    attempt.fence.controllerInstanceId !== controllerInstanceId ||
    attempt.expected.ownerControllerInstanceId !== controllerInstanceId ||
    attempt.expected.ownerBootId !== ownerBinding.bootId
  ) return false
  const ownership = attempt.processOwnership && 'ownership' in attempt.processOwnership
    ? attempt.processOwnership.ownership
    : undefined
  return !ownership || (
    ownership.controllerInstanceId === controllerInstanceId &&
    ownership.ownerAttestation.authorityId === ownerBinding.authorityId &&
    ownership.ownerAttestation.bootId === ownerBinding.bootId
  )
}

async function compareAndSwap(
  transactions: TeamLifecycleJournalTransactionPort,
  ownerBinding: ProcessOwnerBinding,
  controllerInstanceId: ProcessControllerInstanceId,
  request: ProcessOwnershipCompareAndSwapRequest,
): Promise<ProcessOwnershipCompareAndSwapResult> {
  try {
    return await transactions.update<ProcessOwnershipCompareAndSwapResult>(state => {
      const matches = matchingScope(state, request.scope)
      if (matches.length !== 1) return { state, value: unavailableCas() }
      const attempt = matches[0]
      if (!attempt) return { state, value: unavailableCas() }
      const current = attempt.processOwnership
      if (request.expectedRevision === null) {
        if (current || attempt.phase !== 'armed' || state.tombstones.some(item =>
          isExactProcessOwnershipScope(item.scope, request.scope) || item.processRef === request.next.intent.processRef)) {
          return { state, value: conflict() }
        }
        if (
          !isDeepStrictEqual(request.next, initializeProcessOwnershipState(request.next.intent)) ||
          !isCurrentAdmission(state, attempt, ownerBinding, controllerInstanceId)
        ) {
          return { state, value: unavailableCas() }
        }
      } else if (!current || current.revision !== request.expectedRevision) {
        return { state, value: conflict() }
      } else if (request.next.revision !== current.revision + 1 || !isDeepStrictEqual(request.next.intent, current.intent)) {
        return { state, value: unavailableCas() }
      } else if (
        !isCurrentAdmission(state, attempt, ownerBinding, controllerInstanceId) &&
        !isExactExistingEffectCleanup(current, request.next, attempt, ownerBinding, controllerInstanceId)
      ) {
        return { state, value: unavailableCas() }
      }
      if (!validNext(request.scope, request.next, current, attempt, ownerBinding, controllerInstanceId)) {
        return { state, value: unavailableCas() }
      }
      const refs = matchingRef(state, request.next.intent.processRef).filter(candidate => candidate.key !== attempt.key)
      if (refs.length > 0 || state.tombstones.some(item => item.processRef === request.next.intent.processRef)) {
        return { state, value: unavailableCas() }
      }
      const next = immutableSnapshot(request.next)
      return {
        state: { ...state, attempts: { ...state.attempts, [attempt.key]: { ...attempt, processOwnership: next } } },
        value: applied(next),
      }
    }, request.context)
  } catch {
    // A persistence error after replacement is ambiguous; never report applied or roll back.
    return { status: 'unavailable' }
  }
}

function matchingScope(state: DurableStateV5, scope: ProcessOwnershipScope): DurableAttempt[] {
  return Object.values(state.attempts).filter(attempt => isExactProcessOwnershipScope(attemptScope(attempt), scope))
}

function matchingRef(state: DurableStateV5, processRef: OwnedProcessRef): DurableAttempt[] {
  return Object.values(state.attempts).filter(attempt => attempt.processOwnership?.intent.processRef === processRef)
}

function attemptScope(attempt: DurableAttempt): ProcessOwnershipScope {
  return {
    planRef: attempt.expected.binding.launchSpec.planRef,
    executionUnitId: attempt.expected.binding.executionUnit.executionUnitId,
  }
}

function validNext(
  scope: ProcessOwnershipScope,
  next: ProcessOwnershipState,
  current: ProcessOwnershipState | undefined,
  attempt: DurableAttempt,
  ownerBinding: ProcessOwnerBinding,
  controllerInstanceId: ProcessControllerInstanceId,
): boolean {
  if (next.stateVersion !== 1 || !isExactProcessOwnershipScope(next.intent.scope, scope) ||
    !isExactProcessOwnershipScope(scope, attemptScope(attempt)) ||
    next.intent.argvDigest !== attempt.expected.binding.launchSpec.argvAuthority.argvHash ||
    next.intent.argvCount !== attempt.expected.binding.launchSpec.argvAuthority.argv.length ||
    next.intent.environmentPolicyDigest !== computeCanonicalPolicyDigest(attempt.expected.binding.executionUnit.environmentPolicy) ||
    next.intent.relayScopeDigest !== computeCanonicalPolicyDigest({
      laneId: attempt.expected.binding.executionUnit.laneId,
      memberIds: attempt.expected.binding.executionUnit.memberIds,
    }) ||
    !isDeepStrictEqual(next.intent.binaryBinding, attempt.expected.binding.launchSpec.argvAuthority.binaryPolicy) ||
    !isDeepStrictEqual(next.intent.workspaceBinding, workspaceBinding(attempt))) return false
  const ownership = 'ownership' in next ? next.ownership : undefined
  if (!ownership) return !current || !('ownership' in current)
  if (!(ownership.processRef === next.intent.processRef && isExactProcessOwnershipScope(ownership.scope, scope) &&
    ownership.spawnNonceDigest === spawnNonceDigest(next.intent.spawnNonce) &&
    ownership.controllerInstanceId === controllerInstanceId && ownership.ownerAttestation.authorityId === ownerBinding.authorityId &&
    ownership.ownerAttestation.bootId === ownerBinding.bootId && ownership.ownerAttestation.processRef === next.intent.processRef &&
    isExactProcessOwnershipScope(ownership.ownerAttestation.scope, scope) &&
    isDeepStrictEqual(ownership.workspaceBinding, next.intent.workspaceBinding) &&
    isDeepStrictEqual(ownership.ownerAttestation.workspaceBinding, ownership.workspaceBinding) &&
    ownership.ownerAttestation.spawnNonceDigest === ownership.spawnNonceDigest)) return false
  const priorOwnership = current && 'ownership' in current ? current.ownership : undefined
  return priorOwnership
    ? immutableOwnershipMatches(priorOwnership, ownership) &&
      ownership.lastStatusSequence >= priorOwnership.lastStatusSequence
    : ownership.lastStatusSequence === 1
}

function isCurrentAdmission(
  state: DurableStateV5,
  attempt: DurableAttempt,
  ownerBinding: ProcessOwnerBinding,
  controllerInstanceId: ProcessControllerInstanceId,
): boolean {
  return state.runId === attempt.fence.runId &&
    state.ownerIncarnation === attempt.fence.ownerIncarnation &&
    state.operationEpoch === attempt.fence.operationEpoch &&
    attempt.fence.controllerInstanceId === controllerInstanceId &&
    attempt.expected.ownerControllerInstanceId === controllerInstanceId &&
    attempt.expected.ownerBootId === ownerBinding.bootId &&
    attempt.expected.ownerPlanGeneration === attempt.fence.ownerPlanGeneration
}

function isExactExistingEffectCleanup(
  current: ProcessOwnershipState,
  next: ProcessOwnershipState,
  attempt: DurableAttempt,
  ownerBinding: ProcessOwnerBinding,
  controllerInstanceId: ProcessControllerInstanceId,
): boolean {
  if (
    attempt.fence.controllerInstanceId !== controllerInstanceId ||
    attempt.expected.ownerControllerInstanceId !== controllerInstanceId ||
    attempt.expected.ownerBootId !== ownerBinding.bootId
  ) return false
  if (!['stopping', 'drained', 'unclassified_residual'].includes(next.phase)) return false
  const currentOwnership = 'ownership' in current ? current.ownership : undefined
  const nextOwnership = 'ownership' in next ? next.ownership : undefined
  if (!currentOwnership) return next.phase === 'unclassified_residual' && !nextOwnership
  return Boolean(nextOwnership && immutableOwnershipMatches(currentOwnership, nextOwnership))
}

function immutableOwnershipMatches(
  current: ProcessOwnershipRecord,
  next: ProcessOwnershipRecord,
): boolean {
  return current.recordVersion === next.recordVersion &&
    current.processRef === next.processRef &&
    isDeepStrictEqual(current.scope, next.scope) &&
    isDeepStrictEqual(current.workspaceBinding, next.workspaceBinding) &&
    current.spawnNonceDigest === next.spawnNonceDigest &&
    current.controllerInstanceId === next.controllerInstanceId &&
    current.mainProcessIdentityRef === next.mainProcessIdentityRef &&
    isDeepStrictEqual(current.ownerAttestation, next.ownerAttestation)
}

function workspaceBinding(attempt: DurableAttempt): ProcessOwnershipState['intent']['workspaceBinding'] {
  const grant = attempt.expected.binding.launchSpec.workdirAuthority.grant
  return {
    workspaceId: grant.workspaceId,
    registrationRevision: grant.registrationRevision,
    bindingGeneration: grant.bindingGeneration,
    mountGeneration: grant.mountGeneration,
  }
}

function immutableSnapshot<T>(value: T): T {
  const result = cloneJson(value)
  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || Object.isFrozen(candidate)) return
    for (const key of Reflect.ownKeys(candidate)) freeze(Reflect.get(candidate, key))
    Object.freeze(candidate)
  }
  freeze(result)
  return result
}

function unavailableLoad(): ProcessOwnershipLoadResult { return { status: 'unavailable' } }
function unavailableCas(): ProcessOwnershipCompareAndSwapResult { return { status: 'unavailable' } }
function conflict(): ProcessOwnershipCompareAndSwapResult { return { status: 'conflict' } }
function applied(state: ProcessOwnershipState): ProcessOwnershipCompareAndSwapResult {
  return { status: 'applied', state: immutableSnapshot(state) }
}
