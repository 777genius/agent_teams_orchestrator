import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { HostedApprovalRuntimeBindingFenceRegistry } from '../hostedControl/HostedApprovalRuntimeBindingFence.js'
import { OpenCodeSessionStore, retainHostedSessionPublicationStore } from './OpenCodeSessionStore.js'

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
  tempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-session-store-test-')))
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

  test('effect token binds the exact persisted manual session image', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const manual = { ...baseRecord, toolApprovalMode: 'manual' as const }
    await store.upsert(manual)
    const token = await store.prepareEffectToken(
      manual.teamId,
      manual.laneId,
      manual.memberName,
      manual,
    )
    expect(token).not.toBeNull()
    await store.upsert({ ...manual, selectedVariant: 'high' })
    expect(token!.consume()).toBe(false)

    const fresh = await store.prepareEffectToken(
      manual.teamId,
      manual.laneId,
      manual.memberName,
      { ...manual, selectedVariant: 'high' },
    )
    expect(fresh?.consume()).toBe(true)
    expect(fresh?.consume()).toBe(false)
  })

  test('upsert, markStale, and delete share the per-team transition fence', async () => {
    const fences = new HostedApprovalRuntimeBindingFenceRegistry()
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'), fences)
    await store.upsert(baseRecord)
    const pin = fences.forTeam(baseRecord.teamId).tryAcquirePin()
    if (!pin) throw new Error('expected team binding pin')
    const settled: string[] = []
    const stale = store.markStale(baseRecord.teamId, baseRecord.memberName, 'fenced')
      .then(() => { settled.push('stale') })
    const upsert = store.upsert({ ...baseRecord, memberName: 'bob' })
      .then(() => { settled.push('upsert') })
    const deletion = store.delete(baseRecord.teamId, baseRecord.memberName)
      .then(() => { settled.push('delete') })
    await Promise.resolve()
    expect(settled).toEqual([])
    pin.release()
    await Promise.all([stale, upsert, deletion])
    expect(settled.sort()).toEqual(['delete', 'stale', 'upsert'])
  })

  test('conditionally publishes one full-image winner across distinct store instances', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const first = new OpenCodeSessionStore(filePath)
    const second = new OpenCodeSessionStore(filePath)
    await first.upsert(baseRecord)
    const firstCapability = retainHostedSessionPublicationStore(first)
    const secondCapability = retainHostedSessionPublicationStore(second)
    const key = { teamId: baseRecord.teamId, laneId: baseRecord.laneId, memberName: baseRecord.memberName }
    const nextA = { ...baseRecord, opencodeSessionId: 'session-a', updatedAt: '2026-04-21T00:00:01.000Z' }
    const nextB = { ...baseRecord, opencodeSessionId: 'session-b', updatedAt: '2026-04-21T00:00:02.000Z' }
    const results = await Promise.all([
      firstCapability.compareAndSwap({ key, expected: baseRecord, next: nextA }),
      secondCapability.compareAndSwap({ key, expected: baseRecord, next: nextB }),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['applied', 'conflict'])
    const reopened = retainHostedSessionPublicationStore(new OpenCodeSessionStore(filePath))
    const winner = await reopened.readExact(key)
    expect(['session-a', 'session-b']).toContain(winner?.opencodeSessionId)
    const loser = winner?.opencodeSessionId === 'session-a' ? nextB : nextA
    const refresh = { ...winner!, lastKnownRawStatus: 'idle', updatedAt: '2026-04-21T00:00:03.000Z' }
    expect(await reopened.compareAndSwap({ key, expected: loser, next: refresh })).toMatchObject({ status: 'conflict' })
    expect(await reopened.compareAndSwap({ key, expected: winner!, next: refresh })).toEqual({ status: 'applied' })
    expect(await reopened.readExact(key)).toEqual(refresh)
  })

  test('strict hosted reads reject corruption and publication failures retain truthful scope', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    await writeFile(filePath, '{"schemaVersion":2,"records":{}}')
    const corrupt = retainHostedSessionPublicationStore(new OpenCodeSessionStore(filePath))
    const key = { teamId: baseRecord.teamId, laneId: baseRecord.laneId, memberName: baseRecord.memberName }
    await expect(corrupt.readExact(key)).rejects.toThrow('schema is unavailable')
    expect(await corrupt.compareAndSwap({ key, expected: null, next: baseRecord })).toMatchObject({
      status: 'unavailable', publication: 'not_started',
    })

    const beforePath = path.join(tempDir, 'before.json')
    const before = new OpenCodeSessionStore(beforePath, undefined, {
      beforeRename: async () => { throw new Error('before rename') },
    })
    expect(await retainHostedSessionPublicationStore(before).compareAndSwap({ key, expected: null, next: baseRecord }))
      .toMatchObject({ status: 'unavailable', publication: 'not_started' })

    const afterPath = path.join(tempDir, 'after.json')
    const after = new OpenCodeSessionStore(afterPath, undefined, {
      afterRename: async () => { throw new Error('after rename') },
    })
    expect(await retainHostedSessionPublicationStore(after).compareAndSwap({ key, expected: null, next: baseRecord }))
      .toMatchObject({ status: 'unavailable', publication: 'unknown' })
    expect(JSON.parse(await readFile(afterPath, 'utf8')).records['team-a::primary::alice'])
      .toMatchObject({ opencodeSessionId: baseRecord.opencodeSessionId })

    const releasePath = path.join(tempDir, 'lock-release.json')
    const release = new OpenCodeSessionStore(releasePath, undefined, {
      afterLockReleaseForTest: async () => { throw new Error('forced lock release failure') },
    })
    expect(await retainHostedSessionPublicationStore(release).compareAndSwap({
      key, expected: null, next: baseRecord,
    })).toMatchObject({ status: 'unavailable', publication: 'unknown' })
    expect(JSON.parse(await readFile(releasePath, 'utf8')).records['team-a::primary::alice'])
      .toMatchObject({ opencodeSessionId: baseRecord.opencodeSessionId })
  })

  test('hosted capability is retained only for an actual base store and ignores method replacement', async () => {
    class StructuralStore extends OpenCodeSessionStore {}
    const subclass = new StructuralStore(path.join(tempDir, 'subclass.json'))
    expect(() => retainHostedSessionPublicationStore(subclass)).toThrow('actual store implementation')

    const filePath = path.join(tempDir, 'captured.json')
    const store = new OpenCodeSessionStore(filePath)
    const capability = retainHostedSessionPublicationStore(store)
    const replacementCalls: string[] = []
    Reflect.set(store, 'get', async () => { replacementCalls.push('get'); return null })
    Reflect.set(store, 'upsert', async () => { replacementCalls.push('upsert'); return 'created' })
    expect(await capability.compareAndSwap({
      key: { teamId: baseRecord.teamId, laneId: baseRecord.laneId, memberName: baseRecord.memberName },
      expected: null,
      next: baseRecord,
    })).toEqual({ status: 'applied' })
    expect((await capability.readExact({
      teamId: baseRecord.teamId, laneId: baseRecord.laneId, memberName: baseRecord.memberName,
    }))?.opencodeSessionId).toBe(baseRecord.opencodeSessionId)
    expect(replacementCalls).toEqual([])
  })

  test('hosted CAS validates canonical keys and supports exact conditional deletion', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'canonical.json'))
    const capability = retainHostedSessionPublicationStore(store)
    expect(await capability.compareAndSwap({
      key: { teamId: 'team::alias', laneId: 'primary', memberName: 'alice' },
      expected: null,
      next: { ...baseRecord, teamId: 'team::alias' },
    })).toMatchObject({ status: 'unavailable', publication: 'not_started' })
    const key = { teamId: baseRecord.teamId, laneId: baseRecord.laneId, memberName: baseRecord.memberName }
    expect(await capability.compareAndSwap({ key, expected: null, next: baseRecord })).toEqual({ status: 'applied' })
    expect(await capability.compareAndSwap({ key, expected: { ...baseRecord, updatedAt: 'wrong' }, next: null }))
      .toMatchObject({ status: 'conflict', current: baseRecord })
    expect(await capability.compareAndSwap({ key, expected: baseRecord, next: null })).toEqual({ status: 'applied' })
    expect(await capability.readExact(key)).toBeNull()
    expect(await capability.compareAndSwap({ key, expected: baseRecord, next: null }))
      .toMatchObject({ status: 'conflict', current: null })
  })

  test('hosted CAS snapshots the full next image before waiting for the existing team fence', async () => {
    const fences = new HostedApprovalRuntimeBindingFenceRegistry()
    const store = new OpenCodeSessionStore(path.join(tempDir, 'snapshot.json'), fences)
    const capability = retainHostedSessionPublicationStore(store)
    const pin = fences.forTeam(baseRecord.teamId).tryAcquirePin()
    if (!pin) throw new Error('expected team binding pin')
    const next = { ...baseRecord, opencodeSessionId: 'session-snapshotted' }
    const input = {
      key: { teamId: baseRecord.teamId, laneId: baseRecord.laneId, memberName: baseRecord.memberName },
      expected: null,
      next,
    }
    const pending = capability.compareAndSwap(input)
    next.opencodeSessionId = 'session-mutated-after-call'
    input.key.memberName = 'bob'
    pin.release()
    expect(await pending).toEqual({ status: 'applied' })
    expect((await capability.readExact({
      teamId: baseRecord.teamId, laneId: baseRecord.laneId, memberName: baseRecord.memberName,
    }))?.opencodeSessionId).toBe('session-snapshotted')
    expect(await capability.readExact({
      teamId: baseRecord.teamId, laneId: baseRecord.laneId, memberName: 'bob',
    })).toBeNull()
  })

  test('the filesystem lock selects one CAS winner across two source-mode processes', async () => {
    const filePath = path.join(tempDir, 'two-process.json')
    const store = new OpenCodeSessionStore(filePath)
    await store.upsert(baseRecord)
    const moduleUrl = new URL('./OpenCodeSessionStore.ts', import.meta.url).href
    const script = [
      `const module = await import(${JSON.stringify(moduleUrl)})`,
      'const store = new module.OpenCodeSessionStore(process.env.OPENCODE_CAS_STORE_PATH)',
      'const capability = module.retainHostedSessionPublicationStore(store)',
      'const input = JSON.parse(process.env.OPENCODE_CAS_INPUT)',
      'const result = await capability.compareAndSwap(input)',
      'process.stdout.write(JSON.stringify({ status: result.status }))',
    ].join(';')
    const key = { teamId: baseRecord.teamId, laneId: baseRecord.laneId, memberName: baseRecord.memberName }
    const run = (nextSessionId: string) => new Promise<{ status: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], {
        env: {
          ...process.env,
          OPENCODE_CAS_STORE_PATH: filePath,
          OPENCODE_CAS_INPUT: JSON.stringify({
            key,
            expected: baseRecord,
            next: { ...baseRecord, opencodeSessionId: nextSessionId },
          }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
      child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
      child.once('error', reject)
      child.once('close', code => {
        if (code !== 0) {
          reject(new Error(`CAS child exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')) as { status: string })
        } catch (cause) {
          reject(new Error('CAS child returned malformed output', { cause }))
        }
      })
    })
    const outcomes = await Promise.all([run('session-process-a'), run('session-process-b')])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['applied', 'conflict'])
    const winner = await retainHostedSessionPublicationStore(new OpenCodeSessionStore(filePath)).readExact(key)
    expect(['session-process-a', 'session-process-b']).toContain(winner?.opencodeSessionId)
  }, 120_000)

  test('concurrent same-session metadata refreshes compare the complete predecessor image', async () => {
    const filePath = path.join(tempDir, 'metadata-refresh-race.json')
    const seed = new OpenCodeSessionStore(filePath)
    await seed.upsert(baseRecord)
    const left = retainHostedSessionPublicationStore(new OpenCodeSessionStore(filePath))
    const right = retainHostedSessionPublicationStore(new OpenCodeSessionStore(filePath))
    const key = { teamId: baseRecord.teamId, laneId: baseRecord.laneId, memberName: baseRecord.memberName }
    const leftRefresh = { ...baseRecord, lastKnownRawStatus: 'idle',
      updatedAt: '2026-04-21T00:00:01.000Z' }
    const rightRefresh = { ...baseRecord, lastKnownRawStatus: 'busy',
      updatedAt: '2026-04-21T00:00:02.000Z' }
    const outcomes = await Promise.all([
      left.compareAndSwap({ key, expected: baseRecord, next: leftRefresh }),
      right.compareAndSwap({ key, expected: baseRecord, next: rightRefresh }),
    ])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['applied', 'conflict'])
    const winner = await retainHostedSessionPublicationStore(new OpenCodeSessionStore(filePath)).readExact(key)
    expect(winner?.opencodeSessionId).toBe(baseRecord.opencodeSessionId)
    expect(['idle', 'busy']).toContain(winner?.lastKnownRawStatus)
    const conflict = outcomes.find(outcome => outcome.status === 'conflict')
    expect(conflict?.status === 'conflict' && conflict.current).toEqual(winner)
  })
})
