import { assertValidGroupMailboxRows, buildGroupMailboxPrompt, hasGroupChatTools, hasGroupMailboxMarker } from '../../../utils/groupMailbox.js'
import { executionAssert } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { OpenCodeGroupChatRunProof } from '../OpenCodeGroupChatCapability.js'
import type { RunBinding, RunMemberStatus } from './OpenCodeV2RunTypes.js'
import type { ControllerToolProof } from './OpenCodeV2ControllerTools.js'

/** App group origin retained in the immutable intent, never forwarded as SDK options. */
export type OpenCodeV2GroupDelivery = {
  groupChatId: string; groupMessageId: string; groupChatProtocolVersion: 1; groupRunKey: string;
  from: string; timestamp: string; text: string; groupChatName?: string; relayOfMessageId?: string;
}
export function parseOpenCodeV2GroupDelivery(body: Record<string, unknown>, physicalMessageId: string): OpenCodeV2GroupDelivery | undefined {
  if (!hasGroupMailboxMarker(body)) return undefined
  executionAssert(typeof body.groupChatId === 'string' && body.groupChatProtocolVersion === 1 &&
    typeof body.groupRunKey === 'string' && body.groupRunKey.length > 0 && physicalMessageId !== body.groupMessageId,
    'GROUP_INVALID_ENVELOPE')
  assertValidGroupMailboxRows([{ ...body, messageId: physicalMessageId, read: false }])
  return { groupChatId: body.groupChatId, groupMessageId: body.groupMessageId as string,
    groupChatProtocolVersion: 1, groupRunKey: body.groupRunKey, from: body.from as string,
    timestamp: body.timestamp as string, text: body.text as string,
    ...(body.groupChatName === undefined ? {} : { groupChatName: body.groupChatName as string }),
    ...(body.relayOfMessageId === undefined ? {} : { relayOfMessageId: body.relayOfMessageId as string }) }
}
export function assertOpenCodeV2GroupProof(binding: Pick<RunBinding, 'teamId' | 'runId'>, proof: OpenCodeGroupChatRunProof,
  member: { memberId: string; laneId: string; originalSessionId: string; runtimePid?: number }): void {
  executionAssert(proof.processorReady === true && proof.teamName === binding.teamId &&
    proof.runId === binding.runId && proof.runKey === binding.runId && proof.memberName === member.memberId &&
    proof.laneId === member.laneId && proof.runtimeSessionId === member.originalSessionId &&
    proof.runtimePid === member.runtimePid, 'GROUP_RECIPIENT_INCOMPATIBLE')
}
export function assertOpenCodeV2GroupBinding(group: OpenCodeV2GroupDelivery, binding: Pick<RunBinding, 'teamId' | 'runId'>, proof: OpenCodeGroupChatRunProof,
  member: { memberId: string; laneId: string; originalSessionId: string; runtimePid?: number }): void {
  executionAssert(group.groupRunKey === binding.runId, 'GROUP_RECIPIENT_INCOMPATIBLE')
  assertOpenCodeV2GroupProof(binding, proof, member)
}
/** Called only after the original lease client re-read its session and current MCP tools. */
export function buildOpenCodeV2GroupProof(binding: Pick<RunBinding, 'teamId' | 'runId'>, member: RunMemberStatus, tools: ControllerToolProof): OpenCodeGroupChatRunProof | null {
  executionAssert(member.state === 'accepted' && member.bootstrap?.verified === true &&
    member.bootstrap.strategy === 'instruction-entry' && member.bootstrap.missingNativeMessageID === true &&
    member.originalSessionId === member.runtimeSessionId && member.originalSessionId === member.opencodeSessionId &&
    Number.isSafeInteger(member.runtimePid) && member.runtimePid! > 0 && tools.server === 'agent-teams' &&
    /^[a-f0-9]{64}$/.test(tools.schemasHash), 'GROUP_RECIPIENT_INCOMPATIBLE')
  if (!hasGroupChatTools(tools.tools)) return null
  return { teamName: binding.teamId, memberName: member.memberId, runId: binding.runId, runKey: binding.runId,
    laneId: member.laneId, runtimePid: member.runtimePid!, runtimeSessionId: member.originalSessionId, processorReady: true,
    ...(tools.tools.some(tool => /^(?:group_chat_react|agent-teams_group_chat_react|agent_teams_group_chat_react|mcp__agent-teams__group_chat_react|mcp__agent_teams__group_chat_react)$/.test(tool.name))
      ? { groupReactionProtocolVersion: 1 as const } : {}) }
}
export function openCodeV2GroupPrompt(group: OpenCodeV2GroupDelivery, physicalMessageId: string, teamName: string, memberName: string): string {
  return buildGroupMailboxPrompt({ ...group, messageId: physicalMessageId }, teamName, memberName) +
    `\nGroup delivery binding: ${JSON.stringify({ groupRunKey: group.groupRunKey, relayOfMessageId: group.relayOfMessageId ?? null })}`
}
