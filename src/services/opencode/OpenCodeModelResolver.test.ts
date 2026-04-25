import { describe, expect, test } from 'bun:test'

import { resolveOpenCodeProviderScopedModel } from './OpenCodeModelResolver.js'

import type { OpenCodeProvisioningSnapshot } from './types.js'

function snapshot(overrides: Partial<OpenCodeProvisioningSnapshot> = {}): OpenCodeProvisioningSnapshot {
  return {
    detected: true,
    hostHealthy: true,
    projectPath: '/tmp/project',
    profile: null,
    host: null,
    config: null,
    configProviders: {
      providers: [
        {
          id: 'openai',
          models: {
            'gpt-5.4-mini': {},
            shared: {},
          },
        },
        {
          id: 'opencode',
          models: {
            'big-pickle': {},
            shared: {},
          },
        },
        {
          id: 'openrouter',
          models: {
            'moonshotai/kimi-k2': {},
          },
        },
      ],
      default: {
        opencode: 'big-pickle',
      },
    },
    providers: {
      all: [],
      default: {},
      connected: ['opencode'],
    },
    providerAuth: null,
    agents: [],
    mcp: null,
    appMcp: null,
    probeError: null,
    diagnostics: [],
    ...overrides,
  }
}

describe('resolveOpenCodeProviderScopedModel', () => {
  test('validates provider-scoped ids against the live catalog', () => {
    expect(resolveOpenCodeProviderScopedModel('openrouter/moonshotai/kimi-k2', snapshot())).toBe(
      'openrouter/moonshotai/kimi-k2',
    )
  })

  test('validates provider-scoped ids discovered by the OpenCode models inventory', () => {
    expect(
      resolveOpenCodeProviderScopedModel(
        'openrouter/qwen/qwen3-coder',
        snapshot({
          models: ['openrouter/qwen/qwen3-coder'],
        }),
      ),
    ).toBe('openrouter/qwen/qwen3-coder')
  })

  test('validates provider-scoped ids discovered only by the live provider catalog', () => {
    expect(
      resolveOpenCodeProviderScopedModel(
        'openrouter/qwen/qwen3-coder',
        snapshot({
          providers: {
            all: [
              {
                id: 'openrouter',
                models: {
                  'qwen/qwen3-coder': {},
                },
              },
            ],
            default: {},
            connected: ['openrouter'],
          },
        }),
      ),
    ).toBe('openrouter/qwen/qwen3-coder')
  })

  test('resolves raw ids from the OpenCode models inventory when unique', () => {
    expect(
      resolveOpenCodeProviderScopedModel(
        'qwen/qwen3-coder',
        snapshot({
          models: ['openrouter/qwen/qwen3-coder'],
        }),
      ),
    ).toBe('openrouter/qwen/qwen3-coder')
  })

  test('resolves raw ids discovered only by the live provider catalog', () => {
    expect(
      resolveOpenCodeProviderScopedModel(
        'qwen/qwen3-coder',
        snapshot({
          providers: {
            all: [
              {
                id: 'openrouter',
                models: {
                  'qwen/qwen3-coder': {},
                },
              },
            ],
            default: {},
            connected: ['openrouter'],
          },
        }),
      ),
    ).toBe('openrouter/qwen/qwen3-coder')
  })

  test('resolves raw catalog ids that contain slashes when the first segment is not a provider', () => {
    expect(resolveOpenCodeProviderScopedModel('moonshotai/kimi-k2', snapshot())).toBe(
      'openrouter/moonshotai/kimi-k2',
    )
  })

  test('fails closed for ambiguous raw catalog ids that contain slashes', () => {
    expect(() =>
      resolveOpenCodeProviderScopedModel(
        'moonshotai/kimi-k2',
        snapshot({
          configProviders: {
            providers: [
              {
                id: 'openrouter',
                models: {
                  'moonshotai/kimi-k2': {},
                },
              },
              {
                id: 'proxy',
                models: {
                  'moonshotai/kimi-k2': {},
                },
              },
            ],
            default: {},
          },
          providers: {
            all: [],
            default: {},
            connected: ['openrouter', 'proxy'],
          },
        }),
      ),
    ).toThrow(/OpenCode raw model id "moonshotai\/kimi-k2" is ambiguous/)
  })

  test('fails closed for unknown provider-scoped ids', () => {
    expect(() =>
      resolveOpenCodeProviderScopedModel('openrouter/ghost-model', snapshot()),
    ).toThrow(/provider-scoped model "openrouter\/ghost-model" was not found/)
  })

  test('uses OpenCode default metadata for raw ids', () => {
    expect(resolveOpenCodeProviderScopedModel('big-pickle', snapshot())).toBe('opencode/big-pickle')
  })

  test('uses live provider default metadata for raw ids', () => {
    expect(
      resolveOpenCodeProviderScopedModel(
        'google/gemini-3-pro-preview',
        snapshot({
          providers: {
            all: [],
            default: {
              openrouter: 'google/gemini-3-pro-preview',
            },
            connected: ['openrouter'],
          },
        }),
      ),
    ).toBe('openrouter/google/gemini-3-pro-preview')
  })

  test('ignores missing default metadata while resolving raw ids', () => {
    expect(
      resolveOpenCodeProviderScopedModel(
        'qwen/qwen3-coder',
        snapshot({
          configProviders: {
            providers: [],
            default: undefined,
          },
          providers: {
            all: [
              {
                id: 'openrouter',
                models: {
                  'qwen/qwen3-coder': {},
                },
              },
            ],
            default: undefined,
            connected: ['openrouter'],
          },
        }),
      ),
    ).toBe('openrouter/qwen/qwen3-coder')
  })

  test('uses a unique catalog match for raw ids', () => {
    expect(resolveOpenCodeProviderScopedModel('gpt-5.4-mini', snapshot())).toBe('openai/gpt-5.4-mini')
  })

  test('uses connected provider metadata when raw ids are shared', () => {
    expect(resolveOpenCodeProviderScopedModel('shared', snapshot())).toBe('opencode/shared')
  })

  test('fails closed for ambiguous raw ids', () => {
    expect(() =>
      resolveOpenCodeProviderScopedModel(
        'shared',
        snapshot({
          providers: {
            all: [],
            default: {},
            connected: ['openai', 'opencode'],
          },
        }),
      ),
    ).toThrow(/ambiguous/)
  })
})
