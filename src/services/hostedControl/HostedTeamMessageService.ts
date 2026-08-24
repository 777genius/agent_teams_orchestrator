import type { HostedControlAuthority } from './protocol.js'
import type { HostedTeamMessageOperation, HostedTeamMessagePort } from './HostedControlDispatcher.js'

type PersistCommand = { schemaVersion: 1; teamId: string; clientMessageId: string; text: string }
type DeliveryRequest = { teamId: string; messageId: string; clientMessageId: string; text: string }
export type HostedPersistedMessage = DeliveryRequest & { createdAt: string }
type PersistenceReceipt = {
  schemaVersion: 1
  teamId: string
  messageId: string
  clientMessageId: string
  persistence: 'durable'
}

export type HostedMessagePersistenceDecision =
  | { kind: 'persisted' | 'idempotent_replay'; receipt: PersistenceReceipt }
  | { kind: 'conflict'; reason: 'idempotency_mismatch' }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; retryAfterMs?: number }

/** Durable store owns atomic idempotency across process restarts. */
export interface HostedMessageDurablePersistencePort {
  persist(command: PersistCommand, authority: HostedControlAuthority): Promise<HostedMessagePersistenceDecision>
  find(request: DeliveryRequest, authority: HostedControlAuthority): Promise<
    | { kind: 'found'; message: HostedPersistedMessage }
    | { kind: 'not_found' | 'conflict' | 'unavailable' }
  >
}

/** Delivery must be idempotent and return operator_required after an ambiguous write. */
export interface HostedMessageDeliveryEffectPort {
  deliver(message: HostedPersistedMessage, authority: HostedControlAuthority): Promise<
    | { kind: 'delivered' | 'pending' | 'operator_required' }
    | { kind: 'unavailable'; retryAfterMs?: number }
  >
}

export interface HostedMessageAuthorityGuard {
  isCurrent(authority: HostedControlAuthority): boolean | Promise<boolean>
}

export class HostedTeamMessageService implements HostedTeamMessagePort {
  constructor(
    private readonly persistence: HostedMessageDurablePersistencePort,
    private readonly delivery: HostedMessageDeliveryEffectPort,
    private readonly guard: HostedMessageAuthorityGuard,
  ) {
    if (typeof persistence.persist !== 'function' || typeof persistence.find !== 'function') {
      throw new TypeError('Hosted durable message persistence is not installed')
    }
    if (typeof delivery.deliver !== 'function') {
      throw new TypeError('Hosted message delivery effect is not installed')
    }
  }

  async dispatch(input: {
    operation: HostedTeamMessageOperation
    payload: Record<string, unknown>
    authority: HostedControlAuthority
  }): Promise<Record<string, unknown>> {
    if (!(await this.guard.isCurrent(input.authority))) return unavailable()
    if (input.operation === 'message_persist') {
      const command = persistCommand(input.payload, input.authority)
      const decision = await this.persistence.persist(command, input.authority)
      if (!(await this.guard.isCurrent(input.authority))) return unavailable()
      return persistencePayload(decision)
    }

    const request = deliveryRequest(input.payload, input.authority)
    const persisted = await this.persistence.find(request, input.authority)
    if (persisted.kind !== 'found' || !(await this.guard.isCurrent(input.authority))) {
      return persisted.kind === 'unavailable' ? unavailable() : { schemaVersion: 2, kind: 'operator_required' }
    }
    if (!sameDelivery(request, persisted.message)) {
      return { schemaVersion: 2, kind: 'operator_required' }
    }
    if (!(await this.guard.isCurrent(input.authority))) return unavailable()
    const decision = await this.delivery.deliver(persisted.message, input.authority)
    if (!(await this.guard.isCurrent(input.authority))) return unavailable()
    return deliveryPayload(decision)
  }
}

/** Safe default until an incarnation-bound mailbox authority is explicitly composed. */
export class FailClosedHostedMessageDelivery implements HostedMessageDeliveryEffectPort {
  async deliver(): Promise<{ kind: 'unavailable' }> {
    return { kind: 'unavailable' }
  }
}

function persistCommand(value: unknown, authority: HostedControlAuthority): PersistCommand {
  const record = exactRecord(value, ['schemaVersion', 'teamId', 'clientMessageId', 'text'], 'persist payload')
  if (record.schemaVersion !== 1 || record.teamId !== authority.teamId) throw new TypeError('Invalid hosted message team')
  return {
    schemaVersion: 1,
    teamId: authority.teamId,
    clientMessageId: pattern(record.clientMessageId, /^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'clientMessageId'),
    text: messageText(record.text),
  }
}

function deliveryRequest(value: unknown, authority: HostedControlAuthority): DeliveryRequest {
  const record = exactRecord(value, ['teamId', 'messageId', 'clientMessageId', 'text'], 'delivery payload')
  if (record.teamId !== authority.teamId) throw new TypeError('Invalid hosted message team')
  return {
    teamId: authority.teamId,
    messageId: pattern(record.messageId, /^message_[0-9a-f]{32}$/, 'messageId'),
    clientMessageId: pattern(record.clientMessageId, /^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'clientMessageId'),
    text: messageText(record.text),
  }
}

function sameDelivery(request: DeliveryRequest, message: HostedPersistedMessage): boolean {
  return request.teamId === message.teamId && request.messageId === message.messageId &&
    request.clientMessageId === message.clientMessageId && request.text === message.text &&
    Number.isFinite(Date.parse(message.createdAt))
}

function unavailable(): Record<string, unknown> {
  return { schemaVersion: 2, kind: 'unavailable', retryAfterMs: null }
}
function persistencePayload(decision: HostedMessagePersistenceDecision): Record<string, unknown> {
  if (decision.kind === 'unavailable') return unavailableWithRetry(decision.retryAfterMs)
  return { schemaVersion: 2, ...decision }
}
function deliveryPayload(
  decision: Awaited<ReturnType<HostedMessageDeliveryEffectPort['deliver']>>,
): Record<string, unknown> {
  if (decision.kind === 'unavailable') return unavailableWithRetry(decision.retryAfterMs)
  return { schemaVersion: 2, ...decision }
}
function unavailableWithRetry(retryAfterMs: number | undefined): Record<string, unknown> {
  return {
    schemaVersion: 2,
    kind: 'unavailable',
    retryAfterMs: Number.isSafeInteger(retryAfterMs) && (retryAfterMs as number) > 0
      ? retryAfterMs
      : null,
  }
}
function exactRecord(value: unknown, keys: string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${field}`)
  const record = value as Record<string, unknown>
  const actual = Reflect.ownKeys(record)
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new TypeError(`Invalid ${field} keys`)
  }
  return record
}
function pattern(value: unknown, regex: RegExp, field: string): string {
  if (typeof value !== 'string' || !regex.test(value)) throw new TypeError(`Invalid ${field}`)
  return value
}
function messageText(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_000 || value.trim() !== value ||
    value.includes('\r') || hasDisallowedControl(value)) throw new TypeError('Invalid hosted message text')
  return value
}
function hasDisallowedControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code === 127 || (code < 32 && code !== 9 && code !== 10) || (code >= 0x80 && code <= 0x9f) ||
      code === 0x061c || (code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)) return true
  }
  return false
}
