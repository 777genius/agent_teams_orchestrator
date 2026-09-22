import { describe, expect, it } from 'bun:test'

import { shouldUseCodexProviderRouting } from './auth.js'

describe('shouldUseCodexProviderRouting', () => {
  it('keeps explicit host-managed anthropic sessions on first-party routing', () => {
    expect(
      shouldUseCodexProviderRouting({
        apiProvider: 'firstParty',
        hasCodexCapability: true,
        hasExplicitHostManagedProviderSelection: true,
      }),
    ).toBe(false)
  })

  it('allows codex fallback for unmanaged first-party sessions with codex capability', () => {
    expect(
      shouldUseCodexProviderRouting({
        apiProvider: 'firstParty',
        hasCodexCapability: true,
        hasExplicitHostManagedProviderSelection: false,
      }),
    ).toBe(true)
  })

  it('keeps explicit openai sessions on codex routing', () => {
    expect(
      shouldUseCodexProviderRouting({
        apiProvider: 'openai',
        hasCodexCapability: true,
        hasExplicitHostManagedProviderSelection: true,
      }),
    ).toBe(true)
  })

  it('never routes third-party providers through codex fallback', () => {
    expect(
      shouldUseCodexProviderRouting({
        apiProvider: 'gemini',
        hasCodexCapability: true,
        hasExplicitHostManagedProviderSelection: false,
      }),
    ).toBe(false)
  })
})
