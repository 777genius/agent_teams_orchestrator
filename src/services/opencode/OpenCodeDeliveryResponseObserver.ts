import type {
  OpenCodeCanonicalMessage,
  OpenCodeCanonicalToolCall,
  OpenCodeSessionReconcileSummary,
} from './types.js'

export type OpenCodeDeliveryResponseState =
  | 'not_observed'
  | 'pending'
  | 'prompt_not_indexed'
  | 'responded_tool_call'
  | 'responded_visible_message'
  | 'responded_non_visible_tool'
  | 'responded_plain_text'
  | 'permission_blocked'
  | 'tool_error'
  | 'empty_assistant_turn'
  | 'session_stale'
  | 'session_error'
  | 'reconcile_failed'

export type OpenCodeDeliveryVisibleReplyCorrelation =
  | 'relayOfMessageId'
  | 'direct_child_message_send'
  | 'plain_assistant_text'

export type OpenCodeDeliveryResponseObservation = {
  state: OpenCodeDeliveryResponseState
  deliveredUserMessageId: string | null
  assistantMessageId: string | null
  toolCallNames: string[]
  visibleMessageToolCallId: string | null
  visibleReplyMessageId: string | null
  visibleReplyCorrelation: OpenCodeDeliveryVisibleReplyCorrelation | null
  visibleReplyMissingRelayOfMessageId?: boolean
  latestAssistantPreview: string | null
  needsFullHistory?: boolean
  reason: string | null
}

export type ObserveOpenCodeDeliveryResponseInput = {
  inboundMessageId?: string | null
  prePromptCursor?: string | null
  summary: OpenCodeSessionReconcileSummary
}

const BOOTSTRAP_TOOL_NAMES = new Set([
  'runtime_bootstrap_checkin',
  'member_briefing',
  'runtime_heartbeat',
  'process_register',
  'process_list',
])

const EXECUTION_TOOL_NAMES = new Set([
  'bash',
  'read',
  'edit',
  'write',
  'grep',
  'glob',
  'list',
  'ls',
])

const RESPONSE_STATE_PRIORITY: Record<OpenCodeDeliveryResponseState, number> = {
  not_observed: 0,
  prompt_not_indexed: 1,
  empty_assistant_turn: 2,
  tool_error: 3,
  session_error: 4,
  pending: 5,
  permission_blocked: 6,
  responded_plain_text: 7,
  responded_tool_call: 8,
  responded_non_visible_tool: 9,
  responded_visible_message: 10,
  session_stale: 11,
  reconcile_failed: 12,
}

function normalizeToolName(name: string | null): string {
  return String(name || '')
    .trim()
    .replace(/^mcp__agent-teams__/, '')
    .replace(/^mcp__agent_teams__/, '')
    .replace(/^agent-teams_/, '')
    .replace(/^agent_teams_/, '')
    .toLowerCase()
}

function compactText(value: string | null | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function messagePreview(message: OpenCodeCanonicalMessage | null): string | null {
  if (!message) return null
  return (
    message.previewText
    ?? compactText(message.text)
    ?? compactText(message.errorMessage)
    ?? null
  ) || null
}

function isMeaningfulNonVisibleTool(toolName: string): boolean {
  if (toolName.startsWith('task_')) return true
  if (toolName === 'member_work_sync_report') return true
  return EXECUTION_TOOL_NAMES.has(toolName)
}

function isErroredTool(tool: OpenCodeCanonicalToolCall): boolean {
  return tool.isError === true || tool.status === 'errored'
}

function isRunningTool(tool: OpenCodeCanonicalToolCall): boolean {
  return tool.status === 'running'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return null
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

function getNestedRecord(
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  return value ? asRecord(value[key]) : null
}

function getTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function getMessageSendOutputRecord(
  tool: OpenCodeCanonicalToolCall,
): Record<string, unknown> | null {
  return asRecord(tool.output) ?? parseJsonRecord(tool.outputText)
}

function getMessageSendOutputMessage(
  tool: OpenCodeCanonicalToolCall,
): Record<string, unknown> | null {
  return getNestedRecord(getMessageSendOutputRecord(tool), 'message')
}

function getRelayOfMessageId(tool: OpenCodeCanonicalToolCall): string | null {
  return (
    getTrimmedString(tool.input?.relayOfMessageId)
    ?? getTrimmedString(getMessageSendOutputMessage(tool)?.relayOfMessageId)
  )
}

function getVisibleReplyMessageId(tool: OpenCodeCanonicalToolCall): string | null {
  const output = getMessageSendOutputRecord(tool)
  return (
    getTrimmedString(output?.messageId)
    ?? getTrimmedString(output?.id)
    ?? getTrimmedString(getMessageSendOutputMessage(tool)?.messageId)
  )
}

function findDeliveredUserMessages(input: ObserveOpenCodeDeliveryResponseInput): {
  messages: OpenCodeCanonicalMessage[]
  usedCursorFallback: boolean
  needsFullHistory: boolean
} {
  const inboundMessageId = input.inboundMessageId?.trim() || null
  const prePromptCursor = input.prePromptCursor?.trim() || null
  const userMessages = input.summary.messages.filter(
    (message): message is OpenCodeCanonicalMessage & { id: string } =>
      message.role === 'user' && typeof message.id === 'string' && message.id.length > 0,
  )

  if (inboundMessageId) {
    const exact = userMessages.filter(message => message.text.includes(inboundMessageId))
    if (exact.length > 0) {
      return { messages: exact, usedCursorFallback: false, needsFullHistory: false }
    }
  }

  if (prePromptCursor) {
    const cursorIndex = input.summary.messages.findIndex(message => message.id === prePromptCursor)
    if (cursorIndex >= 0) {
      const afterCursor = input.summary.messages
        .slice(cursorIndex + 1)
        .filter(
          (message): message is OpenCodeCanonicalMessage & { id: string } =>
            message.role === 'user' && typeof message.id === 'string' && message.id.length > 0,
        )
      if (afterCursor.length === 1) {
        return { messages: afterCursor, usedCursorFallback: true, needsFullHistory: false }
      }
      return { messages: [], usedCursorFallback: false, needsFullHistory: false }
    }
  }

  return { messages: [], usedCursorFallback: false, needsFullHistory: true }
}

function directAssistantChildren(
  summary: OpenCodeSessionReconcileSummary,
  userMessage: OpenCodeCanonicalMessage,
): OpenCodeCanonicalMessage[] {
  if (!userMessage.id) return []
  return summary.messages.filter(
    message => message.role === 'assistant' && message.parentId === userMessage.id,
  )
}

function buildObservation(input: Partial<OpenCodeDeliveryResponseObservation> & {
  state: OpenCodeDeliveryResponseState
}): OpenCodeDeliveryResponseObservation {
  return {
    deliveredUserMessageId: null,
    assistantMessageId: null,
    toolCallNames: [],
    visibleMessageToolCallId: null,
    visibleReplyMessageId: null,
    visibleReplyCorrelation: null,
    latestAssistantPreview: null,
    reason: null,
    ...input,
  }
}

function classifyChildren(input: {
  inboundMessageId: string | null
  userMessage: OpenCodeCanonicalMessage
  children: OpenCodeCanonicalMessage[]
  rawStatus: OpenCodeSessionReconcileSummary['rawStatus']
}): OpenCodeDeliveryResponseObservation {
  const deliveredUserMessageId = input.userMessage.id ?? null
  if (input.children.length === 0) {
    if (input.rawStatus === 'busy' || input.rawStatus === 'retry') {
      return buildObservation({
        state: 'pending',
        deliveredUserMessageId,
        reason: 'assistant_response_pending',
      })
    }
    return buildObservation({
      state: 'empty_assistant_turn',
      deliveredUserMessageId,
      reason: 'no_assistant_child_for_delivered_prompt',
    })
  }

  let hasRunningTool = false
  let hasErroredMeaningfulTool = false
  let best: OpenCodeDeliveryResponseObservation | null = null
  const observedToolNames = new Set<string>()

  for (const child of input.children) {
    const toolCalls = child.toolCalls || []
    const normalizedToolNames = toolCalls
      .map(tool => normalizeToolName(tool.toolName))
      .filter(Boolean)
    normalizedToolNames.forEach(name => observedToolNames.add(name))

    if (child.hasError) {
      const candidate = buildObservation({
        state: 'session_error',
        deliveredUserMessageId,
        assistantMessageId: child.id,
        toolCallNames: [...observedToolNames],
        latestAssistantPreview: messagePreview(child),
        reason: child.errorMessage ?? child.errorName ?? 'assistant_message_error',
      })
      if (!best || RESPONSE_STATE_PRIORITY[candidate.state] > RESPONSE_STATE_PRIORITY[best.state]) {
        best = candidate
      }
      continue
    }

    for (const tool of toolCalls) {
      const normalizedName = normalizeToolName(tool.toolName)
      if (!normalizedName || BOOTSTRAP_TOOL_NAMES.has(normalizedName)) {
        continue
      }
      if (isRunningTool(tool)) {
        hasRunningTool = true
        continue
      }
      if (isErroredTool(tool)) {
        if (normalizedName === 'message_send' || isMeaningfulNonVisibleTool(normalizedName)) {
          hasErroredMeaningfulTool = true
        }
        continue
      }

      if (normalizedName === 'message_send') {
        const relayOfMessageId = getRelayOfMessageId(tool)
        const visibleReplyMessageId = getVisibleReplyMessageId(tool)
        const matchedRelay =
          relayOfMessageId != null
          && input.inboundMessageId != null
          && relayOfMessageId === input.inboundMessageId
        const candidate = buildObservation({
          state: 'responded_visible_message',
          deliveredUserMessageId,
          assistantMessageId: child.id,
          toolCallNames: [...observedToolNames],
          visibleMessageToolCallId: tool.callId,
          visibleReplyMessageId,
          visibleReplyCorrelation: matchedRelay ? 'relayOfMessageId' : 'direct_child_message_send',
          visibleReplyMissingRelayOfMessageId: !matchedRelay,
          latestAssistantPreview: messagePreview(child),
          reason: matchedRelay ? null : 'visible_reply_missing_relayOfMessageId',
        })
        if (!best || RESPONSE_STATE_PRIORITY[candidate.state] > RESPONSE_STATE_PRIORITY[best.state]) {
          best = candidate
        }
        continue
      }

      if (isMeaningfulNonVisibleTool(normalizedName)) {
        const candidate = buildObservation({
          state: 'responded_non_visible_tool',
          deliveredUserMessageId,
          assistantMessageId: child.id,
          toolCallNames: [...observedToolNames],
          latestAssistantPreview: messagePreview(child),
          reason: null,
        })
        if (!best || RESPONSE_STATE_PRIORITY[candidate.state] > RESPONSE_STATE_PRIORITY[best.state]) {
          best = candidate
        }
      }
    }

    const text = compactText(child.text) || compactText(child.previewText)
    if (text) {
      const candidate = buildObservation({
        state: 'responded_plain_text',
        deliveredUserMessageId,
        assistantMessageId: child.id,
        toolCallNames: [...observedToolNames],
        visibleReplyCorrelation: 'plain_assistant_text',
        latestAssistantPreview: messagePreview(child),
        reason: 'assistant_replied_with_plain_text',
      })
      if (!best || RESPONSE_STATE_PRIORITY[candidate.state] > RESPONSE_STATE_PRIORITY[best.state]) {
        best = candidate
      }
    }
  }

  if (best) {
    return {
      ...best,
      toolCallNames: [...observedToolNames],
    }
  }

  if (hasRunningTool || input.rawStatus === 'busy' || input.rawStatus === 'retry') {
    return buildObservation({
      state: 'pending',
      deliveredUserMessageId,
      assistantMessageId: input.children[input.children.length - 1]?.id ?? null,
      toolCallNames: [...observedToolNames],
      latestAssistantPreview: messagePreview(input.children[input.children.length - 1] ?? null),
      reason: 'assistant_response_pending',
    })
  }

  if (hasErroredMeaningfulTool) {
    return buildObservation({
      state: 'tool_error',
      deliveredUserMessageId,
      assistantMessageId: input.children[input.children.length - 1]?.id ?? null,
      toolCallNames: [...observedToolNames],
      latestAssistantPreview: messagePreview(input.children[input.children.length - 1] ?? null),
      reason: 'meaningful_tool_call_failed',
    })
  }

  return buildObservation({
    state: 'empty_assistant_turn',
    deliveredUserMessageId,
    assistantMessageId: input.children[input.children.length - 1]?.id ?? null,
    toolCallNames: [...observedToolNames],
    latestAssistantPreview: messagePreview(input.children[input.children.length - 1] ?? null),
    reason: 'assistant_child_has_no_visible_or_meaningful_response',
  })
}

export function observeOpenCodeDeliveryResponse(
  input: ObserveOpenCodeDeliveryResponseInput,
): OpenCodeDeliveryResponseObservation {
  if (input.summary.reconcileOutcome === 'stale') {
    return buildObservation({
      state: 'session_stale',
      reason: input.summary.staleReason ?? 'session_stale',
    })
  }

  if (input.summary.pendingPermissionRequestIds.length > 0) {
    return buildObservation({
      state: 'permission_blocked',
      reason: 'pending_permission_request',
    })
  }

  const inboundMessageId = input.inboundMessageId?.trim() || null
  const delivered = findDeliveredUserMessages(input)
  if (delivered.messages.length === 0) {
    return buildObservation({
      state:
        input.summary.rawStatus === 'busy' || input.summary.rawStatus === 'retry'
          ? 'prompt_not_indexed'
          : 'prompt_not_indexed',
      needsFullHistory: delivered.needsFullHistory,
      reason: delivered.needsFullHistory
        ? 'delivered_prompt_anchor_not_found_in_limited_history'
        : 'delivered_prompt_anchor_not_found',
    })
  }

  let best: OpenCodeDeliveryResponseObservation | null = null
  for (const userMessage of delivered.messages) {
    const observation = classifyChildren({
      inboundMessageId,
      userMessage,
      children: directAssistantChildren(input.summary, userMessage),
      rawStatus: input.summary.rawStatus,
    })
    if (!best || RESPONSE_STATE_PRIORITY[observation.state] > RESPONSE_STATE_PRIORITY[best.state]) {
      best = observation
    }
  }

  return best ?? buildObservation({ state: 'not_observed', reason: 'no_delivery_observation' })
}
