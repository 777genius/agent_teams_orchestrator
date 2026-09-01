import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'

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
      { kind: 'claimed' },
      { kind: 'owned_by_other' },
    ]))
    const winner = claims[0]?.kind === 'claimed' ? 'attempt-a' : 'attempt-b'
    const loser = winner === 'attempt-a' ? 'attempt-b' : 'attempt-a'
    expect(await store.commitMaterialization(baseRecord, loser)).toBe(false)
    expect(await store.commitMaterialization(baseRecord, winner)).toBe(true)
    expect(await store.markStaleIfSession(baseRecord, 'launch_failed', loser)).toBeNull()
    expect(await store.deleteIfSession(baseRecord, loser)).toBe(false)
    expect(await store.get(baseRecord.teamId, baseRecord.memberName)).toEqual(baseRecord)
  })

  test('distinguishes a newly acquired claim from a replay by the same attempt', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const identity = {
      teamId: baseRecord.teamId,
      laneId: baseRecord.laneId,
      memberName: baseRecord.memberName,
    }

    expect(await store.claimMaterialization(identity, 'attempt-a')).toEqual({ kind: 'claimed' })
    expect(await store.claimMaterialization(identity, 'attempt-a')).toEqual({ kind: 'already_owned' })
    expect(await store.claimMaterialization(identity, 'attempt-b')).toEqual({ kind: 'owned_by_other' })
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
    expect(await store.claimMaterialization(record, 'old-attempt', 'run-1')).toEqual({ kind: 'claimed' })
    expect(await store.commitMaterialization(record, 'old-attempt')).toBe(true)
    expect(await store.markStoppedIfSession({ ...record, runId: 'older-run' })).toBeNull()
    expect(await store.markStoppedIfSession({ ...record, opencodeSessionId: 'other-session' })).toBeNull()
    const stopped = await store.markStoppedIfSession(record)
    expect(stopped?.stoppedAt).toBeDefined()
    expect(await store.markStoppedIfSession(record)).toEqual(stopped)
    expect(await store.claimMaterialization(record, 'same-run-attempt', 'run-1')).toEqual({ kind: 'existing', record: stopped })
    expect(await store.claimMaterialization(record, 'legacy-attempt')).toEqual({ kind: 'existing', record: stopped })
    expect(await store.claimMaterialization(record, 'new-attempt', 'run-2')).toEqual({ kind: 'claimed' })
    expect(await store.commitMaterialization({ ...record, runId: 'run-2', opencodeSessionId: 'session-2' }, 'new-attempt')).toBe(true)
    expect(await store.markStoppedIfSession(record)).toBeNull()
    expect((await store.get('team-a', 'primary', 'alice'))?.stoppedAt).toBeUndefined()
    expect(await store.deleteIfSession(record, 'old-attempt')).toBe(false)
  })

  test('stopped replacement keeps unknown create claims fenced and malformed markers inactive', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'sessions.json'))
    const record = { ...baseRecord, runId: 'run-1' }
    await writeFile(path.join(tempDir, 'sessions.json'), JSON.stringify({ schemaVersion: 1,
      records: { 'team-a::primary::alice': record },
      materializationClaims: { 'team-a::primary::alice': 'unknown-attempt' } }))
    const stopped = await store.markStoppedIfSession(record)
    expect(await store.claimMaterialization(record, 'new-attempt', 'run-2')).toEqual({ kind: 'owned_by_other' })
    expect(await store.claimMaterialization(record, 'unknown-attempt', 'run-2')).toEqual({ kind: 'already_owned' })
    expect(await store.get('team-a', 'primary', 'alice')).toEqual(stopped)
    const malformedStore = new OpenCodeSessionStore(path.join(tempDir, 'malformed.json'))
    for (const stoppedAt of ['', 'invalid', '1']) {
      const malformed = { ...record, stoppedAt }
      await malformedStore.upsert(malformed)
      expect(await malformedStore.claimMaterialization(record, 'new-attempt', 'run-2')).toEqual({ kind: 'existing', record: malformed })
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
    expect(await store.claimMaterialization(old, 'new-attempt', 'run-2')).toEqual({ kind: 'claimed' })
    await expect(store.upsert(old)).rejects.toThrow('materialization claim')
    const next = { ...old, runId: 'run-2', opencodeSessionId: 'session-2' }
    expect(await store.commitMaterialization(next, 'new-attempt')).toBe(true)
    await expect(store.upsert(old)).rejects.toThrow('committed run and session')
    await expect(store.upsert({ ...next, runId: undefined })).rejects.toThrow('committed run and session')
    expect(await store.markStale('team-a', 'primary', 'alice', 'late-observer', old)).toBeNull()
    expect(await store.get('team-a', 'primary', 'alice')).toEqual(next)
  })

})
