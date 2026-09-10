import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  function submittingPatch() {
    return basePatch({ status: 'prompt_submitting', deliveryAttemptId: 'attempt',
      sessionId: 'session', runtimePid: 123, runtimePromptMessageId: 'native-1',
      prePromptCursor: 'cursor', diagnostics: ['admitted'] })
  }

  const unsubmitted = { definitelyUnsubmitted: { runtimePromptMessageId: 'native-1' } }

  test('definitely-unsubmitted owner durably becomes retryable while retaining ledger evidence', async () => {
    const store = await createStore()
    const submitted = await store.upsert(submittingPatch(), { requireRetryable: true })
    const failed = await store.upsert({ ...submitted, status: 'failed_before_accept',
      error: 'arm rejected', completedAt: '2026-09-10T00:00:00.000Z',
      prePromptCursor: 'must-not-replace-evidence', diagnostics: ['unsubmitted'],
      acceptedAt: 'must-not-introduce-acceptance' }, unsubmitted)
    expect(failed).toEqual({ ...submitted, status: 'failed_before_accept', safeToRetry: true,
      error: 'arm rejected', completedAt: '2026-09-10T00:00:00.000Z',
      diagnostics: ['admitted', 'unsubmitted'], updatedAt: failed.updatedAt })
    const reopened = new OpenCodeCommandOutcomeStore(path.join(tempDir!, 'command-outcomes.json'))
    expect((await reopened.query({ deliveryAttemptId: 'attempt' })).record).toEqual(failed)
    const retry = await reopened.upsert({ ...failed, status: 'prompt_submitting',
      runtimePromptMessageId: 'native-2' }, { requireRetryable: true })
    expect(retry).toMatchObject({ status: 'prompt_submitting', safeToRetry: false,
      runtimePromptMessageId: 'native-2', error: null, completedAt: null })
  })

  test('definitely-unsubmitted rejects each mismatched or omitted captured identity without a write', async () => {
    const store = await createStore()
    const submitted = await store.upsert(submittingPatch(), { requireRetryable: true })
    const file = path.join(tempDir!, 'command-outcomes.json')
    const before = await readFile(file, 'utf8')
    const failure = { ...submitted, status: 'failed_before_accept' as const }
    for (const field of ['requestId', 'teamId', 'teamName', 'laneId', 'memberName',
      'projectPath', 'runId', 'deliveryAttemptId', 'messageId', 'payloadHash',
      'sessionId', 'runtimePid', 'runtimePromptMessageId'] as const) {
      for (const value of [undefined, null, field === 'runtimePid' ? 456 : 'foreign']) {
        await expect(store.upsert({ ...failure, [field]: value }, unsubmitted)).rejects.toThrow()
      }
      const omitted: Partial<typeof failure> = { ...failure }
      delete omitted[field]
      await expect(store.upsert(omitted as typeof failure, unsubmitted)).rejects.toThrow()
    }
    for (const runtimePromptMessageId of ['', '   ', 'foreign']) {
      await expect(store.upsert(failure, { definitelyUnsubmitted: { runtimePromptMessageId } })).rejects.toThrow()
    }
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  test('explicit null identity matches but omission cannot stand in for null or an absent attempt', async () => {
    const store = await createStore()
    const submitted = await store.upsert({ ...submittingPatch(), deliveryAttemptId: undefined,
      runId: null, messageId: null, payloadHash: null, sessionId: null, runtimePid: null })
    const failure = { ...submitted, status: 'failed_before_accept' as const }
    await expect(store.upsert(failure, unsubmitted)).rejects.toThrow('exact submitting owner')
    await expect(store.upsert({ ...failure, deliveryAttemptId: undefined, runId: undefined },
      unsubmitted)).rejects.toThrow('exact submitting owner')
    expect(await store.upsert({ ...failure, deliveryAttemptId: undefined }, unsubmitted))
      .toMatchObject({ status: 'failed_before_accept', safeToRetry: true })
  })

  test('definitely-unsubmitted requires readable existing submitting history and the failure status', async () => {
    const store = await createStore()
    const file = path.join(tempDir!, 'command-outcomes.json')
    const failure = { ...submittingPatch(), status: 'failed_before_accept' as const }
    await expect(store.upsert(failure, unsubmitted)).rejects.toThrow('exact submitting owner')
    for (const content of ['{bad json', JSON.stringify({ schemaVersion: 2, records: {} }),
      JSON.stringify({ schemaVersion: 1, records: { [failure.requestId]: { invalid: true } } })]) {
      await writeFile(file, content)
      await expect(store.upsert(failure, unsubmitted)).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe(content)
    }
    await rm(file)
    const submitted = await store.upsert(submittingPatch())
    const before = await readFile(file, 'utf8')
    for (const status of ['received', 'preconditions_checked', 'session_resolved', 'mcp_ready',
      'prompt_submitting', 'prompt_accepted', 'turn_observed', 'reconciled', 'failed_after_accept'] as const) {
      await expect(store.upsert({ ...submitted, status }, unsubmitted)).rejects.toThrow()
    }
    expect(await readFile(file, 'utf8')).toBe(before)
    for (const status of ['received', 'preconditions_checked', 'session_resolved', 'mcp_ready',
      'failed_before_accept', 'prompt_accepted', 'failed_after_accept', 'turn_observed', 'reconciled'] as const) {
      await writeFile(file, JSON.stringify({ schemaVersion: 1,
        records: { [submitted.requestId]: { ...submitted, status } } }))
      const bytes = await readFile(file, 'utf8')
      await expect(store.upsert(failure, unsubmitted)).rejects.toThrow('exact submitting owner')
      expect(await readFile(file, 'utf8')).toBe(bytes)
    }
  })

  test('definitely-unsubmitted persistence failure leaves the reopened owner fenced', async () => {
    const store = await createStore()
    const submitted = await store.upsert(submittingPatch())
    const writer = spyOn(store as unknown as { writeStore: () => Promise<void> }, 'writeStore')
      .mockRejectedValue(new Error('synthetic persistence failure'))
    try {
      await expect(store.upsert({ ...submitted, status: 'failed_before_accept' }, unsubmitted))
        .rejects.toThrow('synthetic persistence failure')
      expect(writer).toHaveBeenCalledTimes(1)
    } finally {
      writer.mockRestore()
    }
    const reopened = new OpenCodeCommandOutcomeStore(path.join(tempDir!, 'command-outcomes.json'))
    expect((await reopened.query({ requestId: submitted.requestId })).record).toEqual(submitted)
    await expect(reopened.upsert({ ...submitted, runtimePromptMessageId: 'native-2' },
      { requireRetryable: true })).rejects.toThrow('already submitted')
  })

  test('late old-generation evidence cannot reopen a replacement or accepted owner', async () => {
    const store = await createStore()
    const submitted = await store.upsert(submittingPatch())
    const failure = { ...submitted, status: 'failed_before_accept' as const }
    await store.upsert(failure, unsubmitted)
    const competitor = new OpenCodeCommandOutcomeStore(path.join(tempDir!, 'command-outcomes.json'))
    const replacement = await competitor.upsert({ ...submitted, runtimePromptMessageId: 'native-2' },
      { requireRetryable: true })
    for (const status of ['failed_before_accept', 'prompt_accepted', 'reconciled'] as const) {
      await expect(store.upsert({ ...submitted, status },
        status === 'failed_before_accept' ? unsubmitted : {})).rejects.toThrow()
    }
    await expect(store.upsert(failure)).rejects.toThrow('existing prompt')
    expect((await competitor.query({ requestId: submitted.requestId })).record).toEqual(replacement)
    const accepted = await competitor.upsert({ ...replacement, status: 'prompt_accepted' })
    await expect(store.upsert({ ...accepted, status: 'failed_before_accept' },
      { definitelyUnsubmitted: { runtimePromptMessageId: 'native-2' } })).rejects.toThrow()
    expect((await competitor.query({ requestId: submitted.requestId })).record).toEqual(accepted)
  })

  test('retry admission discards retained or incoming acceptance metadata from failed history', async () => {
    const store = await createStore()
    const failed = await store.upsert({ ...submittingPatch(), status: 'failed_before_accept',
      acceptedAt: '2026-09-09T00:00:00.000Z', turnObservedAt: '2026-09-09T00:00:01.000Z',
      sendMessageData: { accepted: true, memberName: 'bob', runtimePromptMessageId: 'native-1', diagnostics: [] } })
    const retry = await store.upsert({ ...failed, status: 'prompt_submitting',
      runtimePromptMessageId: 'native-2' }, { requireRetryable: true })
    expect(retry).toMatchObject({ status: 'prompt_submitting', safeToRetry: false,
      acceptedAt: null, turnObservedAt: null })
    expect(retry.sendMessageData).toBeUndefined()
  })

  test('queued old evidence is checked after the competing generation commits under the lock', async () => {
    const store = await createStore()
    const submitted = await store.upsert(submittingPatch())
    await store.upsert({ ...submitted, status: 'failed_before_accept' }, unsubmitted)
    const competitor = new OpenCodeCommandOutcomeStore(path.join(tempDir!, 'command-outcomes.json'))
    type Writer = { writeStore: (value: unknown) => Promise<void> }
    const target = competitor as unknown as Writer
    const originalWrite = target.writeStore.bind(competitor)
    let entered!: () => void
    let release!: () => void
    const atWrite = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const writer = spyOn(target, 'writeStore').mockImplementation(async value => {
      entered()
      await gate
      await originalWrite(value)
    })
    try {
      const replacementWrite = competitor.upsert({ ...submitted, runtimePromptMessageId: 'native-2' },
        { requireRetryable: true })
      await atWrite
      const failure = { ...submitted, status: 'failed_before_accept' as const }
      const evidence = { definitelyUnsubmitted: { runtimePromptMessageId: 'native-1' } }
      const lateWrite = store.upsert(failure, evidence).then(
        value => ({ value, error: null }),
        (error: Error) => ({ value: null, error }),
      )
      // Neither caller mutation nor a pre-lock snapshot of history may authorize
      // the queued transition against the replacement that is about to commit.
      failure.runtimePromptMessageId = 'native-2'
      evidence.definitelyUnsubmitted.runtimePromptMessageId = 'native-2'
      release()
      const replacement = await replacementWrite
      const late = await lateWrite
      expect(late.value).toBeNull()
      expect(late.error?.message).toContain('exact submitting owner')
      const reopened = new OpenCodeCommandOutcomeStore(path.join(tempDir!, 'command-outcomes.json'))
      expect((await reopened.query({ requestId: submitted.requestId })).record).toEqual(replacement)
    } finally {
      release()
      writer.mockRestore()
    }
  })

  test('atomically admits one prompt and retains its owner across terminal retry and restart', async () => {
    const store = await createStore()
    const file = path.join(tempDir!, 'command-outcomes.json')
    const first = basePatch({ status: 'prompt_submitting', runtimePromptMessageId: 'prompt-a', deliveryAttemptId: 'attempt-a', sessionId: 'session-a', runtimePid: 123 })
    const results = await Promise.allSettled([
      store.upsert(first, { requireRetryable: true }),
      new OpenCodeCommandOutcomeStore(file).upsert({ ...first, runtimePromptMessageId: 'prompt-b' }, { requireRetryable: true }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const winner = (await store.query({ requestId: first.requestId })).record!
    await store.upsert({ ...first, runtimePromptMessageId: winner.runtimePromptMessageId, status: 'reconciled', completedAt: new Date().toISOString() })
    const restarted = new OpenCodeCommandOutcomeStore(file)
    await expect(restarted.upsert(basePatch({ status: 'received' }), { requireRetryable: true })).rejects.toThrow('already submitted')
    await expect(restarted.upsert({ ...first, requestId: 'alias' }, { requireRetryable: true })).rejects.toThrow('another request')
    await expect(restarted.upsert({ ...first, runtimePromptMessageId: 'replacement' })).rejects.toThrow('existing prompt')
    await expect(restarted.upsert({ ...first, memberName: 'foreign' })).rejects.toThrow('identity changed')
    await expect(restarted.upsert({ ...first, sessionId: 'replacement-session' })).rejects.toThrow('identity changed')
    await expect(restarted.upsert({ ...first, runtimePid: 456 })).rejects.toThrow('identity changed')
    expect((await restarted.query({ requestId: first.requestId })).record?.runtimePromptMessageId).toBe(winner.runtimePromptMessageId)
  })

  for (const alias of [false, true]) {
    test(`failed retry admission has one persistent owner (alias=${alias})`, async () => {
      const store = await createStore()
      const file = path.join(tempDir!, 'command-outcomes.json')
      const failed = basePatch({ deliveryAttemptId: 'attempt', status: 'failed_before_accept',
        completedAt: '2026-01-01T00:00:00.000Z', error: 'no session' })
      await store.upsert(failed)
      const first = { ...failed, requestId: alias ? 'retry-a' : failed.requestId,
        status: 'prompt_submitting' as const, runtimePromptMessageId: 'prompt-a' }
      const second = { ...first, requestId: alias ? 'retry-b' : first.requestId,
        runtimePromptMessageId: 'prompt-b' }
      const results = await Promise.allSettled([
        store.upsert(first, { requireRetryable: true }),
        new OpenCodeCommandOutcomeStore(file).upsert(second, { requireRetryable: true }),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const winner = (await store.query({ deliveryAttemptId: 'attempt' })).record!
      expect(winner).toMatchObject({ status: 'prompt_submitting', safeToRetry: false })
      if (!alias) expect(winner).toMatchObject({ completedAt: null, error: null })
      const losing = winner.runtimePromptMessageId === first.runtimePromptMessageId ? second : first
      await expect(store.upsert({ ...losing, status: 'prompt_accepted' })).rejects.toThrow()
      await expect(store.upsert({ ...failed, requestId: winner.requestId,
        status: 'prompt_accepted' })).rejects.toThrow('existing prompt owner')
      const accepted = { ...first, requestId: winner.requestId,
        runtimePromptMessageId: winner.runtimePromptMessageId, status: 'prompt_accepted' as const,
        acceptedAt: '2026-09-10T00:00:00.000Z', sessionId: 'session-a', runtimePid: 123,
        sendMessageData: { accepted: true as const, memberName: first.memberName,
          sessionId: 'session-a', runtimePid: 123,
          runtimePromptMessageId: winner.runtimePromptMessageId!, diagnostics: [] } }
      await store.upsert(accepted)
      const restarted = new OpenCodeCommandOutcomeStore(file)
      for (const query of [{ deliveryAttemptId: 'attempt' },
        { requestId: winner.requestId, deliveryAttemptId: 'attempt' },
        { requestId: failed.requestId, deliveryAttemptId: 'attempt' },
        { requestId: failed.requestId }]) {
        expect((await restarted.query(query)).record).toMatchObject({
          requestId: winner.requestId, status: 'prompt_accepted', safeToRetry: false,
          runtimePromptMessageId: winner.runtimePromptMessageId, sendMessageData: accepted.sendMessageData,
        })
      }
      await expect(restarted.upsert({ ...losing, status: 'prompt_accepted' })).rejects.toThrow()
      await expect(restarted.upsert({ ...accepted, sessionId: 'foreign' })).rejects.toThrow('identity changed')
      await expect(restarted.upsert({ ...accepted, sendMessageData: {
        ...accepted.sendMessageData, runtimePromptMessageId: 'foreign' } })).rejects.toThrow('identity changed')
      await restarted.upsert({ ...accepted, acceptedAt: '2026-09-11T00:00:00.000Z' })
      expect((await restarted.query({ deliveryAttemptId: 'attempt' })).record?.acceptedAt).toBe(accepted.acceptedAt)
      await restarted.upsert({ ...accepted, sendMessageData: {
        accepted: true, memberName: first.memberName, diagnostics: [] } })
      expect((await restarted.query({ deliveryAttemptId: 'attempt' })).record?.sendMessageData)
        .toMatchObject(accepted.sendMessageData)
    })
  }

  test('a failed native generation must admit a new owner before acceptance', async () => {
    const store = await createStore()
    const failed = basePatch({ status: 'failed_before_accept', runtimePromptMessageId: 'old-prompt' })
    await store.upsert(failed)
    await expect(store.upsert({ ...failed, status: 'prompt_accepted' })).rejects.toThrow('admitted prompt owner')
    await expect(store.upsert({ ...failed, status: 'prompt_submitting' },
      { requireRetryable: true })).rejects.toThrow('new prompt owner')
    const admitted = await store.upsert({ ...failed, status: 'prompt_submitting',
      runtimePromptMessageId: 'new-prompt' }, { requireRetryable: true })
    expect(admitted).toMatchObject({ status: 'prompt_submitting', safeToRetry: false,
      runtimePromptMessageId: 'new-prompt' })
    await expect(store.upsert({ ...failed, status: 'prompt_accepted' })).rejects.toThrow('existing prompt')
    await store.upsert({ ...admitted, status: 'prompt_accepted' })
    expect((await store.query({ requestId: failed.requestId })).record?.runtimePromptMessageId).toBe('new-prompt')
  })

  test('retryable history cannot authorize conflicting delivery identities', async () => {
    const store = await createStore()
    const failed = basePatch({ status: 'failed_before_accept', deliveryAttemptId: 'attempt' })
    await store.upsert(failed)
    for (const field of ['payloadHash', 'messageId', 'runId', 'teamId', 'teamName',
      'laneId', 'memberName', 'projectPath'] as const) {
      for (const requestId of [failed.requestId, 'alias']) {
        await expect(store.upsert({ ...failed, requestId, [field]: 'foreign',
          status: 'prompt_submitting', runtimePromptMessageId: 'prompt' },
        { requireRetryable: true })).rejects.toThrow('identity changed')
      }
    }
    await expect(store.upsert({ ...failed, status: 'prompt_submitting',
      runtimePromptMessageId: 'prompt' })).rejects.toThrow('atomic admission')
    expect((await store.query({ deliveryAttemptId: 'attempt' })).record?.status).toBe('failed_before_accept')
  })

  test('uncertain submission stays fenced across failure, replay and restart', async () => {
    const store = await createStore()
    const submitted = basePatch({ status: 'prompt_submitting', deliveryAttemptId: 'attempt',
      runtimePromptMessageId: 'uncertain-prompt' })
    await store.upsert(submitted, { requireRetryable: true })
    await store.upsert({ ...submitted, status: 'failed_before_accept', error: 'response lost',
      completedAt: '2026-01-01T00:00:00.000Z' })
    const reopened = new OpenCodeCommandOutcomeStore(path.join(tempDir!, 'command-outcomes.json'))
    expect(await reopened.prune(1000, Date.parse('2026-09-10T00:00:00.000Z'))).toBe(0)
    expect((await reopened.query({ deliveryAttemptId: 'attempt' })).record).toMatchObject({
      status: 'prompt_submitting', safeToRetry: false, runtimePromptMessageId: 'uncertain-prompt' })
    await expect(reopened.upsert({ ...submitted, runtimePromptMessageId: 'replacement' },
      { requireRetryable: true })).rejects.toThrow()
    await expect(reopened.upsert({ ...submitted, requestId: 'alias' },
      { requireRetryable: true })).rejects.toThrow()
  })

  test('contradictory persisted owners and mismatched query keys fail closed', async () => {
    const store = await createStore()
    const a = await store.upsert(basePatch({ deliveryAttemptId: 'attempt', status: 'prompt_accepted',
      runtimePromptMessageId: 'prompt-a' }))
    const b = { ...a, requestId: 'other', runtimePromptMessageId: 'prompt-b' }
    await writeFile(path.join(tempDir!, 'command-outcomes.json'), JSON.stringify({
      schemaVersion: 1, records: { [a.requestId]: a, other: b },
    }))
    expect((await store.query({ deliveryAttemptId: 'attempt' })).record).toBeNull()
    expect((await store.query({ requestId: a.requestId })).record).toBeNull()
    expect((await store.query({ requestId: 'missing', deliveryAttemptId: 'attempt' })).record).toBeNull()
    expect((await store.query({ requestId: a.requestId, deliveryAttemptId: 'missing' })).record).toBeNull()
    await writeFile(path.join(tempDir!, 'command-outcomes.json'), JSON.stringify({
      schemaVersion: 1, records: { [a.requestId]: a,
        other: { ...b, status: 'failed_before_accept', safeToRetry: true, payloadHash: 'foreign' } },
    }))
    expect((await store.query({ deliveryAttemptId: 'attempt' })).record).toBeNull()
  })

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
