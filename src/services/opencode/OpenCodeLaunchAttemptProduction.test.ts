import { expect, test } from 'bun:test'

import { createOpenCodeOwnedMemberSession } from './OpenCodeLaunchAttemptProductionSession.js'
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
