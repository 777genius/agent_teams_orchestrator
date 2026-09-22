import type { TeamLifecycleLaunchPlan, TeamLifecycleLaunchPlanV3, TeamLifecycleLaunchLaneV3 } from './TeamLifecycleLaunchPlan.js'

export type NativeLaneAction = 'inspect' | 'launch' | 'cancel' | 'stop' | 'recover'
export type NativeLanePhase = 'idle' | 'launching' | 'running' | 'stopped' | 'failed'
export type NativeLaneObservation = {
  phase: NativeLanePhase
  recoverable: boolean
  recoveryBinding?: string
}

export type NativeLaneRequest = {
  action: NativeLaneAction
  plan: TeamLifecycleLaunchPlanV3
  planTeamId: string
  lane: Extract<TeamLifecycleLaunchLaneV3, { kind: 'native' }>
  /** Owner execution identity; deliberately distinct from plan.runtimePlanRef.runId. */
  runId: string | null
  workspaceRoot: string
  signal?: AbortSignal
  effectGuard?: () => boolean | Promise<boolean>
}

/** Provider-neutral effect boundary. Implementations may use a native SDK, but this lane never does. */
export interface NativeTeamLifecycleLaneExecutor {
  execute(request: NativeLaneRequest): Promise<unknown>
}

export class NativeTeamLifecycleLane {
  readonly kind = 'native' as const
  readonly #queues = new Map<string, Promise<void>>()

  constructor(private readonly executor: NativeTeamLifecycleLaneExecutor) {}

  supports(action: NativeLaneAction, plan: TeamLifecycleLaunchPlan): boolean {
    void action
    return plan.schemaVersion === 3 && plan.lanes.some(lane => lane.kind === 'native')
  }

  async inspect(input: Omit<NativeLaneRequest, 'action' | 'runId'> & { runId?: string | null }): Promise<NativeLaneObservation> {
    return this.#invoke({ ...input, action: 'inspect', runId: input.runId ?? null })
  }
  async launch(input: Omit<NativeLaneRequest, 'action' | 'runId'> & { runId: string }): Promise<NativeLaneObservation> {
    return this.#invoke({ ...input, action: 'launch', runId: input.runId })
  }
  async cancel(input: Omit<NativeLaneRequest, 'action'>): Promise<NativeLaneObservation> { return this.#invoke({ ...input, action: 'cancel' }) }
  async stop(input: Omit<NativeLaneRequest, 'action'>): Promise<NativeLaneObservation> { return this.#invoke({ ...input, action: 'stop' }) }
  async recover(input: Omit<NativeLaneRequest, 'action'>): Promise<NativeLaneObservation> { return this.#invoke({ ...input, action: 'recover' }) }

  async #invoke(request: NativeLaneRequest): Promise<NativeLaneObservation> {
    if (request.plan.schemaVersion !== 3 || request.lane.kind !== 'native' || request.planTeamId !== request.plan.teamId) {
      throw new Error('Native lane requires a matching schema-3 native plan')
    }
    if (request.action !== 'inspect' && !request.runId) throw new Error('Native mutation requires an owner runId')
    const key = `${request.planTeamId}\0${request.lane.laneId}`
    const prior = this.#queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = prior.then(() => gate)
    this.#queues.set(key, tail)
    await prior
    try {
      if (request.signal?.aborted) throw new Error('Native lane operation aborted')
      if (request.action !== 'inspect' && !(await request.effectGuard?.() ?? true)) throw new Error('Native lane effect authority revoked')
      if (request.action !== 'inspect' && request.signal?.aborted) throw new Error('Native lane mutation aborted')
      const result = await this.executor.execute(request)
      if (request.signal?.aborted) throw new Error('Native lane operation aborted')
      return normalize(result, request)
    } finally {
      release()
      if (this.#queues.get(key) === tail) this.#queues.delete(key)
    }
  }
}

function normalize(value: unknown, request: NativeLaneRequest): NativeLaneObservation {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null
  if (!record || record.ok === false) throw new Error('Malformed native lane result')
  const source = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : record
  if (source.planTeamId !== request.planTeamId) throw new Error('Native lane result missing or mismatched team identity')
  if (source.laneId !== request.lane.laneId) throw new Error('Native lane result missing or mismatched lane identity')
  if (source.runId !== request.runId) throw new Error('Native lane result missing or mismatched owner run identity')
  if (source.runtimePlanRunId !== request.plan.runtimePlanRef.runId) throw new Error('Native lane result missing or mismatched runtime plan identity')
  const phase = source.phase ?? source.state ?? source.status
  const phases: Record<string, NativeLanePhase> = { idle: 'idle', stopped: 'stopped', stopping: 'stopped', launching: 'launching', running: 'running', ready: 'running', failed: 'failed' }
  if (typeof phase !== 'string' || !phases[phase]) throw new Error('Native lane result omitted a valid phase')
  const recoveryBinding = source.recoveryBinding
  if (recoveryBinding !== undefined && (typeof recoveryBinding !== 'string' || recoveryBinding.length === 0)) throw new Error('Malformed native recovery binding')
  return { phase: phases[phase], recoverable: source.recoverable === true || phases[phase] === 'failed', ...(recoveryBinding ? { recoveryBinding } : {}) }
}
