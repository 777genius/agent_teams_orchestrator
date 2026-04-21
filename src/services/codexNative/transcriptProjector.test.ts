import { describe, expect, test } from 'bun:test'

import { CodexNativeTranscriptProjector } from './transcriptProjector.js'

describe('CodexNativeTranscriptProjector', () => {
  test('projects assistant text and later usage into a transcript-compatible assistant message', () => {
    const projector = new CodexNativeTranscriptProjector()

    const assistantProjection = projector.apply({
      type: 'assistant_text',
      itemId: 'item_0',
      text: 'OK',
    })

    expect(assistantProjection.turnCompleted).toBe(false)
    expect(assistantProjection.appendedMessages).toHaveLength(1)
    expect(assistantProjection.appendedMessages[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'OK',
          },
        ],
      },
    })

    const usageProjection = projector.apply({
      type: 'usage_updated',
      inputTokens: 12,
      cachedInputTokens: 4,
      outputTokens: 2,
    })

    expect(usageProjection.appendedMessages).toEqual([])
    expect(projector.getLastAssistantMessage()).toMatchObject({
      message: {
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 4,
          output_tokens: 2,
        },
      },
    })
    expect(projector.getTotalUsage()).toMatchObject({
      input_tokens: 12,
      cache_read_input_tokens: 4,
      output_tokens: 2,
    })
  })

  test('projects warnings and unsupported raw events into system warning messages', () => {
    const projector = new CodexNativeTranscriptProjector()

    expect(
      projector.apply({
        type: 'thread_started',
        threadId: 'thread-1',
      }),
    ).toMatchObject({
      appendedMessages: [
        {
          type: 'system',
          subtype: 'codex_native_thread_status',
          codexNativeThreadStatus: 'running',
          codexNativeThreadId: 'thread-1',
        },
      ],
      turnCompleted: false,
    })

    expect(
      projector.apply({
        type: 'warning',
        source: 'stderr',
        text: 'native stderr warning',
      }),
    ).toMatchObject({
      appendedMessages: [
        {
          type: 'system',
          subtype: 'codex_native_warning',
          level: 'warning',
          content: 'native stderr warning',
          codexNativeWarningSource: 'process',
        },
      ],
      turnCompleted: false,
    })

    expect(
      projector.apply({
        type: 'unsupported_raw_event',
        rawType: 'tool/requestUserInput',
        payload: {},
      }),
    ).toMatchObject({
      appendedMessages: [
        {
          type: 'system',
          subtype: 'codex_native_warning',
          level: 'warning',
          content:
            'Codex native emitted an unsupported raw event: tool/requestUserInput',
          codexNativeWarningSource: 'process',
        },
      ],
      turnCompleted: false,
    })
  })
})
