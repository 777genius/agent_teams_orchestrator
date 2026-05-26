import { describe, expect, test } from 'bun:test'

import {
  SDKMessageSchema,
  SDKUserMessageReplaySchema,
  SDKUserMessageSchema,
} from './coreSchemas.js'

const userPayload = {
  type: 'user',
  message: {
    role: 'user',
    content: 'Human: I tested the feature looks good',
  },
  parent_tool_use_id: null,
} as const

describe('SDK user message schemas', () => {
  test('accepts synthetic user replay fields on the replay schema', () => {
    const parsed = SDKUserMessageReplaySchema().parse({
      ...userPayload,
      uuid: '00000000-0000-4000-8000-000000000000',
      session_id: 'session-1',
      isReplay: true,
      isSynthetic: true,
      origin: { kind: 'coordinator' },
      protocolKind: 'teammate-message',
    })

    expect(parsed.isReplay).toBe(true)
    expect(parsed.isSynthetic).toBe(true)
    expect(parsed.origin).toEqual({ kind: 'coordinator' })
    expect(parsed.protocolKind).toBe('teammate-message')
  })

  test('preserves replay provenance when parsed through generic SDKMessageSchema', () => {
    const parsed = SDKMessageSchema().parse({
      ...userPayload,
      uuid: '00000000-0000-4000-8000-000000000000',
      session_id: 'session-1',
      isReplay: true,
      isSynthetic: true,
      origin: { kind: 'coordinator' },
      protocolKind: 'teammate-message',
    })

    expect(parsed.type).toBe('user')
    if (parsed.type === 'user') {
      expect(parsed.isReplay).toBe(true)
      expect(parsed.isSynthetic).toBe(true)
      expect(parsed.origin).toEqual({ kind: 'coordinator' })
      expect(parsed.protocolKind).toBe('teammate-message')
    }
  })

  test('ordinary user messages do not require replay fields', () => {
    const parsed = SDKUserMessageSchema().parse(userPayload)

    expect(parsed.type).toBe('user')
    expect('isReplay' in parsed).toBe(false)
    expect(parsed.isSynthetic).toBeUndefined()
  })
})
