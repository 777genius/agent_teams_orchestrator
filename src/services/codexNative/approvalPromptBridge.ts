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
  return async (approval, abortSignal) => {
    const request = buildCodexPermissionRequest(approval)
    const tool = createToolStub(approval.toolName)
    const assistantMessage = createSyntheticAssistantMessage(
      request,
      approval.providerRequestId,
    )
    const parentController = params.toolUseContext.abortController
    const promptController = abortSignal ? new AbortController() : parentController
    const onParentAbort = (): void => promptController.abort(parentController.signal.reason)
    const onTransportAbort = (): void => promptController.abort(abortSignal?.reason)
    const onPromptAbort = (): void => {
      // A local user cancellation still cancels the turn. Transport termination
      // only retires this approval and must not abort the reusable parent context.
      if (!parentController.signal.aborted && !abortSignal?.aborted) {
        parentController.abort(promptController.signal.reason)
      }
    }
    if (abortSignal) {
      parentController.signal.addEventListener('abort', onParentAbort, { once: true })
      abortSignal.addEventListener('abort', onTransportAbort, { once: true })
      promptController.signal.addEventListener('abort', onPromptAbort, { once: true })
      if (parentController.signal.aborted) onParentAbort()
      if (abortSignal.aborted) onTransportAbort()
    }
    try {
      const decision = await params.canUseTool(
        tool,
        approval.toolInput,
        abortSignal
          ? { ...params.toolUseContext, abortController: promptController }
          : params.toolUseContext,
        assistantMessage,
        approval.providerRequestId,
        buildForcedAskDecision(approval),
      )
      return mapPermissionDecision(decision)
    } finally {
      if (abortSignal) {
        parentController.signal.removeEventListener('abort', onParentAbort)
        abortSignal.removeEventListener('abort', onTransportAbort)
        promptController.signal.removeEventListener('abort', onPromptAbort)
      }
    }
  }
}
