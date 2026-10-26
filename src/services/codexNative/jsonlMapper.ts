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
  phase?: unknown
  server?: string
  tool?: string
  arguments?: unknown
  result?: unknown
  error?: unknown
  status?: string
  command?: string
  aggregated_output?: string
  output?: string
  stderr?: string
  exit_code?: number | null
  exitCode?: number | null
  changes?: Array<{
    path?: string
    kind?: string
  }>
}

type CodexItemCompletedEvent = {
  type?: 'item.completed'
  item?:
    | {
        id?: string
        type?: string
        text?: string
        phase?: unknown
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

type CodexErrorEvent = {
  type?: 'error'
  message?: string
}

type CodexTurnFailedEvent = {
  type?: 'turn.failed'
  error?: {
    message?: string
  }
}

type CodexExecJsonEvent =
  | CodexThreadStartedEvent
  | CodexTurnStartedEvent
  | CodexItemStartedEvent
  | CodexItemCompletedEvent
  | CodexTurnCompletedEvent
  | CodexErrorEvent
  | CodexTurnFailedEvent
  | {
      type?: string
      [key: string]: unknown
    }

function parseJsonLine(rawLine: string): CodexExecJsonEvent | null {
  try {
    const parsed = JSON.parse(rawLine) as Record<string, unknown>
    if (
      typeof parsed.type !== 'string' &&
      typeof parsed.method === 'string' &&
      parsed.params &&
      typeof parsed.params === 'object' &&
      !Array.isArray(parsed.params)
    ) {
      return {
        type: parsed.method,
        ...(parsed.params as Record<string, unknown>),
      } as CodexExecJsonEvent
    }
    return parsed as CodexExecJsonEvent
  } catch {
    return null
  }
}

function isCodexNativeToolMappingEnabled(): boolean {
  const value = process.env.CLAUDE_CODE_CODEX_NATIVE_TOOL_MAPPING_ENABLED
  if (value == null) {
    return true
  }
  return /^(1|true|yes|on)$/i.test(value.trim())
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

function normalizeItemStatus(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

function summarizeFileChanges(changes: CodexMcpToolCallItem['changes']): string {
  const normalizedChanges = Array.isArray(changes) ? changes : []
  if (normalizedChanges.length === 0) {
    return 'File changes completed.'
  }
  return [
    'File changes:',
    ...normalizedChanges.map(change => {
      const path = typeof change.path === 'string' && change.path.trim().length > 0
        ? change.path.trim()
        : '(unknown path)'
      const kind = typeof change.kind === 'string' && change.kind.trim().length > 0
        ? change.kind.trim()
        : 'update'
      return `- ${path} (${kind})`
    }),
  ].join('\n')
}

function buildCommandResult(item: CodexMcpToolCallItem): Record<string, unknown> {
  const output =
    typeof item.aggregated_output === 'string'
      ? item.aggregated_output
      : typeof item.output === 'string'
        ? item.output
        : ''
  const stderr = typeof item.stderr === 'string' ? item.stderr : ''
  const exitCode =
    typeof item.exit_code === 'number'
      ? item.exit_code
      : typeof item.exitCode === 'number'
        ? item.exitCode
        : null
  const status = normalizeItemStatus(item.status, 'unknown')
  return {
    content: output || stderr || `Command ${status}.`,
    stdout: output,
    stderr,
    exitCode,
    status,
    toolName: 'Bash',
    toolUseId: item.id,
  }
}

function getCommandExitCode(item: CodexMcpToolCallItem): number | null {
  return typeof item.exit_code === 'number'
    ? item.exit_code
    : typeof item.exitCode === 'number'
      ? item.exitCode
      : null
}

function buildFileChangeResult(item: CodexMcpToolCallItem): Record<string, unknown> {
  const content = summarizeFileChanges(item.changes)
  return {
    content,
    changes: Array.isArray(item.changes) ? item.changes : [],
    status: normalizeItemStatus(item.status, 'unknown'),
    toolName: 'Edit',
    toolUseId: item.id,
  }
}

function mapNativeItemStarted(item: CodexMcpToolCallItem): CodexNativeNormalizedEvent[] {
  if (typeof item.id !== 'string') {
    return []
  }

  if (item.type === 'command_execution') {
    return [
      {
        type: 'tool_call_started',
        itemId: item.id,
        toolSource: 'native',
        toolName: 'Bash',
        arguments: {
          command: typeof item.command === 'string' ? item.command : '',
        },
        status: normalizeItemStatus(item.status, 'in_progress'),
        rawItemType: 'command_execution',
      },
    ]
  }

  if (item.type === 'file_change') {
    return [
      {
        type: 'tool_call_started',
        itemId: item.id,
        toolSource: 'native',
        toolName: 'Edit',
        arguments: {
          file_path: item.changes?.find(change => typeof change.path === 'string')?.path ?? '',
          changes: Array.isArray(item.changes) ? item.changes : [],
        },
        status: normalizeItemStatus(item.status, 'in_progress'),
        rawItemType: 'file_change',
      },
    ]
  }

  return []
}

function mapNativeItemCompleted(item: CodexMcpToolCallItem): CodexNativeNormalizedEvent[] {
  if (typeof item.id !== 'string') {
    return []
  }

  if (item.type === 'command_execution') {
    const status = normalizeItemStatus(item.status, 'unknown')
    const rawResult = buildCommandResult(item)
    const resultText = typeof rawResult.content === 'string' ? rawResult.content : null
    const exitCode = getCommandExitCode(item)
    return [
      {
        type: 'tool_call_completed',
        itemId: item.id,
        toolSource: 'native',
        toolName: 'Bash',
        arguments: {
          command: typeof item.command === 'string' ? item.command : '',
        },
        status,
        resultText,
        rawResult,
        errorMessage: status === 'failed' ? resultText : null,
        isError: status === 'failed' || status === 'declined' || (exitCode !== null && exitCode !== 0),
        rawItemType: 'command_execution',
      },
    ]
  }

  if (item.type === 'file_change') {
    const status = normalizeItemStatus(item.status, 'unknown')
    const rawResult = buildFileChangeResult(item)
    const resultText = typeof rawResult.content === 'string' ? rawResult.content : null
    return [
      {
        type: 'tool_call_completed',
        itemId: item.id,
        toolSource: 'native',
        toolName: 'Edit',
        arguments: {
          file_path: item.changes?.find(change => typeof change.path === 'string')?.path ?? '',
          changes: Array.isArray(item.changes) ? item.changes : [],
        },
        status,
        resultText,
        rawResult,
        errorMessage: status === 'failed' ? resultText : null,
        isError: status === 'failed',
        rawItemType: 'file_change',
      },
    ]
  }

  return []
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
        toolSource: 'mcp',
        serverName: event.item.server,
        toolName: event.item.tool,
        arguments: asRecord(event.item.arguments) ?? {},
        status:
          typeof event.item.status === 'string' && event.item.status.trim().length > 0
            ? event.item.status
            : 'in_progress',
        rawItemType: 'mcp_tool_call',
      },
    ]
  }

  if (event.type === 'item.started' && event.item && isCodexNativeToolMappingEnabled()) {
    const nativeEvents = mapNativeItemStarted(event.item)
    if (nativeEvents.length > 0) {
      return nativeEvents
    }
    if (
      event.item.type === 'todo_list' ||
      event.item.type === 'reasoning' ||
      event.item.type === 'agent_message'
    ) {
      return []
    }
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
        ...(['commentary', 'partial_answer', 'final_answer'].includes(String(event.item.phase))
          ? { phase: event.item.phase as 'commentary' | 'partial_answer' | 'final_answer' } : {}),
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
        toolSource: 'mcp',
        serverName: event.item.server,
        toolName: event.item.tool,
        arguments: asRecord(event.item.arguments) ?? {},
        status,
        resultText:
          extractMcpToolResultText(event.item.result) ?? errorMessage,
        rawResult: event.item.result ?? event.item.error ?? null,
        errorMessage,
        isError,
        rawItemType: 'mcp_tool_call',
      },
    ]
  }

  if (event.type === 'item.completed' && event.item && isCodexNativeToolMappingEnabled()) {
    const nativeEvents = mapNativeItemCompleted(event.item)
    if (nativeEvents.length > 0) {
      return nativeEvents
    }
    if (event.item.type === 'todo_list' || event.item.type === 'reasoning') {
      return []
    }
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

  if (event.type === 'error' && typeof event.message === 'string') {
    const message = event.message.trim()
    if (message.length > 0) {
      return [
        {
          type: 'warning',
          source: 'codex',
          text: `Codex native error: ${message}`,
        },
      ]
    }
  }

  if (
    event.type === 'turn.failed' &&
    typeof event.error?.message === 'string'
  ) {
    const message = event.error.message.trim()
    if (message.length > 0) {
      return [
        {
          type: 'warning',
          source: 'codex',
          text: `Codex native turn failed: ${message}`,
        },
      ]
    }
  }

  if (
    event.type === 'item.started' ||
    event.type === 'item.completed' ||
    event.type === 'item.updated'
  ) {
    const itemType = asRecord(event)?.item
    const itemRecord = asRecord(itemType)
    if (itemRecord?.type === 'todo_list' || itemRecord?.type === 'reasoning') {
      return []
    }
    if (
      !isCodexNativeToolMappingEnabled() &&
      (itemRecord?.type === 'command_execution' || itemRecord?.type === 'file_change')
    ) {
      return []
    }
    return [
      {
        type: 'unsupported_raw_event',
        rawType:
          typeof itemRecord?.type === 'string'
            ? `${event.type}:${itemRecord.type}`
            : event.type,
        payload: event,
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
