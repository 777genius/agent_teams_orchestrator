import { expect, test } from 'bun:test'

import {
  createOpenCodeOwnedMemberSession,
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
