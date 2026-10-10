import type { QueuedCommand } from '../types/textInputTypes.js'
import type { AppState } from '../state/AppStateStore.js'
import { getSessionId } from '../bootstrap/state.js'
import { TEAMMATE_BOOTSTRAP_RUN_ID_ENV } from './swarm/teammateRuntimeEvents.js'

/** Persisted group protocol. Physical messageId differs from canonical groupMessageId. */
export type GroupMailboxEnvelope = {
  groupChatId?: string
  groupChatName?: string
  groupMessageId?: string
  groupChatProtocolVersion?: 1
  groupRunKey?: string
  groupRecipientNames?: string[]
  groupRecipientRunKeys?: Record<string, string>
  relayOfMessageId?: string
}

export function hasGroupMailboxMarker(message: unknown): boolean {
  return !!message && typeof message === 'object' && [
    'groupChatId', 'groupChatName', 'groupMessageId', 'groupChatProtocolVersion',
    'groupRunKey', 'groupRecipientNames', 'groupRecipientRunKeys',
    'groupDeliverySummary', 'groupHandoffStartedAt',
  ].some(key => Object.prototype.hasOwnProperty.call(message, key))
}

// Same 10 MiB source budget as the app inbox/history owner. No repair or truncation.
export const GROUP_MAILBOX_SOURCE_MAX_BYTES = 10 * 1024 * 1024

export function assertValidGroupMailboxRows(rows: unknown[]): void {
  const ids = new Set<string>()
  const counts = new Map<unknown, number>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const id = (row as Record<string, unknown>).messageId
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  const uuid = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  for (const value of rows) {
    if (!hasGroupMailboxMarker(value)) continue
    const row = value as Record<string, unknown>
    if (!uuid(row.groupChatId) || !uuid(row.groupMessageId) || !nonempty(row.messageId) ||
        row.groupChatProtocolVersion !== 1 || !nonempty(row.from) || typeof row.text !== 'string' ||
        !nonempty(row.timestamp) || !Number.isFinite(Date.parse(row.timestamp)) || typeof row.read !== 'boolean' ||
        (row.groupChatName !== undefined && !nonempty(row.groupChatName)) ||
        (row.relayOfMessageId !== undefined && !nonempty(row.relayOfMessageId)) ||
        (row.groupHandoffStartedAt !== undefined && (!nonempty(row.groupHandoffStartedAt) || !Number.isFinite(Date.parse(row.groupHandoffStartedAt)))) ||
        (row.messageId !== row.groupMessageId && !nonempty(row.groupRunKey)) ||
        (row.groupRunKey !== undefined && !nonempty(row.groupRunKey)) ||
        (row.groupRecipientNames !== undefined && (!Array.isArray(row.groupRecipientNames) || !row.groupRecipientNames.every(nonempty))) ||
        (row.groupRecipientRunKeys !== undefined && (!row.groupRecipientRunKeys || typeof row.groupRecipientRunKeys !== 'object' || Array.isArray(row.groupRecipientRunKeys) || !Object.values(row.groupRecipientRunKeys).every(nonempty))) ||
        ids.has(row.messageId as string)) {
      throw new Error('GROUP_STORAGE_UNAVAILABLE: invalid or duplicate group envelope')
    }
    ids.add(row.messageId as string)
    if (row.groupDeliverySummary !== undefined) {
      const summary = row.groupDeliverySummary as Record<string, unknown> | null
      if (!summary || typeof summary !== 'object' || !nonempty(summary.recordedAt) || !Number.isFinite(Date.parse(summary.recordedAt)) ||
          !Array.isArray(summary.recipients) || !summary.recipients.every(recipient =>
            recipient && typeof recipient === 'object' && nonempty(recipient.memberName) && nonempty(recipient.physicalMessageId) &&
            ['queued', 'accepted', 'failed', 'unknown', 'skipped'].includes(recipient.status) &&
            (recipient.reason === undefined || typeof recipient.reason === 'string'))) {
        throw new Error('GROUP_STORAGE_UNAVAILABLE: malformed group delivery summary')
      }
    }
  }
  // A legacy/raw row must not alias a group canonical or physical identity.
  for (const id of ids) {
    if (counts.get(id) !== 1) {
      throw new Error('GROUP_STORAGE_UNAVAILABLE: ambiguous group message identity')
    }
  }
}

export function getCurrentGroupRunIdentity(): { bootstrapRunId: string; runtimeRunId: string; pid: number; groupRunKey: string; runKey: string } {
  const bootstrapRunId = process.env[TEAMMATE_BOOTSTRAP_RUN_ID_ENV]?.trim() || getSessionId()
  return { bootstrapRunId, runtimeRunId: bootstrapRunId, pid: process.pid, groupRunKey: `${bootstrapRunId}:${process.pid}`, runKey: `${bootstrapRunId}:${process.pid}` }
}

export const GROUP_MAILBOX_PROTOCOL_KIND = 'group_chat_message'

// The headless lead has a dedicated single-envelope consumer. Suppress its
// group rows from the generic mid-turn attachment reader in this exact run.
type HeadlessGroupMailboxOwner = { teamName: string; memberName: string; runKey: string }
let headlessGroupMailboxProcessor: HeadlessGroupMailboxOwner | undefined
let activeHeadlessGroupMailboxTurn: HeadlessGroupMailboxOwner | undefined

export function setHeadlessGroupMailboxProcessor(
  owner: HeadlessGroupMailboxOwner | undefined,
): void {
  headlessGroupMailboxProcessor = owner
}

export function hasHeadlessGroupMailboxProcessor(teamName?: string, memberName?: string): boolean {
  return !!headlessGroupMailboxProcessor &&
    headlessGroupMailboxProcessor.teamName === teamName &&
    headlessGroupMailboxProcessor.memberName === memberName &&
    headlessGroupMailboxProcessor.runKey === getCurrentGroupRunIdentity().groupRunKey
}

export function setActiveHeadlessGroupMailboxTurn(owner: HeadlessGroupMailboxOwner | undefined): void {
  activeHeadlessGroupMailboxTurn = owner
}

export function hasActiveHeadlessGroupMailboxTurn(teamName?: string, memberName?: string): boolean {
  const owner = activeHeadlessGroupMailboxTurn
  return !!owner && hasHeadlessGroupMailboxProcessor(owner.teamName, owner.memberName) &&
    owner.runKey === getCurrentGroupRunIdentity().groupRunKey &&
    (teamName === undefined || owner.teamName === teamName) &&
    (memberName === undefined || owner.memberName === memberName)
}

/** Exclude before query snapshots are consumed, so deferred commands remain queued. */
export function hasProcessingGroupMailboxTurn(
  messages: readonly (GroupMailboxEnvelope & { status?: string; messageId?: string })[],
): boolean {
  return messages.some(message => message.status === 'processing' &&
    hasGroupMailboxMarker(message) && isCurrentGroupMailboxMessage(message))
}

export function shouldDeferGroupMailboxCommand(
  command: Pick<QueuedCommand, 'agentId' | 'mode' | 'protocolKind'>,
  processingGroupTurn = false,
): boolean {
  if (command.agentId !== undefined) return false
  return command.protocolKind === GROUP_MAILBOX_PROTOCOL_KIND ||
    ((processingGroupTurn || hasActiveHeadlessGroupMailboxTurn()) &&
      command.mode === 'prompt')
}

export function isCurrentGroupMailboxMessage(message: GroupMailboxEnvelope & { messageId?: string }, runKey = getCurrentGroupRunIdentity().groupRunKey): boolean {
  if (!hasGroupMailboxMarker(message)) return true
  return message.groupChatProtocolVersion === 1 && !!message.groupChatId &&
    !!message.groupMessageId && !!message.messageId && message.messageId !== message.groupMessageId &&
    message.groupRunKey === runKey
}

export function isGroupToolName(name: string, tool: 'group_chat_list' | 'group_chat_send'): boolean {
  return name === tool || ['agent-teams_', 'agent_teams_', 'mcp__agent-teams__', 'mcp__agent_teams__'].some(prefix => name === `${prefix}${tool}`)
}

export function hasGroupChatTools(tools: readonly { name: string }[]): boolean {
  return ['group_chat_list', 'group_chat_send'].every(name => tools.some(tool => isGroupToolName(tool.name, name as 'group_chat_list' | 'group_chat_send')))
}

export function buildGroupMailboxPrompt(message: GroupMailboxEnvelope & {
  from: string; messageId?: string; text: string; timestamp: string
}, teamName?: string, memberName?: string, catalog?: unknown): string {
  return [
    catalog === undefined ? 'Fresh group catalog unavailable. Call group_chat_list before choosing a destination; do not assume an empty list.' : `Fresh group catalog: ${JSON.stringify(catalog)}`,
    'Process this queued GROUP CHAT message. Its destination is explicit; it is not a private message.',
    `Group ID: ${JSON.stringify(message.groupChatId)}. Group name: ${JSON.stringify(message.groupChatName ?? message.groupChatId)}.`,
    `Sender: ${JSON.stringify(message.from)}. Timestamp: ${JSON.stringify(message.timestamp)}.`,
    `Canonical message ID: ${JSON.stringify(message.groupMessageId)}. Physical inbound ID: ${JSON.stringify(message.messageId)}.`,
    `First call group_chat_list (or mcp__agent-teams__group_chat_list) with teamName=${JSON.stringify(teamName)}, from=${JSON.stringify(memberName)} for the fresh group catalog. An unavailable catalog does not mean no groups exist.`,
    `If a reply is needed, call group_chat_send (or mcp__agent-teams__group_chat_send) with ${JSON.stringify({ teamName, from: memberName, groupChatId: message.groupChatId, messageId: '<new UUID, reused only for retry of this exact post>', relayOfMessageId: message.messageId, text: '<reply>' })}.`,
    'Do not reply with SendMessage or message_send to user. They are private-message tools. Do not guess a last group or redirect a blocked group reply to a private chat.',
    'An archived, not-member, invalid-relay, or unavailable result is blocked: stop this reply attempt. Do not retry with another destination. A peer FYI needs no acknowledgement.',
    'You may proactively post in any active group you belong to after a fresh group_chat_list. A proactive post in another group does not reply to this inbound.',
    '<queued_mailbox_message>', message.text, '</queued_mailbox_message>',
  ].join('\n')
}

/** Only a completed tool for this exact group + physical inbound proves a reply. */
export function findGroupMailboxReplyOutcome(input: {
  messages: AppState['messages']; submitUserMessageUuid: string; teamName?: string;
  groupChatId: string; physicalMessageId: string; memberName?: string
}): 'sent' | 'blocked' | 'pending' | 'none' {
  const start = input.messages.findIndex(message => message.type === 'user' && message.uuid === input.submitUserMessageUuid)
  if (start < 0) return 'none'
  const matching = new Map<string, string>()
  for (const message of input.messages.slice(start + 1)) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type !== 'tool_use' || !isGroupToolName(block.name, 'group_chat_send')) continue
        const args = block.input as Record<string, unknown> | null
        if (args && typeof args.messageId === 'string' && args.groupChatId === input.groupChatId && args.relayOfMessageId === input.physicalMessageId && args.teamName === input.teamName && (!input.memberName || args.from === input.memberName)) matching.set(block.id, args.messageId)
      }
    } else if (message.type === 'user') {
      if (!Array.isArray(message.message.content)) break
      let sawToolResult = false
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue
        sawToolResult = true
        if (!matching.has(block.tool_use_id)) continue
        // Structured errors are terminal; no private fallback or speculative repair.
        if (block.is_error === true) return 'blocked'
        const texts = typeof block.content === 'string' ? [block.content] :
          Array.isArray(block.content) ? block.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []
        for (const text of texts) {
          try {
            const result = JSON.parse(text)
            if (result.saved === true && result.groupChatId === input.groupChatId &&
                result.relayOfMessageId === input.physicalMessageId &&
                (result.groupMessageId ?? result.messageId) === matching.get(block.tool_use_id)) return 'sent'
          } catch { /* Unverifiable acknowledgement must not cause another visible post. */ }
        }
        return 'blocked' 
      }
      if (!sawToolResult) break
    }
  }
  return matching.size > 0 ? 'pending' : 'none'
}

export function hasConflictingGroupReplyScope(input: {
  messages: AppState['messages']; submitUserMessageUuid: string; groupChatId: string; physicalMessageId: string; teamName?: string; memberName?: string
}): boolean {
  const start = input.messages.findIndex(message => message.type === 'user' && message.uuid === input.submitUserMessageUuid)
  for (const message of input.messages.slice(start + 1)) {
    if (message.type === 'user' && !Array.isArray(message.message.content)) break
    if (message.type !== 'assistant') continue
    for (const block of message.message.content) {
      if (block.type !== 'tool_use') continue
      if (isGroupToolName(block.name, 'group_chat_send')) {
        const args = block.input as Record<string, unknown> | null
        if (args?.groupChatId !== input.groupChatId || args?.relayOfMessageId !== input.physicalMessageId ||
            typeof args?.messageId !== 'string' || args?.teamName !== input.teamName ||
            (input.memberName && args?.from !== input.memberName)) return true
      } else if (block.name === 'SendMessage' || /(?:^|__)message_send$/.test(block.name) || block.name === 'agent-teams_message_send' || block.name === 'agent_teams_message_send') return true
    }
  }
  return false
}
