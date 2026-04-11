import { describe, expect, test } from 'bun:test'

import { resolveCodexRuntimeSelection } from './codexBackendResolver.js'

describe('codexBackendResolver', () => {
  test('auto prefers the OpenAI API when beta is enabled and OPENAI_API_KEY is configured', () => {
    const result = resolveCodexRuntimeSelection({
      preference: 'auto',
      featureFlagEnabled: true,
      oauthAuthenticated: true,
      apiKeyConfigured: true,
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
      preference: 'auto',
      featureFlagEnabled: true,
      oauthAuthenticated: true,
      apiKeyConfigured: false,
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
      preference: 'api',
      featureFlagEnabled: true,
      oauthAuthenticated: true,
      apiKeyConfigured: false,
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
      preference: 'api',
      featureFlagEnabled: false,
      oauthAuthenticated: false,
      apiKeyConfigured: true,
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
})
