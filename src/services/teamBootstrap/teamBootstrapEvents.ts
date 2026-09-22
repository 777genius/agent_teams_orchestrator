import { randomUUID } from 'crypto'
import type { StructuredIO } from 'src/cli/structuredIO.js'
import { getSessionId } from 'src/bootstrap/state.js'
import type { TeamBootstrapPhase } from './teamBootstrapStateMachine.js'

type EmitPayload = Record<string, unknown>

const MAX_BOOTSTRAP_PROGRESS_REASON_CHARS = 500

function sanitizeBootstrapProgressReason(reason: string): string {
  return reason
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{32,})\b/g, '[redacted]')
    .replace(/\/[^\s"'`]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BOOTSTRAP_PROGRESS_REASON_CHARS)
}

export type TeamBootstrapProgressSink = {
  started(expectedMembers: string[]): Promise<void>
  phaseChanged(phase: TeamBootstrapPhase): Promise<void>
  teamCreated(reusedExistingTeam: boolean): Promise<void>
  memberSpawnStarted(memberName: string): Promise<void>
  memberSpawnResult(payload: {
    memberName: string
    outcome: 'spawned' | 'duplicate_pending' | 'already_running' | 'failed'
    agentId?: string
    teammateId?: string
    backendType?: string
    reason?: string
  }): Promise<void>
  completed(payload: {
    status: 'completed' | 'partial_success'
    expectedMembers: string[]
    registeredMembers: string[]
    failedMembers: Array<{ name: string; reason: string }>
  }): Promise<void>
  failed(reason: string): Promise<void>
}

export class TeamBootstrapProgressEmitter implements TeamBootstrapProgressSink {
  private sequence = 0

  constructor(
    private readonly structuredIO: StructuredIO,
    private readonly runId: string,
    private readonly teamName: string,
  ) {}

  private async emit(payload: EmitPayload): Promise<void> {
    this.sequence += 1
    await this.structuredIO.write({
      type: 'system',
      subtype: 'team_bootstrap',
      uuid: randomUUID(),
      session_id: getSessionId(),
      run_id: this.runId,
      team_name: this.teamName,
      seq: this.sequence,
      ...payload,
    } as never)
  }

  async started(expectedMembers: string[]): Promise<void> {
    await this.emit({ event: 'started', expected_members: expectedMembers })
  }

  async phaseChanged(phase: TeamBootstrapPhase): Promise<void> {
    await this.emit({ event: 'phase_changed', phase })
  }

  async teamCreated(reusedExistingTeam: boolean): Promise<void> {
    await this.emit({
      event: 'team_created',
      reused_existing_team: reusedExistingTeam,
    })
  }

  async memberSpawnStarted(memberName: string): Promise<void> {
    await this.emit({ event: 'member_spawn_started', member_name: memberName })
  }

  async memberSpawnResult(payload: {
    memberName: string
    outcome: 'spawned' | 'duplicate_pending' | 'already_running' | 'failed'
    agentId?: string
    teammateId?: string
    backendType?: string
    reason?: string
  }): Promise<void> {
    await this.emit({
      event: 'member_spawn_result',
      member_name: payload.memberName,
      outcome: payload.outcome,
      ...(payload.agentId ? { agent_id: payload.agentId } : {}),
      ...(payload.teammateId ? { teammate_id: payload.teammateId } : {}),
      ...(payload.backendType ? { backend_type: payload.backendType } : {}),
      ...(payload.reason ? { reason: sanitizeBootstrapProgressReason(payload.reason) } : {}),
    })
  }

  async completed(payload: {
    status: 'completed' | 'partial_success'
    expectedMembers: string[]
    registeredMembers: string[]
    failedMembers: Array<{ name: string; reason: string }>
  }): Promise<void> {
    await this.emit({
      event: 'completed',
      status: payload.status,
      expected_members: payload.expectedMembers,
      registered_members: payload.registeredMembers,
      failed_members: payload.failedMembers.map(member => ({
        ...member,
        reason: sanitizeBootstrapProgressReason(member.reason),
      })),
    })
  }

  async failed(reason: string): Promise<void> {
    await this.emit({ event: 'failed', reason: sanitizeBootstrapProgressReason(reason) })
  }
}

export const NoopTeamBootstrapProgressSink: TeamBootstrapProgressSink = {
  async started() {},
  async phaseChanged() {},
  async teamCreated() {},
  async memberSpawnStarted() {},
  async memberSpawnResult() {},
  async completed() {},
  async failed() {},
}
