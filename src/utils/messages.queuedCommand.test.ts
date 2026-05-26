import { describe, expect, test } from 'bun:test'

import type { Attachment } from '../types/message.js'
import { normalizeAttachmentForAPI } from './messages.js'

function queuedCommandAttachment(
  overrides: Partial<Attachment> = {},
): Attachment {
  return {
    type: 'queued_command',
    prompt: 'Please review the completed task',
    commandMode: 'prompt',
    isMeta: true,
    ...overrides,
  } as Attachment
}

describe('normalizeAttachmentForAPI queued_command provenance', () => {
  test('does not describe meta queued commands without origin as user-authored', () => {
    const [message] = normalizeAttachmentForAPI(queuedCommandAttachment())

    expect(message?.origin).toEqual({ kind: 'coordinator' })
    expect(message?.isMeta).toBe(true)
    expect(message?.isSynthetic).toBe(true)
    expect(String(message?.message.content)).toContain(
      'The coordinator sent a message while you were working:',
    )
    expect(String(message?.message.content)).toContain(
      'IMPORTANT: This is NOT from your user - it came from the coordination layer.',
    )
    expect(String(message?.message.content)).not.toContain(
      'The user sent a new message while you were working:',
    )
  })

  test('keeps ordinary queued prompts user-authored', () => {
    const [message] = normalizeAttachmentForAPI(
      queuedCommandAttachment({
        isMeta: undefined,
      } as Partial<Attachment>),
    )

    expect(message?.origin).toBeUndefined()
    expect(message?.isMeta).toBeUndefined()
    expect(message?.isSynthetic).toBeUndefined()
    expect(String(message?.message.content)).toContain(
      'The user sent a new message while you were working:',
    )
  })

  test('marks task notifications with structured protocol provenance', () => {
    const [message] = normalizeAttachmentForAPI(
      queuedCommandAttachment({
        commandMode: 'task-notification',
      }),
    )

    expect(message?.origin).toEqual({ kind: 'task-notification' })
    expect(message?.protocolKind).toBe('task-notification')
    expect(message?.isSynthetic).toBe(true)
  })

  test('marks raw teammate protocol queued commands without wrapping them as user-authored', () => {
    const prompt =
      '<teammate-message teammate_id="alice">Looks good</teammate-message>'
    const [message] = normalizeAttachmentForAPI(
      queuedCommandAttachment({
        prompt,
        isMeta: undefined,
      } as Partial<Attachment>),
    )

    expect(message?.protocolKind).toBe('teammate-message')
    expect(message?.isMeta).toBe(true)
    expect(message?.isSynthetic).toBe(true)
    expect(String(message?.message.content)).toContain(prompt)
    expect(String(message?.message.content)).not.toContain(
      'The user sent a new message while you were working:',
    )
  })
})
