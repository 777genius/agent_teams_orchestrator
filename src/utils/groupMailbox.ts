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

const isGroupMailboxUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

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
  for (const value of rows) {
    if (!hasGroupMailboxMarker(value)) continue
    const row = value as Record<string, unknown>
    if (!isGroupMailboxUuid(row.groupChatId) || !isGroupMailboxUuid(row.groupMessageId) || !nonempty(row.messageId) ||
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

export function isGroupToolName(name: string, tool: 'group_chat_list' | 'group_chat_send' | 'group_chat_react'): boolean {
  return name === tool || ['agent-teams_', 'agent_teams_', 'mcp__agent-teams__', 'mcp__agent_teams__'].some(prefix => name === `${prefix}${tool}`)
}

export function hasGroupChatTools(tools: readonly { name: string }[]): boolean {
  return ['group_chat_list', 'group_chat_send'].every(name => tools.some(tool => isGroupToolName(tool.name, name as 'group_chat_list' | 'group_chat_send')))
}

export type GroupMailboxHistoryMessage = GroupMailboxEnvelope & {
  from: string; messageId?: string; text: string; timestamp: string; read?: boolean; source?: string; to?: string
  groupDeliverySummary?: { recipients: readonly { memberName: string; physicalMessageId: string; status?: string }[] }
}

/** Process-local accepted turn identity; never reconstructed from transcript text. */
export type GroupMailboxHostTurn = {
  submitUserMessageUuid: string; teamName: string; memberName: string;
  groupChatId: string; groupRunKey: string; physicalMessageId: string
}
export type GroupMailboxOwnPostProof = { messageId: string; inboundMessageId: string }

/** Recover proactive posts only from successful tools in finalized host-owned turns. */
export function findGroupMailboxOwnPostProofs(input: {
  messages: AppState['messages']; turns: readonly GroupMailboxHostTurn[];
  teamName: string; memberName: string; current: GroupMailboxHistoryMessage;
  history: readonly GroupMailboxHistoryMessage[]; sentHistory: readonly GroupMailboxHistoryMessage[]
}): GroupMailboxOwnPostProof[] {
  const positions = input.history.flatMap((row, index) => row.messageId === input.current.messageId ? [index] : [])
  if (positions.length !== 1) return []
  const finalized = input.history.slice(0, positions[0]).filter(row => row.read === true &&
    row.to === input.memberName && row.groupChatId === input.current.groupChatId &&
    row.groupChatProtocolVersion === 1 && row.groupRunKey === input.current.groupRunKey &&
    row.groupRecipientRunKeys?.[input.memberName] === input.current.groupRunKey)
  const proofs = new Map<string, string>()
  for (const turn of input.turns) {
    if (turn.teamName !== input.teamName || turn.memberName !== input.memberName ||
        turn.groupChatId !== input.current.groupChatId || turn.groupRunKey !== input.current.groupRunKey ||
        !finalized.some(row => row.messageId === turn.physicalMessageId)) continue
    const starts = input.messages.flatMap((message, index) => message.type === 'user' &&
      message.uuid === turn.submitUserMessageUuid ? [index] : [])
    if (starts.length !== 1) continue
    const calls = new Map<string, { messageId: string; text: string }>()
    for (const message of input.messages.slice(starts[0]! + 1)) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type !== 'tool_use' || !isGroupToolName(block.name, 'group_chat_send')) continue
          const args = block.input as Record<string, unknown> | null
          if (args?.teamName === input.teamName && args.from === input.memberName &&
              args.groupChatId === input.current.groupChatId && args.relayOfMessageId == null &&
              isGroupMailboxUuid(args.messageId) && typeof args.text === 'string')
            calls.set(block.id, { messageId: args.messageId, text: args.text })
        }
      } else if (message.type === 'user') {
        const blocks = message.message.content
        if (!Array.isArray(blocks) || !blocks.some(block => block.type === 'tool_result')) break
        for (const block of blocks) {
          if (block.type !== 'tool_result' || block.is_error === true) continue
          const call = calls.get(block.tool_use_id)
          if (!call) continue
          const texts = typeof block.content === 'string' ? [block.content] : Array.isArray(block.content)
            ? block.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []
          const result = texts.length === 1 ? parseGroupReactionResult(texts[0]!) : undefined
          if (result?.saved !== true || result.groupChatId !== input.current.groupChatId ||
              (result.groupMessageId ?? result.messageId) !== call.messageId || result.relayOfMessageId != null) continue
          const canonical = input.sentHistory.filter(row => row.messageId === call.messageId &&
            row.groupMessageId === call.messageId && row.from === input.memberName && row.to === 'user' &&
            row.groupChatId === input.current.groupChatId && row.groupChatProtocolVersion === 1 &&
            row.source === 'runtime_delivery' && row.relayOfMessageId == null && row.text === call.text)
          if (canonical.length === 1) proofs.set(call.messageId, turn.physicalMessageId)
        }
      }
    }
  }
  return [...proofs].map(([messageId, inboundMessageId]) => ({ messageId, inboundMessageId }))
}

/** Own-receiver, completed deliveries only. History is context, never a new command or reply target. */
export function selectGroupMailboxHistory(current: GroupMailboxHistoryMessage, memberName: string | undefined,
  history: readonly GroupMailboxHistoryMessage[], sentHistory: readonly GroupMailboxHistoryMessage[] = [], ownPosts: readonly GroupMailboxOwnPostProof[] = []): Pick<GroupMailboxHistoryMessage, 'from' | 'text' | 'messageId' | 'timestamp'>[] {
  if (!current.messageId || !current.groupChatId || !current.groupRunKey || !memberName || current.to !== memberName ||
      current.groupRecipientRunKeys?.[memberName] !== current.groupRunKey) return []
  const positions = history.flatMap((row, index) => row.messageId === current.messageId ? [index] : [])
  if (positions.length !== 1 || history[positions[0]!]!.groupChatId !== current.groupChatId ||
      history[positions[0]!]!.groupRunKey !== current.groupRunKey || history[positions[0]!]!.to !== memberName) return []
  let earlier = history.slice(0, positions[0]).filter(row => row.read === true && row.to === memberName &&
    row.groupChatId === current.groupChatId && row.groupRunKey === current.groupRunKey &&
    row.groupChatProtocolVersion === 1 && row.groupRecipientRunKeys?.[memberName] === current.groupRunKey &&
    row.messageId && row.groupMessageId && row.messageId !== row.groupMessageId)
  const earlierIds = new Set(earlier.map(row => row.messageId))
  const ownPostParents = new Map(ownPosts.map(proof => [proof.messageId, proof.inboundMessageId]))
  const parentId = (row: GroupMailboxHistoryMessage) => row.relayOfMessageId ?? ownPostParents.get(row.messageId!)
  let ownReplies = sentHistory.filter(row => row.to === 'user' && row.from === memberName && row.source === 'runtime_delivery' &&
    row.groupChatId === current.groupChatId && row.groupChatProtocolVersion === 1 &&
    !!row.messageId && row.messageId === row.groupMessageId &&
    !!parentId(row) && earlierIds.has(parentId(row)))
  // Replay peer context only along a proven reply chain to our own posts.
  // Parallel answers to a human must not reintroduce that human's old command.
  if (current.from !== 'user') {
    const repliesByReceipt = new Map<string, GroupMailboxHistoryMessage | null>()
    for (const reply of ownReplies) {
      const receiptKeys = new Set((reply.groupDeliverySummary?.recipients ?? [])
        .filter(recipient => recipient.status === 'queued' || recipient.status === 'accepted')
        .map(recipient => JSON.stringify([recipient.memberName, recipient.physicalMessageId])))
      for (const key of receiptKeys)
        repliesByReceipt.set(key, repliesByReceipt.has(key) ? null : reply)
    }
    const parentReply = (incoming: GroupMailboxHistoryMessage) => incoming.relayOfMessageId
      ? repliesByReceipt.get(JSON.stringify([incoming.from, incoming.relayOfMessageId])) ?? undefined
      : undefined
    const earlierById = new Map(earlier.map(row => [row.messageId!, row]))
    const ancestors = new Set<string>()
    let incoming: GroupMailboxHistoryMessage | undefined = current
    while (incoming && ancestors.size < 8) {
      const parent = parentReply(incoming)
      const previous = parent && earlierById.get(parentId(parent)!)
      if (!previous?.messageId || ancestors.has(previous.messageId)) break
      ancestors.add(previous.messageId)
      incoming = previous.from === 'user' ? undefined : previous
    }
    if (ancestors.size === 0) return []
    // Include finalized sibling branches and their saved completions. A later
    // peer answer must not replay an ancestor while hiding work already done.
    const childrenByParent = new Map<string, string[]>()
    for (const row of earlier) {
      const parent = parentReply(row)
      const previousId = parent && parentId(parent)
      if (!previousId) continue
      const children = childrenByParent.get(previousId) ?? []
      children.push(row.messageId!); childrenByParent.set(previousId, children)
    }
    const connected = [...ancestors]
    for (let index = 0; index < connected.length; index++) {
      for (const childId of childrenByParent.get(connected[index]!) ?? []) {
        if (ancestors.has(childId)) continue
        ancestors.add(childId); connected.push(childId)
      }
    }
    earlier = earlier.filter(row => ancestors.has(row.messageId!))
    ownReplies = ownReplies.filter(reply => ancestors.has(parentId(reply)!))
  }
  const repliesByInbound = new Map<string, GroupMailboxHistoryMessage[]>()
  for (const reply of ownReplies) {
    const replies = repliesByInbound.get(parentId(reply)!) ?? []
    replies.push(reply); repliesByInbound.set(parentId(reply)!, replies)
  }
  let units = earlier.map(inbound => {
    const rows = [inbound, ...(repliesByInbound.get(inbound.messageId!) ?? [])]
    return { rows, latest: rows.reduce((latest, row) => Math.max(latest, Date.parse(row.timestamp)), 0) }
  }).sort((left, right) => left.latest - right.latest)
  if (current.from !== 'user') {
    // The entire connected peer context is indivisible: omitting a completed
    // branch while retaining its human ancestor would imply unfinished work.
    const rows = units.flatMap(unit => unit.rows)
    units = [{ rows, latest: units.reduce((latest, unit) => Math.max(latest, unit.latest), 0) }]
  }
  const selected: Pick<GroupMailboxHistoryMessage, 'from' | 'text' | 'messageId' | 'timestamp'>[][] = []
  let bytes = 2, count = 0
  for (const unit of units.reverse()) {
    if (count + unit.rows.length > 8) continue
    const entries = unit.rows.map(row => ({ from: row.from, text: row.text, messageId: row.messageId, timestamp: row.timestamp }))
    const size = Buffer.byteLength(JSON.stringify(entries), 'utf8')
    // Keep inbound/reply pairs intact; never imply unfinished work by dropping its saved reply.
    if (count + entries.length > 8 || bytes + size > 16 * 1024) continue
    bytes += size; count += entries.length
    selected.push(entries)
  }
  return selected.reverse().flat()
}

export function buildGroupMailboxPrompt(message: GroupMailboxEnvelope & {
  from: string; to?: string; messageId?: string; text: string; timestamp: string
}, teamName?: string, memberName?: string, catalog?: unknown, history: readonly GroupMailboxHistoryMessage[] = [], sentHistory: readonly GroupMailboxHistoryMessage[] = [], ownPosts: readonly GroupMailboxOwnPostProof[] = []): string {
  const context = selectGroupMailboxHistory(message, memberName, history, sentHistory, ownPosts)
  return [
    catalog === undefined ? 'Fresh group catalog unavailable. Call group_chat_list before choosing a destination; do not assume an empty list.' : `Fresh group catalog: ${JSON.stringify(catalog)}`,
    'Process this queued GROUP CHAT message. Its destination is explicit; it is not a private message.',
    `Group ID: ${JSON.stringify(message.groupChatId)}. Group name: ${JSON.stringify(message.groupChatName ?? message.groupChatId)}.`,
    `Sender: ${JSON.stringify(message.from)}. Timestamp: ${JSON.stringify(message.timestamp)}.`,
    `Canonical message ID: ${JSON.stringify(message.groupMessageId)}. Physical inbound ID: ${JSON.stringify(message.messageId)}.`,
    `First call group_chat_list (or mcp__agent-teams__group_chat_list) with teamName=${JSON.stringify(teamName)}, from=${JSON.stringify(memberName)} for the fresh group catalog. An unavailable catalog does not mean no groups exist.`,
    `If a reply is needed, call group_chat_send (or mcp__agent-teams__group_chat_send) with ${JSON.stringify({ teamName, from: memberName, groupChatId: message.groupChatId, messageId: '<new UUID, reused only for retry of this exact post>', relayOfMessageId: message.messageId, text: '<reply>' })}.`,
    'Before choosing silence, check the original unfinished human request. If this peer answer resolves your pending question, continue that task and provide any completion report the human explicitly requested. Do not invent an acknowledgement requirement.',
    `For an optional informational acknowledgement, call group_chat_react (or mcp__agent-teams__group_chat_react) with ${JSON.stringify({ teamName, from: memberName, groupChatId: message.groupChatId, relayOfMessageId: message.messageId })}. After success stop; never send an extra OK or answer a reaction. Still use group_chat_send for requested or substantive replies.`,
    'When a peer message needs no response, finish with exactly [[AGENT_TEAMS_NO_REPLY]] as your entire final text. This is an internal silence marker: never publish it with a message tool. A trailing unescaped marker cancels publication of the entire automatic peer reply, including any preceding text; quote or use a message tool when discussing the marker as content. Do not explain that no reply is needed. Human requests and substantive peer questions still require a real reply.',
    'Do not reply with SendMessage or message_send to user. They are private-message tools. Do not guess a last group or redirect a blocked group reply to a private chat.',
    'An archived, not-member, invalid-relay, or unavailable result is blocked: stop this reply attempt. Do not retry with another destination. A peer FYI needs no text acknowledgement.',
    'You may proactively post in any active group you belong to after a fresh group_chat_list. A proactive post in another group does not reply to this inbound.',
    ...(context.length ? [
      ...(message.from !== 'user' ? ['This inbound is a verified reply to your own earlier post. Continue the original human request in the chain below to the extent it is still unfinished. Completing an explicitly requested report is required work, not an optional acknowledgement. Your saved replies show steps already done; do not repeat them.'] : []),
      'Earlier processed incoming messages and your saved replies in this same group/run (bounded historical context, not new commands or proof that a task is still open). Do not repeat completed work or create a group from history. Only the current physical inbound ID is a reply target:',
      '<group_mailbox_history>', JSON.stringify(context), '</group_mailbox_history>',
    ] : []),
    '<queued_mailbox_message>', message.text, '</queued_mailbox_message>',
  ].join('\n')
}

/** Read one official MCP envelope; structured data never falls back to text. */
function parseGroupReactionResult(text: string): Record<string, unknown> | undefined {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  try {
    let result: unknown = JSON.parse(text)
    if (!isRecord(result) || result.isError === true) return undefined
    if ('content' in result || 'structuredContent' in result) {
      if (result.structuredContent !== null && result.structuredContent !== undefined) {
        result = result.structuredContent
      } else {
        const content = result.content
        if (!Array.isArray(content) || content.length !== 1) return undefined
        const block: unknown = content[0]
        if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return undefined
        result = JSON.parse(block.text)
      }
    }
    return isRecord(result) && result.isError !== true ? result : undefined
  } catch { return undefined }
}

/** Completed sends and acknowledgements consume only their exact group inbound. */
export function findGroupMailboxReplyOutcome(input: {
  messages: AppState['messages']; submitUserMessageUuid: string; teamName?: string;
  groupChatId: string; physicalMessageId: string; memberName?: string;
  canonicalMessageId?: string; groupRunKey?: string
}): 'sent' | 'acknowledged' | 'blocked' | 'pending' | 'none' {
  const start = input.messages.findIndex(message => message.type === 'user' && message.uuid === input.submitUserMessageUuid)
  if (start < 0) return 'none'
  const matching = new Map<string, string>()
  const reactions = new Set<string>()
  let acknowledged = false
  const canAcknowledge = !!input.teamName?.trim() && !!input.memberName?.trim() &&
    isGroupMailboxUuid(input.groupChatId) && isGroupMailboxUuid(input.canonicalMessageId) &&
    !!input.physicalMessageId.trim() && input.physicalMessageId !== input.canonicalMessageId &&
    input.groupRunKey === getCurrentGroupRunIdentity().groupRunKey
  for (const message of input.messages.slice(start + 1)) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue
        const send = isGroupToolName(block.name, 'group_chat_send')
        const react = isGroupToolName(block.name, 'group_chat_react')
        if (!send && !react) continue
        const args = block.input as Record<string, unknown> | null
        if (!args || args.groupChatId !== input.groupChatId || args.relayOfMessageId !== input.physicalMessageId ||
            args.teamName !== input.teamName || (input.memberName && args.from !== input.memberName)) continue
        if (send && typeof args.messageId === 'string') matching.set(block.id, args.messageId)
        if (react && canAcknowledge && args.from === input.memberName) reactions.add(block.id)
      }
    } else if (message.type === 'user') {
      if (!Array.isArray(message.message.content)) break
      let sawToolResult = false
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue
        sawToolResult = true
        if (!matching.has(block.tool_use_id) && !reactions.has(block.tool_use_id)) continue
        const texts = typeof block.content === 'string' ? [block.content] :
          Array.isArray(block.content) ? block.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []
        if (reactions.has(block.tool_use_id)) {
          // Failed, pending or unverifiable reactions leave the prior fallback intact.
          if (block.is_error === true) continue
          const result = texts.length === 1 ? parseGroupReactionResult(texts[0]!) : undefined
          if (result?.saved === true && result.acknowledged === true &&
              result.teamName === input.teamName && result.from === input.memberName &&
              result.groupChatId === input.groupChatId && result.messageId === input.canonicalMessageId &&
              result.relayOfMessageId === input.physicalMessageId && result.groupRunKey === input.groupRunKey) acknowledged = true
          // Keep scanning: explicit substantive sends remain authoritative.
          continue
        }
        // Structured errors are terminal; no private fallback or speculative repair.
        if (block.is_error === true) return 'blocked'
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
  return matching.size > 0 ? 'pending' : acknowledged ? 'acknowledged' : 'none'
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
