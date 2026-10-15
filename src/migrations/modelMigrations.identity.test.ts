import { afterEach, describe, expect, it } from 'bun:test'
import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from '../bootstrap/state.js'
import { migrateFennecToOpus } from './migrateFennecToOpus.js'
import { migrateLegacyOpusToCurrent } from './migrateLegacyOpusToCurrent.js'
import { migrateOpusToOpus1m } from './migrateOpusToOpus1m.js'
import { migrateSonnet1mToSonnet45 } from './migrateSonnet1mToSonnet45.js'
import { migrateSonnet45ToSonnet46 } from './migrateSonnet45ToSonnet46.js'

afterEach(() => {
  setMainLoopModelOverride(undefined)
})

describe('model migrations preserve explicit selection identity', () => {
  it.each([
    'claude-opus-5',
    'claude-opus-5-5[1m]',
    'claude-sonnet-4-5-20250929',
    'opus',
    'opus[1m]',
    'sonnet[1m]',
  ])('does not rewrite %s', model => {
    setMainLoopModelOverride(model)

    migrateFennecToOpus()
    migrateLegacyOpusToCurrent()
    migrateOpusToOpus1m()
    migrateSonnet1mToSonnet45()
    migrateSonnet45ToSonnet46()

    expect(getMainLoopModelOverride()).toBe(model)
  })
})
