import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

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
  TeamLifecycleLaneObservation,
} from './OpenCodeTeamLifecycleLane.js'

type DurableState = {
  schemaVersion: 2
  revision: number
  planFingerprint: string
  toolApprovalMode: TeamLifecycleLaunchPlan['toolApprovalMode']
  phase: HostedLifecycleProviderSnapshot['phase']
  runId: string | null
  recoverable: boolean
}

type LaneInput = {
  planTeamId: string
  workspaceRoot: string
  toolApprovalMode: TeamLifecycleLaunchPlan['toolApprovalMode']
  lane: TeamLifecycleLaunchPlan['lanes'][number]
  runId: string
}

type EffectGuard = NonNullable<TeamLifecycleOwnerEffectInput['effectGuard']>
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
) => Promise<TeamLifecycleRunReservation | null>

export type DurableTeamLifecycleExecutionOptions = {
  runReservation?: TeamLifecycleRunReservationPort
  /** Hosted composition can require the port before accepting any launch. */
  requireRunReservation?: boolean
  reservationTimeoutMs?: number
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
    return this.#acceptingEffects &&
      plan.lanes.every(lane => this.#adapters.get(lane.kind)?.supports(action) === true)
  }

  inspect(plan: TeamLifecycleLaunchPlan): Promise<HostedLifecycleProviderSnapshot> {
    this.#rememberPlan(plan)
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
        const observations = await this.#inspectLanes(plan, state.runId)
        if (observations.some(observation => observation.phase === 'failed' || observation.phase === 'idle')) {
          state = await this.#write({ ...state, phase: 'failed', recoverable: true }, plan)
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
        const reservation = await this.#resolveReservation(binding)
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
      this.#trackJob(runId, this.#completeLaunch(input.plan, runId, input.effectGuard ?? EFFECT_ALLOWED))
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
        input.effectGuard ?? EFFECT_ALLOWED,
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
    for (const plan of this.#knownPlans.values()) {
      await this.#serialized(async () => {
        const current = await this.#read(plan)
        if (current.phase !== 'running' || !current.runId || !this.#ownedRuns.has(current.runId)) return
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
      if (current.runId === runId && current.phase === 'running') return
      if (current.runId !== runId || current.phase !== 'launching') {
        await this.#applyLanes(plan, runId, 'stop', effectGuard).catch(() => [])
        return
      }
      const next = launchCompletion(observations)
      if (next.phase === 'launching') return
      await this.#write({
        ...current,
        phase: next.phase,
        recoverable: next.recoverable,
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
      if (current.runId !== runId || current.phase !== 'stopping') return
      await this.#write({
        ...current,
        phase: stopped ? 'idle' : 'failed',
        runId: stopped ? null : runId,
        recoverable: !stopped,
      }, plan)
      if (stopped) this.#ownedRuns.delete(runId)
    })
  }

  async #reconcileLaunching(plan: TeamLifecycleLaunchPlan, state: DurableState): Promise<DurableState> {
    let observations: TeamLifecycleLaneObservation[]
    try {
      observations = await this.#inspectLanes(plan, state.runId!)
    } catch {
      observations = [{ phase: 'failed', recoverable: true }]
    }
    const next = launchCompletion(observations)
    if (next.phase === 'launching') return state
    return this.#write({ ...state, phase: next.phase, recoverable: next.recoverable }, plan)
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
        runId,
      })
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
      }
      // No asynchronous boundary may exist between the authority comparison and
      // invoking the provider adapter: a queued launch can outlive its request.
      if (!(await effectGuard())) throw new Error('Team lifecycle effect authority changed')
      const observation = await adapter[action](laneInput)
      if (!(await effectGuard())) {
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
      return await Promise.race([reserve(binding, controller.signal), aborted])
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
    const state: DurableState = {
      ...input,
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
    const prior = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => { release = resolve })
    await prior
    try { return await operation() } finally { release() }
  }
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
  const keys = ['schemaVersion', 'revision', 'planFingerprint', 'toolApprovalMode', 'phase', 'runId', 'recoverable']
  if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key)) ||
    record.schemaVersion !== 2 || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0 ||
    typeof record.planFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.planFingerprint) ||
    !['idle', 'launching', 'running', 'stopping', 'failed'].includes(String(record.phase)) ||
    !(record.runId === null || typeof record.runId === 'string' && /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/.test(record.runId)) ||
    !['manual', 'auto'].includes(String(record.toolApprovalMode)) ||
    typeof record.recoverable !== 'boolean') throw new Error('Invalid team lifecycle state')
  if (record.phase === 'idle' ? record.runId !== null : record.runId === null) {
    throw new Error('Invalid team lifecycle state/run binding')
  }
  return record as DurableState
}
