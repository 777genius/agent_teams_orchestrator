import { afterEach, describe, expect, mock, test } from 'bun:test'

function setOptionalEnv(
  key: string,
  value: string | null | undefined,
  original: string | undefined,
) {
  if (value === undefined) {
    if (original === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = original
    }
    return
  }

  if (value === null) {
    delete process.env[key]
    return
  }

  process.env[key] = value
}

async function loadCodexStatus(options: {
  backendEnv?: string | null
  openAiApiKey?: string | null
  codexApiKey?: string | null
  nativeBinaryDetected?: boolean
} = {}) {
  const originalCodexBackend = process.env.CLAUDE_CODE_CODEX_BACKEND
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY
  const originalCodexApiKey = process.env.CODEX_API_KEY

  setOptionalEnv(
    'CLAUDE_CODE_CODEX_BACKEND',
    options.backendEnv ?? 'codex-native',
    originalCodexBackend,
  )
  setOptionalEnv('OPENAI_API_KEY', options.openAiApiKey ?? null, originalOpenAiApiKey)
  setOptionalEnv('CODEX_API_KEY', options.codexApiKey ?? null, originalCodexApiKey)

  try {
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

    const modelAllowlistModulePath = new URL(
      '../../utils/model/modelAllowlist.ts',
      import.meta.url,
    ).href
    mock.module(modelAllowlistModulePath, () => ({
      isModelAllowed: () => true,
    }))

    const codexModelsModulePath = new URL('../../utils/model/codex.ts', import.meta.url).href
    mock.module(codexModelsModulePath, () => ({
      CODEX_MODELS: [{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }],
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

    const originalWhich = Bun.which
    Bun.which = ((binaryName: string) => {
      if (binaryName === 'codex') {
        return options.nativeBinaryDetected === false ? null : '/usr/local/bin/codex'
      }
      return originalWhich(binaryName)
    }) as typeof Bun.which

    try {
      const registryModulePath = new URL('./registry.ts', import.meta.url).href
      const { getUnifiedRuntimeStatusPayload } = await import(
        `${registryModulePath}?test=${Math.random().toString(36).slice(2)}`
      )

      const payload = await getUnifiedRuntimeStatusPayload('codex')
      return payload.providers.codex
    } finally {
      Bun.which = originalWhich
    }
  } finally {
    setOptionalEnv('CLAUDE_CODE_CODEX_BACKEND', undefined, originalCodexBackend)
    setOptionalEnv('OPENAI_API_KEY', undefined, originalOpenAiApiKey)
    setOptionalEnv('CODEX_API_KEY', undefined, originalCodexApiKey)
  }
}

afterEach(() => {
  mock.restore()
  mock.clearAllMocks()
})

describe('codex-native registry rollout states', () => {
  test('reports ready when the codex binary and CODEX_API_KEY are present', async () => {
    const codex = await loadCodexStatus({
      codexApiKey: 'sk-native-test',
    })

    expect(codex?.selectedBackendId).toBe('codex-native')
    expect(codex?.resolvedBackendId).toBe('codex-native')
    expect(codex?.availableBackends).toHaveLength(1)
    expect(codex?.availableBackends[0]).toMatchObject({
      id: 'codex-native',
      selectable: true,
      available: true,
      state: 'ready',
      audience: 'general',
      statusMessage: 'Ready',
    })
  })

  test('reports authentication-required when both supported API key env vars are missing', async () => {
    const codex = await loadCodexStatus({
      codexApiKey: null,
      openAiApiKey: null,
    })

    expect(codex?.selectedBackendId).toBe('codex-native')
    expect(codex?.resolvedBackendId).toBeNull()
    expect(codex?.availableBackends[0]).toMatchObject({
      id: 'codex-native',
      selectable: false,
      available: false,
      state: 'authentication-required',
      audience: 'general',
      statusMessage: 'Authentication required',
    })
  })

  test('reports runtime-missing when the codex binary is not detected', async () => {
    const codex = await loadCodexStatus({
      codexApiKey: 'sk-native-test',
      nativeBinaryDetected: false,
    })

    expect(codex?.selectedBackendId).toBe('codex-native')
    expect(codex?.resolvedBackendId).toBeNull()
    expect(codex?.availableBackends[0]).toMatchObject({
      id: 'codex-native',
      selectable: false,
      available: false,
      state: 'runtime-missing',
      audience: 'general',
      statusMessage: 'Codex CLI not found',
    })
  })

  test('normalizes legacy backend env values to the native option', async () => {
    const codex = await loadCodexStatus({
      backendEnv: 'api',
      openAiApiKey: 'sk-openai-test',
      codexApiKey: null,
    })

    expect(codex?.selectedBackendId).toBe('codex-native')
    expect(codex?.resolvedBackendId).toBe('codex-native')
    expect(codex?.availableBackends.map(option => option.id)).toEqual(['codex-native'])
  })
})
