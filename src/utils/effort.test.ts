import { describe, expect, test } from 'bun:test'

import { modelSupportsEffort, modelSupportsMaxEffort } from './effort.js'

describe('model effort support', () => {
  test('allows documented Anthropic effort models and max-only subset', () => {
    expect(modelSupportsEffort('claude-opus-4-7')).toBe(true)
    expect(modelSupportsEffort('claude-opus-4-6')).toBe(true)
    expect(modelSupportsEffort('claude-opus-4-5')).toBe(true)
    expect(modelSupportsEffort('claude-sonnet-4-6')).toBe(true)

    expect(modelSupportsMaxEffort('claude-opus-4-7')).toBe(true)
    expect(modelSupportsMaxEffort('claude-opus-4-6')).toBe(true)
    expect(modelSupportsMaxEffort('claude-sonnet-4-6')).toBe(true)
    expect(modelSupportsMaxEffort('claude-opus-4-5')).toBe(false)
  })

  test('allows standard effort levels for Haiku 4.5 without enabling max effort', () => {
    expect(modelSupportsEffort('claude-haiku-4-5')).toBe(true)
    expect(modelSupportsEffort('claude-haiku-4-5-20251001')).toBe(true)
    expect(modelSupportsEffort('claude-3-5-haiku-20241022')).toBe(false)
    expect(modelSupportsMaxEffort('claude-haiku-4-5')).toBe(false)
  })
})
