import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import * as lockfile from '../../utils/lockfile.js'
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

  test('atomically publishes only one session for a normalized logical member', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const first = new OpenCodeSessionStore(filePath)
    const second = new OpenCodeSessionStore(filePath)
    const contender = { ...baseRecord, memberName: 'Alice', projectPath: '/tmp/other/../project',
      opencodeSessionId: 'session-2' }
    const outcomes = await Promise.all([
      first.publishIfAbsentOrExact(baseRecord),
      second.publishIfAbsentOrExact(contender),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'inserted')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'conflict')).toHaveLength(1)
    expect(await first.list()).toHaveLength(1)
  })

  test('uses normalized member lookup consistently for legacy Alice versus alice records', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, records: {
      'team-a::primary::Alice': { ...baseRecord, memberName: 'Alice' },
    } }))
    const store = new OpenCodeSessionStore(filePath)
    expect(await store.get('team-a', 'primary', 'alice')).toMatchObject({ memberName: 'Alice' })
    expect(await store.get('team-a', 'primary', ' ALICE ')).toMatchObject({ memberName: 'Alice' })
  })

  test('atomically reserves normalized logical member before effects and fences a restart contender', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const first = new OpenCodeSessionStore(filePath)
    const second = new OpenCodeSessionStore(filePath)
    const alice = { teamId: 'team-a', laneId: 'primary', projectIdentity: '/tmp/project', memberName: 'Alice' }
    const normalized = { ...alice, memberName: ' alice ', projectIdentity: '/tmp/other/../project' }
    const outcomes = await Promise.all([
      first.reserveLogicalMember(alice, 'reservation-a', 'session-a'),
      second.reserveLogicalMember(normalized, 'reservation-b', 'session-b'),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'reserved')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'conflict')).toHaveLength(1)
    const winner = outcomes.find(outcome => outcome.status === 'reserved')!
    const restarted = new OpenCodeSessionStore(filePath)
    expect((await restarted.reserveLogicalMember(normalized, 'reservation-c', 'session-c')).status)
      .toBe('conflict')
    expect(await restarted.list()).toEqual([])
    expect(winner.status).toBe('reserved')
  })

  test('crash after remote effect reuses exact reservation and publishes only its exact session', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const logical = { teamId: 'team-a', laneId: 'primary', projectIdentity: '/tmp/project', memberName: 'Alice' }
    const beforeCrash = new OpenCodeSessionStore(filePath)
    expect((await beforeCrash.reserveLogicalMember(logical, 'reservation-a', 'session-1')).status).toBe('reserved')
    const restarted = new OpenCodeSessionStore(filePath)
    expect((await restarted.reserveLogicalMember({ ...logical, memberName: 'alice' },
      'reservation-a', 'session-1')).status).toBe('exact')
    expect((await restarted.publishReserved(baseRecord, 'reservation-a')).status).toBe('inserted')
    expect(await restarted.get('team-a', 'primary', 'ALICE')).toEqual(baseRecord)
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { schemaVersion: number;
      reservations: Record<string, unknown> }
    expect(persisted.schemaVersion).toBe(2)
    expect(persisted.reservations).toEqual({})
  })

  test('post-effect publication conflict stays reserved for durable reconciliation authority', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const logical = { teamId: 'team-a', laneId: 'primary', projectIdentity: '/tmp/project', memberName: 'alice' }
    const store = new OpenCodeSessionStore(filePath)
    await store.reserveLogicalMember(logical, 'reservation-a', 'session-1')
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      schemaVersion: 2; records: Record<string, typeof baseRecord>; reservations: Record<string, unknown> }
    persisted.records['team-a::primary::alice'] = { ...baseRecord, opencodeSessionId: 'foreign-session' }
    await writeFile(filePath, JSON.stringify(persisted))
    expect((await store.publishReserved(baseRecord, 'reservation-a')).status).toBe('conflict')
    const after = JSON.parse(await readFile(filePath, 'utf8')) as { reservations: Record<string, unknown> }
    expect(Object.keys(after.reservations)).toHaveLength(1)
    expect((await store.reserveLogicalMember(logical, 'reservation-b', 'session-2')).status).toBe('conflict')
  })

  test('corrupt persisted reservation fails closed instead of becoming apparent absence', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, records: {}, reservations: {
      bad: { version: 1, logicalMemberKey: 'bad' },
    } }))
    const store = new OpenCodeSessionStore(filePath)
    await expect(store.get('team-a', 'primary', 'alice')).rejects.toThrow(
      'invalid OpenCode session reservation')
    await expect(store.reserveLogicalMember({ teamId: 'team-a', laneId: 'primary',
      projectIdentity: '/tmp/project', memberName: 'alice' }, 'reservation', 'session')).rejects.toThrow(
      'invalid OpenCode session reservation')
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

  test('conditionally marks stale only for the exact session', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    await store.upsert(baseRecord)

    const result = await store.markStaleIfSessionMatches(
      baseRecord.teamId,
      baseRecord.laneId,
      baseRecord.memberName,
      baseRecord.opencodeSessionId,
      'cleanup_failed',
    )

    expect(result.status).toBe('applied')
    expect(
      await store.get(baseRecord.teamId, baseRecord.laneId, baseRecord.memberName),
    ).toMatchObject({
      opencodeSessionId: baseRecord.opencodeSessionId,
      staleReason: 'cleanup_failed',
    })
  })

  test('conditional stale marking preserves and reports a foreign replacement', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const replacement = { ...baseRecord, opencodeSessionId: 'session-replacement' }
    await store.upsert(replacement)

    const result = await store.markStaleIfSessionMatches(
      baseRecord.teamId,
      baseRecord.laneId,
      baseRecord.memberName,
      baseRecord.opencodeSessionId,
      'cleanup_failed',
    )

    expect(result).toEqual({ status: 'foreign', record: replacement })
    expect(await store.get(baseRecord.teamId, baseRecord.laneId, baseRecord.memberName)).toEqual(
      replacement,
    )
  })

  test('conditional stale marking is idempotent when the exact reason is already stored', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const alreadyStale = { ...baseRecord, staleReason: 'cleanup_failed' }
    await store.upsert(alreadyStale)

    const result = await store.markStaleIfSessionMatches(
      baseRecord.teamId,
      baseRecord.laneId,
      baseRecord.memberName,
      baseRecord.opencodeSessionId,
      'cleanup_failed',
    )

    expect(result).toEqual({ status: 'already-satisfied', record: alreadyStale })
    expect(await store.get(baseRecord.teamId, baseRecord.laneId, baseRecord.memberName)).toEqual(
      alreadyStale,
    )
  })

  test('conditionally deletes only the exact session and is idempotent once absent', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    await store.upsert(baseRecord)

    expect(
      await store.deleteIfSessionMatches(
        baseRecord.teamId,
        baseRecord.laneId,
        baseRecord.memberName,
        baseRecord.opencodeSessionId,
      ),
    ).toEqual({ status: 'applied', record: baseRecord })
    expect(
      await store.deleteIfSessionMatches(
        baseRecord.teamId,
        baseRecord.laneId,
        baseRecord.memberName,
        baseRecord.opencodeSessionId,
      ),
    ).toEqual({ status: 'absent' })
  })

  test('conditional delete preserves and reports a foreign replacement', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const replacement = { ...baseRecord, opencodeSessionId: 'session-replacement' }
    await store.upsert(replacement)

    const result = await store.deleteIfSessionMatches(
      baseRecord.teamId,
      baseRecord.laneId,
      baseRecord.memberName,
      baseRecord.opencodeSessionId,
    )

    expect(result).toEqual({ status: 'foreign', record: replacement })
    expect(await store.get(baseRecord.teamId, baseRecord.laneId, baseRecord.memberName)).toEqual(
      replacement,
    )
  })

  test('replacement installed before conditional delete obtains the lock is preserved', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const store = new OpenCodeSessionStore(filePath)
    const replacement = { ...baseRecord, opencodeSessionId: 'session-replacement' }
    await store.upsert(baseRecord)
    const release = await lockfile.lock(`${filePath}.lock`)

    const deletion = store.deleteIfSessionMatches(
      baseRecord.teamId,
      baseRecord.laneId,
      baseRecord.memberName,
      baseRecord.opencodeSessionId,
    )
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        records: {
          [`${baseRecord.teamId}::${baseRecord.laneId}::${baseRecord.memberName}`]: replacement,
        },
      }),
    )
    await release()

    expect(await deletion).toEqual({ status: 'foreign', record: replacement })
    expect(await store.get(baseRecord.teamId, baseRecord.laneId, baseRecord.memberName)).toEqual(
      replacement,
    )
  })

  test('conditional mutations scope identity to the exact lane', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const secondary = {
      ...baseRecord,
      laneId: 'secondary:opencode:alice',
      opencodeSessionId: 'session-secondary',
    }
    await store.upsert(baseRecord)
    await store.upsert(secondary)

    expect(
      await store.markStaleIfSessionMatches(
        baseRecord.teamId,
        secondary.laneId,
        baseRecord.memberName,
        baseRecord.opencodeSessionId,
        'wrong-lane',
      ),
    ).toEqual({ status: 'foreign', record: secondary })
    expect(
      await store.deleteIfSessionMatches(
        baseRecord.teamId,
        secondary.laneId,
        baseRecord.memberName,
        baseRecord.opencodeSessionId,
      ),
    ).toEqual({ status: 'foreign', record: secondary })
    expect(await store.get(baseRecord.teamId, baseRecord.laneId, baseRecord.memberName)).toEqual(
      baseRecord,
    )
    expect(await store.get(baseRecord.teamId, secondary.laneId, baseRecord.memberName)).toEqual(
      secondary,
    )
  })
})
