import { executionAssert } from '../execution/OpenCodeV2ExecutionContracts.js'
import { OpenCodeLogProjector } from '../OpenCodeLogProjector.js'
import type { ExecutionLog, ExecutionMessage, ExecutionMessagePage } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import type { OpenCodeCanonicalContentBlock, OpenCodeCanonicalMessage, OpenCodeCanonicalToolCall,
  OpenCodeDurableSessionState, OpenCodeLogProjection, OpenCodeSessionReconcileSummary } from '../types.js'

export type OpenCodeV2CanonicalTranscript = Readonly<{
  sessionId: string; durableState: OpenCodeDurableSessionState; messages: OpenCodeCanonicalMessage[]
  logProjection: OpenCodeLogProjection; diagnostics: string[]
}>
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' &&
  !Array.isArray(value) ? value as Record<string, unknown> : null
const string = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null
const timestamp = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) &&
  value >= 0 && value <= 8_640_000_000_000_000 ? value : null
const preview = (value: string): string | null => {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length === 0 ? null : compact.length <= 160 ? compact : compact.slice(0, 157) + '...'
}
function error(value: unknown): { name: string | null; message: string | null } {
  const row = record(value)
  if (!row) return { name: null, message: null }
  // Both pins use Session.StructuredError {type,message}, unlike V1's name.
  return { name: string(row.type), message: string(row.message) }
}
function projectTool(part: Record<string, unknown>): { call: OpenCodeCanonicalToolCall; blocks: OpenCodeCanonicalContentBlock[] } {
  const state = record(part.state), time = record(part.time)
  executionAssert(state && string(part.id) && string(part.name), 'v2_transcript_invalid_tool')
  executionAssert(['streaming', 'running', 'completed', 'error'].includes(String(state.status)), 'v2_transcript_invalid_tool')
  const status = state.status === 'completed' ? 'completed' : state.status === 'error' ? 'errored' : 'running'
  const input = record(state.input)
  if (state.status !== 'streaming') executionAssert(input, 'v2_transcript_invalid_tool_input')
  const content = state.content
  if (state.status === 'completed') executionAssert(Array.isArray(content) && content.length > 0, 'v2_transcript_invalid_tool_output')
  const output: unknown = content ?? (state.status === 'error' ? state.error : null)
  const texts: string[] = []
  if (Array.isArray(content)) for (const value of content) {
    const item = record(value)
    executionAssert(item && (item.type === 'text' && typeof item.text === 'string' || item.type === 'file' &&
      typeof item.uri === 'string' && typeof item.mime === 'string'), 'v2_transcript_invalid_tool_content')
    if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
  }
  const toolError = error(state.error)
  const outputText = texts.length > 0 ? texts.join('\n') : toolError.message
  const call: OpenCodeCanonicalToolCall = { callId: string(part.id), toolName: string(part.name), title: null,
    status, input, output, outputText, outputPreview: outputText ? preview(outputText) : null,
    startedAt: timestamp(time?.ran) ?? timestamp(time?.created), completedAt: timestamp(time?.completed), isError: state.status === 'error' }
  const blocks: OpenCodeCanonicalContentBlock[] = [{ type: 'tool_use', id: call.callId, name: call.toolName,
    title: null, status, input, startedAt: call.startedAt, completedAt: call.completedAt }]
  if (output !== null || call.isError) blocks.push({ type: 'tool_result', toolUseId: call.callId, toolName: call.toolName,
    title: null, status, contentText: outputText, contentPreview: call.outputPreview, rawContent: output,
    isError: call.isError, startedAt: call.startedAt, completedAt: call.completedAt })
  return { call, blocks }
}
function projectMessage(message: ExecutionMessage, diagnostics: string[], sessionID: string): OpenCodeCanonicalMessage {
  const row = message.data, time = record(row.time), model = record(row.model), failure = error(row.error)
  executionAssert(row.id === message.id && row.type === message.type && (row.sessionID === undefined || row.sessionID === sessionID) &&
    /^msg_[A-Za-z0-9]+$/.test(message.id) &&
    timestamp(time?.created) === message.timeCreated, 'v2_transcript_message_identity_mismatch')
  const contentBlocks: OpenCodeCanonicalContentBlock[] = [], toolCalls: OpenCodeCanonicalToolCall[] = []
  const texts: string[] = [], reasoning: string[] = [], partTypes: string[] = []
  let role: OpenCodeCanonicalMessage['role'] = 'unknown'
  if (message.type === 'assistant') {
    role = 'assistant'
    executionAssert(Array.isArray(row.content), 'v2_transcript_invalid_assistant')
    const toolIDs = new Set<string>()
    for (const value of row.content) {
      const part = record(value); executionAssert(part, 'v2_transcript_invalid_content')
      const kind = string(part.type); executionAssert(kind, 'v2_transcript_invalid_content')
      partTypes.push(kind)
      if (kind === 'text' || kind === 'reasoning') {
        executionAssert(typeof part.text === 'string', 'v2_transcript_invalid_text')
        contentBlocks.push({ type: kind, text: part.text })
        if (kind === 'text') texts.push(part.text); else reasoning.push(part.text)
      } else if (kind === 'tool') {
        const tool = projectTool(part)
        executionAssert(tool.call.callId && !toolIDs.has(tool.call.callId), 'v2_transcript_duplicate_tool')
        toolIDs.add(tool.call.callId); toolCalls.push(tool.call); contentBlocks.push(...tool.blocks)
      } else diagnostics.push(`v2_transcript_unknown_assistant_content:${message.id}:${kind}`)
    }
  } else if (['user', 'system', 'synthetic', 'skill'].includes(message.type)) {
    role = message.type === 'user' ? 'user' : 'system'
    executionAssert(typeof row.text === 'string', 'v2_transcript_invalid_text')
    texts.push(row.text); partTypes.push('text'); contentBlocks.push({ type: 'text', text: row.text })
    // The canonical protocol has no native file/mention/skill attachment block.
    // Preserve supported text and disclose omitted attachment presentation.
    if (['files', 'agents', 'skills'].some(key => { const value = row[key]; return Array.isArray(value) && value.length > 0 }))
      diagnostics.push(`v2_transcript_attachment_presentation_unavailable:${message.id}`)
  } else if (message.type === 'shell') {
    role = 'system'
    executionAssert(typeof row.command === 'string', 'v2_transcript_invalid_shell')
    const output = record(row.output)
    const shellText = [row.command, typeof output?.output === 'string' ? output.output : ''].filter(Boolean).join('\n')
    texts.push(shellText); partTypes.push('text'); contentBlocks.push({ type: 'text', text: shellText })
  } else if (message.type === 'compaction') {
    role = 'system'
    if (typeof row.summary === 'string') { texts.push(row.summary); partTypes.push('text'); contentBlocks.push({ type: 'text', text: row.summary }) }
  } else if (['idle', 'agent-switched', 'model-switched', 'location-switched'].includes(message.type)) {
    role = 'system'; partTypes.push(message.type)
  } else diagnostics.push(`v2_transcript_unknown_message_type:${message.id}:${message.type}`)
  if (failure.name || failure.message) contentBlocks.push({ type: 'error', name: failure.name ?? 'OpenCodeError',
    message: failure.message ?? 'Unknown OpenCode runtime error' })
  const text = texts.join('\n\n')
  return { id: message.id, parentId: null, role, agent: string(row.agent), providerId: string(model?.providerID),
    modelId: string(model?.id), createdAt: timestamp(time?.created), completedAt: timestamp(time?.completed),
    text, reasoningText: reasoning.join('\n\n'), previewText: preview(text), partTypes, reasoningPartCount: reasoning.length,
    toolCalls, contentBlocks, finishReason: string(row.finish), errorName: failure.name, errorMessage: failure.message,
    hasError: failure.name !== null || failure.message !== null }
}

/** Public DTO normalization only: never fabricates V1 wire messages, native
 * parent IDs, effect receipts, or settled turns from completed assistant text. */
export function normalizeV2Transcript(result: { messages: ExecutionMessagePage; log: ExecutionLog }, sessionID: string): OpenCodeV2CanonicalTranscript {
  executionAssert(/^ses_[A-Za-z0-9]+$/.test(sessionID) && result.messages.previous === null && result.messages.next === null &&
    result.messages.data.length <= 1600 && result.log.synced === true && result.log.events.length <= 4096,
  'v2_transcript_incomplete_cut')
  executionAssert(new Set(result.messages.data.map(message => message.id)).size === result.messages.data.length,
    'v2_transcript_duplicate_message')
  let last = -1; const eventIDs = new Set<string>(), diagnostics = ['v2_native_parent_ids_unavailable']
  let durableState: OpenCodeDurableSessionState = 'unknown'
  for (const event of result.log.events) {
    executionAssert(event.aggregateID === sessionID && event.data.sessionID === sessionID && Number.isSafeInteger(event.seq) &&
      event.seq > last && !eventIDs.has(event.id), 'v2_transcript_foreign_or_incomplete_log')
    last = event.seq; eventIDs.add(event.id)
    if (event.type === 'session.execution.started' || event.type === 'session.step.started') durableState = 'running'
    else if (event.type === 'session.retry.scheduled') durableState = 'retrying'
    else if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)) {
      const outcome = event.type === 'session.execution.succeeded' ? 'succeeded' : event.type === 'session.execution.failed' ? 'failed' : 'interrupted'
      const idle = result.messages.data.find(message => message.id === event.id.replace(/^evt_/, 'msg_'))
      const valid = outcome === 'interrupted' && event.data.reason === 'shutdown' || idle?.type === 'idle' && idle.data.outcome === outcome
      durableState = valid ? outcome === 'failed' ? 'error' : 'idle' : 'unknown'
      if (!valid) diagnostics.push(`v2_transcript_terminal_snapshot_mismatch:${event.id}`)
    }
  }
  executionAssert(result.log.watermark === (result.log.events.at(-1)?.seq ?? null), 'v2_transcript_incomplete_watermark')
  const messages = result.messages.data.map(message => projectMessage(message, diagnostics, sessionID))
  const latestUser = messages.filter(message => message.role === 'user').at(-1)
  const latestAssistant = messages.filter(message => message.role === 'assistant').at(-1)
  const summary: OpenCodeSessionReconcileSummary = { sessionId: sessionID, reconcileOutcome: 'reconciled', rawStatus: null,
    durableState, staleReason: null, profileAuthState: null, pendingPermissionRequestIds: [], messageCount: messages.length,
    toolCallCount: messages.reduce((count, message) => count + message.toolCalls.length, 0),
    errorCount: messages.reduce((count, message) => count + Number(message.hasError), 0),
    lastCanonicalCursor: messages.at(-1)?.id ?? null, latestUserMessageId: latestUser?.id ?? null,
    latestAssistantMessageId: latestAssistant?.id ?? null, latestAssistantText: latestAssistant?.text ?? null,
    latestAssistantPreview: latestAssistant?.previewText ?? null, replyPendingSinceMessageId: null, messages, diagnostics }
  const logProjection = new OpenCodeLogProjector({ clock: () => messages[0]?.createdAt ?? 0 }).projectSummary(summary)
  return { sessionId: sessionID, durableState, messages, logProjection, diagnostics }
}
