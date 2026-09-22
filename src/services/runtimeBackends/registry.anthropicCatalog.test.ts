import { describe, expect, test } from 'bun:test'

import { buildAnthropicRuntimeStatus } from './anthropicStatus.js'
import type { RuntimeProviderModelCatalog } from './types.js'

const baseCatalog: RuntimeProviderModelCatalog = {
  schemaVersion: 1,
  providerId: 'anthropic',
  source: 'static-fallback',
  status: 'ready',
  fetchedAt: '2026-04-21T00:00:00.000Z',
  staleAt: '2026-04-21T00:10:00.000Z',
  defaultModelId: 'haiku',
  defaultLaunchModel: 'haiku',
  models: [],
  diagnostics: {
    configReadState: 'skipped',
    appServerState: 'degraded',
  },
}

function buildMinimalAnthropicStatus(
  authMethod: string | null,
  subscriptionRateLimits = {
    primary: {
      usedPercent: 25,
      windowDurationMins: 300,
      resetsAt: 1_777_777_000,
    },
    secondary: {
      usedPercent: 50,
      windowDurationMins: 10_080,
      resetsAt: 1_777_999_000,
    },
  },
) {
  return buildAnthropicRuntimeStatus({
    auth: {
      authenticated: authMethod !== null,
      authMethod,
    },
    modelCatalog: baseCatalog,
    visibleModels: ['haiku'],
    reasoningEfforts: [],
    fastMode: {
      supported: true,
      available: false,
      reason: null,
      source: 'runtime',
    },
    extensions: {
      plugins: { status: 'supported', ownership: 'shared', reason: null },
      mcp: { status: 'supported', ownership: 'shared', reason: null },
      skills: { status: 'supported', ownership: 'shared', reason: null },
      apiKeys: { status: 'supported', ownership: 'shared', reason: null },
    },
    subscriptionRateLimits,
  })
}

describe('runtime backend registry Anthropic catalog integration', () => {
  test('anthropic runtime status exposes the normalized model catalog and parity metadata', () => {
    const anthropic = buildAnthropicRuntimeStatus({
      auth: {
        authenticated: true,
        authMethod: 'claude.ai',
      },
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic',
        source: 'anthropic-models-api',
        status: 'ready',
        fetchedAt: '2026-04-21T00:00:00.000Z',
        staleAt: '2026-04-21T00:10:00.000Z',
        defaultModelId: 'opus[1m]',
        defaultLaunchModel: 'opus[1m]',
        models: [
          {
            id: 'opus',
            launchModel: 'opus',
            displayName: 'Opus 4.7',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsFastMode: false,
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'claude-opus-4-6',
            launchModel: 'claude-opus-4-6',
            displayName: 'Opus 4.6',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text', 'image'],
            supportsFastMode: true,
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'haiku',
            launchModel: 'haiku',
            displayName: 'Haiku 4.5',
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            inputModalities: ['text', 'image'],
            supportsFastMode: false,
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
        ],
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'healthy',
        },
      },
      visibleModels: ['opus', 'claude-opus-4-6', 'haiku'],
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
      fastMode: {
        supported: true,
        available: true,
        reason: null,
        source: 'runtime',
      },
      extensions: {
        plugins: { status: 'supported', ownership: 'shared', reason: null },
        mcp: { status: 'supported', ownership: 'shared', reason: null },
        skills: { status: 'supported', ownership: 'shared', reason: null },
        apiKeys: { status: 'supported', ownership: 'shared', reason: null },
      },
    })

    expect(anthropic.authenticated).toBe(true)
    expect(anthropic.authMethod).toBe('claude.ai')
    expect(anthropic.models).toEqual(['opus', 'claude-opus-4-6', 'haiku'])
    expect(anthropic.modelCatalog?.source).toBe('anthropic-models-api')
    expect(anthropic.runtimeCapabilities).toEqual({
      modelCatalog: {
        dynamic: true,
        source: 'anthropic-models-api',
      },
      reasoningEffort: {
        supported: true,
        values: ['low', 'medium', 'high', 'max'],
        configPassthrough: true,
      },
      fastMode: {
        supported: true,
        available: true,
        reason: null,
        source: 'runtime',
      },
    })
  })

  test('anthropic runtime status exposes account-scoped live Fable, Mythos, and Sonnet 5 models', () => {
    const anthropic = buildAnthropicRuntimeStatus({
      auth: {
        authenticated: true,
        authMethod: 'claude.ai',
      },
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic',
        source: 'anthropic-models-api',
        status: 'ready',
        fetchedAt: '2026-07-02T00:00:00.000Z',
        staleAt: '2026-07-02T00:10:00.000Z',
        defaultModelId: 'claude-fable-5',
        defaultLaunchModel: 'claude-fable-5',
        models: [
          {
            id: 'claude-fable-5',
            launchModel: 'claude-fable-5',
            displayName: 'Fable 5',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image', 'pdf'],
            supportsFastMode: false,
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'claude-mythos-5',
            launchModel: 'claude-mythos-5',
            displayName: 'Mythos 5',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsFastMode: false,
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'claude-sonnet-5',
            launchModel: 'claude-sonnet-5',
            displayName: 'Sonnet 5',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsFastMode: false,
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
        ],
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'healthy',
        },
      },
      visibleModels: ['claude-fable-5', 'claude-mythos-5', 'claude-sonnet-5'],
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
      fastMode: {
        supported: true,
        available: false,
        reason: null,
        source: 'runtime',
      },
      extensions: {
        plugins: { status: 'supported', ownership: 'shared', reason: null },
        mcp: { status: 'supported', ownership: 'shared', reason: null },
        skills: { status: 'supported', ownership: 'shared', reason: null },
        apiKeys: { status: 'supported', ownership: 'shared', reason: null },
      },
    })

    expect(anthropic.models).toEqual([
      'claude-fable-5',
      'claude-mythos-5',
      'claude-sonnet-5',
    ])
    expect(anthropic.modelCatalog?.defaultLaunchModel).toBe('claude-fable-5')
    expect(anthropic.modelCatalog?.models.map(model => model.launchModel)).toEqual([
      'claude-fable-5',
      'claude-mythos-5',
      'claude-sonnet-5',
    ])
    expect(anthropic.runtimeCapabilities?.modelCatalog).toEqual({
      dynamic: true,
      source: 'anthropic-models-api',
    })
  })

  test('exposes subscription rate limits for Anthropic subscription auth', () => {
    expect(buildMinimalAnthropicStatus('claude.ai').subscriptionRateLimits).toEqual({
      primary: {
        usedPercent: 25,
        windowDurationMins: 300,
        resetsAt: 1_777_777_000,
      },
      secondary: {
        usedPercent: 50,
        windowDurationMins: 10_080,
        resetsAt: 1_777_999_000,
      },
    })
    expect(buildMinimalAnthropicStatus('oauth_token').subscriptionRateLimits).not.toBeNull()
  })

  test('hides subscription rate limits for Anthropic API key auth', () => {
    expect(buildMinimalAnthropicStatus('api_key').subscriptionRateLimits).toBeNull()
    expect(buildMinimalAnthropicStatus('api_key_helper').subscriptionRateLimits).toBeNull()
    expect(buildMinimalAnthropicStatus(null).subscriptionRateLimits).toBeNull()
  })
})
