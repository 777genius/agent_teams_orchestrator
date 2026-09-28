import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { fsyncFileAndParent } from '../hostedControl/HostedTaskMutationWal.js'
import type { HostedLifecycleAction, HostedLifecycleProviderSnapshot } from '../hostedControl/HostedLifecycleSnapshot.js'
import type { TeamLifecycleLaunchPlan } from './TeamLifecycleLaunchPlan.js'
import type {
  TeamLifecycleExecutionPort,
  TeamLifecycleOwnerEffectInput,
} from './TeamLifecycleOwnerService.js'
import type {
  TeamLifecycleLaneEffectPort,
  TeamLifecycleLaneObservation,
} from './OpenCodeTeamLifecycleLane.js'
import {
  decodeLaneFailure,
  laneFailureFromError,
  type TeamLifecycleLaneFailure,
  type TeamLifecycleLaneFailureReport,
} from './TeamLifecycleLaneFailure.js'

type DurableState = {
  schemaVersion: 2
  revision: number
  planFingerprint: string
  toolApprovalMode: TeamLifecycleLaunchPlan['toolApprovalMode']
  phase: HostedLifecycleProviderSnapshot['phase']
  runId: string | null
  recoverable: boolean
  /** Present only with phase `failed` when a lane effect caused it. */
  failure?: TeamLifecycleLaneFailure
}

type LaneInput = {
  planTeamId: string
  workspaceRoot: string
  toolApprovalMode: TeamLifecycleLaunchPlan['toolApprovalMode']
  lane: TeamLifecycleLaunchPlan['lanes'][number]
  planLanes: TeamLifecycleLaunchPlan['lanes']
  agentLanguage?: string
  runId: string
}

type EffectGuard = NonNullable<TeamLifecycleOwnerEffectInput['effectGuard']>
/** `start` gates beginning a lane effect; `authority` must still hold when it returns. */
type EffectGuards = Readonly<{ start: EffectGuard; authority: EffectGuard }>
/** First lead-lane poll delay; it doubles up to the cap so a slow bootstrap costs few inspections. */
const LEAD_LANE_READY_POLL_MS = 500
const LEAD_LANE_READY_MAX_POLL_MS = 5_000
/** Above the longest native bootstrap budget (900 s) plus its lane deadline grace. */
const LEAD_LANE_READY_TIMEOUT_MS = 20 * 60_000
const EFFECT_ALLOWED: EffectGuard = () => true

export type TeamLifecycleRunReservation = {
  planFingerprint: string
  expectedProviderGeneration: string
  commandId: string
  idempotencyKey: string
  runId: string
}

/** Implementations must durably return the same run for an identical binding and reject conflicts. */
export type TeamLifecycleRunReservationPort = (
  binding: Omit<TeamLifecycleRunReservation, 'runId'>,
  signal: AbortSignal,
  input: TeamLifecycleOwnerEffectInput,
) => Promise<TeamLifecycleRunReservation | null>

export type DurableTeamLifecycleExecutionOptions = {
  runReservation?: TeamLifecycleRunReservationPort
  /** Hosted composition can require the port before accepting any launch. */
  requireRunReservation?: boolean
  reservationTimeoutMs?: number
  /** Operator diagnostics for a lane failure; the durable state carries the same reason. */
  reportLaneFailure?: (report: TeamLifecycleLaneFailureReport) => void
  /**
   * The admitted plan, so shutdown can stop a run recorded by an earlier process even when this
   * process never inspected it. Null when no plan is admitted.
   */
  loadAdmittedPlan?: () => Promise<TeamLifecycleLaunchPlan | null>
}

/**
 * Provider-independent sole lifecycle owner. It durably records intent before effects and
 * confirms every terminal transition through the lane adapters before publishing it.
 */
export class DurableTeamLifecycleExecution implements TeamLifecycleExecutionPort {
  readonly #adapters: ReadonlyMap<TeamLifecycleLaunchPlan['lanes'][number]['kind'], TeamLifecycleLaneEffectPort>
  readonly #jobs = new Map<string, Promise<void>>()
  readonly #ownedRuns = new Set<string>()
  readonly #knownPlans = new Map<string, TeamLifecycleLaunchPlan>()
  readonly #reservationAbort = new AbortController()
  #acceptingEffects = true
  #closePromise: Promise<void> | null = null
  #shutdownPromise: Promise<void> | null = null
  #tail: Promise<void> = Promise.resolve()
  /** Latest queued or running inspection that no later operation was queued behind. */
  #inspection: { planFingerprint: string; snapshot: Promise<HostedLifecycleProviderSnapshot> } | null = null

  constructor(
    private readonly statePath: string,
    adapters: readonly TeamLifecycleLaneEffectPort[],
    private readonly providerId = 'team-lifecycle-owner',
    private readonly options: DurableTeamLifecycleExecutionOptions = {},
  ) {
    if (!isAbsolute(statePath) || statePath.includes('\0')) {
      throw new TypeError('Team lifecycle state path must be absolute')
    }
    if (options.reservationTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.reservationTimeoutMs) || options.reservationTimeoutMs < 1)) {
      throw new TypeError('Invalid team lifecycle run reservation timeout')
    }
    const entries = adapters.map(adapter => [adapter.kind, adapter] as const)
    if (new Set(entries.map(([kind]) => kind)).size !== entries.length) {
      throw new TypeError('Duplicate team lifecycle lane adapter')
    }
    this.#adapters = new Map(entries)
  }

  supports(plan: TeamLifecycleLaunchPlan, action: HostedLifecycleAction): boolean {
    return this.#acceptingEffects && plan.lanes.every(lane => {
      const adapter = this.#adapters.get(lane.kind)
      return adapter?.supports(action) === true && (adapter.supportsPlan?.(plan) ?? true)
    })
  }

  inspect(plan: TeamLifecycleLaunchPlan): Promise<HostedLifecycleProviderSnapshot> {
    this.#rememberPlan(plan)
    // Lifecycle queries and the inbox pump inspect concurrently; they share one
    // lane reconcile instead of queueing one each.
    const fingerprint = planFingerprint(plan)
    if (this.#inspection?.planFingerprint === fingerprint) return this.#inspection.snapshot
    const inspection = { planFingerprint: fingerprint, snapshot: this.#inspectSerialized(plan) }
    this.#inspection = inspection
    const settle = () => { if (this.#inspection === inspection) this.#inspection = null }
    inspection.snapshot.then(settle, settle)
    return inspection.snapshot
  }

  #inspectSerialized(plan: TeamLifecycleLaunchPlan): Promise<HostedLifecycleProviderSnapshot> {
    return this.#serialized(async () => {
      let state = await this.#read(plan)
      if (state.phase === 'launching' && state.runId && !this.#jobs.has(state.runId)) {
        if (!this.#ownedRuns.has(state.runId)) {
          // A launch not owned by this process is crash evidence, never inferred success.
          state = await this.#write({ ...state, phase: 'failed', recoverable: true }, plan)
        } else {
          state = await this.#reconcileLaunching(plan, state)
        }
      } else if (state.phase === 'stopping' && state.runId && !this.#jobs.has(state.runId)) {
        // Stop completion is only authoritative while its local job is still owned.
        state = await this.#write({ ...state, phase: 'failed', recoverable: true }, plan)
      } else if (state.phase === 'running' && state.runId) {
        const runId = state.runId
        const observations = await this.#inspectLanes(plan, runId).catch((error: unknown) => {
          // A failed inspect leaves the durable phase unchanged; only report why.
          this.#reportLaneFailure(laneFailureFromError('inspect', error), runId, plan)
          throw error
        })
        if (observations.some(observation => observation.phase === 'failed' || observation.phase === 'idle')) {
          const failure = reportedFailure('inspect', observations)
          state = await this.#write({ ...state, phase: 'failed', recoverable: true, failure }, plan)
          this.#reportLaneFailure(failure, runId, plan)
        }
      }
      return snapshot(this.providerId, state)
    })
  }

  launch(input: TeamLifecycleOwnerEffectInput): Promise<HostedLifecycleProviderSnapshot> {
    return this.#launch(input, false)
  }

  replayLaunch(input: TeamLifecycleOwnerEffectInput): Promise<HostedLifecycleProviderSnapshot> {
    return this.#launch(input, true)
  }

  #launch(input: TeamLifecycleOwnerEffectInput, replayOnly: boolean): Promise<HostedLifecycleProviderSnapshot> {
    this.#rememberPlan(input.plan)
    return this.#serialized(async () => {
      this.#assertAcceptingEffects()
      this.#assertSupported(input.plan, 'launch')
      let before = await this.#read(input.plan)
      const reservationRequired = this.options.requireRunReservation || !!this.options.runReservation
      if (reservationRequired && !this.options.runReservation) {
        throw new Error('Team lifecycle run reservation is required')
      }
      if (reservationRequired && !input.idempotencyKey) {
        throw new Error('Team lifecycle idempotency key is required for run reservation')
      }
      if (replayOnly && (!this.options.runReservation || before.phase === 'idle')) {
        throw new Error('Team lifecycle run replay is unavailable')
      }
      if (before.phase === 'idle' || !reservationRequired) {
        this.#assertGeneration(before, input.expectedProviderGeneration)
      }
      if (before.phase !== 'idle' && !reservationRequired) throw new Error('Team lifecycle owner is not idle')
      let runId: string
      if (this.options.runReservation) {
        const binding = {
          planFingerprint: planFingerprint(input.plan),
          expectedProviderGeneration: input.reservationExpectedProviderGeneration ?? input.expectedProviderGeneration,
          commandId: input.commandId,
          idempotencyKey: input.idempotencyKey!,
        }
        const reservation = await this.#resolveReservation(binding, input)
        if (!reservation || reservation.planFingerprint !== binding.planFingerprint ||
          reservation.expectedProviderGeneration !== binding.expectedProviderGeneration ||
          reservation.commandId !== binding.commandId ||
          reservation.idempotencyKey !== binding.idempotencyKey ||
          !/^run_[0-9a-f]{32}$/.test(reservation.runId)) {
          throw new Error('Team lifecycle run reservation changed or unavailable')
        }
        // The reservation can await remote durability. Recheck authority and local state
        // before publishing intent; no lane job is started on a stale response.
        this.#assertAcceptingEffects()
        this.#assertSupported(input.plan, 'launch')
        if (!await (input.effectGuard ?? EFFECT_ALLOWED)()) {
          throw new Error('Team lifecycle effect authority changed')
        }
        const current = await this.#read(input.plan)
        this.#assertAcceptingEffects()
        if (current.phase !== 'idle') {
          if (current.runId === reservation.runId &&
            (current.phase === 'launching' || current.phase === 'running')) {
            return snapshot(this.providerId, current)
          }
          throw new Error('Team lifecycle owner is not idle')
        }
        if (replayOnly) throw new Error('Team lifecycle run replay is stale')
        this.#assertGeneration(current, input.expectedProviderGeneration)
        if (!await (input.effectGuard ?? EFFECT_ALLOWED)()) {
          throw new Error('Team lifecycle effect authority changed')
        }
        this.#assertAcceptingEffects()
        before = current
        runId = reservation.runId
      } else {
        runId = `run_${randomUUID().replaceAll('-', '')}`
      }
      const launching = await this.#write({ ...before, phase: 'launching', runId, recoverable: false }, input.plan)
      this.#ownedRuns.add(runId)
      this.#trackJob(runId, this.#completeLaunch(input.plan, runId, effectGuards(input)))
      return snapshot(this.providerId, launching)
    })
  }

  cancel(input: TeamLifecycleOwnerEffectInput): Promise<HostedLifecycleProviderSnapshot> {
    return this.#terminalAction(input, 'cancel')
  }

  stop(input: TeamLifecycleOwnerEffectInput): Promise<HostedLifecycleProviderSnapshot> {
    this.#rememberPlan(input.plan)
    return this.#serialized(async () => {
      this.#assertAcceptingEffects()
      this.#assertSupported(input.plan, 'stop')
      const before = await this.#read(input.plan)
      this.#assertGeneration(before, input.expectedProviderGeneration)
      if (before.phase !== 'running' || before.runId !== input.runId) throw new Error('Team lifecycle run is stale')
      const stopping = await this.#write({ ...before, phase: 'stopping', recoverable: false }, input.plan)
      this.#trackJob(before.runId, this.#completeStop(input.plan, before.runId, effectGuards(input)))
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
    this.#rememberPlan(input.plan)
    return this.#serialized(async () => {
      this.#assertAcceptingEffects()
      this.#assertSupported(input.plan, action)
      const before = await this.#read(input.plan)
      this.#assertGeneration(before, input.expectedProviderGeneration)
      const expectedPhase = action === 'cancel' ? 'launching' : 'failed'
      if (before.phase !== expectedPhase || !before.runId || before.runId !== input.runId) {
        throw new Error('Team lifecycle run is stale')
      }
      const observations = await this.#applyLanes(
        input.plan,
        before.runId,
        action,
        effectGuards(input),
      )
      if (!observations.every(observation => observation.phase === 'idle')) {
        throw new Error(`Team lifecycle ${action} was not confirmed`)
      }
      const idleState = await this.#write({ ...before, phase: 'idle', runId: null, recoverable: false }, input.plan)
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
    this.#reservationAbort.abort(new Error('Team lifecycle execution is closed'))
    // Cross the serialization barrier so a launch already admitted has registered its job.
    await this.#serialized(async () => {})
    while (this.#jobs.size > 0) {
      await Promise.all([...this.#jobs.values()])
    }
  }

  /**
   * Drains admitted work, then stops every run recorded in this state file. The state file
   * sits under the team root this process exclusively leases, so a run left by a crashed earlier
   * owner and adopted here (its detached host survives) is this process's to stop as well.
   */
  shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#shutdown()
    return this.#shutdownPromise
  }

  async #shutdown(): Promise<void> {
    await this.close()
    const admitted = await this.options.loadAdmittedPlan?.().catch(() => null)
    if (admitted) this.#rememberPlan(admitted)
    // Runtime authority loss is a teardown boundary, not a new commanded
    // effect. Stop each recorded run with its exact plan/run tuple before
    // allowing the hosted runtime to finish closing. After close() no job is
    // left, so a failed, launching or stopping run may still have live lane
    // processes (a permission-blocked launch, a crash) and is stopped as well.
    for (const plan of this.#knownPlans.values()) {
      await this.#serialized(async () => {
        // A superseded remembered plan must not abort teardown of the current one.
        const current = await this.#read(plan).catch(() => null)
        if (!current?.runId) return
        let stopped = false
        let failure: TeamLifecycleLaneFailure | undefined
        try {
          stopped = (await this.#applyLanesForTeardown(plan, current.runId))
            .every(observation => observation.phase === 'idle')
          if (!stopped) failure = stopNotConfirmed('teardown')
        } catch (error) {
          failure = laneFailureFromError('teardown', error)
        }
        if (stopped) {
          await this.#write({ ...current, phase: 'idle', runId: null, recoverable: false }, plan)
          this.#ownedRuns.delete(current.runId)
          return
        }
        // Keep the first recorded cause: a run that is already failed, launching or stopping
        // stays as it is and the teardown failure is only reported.
        if (current.phase === 'running') {
          await this.#write({ ...current, phase: 'failed', recoverable: true, failure }, plan)
        }
        if (failure) this.#reportLaneFailure(failure, current.runId, plan)
      })
    }
  }

  async #completeLaunch(plan: TeamLifecycleLaunchPlan, runId: string, guards: EffectGuards): Promise<void> {
    let observations: TeamLifecycleLaneObservation[]
    let failure: TeamLifecycleLaneFailure | undefined
    try {
      observations = await this.#launchLanes(plan, runId, guards)
    } catch (error) {
      observations = [{ phase: 'failed', recoverable: true }]
      failure = laneFailureFromError('launch', error)
    }
    await this.#serialized(async () => {
      const current = await this.#read(plan)
      if (current.runId === runId && current.phase === 'running') return
      if (current.runId !== runId || current.phase !== 'launching') {
        // Compensation for a superseded launch is not a new commanded effect.
        await this.#applyLanes(plan, runId, 'stop', { start: guards.authority, authority: guards.authority })
          .catch(() => [])
        return
      }
      const next = launchCompletion(observations)
      if (next.phase === 'launching') return
      const reason = next.phase === 'failed' ? failure ?? reportedFailure('launch', observations) : undefined
      await this.#write({
        ...current,
        phase: next.phase,
        recoverable: next.recoverable,
        ...(reason ? { failure: reason } : {}),
      }, plan)
      if (reason) this.#reportLaneFailure(reason, runId, plan)
    })
  }

  /**
   * Desktop launch order: the lane holding team-lead starts first, and every
   * other lane starts one at a time only after it reports running, so side
   * lanes join a team the lead has already created. A plan without exactly
   * one lead lane keeps a single concurrent pass.
   */
  async #launchLanes(
    plan: TeamLifecycleLaunchPlan,
    runId: string,
    guards: EffectGuards,
  ): Promise<TeamLifecycleLaneObservation[]> {
    const leadLanes = plan.lanes.filter(lane => lane.members.some(member => member.name === TEAM_LEAD_NAME))
    if (plan.lanes.length === 1 || leadLanes.length !== 1) return this.#applyLanes(plan, runId, 'launch', guards)
    const leadLane = leadLanes[0]!
    const [launched] = await this.#applyLanes(plan, runId, 'launch', guards, [leadLane])
    const lead = await this.#awaitLaneReady(plan, runId, leadLane, launched!)
    if (lead.phase !== 'running') return [lead]
    const observations = [lead]
    for (const lane of plan.lanes) {
      if (lane === leadLane) continue
      if (!(await this.#launchStillOwned(plan, runId))) return [...observations, { phase: 'launching', recoverable: false }]
      observations.push(...await this.#applyLanes(plan, runId, 'launch', guards, [lane]))
    }
    return observations
  }

  /** Polls the lead lane while it bootstraps; a cancel, stop or close ends the wait. */
  async #awaitLaneReady(
    plan: TeamLifecycleLaunchPlan,
    runId: string,
    lane: TeamLifecycleLaunchPlan['lanes'][number],
    launched: TeamLifecycleLaneObservation,
  ): Promise<TeamLifecycleLaneObservation> {
    let observation = launched
    const deadline = Date.now() + LEAD_LANE_READY_TIMEOUT_MS
    let pollMs = LEAD_LANE_READY_POLL_MS
    while (observation.phase === 'launching') {
      if (Date.now() >= deadline) return { phase: 'failed', recoverable: true }
      await new Promise(resolve => setTimeout(resolve, pollMs))
      pollMs = Math.min(pollMs * 2, LEAD_LANE_READY_MAX_POLL_MS)
      if (!(await this.#launchStillOwned(plan, runId))) return observation
      observation = await this.#adapter(lane.kind).inspect({
        planTeamId: plan.teamId,
        workspaceRoot: plan.workspaceRoot,
        toolApprovalMode: plan.toolApprovalMode,
        lane,
        planLanes: plan.lanes,
        runId,
      })
    }
    return observation
  }

  async #launchStillOwned(plan: TeamLifecycleLaunchPlan, runId: string): Promise<boolean> {
    if (!this.#acceptingEffects) return false
    const current = await this.#read(plan).catch(() => null)
    return current?.runId === runId && current.phase === 'launching'
  }

  async #completeStop(plan: TeamLifecycleLaunchPlan, runId: string, guards: EffectGuards): Promise<void> {
    let stopped = false
    let failure: TeamLifecycleLaneFailure | undefined
    try {
      stopped = (await this.#applyLanes(plan, runId, 'stop', guards))
        .every(observation => observation.phase === 'idle')
      if (!stopped) failure = stopNotConfirmed('stop')
    } catch (error) {
      failure = laneFailureFromError('stop', error)
    }
    await this.#serialized(async () => {
      const current = await this.#read(plan)
      if (current.runId !== runId || current.phase !== 'stopping') return
      await this.#write({
        ...current,
        phase: stopped ? 'idle' : 'failed',
        runId: stopped ? null : runId,
        recoverable: !stopped,
        ...(failure ? { failure } : {}),
      }, plan)
      if (failure) this.#reportLaneFailure(failure, runId, plan)
      if (stopped) this.#ownedRuns.delete(runId)
    })
  }

  async #reconcileLaunching(plan: TeamLifecycleLaunchPlan, state: DurableState): Promise<DurableState> {
    let observations: TeamLifecycleLaneObservation[]
    let failure: TeamLifecycleLaneFailure | undefined
    try {
      observations = await this.#inspectLanes(plan, state.runId!)
    } catch (error) {
      observations = [{ phase: 'failed', recoverable: true }]
      failure = laneFailureFromError('inspect', error)
    }
    const next = launchCompletion(observations)
    if (next.phase === 'launching') return state
    const reason = next.phase === 'failed' ? failure ?? reportedFailure('inspect', observations) : undefined
    const written = await this.#write({
      ...state, phase: next.phase, recoverable: next.recoverable, ...(reason ? { failure: reason } : {}),
    }, plan)
    if (reason) this.#reportLaneFailure(reason, state.runId!, plan)
    return written
  }

  #reportLaneFailure(failure: TeamLifecycleLaneFailure, runId: string, plan: TeamLifecycleLaunchPlan): void {
    try {
      this.options.reportLaneFailure?.({ ...failure, runId, laneKinds: plan.lanes.map(lane => lane.kind) })
    } catch { /* diagnostics never change lifecycle state */ }
  }

  #trackJob(runId: string, operation: Promise<void>): void {
    const job = operation.catch(() => {}).finally(() => {
      if (this.#jobs.get(runId) === job) this.#jobs.delete(runId)
    })
    this.#jobs.set(runId, job)
  }

  #inspectLanes(plan: TeamLifecycleLaunchPlan, runId: string): Promise<TeamLifecycleLaneObservation[]> {
    return Promise.all(plan.lanes.map(lane => {
      const adapter = this.#adapter(lane.kind)
      return adapter.inspect({
        planTeamId: plan.teamId,
        workspaceRoot: plan.workspaceRoot,
        toolApprovalMode: plan.toolApprovalMode,
        lane,
        planLanes: plan.lanes,
        runId,
      })
    }))
  }

  #applyLanes(
    plan: TeamLifecycleLaunchPlan,
    runId: string,
    action: 'launch' | 'cancel' | 'stop' | 'recover',
    guards: EffectGuards,
    lanes: TeamLifecycleLaunchPlan['lanes'] = plan.lanes,
  ): Promise<TeamLifecycleLaneObservation[]> {
    return Promise.all(lanes.map(async lane => {
      const adapter = this.#adapter(lane.kind)
      const laneInput: LaneInput = {
        planTeamId: plan.teamId,
        workspaceRoot: plan.workspaceRoot,
        toolApprovalMode: plan.toolApprovalMode,
        lane,
        planLanes: plan.lanes,
        ...(plan.agentLanguage === undefined ? {} : { agentLanguage: plan.agentLanguage }),
        runId,
      }
      // No asynchronous boundary may exist between the authority comparison and
      // invoking the provider adapter: a queued launch can outlive its request.
      if (!(await guards.start())) throw new Error('Team lifecycle effect authority changed')
      const observation = await adapter[action](laneInput)
      // A started effect may outlast its command deadline (launch attests
      // readiness first), but never the owner authority that admitted it.
      if (!(await guards.authority())) {
        // A successful launch is already an external effect. Losing authority
        // while it awaited must synchronously compensate that exact run before
        // the job can settle or close() can declare the owner drained.
        if (action === 'launch') {
          const stopped = await adapter.stop(laneInput)
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
    return Promise.all(plan.lanes.map(lane => this.#adapter(lane.kind).stop({
      planTeamId: plan.teamId,
      workspaceRoot: plan.workspaceRoot,
      toolApprovalMode: plan.toolApprovalMode,
      lane,
      planLanes: plan.lanes,
      runId,
    })))
  }

  #rememberPlan(plan: TeamLifecycleLaunchPlan): void {
    this.#knownPlans.set(planFingerprint(plan), plan)
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

  async #resolveReservation(
    binding: Omit<TeamLifecycleRunReservation, 'runId'>,
    input: TeamLifecycleOwnerEffectInput,
  ): Promise<TeamLifecycleRunReservation | null> {
    const reserve = this.options.runReservation!
    const controller = new AbortController()
    const onClose = () => controller.abort(new Error('Team lifecycle execution is closed'))
    this.#reservationAbort.signal.addEventListener('abort', onClose, { once: true })
    if (this.#reservationAbort.signal.aborted) onClose()
    const timeout = setTimeout(() => controller.abort(new Error('Team lifecycle run reservation timed out')),
      this.options.reservationTimeoutMs ?? 30_000)
    let onAbort: (() => void) | undefined
    try {
      if (controller.signal.aborted) throw controller.signal.reason
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      return await Promise.race([reserve(binding, controller.signal, input), aborted])
    } finally {
      clearTimeout(timeout)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      this.#reservationAbort.signal.removeEventListener('abort', onClose)
    }
  }

  async #read(plan: TeamLifecycleLaunchPlan): Promise<DurableState> {
    const expectedPlan = planFingerprint(plan)
    const handle = await open(this.statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!handle) return initialState(plan)
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
    // A failure reason describes the current failed phase only; any other transition drops it.
    const { failure, ...rest } = input
    const state: DurableState = {
      ...rest,
      ...(rest.phase === 'failed' && failure ? { failure } : {}),
      schemaVersion: 2,
      toolApprovalMode: plan.toolApprovalMode,
      revision: input.revision + 1,
      planFingerprint: planFingerprint(plan),
    }
    await writeFileAtomic(this.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    await fsyncFileAndParent(this.statePath)
    return state
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    // An operation queued after an inspection must not be observed through it.
    this.#inspection = null
    const prior = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => { release = resolve })
    await prior
    try { return await operation() } finally { release() }
  }
}

function effectGuards(input: TeamLifecycleOwnerEffectInput): EffectGuards {
  const start = input.effectGuard ?? EFFECT_ALLOWED
  return Object.freeze({ start, authority: input.effectAuthorityGuard ?? start })
}

function initialState(plan: TeamLifecycleLaunchPlan): DurableState {
  return {
    schemaVersion: 2,
    revision: 0,
    planFingerprint: planFingerprint(plan),
    toolApprovalMode: plan.toolApprovalMode,
    phase: 'idle',
    runId: null,
    recoverable: false,
  }
}

function stopNotConfirmed(action: 'stop' | 'teardown'): TeamLifecycleLaneFailure {
  return { action, code: 'stop_not_confirmed', message: 'A lane did not confirm the run stopped' }
}

function reportedFailure(
  action: 'launch' | 'inspect',
  observations: readonly TeamLifecycleLaneObservation[],
): TeamLifecycleLaneFailure {
  const phase = observations.some(observation => observation.phase === 'failed') ? 'failed' : 'idle'
  return { action, code: `lane_reported_${phase}`, message: `A lane reported ${phase} for the run` }
}

function launchCompletion(
  observations: readonly TeamLifecycleLaneObservation[],
): TeamLifecycleLaneObservation {
  if (observations.every(observation => observation.phase === 'running')) {
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

function decodeState(value: unknown): DurableState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid team lifecycle state')
  const record = value as Record<string, unknown>
  const keys = ['schemaVersion', 'revision', 'planFingerprint', 'toolApprovalMode', 'phase', 'runId', 'recoverable',
    ...(Object.hasOwn(record, 'failure') ? ['failure'] : [])]
  if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key)) ||
    (record.failure !== undefined && record.phase !== 'failed') ||
    record.schemaVersion !== 2 || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0 ||
    typeof record.planFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.planFingerprint) ||
    !['idle', 'launching', 'running', 'stopping', 'failed'].includes(String(record.phase)) ||
    !(record.runId === null || typeof record.runId === 'string' && /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/.test(record.runId)) ||
    !['manual', 'auto'].includes(String(record.toolApprovalMode)) ||
    typeof record.recoverable !== 'boolean') throw new Error('Invalid team lifecycle state')
  if (record.phase === 'idle' ? record.runId !== null : record.runId === null) {
    throw new Error('Invalid team lifecycle state/run binding')
  }
  if (record.failure !== undefined) decodeLaneFailure(record.failure)
  return record as DurableState
}
