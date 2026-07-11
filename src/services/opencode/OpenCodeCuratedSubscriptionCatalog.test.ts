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
        },
        'glm-5-turbo': {
          reasoning: true,
          tool_call: true,
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
})
