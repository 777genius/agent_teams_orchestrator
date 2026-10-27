import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  getFlagSettingsInline,
  isSessionPersistenceDisabled,
  setFlagSettingsInline,
  setSessionPersistenceDisabled,
} from '../bootstrap/state.js'
import { isSessionStoragePersistenceEnabled } from './sessionStorage.js'
import { resetSettingsCache } from './settings/settingsCache.js'

const envKeys = ['NODE_ENV', 'TEST_ENABLE_SESSION_PERSISTENCE', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY'] as const
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
const originalSettings = getFlagSettingsInline()
const originalDisabled = isSessionPersistenceDisabled()

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  setSessionPersistenceDisabled(false)
  setFlagSettingsInline({ cleanupPeriodDays: 30 })
  resetSettingsCache()
})

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setSessionPersistenceDisabled(originalDisabled)
  setFlagSettingsInline(originalSettings)
  resetSettingsCache()
})

describe('effective host session persistence policy', () => {
  test('test sessions need explicit persistence opt-in', () => {
    expect(isSessionStoragePersistenceEnabled()).toBe(false)
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    expect(isSessionStoragePersistenceEnabled()).toBe(true)
  })

  test('ordinary sessions persist unless an existing opt-out applies', () => {
    process.env.NODE_ENV = 'development'
    expect(isSessionStoragePersistenceEnabled()).toBe(true)
    setSessionPersistenceDisabled(true)
    expect(isSessionStoragePersistenceEnabled()).toBe(false)
  })

  test('test opt-in cannot override no-session-persistence', () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    setSessionPersistenceDisabled(true)
    expect(isSessionStoragePersistenceEnabled()).toBe(false)
  })

  test('skip-history launch policy also disables native history ownership', () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = 'true'
    expect(isSessionStoragePersistenceEnabled()).toBe(false)
  })

  test('zero-day transcript retention keeps all history persistence disabled', () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    setFlagSettingsInline({ cleanupPeriodDays: 0 })
    resetSettingsCache()
    expect(isSessionStoragePersistenceEnabled()).toBe(false)
  })
})
