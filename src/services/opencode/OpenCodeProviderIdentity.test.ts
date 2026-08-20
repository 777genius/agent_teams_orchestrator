import { describe, expect, test } from 'bun:test'

import {
  OPEN_CODE_PROVIDER_ALIAS_ENTRIES,
  canonicalizeOpenCodeProviderId,
  createOpenCodeCanonicalModelId,
  createOpenCodeCanonicalProviderId,
  createOpenCodeExactProviderModelRef,
  parseOpenCodeExactProviderModelRef,
  tryCreateOpenCodeCanonicalProviderId,
} from './OpenCodeProviderIdentity.js'

describe('canonicalizeOpenCodeProviderId', () => {
  test.each([
    ...OPEN_CODE_PROVIDER_ALIAS_ENTRIES,
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

describe('branded OpenCode provider identity boundary', () => {
  test('converges aliases once and creates an exact provider/model reference', () => {
    const providerId = createOpenCodeCanonicalProviderId('Amazon Q Developer / Kiro')
    const modelId = createOpenCodeCanonicalModelId('anthropic/claude-sonnet-4')
    const ref = createOpenCodeExactProviderModelRef(providerId, modelId)

    expect(providerId).toBe('kiro')
    expect(ref).toEqual({
      providerId: 'kiro',
      modelId: 'anthropic/claude-sonnet-4',
      raw: 'kiro/anthropic/claude-sonnet-4',
    })
    expect(Object.isFrozen(ref)).toBe(true)
  })

  test.each([
    '', ' ', ' provider', 'provider ', '../provider', 'provider/../other',
    '.', '..', '/provider', 'provider/', 'provider//other', 'provider?token=x',
    'provider#fragment', 'provider\u0000evil', 'provider\nevil', 'a/b', '-leading',
    'trailing-', 'a'.repeat(129),
  ])('rejects malformed or ambiguous provider id %j', value => {
    expect(tryCreateOpenCodeCanonicalProviderId(value)).toBeNull()
    expect(() => createOpenCodeCanonicalProviderId(value)).toThrow()
  })

  test.each([
    '', ' ', '../model', 'model/../other', './model', 'model//variant',
    '/model', 'model/', 'model?key=secret', 'model#fragment', 'model\u0000evil',
    'model name', 'user:pass@host', 'user:pass@host/model', 'user:pass@host:443/model',
    'api.example.invalid:443', 'api.example.invalid:443/model', 'localhost:4096',
    'internal:443/model', '123:443/model', '127.0.0.1:443/model',
    'org/user:pass@host/model', 'org/api.example.invalid:443/model',
    'api.example.invalid:000443/model', 'api.example.invalid.:443/model',
    'user:pa@ss@host', 'org/user:pa@ss@host/model',
    ':secret@example.invalid', 'org/:secret@example.invalid/model',
    'user@host', 'org/user@host/model', 'user@localhost',
    'user@api.example.invalid', 'user@api.example.invalid.',
    'user@127.0.0.1', 'user@[2001:db8::1]', 'user@host:443',
    'api.example.invalid:999999/model', '[2001:db8::1]:443/model',
    'https://api.example.invalid/model', '//api.example.invalid/model',
  ])('rejects malformed model id %j', value => {
    expect(() => createOpenCodeCanonicalModelId(value)).toThrow()
  })

  test('parses only an exact canonical scoped ref with no alias, default, or raw-id fallback', () => {
    expect(parseOpenCodeExactProviderModelRef('kiro/anthropic/claude')).toEqual({
      providerId: 'kiro',
      modelId: 'anthropic/claude',
      raw: 'kiro/anthropic/claude',
    })
    expect(parseOpenCodeExactProviderModelRef('claude')).toBeNull()
    expect(parseOpenCodeExactProviderModelRef('/claude')).toBeNull()
    expect(parseOpenCodeExactProviderModelRef('kiro/')).toBeNull()
    expect(parseOpenCodeExactProviderModelRef('Kiro/claude')).toBeNull()
    expect(parseOpenCodeExactProviderModelRef('Amazon Q Developer / Kiro/claude')).toBeNull()
    expect(parseOpenCodeExactProviderModelRef('other/kiro/claude')).toEqual({
      providerId: 'other',
      modelId: 'kiro/claude',
      raw: 'other/kiro/claude',
    })
  })

  test('normalizes only explicit aliases and rejects whitespace/confusable lookalikes', () => {
    for (const value of [
      'GitHub  Copilot', 'github copilot', 'GITHUB-COPILOT',
      'GitHub\u00a0Copilot', 'gіthub-copilot',
    ]) expect(tryCreateOpenCodeCanonicalProviderId(value)).toBeNull()
    expect(createOpenCodeCanonicalProviderId('github-copilot')).toBe('github-copilot')
  })

  test('preserves legal case, colons, and multiple model path segments', () => {
    expect(parseOpenCodeExactProviderModelRef('xai/org/Team:Model-v2')).toEqual({
      providerId: 'xai', modelId: 'org/Team:Model-v2', raw: 'xai/org/Team:Model-v2',
    })
    expect(parseOpenCodeExactProviderModelRef('xai/org/Team:Model-v2/')).toBeNull()
    expect(createOpenCodeCanonicalModelId('vendor/release:stable/Model-v2')).toBe(
      'vendor/release:stable/Model-v2',
    )
    expect(createOpenCodeCanonicalModelId('qwen-test:0.5b')).toBe('qwen-test:0.5b')
    expect(createOpenCodeCanonicalModelId('vendor/model@revision')).toBe('vendor/model@revision')
  })

  test('rejects endpoint and userinfo shaped exact refs without provider fallback', () => {
    for (const value of [
      'xai/user:pass@host', 'xai/user:pass@host/model', 'xai/user:pass@host:443/model',
      'xai/api.example.invalid:443', 'xai/api.example.invalid:443/model',
      'xai/localhost:4096/trailing', 'xai/internal:443/model', 'xai/123:443/model',
      'xai/127.0.0.1:443/model', 'xai/org/user:pass@host/model',
      'xai/org/api.example.invalid:443/model',
      'xai/api.example.invalid:000443/model', 'xai/api.example.invalid.:443/model',
      'xai/user:pa@ss@host/model', 'xai/api.example.invalid:999999/model',
      'xai/:secret@example.invalid/model', 'xai/user@host/model',
      'xai/user@api.example.invalid/model', 'xai/user@api.example.invalid./model',
      'xai/user@127.0.0.1/model', 'xai/user@[2001:db8::1]/model',
      'xai/user@host:443/model',
    ]) expect(parseOpenCodeExactProviderModelRef(value)).toBeNull()
  })
})
