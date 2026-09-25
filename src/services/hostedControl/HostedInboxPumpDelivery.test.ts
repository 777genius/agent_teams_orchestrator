import { describe, expect, test } from 'bun:test'

import { confirmDeliveryThroughInboxPump } from './HostedInboxPumpDelivery.js'
import type { InboxPumpDecision } from './HostedTeamLeadInboxPump.js'
import type { HostedPersistedMessage } from './HostedTeamMessageService.js'
import type { HostedControlAuthority } from './protocol.js'

const authority = {
  actorId: 'actor-a', deploymentId: 'deployment-a', bootId: 'boot-a', restoreGeneration: 1,
  workspaceId: 'workspace-a', mountBinding: { mountGeneration: 1, declaredRootHash: 'b'.repeat(64) },
  teamId: `team_${'a'.repeat(32)}`,
} satisfies HostedControlAuthority
const message: HostedPersistedMessage = {
  teamId: authority.teamId, messageId: `message_${'c'.repeat(32)}`,
  clientMessageId: 'client_message_confirm', text: 'hello', createdAt: '2026-09-25T10:00:00.000Z',
  recipient: 'alice',
}
const appended = { deliver: async () => ({ kind: 'delivered' as const }) }

describe('confirmDeliveryThroughInboxPump', () => {
  test('reports delivered only when the pump confirmed the prompt or a native inbox', async () => {
    const cases: Array<[InboxPumpDecision['kind'], string]> = [
      ['accepted', 'delivered'], ['observed', 'delivered'], ['native_inbox', 'delivered'],
      ['pending', 'pending'], ['unavailable', 'pending'], ['operator_required', 'operator_required'],
    ]
    for (const [decision, expected] of cases) {
      const woken: string[] = []
      const port = confirmDeliveryThroughInboxPump(appended, {
        wake: async ({ recipient }) => { woken.push(recipient); return { kind: decision } },
      })
      const result: string = (await port.deliver(message, authority)).kind
      expect({ decision, result }).toEqual({ decision, result: expected })
      expect(woken).toEqual(['alice'])
    }
  })

  test('answers pending when the pump does not settle in time or fails', async () => {
    const slow = confirmDeliveryThroughInboxPump(appended, {
      wake: () => new Promise(() => {}),
    }, 20)
    expect(await slow.deliver(message, authority)).toEqual({ kind: 'pending' })
    const failing = confirmDeliveryThroughInboxPump(appended, {
      wake: async () => { throw new Error('bridge down') },
    })
    expect(await failing.deliver(message, authority)).toEqual({ kind: 'pending' })
  })

  test('never wakes the pump when the inbox append itself did not succeed', async () => {
    let woken = 0
    for (const kind of ['operator_required', 'unavailable'] as const) {
      const port = confirmDeliveryThroughInboxPump({ deliver: async () => ({ kind }) }, {
        wake: async () => { woken++; return { kind: 'accepted' } },
      })
      expect(await port.deliver(message, authority)).toEqual({ kind })
    }
    expect(woken).toBe(0)
  })
})
