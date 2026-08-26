import { createHash, randomUUID } from 'node:crypto'

import { createOwnedOpenCodeLifecycleCommandExecutor } from '../opencode/OpenCodeBridgeCommandHandler.js'
import type { TeamLifecycleLaunchLane } from './TeamLifecycleLaunchPlan.js'

export type TeamLifecycleLanePhase = 'idle' | 'launching' | 'running' | 'failed'

export type TeamLifecycleLaneObservation = {
  phase: TeamLifecycleLanePhase
  recoverable: boolean
  /** Digest of the exact provider session set, persisted before recovery adoption. */
  recoveryBinding?: string
}

export interface TeamLifecycleLaneEffectPort {
  readonly kind: TeamLifecycleLaunchLane['kind']
  supports(action: 'launch' | 'cancel' | 'stop' | 'recover'): boolean
  inspect(input: TeamLifecycleLaneInput & { runId: string | null }): Promise<TeamLifecycleLaneObservation>
  launch(input: TeamLifecycleLaneInput & { runId: string }): Promise<TeamLifecycleLaneObservation>
  cancel(input: TeamLifecycleLaneInput & { runId: string }): Promise<TeamLifecycleLaneObservation>
  stop(input: TeamLifecycleLaneInput & { runId: string }): Promise<TeamLifecycleLaneObservation>
  recover(input: TeamLifecycleLaneInput & { runId: string }): Promise<TeamLifecycleLaneObservation>
}

export type TeamLifecycleLaneInput = {
  planTeamId: string
  workspaceRoot: string
  toolApprovalMode: 'manual' | 'auto'
  lane: TeamLifecycleLaunchLane
  /** Checked inside the lane queue immediately before a provider mutation. */
  effectGuard?: () => boolean | Promise<boolean>
  signal?: AbortSignal
  recoveryBinding?: string
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

  async inspect(input: TeamLifecycleLaneInput & { runId: string | null }): Promise<TeamLifecycleLaneObservation> {
    if (input.lane.kind !== 'opencode' || !input.runId) return idle()
    return this.#serialized(input, async () => {
      const data = await this.#execute('opencode.reconcileTeam', input.workspaceRoot, {
        runId: input.runId,
        laneId: input.lane.laneId,
        teamId: input.planTeamId,
        projectPath: input.workspaceRoot,
        selectedModel: input.lane.selectedModel,
        selectedVariant: input.lane.effort ?? null,
        toolApprovalMode: input.toolApprovalMode,
        expectedMembers: input.lane.members.map(member => ({
          name: member.name,
          model: member.model ?? input.lane.selectedModel,
          variant: member.effort ?? input.lane.effort ?? null,
        })),
      }, input.signal, input.effectGuard)
      return launchObservation(data, input.lane.members.map(member => member.name), input.recoveryBinding)
    })
  }

  async launch(input: TeamLifecycleLaneInput & { runId: string }): Promise<TeamLifecycleLaneObservation> {
    if (input.lane.kind !== 'opencode') throw new Error('OpenCode lane received a native plan')
    const lane = input.lane
    return this.#serialized(input, async () => {
      await assertEffectGuard(input)
      const data = await this.#execute('opencode.launchTeam', input.workspaceRoot, {
        runId: input.runId,
        laneId: lane.laneId,
        teamId: input.planTeamId,
        projectPath: input.workspaceRoot,
        selectedModel: lane.selectedModel,
        toolApprovalMode: input.toolApprovalMode,
        skipPermissions: input.toolApprovalMode === 'manual' ? false : true,
        ...(lane.effort ? { effort: lane.effort } : {}),
        members: lane.members.map(member => ({
          name: member.name,
          prompt: member.prompt,
          ...(member.model ? { model: member.model } : {}),
          ...(member.effort ? { effort: member.effort } : {}),
        })),
      }, input.signal, input.effectGuard)
      return launchObservation(data, input.lane.members.map(member => member.name))
    })
  }

  cancel(input: TeamLifecycleLaneInput & { runId: string }): Promise<TeamLifecycleLaneObservation> {
    return this.#serialized(input, () => this.#stop(input))
  }

  stop(input: TeamLifecycleLaneInput & { runId: string }): Promise<TeamLifecycleLaneObservation> {
    return this.#serialized(input, () => this.#stop(input))
  }

  async recover(input: TeamLifecycleLaneInput & { runId: string }): Promise<TeamLifecycleLaneObservation> {
    // Recovery is a confirmed cleanup to idle. A new launch requires a fresh command/revision.
    return this.#serialized(input, () => this.#stop(input))
  }

  async #stop(input: TeamLifecycleLaneInput & { runId: string }): Promise<TeamLifecycleLaneObservation> {
    if (input.lane.kind !== 'opencode') throw new Error('OpenCode lane received a native plan')
    await assertEffectGuard(input)
    const data = await this.#execute('opencode.stopTeam', input.workspaceRoot, {
      runId: input.runId,
      laneId: input.lane.laneId,
      teamId: input.planTeamId,
      projectPath: input.workspaceRoot,
      selectedModel: input.lane.selectedModel,
      selectedVariant: input.lane.effort ?? null,
      toolApprovalMode: input.toolApprovalMode,
      expectedMembers: input.lane.members.map(member => ({
        name: member.name,
        model: member.model ?? input.lane.selectedModel,
        variant: member.effort ?? input.lane.effort ?? null,
      })),
    }, input.signal, input.effectGuard)
    if (data.stopped !== true) throw new Error('OpenCode bridge did not confirm lane stop')
    return idle()
  }

  async #execute(
    command: 'opencode.launchTeam' | 'opencode.reconcileTeam' | 'opencode.stopTeam',
    cwd: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    effectGuard?: () => boolean | Promise<boolean>,
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
    }, { signal, effectGuard })
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

async function assertEffectGuard(input: TeamLifecycleLaneInput): Promise<void> {
  if (input.effectGuard && !(await input.effectGuard())) {
    throw new Error('Team lifecycle lane authority changed before provider effect')
  }
}

function launchObservation(
  data: Record<string, unknown>,
  expectedMemberNames: readonly string[],
  expectedRecoveryBinding?: string,
): TeamLifecycleLaneObservation {
  switch (data.teamLaunchState) {
    case 'ready': {
      const recoveryBinding = exactSessionSetBinding(data, expectedMemberNames)
      if (expectedRecoveryBinding && recoveryBinding !== expectedRecoveryBinding) {
        throw new Error('OpenCode lifecycle session set does not match the durable launch binding')
      }
      return { phase: 'running', recoverable: false, recoveryBinding }
    }
    case 'launching':
    case 'permission_blocked': {
      const recoveryBinding = exactSessionSetBinding(data, expectedMemberNames)
      if (expectedRecoveryBinding && recoveryBinding !== expectedRecoveryBinding) {
        throw new Error('OpenCode lifecycle session set does not match the durable launch binding')
      }
      return { phase: 'launching', recoverable: false, recoveryBinding }
    }
    case 'failed': return { phase: 'failed', recoverable: true }
    default: throw new Error('OpenCode bridge returned an invalid team launch state')
  }
}

function exactSessionSetBinding(
  data: Record<string, unknown>,
  expectedMemberNames: readonly string[],
): string {
  const members = asRecord(data.members)
  const tuples = Object.entries(members).map(([memberName, raw]) => {
    const sessionId = asRecord(raw).sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('OpenCode lifecycle response omitted an exact member session id')
    }
    return { memberName, opencodeSessionId: sessionId }
  }).sort((left, right) => left.memberName.localeCompare(right.memberName))
  const expected = [...expectedMemberNames].sort((left, right) => left.localeCompare(right))
  if (tuples.length !== expected.length || tuples.some((tuple, index) => tuple.memberName !== expected[index])) {
    throw new Error('OpenCode lifecycle response changed the exact admitted member set')
  }
  if (tuples.length === 0 || new Set(tuples.map(tuple => tuple.opencodeSessionId)).size !== tuples.length) {
    throw new Error('OpenCode lifecycle response contains a missing or duplicate session id')
  }
  return `session-set_${createHash('sha256').update(JSON.stringify(tuples)).digest('hex')}`
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
