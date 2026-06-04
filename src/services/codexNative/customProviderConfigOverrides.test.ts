import { describe, expect, test } from 'bun:test'

import { buildCodexNativeCustomProviderConfigOverrides } from './customProviderConfigOverrides.js'

describe('buildCodexNativeCustomProviderConfigOverrides', () => {
  test('reads validated app-managed Codex custom provider overrides', () => {
    expect(
      buildCodexNativeCustomProviderConfigOverrides({
        settingsInline: {
          codex: {
            forced_login_method: 'api',
            agent_teams_custom_provider: {
              config_overrides: [
                'model_provider="agent_teams_custom"',
                'model_providers.agent_teams_custom.name="Agent Teams Custom"',
                'model_providers.agent_teams_custom.base_url="https://gateway.example.com/v1"',
                'model_providers.agent_teams_custom.wire_api="responses"',
                'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
              ],
            },
          },
        },
      }),
    ).toEqual([
      'model_provider="agent_teams_custom"',
      'model_providers.agent_teams_custom.name="Agent Teams Custom"',
      'model_providers.agent_teams_custom.base_url="https://gateway.example.com/v1"',
      'model_providers.agent_teams_custom.wire_api="responses"',
      'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
    ])
  })

  test('allows localhost http endpoints without weakening the override whitelist', () => {
    expect(
      buildCodexNativeCustomProviderConfigOverrides({
        settingsInline: {
          codex: {
            forced_login_method: 'api',
            agent_teams_custom_provider: {
              config_overrides: [
                'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
                'model_provider="agent_teams_custom"',
                'model_providers.agent_teams_custom.wire_api="responses"',
                'model_providers.agent_teams_custom.base_url="http://127.0.0.1:8080/v1"',
                'model_providers.agent_teams_custom.name="Agent Teams Custom"',
              ],
            },
          },
        },
      }),
    ).toEqual([
      'model_provider="agent_teams_custom"',
      'model_providers.agent_teams_custom.name="Agent Teams Custom"',
      'model_providers.agent_teams_custom.base_url="http://127.0.0.1:8080/v1"',
      'model_providers.agent_teams_custom.wire_api="responses"',
      'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
    ])
  })

  test('drops malformed, partial, and non-whitelisted custom provider overrides', () => {
    expect(
      buildCodexNativeCustomProviderConfigOverrides({
        settingsInline: {
          codex: {
            forced_login_method: 'api',
            agent_teams_custom_provider: {
              config_overrides: [
                'model_provider="agent_teams_custom"',
                'model_providers.agent_teams_custom.name="Agent Teams Custom"',
                'model_providers.agent_teams_custom.base_url="https://user:token@gateway.example.com/v1"',
                'model_providers.agent_teams_custom.base_url="https://gateway.example.com/v1?token=secret"',
                'model_providers.agent_teams_custom.wire_api="responses"',
                'model_providers.agent_teams_custom.env_key="OPENAI_API_KEY"',
                'forced_login_method="api"',
                'model_provider="openai"',
                'model_providers.agent_teams_custom.base_url="https://gateway.example.com/v1"\nforced_login_method="api"',
                42,
                null,
              ],
            },
          },
        },
      }),
    ).toEqual([])
  })

  test('dedupes duplicate valid overrides and returns canonical order', () => {
    expect(
      buildCodexNativeCustomProviderConfigOverrides({
        settingsInline: {
          codex: {
            forced_login_method: 'api',
            agent_teams_custom_provider: {
              config_overrides: [
                'model_providers.agent_teams_custom.base_url="https://gateway.example.com/v1"',
                'model_provider="agent_teams_custom"',
                'model_provider="agent_teams_custom"',
                'model_providers.agent_teams_custom.name="Agent Teams Custom"',
                'model_providers.agent_teams_custom.name="Agent Teams Custom"',
                'model_providers.agent_teams_custom.wire_api="responses"',
                'model_providers.agent_teams_custom.wire_api="responses"',
                'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
                'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
              ],
            },
          },
        },
      }),
    ).toEqual([
      'model_provider="agent_teams_custom"',
      'model_providers.agent_teams_custom.name="Agent Teams Custom"',
      'model_providers.agent_teams_custom.base_url="https://gateway.example.com/v1"',
      'model_providers.agent_teams_custom.wire_api="responses"',
      'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
    ])
  })

  test('returns no overrides when settings are absent or not an object', () => {
    expect(
      buildCodexNativeCustomProviderConfigOverrides({ settingsInline: null }),
    ).toEqual([])
    expect(
      buildCodexNativeCustomProviderConfigOverrides({
        settingsInline: { codex: { agent_teams_custom_provider: [] } },
      }),
    ).toEqual([])
  })

  test('ignores valid custom provider overrides outside Codex API-key mode', () => {
    expect(
      buildCodexNativeCustomProviderConfigOverrides({
        settingsInline: {
          codex: {
            forced_login_method: 'chatgpt',
            agent_teams_custom_provider: {
              config_overrides: [
                'model_provider="agent_teams_custom"',
                'model_providers.agent_teams_custom.name="Agent Teams Custom"',
                'model_providers.agent_teams_custom.base_url="https://gateway.example.com/v1"',
                'model_providers.agent_teams_custom.wire_api="responses"',
                'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
              ],
            },
          },
        },
      }),
    ).toEqual([])
  })
})
