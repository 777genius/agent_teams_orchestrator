import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as lockfile from '../../../utils/lockfile.js'
import * as windowsGuard from './OpenCodeV2WindowsDeliveryGuard.js'
import { OpenCodeV2DeliveryJournal } from './OpenCodeV2DeliveryJournal.js'
import type { SendMessageOutcomeBase } from './OpenCodeBridgeDeliveryJournal.js'

const identity = { requestId: 'TEST-request', deliveryAttemptId: 'TEST-attempt',
  localMessageId: 'TEST-message', nativeInputID: 'msg_TESTlifecycle' }
const base: SendMessageOutcomeBase = { requestId: identity.requestId, teamId: 'TEST-team', teamName: 'TEST-team',
  runId: 'TEST-run', laneId: 'TEST-lane', memberName: 'TEST-worker', projectPath: '/TEST-project',
  body: { deliveryAttemptId: identity.deliveryAttemptId, messageId: identity.localMessageId } }

// Pure composition tests only: spies cannot mint Windows filesystem authority.
// The Windows-only sibling test qualifies the actual native guard and store.
test('Windows journal retains its original failure and all bounded cleanup failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-journal-lifecycle-'))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const events: string[] = []
  const primary = new Error('TEST_query_failure'), releaseFailure = new Error('TEST_release_failure')
  const assertFailure = new Error('TEST_guard_recheck_failure'), closeFailure = new Error('TEST_guard_close_failure')
  const deadline = Date.now() + 10_000
  let assertions = 0
  const guard = spyOn(windowsGuard, 'openWindowsDeliveryJournalGuard').mockImplementation(async (dataRoot, cutoff) => {
    expect(dataRoot).toBe(root); expect(cutoff).toBe(deadline); events.push('open')
    return { path: path.join(root, 'TEST-guard'), assertOwned: async () => {
      events.push('assert'); if (++assertions === 3) throw assertFailure
    }, close: async () => { events.push('close'); throw closeFailure } }
  })
  const lock = spyOn(lockfile, 'lock').mockImplementation(async () => {
    events.push('lock'); return async () => { events.push('release'); throw releaseFailure }
  })
  const journal = new OpenCodeV2DeliveryJournal(root)
  const query = spyOn(journal, 'query').mockImplementation(async () => { events.push('query'); throw primary })
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const failure = await journal.reserve(base, 'ses_TESTlifecycle', identity, 'a'.repeat(64), deadline).catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.cause).toBe(primary)
    expect(failure.errors).toEqual([primary, releaseFailure, assertFailure, closeFailure])
    expect(events).toEqual(['open', 'assert', 'lock', 'assert', 'query', 'release', 'assert', 'close'])
  } finally {
    Object.defineProperty(process, 'platform', platform)
    query.mockRestore(); lock.mockRestore(); guard.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows journal closes its retained guard after lock refusal without running a store operation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-journal-lock-refusal-'))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const events: string[] = [], primary = new Error('TEST_lock_refused')
  const deadline = Date.now() + 10_000
  const guard = spyOn(windowsGuard, 'openWindowsDeliveryJournalGuard').mockImplementation(async (_root, cutoff) => {
    expect(cutoff).toBe(deadline)
    return { path: path.join(root, 'TEST-guard'), assertOwned: async () => { events.push('assert') },
      close: async () => { events.push('close') } }
  })
  const lock = spyOn(lockfile, 'lock').mockRejectedValue(primary)
  const journal = new OpenCodeV2DeliveryJournal(root)
  const query = spyOn(journal, 'query')
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    await expect(journal.reserve(base, 'ses_TESTlifecycle', identity, 'a'.repeat(64), deadline)).rejects.toBe(primary)
    expect(query).not.toHaveBeenCalled()
    expect(events).toEqual(['assert', 'assert', 'close'])
  } finally {
    Object.defineProperty(process, 'platform', platform)
    query.mockRestore(); lock.mockRestore(); guard.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
