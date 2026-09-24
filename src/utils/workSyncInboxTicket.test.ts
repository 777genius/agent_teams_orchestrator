import { describe, expect, test } from 'bun:test'

import {
  isMatchingWorkSyncContinuationTicket,
  readWorkSyncInboxContinuationTicket,
} from './workSyncInboxTicket.js'

describe('work-sync inbox ticket matching', () => {
  test('does not treat a ticketed nudge as a generic mailbox message', () => {
    const message = {
      messageKind: 'member_work_sync_nudge' as const,
      messageId: 'intent-c1',
      workSyncRuntimeTicketId: 'nonce-c1',
      workSyncRuntimeGeneration: 1,
      workSyncRuntimeInstanceId: 'runtime-1',
      workSyncIntentId: 'intent-c1',
    }
    expect(readWorkSyncInboxContinuationTicket(message)?.ticketId).toBe('nonce-c1')
    expect(
      isMatchingWorkSyncContinuationTicket({
        message,
        runtimeInstanceId: 'runtime-1',
        reservationNonce: 'nonce-c1',
        intentId: 'intent-c1',
        expectedGeneration: 1,
      }),
    ).toBe(true)
    expect(
      isMatchingWorkSyncContinuationTicket({
        message,
        runtimeInstanceId: 'runtime-2',
        reservationNonce: 'nonce-c1',
        intentId: 'intent-c1',
        expectedGeneration: 1,
      }),
    ).toBe(false)
  })

  test('ordinary mailbox text without ticket fields is not a continuation', () => {
    expect(
      readWorkSyncInboxContinuationTicket({
        messageKind: 'member_work_sync_nudge',
        messageId: 'msg-1',
        text: 'please continue',
      }),
    ).toBeNull()
  })

  test('rejects a ticketed envelope whose admission hash does not match the reserve', () => {
    const message = {
      messageKind: 'member_work_sync_nudge' as const,
      messageId: 'intent-c1',
      workSyncRuntimeTicketId: 'nonce-c1',
      workSyncRuntimeGeneration: 1,
      workSyncRuntimeInstanceId: 'runtime-1',
      workSyncIntentId: 'intent-c1',
      workSyncAdmissionPayloadHash: 'hash-other',
    }
    expect(
      isMatchingWorkSyncContinuationTicket({
        message,
        runtimeInstanceId: 'runtime-1',
        reservationNonce: 'nonce-c1',
        intentId: 'intent-c1',
        expectedGeneration: 1,
        admissionPayloadHash: 'hash-a',
      }),
    ).toBe(false)
  })
})
