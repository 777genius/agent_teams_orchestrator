import { describe, expect, test } from 'bun:test'

import { getBootstrapSpawnDelayMs } from './teamBootstrapSpawnSchedule.js'
import type { NormalizedBootstrapMember } from './teamBootstrapTypes.js'

function member(
  name: string,
  provider?: 'anthropic' | 'codex' | 'gemini',
): NormalizedBootstrapMember {
  return {
    originalName: name,
    displayName: name,
    normalizedName: name,
    prompt: `hello from ${name}`,
    ...(provider ? { provider } : {}),
  }
}

describe('team bootstrap spawn schedule', () => {
  test('does not delay non-gemini teammates', () => {
    const members = [member('alice', 'anthropic'), member('bob', 'codex')]
    expect(getBootstrapSpawnDelayMs(members, 0)).toBe(0)
    expect(getBootstrapSpawnDelayMs(members, 1)).toBe(0)
  })

  test('stagger delays consecutive gemini teammates deterministically', () => {
    const members = [
      member('alice', 'gemini'),
      member('bob', 'gemini'),
      member('tom', 'gemini'),
      member('jack', 'gemini'),
    ]
    expect(getBootstrapSpawnDelayMs(members, 0)).toBe(0)
    expect(getBootstrapSpawnDelayMs(members, 1)).toBe(1500)
    expect(getBootstrapSpawnDelayMs(members, 2)).toBe(3000)
    expect(getBootstrapSpawnDelayMs(members, 3)).toBe(4500)
  })

  test('counts only previous teammates from the same provider bucket', () => {
    const members = [
      member('alice', 'gemini'),
      member('bob', 'anthropic'),
      member('tom', 'gemini'),
      member('jack', 'codex'),
      member('zoe', 'gemini'),
    ]
    expect(getBootstrapSpawnDelayMs(members, 0)).toBe(0)
    expect(getBootstrapSpawnDelayMs(members, 2)).toBe(1500)
    expect(getBootstrapSpawnDelayMs(members, 4)).toBe(3000)
  })
})
