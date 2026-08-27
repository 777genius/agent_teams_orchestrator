import { expect, test } from 'bun:test'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { createHash } from 'node:crypto'

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
import { OpenCodeLaunchAttemptStore, OpenCodeLaunchFileJournalPersistence } from './OpenCodeLaunchAttemptStore.js'
import type { OpenCodeLaunchAttemptResponse, OpenCodeLaunchMemberLinkage,
  OpenCodeOpaqueIdentity, OpenCodeRetainedHostIdentity } from './OpenCodeBridgeContractV2.js'
import type { OpenCodeCurrentScopedProfilePlan, OpenCodeScopedPreparedProfile,
  OpenCodeSessionRecord } from './types.js'
import { OpenCodeSafePublicationDirectory } from './OpenCodeSafePublication.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
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
  reobserveOpenCodeProductionRetainedProof,
  resolveOpenCodeProductionRetainedProofRecord,
  transitionOpenCodeProductionMemberClaim,
} from './OpenCodeLaunchAttemptProduction.js'

const identity = `sha256:${'a'.repeat(64)}` as OpenCodeOpaqueIdentity
const productionContext = () => ({
  deadlineAtMs: Date.now() + 10_000,
  signal: new AbortController().signal,
  monotonicNow: Date.now,
})

test('attempt host release ledger survives restart, rejects foreign/corrupt receipts, and clears idempotently', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-host-release-ledger-'))
  const file = path.join(directory, 'receipt.json')
  const expected = { attemptId: '123e4567-e89b-42d3-a456-426614174000',
    payloadHash: 'b'.repeat(64), generation: 3 }
  const record = { schemaVersion: 1 as const, ...expected, hostKeyIdentity: identity,
    receipt: { schemaVersion: 1 as const, receiptId: '123e4567-e89b-42d3-a456-426614174443',
      hostKeyDigest: 'c'.repeat(64), pid: 443, processStartedAtMs: 12_345,
      lifetime: 'process' as const } }
  try {
    const first = new OpenCodeLaunchHostReleaseLedger(file)
    await first.record(record)
    const recordFile = path.join(`${file}.records`,
      `${expected.generation}.${record.receipt.receiptId}.json`)
    const raw = await readFile(recordFile, 'utf8')
    expect(raw).not.toContain('://')
    expect(raw).not.toContain('auth')
    const restarted = new OpenCodeLaunchHostReleaseLedger(file)
    const migrated = { ...record, schemaVersion: 3 as const,
      obligationId: record.receipt.receiptId, disposition: 'unknown' as const,
      releaseState: 'pending' as const }
    expect(await restarted.read(expected)).toEqual(migrated)
    expect(await restarted.readPending({ attemptId: expected.attemptId,
      payloadHash: expected.payloadHash, currentGeneration: 4 })).toEqual(migrated)
    const completedKeepAlive = { ...migrated, disposition: 'keep_alive' as const,
      releaseState: 'complete' as const }
    await restarted.record(completedKeepAlive)
    expect(await restarted.read(expected)).toEqual(completedKeepAlive)
    expect(await restarted.read({ ...expected, generation: 4 })).toBeNull()
    await restarted.clear(completedKeepAlive)
    await restarted.clear(completedKeepAlive)
    expect(await restarted.read(expected)).toBeNull()

    await writeFile(recordFile, '{"schemaVersion":1,"receipt":{"hostKeyDigest":"not-a-digest"}}')
    await expect(restarted.read(expected)).rejects.toThrow('corrupt')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('attempt host release ledger preserves every generation and prepublished acquisition obligation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-host-release-generations-'))
  const file = path.join(directory, 'receipt.json')
  const attemptId = '123e4567-e89b-42d3-a456-426614174000'
  const payloadHash = 'b'.repeat(64)
  try {
    const ledger = new OpenCodeLaunchHostReleaseLedger(file)
    const firstObligation = await ledger.reserve({ attemptId, payloadHash, generation: 1,
      hostKeyIdentity: identity })
    expect(await new OpenCodeLaunchHostReleaseLedger(file).hasUnresolvedAcquisition({
      attemptId, payloadHash, currentGeneration: 2,
    })).toBe(true)
    const first = { ...firstObligation, receipt: { schemaVersion: 1 as const,
      receiptId: '123e4567-e89b-42d3-a456-426614174441', hostKeyDigest: 'c'.repeat(64),
      pid: 441, processStartedAtMs: 1_441, lifetime: 'process' as const } }
    await ledger.record(first)
    const secondObligation = await ledger.reserve({ attemptId, payloadHash, generation: 2,
      hostKeyIdentity: identity })
    const second = { ...secondObligation, disposition: 'keep_alive' as const,
      releaseState: 'complete' as const, receipt: { schemaVersion: 1 as const,
        receiptId: '123e4567-e89b-42d3-a456-426614174442', hostKeyDigest: 'd'.repeat(64),
        pid: 442, processStartedAtMs: 1_442, lifetime: 'persistent' as const } }
    await ledger.record(second)

    const restarted = new OpenCodeLaunchHostReleaseLedger(file)
    expect(await restarted.hasUnresolvedAcquisition({ attemptId, payloadHash, currentGeneration: 2 }))
      .toBe(false)
    expect((await restarted.readAllPending({ attemptId, payloadHash, currentGeneration: 2 }))
      .map(record => [record.generation, record.receipt.receiptId]))
      .toEqual([[1, first.receipt.receiptId], [2, second.receipt.receiptId]])
    await restarted.clear(second)
    expect((await restarted.readAllPending({ attemptId, payloadHash, currentGeneration: 2 }))
      .map(record => record.generation)).toEqual([1])
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
    const store = new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(
      path.join(directory, 'attempt.journal')))
    const ledger = new OpenCodeLaunchMutationLedger(path.join(directory, 'claims'))
    const targetOne = OpenCodeLaunchMutationLedger.targetDigest({
      teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project', memberIdentity: identity,
    })
    const targetTwo = OpenCodeLaunchMutationLedger.targetDigest({
      teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project', memberIdentity: secondMember,
    })
    const now = new Date().toISOString()
    const record: OpenCodeSessionRecord = {
      teamId: 'team', laneId: 'primary', memberName: 'alice', providerId: 'opencode',
      selectedModel: 'openrouter/model', projectPath: '/fake/project', profileRootKey: 'profile', hostKey: 'host',
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
      teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project', memberIdentity: identity,
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
  }
}

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

test('production wiring rejects a durable member intent backed only by a same-name projection', async () => {
  const fixture = await productionRecoveryHarness()
  try {
    const seeded = await fixture.seedIntent()
    await fixture.sessionStore.upsert(seeded.record)

    await expect(fixture.bridge.execute(fixture.command)).rejects.toThrow('explicit reconciliation')
    expect(fixture.memberCreates()).toBe(0)
    expect(await fixture.sessionStore.get('team', 'primary', 'alice')).toEqual(seeded.record)
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
        projectIdentity: fixture.command.projectPath, memberIdentity: otherMember })
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
      const expectedSessionReads = name === 'mismatched member claim' ? 1 : 2
      expect(fixture.sessionReads(), `${name} preflight and readMemberLinkage`)
        .toBe(expectedSessionReads)
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
      projectIdentity: '/fake/project', memberIdentity })
    const authority: OpenCodeLaunchMutationIdentity = { attemptId: '123e4567-e89b-42d3-a456-426614174001',
      payloadHash: 'a'.repeat(64), inputDigest: 'b'.repeat(64), generation: 1, fence: 1,
      immutableDigest: 'c'.repeat(64),
      acquisitionToken: 'acquire', claimToken: 'acquire.claim', memberIdentity }
    const sessionId = OpenCodeLaunchMutationLedger.idempotencyIdentity(target)
    const title = `agent-teams-launch:${authority.attemptId}:${memberIdentity}:${createHash('sha256').update(authority.claimToken).digest('hex')}`
    const text = '<bootstrap-exact>'
    const messageID = 'msg_exact'
    const now = new Date().toISOString()
    const record: OpenCodeSessionRecord = { teamId: 'team', laneId: 'primary', memberName: 'alice',
      providerId: 'opencode', selectedModel: 'openrouter/model', projectPath: '/fake/project',
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

async function productionRecoveryHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-production-recovery-e2e-'))
  const projectPath = path.join(directory, 'project')
  await mkdir(projectPath)
  const sessionStore = new OpenCodeSessionStore(path.join(directory, 'sessions.json'))
  let sessionReadCount = 0
  const originalSessionGet = sessionStore.get.bind(sessionStore)
  sessionStore.get = async (...input: Parameters<OpenCodeSessionStore['get']>) => {
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
  const profileManager = {
    captureCurrentScopedProfilePlan: async (input: Parameters<typeof current>[0]) => current(input),
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
    projectIdentity: projectPath, memberIdentity })
  const sessionId = OpenCodeLaunchMutationLedger.idempotencyIdentity(target)
  let memberCreateCount = 0
  let mcpCheckCount = 0
  const remote = new Map<string, { id: string; title: string }>()
  const messages = new Map<string, { info: Record<string, unknown>; parts: Array<{ type: 'text'; text: string }> }>()
  const client = {
    getSession: async (id: string) => {
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
  const bridge = createOpenCodeLaunchAttemptProductionTestBridge({ dataDirectory: path.join(directory, 'data'),
    profileManager: profileManager as never, sessionStore: sessionStore as never,
    clientFactory: { create: () => client } as never,
    hostManager: { ensureScopedHostReference: async () => ({ handle: host }), releaseHostReference: async () => {},
      retainHostLease: async () => {} } as never,
    mcpManager: { ensureAppMcp: async () => {
      mcpCheckCount += 1
      throw new Error('MCP must not run before recovery settles')
    } } as never,
  })
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
      const record: OpenCodeSessionRecord = { teamId: 'team', laneId: 'primary', memberName: 'alice',
        providerId: 'opencode', selectedModel: 'openrouter/model', projectPath, profileRootKey: 'profile',
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
        claimToken, memberIdentity } }
      if (options.applied) {
        await lease.append({ type: 'member_applied', memberIdentity, linkage, claimToken })
      }
    }, context)
    return seeded
  }
  return { bridge, command: rawCommand, sessionStore, seedIntent, ledger, target, context,
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
    readSessionProjection: () => originalSessionGet('team', 'primary', 'alice'),
    memberCreates: () => memberCreateCount,
    sessionReads: () => sessionReadCount,
    mcpChecks: () => mcpCheckCount,
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}

function notFound(): Error { return new Error('request failed (404 Not Found)') }
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
    projectIdentity: '/fake/project', memberIdentity })
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
  const claim = { version: 1 as const, targetDigest, idempotencyIdentity: sessionId,
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
