import { describe, expect, test } from 'bun:test'

import {
  getFlagSettingsInline,
  setFlagSettingsInline,
} from '../bootstrap/state.js'
import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from './anthropicConnectionMode.js'
import {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
} from './managedEnv.js'
import { resetSettingsCache } from './settings/settingsCache.js'
import { applyFinalMemberEnvPatch } from './swarm/spawnUtils.js'

const ENV_KEYS = [
  AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_USE_BEDROCK',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
] as const

function withIsolatedEnv(operation: () => void): void {
  const originalEnv = new Map<string, string | undefined>(
    ENV_KEYS.map(key => [key, process.env[key]]),
  )
  const originalFlagSettings = getFlagSettingsInline()

  try {
    for (const key of ENV_KEYS) delete process.env[key]
    resetSettingsCache()
    operation()
  } finally {
    setFlagSettingsInline(originalFlagSettings)
    resetSettingsCache()
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('host-managed Anthropic settings env', () => {
  test.each([
    ['before trust', applySafeConfigEnvironmentVariables],
    ['after trust', applyConfigEnvironmentVariables],
  ] as const)('preserves final gateway member credentials %s', (_phase, applyEnv) => {
    withIsolatedEnv(() => {
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
      applyFinalMemberEnvPatch(process.env as Record<string, string>, {
        ANTHROPIC_BASE_URL: 'https://member-gateway.example',
        ANTHROPIC_AUTH_TOKEN: 'member-token',
        ANTHROPIC_API_KEY: '',
      })
      setFlagSettingsInline({ env: {
        ANTHROPIC_BASE_URL: 'https://leader-gateway.example',
        ANTHROPIC_AUTH_TOKEN: 'leader-token',
        ANTHROPIC_API_KEY: 'leader-key',
      } })
      applyEnv()
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://member-gateway.example')
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('member-token')
      expect(process.env.ANTHROPIC_API_KEY).toBe('')

      process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'
      applyFinalMemberEnvPatch(process.env as Record<string, string>, { CODEX_API_KEY: 'member-codex-key' })
      setFlagSettingsInline({ env: { CODEX_API_KEY: 'leader-codex-key' } })
      resetSettingsCache()
      applyEnv()
      expect(process.env.CODEX_API_KEY).toBe('member-codex-key')
    })
  })

  test.each([
    ['before trust', applySafeConfigEnvironmentVariables],
    ['after trust', applyConfigEnvironmentVariables],
  ] as const)('compatible mode applies model mappings %s without replacing the host route', (_phase, applyEnv) => {
    withIsolatedEnv(() => {
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
      process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'compatible'
      process.env.ANTHROPIC_BASE_URL = 'https://host-gateway.example/anthropic'
      process.env.ANTHROPIC_AUTH_TOKEN = 'host-token'
      setFlagSettingsInline({
        env: {
          CLAUDE_CODE_USE_BEDROCK: '1',
          ANTHROPIC_BASE_URL: 'https://settings-gateway.example/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'settings-token',
          ANTHROPIC_MODEL: 'gateway-main',
          ANTHROPIC_SMALL_FAST_MODEL: 'gateway-small',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway-sonnet',
          ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: 'thinking',
          CLAUDE_CODE_SUBAGENT_MODEL: 'gateway-subagent',
          ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: 'us-east-1',
        },
      })

      applyEnv()

      expect(process.env.ANTHROPIC_MODEL).toBe('gateway-main')
      expect(process.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('gateway-small')
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gateway-sonnet')
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe('thinking')
      expect(process.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('gateway-subagent')
      expect(process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION).toBeUndefined()
      expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://host-gateway.example/anthropic')
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('host-token')
    })
  })

  test('explicit API-key mode blocks settings from restoring Bedrock routing', () => {
    withIsolatedEnv(() => {
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
      process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'api_key'
      process.env.ANTHROPIC_API_KEY = 'host-direct-key'
      setFlagSettingsInline({
        env: {
          [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'auto',
          CLAUDE_CODE_USE_BEDROCK: '1',
          ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
          ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer gateway-token',
          ANTHROPIC_MODEL: 'bedrock-model-id',
          ANTHROPIC_API_KEY: 'settings-key-that-must-not-win',
        },
      })

      applyConfigEnvironmentVariables()

      expect(process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]).toBe(
        'api_key',
      )
      expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
      expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
      expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
      expect(process.env.ANTHROPIC_API_KEY).toBe('host-direct-key')
    })
  })

  test('Auto mode preserves supported Anthropic backend settings', () => {
    withIsolatedEnv(() => {
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
      process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'auto'
      setFlagSettingsInline({
        env: {
          CLAUDE_CODE_USE_BEDROCK: '1',
          ANTHROPIC_MODEL: 'bedrock-model-id',
        },
      })

      applyConfigEnvironmentVariables()

      expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
      expect(process.env.ANTHROPIC_MODEL).toBe('bedrock-model-id')
    })
  })
})
