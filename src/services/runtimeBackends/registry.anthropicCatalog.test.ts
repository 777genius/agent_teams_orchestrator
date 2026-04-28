import { describe, expect, test } from 'bun:test'

import { buildAnthropicRuntimeStatus } from './anthropicStatus.js'

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
})
