import type { OpenCodeHostLeaseInput } from '../../../src/services/opencode/OpenCodeHostManager.js'
import type { HostedApprovalRuntimeRoute } from '../../../src/services/hostedControl/HostedApprovalRuntimeAdmission.js'

/** Ordinary creation leases carry the admitted run; retained-session leases
 * carry the exact OpenCode session. Neither permits another team/lane/member. */
export function matchesNativeLifecycleLease(lease: OpenCodeHostLeaseInput, route: HostedApprovalRuntimeRoute): boolean {
  return lease.teamId === route.authority.teamId && lease.laneId === route.authority.laneId &&
    lease.memberName === route.memberName && (lease.sessionId != null
      ? lease.sessionId === route.authority.sessionId && (lease.runId == null || lease.runId === route.authority.runId)
      : lease.runId === route.authority.runId)
}
