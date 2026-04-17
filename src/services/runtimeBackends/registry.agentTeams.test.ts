import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

afterEach(() => {
  mock.restore()
  mock.clearAllMocks()
})

beforeEach(() => {
  mock.restore()
  mock.clearAllMocks()
})

describe('runtime backend registry with agent_teams capabilities', () => {
  test('codex runtime status exposes provider-aware extension capabilities', async () => {
    const authModulePath = new URL('../../utils/auth.ts', import.meta.url).href
    mock.module(authModulePath, () => ({
      getAuthTokenSource: () => ({ source: 'none', hasToken: false }),
      getAnthropicApiKeyWithSource: () => ({ source: 'none' }),
    }))

    const configModulePath = new URL('../../utils/config.ts', import.meta.url).href
    mock.module(configModulePath, () => ({
      getGlobalConfig: () => ({
        geminiBackendPreference: 'auto',
      }),
    }))

    const geminiAuthModulePath = new URL('../../utils/geminiAuth.ts', import.meta.url).href
    mock.module(geminiAuthModulePath, () => ({
      getGeminiApiVersion: () => 'v1beta',
      getGeminiBaseUrl: () => 'https://generativelanguage.googleapis.com',
    }))

    const modelConfigsModulePath = new URL('../../utils/model/configs.ts', import.meta.url).href
    mock.module(modelConfigsModulePath, () => ({
      CLAUDE_HAIKU_4_5_CONFIG: { firstParty: 'claude-haiku-4-5' },
      CLAUDE_OPUS_4_6_CONFIG: { firstParty: 'claude-opus-4-6' },
      CLAUDE_SONNET_4_6_CONFIG: { firstParty: 'claude-sonnet-4-6' },
    }))

    const modelAllowlistModulePath = new URL('../../utils/model/modelAllowlist.ts', import.meta.url)
      .href
    mock.module(modelAllowlistModulePath, () => ({
      isModelAllowed: () => true,
    }))

    const codexModelsModulePath = new URL('../../utils/model/codex.ts', import.meta.url).href
    mock.module(codexModelsModulePath, () => ({
      CODEX_MODELS: [
        {
          id: 'gpt-5.3-codex',
          label: 'GPT-5.3 Codex',
          description: 'Optimized for coding and tool use',
        },
      ],
    }))

    const geminiModelsModulePath = new URL('../../utils/model/gemini.ts', import.meta.url).href
    mock.module(geminiModelsModulePath, () => ({
      GEMINI_MODELS: [],
    }))

    const apiBackendPath = new URL('../gemini/backends/apiBackend.ts', import.meta.url).href
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

    const cliBackendPath = new URL('../gemini/backends/cliBackend.ts', import.meta.url).href
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

    const codexResolverPath = new URL('./codexBackendResolver.ts', import.meta.url).href
    mock.module(codexResolverPath, () => ({
      resolveCodexRuntimeSelection: () => ({
        selectedBackendId: 'auto',
        resolvedBackendId: 'api',
        authenticated: true,
        authMethod: 'api_key',
        statusMessage: null,
        detailMessage: null,
        canLoginFromUi: true,
        oauthAuthenticated: false,
        apiKeyConfigured: true,
        featureFlagEnabled: true,
      }),
    }))

    const registryModulePath = new URL('./registry.ts', import.meta.url).href
    const { getUnifiedRuntimeStatusPayload } = await import(registryModulePath)

    const payload = await getUnifiedRuntimeStatusPayload('codex')
    const codex = payload.providers.codex

    expect(payload.schemaVersion).toBe(2)
    expect(codex?.models).toEqual(['gpt-5.3-codex'])
    expect(codex?.capabilities.extensions.mcp.status).toBe('supported')
    expect(codex?.capabilities.extensions.mcp.ownership).toBe('shared')
    expect(codex?.capabilities.extensions.plugins.status).toBe('unsupported')
    expect(codex?.capabilities.extensions.plugins.reason).toContain('Anthropic sessions')
  })
})
