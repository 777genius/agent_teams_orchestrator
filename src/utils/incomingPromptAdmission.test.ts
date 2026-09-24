import { describe, expect, test } from 'bun:test'

import {
  decideIncomingPromptAdmission,
  getBlockingIncomingPromptQueueModes,
  startQueryForIncomingKind,
} from './incomingPromptAdmission.js'

describe('incoming prompt admission', () => {
  test('accepts bootstrap prompts while idle even when prompt queue is busy', () => {
    expect(
      decideIncomingPromptAdmission({
        submissionKind: 'bootstrap',
        bootstrapAdmissionPending: true,
        queryGuardStatus: 'idle',
        blockingQueueModes: ['prompt'],
      }),
    ).toEqual({ accepted: true })
  })

  test('accepts bootstrap prompts while idle even when bash queue is busy', () => {
    expect(
      decideIncomingPromptAdmission({
        submissionKind: 'bootstrap',
        bootstrapAdmissionPending: true,
        queryGuardStatus: 'idle',
        blockingQueueModes: ['bash'],
      }),
    ).toEqual({ accepted: true })
  })

  test('rejects bootstrap prompts while a query is running', () => {
    expect(
      decideIncomingPromptAdmission({
        submissionKind: 'bootstrap',
        bootstrapAdmissionPending: true,
        queryGuardStatus: 'running',
        blockingQueueModes: [],
      }),
    ).toEqual({
      accepted: false,
      rejectionReason: 'query_active',
      retryable: true,
    })
  })

  test('rejects bootstrap prompts while a query is dispatching', () => {
    expect(
      decideIncomingPromptAdmission({
        submissionKind: 'bootstrap',
        bootstrapAdmissionPending: true,
        queryGuardStatus: 'dispatching',
        blockingQueueModes: [],
      }),
    ).toEqual({
      accepted: false,
      rejectionReason: 'query_active',
      retryable: true,
    })
  })

  test('keeps normal runtime prompts behind blocking prompt and bash queue items', () => {
    for (const submissionKind of ['runtime_delivery', 'mailbox', 'task', 'tick'] as const) {
      expect(
        decideIncomingPromptAdmission({
          submissionKind,
          bootstrapAdmissionPending: false,
          queryGuardStatus: 'idle',
          blockingQueueModes: ['prompt', 'bash'],
        }),
      ).toEqual({
        accepted: false,
        rejectionReason: 'command_queue_busy',
        retryable: true,
      })
    }
  })

  test('accepts a matching work-sync continuation while dispatching', () => {
    expect(
      decideIncomingPromptAdmission({
        submissionKind: 'work_sync_continuation',
        bootstrapAdmissionPending: false,
        queryGuardStatus: 'dispatching',
        blockingQueueModes: [],
      }),
    ).toEqual({ accepted: true })
  })

  test('rejects a work-sync continuation while idle so it cannot use tryStart', () => {
    expect(
      decideIncomingPromptAdmission({
        submissionKind: 'work_sync_continuation',
        bootstrapAdmissionPending: false,
        queryGuardStatus: 'idle',
        blockingQueueModes: [],
      }),
    ).toEqual({
      accepted: false,
      rejectionReason: 'query_active',
      retryable: true,
    })
  })

  test('accepts normal runtime prompts when idle and no blocking queue modes exist', () => {
    expect(
      decideIncomingPromptAdmission({
        submissionKind: 'runtime_delivery',
        bootstrapAdmissionPending: false,
        queryGuardStatus: 'idle',
        blockingQueueModes: [],
      }),
    ).toEqual({ accepted: true })
  })

  test('only prompt and bash queue modes block incoming runtime prompts', () => {
    expect(
      getBlockingIncomingPromptQueueModes([
        'task-notification',
        'prompt',
        'prompt',
        'bash',
      ]),
    ).toEqual(['prompt', 'bash'])
  })

  test('blocks every non-bootstrap prompt source while bootstrap admission is pending', () => {
    for (const submissionKind of ['runtime_delivery', 'mailbox', 'task', 'tick'] as const) {
      expect(
        decideIncomingPromptAdmission({
          submissionKind,
          bootstrapAdmissionPending: true,
          queryGuardStatus: 'idle',
          blockingQueueModes: [],
        }),
      ).toEqual({
        accepted: false,
        rejectionReason: 'bootstrap_pending',
        retryable: true,
      })
    }
  })

  test('reports bootstrap_pending before transient query or queue state', () => {
    expect(
      decideIncomingPromptAdmission({
        submissionKind: 'mailbox',
        bootstrapAdmissionPending: true,
        queryGuardStatus: 'running',
        blockingQueueModes: ['prompt'],
      }),
    ).toEqual({
      accepted: false,
      rejectionReason: 'bootstrap_pending',
      retryable: true,
    })
  })
})

describe('startQueryForIncomingKind', () => {
  test('starts a reserved continuation when the ticket is still held', () => {
    expect(
      startQueryForIncomingKind({
        incomingKind: 'work_sync_continuation',
        continuationTicket: { intentId: 'intent-c1' },
        startReservedContinuation: () => ({ ok: true, generation: 4 }),
        tryStart: () => 99,
      }),
    ).toBe(4)
  })

  test('falls back to ordinary tryStart when a leftover continuation kind has no ticket', () => {
    expect(
      startQueryForIncomingKind({
        incomingKind: 'work_sync_continuation',
        continuationTicket: null,
        startReservedContinuation: () => ({ ok: false }),
        tryStart: () => 7,
      }),
    ).toBe(7)
  })
})
