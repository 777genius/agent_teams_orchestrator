import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { writeToMailboxAtCanonicalTeamRootVerified } from '../../utils/teammateMailbox.js'
import type { HostedControlAuthority } from './protocol.js'
import type { HostedTeamMessageOperation, HostedTeamMessagePort } from './HostedControlDispatcher.js'
import type { InboxPumpDecision } from './HostedTeamLeadInboxPump.js'
import {
  isHostedMessageRecipientName,
  type HostedMessageRecipientRoster,
} from './HostedTeamRecipientRoster.js'

/**
 * How long message_send waits for the pump before answering `pending`. It must
 * stay well inside Product's 5s owner-exchange deadline.
 */
export const HOSTED_INBOX_PUMP_CONFIRMATION_MS = 2_000
const MESSAGE_ID_DOMAIN = 'agent-teams.hosted-message.id/v1'

/** An absent recipient addresses the team lead. */
type SendCommand = {
  teamId: string
  clientMessageId: string
  text: string
  recipient?: string
}
type RuntimeDelivery = 'delivered' | 'pending' | 'operator_required'

export interface HostedMessageAuthorityGuard {
  isCurrent(authority: HostedControlAuthority): boolean | Promise<boolean>
}

/** The pump that prompts a recipient's OpenCode session; absent when no OpenCode lane exists. */
export interface HostedMessageDeliveryWaker {
  wakeRecipient(recipient: string, messageId: string): Promise<InboxPumpDecision>
}

export type HostedTeamMessageServiceOptions = {
  canonicalTeamRoot: string
  guard: HostedMessageAuthorityGuard
  /** Without a roster only lead messages are admitted. */
  recipients?: HostedMessageRecipientRoster | null
  pump?: HostedMessageDeliveryWaker
  writeMailbox?: typeof writeToMailboxAtCanonicalTeamRootVerified
  now?: () => Date
  confirmationMs?: number
}

/**
 * The one hosted user-message operation. The inbox row is the durable record:
 * its id derives from the browser's client message id, so a retry after any
 * restart finds the row and replays it. The pump then prompts the recipient,
 * and `delivered` means its session accepted the row, or a native recipient,
 * which reads its own inbox, has it.
 */
export class HostedTeamMessageService implements HostedTeamMessagePort {
  readonly #root: string
  readonly #guard: HostedMessageAuthorityGuard
  readonly #recipients: HostedMessageRecipientRoster | null
  readonly #pump: HostedMessageDeliveryWaker | undefined
  readonly #writeMailbox: typeof writeToMailboxAtCanonicalTeamRootVerified
  readonly #now: () => Date
  readonly #confirmationMs: number

  constructor(options: HostedTeamMessageServiceOptions) {
    if (!isAbsolute(options.canonicalTeamRoot)) {
      throw new TypeError('Hosted message service requires the canonical team root')
    }
    this.#root = options.canonicalTeamRoot
    this.#guard = options.guard
    this.#recipients = options.recipients ?? null
    this.#pump = options.pump
    this.#writeMailbox = options.writeMailbox ?? writeToMailboxAtCanonicalTeamRootVerified
    this.#now = options.now ?? (() => new Date())
    this.#confirmationMs = options.confirmationMs ?? HOSTED_INBOX_PUMP_CONFIRMATION_MS
  }

  async dispatch(input: {
    operation: HostedTeamMessageOperation
    payload: Record<string, unknown>
    authority: HostedControlAuthority
  }): Promise<Record<string, unknown>> {
    if (input.operation !== 'message_send') throw new TypeError('Invalid hosted message operation')
    if (!(await this.#guard.isCurrent(input.authority))) return unavailable()
    const command = sendCommand(input.payload, input.authority)
    if (command.recipient !== undefined) {
      if (!this.#recipients) return unavailable()
      let admitted: boolean
      try {
        admitted = await this.#recipients.isActiveRecipient(command.recipient)
      } catch {
        return unavailable()
      }
      if (!(await this.#guard.isCurrent(input.authority))) return unavailable()
      if (!admitted) return { schemaVersion: 2, kind: 'invalid_recipient' }
    }
    const recipient = command.recipient ?? TEAM_LEAD_NAME
    const messageId = hostedMessageIdFor(command.teamId, command.clientMessageId)
    let written: Awaited<ReturnType<typeof writeToMailboxAtCanonicalTeamRootVerified>>
    try {
      written = await this.#writeMailbox({
        canonicalTeamRoot: this.#root,
        recipientName: recipient,
        message: { messageId, from: 'user', text: command.text, timestamp: this.#now().toISOString() },
        replay: 'same_content',
      })
    } catch {
      // Whatever reached the inbox carries the deterministic id: the retry replays it.
      return unavailable()
    }
    if (written.kind === 'conflict') return { schemaVersion: 2, kind: 'conflict', reason: 'idempotency_mismatch' }
    if (!(await this.#guard.isCurrent(input.authority))) return unavailable()
    return {
      schemaVersion: 2,
      kind: written.kind === 'written' ? 'persisted' : 'idempotent_replay',
      receipt: {
        schemaVersion: 1,
        teamId: command.teamId,
        messageId,
        clientMessageId: command.clientMessageId,
        persistence: 'durable',
        ...(command.recipient === undefined ? {} : { recipient: command.recipient }),
      },
      runtimeDelivery: await this.#runtimeDelivery(recipient, messageId),
    }
  }

  /** Without a pump the appended row is the delivery, as it is for native readers. */
  async #runtimeDelivery(recipient: string, messageId: string): Promise<RuntimeDelivery> {
    if (!this.#pump) return 'delivered'
    const wake = this.#pump.wakeRecipient(recipient, messageId)
      .catch((): InboxPumpDecision => ({ kind: 'unavailable' }))
    const decision = await settleWithin(wake, this.#confirmationMs)
    switch (decision?.kind) {
      case 'accepted':
      case 'observed':
      case 'native_inbox':
        return 'delivered'
      case 'operator_required':
        return 'operator_required'
      default:
        return 'pending'
    }
  }
}

/** The id a browser send gets in every inbox and receipt; stable across restarts. */
export function hostedMessageIdFor(teamId: string, clientMessageId: string): string {
  return `message_${createHash('sha256')
    .update(`${MESSAGE_ID_DOMAIN}\0${teamId}\0${clientMessageId}`)
    .digest('hex').slice(0, 32)}`
}

async function settleWithin<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function sendCommand(value: unknown, authority: HostedControlAuthority): SendCommand {
  const keys = ['schemaVersion', 'teamId', 'clientMessageId', 'text']
  const hasRecipient = !!value && typeof value === 'object' && Object.hasOwn(value, 'recipient')
  const record = exactRecord(value, hasRecipient ? [...keys, 'recipient'] : keys, 'send payload')
  if (record.schemaVersion !== 1 || record.teamId !== authority.teamId) throw new TypeError('Invalid hosted message team')
  if (hasRecipient && !isHostedMessageRecipientName(record.recipient)) {
    throw new TypeError('Invalid hosted message recipient')
  }
  return {
    teamId: authority.teamId,
    clientMessageId: pattern(record.clientMessageId, /^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, 'clientMessageId'),
    text: messageText(record.text),
    ...(hasRecipient ? { recipient: record.recipient as string } : {}),
  }
}

function unavailable(): Record<string, unknown> {
  return { schemaVersion: 2, kind: 'unavailable', retryAfterMs: null }
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
