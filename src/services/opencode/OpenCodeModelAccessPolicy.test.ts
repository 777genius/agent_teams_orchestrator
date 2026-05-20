import { describe, expect, test } from 'bun:test'

import { evaluateOpenCodeModelAccess } from './OpenCodeModelAccessPolicy.js'

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
