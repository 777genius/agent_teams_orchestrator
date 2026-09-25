import { describe, expect, test } from 'bun:test'
import {
  FailClosedHostedMessageDelivery,
  HostedTeamMessageService,
  type HostedMessageDeliveryEffectPort,
  type HostedMessageDurablePersistencePort,
} from './HostedTeamMessageService.js'
import type { HostedControlAuthority } from './protocol.js'

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
const message = {
  teamId: authority.teamId,
  messageId: `message_${'c'.repeat(32)}`,
  clientMessageId: command.clientMessageId,
  text: command.text,
  createdAt: '2026-08-09T12:00:00.000Z',
}
const receipt = {
  schemaVersion: 1 as const,
  teamId: authority.teamId,
  messageId: message.messageId,
  clientMessageId: command.clientMessageId,
  persistence: 'durable' as const,
}

function fixture(
  persistenceOverrides: Partial<HostedMessageDurablePersistencePort> = {},
  deliveryOverrides: Partial<HostedMessageDeliveryEffectPort> = {},
) {
  let persists = 0
  let deliveries = 0
  const persistence: HostedMessageDurablePersistencePort = {
    persist: async () => { persists += 1; return { kind: 'persisted', receipt } },
    find: async () => ({ kind: 'found', message }),
    ...persistenceOverrides,
  }
  const delivery: HostedMessageDeliveryEffectPort = {
    deliver: async () => { deliveries += 1; return { kind: 'delivered' } },
    ...deliveryOverrides,
  }
  return { persistence, delivery, persists: () => persists, deliveries: () => deliveries }
}

describe('HostedTeamMessageService', () => {
  test('has no global mailbox side effect without an incarnation-bound adapter', async () => {
    await expect(new FailClosedHostedMessageDelivery().deliver())
      .resolves.toEqual({ kind: 'unavailable' })
  })

  test('returns exact durable persistence and replay receipts', async () => {
    for (const kind of ['persisted', 'idempotent_replay'] as const) {
      const f = fixture({ persist: async () => ({ kind, receipt }) })
      const service = new HostedTeamMessageService(f.persistence, f.delivery, { isCurrent: () => true })
      await expect(service.dispatch({ operation: 'message_persist', payload: command, authority })).resolves.toEqual({
        schemaVersion: 2,
        kind,
        receipt,
      })
    }
  })

  test('preserves an idempotency conflict without attempting delivery', async () => {
    const f = fixture({
      persist: async () => ({ kind: 'conflict', reason: 'idempotency_mismatch' }),
    })
    const service = new HostedTeamMessageService(f.persistence, f.delivery, { isCurrent: () => true })
    const result = await service.dispatch({ operation: 'message_persist', payload: command, authority })
    expect(result).toEqual({ schemaVersion: 2, kind: 'conflict', reason: 'idempotency_mismatch' })
    expect(f.deliveries()).toBe(0)
  })

  test('delivers only the exact durable record and returns its acknowledgement', async () => {
    const f = fixture()
    const service = new HostedTeamMessageService(f.persistence, f.delivery, { isCurrent: () => true })
    await expect(service.dispatch({
      operation: 'message_deliver',
      payload: { teamId: message.teamId, messageId: message.messageId, clientMessageId: message.clientMessageId, text: message.text },
      authority,
    })).resolves.toEqual({ schemaVersion: 2, kind: 'delivered' })
    expect(f.deliveries()).toBe(1)
  })

  test('requires an operator for missing or mismatched persistence proof', async () => {
    for (const find of [
      async () => ({ kind: 'not_found' as const }),
      async () => ({ kind: 'found' as const, message: { ...message, text: 'different' } }),
    ]) {
      const f = fixture({ find })
      const service = new HostedTeamMessageService(f.persistence, f.delivery, { isCurrent: () => true })
      const result = await service.dispatch({
        operation: 'message_deliver',
        payload: { teamId: message.teamId, messageId: message.messageId, clientMessageId: message.clientMessageId, text: message.text },
        authority,
      })
      expect(result).toEqual({ schemaVersion: 2, kind: 'operator_required' })
      expect(f.deliveries()).toBe(0)
    }
  })

  test('does not persist or deliver after denied or stale authority', async () => {
    const f = fixture()
    const denied = new HostedTeamMessageService(f.persistence, f.delivery, { isCurrent: () => false })
    expect((await denied.dispatch({ operation: 'message_persist', payload: command, authority })).kind).toBe('unavailable')
    expect(f.persists()).toBe(0)

    let checks = 0
    const stale = new HostedTeamMessageService(f.persistence, f.delivery, {
      isCurrent: () => ++checks === 1,
    })
    const result = await stale.dispatch({
      operation: 'message_deliver',
      payload: { teamId: message.teamId, messageId: message.messageId, clientMessageId: message.clientMessageId, text: message.text },
      authority,
    })
    expect(result).toEqual({ schemaVersion: 2, kind: 'operator_required' })
    expect(f.deliveries()).toBe(0)
  })

  test('maps an ambiguous delivery to operator_required without retrying', async () => {
    let attempts = 0
    const f = fixture({}, {
      deliver: async () => { attempts += 1; return { kind: 'operator_required' } },
    })
    const service = new HostedTeamMessageService(f.persistence, f.delivery, { isCurrent: () => true })
    const result = await service.dispatch({
      operation: 'message_deliver',
      payload: { teamId: message.teamId, messageId: message.messageId, clientMessageId: message.clientMessageId, text: message.text },
      authority,
    })
    expect(result).toEqual({ schemaVersion: 2, kind: 'operator_required' })
    expect(attempts).toBe(1)
  })

  test('suppresses the acknowledgement when authority changes during delivery', async () => {
    let checks = 0
    const f = fixture()
    const service = new HostedTeamMessageService(f.persistence, f.delivery, {
      isCurrent: () => ++checks <= 3,
    })
    const result = await service.dispatch({
      operation: 'message_deliver',
      payload: { teamId: message.teamId, messageId: message.messageId, clientMessageId: message.clientMessageId, text: message.text },
      authority,
    })
    expect(f.deliveries()).toBe(1)
    expect(result).toEqual({ schemaVersion: 2, kind: 'unavailable', retryAfterMs: null })
  })

  test('normalizes unavailable results to the exact retry envelope', async () => {
    const persistenceFixture = fixture({ persist: async () => ({ kind: 'unavailable' }) })
    const persistenceService = new HostedTeamMessageService(
      persistenceFixture.persistence,
      persistenceFixture.delivery,
      { isCurrent: () => true },
    )
    await expect(persistenceService.dispatch({
      operation: 'message_persist', payload: command, authority,
    })).resolves.toEqual({ schemaVersion: 2, kind: 'unavailable', retryAfterMs: null })

    const deliveryFixture = fixture({}, {
      deliver: async () => ({ kind: 'unavailable', retryAfterMs: 250 }),
    })
    const deliveryService = new HostedTeamMessageService(
      deliveryFixture.persistence,
      deliveryFixture.delivery,
      { isCurrent: () => true },
    )
    await expect(deliveryService.dispatch({
      operation: 'message_deliver',
      payload: { teamId: message.teamId, messageId: message.messageId, clientMessageId: message.clientMessageId, text: message.text },
      authority,
    })).resolves.toEqual({ schemaVersion: 2, kind: 'unavailable', retryAfterMs: 250 })
  })

  test('admits a teammate recipient only from the current roster and fails closed without one', async () => {
    const payload = { ...command, recipient: 'alice' }
    const persisted: unknown[] = []
    const f = fixture({ persist: async input => { persisted.push(input); return { kind: 'persisted', receipt } } })
    const roster = { isActiveRecipient: async (name: string) => name === 'alice' }
    const service = new HostedTeamMessageService(f.persistence, f.delivery, { isCurrent: () => true }, roster)

    await expect(service.dispatch({
      operation: 'message_persist', payload: { ...command, recipient: 'mallory' }, authority,
    })).resolves.toEqual({ schemaVersion: 2, kind: 'invalid_recipient' })
    expect(persisted).toEqual([])
    await expect(service.dispatch({ operation: 'message_persist', payload, authority }))
      .resolves.toMatchObject({ schemaVersion: 2, kind: 'persisted' })
    expect(persisted).toEqual([payload])

    for (const recipient of ['team-lead', 'user', '../alice', '']) {
      await expect(service.dispatch({
        operation: 'message_persist', payload: { ...command, recipient }, authority,
      })).rejects.toThrow('Invalid hosted message recipient')
    }
    const withoutRoster = new HostedTeamMessageService(f.persistence, f.delivery, { isCurrent: () => true })
    await expect(withoutRoster.dispatch({ operation: 'message_persist', payload, authority }))
      .resolves.toEqual({ schemaVersion: 2, kind: 'unavailable', retryAfterMs: null })
    expect(persisted).toEqual([payload])
  })
})
