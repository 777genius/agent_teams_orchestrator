import { describe, expect, test } from 'bun:test'

import {
  getFlagSettingsInline,
  setFlagSettingsInline,
} from '../../bootstrap/state.js'
import type { SDKMessage, SDKUserMessageReplay } from '../../entrypoints/agentSdkTypes.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'
import {
  executeCodexNativeTurn,
  resolveCodexNativeExecTimeoutPolicy,
  resolveCodexNativeExecTimeoutMs,
} from './turnExecutor.js'

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
  test('applies mailbox timeout policy to ordinary queued mailbox prompts', () => {
    const prompt = [
      'Process this queued mailbox message now.',
      '<queued_mailbox_message>',
      'Тут?',
      '</queued_mailbox_message>',
    ].join('\n')

    expect(resolveCodexNativeExecTimeoutPolicy(prompt, {})).toEqual({
      idleTimeoutMs: 300_000,
      absoluteTimeoutMs: 2_700_000,
    })
    expect(
      resolveCodexNativeExecTimeoutPolicy(prompt, {
        CLAUDE_CODE_CODEX_NATIVE_MAILBOX_IDLE_TIMEOUT_MS: '45000',
        CLAUDE_CODE_CODEX_NATIVE_MAILBOX_ABSOLUTE_TIMEOUT_MS: '90000',
      }),
    ).toEqual({
      idleTimeoutMs: 45_000,
      absoluteTimeoutMs: 90_000,
    })
    expect(
      resolveCodexNativeExecTimeoutPolicy(prompt, {
        CLAUDE_CODE_CODEX_NATIVE_MAILBOX_IDLE_TIMEOUT_MS: '0',
        CLAUDE_CODE_CODEX_NATIVE_MAILBOX_ABSOLUTE_TIMEOUT_MS: '0',
      }),
    ).toEqual({
      idleTimeoutMs: null,
      absoluteTimeoutMs: null,
    })
  })

  test('applies direct timeout policy to non-mailbox prompts', () => {
    expect(resolveCodexNativeExecTimeoutPolicy('Reply only with OK', {})).toEqual({
      idleTimeoutMs: 900_000,
      absoluteTimeoutMs: 3_600_000,
    })
    expect(
      resolveCodexNativeExecTimeoutPolicy('Reply only with OK', {
        CLAUDE_CODE_CODEX_NATIVE_DIRECT_IDLE_TIMEOUT_MS: '120000',
        CLAUDE_CODE_CODEX_NATIVE_DIRECT_ABSOLUTE_TIMEOUT_MS: '600000',
      }),
    ).toEqual({
      idleTimeoutMs: 120_000,
      absoluteTimeoutMs: 600_000,
    })
    expect(
      resolveCodexNativeExecTimeoutPolicy('Reply only with OK', {
        CLAUDE_CODE_CODEX_NATIVE_DIRECT_IDLE_TIMEOUT_MS: '0',
        CLAUDE_CODE_CODEX_NATIVE_DIRECT_ABSOLUTE_TIMEOUT_MS: '0',
      }),
    ).toEqual({
      idleTimeoutMs: null,
      absoluteTimeoutMs: null,
    })
  })

  test('keeps legacy mailbox timeout resolver as absolute timeout compatibility', () => {
    const prompt = [
      'Process this queued mailbox message now.',
      '<queued_mailbox_message>',
      'Тут?',
      '</queued_mailbox_message>',
    ].join('\n')

    expect(resolveCodexNativeExecTimeoutMs(prompt, {})).toBe(2_700_000)
    expect(resolveCodexNativeExecTimeoutMs('Reply only with OK', {})).toBe(
      3_600_000,
    )
    expect(
      resolveCodexNativeExecTimeoutMs(prompt, {
        CLAUDE_CODE_CODEX_NATIVE_MAILBOX_TURN_TIMEOUT_MS: '45000',
      }),
    ).toBe(45_000)
    expect(
      resolveCodexNativeExecTimeoutMs(prompt, {
        CLAUDE_CODE_CODEX_NATIVE_MAILBOX_TURN_TIMEOUT_MS: '0',
      }),
    ).toBeNull()
    expect(
      resolveCodexNativeExecTimeoutMs('Reply only with OK', {
        CLAUDE_CODE_CODEX_NATIVE_DIRECT_TURN_TIMEOUT_MS: '60000',
      }),
    ).toBe(60_000)
  })

  test('passes the queued mailbox timeout policy to native exec', async () => {
    const prompt = [
      'Process this queued mailbox message now.',
      '<queued_mailbox_message>',
      'Тут?',
      '</queued_mailbox_message>',
    ].join('\n')
    let observedIdleTimeoutMs: number | null | undefined
    let observedAbsoluteTimeoutMs: number | null | undefined
    const params = baseParams({ prompt })

    await collectMessages(
      executeCodexNativeTurn(params, {
        runExec: async function* (options) {
          observedIdleTimeoutMs = options.idleTimeoutMs
          observedAbsoluteTimeoutMs = options.absoluteTimeoutMs
          yield {
            type: 'normalized_event',
            event: {
              type: 'assistant_text',
              itemId: 'item_0',
              text: 'Я тут.',
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
            threadId: null,
            credentialSource: 'ambient-process-env',
            completionPolicy: 'ephemeral',
            finalHistoryCompleteness: 'live-only',
            finalUsageAuthority: 'live-turn-completed',
          }
        },
      }),
    )

    expect(observedIdleTimeoutMs).toBe(300_000)
    expect(observedAbsoluteTimeoutMs).toBe(2_700_000)
  })

  test('passes direct timeout policy to non-mailbox native exec', async () => {
    let observedIdleTimeoutMs: number | null | undefined = undefined
    let observedAbsoluteTimeoutMs: number | null | undefined = undefined

    await collectMessages(
      executeCodexNativeTurn(baseParams(), {
        runExec: async function* (options) {
          observedIdleTimeoutMs = options.idleTimeoutMs
          observedAbsoluteTimeoutMs = options.absoluteTimeoutMs
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
              type: 'turn_completed',
            },
          }
          return {
            identity: {
              executablePath: '/usr/local/bin/codex',
              executableSource: 'system-path',
              version: 'codex-cli 0.117.0',
            },
            threadId: null,
            credentialSource: 'ambient-process-env',
            completionPolicy: 'ephemeral',
            finalHistoryCompleteness: 'live-only',
            finalUsageAuthority: 'live-turn-completed',
          }
        },
      }),
    )

    expect(observedIdleTimeoutMs).toBe(900_000)
    expect(observedAbsoluteTimeoutMs).toBe(3_600_000)
  })

  test('disables unsupported Codex plugins only for API-key native execution', async () => {
    const previousCodeKey = process.env.CODEX_API_KEY
    const previousOpenAiKey = process.env.OPENAI_API_KEY
    const previousSettings = getFlagSettingsInline()
    let observedDisabledFeatures: string[] | undefined

    try {
      process.env.CODEX_API_KEY = 'sk-test'
      delete process.env.OPENAI_API_KEY
      setFlagSettingsInline({
        codex: {
          forced_login_method: 'api',
        },
      })

      await collectMessages(
        executeCodexNativeTurn(baseParams(), {
          runExec: async function* (options) {
            observedDisabledFeatures = options.disabledFeatures
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
                type: 'turn_completed',
              },
            }
            return {
              identity: {
                executablePath: '/usr/local/bin/codex',
                executableSource: 'system-path',
                version: 'codex-cli 0.117.0',
              },
              threadId: null,
              credentialSource: 'explicit-api-key',
              completionPolicy: 'ephemeral',
              finalHistoryCompleteness: 'live-only',
              finalUsageAuthority: 'live-turn-completed',
            }
          },
        }),
      )

      expect(observedDisabledFeatures).toEqual(['plugins'])
    } finally {
      if (previousCodeKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = previousCodeKey
      }
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey
      }
      setFlagSettingsInline(previousSettings)
    }
  })

  test('keeps Codex plugins enabled for ChatGPT native execution', async () => {
    const previousCodeKey = process.env.CODEX_API_KEY
    const previousOpenAiKey = process.env.OPENAI_API_KEY
    const previousSettings = getFlagSettingsInline()
    let observedDisabledFeatures: string[] | undefined

    try {
      process.env.CODEX_API_KEY = 'sk-test'
      delete process.env.OPENAI_API_KEY
      setFlagSettingsInline({
        codex: {
          forced_login_method: 'chatgpt',
        },
      })

      await collectMessages(
        executeCodexNativeTurn(baseParams(), {
          runExec: async function* (options) {
            observedDisabledFeatures = options.disabledFeatures
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
                type: 'turn_completed',
              },
            }
            return {
              identity: {
                executablePath: '/usr/local/bin/codex',
                executableSource: 'system-path',
                version: 'codex-cli 0.117.0',
              },
              threadId: null,
              credentialSource: 'explicit-api-key',
              completionPolicy: 'ephemeral',
              finalHistoryCompleteness: 'live-only',
              finalUsageAuthority: 'live-turn-completed',
            }
          },
        }),
      )

      expect(observedDisabledFeatures).toEqual([])
    } finally {
      if (previousCodeKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = previousCodeKey
      }
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey
      }
      setFlagSettingsInline(previousSettings)
    }
  })

  test('records an assistant API error when native execution completes without assistant output', async () => {
    const params = baseParams({
      persistSession: true,
    })
    const persistenceCalls: string[] = []
    const messages = await collectMessages(
      executeCodexNativeTurn(params, {
        runExec: async function* () {
          yield {
            type: 'normalized_event',
            event: {
              type: 'thread_started',
              threadId: 'thread-empty',
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
            threadId: 'thread-empty',
            credentialSource: 'ambient-process-env',
            completionPolicy: 'ephemeral',
            finalHistoryCompleteness: 'live-only',
            finalUsageAuthority: 'live-turn-completed',
          }
        },
        recordTranscript: async messages => {
          const lastMessage = messages.at(-1)
          const kind =
            lastMessage?.type === 'assistant' && lastMessage.isApiErrorMessage
              ? 'api-error'
              : 'normal'
          persistenceCalls.push(
            `record:${lastMessage?.type ?? 'none'}:${kind}`,
          )
          return '' as never
        },
        flushSessionStorage: async () => {
          persistenceCalls.push('flush')
        },
      }),
    )

    expect(messages[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining(
              'completed without an assistant message',
            ),
          },
        ],
      },
    })
    expect(messages[1]).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [expect.stringContaining('completed without an assistant message')],
    })
    expect(params.mutableMessages.at(-1)).toMatchObject({
      type: 'assistant',
      isApiErrorMessage: true,
      errorDetails: expect.stringContaining(
        'completed without an assistant message',
      ),
    })
    expect(persistenceCalls).toContain('record:assistant:api-error')
    expect(persistenceCalls.at(-1)).toBe('flush')
  })

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
