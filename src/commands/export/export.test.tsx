import { describe, expect, test } from 'bun:test'

import type { Message } from '../../types/message.js'
import { extractFirstPrompt } from './export.js'

function userMessage(
  content: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    type: 'user',
    isMeta: false,
    message: {
      role: 'user',
      content,
    },
    ...overrides,
  } as Message
}

describe('extractFirstPrompt', () => {
  test('skips synthetic replay text when naming exports', () => {
    expect(
      extractFirstPrompt([
        userMessage('Human: I tested the feature looks good', {
          isReplay: true,
          isSynthetic: true,
        } as Partial<Message>),
        userMessage('real export prompt'),
      ]),
    ).toBe('real export prompt')
  })

  test('keeps ordinary human replay text', () => {
    expect(
      extractFirstPrompt([
        userMessage('Human: I tested the feature looks good', {
          isReplay: true,
        } as Partial<Message>),
      ]),
    ).toBe('Human: I tested the feature looks good')
  })

  test('skips structured protocol rows when naming exports', () => {
    expect(
      extractFirstPrompt([
        userMessage('plain protocol payload', {
          protocolKind: 'teammate-message',
        } as Partial<Message>),
        userMessage('real export prompt'),
      ]),
    ).toBe('real export prompt')
  })
})
