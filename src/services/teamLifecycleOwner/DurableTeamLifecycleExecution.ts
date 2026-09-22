import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import * as lockfile from '../../utils/lockfile.js'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import { fsyncFileAndParent } from '../hostedControl/HostedTaskMutationWal.js'
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

type DurableState = {
  schemaVersion: 4
  revision: number
  planFingerprint: string
  toolApprovalMode: TeamLifecycleLaunchPlan['toolApprovalMode']
  phase: HostedLifecycleProviderSnapshot['phase']
  runId: string | null
  recoverable: boolean
  ownerIncarnation: string | null
  recoveryBindings: Record<string, string>
}

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
  #acceptingEffects = true
  #closePromise: Promise<void> | null = null
  #shutdownPromise: Promise<void> | null = null
  #tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly statePath: string,
    adapters: readonly TeamLifecycleLaneEffectPort[],
    private readonly providerId = 'team-lifecycle-owner',
    timeouts: { effectTimeoutMs?: number; compensationTimeoutMs?: number } = {},
  ) {
    if (!isAbsolute(statePath) || statePath.includes('\0')) {
      throw new TypeError('Team lifecycle state path must be absolute')
    }
    this.#initializationMarkerPath = `${statePath}.initialized`
    this.#effectTimeoutMs = positiveTimeout(timeouts.effectTimeoutMs ?? 300_000, 'effect')
    this.#compensationTimeoutMs = positiveTimeout(timeouts.compensationTimeoutMs ?? 10_000, 'compensation')
    const entries = adapters.map(adapter => [adapter.kind, adapter] as const)
    if (new Set(entries.map(([kind]) => kind)).size !== entries.length) {
      throw new TypeError('Duplicate team lifecycle lane adapter')
    }
    this.#adapters = new Map(entries)
  }

  supports(plan: TeamLifecycleLaunchPlan, action: HostedLifecycleAction): boolean {
    // Capability is a property of the plan and adapters, not of this owner's
    // current admission state. close() fences effects separately.
    return this.#supportsCapability(plan, action)
  }

  inspect(plan: TeamLifecycleLaunchPlan): Promise<HostedLifecycleProviderSnapshot> {
    return this.#serialized(async () => {
      let state = await this.#read(plan)
      this.#assertActiveSupported(plan, state)
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
      this.#assertActiveSupported(plan, state)
      if (state.phase === 'idle') return

      if (state.phase === 'running' && state.runId) {
        await this.#adoptRecoveredRunning(plan, state, effectGuard)
        return
      }

      if (!state.runId) throw new Error('Team lifecycle startup state is ambiguous')
      await this.#failRecoveredState(
        plan,
        state,
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
      }, input.plan)
      this.#ownedRuns.set(runId, input.plan)
      this.#trackJob(runId, this.#completeLaunch(input.plan, runId, input.effectGuard ?? EFFECT_ALLOWED))
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
      const stopping = await this.#write({ ...before, phase: 'stopping', recoverable: false }, input.plan)
      this.#trackJob(before.runId, this.#completeStop(input.plan, before.runId, input.effectGuard ?? EFFECT_ALLOWED))
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
      const observations = await this.#applyLanes(
        input.plan,
        before.runId,
        action,
        input.effectGuard ?? EFFECT_ALLOWED,
      )
      if (!observations.every(observation => observation.phase === 'idle')) {
        throw new Error(`Team lifecycle ${action} was not confirmed`)
      }
      const idleState = await this.#write({
        ...before, phase: 'idle', runId: null, recoverable: false, ownerIncarnation: null,
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
        await this.#write({
          ...current,
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

  async #completeLaunch(plan: TeamLifecycleLaunchPlan, runId: string, effectGuard: EffectGuard): Promise<void> {
    let observations: TeamLifecycleLaneObservation[]
    try {
      observations = await this.#applyLanes(plan, runId, 'launch', effectGuard)
    } catch {
      observations = [{ phase: 'failed', recoverable: true }]
    }
    await this.#serialized(async () => {
      const current = await this.#read(plan)
      if (current.ownerIncarnation !== this.#ownerIncarnation) return
      if (current.runId === runId && current.phase === 'running') return
      if (current.runId !== runId || current.phase !== 'launching') {
        await this.#applyLanesForTeardown(plan, runId).catch(() => [])
        return
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

  async #completeStop(plan: TeamLifecycleLaunchPlan, runId: string, effectGuard: EffectGuard): Promise<void> {
    let stopped = false
    try {
      stopped = (await this.#applyLanes(plan, runId, 'stop', effectGuard))
        .every(observation => observation.phase === 'idle')
    } catch {}
    await this.#serialized(async () => {
      const current = await this.#read(plan)
      if (current.runId !== runId || current.phase !== 'stopping' ||
        current.ownerIncarnation !== this.#ownerIncarnation) return
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
    const next = launchCompletion(observations)
    if (next.phase === 'launching') {
      return observationsHaveRecoveryBindings(plan, observations)
        ? this.#write({ ...state, recoveryBindings: launchRecoveryBindings(plan, observations) }, plan)
        : state
    }
    return this.#write({
      ...state,
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
      await this.#failRecoveredState(
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
      await this.#failRecoveredState(plan, state, error, effectGuard)
    }
    if (observations!.every(observation => observation.phase === 'running')) {
      // Reading the exact durable plan/run tuple under the replacement runtime's
      // exclusive authority is its adoption boundary. From this point shutdown
      // must compensate the recovered external run just like a local launch.
      const adopted = await this.#write({
        ...state,
        ownerIncarnation: this.#ownerIncarnation,
      }, plan)
      this.#ownedRuns.set(state.runId, plan)
      return adopted
    }
    await this.#failRecoveredState(
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
    await this.#write({
      ...state,
      phase: stopped ? 'idle' : 'failed',
      runId: stopped ? null : state.runId,
      recoverable: !stopped,
      ownerIncarnation: stopped ? null : this.#ownerIncarnation,
      recoveryBindings: stopped ? {} : state.recoveryBindings,
    }, plan)
    throw new Error('Unable to adopt recovered team lifecycle run', { cause })
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
        plan,
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
        plan,
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
        plan,
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
        plan,
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
        plan,
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
    this.#assertAcceptingEffects()
    if (!this.#supportsCapability(plan, action)) throw new Error(`Team lifecycle ${action} is unavailable for this plan`)
  }

  #assertActiveSupported(plan: TeamLifecycleLaunchPlan, state: DurableState): void {
    // An unsupported schema may still have durable active state. Fence before
    // any reconciliation, adoption, inspection, or teardown can call a lane.
    if (state.phase !== 'idle' && !this.#supportsCapability(plan, 'recover')) {
      throw new Error('Team lifecycle active state is unavailable for this plan')
    }
  }

  #supportsCapability(plan: TeamLifecycleLaunchPlan, action: HostedLifecycleAction): boolean {
    return plan.lanes.every(lane => this.#adapters.get(lane.kind)?.supports(action, plan) === true)
  }

  #assertAcceptingEffects(): void {
    if (!this.#acceptingEffects) throw new Error('Team lifecycle execution is closed')
  }

  #assertGeneration(state: DurableState, expected: string): void {
    if (generation(state) !== expected) throw new Error('Team lifecycle provider generation changed')
  }

  async #read(plan: TeamLifecycleLaunchPlan): Promise<DurableState> {
    const expectedPlan = planFingerprint(plan)
    const handle = await open(this.statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!handle) {
      const marker = await open(
        this.#initializationMarkerPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      ).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!marker) return initialState(plan)
      try {
        const stat = await marker.stat()
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 2 || stat.size > 1024 ||
          (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
          throw new Error('Unsafe team lifecycle initialization marker')
        }
      } finally { await marker.close() }
      throw new Error('Team lifecycle durable state disappeared after initialization')
    }
    try {
      const [stat, current] = await Promise.all([handle.stat(), lstat(this.statePath)])
      if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() || stat.dev !== current.dev ||
        stat.ino !== current.ino || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
        throw new Error('Unsafe team lifecycle durable state')
      }
      const state = decodeState(JSON.parse(await handle.readFile('utf8')))
      if (state.toolApprovalMode !== plan.toolApprovalMode) {
        throw new Error('Team lifecycle durable approval mode changed')
      }
      if (state.planFingerprint !== expectedPlan) {
        if (state.phase !== 'idle') throw new Error('Active team lifecycle plan changed')
        return initialState(plan)
      }
      return state
    } finally {
      await handle.close()
    }
  }

  async #write(input: DurableState, plan: TeamLifecycleLaunchPlan): Promise<DurableState> {
    const state: DurableState = {
      ...input,
      schemaVersion: 4,
      toolApprovalMode: plan.toolApprovalMode,
      revision: input.revision + 1,
      planFingerprint: planFingerprint(plan),
    }
    await writeFileAtomic(this.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    await fsyncFileAndParent(this.statePath)
    await this.#writeInitializationMarker()
    return state
  }

  async #writeInitializationMarker(): Promise<void> {
    const marker = `${JSON.stringify({ schemaVersion: 1, initialized: true })}\n`
    const exists = await lstat(this.#initializationMarkerPath).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
    if (!exists) {
      await writeFileAtomic(this.#initializationMarkerPath, marker, { mode: 0o600 })
      await fsyncFileAndParent(this.#initializationMarkerPath)
    }
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => { release = resolve })
    await prior
    let unlock: (() => Promise<void>) | null = null
    try {
      unlock = await lockfile.lock(`${this.statePath}.owner`, {
        realpath: false,
        retries: { retries: 20, minTimeout: 5, maxTimeout: 100 },
      })
      return await operation()
    } finally {
      await unlock?.()
      release()
    }
  }
}

function initialState(plan: TeamLifecycleLaunchPlan): DurableState {
  return {
    schemaVersion: 4,
    revision: 0,
    planFingerprint: planFingerprint(plan),
    toolApprovalMode: plan.toolApprovalMode,
    phase: 'idle',
    runId: null,
    recoverable: false,
    ownerIncarnation: null,
    recoveryBindings: {},
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
  return `generation_${createHash('sha256').update(JSON.stringify(state)).digest('hex')}`
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

function decodeState(value: unknown): DurableState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid team lifecycle state')
  const record = value as Record<string, unknown>
  const legacyOwner = record.schemaVersion === 2
  const legacyBindings = record.schemaVersion === 2 || record.schemaVersion === 3
  const keys = ['schemaVersion', 'revision', 'planFingerprint', 'toolApprovalMode', 'phase', 'runId', 'recoverable',
    ...(legacyOwner ? [] : ['ownerIncarnation']), ...(legacyBindings ? [] : ['recoveryBindings'])]
  if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key)) ||
    ![2, 3, 4].includes(record.schemaVersion as number) || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0 ||
    typeof record.planFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.planFingerprint) ||
    !['idle', 'launching', 'running', 'stopping', 'failed'].includes(String(record.phase)) ||
    !(record.runId === null || typeof record.runId === 'string' && /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/.test(record.runId)) ||
    !['manual', 'auto'].includes(String(record.toolApprovalMode)) ||
    typeof record.recoverable !== 'boolean' || (!legacyOwner && !(record.ownerIncarnation === null ||
      typeof record.ownerIncarnation === 'string' && /^owner_[0-9a-f]{32}$/.test(record.ownerIncarnation))) ||
    (!legacyBindings && !validRecoveryBindings(record.recoveryBindings))) {
    throw new Error('Invalid team lifecycle state')
  }
  if (record.phase === 'idle' ? record.runId !== null : record.runId === null) {
    throw new Error('Invalid team lifecycle state/run binding')
  }
  return {
    ...record,
    schemaVersion: 4,
    ownerIncarnation: legacyOwner ? null : record.ownerIncarnation,
    recoveryBindings: legacyBindings ? {} : record.recoveryBindings,
  } as DurableState
}

function validRecoveryBindings(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.length <= 64 && entries.every(([laneId, binding]) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(laneId) &&
    typeof binding === 'string' && /^session-set_[0-9a-f]{64}$/.test(binding))
}
