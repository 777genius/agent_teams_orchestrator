import { describe, expect, test } from 'bun:test'

import {
  getFlagSettingsInline,
  setFlagSettingsInline,
} from '../bootstrap/state.js'
import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from './anthropicConnectionMode.js'
import { applyConfigEnvironmentVariables } from './managedEnv.js'

const ENV_KEYS = [
  AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_USE_BEDROCK',
] as const

function withIsolatedEnv(operation: () => void): void {
  const originalEnv = new Map<string, string | undefined>(
    ENV_KEYS.map(key => [key, process.env[key]]),
  )
  const originalFlagSettings = getFlagSettingsInline()

  try {
    for (const key of ENV_KEYS) delete process.env[key]
    operation()
  } finally {
    setFlagSettingsInline(originalFlagSettings)
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('host-managed Anthropic settings env', () => {
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
