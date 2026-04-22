import { afterEach, describe, expect, it } from 'bun:test'
import { getAgentModel } from './agent.js'

const ORIGINAL_ENV = {
  CLAUDE_CODE_ENTRY_PROVIDER: process.env.CLAUDE_CODE_ENTRY_PROVIDER,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
}

afterEach(() => {
  process.env.CLAUDE_CODE_ENTRY_PROVIDER = ORIGINAL_ENV.CLAUDE_CODE_ENTRY_PROVIDER
  process.env.CLAUDE_CODE_USE_BEDROCK = ORIGINAL_ENV.CLAUDE_CODE_USE_BEDROCK
})

describe('getAgentModel', () => {
  it('does not crash when the parent model is missing in codex-hosted sessions', () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'

    expect(getAgentModel(undefined, null, undefined, 'default')).toBe('gpt-5.4')
    expect(getAgentModel('inherit', null, undefined, 'default')).toBe('gpt-5.4')
  })

  it('does not crash when the parent model is missing for alias-based agent configs', () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'

    expect(getAgentModel('sonnet', null, undefined, 'default')).toBe('gpt-5.2-codex')
  })
})
