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
      source: 'stderr'
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
