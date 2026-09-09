import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as lockfile from '../../utils/lockfile.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { parseOpenCodeStopRequest, type OpenCodeStopData, type OpenCodeStopRequest } from './OpenCodeStopRecovery.js'
import type { OpenCodeSessionRecord } from './types.js'

const capability = `opencode:${'a'.repeat(32)}`
const behavior = 'b'.repeat(64)
const runtime = { providerId: 'opencode' as const, binaryPath: 'opencode', binaryFingerprint: null,
  version: null, capabilitySnapshotId: capability }
const record: OpenCodeSessionRecord = {
  teamId: 'team', laneId: 'primary', runId: 'run', memberName: 'alice', providerId: 'opencode',
  selectedModel: 'openai/gpt-5.4', projectPath: '/tmp/project', profileRootKey: 'profile', hostKey: 'shared-host',
  opencodeSessionId: 'session-original', expectedBehaviorFingerprint: behavior, resolvedBehaviorFingerprint: null,
  lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: null,
  sourceAuthFingerprint: null, managedAuthFingerprint: null, projectBehaviorFingerprint: behavior,
  staleReason: null, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
}
const request: OpenCodeStopRequest = {
  contractVersion: 1, originalRequestId: 'original-stop-request', idempotencyKey: 'deterministic-stop-key',
  target: { teamId: record.teamId, laneId: record.laneId!, runId: record.runId!, projectPath: record.projectPath,
    capabilitySnapshotId: capability, expectedBehaviorFingerprint: behavior,
    members: [{ memberName: record.memberName, sessionId: record.opencodeSessionId }] },
}
const result = (stopped: boolean): OpenCodeStopData => ({
  runId: 'run', stopped, members: { alice: { sessionId: record.opencodeSessionId, stopped, diagnostics: stopped ? [] : ['deadline expired'] } },
  warnings: ['retained warning'], diagnostics: [], manifestHighWatermark: 0, runtimeStoreManifestHighWatermark: 0,
  idempotencyKey: request.idempotencyKey,
})
let dir: string
let file: string
let store: OpenCodeSessionStore
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'stop-recovery-'))
  file = path.join(dir, 'sessions.json')
  store = new OpenCodeSessionStore(file)
  await store.upsert(record)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const legacy = async () => capability

describe('owned durable Stop outcomes', () => {
  for (const stopped of [true, false]) test(`duplicate ${stopped} survives store recreation and never changes result`, async () => {
    expect((await store.beginStop(request, runtime)).status).toBe('started')
    await store.completeStop(request, result(stopped))
    const recreated = new OpenCodeSessionStore(file)
    const replay = await recreated.beginStop(request, runtime)
    expect(replay.status).toBe('completed')
    if (replay.status !== 'completed') throw new Error('missing receipt')
    expect(replay.receipt.data).toEqual(result(stopped))
    expect(replay.receipt.request).toEqual(request)
    expect(replay.receipt.binding[0]).toEqual({ memberName: 'alice', sessionId: record.opencodeSessionId,
      hostKey: record.hostKey, createdAt: record.createdAt })
    await expect(recreated.completeStop(request, result(!stopped))).rejects.toThrow('already completed')
  })

  test('concurrent duplicates have one durable start; a new key cannot bypass it', async () => {
    const other = new OpenCodeSessionStore(file)
    const outcomes = await Promise.all([store.beginStop(request, runtime), other.beginStop(request, runtime)])
    expect(outcomes.map(item => item.status).sort()).toEqual(['inflight', 'started'])
    expect((await other.beginStop({ ...request, originalRequestId: 'random', idempotencyKey: 'random' }, runtime)).status).toBe('inflight')
  })

  test('an interrupted original run does not poison an independently launched successor Stop', async () => {
    await store.beginStop(request, runtime)
    await store.markStoppedIfSession(record, { runtime, expectedBehaviorFingerprint: behavior })
    const successor = { ...record, runId: 'next-run', opencodeSessionId: 'next-session',
      createdAt: '2026-09-09T02:00:00.000Z' }
    const claim = await store.claimMaterialization(successor, 'next-launch', successor.runId)
    if (claim.kind !== 'claimed') throw new Error('missing successor claim')
    const owner = await store.commitMaterialization(successor, claim.ownerToken)
    if (!owner) throw new Error('missing successor owner')
    await store.releaseMaterializationOwner(successor, owner)
    const nextRequest: OpenCodeStopRequest = { ...request, originalRequestId: 'next-stop', idempotencyKey: 'next-key',
      target: { ...request.target, runId: successor.runId,
        members: [{ memberName: successor.memberName, sessionId: successor.opencodeSessionId }] } }
    expect((await store.beginStop(nextRequest, runtime)).status).toBe('started')
    expect((await store.lookupStop(request)).status).toBe('inflight')
    expect((await store.reconcileStop(request, legacy)).status).toBe('target_mismatch')
  })

  test('malformed runtime authority never writes a start receipt', async () => {
    await expect(store.beginStop(request, { ...runtime, providerId: 'invalid' } as typeof runtime)).rejects.toThrow('Corrupt')
    expect((await store.lookupStop(request)).status).toBe('unknown')
  })

  test('a corrupt aggregate cannot turn all-true members into a retained false result', async () => {
    await store.beginStop(request, runtime)
    await expect(store.completeStop(request, { ...result(true), stopped: false })).rejects.toThrow('Invalid durable Stop result')
    expect((await store.lookupStop(request)).status).toBe('inflight')
  })

  test('crash after effect remains inflight, but exact terminal state reconciles separately', async () => {
    await store.beginStop(request, runtime)
    await store.markStoppedIfSession(record, { runtime, expectedBehaviorFingerprint: behavior })
    const recreated = new OpenCodeSessionStore(file)
    expect((await recreated.lookupStop(request)).status).toBe('inflight')
    expect((await recreated.beginStop(request, runtime)).status).toBe('inflight')
    const reconciliation = await recreated.reconcileStop(request, legacy)
    expect(reconciliation.status).toBe('reconciled_stopped')
    expect(reconciliation.sessionSetToken).toMatch(/^[a-f0-9]{64}$/)
    expect(reconciliation).not.toHaveProperty('receipt')
    expect((await recreated.lookupStop(request)).status).toBe('inflight')
  })

  test('timeout after terminal effect retains false while reconciliation reports stopped', async () => {
    await store.beginStop(request, runtime)
    await store.markStoppedIfSession(record, { runtime, expectedBehaviorFingerprint: behavior })
    await store.completeStop(request, result(false))
    const recreated = new OpenCodeSessionStore(file)
    const outcome = await recreated.lookupStop(request)
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') expect(outcome.receipt.data.stopped).toBe(false)
    expect((await recreated.reconcileStop(request, legacy)).status).toBe('reconciled_stopped')
  })

  for (const field of ['teamId', 'laneId', 'runId', 'projectPath', 'capabilitySnapshotId', 'expectedBehaviorFingerprint', 'members'] as const) {
    test(`receipt rejects changed ${field}`, async () => {
      await store.beginStop(request, runtime)
      await store.completeStop(request, result(true))
      const target = { ...request.target, [field]: field === 'members'
        ? [{ memberName: 'alice', sessionId: 'successor' }]
        : field === 'capabilitySnapshotId' ? `opencode:${'c'.repeat(32)}`
        : field === 'expectedBehaviorFingerprint' ? 'c'.repeat(64) : 'other' }
      expect((await store.lookupStop({ ...request, target })).status).toBe('target_mismatch')
    })
  }

  test('original request and deterministic key are both immutable', async () => {
    await store.beginStop(request, runtime)
    expect((await store.lookupStop({ ...request, idempotencyKey: 'other' })).status).toBe('target_mismatch')
    expect((await store.lookupStop({ ...request, originalRequestId: 'other' })).status).toBe('target_mismatch')
  })

  test('cancelled lock acquisition leaves no receipt; completed write is not raced with abort', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(store.beginStop(request, runtime, controller.signal)).rejects.toThrow()
    expect((await store.lookupStop(request)).status).toBe('unknown')
    await store.beginStop(request, runtime)
    await store.completeStop(request, result(false))
    expect((await new OpenCodeSessionStore(file).lookupStop(request)).status).toBe('completed')
  })

  test('corrupt result/store cannot be mistaken for absence or true Stop', async () => {
    await store.beginStop(request, runtime)
    await store.completeStop(request, result(false))
    const disk = JSON.parse(await readFile(file, 'utf8'))
    const receipt = Object.values(disk.stopReceipts)[0] as { data?: unknown }
    delete receipt.data
    await writeFile(file, JSON.stringify(disk))
    await expect(store.lookupStop(request)).rejects.toThrow()
    await writeFile(file, JSON.stringify({ schemaVersion: 999, records: {} }))
    await expect(store.beginStop(request, runtime)).rejects.toThrow('authority')
  })
})

describe('legacy current-state reconciliation', () => {
  test('old no-receipt terminal Stop recovers without deleting state or minting history', async () => {
    await store.markStoppedIfSession(record)
    expect((await store.lookupStop(request)).status).toBe('unknown')
    const before = await readFile(file, 'utf8')
    expect((await store.reconcileStop(request, legacy)).status).toBe('reconciled_stopped')
    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await store.lookupStop(request)).status).toBe('unknown')
  })

  test('active/no PID/cached idle and absent records never prove Stop', async () => {
    await store.upsert({ ...record, lastKnownRawStatus: 'idle' })
    expect((await store.reconcileStop(request, legacy)).status).toBe('active')
    await store.delete(record.teamId, record.laneId!, record.memberName)
    expect((await store.reconcileStop(request, legacy)).status).toBe('unknown')
  })

  test('dead-host retirement is not an abort receipt', async () => {
    await store.upsert({ ...record, stoppedAt: '2026-09-09T01:00:00.000Z', staleReason: 'runtime_process_gone' })
    expect((await store.reconcileStop(request, legacy)).status).toBe('unknown')
  })

  test('legacy capability must be retained, not supplied as authority by caller', async () => {
    await store.markStoppedIfSession(record)
    expect((await store.reconcileStop(request, async () => { throw new Error('missing manifest') })).status).toBe('unknown')
    expect((await store.reconcileStop(request, async () => `opencode:${'c'.repeat(32)}`)).status).toBe('target_mismatch')
  })

  test('same-run session replacement is fenced; history never grants current cleanup', async () => {
    await store.beginStop(request, runtime)
    await store.completeStop(request, result(false))
    await store.upsert({ ...record, opencodeSessionId: 'replacement' })
    expect((await store.reconcileStop(request, legacy)).status).toBe('target_mismatch')
    expect((await store.lookupStop(request)).status).toBe('completed')
    expect((await store.lookupStop({ ...request, target: { ...request.target,
      members: [{ memberName: 'alice', sessionId: 'replacement' }] } })).status).toBe('target_mismatch')
  })

  test('same session ID with changed runtime generation cannot consume bound observation', async () => {
    await store.beginStop(request, runtime)
    await store.upsert({ ...record, createdAt: '2026-09-09T02:00:00.000Z' })
    expect((await store.reconcileStop(request, legacy)).status).toBe('target_mismatch')
    expect(await store.markStoppedIfSession(record)).toBeNull()
  })

  test('new run and incomplete target set are fenced', async () => {
    expect((await store.reconcileStop({ ...request, target: { ...request.target, runId: 'other-run' } }, legacy)).status).toBe('target_mismatch')
    await store.upsert({ ...record, memberName: 'bob', opencodeSessionId: 'session-bob' })
    expect((await store.reconcileStop(request, legacy)).status).toBe('target_mismatch')
  })

  test('shared-host sibling team and lane records remain byte-for-byte unchanged', async () => {
    const sibling = { ...record, teamId: 'sibling', opencodeSessionId: 'sibling-session' }
    const lane = { ...record, laneId: 'secondary', opencodeSessionId: 'secondary-session' }
    await store.upsert(sibling); await store.upsert(lane)
    await store.beginStop(request, runtime)
    await store.markStoppedIfSession(record, { runtime, expectedBehaviorFingerprint: behavior })
    await store.completeStop(request, result(true))
    expect((await store.reconcileStop(request, legacy)).status).toBe('reconciled_stopped')
    expect(await store.get('sibling', 'primary', 'alice')).toEqual(sibling)
    expect(await store.get('team', 'secondary', 'alice')).toEqual(lane)
  })

  test('materialization claim prevents affirmative reconciliation', async () => {
    await store.markStoppedIfSession(record)
    expect((await store.claimMaterialization(record, 'launch-next', 'next-run')).kind).toBe('claimed')
    expect((await store.reconcileStop(request, legacy)).status).toBe('unknown')
  })

  test('reconciliation waits on the existing session-store lock and observes a queued replacement', async () => {
    await store.lookupStop(request) // create owned lock path
    const release = await lockfile.lock(`${file}.lock`, { retries: 0 })
    const pending = store.reconcileStop(request, legacy)
    try {
      const disk = JSON.parse(await readFile(file, 'utf8'))
      disk.records['team::primary::alice'].opencodeSessionId = 'successor'
      await writeFile(file, JSON.stringify(disk))
    } finally { await release() }
    expect((await pending).status).toBe('target_mismatch')
  })

  test('unsupported version, empty or duplicate session set are rejected', () => {
    expect(() => parseOpenCodeStopRequest({ ...request, contractVersion: 2 })).toThrow('Unsupported')
    expect(() => parseOpenCodeStopRequest({ ...request, target: { ...request.target, members: [] } })).toThrow('nonempty')
    expect(() => parseOpenCodeStopRequest({ ...request, target: { ...request.target,
      members: [...request.target.members, ...request.target.members] } })).toThrow('Ambiguous')
  })
})
