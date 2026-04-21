import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

afterEach(() => {
  mock.restore()
  mock.clearAllMocks()
})

beforeEach(() => {
  mock.restore()
  mock.clearAllMocks()
})

describe('runtime backend registry Anthropic catalog integration', () => {
  test('anthropic runtime status exposes the normalized model catalog and safe effort metadata', async () => {
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'

    try {
    const authModulePath = new URL('../../utils/auth.js', import.meta.url).href
    mock.module(authModulePath, () => ({
      getAuthTokenSource: () => ({ source: 'claude.ai', hasToken: true }),
      getAnthropicApiKeyWithSource: () => ({ source: 'none' }),
    }))

    const configModulePath = new URL('../../utils/config.js', import.meta.url).href
    mock.module(configModulePath, () => ({
      getGlobalConfig: () => ({
        geminiBackendPreference: 'auto',
      }),
    }))

    const geminiAuthModulePath = new URL('../../utils/geminiAuth.js', import.meta.url).href
    mock.module(geminiAuthModulePath, () => ({
      getGeminiApiVersion: () => 'v1beta',
      getGeminiBaseUrl: () => 'https://generativelanguage.googleapis.com',
    }))

    const modelAllowlistModulePath = new URL('../../utils/model/modelAllowlist.js', import.meta.url)
      .href
    mock.module(modelAllowlistModulePath, () => ({
      isModelAllowed: () => true,
    }))

    const codexModelsModulePath = new URL('../../utils/model/codex.js', import.meta.url).href
    mock.module(codexModelsModulePath, () => ({
      CODEX_MODELS: [],
    }))

    const geminiModelsModulePath = new URL('../../utils/model/gemini.js', import.meta.url).href
    mock.module(geminiModelsModulePath, () => ({
      GEMINI_MODELS: [],
    }))

    const apiBackendPath = new URL('../gemini/backends/apiBackend.js', import.meta.url).href
    mock.module(apiBackendPath, () => ({
      geminiApiBackend: {
        validate: async () => ({
          ok: false,
          backend: 'api',
          authMethod: 'none',
          endpointLabel: 'https://generativelanguage.googleapis.com/v1beta',
          message: 'Not configured',
        }),
      },
    }))

    const cliBackendPath = new URL('../gemini/backends/cliBackend.js', import.meta.url).href
    mock.module(cliBackendPath, () => ({
      geminiCliBackend: {
        validate: async () => ({
          ok: false,
          backend: 'cli',
          authMethod: 'none',
          endpointLabel: 'Code Assist (cloudcode-pa.googleapis.com/v1internal)',
          message: 'Not configured',
        }),
      },
    }))

    const anthropicCatalogModulePath = new URL('./anthropicCatalog.js', import.meta.url).href
    mock.module(anthropicCatalogModulePath, () => ({
      getAnthropicRuntimeModelCatalog: async () => ({
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
            supportedReasoningEfforts: ['low', 'medium', 'high'],
            defaultReasoningEffort: null,
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'opus[1m]',
            launchModel: 'opus[1m]',
            displayName: 'Opus 4.7 (1M)',
            hidden: true,
            supportedReasoningEfforts: ['low', 'medium', 'high'],
            defaultReasoningEffort: null,
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'claude-opus-4-6',
            launchModel: 'claude-opus-4-6',
            displayName: 'Opus 4.6',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high'],
            defaultReasoningEffort: null,
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'sonnet',
            launchModel: 'sonnet',
            displayName: 'Sonnet 4.6',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high'],
            defaultReasoningEffort: null,
            inputModalities: ['text', 'image'],
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
      }),
      getAnthropicVisibleRuntimeModels: () => ['opus', 'claude-opus-4-6', 'sonnet', 'haiku'],
      getAnthropicRuntimeReasoningEfforts: () => ['low', 'medium', 'high'],
    }))

    const registryModulePath = new URL('./registry.js', import.meta.url).href
    const { getUnifiedRuntimeStatusPayload } = await import(
      `${registryModulePath}?test=${Math.random().toString(36).slice(2)}`
    )

    const payload = await getUnifiedRuntimeStatusPayload('anthropic')
    const anthropic = payload.providers.anthropic

    expect(payload.schemaVersion).toBe(2)
    expect(anthropic?.authenticated).toBe(true)
    expect(anthropic?.authMethod).toBeTruthy()
    expect(anthropic?.models).toEqual(['opus', 'claude-opus-4-6', 'sonnet', 'haiku'])
    expect(['anthropic-models-api', 'static-fallback']).toContain(anthropic?.modelCatalog?.source)
    expect(anthropic?.runtimeCapabilities).toEqual({
      modelCatalog: {
        dynamic: true,
        source: anthropic?.modelCatalog?.source ?? 'static-fallback',
      },
      reasoningEffort: {
        supported: true,
        values: ['low', 'medium', 'high'],
        configPassthrough: false,
      },
    })
    } finally {
      if (originalAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
      }
    }
  })
})
