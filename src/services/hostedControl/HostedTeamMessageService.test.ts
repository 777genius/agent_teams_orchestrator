import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { InboxPumpDecision } from './HostedTeamLeadInboxPump.js'
import {
  hostedMessageIdFor,
  HostedTeamMessageService,
  type HostedTeamMessageServiceOptions,
} from './HostedTeamMessageService.js'
import type { HostedControlAuthority } from './protocol.js'

const roots: string[] = []
const authority: HostedControlAuthority = {
  actorId: 'actor-a',
  deploymentId: 'deployment-a',
  bootId: 'boot-a',
  restoreGeneration: 0,
  workspaceId: 'workspace-a',
  mountBinding: { mountGeneration: 1, declaredRootHash: 'a'.repeat(64) },
  teamId: `team_${'b'.repeat(32)}`,
}
const command = {
  schemaVersion: 1,
  teamId: authority.teamId,
  clientMessageId: 'client_message_command01',
  text: 'hello team',
}
const messageId = hostedMessageIdFor(authority.teamId, command.clientMessageId)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function teamRoot(): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'hosted-message-send-')))
  roots.push(parent)
  const root = join(parent, 'legacy')
  await mkdir(root, { mode: 0o700 })
  return root
}

function service(root: string, options: Partial<HostedTeamMessageServiceOptions> = {}) {
  return new HostedTeamMessageService({ canonicalTeamRoot: root, guard: { isCurrent: () => true }, ...options })
}

function send(target: HostedTeamMessageService, payload: Record<string, unknown> = command) {
  return target.dispatch({ operation: 'message_send', payload, authority })
}

async function inbox(root: string, member: string): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await readFile(join(root, 'inboxes', `${member}.json`), 'utf8'))
}

describe('HostedTeamMessageService', () => {
  test('appends one row with an id derived from the client id and replays it after a restart', async () => {
    const root = await teamRoot()
    const receipt = {
      schemaVersion: 1, teamId: authority.teamId, messageId,
      clientMessageId: command.clientMessageId, persistence: 'durable',
    }
    await expect(send(service(root, { now: () => new Date('2026-09-26T10:00:00.000Z') })))
      .resolves.toEqual({ schemaVersion: 2, kind: 'persisted', receipt, runtimeDelivery: 'delivered' })
    // A new instance has no memory: the inbox row is the idempotency record.
    await expect(send(service(root, { now: () => new Date('2026-09-26T10:05:00.000Z') })))
      .resolves.toEqual({ schemaVersion: 2, kind: 'idempotent_replay', receipt, runtimeDelivery: 'delivered' })
    expect(await inbox(root, 'team-lead')).toEqual([{
      messageId, from: 'user', text: command.text, timestamp: '2026-09-26T10:00:00.000Z', read: false,
    }])
    await expect(send(service(root), { ...command, text: 'changed' }))
      .resolves.toEqual({ schemaVersion: 2, kind: 'conflict', reason: 'idempotency_mismatch' })
    expect(await inbox(root, 'team-lead')).toHaveLength(1)
  })

  test('two concurrent sends of one client id write one row and the other replays it', async () => {
    const root = await teamRoot()
    const results = await Promise.all([send(service(root)), send(service(root))])
    expect(results.map(result => result.kind).sort()).toEqual(['idempotent_replay', 'persisted'])
    expect(new Set(results.map(result => JSON.stringify(result.receipt))).size).toBe(1)
    expect(await inbox(root, 'team-lead')).toHaveLength(1)
  })

  test('reports delivered only when the pump confirmed the row, pending otherwise', async () => {
    const cases: Array<[InboxPumpDecision['kind'] | 'hang' | 'throw', string]> = [
      ['accepted', 'delivered'], ['observed', 'delivered'], ['native_inbox', 'delivered'],
      ['pending', 'pending'], ['unavailable', 'pending'], ['operator_required', 'operator_required'],
      ['hang', 'pending'], ['throw', 'pending'],
    ]
    for (const [decision, expected] of cases) {
      const root = await teamRoot()
      const woken: string[] = []
      const target = service(root, {
        confirmationMs: 20,
        pump: {
          wakeRecipient: async (recipient, id) => {
            woken.push(`${recipient}:${id}`)
            if (decision === 'hang') return new Promise(() => {})
            if (decision === 'throw') throw new Error('bridge down')
            return { kind: decision }
          },
        },
      })
      const result = await send(target)
      expect({ decision, runtimeDelivery: result.runtimeDelivery }).toEqual({ decision, runtimeDelivery: expected })
      expect(woken).toEqual([`team-lead:${messageId}`])
    }
  })

  test('admits a teammate recipient only from the current roster and fails closed without one', async () => {
    const root = await teamRoot()
    const roster = { isActiveRecipient: async (name: string) => name === 'alice' }
    await expect(send(service(root, { recipients: roster }), { ...command, recipient: 'mallory' }))
      .resolves.toEqual({ schemaVersion: 2, kind: 'invalid_recipient' })
    await expect(send(service(root, { recipients: roster }), { ...command, recipient: 'alice' }))
      .resolves.toMatchObject({ kind: 'persisted', receipt: { recipient: 'alice' } })
    expect(await inbox(root, 'alice')).toEqual([expect.objectContaining({ messageId, from: 'user' })])
    for (const recipient of ['team-lead', 'user', '../alice', '']) {
      await expect(send(service(root, { recipients: roster }), { ...command, recipient }))
        .rejects.toThrow('Invalid hosted message recipient')
    }
    await expect(send(service(root), { ...command, clientMessageId: 'client_message_command02', recipient: 'alice' }))
      .resolves.toEqual({ schemaVersion: 2, kind: 'unavailable', retryAfterMs: null })
  })

  test('writes nothing under a stale authority', async () => {
    const root = await teamRoot()
    await expect(send(service(root, { guard: { isCurrent: () => false } })))
      .resolves.toEqual({ schemaVersion: 2, kind: 'unavailable', retryAfterMs: null })
    await expect(readFile(join(root, 'inboxes', 'team-lead.json'))).rejects.toThrow()
  })
})
