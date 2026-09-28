import { createHash } from 'node:crypto'

import {
  OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT,
  type OpenCodeRuntimeMessageActionMode,
  type OpenCodeRuntimeMessageKind,
  type OpenCodeRuntimeMessageTaskRef,
} from '../opencode/OpenCodeRuntimeMessageText.js'

/** Desktop DEFAULT_INBOX_RELAY_BATCH_SIZE. */
export const OPEN_CODE_INBOX_RELAY_BATCH_SIZE = 10

const MESSAGE_KINDS: readonly OpenCodeRuntimeMessageKind[] = [
  'default', 'slash_command', 'slash_command_result', 'task_comment_notification',
  'task_stall_remediation', 'member_work_sync_nudge', 'runtime_recovery_nudge', 'agent_error',
]
const ACTION_MODES: readonly OpenCodeRuntimeMessageActionMode[] = ['do', 'ask', 'delegate']

/** One inbox row desktop's OpenCode member inbox relay would prompt, with its reply target. */
export type DeliverableInboxRow = Readonly<{
  sourceMessageId: string
  /** Trimmed sender; empty when the row has none. */
  from: string
  replyRecipient: string
  row: Readonly<Record<string, unknown>>
}>

/**
 * Owner copy of desktop's OpenCode member inbox relay selection
 * (agent-teams-ai TeamProvisioningOpenCodeMemberInboxRelay:
 * selectOpenCodeMemberInboxRelayUnreadMessages + resolveOpenCodeMemberInboxDeliveryDecision):
 * unread rows with a stable id and non-empty text, work-sync nudges and system
 * notifications first, then oldest first, at most one batch. The shared golden
 * docs/opencode-inbox-relay-selection-golden.json pins the equivalence; change
 * both repositories together. Hosted-only exclusions are applied by the caller.
 */
export function selectDeliverableInboxRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  recipient: string,
): DeliverableInboxRow[] {
  return rows
    .filter(row => row.read !== true && typeof row.text === 'string' && row.text.trim().length > 0 &&
      typeof row.messageId === 'string' && row.messageId.trim().length > 0)
    .sort(compareRelayRows)
    .slice(0, OPEN_CODE_INBOX_RELAY_BATCH_SIZE)
    .map(row => {
      const from = typeof row.from === 'string' ? row.from.trim() : ''
      return Object.freeze({
        sourceMessageId: row.messageId as string,
        from,
        replyRecipient: replyRecipientFor(recipient, from, row),
        row,
      })
    })
}

/** Prompt metadata carried from the row, validated for the runtime builder. */
export function relayPromptFields(row: Readonly<Record<string, unknown>>): {
  taskRefs?: OpenCodeRuntimeMessageTaskRef[]
  messageKind?: OpenCodeRuntimeMessageKind
  actionMode?: OpenCodeRuntimeMessageActionMode
} {
  const taskRefs = parseTaskRefs(row.taskRefs)
  return {
    ...(taskRefs.length ? { taskRefs } : {}),
    ...(MESSAGE_KINDS.includes(row.messageKind as OpenCodeRuntimeMessageKind)
      ? { messageKind: row.messageKind as OpenCodeRuntimeMessageKind } : {}),
    ...(ACTION_MODES.includes(row.actionMode as OpenCodeRuntimeMessageActionMode)
      ? { actionMode: row.actionMode as OpenCodeRuntimeMessageActionMode } : {}),
  }
}

/** The bridge accepts only `message_<32 hex>`; the id is stable per recipient row. */
export function hostedInboxRelayMessageId(teamId: string, recipient: string, sourceMessageId: string): string {
  return `message_${createHash('sha256')
    .update(`agent-teams.hosted-inbox-relay/v1\0${teamId}\0${recipient}\0${sourceMessageId}`)
    .digest('hex').slice(0, 32)}`
}

/** Desktop getOpenCodeInboxRelayPriority. */
function relayPriority(row: Readonly<Record<string, unknown>>): number {
  if (row.messageKind === 'member_work_sync_nudge') return 30
  return row.source === 'system_notification' ? 20 : 0
}

/** Desktop compareOpenCodeInboxRelayMessagesByPriority. */
function compareRelayRows(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): number {
  const priorityDelta = relayPriority(b) - relayPriority(a)
  if (priorityDelta !== 0) return priorityDelta
  const aTime = Date.parse(String(a.timestamp))
  const bTime = Date.parse(String(b.timestamp))
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
    if (aTime !== bTime) return aTime - bTime
  } else if (Number.isFinite(aTime)) {
    return -1
  } else if (Number.isFinite(bTime)) {
    return 1
  }
  return String(a.messageId).localeCompare(String(b.messageId))
}

/**
 * Desktop resolveOpenCodeMemberInboxDeliveryDecision without inferred task
 * references: app notices get the informational contract, an addressable sender
 * other than the recipient is the reply target, anything else answers the user.
 */
function replyRecipientFor(recipient: string, from: string, row: Readonly<Record<string, unknown>>): string {
  const unaddressable = !from || from.toLowerCase() === OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT
  const hasTaskRefs = Array.isArray(row.taskRefs) && row.taskRefs.length > 0
  if (row.source === 'system_notification' || (unaddressable && hasTaskRefs)) {
    return OPEN_CODE_INFORMATIONAL_NOTICE_REPLY_RECIPIENT
  }
  return !unaddressable && from.toLowerCase() !== recipient.trim().toLowerCase() ? from : 'user'
}

function parseTaskRefs(value: unknown): OpenCodeRuntimeMessageTaskRef[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return []
  const refs: OpenCodeRuntimeMessageTaskRef[] = []
  for (const candidate of value) {
    const ref = candidate as Record<string, unknown> | null
    if (!ref || typeof ref.taskId !== 'string' || typeof ref.displayId !== 'string' ||
      typeof ref.teamName !== 'string') return []
    refs.push({ taskId: ref.taskId, displayId: ref.displayId, teamName: ref.teamName })
  }
  return refs
}
