import { describe, expect, test } from 'bun:test'

import { resolveCodexRuntimeSelection } from './codexBackendResolver.js'

describe('codexBackendResolver', () => {
  test('auto prefers the OpenAI API when beta is enabled and OPENAI_API_KEY is configured', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      preference: 'auto',
      featureFlagEnabled: true,
      oauthAuthenticated: true,
      apiKeyConfigured: true,
      nativeFeatureFlagEnabled: false,
      nativeApiKeyConfigured: false,
      nativeBinaryDetected: false,
    })

    expect(result).toMatchObject({
      selectedBackendId: 'auto',
      resolvedBackendId: 'api',
      authenticated: true,
      authMethod: 'api_key',
      canLoginFromUi: true,
      statusMessage: 'Resolved to OpenAI API',
    })
  })

  test('auto falls back to the built-in adapter when no API key is configured', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      preference: 'auto',
      featureFlagEnabled: true,
      oauthAuthenticated: true,
      apiKeyConfigured: false,
      nativeFeatureFlagEnabled: false,
      nativeApiKeyConfigured: false,
      nativeBinaryDetected: false,
    })

    expect(result).toMatchObject({
      selectedBackendId: 'auto',
      resolvedBackendId: 'adapter',
      authenticated: true,
      authMethod: 'oauth_token',
    })
  })

  test('api mode stays unavailable without OPENAI_API_KEY even when beta is enabled', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      preference: 'api',
      featureFlagEnabled: true,
      oauthAuthenticated: true,
      apiKeyConfigured: false,
      nativeFeatureFlagEnabled: false,
      nativeApiKeyConfigured: false,
      nativeBinaryDetected: false,
    })

    expect(result).toMatchObject({
      selectedBackendId: 'api',
      resolvedBackendId: null,
      authenticated: false,
      authMethod: null,
      canLoginFromUi: false,
      statusMessage: 'Codex OpenAI API not ready',
      detailMessage: 'Codex API key mode requires OPENAI_API_KEY.',
    })
  })

  test('api mode stays disabled until the beta flag is enabled', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      preference: 'api',
      featureFlagEnabled: false,
      oauthAuthenticated: false,
      apiKeyConfigured: true,
      nativeFeatureFlagEnabled: false,
      nativeApiKeyConfigured: false,
      nativeBinaryDetected: false,
    })

    expect(result).toMatchObject({
      selectedBackendId: 'api',
      resolvedBackendId: null,
      authenticated: false,
      canLoginFromUi: false,
      detailMessage:
        'Codex API key mode is disabled until the beta flag is enabled.',
    })
  })

  test('codex-native stays unavailable until the native beta flag is enabled', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      preference: 'codex-native',
      featureFlagEnabled: false,
      oauthAuthenticated: false,
      apiKeyConfigured: false,
      nativeFeatureFlagEnabled: false,
      nativeBinaryDetected: true,
      nativeApiKeyConfigured: true,
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: null,
      authenticated: false,
      authMethod: null,
      canLoginFromUi: false,
      statusMessage: 'Codex native runtime not ready',
      detailMessage:
        'Codex native runtime is disabled until CLAUDE_CODE_CODEX_NATIVE_BETA is enabled.',
    })
  })

  test('codex-native stays unavailable without a detected codex binary', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      preference: 'codex-native',
      featureFlagEnabled: false,
      oauthAuthenticated: false,
      apiKeyConfigured: false,
      nativeFeatureFlagEnabled: true,
      nativeBinaryDetected: false,
      nativeApiKeyConfigured: true,
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: null,
      authenticated: false,
      authMethod: null,
      canLoginFromUi: false,
      detailMessage:
        'Codex native runtime requires the codex CLI binary to be installed and discoverable.',
    })
  })

  test('codex-native stays unavailable without CODEX_API_KEY', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      preference: 'codex-native',
      featureFlagEnabled: false,
      oauthAuthenticated: false,
      apiKeyConfigured: false,
      nativeFeatureFlagEnabled: true,
      nativeBinaryDetected: true,
      nativeApiKeyConfigured: false,
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: null,
      authenticated: false,
      authMethod: null,
      canLoginFromUi: false,
      detailMessage: 'Codex native runtime requires CODEX_API_KEY.',
    })
  })

  test('codex-native resolves only when the flag, binary, and CODEX_API_KEY are all ready', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      preference: 'codex-native',
      featureFlagEnabled: false,
      oauthAuthenticated: false,
      apiKeyConfigured: false,
      nativeFeatureFlagEnabled: true,
      nativeBinaryDetected: true,
      nativeApiKeyConfigured: true,
    })

    expect(result).toMatchObject({
      selectedBackendId: 'codex-native',
      resolvedBackendId: 'codex-native',
      authenticated: true,
      authMethod: 'api_key',
      canLoginFromUi: false,
      statusMessage: 'Codex native runtime ready',
      detailMessage:
        'Codex native runtime is ready through the local codex exec seam.',
    })
  })

  test('auto never silently resolves to codex-native in phase 0', () => {
    const result = resolveCodexRuntimeSelection({
      env: {},
      preference: 'auto',
      featureFlagEnabled: false,
      oauthAuthenticated: false,
      apiKeyConfigured: false,
      nativeFeatureFlagEnabled: true,
      nativeBinaryDetected: true,
      nativeApiKeyConfigured: true,
    })

    expect(result).toMatchObject({
      selectedBackendId: 'auto',
      resolvedBackendId: null,
      authenticated: false,
      authMethod: null,
    })
  })
})
