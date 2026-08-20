import { expect, test } from 'bun:test'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  createOpenCodeOwnedMemberSession,
  OpenCodeProofSessionCleanupLedger,
  reconcileOpenCodeOwnedMemberSession,
} from './OpenCodeLaunchAttemptProductionSession.js'
import type { OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'

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

test('proof cleanup ownership is durable before POST and a lost response is reconciled without another create', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-proof-cleanup-'))
  try {
    const ledger = new OpenCodeProofSessionCleanupLedger(path.join(directory, 'proof.json'))
    const ownership = { attemptId: 'attempt-a', hostKeyIdentity: identity,
      authoritativeSessionId: 'session-deterministic', ownershipTitle: 'agent-teams-proof:attempt-a:digest' }
    const first = await ledger.register(ownership)
    expect(first.created).toBe(true)
    expect((await ledger.read())?.state).toBe('registered')

    const remote = new Map([[ownership.authoritativeSessionId, {
      id: ownership.authoritativeSessionId, title: ownership.ownershipTitle,
    }]])
    const outcome = await reconcileOpenCodeOwnedMemberSession({
      authoritativeSessionId: ownership.authoritativeSessionId,
      ownershipTitle: ownership.ownershipTitle,
      getSession: async id => {
        const session = remote.get(id)
        if (!session) throw new Error('request failed (404 Not Found)')
        return session
      },
      deleteSession: async id => remote.delete(id),
    })
    await ledger.recordState(ownership, outcome)
    expect(outcome).toBe('deleted')
    expect((await ledger.read())?.state).toBe('deleted')
    expect((await ledger.register(ownership)).created).toBe(false)
    expect(remote.size).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('proof cleanup ledger truthfully retains inconclusive and foreign outcomes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-proof-cleanup-'))
  try {
    const ledger = new OpenCodeProofSessionCleanupLedger(path.join(directory, 'proof.json'))
    const ownership = { attemptId: 'attempt-a', hostKeyIdentity: identity,
      authoritativeSessionId: 'session-deterministic', ownershipTitle: 'agent-teams-proof:attempt-a:digest' }
    await ledger.register(ownership)
    expect(await reconcileOpenCodeOwnedMemberSession({
      authoritativeSessionId: ownership.authoritativeSessionId,
      ownershipTitle: ownership.ownershipTitle,
      getSession: async () => { throw new Error('inconclusive GET') },
      deleteSession: async () => true,
    })).toBe('unresolved')
    await ledger.recordState(ownership, 'unresolved')
    expect((await ledger.read())?.state).toBe('unresolved')
    let deleteCalls = 0
    expect(await reconcileOpenCodeOwnedMemberSession({
      authoritativeSessionId: ownership.authoritativeSessionId,
      ownershipTitle: ownership.ownershipTitle,
      getSession: async () => ({ id: ownership.authoritativeSessionId, title: ownership.ownershipTitle }),
      deleteSession: async () => { deleteCalls += 1; throw new Error('inconclusive DELETE') },
    })).toBe('unresolved')
    expect(deleteCalls).toBe(1)
    await ledger.recordState(ownership, 'foreign')
    expect((await ledger.read())?.state).toBe('foreign')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
