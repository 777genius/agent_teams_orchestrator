import { createHash } from 'node:crypto'

import type {
  HostedLifecycleProviderAdapter,
  HostedLifecycleProviderEffectResult,
  HostedLifecycleProviderInspection,
  HostedLifecycleScope,
} from '../hostedControl/HostedLifecycleProviderRegistry.js'
import type { HostedLifecycleAction, HostedLifecycleProviderSnapshot } from '../hostedControl/HostedLifecycleSnapshot.js'
import type {
  TeamLifecycleLaunchPlan,
  TeamLifecycleLaunchPlanAdmission,
  TeamLifecycleLaunchPlanStore,
} from './TeamLifecycleLaunchPlan.js'

export type TeamLifecycleOwnerState = HostedLifecycleProviderSnapshot

export type TeamLifecycleOwnerEffectInput = {
  plan: TeamLifecycleLaunchPlan
  commandId: string
  /** Required by a trusted hosted run-reservation port; desktop execution does not use it. */
  idempotencyKey?: string
  /** Stable bound generation supplied by the hosted command for reservation replay. */
  reservationExpectedProviderGeneration?: string
  runId: string | null
  expectedProviderGeneration: string
  /** Revalidated immediately before each lane adapter performs an effect. */
  effectGuard?: () => boolean | Promise<boolean>
}

/**
 * Sole effect boundary for both native providers and the OpenCode lane. Implementations must
 * durably confirm each transition before returning; no second lane owner may be composed.
 */
export interface TeamLifecycleExecutionPort {
  /**
   * Capability is resolved from the privately admitted plan, never from a hosted request.
   * Returning false keeps the corresponding public lifecycle state unavailable.
   */
  supports(plan: TeamLifecycleLaunchPlan, action: HostedLifecycleAction): boolean | Promise<boolean>
  inspect(plan: TeamLifecycleLaunchPlan): Promise<TeamLifecycleOwnerState | null>
  launch(input: TeamLifecycleOwnerEffectInput): Promise<TeamLifecycleOwnerState>
  /** Read-only replay: must never publish a new run or invoke lane effects. */
  replayLaunch?(input: TeamLifecycleOwnerEffectInput): Promise<TeamLifecycleOwnerState>
  cancel(input: TeamLifecycleOwnerEffectInput): Promise<TeamLifecycleOwnerState>
  stop(input: TeamLifecycleOwnerEffectInput): Promise<TeamLifecycleOwnerState>
  recover(input: TeamLifecycleOwnerEffectInput): Promise<TeamLifecycleOwnerState>
}

export type TeamLifecycleOwnerServiceOptions = {
  planStore: TeamLifecycleLaunchPlanStore
  execution: TeamLifecycleExecutionPort
  providerId?: string
  effectGuard?: () => boolean | Promise<boolean>
}

export type TeamLifecycleExactPlanAdmission =
  | { kind: 'admitted'; workspaceId: string; teamId: string; planGeneration: string }
  | { kind: 'not_found' | 'unavailable' }

/** A narrow hosted registry adapter; it never accepts plans from a caller or browser. */
export class TeamLifecycleOwnerService implements HostedLifecycleProviderAdapter {
  readonly providerId: string
  readonly #queues = new Map<string, Promise<void>>()

  constructor(private readonly options: TeamLifecycleOwnerServiceOptions) {
    this.providerId = options.providerId ?? 'team-lifecycle-owner'
  }

  /** Read-only owner admission for the exact plan privately published under the team root. */
  async admitLaunchPlan(input: {
    scope: HostedLifecycleScope
    workspaceRoot: string
    expectedPlanGeneration: string
  }): Promise<TeamLifecycleExactPlanAdmission> {
    return this.#serialized(input.scope, async () => {
      if (!/^plan-generation_[0-9a-f]{64}$/.test(input.expectedPlanGeneration)) {
        return { kind: 'unavailable' }
      }
      let admission: TeamLifecycleLaunchPlanAdmission | null
      try {
        admission = await this.options.planStore.load(input.scope)
      } catch {
        return { kind: 'unavailable' }
      }
      if (!admission) return { kind: 'not_found' }
      if (admission.plan.workspaceId !== input.scope.workspaceId ||
        admission.plan.teamId !== input.scope.teamId ||
        admission.plan.workspaceRoot !== input.workspaceRoot ||
        admission.planGeneration !== input.expectedPlanGeneration ||
        !(await this.#admissionCurrent(admission))) {
        return { kind: 'unavailable' }
      }
      return { kind: 'admitted', workspaceId: input.scope.workspaceId,
        teamId: input.scope.teamId, planGeneration: admission.planGeneration }
    })
  }

  async inspect(scope: HostedLifecycleScope): Promise<HostedLifecycleProviderInspection> {
    return this.#serialized(scope, async () => {
      const plan = await this.options.planStore.load(scope)
      if (!plan) return { kind: 'not_owned' }
      const observed = await this.options.execution.inspect(plan.plan)
      if (!observed || !this.#validSnapshot(observed)) return { kind: 'unavailable' }
      const snapshot = bindPlanGeneration(observed, plan.planGeneration)
      if (!(await this.#capabilityCurrent(plan.plan, snapshot)) ||
        !(await this.#admissionCurrent(plan))) {
        return { kind: 'unavailable' }
      }
      return { kind: 'owned', snapshot }
    })
  }

  async execute(input: {
    scope: HostedLifecycleScope
    action: HostedLifecycleAction
    commandId: string
    idempotencyKey?: string
    runId: string | null
    expectedProviderGeneration: string
  }): Promise<HostedLifecycleProviderEffectResult> {
    return this.#serialized(input.scope, async () => {
      const admission = await this.options.planStore.load(input.scope)
      if (!admission) return { kind: 'not_found' }
      const rawBefore = await this.options.execution.inspect(admission.plan)
      if (!rawBefore || !this.#validSnapshot(rawBefore)) return { kind: 'unavailable' }
      const before = bindPlanGeneration(rawBefore, admission.planGeneration)
      const replayLaunch = input.action === 'launch' && !!input.idempotencyKey &&
        input.expectedProviderGeneration !== before.providerGeneration &&
        (before.phase === 'launching' || before.phase === 'running') &&
        this.options.execution.replayLaunch !== undefined
      if (!replayLaunch && (input.expectedProviderGeneration !== before.providerGeneration ||
        !actionAllowed(before, input.action, input.runId))) {
        return { kind: 'unavailable' }
      }
      if (!(await this.#supportsSafeClosure(admission.plan, input.action)) ||
        !(await this.#admissionCurrent(admission))) {
        return { kind: 'unavailable' }
      }
      const effectGuard = () => this.#admissionCurrent(admission)
      if (!(await effectGuard())) return { kind: 'unavailable' }
      let rawAfter: TeamLifecycleOwnerState
      const effectInput: TeamLifecycleOwnerEffectInput = {
        plan: admission.plan,
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        reservationExpectedProviderGeneration: input.expectedProviderGeneration,
        runId: input.runId,
        expectedProviderGeneration: rawBefore.providerGeneration,
        effectGuard,
      }
      try {
        if (!(await effectGuard())) return { kind: 'unavailable' }
        rawAfter = replayLaunch
          ? await this.options.execution.replayLaunch!(effectInput)
          : await this.options.execution[input.action](effectInput)
      } catch {
        return { kind: 'unavailable' }
      }
      if (!this.#validSnapshot(rawAfter) || !(await effectGuard())) return { kind: 'unavailable' }
      const after = bindPlanGeneration(rawAfter, admission.planGeneration)
      if ((replayLaunch
        ? (after.runId !== before.runId || !after.runId ||
          (after.phase !== 'launching' && after.phase !== 'running'))
        : !this.#validTransition(before, after, input.action, input.runId)) ||
        !(await this.#capabilityCurrent(admission.plan, after))) return { kind: 'unavailable' }
      const rawConfirmed = await this.options.execution.inspect(admission.plan)
      if (!rawConfirmed || !this.#validSnapshot(rawConfirmed)) return { kind: 'unavailable' }
      const confirmed = bindPlanGeneration(rawConfirmed, admission.planGeneration)
      if ((replayLaunch
        ? (confirmed.runId !== before.runId ||
          (confirmed.phase !== 'launching' && confirmed.phase !== 'running'))
        : !this.#validConfirmation(after, confirmed, input.action, input.runId)) ||
        !(await this.#capabilityCurrent(admission.plan, confirmed)) || !(await effectGuard())) {
        return { kind: 'unavailable' }
      }
      return { kind: 'applied', snapshot: confirmed }
    })
  }

  async #admissionCurrent(admission: TeamLifecycleLaunchPlanAdmission): Promise<boolean> {
    try {
      return await admission.isCurrent() &&
        (!this.options.effectGuard || await this.options.effectGuard())
    } catch {
      return false
    }
  }

  #validSnapshot(snapshot: TeamLifecycleOwnerState): boolean {
    const activeRunRequired = snapshot.phase === 'launching' || snapshot.phase === 'running' ||
      snapshot.phase === 'stopping' || (snapshot.phase === 'failed' && snapshot.recoverable)
    return snapshot.providerId === this.providerId &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(snapshot.providerGeneration) &&
      ['idle', 'launching', 'running', 'stopping', 'failed'].includes(snapshot.phase) &&
      typeof snapshot.recoverable === 'boolean' &&
      (activeRunRequired ? snapshot.runId !== null : true) &&
      (snapshot.phase === 'idle' ? snapshot.runId === null : true)
  }

  #validTransition(
    before: TeamLifecycleOwnerState,
    after: TeamLifecycleOwnerState,
    action: HostedLifecycleAction,
    requestedRunId: string | null,
  ): boolean {
    if (!this.#validSnapshot(after) || before.providerGeneration === after.providerGeneration) return false
    if (action !== 'launch' && before.runId !== requestedRunId) return false
    if (action === 'launch') return after.runId !== null && (after.phase === 'launching' || after.phase === 'running')
    if (action === 'cancel') return after.phase === 'idle' && after.runId === null
    if (action === 'stop') return (after.phase === 'stopping' && after.runId === requestedRunId) || (after.phase === 'idle' && after.runId === null)
    return after.phase === 'idle' || after.phase === 'launching' || after.phase === 'running'
  }

  #validConfirmation(
    after: TeamLifecycleOwnerState,
    confirmed: TeamLifecycleOwnerState,
    action: HostedLifecycleAction,
    requestedRunId: string | null,
  ): boolean {
    if (sameSnapshot(after, confirmed)) return true
    if (after.providerId !== confirmed.providerId ||
      after.providerGeneration === confirmed.providerGeneration) return false
    if ((action === 'launch' || action === 'recover') && after.phase === 'launching') {
      return after.runId !== null && confirmed.runId === after.runId &&
        (confirmed.phase === 'running' || (confirmed.phase === 'failed' && confirmed.recoverable))
    }
    if (action === 'stop' && after.phase === 'stopping') {
      return after.runId === requestedRunId &&
        ((confirmed.phase === 'idle' && confirmed.runId === null) ||
          (confirmed.phase === 'failed' && confirmed.recoverable && confirmed.runId === after.runId))
    }
    return false
  }

  async #capabilityCurrent(plan: TeamLifecycleLaunchPlan, snapshot: TeamLifecycleOwnerState): Promise<boolean> {
    const action = exposedAction(snapshot)
    return action === null || await this.#supportsSafeClosure(plan, action)
  }

  async #supportsSafeClosure(plan: TeamLifecycleLaunchPlan, action: HostedLifecycleAction): Promise<boolean> {
    // Each action includes every capability its valid immediate or asynchronous successor can expose.
    const required: readonly HostedLifecycleAction[] = action === 'launch' || action === 'recover'
      ? ['launch', 'cancel', 'stop', 'recover']
      : action === 'cancel'
        ? ['cancel', 'launch']
        : ['stop', 'launch', 'recover']
    const supported = await Promise.all(required.map(candidate => this.options.execution.supports(plan, candidate)))
    return supported.every(Boolean)
  }

  async #serialized<T>(scope: HostedLifecycleScope, operation: () => Promise<T>): Promise<T> {
    const key = `${scope.workspaceId}\0${scope.teamId}`
    const prior = this.#queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = prior.then(() => current)
    this.#queues.set(key, tail)
    await prior
    try { return await operation() } finally {
      release()
      if (this.#queues.get(key) === tail) this.#queues.delete(key)
    }
  }
}

function bindPlanGeneration(
  snapshot: TeamLifecycleOwnerState,
  planGeneration: string,
): TeamLifecycleOwnerState {
  if (!/^plan-generation_[0-9a-f]{64}$/.test(planGeneration)) {
    throw new TypeError('Invalid team lifecycle plan generation')
  }
  const providerGeneration = `generation_${createHash('sha256').update(JSON.stringify({
    domain: 'team-lifecycle-owner-generation/v1',
    planGeneration,
    runtimeProviderGeneration: snapshot.providerGeneration,
  })).digest('hex')}`
  return { ...snapshot, providerGeneration }
}

function exposedAction(snapshot: TeamLifecycleOwnerState): HostedLifecycleAction | null {
  if (snapshot.phase === 'idle') return 'launch'
  if (snapshot.phase === 'launching') return 'cancel'
  if (snapshot.phase === 'running') return 'stop'
  if (snapshot.phase === 'failed' && snapshot.recoverable) return 'recover'
  return null
}

function actionAllowed(snapshot: TeamLifecycleOwnerState, action: HostedLifecycleAction, runId: string | null): boolean {
  if (action !== 'launch' && snapshot.runId !== runId) return false
  if (action === 'launch') return snapshot.phase === 'idle'
  if (action === 'cancel') return snapshot.phase === 'launching'
  if (action === 'stop') return snapshot.phase === 'running'
  return snapshot.phase === 'failed' && snapshot.recoverable
}

function sameSnapshot(left: TeamLifecycleOwnerState, right: TeamLifecycleOwnerState): boolean {
  return left.providerId === right.providerId && left.providerGeneration === right.providerGeneration &&
    left.phase === right.phase && left.runId === right.runId && left.recoverable === right.recoverable
}
