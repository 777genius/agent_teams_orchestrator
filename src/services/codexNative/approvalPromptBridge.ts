import type { SDKControlPermissionRequest } from '../../entrypoints/sdk/controlTypes.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { createSyntheticAssistantMessage, createToolStub } from '../../remote/remotePermissionBridge.js'
import type { ToolUseContext } from '../../Tool.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import type {
  CodexAppServerApprovalDecision,
  CodexAppServerApprovalRequestHandler,
  CodexAppServerToolApprovalRequest,
} from './appServerApproval.js'

function buildCodexPermissionRequest(
  approval: CodexAppServerToolApprovalRequest,
): SDKControlPermissionRequest {
  return {
    subtype: 'can_use_tool',
    tool_name: approval.toolName,
    input: approval.toolInput,
    tool_use_id: approval.providerRequestId,
    title: 'Codex approval',
    display_name: approval.toolName,
    description: approval.reason ?? undefined,
    decision_reason: approval.reason ?? undefined,
  }
}

function buildForcedAskDecision(
  approval: CodexAppServerToolApprovalRequest,
): PermissionDecision {
  return {
    behavior: 'ask',
    message: approval.reason ?? `Codex requests permission to use ${approval.toolName}`,
    updatedInput: approval.toolInput,
    decisionReason: {
      type: 'other',
      reason: 'Codex app-server approval request',
    },
  }
}

function mapPermissionDecision(
  decision: PermissionDecision,
): CodexAppServerApprovalDecision {
  if (decision.behavior === 'allow') {
    return { allow: true }
  }
  if (decision.behavior === 'deny') {
    return {
      allow: false,
      message: decision.message,
    }
  }
  return {
    allow: false,
    message: decision.message,
  }
}

export function createCodexAppServerApprovalPromptHandler(params: {
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
}): CodexAppServerApprovalRequestHandler {
  return async approval => {
    const request = buildCodexPermissionRequest(approval)
    const tool = createToolStub(approval.toolName)
    const assistantMessage = createSyntheticAssistantMessage(
      request,
      approval.providerRequestId,
    )
    const decision = await params.canUseTool(
      tool,
      approval.toolInput,
      params.toolUseContext,
      assistantMessage,
      approval.providerRequestId,
      buildForcedAskDecision(approval),
    )
    return mapPermissionDecision(decision)
  }
}
