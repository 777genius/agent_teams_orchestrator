import { expect, test } from 'bun:test'
import path from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { createHash } from 'node:crypto'

import {
  commitOpenCodeMemberProjection,
  createOpenCodeOwnedMemberSession,
  OpenCodeProofSessionCleanupLedger,
  recoverOpenCodeCommittedMemberProjection,
  reconcileOpenCodeOwnedMemberSession,
} from './OpenCodeLaunchAttemptProductionSession.js'
import { OpenCodeLaunchMutationLedger, type OpenCodeLaunchMutationIdentity } from './OpenCodeLaunchMutationLedger.js'
import type { OpenCodeLaunchMemberLinkage, OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'
import type { OpenCodeSessionRecord } from './types.js'

const identity = `sha256:${'a'.repeat(64)}` as OpenCodeOpaqueIdentity

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

test('proof cleanup refuses an expired immutable launch deadline before publication', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-proof-deadline-'))
  try {
    const file = path.join(directory, 'proof.json')
    const ledger = new OpenCodeProofSessionCleanupLedger(file)
    await expect(ledger.reconcileAndRegister({ attemptId: 'attempt-a', requestGeneration: 1,
      hostKeyIdentity: identity, ownership: generation => ({ authoritativeSessionId: `proof-${generation}`,
        ownershipTitle: `owned-${generation}` }), reconcile: async () => 'absent' }, {
      deadlineAtMs: performance.now() - 1, signal: new AbortController().signal,
    })).rejects.toThrow('deadline expired')
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
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

test('committed mutation crash failpoints rehydrate only the exact remote projection without create', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-commit-recovery-'))
  try {
    const ledger = new OpenCodeLaunchMutationLedger(path.join(directory, 'claims'))
    const memberIdentity = identity
    const target = OpenCodeLaunchMutationLedger.targetDigest({ teamId: 'team', laneId: 'primary',
      projectIdentity: '/fake/project', memberIdentity })
    const authority: OpenCodeLaunchMutationIdentity = { attemptId: '123e4567-e89b-42d3-a456-426614174001',
      payloadHash: 'a'.repeat(64), inputDigest: 'b'.repeat(64), generation: 1, fence: 1,
      acquisitionToken: 'acquire', claimToken: 'claim', memberIdentity }
    const sessionId = OpenCodeLaunchMutationLedger.idempotencyIdentity(target)
    const title = `agent-teams-launch:${authority.attemptId}:${memberIdentity}:${createHash('sha256').update('claim').digest('hex')}`
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
      commit: () => ledger.transition(target, authority, 'commit', linkage, storeContext(),
        { ownershipTitle: title, sessionRecord: record }),
      upsert: async () => { projected.push(record) },
      failpoint: point => { if (point === 'after_commit') throw new Error('crash:after_commit') },
    })).rejects.toThrow('crash:after_commit')
    expect(projected).toHaveLength(0)
    const claim = await new OpenCodeLaunchMutationLedger(path.join(directory, 'claims')).read(target, storeContext())
    let creates = 0
    const recovered = await recoverOpenCodeCommittedMemberProjection({ claim: claim!, teamId: 'team',
      laneId: 'primary', memberName: 'alice', selectedModel: 'openrouter/model', expectedBootstrapText: text,
      getSession: async () => ({ id: sessionId, title }),
      getSessionMessage: async () => ({ info: { id: messageID, providerID: 'openrouter', modelID: 'model' },
        parts: [{ type: 'text', text }] }),
      upsert: async value => { projected.push(value) },
    })
    expect(recovered.status).toBe('recovered')
    expect(projected).toHaveLength(1)
    expect(creates).toBe(0)
  } finally { await rm(directory, { recursive: true, force: true }) }
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
    ['transport', async () => { throw new Error('unknown transport') }, async () => null],
  ] as const) {
    let upserts = 0
    const result = await recoverOpenCodeCommittedMemberProjection({ ...base.input,
      getSession, getSessionMessage: getMessage, upsert: async () => { upserts += 1 } })
    expect(result).toEqual({ status: 'unresolved', reason })
    expect(upserts).toBe(0)
  }
})

function notFound(): Error { return new Error('request failed (404 Not Found)') }
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
  const claimToken = 'claim'
  const sessionId = 'ses_01234567890123456789012345'
  const title = `agent-teams-launch:${attemptId}:${memberIdentity}:${createHash('sha256').update(claimToken).digest('hex')}`
  const text = '<bootstrap-exact>'
  const now = new Date().toISOString()
  const record = { teamId: 'team', laneId: 'primary', memberName: 'alice', providerId: 'opencode' as const,
    selectedModel: 'openrouter/model', projectPath: '/fake/project', profileRootKey: 'profile', hostKey: 'host',
    resolvedBehaviorFingerprint: null, opencodeSessionId: sessionId, lastCanonicalCursor: null,
    lastKnownRawStatus: null, lastKnownDurableState: null, sourceAuthFingerprint: null,
    managedAuthFingerprint: null, projectBehaviorFingerprint: 'behavior', staleReason: null,
    appManagedBootstrap: { schemaVersion: 1 as const, messageID: 'msg_exact',
      contextHash: createHash('sha256').update(text).digest('hex'), briefingHash: createHash('sha256').update('').digest('hex'),
      injectionVerifiedAt: now, model: 'openrouter/model', agent: 'teammate-bootstrap' }, createdAt: now, updatedAt: now }
  const linkage = linkageForTest(memberIdentity, record)
  const claim = { version: 1 as const, targetDigest: 'd'.repeat(64), idempotencyIdentity: sessionId,
    state: 'committed' as const, attemptId, payloadHash: 'a'.repeat(64), inputDigest: 'b'.repeat(64),
    generation: 1, fence: 1, acquisitionToken: 'acquire', claimToken, memberIdentity, linkage,
    recovery: { ownershipTitle: title, sessionRecord: record } }
  const message = { info: { id: 'msg_exact', providerID: 'openrouter', modelID: 'model' },
    parts: [{ type: 'text' as const, text }] }
  return { sessionId, title, message, input: { claim, teamId: 'team', laneId: 'primary', memberName: 'alice',
    selectedModel: 'openrouter/model', expectedBootstrapText: text } }
}
