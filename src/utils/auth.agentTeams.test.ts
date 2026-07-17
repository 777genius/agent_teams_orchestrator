import { describe, expect, it } from 'bun:test'

import {
  getFlagSettingsInline,
  setFlagSettingsInline,
} from '../bootstrap/state.js'
import {
  clearApiKeyHelperCache,
  getAuthTokenSource,
  getAnthropicApiKeyWithSource,
  getApiKeyFromApiKeyHelper,
  getConfiguredApiKeyHelper,
  isAnthropicAuthEnabled,
  isHostManagedAnthropicProviderSelection,
} from './auth.js'
import {
  AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
  APP_MANAGED_ANTHROPIC_AUTH_MODE_ENV,
  APP_MANAGED_ANTHROPIC_SETTINGS_PATH_ENV,
} from './anthropicConnectionMode.js'
import { resetSettingsCache } from './settings/settingsCache.js'

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
  'CI',
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SIMPLE',
  APP_MANAGED_ANTHROPIC_AUTH_MODE_ENV,
  APP_MANAGED_ANTHROPIC_SETTINGS_PATH_ENV,
  'COO_RUNNING_ON_HOMESPACE',
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

async function withIsolatedEnvAsync(fn: () => Promise<void>): Promise<void> {
  const original = new Map<string, string | undefined>(
    ENV_KEYS.map(key => [key, process.env[key]]),
  )

  try {
    for (const key of ENV_KEYS) {
      delete process.env[key]
    }
    await fn()
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

  it('keeps app-managed subscription mode on OAuth despite a user apiKeyHelper', () => {
    const originalFlagSettings = getFlagSettingsInline()
    try {
      setFlagSettingsInline({ apiKeyHelper: "'/tmp/user-api-key-helper.sh'" })
      withIsolatedEnv(() => {
        process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
        process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'host-managed-oauth-token'
        process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] =
          'subscription'

        expect(isAnthropicAuthEnabled()).toBe(true)
      })
    } finally {
      setFlagSettingsInline(originalFlagSettings)
    }
  })

  it('keeps app-managed API key mode ahead of ambient OAuth and apiKeyHelper auth', () => {
    const originalFlagSettings = getFlagSettingsInline()
    try {
      setFlagSettingsInline({ apiKeyHelper: "'/tmp/user-api-key-helper.sh'" })
      withIsolatedEnv(() => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-host-managed-auth'
        process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-bearer-token'
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ambient-oauth-token'
        process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
        process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
        process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'api_key'

        expect(getAuthTokenSource()).toEqual({ source: 'none', hasToken: false })
        expect(getConfiguredApiKeyHelper()).toBeUndefined()
        expect(getAnthropicApiKeyWithSource()).toEqual({
          key: 'sk-ant-host-managed-auth',
          source: 'ANTHROPIC_API_KEY',
        })
      })
    } finally {
      setFlagSettingsInline(originalFlagSettings)
    }
  })

  it('recognizes only the marked app-managed helper in explicit API-key mode', () => {
    const originalFlagSettings = getFlagSettingsInline()
    try {
      setFlagSettingsInline({ apiKeyHelper: "'/tmp/app-api-key-helper.sh'" })
      withIsolatedEnv(() => {
        process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
        process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
        process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'api_key'
        process.env[APP_MANAGED_ANTHROPIC_AUTH_MODE_ENV] = 'api_key_helper'
        process.env[APP_MANAGED_ANTHROPIC_SETTINGS_PATH_ENV] =
          '/tmp/runtime-settings-anthropic.json'

        expect(getConfiguredApiKeyHelper()).toBe(
          "'/tmp/app-api-key-helper.sh'",
        )
        expect(getAuthTokenSource()).toEqual({
          source: 'apiKeyHelper',
          hasToken: true,
        })
        expect(getAnthropicApiKeyWithSource()).toEqual({
          key: null,
          source: 'apiKeyHelper',
        })
      })
    } finally {
      setFlagSettingsInline(originalFlagSettings)
    }
  })

  it('does not execute an ambient helper in explicit host-managed API-key mode', async () => {
    const originalFlagSettings = getFlagSettingsInline()
    try {
      setFlagSettingsInline({
        apiKeyHelper: "printf 'ambient-helper-must-not-run'",
      })
      await withIsolatedEnvAsync(async () => {
        process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
        process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
        process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'api_key'

        expect(getConfiguredApiKeyHelper()).toBeUndefined()
        expect(await getApiKeyFromApiKeyHelper(true)).toBeNull()
      })
    } finally {
      setFlagSettingsInline(originalFlagSettings)
    }
  })

  it('executes the marked app-managed helper in explicit API-key mode', async () => {
    const originalFlagSettings = getFlagSettingsInline()
    try {
      clearApiKeyHelperCache()
      setFlagSettingsInline({
        apiKeyHelper: "printf 'sk-ant-app-managed-helper\\n'",
      })
      resetSettingsCache()
      await withIsolatedEnvAsync(async () => {
        process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
        process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
        process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'api_key'
        process.env[APP_MANAGED_ANTHROPIC_AUTH_MODE_ENV] = 'api_key_helper'
        process.env[APP_MANAGED_ANTHROPIC_SETTINGS_PATH_ENV] =
          '/tmp/runtime-settings-anthropic.json'

        expect(await getApiKeyFromApiKeyHelper(true)).toBe(
          'sk-ant-app-managed-helper',
        )
      })
    } finally {
      clearApiKeyHelperCache()
      setFlagSettingsInline(originalFlagSettings)
      resetSettingsCache()
    }
  })
})
