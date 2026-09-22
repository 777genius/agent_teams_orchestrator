import { describe, expect, test } from 'bun:test'

import {
  selectNextInProcessMailboxMessageIndex,
  shouldDeferInProcessMailboxReadAck,
  tryMarkDeferredInProcessMailboxReadAck,
} from './inProcessRunner.js'

describe('selectNextInProcessMailboxMessageIndex', () => {
  test('prioritizes work-sync nudges before lead and peer chatter', () => {
    const messages = [
      {
        read: false,
        from: 'peer',
      },
      {
        read: false,
        from: 'team-lead',
      },
      {
        read: false,
        from: 'system',
        messageKind: 'member_work_sync_nudge' as const,
      },
    ]

    expect(selectNextInProcessMailboxMessageIndex(messages)).toBe(2)
  })

  test('falls back to lead messages before peer FIFO', () => {
    const messages = [
      {
        read: false,
        from: 'peer',
      },
      {
        read: false,
        from: 'team-lead',
      },
    ]

    expect(selectNextInProcessMailboxMessageIndex(messages)).toBe(1)
  })

  test('falls back to first unread message when no priority rows exist', () => {
    const messages = [
      {
        read: true,
        from: 'team-lead',
      },
      {
        read: false,
        from: 'peer',
      },
    ]

    expect(selectNextInProcessMailboxMessageIndex(messages)).toBe(1)
  })

  test('defers read ack for work-sync nudges until the turn completes', () => {
    expect(
      shouldDeferInProcessMailboxReadAck({
        messageKind: 'member_work_sync_nudge',
      }),
    ).toBe(true)
  })

  test('keeps immediate read ack for ordinary mailbox rows', () => {
    expect(shouldDeferInProcessMailboxReadAck({})).toBe(false)
    expect(
      shouldDeferInProcessMailboxReadAck({
        messageKind: 'task_comment_notification',
      }),
    ).toBe(false)
  })

  test('does not throw when deferred work-sync read ack fails', async () => {
    const marked = await tryMarkDeferredInProcessMailboxReadAck({
      agentName: 'alice',
      teamName: 'my-team',
      messageId: 'message-1',
      markRead: async () => {
        throw new Error('mailbox write failed')
      },
    })

    expect(marked).toBe(false)
  })
})
