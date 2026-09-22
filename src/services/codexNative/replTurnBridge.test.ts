import { describe, expect, test } from 'bun:test'

import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import type { Message, StreamEvent } from '../../types/message.js'
import { runCodexNativeTurnInRepl } from './replTurnBridge.js'

function baseParams(
  overrides: Partial<Parameters<typeof runCodexNativeTurnInRepl>[0]> = {},
) {
  return {
    prompt: 'Reply only with OK',
    cwd: '/tmp/demo',
    model: 'gpt-5.4',
    effortValue: undefined,
    permissionMode: 'default' as const,
    additionalWritableDirectories: [],
    initialAppState: {
      fastMode: false,
    } as never,
    transcriptMessages: [],
    onReplEvent: (_event: Message | StreamEvent) => {},
    ...overrides,
  }
}

describe('runCodexNativeTurnInRepl', () => {
  test('forwards assistant and tool-result messages but suppresses success results', async () => {
    const events: (Message | StreamEvent)[] = []

    await runCodexNativeTurnInRepl(
      baseParams({
        onReplEvent: event => {
          events.push(event)
        },
      }),
      {
        executeTurn: async function* () {
          yield {
            type: 'assistant',
            uuid: 'assistant-1',
            timestamp: new Date().toISOString(),
            error: false,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'OK' }],
            },
          } as SDKMessage
          yield {
            type: 'user',
            uuid: 'tool-result-1',
            timestamp: new Date().toISOString(),
            session_id: 'session-1',
            parent_tool_use_id: null,
            tool_use_result: {
              content: 'done',
              is_error: false,
            },
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-1',
                  content: 'done',
                  is_error: false,
                },
              ],
            },
          } as SDKMessage
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            duration_ms: 10,
            duration_api_ms: 10,
            num_turns: 1,
            result: 'OK',
            stop_reason: 'end_turn',
            session_id: 'session-1',
            total_cost_usd: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            fast_mode_state: null,
            uuid: 'result-1',
          } as SDKMessage
          return {
            totalUsage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            binaryIdentity: null,
            threadId: null,
            credentialSource: null,
            completionPolicy: null,
            finalHistoryCompleteness: null,
            finalUsageAuthority: null,
          }
        },
      },
    )

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'OK' }],
      },
    })
    expect(events[1]).toMatchObject({
      type: 'user',
      message: {
        content: [{ type: 'tool_result' }],
      },
    })
  })

  test('suppresses duplicate error result after assistant api error', async () => {
    const events: (Message | StreamEvent)[] = []

    await runCodexNativeTurnInRepl(
      baseParams({
        onReplEvent: event => {
          events.push(event)
        },
      }),
      {
        executeTurn: async function* () {
          yield {
            type: 'assistant',
            uuid: 'assistant-error-1',
            timestamp: new Date().toISOString(),
            error: true,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Native lane failed' }],
            },
          } as SDKMessage
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            duration_ms: 10,
            duration_api_ms: 10,
            num_turns: 1,
            result: '',
            stop_reason: null,
            session_id: 'session-1',
            total_cost_usd: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            fast_mode_state: null,
            uuid: 'result-error-1',
            errors: ['Native lane failed'],
          } as SDKMessage
          return {
            totalUsage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            binaryIdentity: null,
            threadId: null,
            credentialSource: null,
            completionPolicy: null,
            finalHistoryCompleteness: null,
            finalUsageAuthority: null,
          }
        },
      },
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Native lane failed' }],
      },
    })
  })

  test('forwards execution errors when no assistant error was emitted', async () => {
    const events: (Message | StreamEvent)[] = []

    await runCodexNativeTurnInRepl(
      baseParams({
        onReplEvent: event => {
          events.push(event)
        },
      }),
      {
        executeTurn: async function* () {
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            duration_ms: 10,
            duration_api_ms: 10,
            num_turns: 1,
            result: '',
            stop_reason: null,
            session_id: 'session-1',
            total_cost_usd: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            fast_mode_state: null,
            uuid: 'result-error-2',
            errors: ['Native lane failed before assistant output'],
          } as SDKMessage
          return {
            totalUsage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            binaryIdentity: null,
            threadId: null,
            credentialSource: null,
            completionPolicy: null,
            finalHistoryCompleteness: null,
            finalUsageAuthority: null,
          }
        },
      },
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'system',
      content: 'Native lane failed before assistant output',
      level: 'warning',
    })
  })
})
