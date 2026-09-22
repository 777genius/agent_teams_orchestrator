import { describe, expect, test } from 'bun:test'

import type { Message } from '../types/message.js'
import { extractTitleText } from './bridgeMessaging.js'

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    type: 'user',
    isMeta: false,
    message: {
      role: 'user',
      content: 'Human: I tested the feature looks good',
    },
    ...overrides,
  } as Message
}

describe('extractTitleText', () => {
  test('keeps ordinary human text even when it starts with Human', () => {
    expect(extractTitleText(userMessage())).toBe(
      'Human: I tested the feature looks good',
    )
  })

  test('rejects meta synthetic replay text from session titles', () => {
    expect(
      extractTitleText(
        userMessage({
          isMeta: true,
        }),
      ),
    ).toBeUndefined()
  })

  test('rejects synthetic replay text even when a caller forgot isMeta', () => {
    expect(
      extractTitleText(
        userMessage({
          isSynthetic: true,
        } as Partial<Message>),
      ),
    ).toBeUndefined()
  })

  test('rejects non-human origin user messages from session titles', () => {
    expect(
      extractTitleText(
        userMessage({
          origin: { kind: 'task-notification' },
        } as Partial<Message>),
      ),
    ).toBeUndefined()
  })

  test('rejects structured teammate protocol messages from session titles', () => {
    expect(
      extractTitleText(
        userMessage({
          protocolKind: 'teammate-message',
        } as Partial<Message>),
      ),
    ).toBeUndefined()
  })
})
