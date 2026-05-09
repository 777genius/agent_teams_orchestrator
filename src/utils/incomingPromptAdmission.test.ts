import { describe, expect, test } from 'bun:test'

import {
  decideIncomingPromptAdmission,
  getBlockingIncomingPromptQueueModes,
} from './incomingPromptAdmission.js'

describe('incoming prompt admission', () => {
  test('accepts bootstrap prompts while idle even when prompt queue is busy', () => {
    expect(
      decideIncomingPromptAdmission({
        submissionKind: 'bootstrap',
        queryGuardStatus: 'idle',
        blockingQueueModes: ['prompt'],
      }),
    ).toEqual({ accepted: true })
  })

  test('accepts bootstrap prompts while idle even when bash queue is busy', () => {
    expect(
      decideIncomingPromptAdmission({
        submissionKind: 'bootstrap',
        queryGuardStatus: 'idle',
        blockingQueueModes: ['bash'],
      }),
    ).toEqual({ accepted: true })
  })

  test('rejects bootstrap prompts while a query is running', () => {
    expect(
      decideIncomingPromptAdmission({
        submissionKind: 'bootstrap',
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

  test('accepts normal runtime prompts when idle and no blocking queue modes exist', () => {
    expect(
      decideIncomingPromptAdmission({
        submissionKind: 'runtime_delivery',
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
})
