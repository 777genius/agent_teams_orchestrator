import { randomUUID } from 'node:crypto'

import { createOwnedOpenCodeLifecycleCommandExecutor } from '../opencode/OpenCodeBridgeCommandHandler.js'
import { openCodeSessionStore } from '../opencode/OpenCodeSessionStore.js'
import type { TeamLifecycleLaunchLane, TeamLifecycleLaunchPlan } from './TeamLifecycleLaunchPlan.js'

export type TeamLifecycleLanePhase = 'idle' | 'launching' | 'running' | 'failed'

export type TeamLifecycleLaneObservation = {
  phase: TeamLifecycleLanePhase
  recoverable: boolean
}

export interface TeamLifecycleLaneEffectPort {
  readonly kind: TeamLifecycleLaunchLane['kind']
  supports(action: 'launch' | 'cancel' | 'stop' | 'recover'): boolean
  /** Optional whole-plan topology admission; absent admits every plan containing this lane kind. */
  supportsPlan?(plan: TeamLifecycleLaunchPlan): boolean
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
}

type ExecuteBridge = ReturnType<typeof createOwnedOpenCodeLifecycleCommandExecutor>

/**
 * The in-process owner has no separate bridge handshake; the bridge only
 * requires a non-empty identity and never compares it.
 */
const LIFECYCLE_OWNER_HANDSHAKE_IDENTITY = 'hosted-lifecycle-owner/v1'

/** Capability the bridge committed for this exact run, or null before any session record exists. */
export type ReadLaunchedCapability = (input: { teamId: string; laneId: string; runId: string }) => Promise<string | null>

const readLaunchedCapability: ReadLaunchedCapability = async ({ teamId, laneId, runId }) => {
  const ids = new Set((await openCodeSessionStore.list())
    .filter(record => record.teamId === teamId && (record.laneId ?? 'primary') === laneId && record.runId === runId)
    .map(record => record.stopAuthority?.runtime.capabilitySnapshotId))
  const [only] = ids
  return ids.size === 1 && typeof only === 'string' && /^opencode:[a-f0-9]{32}$/.test(only) ? only : null
}

export function createProductionOpenCodeTeamLifecycleLane(
  hasLiveCapability: () => boolean = () => true,
): OpenCodeTeamLifecycleLane {
  const executeBridge = createOwnedOpenCodeLifecycleCommandExecutor()
  return new OpenCodeTeamLifecycleLane(executeBridge, 300_000, hasLiveCapability)
}

/** Existing OpenCode bridge is the sole production effect owner for OpenCode sessions. */
export class OpenCodeTeamLifecycleLane implements TeamLifecycleLaneEffectPort {
  readonly kind = 'opencode' as const
  readonly #queues = new Map<string, Promise<void>>()
  /** Capability the bridge reported for each run this process launched. */
  readonly #launchedCapabilities = new Map<string, string>()

  constructor(
    private readonly executeBridge: ExecuteBridge = createOwnedOpenCodeLifecycleCommandExecutor(),
    private readonly timeoutMs = 300_000,
    private readonly hasLiveCapability: () => boolean = () => false,
    private readonly readCapability: ReadLaunchedCapability = readLaunchedCapability,
  ) {}

  supports(): boolean { return this.hasLiveCapability() }

  /**
   * Capability the bridge reported when this process launched the run.
   * Non-Cursor session records carry no stop authority, so delivery to the
   * run's retained host has no other source for it.
   */
  launchedCapability(input: { teamId: string; laneId: string; runId: string }): string | null {
    return this.#launchedCapabilities.get(runKey(input.teamId, input.laneId, input.runId)) ?? null
  }

  async inspect(input: {
    planTeamId: string
    workspaceRoot: string
    toolApprovalMode: 'manual' | 'auto'
    lane: TeamLifecycleLaunchLane
    runId: string | null
  }): Promise<TeamLifecycleLaneObservation> {
    if (input.lane.kind !== 'opencode' || !input.runId) return idle()
    const runId = input.runId
    return this.#serialized(input, async () => {
      // With a committed capability the bridge reconciles on the run's own
      // retained host; without it only a generic probe is possible, which may
      // evict that host.
      const capabilitySnapshotId = this.#launchedCapabilities.get(runKey(input.planTeamId, input.lane.laneId, runId))
        ?? await this.readCapability({ teamId: input.planTeamId, laneId: input.lane.laneId, runId })
      const data = await this.#execute('opencode.reconcileTeam', input.workspaceRoot, {
        runId,
        laneId: input.lane.laneId,
        teamId: input.planTeamId,
        ...(capabilitySnapshotId ? {
          expectedCapabilitySnapshotId: capabilitySnapshotId,
          preconditions: {
            handshakeIdentityHash: LIFECYCLE_OWNER_HANDSHAKE_IDENTITY,
            laneId: input.lane.laneId,
            expectedRunId: runId,
            expectedCapabilitySnapshotId: capabilitySnapshotId,
            expectedBehaviorFingerprint: null,
            expectedManifestHighWatermark: null,
            commandLeaseId: null,
            idempotencyKey: `hosted-reconcile:${input.planTeamId}:${input.lane.laneId}:${runId}:${randomUUID()}`,
          },
        } : {}),
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
    toolApprovalMode: 'manual' | 'auto'
    lane: TeamLifecycleLaunchLane
    runId: string
  }): Promise<TeamLifecycleLaneObservation> {
    if (input.lane.kind !== 'opencode') throw new Error('OpenCode lane received a native plan')
    const lane = input.lane
    return this.#serialized(input, async () => {
      // Strict launch only accepts the behavior fingerprint that a selected
      // execution-proof readiness attested for this project, model and host.
      const expectedBehaviorFingerprint = await this.#attestLaunchBehavior(input.workspaceRoot, lane.selectedModel)
      const response = await this.#executeCommand('opencode.launchTeam', input.workspaceRoot, {
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
        preconditions: {
          handshakeIdentityHash: LIFECYCLE_OWNER_HANDSHAKE_IDENTITY,
          laneId: lane.laneId,
          expectedRunId: input.runId,
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint,
          expectedManifestHighWatermark: null,
          // Caller-owned host lease for this single launch attempt.
          commandLeaseId: `hosted-launch-lease_${randomUUID()}`,
          idempotencyKey: `hosted-launch:${input.planTeamId}:${lane.laneId}:${input.runId}`,
        },
      })
      const runtime = response.runtime
      const capability = runtime && typeof runtime === 'object'
        ? (runtime as Record<string, unknown>).capabilitySnapshotId
        : undefined
      if (typeof capability === 'string' && /^opencode:[a-f0-9]{32}$/.test(capability)) {
        this.#launchedCapabilities.set(runKey(input.planTeamId, lane.laneId, input.runId), capability)
      }
      return launchObservation(asRecord(response.data))
    })
  }

  async #attestLaunchBehavior(workspaceRoot: string, selectedModel: string): Promise<string> {
    const readiness = await this.#execute('opencode.readiness', workspaceRoot, {
      projectPath: workspaceRoot,
      selectedModel,
      requireExecutionProbe: true,
    })
    if (readiness.launchAllowed !== true) {
      const state = typeof readiness.state === 'string' ? readiness.state : 'unknown'
      const missing = Array.isArray(readiness.missing)
        ? readiness.missing.filter((item): item is string => typeof item === 'string')
        : []
      throw new Error(`OpenCode readiness does not allow launch (${state})${missing.length ? `: ${missing.join('; ')}` : ''}`)
    }
    const fingerprint = asRecord(readiness.expectedBehaviorEvidence).expectedBehaviorFingerprint
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error('OpenCode readiness did not attest an expected behavior fingerprint')
    }
    return fingerprint
  }

  cancel(input: {
    planTeamId: string
    workspaceRoot: string
    toolApprovalMode: 'manual' | 'auto'
    lane: TeamLifecycleLaunchLane
    runId: string
  }): Promise<TeamLifecycleLaneObservation> {
    return this.#serialized(input, () => this.#stop(input))
  }

  stop(input: {
    planTeamId: string
    workspaceRoot: string
    toolApprovalMode: 'manual' | 'auto'
    lane: TeamLifecycleLaunchLane
    runId: string
  }): Promise<TeamLifecycleLaneObservation> {
    return this.#serialized(input, () => this.#stop(input))
  }

  async recover(input: {
    planTeamId: string
    workspaceRoot: string
    toolApprovalMode: 'manual' | 'auto'
    lane: TeamLifecycleLaunchLane
    runId: string
  }): Promise<TeamLifecycleLaneObservation> {
    // Recovery is a confirmed cleanup to idle. A new launch requires a fresh command/revision.
    return this.#serialized(input, () => this.#stop(input))
  }

  async #stop(input: {
    planTeamId: string
    workspaceRoot: string
    toolApprovalMode: 'manual' | 'auto'
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
    this.#launchedCapabilities.delete(runKey(input.planTeamId, input.lane.laneId, input.runId))
    return idle()
  }

  async #execute(
    command: 'opencode.readiness' | 'opencode.launchTeam' | 'opencode.reconcileTeam' | 'opencode.stopTeam',
    cwd: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return asRecord((await this.#executeCommand(command, cwd, body)).data)
  }

  async #executeCommand(
    command: 'opencode.readiness' | 'opencode.launchTeam' | 'opencode.reconcileTeam' | 'opencode.stopTeam',
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
    return record
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

function runKey(teamId: string, laneId: string, runId: string): string {
  return JSON.stringify([teamId, laneId, runId])
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
