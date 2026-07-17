import { describe, expect, test } from 'bun:test'

import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'

describe('canonicalizeOpenCodeProviderId', () => {
  test.each([
    ['MiniMax Token Plan (minimax.io)', 'minimax-coding-plan'],
    ['Xiaomi Token Plan (Europe)', 'xiaomi-token-plan-ams'],
    ['Xiaomi Token Plan (Singapore)', 'xiaomi-token-plan-sgp'],
    ['Xiaomi Token Plan (China)', 'xiaomi-token-plan-cn'],
    ['Xiaomi MiMo Token Plan - Singapore', 'xiaomi-token-plan-sgp'],
    ['Z.AI Coding Plan', 'zai-coding-plan'],
    ['Kimi Code Membership', 'kimi-for-coding'],
    ['Amazon Q Developer / Kiro', 'kiro'],
    ['GitHub Copilot', 'github-copilot'],
  ])('maps %s to %s', (input, expected) => {
    expect(canonicalizeOpenCodeProviderId(input)).toBe(expected)
  })
})
