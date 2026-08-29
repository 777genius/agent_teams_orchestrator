import { mkdtemp, rm } from 'node:fs/promises'
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

  test('conditional cleanup never mutates or deletes a replacement session', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const replacement = { ...baseRecord, opencodeSessionId: 'session-winner' }
    await store.upsert(replacement)

    expect(await store.markStaleIfSession(baseRecord, 'launch_failed')).toBeNull()
    expect(await store.deleteIfSession(baseRecord)).toBe(false)
    expect(await store.get(baseRecord.teamId, baseRecord.memberName)).toEqual(replacement)
  })
})
