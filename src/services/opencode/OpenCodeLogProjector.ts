import {
  CHANNEL_MESSAGE_TAG,
  CROSS_SESSION_MESSAGE_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../../constants/xml.js'

import type {
  OpenCodeCanonicalContentBlock,
  OpenCodeCanonicalMessage,
  OpenCodeLogProjection,
  OpenCodeProjectedLogContentBlock,
  OpenCodeProjectedLogMessage,
  OpenCodeProjectedLogToolCall,
  OpenCodeProjectedLogToolResult,
  OpenCodeSessionReconcileSummary,
} from './types.js'

type OpenCodeLogProjectorClock = () => number

const MAX_PROJECTED_TOOL_RESULT_TEXT_CHARS = 8_000
const NON_HUMAN_USER_PROTOCOL_TAGS = [
  CHANNEL_MESSAGE_TAG,
  CROSS_SESSION_MESSAGE_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
] as const
const HUMAN_REPLAY_PREFIX = 'Human:'

function asFiniteTimestamp(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toIsoTimestamp(
  value: number | null | undefined,
  fallbackTimestamp: number,
): string {
  return new Date(asFiniteTimestamp(value) ?? fallbackTimestamp).toISOString()
}

function getNonHumanUserProtocolKind(
  message: OpenCodeCanonicalMessage,
): string | undefined {
  const texts = [
    message.text,
    ...message.contentBlocks.flatMap(block =>
      block.type === 'text' ? [block.text] : [],
    ),
  ]
  for (const raw of texts) {
    const text = raw.trimStart()
    const protocolText = text.startsWith(HUMAN_REPLAY_PREFIX)
      ? text.slice(HUMAN_REPLAY_PREFIX.length).trimStart()
      : text
    const protocolKind = NON_HUMAN_USER_PROTOCOL_TAGS.find(tag =>
      protocolText.startsWith(`<${tag}`),
    )
    if (protocolKind) return protocolKind
  }
  return undefined
}

function buildFallbackUuid(params: {
  sessionId: string
  role: string
  index: number
}): string {
  return `${params.sessionId}::${params.role}::${params.index}`
}

function buildFallbackToolUseId(params: {
  assistantUuid: string
  toolIndex: number
}): string {
  return `${params.assistantUuid}::tool::${params.toolIndex}`
}

function buildModelRef(message: OpenCodeCanonicalMessage): string | undefined {
  if (message.providerId && message.modelId) {
    return `${message.providerId}/${message.modelId}`
  }
  return message.modelId ?? undefined
}

function truncateProjectedToolResultText(value: string): string {
  if (value.length <= MAX_PROJECTED_TOOL_RESULT_TEXT_CHARS) {
    return value
  }

  const omitted = value.length - MAX_PROJECTED_TOOL_RESULT_TEXT_CHARS
  return `${value.slice(0, MAX_PROJECTED_TOOL_RESULT_TEXT_CHARS)}\n...[truncated ${omitted} chars from OpenCode tool result]`
}

function stringifyToolResultContent(value: unknown): string | OpenCodeProjectedLogContentBlock[] {
  if (typeof value === 'string') {
    return truncateProjectedToolResultText(value)
  }

  if (Array.isArray(value)) {
    const textBlocks = value.flatMap((item): OpenCodeProjectedLogContentBlock[] => {
      if (
        item
        && typeof item === 'object'
        && 'type' in item
        && item.type === 'text'
        && 'text' in item
        && typeof item.text === 'string'
      ) {
        return [{ type: 'text', text: truncateProjectedToolResultText(item.text) }]
      }
      return []
    })
    if (textBlocks.length > 0) {
      return textBlocks
    }
  }

  if (value === null || value === undefined) {
    return ''
  }

  try {
    return truncateProjectedToolResultText(JSON.stringify(value, null, 2))
  } catch {
    return truncateProjectedToolResultText(String(value))
  }
}

function buildToolUseBlock(
  block: Extract<OpenCodeCanonicalContentBlock, { type: 'tool_use' }>,
  fallbackId: string,
): {
  contentBlock: OpenCodeProjectedLogContentBlock
  toolCall: OpenCodeProjectedLogToolCall
} {
  const id = block.id ?? fallbackId
  const name = block.name ?? 'unknown'
  const input = block.input ?? {}

  return {
    contentBlock: {
      type: 'tool_use',
      id,
      name,
      input,
    },
    toolCall: {
      id,
      name,
      input,
      isTask: name === 'Task',
      ...(name === 'Task' && typeof input.description === 'string'
        ? { taskDescription: input.description }
        : {}),
      ...(name === 'Task' && typeof input.subagent_type === 'string'
        ? { taskSubagentType: input.subagent_type }
        : {}),
    },
  }
}

function buildAssistantLogMessage(params: {
  sessionId: string
  message: OpenCodeCanonicalMessage
  index: number
  assistantUuid: string
  timestampFallback: () => number
}): OpenCodeProjectedLogMessage | null {
  const content: OpenCodeProjectedLogContentBlock[] = []
  const toolCalls: OpenCodeProjectedLogToolCall[] = []

  for (const block of params.message.contentBlocks) {
    switch (block.type) {
      case 'reasoning':
        content.push({
          type: 'thinking',
          thinking: block.text,
          signature: 'opencode',
        })
        break
      case 'text':
        content.push({
          type: 'text',
          text: block.text,
        })
        break
      case 'tool_use': {
        const projected = buildToolUseBlock(
          block,
          buildFallbackToolUseId({
            assistantUuid: params.assistantUuid,
            toolIndex: toolCalls.length,
          }),
        )
        content.push(projected.contentBlock)
        toolCalls.push(projected.toolCall)
        break
      }
      default:
        break
    }
  }

  if (content.length === 0) {
    return null
  }

  return {
    uuid: params.message.id ?? buildFallbackUuid({
      sessionId: params.sessionId,
      role: 'assistant',
      index: params.index,
    }),
    parentUuid: params.message.parentId,
    type: 'assistant',
    timestamp: toIsoTimestamp(params.message.createdAt, params.timestampFallback()),
    role: 'assistant',
    content,
    model: buildModelRef(params.message),
    agentName: params.message.agent ?? undefined,
    isMeta: false,
    sessionId: params.sessionId,
    toolCalls,
    toolResults: [],
  }
}

function buildSyntheticToolResultMessage(params: {
  sessionId: string
  assistantUuid: string
  message: OpenCodeCanonicalMessage
  index: number
  timestampFallback: () => number
}): OpenCodeProjectedLogMessage | null {
  const content: OpenCodeProjectedLogContentBlock[] = []
  const toolResults: OpenCodeProjectedLogToolResult[] = []

  for (const [toolIndex, toolCall] of params.message.toolCalls.entries()) {
    const toolUseId =
      toolCall.callId
      ?? buildFallbackToolUseId({
        assistantUuid: params.assistantUuid,
        toolIndex,
      })
    const rawContent =
      toolCall.output !== null && toolCall.output !== undefined
        ? toolCall.output
        : toolCall.outputText
    if (rawContent === null || rawContent === undefined) {
      if (!toolCall.isError) {
        continue
      }
    }

    const normalizedContent = stringifyToolResultContent(
      rawContent ?? toolCall.outputText ?? 'OpenCode tool failed without output',
    )
    content.push({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: normalizedContent,
      ...(toolCall.isError ? { is_error: true } : {}),
    })
    toolResults.push({
      toolUseId,
      content: normalizedContent,
      isError: toolCall.isError,
    })
  }

  if (content.length === 0) {
    return null
  }

  return {
    uuid: `${params.assistantUuid}::tool_results`,
    parentUuid: params.assistantUuid,
    type: 'user',
    timestamp: toIsoTimestamp(
      params.message.completedAt ?? params.message.createdAt,
      params.timestampFallback(),
    ),
    role: 'user',
    content,
    model: buildModelRef(params.message),
    agentName: params.message.agent ?? undefined,
    isMeta: true,
    sessionId: params.sessionId,
    toolCalls: [],
    toolResults,
    ...(toolResults.length === 1 ? { sourceToolUseID: toolResults[0]?.toolUseId } : {}),
    sourceToolAssistantUUID: params.assistantUuid,
  }
}

function buildSystemErrorMessage(params: {
  sessionId: string
  assistantUuid: string
  assistantProjected: boolean
  message: OpenCodeCanonicalMessage
  timestampFallback: () => number
}): OpenCodeProjectedLogMessage | null {
  if (!params.message.hasError) {
    return null
  }

  const errorLabel = params.message.errorName ?? 'OpenCodeError'
  const errorMessage = params.message.errorMessage ?? 'Unknown OpenCode runtime error'
  return {
    uuid: `${params.assistantUuid}::error`,
    parentUuid: params.assistantProjected ? params.assistantUuid : params.message.parentId,
    type: 'system',
    timestamp: toIsoTimestamp(
      params.message.completedAt ?? params.message.createdAt,
      params.timestampFallback(),
    ),
    content: `OpenCode runtime error - ${errorLabel}: ${errorMessage}`,
    model: buildModelRef(params.message),
    agentName: params.message.agent ?? undefined,
    isMeta: true,
    sessionId: params.sessionId,
    toolCalls: [],
    toolResults: [],
    subtype: 'informational',
    level: 'error',
  }
}

function buildUserLogMessage(params: {
  sessionId: string
  message: OpenCodeCanonicalMessage
  index: number
  timestampFallback: () => number
}): OpenCodeProjectedLogMessage | null {
  const content = params.message.contentBlocks.flatMap((block): OpenCodeProjectedLogContentBlock[] => {
    if (block.type === 'text') {
      return [{ type: 'text', text: block.text }]
    }
    return []
  })

  if (content.length === 0) {
    return null
  }

  const protocolKind = getNonHumanUserProtocolKind(params.message)

  return {
    uuid: params.message.id ?? buildFallbackUuid({
      sessionId: params.sessionId,
      role: 'user',
      index: params.index,
    }),
    parentUuid: params.message.parentId,
    type: 'user',
    timestamp: toIsoTimestamp(params.message.createdAt, params.timestampFallback()),
    role: 'user',
    content,
    model: buildModelRef(params.message),
    agentName: params.message.agent ?? undefined,
    isMeta: protocolKind !== undefined,
    isSynthetic: protocolKind !== undefined ? true : undefined,
    protocolKind,
    sessionId: params.sessionId,
    toolCalls: [],
    toolResults: [],
  }
}

function buildSystemLogMessage(params: {
  sessionId: string
  message: OpenCodeCanonicalMessage
  index: number
  timestampFallback: () => number
}): OpenCodeProjectedLogMessage | null {
  const text = params.message.text.trim()
  if (!text) {
    return null
  }

  return {
    uuid: params.message.id ?? buildFallbackUuid({
      sessionId: params.sessionId,
      role: 'system',
      index: params.index,
    }),
    parentUuid: params.message.parentId,
    type: 'system',
    timestamp: toIsoTimestamp(params.message.createdAt, params.timestampFallback()),
    role: 'system',
    content: text,
    model: buildModelRef(params.message),
    agentName: params.message.agent ?? undefined,
    isMeta: true,
    sessionId: params.sessionId,
    toolCalls: [],
    toolResults: [],
    subtype: 'informational',
    level: 'info',
  }
}

export class OpenCodeLogProjector {
  private readonly clock: OpenCodeLogProjectorClock

  constructor(params: {
    clock?: OpenCodeLogProjectorClock
  } = {}) {
    this.clock = params.clock ?? Date.now
  }

  projectSummary(summary: OpenCodeSessionReconcileSummary): OpenCodeLogProjection {
    const messages: OpenCodeProjectedLogMessage[] = []
    let syntheticMessageCount = 0
    let fallbackTimestamp = asFiniteTimestamp(this.clock()) ?? Date.now()

    const nextFallbackTimestamp = (): number => {
      const timestamp = fallbackTimestamp
      fallbackTimestamp += 1
      return timestamp
    }

    summary.messages.forEach((message, index) => {
      switch (message.role) {
        case 'assistant': {
          const assistantUuid =
            message.id
            ?? buildFallbackUuid({
              sessionId: summary.sessionId,
              role: 'assistant',
              index,
            })
          const assistantMessage = buildAssistantLogMessage({
            sessionId: summary.sessionId,
            message,
            index,
            assistantUuid,
            timestampFallback: nextFallbackTimestamp,
          })
          if (assistantMessage) {
            messages.push(assistantMessage)
          }

          const toolResultMessage = buildSyntheticToolResultMessage({
            sessionId: summary.sessionId,
            assistantUuid,
            message,
            index,
            timestampFallback: nextFallbackTimestamp,
          })
          if (toolResultMessage) {
            syntheticMessageCount += 1
            messages.push(toolResultMessage)
          }

          const systemErrorMessage = buildSystemErrorMessage({
            sessionId: summary.sessionId,
            assistantUuid,
            assistantProjected: assistantMessage !== null,
            message,
            timestampFallback: nextFallbackTimestamp,
          })
          if (systemErrorMessage) {
            syntheticMessageCount += 1
            messages.push(systemErrorMessage)
          }
          break
        }
        case 'user': {
          const userMessage = buildUserLogMessage({
            sessionId: summary.sessionId,
            message,
            index,
            timestampFallback: nextFallbackTimestamp,
          })
          if (userMessage) {
            messages.push(userMessage)
          }
          break
        }
        case 'system': {
          const systemMessage = buildSystemLogMessage({
            sessionId: summary.sessionId,
            message,
            index,
            timestampFallback: nextFallbackTimestamp,
          })
          if (systemMessage) {
            messages.push(systemMessage)
          }
          break
        }
        default:
          break
      }
    })

    return {
      sessionId: summary.sessionId,
      durableState: summary.durableState,
      sourceMessageCount: summary.messageCount,
      projectedMessageCount: messages.length,
      syntheticMessageCount,
      toolCallCount: summary.toolCallCount,
      errorCount: summary.errorCount,
      diagnostics: [...summary.diagnostics],
      messages,
    }
  }
}

export const openCodeLogProjector = new OpenCodeLogProjector()
