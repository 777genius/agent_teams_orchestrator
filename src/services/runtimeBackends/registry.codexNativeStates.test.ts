import { describe, expect, test } from 'bun:test'

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
  settingsInline?: Record<string, unknown> | null
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

  const originalWhich = Bun.which
  Bun.which = ((binaryName: string) => {
    if (binaryName === 'codex') {
      return options.nativeBinaryDetected === false ? null : '/usr/local/bin/codex'
    }
    return originalWhich(binaryName)
  }) as typeof Bun.which

  try {
    const bootstrapStateModulePath = new URL('../../bootstrap/state.js', import.meta.url).href
    const { setFlagSettingsInline } = await import(
      `${bootstrapStateModulePath}?test=${Math.random().toString(36).slice(2)}`
    )
    setFlagSettingsInline(options.settingsInline ?? null)

    const registryModulePath = new URL('./registry.js', import.meta.url).href
    const { getUnifiedRuntimeStatusPayload } = await import(
      `${registryModulePath}?test=${Math.random().toString(36).slice(2)}`
    )

    const payload = await getUnifiedRuntimeStatusPayload('codex')
    return payload.providers.codex
  } finally {
    const bootstrapStateModulePath = new URL('../../bootstrap/state.js', import.meta.url).href
    const { setFlagSettingsInline } = await import(
      `${bootstrapStateModulePath}?test=${Math.random().toString(36).slice(2)}`
    )
    setFlagSettingsInline(null)
    Bun.which = originalWhich
    setOptionalEnv('CLAUDE_CODE_CODEX_BACKEND', undefined, originalCodexBackend)
    setOptionalEnv('OPENAI_API_KEY', undefined, originalOpenAiApiKey)
    setOptionalEnv('CODEX_API_KEY', undefined, originalCodexApiKey)
  }
}

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

  test('reports ready for host-managed ChatGPT auth without requiring API keys', async () => {
    const codex = await loadCodexStatus({
      codexApiKey: null,
      openAiApiKey: null,
      settingsInline: {
        codex: {
          forced_login_method: 'chatgpt',
        },
      },
    })

    expect(codex?.selectedBackendId).toBe('codex-native')
    expect(codex?.resolvedBackendId).toBe('codex-native')
    expect(codex?.authMethod).toBe('oauth_token')
    expect(codex?.availableBackends[0]).toMatchObject({
      id: 'codex-native',
      selectable: true,
      available: true,
      state: 'ready',
      audience: 'general',
      statusMessage: 'Ready',
    })
    expect(codex?.backend).toMatchObject({
      kind: 'codex-native',
      authMethodDetail: 'oauth_token',
    })
  })
})
