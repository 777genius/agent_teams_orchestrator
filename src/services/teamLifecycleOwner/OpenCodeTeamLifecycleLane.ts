import { randomUUID } from 'node:crypto'

import { createOwnedOpenCodeLifecycleCommandExecutor } from '../opencode/OpenCodeBridgeCommandHandler.js'
import type { TeamLifecycleLaunchLane } from './TeamLifecycleLaunchPlan.js'

export type TeamLifecycleLanePhase = 'idle' | 'launching' | 'running' | 'failed'

export type TeamLifecycleLaneObservation = {
  phase: TeamLifecycleLanePhase
  recoverable: boolean
}

export interface TeamLifecycleLaneEffectPort {
  readonly kind: TeamLifecycleLaunchLane['kind']
  supports(action: 'launch' | 'cancel' | 'stop' | 'recover'): boolean
  inspect(input: { planTeamId: string; workspaceRoot: string; lane: TeamLifecycleLaunchLane; runId: string | null }): Promise<TeamLifecycleLaneObservation>
  launch(input: { planTeamId: string; workspaceRoot: string; lane: TeamLifecycleLaunchLane; runId: string }): Promise<TeamLifecycleLaneObservation>
  cancel(input: { planTeamId: string; workspaceRoot: string; lane: TeamLifecycleLaunchLane; runId: string }): Promise<TeamLifecycleLaneObservation>
  stop(input: { planTeamId: string; workspaceRoot: string; lane: TeamLifecycleLaunchLane; runId: string }): Promise<TeamLifecycleLaneObservation>
  recover(input: { planTeamId: string; workspaceRoot: string; lane: TeamLifecycleLaunchLane; runId: string }): Promise<TeamLifecycleLaneObservation>
}

type ExecuteBridge = ReturnType<typeof createOwnedOpenCodeLifecycleCommandExecutor>

export function createProductionOpenCodeTeamLifecycleLane(): OpenCodeTeamLifecycleLane {
  const executeBridge = createOwnedOpenCodeLifecycleCommandExecutor()
  return new OpenCodeTeamLifecycleLane(executeBridge, 300_000, () => true)
}

/** Existing OpenCode bridge is the sole production effect owner for OpenCode sessions. */
export class OpenCodeTeamLifecycleLane implements TeamLifecycleLaneEffectPort {
  readonly kind = 'opencode' as const
  readonly #queues = new Map<string, Promise<void>>()

  constructor(
    private readonly executeBridge: ExecuteBridge = createOwnedOpenCodeLifecycleCommandExecutor(),
    private readonly timeoutMs = 300_000,
    private readonly hasLiveCapability: () => boolean = () => false,
  ) {}

  supports(): boolean { return this.hasLiveCapability() }

  async inspect(input: {
    planTeamId: string
    workspaceRoot: string
    lane: TeamLifecycleLaunchLane
    runId: string | null
  }): Promise<TeamLifecycleLaneObservation> {
    if (input.lane.kind !== 'opencode' || !input.runId) return idle()
    return this.#serialized(input, async () => {
      const data = await this.#execute('opencode.reconcileTeam', input.workspaceRoot, {
        runId: input.runId,
        laneId: input.lane.laneId,
        teamId: input.planTeamId,
        expectedMembers: input.lane.members.map(member => ({
          name: member.name,
          ...(member.model ? { model: member.model } : {}),
        })),
      })
      return launchObservation(data)
    })
  }

  async launch(input: {
    planTeamId: string
    workspaceRoot: string
    lane: TeamLifecycleLaunchLane
    runId: string
  }): Promise<TeamLifecycleLaneObservation> {
    if (input.lane.kind !== 'opencode') throw new Error('OpenCode lane received a native plan')
    const lane = input.lane
    return this.#serialized(input, async () => {
      const data = await this.#execute('opencode.launchTeam', input.workspaceRoot, {
        runId: input.runId,
        laneId: lane.laneId,
        teamId: input.planTeamId,
        projectPath: input.workspaceRoot,
        selectedModel: lane.selectedModel,
        ...(lane.effort ? { effort: lane.effort } : {}),
        members: lane.members.map(member => ({
          name: member.name,
          prompt: member.prompt,
          ...(member.model ? { model: member.model } : {}),
          ...(member.effort ? { effort: member.effort } : {}),
        })),
      })
      return launchObservation(data)
    })
  }

  cancel(input: {
    planTeamId: string
    workspaceRoot: string
    lane: TeamLifecycleLaunchLane
    runId: string
  }): Promise<TeamLifecycleLaneObservation> {
    return this.#serialized(input, () => this.#stop(input))
  }

  stop(input: {
    planTeamId: string
    workspaceRoot: string
    lane: TeamLifecycleLaunchLane
    runId: string
  }): Promise<TeamLifecycleLaneObservation> {
    return this.#serialized(input, () => this.#stop(input))
  }

  async recover(input: {
    planTeamId: string
    workspaceRoot: string
    lane: TeamLifecycleLaunchLane
    runId: string
  }): Promise<TeamLifecycleLaneObservation> {
    // Recovery is a confirmed cleanup to idle. A new launch requires a fresh command/revision.
    return this.#serialized(input, () => this.#stop(input))
  }

  async #stop(input: {
    planTeamId: string
    workspaceRoot: string
    lane: TeamLifecycleLaunchLane
    runId: string
  }): Promise<TeamLifecycleLaneObservation> {
    if (input.lane.kind !== 'opencode') throw new Error('OpenCode lane received a native plan')
    const data = await this.#execute('opencode.stopTeam', input.workspaceRoot, {
      runId: input.runId,
      laneId: input.lane.laneId,
      teamId: input.planTeamId,
    })
    if (data.stopped !== true) throw new Error('OpenCode bridge did not confirm lane stop')
    return idle()
  }

  async #execute(
    command: 'opencode.launchTeam' | 'opencode.reconcileTeam' | 'opencode.stopTeam',
    cwd: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.hasLiveCapability()) throw new Error('OpenCode lifecycle owner capability is unavailable')
    const response: unknown = await this.executeBridge({
      schemaVersion: 1,
      requestId: `hosted-lifecycle-${randomUUID()}`,
      command,
      cwd,
      startedAt: new Date().toISOString(),
      timeoutMs: this.timeoutMs,
      body,
    })
    const record = asRecord(response)
    if (record.ok !== true) {
      const error = asRecord(record.error)
      throw new Error(typeof error.message === 'string' ? error.message : 'OpenCode bridge command failed')
    }
    return asRecord(record.data)
  }

  async #serialized<T>(
    input: { planTeamId: string; lane: TeamLifecycleLaunchLane; runId: string | null },
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${input.planTeamId}\0${input.lane.laneId}`
    const prior = this.#queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = prior.then(() => current)
    this.#queues.set(key, tail)
    await prior
    try {
      return await operation()
    } finally {
      release()
      if (this.#queues.get(key) === tail) this.#queues.delete(key)
    }
  }
}

function launchObservation(data: Record<string, unknown>): TeamLifecycleLaneObservation {
  switch (data.teamLaunchState) {
    case 'ready': return { phase: 'running', recoverable: false }
    case 'launching':
    case 'permission_blocked': return { phase: 'launching', recoverable: false }
    case 'failed': return { phase: 'failed', recoverable: true }
    default: throw new Error('OpenCode bridge returned an invalid team launch state')
  }
}

function idle(): TeamLifecycleLaneObservation {
  return { phase: 'idle', recoverable: false }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode bridge returned an invalid response')
  }
  return value as Record<string, unknown>
}
