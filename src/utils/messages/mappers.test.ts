import { describe, expect, test } from 'bun:test'

import { toInternalMessages, toSDKMessages } from './mappers.js'

describe('SDK message mappers', () => {
  test('maps synthetic SDK user replay to internal meta user message', () => {
    const [message] = toInternalMessages([
      {
        type: 'user',
        message: {
          role: 'user',
          content: 'Human: I tested the feature looks good',
        },
        parent_tool_use_id: null,
        uuid: 'user-replay-1',
        session_id: 'session-1',
        isReplay: true,
        isSynthetic: true,
        origin: { kind: 'coordinator' },
        protocolKind: 'teammate-message',
      },
    ] as never)

    expect(message?.type).toBe('user')
    if (message?.type === 'user') {
      expect(message.isMeta).toBe(true)
      expect(message.isSynthetic).toBe(true)
      expect(message.isReplay).toBe(true)
      expect(message.origin).toEqual({ kind: 'coordinator' })
      expect(message.protocolKind).toBe('teammate-message')
      expect(message.message.content).toBe('Human: I tested the feature looks good')
    }
  })

  test('keeps ordinary SDK user text non-meta even when it starts with Human', () => {
    const [message] = toInternalMessages([
      {
        type: 'user',
        message: {
          role: 'user',
          content: 'Human: I tested the feature looks good',
        },
        parent_tool_use_id: null,
        uuid: 'user-human-1',
        session_id: 'session-1',
      },
    ] as never)

    expect(message?.type).toBe('user')
    if (message?.type === 'user') {
      expect(message.isMeta).not.toBe(true)
      expect(message.message.content).toBe('Human: I tested the feature looks good')
    }
  })

  test('maps internal meta user messages to synthetic SDK user messages', () => {
    const [message] = toSDKMessages([
      {
        type: 'user',
        message: {
          role: 'user',
          content: 'Base directory for this skill: /tmp/skill',
        },
        uuid: 'meta-user-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        isMeta: true,
        origin: { kind: 'coordinator' },
        protocolKind: 'teammate-message',
      },
    ] as never)

    expect(message?.type).toBe('user')
    if (message?.type === 'user') {
      expect(message.isSynthetic).toBe(true)
      expect(message.origin).toEqual({ kind: 'coordinator' })
      expect(message.protocolKind).toBe('teammate-message')
      expect(message.message.content).toBe('Base directory for this skill: /tmp/skill')
    }
  })

  test('preserves explicit internal synthetic provenance even when message is not meta', () => {
    const [message] = toSDKMessages([
      {
        type: 'user',
        message: {
          role: 'user',
          content:
            '<teammate-message teammate_id="alice">Looks good</teammate-message>',
        },
        uuid: 'synthetic-protocol-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        isSynthetic: true,
        protocolKind: 'teammate-message',
      },
    ] as never)

    expect(message?.type).toBe('user')
    if (message?.type === 'user') {
      expect(message.isSynthetic).toBe(true)
      expect(message.protocolKind).toBe('teammate-message')
    }
  })
})
