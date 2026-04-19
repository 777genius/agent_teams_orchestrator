import { describe, expect, test } from 'bun:test'

import {
  getCodexApiKey,
  getCodexRuntimeBackendPreference,
  normalizeCodexBackendPreference,
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
})
