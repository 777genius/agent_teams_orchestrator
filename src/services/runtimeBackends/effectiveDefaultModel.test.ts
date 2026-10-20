import { describe, expect, test } from 'bun:test'

import {
  getFlagSettingsInline,
  setFlagSettingsInline,
} from '../../bootstrap/state.js'
import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from '../../utils/anthropicConnectionMode.js'
import { applySafeConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import { getMainLoopModel } from '../../utils/model/model.js'
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
  const previous = { ...process.env }
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
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(previous, key)) delete process.env[key]
    }
    Object.assign(process.env, previous)
  }
}

describe('effective inherited Anthropic model', () => {
  test('restores settings-applied env outside the model-key list', () => {
    const original = process.env.ANTHROPIC_BASE_URL
    try {
      delete process.env.ANTHROPIC_BASE_URL
      isolated(() => {
        setFlagSettingsInline({
          env: { ANTHROPIC_BASE_URL: 'http://fixture-env-restore.invalid' },
        })
        resetSettingsCache()
        applySafeConfigEnvironmentVariables()
        expect(process.env.ANTHROPIC_BASE_URL).toBe(
          'http://fixture-env-restore.invalid',
        )
      })
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = original
    }
  })

  test.each(['env', 'settings'] as const)(
    'whitespace-only %s model resolves like the actual runtime launch',
    (source) =>
      isolated(() => {
        if (source === 'env') process.env.ANTHROPIC_MODEL = ' \t '
        else setFlagSettingsInline({ model: ' \t ' })
        resetSettingsCache()
        const catalog = { defaultLaunchModel: 'catalog-recommendation' }
        const launchModel = getMainLoopModel()
        expect(launchModel).not.toBe(catalog.defaultLaunchModel)
        expect(getAnthropicDefaultLaunchModel(catalog)).toBe(launchModel)
        expect(getAnthropicEffectiveDefaultModel(catalog)).toBe(launchModel)
      }),
  )

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
