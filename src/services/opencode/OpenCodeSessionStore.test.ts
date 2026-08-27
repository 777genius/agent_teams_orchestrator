import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
