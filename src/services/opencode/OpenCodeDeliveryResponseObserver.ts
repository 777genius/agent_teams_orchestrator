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
  groupChatId?: string | null
  memberName?: string | null
  teamName?: string | null
  prePromptCursor?: string | null
  runtimePromptMessageId?: string | null
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
    .replace(/^proxy_(?=(?:mcp__agent[-_]teams__|agent[-_]teams_))/, '')
    .replace(/^mcp__agent-teams__/, '')
    .replace(/^mcp__agent_teams__/, '')
    .replace(/^agent-teams_/, '')
    .replace(/^agent_teams_/, '')
    .toLowerCase()
}

function compactText(value: string | null | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function isRejectedMemberWorkSyncReportText(text: string): boolean {
  const normalized = compactText(text).toLowerCase()
  return (
    /\baccepted\s*[:=]\s*false\b/.test(normalized) ||
    /"accepted"\s*:\s*false/.test(normalized) ||
    /\bnot\s+accepted\b/.test(normalized) ||
    /\breport\s+rejected\b/.test(normalized) ||
    /\breport\s+(?:was\s+)?(?:not\s+accepted|failed)\b/.test(normalized) ||
    /\bmember_work_sync_report\s+(?:not\s+accepted|rejected|failed)\b/.test(normalized) ||
    /\breport_rejected(?::|_|\b)/.test(normalized) ||
    /\bstale[_\s-]+(?:agenda[_\s-]+)?fingerprint\b/.test(normalized) ||
    /\binvalid[_\s-]+report[_\s-]+token\b/.test(normalized) ||
    /\breport[_\s-]+token[_\s-]+invalid\b/.test(normalized) ||
    /\bidentity[_\s-]+(?:untrusted|mismatch)\b/.test(normalized) ||
    /\bmember[_\s-]+inactive\b/.test(normalized) ||
    /\breserved[_\s-]+or[_\s-]+invalid[_\s-]+member\b/.test(normalized) ||
    /\bteam[_\s-]+runtime[_\s-]+inactive\b/.test(normalized) ||
    /\bforeign[_\s-]+task[_\s-]+id\b/.test(normalized) ||
    /\bcaught[_\s-]+up[_\s-]+rejected[_\s-]+actionable[_\s-]+items[_\s-]+exist\b/.test(normalized) ||
    /\bstill[_\s-]+working[_\s-]+rejected[_\s-]+agenda[_\s-]+empty\b/.test(normalized) ||
    /\bblocked[_\s-]+without[_\s-]+evidence\b/.test(normalized) ||
    /\breport fingerprint is stale\b/.test(normalized) ||
    /\breport token is (?:invalid|required)\b/.test(normalized) ||
    /\bcannot report caught_up while actionable work remains\b/.test(normalized) ||
    /\bcannot report still_working when no actionable work remains\b/.test(normalized)
  )
}

function isAcceptedMemberWorkSyncReportText(text: string): boolean {
  const normalized = compactText(text).toLowerCase()
  return (
    /\baccepted\s*[:=]\s*true\b/.test(normalized) ||
    /"accepted"\s*:\s*true/.test(normalized) ||
    /\breport\s+(?:was\s+)?accepted\b/.test(normalized) ||
    /\bmember_work_sync_report\s+(?:was\s+)?accepted\b/.test(normalized)
  )
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

function isRejectedMemberWorkSyncReportTool(
  tool: OpenCodeCanonicalToolCall,
  normalizedToolName: string,
): boolean {
  if (normalizedToolName !== 'member_work_sync_report') return false
  const acceptedFlags = collectAcceptedFlagsFromValue([
    tool.output,
    tool.outputText,
    tool.outputPreview,
  ])
  if (acceptedFlags.includes(false)) return true
  const texts = [compactText(tool.outputText), compactText(tool.outputPreview)].filter(Boolean)
  return texts.some(text => isRejectedMemberWorkSyncReportText(text))
}

function isAcceptedMemberWorkSyncReportTool(
  tool: OpenCodeCanonicalToolCall,
  normalizedToolName: string,
): boolean {
  if (normalizedToolName !== 'member_work_sync_report') return false
  const acceptedFlags = collectAcceptedFlagsFromValue([
    tool.output,
    tool.outputText,
    tool.outputPreview,
  ])
  if (acceptedFlags.includes(true) && !acceptedFlags.includes(false)) return true
  const texts = [compactText(tool.outputText), compactText(tool.outputPreview)].filter(Boolean)
  return texts.some(text => isAcceptedMemberWorkSyncReportText(text))
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

function tryParseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

function parseEmbeddedJsonRecord(value: string | null | undefined): Record<string, unknown> | null {
  const text = value?.trim()
  if (!text) return null
  const exact = tryParseJsonRecord(text)
  if (exact) return exact

  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  let firstParsed: Record<string, unknown> | null = null

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (start === -1) {
      if (char === '{') {
        start = index
        depth = 1
        inString = false
        escaped = false
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char !== '}') {
      continue
    }

    depth -= 1
    if (depth === 0) {
      const parsed = tryParseJsonRecord(text.slice(start, index + 1))
      if (parsed) {
        if (typeof parsed.accepted === 'boolean') {
          return parsed
        }
        firstParsed ??= parsed
      }
      start = -1
    }
  }

  return firstParsed
}

function collectAcceptedFlagsFromValue(value: unknown, flags: boolean[] = []): boolean[] {
  if (typeof value === 'string') {
    const parsed = parseEmbeddedJsonRecord(value)
    if (typeof parsed?.accepted === 'boolean') {
      flags.push(parsed.accepted)
    } else if (isRejectedMemberWorkSyncReportText(value)) {
      flags.push(false)
    }
    return flags
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectAcceptedFlagsFromValue(item, flags))
    return flags
  }

  const record = asRecord(value)
  if (!record) return flags

  if (typeof record.accepted === 'boolean') {
    flags.push(record.accepted)
  }

  for (const key of ['content', 'text', 'result', 'output', 'data'] as const) {
    if (key in record) {
      collectAcceptedFlagsFromValue(record[key], flags)
    }
  }

  return flags
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

function findGroupSendReceipt(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') return findGroupSendReceipt(parseJsonRecord(value))
  if (Array.isArray(value)) {
    for (const item of value) {
      const receipt = findGroupSendReceipt(item)
      if (receipt) return receipt
    }
    return null
  }
  const record = asRecord(value)
  if (!record) return null
  if ('saved' in record || 'error' in record) return record
  for (const key of ['content', 'text', 'result', 'output', 'data']) {
    const receipt = findGroupSendReceipt(record[key])
    if (receipt) return receipt
  }
  return null
}

function findDeliveredUserMessages(input: ObserveOpenCodeDeliveryResponseInput): {
  messages: OpenCodeCanonicalMessage[]
  usedCursorFallback: boolean
  needsFullHistory: boolean
} {
  const inboundMessageId = input.inboundMessageId?.trim() || null
  const prePromptCursor = input.prePromptCursor?.trim() || null
  const runtimePromptMessageId = input.runtimePromptMessageId?.trim() || null
  const userMessages = input.summary.messages.filter(
    (message): message is OpenCodeCanonicalMessage & { id: string } =>
      message.role === 'user' && typeof message.id === 'string' && message.id.length > 0,
  )

  if (runtimePromptMessageId) {
    const exact = userMessages.filter(message => message.id === runtimePromptMessageId)
    if (exact.length > 0) {
      return { messages: exact, usedCursorFallback: false, needsFullHistory: false }
    }
  }

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

function assistantResponseChain(
  summary: OpenCodeSessionReconcileSummary,
  userMessage: OpenCodeCanonicalMessage,
): OpenCodeCanonicalMessage[] {
  if (!userMessage.id) return []
  const responseParentIds = new Set([userMessage.id])
  const responseMessages: OpenCodeCanonicalMessage[] = []

  for (const message of summary.messages) {
    if (message.role !== 'assistant' || !message.parentId || !responseParentIds.has(message.parentId)) {
      continue
    }
    responseMessages.push(message)
    if (message.id) {
      responseParentIds.add(message.id)
    }
  }

  return responseMessages
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
  groupChatId?: string | null
  memberName?: string | null
  teamName?: string | null
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

  let groupReplyBlocked = false
  let hasRunningTool = false
  let hasErroredMeaningfulTool = false
  let hasRejectedMemberWorkSyncReport = false
  let hasAcceptedMemberWorkSyncReport = false
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
      if (input.groupChatId && (normalizedName === 'group_chat_send' || normalizedName === 'message_send' || normalizedName === 'sendmessage')) {
        const receipt = findGroupSendReceipt(tool.output) ?? findGroupSendReceipt(tool.outputText)
        const matched = normalizedName === 'group_chat_send' && !isErroredTool(tool) &&
          tool.input?.groupChatId === input.groupChatId &&
          tool.input?.from === input.memberName &&
          (!input.teamName || tool.input?.teamName === input.teamName) &&
          tool.input?.relayOfMessageId === input.inboundMessageId &&
          receipt?.saved === true && receipt.groupChatId === input.groupChatId &&
          receipt.relayOfMessageId === input.inboundMessageId &&
          typeof tool.input?.messageId === 'string' &&
          (receipt.groupMessageId ?? receipt.messageId) === tool.input.messageId
        if (matched) {
          best = buildObservation({
            state: 'responded_visible_message', deliveredUserMessageId,
            assistantMessageId: child.id, toolCallNames: [...observedToolNames],
            visibleMessageToolCallId: tool.callId,
            visibleReplyMessageId: tool.input!.messageId as string,
            visibleReplyCorrelation: 'relayOfMessageId', latestAssistantPreview: messagePreview(child),
          })
        } else {
          groupReplyBlocked = true
        }
        continue
      }
      if (isErroredTool(tool)) {
        if (normalizedName === 'message_send' || isMeaningfulNonVisibleTool(normalizedName)) {
          hasErroredMeaningfulTool = true
        }
        continue
      }

      if (isRejectedMemberWorkSyncReportTool(tool, normalizedName)) {
        hasRejectedMemberWorkSyncReport = true
        continue
      }
      if (isAcceptedMemberWorkSyncReportTool(tool, normalizedName)) {
        hasAcceptedMemberWorkSyncReport = true
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
      if (hasRejectedMemberWorkSyncReport && !hasAcceptedMemberWorkSyncReport) {
        continue
      }
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

  if (groupReplyBlocked && best?.state !== 'responded_visible_message') {
    return buildObservation({
      state: 'tool_error', deliveredUserMessageId,
      assistantMessageId: input.children[input.children.length - 1]?.id ?? null,
      toolCallNames: [...observedToolNames], reason: 'group_reply_blocked',
    })
  }

  if (hasRejectedMemberWorkSyncReport && !hasAcceptedMemberWorkSyncReport) {
    return buildObservation({
      state: 'tool_error',
      deliveredUserMessageId,
      assistantMessageId: input.children[input.children.length - 1]?.id ?? null,
      toolCallNames: [...observedToolNames],
      latestAssistantPreview: messagePreview(input.children[input.children.length - 1] ?? null),
      reason: 'member_work_sync_report_rejected',
    })
  }

  if (best) {
    return {
      ...best,
      toolCallNames: [...observedToolNames],
    }
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
      groupChatId: input.groupChatId,
      memberName: input.memberName,
      teamName: input.teamName,
      userMessage,
      children: assistantResponseChain(input.summary, userMessage),
      rawStatus: input.summary.rawStatus,
    })
    if (!best || RESPONSE_STATE_PRIORITY[observation.state] > RESPONSE_STATE_PRIORITY[best.state]) {
      best = observation
    }
  }

  return best ?? buildObservation({ state: 'not_observed', reason: 'no_delivery_observation' })
}
