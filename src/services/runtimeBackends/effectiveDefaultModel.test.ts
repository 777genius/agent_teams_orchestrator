import { describe, expect, test } from 'bun:test'

import {
  getFlagSettingsInline,
  setFlagSettingsInline,
} from '../../bootstrap/state.js'
import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from '../../utils/anthropicConnectionMode.js'
import { applySafeConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  getAnthropicDefaultLaunchModel,
  getAnthropicEffectiveDefaultModel,
} from './effectiveDefaultModel.js'

const envKeys = [
  AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
] as const

function isolated(operation: () => void) {
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]))
  const flags = getFlagSettingsInline()
  try {
    for (const key of envKeys) delete process.env[key]
    setFlagSettingsInline(null)
    resetSettingsCache()
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    operation()
  } finally {
    setFlagSettingsInline(flags)
    resetSettingsCache()
    for (const key of envKeys) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('effective inherited Anthropic model', () => {
  test('applied env wins over saved model and catalog recommendation', () =>
    isolated(() => {
      process.env.ANTHROPIC_MODEL = 'gateway-selected'
      setFlagSettingsInline({ model: 'saved-model' })
      resetSettingsCache()
      expect(
        getAnthropicDefaultLaunchModel({ defaultLaunchModel: 'first-listed' }),
      ).toBe('gateway-selected')
      expect(
        getAnthropicEffectiveDefaultModel({
          defaultLaunchModel: 'first-listed',
        }),
      ).toBe('gateway-selected')
    }))

  test.each(['auto', 'compatible'] as const)(
    '%s applies settings.env then resolves family mappings',
    (mode) =>
      isolated(() => {
        process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = mode
        process.env.ANTHROPIC_MODEL = 'ambient-model'
        setFlagSettingsInline({
          env: {
            ANTHROPIC_MODEL: 'sonnet',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway-sonnet',
          },
        })
        resetSettingsCache()
        applySafeConfigEnvironmentVariables()
        expect(
          getAnthropicEffectiveDefaultModel({
            defaultLaunchModel: 'first-listed',
          }),
        ).toBe('gateway-sonnet')
        expect(
          getAnthropicDefaultLaunchModel({
            defaultLaunchModel: 'first-listed',
          }),
        ).toBe('gateway-sonnet')
      }),
  )

  test.each(['api_key', 'subscription'] as const)(
    '%s cannot restore proxy model vars from settings',
    (mode) =>
      isolated(() => {
        process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = mode
        setFlagSettingsInline({
          env: {
            ANTHROPIC_MODEL: 'proxy-model',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'proxy-opus',
          },
        })
        resetSettingsCache()
        applySafeConfigEnvironmentVariables()
        expect(getAnthropicEffectiveDefaultModel()).toBeNull()
        expect(
          getAnthropicDefaultLaunchModel({ defaultLaunchModel: 'opus[1m]' }),
        ).toBe('opus[1m]')
        expect(
          getAnthropicEffectiveDefaultModel({ defaultLaunchModel: 'opus[1m]' }),
        ).not.toContain('proxy')
      }),
  )

  test('saved model is honored when no model env applies', () =>
    isolated(() => {
      setFlagSettingsInline({ model: 'saved-model' })
      resetSettingsCache()
      expect(
        getAnthropicEffectiveDefaultModel({
          defaultLaunchModel: 'first-listed',
        }),
      ).toBe('saved-model')
    }))

  test('unknown remains null and catalog alias remains the launch fallback', () =>
    isolated(() => {
      expect(getAnthropicEffectiveDefaultModel()).toBeNull()
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'fixture-opus'
      expect(
        getAnthropicDefaultLaunchModel({ defaultLaunchModel: 'opus[1m]' }),
      ).toBe('opus[1m]')
      expect(
        getAnthropicEffectiveDefaultModel({ defaultLaunchModel: 'opus[1m]' }),
      ).toBe('fixture-opus[1m]')
    }))
})
