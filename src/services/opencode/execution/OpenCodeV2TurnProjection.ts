import type { ControllerInboxBinding, ControllerInboxProof } from '../bridge/OpenCodeV2ControllerTools.js'
import type { ExecutionLog, ExecutionLogEvent, ExecutionMessagePage } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import { canonicalExecutionJSON } from './OpenCodeV2ExecutionContracts.js'

export type OpenCodeV2ToolEffect = Readonly<{
  assistantMessageId: string; toolCallId: string; toolName: string
  kind: 'visible_message' | 'task' | 'other'; input: Readonly<Record<string, unknown>>
  content: readonly unknown[]; result: Readonly<Record<string, unknown>> | null
}>
export type OpenCodeV2VisibleReply = Readonly<{
  nativeInputId: string; assistantMessageId: string; toolCallId: string; toolName: string
  inboundMessageId: string; visibleReplyMessageId: string
}>
export type OpenCodeV2TurnProjection = Readonly<{
  state: 'unknown' | 'pending' | 'succeeded' | 'failed' | 'cancelled'
  reason: string; assistantMessageIds: readonly string[]; text: string
  toolEffects: readonly OpenCodeV2ToolEffect[]; visibleReplies: readonly OpenCodeV2VisibleReply[]
}>
export type OpenCodeV2TurnCut = Readonly<{
  pin: '2.0.0' | '2.0.21'
  sessionID: string; nativeInputID: string; beforeCursor: number | null; originalText: string
  messages: ExecutionMessagePage; log: ExecutionLog
  inboundMessageId?: string; advertisedTools?: readonly string[]
  controllerBinding?: ControllerInboxBinding; controllerInbox?: ControllerInboxProof | null
}>

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const string = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null
const terminal = (event: ExecutionLogEvent): boolean =>
  ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)
const messageIDFromEvent = (id: string): string => id.replace(/^evt_/, 'msg_')
const same = (left: unknown, right: unknown): boolean => {
  try { return canonicalExecutionJSON(left) === canonicalExecutionJSON(right) } catch { return false }
}
function assistantLineage(interval: readonly ExecutionLogEvent[]): string[] | null {
  const starts = new Map<string, { event: ExecutionLogEvent; index: number; count: number }>()
  const retries = new Set<number>()
  for (const [index, event] of interval.entries()) {
    if (event.type !== 'session.step.started') continue
    const id = string(event.data.assistantMessageID)
    if (!id) return null
    const previous = starts.get(id)
    if (previous) {
      const retry = interval[index - 1], error = record(retry?.data.error)
      // Both pins retain the assistant ID across native provider retries. Only
      // an adjacent start/retry/start chain without output or effects is proven.
      // Native retry counters start at 1 and increment before scheduling.
      if (previous.index !== index - 2 || retry?.type !== 'session.retry.scheduled' ||
          retry.data.assistantMessageID !== id || retry.data.attempt !== previous.count + 1 ||
          !Number.isSafeInteger(retry.data.at) || (retry.data.at as number) < 0 ||
          !error || typeof error.type !== 'string' || typeof error.message !== 'string' ||
          !same(event.data.agent, previous.event.data.agent) || !same(event.data.model, previous.event.data.model)) return null
      retries.add(index - 1)
    }
    starts.set(id, { event, index, count: (previous?.count ?? 0) + 1 })
  }
  if (interval.some((event, index) => event.type === 'session.retry.scheduled' && !retries.has(index))) return null
  return [...starts.keys()]
}
function toolResult(content: readonly unknown[]): Record<string, unknown> | null {
  // The controller's existing message/task tools return their result as one
  // JSON text item. Multiple JSON results are ambiguous and cannot publish.
  const values: Record<string, unknown>[] = []
  for (const value of content) {
    const item = record(value)
    if (item?.type !== 'text' || typeof item.text !== 'string') continue
    try { const result = record(JSON.parse(item.text)); if (result) values.push(result) } catch { /* model prose is not a receipt */ }
  }
  return values.length === 1 ? values[0] ?? null : null
}

/**
 * Both qualified pins expose session-event inboxID, assistantMessageID and
 * tool id, but neither exposes an assistant parent/input ID. Thus lineage is
 * proved only for a unique delivered input in a complete execution interval.
 * Native Step.Ended is the provider boundary; only Execution terminal ends a
 * turn. See each pin's schema/dist/session-event.js and session-message.js.
 * This pure projection grants no outbox or task mutation authority.
 */
export function projectOpenCodeV2Turn(input: OpenCodeV2TurnCut): OpenCodeV2TurnProjection {
  const empty = (state: OpenCodeV2TurnProjection['state'], reason: string): OpenCodeV2TurnProjection =>
    ({ state, reason, assistantMessageIds: [], text: '', toolEffects: [], visibleReplies: [] })
  const unknown = (reason: string) => empty('unknown', reason)
  if (input.messages.previous !== null || input.messages.next !== null || input.log.synced !== true)
    return unknown('incomplete_native_cut')
  if (input.pin !== '2.0.0' && input.pin !== '2.0.21') return unknown('unqualified_projection_pin')
  const events = input.log.events
  if (events.length > 4096 || input.messages.data.length > 1600 ||
      new Set(input.messages.data.map(message => message.id)).size !== input.messages.data.length)
    return unknown('unbounded_or_duplicate_cut')
  const ids = new Set<string>(); let last = -1
  for (const event of events) {
    if (event.aggregateID !== input.sessionID || event.data.sessionID !== input.sessionID || ids.has(event.id) ||
        !Number.isSafeInteger(event.seq) || event.seq <= last || last >= 0 && event.seq !== last + 1)
      return unknown('foreign_or_incomplete_log')
    ids.add(event.id); last = event.seq
  }
  if (input.log.watermark !== (events.at(-1)?.seq ?? null)) return unknown('incomplete_log_watermark')
  const after = input.beforeCursor ?? -1
  const deliveries = events.filter(event => event.seq > after && event.type === 'session.inbox.delivered' &&
    event.data.inboxID === input.nativeInputID)
  const cancellations = events.filter(event => event.seq > after && event.type === 'session.inbox.cancelled' &&
    event.data.inboxID === input.nativeInputID)
  if (deliveries.length === 0) return cancellations.length === 1
    ? empty('cancelled', 'original_inbox_cancelled') : cancellations.length > 1
      ? unknown('ambiguous_input_disposition') : empty('pending', 'input_not_delivered')
  if (deliveries.length !== 1 || cancellations.length !== 0) return unknown('ambiguous_input_disposition')
  const delivered = deliveries[0]
  if (!delivered) return unknown('missing_original_delivery')
  const user = input.messages.data.find(message => message.id === input.nativeInputID)
  if (!user || user.type !== 'user' || user.data.id !== input.nativeInputID || user.data.type !== 'user' ||
      user.data.text !== input.originalText) return unknown('original_input_projection_mismatch')

  const deliveredAt = events.indexOf(delivered)
  let boundary = -1
  for (const [index, event] of events.entries()) if (index < deliveredAt && terminal(event)) boundary = index
  const end = events.findIndex((event, index) => index > deliveredAt && terminal(event))
  const interval = events.slice(boundary + 1, end < 0 ? undefined : end + 1)
  if (interval.filter(event => event.type === 'session.inbox.delivered').length !== 1)
    return unknown('ambiguous_delivered_input_lineage')
  const starts = interval.filter(event => event.type === 'session.execution.started')
  if (starts.length !== 1 || interval.some(event => event.type === 'session.step.started' && event.seq < delivered.seq))
    return unknown('execution_interval_lineage_missing')
  const assistants = assistantLineage(interval)
  if (!assistants) return unknown('ambiguous_assistant_lineage')
  if (events.some(event => event.type === 'session.step.started' &&
      assistants.includes(event.data.assistantMessageID as string) && !interval.includes(event)))
    return unknown('ambiguous_assistant_lineage')
  const text: string[] = [], toolEffects: OpenCodeV2ToolEffect[] = [], visibleReplies: OpenCodeV2VisibleReply[] = []
  for (const assistantId of assistants) {
    const message = input.messages.data.find(item => item.id === assistantId)
    if (!message || message.type !== 'assistant' || message.data.type !== 'assistant' || message.data.id !== assistantId ||
        !Array.isArray(message.data.content)) return unknown('assistant_snapshot_lineage_mismatch')
    const related = interval.filter(event => event.data.assistantMessageID === assistantId)
    const stepEnds = related.filter(event => event.type === 'session.step.ended' || event.type === 'session.step.failed')
    if (end >= 0 && stepEnds.length !== 1) return unknown('missing_step_terminal')
    if (stepEnds.length > 1) return unknown('ambiguous_step_terminal')
    if (end >= 0 && typeof record(message.data.time)?.completed !== 'number') return unknown('incomplete_assistant_snapshot')
    const stepEnd = stepEnds[0]
    if (stepEnd && (stepEnd.type === 'session.step.ended' ? message.data.finish !== stepEnd.data.finish
      : !same(message.data.error, stepEnd.data.error))) return unknown('step_terminal_snapshot_mismatch')
    for (const raw of message.data.content) {
      const part = record(raw)
      if (!part) return unknown('invalid_assistant_content')
      if (part.type === 'text') {
        if (typeof part.text !== 'string' || !related.some(event => event.type === 'session.text.ended' && event.data.text === part.text))
          return unknown('text_snapshot_mismatch')
        text.push(part.text); continue
      }
      if (part.type !== 'tool') continue
      const toolId = string(part.id), name = string(part.name), state = record(part.state)
      if (!toolId || !name || !state) return unknown('invalid_tool_snapshot')
      const toolEvents = related.filter(event => event.data.id === toolId)
      const started = toolEvents.filter(event => event.type === 'session.tool.input.started')
      const called = toolEvents.filter(event => event.type === 'session.tool.called')
      const successes = toolEvents.filter(event => event.type === 'session.tool.success')
      const failures = toolEvents.filter(event => event.type === 'session.tool.failed')
      if (started.length !== 1 || started[0]?.data.name !== name || called.length !== 1 ||
          !same(called[0]?.data.input, state.input) || typeof called[0]?.data.executed !== 'boolean' ||
          (started[0]?.seq ?? Infinity) >= (called[0]?.seq ?? -1))
        return unknown('tool_call_lineage_mismatch')
      if (state.status === 'streaming' || state.status === 'running') {
        if (end >= 0) return unknown('unsettled_tool_at_execution_terminal')
        continue
      }
      if (state.status === 'error') {
        if (failures.length !== 1 || successes.length !== 0 || !same(failures[0]?.data.error, state.error))
          return unknown('tool_failure_snapshot_mismatch')
        continue
      }
      if (state.status !== 'completed' || successes.length !== 1 || failures.length !== 0 ||
          !Array.isArray(state.content) || state.content.length === 0 ||
          !same(successes[0]?.data.content, state.content) || successes[0]?.data.executed !== part.executed ||
          (called[0]?.seq ?? Infinity) >= (successes[0]?.seq ?? -1))
        return unknown('tool_success_snapshot_mismatch')
      if (name === 'execute' && input.advertisedTools?.includes('agent-teams_message_send')) {
        const metadata = record(state.metadata)
        if (!metadata || metadata.truncated === true || !same(metadata, successes[0]?.data.metadata) ||
            !Array.isArray(metadata.toolCalls) || metadata.toolCalls.length > 256) continue
        const calls = metadata.toolCalls.map(record).filter(call => call?.tool === 'agent-teams.message_send')
        if (calls.length !== 1 || calls[0]?.status !== 'completed' || !input.inboundMessageId ||
            !input.controllerBinding || !input.controllerInbox ||
            !same(input.controllerBinding, input.controllerInbox.binding) ||
            input.controllerBinding.sessionID !== input.sessionID) continue
        const actual = record(calls[0].input)
        if (!actual || actual.teamName !== input.controllerBinding.teamId ||
            actual.from !== input.controllerBinding.memberId || actual.to !== 'user' ||
            actual.source !== 'runtime_delivery' || actual.relayOfMessageId !== input.inboundMessageId ||
            !string(actual.text)) continue
        const matches = input.controllerInbox.messages.filter(row => row.relayOfMessageId === input.inboundMessageId &&
          row.from === actual.from && row.to === actual.to && row.source === actual.source)
        const reply = matches[0]
        if (matches.length !== 1 || !reply || reply.text !== actual.text || !string(reply.messageId) ||
            input.controllerInbox.messages.filter(row => row.messageId === reply.messageId).length !== 1) continue
        const toolName = 'agent-teams.message_send'
        toolEffects.push({ assistantMessageId: assistantId, toolCallId: toolId, toolName, kind: 'visible_message',
          input: actual, content: state.content, result: reply })
        visibleReplies.push({ nativeInputId: input.nativeInputID, assistantMessageId: assistantId, toolCallId: toolId,
          toolName, inboundMessageId: input.inboundMessageId, visibleReplyMessageId: reply.messageId })
        continue
      }
      if (!input.advertisedTools?.includes(name)) continue
      const effectInput = record(state.input)
      if (!effectInput) return unknown('invalid_tool_input')
      const result = toolResult(state.content)
      const kind = name.endsWith('_message_send') ? 'visible_message' : /_task_(claim|start|comment|done|update)$/.test(name) ? 'task' : 'other'
      toolEffects.push({ assistantMessageId: assistantId, toolCallId: toolId, toolName: name, kind,
        input: effectInput, content: state.content, result })
      if (kind !== 'visible_message' || !input.inboundMessageId || !result) continue
      const reply = record(result.message)
      const relay = string(reply?.relayOfMessageId) ?? string(result.relayOfMessageId)
      const replyId = string(reply?.messageId) ?? string(result.messageId)
      if (effectInput.relayOfMessageId !== input.inboundMessageId || relay !== input.inboundMessageId || !replyId ||
          result.accepted === false || result.isError === true ||
          (result.deliveredToInbox !== true && result.accepted !== true)) continue
      visibleReplies.push({ nativeInputId: input.nativeInputID, assistantMessageId: assistantId, toolCallId: toolId,
        toolName: name, inboundMessageId: input.inboundMessageId, visibleReplyMessageId: replyId })
    }
    // Any event attributed to an unmaterialized tool is an incomplete cut.
    const snapshotToolIds = new Set(message.data.content.map(record).filter(part => part?.type === 'tool').map(part => part?.id))
    if (related.some(event => event.type.startsWith('session.tool.') && !snapshotToolIds.has(event.data.id)))
      return unknown('tool_event_missing_snapshot')
  }
  if (interval.some(event => typeof event.data.assistantMessageID === 'string' && !assistants.includes(event.data.assistantMessageID)))
    return unknown('foreign_assistant_event')
  if (end < 0) return { state: 'pending', reason: 'no_execution_terminal', assistantMessageIds: assistants,
    text: text.join('\n'), toolEffects, visibleReplies: [] }
  const ending = events[end]
  if (!ending) return unknown('missing_execution_terminal')
  const state = ending.type === 'session.execution.succeeded' ? 'succeeded' : ending.type === 'session.execution.failed' ? 'failed' : 'cancelled'
  if (state === 'succeeded' && assistants.length === 0) return unknown('no_assistant_terminal_lineage')
  // Native shutdown deliberately omits an idle transcript row. Other endings
  // must agree with the actual pinned client projection of that durable event.
  // Floor projection clears retry state for execution endings without adding
  // idle. Current appends idle except native shutdown (both primary pins audited).
  if (input.pin === '2.0.21' && !(state === 'cancelled' && ending.data.reason === 'shutdown')) {
    const idle = input.messages.data.find(message => message.id === messageIDFromEvent(ending.id))
    if (!idle || idle.type !== 'idle' || idle.data.outcome !== (state === 'cancelled' ? 'interrupted' : state))
      return unknown('terminal_snapshot_mismatch')
  }
  return { state, reason: ending.type, assistantMessageIds: assistants, text: text.join('\n'), toolEffects, visibleReplies }
}
