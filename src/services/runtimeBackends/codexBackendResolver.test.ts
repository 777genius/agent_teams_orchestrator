import { describe, expect, test } from 'bun:test'

import {
  detectCodexCliLoginState,
  getCodexApiKey,
  getCodexForcedLoginMethod,
  getCodexRuntimeBackendPreference,
  normalizeCodexBackendPreference,
  resolveCodexCliBinary,
  resolveCodexRuntimeSelection,
} from './codexBackendResolver.js'

describe('codexBackendResolver', () => {
  test('normalizes every stored legacy preference to codex-native', () => {
    expect(normalizeCodexBackendPreference(undefined)).toBe('codex-native')
    expect(normalizeCodexBackendPreference(null)).toBe('codex-native')
    expect(normalizeCodexBackendPreference('auto')).toBe('codex-native')
    expect(normalizeCodexBackendPreference('adapter')).toBe('codex-native')
    expect(normalizeCodexBackendPreference('api')).toBe('codex-native')
    expect(normalizeCodexBackendPreference('codex-native')).toBe('codex-native')
  })

  test('prefers CODEX_API_KEY and falls back to OPENAI_API_KEY', () => {
    expect(getCodexApiKey({ CODEX_API_KEY: 'sk-native', OPENAI_API_KEY: 'sk-openai' })).toBe(
      'sk-native',
    )
    expect(getCodexApiKey({ OPENAI_API_KEY: 'sk-openai' })).toBe('sk-openai')
    expect(getCodexApiKey({})).toBeNull()
  })

  test('always reports the native backend as selected', () => {
    expect(getCodexRuntimeBackendPreference({ CLAUDE_CODE_CODEX_BACKEND: 'api' })).toBe(
      'codex-native',
    )
  })

  test('prefers CODEX_CLI_PATH over PATH lookup for the Codex binary', () => {
    let whichCalled = false
    expect(
      resolveCodexCliBinary({
        env: {
          CODEX_CLI_PATH: ' C:\\Program Files\\OpenAI\\codex.cmd ',
        },
        which: () => {
          whichCalled = true
          return '/usr/local/bin/codex'
        },
      }),
    ).toEqual({
      executablePath: 'C:\\Program Files\\OpenAI\\codex.cmd',
      executableSource: 'configured-env',
    })
    expect(whichCalled).toBe(false)
  })

  test('checks Codex login status through the configured binary and env', () => {
    const calls: {
      executablePath: string
      args: string[]
      env: NodeJS.ProcessEnv | undefined
    }[] = []
    const state = detectCodexCliLoginState(10_000, {
      env: {
        CODEX_CLI_PATH: '/opt/codex/bin/codex',
        CODEX_HOME: '/tmp/codex-home-a',
      },
      which: () => '/usr/local/bin/codex',
      spawnSync: (executablePath, args, options) => {
        calls.push({
          executablePath,
          args,
          env: options.env,
        })
        return {
          status: 0,
          stdout: 'Logged in using ChatGPT',
          stderr: '',
        } as never
      },
    })

    expect(state).toBe('logged_in')
    expect(calls).toEqual([
      {
        executablePath: '/opt/codex/bin/codex',
        args: ['login', 'status'],
        env: {
          CODEX_CLI_PATH: '/opt/codex/bin/codex',
          CODEX_HOME: '/tmp/codex-home-a',
        },
      },
    ])
  })

  test('reads the host-managed forced login method from inline settings', () => {
    expect(
      getCodexForcedLoginMethod({
        codex: {
          forced_login_method: 'chatgpt',
        },
      }),
    ).toBe('chatgpt')
    expect(
      getCodexForcedLoginMethod({
        codex: {
          forced_login_method: 'api',
        },
      }),
    ).toBe('api')
    expect(getCodexForcedLoginMethod({ codex: {} })).toBeNull()
  })

  test('reports runtime-missing when the codex binary is unavailable', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      nativeBinaryDetected: false,
      apiKeyConfigured: true,
      nativeApiKeyConfigured: true,
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: null,
      authenticated: false,
      authMethod: null,
      canLoginFromUi: false,
      statusMessage: 'Codex native runtime unavailable',
      detailMessage:
        'Codex native runtime requires the codex CLI binary to be installed and discoverable.',
    })
  })

  test('reports authentication-required when neither CODEX_API_KEY nor OPENAI_API_KEY is configured', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      nativeBinaryDetected: true,
      apiKeyConfigured: false,
      nativeApiKeyConfigured: false,
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: null,
      authenticated: false,
      authMethod: null,
      canLoginFromUi: false,
      statusMessage: 'Codex native runtime unavailable',
      detailMessage:
        'Codex native runtime requires CODEX_API_KEY or OPENAI_API_KEY.',
    })
  })

  test('resolves to codex-native when the binary and any supported API key are present', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      nativeBinaryDetected: true,
      apiKeyConfigured: true,
      nativeApiKeyConfigured: true,
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: 'codex-native',
      authenticated: true,
      authMethod: 'api_key',
      canLoginFromUi: false,
      statusMessage: 'Codex native runtime ready',
      detailMessage: 'Codex native runtime is ready through the local codex exec seam.',
    })
  })

  test('resolves to codex-native when host-managed ChatGPT auth is selected even without API keys', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      nativeBinaryDetected: true,
      apiKeyConfigured: false,
      nativeApiKeyConfigured: false,
      chatgptLoginState: 'logged_in',
      settingsInline: {
        codex: {
          forced_login_method: 'chatgpt',
        },
      },
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: 'codex-native',
      authenticated: true,
      authMethod: 'oauth_token',
      canLoginFromUi: false,
      statusMessage: 'Codex native runtime ready',
      detailMessage:
        'Codex native runtime is ready through the local codex exec seam using the host-managed ChatGPT account path.',
    })
  })

  test('fails closed when host forces chatgpt mode and login state is unknown', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      nativeBinaryDetected: true,
      apiKeyConfigured: false,
      nativeApiKeyConfigured: false,
      chatgptLoginState: 'unknown',
      settingsInline: {
        codex: {
          forced_login_method: 'chatgpt',
        },
      },
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: null,
      authenticated: false,
      authMethod: null,
      authCheckIndeterminate: true,
      canLoginFromUi: false,
      statusMessage: 'Codex native runtime unavailable',
    })
  })

  test('does not mark pinned ChatGPT auth as ready when codex login is inactive', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      nativeBinaryDetected: true,
      apiKeyConfigured: false,
      nativeApiKeyConfigured: false,
      chatgptLoginState: 'not_logged_in',
      settingsInline: {
        codex: {
          forced_login_method: 'chatgpt',
        },
      },
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: null,
      authenticated: false,
      authMethod: null,
      canLoginFromUi: false,
      statusMessage: 'Codex native runtime unavailable',
      detailMessage: 'Codex native runtime requires an active `codex login` ChatGPT session.',
    })
  })

  test('includes configured runtime context when pinned ChatGPT login is not visible', () => {
    const result = resolveCodexRuntimeSelection({
      env: {
        CODEX_CLI_PATH: '/opt/codex/bin/codex',
        CODEX_HOME: '/tmp/empty-codex-home',
      },
      apiKeyConfigured: false,
      nativeApiKeyConfigured: false,
      chatgptLoginState: 'not_logged_in',
      settingsInline: {
        codex: {
          forced_login_method: 'chatgpt',
        },
      },
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: null,
      authenticated: false,
      authMethod: null,
      statusMessage: 'Codex native runtime unavailable',
      detailMessage:
        'Codex native runtime requires an active `codex login` ChatGPT session. Runtime context: binary=configured-env:/opt/codex/bin/codex; CODEX_HOME=/tmp/empty-codex-home; login=not_logged_in.',
    })
  })

  test('falls back to API auth when auto ChatGPT routing is inactive but an API key exists', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      nativeBinaryDetected: true,
      oauthAuthenticated: true,
      apiKeyConfigured: true,
      nativeApiKeyConfigured: true,
      chatgptLoginState: 'not_logged_in',
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: 'codex-native',
      authenticated: true,
      authMethod: 'api_key',
      canLoginFromUi: false,
      statusMessage: 'Codex native runtime ready',
      detailMessage: 'Codex native runtime is ready through the local codex exec seam.',
    })
  })

  test('does not report API fallback authenticated while ChatGPT login is unknown', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      nativeBinaryDetected: true,
      oauthAuthenticated: true,
      apiKeyConfigured: true,
      nativeApiKeyConfigured: true,
      chatgptLoginState: 'unknown',
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: null,
      authCheckIndeterminate: true,
      authenticated: false,
      authMethod: null,
      statusMessage: 'Codex native runtime degraded',
      detailMessage: 'Codex native runtime is not ready.',
    })
  })

  test('keeps api mode strict when host settings pin Codex to API auth', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      nativeBinaryDetected: true,
      apiKeyConfigured: false,
      nativeApiKeyConfigured: false,
      settingsInline: {
        codex: {
          forced_login_method: 'api',
        },
      },
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: null,
      authenticated: false,
      authMethod: null,
      statusMessage: 'Codex native runtime unavailable',
      detailMessage:
        'Codex native runtime requires CODEX_API_KEY or OPENAI_API_KEY.',
    })
  })
})
