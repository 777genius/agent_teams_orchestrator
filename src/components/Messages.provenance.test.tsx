import { describe, expect, test } from 'bun:test'

import { dropTextInBriefTurns, filterForBriefTool } from './Messages.js'

describe('Messages provenance filters', () => {
  test('brief-only mode excludes synthetic user replay text without relying on isMeta', () => {
    const messages = [
      {
        type: 'user',
        isSynthetic: true,
        message: {
          content: [{ type: 'text', text: 'Human: I tested the feature looks good' }],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'text', text: 'Build the real feature' }],
        },
      },
    ]

    expect(filterForBriefTool(messages, ['Brief'])).toEqual([messages[1]])
  })

  test('brief text dropping does not let structured protocol rows create turns', () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'redundant text' }],
        },
      },
      {
        type: 'user',
        protocolKind: 'teammate-message',
        message: {
          content: [{ type: 'text', text: 'plain protocol payload' }],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Brief' }],
        },
      },
    ]

    expect(dropTextInBriefTurns(messages, ['Brief'])).toEqual([
      messages[1],
      messages[2],
    ])
  })
})
