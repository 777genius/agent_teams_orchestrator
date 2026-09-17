import { describe, expect, test } from 'bun:test'

import {
  buildCodexNativeUserLoopbackProviderConfigOverrides,
  parseCodexUserLoopbackProvider,
} from './userLoopbackProviderConfigOverrides.js'

const MIXIN_CONFIG = `
model = "gemini-3.8-flash-high-cursor"
model_provider = "codex-mixin"
model_catalog_json = "/tmp/codex-home/model-catalogs/mixin-models.json"

[model_providers.codex-mixin]
name = "Codex Mixin"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = true
stream_idle_timeout_ms = 900000
request_max_retries = 2
http_headers = { "x-codex-mixin-client-key" = "test-mixin-key" }
`

describe('parseCodexUserLoopbackProvider', () => {
  test('parses a loopback mixin provider and keeps header names without treating OpenAI as local', () => {
    const parsed = parseCodexUserLoopbackProvider(MIXIN_CONFIG, {
      CODEX_HOME: '/tmp/codex-home',
    })

    expect(parsed).toMatchObject({
      providerId: 'codex-mixin',
      name: 'Codex Mixin',
      baseUrl: 'http://127.0.0.1:8788/v1',
      wireApi: 'responses',
      requiresOpenaiAuth: true,
      supportsWebsockets: true,
      defaultModel: 'gemini-3.8-flash-high-cursor',
      modelCatalogJsonPath: '/tmp/codex-home/model-catalogs/mixin-models.json',
    })
    expect(parsed?.httpHeaders).toEqual({
      'x-codex-mixin-client-key': 'test-mixin-key',
    })
  })

  test('ignores OpenAI and non-loopback custom providers', () => {
    expect(
      parseCodexUserLoopbackProvider(`
model_provider = "openai"
[model_providers.openai]
base_url = "http://127.0.0.1:8788/v1"
`),
    ).toBeNull()

    expect(
      parseCodexUserLoopbackProvider(`
model_provider = "codex-mixin"
[model_providers.codex-mixin]
base_url = "https://api.example.com/v1"
`),
    ).toBeNull()
  })
})

describe('buildCodexNativeUserLoopbackProviderConfigOverrides', () => {
  test('emits bounded -c overrides for a loopback provider', () => {
    expect(
      buildCodexNativeUserLoopbackProviderConfigOverrides({
        configToml: MIXIN_CONFIG,
        env: { CODEX_HOME: '/tmp/codex-home' },
      }),
    ).toEqual([
      'model_provider="codex-mixin"',
      'model_providers.codex-mixin.base_url="http://127.0.0.1:8788/v1"',
      'model_providers.codex-mixin.name="Codex Mixin"',
      'model_providers.codex-mixin.wire_api="responses"',
      'model_providers.codex-mixin.requires_openai_auth=true',
      'model_providers.codex-mixin.supports_websockets=true',
      'model_providers.codex-mixin.stream_idle_timeout_ms=900000',
      'model_providers.codex-mixin.request_max_retries=2',
      'model_catalog_json="/tmp/codex-home/model-catalogs/mixin-models.json"',
      'model_providers.codex-mixin.http_headers={ "x-codex-mixin-client-key" = "test-mixin-key" }',
    ])
  })

  test('returns no overrides when config is missing or not loopback', () => {
    expect(
      buildCodexNativeUserLoopbackProviderConfigOverrides({ configToml: null }),
    ).toEqual([])
    expect(
      buildCodexNativeUserLoopbackProviderConfigOverrides({
        configToml: 'model_provider = "openai"\n',
      }),
    ).toEqual([])
  })
})
