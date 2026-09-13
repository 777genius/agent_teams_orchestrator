import { describe, expect, test } from 'bun:test'

import {
  buildOpenCodeModelRouteMetadata,
  evaluateOpenCodeModelAccess,
} from './OpenCodeModelAccessPolicy.js'

import type { OpenCodeModelMetadata } from './types.js'

type Catalog = Parameters<typeof evaluateOpenCodeModelAccess>[0]['catalog']

function modelMetadata(id: string, overrides: Partial<OpenCodeModelMetadata> = {}): OpenCodeModelMetadata {
  return {
    id,
    cost: null,
    context: null,
    limits: null,
    free: true,
    raw: {},
    ...overrides,
  }
}

function catalog(overrides: Partial<Catalog> = {}): Catalog {
  return {
    connectedProviders: [],
    models: [],
    modelMetadata: [],
    configProviders: null,
    providers: null,
    ...overrides,
  }
}

describe('OpenCodeModelAccessPolicy', () => {
  test('rejects upstream-present free router success proof after provider disconnects', () => {
    const input = {
      selectedModel: 'openrouter/openrouter/free',
      catalog: catalog({
        models: ['openrouter/openrouter/free'],
        runtimeEnv: { OPENROUTER_API_KEY: 'synthetic-key' },
        providers: { all: [{ id: 'openrouter', models: { 'openrouter/free': {} } }], connected: [] },
      }),
      executionOutcome: { outcome: 'available' as const, reason: null },
    }
    expect(evaluateOpenCodeModelAccess(input).kind).toBe('not_authenticated')
    expect(evaluateOpenCodeModelAccess(input).launchAllowed).toBe(false)
    expect(evaluateOpenCodeModelAccess({ ...input,
      catalog: { ...input.catalog, connectedProviders: ['openrouter'] },
    }).kind).toBe('verified')
  })

  test('allows connected providers without an execution proof', () => {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'openrouter/moonshotai/kimi-k2',
      catalog: catalog({
        connectedProviders: ['openrouter'],
        models: ['openrouter/moonshotai/kimi-k2'],
      }),
    })

    expect(access.kind).toBe('credentialed')
    expect(access.launchAllowed).toBe(true)
    expect(access.requiresExecutionProof).toBe(false)
  })

  test('allows built-in free OpenCode models without connected providers', () => {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'opencode/big-pickle',
      catalog: catalog({
        models: ['opencode/big-pickle'],
        modelMetadata: [modelMetadata('opencode/big-pickle')],
      }),
    })

    expect(access.kind).toBe('builtin_free')
    expect(access.launchAllowed).toBe(true)
    expect(access.requiresExecutionProof).toBe(false)
  })

  test('continues allowing every catalog-confirmed built-in free OpenCode model', () => {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'opencode/catalog-free-model',
      catalog: catalog({
        models: ['opencode/catalog-free-model'],
        modelMetadata: [modelMetadata('opencode/catalog-free-model')],
      }),
    })

    expect(access.kind).toBe('builtin_free')
    expect(access.launchAllowed).toBe(true)
    expect(access.requiresExecutionProof).toBe(false)
  })

  test('requires execution proof for configured authless local providers', () => {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'llama.cpp/qwen-test:0.5b',
      catalog: catalog({
        configProviders: {
          providers: [
            {
              id: 'llama.cpp',
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: 'http://127.0.0.1:8080/v1' },
              models: { 'qwen-test:0.5b': {} },
            },
          ],
          default: {},
        },
      }),
    })

    expect(access.kind).toBe('configured_authless')
    expect(access.launchAllowed).toBe(false)
    expect(access.requiresExecutionProof).toBe(true)
  })

  test('requires execution proof for configured Ollama Cloud routes', () => {
    const cloudCatalog = catalog({
      configProviders: {
        providers: [
          {
            id: 'ollama',
            name: 'Ollama',
            models: {
              'kimi-k2.6:cloud': {
                limit: {
                  context: 262_144,
                  output: 262_144,
                },
                attachment: true,
                modalities: {
                  input: ['text', 'image'],
                  output: ['text'],
                },
                name: 'kimi-k2.6:cloud',
              },
            },
          },
        ],
        default: {},
      },
    })
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'ollama/kimi-k2.6:cloud',
      catalog: cloudCatalog,
    })
    const route = buildOpenCodeModelRouteMetadata({
      selectedModel: 'ollama/kimi-k2.6:cloud',
      catalog: cloudCatalog,
    })

    expect(access).toMatchObject({
      kind: 'configured_authless',
      providerId: 'ollama',
      modelId: 'kimi-k2.6:cloud',
      launchAllowed: false,
      requiresExecutionProof: true,
    })
    expect(route).toMatchObject({
      routeKind: 'configured_local',
      proofState: 'needs_probe',
      requiresExecutionProof: true,
    })
  })

  test.each([
    ['cursor-acp', 'auto'],
    ['kiro', 'auto'],
  ])('requires execution proof for managed CLI-session plugin %s', (providerId, modelId) => {
    const selectedModel = `${providerId}/${modelId}`
    const access = evaluateOpenCodeModelAccess({
      selectedModel,
      catalog: {
        connectedProviders: [],
        models: [selectedModel],
      },
    })

    expect(access).toMatchObject({
      kind: 'configured_authless',
      launchAllowed: false,
      requiresExecutionProof: true,
    })
  })

  test('requires execution proof for configured authless local providers even when OpenCode reports them connected', () => {
    const localCatalog = catalog({
      connectedProviders: ['llama.cpp'],
      configProviders: {
        providers: [
          {
            id: 'llama.cpp',
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'http://127.0.0.1:8080/v1' },
            models: { 'qwen-test:0.5b': {} },
          },
        ],
        default: {},
      },
    })
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'llama.cpp/qwen-test:0.5b',
      catalog: localCatalog,
    })
    const route = buildOpenCodeModelRouteMetadata({
      selectedModel: 'llama.cpp/qwen-test:0.5b',
      catalog: localCatalog,
    })

    expect(access.kind).toBe('configured_authless')
    expect(access.launchAllowed).toBe(false)
    expect(access.requiresExecutionProof).toBe(true)
    expect(route.routeKind).toBe('configured_local')
    expect(route.proofState).toBe('needs_probe')
  })

  test('requires execution proof for loopback OpenAI-compatible providers from the live provider list', () => {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'lmstudio/google/gemma-3n-e4b',
      catalog: catalog({
        providers: {
          connected: [],
          authenticated: [],
          all: [
            {
              id: 'lmstudio',
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: 'http://localhost:1234/v1' },
              models: { 'google/gemma-3n-e4b': {} },
            },
          ],
        },
      }),
    })

    expect(access.kind).toBe('configured_authless')
    expect(access.providerId).toBe('lmstudio')
    expect(access.modelId).toBe('google/gemma-3n-e4b')
    expect(access.launchAllowed).toBe(false)
    expect(access.requiresExecutionProof).toBe(true)
  })

  test('does not treat remote OpenAI-compatible providers as authless', () => {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'custom/gpt-remote',
      catalog: catalog({
        configProviders: {
          providers: [
            {
              id: 'custom',
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: 'https://api.example.com/v1' },
              models: { 'gpt-remote': {} },
            },
          ],
          default: {},
        },
      }),
    })

    expect(access.kind).toBe('not_authenticated')
    expect(access.launchAllowed).toBe(false)
    expect(access.requiresExecutionProof).toBe(false)
  })

  test.each([
    'http://127.attacker.example/v1',
    'http://127.0.0.1.attacker.example/v1',
    'http://attacker.example@127.0.0.1/v1',
    'http://2130706433/v1',
    'http://192.168.1.10/v1',
    'not a URL',
  ])('does not treat nonliteral loopback confusion as authless: %s', baseURL => {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'custom/exact-model',
      catalog: catalog({
        configProviders: {
          providers: [{
            id: 'custom',
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL },
            models: { 'exact-model': {} },
          }],
          default: {},
        },
      }),
    })

    expect(access.kind).toBe('not_authenticated')
    expect(access.launchAllowed).toBe(false)
    expect(access.requiresExecutionProof).toBe(false)
  })

  test.each([
    'http://127.0.0.1:8080/v1',
    'http://127.1.2.3:8080/v1',
    'http://[::1]:8080/v1',
  ])('requires proof for a literal loopback authority: %s', baseURL => {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'custom/exact-model',
      catalog: catalog({
        configProviders: {
          providers: [{
            id: 'custom',
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL },
            models: { 'exact-model': {} },
          }],
          default: {},
        },
      }),
    })

    expect(access.kind).toBe('configured_authless')
    expect(access.launchAllowed).toBe(false)
    expect(access.requiresExecutionProof).toBe(true)
  })

  test('requires execution proof for known local provider models discovered only from inventory', () => {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'llama.cpp/qwen3-coder:a3b',
      catalog: catalog({
        models: ['llama.cpp/qwen3-coder:a3b'],
      }),
    })

    expect(access.kind).toBe('configured_authless')
    expect(access.launchAllowed).toBe(false)
    expect(access.requiresExecutionProof).toBe(true)
  })

  test('allows configured authless providers after execution proof', () => {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'llama.cpp/qwen-test:0.5b',
      catalog: catalog({
        configProviders: {
          providers: [
            {
              id: 'llama.cpp',
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: 'http://127.0.0.1:8080/v1' },
              models: { 'qwen-test:0.5b': {} },
            },
          ],
          default: {},
        },
      }),
      executionOutcome: {
        outcome: 'available',
        reason: null,
      },
    })

    expect(access.kind).toBe('verified')
    expect(access.launchAllowed).toBe(true)
    expect(access.requiresExecutionProof).toBe(false)
  })

  test('keeps credentialed providers as connected routes after execution proof', () => {
    const connectedCatalog = catalog({
      connectedProviders: ['openrouter'],
      models: ['openrouter/moonshotai/kimi-k2'],
    })
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'openrouter/moonshotai/kimi-k2',
      catalog: connectedCatalog,
      executionOutcome: {
        outcome: 'available',
        reason: null,
      },
    })
    const route = buildOpenCodeModelRouteMetadata({
      selectedModel: 'openrouter/moonshotai/kimi-k2',
      catalog: connectedCatalog,
      executionOutcome: {
        outcome: 'available',
        reason: null,
      },
    })

    expect(access.kind).toBe('verified')
    expect(access.launchAllowed).toBe(true)
    expect(route.routeKind).toBe('connected_provider')
    expect(route.proofState).toBe('verified')
  })

  test('does not treat disconnected remote providers as authless', () => {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'openrouter/moonshotai/kimi-k2',
      catalog: catalog({
        configProviders: {
          providers: [
            {
              id: 'openrouter',
              models: { 'moonshotai/kimi-k2': {} },
            },
          ],
          default: {},
        },
      }),
    })

    expect(access.kind).toBe('not_authenticated')
    expect(access.launchAllowed).toBe(false)
    expect(access.requiresExecutionProof).toBe(false)
  })

  test('reports unknown scoped models as unavailable', () => {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'llama.cpp/ghost-model',
      catalog: catalog({
        models: ['llama.cpp/qwen-test:0.5b'],
      }),
    })

    expect(access.kind).toBe('unknown_model')
    expect(access.launchAllowed).toBe(false)
    expect(access.reason).toContain('was not found in the live provider catalog')
  })
})

test('OpenRouter fallback requires its own connected provider when catalog is missing', () => {
  for (const connectedProviders of [[], ['openai'], ['openrouter']]) {
    const access = evaluateOpenCodeModelAccess({
      selectedModel: 'openrouter/openrouter/free', catalog: catalog({ connectedProviders, runtimeEnv: { OPENROUTER_API_KEY: 'key' } }),
    })
    expect(access.kind).toBe(connectedProviders.includes('openrouter') ? 'credentialed' : 'unknown_model')
    expect(access.launchAllowed).toBe(connectedProviders.includes('openrouter'))
    const proven = evaluateOpenCodeModelAccess({
      selectedModel: 'openrouter/openrouter/free',
      catalog: catalog({ connectedProviders, runtimeEnv: { OPENROUTER_API_KEY: 'key' } }),
      executionOutcome: { outcome: 'available', reason: null },
    })
    expect(proven.launchAllowed).toBe(connectedProviders.includes('openrouter'))
  }
})

for (const restriction of [{ blacklist: ['openrouter/free'] }, { whitelist: [] }, { whitelist: ['other'] }, { whitelist: ['openrouter/openrouter/free'] }]) {
  for (const source of ['managed', 'config', 'live']) {
    test(`excluded router cannot launch even with earlier execution proof: ${source} ${JSON.stringify(restriction)}`, () => {
      const restricted = catalog({
        connectedProviders: ['openrouter'], models: ['openrouter/openrouter/free'],
        managedConfig: source === 'managed' ? { provider: { openrouter: restriction } } : undefined,
        configProviders: source === 'config' ? { providers: [{ id: 'openrouter', ...restriction }], default: {} } : null,
        providers: source === 'live' ? { all: [{ id: 'openrouter', ...restriction }], connected: ['openrouter'], default: {} } : null,
      })
      for (const executionOutcome of [null, { outcome: 'available' as const, reason: null }]) {
        expect(evaluateOpenCodeModelAccess({ selectedModel: 'openrouter/openrouter/free',
          catalog: restricted, executionOutcome }).launchAllowed).toBe(false)
      }
    })
  }
}

for (const apiKey of [null, '', ' ', false, [], {}, '{env:MISSING}']) {
  test(`invalid OpenRouter override cannot be reopened by execution proof: ${JSON.stringify(apiKey)}`, () => {
    const access = evaluateOpenCodeModelAccess({ selectedModel: 'openrouter/openrouter/free',
      catalog: catalog({ connectedProviders: ['openrouter'], models: ['openrouter/openrouter/free'],
        managedConfig: { provider: { openrouter: { options: { apiKey } } } } }),
      executionOutcome: { outcome: 'available' } as any })
    expect(access.launchAllowed).toBe(false)
    expect(access.kind).toBe('not_authenticated')
  })
}

test('OpenRouter free route is never configured authless even with custom loopback metadata', () => {
  const result = evaluateOpenCodeModelAccess({ selectedModel: 'openrouter/openrouter/free',
    catalog: catalog({ models: ['openrouter/openrouter/free'], configProviders: { providers: [
      { id: 'openrouter', npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:11434' }, models: { 'openrouter/free': {} } },
    ], default: {} } }) })
  expect(result.kind).toBe('not_authenticated')
  expect(result.launchAllowed).toBe(false)
})

for (const key of ['whitelist', 'blacklist']) {
  test(`raw ${key} uses the catalog environment before accepting proof`, () => {
    const result = evaluateOpenCodeModelAccess({ selectedModel: 'openrouter/openrouter/free',
      catalog: catalog({ connectedProviders: ['openrouter'], runtimeEnv: Object.freeze({ ROUTE: 'openrouter/free', OPENROUTER_API_KEY: 'key' }),
        managedConfig: { provider: { openrouter: { [key]: ['{env:ROUTE}'] } } } }),
      executionOutcome: { outcome: 'available' } as any })
    expect(result.launchAllowed).toBe(key === 'whitelist')
  })
}

for (const [options, envKey, auth, allowed] of [
  [undefined, undefined, null, false],
  [undefined, 'env-key', null, true],
  [undefined, 'env-key', { type: 'api', key: ' ' }, false],
  [undefined, undefined, { type: 'api', key: 'saved-key' }, true],
  [{ apiKey: '' }, 'env-key', { type: 'api', key: 'saved-key' }, false],
  [{ apiKey: 'explicit-key' }, undefined, { type: 'api', key: '' }, true],
] as const) {
  test(`native OpenRouter membership requires selected credential evidence: ${JSON.stringify([options, envKey, auth])}`, () => {
    const result = evaluateOpenCodeModelAccess({ selectedModel: 'openrouter/openrouter/free',
      catalog: catalog({ connectedProviders: ['openrouter'], models: [],
        managedConfig: { provider: { openrouter: { options } } },
        runtimeEnv: { OPENROUTER_API_KEY: envKey }, openRouterAuth: auth }) })
    expect(result.launchAllowed).toBe(allowed)
    expect(result.kind).toBe(allowed ? 'credentialed' : 'not_authenticated')
  })
}
