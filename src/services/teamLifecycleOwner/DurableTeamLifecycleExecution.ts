import { createHash, randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { HostedLifecycleAction, HostedLifecycleProviderSnapshot } from '../hostedControl/HostedLifecycleSnapshot.js'
import type { TeamLifecycleLaunchPlan } from './TeamLifecycleLaunchPlan.js'
import type {
  TeamLifecycleExecutionPort,
  TeamLifecycleOwnerEffectInput,
} from './TeamLifecycleOwnerService.js'
import type {
  TeamLifecycleLaneEffectPort,
  TeamLifecycleLaneInput,
  TeamLifecycleLaneObservation,
} from './OpenCodeTeamLifecycleLane.js'
import { createTeamLifecycleEffectJournal, type TeamLifecycleEffectJournal } from './TeamLifecycleEffectJournal.js'
import {
  assertIdleCustody,
  createInitialDurableState,
  stringifyDurableState,
  type DurableStateV5 as DurableState,
} from './TeamLifecycleDurableState.js'
import { TeamLifecycleJournalTransactions } from './TeamLifecycleJournalTransactions.js'

type LaneInput = TeamLifecycleLaneInput & { runId: string }

type EffectGuard = NonNullable<TeamLifecycleOwnerEffectInput['effectGuard']>
const EFFECT_ALLOWED: EffectGuard = () => true

/**
 * Provider-independent sole lifecycle owner. It durably records intent before effects and
 * confirms every terminal transition through the lane adapters before publishing it.
 */
export class DurableTeamLifecycleExecution implements TeamLifecycleExecutionPort {
  readonly #adapters: ReadonlyMap<TeamLifecycleLaunchPlan['lanes'][number]['kind'], TeamLifecycleLaneEffectPort>
  readonly #jobs = new Map<string, Promise<void>>()
  readonly #ownedRuns = new Map<string, TeamLifecycleLaunchPlan>()
  readonly #ownerIncarnation = `owner_${randomUUID().replaceAll('-', '')}`
  readonly #initializationMarkerPath: string
  readonly #effectTimeoutMs: number
  readonly #compensationTimeoutMs: number
  readonly transactions: TeamLifecycleJournalTransactions
  readonly journal: TeamLifecycleEffectJournal
  #acceptingEffects = true
  #closePromise: Promise<void> | null = null
  #shutdownPromise: Promise<void> | null = null
  #operationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly statePath: string,
    adapters: readonly TeamLifecycleLaneEffectPort[],
    private readonly providerId = 'team-lifecycle-owner',
    timeouts: { effectTimeoutMs?: number; compensationTimeoutMs?: number } = {},
    infrastructure: { transactions?: TeamLifecycleJournalTransactions } = {},
  ) {
    if (!isAbsolute(statePath) || statePath.includes('\0')) {
      throw new TypeError('Team lifecycle state path must be absolute')
    }
    this.#initializationMarkerPath = `${statePath}.initialized`
    if (infrastructure.transactions && infrastructure.transactions.statePath !== statePath) {
      throw new TypeError('Team lifecycle transaction path does not match executor state path')
    }
    this.transactions = infrastructure.transactions ?? new TeamLifecycleJournalTransactions(statePath)
    this.journal = createTeamLifecycleEffectJournal({ transactions: this.transactions })
    this.#effectTimeoutMs = positiveTimeout(timeouts.effectTimeoutMs ?? 300_000, 'effect')
    this.#compensationTimeoutMs = positiveTimeout(timeouts.compensationTimeoutMs ?? 10_000, 'compensation')
    const entries = adapters.map(adapter => [adapter.kind, adapter] as const)
    if (new Set(entries.map(([kind]) => kind)).size !== entries.length) {
      throw new TypeError('Duplicate team lifecycle lane adapter')
    }
    this.#adapters = new Map(entries)
  }

  supports(plan: TeamLifecycleLaunchPlan, action: HostedLifecycleAction): boolean {
    return this.#acceptingEffects &&
      plan.lanes.every(lane => this.#adapters.get(lane.kind)?.supports(action) === true)
  }

  inspect(plan: TeamLifecycleLaunchPlan): Promise<HostedLifecycleProviderSnapshot> {
    return this.#serialized(async () => {
      let state = await this.#read(plan)
      if (state.phase === 'launching' && state.runId && !this.#jobs.has(state.runId)) {
        if (state.ownerIncarnation !== this.#ownerIncarnation) {
          throw new Error('Team lifecycle run is owned by another incarnation')
        } else {
          state = await this.#reconcileLaunching(plan, state)
        }
      } else if (state.phase === 'stopping' && state.runId && !this.#jobs.has(state.runId)) {
        if (state.ownerIncarnation !== this.#ownerIncarnation) {
          throw new Error('Team lifecycle run is owned by another incarnation')
        }
        // Stop completion is only authoritative while its local job is still owned.
        state = await this.#write({ ...state, phase: 'failed', recoverable: true }, plan)
      } else if (state.phase === 'running' && state.runId) {
        if (state.ownerIncarnation !== this.#ownerIncarnation) {
          throw new Error('Team lifecycle run is owned by another incarnation')
        } else {
          const observations = await this.#inspectLanes(plan, state.runId, state.recoveryBindings)
          const observed = state
          state = await this.#read(plan)
          if (state.runId !== observed.runId || state.ownerIncarnation !== observed.ownerIncarnation ||
            state.operationEpoch !== observed.operationEpoch) throw new Error('Team lifecycle inspection publication is stale')
          if (observations.some(observation => observation.phase === 'failed' || observation.phase === 'idle')) {
            state = await this.#write({ ...state, phase: 'failed', recoverable: true }, plan)
          }
        }
      }
      return snapshot(this.providerId, state)
    })
  }

  /**
   * Establishes ownership of any durable provider run before production ports
   * become reachable. A missing plan is safe only when no execution state has
   * ever been published; active or ambiguous crash state is either adopted or
   * synchronously driven through exact teardown before startup fails closed.
   */
  recoverAtStartup(
    plan: TeamLifecycleLaunchPlan | null,
    effectGuard: EffectGuard,
  ): Promise<void> {
    return this.#serialized(async () => {
      this.#assertAcceptingEffects()
      if (!plan) {
        const stateExists = await lstat(this.statePath).then(() => true).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        })
        const markerExists = await lstat(this.#initializationMarkerPath).then(() => true).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        })
        if (stateExists || markerExists) throw new Error('Team lifecycle durable state has no admitted startup plan')
        return
      }

      if (!(await effectGuard())) throw new Error('Team lifecycle startup authority is not current')
      const state = await this.#read(plan)
      if (!(await effectGuard())) throw new Error('Team lifecycle startup authority changed')
      if (state.phase === 'idle') return

      if (state.ownerIncarnation !== this.#ownerIncarnation &&
        (plan.lanes.some(lane => lane.kind === 'native') || Object.keys(state.attempts).length > 0)) {
        await this.#rejectNativeControllerReplacement(plan, state)
      }

      if (state.phase === 'running' && state.runId) {
        await this.#adoptRecoveredRunning(plan, { ...state, runId: state.runId }, effectGuard)
        return
      }

      if (!state.runId) throw new Error('Team lifecycle startup state is ambiguous')
      await this.#failRecoveredState(
        plan,
        { ...state, runId: state.runId },
        new Error(`Team lifecycle startup found interrupted ${state.phase} state`),
        effectGuard,
      )
    })
  }

  launch(input: TeamLifecycleOwnerEffectInput): Promise<HostedLifecycleProviderSnapshot> {
    return this.#serialized(async () => {
      this.#assertAcceptingEffects()
      this.#assertSupported(input.plan, 'launch')
      const before = await this.#read(input.plan)
      this.#assertGeneration(before, input.expectedProviderGeneration)
      if (before.phase !== 'idle') throw new Error('Team lifecycle owner is not idle')
      const runId = `run_${randomUUID().replaceAll('-', '')}`
      const launching = await this.#write({
        ...before, phase: 'launching', runId, recoverable: false,
        ownerIncarnation: this.#ownerIncarnation,
        recoveryBindings: {},
        operationEpoch: before.operationEpoch + 1,
      }, input.plan)
      this.#ownedRuns.set(runId, input.plan)
      this.#trackJob(runId, this.#completeLaunch(input.plan, runId, launching.operationEpoch, input.effectGuard ?? EFFECT_ALLOWED))
      return snapshot(this.providerId, launching)
    })
  }

  cancel(input: TeamLifecycleOwnerEffectInput): Promise<HostedLifecycleProviderSnapshot> {
    return this.#terminalAction(input, 'cancel')
  }

  stop(input: TeamLifecycleOwnerEffectInput): Promise<HostedLifecycleProviderSnapshot> {
    return this.#serialized(async () => {
      this.#assertAcceptingEffects()
      this.#assertSupported(input.plan, 'stop')
      const before = await this.#read(input.plan)
      this.#assertGeneration(before, input.expectedProviderGeneration)
      if (before.phase !== 'running' || before.runId !== input.runId ||
        before.ownerIncarnation !== this.#ownerIncarnation) throw new Error('Team lifecycle run is stale')
      const runId = before.runId
      const stopping = await this.#write({ ...before, phase: 'stopping', recoverable: false,
        operationEpoch: before.operationEpoch + 1 }, input.plan)
      this.#trackJob(runId, this.#completeStop(input.plan, runId, stopping.operationEpoch, input.effectGuard ?? EFFECT_ALLOWED))
      return snapshot(this.providerId, stopping)
    })
  }

  recover(input: TeamLifecycleOwnerEffectInput): Promise<HostedLifecycleProviderSnapshot> {
    return this.#terminalAction(input, 'recover')
  }

  async #terminalAction(
    input: TeamLifecycleOwnerEffectInput,
    action: 'cancel' | 'recover',
  ): Promise<HostedLifecycleProviderSnapshot> {
    return this.#serialized(async () => {
      this.#assertAcceptingEffects()
      this.#assertSupported(input.plan, action)
      const before = await this.#read(input.plan)
      this.#assertGeneration(before, input.expectedProviderGeneration)
      const expectedPhase = action === 'cancel' ? 'launching' : 'failed'
      if (before.phase !== expectedPhase || !before.runId || before.runId !== input.runId ||
        before.ownerIncarnation !== this.#ownerIncarnation) {
        throw new Error('Team lifecycle run is stale')
      }
      const reserved = await this.#write({ ...before, operationEpoch: before.operationEpoch + 1 }, input.plan)
      const observations = await this.#applyLanes(
        input.plan,
        before.runId,
        action,
        input.effectGuard ?? EFFECT_ALLOWED,
      )
      if (!observations.every(observation => observation.phase === 'idle')) {
        throw new Error(`Team lifecycle ${action} was not confirmed`)
      }
      const current = await this.#read(input.plan)
      if (current.runId !== before.runId || current.ownerIncarnation !== this.#ownerIncarnation ||
        current.operationEpoch !== reserved.operationEpoch) throw new Error('Team lifecycle terminal publication is stale')
      const idleState = await this.#write({
        ...current, phase: 'idle', runId: null, recoverable: false, ownerIncarnation: null,
        recoveryBindings: {},
      }, input.plan)
      this.#ownedRuns.delete(before.runId)
      return snapshot(this.providerId, idleState)
    })
  }

  /** Stops new lifecycle effects and drains every fire-and-forget transition owned by this process. */
  close(): Promise<void> {
    this.#closePromise ??= this.#close()
    return this.#closePromise
  }

  async #close(): Promise<void> {
    this.#acceptingEffects = false
    // Cross the serialization barrier so a launch already admitted has registered its job.
    await this.#serialized(async () => {})
    while (this.#jobs.size > 0) {
      await Promise.all([...this.#jobs.values()])
    }
  }

  /** Drains admitted work, then compensates every exact run owned by this process. */
  shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#shutdown()
    return this.#shutdownPromise
  }

  async #shutdown(): Promise<void> {
    await this.close()
    // Runtime authority loss is a teardown boundary, not a new commanded
    // effect. Stop only runs durably owned by this process, using their exact
    // plan/run tuple, before allowing the hosted runtime to finish closing.
    for (const [ownedRunId, plan] of [...this.#ownedRuns]) {
      await this.#serialized(async () => {
        const current = await this.#read(plan)
        if (current.phase === 'idle' || current.runId !== ownedRunId ||
          current.ownerIncarnation !== this.#ownerIncarnation) {
          this.#ownedRuns.delete(ownedRunId)
          return
        }
        let stopped = false
        try {
          stopped = (await this.#applyLanesForTeardown(plan, current.runId))
            .every(observation => observation.phase === 'idle')
        } catch {}
        const publish = await this.#read(plan)
        if (publish.runId !== current.runId || publish.ownerIncarnation !== current.ownerIncarnation ||
          publish.operationEpoch !== current.operationEpoch) return
        await this.#write({
          ...publish,
          phase: stopped ? 'idle' : 'failed',
          runId: stopped ? null : current.runId,
          recoverable: !stopped,
          ownerIncarnation: stopped ? null : this.#ownerIncarnation,
          recoveryBindings: stopped ? {} : current.recoveryBindings,
        }, plan)
        if (stopped) this.#ownedRuns.delete(current.runId)
      })
    }
  }

  async #completeLaunch(plan: TeamLifecycleLaunchPlan, runId: string, operationEpoch: number, effectGuard: EffectGuard): Promise<void> {
    let observations: TeamLifecycleLaneObservation[]
    try {
      observations = await this.#applyLanes(plan, runId, 'launch', effectGuard)
    } catch {
      observations = [{ phase: 'failed', recoverable: true }]
    }
    await this.#serialized(async () => {
      const current = await this.#read(plan)
      if (current.ownerIncarnation !== this.#ownerIncarnation || current.operationEpoch !== operationEpoch) {
        return this.#trackStaleTeardown(plan, runId)
      }
      if (current.runId === runId && current.phase === 'running') return
      if (current.runId !== runId || current.phase !== 'launching') {
        return this.#trackStaleTeardown(plan, runId)
      }
      const next = launchCompletion(observations)
      if (next.phase === 'launching') {
        if (observationsHaveRecoveryBindings(plan, observations)) {
          await this.#write({
            ...current,
            recoveryBindings: launchRecoveryBindings(plan, observations),
          }, plan)
        }
        return
      }
      await this.#write({
        ...current,
        phase: next.phase,
        recoverable: next.recoverable,
        recoveryBindings: next.phase === 'running'
          ? launchRecoveryBindings(plan, observations)
          : {},
      }, plan)
    })
  }

  async #completeStop(plan: TeamLifecycleLaunchPlan, runId: string, operationEpoch: number, effectGuard: EffectGuard): Promise<void> {
    let stopped = false
    try {
      stopped = (await this.#applyLanes(plan, runId, 'stop', effectGuard))
        .every(observation => observation.phase === 'idle')
    } catch {}
    await this.#serialized(async () => {
      const current = await this.#read(plan)
      if (current.runId !== runId || current.phase !== 'stopping' ||
        current.ownerIncarnation !== this.#ownerIncarnation || current.operationEpoch !== operationEpoch) return
      await this.#write({
        ...current,
        phase: stopped ? 'idle' : 'failed',
        runId: stopped ? null : runId,
        recoverable: !stopped,
        ownerIncarnation: stopped ? null : this.#ownerIncarnation,
        recoveryBindings: stopped ? {} : current.recoveryBindings,
      }, plan)
      if (stopped) this.#ownedRuns.delete(runId)
    })
  }

  async #reconcileLaunching(plan: TeamLifecycleLaunchPlan, state: DurableState): Promise<DurableState> {
    let observations: TeamLifecycleLaneObservation[]
    try {
      observations = await this.#inspectLanes(plan, state.runId!, state.recoveryBindings)
    } catch {
      observations = [{ phase: 'failed', recoverable: true }]
    }
    const current = await this.#read(plan)
    if (current.runId !== state.runId || current.ownerIncarnation !== state.ownerIncarnation ||
      current.operationEpoch !== state.operationEpoch || current.phase !== 'launching') return current
    const next = launchCompletion(observations)
    if (next.phase === 'launching') {
      return observationsHaveRecoveryBindings(plan, observations)
        ? this.#write({ ...current, recoveryBindings: launchRecoveryBindings(plan, observations) }, plan)
        : current
    }
    return this.#write({
      ...current,
      phase: next.phase,
      recoverable: next.recoverable,
      recoveryBindings: next.phase === 'running' ? launchRecoveryBindings(plan, observations) : {},
    }, plan)
  }

  async #adoptRecoveredRunning(
    plan: TeamLifecycleLaunchPlan,
    state: DurableState & { runId: string },
    effectGuard?: EffectGuard,
  ): Promise<DurableState> {
    if (!hasExactRecoveryBindings(plan, state.recoveryBindings)) {
      return this.#failRecoveredState(
        plan,
        state,
        new Error('Recovered team lifecycle run has no exact durable provider session binding'),
        effectGuard,
      )
    }
    let observations: TeamLifecycleLaneObservation[]
    try {
      observations = effectGuard
        ? await this.#inspectLanesGuarded(plan, state.runId, state.recoveryBindings, effectGuard)
        : await this.#inspectLanes(plan, state.runId, state.recoveryBindings)
    } catch (error) {
      return this.#failRecoveredState(plan, state, error, effectGuard)
    }
    if (observations.every(observation => observation.phase === 'running')) {
      // Reading the exact durable plan/run tuple under the replacement runtime's
      // exclusive authority is its adoption boundary. From this point shutdown
      // must compensate the recovered external run just like a local launch.
      const current = await this.#read(plan)
      if (current.runId !== state.runId || current.ownerIncarnation !== state.ownerIncarnation ||
        current.operationEpoch !== state.operationEpoch) throw new Error('Recovered lifecycle publication is stale')
      const adopted = await this.#write({
        ...current,
        ownerIncarnation: this.#ownerIncarnation,
      }, plan)
      this.#ownedRuns.set(state.runId, plan)
      return adopted
    }
    return this.#failRecoveredState(
      plan,
      state,
      new Error('Recovered team lifecycle lanes do not confirm the exact running tuple'),
      effectGuard,
    )
  }

  async #failRecoveredState(
    plan: TeamLifecycleLaunchPlan,
    state: DurableState & { runId: string },
    cause: unknown,
    effectGuard?: EffectGuard,
  ): Promise<never> {
    let stopped = false
    try {
      stopped = (await (effectGuard
        ? this.#applyLanesForRecoveryTeardown(plan, state.runId, effectGuard)
        : this.#applyLanesForTeardown(plan, state.runId)))
        .every(observation => observation.phase === 'idle')
    } catch {}
    const current = await this.#read(plan)
    if (current.runId !== state.runId || current.operationEpoch !== state.operationEpoch) {
      throw new Error('Recovered lifecycle failure publication is stale', { cause })
    }
    await this.#write({
      ...current,
      phase: stopped ? 'idle' : 'failed',
      runId: stopped ? null : state.runId,
      recoverable: !stopped,
      ownerIncarnation: stopped ? null : this.#ownerIncarnation,
      recoveryBindings: stopped ? {} : state.recoveryBindings,
    }, plan)
    throw new Error('Unable to adopt recovered team lifecycle run', { cause })
  }

  async #rejectNativeControllerReplacement(plan: TeamLifecycleLaunchPlan, state: DurableState): Promise<never> {
    const current = await this.#read(plan)
    if (current.revision !== state.revision) throw new Error('Native lifecycle replacement evidence changed')
    await this.#write({ ...current, phase: 'failed', recoverable: false, ownerIncarnation: null,
      operationEpoch: current.operationEpoch + 1,
      disposition: { kind: 'native-controller-replacement-required', runId: current.runId,
        reason: 'boot-local-native-channels-are-not-adoptable' } }, plan)
    throw new Error('Native team lifecycle state cannot be adopted by a replacement controller')
  }

  async #trackStaleTeardown(plan: TeamLifecycleLaunchPlan, runId: string): Promise<void> {
    await this.#applyLanesForTeardown(plan, runId).catch(() => [])
  }

  #trackJob(runId: string, operation: Promise<void>): void {
    const job = operation.catch(() => {}).finally(() => {
      if (this.#jobs.get(runId) === job) this.#jobs.delete(runId)
    })
    this.#jobs.set(runId, job)
  }

  #inspectLanes(
    plan: TeamLifecycleLaunchPlan,
    runId: string,
    recoveryBindings: Record<string, string> = {},
  ): Promise<TeamLifecycleLaneObservation[]> {
    return Promise.all(plan.lanes.map(async lane => {
      const adapter = this.#adapter(lane.kind)
      const expectedBinding = recoveryBindings[lane.laneId]
      const observation = await adapter.inspect({
        planTeamId: plan.teamId,
        workspaceRoot: plan.workspaceRoot,
        toolApprovalMode: plan.toolApprovalMode,
        lane,
        runId,
        recoveryBinding: expectedBinding,
      })
      assertRecoveryBinding(lane.laneId, expectedBinding, observation)
      return observation
    }))
  }

  #inspectLanesGuarded(
    plan: TeamLifecycleLaunchPlan,
    runId: string,
    recoveryBindings: Record<string, string>,
    effectGuard: EffectGuard,
  ): Promise<TeamLifecycleLaneObservation[]> {
    return Promise.all(plan.lanes.map(async lane => {
      const adapter = this.#adapter(lane.kind)
      if (!(await effectGuard())) throw new Error('Team lifecycle startup authority changed')
      const expectedBinding = recoveryBindings[lane.laneId]
      const observation = await adapter.inspect({
        planTeamId: plan.teamId,
        workspaceRoot: plan.workspaceRoot,
        toolApprovalMode: plan.toolApprovalMode,
        lane,
        runId,
        recoveryBinding: expectedBinding,
        effectGuard,
      })
      assertRecoveryBinding(lane.laneId, expectedBinding, observation)
      if (!(await effectGuard())) throw new Error('Team lifecycle startup authority changed')
      return observation
    }))
  }

  #applyLanes(
    plan: TeamLifecycleLaunchPlan,
    runId: string,
    action: 'launch' | 'cancel' | 'stop' | 'recover',
    effectGuard: EffectGuard,
  ): Promise<TeamLifecycleLaneObservation[]> {
    return Promise.all(plan.lanes.map(async lane => {
      const adapter = this.#adapter(lane.kind)
      const laneInput: LaneInput = {
        planTeamId: plan.teamId,
        workspaceRoot: plan.workspaceRoot,
        toolApprovalMode: plan.toolApprovalMode,
        lane,
        runId,
        effectGuard,
      }
      // No asynchronous boundary may exist between the authority comparison and
      // invoking the provider adapter: a queued launch can outlive its request.
      if (!(await effectGuard())) throw new Error('Team lifecycle effect authority changed')
      const observation = await this.#invokeAdapter(adapter, action, laneInput, this.#effectTimeoutMs)
      if (!(await effectGuard())) {
        // A successful launch is already an external effect. Losing authority
        // while it awaited must synchronously compensate that exact run before
        // the job can settle or close() can declare the owner drained.
        if (action === 'launch') {
          const stopped = await this.#invokeAdapter(adapter, 'stop', {
            ...laneInput,
            effectGuard: () => this.#ownedRuns.get(runId) === plan,
          }, this.#compensationTimeoutMs)
          if (stopped.phase !== 'idle') {
            throw new Error('Team lifecycle effect authority changed and exact launch compensation was not confirmed')
          }
        }
        throw new Error('Team lifecycle effect authority changed')
      }
      return observation
    }))
  }

  #applyLanesForTeardown(
    plan: TeamLifecycleLaunchPlan,
    runId: string,
  ): Promise<TeamLifecycleLaneObservation[]> {
    return Promise.all(plan.lanes.map(lane => {
      const adapter = this.#adapter(lane.kind)
      return this.#invokeAdapter(adapter, 'stop', {
        planTeamId: plan.teamId,
        workspaceRoot: plan.workspaceRoot,
        toolApprovalMode: plan.toolApprovalMode,
        lane,
        runId,
        effectGuard: () => this.#ownedRuns.get(runId) === plan,
      }, this.#compensationTimeoutMs)
    }))
  }

  #applyLanesForRecoveryTeardown(
    plan: TeamLifecycleLaunchPlan,
    runId: string,
    effectGuard: EffectGuard,
  ): Promise<TeamLifecycleLaneObservation[]> {
    return Promise.all(plan.lanes.map(async lane => {
      if (!(await effectGuard())) throw new Error('Team lifecycle startup authority changed before teardown')
      const adapter = this.#adapter(lane.kind)
      return this.#invokeAdapter(adapter, 'stop', {
        planTeamId: plan.teamId,
        workspaceRoot: plan.workspaceRoot,
        toolApprovalMode: plan.toolApprovalMode,
        lane,
        runId,
        effectGuard,
      }, this.#compensationTimeoutMs)
    }))
  }

  async #invokeAdapter(
    adapter: TeamLifecycleLaneEffectPort,
    action: 'launch' | 'cancel' | 'stop' | 'recover',
    input: LaneInput,
    timeoutMs: number,
  ): Promise<TeamLifecycleLaneObservation> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`Team lifecycle ${action} deadline exceeded`)), timeoutMs)
    timer.unref?.()
    try {
      const operation = adapter[action]({ ...input, signal: controller.signal })
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => {
            reject(controller.signal.reason)
          }, { once: true })),
        ])
      } catch (error) {
        if (!controller.signal.aborted) throw error
        // A cooperative adapter may need its provider gate to release before
        // acknowledging cancellation. Keep the owning job live until that
        // happens, and compensate a late successful launch synchronously. This
        // is the fence that makes close() a true no-late-provider-effects
        // boundary instead of a timer race.
        let late: TeamLifecycleLaneObservation
        try {
          late = await operation
        } catch {
          throw error
        }
        if (action === 'launch' && late.phase !== 'idle') {
          const stopped = await adapter.stop({
            ...input,
            signal: undefined,
            effectGuard: () => this.#ownedRuns.get(input.runId) !== undefined,
          })
          if (stopped.phase !== 'idle') {
            throw new Error('Timed-out team lifecycle launch compensation was not confirmed', { cause: error })
          }
        }
        throw error
      }
    } finally {
      clearTimeout(timer)
    }
  }

  #adapter(kind: TeamLifecycleLaunchPlan['lanes'][number]['kind']): TeamLifecycleLaneEffectPort {
    const adapter = this.#adapters.get(kind)
    if (!adapter) throw new Error(`No production team lifecycle adapter for ${kind}`)
    return adapter
  }

  #assertSupported(plan: TeamLifecycleLaunchPlan, action: HostedLifecycleAction): void {
    if (!this.supports(plan, action)) throw new Error(`Team lifecycle ${action} is unavailable for this plan`)
  }

  #assertAcceptingEffects(): void {
    if (!this.#acceptingEffects) throw new Error('Team lifecycle execution is closed')
  }

  #assertGeneration(state: DurableState, expected: string): void {
    if (generation(state) !== expected) throw new Error('Team lifecycle provider generation changed')
  }

  async #read(plan: TeamLifecycleLaunchPlan): Promise<DurableState> {
    const expectedPlan = planFingerprint(plan)
    if (!(await this.transactions.exists())) {
      return this.transactions.initialize(createInitialDurableState(expectedPlan, plan.toolApprovalMode))
    }
    await this.transactions.migrateLegacyIfNeeded()
    const state = await this.transactions.read(value => value)
    if (state.toolApprovalMode !== plan.toolApprovalMode) throw new Error('Team lifecycle durable approval mode changed')
    if (state.planFingerprint === expectedPlan) return state
    if (state.phase !== 'idle') throw new Error('Active team lifecycle plan changed')
    return this.transactions.update(current => {
      if (current.revision !== state.revision || current.phase !== 'idle') throw new Error('Team lifecycle plan rotation raced')
      return { state: createInitialDurableState(expectedPlan, plan.toolApprovalMode, {
        revision: current.revision,
        operationEpoch: current.operationEpoch + 1,
        attempts: current.attempts,
        tombstones: current.tombstones,
        disposition: current.disposition,
        legacyUnresolved: current.legacyUnresolved,
      }), value: undefined }
    }).then(() => this.transactions.read(value => value))
  }

  async #write(input: DurableState, plan: TeamLifecycleLaunchPlan): Promise<DurableState> {
    const expectedPlan = planFingerprint(plan)
    if (input.phase === 'idle') assertIdleCustody(input)
    await this.transactions.update(current => {
      if (current.revision !== input.revision) throw new Error('Team lifecycle durable state changed concurrently')
      if (input.planFingerprint !== expectedPlan || input.toolApprovalMode !== plan.toolApprovalMode) {
        throw new Error('Team lifecycle write plan binding changed')
      }
      return { state: input, value: undefined }
    })
    return this.transactions.read(value => value)
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#operationTail
    let release!: () => void
    this.#operationTail = new Promise<void>(resolve => { release = resolve })
    await prior
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function launchCompletion(
  observations: readonly TeamLifecycleLaneObservation[],
): TeamLifecycleLaneObservation {
  if (observations.every(observation => observation.phase === 'running' &&
    validRecoveryBinding(observation.recoveryBinding))) {
    return { phase: 'running', recoverable: false }
  }
  if (observations.some(observation => observation.phase === 'failed' || observation.phase === 'idle')) {
    return { phase: 'failed', recoverable: true }
  }
  // A lane may legitimately remain launching (including permission_blocked) after
  // the bridge request returns. Inspect is responsible for later reconciliation.
  return { phase: 'launching', recoverable: false }
}

function snapshot(providerId: string, state: DurableState): HostedLifecycleProviderSnapshot {
  return {
    providerId,
    providerGeneration: generation(state),
    phase: state.phase,
    runId: state.runId,
    recoverable: state.recoverable,
  }
}

function generation(state: DurableState): string {
  return `generation_${createHash('sha256').update(stringifyDurableState(state)).digest('hex')}`
}

function planFingerprint(plan: TeamLifecycleLaunchPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`Invalid team lifecycle ${label} timeout`)
  return Math.ceil(value)
}

function launchRecoveryBindings(
  plan: TeamLifecycleLaunchPlan,
  observations: readonly TeamLifecycleLaneObservation[],
): Record<string, string> {
  if (observations.length !== plan.lanes.length) throw new Error('Lifecycle lane observation count changed')
  return Object.fromEntries(plan.lanes.map((lane, index) => {
    const binding = observations[index]?.recoveryBinding
    if (!validRecoveryBinding(binding)) {
      throw new Error(`Lifecycle lane ${lane.laneId} omitted its exact recovery binding`)
    }
    return [lane.laneId, binding]
  }))
}

function observationsHaveRecoveryBindings(
  plan: TeamLifecycleLaunchPlan,
  observations: readonly TeamLifecycleLaneObservation[],
): boolean {
  return observations.length === plan.lanes.length && observations.every(
    observation => validRecoveryBinding(observation.recoveryBinding),
  )
}

function validRecoveryBinding(value: unknown): value is string {
  return typeof value === 'string' && /^session-set_[0-9a-f]{64}$/.test(value)
}

function hasExactRecoveryBindings(
  plan: TeamLifecycleLaunchPlan,
  bindings: Record<string, string>,
): boolean {
  const actual = Object.keys(bindings).sort()
  const expected = plan.lanes.map(lane => lane.laneId).sort()
  return actual.length === expected.length && actual.every((laneId, index) => laneId === expected[index])
}

function assertRecoveryBinding(
  laneId: string,
  expected: string | undefined,
  observation: TeamLifecycleLaneObservation,
): void {
  if (expected && observation.recoveryBinding !== expected) {
    throw new Error(`Lifecycle lane ${laneId} provider session set changed from its durable binding`)
  }
}
