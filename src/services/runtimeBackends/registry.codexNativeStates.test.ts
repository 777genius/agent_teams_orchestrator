import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'

const REGISTRY_STATUS_TEST_TIMEOUT_MS = 30_000

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
  codexCliPath?: string | null
  nativeBinaryDetected?: boolean
  nativeBinaryPath?: string
  settingsInline?: Record<string, unknown> | null
} = {}) {
  const originalCodexBackend = process.env.CLAUDE_CODE_CODEX_BACKEND
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY
  const originalCodexApiKey = process.env.CODEX_API_KEY
  const originalCodexCliPath = process.env.CODEX_CLI_PATH

  setOptionalEnv(
    'CLAUDE_CODE_CODEX_BACKEND',
    options.backendEnv ?? 'codex-native',
    originalCodexBackend,
  )
  setOptionalEnv('OPENAI_API_KEY', options.openAiApiKey ?? null, originalOpenAiApiKey)
  setOptionalEnv('CODEX_API_KEY', options.codexApiKey ?? null, originalCodexApiKey)
  setOptionalEnv('CODEX_CLI_PATH', options.codexCliPath ?? null, originalCodexCliPath)

  const originalWhich = Bun.which
  Bun.which = ((binaryName: string) => {
    if (binaryName === 'codex') {
      return options.nativeBinaryDetected === false
        ? null
        : options.nativeBinaryPath ?? '/usr/local/bin/codex'
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

    const payload = await getUnifiedRuntimeStatusPayload('codex', {
      getCodexModelCatalog: async () => ({
        schemaVersion: 1,
        providerId: 'codex',
        source: 'static-fallback',
        status: 'degraded',
        fetchedAt: '2026-04-28T00:00:00.000Z',
        staleAt: '2026-04-28T00:10:00.000Z',
        defaultModelId: 'gpt-5.4',
        defaultLaunchModel: 'gpt-5.4',
        models: [
          {
            id: 'gpt-5.4',
            launchModel: 'gpt-5.4',
            displayName: 'GPT-5.4',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            supportsFastMode: true,
            isDefault: true,
            upgrade: false,
            source: 'static-fallback',
          },
        ],
        diagnostics: {
          configReadState: 'skipped',
          appServerState: 'degraded',
          message: null,
          code: null,
        },
      }),
    })
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
    setOptionalEnv('CODEX_CLI_PATH', undefined, originalCodexCliPath)
  }
}

function createLoggedInCodexShim(): { binaryPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-login-shim-'))
  const binaryPath = path.join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex')

  if (process.platform === 'win32') {
    writeFileSync(
      binaryPath,
      '@echo off\r\nif "%1"=="login" if "%2"=="status" exit /b 0\r\nexit /b 1\r\n',
    )
  } else {
    writeFileSync(
      binaryPath,
      '#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit 0; fi\nexit 1\n',
    )
    chmodSync(binaryPath, 0o755)
  }

  return {
    binaryPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
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
  }, REGISTRY_STATUS_TEST_TIMEOUT_MS)

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
  }, REGISTRY_STATUS_TEST_TIMEOUT_MS)

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
  }, REGISTRY_STATUS_TEST_TIMEOUT_MS)

  test('normalizes legacy backend env values to the native option', async () => {
    const codex = await loadCodexStatus({
      backendEnv: 'api',
      openAiApiKey: 'sk-openai-test',
      codexApiKey: null,
    })

    expect(codex?.selectedBackendId).toBe('codex-native')
    expect(codex?.resolvedBackendId).toBe('codex-native')
    expect(codex?.availableBackends.map(option => option.id)).toEqual(['codex-native'])
  }, REGISTRY_STATUS_TEST_TIMEOUT_MS)

  test('reports configured Codex CLI path in external diagnostics', async () => {
    const codex = await loadCodexStatus({
      codexApiKey: 'sk-native-test',
      codexCliPath: '/opt/codex/bin/codex.cmd',
      nativeBinaryDetected: false,
    })

    expect(codex?.resolvedBackendId).toBe('codex-native')
    expect(codex?.externalRuntimeDiagnostics[0]).toMatchObject({
      id: 'cli-bin',
      detected: true,
      detailMessage: '/opt/codex/bin/codex.cmd',
    })
  }, REGISTRY_STATUS_TEST_TIMEOUT_MS)

  test('reports ready for host-managed ChatGPT auth without requiring API keys', async () => {
    const shim = createLoggedInCodexShim()
    try {
      const codex = await loadCodexStatus({
        codexApiKey: null,
        openAiApiKey: null,
        nativeBinaryPath: shim.binaryPath,
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
    } finally {
      shim.cleanup()
    }
  }, REGISTRY_STATUS_TEST_TIMEOUT_MS)

  test('rechecks ChatGPT login status when the detected codex binary path changes', async () => {
    const firstShim = createLoggedInCodexShim()
    const secondShim = createLoggedInCodexShim()
    try {
      const firstCodex = await loadCodexStatus({
        codexApiKey: null,
        openAiApiKey: null,
        nativeBinaryPath: firstShim.binaryPath,
        settingsInline: {
          codex: {
            forced_login_method: 'chatgpt',
          },
        },
      })
      const secondCodex = await loadCodexStatus({
        codexApiKey: null,
        openAiApiKey: null,
        nativeBinaryPath: secondShim.binaryPath,
        settingsInline: {
          codex: {
            forced_login_method: 'chatgpt',
          },
        },
      })

      expect(firstCodex?.resolvedBackendId).toBe('codex-native')
      expect(firstCodex?.authMethod).toBe('oauth_token')
      expect(secondCodex?.resolvedBackendId).toBe('codex-native')
      expect(secondCodex?.authMethod).toBe('oauth_token')
    } finally {
      firstShim.cleanup()
      secondShim.cleanup()
    }
  }, REGISTRY_STATUS_TEST_TIMEOUT_MS)
})
