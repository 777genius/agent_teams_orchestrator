import { describe, expect, test } from 'bun:test'

import {
  hydrateOpenCodeRecoveredSessionLease,
  OpenCodeLaunchRetainedHostLeases,
  OpenCodeRetainedHostLeaseForeignError,
  readOpenCodeExactMessageText,
} from './OpenCodeLaunchProductionGuards.js'
import type { OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'

const oid = (character: string) => `sha256:${character.repeat(64)}` as OpenCodeOpaqueIdentity

describe('OpenCode launch production guards', () => {
  test('does not trim a nonce response', () => {
    expect(readOpenCodeExactMessageText({ parts: [{ text: ' nonce ' }] })).toBe(' nonce ')
    expect(readOpenCodeExactMessageText({ parts: [{ text: 'nonce' }, { text: '' }] })).toBe('nonce\n')
  })

  test('member 1 durable lease keeps the retained host after member 2 failure cleanup', () => {
    const leases = new OpenCodeLaunchRetainedHostLeases()
    leases.commit(oid('1'))
    leases.remove(oid('2'))
    expect(leases.shouldKeepHostAlive()).toBe(true)
    leases.remove(oid('1'))
    expect(leases.shouldKeepHostAlive()).toBe(false)
  })

  test('restart hydrates recovered member ownership before later-member cleanup', async () => {
    const leases = new OpenCodeLaunchRetainedHostLeases()
    const retained: Array<{ hostKey: string; sessionId: string }> = []
    await hydrateOpenCodeRecoveredSessionLease({
      record: {
        hostKey: 'host-one', teamId: 'team', laneId: 'primary', memberName: 'member-1',
        opencodeSessionId: 'session-one',
      },
      memberIdentity: oid('1'), runId: 'restart-run', leases,
      retainHostLease: async (hostKey, owner) => { retained.push({ hostKey, sessionId: owner.sessionId }) },
    })

    leases.remove(oid('2'))
    expect(retained).toEqual([{ hostKey: 'host-one', sessionId: 'session-one' }])
    expect(leases.shouldKeepHostAlive()).toBe(true)
  })

  test('foreign recovery CAS fails typed and never marks the host reusable', async () => {
    const leases = new OpenCodeLaunchRetainedHostLeases()
    const attempt = hydrateOpenCodeRecoveredSessionLease({
      record: {
        hostKey: 'shared-host', teamId: 'team', laneId: 'primary', memberName: 'member-1',
        opencodeSessionId: 'stale-session',
      },
      memberIdentity: oid('1'), runId: 'stale-run', leases,
      retainHostLease: async () => 'foreign',
    })

    await expect(attempt).rejects.toBeInstanceOf(OpenCodeRetainedHostLeaseForeignError)
    await expect(attempt).rejects.toThrow('custody changed [redacted]')
    expect(leases.shouldKeepHostAlive()).toBe(false)
  })

  test('exact recovery retry is reusable without rewriting custody', async () => {
    const leases = new OpenCodeLaunchRetainedHostLeases()
    const outcome = await hydrateOpenCodeRecoveredSessionLease({
      record: {
        hostKey: 'shared-host', teamId: 'team', laneId: 'primary', memberName: 'member-1',
        opencodeSessionId: 'successor-session',
      },
      memberIdentity: oid('1'), runId: 'successor-run', leases,
      retainHostLease: async () => 'exact',
    })

    expect(outcome).toBe('exact')
    expect(leases.shouldKeepHostAlive()).toBe(true)
  })
})
