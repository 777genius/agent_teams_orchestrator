import { describe, expect, it } from 'bun:test'

import {
  getAnthropicApiKeyWithSource,
  isHostManagedAnthropicProviderSelection,
} from './auth.js'

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CI',
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SIMPLE',
  'COO_RUNNING_ON_HOMESPACE',
  'NODE_ENV',
  'USER_TYPE',
] as const

function withIsolatedEnv(fn: () => void): void {
  const original = new Map<string, string | undefined>(
    ENV_KEYS.map(key => [key, process.env[key]]),
  )

  try {
    for (const key of ENV_KEYS) {
      delete process.env[key]
    }
    fn()
  } finally {
    for (const key of ENV_KEYS) {
      const value = original.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('host-managed Anthropic auth', () => {
  it('treats host-managed Anthropic API key env as the active auth source', () => {
    withIsolatedEnv(() => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-host-managed-auth'
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'

      expect(isHostManagedAnthropicProviderSelection()).toBe(true)
      expect(getAnthropicApiKeyWithSource()).toEqual({
        key: 'sk-ant-host-managed-auth',
        source: 'ANTHROPIC_API_KEY',
      })
    })
  })

  it('does not mark non-Anthropic host-managed providers as Anthropic API key auth', () => {
    withIsolatedEnv(() => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-host-managed-auth'
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'

      expect(isHostManagedAnthropicProviderSelection()).toBe(false)
    })
  })
})
