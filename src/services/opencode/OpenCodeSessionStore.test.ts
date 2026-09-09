import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import * as lockfile from '../../utils/lockfile.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import type { MaterializationOwnerToken } from './OpenCodeSessionStore.js'

const token = (attemptId: string, version = 1, sessionId = ''): MaterializationOwnerToken =>
  ({ attemptId, sessionId, version })

const baseRecord = {
  teamId: 'team-a',
  laneId: 'primary',
  memberName: 'alice',
  providerId: 'opencode' as const,
  selectedModel: 'openai/gpt-5.4',
  projectPath: '/tmp/project',
  profileRootKey: 'profile-root',
  hostKey: 'host-key',
  resolvedBehaviorFingerprint: null,
  opencodeSessionId: 'session-1',
  lastCanonicalCursor: null,
  lastKnownRawStatus: null,
  lastKnownDurableState: null,
  sourceAuthFingerprint: null,
  managedAuthFingerprint: null,
  projectBehaviorFingerprint: 'behavior-v1',
  staleReason: null,
  createdAt: '2026-04-21T00:00:00.000Z',
  updatedAt: '2026-04-21T00:00:00.000Z',
}

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-store-test-'))
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

describe('OpenCodeSessionStore', () => {
  test('upserts and reads records', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))

    expect(await store.upsert(baseRecord)).toBe('created')
    expect(await store.get(baseRecord.teamId, baseRecord.memberName)).toEqual(baseRecord)
    expect(await store.list()).toEqual([baseRecord])
  })

  test('returns unchanged for identical record and marks stale explicitly', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))

    expect(await store.upsert(baseRecord)).toBe('created')
    expect(await store.upsert(baseRecord)).toBe('unchanged')

    const stale = await store.markStale(baseRecord.teamId, baseRecord.memberName, 'auth_stale')
    expect(stale?.staleReason).toBe('auth_stale')
    expect(stale?.updatedAt).not.toBe(baseRecord.updatedAt)
  })

  test('deletes records cleanly', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))

    await store.upsert(baseRecord)
    expect(await store.delete(baseRecord.teamId, baseRecord.memberName)).toBe(true)
    expect(await store.get(baseRecord.teamId, baseRecord.memberName)).toBeNull()
  })

  test('stores sibling OpenCode lanes independently for the same team/member pair', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const primary = { ...baseRecord, laneId: 'primary', opencodeSessionId: 'session-primary' }
    const secondary = {
      ...baseRecord,
      laneId: 'secondary:opencode:alice',
      opencodeSessionId: 'session-secondary',
    }

    expect(await store.upsert(primary)).toBe('created')
    expect(await store.upsert(secondary)).toBe('created')
    expect(await store.get(baseRecord.teamId, 'primary', baseRecord.memberName)).toEqual(primary)
    expect(
      await store.get(baseRecord.teamId, 'secondary:opencode:alice', baseRecord.memberName),
    ).toEqual(secondary)
    expect(await store.list()).toHaveLength(2)
  })

  test('atomically assigns materialization to one attempt and commits only its claim', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const identity = {
      teamId: baseRecord.teamId,
      laneId: baseRecord.laneId,
      memberName: baseRecord.memberName,
    }

    const claims = await Promise.all([
      store.claimMaterialization(identity, 'attempt-a'),
      store.claimMaterialization(identity, 'attempt-b'),
    ])
    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'claimed' }),
      { kind: 'owned_by_other' },
    ]))
    const winningClaim = claims.find(claim => claim.kind === 'claimed')
    if (!winningClaim || winningClaim.kind !== 'claimed') throw new Error('missing winning claim')
    const loser = winningClaim.ownerToken.attemptId === 'attempt-a' ? 'attempt-b' : 'attempt-a'
    expect(await store.commitMaterialization(baseRecord, token(loser))).toBeNull()
    expect(await store.commitMaterialization(baseRecord, winningClaim.ownerToken)).not.toBeNull()
    expect(await store.markStaleIfSession(baseRecord, 'launch_failed', token(loser))).toBeNull()
    expect(await store.deleteIfSession(baseRecord, token(loser))).toBe(false)
    expect(await store.get(baseRecord.teamId, baseRecord.memberName)).toEqual(baseRecord)
  })

  test('distinguishes a newly acquired claim from a replay by the same attempt', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const identity = {
      teamId: baseRecord.teamId,
      laneId: baseRecord.laneId,
      memberName: baseRecord.memberName,
    }

    expect(await store.claimMaterialization(identity, 'attempt-a')).toEqual(expect.objectContaining({ kind: 'claimed' }))
    expect(await store.claimMaterialization(identity, 'attempt-a')).toEqual({ kind: 'owned_by_other' })
    expect(await store.claimMaterialization(identity, 'attempt-b')).toEqual({ kind: 'owned_by_other' })
  })

  test('rejects an already-aborted claim before touching the store and preserves no-signal callers', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const store = new OpenCodeSessionStore(filePath)
    const identity = {
      teamId: baseRecord.teamId,
      laneId: baseRecord.laneId,
      memberName: baseRecord.memberName,
    }
    const controller = new AbortController()
    const abortReason = new Error('claim already cancelled')
    controller.abort(abortReason)

    await expect(
      store.claimMaterialization(identity, 'attempt-a', undefined, controller.signal),
    ).rejects.toBe(abortReason)
    expect(await Bun.file(`${filePath}.lock`).exists()).toBe(false)
    expect(await store.claimMaterialization(identity, 'attempt-b')).toEqual(expect.objectContaining({ kind: 'claimed' }))
  })

  test('aborts a contended materialization claim promptly without a late claim', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const lockPath = `${filePath}.lock`
    const store = new OpenCodeSessionStore(filePath)
    const identity = {
      teamId: baseRecord.teamId,
      laneId: baseRecord.laneId,
      memberName: baseRecord.memberName,
    }
    const successfulMember = {
      ...baseRecord,
      memberName: 'bob',
      opencodeSessionId: 'session-bob',
    }
    await store.upsert(successfulMember)
    await writeFile(lockPath, '')
    const releaseBlocker = await lockfile.lock(lockPath, { retries: 0 })
    const controller = new AbortController()
    const abortReason = new Error('cancel contended claim')
    const pendingClaim = store.claimMaterialization(identity, 'attempt-a', undefined, controller.signal)
    const outcomePromise = pendingClaim.then(
      value => ({ kind: 'resolved' as const, value }),
      error => ({ kind: 'rejected' as const, error }),
    )

    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort(abortReason)
    let timeout: ReturnType<typeof setTimeout> | undefined
    let outcome: Awaited<typeof outcomePromise> | { kind: 'timeout' }
    try {
      outcome = await Promise.race([
        outcomePromise,
        new Promise<{ kind: 'timeout' }>(resolve => {
          timeout = setTimeout(() => resolve({ kind: 'timeout' }), 100)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      await releaseBlocker()
    }
    await outcomePromise
    await new Promise(resolve => setTimeout(resolve, 125))

    expect(outcome).toEqual({ kind: 'rejected', error: abortReason })
    expect(await store.claimMaterialization(identity, 'attempt-b')).toEqual(expect.objectContaining({ kind: 'claimed' }))
    expect(await store.get('team-a', 'primary', 'bob')).toEqual(successfulMember)
  })

  test('releases a lock acquired at the abort boundary without running the claim callback', async () => {
    const controller = new AbortController()
    const abortReason = new Error('cancel at acquisition boundary')
    let lockCalls = 0
    let releaseCalls = 0
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'), {
      lock: async () => {
        lockCalls += 1
        if (lockCalls === 1) controller.abort(abortReason)
        return async () => { releaseCalls += 1 }
      },
    })
    const identity = {
      teamId: baseRecord.teamId,
      laneId: baseRecord.laneId,
      memberName: baseRecord.memberName,
    }

    await expect(
      store.claimMaterialization(identity, 'attempt-a', undefined, controller.signal),
    ).rejects.toBe(abortReason)
    expect(releaseCalls).toBe(1)
    expect(await store.claimMaterialization(identity, 'attempt-b')).toEqual(expect.objectContaining({ kind: 'claimed' }))
    expect(releaseCalls).toBe(2)
  })

  test('aborts while a lock attempt is still pending and releases a late acquisition once', async () => {
    const controller = new AbortController()
    const abortReason = new Error('cancel pending lock operation')
    let resolveLock!: (release: () => Promise<void>) => void
    let notifyLockStarted!: () => void
    const lockStarted = new Promise<void>(resolve => { notifyLockStarted = resolve })
    let releaseCalls = 0
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'), {
      lock: (() => {
        notifyLockStarted()
        return new Promise(resolve => { resolveLock = resolve })
      }) as typeof lockfile.lock,
    })
    const identity = {
      teamId: baseRecord.teamId,
      laneId: baseRecord.laneId,
      memberName: baseRecord.memberName,
    }

    const pendingClaim = store.claimMaterialization(
      identity,
      'attempt-a',
      'run-a',
      controller.signal,
    )
    await lockStarted
    controller.abort(abortReason)
    await expect(pendingClaim).rejects.toBe(abortReason)

    let drainSettled = false
    const drain = store.drainPendingLateLockReleases().then(() => { drainSettled = true })
    await Promise.resolve()
    expect(drainSettled).toBe(false)

    resolveLock(async () => { releaseCalls += 1 })
    await drain
    expect(drainSettled).toBe(true)
    expect(releaseCalls).toBe(1)
  })

  test('reports a failed late release after cancellation', async () => {
    const controller = new AbortController()
    const abortReason = new Error('cancel pending lock operation')
    const releaseError = new Error('late lock release failed')
    let resolveLock!: (release: () => Promise<void>) => void
    let notifyLockStarted!: () => void
    const lockStarted = new Promise<void>(resolve => { notifyLockStarted = resolve })
    let notifyReleaseError!: () => void
    const releaseErrorReported = new Promise<void>(resolve => { notifyReleaseError = resolve })
    const reportedErrors: unknown[] = []
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'), {
      lock: (() => {
        notifyLockStarted()
        return new Promise(resolve => { resolveLock = resolve })
      }) as typeof lockfile.lock,
      onLateLockReleaseError: error => {
        reportedErrors.push(error)
        notifyReleaseError()
      },
    })

    const pendingClaim = store.claimMaterialization(baseRecord, 'attempt-a', 'run-a', controller.signal)
    await lockStarted
    controller.abort(abortReason)
    await expect(pendingClaim).rejects.toBe(abortReason)
    resolveLock(async () => { throw releaseError })
    await releaseErrorReported

    expect(reportedErrors).toEqual([releaseError])
  })

  test('keeps a completed claim fenced when lock release reports an unknown outcome', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const releaseError = new Error('lock release failed')
    const store = new OpenCodeSessionStore(filePath, {
      lock: (async () => async () => { throw releaseError }) as typeof lockfile.lock,
    })
    const identity = {
      teamId: baseRecord.teamId,
      laneId: baseRecord.laneId,
      memberName: baseRecord.memberName,
    }

    await expect(store.claimMaterialization(identity, 'attempt-a', 'run-a'))
      .rejects.toBe(releaseError)

    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    expect(JSON.parse(persisted.materializationClaims['team-a::primary::alice'])).toEqual(token('attempt-a'))
    expect(persisted.materializationClaimRuns['team-a::primary::alice']).toBe('run-a')
  })

  test('treats an exact committed owner replay as an idempotent commit', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const releaseError = new Error('commit lock release failed')
    let releaseCalls = 0
    const store = new OpenCodeSessionStore(filePath, {
      lock: (async () => async () => {
        releaseCalls += 1
        if (releaseCalls === 2) throw releaseError
      }) as typeof lockfile.lock,
    })
    const record = { ...baseRecord, runId: 'run-a' }

    expect(await store.claimMaterialization(record, 'attempt-a', 'run-a')).toEqual(expect.objectContaining({ kind: 'claimed' }))
    await expect(store.commitMaterialization(record, token('attempt-a'))).rejects.toBe(releaseError)
    expect(await store.commitMaterialization(record, token('attempt-a'))).not.toBeNull()
    expect(await store.commitMaterialization({ ...record, selectedModel: 'foreign/model' }, token('attempt-a')))
      .toBeNull()
  })

  test('clears the pending retry timer when lock acquisition is aborted', async () => {
    const controller = new AbortController()
    const abortReason = new Error('cancel retry timer')
    const timerHandle = {} as ReturnType<typeof setTimeout>
    let signalTimerScheduled!: () => void
    const timerScheduled = new Promise<void>(resolve => { signalTimerScheduled = resolve })
    let clearedTimer: ReturnType<typeof setTimeout> | undefined
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'), {
      lock: async () => {
        throw Object.assign(new Error('contended'), { code: 'ELOCKED' })
      },
      setTimer: (() => {
        signalTimerScheduled()
        return timerHandle
      }) as typeof setTimeout,
      clearTimer: (timer) => { clearedTimer = timer },
    })
    const identity = {
      teamId: baseRecord.teamId,
      laneId: baseRecord.laneId,
      memberName: baseRecord.memberName,
    }

    const pendingClaim = store.claimMaterialization(identity, 'attempt-a', undefined, controller.signal)
    await timerScheduled
    controller.abort(abortReason)

    await expect(pendingClaim).rejects.toBe(abortReason)
    expect(clearedTimer).toBe(timerHandle)
  })

  test('conditional cleanup never mutates or deletes a replacement session', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const replacement = { ...baseRecord, opencodeSessionId: 'session-winner' }
    await store.upsert(replacement)

    expect(await store.markStaleIfSession(baseRecord, 'launch_failed')).toBeNull()
    expect(await store.deleteIfSession(baseRecord)).toBe(false)
    expect(await store.get(baseRecord.teamId, baseRecord.memberName)).toEqual(replacement)
  })
  test('confirmed stop is exact-run/session CAS and permits only a different run to claim replacement', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'sessions.json'))
    const record = { ...baseRecord, runId: 'run-1' }
    expect(await store.claimMaterialization(record, 'old-attempt', 'run-1')).toEqual(expect.objectContaining({ kind: 'claimed' }))
    expect(await store.commitMaterialization(record, token('old-attempt'))).not.toBeNull()
    expect(await store.markStoppedIfSession({ ...record, runId: 'older-run' })).toBeNull()
    expect(await store.markStoppedIfSession({ ...record, opencodeSessionId: 'other-session' })).toBeNull()
    expect(await store.markStoppedIfSession({ ...record, hostKey: 'other-host' })).toBeNull()
    const stopped = await store.markStoppedIfSession(record)
    expect(stopped?.stoppedAt).toBeDefined()
    expect(await store.markStoppedIfSession(record)).toEqual(stopped)
    expect(await store.claimMaterialization(record, 'same-run-attempt', 'run-1')).toEqual({ kind: 'existing', record: stopped, ownerToken: token('old-attempt', 1, record.opencodeSessionId) })
    expect(await store.claimMaterialization(record, 'legacy-attempt')).toEqual({ kind: 'existing', record: stopped, ownerToken: token('old-attempt', 1, record.opencodeSessionId) })
    expect(await store.claimMaterialization(record, 'new-attempt', 'run-2')).toEqual(expect.objectContaining({ kind: 'claimed' }))
    expect(await store.commitMaterialization({ ...record, runId: 'run-2', opencodeSessionId: 'session-2' }, token('new-attempt', 2))).not.toBeNull()
    expect(await store.markStoppedIfSession(record)).toBeNull()
    expect((await store.get('team-a', 'primary', 'alice'))?.stoppedAt).toBeUndefined()
    expect(await store.deleteIfSession(record, token('old-attempt', 1, record.opencodeSessionId))).toBe(false)
  })

  test('terminal Stop CAS rejects dead-runtime retirement even with matching retained authority', async () => {
    const file = path.join(tempDir, 'sessions.json')
    const store = new OpenCodeSessionStore(file)
    const record = { ...baseRecord, runId: 'old-run',
      profileScope: { purpose: 'launch_runtime' as const, providerId: 'openai', scopeToken: 'scope',
        configFingerprint: 'config', selectedAuthIdentity: 'absent' as const },
      stopAuthority: { runtime: { providerId: 'opencode' as const, binaryPath: 'opencode',
        binaryFingerprint: null, version: null, capabilitySnapshotId: `opencode:${'a'.repeat(32)}` },
        expectedBehaviorFingerprint: 'b'.repeat(64) },
    }
    await store.upsert(record)
    const retired = await new OpenCodeSessionStore(file).retireAbsentRuntimeIfSession(record, 'next-run')
    expect(retired?.staleReason).toBe('runtime_process_gone')
    expect(retired?.stopAuthority).toEqual(record.stopAuthority)
    const before = await readFile(file, 'utf8')
    expect(await store.markStoppedIfSession(record, record.stopAuthority)).toBeNull()
    expect(await store.markStoppedIfSession(record)).toBeNull()
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await store.get(record.teamId, record.laneId, record.memberName)).toEqual(retired)
  })

  test('atomically replaces an ownerless stale legacy session when a strict run is introduced', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'stale-legacy-sessions.json'))
    const legacy = { ...baseRecord, staleReason: 'managed_auth_changed' }
    const identity = {
      teamId: legacy.teamId,
      laneId: legacy.laneId,
      memberName: legacy.memberName,
    }
    await store.upsert(legacy)

    const claim = await store.claimMaterialization(identity, 'strict-attempt', 'strict-run')
    expect(claim).toEqual(expect.objectContaining({ kind: 'claimed' }))
    if (claim.kind !== 'claimed') throw new Error('missing strict replacement claim')
    expect(await store.get(legacy.teamId, legacy.laneId, legacy.memberName)).toEqual(legacy)

    const successor = {
      ...legacy,
      runId: 'strict-run',
      opencodeSessionId: 'strict-session',
      staleReason: null,
    }
    expect(await store.commitMaterialization(successor, claim.ownerToken)).not.toBeNull()
    expect(await store.get(legacy.teamId, legacy.laneId, legacy.memberName)).toEqual(successor)
  })

  test('keeps clean and unknown-outcome legacy sessions fenced from strict replacement', async () => {
    for (const [name, staleReason] of [
      ['clean', null],
      ['unknown-outcome', 'launch_failed'],
    ] as const) {
      const store = new OpenCodeSessionStore(path.join(tempDir, `${name}-legacy-sessions.json`))
      const legacy = { ...baseRecord, staleReason }
      await store.upsert(legacy)
      expect(await store.claimMaterialization(legacy, 'strict-attempt', 'strict-run')).toEqual({
        kind: 'existing',
        record: legacy,
        ownerToken: null,
      })
    }
  })

  test('cancelled different-run replacement preserves the stopped record and old owner until retry commit', async () => {
    const filePath = path.join(tempDir, 'sessions.json')
    const store = new OpenCodeSessionStore(filePath)
    const record = { ...baseRecord, runId: 'run-1' }
    const identity = {
      teamId: record.teamId,
      laneId: record.laneId,
      memberName: record.memberName,
    }
    expect(await store.claimMaterialization(identity, 'old-attempt', 'run-1')).toEqual(expect.objectContaining({ kind: 'claimed' }))
    expect(await store.commitMaterialization(record, token('old-attempt'))).not.toBeNull()
    const stopped = await store.markStoppedIfSession(record)
    expect(stopped?.stoppedAt).toBeDefined()

    const controller = new AbortController()
    expect(await store.claimMaterialization(identity, 'cancelled-attempt', 'run-2', controller.signal))
      .toEqual(expect.objectContaining({ kind: 'claimed' }))
    controller.abort(new Error('cancel immediately after replacement claim'))
    const claimedState = JSON.parse(await readFile(filePath, 'utf8'))
    expect(claimedState.records['team-a::primary::alice']).toEqual(stopped)
    expect(JSON.parse(claimedState.materializationClaims['team-a::primary::alice'])).toEqual(token('cancelled-attempt', 2))
    expect(claimedState.materializationClaimRuns['team-a::primary::alice']).toBe('run-2')
    expect(claimedState.materializationOwners['team-a::primary::alice']).toEqual(token('old-attempt', 1, record.opencodeSessionId))

    expect(await store.releaseMaterializationClaim(identity, token('cancelled-attempt', 2))).toBe(true)
    const cancelledState = JSON.parse(await readFile(filePath, 'utf8'))
    expect(cancelledState.records['team-a::primary::alice']).toEqual(stopped)
    expect(cancelledState.materializationClaims['team-a::primary::alice']).toBeUndefined()
    expect(cancelledState.materializationClaimRuns['team-a::primary::alice']).toBeUndefined()
    expect(cancelledState.materializationOwners['team-a::primary::alice']).toEqual(token('old-attempt', 1, record.opencodeSessionId))
    expect(await store.claimMaterialization(identity, 'same-run-attempt', 'run-1'))
      .toEqual({ kind: 'existing', record: stopped, ownerToken: token('old-attempt', 1, record.opencodeSessionId) })
    expect(await store.claimMaterialization(identity, 'missing-run-attempt'))
      .toEqual({ kind: 'existing', record: stopped, ownerToken: token('old-attempt', 1, record.opencodeSessionId) })

    expect(await store.claimMaterialization(identity, 'retry-attempt', 'run-2')).toEqual(expect.objectContaining({ kind: 'claimed' }))
    expect(await store.commitMaterialization({
      ...record, runId: 'run-2', opencodeSessionId: 'wrong-owner',
    }, token('other-attempt', 3)))
      .toBeNull()
    expect(await store.commitMaterialization({ ...record, opencodeSessionId: 'same-run' }, token('retry-attempt', 3)))
      .toBeNull()
    expect(await store.get(record.teamId, record.laneId, record.memberName)).toEqual(stopped)
    const fencedState = JSON.parse(await readFile(filePath, 'utf8'))
    expect(JSON.parse(fencedState.materializationClaims['team-a::primary::alice'])).toEqual(token('retry-attempt', 3))
    expect(fencedState.materializationClaimRuns['team-a::primary::alice']).toBe('run-2')
    expect(fencedState.materializationOwners['team-a::primary::alice']).toEqual(token('old-attempt', 1, record.opencodeSessionId))
    const successor = { ...record, runId: 'run-2', opencodeSessionId: 'session-2' }
    expect(await store.commitMaterialization(successor, token('retry-attempt', 3))).not.toBeNull()
    const committedState = JSON.parse(await readFile(filePath, 'utf8'))
    expect(committedState.records['team-a::primary::alice']).toEqual(successor)
    expect(committedState.materializationClaims['team-a::primary::alice']).toBeUndefined()
    expect(committedState.materializationClaimRuns['team-a::primary::alice']).toBeUndefined()
    expect(committedState.materializationOwners['team-a::primary::alice']).toEqual(token('retry-attempt', 3, successor.opencodeSessionId))
  })

  test('binds a materialization claim to its requested run', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'sessions.json'))
    const record = { ...baseRecord, runId: 'run-1' }
    const identity = {
      teamId: record.teamId,
      laneId: record.laneId,
      memberName: record.memberName,
    }

    expect(await store.claimMaterialization(identity, 'shared-attempt', 'run-1'))
      .toEqual(expect.objectContaining({ kind: 'claimed' }))
    expect(await store.claimMaterialization(identity, 'shared-attempt', 'run-2'))
      .toEqual({ kind: 'owned_by_other' })
    expect(await store.commitMaterialization({ ...record, runId: 'run-2' }, token('shared-attempt')))
      .toBeNull()
    expect(await store.releaseMaterializationClaim(identity, token('shared-attempt'), 'run-2'))
      .toBe(false)
    expect(await store.releaseMaterializationClaim(identity, token('shared-attempt'), 'run-1'))
      .toBe(true)
  })

  test('stopped replacement keeps unknown create claims fenced and malformed markers inactive', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'sessions.json'))
    const record = { ...baseRecord, runId: 'run-1' }
    await writeFile(path.join(tempDir, 'sessions.json'), JSON.stringify({ schemaVersion: 1,
      records: { 'team-a::primary::alice': record },
      materializationClaims: { 'team-a::primary::alice': 'unknown-attempt' } }))
    const stopped = await store.markStoppedIfSession(record)
    expect(await store.claimMaterialization(record, 'new-attempt', 'run-2')).toEqual({ kind: 'owned_by_other' })
    expect(await store.claimMaterialization(record, 'unknown-attempt', 'run-2')).toEqual({ kind: 'owned_by_other' })
    expect(await store.get('team-a', 'primary', 'alice')).toEqual(stopped)
    const malformedStore = new OpenCodeSessionStore(path.join(tempDir, 'malformed.json'))
    for (const stoppedAt of ['', 'invalid', '1']) {
      const malformed = { ...record, stoppedAt }
      await malformedStore.upsert(malformed)
      expect(await malformedStore.claimMaterialization(record, 'new-attempt', 'run-2')).toEqual({ kind: 'existing', record: malformed, ownerToken: null })
    }
  })

  test('old observer writes cannot erase stop, cross an active claim, or replace the successor', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'sessions.json'))
    const old = { ...baseRecord, runId: 'run-1', profileScope: { purpose: 'launch_runtime' as const,
      providerId: 'openai', scopeToken: 'scope', configFingerprint: 'config', selectedAuthIdentity: 'absent' as const } }
    await store.upsert(old)
    const stopped = await store.markStoppedIfSession(old)
    await expect(store.upsert(old)).rejects.toThrow('stopped session')
    expect(await store.markStale('team-a', 'primary', 'alice', 'late-observer', old)).toBeNull()
    expect(await store.markStaleIfSession(old, 'late-failed-launch')).toBeNull()
    expect(await store.deleteIfSession(old)).toBe(false)
    expect(await store.get('team-a', 'primary', 'alice')).toEqual(stopped)
    expect(await store.upsert(stopped!)).toBe('unchanged')
    expect(await store.claimMaterialization(old, 'new-attempt', 'run-2')).toEqual(expect.objectContaining({ kind: 'claimed' }))
    await expect(store.upsert(old)).rejects.toThrow('materialization claim')
    const next = { ...old, runId: 'run-2', opencodeSessionId: 'session-2' }
    expect(await store.commitMaterialization(next, token('new-attempt'))).not.toBeNull()
    await expect(store.upsert(old)).rejects.toThrow('materialization owner')
    await expect(store.upsert({ ...next, runId: undefined })).rejects.toThrow('materialization owner')
    expect(await store.markStale('team-a', 'primary', 'alice', 'late-observer', old)).toBeNull()
    expect(await store.markStale('team-a', 'primary', 'alice', 'generic-observer', next)).toBeNull()
    expect(await store.get('team-a', 'primary', 'alice')).toEqual(next)
  })

  test('drains a tracked materialization reconciliation before command cleanup completes', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    let resolveReconciliation!: () => void
    const reconciliation = new Promise<void>(resolve => { resolveReconciliation = resolve })
    store.trackPendingMaterializationReconciliation(reconciliation)

    let drained = false
    const drain = store.drainPendingLateLockReleases().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)

    resolveReconciliation()
    await drain
    expect(drained).toBe(true)
  })

  test('keeps an active owner and rejects its stale token after exact release', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const record = { ...baseRecord, runId: 'run-1' }
    expect(await store.claimMaterialization(record, 'old-attempt', 'run-1'))
      .toEqual(expect.objectContaining({ kind: 'claimed' }))
    expect(await store.commitMaterialization(record, token('old-attempt'))).not.toBeNull()

    const oldOwner = token('old-attempt', 1, record.opencodeSessionId)
    expect(await store.acquireMaterializationOwner(record, 'new-attempt', undefined, oldOwner))
      .toBeNull()
    expect(await store.observeMaterialization(record)).toEqual({ record, ownerToken: oldOwner })
    expect(await store.releaseMaterializationOwner(record, oldOwner)).toBe(true)
    expect(await store.releaseMaterializationOwner(record, oldOwner)).toBe(false)
    expect(await store.markStaleIfSession(record, 'stale-token', oldOwner)).toBeNull()
    await expect(store.upsert({ ...record, updatedAt: '2026-04-21T00:02:00.000Z' }, oldOwner))
      .rejects.toThrow('fenced by a materialization owner')
    expect(await store.deleteIfSession(record, oldOwner)).toBe(false)
    expect(await store.get(record.teamId, record.laneId, record.memberName)).toEqual(record)

    const newOwner = token('new-attempt', 2, record.opencodeSessionId)
    expect(await store.acquireMaterializationOwner(record, 'new-attempt', undefined, null))
      .toEqual(newOwner)
    const changed = await store.markStaleIfSession(record, 'new-state', newOwner)
    expect(changed?.staleReason).toBe('new-state')
  })

  test('normalizes legacy owner tokens and preserves their fencing version', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const store = new OpenCodeSessionStore(filePath)
    const record = { ...baseRecord, runId: 'run-1' }
    const key = 'team-a::primary::alice'
    await writeFile(filePath, JSON.stringify({
      schemaVersion: 1,
      records: { [key]: record },
      materializationOwners: {
        [key]: { attemptId: 'legacy-attempt', sessionId: record.opencodeSessionId },
      },
      materializationOwnerVersions: { [key]: 4 },
    }))

    const legacyOwner = token('legacy-attempt', 5, record.opencodeSessionId)
    expect(await store.observeMaterialization(record)).toEqual({ record, ownerToken: legacyOwner })
    expect(await store.upsert({ ...record, updatedAt: '2026-04-21T00:01:00.000Z' }, legacyOwner))
      .toBe('updated')
    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    expect(persisted.materializationOwners[key]).toEqual(legacyOwner)
    expect(persisted.materializationOwnerVersions[key]).toBe(5)

    expect(await store.releaseMaterializationOwner(record, legacyOwner)).toBe(true)
    expect(await store.acquireMaterializationOwner(
      { ...record, updatedAt: '2026-04-21T00:01:00.000Z' },
      'new-attempt',
      undefined,
      null,
    )).toEqual(token('new-attempt', 6, record.opencodeSessionId))
  })

  test('keeps concurrent same-attempt replays fenced while the original owner is active', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const record = { ...baseRecord, runId: 'run-1' }
    expect(await store.claimMaterialization(record, 'attempt-a', 'run-1'))
      .toEqual(expect.objectContaining({ kind: 'claimed' }))
    expect(await store.commitMaterialization(record, token('attempt-a'))).not.toBeNull()

    const [firstObservation, secondObservation] = await Promise.all([
      store.claimMaterialization(record, 'attempt-a', 'run-1'),
      store.claimMaterialization(record, 'attempt-a', 'run-1'),
    ])
    expect(firstObservation.kind).toBe('existing')
    expect(secondObservation.kind).toBe('existing')
    if (firstObservation.kind !== 'existing' || secondObservation.kind !== 'existing') {
      throw new Error('both replays must observe the incomplete record')
    }

    const transfers = await Promise.all([
      store.acquireMaterializationOwner(record, 'attempt-a', undefined, firstObservation.ownerToken),
      store.acquireMaterializationOwner(record, 'attempt-a', undefined, secondObservation.ownerToken),
    ])
    expect(transfers.filter(Boolean)).toHaveLength(0)
    const consumed = await store.claimMaterialization(record, 'attempt-a', 'run-1')
    expect(consumed).toMatchObject({ kind: 'existing', ownerToken: {
      attemptId: 'attempt-a', sessionId: record.opencodeSessionId, version: 1,
    } })
  })

  test('does not let concurrent retries take over an active incomplete-session owner', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const record = { ...baseRecord, runId: 'run-1' }
    expect(await store.claimMaterialization(record, 'attempt-a', 'run-1'))
      .toEqual(expect.objectContaining({ kind: 'claimed' }))
    expect(await store.commitMaterialization(record, token('attempt-a'))).not.toBeNull()

    const [observedByB, observedByC] = await Promise.all([
      store.claimMaterialization(record, 'attempt-b', 'run-1'),
      store.claimMaterialization(record, 'attempt-c', 'run-1'),
    ])
    expect(observedByB.kind).toBe('existing')
    expect(observedByC.kind).toBe('existing')
    if (observedByB.kind !== 'existing' || observedByC.kind !== 'existing') {
      throw new Error('both retries must observe the incomplete record')
    }
    expect(observedByB.ownerToken).toEqual(observedByC.ownerToken)

    const transfers = await Promise.all([
      store.acquireMaterializationOwner(record, 'attempt-b', undefined, observedByB.ownerToken),
      store.acquireMaterializationOwner(record, 'attempt-c', undefined, observedByC.ownerToken),
    ])
    expect(transfers.filter(Boolean)).toHaveLength(0)
    expect(await store.observeMaterialization(record)).toEqual({
      record,
      ownerToken: token('attempt-a', 1, record.opencodeSessionId),
    })
  })

  test('persists owner PID when start time is unavailable and reclaims a dead owner', async () => {
    const filePath = path.join(tempDir, 'session-store-no-start-time.json')
    const record = { ...baseRecord, runId: 'run-no-start-time' }
    let alive = true
    let startTimeRead: number | null = null
    const store = new OpenCodeSessionStore(filePath, {
      ownerPid: 111,
      isProcessAlive: () => alive,
      readProcessStartTimeMs: async () => startTimeRead,
    })
    const claim = await store.claimMaterialization(record, 'attempt-a', record.runId)
    if (claim.kind !== 'claimed') throw new Error('expected materialization claim')
    const owner = await store.commitMaterialization(record, claim.ownerToken)
    expect(owner).not.toBeNull()
    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    expect(persisted.materializationOwnerProcesses['team-a::primary::alice']).toEqual({
      pid: 111, startedAtMs: null,
    })
    startTimeRead = 2_222
    expect(await store.releaseInactiveMaterializationOwner(record, owner!)).toBe(false)
    alive = false
    expect(await store.releaseInactiveMaterializationOwner(record, owner!)).toBe(true)
  })

  test('takes over only after persisted process identity proves the owner exited or changed', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const record = { ...baseRecord, runId: 'run-1' }
    const alive = new Map([[111, true], [222, true]])
    const startedAt = new Map([[111, 1_000], [222, 2_000]])
    const storeFor = (ownerPid: number) => new OpenCodeSessionStore(filePath, {
      ownerPid,
      isProcessAlive: pid => alive.get(pid) ?? false,
      readProcessStartTimeMs: async pid => startedAt.get(pid) ?? null,
    })
    const original = storeFor(111)
    const claim = await original.claimMaterialization(record, 'attempt-a', 'run-1')
    expect(claim.kind).toBe('claimed')
    if (claim.kind !== 'claimed') throw new Error('expected original materialization claim')
    const originalOwner = await original.commitMaterialization(record, claim.ownerToken)
    expect(originalOwner).not.toBeNull()

    const retry = storeFor(222)
    expect(await retry.isMaterializationOwnerActive(record, originalOwner!)).toBe(true)
    expect(await retry.acquireMaterializationOwner(record, 'attempt-b', undefined, originalOwner))
      .toBeNull()
    expect(await retry.releaseInactiveMaterializationOwner(record, originalOwner!)).toBe(false)

    // The PID still exists, but a different start time proves it was reused.
    startedAt.set(111, 1_001)
    expect(await retry.isMaterializationOwnerActive(record, originalOwner!)).toBe(false)
    expect(await retry.releaseInactiveMaterializationOwner(record, originalOwner!)).toBe(true)
    expect(await retry.observeMaterialization(record)).toEqual({ record, ownerToken: null })
    const successor = await retry.acquireMaterializationOwner(record, 'attempt-b', undefined, null)
    expect(successor).toEqual(token('attempt-b', 2, record.opencodeSessionId))
    expect(await retry.releaseInactiveMaterializationOwner(record, originalOwner!)).toBe(false)
    expect(await retry.observeMaterialization(record)).toEqual({ record, ownerToken: successor })
  })

  test('aborts owner takeover and release after asynchronous liveness checks', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const record = { ...baseRecord, runId: 'run-1' }
    const key = 'team-a::primary::alice'
    const owner = token('attempt-a', 1, record.opencodeSessionId)

    const exercise = async (operation: 'acquire' | 'release') => {
      await writeFile(filePath, JSON.stringify({
        schemaVersion: 1,
        records: { [key]: record },
        materializationOwners: { [key]: owner },
        materializationOwnerVersions: { [key]: 1 },
        materializationOwnerProcesses: { [key]: { pid: 111, startedAtMs: 1_000 } },
      }))
      let notifyOwnerRead!: () => void
      const ownerReadStarted = new Promise<void>(resolve => { notifyOwnerRead = resolve })
      let resolveOwnerRead!: (value: number) => void
      const store = new OpenCodeSessionStore(filePath, {
        ownerPid: 222,
        isProcessAlive: pid => pid === 111 || pid === 222,
        readProcessStartTimeMs: async pid => {
          if (pid === 222) return 2_000
          notifyOwnerRead()
          return new Promise<number>(resolve => { resolveOwnerRead = resolve })
        },
      })
      const controller = new AbortController()
      const abortReason = new Error(`cancel owner ${operation}`)
      const pending = operation === 'acquire'
        ? store.acquireMaterializationOwner(record, 'attempt-b', controller.signal, owner)
        : store.releaseInactiveMaterializationOwner(record, owner, controller.signal)
      await ownerReadStarted
      controller.abort(abortReason)
      resolveOwnerRead(1_001)
      await expect(pending).rejects.toBe(abortReason)
      expect(await store.observeMaterialization(record)).toEqual({ record, ownerToken: owner })
    }

    await exercise('acquire')
    await exercise('release')
  })

  test('generic stale marking proceeds after a materialization owner process is proven inactive', async () => {
    const filePath = path.join(tempDir, 'inactive-owner.json')
    const record = { ...baseRecord, runId: 'run-1' }
    const key = 'team-a::primary::alice'
    const owner = token('attempt-a', 1, record.opencodeSessionId)
    await writeFile(filePath, JSON.stringify({
      schemaVersion: 1,
      records: { [key]: record },
      materializationOwners: { [key]: owner },
      materializationOwnerVersions: { [key]: 1 },
      materializationOwnerProcesses: { [key]: { pid: 111, startedAtMs: 1_000 } },
    }))
    const store = new OpenCodeSessionStore(filePath, {
      isProcessAlive: pid => pid === 111,
      readProcessStartTimeMs: async () => 2_000,
    })

    expect(await store.markStale(
      record.teamId, record.laneId!, record.memberName, 'inactive-owner', record,
    )).toMatchObject({ staleReason: 'inactive-owner' })
  })

})
