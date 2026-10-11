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

// A retained host/session and a fresh tools/list are required. Version labels,
// cached tool proofs and a lightweight launch handshake cannot attest a run.
export function buildOpenCodeGroupChatRunProof(
  snapshot: OpenCodeProvisioningSnapshot | null,
  record: OpenCodeSessionRecord,
  observedTools: readonly string[],
): OpenCodeGroupChatRunProof | undefined {
  const host = snapshot?.host
  const config = host?.profile.managedConfig.mcp?.['agent-teams']
  const binding = { ...host?.profile.env, ...config?.environment }
  const pid = record.runtimePid
  if (!host || host.state !== 'healthy' || !snapshot?.hostHealthy || !Number.isSafeInteger(pid) || pid <= 0 || host.pid !== pid || host.hostKey !== record.hostKey ||
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
