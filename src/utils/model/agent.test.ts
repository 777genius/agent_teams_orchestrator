import { afterEach, describe, expect, it } from 'bun:test'
import { getAgentModel } from './agent.js'
import { getDefaultOpusModel, getDefaultSonnetModel } from './model.js'

const ORIGINAL_ENV = {
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  CLAUDE_CODE_DISABLE_1M_CONTEXT: process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT,
  CLAUDE_CODE_ENTRY_PROVIDER: process.env.CLAUDE_CODE_ENTRY_PROVIDER,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
}

afterEach(() => {
  process.env.ANTHROPIC_MODEL = ORIGINAL_ENV.ANTHROPIC_MODEL
  process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT =
    ORIGINAL_ENV.CLAUDE_CODE_DISABLE_1M_CONTEXT
  process.env.CLAUDE_CODE_ENTRY_PROVIDER = ORIGINAL_ENV.CLAUDE_CODE_ENTRY_PROVIDER
  process.env.CLAUDE_CODE_USE_BEDROCK = ORIGINAL_ENV.CLAUDE_CODE_USE_BEDROCK
})

describe('getAgentModel', () => {
  it('does not crash when the parent model is missing in codex-hosted sessions', () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'

    expect(getAgentModel(undefined, null, undefined, 'default')).toBe('gpt-5.6-sol')
    expect(getAgentModel('inherit', null, undefined, 'default')).toBe('gpt-5.6-sol')
  })

  it('does not crash when the parent model is missing for alias-based agent configs', () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'

    expect(getAgentModel('sonnet', null, undefined, 'default')).toBe('gpt-5.2-codex')
  })

  it('preserves member inherit exactly across plan and context-cap transitions', () => {
    const parentModel = 'claude-opus-5-5[1m]'

    expect(
      getAgentModel('inherit', parentModel, undefined, 'plan'),
    ).toBe(parentModel)
    expect(
      getAgentModel('inherit', parentModel, undefined, 'default'),
    ).toBe(parentModel)
  })

  it('binds inherited plan policy to the parent rather than ambient selection', () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
    for (const ambientModel of ['haiku', 'opusplan']) {
      process.env.ANTHROPIC_MODEL = ambientModel
      for (const cap of ['0', '1']) {
        process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = cap
        for (const parentModel of ['claude-opus-5', 'claude-opus-5-5[1m]']) {
          expect(getAgentModel('inherit', parentModel, undefined, 'plan')).toBe(
            parentModel,
          )
        }
      }
    }
  })

  it('preserves conditional policy when the parent itself is an alias', () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
    expect(getAgentModel('inherit', 'opusplan', undefined, 'plan')).toBe(
      getDefaultOpusModel(),
    )
    expect(getAgentModel('inherit', 'haiku', undefined, 'plan')).toBe(
      getDefaultSonnetModel(),
    )
  })

  it('preserves explicit custom member IDs without applying a parent region prefix', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'

    expect(
      getAgentModel(
        'custom-provider/model',
        'eu.anthropic.claude-opus-5-5-v1:0',
        undefined,
        'default',
      ),
    ).toBe('custom-provider/model')
  })

  it('keeps explicit Opus 5 and future IDs unchanged for members', () => {
    for (const model of [
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-opus-6-future',
    ]) {
      expect(getAgentModel(model, 'claude-sonnet-5', undefined, 'plan')).toBe(
        model,
      )
    }
  })
})
