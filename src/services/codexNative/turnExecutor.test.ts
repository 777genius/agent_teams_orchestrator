import { afterEach, describe, expect, test } from 'bun:test'

import {
  getFlagSettingsInline,
  setStrictMcpConfig,
  setFlagSettingsInline,
} from '../../bootstrap/state.js'
import type { SDKMessage, SDKUserMessageReplay } from '../../entrypoints/agentSdkTypes.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../../utils/teammate.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'
import type { CodexNativeTurnSettledEvent } from './runtimeTurnSettledEmitter.js'
import {
  executeCodexNativeTurn,
  resolveCodexNativeApprovalLaunchPolicy,
  resolveCodexNativeExecTimeoutPolicy,
  resolveCodexNativeExecTimeoutMs,
} from './turnExecutor.js'
import { buildCodexNativeUserLoopbackProviderConfigOverrides } from './userLoopbackProviderConfigOverrides.js'

function baseParams(overrides: Partial<Parameters<typeof executeCodexNativeTurn>[0]> = {}) {
  return {
    prompt: 'Reply only with OK',
    cwd: '/tmp/demo',
    model: 'gpt-5.3-codex',
    effortValue: undefined,
    permissionMode: 'bypassPermissions' as const,
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

function executeTurn(
  params: Parameters<typeof executeCodexNativeTurn>[0],
  deps: Parameters<typeof executeCodexNativeTurn>[1] = {},
) {
  return executeCodexNativeTurn(params, {
    buildUserLoopbackProviderConfigOverrides: () => [],
    ...deps,
  })
}

afterEach(() => {
  clearDynamicTeamContext()
  setStrictMcpConfig(false)
})

describe('executeCodexNativeTurn', () => {
  test('applies mailbox timeout policy to ordinary queued mailbox prompts', () => {
    const prompt = [
      'Process this queued mailbox message now.',
      '<queued_mailbox_message>',
      'Тут?',
      '</queued_mailbox_message>',
    ].join('\n')

    expect(resolveCodexNativeExecTimeoutPolicy(prompt, {})).toEqual({
      idleTimeoutMs: 900_000,
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
      executeTurn(params, {
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

    expect(observedIdleTimeoutMs).toBe(900_000)
    expect(observedAbsoluteTimeoutMs).toBe(2_700_000)
  })

  test('passes direct timeout policy to non-mailbox native exec', async () => {
    let observedIdleTimeoutMs: number | null | undefined = undefined
    let observedAbsoluteTimeoutMs: number | null | undefined = undefined

    await collectMessages(
      executeTurn(baseParams(), {
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

  test.each(['max', 'ultra'] as const)(
    'passes %s effort to Codex without downgrading it',
    async (effort) => {
      let observedReasoningEffort: string | null | undefined

      await collectMessages(
        executeTurn(
          baseParams({ model: 'gpt-5.6-sol', effortValue: effort }),
          {
            runExec: async function* (options) {
              observedReasoningEffort = options.reasoningEffort
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
                  version: 'codex-cli 0.144.1',
                },
                threadId: null,
                credentialSource: 'ambient-process-env',
                completionPolicy: 'ephemeral',
                finalHistoryCompleteness: 'live-only',
                finalUsageAuthority: 'live-turn-completed',
              }
            },
          },
        ),
      )

      expect(observedReasoningEffort).toBe(effort)
    },
  )

  test('maps bypass permissions to Codex native never-approval mode', async () => {
    let observedApprovalPolicy: 'never' | 'on-request' | null | undefined

    await collectMessages(
      executeTurn(baseParams({ permissionMode: 'bypassPermissions' }), {
        runExec: async function* (options) {
          observedApprovalPolicy = options.approvalPolicy
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
            threadId: 'thread-1',
            credentialSource: 'none',
            completionPolicy: 'ephemeral',
            finalHistoryCompleteness: 'live-only',
            finalUsageAuthority: 'live-turn-completed',
          }
        },
      }),
    )

    expect(observedApprovalPolicy).toBe('never')
  })

  test('resolves manual Codex approval policy to the app-server protocol', () => {
    expect(resolveCodexNativeApprovalLaunchPolicy('default')).toEqual({
      transport: 'app-server',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
    })
    expect(resolveCodexNativeApprovalLaunchPolicy('bypassPermissions')).toEqual({
      transport: 'exec-json',
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
    })
  })

  test('routes manual Codex turns through the app-server approval transport', async () => {
    let observedTransport: 'app-server' | null = null
    let observedApprovalProvider: string | null = null

    const messages = await collectMessages(
      executeTurn(
        baseParams({
          permissionMode: 'default',
          requestApproval: async approval => {
            observedApprovalProvider = approval.providerId
            return { allow: true }
          },
        }),
        {
          runAppServer: async function* (options) {
            observedTransport = 'app-server'
            await options.requestApproval({
              providerId: 'codex',
              requestId: 'rpc-1',
              providerRequestId: 'codex:item/commandExecution/requestApproval:item-1',
              method: 'item/commandExecution/requestApproval',
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-1',
              toolName: 'Bash',
              toolInput: { provider: 'codex', command: 'echo ok' },
              reason: 'approval smoke',
              raw: {},
            })
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
                version: 'codex-cli 0.125.0',
              },
              threadId: 'thread-1',
              credentialSource: 'none',
              completionPolicy: 'ephemeral',
              finalHistoryCompleteness: 'explicit-hydration-required',
              finalUsageAuthority: 'live-turn-completed',
            }
          },
        },
      ),
    )

    expect(observedTransport).toBe('app-server')
    expect(observedApprovalProvider).toBe('codex')
    expect(messages.some(message => message.type === 'assistant')).toBe(true)
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
        executeTurn(baseParams(), {
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
    let observedApiKey: string | null | undefined

    try {
      process.env.CODEX_API_KEY = 'sk-test'
      delete process.env.OPENAI_API_KEY
      setFlagSettingsInline({
        codex: {
          forced_login_method: 'chatgpt',
        },
      })

      await collectMessages(
        executeTurn(baseParams(), {
          runExec: async function* (options) {
            observedDisabledFeatures = options.disabledFeatures
            observedApiKey = options.apiKey
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
              credentialSource: 'none',
              completionPolicy: 'ephemeral',
              finalHistoryCompleteness: 'live-only',
              finalUsageAuthority: 'live-turn-completed',
            }
          },
        }),
      )

      expect(observedDisabledFeatures).toEqual([])
      expect(observedApiKey).toBeUndefined()
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

  test('passes validated workspace trust settings to native config overrides', async () => {
    const previousSettings = getFlagSettingsInline()
    let observedConfigOverrides: string[] | undefined

    try {
      setFlagSettingsInline({
        codex: {
          forced_login_method: 'chatgpt',
          agent_teams_workspace_trust: {
            config_overrides: [
              'projects."/tmp/project".trust_level="trusted"',
              'forced_login_method="api"',
              'projects."/private/tmp/project".trust_level="trusted"',
            ],
          },
        },
      })

      await collectMessages(
        executeTurn(baseParams(), {
          buildUserLoopbackProviderConfigOverrides: () => [],
          runExec: async function* (options) {
            observedConfigOverrides = options.configOverrides
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
              credentialSource: 'none',
              completionPolicy: 'ephemeral',
              finalHistoryCompleteness: 'live-only',
              finalUsageAuthority: 'live-turn-completed',
            }
          },
        }),
      )

      expect(observedConfigOverrides).toEqual([
        'projects."/tmp/project".trust_level="trusted"',
        'projects."/private/tmp/project".trust_level="trusted"',
      ])
    } finally {
      setFlagSettingsInline(previousSettings)
    }
  })

  test('passes supported app-owned launch config settings to native config overrides', async () => {
    const previousSettings = getFlagSettingsInline()
    let observedConfigOverrides: string[] | undefined

    try {
      setFlagSettingsInline({
        codex: {
          forced_login_method: 'chatgpt',
          agent_teams_launch_config: {
            config_overrides: [
              'service_tier="flex"',
              'service_tier="fast"',
              'features.fast_mode=true',
              'forced_login_method="api"',
            ],
          },
        },
      })

      await collectMessages(
        executeTurn(baseParams(), {
          buildUserLoopbackProviderConfigOverrides: () => [],
          runExec: async function* (options) {
            observedConfigOverrides = options.configOverrides
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
              credentialSource: 'none',
              completionPolicy: 'ephemeral',
              finalHistoryCompleteness: 'live-only',
              finalUsageAuthority: 'live-turn-completed',
            }
          },
        }),
      )

      expect(observedConfigOverrides).toEqual([
        'service_tier="fast"',
        'features.fast_mode=true',
      ])
    } finally {
      setFlagSettingsInline(previousSettings)
    }
  })

  test('passes validated custom provider settings to native exec config overrides', async () => {
    const previousSettings = getFlagSettingsInline()
    let observedConfigOverrides: string[] | undefined

    try {
      setFlagSettingsInline({
        codex: {
          forced_login_method: 'api',
          agent_teams_custom_provider: {
            config_overrides: [
              'model_provider="agent_teams_custom"',
              'model_providers.agent_teams_custom.name="Agent Teams Custom"',
              'model_providers.agent_teams_custom.base_url="https://gateway.example.com/v1"',
              'model_providers.agent_teams_custom.wire_api="responses"',
              'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
              'forced_login_method="chatgpt"',
            ],
          },
        },
      })

      await collectMessages(
        executeTurn(baseParams(), {
          buildUserLoopbackProviderConfigOverrides: () => [],
          runExec: async function* (options) {
            observedConfigOverrides = options.configOverrides
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

      expect(observedConfigOverrides).toEqual([
        'model_provider="agent_teams_custom"',
        'model_providers.agent_teams_custom.name="Agent Teams Custom"',
        'model_providers.agent_teams_custom.base_url="https://gateway.example.com/v1"',
        'model_providers.agent_teams_custom.wire_api="responses"',
        'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
      ])
    } finally {
      setFlagSettingsInline(previousSettings)
    }
  })

  test('passes validated custom provider settings to native app-server config overrides', async () => {
    const previousSettings = getFlagSettingsInline()
    let observedConfigOverrides: string[] | undefined

    try {
      setFlagSettingsInline({
        codex: {
          forced_login_method: 'api',
          agent_teams_custom_provider: {
            config_overrides: [
              'model_provider="agent_teams_custom"',
              'model_providers.agent_teams_custom.name="Agent Teams Custom"',
              'model_providers.agent_teams_custom.base_url="http://127.0.0.1:8080/v1"',
              'model_providers.agent_teams_custom.wire_api="responses"',
              'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
            ],
          },
        },
      })

      await collectMessages(
        executeTurn(baseParams({ permissionMode: 'default' }), {
          runAppServer: async function* (options) {
            observedConfigOverrides = options.configOverrides
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
              threadId: 'thread-1',
              credentialSource: 'explicit-api-key',
              completionPolicy: 'persistent',
              finalHistoryCompleteness: 'live-only',
              finalUsageAuthority: 'live-turn-completed',
            }
          },
        }),
      )

      expect(observedConfigOverrides).toEqual([
        'model_provider="agent_teams_custom"',
        'model_providers.agent_teams_custom.name="Agent Teams Custom"',
        'model_providers.agent_teams_custom.base_url="http://127.0.0.1:8080/v1"',
        'model_providers.agent_teams_custom.wire_api="responses"',
        'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
      ])
    } finally {
      setFlagSettingsInline(previousSettings)
    }
  })

  test('isolates user config by default for native exec', async () => {
    const previousIgnoreUserConfig =
      process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG
    let observedIgnoreUserConfig: boolean | undefined

    try {
      delete process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG
      await collectMessages(
        executeTurn(baseParams(), {
          runExec: async function* (options) {
            observedIgnoreUserConfig = options.ignoreUserConfig
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

      expect(observedIgnoreUserConfig).toBe(true)
    } finally {
      if (previousIgnoreUserConfig === undefined) {
        delete process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG
      } else {
        process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG =
          previousIgnoreUserConfig
      }
    }
  })

  test('forwards loopback user provider overrides while still isolating user config', async () => {
    const previousIgnoreUserConfig =
      process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG
    let observedConfigOverrides: string[] | undefined
    let observedIgnoreUserConfig: boolean | undefined

    try {
      delete process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG
      await collectMessages(
      executeTurn(baseParams(), {
        buildUserLoopbackProviderConfigOverrides: () =>
          buildCodexNativeUserLoopbackProviderConfigOverrides({
            configToml: `
model_provider = "codex-mixin"
[model_providers.codex-mixin]
name = "Codex Mixin"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
requires_openai_auth = true
`,
            env: { CODEX_HOME: '/tmp/codex-home' },
          }),
        runExec: async function* (options) {
          observedConfigOverrides = options.configOverrides
          observedIgnoreUserConfig = options.ignoreUserConfig
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

    expect(observedIgnoreUserConfig).toBe(true)
    expect(observedConfigOverrides).toEqual([
      'model_provider="codex-mixin"',
      'model_providers.codex-mixin.base_url="http://127.0.0.1:8788/v1"',
      'model_providers.codex-mixin.name="Codex Mixin"',
      'model_providers.codex-mixin.wire_api="responses"',
      'model_providers.codex-mixin.requires_openai_auth=true',
    ])
    } finally {
      if (previousIgnoreUserConfig === undefined) {
        delete process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG
      } else {
        process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG =
          previousIgnoreUserConfig
      }
    }
  })

  test('allows explicit user config isolation opt-out for native exec', async () => {
    const previousIgnoreUserConfig =
      process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG
    let observedIgnoreUserConfig: boolean | undefined

    try {
      process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG = 'false'
      await collectMessages(
        executeTurn(baseParams(), {
          runExec: async function* (options) {
            observedIgnoreUserConfig = options.ignoreUserConfig
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

      expect(observedIgnoreUserConfig).toBe(false)
    } finally {
      if (previousIgnoreUserConfig === undefined) {
        delete process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG
      } else {
        process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG =
          previousIgnoreUserConfig
      }
    }
  })

  test('passes explicit user config isolation to native exec', async () => {
    const previousIgnoreUserConfig =
      process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG
    let observedIgnoreUserConfig: boolean | undefined

    try {
      process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG = 'true'
      await collectMessages(
        executeTurn(baseParams(), {
          runExec: async function* (options) {
            observedIgnoreUserConfig = options.ignoreUserConfig
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

      expect(observedIgnoreUserConfig).toBe(true)
    } finally {
      if (previousIgnoreUserConfig === undefined) {
        delete process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG
      } else {
        process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG =
          previousIgnoreUserConfig
      }
    }
  })

  test('forces user config isolation when strict MCP config is enabled', async () => {
    const previousIgnoreUserConfig =
      process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG
    let observedIgnoreUserConfig: boolean | undefined

    try {
      process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG = 'false'
      setStrictMcpConfig(true)
      await collectMessages(
        executeTurn(baseParams(), {
          runExec: async function* (options) {
            observedIgnoreUserConfig = options.ignoreUserConfig
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

      expect(observedIgnoreUserConfig).toBe(true)
    } finally {
      if (previousIgnoreUserConfig === undefined) {
        delete process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG
      } else {
        process.env.CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG =
          previousIgnoreUserConfig
      }
      setStrictMcpConfig(false)
    }
  })

  test('records an assistant API error when native execution completes without assistant output', async () => {
    const params = baseParams({
      persistSession: true,
    })
    const persistenceCalls: string[] = []
    const messages = await collectMessages(
      executeTurn(params, {
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

  test('rejects inline image prompts without prepared file paths conservatively', async () => {
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

    const messages = await collectMessages(executeTurn(params))

    expect(messages[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining('prepared file paths'),
          },
        ],
      },
    })
    expect(messages[1]).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [expect.stringContaining('prepared file paths')],
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
    const iterator = executeTurn(params, {
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

    const iterator = executeTurn(params, {
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

  test('emits codex turn-settled event after native exec completes for teammates', async () => {
    setDynamicTeamContext({
      agentId: 'jack@alpha',
      agentName: 'jack',
      teamName: 'alpha',
      planModeRequired: false,
    })
    const order: string[] = []
    const events: CodexNativeTurnSettledEvent[] = []

    await collectMessages(
      executeTurn(baseParams({ cwd: '/tmp/alpha' }), {
        runExec: async function* () {
          yield {
            type: 'normalized_event',
            event: {
              type: 'thread_started',
              threadId: 'thread-123',
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
              type: 'turn_completed',
            },
          }
          order.push('exec-completed')
          return {
            identity: {
              executablePath: '/usr/local/bin/codex',
              executableSource: 'system-path',
              version: 'codex-cli 0.117.0',
            },
            threadId: 'thread-123',
            credentialSource: 'ambient-process-env',
            completionPolicy: 'ephemeral',
            finalHistoryCompleteness: 'live-only',
            finalUsageAuthority: 'live-turn-completed',
          }
        },
        runtimeTurnSettledEmitter: {
          async emit(event) {
            order.push('emitted')
            events.push(event)
          },
        },
      }),
    )

    expect(order).toEqual(['exec-completed', 'emitted'])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      provider: 'codex',
      eventName: 'runtime_turn_settled',
      hookEventName: 'Stop',
      source: 'agent-teams-orchestrator-codex-native',
      agentId: 'jack@alpha',
      agentName: 'jack',
      teamName: 'alpha',
      cwd: '/tmp/alpha',
      outcome: 'success',
      threadId: 'thread-123',
    })
  })

  test('emits codex turn-settled event for team leads from app state identity', async () => {
    const events: CodexNativeTurnSettledEvent[] = []

    await collectMessages(
      executeTurn(
        baseParams({
          cwd: '/tmp/alpha',
          initialAppState: {
            fastMode: false,
            teamContext: {
              teamName: 'alpha',
              teamFilePath: '/tmp/alpha/team.json',
              leadAgentId: 'team-lead@alpha',
              teammates: {
                'team-lead@alpha': {
                  name: 'team-lead',
                  tmuxSessionName: 'alpha',
                  tmuxPaneId: '%1',
                  cwd: '/tmp/alpha',
                  spawnedAt: 1,
                },
              },
            },
          } as never,
        }),
        {
          runExec: async function* () {
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
              threadId: 'thread-lead',
              credentialSource: 'ambient-process-env',
              completionPolicy: 'ephemeral',
              finalHistoryCompleteness: 'live-only',
              finalUsageAuthority: 'live-turn-completed',
            }
          },
          runtimeTurnSettledEmitter: {
            async emit(event) {
              events.push(event)
            },
          },
        },
      ),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      provider: 'codex',
      agentId: 'team-lead@alpha',
      agentName: 'team-lead',
      teamName: 'alpha',
      cwd: '/tmp/alpha',
      outcome: 'success',
      threadId: 'thread-lead',
    })
  })

  test('emits codex turn-settled before yielding the terminal result', async () => {
    setDynamicTeamContext({
      agentId: 'jack@alpha',
      agentName: 'jack',
      teamName: 'alpha',
      planModeRequired: false,
    })
    const events: CodexNativeTurnSettledEvent[] = []
    const iterator = executeTurn(baseParams({ cwd: '/tmp/alpha' }), {
      runExec: async function* () {
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
          identity: null,
          threadId: 'thread-123',
          credentialSource: 'ambient-process-env',
          completionPolicy: 'ephemeral',
          finalHistoryCompleteness: 'live-only',
          finalUsageAuthority: 'live-turn-completed',
        }
      },
      runtimeTurnSettledEmitter: {
        async emit(event) {
          events.push(event)
        },
      },
    })

    try {
      while (true) {
        const next = await iterator.next()
        expect(next.done).toBe(false)
        if (!next.done && next.value.type === 'result') {
          expect(events).toHaveLength(1)
          expect(events[0]).toMatchObject({
            outcome: 'success',
            threadId: 'thread-123',
          })
          break
        }
      }
    } finally {
      await iterator.return(undefined as never)
    }
  })

  test('emits codex turn-settled event for terminal error paths', async () => {
    setDynamicTeamContext({
      agentId: 'bob@alpha',
      agentName: 'bob',
      teamName: 'alpha',
      planModeRequired: false,
    })
    const events: CodexNativeTurnSettledEvent[] = []

    await collectMessages(
      executeTurn(baseParams(), {
        runExec: async function* () {
          throw new Error('codex crashed')
        },
        runtimeTurnSettledEmitter: {
          async emit(event) {
            events.push(event)
          },
        },
      }),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      provider: 'codex',
      agentName: 'bob',
      teamName: 'alpha',
      outcome: 'error',
      detail: 'codex crashed',
    })
  })

  test('does not emit codex turn-settled event outside teammate context', async () => {
    const events: CodexNativeTurnSettledEvent[] = []

    await collectMessages(
      executeTurn(baseParams(), {
        runExec: async function* () {
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
        runtimeTurnSettledEmitter: {
          async emit(event) {
            events.push(event)
          },
        },
      }),
    )

    expect(events).toEqual([])
  })
})
