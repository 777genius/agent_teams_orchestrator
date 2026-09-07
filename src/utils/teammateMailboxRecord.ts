import { createHash } from 'node:crypto'
import type { TeammateMessage } from './teammateMailbox.js'
export type RawTeammateMessage = Omit<TeammateMessage, 'messageId'> & { messageId?: string }

export function createCompatibilityInboxMessageId(parts: {
  from: string
  text: string
  timestamp: string
}): string {
  return `inbox-${createHash('sha256').update(`${parts.from}\n${parts.timestamp}\n${parts.text}`).digest('hex').slice(0, 16)}`
}

export function resolveTeammateMessageId(
  message: Pick<
    RawTeammateMessage,
    'from' | 'text' | 'timestamp' | 'messageId'
  >,
): string {
  if (
    typeof message.messageId === 'string' &&
    message.messageId.trim().length > 0
  ) {
    return message.messageId
  }
  return createCompatibilityInboxMessageId(message)
}

export function normalizeTeammateMessage(
  message: RawTeammateMessage,
): TeammateMessage {
  return {
    ...message,
    messageId: resolveTeammateMessageId(message),
  }
}

export function isRawMailboxMessage(value: unknown): value is RawTeammateMessage {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { from?: unknown }).from === 'string' &&
    typeof (value as { text?: unknown }).text === 'string' &&
    typeof (value as { timestamp?: unknown }).timestamp === 'string'
  )
}

export function hasVerifiedMailboxMessage(
  messages: readonly TeammateMessage[],
  message: Pick<TeammateMessage, 'messageId' | 'from' | 'timestamp' | 'text'>,
): boolean {
  return messages.some(
    row =>
      row.messageId === message.messageId &&
      row.from === message.from &&
      row.timestamp === message.timestamp &&
      row.text === message.text,
  )
}
