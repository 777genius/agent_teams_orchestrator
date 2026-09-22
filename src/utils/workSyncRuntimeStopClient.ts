import { closeLocalWorkSyncAdmissionForUserStop, persistBoundWorkSyncAdmissionLiveState } from './workSyncContinuationAdmission.js'
import { getTeamName, getAgentName } from './teammate.js'
import type { QueryGuard } from './QueryGuard.js'

export async function postMemberWorkSyncRuntimeStop(input: {
  localStopId: string
  reason: string
  runtimeInstanceId: string
}): Promise<'applied' | 'unknown'> {
  const baseUrl = process.env.CLAUDE_TEAM_CONTROL_URL?.trim()
  const teamName = getTeamName()
  const memberName = getAgentName()
  if (!baseUrl || !teamName || !memberName) {
    return 'unknown'
  }
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, '')}/api/teams/${encodeURIComponent(teamName)}/member-work-sync/${encodeURIComponent(memberName)}/runtime-stop`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runtimeInstanceId: input.runtimeInstanceId,
          localStopId: input.localStopId,
          reason: input.reason,
        }),
      },
    )
    return response.ok ? 'applied' : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function requestLocalWorkSyncUserStop(guard: QueryGuard): void {
  closeLocalWorkSyncAdmissionForUserStop(guard)
  void persistBoundWorkSyncAdmissionLiveState()
  void postMemberWorkSyncRuntimeStop({
    localStopId: `local-stop:${guard.runtimeInstanceId}:${guard.generation}`,
    reason: 'runtime_local_user_stop',
    runtimeInstanceId: guard.runtimeInstanceId,
  })
}
