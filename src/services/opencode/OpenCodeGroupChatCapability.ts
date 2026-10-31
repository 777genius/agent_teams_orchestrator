import { isBoundGroupChatControl } from '../../utils/groupChatControlClient.js'
import { hasGroupChatTools } from '../../utils/groupMailbox.js'
import type { OpenCodeProvisioningSnapshot, OpenCodeSessionRecord } from './types.js'

export type OpenCodeGroupChatRunProof = {
  teamName: string
  memberName: string
  runId: string
  runKey: string
  laneId: string | null
  runtimePid: number
  runtimeSessionId: string
  processorReady: true
  groupReactionProtocolVersion?: 1
}

// A retained host or exact owned OAuth endpoint, a matching run/session, and
// fresh tools/list are required. Cached proofs and labels cannot attest a run.
export function buildOpenCodeGroupChatRunProof(
  snapshot: OpenCodeProvisioningSnapshot | null,
  record: OpenCodeSessionRecord,
  observedTools: readonly string[],
  ownedHost?: { hostKey: string; pid: number; controlUrl: string; controlContext: string },
): OpenCodeGroupChatRunProof | undefined {
  const host = snapshot?.host
  const config = host?.profile.managedConfig.mcp?.['agent-teams']
  const binding = host
    ? { ...host.profile.env, ...config?.environment }
    : { AGENT_TEAMS_BOUND_CONTROL_URL: ownedHost?.controlUrl, AGENT_TEAMS_BOUND_CONTEXT_JSON: ownedHost?.controlContext }
  const pid = record.runtimePid
  const hostMatches = host
    ? host.state === 'healthy' && snapshot?.hostHealthy && host.pid === pid && host.hostKey === record.hostKey
    : ownedHost?.pid === pid && ownedHost.hostKey === record.hostKey
  if (!hostMatches || !Number.isSafeInteger(pid) || pid <= 0 ||
      !record.runId || record.stoppedAt || record.staleReason || !record.appManagedBootstrap ||
      record.appManagedBootstrap.schemaVersion !== 1 || !record.appManagedBootstrap.injectionVerifiedAt ||
      !record.opencodeSessionId || snapshot?.mcp?.['agent-teams']?.status !== 'connected' ||
      !isBoundGroupChatControl(binding.AGENT_TEAMS_BOUND_CONTROL_URL, binding.AGENT_TEAMS_BOUND_CONTEXT_JSON) ||
      !hasGroupChatTools(observedTools.map(name => ({ name })))) return undefined
  try { process.kill(pid, 0) } catch { return undefined }
  return {
    teamName: record.teamId, memberName: record.memberName,
    runId: record.runId, runKey: record.runId, laneId: record.laneId ?? null,
    runtimePid: pid, runtimeSessionId: record.opencodeSessionId, processorReady: true, groupReactionProtocolVersion: 1,
  }
}
