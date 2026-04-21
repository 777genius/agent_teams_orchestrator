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
  test('preserves provider-scoped ids as-is', () => {
    expect(resolveOpenCodeProviderScopedModel('openrouter/moonshotai/kimi-k2', snapshot())).toBe(
      'openrouter/moonshotai/kimi-k2',
    )
  })

  test('uses OpenCode default metadata for raw ids', () => {
    expect(resolveOpenCodeProviderScopedModel('big-pickle', snapshot())).toBe('opencode/big-pickle')
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
