import { afterEach, describe, expect, mock, test } from 'bun:test'

type CodexStatusFixtureOptions = {
  selectedBackendId?: 'auto' | 'adapter' | 'api' | 'codex-native'
  openAiApiKey?: string | null
  codexApiKey?: string | null
  nativeBetaEnabled?: boolean
  internalUnlockEnabled?: boolean
  oauthAuthenticated?: boolean
  nativeBinaryDetected?: boolean
}

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

async function loadCodexStatus(
  options: CodexStatusFixtureOptions = {},
) {
  const originalCodexBackend = process.env.CLAUDE_CODE_CODEX_BACKEND
  const originalCodexApiBeta = process.env.CLAUDE_CODE_CODEX_API_KEY_BETA
  const originalCodexNativeBeta = process.env.CLAUDE_CODE_CODEX_NATIVE_BETA
  const originalCodexNativeInternalUnlock =
    process.env.CLAUDE_CODE_CODEX_NATIVE_INTERNAL_UNLOCK
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY
  const originalCodexApiKey = process.env.CODEX_API_KEY

  setOptionalEnv(
    'CLAUDE_CODE_CODEX_BACKEND',
    options.selectedBackendId ?? 'codex-native',
    originalCodexBackend,
  )
  setOptionalEnv(
    'CLAUDE_CODE_CODEX_API_KEY_BETA',
    '1',
    originalCodexApiBeta,
  )
  setOptionalEnv(
    'CLAUDE_CODE_CODEX_NATIVE_BETA',
    options.nativeBetaEnabled === false ? null : '1',
    originalCodexNativeBeta,
  )
  setOptionalEnv(
    'CLAUDE_CODE_CODEX_NATIVE_INTERNAL_UNLOCK',
    options.internalUnlockEnabled ? '1' : null,
    originalCodexNativeInternalUnlock,
  )
  setOptionalEnv('OPENAI_API_KEY', options.openAiApiKey ?? null, originalOpenAiApiKey)
  setOptionalEnv('CODEX_API_KEY', options.codexApiKey ?? null, originalCodexApiKey)

  try {
    const authModulePath = new URL('../../utils/auth.ts', import.meta.url).href
    mock.module(authModulePath, () => ({
      getAuthTokenSource: () => ({ source: 'none', hasToken: false }),
      getAnthropicApiKeyWithSource: () => ({ source: 'none' }),
      getCodexOAuthTokens: () =>
        options.oauthAuthenticated ? { accessToken: 'oauth-token' } : null,
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
    setOptionalEnv(
      'CLAUDE_CODE_CODEX_API_KEY_BETA',
      undefined,
      originalCodexApiBeta,
    )
    setOptionalEnv(
      'CLAUDE_CODE_CODEX_NATIVE_BETA',
      undefined,
      originalCodexNativeBeta,
    )
    setOptionalEnv(
      'CLAUDE_CODE_CODEX_NATIVE_INTERNAL_UNLOCK',
      undefined,
      originalCodexNativeInternalUnlock,
    )
    setOptionalEnv('OPENAI_API_KEY', undefined, originalOpenAiApiKey)
    setOptionalEnv('CODEX_API_KEY', undefined, originalCodexApiKey)
  }
}

afterEach(() => {
  mock.restore()
  mock.clearAllMocks()
})

describe('codex-native registry rollout states', () => {
  test('reports runtime-missing when the codex binary is not detected', async () => {
    const codex = await loadCodexStatus({
      selectedBackendId: 'codex-native',
      codexApiKey: 'sk-native-test',
      nativeBinaryDetected: false,
    })

    expect(codex?.selectedBackendId).toBe('codex-native')
    expect(codex?.resolvedBackendId).toBeNull()
    expect(codex?.availableBackends.find(option => option.id === 'codex-native')).toMatchObject({
      id: 'codex-native',
      selectable: false,
      available: false,
      state: 'runtime-missing',
      audience: 'internal',
      statusMessage: 'Codex CLI not found',
    })
  })

  test('reports authentication-required when CODEX_API_KEY is missing', async () => {
    const codex = await loadCodexStatus({
      selectedBackendId: 'codex-native',
      codexApiKey: null,
      nativeBinaryDetected: true,
    })

    expect(codex?.selectedBackendId).toBe('codex-native')
    expect(codex?.resolvedBackendId).toBeNull()
    expect(codex?.availableBackends.find(option => option.id === 'codex-native')).toMatchObject({
      id: 'codex-native',
      selectable: false,
      available: false,
      state: 'authentication-required',
      audience: 'internal',
      statusMessage: 'Authentication required',
    })
  })

  test('keeps auto resolved to the old codex lanes even when codex-native is internally unlockable', async () => {
    const codex = await loadCodexStatus({
      selectedBackendId: 'auto',
      openAiApiKey: 'sk-openai-test',
      codexApiKey: 'sk-native-test',
      nativeBinaryDetected: true,
      internalUnlockEnabled: true,
    })

    expect(codex?.selectedBackendId).toBe('auto')
    expect(codex?.resolvedBackendId).toBe('api')
    expect(codex?.availableBackends.find(option => option.id === 'auto')).toMatchObject({
      id: 'auto',
      selectable: true,
      available: true,
      state: 'ready',
      audience: 'general',
      statusMessage: 'Resolved to OpenAI API',
    })
    expect(codex?.availableBackends.find(option => option.id === 'codex-native')).toMatchObject({
      id: 'codex-native',
      selectable: true,
      available: true,
      state: 'ready',
      audience: 'internal',
      statusMessage: 'Ready for internal use',
    })
  })
})
