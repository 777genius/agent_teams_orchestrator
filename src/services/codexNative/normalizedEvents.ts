export type CodexNativeToolSource = 'mcp' | 'native'

export type CodexNativeNormalizedEvent =
  | {
      type: 'thread_started'
      threadId: string
    }
  | {
      type: 'turn_started'
    }
  | {
      type: 'assistant_text'
      itemId: string
      text: string
    }
  | {
      type: 'tool_call_started'
      itemId: string
      toolSource: CodexNativeToolSource
      serverName?: string
      toolName: string
      arguments: Record<string, unknown>
      status: string
      rawItemType: string
    }
  | {
      type: 'tool_call_completed'
      itemId: string
      toolSource: CodexNativeToolSource
      serverName?: string
      toolName: string
      arguments: Record<string, unknown>
      status: string
      resultText: string | null
      rawResult: unknown
      errorMessage: string | null
      isError: boolean
      rawItemType: string
    }
  | {
      type: 'usage_updated'
      inputTokens: number
      cachedInputTokens: number
      outputTokens: number
    }
  | {
      type: 'turn_completed'
    }
  | {
      type: 'warning'
      source: 'stderr' | 'codex'
      text: string
    }
  | {
      type: 'unsupported_raw_event'
      rawType: string
      payload: unknown
    }

export type CodexNativeExecCapabilityProfile =
  | 'headless-limited'
  | 'interactive-unsupported'
