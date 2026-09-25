import { describe, expect, test } from 'bun:test'

import {
  buildOpenCodeModelRouteMetadata,
  evaluateOpenCodeModelAccess,
  requiresExactOpenCodeLaunchOutput,
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
  test('keeps exact launch output for cloud tags and credentialed models', () => {
    expect(requiresExactOpenCodeLaunchOutput('ollama/kimi-k2.6:cloud')).toBe(true)
    expect(requiresExactOpenCodeLaunchOutput('deepinfra/chosen')).toBe(true)
    expect(requiresExactOpenCodeLaunchOutput('cursor-acp/auto')).toBe(true)
    expect(requiresExactOpenCodeLaunchOutput('vllm/meta-llama/Llama-3-70b')).toBe(true)
  })

  test('does not treat cloudflare-style local ids as cloud routes', () => {
    expect(requiresExactOpenCodeLaunchOutput('lmstudio/cloudflare-local')).toBe(false)
    expect(requiresExactOpenCodeLaunchOutput('ollama/qwen-cloudsonnet')).toBe(false)
  })

  test('accepts non-exact launch output for local Ollama models', () => {
    expect(requiresExactOpenCodeLaunchOutput('ollama/qwen2.5-coder:1.5b')).toBe(false)
    expect(requiresExactOpenCodeLaunchOutput('ollama/qwen2.5-coder:0.5b')).toBe(false)
    expect(requiresExactOpenCodeLaunchOutput('lmstudio/local-model')).toBe(false)
  })

  test('requires exact launch output for remote Ollama and accepts loopback vLLM', () => {
    const remoteOllama = catalog({
      configProviders: {
        providers: [
          {
            id: 'ollama',
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'https://ollama.example.internal/v1' },
            models: { 'qwen2.5-coder:1.5b': {} },
          },
        ],
        default: {},
      },
    })
    const loopbackVllm = catalog({
      configProviders: {
        providers: [
          {
            id: 'vllm',
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'http://127.0.0.1:8000/v1' },
            models: { 'local-llama': {} },
          },
        ],
        default: {},
      },
    })
    expect(requiresExactOpenCodeLaunchOutput('ollama/qwen2.5-coder:1.5b', remoteOllama)).toBe(true)
    expect(requiresExactOpenCodeLaunchOutput('vllm/local-llama', loopbackVllm)).toBe(false)
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

  // The strict profile grants authless scope to any opencode/<model> without a
  // key, so this gate is what keeps paid and unknown Zen routes from launching.
  test('refuses paid and unknown Zen models without a connected key', () => {
    const paid = evaluateOpenCodeModelAccess({
      selectedModel: 'opencode/paid-model',
      catalog: catalog({
        models: ['opencode/paid-model'],
        modelMetadata: [modelMetadata('opencode/paid-model', { free: false })],
      }),
    })
    expect(paid.kind).toBe('not_authenticated')
    expect(paid.launchAllowed).toBe(false)

    const unknown = evaluateOpenCodeModelAccess({
      selectedModel: 'opencode/not-in-catalog-free',
      catalog: catalog({
        models: ['opencode/big-pickle'],
        modelMetadata: [modelMetadata('opencode/big-pickle')],
      }),
    })
    expect(unknown.kind).toBe('unknown_model')
    expect(unknown.launchAllowed).toBe(false)
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
