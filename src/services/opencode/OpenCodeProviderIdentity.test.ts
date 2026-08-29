import { describe, expect, test } from 'bun:test'

import {
  canonicalizeOpenCodeProviderId,
  isLiteralLoopbackOpenCodeUrl,
} from './OpenCodeProviderIdentity.js'

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

describe('isLiteralLoopbackOpenCodeUrl', () => {
  test.each([
    'http://localhost:11434/v1',
    'http://LOCALHOST/v1',
    'http://0.0.0.0:8080/v1',
    'http://127.0.0.1:8080/v1',
    'http://127.1.2.3/v1',
    'http://127.255.255.255/v1',
    'http://[::1]:8080/v1',
  ])('accepts literal loopback URL %s', value => {
    expect(isLiteralLoopbackOpenCodeUrl(value)).toBe(true)
  })

  test.each([
    'http://127.attacker.example/v1',
    'http://127.0.0.1.attacker.example/v1',
    'http://localhost.attacker.example/v1',
    'http://attacker.localhost/v1',
    'http://attacker.example@127.0.0.1/v1',
    'http://127.0.0.1@attacker.example/v1',
    'http://192.168.1.10/v1',
    'http://2130706433/v1',
    'http://127.1/v1',
    'http://127.00.0.1/v1',
    'http://127.0.0.999/v1',
    'http://127.0.0.1:invalid/v1',
    'http://127.0.0.1:99999/v1',
    'not a URL',
  ])('rejects nonliteral or malformed URL %s', value => {
    expect(isLiteralLoopbackOpenCodeUrl(value)).toBe(false)
  })
})
