import { describe, expect, test } from 'bun:test'

import type { SDKMessage, SDKUserMessageReplay } from '../../entrypoints/agentSdkTypes.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'
import { executeCodexNativeTurn } from './turnExecutor.js'

function baseParams(overrides: Partial<Parameters<typeof executeCodexNativeTurn>[0]> = {}) {
  return {
    prompt: 'Reply only with OK',
    cwd: '/tmp/demo',
    model: 'gpt-5.3-codex',
    effortValue: undefined,
    permissionMode: 'default' as const,
    additionalWritableDirectories: [],
    persistSession: false,
    replayedUserMessages: [] as SDKUserMessageReplay[],
    transcriptMessages: [],
    mutableMessages: [],
    totalUsage: EMPTY_USAGE,
    permissionDenials: [],
    initialAppState: {
      fastMode: false,
    } as never,
    startTime: Date.now() - 10,
    setSDKStatus: () => {},
    ...overrides,
  }
}

async function collectMessages(
  iterator: AsyncGenerator<SDKMessage, unknown, unknown>,
): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = []
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      return messages
    }
    messages.push(next.value)
  }
}

async function collectMessagesAndSummary(
  iterator: AsyncGenerator<SDKMessage, unknown, unknown>,
): Promise<{ messages: SDKMessage[]; summary: unknown }> {
  const messages: SDKMessage[] = []
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      return {
        messages,
        summary: next.value,
      }
    }
    messages.push(next.value)
  }
}

describe('executeCodexNativeTurn', () => {
  test('rejects non-text prompts conservatively', async () => {
    const params = baseParams({
      prompt: [
        {
          type: 'text',
          text: 'Look at this screenshot',
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'abc',
          },
        } as never,
      ],
    })

    const messages = await collectMessages(executeCodexNativeTurn(params))

    expect(messages[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining('text-only prompts'),
          },
        ],
      },
    })
    expect(messages[1]).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [expect.stringContaining('text-only prompts')],
    })
  })

  test('projects native execution into assistant output, warnings, and a success result', async () => {
    const params = baseParams({
      replayedUserMessages: [
        {
          type: 'user',
          message: {
            role: 'user',
            content: 'Reply only with OK',
          },
          session_id: 'session-1',
          parent_tool_use_id: null,
          uuid: 'user-1',
          timestamp: new Date().toISOString(),
          isReplay: true,
        },
      ],
      persistSession: true,
    })

    const transcriptSnapshots: number[] = []
    const iterator = executeCodexNativeTurn(params, {
      runExec: async function* () {
        yield {
          type: 'binary_identity',
          identity: {
            executablePath: '/usr/local/bin/codex',
            executableSource: 'system-path',
            version: 'codex-cli 0.117.0',
          },
        }
        yield {
          type: 'normalized_event',
          event: {
            type: 'thread_started',
            threadId: 'thread-1',
          },
        }
        yield {
          type: 'normalized_event',
          event: {
            type: 'warning',
            source: 'stderr',
            text: 'native stderr warning',
          },
        }
        yield {
          type: 'normalized_event',
          event: {
            type: 'assistant_text',
            itemId: 'item_0',
            text: 'OK',
          },
        }
        yield {
          type: 'normalized_event',
          event: {
            type: 'usage_updated',
            inputTokens: 12,
            cachedInputTokens: 4,
            outputTokens: 2,
          },
        }
        yield {
          type: 'normalized_event',
          event: {
            type: 'turn_completed',
          },
        }
        return {
          identity: {
            executablePath: '/usr/local/bin/codex',
            executableSource: 'system-path',
            version: 'codex-cli 0.117.0',
          },
          threadId: 'thread-1',
          credentialSource: 'explicit-api-key',
          completionPolicy: 'ephemeral',
          finalHistoryCompleteness: 'live-only',
          finalUsageAuthority: 'live-turn-completed',
        }
      },
      recordTranscript: async messages => {
        transcriptSnapshots.push(messages.length)
      },
      flushSessionStorage: async () => {},
    })

    const { messages, summary } = await collectMessagesAndSummary(iterator)

    expect(messages).toMatchObject([
      {
        type: 'user',
        uuid: 'user-1',
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'OK',
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'OK',
        is_error: false,
      },
    ])

    expect(params.transcriptMessages).toMatchObject([
      {
        type: 'system',
        subtype: 'codex_native_thread_status',
        codexNativeThreadStatus: 'running',
        codexNativeThreadId: 'thread-1',
      },
      {
        type: 'system',
        subtype: 'codex_native_warning',
        level: 'warning',
        content: 'native stderr warning',
        codexNativeWarningSource: 'process',
      },
      {
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 4,
            output_tokens: 2,
          },
        },
      },
      {
        type: 'system',
        subtype: 'codex_native_execution_summary',
        codexNativeThreadId: 'thread-1',
        codexNativeCompletionPolicy: 'ephemeral',
        codexNativeHistoryCompleteness: 'live-only',
        codexNativeFinalUsageAuthority: 'live-turn-completed',
        codexNativeExecutableSource: 'system-path',
        codexNativeExecutableVersion: 'codex-cli 0.117.0',
      },
      {
        type: 'system',
        subtype: 'codex_native_thread_status',
        codexNativeThreadStatus: 'completed',
        codexNativeThreadId: 'thread-1',
      },
    ])
    expect(transcriptSnapshots.length).toBeGreaterThanOrEqual(2)
    expect(summary).toEqual({
      totalUsage: expect.objectContaining({
        input_tokens: 12,
        cache_read_input_tokens: 4,
        output_tokens: 2,
      }),
      binaryIdentity: {
        executablePath: '/usr/local/bin/codex',
        executableSource: 'system-path',
        version: 'codex-cli 0.117.0',
      },
      threadId: 'thread-1',
      credentialSource: 'explicit-api-key',
      completionPolicy: 'ephemeral',
      finalHistoryCompleteness: 'live-only',
      finalUsageAuthority: 'live-turn-completed',
    })
  })

  test('records explicit hydration-required history truth for persistent native runs', async () => {
    const params = baseParams({
      persistSession: true,
    })

    const iterator = executeCodexNativeTurn(params, {
      runExec: async function* () {
        yield {
          type: 'binary_identity',
          identity: {
            executablePath: '/usr/local/bin/codex',
            executableSource: 'system-path',
            version: 'codex-cli 0.117.0',
          },
        }
        yield {
          type: 'normalized_event',
          event: {
            type: 'thread_started',
            threadId: 'thread-persistent',
          },
        }
        yield {
          type: 'normalized_event',
          event: {
            type: 'assistant_text',
            itemId: 'item_0',
            text: 'OK',
          },
        }
        yield {
          type: 'normalized_event',
          event: {
            type: 'usage_updated',
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
          },
        }
        yield {
          type: 'normalized_event',
          event: {
            type: 'turn_completed',
          },
        }
        return {
          identity: {
            executablePath: '/usr/local/bin/codex',
            executableSource: 'system-path',
            version: 'codex-cli 0.117.0',
          },
          threadId: 'thread-persistent',
          credentialSource: 'ambient-process-env',
          completionPolicy: 'persistent',
          finalHistoryCompleteness: 'explicit-hydration-required',
          finalUsageAuthority: 'live-turn-completed',
        }
      },
      recordTranscript: async () => {},
      flushSessionStorage: async () => {},
    })

    await collectMessagesAndSummary(iterator)

    expect(params.transcriptMessages).toMatchObject([
      {
        type: 'system',
        subtype: 'codex_native_thread_status',
        codexNativeThreadStatus: 'running',
        codexNativeThreadId: 'thread-persistent',
      },
      {
        type: 'assistant',
      },
      {
        type: 'system',
        subtype: 'codex_native_execution_summary',
        codexNativeThreadId: 'thread-persistent',
        codexNativeCompletionPolicy: 'persistent',
        codexNativeHistoryCompleteness: 'explicit-hydration-required',
      },
      {
        type: 'system',
        subtype: 'codex_native_thread_status',
        codexNativeThreadStatus: 'completed',
        codexNativeThreadId: 'thread-persistent',
      },
    ])
  })
})
