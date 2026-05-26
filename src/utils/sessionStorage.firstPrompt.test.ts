import { describe, expect, test } from 'bun:test'

import type { Message } from '../types/message.js'
import { getFirstMeaningfulUserMessageTextContent } from './sessionStorage.js'

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

describe('getFirstMeaningfulUserMessageTextContent', () => {
  test('skips synthetic user replay text before authored text', () => {
    expect(
      getFirstMeaningfulUserMessageTextContent([
        userMessage('Human: I tested the feature looks good', {
          isReplay: true,
          isSynthetic: true,
        } as Partial<Message>),
        userMessage('real user request'),
      ]),
    ).toBe('real user request')
  })

  test('keeps ordinary human replay text', () => {
    expect(
      getFirstMeaningfulUserMessageTextContent([
        userMessage('Human: I tested the feature looks good', {
          isReplay: true,
        } as Partial<Message>),
      ]),
    ).toBe('Human: I tested the feature looks good')
  })

  test('skips structured protocol rows before authored text', () => {
    expect(
      getFirstMeaningfulUserMessageTextContent([
        userMessage('plain protocol payload', {
          protocolKind: 'teammate-message',
        } as Partial<Message>),
        userMessage('real user request'),
      ]),
    ).toBe('real user request')
  })
})
