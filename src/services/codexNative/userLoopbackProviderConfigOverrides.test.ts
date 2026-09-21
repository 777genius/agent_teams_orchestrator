import { describe, expect, test } from 'bun:test'

import {
  buildCodexNativeUserLoopbackProviderConfigOverrides,
  parseCodexUserLoopbackProvider,
  resolveCodexNativeUserLoopbackLaunchConfig,
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
experimental_bearer_token = "secret-mixin-token"
`

const QUOTED_MIXIN_CONFIG = `
model_provider = "codex-mixin"
stream_idle_timeout_ms = 1

[model_providers."codex-mixin"]
name = "Quoted Mixin"
base_url = "http://127.0.0.1:8788/v1"
stream_idle_timeout_ms = 900_000
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
      experimentalBearerToken: 'secret-mixin-token',
    })
    expect(parsed?.httpHeaders).toEqual({
      'x-codex-mixin-client-key': 'test-mixin-key',
    })
  })

  test('parses quoted section headers and underscore numbers', () => {
    const parsed = parseCodexUserLoopbackProvider(QUOTED_MIXIN_CONFIG)
    expect(parsed).toMatchObject({
      providerId: 'codex-mixin',
      name: 'Quoted Mixin',
      baseUrl: 'http://127.0.0.1:8788/v1',
      streamIdleTimeoutMs: 900000,
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
  test('emits bounded -c overrides without secrets and keeps secrets in env/overlay', () => {
    const launch = resolveCodexNativeUserLoopbackLaunchConfig({
      configToml: MIXIN_CONFIG,
      env: { CODEX_HOME: '/tmp/codex-home' },
    })
    expect(launch.configOverrides).toEqual([
      'model_provider="codex-mixin"',
      'model_providers.codex-mixin.base_url="http://127.0.0.1:8788/v1"',
      'model="gemini-3.8-flash-high-cursor"',
      'model_providers.codex-mixin.name="Codex Mixin"',
      'model_providers.codex-mixin.wire_api="responses"',
      'model_providers.codex-mixin.requires_openai_auth=true',
      'model_providers.codex-mixin.supports_websockets=true',
      'model_providers.codex-mixin.stream_idle_timeout_ms=900000',
      'model_providers.codex-mixin.request_max_retries=2',
      'model_providers.codex-mixin.env_key="AGENT_TEAMS_CODEX_LOOPBACK_TOKEN"',
      'model_catalog_json="/tmp/codex-home/model-catalogs/mixin-models.json"',
    ])
    expect(launch.configOverrides.join('\n')).not.toContain('secret-mixin-token')
    expect(launch.configOverrides.join('\n')).not.toContain('test-mixin-key')
    expect(launch.secretEnv).toEqual({
      AGENT_TEAMS_CODEX_LOOPBACK_TOKEN: 'secret-mixin-token',
    })
    expect(launch.overlayToml).toContain('secret-mixin-token')
    expect(launch.overlayToml).toContain('test-mixin-key')
    expect(
      buildCodexNativeUserLoopbackProviderConfigOverrides({
        configToml: MIXIN_CONFIG,
        env: { CODEX_HOME: '/tmp/codex-home' },
      }),
    ).toEqual(launch.configOverrides)
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
