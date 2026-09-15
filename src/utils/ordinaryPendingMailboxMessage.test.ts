import { afterEach, describe, expect, test } from 'bun:test'

import {
  classifyTicketedWorkSyncEnvelope,
  getOrdinaryPendingMessage,
} from './ordinaryPendingMailboxMessage.js'
import { QueryGuard } from './QueryGuard.js'
import {
  armWorkSyncPostTurnAdmissionWindow,
  bindWorkSyncContinuationAdmission,
  clearWorkSyncPostTurnAdmissionWindowForTests,
  resetWorkSyncAdmissionProcessorForTests,
  unbindWorkSyncContinuationAdmission,
} from './workSyncContinuationAdmission.js'

const staleC1 = {
  messageId: 'work-sync-c1',
  from: 'system',
  text: 'Early continuation C1.',
  messageKind: 'member_work_sync_nudge',
  workSyncRuntimeTicketId: 'ticket-c1',
  workSyncRuntimeGeneration: 0,
  workSyncRuntimeInstanceId: 'runtime-1',
  workSyncIntentId: 'intent-c1',
}

const nextC2 = {
  messageId: 'work-sync-c2',
  from: 'system',
  text: 'Early continuation C2.',
  messageKind: 'member_work_sync_nudge',
  workSyncRuntimeTicketId: 'ticket-c2',
  workSyncRuntimeGeneration: 0,
  workSyncRuntimeInstanceId: 'runtime-1',
  workSyncIntentId: 'intent-c2',
}

const userMailbox = {
  messageId: 'user-1',
  from: 'user',
  text: 'Please look at this.',
}

const continueNudge = {
  messageId: 'work-sync-continue',
  from: 'system',
  text: 'Please continue.',
  messageKind: 'member_work_sync_nudge',
}

describe('ordinary pending mailbox selection', () => {
  afterEach(() => {
    clearWorkSyncPostTurnAdmissionWindowForTests()
    resetWorkSyncAdmissionProcessorForTests()
    unbindWorkSyncContinuationAdmission()
  })

  test('skips a stale ticketed envelope so C2 can proceed', () => {
    const guard = new QueryGuard('runtime-1')
    const reserved = guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 0,
      intentId: 'intent-c2',
      reservationNonce: 'ticket-c2',
    })
    expect(reserved.ok).toBe(true)
    bindWorkSyncContinuationAdmission({
      guard,
      teamName: 'team-a',
      memberName: 'bob',
    })
    expect(classifyTicketedWorkSyncEnvelope(staleC1)).toBe('stale')
    expect(classifyTicketedWorkSyncEnvelope(nextC2)).toBe('match')
    expect(
      getOrdinaryPendingMessage({
        pendingMessages: [staleC1, nextC2],
        deferUnticketedWorkSyncNudges: true,
      })?.messageId,
    ).toBe('work-sync-c2')
  })

  test('skips a stale ticketed envelope so an idle user mailbox can proceed', () => {
    expect(classifyTicketedWorkSyncEnvelope(staleC1)).toBe('stale')
    expect(
      getOrdinaryPendingMessage({
        pendingMessages: [staleC1, userMailbox],
        deferUnticketedWorkSyncNudges: true,
      })?.messageId,
    ).toBe('user-1')
  })

  test('selects an unticketed Continue while handshake is open', () => {
    expect(
      getOrdinaryPendingMessage({
        pendingMessages: [continueNudge, userMailbox],
        deferUnticketedWorkSyncNudges: false,
      })?.messageId,
    ).toBe('work-sync-continue')
  })

  test('holds ticketed envelopes only during the post-turn wait window', () => {
    armWorkSyncPostTurnAdmissionWindow(Date.now(), 5_000)
    expect(classifyTicketedWorkSyncEnvelope(staleC1)).toBe('wait')
    expect(
      getOrdinaryPendingMessage({
        pendingMessages: [staleC1, userMailbox],
        deferUnticketedWorkSyncNudges: true,
      }),
    ).toBeUndefined()
  })
})
