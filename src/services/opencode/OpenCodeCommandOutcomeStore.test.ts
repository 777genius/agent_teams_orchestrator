import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeCommandOutcomeStore } from './OpenCodeCommandOutcomeStore.js'

let tempDir: string | null = null

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

async function createStore(): Promise<OpenCodeCommandOutcomeStore> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-command-outcome-store-'))
  return new OpenCodeCommandOutcomeStore(path.join(tempDir, 'command-outcomes.json'))
}

function basePatch(overrides: Partial<Parameters<OpenCodeCommandOutcomeStore['upsert']>[0]> = {}) {
  return {
    requestId: 'send-request-1',
    status: 'received' as const,
    teamId: 'team-a',
    teamName: 'team-a',
    laneId: 'secondary:opencode:bob',
    memberName: 'bob',
    projectPath: '/tmp/project',
    runId: 'run-1',
    messageId: 'inbox-1',
    payloadHash: 'payload-hash-1',
    ...overrides,
  }
}

describe('OpenCodeCommandOutcomeStore', () => {
  test('writes and queries a send-message outcome by request id and delivery attempt id', async () => {
    const store = await createStore()

    await store.upsert(basePatch({
      deliveryAttemptId: 'ledger-1:1:payload',
      status: 'prompt_submitting',
      sessionId: 'session-bob',
      runtimePromptMessageId: 'msg_prompt_1',
    }))

    await expect(store.query({ requestId: 'send-request-1' })).resolves.toMatchObject({
      record: {
        requestId: 'send-request-1',
        deliveryAttemptId: 'ledger-1:1:payload',
        status: 'prompt_submitting',
        safeToRetry: false,
        runtimePromptMessageId: 'msg_prompt_1',
      },
      diagnostics: [],
    })
    await expect(store.query({ deliveryAttemptId: 'ledger-1:1:payload' })).resolves.toMatchObject({
      record: {
        requestId: 'send-request-1',
      },
    })
  })

  test('does not downgrade prompt_accepted to failed_before_accept', async () => {
    const store = await createStore()

    await store.upsert(basePatch({
      status: 'prompt_accepted',
      sessionId: 'session-bob',
      runtimePromptMessageId: 'msg_prompt_1',
      acceptedAt: '2026-05-12T06:45:40.000Z',
    }))
    await store.upsert(basePatch({
      status: 'failed_before_accept',
      error: 'late failure',
      diagnostics: ['late failure'],
    }))

    await expect(store.query({ requestId: 'send-request-1' })).resolves.toMatchObject({
      record: {
        status: 'prompt_accepted',
        safeToRetry: false,
        error: 'late failure',
        diagnostics: ['late failure'],
      },
    })
  })

  test('treats corrupt JSON as unknown readable state instead of throwing', async () => {
    const store = await createStore()
    if (!tempDir) {
      throw new Error('missing temp dir')
    }
    await writeFile(path.join(tempDir, 'command-outcomes.json'), '{bad json', 'utf8')

    const result = await store.query({ requestId: 'send-request-1' })

    expect(result.record).toBeNull()
    expect(result.diagnostics.join('\n')).toContain('OpenCode command outcome store read failed')
  })

  test('rejects a request id and delivery attempt id that resolve to different records', async () => {
    const store = await createStore()

    await store.upsert(basePatch({
      requestId: 'send-request-1',
      deliveryAttemptId: 'ledger-1:1:payload',
    }))
    await store.upsert(basePatch({
      requestId: 'send-request-2',
      deliveryAttemptId: 'ledger-1:2:payload',
      messageId: 'inbox-2',
    }))

    const result = await store.query({
      requestId: 'send-request-1',
      deliveryAttemptId: 'ledger-1:2:payload',
    })

    expect(result.record).toBeNull()
    expect(result.diagnostics.join('\n')).toContain('matched different requestId and deliveryAttemptId')
  })

  test('prunes only completed records older than the retention window', async () => {
    const store = await createStore()

    await store.upsert(basePatch({
      requestId: 'completed-old',
      status: 'reconciled',
      completedAt: '2026-05-12T06:00:00.000Z',
    }))
    await store.upsert(basePatch({
      requestId: 'completed-new',
      status: 'reconciled',
      completedAt: '2026-05-12T06:59:00.000Z',
    }))
    await store.upsert(basePatch({
      requestId: 'in-flight-old',
      status: 'prompt_submitting',
    }))

    const removed = await store.prune(
      30 * 60 * 1000,
      Date.parse('2026-05-12T07:00:00.000Z'),
    )

    expect(removed).toBe(1)
    await expect(store.query({ requestId: 'completed-old' })).resolves.toMatchObject({
      record: null,
    })
    await expect(store.query({ requestId: 'completed-new' })).resolves.toMatchObject({
      record: { requestId: 'completed-new' },
    })
    await expect(store.query({ requestId: 'in-flight-old' })).resolves.toMatchObject({
      record: { requestId: 'in-flight-old' },
    })
  })

  test('serializes concurrent updates through the store lock', async () => {
    const store = await createStore()

    await Promise.all([
      store.upsert(basePatch({
        status: 'received',
        diagnostics: ['received'],
      })),
      store.upsert(basePatch({
        status: 'prompt_submitting',
        sessionId: 'session-bob',
        runtimePromptMessageId: 'msg_prompt_1',
        diagnostics: ['submitting'],
      })),
      store.upsert(basePatch({
        status: 'prompt_accepted',
        sessionId: 'session-bob',
        runtimePromptMessageId: 'msg_prompt_1',
        acceptedAt: '2026-05-12T06:45:40.000Z',
        diagnostics: ['accepted'],
      })),
    ])

    const result = await store.query({ requestId: 'send-request-1' })

    expect(result.record).toMatchObject({
      status: 'prompt_accepted',
      safeToRetry: false,
      sessionId: 'session-bob',
      runtimePromptMessageId: 'msg_prompt_1',
    })
    expect(result.record?.diagnostics).toEqual(
      expect.arrayContaining(['received', 'submitting', 'accepted']),
    )
  })
})
