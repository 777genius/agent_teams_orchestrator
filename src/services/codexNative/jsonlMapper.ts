import type { CodexNativeNormalizedEvent } from './normalizedEvents.js'

type CodexThreadStartedEvent = {
  type?: 'thread.started'
  thread_id?: string
}

type CodexTurnStartedEvent = {
  type?: 'turn.started'
}

type CodexItemCompletedEvent = {
  type?: 'item.completed'
  item?: {
    id?: string
    type?: string
    text?: string
  }
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
