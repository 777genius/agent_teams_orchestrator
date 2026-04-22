import type { CodexNativeNormalizedEvent } from './normalizedEvents.js'

type CodexThreadStartedEvent = {
  type?: 'thread.started'
  thread_id?: string
}

type CodexTurnStartedEvent = {
  type?: 'turn.started'
}

type CodexMcpToolCallItem = {
  id?: string
  type?: string
  text?: string
  server?: string
  tool?: string
  arguments?: unknown
  result?: unknown
  error?: unknown
  status?: string
}

type CodexItemCompletedEvent = {
  type?: 'item.completed'
  item?:
    | {
        id?: string
        type?: string
        text?: string
      }
    | CodexMcpToolCallItem
}

type CodexItemStartedEvent = {
  type?: 'item.started'
  item?: CodexMcpToolCallItem
}

type CodexTurnCompletedEvent = {
  type?: 'turn.completed'
  usage?: {
    input_tokens?: number
    cached_input_tokens?: number
    output_tokens?: number
  }
}

type CodexExecJsonEvent =
  | CodexThreadStartedEvent
  | CodexTurnStartedEvent
  | CodexItemStartedEvent
  | CodexItemCompletedEvent
  | CodexTurnCompletedEvent
  | {
      type?: string
      [key: string]: unknown
    }

function parseJsonLine(rawLine: string): CodexExecJsonEvent | null {
  try {
    return JSON.parse(rawLine) as CodexExecJsonEvent
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function extractMcpToolResultText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  const record = asRecord(value)
  const content = record?.content
  if (Array.isArray(content)) {
    const textSegments = content
      .map(block => asRecord(block))
      .map(block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : null))
      .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
    if (textSegments.length > 0) {
      return textSegments.join('\n').trim()
    }
  }

  if (record) {
    const structuredContent = record.structured_content
    if (structuredContent != null) {
      return JSON.stringify(structuredContent)
    }
  }

  return null
}

function extractMcpToolErrorMessage(value: unknown): string | null {
  const record = asRecord(value)
  const message = record?.message
  return typeof message === 'string' && message.trim().length > 0 ? message : null
}

function mapJsonEvent(event: CodexExecJsonEvent): CodexNativeNormalizedEvent[] {
  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    return [
      {
        type: 'thread_started',
        threadId: event.thread_id,
      },
    ]
  }

  if (event.type === 'turn.started') {
    return [{ type: 'turn_started' }]
  }

  if (
    event.type === 'item.started' &&
    event.item?.type === 'mcp_tool_call' &&
    typeof event.item.id === 'string' &&
    typeof event.item.server === 'string' &&
    typeof event.item.tool === 'string'
  ) {
    return [
      {
        type: 'tool_call_started',
        itemId: event.item.id,
        serverName: event.item.server,
        toolName: event.item.tool,
        arguments: asRecord(event.item.arguments) ?? {},
        status:
          typeof event.item.status === 'string' && event.item.status.trim().length > 0
            ? event.item.status
            : 'in_progress',
      },
    ]
  }

  if (
    event.type === 'item.completed' &&
    event.item?.type === 'agent_message' &&
    typeof event.item.id === 'string' &&
    typeof event.item.text === 'string'
  ) {
    return [
      {
        type: 'assistant_text',
        itemId: event.item.id,
        text: event.item.text,
      },
    ]
  }

  if (
    event.type === 'item.completed' &&
    event.item?.type === 'mcp_tool_call' &&
    typeof event.item.id === 'string' &&
    typeof event.item.server === 'string' &&
    typeof event.item.tool === 'string'
  ) {
    const errorMessage = extractMcpToolErrorMessage(event.item.error)
    const status =
      typeof event.item.status === 'string' && event.item.status.trim().length > 0
        ? event.item.status
        : 'unknown'
    const isError = status === 'failed' || errorMessage !== null
    return [
      {
        type: 'tool_call_completed',
        itemId: event.item.id,
        serverName: event.item.server,
        toolName: event.item.tool,
        arguments: asRecord(event.item.arguments) ?? {},
        status,
        resultText:
          extractMcpToolResultText(event.item.result) ?? errorMessage,
        rawResult: event.item.result ?? null,
        errorMessage,
        isError,
      },
    ]
  }

  if (event.type === 'turn.completed') {
    return [
      {
        type: 'usage_updated',
        inputTokens: event.usage?.input_tokens ?? 0,
        cachedInputTokens: event.usage?.cached_input_tokens ?? 0,
        outputTokens: event.usage?.output_tokens ?? 0,
      },
      {
        type: 'turn_completed',
      },
    ]
  }

  if (event.type === 'item.started' || event.type === 'item.completed') {
    return []
  }

  return [
    {
      type: 'unsupported_raw_event',
      rawType: event.type ?? 'unknown',
      payload: event,
    },
  ]
}

export function mapCodexNativeExecLine(
  rawLine: string,
): CodexNativeNormalizedEvent[] {
  const line = rawLine.trim()
  if (!line) {
    return []
  }

  if (!line.startsWith('{')) {
    return [
      {
        type: 'warning',
        source: 'stderr',
        text: line,
      },
    ]
  }

  const parsed = parseJsonLine(line)
  if (!parsed) {
    return [
      {
        type: 'warning',
        source: 'stderr',
        text: line,
      },
    ]
  }

  return mapJsonEvent(parsed)
}

export function mapCodexNativeExecOutput(
  rawOutput: string,
): CodexNativeNormalizedEvent[] {
  return rawOutput
    .split(/\r?\n/)
    .flatMap(line => mapCodexNativeExecLine(line))
}
