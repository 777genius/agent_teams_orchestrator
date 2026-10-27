import { describe, expect, test } from 'bun:test'

import type { Message } from '../types/message.js'
import {
  getConversationRestoreError,
  messagesAfterAreOnlySynthetic,
  selectableUserMessagesFilter,
} from './MessageSelector.js'

describe('conversation restore admission', () => {
  test('rejects conversation-only and combined restores while preserving files-only restore', () => {
    let checks = 0
    const validate = () => {
      checks += 1
      return 'Native conversation rewind is unavailable'
    }
    expect(getConversationRestoreError('conversation', validate)).toBe('Native conversation rewind is unavailable')
    expect(getConversationRestoreError('both', validate)).toBe('Native conversation rewind is unavailable')
    expect(getConversationRestoreError('code', validate)).toBeUndefined()
    expect(getConversationRestoreError('nevermind', validate)).toBeUndefined()
    expect(checks).toBe(2)
  })

  test('preserves restore behavior when the current provider has no refusal', () => {
    expect(getConversationRestoreError('both')).toBeUndefined()
    expect(getConversationRestoreError('conversation', () => undefined)).toBeUndefined()
  })

  test('awaits a bound-history preflight and never invokes it for files-only restore', async () => {
    let checks = 0
    const validate = async () => {
      checks += 1
      return 'The source transcript has a native conversation owner'
    }
    expect(await getConversationRestoreError('both', validate)).toContain('native conversation owner')
    expect(await getConversationRestoreError('conversation', validate)).toContain('native conversation owner')
    expect(await getConversationRestoreError('code', validate)).toBeUndefined()
    expect(checks).toBe(2)
  })
})

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: 'Human: I tested the feature looks good',
    },
    isMeta: false,
    ...overrides,
  } as Message
}

describe('selectableUserMessagesFilter', () => {
  test('keeps ordinary human-authored user messages', () => {
    expect(selectableUserMessagesFilter(userMessage())).toBe(true)
  })

  test('rejects synthetic user-role replay text even without meta flag', () => {
    expect(
      selectableUserMessagesFilter(
        userMessage({
          isSynthetic: true,
        } as Partial<Message>),
      ),
    ).toBe(false)
  })

  test('rejects non-human origin user-role messages', () => {
    expect(
      selectableUserMessagesFilter(
        userMessage({
          origin: { kind: 'task-notification' },
        } as Partial<Message>),
      ),
    ).toBe(false)
  })

  test('rejects structured protocol user-role messages', () => {
    expect(
      selectableUserMessagesFilter(
        userMessage({
          protocolKind: 'teammate-message',
        } as Partial<Message>),
      ),
    ).toBe(false)
  })

  test('rejects user-role tool result metadata', () => {
    expect(
      selectableUserMessagesFilter(
        userMessage({
          toolUseResult: {},
        } as Partial<Message>),
      ),
    ).toBe(false)
  })
})

describe('messagesAfterAreOnlySynthetic', () => {
  test('ignores structured protocol user-role messages after the selected turn', () => {
    expect(
      messagesAfterAreOnlySynthetic(
        [
          userMessage({ message: { role: 'user', content: 'Human: start' } }),
          userMessage({
            message: {
              role: 'user',
              content: '<teammate-message from="qa">looks good</teammate-message>',
            },
            protocolKind: 'teammate-message',
          } as Partial<Message>),
        ],
        0,
      ),
    ).toBe(true)
  })

  test('ignores structured coordinator user-role messages after the selected turn', () => {
    expect(
      messagesAfterAreOnlySynthetic(
        [
          userMessage({ message: { role: 'user', content: 'Human: start' } }),
          userMessage({
            message: {
              role: 'user',
              content: 'Human: auto-approved queued command',
            },
            origin: { kind: 'coordinator' },
          } as Partial<Message>),
        ],
        0,
      ),
    ).toBe(true)
  })

  test('keeps ordinary replayed user messages meaningful', () => {
    expect(
      messagesAfterAreOnlySynthetic(
        [
          userMessage({ message: { role: 'user', content: 'Human: start' } }),
          userMessage({
            message: {
              role: 'user',
              content: 'Human: I tested the feature looks good',
            },
            isReplay: true,
          } as Partial<Message>),
        ],
        0,
      ),
    ).toBe(false)
  })

  test('keeps ordinary human-authored user messages meaningful', () => {
    expect(
      messagesAfterAreOnlySynthetic(
        [
          userMessage({ message: { role: 'user', content: 'Human: start' } }),
          userMessage({
            message: {
              role: 'user',
              content: 'Human: please continue',
            },
          }),
        ],
        0,
      ),
    ).toBe(false)
  })
})
