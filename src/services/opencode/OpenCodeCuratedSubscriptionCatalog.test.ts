import { describe, expect, test } from 'bun:test'

import {
  getOpenCodeCuratedSubscriptionProviderConfigs,
  getOpenCodeCuratedSubscriptionProvider,
  validateOpenCodeCuratedSubscriptionKey,
} from './OpenCodeCuratedSubscriptionCatalog.js'

describe('OpenCodeCuratedSubscriptionCatalog', () => {
  test.each([
    ['zai-coding-plan', 'zai-coding-plan/glm-5.2'],
    ['minimax-coding-plan', 'minimax-coding-plan/MiniMax-M3'],
    ['kimi-for-coding', 'kimi-for-coding/kimi-for-coding'],
  ] as const)(
    'requires a real model request before accepting %s credentials',
    (providerId, preferredModelId) => {
      const provider = getOpenCodeCuratedSubscriptionProvider(providerId)

      expect(provider).not.toBeNull()
      expect(provider?.credentialKind).toBe('api-key')
      expect(provider?.requireConnectExecutionProof).toBe(true)
      expect(provider?.modelProbePreferences).toContain(preferredModelId)
    },
  )

  test('accepts MiniMax subscription keys before checking the broader pay-as-you-go prefix', () => {
    expect(
      validateOpenCodeCuratedSubscriptionKey(
        'minimax-coding-plan',
        'sk-cp-valid-subscription-key',
      ),
    ).toBeNull()
    expect(
      validateOpenCodeCuratedSubscriptionKey('minimax-coding-plan', 'sk-payg-key'),
    ).toContain('pay-as-you-go')
  })

  test('explains the Xiaomi Token Plan key format and regional endpoint', () => {
    const europe = getOpenCodeCuratedSubscriptionProvider('xiaomi-token-plan-ams')

    expect(europe?.setup.secretLabel).toBe('Token Plan API Key (tp-...)')
    expect(europe?.setup.secretPlaceholder).toBe('tp-xxxxx')
    expect(europe?.setup.description).toContain('token-plan-ams.xiaomimimo.com/v1')
    expect(europe?.setup.description).toContain('shown once')
  })

  test('keeps the Z.AI Coding Plan fallback aligned with the official OpenCode contract', () => {
    const configs = getOpenCodeCuratedSubscriptionProviderConfigs()

    expect(configs['zai-coding-plan']).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: 'https://api.z.ai/api/coding/paas/v4',
      },
      models: {
        'glm-5.2': {
          reasoning: true,
          tool_call: true,
          interleaved: { field: 'reasoning_content' },
          limit: { context: 1_000_000, output: 131_072 },
        },
        'glm-5.1': {
          reasoning: true,
          tool_call: true,
          interleaved: { field: 'reasoning_content' },
        },
        'glm-5': {
          reasoning: true,
          tool_call: true,
          limit: { context: 200_000, output: 131_072 },
        },
        'glm-5-turbo': {
          reasoning: true,
          tool_call: true,
        },
        'glm-4.5-air': {
          reasoning: true,
          tool_call: true,
          limit: { context: 131_072, output: 98_304 },
        },
      },
    })
  })

  test('preserves reasoning content across Kimi and MiMo tool-call turns', () => {
    const configs = getOpenCodeCuratedSubscriptionProviderConfigs()

    expect(configs['kimi-for-coding']).toMatchObject({
      options: { baseURL: 'https://api.kimi.com/coding/v1' },
      models: {
        'kimi-for-coding': {
          tool_call: true,
          interleaved: { field: 'reasoning_content' },
        },
      },
    })
    expect(configs['xiaomi-token-plan-ams']).toMatchObject({
      options: { baseURL: 'https://token-plan-ams.xiaomimimo.com/v1' },
      models: {
        'mimo-v2.5-pro': {
          tool_call: true,
          interleaved: { field: 'reasoning_content' },
        },
      },
    })
  })

  test('keeps every curated coding model capable of multi-turn tool execution', () => {
    const configs = getOpenCodeCuratedSubscriptionProviderConfigs()
    const providerIds = [
      'zai-coding-plan',
      'kimi-for-coding',
      'xiaomi-token-plan-ams',
      'xiaomi-token-plan-sgp',
      'xiaomi-token-plan-cn',
    ] as const

    for (const providerId of providerIds) {
      const provider = configs[providerId] as {
        models?: Record<string, {
          reasoning?: boolean
          tool_call?: boolean
          interleaved?: { field?: string }
          modalities?: { output?: readonly string[] }
        }>
      }
      const models = Object.entries(provider.models ?? {})
      expect(models.length).toBeGreaterThan(0)
      for (const [modelId, model] of models) {
        expect(model.reasoning, `${providerId}/${modelId} reasoning`).toBe(true)
        expect(model.tool_call, `${providerId}/${modelId} tool_call`).toBe(true)
        expect(model.interleaved?.field, `${providerId}/${modelId} reasoning field`).toBe(
          'reasoning_content',
        )
        expect(model.modalities?.output, `${providerId}/${modelId} output modality`).toContain(
          'text',
        )
      }
    }
  })
})
