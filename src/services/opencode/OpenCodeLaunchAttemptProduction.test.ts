import { expect, spyOn, test } from 'bun:test'
import path from 'node:path'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { createHash } from 'node:crypto'
import * as childProcess from 'node:child_process'

import {
  commitOpenCodeMemberProjection,
  createOpenCodeOwnedMemberSession,
  OpenCodeProofSessionCleanupLedger,
  recoverOpenCodeCommittedMemberLinkage,
  recoverOpenCodeCommittedMemberProjection,
  reconcileOpenCodeOwnedMemberSession,
} from './OpenCodeLaunchAttemptProductionSession.js'
import { OpenCodeLaunchMutationLedger, type OpenCodeLaunchMutationIdentity } from './OpenCodeLaunchMutationLedger.js'
import { computeOpenCodeLaunchAttemptInputDigest, computeOpenCodeLaunchAttemptImmutableDigest } from './OpenCodeLaunchAttempt.js'
import { deriveOpenCodeLaunchNamespacePaths, OpenCodeLaunchAttemptStore,
  OpenCodeLaunchFileJournalPersistence, type OpenCodeMemberCleanupObligation,
  type OpenCodeMemberCleanupPhase } from './OpenCodeLaunchAttemptStore.js'
import type { OpenCodeLaunchAttemptResponse, OpenCodeLaunchMemberLinkage,
  OpenCodeOpaqueIdentity, OpenCodeRetainedHostIdentity } from './OpenCodeBridgeContractV2.js'
import type { OpenCodeCurrentScopedProfilePlan, OpenCodeScopedPreparedProfile,
  OpenCodeSessionRecord } from './types.js'
import { OpenCodeSafePublicationDirectory } from './OpenCodeSafePublication.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeProfileManager } from './OpenCodeProfileManager.js'
import { OpenCodeRetainedHostLeaseForeignError } from './OpenCodeLaunchProductionGuards.js'
import { authorizeOpenCodeLaunchScopedProfile } from './OpenCodePlanScopedProfile.js'
import { planScopedProfile } from './OpenCodeOperationPolicy.js'
import { computeOpenCodeLaunchCommandImmutableDigest, computeOpenCodeLaunchCommandInputDigest,
  computeOpenCodeLaunchRequestCorrelationDigest, type OpenCodeLaunchAttemptBridgePort } from './OpenCodeLaunchAttemptBridge.js'
import {
  assertOpenCodeProductionBootstrapOwnership,
  createOpenCodeLaunchPreflightResult,
  deriveOpenCodeProductionProofOwnership,
  hasExactOpenCodeClaimReconciliationAuthority,
  inspectOpenCodeProductionGeneration,
  OpenCodeLaunchHostReleaseLedger,
  createOpenCodeLaunchAttemptProductionTestBridge,
  readOpenCodeProductionMemberClaim,
  reobserveOpenCodeProductionRetainedProof,
  reconcileOpenCodeMemberCleanupObligations,
  retainOpenCodeProductionOwnedHostLease,
  resolveOpenCodeProductionRetainedProofRecord,
  transitionOpenCodeProductionMemberClaim,
} from './OpenCodeLaunchAttemptProduction.js'

const identity = `sha256:${'a'.repeat(64)}` as OpenCodeOpaqueIdentity
const productionContext = () => ({
  deadlineAtMs: Date.now() + 10_000,
  signal: new AbortController().signal,
  monotonicNow: Date.now,
})

test('production lease transfer withholds cleanup and downstream effects from a foreign loser', async () => {
  const owned = { memberIdentity: identity }
  const registered: typeof owned[] = []
  let downstreamEffects = 0
  const loser = retainOpenCodeProductionOwnedHostLease({
    owned,
    registerOwned: resource => { registered.push(resource) },
    retainHostLease: async () => 'foreign',
  }).then(() => { downstreamEffects += 1 })

  await expect(loser).rejects.toBeInstanceOf(OpenCodeRetainedHostLeaseForeignError)
  expect({ registered, downstreamEffects }).toEqual({ registered: [], downstreamEffects: 0 })

  await expect(retainOpenCodeProductionOwnedHostLease({
    owned,
    registerOwned: resource => { registered.push(resource) },
    retainHostLease: async () => 'exact',
  })).resolves.toBe('exact')
  expect(registered).toEqual([owned])
})

const cleanupObligation = (phase: OpenCodeMemberCleanupPhase = 'remote'):
OpenCodeMemberCleanupObligation => ({
  attemptId: '123e4567-e89b-42d3-a456-426614174099', payloadHash: 'a'.repeat(64),
  generation: 1, hostKey: 'host', memberIdentity: identity, memberName: 'alice',
  teamId: 'team', laneId: 'primary', projectIdentity: '/tmp/project-a',
  runId: 'run-owned', sessionId: 'session-owned',
  sessionIdentity: `sha256:${'b'.repeat(64)}` as OpenCodeOpaqueIdentity,
  ownershipTitle: 'agent-teams-launch:owned', phase,
})

test.each([
  ['markStale', new Set(['mark'])],
  ['releaseHostLease', new Set(['release'])],
  ['delete', new Set(['delete'])],
  ['markStale+releaseHostLease', new Set(['mark', 'release'])],
  ['releaseHostLease+delete', new Set(['release', 'delete'])],
] as const)('member cleanup restart resumes the exact missing phase after %s failure',
async (_name, initialFaults) => {
  let durable = cleanupObligation()
  let remotePresent = true
  let projection: { sessionId: string; runId: string; stale?: boolean } | null = {
    sessionId: durable.sessionId, runId: durable.runId!,
  }
  let faults = new Set<string>(initialFaults)
  const counts = { remoteReads: 0, remoteDeletes: 0, mark: 0, release: 0, delete: 0 }
  const run = () => reconcileOpenCodeMemberCleanupObligations({
    obligations: [durable], deadlineAtMs: 100,
    signal: new AbortController().signal, monotonicNow: () => 0,
    reconcileRemote: async () => {
      counts.remoteReads += 1
      if (remotePresent) { counts.remoteDeletes += 1; remotePresent = false; return 'deleted' }
      return 'absent'
    },
    readProjection: async () => projection,
    markProjectionStale: async () => {
      counts.mark += 1
      if (faults.has('mark')) throw new Error('mark fault')
      if (projection) projection = { ...projection, stale: true }
      return 'satisfied'
    },
    releaseLease: async () => {
      counts.release += 1
      if (faults.has('release')) throw new Error('release fault')
    },
    deleteProjection: async () => {
      counts.delete += 1
      if (faults.has('delete')) throw new Error('delete fault')
      projection = null
      return 'satisfied'
    },
    advance: async (_obligation, phase) => { durable = { ...durable, phase } },
    completed: () => {},
  })

  expect(await run()).toBe('timed_out')
  const restartPhase = durable.phase
  const beforeReplay = { ...counts }
  faults = new Set()
  expect(await run()).toBe('complete')
  expect(durable.phase).toBe('complete')
  expect(projection).toBeNull()
  expect(counts.remoteDeletes).toBe(1)
  if (restartPhase !== 'remote') expect(counts.remoteReads).toBe(beforeReplay.remoteReads)
  if (restartPhase === 'lease_release' || restartPhase === 'projection_delete'
    || restartPhase === 'obligation_complete') expect(counts.mark).toBe(beforeReplay.mark)
  if (restartPhase === 'projection_delete' || restartPhase === 'obligation_complete') {
    expect(counts.release).toBe(beforeReplay.release)
  }
})

test('member cleanup retains cancellation/deadline and never mutates a foreign replacement projection',
async () => {
  for (const boundary of ['cancelled', 'expired'] as const) {
    let durable = cleanupObligation()
    let effects = 0
    const controller = new AbortController()
    if (boundary === 'cancelled') controller.abort(new Error('cancelled'))
    expect(await reconcileOpenCodeMemberCleanupObligations({
      obligations: [durable], deadlineAtMs: 10, signal: controller.signal,
      monotonicNow: () => boundary === 'expired' ? 10 : 0,
      reconcileRemote: async () => { effects += 1; return 'deleted' },
      readProjection: async () => { effects += 1; return null },
      markProjectionStale: async () => { effects += 1; return 'satisfied' },
      releaseLease: async () => { effects += 1 },
      deleteProjection: async () => { effects += 1; return 'satisfied' },
      advance: async (_obligation, phase) => { durable = { ...durable, phase } },
      completed: () => { effects += 1 },
    })).toBe('timed_out')
    expect(durable.phase).toBe('remote')
    expect(effects).toBe(0)
  }

  let durable = cleanupObligation('projection_stale')
  let stale = 0; let deleted = 0; let released = 0
  expect(await reconcileOpenCodeMemberCleanupObligations({
    obligations: [durable], deadlineAtMs: 10, signal: new AbortController().signal,
    monotonicNow: () => 0, reconcileRemote: async () => 'absent',
    readProjection: async () => ({ sessionId: 'foreign-replacement', runId: 'foreign-run' }),
    markProjectionStale: async () => { stale += 1; return 'satisfied' },
    releaseLease: async () => { released += 1 },
    deleteProjection: async () => { deleted += 1; return 'satisfied' },
    advance: async (_obligation, phase) => { durable = { ...durable, phase } },
    completed: () => {},
  })).toBe('complete')
  expect({ stale, deleted, released, phase: durable.phase })
    .toEqual({ stale: 0, deleted: 0, released: 1, phase: 'complete' })
})

test('member cleanup does not complete while project projection authority is unresolved', async () => {
  let durable = cleanupObligation('projection_stale')
  let advanced = 0
  expect(await reconcileOpenCodeMemberCleanupObligations({
    obligations: [durable], deadlineAtMs: 10, signal: new AbortController().signal,
    monotonicNow: () => 0, reconcileRemote: async () => 'absent',
    readProjection: async () => { throw new Error('project authority unresolved') },
    markProjectionStale: async () => 'satisfied', releaseLease: async () => {},
    deleteProjection: async () => 'satisfied',
    advance: async (_obligation, phase) => { advanced += 1; durable = { ...durable, phase } },
    completed: () => {},
  })).toBe('timed_out')
  expect(durable.phase).toBe('projection_stale')
  expect(advanced).toBe(0)
})

test('member cleanup leaves a missing-run legacy obligation wholly unresolved', async () => {
  const durable = { ...cleanupObligation(), runId: undefined }
  let effects = 0
  expect(await reconcileOpenCodeMemberCleanupObligations({
    obligations: [durable], deadlineAtMs: 10, signal: new AbortController().signal,
    monotonicNow: () => 0,
    reconcileRemote: async () => { effects += 1; return 'deleted' },
    readProjection: async () => {
      effects += 1
      return { sessionId: durable.sessionId, runId: 'replacement-run' }
    },
    markProjectionStale: async () => { effects += 1; return 'satisfied' },
    releaseLease: async () => { effects += 1 },
    deleteProjection: async () => { effects += 1; return 'satisfied' },
    advance: async () => { effects += 1 }, completed: () => { effects += 1 },
  })).toBe('timed_out')
  expect({ effects, phase: durable.phase }).toEqual({ effects: 0, phase: 'remote' })
})

test('member cleanup treats a same-session foreign run as a non-mutating stale replay', async () => {
  let durable = cleanupObligation('projection_stale')
  const calls = { reads: 0, marks: 0, releases: 0, deletes: 0 }
  expect(await reconcileOpenCodeMemberCleanupObligations({
    obligations: [durable], deadlineAtMs: 10, signal: new AbortController().signal,
    monotonicNow: () => 0, reconcileRemote: async () => 'absent',
    readProjection: async () => {
      calls.reads += 1
      return { sessionId: durable.sessionId, runId: 'replacement-run' }
    },
    markProjectionStale: async () => { calls.marks += 1; return 'foreign' },
    releaseLease: async () => { calls.releases += 1 },
    deleteProjection: async () => { calls.deletes += 1; return 'foreign' },
    advance: async (_obligation, phase) => { durable = { ...durable, phase } },
    completed: () => {},
  })).toBe('complete')
  expect({ ...calls, phase: durable.phase })
    .toEqual({ reads: 2, marks: 1, releases: 1, deletes: 1, phase: 'complete' })
})

test('member cleanup exact-owner delete is applied once across an idempotent replay', async () => {
  let durable = cleanupObligation('projection_delete')
  let projection: { sessionId: string; runId: string } | null = {
    sessionId: durable.sessionId, runId: durable.runId!,
  }
  let deletes = 0
  let failAdvance = true
  const run = () => reconcileOpenCodeMemberCleanupObligations({
    obligations: [durable], deadlineAtMs: 10, signal: new AbortController().signal,
    monotonicNow: () => 0, reconcileRemote: async () => 'absent',
    readProjection: async () => projection,
    markProjectionStale: async () => 'satisfied', releaseLease: async () => {},
    deleteProjection: async () => { deletes += 1; projection = null; return 'satisfied' },
    advance: async (_obligation, phase) => {
      if (failAdvance) { failAdvance = false; throw new Error('journal fault') }
      durable = { ...durable, phase }
    },
    completed: () => {},
  })
  expect(await run()).toBe('timed_out')
  expect(await run()).toBe('complete')
  expect({ deletes, projection, phase: durable.phase })
    .toEqual({ deletes: 1, projection: null, phase: 'complete' })
})

test('attempt host release ledger survives restart, rejects foreign/corrupt receipts, and clears idempotently', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-host-release-ledger-'))
  const ledgerDirectory = path.join(directory, 'opencode', 'launch-attempts')
  await mkdir(ledgerDirectory, { recursive: true })
  const file = path.join(ledgerDirectory, 'receipt.json')
  const expected = { attemptId: '123e4567-e89b-42d3-a456-426614174000',
    payloadHash: 'b'.repeat(64), generation: 3 }
  const record = { schemaVersion: 1 as const, ...expected, hostKeyIdentity: identity,
    receipt: { schemaVersion: 1 as const, receiptId: '123e4567-e89b-42d3-a456-426614174443',
      hostKeyDigest: 'c'.repeat(64), pid: 443, processStartedAtMs: 12_345,
      lifetime: 'process' as const } }
  try {
    const first = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(file)
    await writeFile(file, `${JSON.stringify(record)}\n`)
    const migrated = await first.read(expected)
    await first.record(migrated)
    const marker = JSON.parse(await readFile(file, 'utf8')) as { slot: 0 | 1 }
    const recordFile = `${file}.slot${marker.slot}`
    const raw = await readFile(recordFile, 'utf8')
    expect(raw).not.toContain('://')
    expect(raw).not.toContain('auth')
    const restarted = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(file)
    expect(migrated).toMatchObject({ ...record, schemaVersion: 4,
      obligationId: record.receipt.receiptId, disposition: 'unknown', releaseState: 'pending' })
    expect(await restarted.readPending({ attemptId: expected.attemptId,
      payloadHash: expected.payloadHash, currentGeneration: 4 })).toEqual(migrated)
    const completedKeepAlive = { ...migrated!, disposition: 'keep_alive' as const,
      releaseState: 'complete' as const }
    await restarted.record(completedKeepAlive)
    expect(await restarted.read(expected)).toEqual(completedKeepAlive)
    expect(await restarted.read({ ...expected, generation: 4 })).toBeNull()
    await restarted.clear(completedKeepAlive)
    await restarted.clear(completedKeepAlive)
    expect(await restarted.read(expected)).toBeNull()

    const currentMarker = JSON.parse(await readFile(file, 'utf8')) as { slot: 0 | 1 }
    await writeFile(`${file}.slot${currentMarker.slot}`,
      '{"schemaVersion":1,"receipt":{"hostKeyDigest":"not-a-digest"}}')
    await expect(restarted.read(expected)).rejects.toThrow('corrupt')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('attempt host release ledger persists an exact Windows generation and rejects malformed tokens', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-windows-host-release-ledger-'))
  const ledgerDirectory = path.join(directory, 'opencode', 'launch-attempts')
  await mkdir(ledgerDirectory, { recursive: true })
  const file = path.join(ledgerDirectory, 'receipt.json')
  const attemptId = '123e4567-e89b-42d3-a456-426614174010'
  const payloadHash = 'd'.repeat(64)
  try {
    const ledger = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(file)
    const obligation = await ledger.reserve({ attemptId, payloadHash, generation: 1,
      hostKeyIdentity: identity, hostKeyDigest: 'e'.repeat(64) })
    const exact = { ...obligation, disposition: 'dispose' as const,
      releaseState: 'pending' as const, receipt: {
        schemaVersion: 2 as const, receiptId: '123e4567-e89b-42d3-a456-426614174011',
        hostKeyDigest: obligation.hostKeyDigest, pid: 443, processStartedAtMs: 12_345,
        processBirthToken: 'windows:0000000000000123:01d9abcd000001bb', lifetime: 'persistent' as const,
      } }
    await ledger.record(exact)
    const restarted = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(file)
    expect((await restarted.readObligation({ attemptId, payloadHash, generation: 1,
      obligationId: obligation.obligationId }))?.receipt?.processBirthToken)
      .toBe('windows:0000000000000123:01d9abcd000001bb')
    await expect(ledger.record({ ...exact, receipt: {
      ...exact.receipt, processBirthToken: 'windows:0000000000000123:01D9ABCD000001BB',
    } })).rejects.toThrow('corrupt')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('attempt host release ledger preserves every generation and prepublished acquisition obligation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-host-release-generations-'))
  const ledgerDirectory = path.join(directory, 'opencode', 'launch-attempts')
  await mkdir(ledgerDirectory, { recursive: true })
  const file = path.join(ledgerDirectory, 'receipt.json')
  const attemptId = '123e4567-e89b-42d3-a456-426614174000'
  const payloadHash = 'b'.repeat(64)
  try {
    const ledger = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(file)
    const firstObligation = await ledger.reserve({ attemptId, payloadHash, generation: 1,
      hostKeyIdentity: identity, hostKeyDigest: 'c'.repeat(64) })
    expect(await OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(file).hasUnresolvedAcquisition({
      attemptId, payloadHash, currentGeneration: 2,
    })).toBe(true)
    const first = { ...firstObligation, receipt: { schemaVersion: 1 as const,
      receiptId: '123e4567-e89b-42d3-a456-426614174441', hostKeyDigest: 'c'.repeat(64),
      pid: 441, processStartedAtMs: 1_441, lifetime: 'process' as const } }
    await ledger.record(first)
    const secondObligation = await ledger.reserve({ attemptId, payloadHash, generation: 2,
      hostKeyIdentity: identity, hostKeyDigest: 'd'.repeat(64) })
    const second = { ...secondObligation, disposition: 'keep_alive' as const,
      releaseState: 'complete' as const, receipt: { schemaVersion: 1 as const,
        receiptId: '123e4567-e89b-42d3-a456-426614174442', hostKeyDigest: 'd'.repeat(64),
        pid: 442, processStartedAtMs: 1_442, lifetime: 'persistent' as const } }
    await ledger.record(second)

    const restarted = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(file)
    expect(await restarted.hasUnresolvedAcquisition({ attemptId, payloadHash, currentGeneration: 2 }))
      .toBe(false)
    expect((await restarted.readAllPending({ attemptId, payloadHash, currentGeneration: 2 }))
      .map(record => [record.generation, record.receipt.receiptId]))
      .toEqual([[1, first.receipt.receiptId], [2, second.receipt.receiptId]])
    await restarted.clear((await restarted.readObligation({ attemptId, payloadHash, generation: 2,
      obligationId: secondObligation.obligationId }))!)
    expect((await restarted.readAllPending({ attemptId, payloadHash, currentGeneration: 2 }))
      .map(record => record.generation)).toEqual([1])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('attempt host release ledger updates only the exact obligation when one generation has multiple receipts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-host-release-same-generation-'))
  const ledgerDirectory = path.join(directory, 'opencode', 'launch-attempts')
  await mkdir(ledgerDirectory, { recursive: true })
  const file = path.join(ledgerDirectory, 'receipt.json')
  const expected = { attemptId: '123e4567-e89b-42d3-a456-426614174000',
    payloadHash: 'b'.repeat(64), generation: 1 }
  try {
    const ledger = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(file)
    const predecessor = await ledger.reserve({ ...expected, hostKeyIdentity: identity,
      hostKeyDigest: 'c'.repeat(64) })
    const current = await ledger.reserve({ ...expected, hostKeyIdentity: identity,
      hostKeyDigest: 'd'.repeat(64) })
    const predecessorReceipt = { ...predecessor, disposition: 'dispose' as const,
      releaseState: 'complete' as const, receipt: { schemaVersion: 1 as const,
        receiptId: '123e4567-e89b-42d3-a456-426614174451', hostKeyDigest: 'c'.repeat(64),
        pid: 451, processStartedAtMs: 1_451, lifetime: 'process' as const } }
    const currentReceipt = { ...current, receipt: { schemaVersion: 1 as const,
      receiptId: '123e4567-e89b-42d3-a456-426614174452', hostKeyDigest: 'd'.repeat(64),
      pid: 452, processStartedAtMs: 1_452, lifetime: 'process' as const } }
    await ledger.record(predecessorReceipt)
    await ledger.record(currentReceipt)

    await expect(ledger.read(expected)).rejects.toThrow('ambiguous')
    const persistedCurrent = await ledger.readObligation({ ...expected, obligationId: current.obligationId })
    expect(persistedCurrent).toMatchObject({ obligationId: current.obligationId,
      disposition: 'unknown', releaseState: 'pending', receipt: currentReceipt.receipt })
    const completedCurrent = { ...persistedCurrent!, disposition: 'dispose' as const,
      releaseState: 'complete' as const }
    await ledger.record(completedCurrent)
    expect(await ledger.readObligation({ ...expected, obligationId: predecessor.obligationId }))
      .toMatchObject({ obligationId: predecessor.obligationId, disposition: 'dispose',
        releaseState: 'complete', receipt: predecessorReceipt.receipt })
    expect(await ledger.readObligation({ ...expected, obligationId: current.obligationId }))
      .toEqual(completedCurrent)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('attempt host release ledger CAS fences host substitution and non-monotonic transitions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-host-release-cas-'))
  const ledgerDirectory = path.join(directory, 'opencode', 'launch-attempts')
  await mkdir(ledgerDirectory, { recursive: true })
  const file = path.join(ledgerDirectory, 'receipt.json')
  const expected = { attemptId: '123e4567-e89b-42d3-a456-426614174000',
    payloadHash: 'b'.repeat(64), generation: 1 }
  try {
    const ledger = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(file)
    const reservation = await ledger.reserve({ ...expected, hostKeyIdentity: identity,
      hostKeyDigest: 'c'.repeat(64) })
    await ledger.record({ ...reservation, receipt: { schemaVersion: 1,
      receiptId: '123e4567-e89b-42d3-a456-426614174461', hostKeyDigest: 'c'.repeat(64),
      pid: 461, processStartedAtMs: 1_461, lifetime: 'process' } })
    const acquired = (await ledger.readObligation({ ...expected,
      obligationId: reservation.obligationId }))!

    await expect(ledger.record({ ...acquired, hostKeyIdentity: `sha256:${'d'.repeat(64)}`,
      receipt: { ...acquired.receipt, hostKeyDigest: 'd'.repeat(64), pid: 462 } }))
      .rejects.toThrow('identity')
    const contender = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(file)
    const competing = await Promise.allSettled([
      ledger.record({ ...acquired, disposition: 'dispose' }),
      contender.record({ ...acquired, disposition: 'keep_alive' }),
    ])
    expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(competing.filter(result => result.status === 'rejected')).toHaveLength(1)
    const intended = (await ledger.readObligation({ ...expected,
      obligationId: reservation.obligationId }))!
    const conflictingDisposition = intended.disposition === 'dispose' ? 'keep_alive' : 'dispose'
    await expect(ledger.record({ ...intended, disposition: conflictingDisposition }))
      .rejects.toThrow('disposition changed')
    const completed = { ...intended, releaseState: 'complete' as const }
    await ledger.record(completed)
    await expect(ledger.record({ ...completed, releaseState: 'pending' }))
      .rejects.toThrow('completion regressed')
    expect(await ledger.readObligation({ ...expected, obligationId: reservation.obligationId }))
      .toEqual(completed)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('attempt host release ledger fences a foreign legacy slot before capability reconciliation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-host-release-foreign-legacy-'))
  const ledgerDirectory = path.join(directory, 'opencode', 'launch-attempts')
  await mkdir(ledgerDirectory, { recursive: true })
  const file = path.join(ledgerDirectory, 'receipt.json')
  const expected = { attemptId: '123e4567-e89b-42d3-a456-426614174000',
    payloadHash: 'b'.repeat(64), generation: 3 }
  try {
    await writeFile(file, JSON.stringify({ schemaVersion: 1,
      attemptId: '123e4567-e89b-42d3-a456-426614174999',
      payloadHash: 'f'.repeat(64), generation: 1, hostKeyIdentity: identity,
      receipt: { schemaVersion: 1, receiptId: '123e4567-e89b-42d3-a456-426614174443',
        hostKeyDigest: 'c'.repeat(64), pid: 443, processStartedAtMs: 12_345,
        lifetime: 'process' } }))
    const ledger = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(file)
    await expect(ledger.read(expected)).rejects.toThrow('foreign')
    await expect(ledger.readAllPending({ attemptId: expected.attemptId,
      payloadHash: expected.payloadHash, currentGeneration: expected.generation }))
      .rejects.toThrow('foreign')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test.each([
  ['valid exact ids', { id: 'msg-bootstrap', sessionID: 'ses_member' }, true],
  ['valid normalized compatibility session id', { id: 'msg-bootstrap', sessionId: 'ses_member' }, true],
  ['missing message id', { sessionID: 'ses_member' }, false],
  ['mismatched message id', { id: 'msg-other', sessionID: 'ses_member' }, false],
  ['missing session id', { id: 'msg-bootstrap' }, false],
  ['mismatched session id', { id: 'msg-bootstrap', sessionID: 'ses_other' }, false],
  ['contradictory session id aliases', { id: 'msg-bootstrap', sessionID: 'ses_member',
    sessionId: 'ses_other' }, false],
] as const)('production bootstrap ownership: %s', (_name, info, valid) => {
  const verify = () => assertOpenCodeProductionBootstrapOwnership({
    message: { info, parts: [] }, messageId: 'msg-bootstrap', sessionId: 'ses_member', phase: 'returned',
  })
  if (valid) expect(verify()).toMatchObject({ info })
  else expect(verify).toThrow('returned ownership verification failed')
})

test('production preflight never authorizes reconciliation and omits continuation for completed replay', () => {
  const base = {
    attemptId: '123e4567-e89b-42d3-a456-426614174000',
    payloadHash: 'b'.repeat(64),
    immutableDigest: 'c'.repeat(64),
    generation: 4,
    committed: [],
    deadlineAtMs: 10_000,
  }
  const pending = [`sha256:${'d'.repeat(64)}` as OpenCodeOpaqueIdentity]
  const reconciliation = createOpenCodeLaunchPreflightResult({
    ...base, reconciliationRequired: true, pending,
  })
  expect(reconciliation).toMatchObject({
    attemptId: base.attemptId,
    payloadHash: base.payloadHash,
    generation: 4,
    status: 'reconciliation_required',
    pending,
  })
  expect(reconciliation.continuationToken).toBeUndefined()

  const completed = createOpenCodeLaunchPreflightResult({
    ...base, reconciliationRequired: false, pending: [],
  })
  expect(completed.status).toBe('succeeded')
  expect(completed.continuationToken).toBeUndefined()
})

test('production inspection accepts only exact current replay or exact next-generation capability', () => {
  const initial = { generation: 1, inputDigest: 'a'.repeat(64), consumedContinuationToken: undefined,
    continuation: { issuedGeneration: 1, token: 'token-one', eligibleMemberIdentities: [identity] } }
  expect(inspectOpenCodeProductionGeneration(initial, {
    generation: 1, inputDigest: initial.inputDigest, continuation: false,
  })).toBe('replay')
  expect(inspectOpenCodeProductionGeneration(initial, {
    generation: 2, inputDigest: 'b'.repeat(64), continuation: true, continuationToken: 'token-one',
  })).toBe('continue')
  for (const changed of [
    { generation: 2, inputDigest: initial.inputDigest, continuation: false },
    { generation: 1, inputDigest: 'b'.repeat(64), continuation: false },
    { generation: 1, inputDigest: initial.inputDigest, continuation: true, continuationToken: 'token-one' },
    { generation: 2, inputDigest: 'b'.repeat(64), continuation: true, continuationToken: 'changed' },
    { generation: 3, inputDigest: 'b'.repeat(64), continuation: true, continuationToken: 'token-one' },
  ]) expect(() => inspectOpenCodeProductionGeneration(initial, changed)).toThrow()

  const continued = { generation: 2, inputDigest: 'b'.repeat(64), continuation: undefined,
    consumedContinuationToken: 'token-one' }
  expect(inspectOpenCodeProductionGeneration(continued, {
    generation: 2, inputDigest: continued.inputDigest, continuation: true, continuationToken: 'token-one',
  })).toBe('replay')
  expect(() => inspectOpenCodeProductionGeneration(continued, {
    generation: 2, inputDigest: continued.inputDigest, continuation: true, continuationToken: 'changed',
  })).toThrow()
})

test('claimed remote cleanup requires the exact accepted-proof journal intent authority', () => {
  const claim = {
    ...identityForProductionClaim(identity, 1, 'acquisition-1.claim-one'),
    version: 1 as const,
    targetDigest: 'f'.repeat(64),
    idempotencyIdentity: 'ses_authoritative',
    state: 'claimed' as const,
  }
  const journal = {
    acceptedProofResponse: {} as never,
    generation: claim.generation,
    fence: claim.fence,
    inputDigest: claim.inputDigest,
    immutableDigest: claim.immutableDigest,
    events: [{
      type: 'member_intent' as const,
      sequence: 1,
      generation: claim.generation,
      fence: claim.fence,
      memberIdentity: claim.memberIdentity,
      claimToken: claim.claimToken,
      inputDigest: claim.inputDigest,
    }],
  }
  expect(hasExactOpenCodeClaimReconciliationAuthority(journal, true, claim)).toBe(true)
  expect(hasExactOpenCodeClaimReconciliationAuthority(journal, false, claim)).toBe(false)
  expect(hasExactOpenCodeClaimReconciliationAuthority({ ...journal, acceptedProofResponse: undefined }, true, claim))
    .toBe(false)
  expect(hasExactOpenCodeClaimReconciliationAuthority({ ...journal, inputDigest: '0'.repeat(64) }, true, claim))
    .toBe(false)
  expect(hasExactOpenCodeClaimReconciliationAuthority({ ...journal, events: journal.events.map(event => ({
    ...event, claimToken: 'acquisition-1.invented',
  })) }, true, claim)).toBe(false)
  expect(hasExactOpenCodeClaimReconciliationAuthority({ ...journal, events: [...journal.events, {
    ...journal.events[0]!, sequence: 2, type: 'member_unknown' as const,
  }] }, true, claim)).toBe(false)
})

test('production authority continues member 1 committed/member 2 proven failure only in generation 2', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-production-continuation-'))
  try {
    const attemptId = '123e4567-e89b-42d3-a456-426614174000'
    const payloadHash = 'b'.repeat(64)
    const immutableDigest = 'c'.repeat(64)
    const firstDigest = 'd'.repeat(64)
    const secondDigest = 'e'.repeat(64)
    const secondMember = `sha256:${'5'.repeat(64)}` as OpenCodeOpaqueIdentity
    // Keep the journal below its two mutable namespace levels so the retained
    // authority root is this disposable fixture, never the filesystem root.
    const store = new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(
      path.join(directory, 'launch-attempts', 'attempt.journal')))
    const ledger = new OpenCodeLaunchMutationLedger(path.join(directory, 'claims'))
    const targetOne = OpenCodeLaunchMutationLedger.targetDigest({
      teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project', memberName: 'alice',
    })
    const targetTwo = OpenCodeLaunchMutationLedger.targetDigest({
      teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project', memberName: 'bob',
    })
    const now = new Date().toISOString()
    const record: OpenCodeSessionRecord = {
      version: 2,
      teamId: 'team', laneId: 'primary', memberName: 'alice', providerId: 'opencode',
      selectedModel: 'openrouter/model', projectIdentity: '/fake/project', projectPath: '/fake/project',
      runId: null, profileRootKey: 'profile', hostKey: 'host',
      resolvedBehaviorFingerprint: null, opencodeSessionId: OpenCodeLaunchMutationLedger.idempotencyIdentity(targetOne),
      lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: null,
      sourceAuthFingerprint: null, managedAuthFingerprint: null, projectBehaviorFingerprint: 'behavior',
      staleReason: null, appManagedBootstrap: { schemaVersion: 1, messageID: 'msg',
        contextHash: '1'.repeat(64), briefingHash: '2'.repeat(64), injectionVerifiedAt: now,
        model: 'openrouter/model', agent: 'teammate-bootstrap' }, createdAt: now, updatedAt: now,
    }
    const firstLinkage = linkageForTest(identity, record)
    const firstRecovery = { ownershipTitle: 'agent-teams-launch:owned', sessionRecord: record }
    const makeIdentity = (lease: { generation: number; fence: number; acquisitionToken: string },
      claimToken: string, memberIdentity: OpenCodeOpaqueIdentity, inputDigest: string): OpenCodeLaunchMutationIdentity => ({
      attemptId, payloadHash, immutableDigest, inputDigest, memberIdentity, claimToken,
      logicalMember: { teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project',
        memberName: memberIdentity === identity ? 'alice' : 'bob' },
      generation: lease.generation, fence: lease.fence, acquisitionToken: lease.acquisitionToken,
    })
    const deadline = productionContext()
    let continuationToken = ''
    let failedClaimToken = ''
    await store.withGeneration({ attemptId, payloadHash, immutableDigest, inputDigest: firstDigest,
      generation: 1, startedAtMs: Date.now(), totalBudgetMs: 10_000 }, 'begin', async lease => {
      const firstClaim = await lease.claim(identity)
      const firstAuthority = makeIdentity(lease, firstClaim, identity, firstDigest)
      expect(await ledger.claim(targetOne, firstAuthority, deadline)).toBe('claimed')
      expect(await transitionOpenCodeProductionMemberClaim(ledger, targetOne,
        { ...firstAuthority, transition: 'commit', linkage: firstLinkage, recovery: firstRecovery }, deadline))
        .toBe('committed')
      await lease.append({ type: 'member_applied', memberIdentity: identity,
        linkage: firstLinkage, claimToken: firstClaim })

      const secondClaim = await lease.claim(secondMember)
      failedClaimToken = secondClaim
      const secondAuthority = makeIdentity(lease, secondClaim, secondMember, firstDigest)
      expect(await ledger.claim(targetTwo, secondAuthority, deadline)).toBe('claimed')
      expect(await transitionOpenCodeProductionMemberClaim(ledger, targetTwo,
        { ...secondAuthority, transition: 'cancel', provenNoExternalEffect: true }, deadline)).toBe('cancelled')
      await lease.append({ type: 'member_failed', memberIdentity: secondMember,
        failure: 'pre_side_effect_transport', externalEffect: false, claimToken: secondClaim })
      continuationToken = await lease.issueContinuation([secondMember])
    }, deadline)

    await store.withGeneration({ attemptId, payloadHash, immutableDigest, inputDigest: secondDigest,
      generation: 2, continuationToken }, 'continue', async lease => {
      expect((await ledger.read(targetOne, deadline))?.state).toBe('committed')
      await lease.reconcile({ type: 'member_reconciled_absent', memberIdentity: secondMember,
        claimToken: failedClaimToken })
      const secondClaim = await lease.claim(secondMember)
      const secondAuthority = makeIdentity(lease, secondClaim, secondMember, secondDigest)
      expect(await ledger.claim(targetTwo, secondAuthority, deadline)).toBe('claimed')
    }, deadline)
    expect(await store.inspect({ attemptId, payloadHash, immutableDigest, inputDigest: secondDigest }))
      .toMatchObject({ generation: 2, authorizedMemberIdentities: [secondMember] })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('production maps unknown transport to permanent unknown and never to reclaimable known failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-production-unknown-'))
  try {
    const ledger = new OpenCodeLaunchMutationLedger(path.join(directory, 'claims'))
    const unknownTarget = OpenCodeLaunchMutationLedger.targetDigest({
      teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project', memberName: 'alice',
    })
    const owner = identityForProductionClaim(identity, 1, 'claim-one')
    expect(await ledger.claim(unknownTarget, owner, productionContext())).toBe('claimed')
    expect(await transitionOpenCodeProductionMemberClaim(ledger, unknownTarget,
      { ...owner, transition: 'cancel' }, productionContext())).toBe('cancelled')
    expect((await ledger.read(unknownTarget, productionContext()))?.state).toBe('unknown')
    const next = identityForProductionClaim(identity, 2, 'claim-two')
    expect(await ledger.claim(unknownTarget, next, productionContext())).toBe('unknown')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

function identityForProductionClaim(
  memberIdentity: OpenCodeOpaqueIdentity,
  generation: number,
  claimToken: string,
): OpenCodeLaunchMutationIdentity {
  return {
    attemptId: '123e4567-e89b-42d3-a456-426614174000', payloadHash: 'b'.repeat(64),
    inputDigest: generation === 1 ? 'c'.repeat(64) : 'd'.repeat(64), immutableDigest: 'e'.repeat(64),
    generation, fence: generation, acquisitionToken: `acquisition-${generation}`,
    claimToken, memberIdentity,
    logicalMember: { teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project', memberName: 'alice' },
  }
}

test('migrated V1 known-failure restart uses one durable identity for lookup, effect, and commit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-production-v1-identity-'))
  try {
    const claimsDirectory = path.join(directory, 'claims')
    await mkdir(claimsDirectory)
    const ledger = new OpenCodeLaunchMutationLedger(claimsDirectory)
    const logicalMember = { teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project',
      memberName: 'alice' }
    const memberIdentity = identity
    const canonicalTarget = OpenCodeLaunchMutationLedger.targetDigest(logicalMember)
    const legacyTarget = createHash('sha256').update(JSON.stringify({ teamId: logicalMember.teamId,
      laneId: logicalMember.laneId, projectIdentity: logicalMember.projectIdentity, memberIdentity })).digest('hex')
    const durableSessionId = OpenCodeLaunchMutationLedger.idempotencyIdentity(legacyTarget)
    const canonicalSessionId = OpenCodeLaunchMutationLedger.idempotencyIdentity(canonicalTarget)
    expect(durableSessionId).not.toBe(canonicalSessionId)

    const retry = identityForProductionClaim(memberIdentity, 2, 'acquisition-2.claim-retry')
    const predecessor = {
      version: 1 as const, targetDigest: legacyTarget, idempotencyIdentity: durableSessionId,
      state: 'known_failure' as const, attemptId: retry.attemptId, payloadHash: retry.payloadHash,
      inputDigest: 'c'.repeat(64), immutableDigest: retry.immutableDigest,
      generation: 1, fence: 1, acquisitionToken: 'acquisition-1',
      claimToken: 'acquisition-1.claim-legacy', memberIdentity,
    }
    const predecessorPersistence = new OpenCodeLaunchFileJournalPersistence(
      path.join(claimsDirectory, `${legacyTarget}.claim`))
    const predecessorContext = productionContext()
    const releasePredecessor = await predecessorPersistence.acquireExclusive(predecessorContext)
    try {
      await predecessorPersistence.replaceAndSync(
        new TextEncoder().encode(JSON.stringify(predecessor)), predecessorContext)
    } finally { await releasePredecessor(predecessorContext) }
    expect(await ledger.claim(canonicalTarget, retry, productionContext())).toBe('claimed')

    const remote = new Map<string, { id: string; title: string }>()
    const lookupIds: string[] = []
    const createIds: string[] = []
    const title = `agent-teams-launch:${retry.attemptId}:${memberIdentity}:owned`
    const applyOnce = async (): Promise<void> => {
      const durable = await readOpenCodeProductionMemberClaim(
        ledger, canonicalTarget, retry, productionContext())
      expect(durable?.legacyTargetDigest).toBe(legacyTarget)
      const sessionId = durable!.idempotencyIdentity
      lookupIds.push(sessionId)
      if (!remote.has(sessionId)) {
        createIds.push(sessionId)
        remote.set(sessionId, { id: sessionId, title })
      }
    }

    // The first process crashes after the effect and before settlement. The
    // restarted process looks up the same durable identity and does not create
    // a second effect under the canonical logical digest.
    await applyOnce()
    await applyOnce()

    const now = new Date().toISOString()
    const record: OpenCodeSessionRecord = {
      version: 2,
      teamId: 'team', laneId: 'primary', memberName: 'alice', providerId: 'opencode',
      selectedModel: 'openrouter/model', projectIdentity: '/fake/project', projectPath: '/fake/project',
      runId: null, profileRootKey: 'profile', hostKey: 'host',
      resolvedBehaviorFingerprint: null, opencodeSessionId: durableSessionId,
      lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: null,
      sourceAuthFingerprint: null, managedAuthFingerprint: null, projectBehaviorFingerprint: 'behavior',
      bootstrapMode: 'app_managed_context', bootstrapEvidenceSource: 'app_managed_bootstrap',
      appManagedBootstrap: { schemaVersion: 1, messageID: 'msg_v1', contextHash: '1'.repeat(64),
        briefingHash: '2'.repeat(64), injectionVerifiedAt: now, model: 'openrouter/model',
        agent: 'teammate-bootstrap' }, staleReason: null, createdAt: now, updatedAt: now,
    }
    const linkage = linkageForTest(memberIdentity, record)
    expect(await transitionOpenCodeProductionMemberClaim(ledger, canonicalTarget,
      { ...retry, transition: 'commit', linkage, recovery: { ownershipTitle: title, sessionRecord: record } },
      productionContext())).toBe('committed')
    expect(await ledger.read(canonicalTarget, productionContext())).toMatchObject({
      state: 'committed', legacyTargetDigest: legacyTarget, idempotencyIdentity: durableSessionId,
      recovery: { sessionRecord: { opencodeSessionId: durableSessionId } },
    })
    expect({ lookupIds, createIds, remoteIds: [...remote.keys()] }).toEqual({
      lookupIds: [durableSessionId, durableSessionId], createIds: [durableSessionId],
      remoteIds: [durableSessionId],
    })
    expect(remote.has(canonicalSessionId)).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('production member mutation registers deterministic ownership before an ambiguous create rejection', async () => {
  const calls: string[] = []
  let ownedSessionIdentity: string | undefined

  await expect(createOpenCodeOwnedMemberSession({
    memberIdentity: identity,
    authoritativeSessionId: 'session-deterministic',
    registerRecord: () => { calls.push('record') },
    registerOwned: owned => {
      calls.push('owned')
      ownedSessionIdentity = owned.sessionIdentity
    },
    createSession: async () => {
      calls.push('create')
      throw new Error('ambiguous transport rejection')
    },
  })).rejects.toThrow('ambiguous transport rejection')

  expect(calls).toEqual(['record', 'owned', 'create'])
  expect(ownedSessionIdentity).toMatch(/^sha256:[0-9a-f]{64}$/)
})

test('ambiguous create reconciliation physically deletes the exact attempt-owned remote session', async () => {
  const remote = new Map<string, { id: string; title: string }>()
  const id = 'session-deterministic'
  const title = 'agent-teams-launch:attempt-a:member-a'
  await expect(createOpenCodeOwnedMemberSession({
    memberIdentity: identity,
    authoritativeSessionId: id,
    registerRecord: () => {},
    registerOwned: () => {},
    createSession: async () => {
      remote.set(id, { id, title })
      throw new Error('response lost after remote commit')
    },
  })).rejects.toThrow('response lost')
  let deletes = 0
  expect(await reconcileOpenCodeOwnedMemberSession({
    authoritativeSessionId: id,
    ownershipTitle: title,
    getSession: async sessionId => {
      const found = remote.get(sessionId)
      if (!found) throw new Error('request failed (404 Not Found)')
      return found
    },
    deleteSession: async sessionId => { deletes += 1; return remote.delete(sessionId) },
  })).toBe('deleted')
  expect(deletes).toBe(1)
  expect(remote.has(id)).toBe(false)
})

test('reconciliation proves absence and never deletes a foreign or reused deterministic id', async () => {
  const id = 'session-deterministic'
  const foreign = { id, title: 'ordinary user session' }
  let deletes = 0
  expect(await reconcileOpenCodeOwnedMemberSession({
    authoritativeSessionId: id,
    ownershipTitle: 'agent-teams-launch:attempt-a:member-a',
    getSession: async () => foreign,
    deleteSession: async () => { deletes += 1; return true },
  })).toBe('foreign')
  expect(deletes).toBe(0)
  expect(await reconcileOpenCodeOwnedMemberSession({
    authoritativeSessionId: id,
    ownershipTitle: 'agent-teams-launch:attempt-a:member-a',
    getSession: async () => { throw new Error('request failed (404 Not Found)') },
    deleteSession: async () => { deletes += 1; return true },
  })).toBe('absent')
  expect(deletes).toBe(0)
})

test('production proof composition retires an exact crashed generation before a changed-nonce generation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-proof-cleanup-'))
  try {
    const ledger = new OpenCodeProofSessionCleanupLedger(path.join(directory, 'proof.json'))
    const remote = new Map<string, { id: string; title: string }>()
    let nonce = 'nonce-a'
    const ownership = (generation: number) => ({ authoritativeSessionId: `proof-${generation}`,
      ownershipTitle: `agent-teams-proof:attempt-a:${generation}:${nonce}` })
    const reconcile = (record: { authoritativeSessionId: string; ownershipTitle: string }) =>
      reconcileOpenCodeOwnedMemberSession({ ...record,
        getSession: async id => { const value = remote.get(id); if (!value) throw notFound(); return value },
        deleteSession: async id => remote.delete(id) })
    const first = await ledger.reconcileAndRegister({ attemptId: 'attempt-a', requestGeneration: 1,
      hostKeyIdentity: identity, ownership, reconcile })
    expect(first.created).toBe(true)
    expect(first.record.generation).toBe(1)
    expect((await ledger.read())?.state).toBe('registered')
    // Crash failpoint: POST committed but no response/state update was persisted.
    remote.set(first.record.authoritativeSessionId, { id: first.record.authoritativeSessionId,
      title: first.record.ownershipTitle })
    nonce = 'nonce-b'
    const restarted = new OpenCodeProofSessionCleanupLedger(path.join(directory, 'proof.json'))
    const second = await restarted.reconcileAndRegister({ attemptId: 'attempt-a', requestGeneration: 2,
      hostKeyIdentity: identity, ownership, reconcile })
    expect(second.created).toBe(true)
    expect(second.priorOutcome).toBe('deleted')
    expect(second.record.generation).toBe(2)
    expect(second.record.ownershipTitle).toContain('nonce-b')
    expect(remote.size).toBe(0)
    expect((await restarted.readGenerations())?.retired).toHaveLength(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('production proof ledger persists the attempt-bound observation handle across restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-proof-observation-'))
  try {
    const file = path.join(directory, 'proof.json')
    const ledger = new OpenCodeProofSessionCleanupLedger(file)
    const registration = await ledger.reconcileAndRegister({
      attemptId: 'attempt-a', requestGeneration: 1, hostKeyIdentity: identity,
      ownership: generation => ({ authoritativeSessionId: `proof-${generation}`,
        ownershipTitle: `owned-${generation}` }), reconcile: async () => 'absent',
    })
    const owned = await ledger.recordState(registration.record, 'owned')
    const observed = await ledger.recordObservationMessage(owned, 'msg-proof-accepted')
    expect(observed.observationMessageId).toBe('msg-proof-accepted')

    const restarted = new OpenCodeProofSessionCleanupLedger(file)
    expect(await restarted.read()).toMatchObject({
      attemptId: 'attempt-a', requestGeneration: 1, hostKeyIdentity: identity,
      authoritativeSessionId: 'proof-1', state: 'owned',
      observationMessageId: 'msg-proof-accepted',
    })
    await expect(restarted.recordObservationMessage(observed, 'msg-substituted'))
      .rejects.toThrow('identity changed')
    expect((await restarted.read())?.observationMessageId).toBe('msg-proof-accepted')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('production restart re-observes the exact persisted proof owner and message', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-proof-roster-restart-'))
  try {
    const proofFile = path.join(directory, 'proof.json')
    const firstRun = new OpenCodeProofSessionCleanupLedger(proofFile)
    const registration = await firstRun.reconcileAndRegister({
      attemptId: 'attempt-a', requestGeneration: 1, hostKeyIdentity: identity,
      ownership: generation => deriveOpenCodeProductionProofOwnership({
        attemptId: 'attempt-a', requestGeneration: 1, proofGeneration: generation,
        hostKeyIdentity: identity,
      }), reconcile: async () => 'absent',
    })
    const owned = await firstRun.recordState(registration.record, 'owned')
    await firstRun.recordObservationMessage(owned, 'msg-proof-accepted')

    const restarted = new OpenCodeProofSessionCleanupLedger(proofFile)
    const resolved = await resolveOpenCodeProductionRetainedProofRecord({
      ledger: restarted, attemptId: 'attempt-a', requestGeneration: 1,
      hostKeyIdentity: identity, deadlineAtMs: Date.now() + 10_000,
      signal: new AbortController().signal,
    })
    expect(resolved.observationMessageId).toBe('msg-proof-accepted')
    const remoteMessage = { info: { id: 'msg-proof-accepted', sessionID: resolved.authoritativeSessionId,
      providerID: 'anthropic', modelID: 'model' }, parts: [{ type: 'text', text: 'nonce' }] }
    expect(await reobserveOpenCodeProductionRetainedProof({
      retainedProof: resolved,
      getSession: async () => ({ id: resolved.authoritativeSessionId, title: resolved.ownershipTitle }),
      getSessionMessage: async () => remoteMessage,
    })).toBe(remoteMessage)

    await expect(resolveOpenCodeProductionRetainedProofRecord({
      ledger: restarted, attemptId: 'attempt-a', requestGeneration: 2,
      hostKeyIdentity: identity, deadlineAtMs: Date.now() + 10_000,
      signal: new AbortController().signal,
    })).rejects.toThrow('retained proof is unavailable')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test.each([
  ['replaced or reused session',
    (proof: NonNullable<Awaited<ReturnType<OpenCodeProofSessionCleanupLedger['read']>>>) => ({
      session: { id: 'ses_replaced', title: proof.ownershipTitle }, messageId: proof.observationMessageId,
    }), 'session ownership changed'],
  ['wrong ownership title',
    (proof: NonNullable<Awaited<ReturnType<OpenCodeProofSessionCleanupLedger['read']>>>) => ({
      session: { id: proof.authoritativeSessionId, title: `${proof.ownershipTitle}:foreign` },
      messageId: proof.observationMessageId,
    }), 'session ownership changed'],
  ['substituted message id',
    (proof: NonNullable<Awaited<ReturnType<OpenCodeProofSessionCleanupLedger['read']>>>) => ({
      session: { id: proof.authoritativeSessionId, title: proof.ownershipTitle }, messageId: 'msg-substituted',
    }), 'message identity changed'],
  ['missing message id',
    (proof: NonNullable<Awaited<ReturnType<OpenCodeProofSessionCleanupLedger['read']>>>) => ({
      session: { id: proof.authoritativeSessionId, title: proof.ownershipTitle }, messageId: undefined,
    }), 'message identity changed'],
  ['missing message session id',
    (proof: NonNullable<Awaited<ReturnType<OpenCodeProofSessionCleanupLedger['read']>>>) => ({
      session: { id: proof.authoritativeSessionId, title: proof.ownershipTitle },
      messageId: proof.observationMessageId,
    }), 'message session changed'],
  ['mismatched message session id',
    (proof: NonNullable<Awaited<ReturnType<OpenCodeProofSessionCleanupLedger['read']>>>) => ({
      session: { id: proof.authoritativeSessionId, title: proof.ownershipTitle },
      messageId: proof.observationMessageId,
    }), 'message session changed'],
] as const)('production restart fails closed on %s', async (_name, mutate, expected) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-proof-reobserve-fake-'))
  try {
    const file = path.join(directory, 'proof.json')
    const firstRun = new OpenCodeProofSessionCleanupLedger(file)
    const registration = await firstRun.reconcileAndRegister({
      attemptId: 'attempt-a', requestGeneration: 1, hostKeyIdentity: identity,
      ownership: generation => deriveOpenCodeProductionProofOwnership({
        attemptId: 'attempt-a', requestGeneration: 1, proofGeneration: generation,
        hostKeyIdentity: identity,
      }), reconcile: async () => 'absent',
    })
    const owned = await firstRun.recordState(registration.record, 'owned')
    await firstRun.recordObservationMessage(owned, 'msg-proof-accepted')
    const retainedProof = await new OpenCodeProofSessionCleanupLedger(file).read()
    expect(retainedProof).not.toBeNull()
    const changed = mutate(retainedProof!)
    await expect(reobserveOpenCodeProductionRetainedProof({
      retainedProof: retainedProof!,
      getSession: async () => changed.session,
      getSessionMessage: async () => ({ info: { id: changed.messageId,
        ...(_name === 'missing message session id' ? {}
          : { sessionID: _name === 'mismatched message session id'
            ? 'ses_other' : retainedProof!.authoritativeSessionId }) }, parts: [] }),
    })).rejects.toThrow(expected)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('proof cleanup refuses an expired immutable launch deadline before publication', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-proof-deadline-'))
  try {
    const file = path.join(directory, 'proof.json')
    const ledger = new OpenCodeProofSessionCleanupLedger(file)
    await expect(ledger.reconcileAndRegister({ attemptId: 'attempt-a', requestGeneration: 1,
      hostKeyIdentity: identity, ownership: generation => ({ authoritativeSessionId: `proof-${generation}`,
        ownershipTitle: `owned-${generation}` }), reconcile: async () => 'absent' }, {
      deadlineAtMs: Date.now() - 1, signal: new AbortController().signal,
    })).rejects.toThrow('deadline expired')
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('proof cleanup bounds a previous physical lease wait without releasing successor serialization', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-proof-physical-'))
  try {
    const controlled = controlledProofDirectories()
    const ledger = new OpenCodeProofSessionCleanupLedger(path.join(directory, 'proof.json'), controlled.open)
    const firstDeadline = Date.now() + 5_000
    await ledger.read({ deadlineAtMs: firstDeadline, signal: new AbortController().signal })
    expect(controlled.opens()).toBe(1)

    const expired = Date.now() + 30
    await expect(ledger.read({ deadlineAtMs: expired, signal: new AbortController().signal }))
      .rejects.toThrow('deadline expired')
    expect(controlled.opens()).toBe(1)

    const successorDeadline = Date.now() + 5_000
    const successor = ledger.read({ deadlineAtMs: successorDeadline, signal: new AbortController().signal })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controlled.opens()).toBe(1)
    controlled.settle(0)
    await successor
    expect(controlled.opens()).toBe(2)
    expect(controlled.deadlines()).toEqual([firstDeadline, successorDeadline])
    controlled.settle(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('proof cleanup cancellation abandons only its queued caller and preserves the physical predecessor', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-proof-cancel-'))
  try {
    const controlled = controlledProofDirectories()
    const ledger = new OpenCodeProofSessionCleanupLedger(path.join(directory, 'proof.json'), controlled.open)
    await ledger.read({ deadlineAtMs: Date.now() + 5_000, signal: new AbortController().signal })
    const abort = new AbortController()
    const cancelled = ledger.read({ deadlineAtMs: Date.now() + 5_000, signal: abort.signal })
    abort.abort(new Error('caller cancelled'))
    await expect(cancelled).rejects.toThrow('caller cancelled')
    expect(controlled.opens()).toBe(1)

    const successor = ledger.read({ deadlineAtMs: Date.now() + 5_000,
      signal: new AbortController().signal })
    await new Promise(resolve => setTimeout(resolve, 0)); expect(controlled.opens()).toBe(1)
    controlled.settle(0); await successor
    expect(controlled.opens()).toBe(2)
    controlled.settle(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('proof generations continue after absent/deleted truth but never pass unresolved or foreign ownership', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-proof-cleanup-'))
  try {
    const ledger = new OpenCodeProofSessionCleanupLedger(path.join(directory, 'proof.json'))
    let ownershipCalls = 0
    const ownership = (generation: number) => { ownershipCalls += 1; return {
      authoritativeSessionId: `proof-${generation}`, ownershipTitle: `owned-${generation}` } }
    const first = await ledger.reconcileAndRegister({ attemptId: 'attempt-a', requestGeneration: 1,
      hostKeyIdentity: identity, ownership, reconcile: async () => 'absent' })
    await ledger.recordState(first.record, 'absent')
    const second = await ledger.reconcileAndRegister({ attemptId: 'attempt-a', requestGeneration: 1,
      hostKeyIdentity: identity, ownership, reconcile: async () => { throw new Error('must not reconcile terminal') } })
    expect(second.record.generation).toBe(2)
    const unresolved = await ledger.reconcileAndRegister({ attemptId: 'attempt-a', requestGeneration: 2,
      hostKeyIdentity: identity, ownership, reconcile: async () => 'unresolved' })
    expect(unresolved.created).toBe(false)
    expect(unresolved.record.state).toBe('unresolved')
    expect(ownershipCalls).toBe(2)
    let foreignReconciliations = 0
    const foreign = await ledger.reconcileAndRegister({ attemptId: 'attempt-a', requestGeneration: 2,
      hostKeyIdentity: identity, ownership, reconcile: async () => { foreignReconciliations += 1; return 'foreign' } })
    expect(foreign.created).toBe(false)
    expect(foreign.record.state).toBe('foreign')
    expect(foreignReconciliations).toBe(1)
    const stillForeign = await ledger.reconcileAndRegister({ attemptId: 'attempt-a', requestGeneration: 2,
      hostKeyIdentity: identity, ownership, reconcile: async () => { foreignReconciliations += 1; return 'absent' } })
    expect(stillForeign.record.state).toBe('foreign')
    expect(foreignReconciliations).toBe(1)
    expect(ownershipCalls).toBe(2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('restart migrates the exact-head proof record and refuses reconciliation through a changed host', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-proof-legacy-'))
  try {
    const file = path.join(directory, 'proof.json')
    await writeFile(file, JSON.stringify({ version: 1, attemptId: 'attempt-a', hostKeyIdentity: identity,
      authoritativeSessionId: 'proof-legacy', ownershipTitle: 'owned-legacy', state: 'deleted',
      updatedAt: new Date(0).toISOString() }))
    const ledger = new OpenCodeProofSessionCleanupLedger(file)
    const migrated = await ledger.reconcileAndRegister({ attemptId: 'attempt-a', requestGeneration: 2,
      hostKeyIdentity: identity, ownership: generation => ({ authoritativeSessionId: `proof-${generation}`,
        ownershipTitle: `owned-${generation}` }), reconcile: async () => { throw new Error('terminal state') } })
    expect(migrated.created).toBe(true)
    expect(migrated.record.generation).toBe(2)
    const changedHost = `sha256:${'b'.repeat(64)}` as OpenCodeOpaqueIdentity
    const blocked = await ledger.reconcileAndRegister({ attemptId: 'attempt-a', requestGeneration: 3,
      hostKeyIdentity: changedHost, ownership: generation => ({ authoritativeSessionId: `proof-${generation}`,
        ownershipTitle: `owned-${generation}` }), reconcile: async () => 'absent' })
    expect(blocked.created).toBe(false)
    expect(blocked.priorOutcome).toBe('unresolved')
    expect(blocked.record.hostKeyIdentity).toBe(identity)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('production wiring uses normalized Alice lookup and rejects intent without exact mutation authority before effects', async () => {
  const fixture = await productionRecoveryHarness()
  try {
    const seeded = await fixture.seedIntent()
    const caseVariant = { ...seeded.record, memberName: 'Alice' }
    await fixture.sessionStore.upsert(caseVariant)

    await expect(fixture.bridge.execute(fixture.command)).rejects.toThrow('explicit reconciliation')
    expect(fixture.memberCreates()).toBe(0)
    expect(await fixture.sessionStore.get('team', 'primary', 'alice')).toEqual(caseVariant)
    const journal = await fixture.inspectJournal()
    expect(journal?.events.map(event => event.type)).not.toContain('member_reconciled_applied')
  } finally { await fixture.dispose() }
})

test('production preflight repairs an exact committed claim after commit-before-upsert crash', async () => {
  const fixture = await productionRecoveryHarness()
  try {
    const seeded = await fixture.seedIntent({ acceptedProof: true })
    await fixture.commitClaim(seeded)

    const output = await fixture.bridge.execute(fixture.command)
    const data = output.data as { launchAttempt?: unknown; members?: unknown } | null

    expect(data?.launchAttempt).toMatchObject({ launchAttempt: { outcome: 'succeeded' } })
    expect(data?.members).toMatchObject({ alice: {
      launchState: 'created', sessionId: seeded.record.opencodeSessionId,
    } })
    expect(fixture.memberCreates()).toBe(0)
    expect(await fixture.sessionStore.get('team', 'primary', 'alice')).toEqual(seeded.record)
    expect((await fixture.inspectJournal())?.events.map(event => event.type))
      .toContain('member_reconciled_applied')
  } finally { await fixture.dispose() }
})

test('production recovery fails closed when a successor wins retained-host lease CAS', async () => {
  let retains = 0
  let localReleases = 0
  const manager = {
    ensureScopedHostReference: async () => { throw new Error('must not provision during recovery') },
    releaseHostReference: async () => { localReleases += 1 },
    hasExactRetainedHostReleaseCapability: () => false,
    retainHostLease: async () => { retains += 1; return 'foreign' as const },
    reconcileHostReleaseReceipt: async () => {},
  } as unknown as OpenCodeHostManager
  const fixture = await productionRecoveryHarness(manager)
  try {
    const seeded = await fixture.seedIntent({ acceptedProof: true })
    await fixture.commitClaim(seeded)
    await fixture.sessionStore.upsert(seeded.record)

    let failure: unknown
    try { await fixture.bridge.execute(fixture.command) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(OpenCodeRetainedHostLeaseForeignError)
    expect((failure as OpenCodeRetainedHostLeaseForeignError).code)
      .toBe('OPENCODE_RETAINED_HOST_LEASE_FOREIGN')
    expect((failure as Error).message).toBe('OpenCode retained host lease custody changed [redacted]')
    expect({ retains, localReleases, creates: fixture.memberCreates(), mcp: fixture.mcpChecks() })
      .toEqual({ retains: 1, localReleases: 0, creates: 0, mcp: 0 })
    expect(await fixture.readSessionProjection()).toEqual(seeded.record)
  } finally { await fixture.dispose() }
}, 15_000)

const staleProductionAuthorityCases = [
    ['pending claim', async (fixture: Awaited<ReturnType<typeof productionRecoveryHarness>>, seeded: ProductionSeed) => {
      expect(await fixture.ledger.claim(fixture.target, seeded.authority, fixture.context)).toBe('claimed')
      fixture.remote.set(fixture.sessionId, { id: fixture.sessionId, title: seeded.title })
      await fixture.sessionStore.upsert(seeded.record)
      expect(await fixture.ledger.read(fixture.target, fixture.context)).toMatchObject({ state: 'claimed' })
      expect(await fixture.readSessionProjection()).toEqual(seeded.record)
    }],
    ['released claim', async (fixture: Awaited<ReturnType<typeof productionRecoveryHarness>>, seeded: ProductionSeed) => {
      expect(await fixture.ledger.claim(fixture.target, seeded.authority, fixture.context)).toBe('claimed')
      expect(await fixture.ledger.transition(fixture.target, seeded.authority, 'known_failure', undefined,
        fixture.context)).toBe('cancelled')
      await fixture.sessionStore.upsert(seeded.record)
    }],
    ...([
      ['stale generation', { generation: 2 }],
      ['stale fence', { fence: 2 }],
      ['mismatched claim token', { claimToken: '' }],
    ] as const).map(([name, authority]) => [name,
      async (fixture: Awaited<ReturnType<typeof productionRecoveryHarness>>, seeded: ProductionSeed) => {
        await fixture.commitClaim({ ...seeded, authority: { ...seeded.authority, ...authority,
          ...('claimToken' in authority && authority.claimToken === '' ? {
            claimToken: `${seeded.authority.acquisitionToken}.foreign`,
          } : {}) } })
        await fixture.sessionStore.upsert(seeded.record)
      }] as const),
    ['mismatched member claim', async (fixture: Awaited<ReturnType<typeof productionRecoveryHarness>>,
      seeded: ProductionSeed) => {
      const otherMember = `sha256:${'9'.repeat(64)}` as OpenCodeOpaqueIdentity
      const otherTarget = OpenCodeLaunchMutationLedger.targetDigest({ teamId: 'team', laneId: 'primary',
        projectIdentity: fixture.command.projectPath, memberName: 'alice' })
      expect(await fixture.ledger.claim(otherTarget, { ...seeded.authority,
        memberIdentity: otherMember }, fixture.context)).toBe('claimed')
      await fixture.sessionStore.upsert(seeded.record)
    }],
    ['mismatched session', async (fixture: Awaited<ReturnType<typeof productionRecoveryHarness>>, seeded: ProductionSeed) => {
      await fixture.commitClaim(seeded)
      await fixture.sessionStore.upsert({ ...seeded.record, opencodeSessionId: 'ses_foreign' })
    }],
    ['mismatched message', async (fixture: Awaited<ReturnType<typeof productionRecoveryHarness>>, seeded: ProductionSeed) => {
      await fixture.commitClaim(seeded)
      await fixture.sessionStore.upsert({ ...seeded.record, appManagedBootstrap: {
        ...seeded.record.appManagedBootstrap!, messageID: 'msg_foreign',
      } })
    }],
    ['mismatched title', async (fixture: Awaited<ReturnType<typeof productionRecoveryHarness>>, seeded: ProductionSeed) => {
      const mismatchedTitle = `${seeded.title}:foreign`
      await fixture.commitClaim({ ...seeded, title: mismatchedTitle })
      await fixture.sessionStore.upsert(seeded.record)
      expect(await fixture.ledger.read(fixture.target, fixture.context)).toMatchObject({
        state: 'committed', linkage: seeded.linkage,
        recovery: { ownershipTitle: mismatchedTitle, sessionRecord: seeded.record },
      })
      expect(await fixture.readSessionProjection()).toEqual(seeded.record)
    }],
    ['mismatched commit', async (fixture: Awaited<ReturnType<typeof productionRecoveryHarness>>, seeded: ProductionSeed) => {
      await fixture.commitClaim({ ...seeded, linkage: { ...seeded.linkage, commitIdentity: identity } })
      await fixture.sessionStore.upsert(seeded.record)
    }],
  ] as const

test.each(staleProductionAuthorityCases)(
  'production callback and preflight fail closed for %s durable authority', async (name, arrange) => {
    const fixture = await productionRecoveryHarness()
    try {
      const seeded = await fixture.seedIntent({ acceptedProof: true, applied: true })
      try { await arrange(fixture, seeded) }
      catch (error) { throw new Error(`arrange failed: ${name}`, { cause: error }) }
      const output = await fixture.bridge.execute(fixture.command)
      const data = output.data as { launchAttempt?: OpenCodeLaunchAttemptResponse } | null
      expect(data?.launchAttempt?.launchAttempt, name).toMatchObject({
        outcome: 'reconciliation_required', phase: 'complete',
      })
      expect(data?.launchAttempt?.members, name).toMatchObject({
        committed: [], failed: [], pending: [fixture.memberIdentity],
      })
      expect(output.snapshot.probeError, name).toBe('launch attempt did not acquire a host')
      expect(fixture.sessionReads(), `${name} preflight and readMemberLinkage`)
        .toBe(2)
      expect(fixture.mcpChecks(), `${name} stops at recovery boundary`).toBe(0)
      expect(fixture.memberCreates(), name).toBe(0)
      const events = (await fixture.inspectJournal())?.events.map(event => event.type)
      expect(events, name).not.toContain('member_reconciled_applied')
      expect(events, `${name} exact recovery journal`).toEqual(['member_intent', 'member_applied'])
    } finally { await fixture.dispose() }
  })

test('committed mutation crash failpoints rehydrate only the exact remote projection without create', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-commit-recovery-'))
  try {
    const ledger = new OpenCodeLaunchMutationLedger(path.join(directory, 'claims'))
    const memberIdentity = identity
    const target = OpenCodeLaunchMutationLedger.targetDigest({ teamId: 'team', laneId: 'primary',
      projectIdentity: '/fake/project', memberName: 'alice' })
    const authority: OpenCodeLaunchMutationIdentity = { attemptId: '123e4567-e89b-42d3-a456-426614174001',
      payloadHash: 'a'.repeat(64), inputDigest: 'b'.repeat(64), generation: 1, fence: 1,
      immutableDigest: 'c'.repeat(64),
      acquisitionToken: 'acquire', claimToken: 'acquire.claim', memberIdentity,
      logicalMember: { teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project', memberName: 'alice' } }
    const sessionId = OpenCodeLaunchMutationLedger.idempotencyIdentity(target)
    const title = `agent-teams-launch:${authority.attemptId}:${memberIdentity}:${createHash('sha256').update(authority.claimToken).digest('hex')}`
    const text = '<bootstrap-exact>'
    const messageID = 'msg_exact'
    const now = new Date().toISOString()
    const record: OpenCodeSessionRecord = { version: 2, teamId: 'team', laneId: 'primary', memberName: 'alice',
      providerId: 'opencode', selectedModel: 'openrouter/model', projectIdentity: '/fake/project',
      projectPath: '/fake/project', runId: null,
      profileRootKey: 'profile', hostKey: 'host', resolvedBehaviorFingerprint: null,
      opencodeSessionId: sessionId, lastCanonicalCursor: null, lastKnownRawStatus: null,
      lastKnownDurableState: null, sourceAuthFingerprint: null, managedAuthFingerprint: null,
      projectBehaviorFingerprint: 'behavior', bootstrapMode: 'app_managed_context',
      bootstrapEvidenceSource: 'app_managed_bootstrap', appManagedBootstrap: { schemaVersion: 1,
        messageID, contextHash: createHash('sha256').update(text).digest('hex'), briefingHash: createHash('sha256').update('').digest('hex'),
        injectionVerifiedAt: now, model: 'openrouter/model', agent: 'teammate-bootstrap' },
      staleReason: null, createdAt: now, updatedAt: now }
    const linkage: OpenCodeLaunchMemberLinkage = linkageForTest(memberIdentity, record)
    await ledger.claim(target, authority, storeContext())
    const projected: OpenCodeSessionRecord[] = []
    await expect(commitOpenCodeMemberProjection({
      commit: async () => {
        const result = await ledger.transition(target, authority, 'commit', linkage, storeContext(),
          { ownershipTitle: title, sessionRecord: record })
        return result === 'cancelled' ? 'fenced' : result
      },
      upsert: async () => { projected.push(record) },
      failpoint: point => { if (point === 'after_commit') throw new Error('crash:after_commit') },
    })).rejects.toThrow('crash:after_commit')
    expect(projected).toHaveLength(0)
    const claim = await new OpenCodeLaunchMutationLedger(path.join(directory, 'claims')).read(target, storeContext())
    const recovered = await recoverOpenCodeCommittedMemberProjection({ claim: claim!, ...authority, teamId: 'team',
      laneId: 'primary', memberName: 'alice', selectedModel: 'openrouter/model', expectedBootstrapText: text,
      getSession: async () => ({ id: sessionId, title }),
      getSessionMessage: async () => ({ info: { id: messageID, sessionID: sessionId,
        providerID: 'openrouter', modelID: 'model' },
        parts: [{ type: 'text', text }] }),
      upsert: async value => { projected.push(value) },
    })
    expect(recovered.status).toBe('recovered')
    expect(projected).toHaveLength(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('production restart adopts a session projection only for the exact committed member-intent claim', async () => {
  const base = await committedRecoveryFixture()
  const otherMember = `sha256:${'9'.repeat(64)}` as OpenCodeOpaqueIdentity
  const changedMessageRecord = { ...base.record, appManagedBootstrap: {
    ...base.record.appManagedBootstrap!, messageID: 'msg_substituted',
  } }
  const changedSessionRecord = { ...base.record, opencodeSessionId: 'ses_substituted' }
  const changedCommit = { ...base.linkage, commitIdentity: `sha256:${'8'.repeat(64)}` as OpenCodeOpaqueIdentity }
  const cases: Array<[string, Parameters<typeof recoverOpenCodeCommittedMemberLinkage>[0]]> = [
    ['claimless pre-existing record', { ...base.input, claim: null, record: base.record }],
    ['pending claim', { ...base.input, claim: { ...base.input.claim, state: 'claimed',
      linkage: undefined, recovery: undefined }, record: base.record } as never],
    ['released claim', { ...base.input, claim: { ...base.input.claim, state: 'known_failure',
      linkage: undefined, recovery: undefined }, record: base.record } as never],
    ['unknown claim', { ...base.input, claim: { ...base.input.claim, state: 'unknown',
      linkage: undefined, recovery: undefined }, record: base.record } as never],
    ['stale generation', { ...base.input, generation: base.input.generation + 1, record: base.record }],
    ['stale fence', { ...base.input, fence: base.input.fence + 1, record: base.record }],
    ['mismatched claim token', { ...base.input, claimToken: `${base.input.claimToken}.other`, record: base.record }],
    ['mismatched member', { ...base.input, memberIdentity: otherMember, record: base.record }],
    ['mismatched session', { ...base.input, record: changedSessionRecord }],
    ['mismatched bootstrap message', { ...base.input, record: changedMessageRecord }],
    ['mismatched ownership title', { ...base.input, claim: { ...base.input.claim, recovery: {
      ...base.input.claim.recovery!, ownershipTitle: `${base.title}:foreign`,
    } }, record: base.record }],
    ['mismatched commit identity', { ...base.input, claim: { ...base.input.claim,
      linkage: changedCommit }, record: base.record }],
  ]
  for (const [name, input] of cases) {
    expect(recoverOpenCodeCommittedMemberLinkage(input), name).toBeNull()
  }
  expect(recoverOpenCodeCommittedMemberLinkage({ ...base.input, record: base.record }))
    .toEqual(base.linkage)
})

test('projection failpoints preserve authoritative ordering before and after the repairable upsert', async () => {
  for (const point of ['after_commit', 'before_projection', 'after_projection'] as const) {
    const order: string[] = []
    await expect(commitOpenCodeMemberProjection({
      commit: async () => { order.push('commit'); return 'committed' },
      onCommitted: () => { order.push('owned') },
      upsert: async () => { order.push('projection') },
      failpoint: observed => { order.push(observed); if (observed === point) throw new Error(`crash:${point}`) },
    })).rejects.toThrow(`crash:${point}`)
    expect(order.slice(0, 2)).toEqual(['commit', 'owned'])
    expect(order.includes('projection')).toBe(point === 'after_projection')
    if (point === 'after_projection') expect(order.at(-2)).toBe('projection')
  }
})

test('post-commit normalized projection conflict never returns committed success and retains durable authority', async () => {
  const order: string[] = []
  let durableCommitted = false
  await expect(commitOpenCodeMemberProjection({
    commit: async () => { order.push('commit'); durableCommitted = true; return 'committed' },
    onCommitted: () => { order.push('durable-authority') },
    upsert: async () => { order.push('projection-conflict'); throw new Error('normalized projection conflict') },
  })).rejects.toThrow('normalized projection conflict')
  expect(order).toEqual(['commit', 'durable-authority', 'projection-conflict'])
  expect(durableCommitted).toBe(true)
})

test('committed projection recovery reports absent, mismatched and foreign remote truth without adoption', async () => {
  const base = await committedRecoveryFixture()
  for (const [reason, getSession, getMessage] of [
    ['remote_absent', async () => { throw notFound() }, async () => null],
    ['remote_foreign', async () => ({ id: base.sessionId, title: 'foreign' }), async () => base.message],
    ['remote_mismatch', async () => ({ id: base.sessionId, title: base.title }),
      async () => ({ ...base.message, info: { ...base.message.info, modelID: 'other' } })],
    ['remote_mismatch', async () => ({ id: base.sessionId, title: base.title }),
      async () => ({ ...base.message, info: { ...base.message.info, id: undefined } })],
    ['remote_mismatch', async () => ({ id: base.sessionId, title: base.title }),
      async () => ({ ...base.message, info: { ...base.message.info, id: 'msg_other' } })],
    ['remote_mismatch', async () => ({ id: base.sessionId, title: base.title }),
      async () => ({ ...base.message, info: { ...base.message.info, sessionID: undefined } })],
    ['remote_mismatch', async () => ({ id: base.sessionId, title: base.title }),
      async () => ({ ...base.message, info: { ...base.message.info, sessionID: 'ses_other' } })],
    ['transport', async () => { throw new Error('unknown transport') }, async () => null],
  ] as const) {
    let upserts = 0
    const result = await recoverOpenCodeCommittedMemberProjection({ ...base.input,
      getSession, getSessionMessage: getMessage, upsert: async () => { upserts += 1 } })
    expect(result).toEqual({ status: 'unresolved', reason })
    expect(upserts).toBe(0)
  }
})

type ProductionSeed = { record: OpenCodeSessionRecord; linkage: OpenCodeLaunchMemberLinkage;
  authority: OpenCodeLaunchMutationIdentity; title: string; text: string }

async function productionRecoveryHarness(hostManagerOverride?: OpenCodeHostManager) {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-production-recovery-e2e-'))
  const projectPath = path.join(directory, 'project')
  await mkdir(projectPath)
  const sessionStore = new OpenCodeSessionStore(path.join(directory, 'sessions.json'))
  let sessionReadCount = 0
  const originalSessionGet = sessionStore.getByLogicalMember.bind(sessionStore)
  sessionStore.getByLogicalMember = async (...input: Parameters<OpenCodeSessionStore['getByLogicalMember']>) => {
    sessionReadCount += 1
    return originalSessionGet(...input)
  }
  const attemptId = '123e4567-e89b-42d3-a456-426614174443'
  const memberIdentity = `sha256:${'4'.repeat(64)}` as OpenCodeOpaqueIdentity
  const hash = (character: string) => character.repeat(64)
  const oid = (character: string) => `sha256:${character.repeat(64)}` as OpenCodeOpaqueIdentity
  const current = (input: { purpose: 'launch'; providerId?: string | null; modelId?: string | null;
    runtimeInstanceId: string; projectPath?: string }): OpenCodeCurrentScopedProfilePlan => ({
    ...input, providerId: input.providerId!, modelId: input.modelId!, projectPath: input.projectPath!, evidence: {
      canonicalProjectPathFingerprint: hash('1'), projectBehaviorFingerprint: hash('2'),
      providerEnvironmentFingerprint: hash('3'), selectedAuthFingerprint: hash('4'),
      binaryFingerprint: hash('5'), configFingerprint: hash('6'),
      nativeAccountIdentityFingerprint: hash('7'), nativeAccountIdentitySource: 'managed-auth',
      nativeTargetExecutableFingerprint: hash('8'), profileLayoutFingerprint: hash('9'),
      automaticUserPluginFingerprint: hash('a'), plugins: [],
    },
  })
  let authorizationCaptureCount = 0
  const profileManager = {
    captureCurrentScopedProfilePlan: async (input: Parameters<typeof current>[0]) => {
      authorizationCaptureCount += 1
      return current(input)
    },
    planScopedProfile,
    prepareScopedProfile: async (input: OpenCodeCurrentScopedProfilePlan, expected: ReturnType<typeof planScopedProfile>) => ({
      scopeSchema: 'opencode-scoped-profile-v1', purpose: expected.purpose,
      providerId: expected.providerId, modelId: expected.modelId,
      runtimeInstanceId: input.runtimeInstanceId, scopedPlanDigest: expected.digest,
      plannedHostKey: expected.expectedHostKey,
      canonicalProjectPathFingerprint: expected.canonicalProjectPathFingerprint,
      selectedAuthBaselineFingerprint: expected.selectedAuthFingerprint,
      binaryFingerprint: expected.binaryFingerprint,
    } as OpenCodeScopedPreparedProfile),
  }
  const rawCommand: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0] = {
    request: { launchContractVersion: 1, launchAttempt: {
      attemptId, payloadHash: hash('a'), generation: 1, proofNonce: 'A'.repeat(22),
      parent: { sessionIdentity: oid('b'), messageIdentity: oid('c') },
      providerId: 'openrouter', modelId: 'openrouter/model',
      requiredMcpTools: ['agent-teams.message_send'], requireFreshRetainedHostProof: true,
    } },
    members: [{ name: 'alice', memberIdentity }], runId: 'run', laneId: 'primary', teamId: 'team',
    projectPath, selectedModel: 'openrouter/model', toolApprovalMode: 'auto', continuation: false,
    requestedBudgetMs: 30_000, preconditions: {
      handshakeIdentityHash: hash('1'), laneId: 'primary', expectedRunId: 'run',
      expectedCapabilitySnapshotId: null, expectedBehaviorFingerprint: hash('2'),
      expectedManifestHighWatermark: null, commandLeaseId: 'lease-443', idempotencyKey: attemptId,
    },
  }
  rawCommand.request.launchAttempt.requestCorrelationDigest =
    computeOpenCodeLaunchRequestCorrelationDigest(rawCommand)
  const authorization = await authorizeOpenCodeLaunchScopedProfile(profileManager, {
    purpose: 'launch', providerId: 'openrouter', modelId: 'openrouter/model', runtimeInstanceId: attemptId,
    projectPath,
  })
  authorizationCaptureCount = 0
  const durableCommand = { ...rawCommand, requestProjectPath: projectPath, projectIdentity: projectPath,
    effectiveProfilePlanDigest: authorization.effectivePlanDigest }
  const commandInputDigest = computeOpenCodeLaunchCommandInputDigest(durableCommand)
  const inputDigest = computeOpenCodeLaunchAttemptInputDigest(rawCommand.request, [memberIdentity], 'begin',
    rawCommand.requestedBudgetMs, rawCommand.requestedBudgetMs, commandInputDigest)
  const immutableDigest = computeOpenCodeLaunchAttemptImmutableDigest(rawCommand.request, [memberIdentity],
    rawCommand.requestedBudgetMs, rawCommand.requestedBudgetMs,
    computeOpenCodeLaunchCommandImmutableDigest(durableCommand))
  const launchDirectory = path.join(directory, 'data', 'opencode', 'launch-attempts')
  const persistence = new OpenCodeLaunchFileJournalPersistence(path.join(launchDirectory, `${attemptId}.journal`))
  const store = new OpenCodeLaunchAttemptStore(persistence)
  const ledger = new OpenCodeLaunchMutationLedger(path.join(launchDirectory, 'member-claims'),
    filePath => persistence.createRelativePersistence(filePath))
  const target = OpenCodeLaunchMutationLedger.targetDigest({ teamId: 'team', laneId: 'primary',
    projectIdentity: projectPath, memberName: 'alice' })
  const sessionId = OpenCodeLaunchMutationLedger.idempotencyIdentity(target)
  let memberCreateCount = 0
  let mcpCheckCount = 0
  let hostReconcileCount = 0
  let remoteReadCount = 0
  const remote = new Map<string, { id: string; title: string }>()
  const messages = new Map<string, { info: Record<string, unknown>; parts: Array<{ type: 'text'; text: string }> }>()
  const client = {
    getSession: async (id: string) => {
      remoteReadCount += 1
      const value = remote.get(id)
      if (!value) throw notFound()
      return value
    },
    getSessionMessage: async (id: string, messageId: string) => messages.get(`${id}:${messageId}`) ?? null,
    createSession: async () => { memberCreateCount += 1; throw new Error('member create must not run') },
    deleteSession: async () => false,
  }
  const host = { hostKey: 'host', profileRootKey: 'profile', projectPath,
    projectBehaviorFingerprint: hash('2'), baseUrl: 'http://fake.invalid', port: 1, pid: 443,
    processStartedAtMs: 1, version: 'fake', state: 'healthy', profile: {} as never,
    resolvedConfigFingerprint: null, diagnostics: [] }
  const createBridge = () => createOpenCodeLaunchAttemptProductionTestBridge({
    dataDirectory: path.join(directory, 'data'),
    profileManager: profileManager as never, sessionStore: sessionStore as never,
    clientFactory: { create: () => client } as never,
    hostManager: hostManagerOverride ?? { ensureScopedHostReference: async () => ({ handle: host }), releaseHostReference: async () => {},
      hasExactRetainedHostReleaseCapability: () => false,
      retainHostLease: async () => {}, reconcileHostReleaseReceipt: async () => {
        hostReconcileCount += 1
      } } as never,
    mcpManager: { ensureAppMcp: async () => {
      mcpCheckCount += 1
      throw new Error('MCP must not run before recovery settles')
    } } as never,
  })
  const bridge = createBridge()
  const context = { deadlineAtMs: Date.now() + 30_000,
    signal: new AbortController().signal, monotonicNow: Date.now }
  const acceptedProof = (): OpenCodeLaunchAttemptResponse => {
    const retainedHost: OpenCodeRetainedHostIdentity = { hostKeyIdentity: oid('d'), processId: 443,
      processStartedAtMs: 1, profileScopeIdentity: oid('1') }
    return { launchAttempt: { contractVersion: 1, attemptId, idempotencyKey: 'attemptId',
      payloadHash: rawCommand.request.launchAttempt.payloadHash, generation: 1, inputDigest, immutableDigest,
      outcome: 'succeeded', phase: 'complete', startedAt: 0, workDeadlineAt: 10_000,
      absoluteDeadlineAt: 11_000, cleanupReserveMs: 1_000, elapsedMs: 1,
      providerId: 'openrouter', modelId: 'openrouter/model', profilePurpose: 'launch_attempt',
      projectIdentity: oid('f'), profileIdentity: oid('1'), configIdentity: oid('2'), authIdentity: oid('3'),
      pluginPolicyIdentity: oid('4'), cacheIdentity: oid('5'), binaryIdentity: oid('6'),
      retainedHostIdentity: retainedHost,
      requestCorrelationDigest: rawCommand.request.launchAttempt.requestCorrelationDigest },
    proof: { generation: 1, attemptId, parent: rawCommand.request.launchAttempt.parent,
      providerId: 'openrouter', modelId: 'openrouter/model', retainedHostIdentity: retainedHost,
      observedMcpTools: ['agent-teams.message_send'],
      nonceHash: createHash('sha256').update(rawCommand.request.launchAttempt.proofNonce).digest('hex'),
      sessionIdentity: oid('7'), promptMessageIdentity: oid('8'), assistantMessageIdentity: oid('9'),
      verifiedAt: 1, authorizationSource: 'fresh_live_attempt', cacheUsed: false,
      requestCorrelationDigest: rawCommand.request.launchAttempt.requestCorrelationDigest },
    members: { committed: [], failed: [], pending: [], cleanupPending: [] } }
  }
  const seedIntent = async (options: { acceptedProof?: boolean; applied?: boolean } = {}): Promise<ProductionSeed> => {
    let seeded!: ProductionSeed
    await store.withGeneration({ attemptId, payloadHash: rawCommand.request.launchAttempt.payloadHash,
      inputDigest, immutableDigest, generation: 1, startedAtMs: Date.now(), totalBudgetMs: 30_000 },
    'begin', async lease => {
      if (options.acceptedProof) await lease.commitAcceptedProofResponse(acceptedProof())
      const claimToken = await lease.claim(memberIdentity)
      const title = `agent-teams-launch:${attemptId}:${memberIdentity}:${createHash('sha256').update(claimToken).digest('hex')}`
      const text = ['<agent_teams_app_managed_bootstrap>', 'AGENT_TEAMS_APP_MANAGED_BOOTSTRAP_V1',
        JSON.stringify({ teamName: 'team', memberName: 'alice', runtimeProvider: 'opencode',
          runtimeSessionId: sessionId, runId: 'run', laneId: 'primary' }),
        'Join OpenCode team team as alice. Wait for app MCP task delivery.',
        '</agent_teams_app_managed_bootstrap>'].join('\n')
      const now = new Date().toISOString()
      const record: OpenCodeSessionRecord = { version: 2, teamId: 'team', laneId: 'primary', memberName: 'alice',
        providerId: 'opencode', selectedModel: 'openrouter/model', projectIdentity: projectPath,
        projectPath, runId: 'run', profileRootKey: 'profile',
        hostKey: 'host', resolvedBehaviorFingerprint: null, opencodeSessionId: sessionId,
        lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: null,
        sourceAuthFingerprint: null, managedAuthFingerprint: null, projectBehaviorFingerprint: hash('2'),
        bootstrapMode: 'app_managed_context', bootstrapEvidenceSource: 'app_managed_bootstrap',
        appManagedBootstrap: { schemaVersion: 1, messageID: 'msg_exact',
          contextHash: createHash('sha256').update(text).digest('hex'),
          briefingHash: createHash('sha256').update('').digest('hex'), injectionVerifiedAt: now,
          model: 'openrouter/model', agent: 'teammate-bootstrap' }, staleReason: null,
        createdAt: now, updatedAt: now }
      const linkage = linkageForTest(memberIdentity, record)
      seeded = { record, linkage, title, text, authority: { attemptId,
        payloadHash: rawCommand.request.launchAttempt.payloadHash, inputDigest, immutableDigest,
        generation: lease.generation, fence: lease.fence, acquisitionToken: lease.acquisitionToken,
        claimToken, memberIdentity,
        logicalMember: { teamId: 'team', laneId: 'primary', projectIdentity: projectPath,
          memberName: 'alice' } } }
      if (options.applied) {
        await lease.append({ type: 'member_applied', memberIdentity, linkage, claimToken })
      }
    }, context)
    return seeded
  }
  return { bridge, restartBridge: createBridge, command: rawCommand, sessionStore, seedIntent,
    ledger, target, context, directory,
    store, acceptedProof, inputDigest, immutableDigest, launchDirectory,
    remote, messages, sessionId, memberIdentity,
    commitClaim: async (seeded: ProductionSeed) => {
      expect(await ledger.claim(target, seeded.authority, context)).toBe('claimed')
      expect(await ledger.transition(target, seeded.authority, 'commit', seeded.linkage, context,
        { ownershipTitle: seeded.title, sessionRecord: seeded.record })).toBe('committed')
      remote.set(sessionId, { id: sessionId, title: seeded.title })
      messages.set(`${sessionId}:msg_exact`, { info: { id: 'msg_exact', sessionID: sessionId,
        providerID: 'openrouter', modelID: 'model' }, parts: [{ type: 'text', text: seeded.text }] })
    },
    inspectJournal: () => store.inspect({ attemptId, payloadHash: rawCommand.request.launchAttempt.payloadHash,
      inputDigest, immutableDigest }),
    readSessionProjection: () => originalSessionGet({
      teamId: 'team', laneId: 'primary', projectIdentity: projectPath, memberName: 'alice',
    }),
    memberCreates: () => memberCreateCount,
    remoteReads: () => remoteReadCount,
    sessionReads: () => sessionReadCount,
    mcpChecks: () => mcpCheckCount,
    hostReconciles: () => hostReconcileCount,
    authorizationCaptures: () => authorizationCaptureCount,
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}

test('member cleanup replay uses only journaled host identity and never starts fresh host provisioning',
async () => {
  let ensured = 0
  let recovered = 0
  let released = 0
  let releasedLease: { runId?: string | null; sessionId?: string | null } | undefined
  const replacementLease = { runId: 'replacement-run', sessionId: '' }
  let recoveredBirthToken: string | undefined
  let retainedAccess: 'unresolved' | 'absent' = 'unresolved'
  const manager = {
    ensureScopedHostReference: async () => { ensured += 1; throw new Error('must not provision') },
    releaseHostReference: async () => {},
    hasExactRetainedHostReleaseCapability: () => false,
    retainHostLease: async () => {},
    releaseHostLease: async (_hostKey: string, lease: { runId?: string | null; sessionId?: string | null }) => {
      released += 1
      releasedLease = lease
      return lease.runId === replacementLease.runId && lease.sessionId === replacementLease.sessionId
        ? 'applied' as const : 'foreign' as const
    },
    reconcileHostReleaseReceipt: async () => {},
    withRetainedHostAccess: async (identity: { processBirthToken?: string }) => {
      recovered += 1
      recoveredBirthToken = identity.processBirthToken
      return { status: retainedAccess }
    },
  } as unknown as OpenCodeHostManager
  const harness = await productionRecoveryHarness(manager)
  try {
    replacementLease.sessionId = harness.sessionId
    const seeded = await harness.seedIntent({ acceptedProof: true })
    const reservationIdentity = 'union-cleanup-reservation'
    expect((await harness.sessionStore.reserveLogicalMember({
      teamId: 'team', laneId: 'primary', projectIdentity: harness.command.projectPath,
      memberName: 'Alice',
    }, reservationIdentity, harness.sessionId)).status).toBe('reserved')
    expect((await harness.sessionStore.publishReserved(
      seeded.record, reservationIdentity)).status).toBe('inserted')
    const basis = harness.acceptedProof()
    const failure = { code: 'pre_side_effect_transport' as const, origin: 'session' as const,
      retryDisposition: 'automatic' as const, retryable: true,
      phase: 'member_materialize' as const, sideEffectsStarted: false }
    const final = { ...basis, launchAttempt: { ...basis.launchAttempt, outcome: 'failed' as const },
      members: { committed: [], failed: [{ memberIdentity: harness.memberIdentity, failure }],
        pending: [], cleanupPending: [harness.memberIdentity] }, failure }
    const obligation: OpenCodeMemberCleanupObligation = {
      attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash,
      generation: 1, hostKey: 'host', hostProcessId: 443, hostProcessStartedAtMs: 1,
      hostProcessBirthToken: 'windows:0000000000000123:01d9abcd000001bb',
      memberIdentity: harness.memberIdentity, memberName: 'alice', teamId: 'team',
      laneId: 'primary', runId: harness.command.runId, sessionId: harness.sessionId,
      sessionIdentity: (`sha256:${createHash('sha256').update(JSON.stringify({
        kind: 'opencode-session', id: harness.sessionId,
      })).digest('hex')}` as OpenCodeOpaqueIdentity),
      ownershipTitle: 'agent-teams-launch:owned', phase: 'remote',
    }
    await harness.store.withGeneration({
      attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash,
      inputDigest: harness.inputDigest, immutableDigest: harness.immutableDigest, generation: 1,
    }, 'replay', async lease => {
      await lease.bindMemberCleanupObligation(obligation, harness.context)
      await lease.commitTerminalResponse(final, 'incomplete', harness.context)
    }, harness.context)

    const result = await harness.bridge.execute(harness.command)
    const launchAttempt = (result.data as { launchAttempt?: OpenCodeLaunchAttemptResponse })
      .launchAttempt
    expect(launchAttempt?.members.cleanupPending).toEqual([harness.memberIdentity])
    expect({ ensured, recovered, remoteReads: harness.remoteReads(),
      memberCreates: harness.memberCreates(), recoveredBirthToken, released })
      .toEqual({ ensured: 0, recovered: 1, remoteReads: 0, memberCreates: 0, released: 0,
        recoveredBirthToken: 'windows:0000000000000123:01d9abcd000001bb' })
    expect(await harness.inspectJournal()).toMatchObject({ cleanupState: 'incomplete',
      memberCleanupObligations: [{ memberIdentity: harness.memberIdentity, phase: 'remote' }],
      finalResponse: { members: { cleanupPending: [harness.memberIdentity] } } })

    // A later restart can prove the exact remote is absent. The normalized
    // projection and lease have meanwhile been rebound to a replacement run
    // using the same deterministic session id. Both foreign dispositions are
    // terminal for stale replay, without mutating either replacement owner.
    retainedAccess = 'absent'
    const replacementProjection = { ...seeded.record, runId: replacementLease.runId }
    expect(await harness.sessionStore.upsert(replacementProjection)).toBe('updated')
    await harness.restartBridge().execute(harness.command)
    expect({ ensured, recovered, released, releasedLease, replacementLease, projection:
      await harness.sessionStore.get('team', 'primary', 'ALICE') })
      .toEqual({ ensured: 0, recovered: 2, released: 1,
        releasedLease: { teamId: 'team', laneId: 'primary', memberName: 'alice',
          runId: harness.command.runId, sessionId: harness.sessionId },
        replacementLease: { runId: 'replacement-run', sessionId: harness.sessionId },
        projection: replacementProjection })
    expect(await harness.inspectJournal()).toMatchObject({
      // Member cleanup is durably complete even though the independent host
      // receipt remains unavailable, so aggregate cleanup stays incomplete.
      cleanupState: 'incomplete',
      memberCleanupObligations: [{ memberIdentity: harness.memberIdentity,
        runId: harness.command.runId, sessionId: harness.sessionId, phase: 'complete' }],
      acceptedProofResponse: { members: { cleanupPending: [] } },
    })
  } finally { await harness.dispose() }
}, 15_000)

test('persisted legacy member cleanup without run identity conservatively retains the lease phase',
async () => {
  let released = 0
  const manager = {
    ensureScopedHostReference: async () => { throw new Error('must not provision') },
    releaseHostReference: async () => {},
    hasExactRetainedHostReleaseCapability: () => false,
    retainHostLease: async () => {},
    releaseHostLease: async () => { released += 1; return 'applied' as const },
    reconcileHostReleaseReceipt: async () => {},
  } as unknown as OpenCodeHostManager
  const harness = await productionRecoveryHarness(manager)
  try {
    await harness.seedIntent({ acceptedProof: true })
    const basis = harness.acceptedProof()
    const failure = { code: 'pre_side_effect_transport' as const, origin: 'session' as const,
      retryDisposition: 'automatic' as const, retryable: true,
      phase: 'member_materialize' as const, sideEffectsStarted: false }
    const final = { ...basis, launchAttempt: { ...basis.launchAttempt, outcome: 'failed' as const },
      members: { committed: [], failed: [{ memberIdentity: harness.memberIdentity, failure }],
        pending: [], cleanupPending: [harness.memberIdentity] }, failure }
    const legacyObligation: OpenCodeMemberCleanupObligation = {
      attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash,
      generation: 1, hostKey: 'host', memberIdentity: harness.memberIdentity,
      memberName: 'alice', teamId: 'team', laneId: 'primary', sessionId: harness.sessionId,
      sessionIdentity: (`sha256:${createHash('sha256').update(JSON.stringify({
        kind: 'opencode-session', id: harness.sessionId,
      })).digest('hex')}` as OpenCodeOpaqueIdentity),
      ownershipTitle: 'agent-teams-launch:owned', phase: 'lease_release',
    }
    await harness.store.withGeneration({
      attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash,
      inputDigest: harness.inputDigest, immutableDigest: harness.immutableDigest, generation: 1,
    }, 'replay', async lease => {
      await lease.bindMemberCleanupObligation(legacyObligation, harness.context)
      await lease.commitTerminalResponse(final, 'incomplete', harness.context)
    }, harness.context)

    const result = await harness.restartBridge().execute(harness.command)
    expect((result.data as { launchAttempt?: OpenCodeLaunchAttemptResponse })
      .launchAttempt?.members.cleanupPending).toEqual([harness.memberIdentity])
    expect(released).toBe(0)
    expect(await harness.inspectJournal()).toMatchObject({ cleanupState: 'incomplete',
      memberCleanupObligations: [{ memberIdentity: harness.memberIdentity,
        sessionId: harness.sessionId, phase: 'lease_release' }] })
  } finally { await harness.dispose() }
}, 15_000)

test.each(['kiro', 'cursor-acp'] as const)(
  'production-composed %s authorization and native exec stay behind every unsafe tokenless-v1 state',
  async providerId => {
  for (const state of ['current', 'cleanupPending', 'predecessor', 'continuation'] as const) {
    const harness = await productionRecoveryHarness()
    try {
      const hostLedger = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(path.join(harness.launchDirectory,
        `${harness.command.request.launchAttempt.attemptId}.host-release.json`))
      const receipt = { schemaVersion: 1 as const,
        receiptId: `${state === 'current' ? '1' : state === 'cleanupPending' ? '2'
          : state === 'predecessor' ? '3' : '4'}7777777-7777-4777-8777-777777777777`,
        hostKeyDigest: createHash('sha256').update('host').digest('hex'),
        pid: 443, processStartedAtMs: 1, lifetime: 'persistent' as const }
      const obligation = await hostLedger.reserve({
        attemptId: harness.command.request.launchAttempt.attemptId,
        payloadHash: harness.command.request.launchAttempt.payloadHash, generation: 1,
        hostKeyIdentity: harness.acceptedProof().launchAttempt.retainedHostIdentity!.hostKeyIdentity,
        hostKeyDigest: receipt.hostKeyDigest,
      }, harness.context)
      await hostLedger.record({ ...obligation, disposition: 'dispose', releaseState: 'pending', receipt },
        harness.context)
      const exact = await hostLedger.readObligation({ attemptId: obligation.attemptId,
        payloadHash: obligation.payloadHash, generation: 1, obligationId: obligation.obligationId },
      harness.context)
      let continuationToken: string | undefined
      await harness.store.withGeneration({
        attemptId: harness.command.request.launchAttempt.attemptId,
        payloadHash: harness.command.request.launchAttempt.payloadHash,
        inputDigest: harness.inputDigest, immutableDigest: harness.immutableDigest,
        generation: 1, startedAtMs: Date.now(), totalBudgetMs: 30_000,
      }, 'begin', async lease => {
        if (state === 'predecessor' || state === 'continuation') {
          continuationToken = await lease.issueContinuation([harness.memberIdentity], harness.context)
          return
        }
        const basis = harness.acceptedProof()
        const failure = { code: 'contract_violation' as const, origin: 'session' as const,
          retryDisposition: 'never' as const, retryable: false,
          phase: 'member_materialize' as const, sideEffectsStarted: false }
        const final = { ...basis,
          launchAttempt: { ...basis.launchAttempt, outcome: 'failed' as const },
          members: { committed: [], failed: [{ memberIdentity: harness.memberIdentity, failure }],
            pending: [], cleanupPending: state === 'cleanupPending' ? [harness.memberIdentity] : [] },
          failure }
        await lease.commitAcceptedProofResponse(basis, harness.context)
        await lease.bindHostCleanupObligation({ obligationId: exact!.obligationId,
          reservationDigest: exact!.reservationDigest,
          receiptIdentityDigest: exact!.receiptIdentityDigest }, harness.context)
        await lease.commitTerminalResponse(final, 'incomplete', harness.context)
      }, harness.context)

      const value = structuredClone(harness.command)
      value.request.launchAttempt.providerId = providerId
      value.request.launchAttempt.modelId = providerId === 'kiro' ? 'kiro/auto' : 'cursor-acp/auto'
      value.selectedModel = value.request.launchAttempt.modelId
      if (state === 'predecessor' || state === 'continuation') {
        value.continuation = true
        value.request.launchAttempt.generation = 2
        value.request.launchAttempt.continuationToken = continuationToken
      }
      value.request.launchAttempt.requestCorrelationDigest = computeOpenCodeLaunchRequestCorrelationDigest(value)
      if (state === 'predecessor') {
        await harness.store.withGeneration({ attemptId: obligation.attemptId,
          payloadHash: obligation.payloadHash, inputDigest: 'f'.repeat(64),
          immutableDigest: harness.immutableDigest, generation: 2,
          continuationToken, startedAtMs: Date.now(), totalBudgetMs: 30_000,
        }, 'continue', async () => {}, harness.context)
      }

      const before = await durableTreeSnapshot(harness.directory)
      const profileManager = new OpenCodeProfileManager()
      const captureSpy = spyOn(profileManager, 'captureCurrentScopedProfilePlan')
      const execSpy = spyOn(childProcess, 'execFile')
      let clientEffects = 0
      let hostEffects = 0
      let mcpEffects = 0
      const bridge = createOpenCodeLaunchAttemptProductionTestBridge({
        dataDirectory: path.join(harness.directory, 'data'), profileManager,
        sessionStore: harness.sessionStore,
        clientFactory: { create: () => { clientEffects += 1; throw new Error('client effect') } } as never,
        hostManager: {
          hasExactRetainedHostReleaseCapability: () => false,
          ensureScopedHostReference: async () => { hostEffects += 1; throw new Error('host effect') },
          releaseHostReference: async () => { hostEffects += 1 },
          retainHostLease: async () => { hostEffects += 1 },
          reconcileHostReleaseReceipt: async () => { hostEffects += 1 },
        } as never,
        mcpManager: { ensureAppMcp: async () => { mcpEffects += 1; throw new Error('mcp effect') } } as never,
      })
      try {
        await expect(bridge.execute(value)).rejects.toThrow('requires exact retained generation authority')
        expect({ capture: captureSpy.mock.calls.length, exec: execSpy.mock.calls.length,
          clientEffects, hostEffects, mcpEffects }).toEqual({ capture: 0, exec: 0,
          clientEffects: 0, hostEffects: 0, mcpEffects: 0 })
        expect(await durableTreeSnapshot(harness.directory)).toEqual(before)
        expect({ member: harness.memberCreates(), remote: harness.remoteReads(),
          session: harness.sessionReads(), mcp: harness.mcpChecks(), reconcile: harness.hostReconciles() })
          .toEqual({ member: 0, remote: 0, session: 0, mcp: 0, reconcile: 0 })
      } finally {
        captureSpy.mockRestore()
        execSpy.mockRestore()
      }
    } finally { await harness.dispose() }
  }
}, 60_000)

async function durableTreeSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {}
  const visit = async (current: string, relative: string): Promise<void> => {
    let names: string[]
    try { names = await readdir(current) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of names.sort()) {
      const target = path.join(current, name)
      const key = path.join(relative, name)
      const metadata = await lstat(target)
      if (metadata.isDirectory()) {
        snapshot[`${key}/`] = `${metadata.mode & 0o777}`
        await visit(target, key)
      } else if (metadata.isFile()) {
        snapshot[key] = Buffer.from(await readFile(target)).toString('base64')
      } else snapshot[key] = `special:${metadata.mode}`
    }
  }
  await visit(root, '')
  return snapshot
}

function notFound(): Error { return new Error('request failed (404 Not Found)') }

test('production composition routes an incomplete exact final through real HostManager restart reconciliation', async () => {
  const platform = 'linux' as const
  const processBirthToken = 'linux:11111111-2222-3333-4444-555555555555:443'
  const managerDirectory = await mkdtemp(path.join(tmpdir(), 'opencode-production-real-manager-'))
  const registryPath = path.join(managerDirectory, 'registry.json')
  await writeFile(registryPath, JSON.stringify({ schemaVersion: 2, hosts: { host: {
    hostKey: 'host', profileRootKey: 'profile', projectPath: '/static/project',
    projectBehaviorFingerprint: '2'.repeat(64), baseUrl: 'http://127.0.0.1:44443',
    port: 44443, pid: 443, processStartedAtMs: 1,
    processBirthToken, version: null,
    resolvedConfigFingerprint: null, updatedAt: '2026-08-27T00:00:00.000Z', leases: {},
  } } }))
  let leaderAlive = true
  let containmentAlive = true
  const signals: NodeJS.Signals[] = []
  const realHostManager = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
    platform, isProcessAlive: () => leaderAlive,
    isProcessGroupAlive: () => containmentAlive,
    readProcessStartTimeMs: async () => 1,
    readProcessBirthToken: () => processBirthToken,
    killProcess: (_pid, signal) => {
      signals.push(signal); leaderAlive = false; containmentAlive = false
    },
    terminateWindowsProcessGeneration: async () => {
      signals.push('SIGTERM'); leaderAlive = false; containmentAlive = false; return true
    },
    sleepMs: async () => {},
    fetchJson: async () => ({ status: 200, data: { ok: true } }) })
  const harness = await productionRecoveryHarness(realHostManager)
  try {
    const hostLedger = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(path.join(harness.launchDirectory,
      `${harness.command.request.launchAttempt.attemptId}.host-release.json`))
    const obligation = await hostLedger.reserve({
      attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash, generation: 1,
      hostKeyIdentity: harness.acceptedProof().launchAttempt.retainedHostIdentity!.hostKeyIdentity,
      hostKeyDigest: createHash('sha256').update('host').digest('hex'),
    }, harness.context)
    const failure = { code: 'contract_violation' as const, origin: 'session' as const,
      retryDisposition: 'never' as const, retryable: false,
      phase: 'member_materialize' as const, sideEffectsStarted: false }
    const basis = harness.acceptedProof()
    const final = { ...basis, launchAttempt: { ...basis.launchAttempt, outcome: 'failed' as const },
      members: { committed: [], failed: [{ memberIdentity: harness.memberIdentity, failure }],
        pending: [], cleanupPending: [] }, failure }
    await hostLedger.record({ ...obligation,
      disposition: 'dispose', releaseState: 'pending', receipt: {
        schemaVersion: 2, receiptId: '88888888-8888-4888-8888-888888888888',
        hostKeyDigest: createHash('sha256').update('host').digest('hex'),
        pid: 443, processStartedAtMs: 1,
        processBirthToken,
        lifetime: 'persistent',
      } }, harness.context)
    const exact = await hostLedger.readObligation({
      attemptId: obligation.attemptId, payloadHash: obligation.payloadHash,
      generation: obligation.generation, obligationId: obligation.obligationId,
    }, harness.context)
    await harness.store.withGeneration({
      attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash,
      inputDigest: harness.inputDigest, immutableDigest: harness.immutableDigest,
      generation: 1, startedAtMs: Date.now(), totalBudgetMs: 30_000,
    }, 'begin', async lease => {
      await lease.commitAcceptedProofResponse(basis, harness.context)
      await lease.bindHostCleanupObligation({ obligationId: exact!.obligationId,
        reservationDigest: exact!.reservationDigest,
        receiptIdentityDigest: exact!.receiptIdentityDigest }, harness.context)
      await lease.commitTerminalResponse(final, 'incomplete', harness.context)
    }, harness.context)
    const boundJournal = (await harness.inspectJournal())!
    await expect(harness.store.withGeneration({
      attemptId: boundJournal.attemptId, payloadHash: boundJournal.payloadHash,
      inputDigest: boundJournal.inputDigest, immutableDigest: boundJournal.immutableDigest,
      generation: boundJournal.generation, startedAtMs: boundJournal.startedAtMs,
      totalBudgetMs: boundJournal.totalBudgetMs,
    }, 'replay', lease => lease.bindHostCleanupObligation({
      obligationId: exact!.obligationId, reservationDigest: 'f'.repeat(64),
      receiptIdentityDigest: exact!.receiptIdentityDigest,
    }, harness.context), harness.context)).rejects.toThrow('identity changed')

    await harness.bridge.execute(harness.command)
    expect((await harness.inspectJournal())?.cleanupState).toBe('complete')
    expect((await hostLedger.read({ attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash, generation: 1 },
    harness.context))?.releaseState).toBe('complete')
    await expect(readFile(registryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(signals).toEqual(['SIGTERM'])
  } finally {
    await harness.dispose()
    await rm(managerDirectory, { recursive: true, force: true })
  }
})

test.each([
  ['tokenless v1 only through its exact retained capability', {
    schemaVersion: 1 as const, receiptId: '77777777-7777-4777-8777-777777777777',
    hostKeyDigest: createHash('sha256').update('host').digest('hex'),
    pid: 443, processStartedAtMs: 1, lifetime: 'persistent' as const,
  }, true],
  ['Windows v2 through its persisted native generation', {
    schemaVersion: 2 as const, receiptId: '78787878-7878-4878-8878-787878787878',
    hostKeyDigest: createHash('sha256').update('host').digest('hex'),
    pid: 443, processStartedAtMs: 1,
    processBirthToken: 'windows:0000000000000123:01d9abcd000001bb',
    lifetime: 'persistent' as const,
  }, false],
] as const)('production composition restart reconciles %s', async (
  _case, receipt, exactRetainedCapability,
) => {
  let reconciles = 0
  const manager = {
    hasExactRetainedHostReleaseCapability: (candidate: typeof receipt) =>
      exactRetainedCapability && JSON.stringify(candidate) === JSON.stringify(receipt),
    reconcileHostReleaseReceipt: async (candidate: typeof receipt) => {
      expect(candidate).toEqual(receipt); reconciles += 1
    },
    ensureScopedHostReference: async () => { throw new Error('host acquisition must not run') },
    releaseHostReference: async () => { throw new Error('host release must not run') },
    retainHostLease: async () => { throw new Error('member lease must not run') },
  } as unknown as OpenCodeHostManager
  const harness = await productionRecoveryHarness(manager)
  try {
    const hostLedger = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(path.join(harness.launchDirectory,
      `${harness.command.request.launchAttempt.attemptId}.host-release.json`))
    const obligation = await hostLedger.reserve({
      attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash, generation: 1,
      hostKeyIdentity: harness.acceptedProof().launchAttempt.retainedHostIdentity!.hostKeyIdentity,
      hostKeyDigest: receipt.hostKeyDigest,
    }, harness.context)
    await hostLedger.record({ ...obligation, disposition: 'dispose', releaseState: 'pending', receipt },
      harness.context)
    const exact = await hostLedger.readObligation({ attemptId: obligation.attemptId,
      payloadHash: obligation.payloadHash, generation: 1, obligationId: obligation.obligationId },
    harness.context)
    const basis = harness.acceptedProof()
    const failure = { code: 'contract_violation' as const, origin: 'session' as const,
      retryDisposition: 'never' as const, retryable: false,
      phase: 'member_materialize' as const, sideEffectsStarted: false }
    const final = { ...basis, launchAttempt: { ...basis.launchAttempt, outcome: 'failed' as const },
      members: { committed: [], failed: [{ memberIdentity: harness.memberIdentity, failure }],
        pending: [], cleanupPending: [] }, failure }
    await harness.store.withGeneration({
      attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash,
      inputDigest: harness.inputDigest, immutableDigest: harness.immutableDigest,
      generation: 1, startedAtMs: Date.now(), totalBudgetMs: 30_000,
    }, 'begin', async lease => {
      await lease.commitAcceptedProofResponse(basis, harness.context)
      await lease.bindHostCleanupObligation({ obligationId: exact!.obligationId,
        reservationDigest: exact!.reservationDigest,
        receiptIdentityDigest: exact!.receiptIdentityDigest }, harness.context)
      await lease.commitTerminalResponse(final, 'incomplete', harness.context)
    }, harness.context)

    const replay = await harness.bridge.execute(harness.command)
    expect((replay.data as { launchAttempt: unknown }).launchAttempt).toEqual(final)
    expect(harness.authorizationCaptures()).toBe(1)
    expect(reconciles).toBe(1)
    expect((await hostLedger.readObligation({ attemptId: obligation.attemptId,
      payloadHash: obligation.payloadHash, generation: 1, obligationId: obligation.obligationId },
    harness.context))?.releaseState).toBe('complete')
    expect((await harness.inspectJournal())?.cleanupState).toBe('complete')

    const alteredGeneration = await hostLedger.reserve({
      attemptId: obligation.attemptId, payloadHash: obligation.payloadHash, generation: 2,
      hostKeyIdentity: obligation.hostKeyIdentity, hostKeyDigest: obligation.hostKeyDigest,
    }, harness.context)
    await hostLedger.record({ ...alteredGeneration, disposition: 'dispose',
      releaseState: 'pending', receipt }, harness.context)
    await expect(harness.bridge.execute(harness.command)).rejects.toThrow('receipt is foreign')
    expect(reconciles).toBe(1)
  } finally { await harness.dispose() }
})

test.each(['committed', 'claimed'] as const)(
  'production replay fences cleanupPending legacy receipt before %s member recovery effects', async memberState => {
  const managerDirectory = await mkdtemp(path.join(tmpdir(), 'opencode-production-legacy-receipt-'))
  const registryPath = path.join(managerDirectory, 'registry.json')
  const registryBytes = JSON.stringify({ schemaVersion: 2, hosts: { host: {
    hostKey: 'host', profileRootKey: 'profile', projectPath: '/static/project',
    projectBehaviorFingerprint: '2'.repeat(64), baseUrl: 'http://127.0.0.1:44443',
    port: 44443, pid: 443, processStartedAtMs: 1,
    processBirthToken: 'linux:11111111-2222-3333-4444-555555555555:999', version: null,
    resolvedConfigFingerprint: null, updatedAt: '2026-08-27T00:00:00.000Z', leases: {},
  } } })
  await writeFile(registryPath, registryBytes)
  let processProbes = 0
  let startTimeProbes = 0
  let birthProbes = 0
  let containmentProbes = 0
  let remoteRequests = 0
  let signals = 0
  const realHostManager = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
    platform: 'linux',
    isProcessAlive: () => { processProbes += 1; return true },
    isProcessGroupAlive: () => { containmentProbes += 1; return true },
    readProcessStartTimeMs: async () => { startTimeProbes += 1; return 1 },
    readProcessBirthToken: () => {
      birthProbes += 1; return 'linux:11111111-2222-3333-4444-555555555555:999'
    },
    killProcess: () => { signals += 1 },
    sleepMs: async () => {}, fetchJson: async () => {
      remoteRequests += 1; return { status: 200, data: { ok: true } }
    } })
  const harness = await productionRecoveryHarness(realHostManager)
  try {
    const seeded = await harness.seedIntent({ acceptedProof: true, applied: memberState === 'committed' })
    if (memberState === 'committed') {
      await harness.commitClaim(seeded)
      await harness.sessionStore.upsert(seeded.record)
    } else {
      expect(await harness.ledger.claim(harness.target, seeded.authority, harness.context)).toBe('claimed')
    }
    const hostLedger = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(path.join(harness.launchDirectory,
      `${harness.command.request.launchAttempt.attemptId}.host-release.json`))
    const obligation = await hostLedger.reserve({
      attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash, generation: 1,
      hostKeyIdentity: harness.acceptedProof().launchAttempt.retainedHostIdentity!.hostKeyIdentity,
      hostKeyDigest: createHash('sha256').update('host').digest('hex'),
    }, harness.context)
    const failure = { code: 'contract_violation' as const, origin: 'session' as const,
      retryDisposition: 'never' as const, retryable: false,
      phase: 'member_materialize' as const, sideEffectsStarted: false }
    const basis = harness.acceptedProof()
    const final = { ...basis, launchAttempt: { ...basis.launchAttempt, outcome: 'failed' as const },
      members: { committed: [], failed: [{ memberIdentity: harness.memberIdentity, failure }],
        pending: [], cleanupPending: [harness.memberIdentity] }, failure }
    await hostLedger.record({ ...obligation,
      disposition: 'dispose', releaseState: 'pending', receipt: {
        schemaVersion: 1, receiptId: '99999999-9999-4999-8999-999999999999',
        hostKeyDigest: createHash('sha256').update('host').digest('hex'),
        pid: 443, processStartedAtMs: 1, lifetime: 'persistent',
      } }, harness.context)
    const exact = await hostLedger.readObligation({
      attemptId: obligation.attemptId, payloadHash: obligation.payloadHash,
      generation: obligation.generation, obligationId: obligation.obligationId,
    }, harness.context)
    await harness.store.withGeneration({
      attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash,
      inputDigest: harness.inputDigest, immutableDigest: harness.immutableDigest,
      generation: 1, startedAtMs: Date.now(), totalBudgetMs: 30_000,
    }, 'replay', async lease => {
      await lease.bindHostCleanupObligation({ obligationId: exact!.obligationId,
        reservationDigest: exact!.reservationDigest,
        receiptIdentityDigest: exact!.receiptIdentityDigest }, harness.context)
      await lease.commitTerminalResponse(final, 'incomplete', harness.context)
    }, harness.context)

    // Reproduce journal-marker publication with the generation fence still one
    // step behind. The rejection path must not repair it merely to inspect.
    const journalPath = path.join(harness.launchDirectory,
      `${harness.command.request.launchAttempt.attemptId}.journal`)
    await unlink(deriveOpenCodeLaunchNamespacePaths(journalPath, path).fence)
    const beforeDurableTree = await durableTreeSnapshot(harness.directory)
    const beforeManagerTree = await durableTreeSnapshot(managerDirectory)
    const acquireSpy = spyOn(OpenCodeLaunchFileJournalPersistence.prototype, 'acquireExclusive')
    const ensureHostSpy = spyOn(realHostManager, 'ensureScopedHostReference')
    const releaseHostSpy = spyOn(realHostManager, 'releaseHostReference')
    const retainLeaseSpy = spyOn(realHostManager, 'retainHostLease')
    const reconcileSpy = spyOn(realHostManager, 'reconcileHostReleaseReceipt')

    try {
      await expect(harness.bridge.execute(harness.command)).rejects.toThrow(
        'requires exact retained generation authority')
      expect(harness.authorizationCaptures()).toBe(0)
      expect(await durableTreeSnapshot(harness.directory)).toEqual(beforeDurableTree)
      expect(await durableTreeSnapshot(managerDirectory)).toEqual(beforeManagerTree)
      expect((await harness.store.snapshotReadOnly({
        attemptId: harness.command.request.launchAttempt.attemptId,
        payloadHash: harness.command.request.launchAttempt.payloadHash,
        inputDigest: harness.inputDigest, immutableDigest: harness.immutableDigest,
      }, harness.context))?.cleanupState).toBe('incomplete')
      expect({ acquire: acquireSpy.mock.calls.length, ensureHost: ensureHostSpy.mock.calls.length,
        releaseHost: releaseHostSpy.mock.calls.length, retainLease: retainLeaseSpy.mock.calls.length,
        reconcile: reconcileSpy.mock.calls.length })
        .toEqual({ acquire: 0, ensureHost: 0, releaseHost: 0, retainLease: 0, reconcile: 0 })
    } finally {
      acquireSpy.mockRestore(); ensureHostSpy.mockRestore(); releaseHostSpy.mockRestore()
      retainLeaseSpy.mockRestore(); reconcileSpy.mockRestore()
    }
    expect((await hostLedger.readObligation({ attemptId: obligation.attemptId,
      payloadHash: obligation.payloadHash, generation: 1,
      obligationId: obligation.obligationId }, harness.context))?.releaseState).toBe('pending')
    expect(await readFile(registryPath, 'utf8')).toBe(registryBytes)
    expect({ processProbes, startTimeProbes, birthProbes, containmentProbes, remoteRequests, signals })
      .toEqual({ processProbes: 0, startTimeProbes: 0, birthProbes: 0, containmentProbes: 0,
        remoteRequests: 0, signals: 0 })
    expect(harness.memberCreates()).toBe(0)
    expect(harness.remoteReads()).toBe(0)
    expect(harness.sessionReads()).toBe(0)
    expect(harness.mcpChecks()).toBe(0)
    expect(harness.hostReconciles()).toBe(0)
  } finally {
    await harness.dispose()
    await rm(managerDirectory, { recursive: true, force: true })
  }
})

test('production continuation rejects a predecessor tokenless v1 obligation before any effects', async () => {
  const managerDirectory = await mkdtemp(path.join(tmpdir(), 'opencode-production-predecessor-v1-'))
  const registryPath = path.join(managerDirectory, 'registry.json')
  const registryBytes = JSON.stringify({ schemaVersion: 2, hosts: { host: {
    hostKey: 'host', profileRootKey: 'profile', projectPath: '/static/project',
    projectBehaviorFingerprint: '2'.repeat(64), baseUrl: 'http://127.0.0.1:44443',
    port: 44443, pid: 443, processStartedAtMs: 1, version: null,
    resolvedConfigFingerprint: null, updatedAt: '2026-08-27T00:00:00.000Z', leases: {},
  } } })
  await writeFile(registryPath, registryBytes)
  let processProbes = 0
  let startTimeProbes = 0
  let birthProbes = 0
  let containmentProbes = 0
  let remoteDisposals = 0
  let signals = 0
  const realHostManager = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
    platform: 'darwin', isProcessAlive: () => { processProbes += 1; return true },
    readProcessStartTimeMs: async () => { startTimeProbes += 1; return 1 },
    readProcessBirthToken: () => { birthProbes += 1; return null },
    isProcessGroupAlive: () => { containmentProbes += 1; return true },
    killProcess: () => { signals += 1 },
    fetchJson: async () => { remoteDisposals += 1; return { status: 200, data: {} } },
    sleepMs: async () => {} })
  const harness = await productionRecoveryHarness(realHostManager)
  try {
    const seeded = await harness.seedIntent({ acceptedProof: true })
    expect(await harness.ledger.claim(harness.target, seeded.authority, harness.context)).toBe('claimed')
    let continuationToken = ''
    await harness.store.withGeneration({
      attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash,
      inputDigest: harness.inputDigest, immutableDigest: harness.immutableDigest,
      generation: 1,
    }, 'replay', async lease => {
      continuationToken = await lease.issueContinuation([harness.memberIdentity], harness.context)
    }, harness.context)
    const hostLedger = OpenCodeLaunchHostReleaseLedger.forSyntheticFixture(path.join(harness.launchDirectory,
      `${harness.command.request.launchAttempt.attemptId}.host-release.json`))
    const obligation = await hostLedger.reserve({
      attemptId: harness.command.request.launchAttempt.attemptId,
      payloadHash: harness.command.request.launchAttempt.payloadHash, generation: 1,
      hostKeyIdentity: harness.acceptedProof().launchAttempt.retainedHostIdentity!.hostKeyIdentity,
      hostKeyDigest: createHash('sha256').update('host').digest('hex'),
    }, harness.context)
    await hostLedger.record({ ...obligation, disposition: 'dispose', releaseState: 'pending', receipt: {
      schemaVersion: 1, receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      hostKeyDigest: createHash('sha256').update('host').digest('hex'),
      pid: 443, processStartedAtMs: 1, lifetime: 'persistent',
    } }, harness.context)
    const beforeJournal = await harness.inspectJournal()
    const beforeReceipt = await hostLedger.readObligation({ attemptId: obligation.attemptId,
      payloadHash: obligation.payloadHash, generation: 1, obligationId: obligation.obligationId },
    harness.context)
    const beforeClaim = await harness.ledger.read(harness.target, harness.context)
    const continuationCommand = structuredClone(harness.command)
    continuationCommand.continuation = true
    continuationCommand.request.launchAttempt.generation = 2
    continuationCommand.request.launchAttempt.continuationToken = continuationToken
    continuationCommand.request.launchAttempt.requestCorrelationDigest =
      computeOpenCodeLaunchRequestCorrelationDigest(continuationCommand)
    const beforeDurableTree = await durableTreeSnapshot(harness.directory)
    const beforeManagerTree = await durableTreeSnapshot(managerDirectory)
    const acquireSpy = spyOn(OpenCodeLaunchFileJournalPersistence.prototype, 'acquireExclusive')
    const ensureHostSpy = spyOn(realHostManager, 'ensureScopedHostReference')
    const releaseHostSpy = spyOn(realHostManager, 'releaseHostReference')
    const retainLeaseSpy = spyOn(realHostManager, 'retainHostLease')
    const reconcileSpy = spyOn(realHostManager, 'reconcileHostReleaseReceipt')
    try {
      await expect(harness.bridge.execute(continuationCommand)).rejects.toThrow(
        'requires exact retained generation authority')
      expect(await durableTreeSnapshot(harness.directory)).toEqual(beforeDurableTree)
      expect(await durableTreeSnapshot(managerDirectory)).toEqual(beforeManagerTree)
      expect({ acquire: acquireSpy.mock.calls.length, ensureHost: ensureHostSpy.mock.calls.length,
        releaseHost: releaseHostSpy.mock.calls.length, retainLease: retainLeaseSpy.mock.calls.length,
        reconcile: reconcileSpy.mock.calls.length })
        .toEqual({ acquire: 0, ensureHost: 0, releaseHost: 0, retainLease: 0, reconcile: 0 })
    } finally {
      acquireSpy.mockRestore(); ensureHostSpy.mockRestore(); releaseHostSpy.mockRestore()
      retainLeaseSpy.mockRestore(); reconcileSpy.mockRestore()
    }
    expect(await harness.store.snapshotReadOnly({ attemptId: beforeJournal!.attemptId,
      payloadHash: beforeJournal!.payloadHash, inputDigest: beforeJournal!.inputDigest,
      immutableDigest: beforeJournal!.immutableDigest }, harness.context)).toEqual(beforeJournal)
    expect(await hostLedger.readObligation({ attemptId: obligation.attemptId,
      payloadHash: obligation.payloadHash, generation: 1, obligationId: obligation.obligationId },
    harness.context)).toEqual(beforeReceipt)
    expect(await harness.ledger.read(harness.target, harness.context)).toEqual(beforeClaim)
    expect(await readFile(registryPath, 'utf8')).toBe(registryBytes)
    expect({ processProbes, startTimeProbes, birthProbes, containmentProbes, remoteDisposals, signals })
      .toEqual({ processProbes: 0, startTimeProbes: 0, birthProbes: 0, containmentProbes: 0,
        remoteDisposals: 0, signals: 0 })
    expect({ sessionReads: harness.sessionReads(), remoteReads: harness.remoteReads(),
      memberCreates: harness.memberCreates(), mcpChecks: harness.mcpChecks(),
      hostReconciles: harness.hostReconciles() })
      .toEqual({ sessionReads: 0, remoteReads: 0, memberCreates: 0, mcpChecks: 0,
        hostReconciles: 0 })
  } finally {
    await harness.dispose()
    await rm(managerDirectory, { recursive: true, force: true })
  }
})

function controlledProofDirectories() {
  const settlements: Array<() => void> = []
  const observedDeadlines: Array<number | undefined> = []
  let openCount = 0
  return {
    opens: () => openCount,
    deadlines: () => observedDeadlines,
    settle(index: number) { settlements[index]?.() },
    open: async (directoryPath: string, options: Readonly<{ abortSignal?: AbortSignal; deadline?: number }>) => {
      openCount += 1; observedDeadlines.push(options.deadline)
      const actual = await OpenCodeSafePublicationDirectory.open(directoryPath, options)
      let settle!: () => void
      const controlledSettlement = new Promise<void>(resolve => { settle = resolve })
      settlements.push(settle)
      return new Proxy(actual, {
        get(target, property, receiver) {
          if (property === 'physicalSettlement') {
            return Promise.all([target.physicalSettlement, controlledSettlement]).then(() => undefined)
          }
          const value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
}
function storeContext() { return { deadlineAtMs: Date.now() + 10_000,
  signal: new AbortController().signal, monotonicNow: Date.now } }
function linkageForTest(memberIdentity: OpenCodeOpaqueIdentity, record: OpenCodeSessionRecord): OpenCodeLaunchMemberLinkage {
  const messageID = record.appManagedBootstrap!.messageID
  const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}` as OpenCodeOpaqueIdentity
  return { memberIdentity, sessionIdentity: hash({ kind: 'opencode-session', id: record.opencodeSessionId }),
    bootstrapMessageIdentity: hash({ kind: 'opencode-bootstrap', id: messageID }),
    commitIdentity: hash({ kind: 'opencode-session-commit', teamId: record.teamId,
      laneId: record.laneId ?? 'primary', memberName: record.memberName, sessionId: record.opencodeSessionId,
      messageID, contextHash: record.appManagedBootstrap!.contextHash,
      briefingHash: record.appManagedBootstrap!.briefingHash }) }
}
async function committedRecoveryFixture() {
  const memberIdentity = identity
  const attemptId = '123e4567-e89b-42d3-a456-426614174001'
  const acquisitionToken = 'acquire'
  const claimToken = `${acquisitionToken}.claim`
  const targetDigest = OpenCodeLaunchMutationLedger.targetDigest({ teamId: 'team', laneId: 'primary',
    projectIdentity: '/fake/project', memberName: 'alice' })
  const sessionId = OpenCodeLaunchMutationLedger.idempotencyIdentity(targetDigest)
  const title = `agent-teams-launch:${attemptId}:${memberIdentity}:${createHash('sha256').update(claimToken).digest('hex')}`
  const text = '<bootstrap-exact>'
  const now = new Date().toISOString()
  const record = { teamId: 'team', laneId: 'primary', memberName: 'alice', providerId: 'opencode' as const,
    selectedModel: 'openrouter/model', projectPath: '/fake/project', profileRootKey: 'profile', hostKey: 'host',
    resolvedBehaviorFingerprint: null, opencodeSessionId: sessionId, lastCanonicalCursor: null,
    lastKnownRawStatus: null, lastKnownDurableState: null, sourceAuthFingerprint: null,
    managedAuthFingerprint: null, projectBehaviorFingerprint: 'behavior', staleReason: null,
    bootstrapMode: 'app_managed_context' as const, bootstrapEvidenceSource: 'app_managed_bootstrap' as const,
    appManagedBootstrap: { schemaVersion: 1 as const, messageID: 'msg_exact',
      contextHash: createHash('sha256').update(text).digest('hex'), briefingHash: createHash('sha256').update('').digest('hex'),
      injectionVerifiedAt: now, model: 'openrouter/model', agent: 'teammate-bootstrap' }, createdAt: now, updatedAt: now }
  const linkage = linkageForTest(memberIdentity, record)
  const logicalMember = { teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project', memberName: 'alice' }
  const claim = { version: 2 as const, targetDigest, logicalMemberKey: targetDigest, logicalMember,
    idempotencyIdentity: sessionId,
    state: 'committed' as const, attemptId, payloadHash: 'a'.repeat(64), inputDigest: 'b'.repeat(64),
    immutableDigest: 'c'.repeat(64),
    generation: 1, fence: 1, acquisitionToken, claimToken, memberIdentity, linkage,
    recovery: { ownershipTitle: title, sessionRecord: record } }
  const message = { info: { id: 'msg_exact', sessionID: sessionId,
    providerID: 'openrouter', modelID: 'model' },
    parts: [{ type: 'text' as const, text }] }
  return { sessionId, title, message, record, linkage, input: { claim,
    attemptId, payloadHash: claim.payloadHash, inputDigest: claim.inputDigest,
    immutableDigest: claim.immutableDigest, generation: claim.generation, fence: claim.fence,
    claimToken, memberIdentity, teamId: 'team', laneId: 'primary', memberName: 'alice',
    selectedModel: 'openrouter/model', expectedBootstrapText: text } }
}
