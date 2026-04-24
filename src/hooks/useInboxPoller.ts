import { randomUUID } from 'crypto'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useInterval } from 'usehooks-ts'
import { getSessionId } from '../bootstrap/state.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { sendNotification } from '../services/notifier.js'
export { isBootstrapMailboxInstructionText } from '../services/teamBootstrap/teamBootstrapMemberBriefingGuard.js'
import { isBootstrapMailboxInstructionText } from '../services/teamBootstrap/teamBootstrapMemberBriefingGuard.js'
import {
  type AppState,
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/AppState.js'
import { findToolByName } from '../Tool.js'
import type { Tool } from '../Tool.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { assembleToolPool, getAllBaseTools } from '../tools.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { isDeferredTool } from '../tools/ToolSearchTool/prompt.js'
import type { PermissionUpdate } from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import {
  findInProcessTeammateTaskId,
  handlePlanApprovalResponse,
} from '../utils/inProcessTeammateHelpers.js'
import { createAssistantMessage } from '../utils/messages.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import { applyPermissionUpdate } from '../utils/permissions/PermissionUpdate.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isToolSearchEnabledOptimistic } from '../utils/toolSearch.js'
import { isInsideTmux } from '../utils/swarm/backends/detection.js'
import {
  ensureBackendsRegistered,
  getBackendByType,
} from '../utils/swarm/backends/registry.js'
import type { PaneBackendType } from '../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { getLeaderToolUseConfirmQueue } from '../utils/swarm/leaderPermissionBridge.js'
import { sendPermissionResponseViaMailbox } from '../utils/swarm/permissionSync.js'
import {
  removeTeammateFromTeamFile,
  setMemberMode,
} from '../utils/swarm/teamHelpers.js'
import { unassignTeammateTasks } from '../utils/tasks.js'
import {
  getAgentName,
  getTeammateColor,
  isPlanModeRequired,
  isTeamLead,
  isTeammate,
} from '../utils/teammate.js'
import { isInProcessTeammate } from '../utils/teammateContext.js'
import {
  finalizeClaimedMessagesAsRead,
  isModeSetRequest,
  isPermissionRequest,
  isPermissionResponse,
  isPlanApprovalRequest,
  isPlanApprovalResponse,
  isLiveInboxMirrorMessageOwnedBySession,
  isRegularInteractiveMailboxMessage,
  isSilentRegularMailboxMessageForLiveContext,
  isSandboxPermissionRequest,
  isSandboxPermissionResponse,
  isShutdownApproved,
  isShutdownRequest,
  isTeamPermissionUpdate,
  markMessagesAsReadByIds,
  readAndClaimInteractiveMailboxSnapshot,
  type TeammateMessage,
  writeToMailbox,
} from '../utils/teammateMailbox.js'
import {
  hasPermissionCallback,
  hasSandboxPermissionCallback,
  processMailboxPermissionResponse,
  processSandboxPermissionResponse,
} from './useSwarmPermissionPoller.js'

/**
 * Get the agent name to poll for messages.
 * - In-process teammates return undefined (they use waitForNextPromptOrShutdown instead)
 * - Process-based teammates use their CLAUDE_CODE_AGENT_NAME
 * - Team leads use their name from teamContext.teammates
 * - Standalone sessions return undefined
 */
function getAgentNameToPoll(appState: AppState): string | undefined {
  // In-process teammates should NOT use useInboxPoller - they have their own
  // polling mechanism via waitForNextPromptOrShutdown() in inProcessRunner.ts.
  // Using useInboxPoller would cause message routing issues since in-process
  // teammates share the same React context and AppState with the leader.
  //
  // Note: This can be called when the leader's REPL re-renders while an
  // in-process teammate's AsyncLocalStorage context is active (due to shared
  // setAppState). We return undefined to gracefully skip polling rather than
  // throwing, since this is a normal occurrence during concurrent execution.
  if (isInProcessTeammate()) {
    return undefined
  }
  if (isTeammate()) {
    return getAgentName()
  }
  // Team lead polls using their agent name (not ID)
  if (isTeamLead(appState.teamContext)) {
    const leadAgentId = appState.teamContext!.leadAgentId
    // Look up the lead's name from teammates map
    const leadName = appState.teamContext!.teammates[leadAgentId]?.name
    return leadName || 'team-lead'
  }
  return undefined
}

const INBOX_POLL_INTERVAL_MS = 1000
const BOOTSTRAP_RETRY_COOLDOWN_MS = 5000
const ORDINARY_DIRECT_MESSAGE_RETRY_COOLDOWN_MS = 5000
const ORDINARY_DIRECT_MESSAGE_MAX_AUTO_RECOVERY_ATTEMPTS = 1
const BOOTSTRAP_MEMBER_BRIEFING_READINESS_GRACE_MS = 15000
// Native mailbox poller only. OpenCode runtime delivery is direct bridge prompt
// relay and must not reuse SendMessage-based mailbox prompts.
const MEMBER_BRIEFING_TOOL_NAME = 'member_briefing'
const PREFIXED_MEMBER_BRIEFING_TOOL_NAME = 'mcp__agent-teams__member_briefing'
const CODEX_NATIVE_EXEC_TIMEOUT_ERROR_TEXT = 'codex native exec timed out'

export function isMemberBriefingToolName(name: string): boolean {
  return (
    name === MEMBER_BRIEFING_TOOL_NAME ||
    name === PREFIXED_MEMBER_BRIEFING_TOOL_NAME
  )
}

export type InboxPromptSubmitResult = {
  accepted: boolean
  userMessageUuid?: string
}

type Props = {
  enabled: boolean
  isLoading: boolean
  focusedInputDialog: string | undefined
  getMessages: () => AppState['messages']
  transcriptActivitySignature: string
  // Returns true if submission succeeded, false if rejected (e.g., query already running)
  // Dead code elimination: parameter named onSubmitMessage to avoid "teammate" string in external builds
  onSubmitMessage: (
    formatted: string,
    options?: { isMeta?: boolean },
  ) => InboxPromptSubmitResult
}

type PendingInboxMirrorMessage = Pick<
  AppState['inbox']['messages'][number],
  | 'id'
  | 'messageId'
  | 'mailboxClaimedBySessionId'
  | 'from'
  | 'text'
  | 'timestamp'
  | 'status'
>

type QueuedMailboxPromptMessage = Pick<PendingInboxMirrorMessage, 'from' | 'text'>

const GENERIC_QUEUED_MAILBOX_META_PROMPT =
  'Process the queued teammate mailbox attachment for this turn.'

export function getQueuedMailboxMetaPrompt({
  pendingMessages,
  isTeammateSession,
}: {
  pendingMessages: readonly QueuedMailboxPromptMessage[]
  isTeammateSession: boolean
}): string {
  const hasBootstrapInstruction =
    isTeammateSession &&
    pendingMessages.some(
      message =>
        message.from === TEAM_LEAD_NAME &&
        isBootstrapMailboxInstructionText(message.text),
    )

  if (!hasBootstrapInstruction) {
    return GENERIC_QUEUED_MAILBOX_META_PROMPT
  }

  return [
    'Process the queued teammate mailbox attachment now.',
    'It contains your onboarding/bootstrap instructions from the team lead.',
    'Follow the attachment immediately.',
    'If it instructs member_briefing, call the MCP tool member_briefing on the agent-teams server now.',
    'Do not run a shell command named member_briefing.',
    'Do not ask for clarification if the attachment is present and readable.',
    'After bootstrap completes, continue with normal team mailbox and task behavior.',
  ].join(' ')
}

export function getBootstrapPendingMessage({
  pendingMessages,
  isTeammateSession,
}: {
  pendingMessages: readonly PendingInboxMirrorMessage[]
  isTeammateSession: boolean
}): PendingInboxMirrorMessage | undefined {
  if (!isTeammateSession) {
    return undefined
  }

  return pendingMessages.find(
    message =>
      message.from === TEAM_LEAD_NAME &&
      isBootstrapMailboxInstructionText(message.text),
  )
}

export function getOrdinaryPendingMessage({
  pendingMessages,
}: {
  pendingMessages: readonly PendingInboxMirrorMessage[]
}): PendingInboxMirrorMessage | undefined {
  return pendingMessages.find(
    message =>
      !!message.messageId &&
      isRegularInteractiveMailboxMessage({ text: message.text }) &&
      !(
        message.from === TEAM_LEAD_NAME &&
        isBootstrapMailboxInstructionText(message.text)
      ),
  )
}

export function shouldDeferPendingInboxDelivery(params: {
  isLoading: boolean
  focusedInputDialog: string | undefined
  isTeammateSession: boolean
  pendingMessages: readonly PendingInboxMirrorMessage[]
}): boolean {
  if (params.focusedInputDialog) {
    return true
  }

  if (!params.isLoading) {
    return false
  }

  const bootstrapPendingMessage = getBootstrapPendingMessage({
    pendingMessages: params.pendingMessages,
    isTeammateSession: params.isTeammateSession,
  })

  return bootstrapPendingMessage == null
}

export function getBootstrapInlineHandoffPrompt({
  bootstrapInstructionText,
  teamName,
  memberName,
}: {
  bootstrapInstructionText: string
  teamName?: string
  memberName?: string
}): string | null {
  if (!teamName || !memberName) {
    return null
  }

  return [
    `You are bootstrapping into team "${teamName}" as member "${memberName}".`,
    `Your first action is to call the MCP tool member_briefing on the agent-teams server with teamName="${teamName}" and memberName="${memberName}".`,
    'If tool search shows only the prefixed MCP name, use mcp__agent-teams__member_briefing.',
    'Call the MCP tool directly yourself. Do not run a shell command named member_briefing. Do not use Agent, any subagent, or a delegated helper for this bootstrap step.',
    'Do not explore files, inbox paths, or team config before the first member_briefing attempt.',
    'If member_briefing fails, send one short natural-language message to "team-lead" with the exact error text.',
    'Bootstrap instructions from team-lead:',
    '<bootstrap_instructions>',
    bootstrapInstructionText,
    '</bootstrap_instructions>',
  ].join('\n')
}

export function shouldSkipBootstrapReadinessWait(params: {
  bootstrapInstructionText: string
  teamName?: string
  memberName?: string
  toolCallableNow: boolean
}): boolean {
  if (params.toolCallableNow) {
    return true
  }

  return (
    getBootstrapInlineHandoffPrompt({
      bootstrapInstructionText: params.bootstrapInstructionText,
      teamName: params.teamName,
      memberName: params.memberName,
    }) !== null
  )
}

export function getOrdinaryInlineHandoffPrompt({
  from,
  text,
  timestamp,
}: {
  from: string
  text: string
  timestamp: string
}): string {
  return [
    'Process this queued mailbox message now.',
    `Sender: "${from}".`,
    `Timestamp: "${timestamp}".`,
    from.toLowerCase() === 'user'
      ? 'If this is a human direct message, reply via SendMessage with to="user", summary, and message. If SendMessage is unavailable or fails, write exactly the concise reply text as normal assistant text so the runtime can relay it.'
      : 'If this message requires a reply, use SendMessage to the sender.',
    '',
    '<queued_mailbox_message>',
    text,
    '</queued_mailbox_message>',
  ].join('\n')
}

export function extractTaskRefFromMailboxText(text: string): string | undefined {
  const taskIdMatch = text.match(
    /["']?\btaskId\b["']?\s*[:=]\s*["']?([a-zA-Z0-9][a-zA-Z0-9_-]{5,})["']?/,
  )
  if (taskIdMatch?.[1]) {
    return taskIdMatch[1]
  }

  const hashTaskMatch = text.match(/#([a-zA-Z0-9][a-zA-Z0-9_-]{5,})/)
  return hashTaskMatch?.[1]
}

function formatTaskRefForHuman(taskRef?: string): string {
  if (!taskRef) {
    return 'unknown task'
  }
  return taskRef.startsWith('#') ? taskRef : `#${taskRef}`
}

export function getOrdinaryRecoveryInlineHandoffPrompt({
  from,
  text,
  timestamp,
  failureDetail,
  taskRef,
}: {
  from: string
  text: string
  timestamp: string
  failureDetail: string
  taskRef?: string
}): string {
  return [
    'Process this queued mailbox message now.',
    'Recovery mode after a Codex native mailbox timeout.',
    `Sender: "${from}".`,
    `Timestamp: "${timestamp}".`,
    `Task reference: ${taskRef ? formatTaskRefForHuman(taskRef) : 'not found in mailbox text'}.`,
    `Previous turn failure: ${failureDetail}`,
    '',
    'Do not restart from scratch.',
    'First inspect the current task state, transcript, and working tree diff before doing more work.',
    'If the task is already started, leave a task comment saying you are recovering after a Codex native timeout before continuing.',
    'Complete only the missing work. If the current state is unclear, send a concise durable message to team-lead instead of guessing.',
    '',
    '<queued_mailbox_message>',
    text,
    '</queued_mailbox_message>',
  ].join('\n')
}

export function buildCodexNativeMailboxTimeoutLeadNotificationText({
  memberName,
  taskRef,
  detail,
  final,
}: {
  memberName: string
  taskRef?: string
  detail: string
  final: boolean
}): string {
  const taskText = taskRef
    ? ` for ${formatTaskRefForHuman(taskRef)}`
    : ''
  if (final) {
    return `${memberName} could not recover a Codex native mailbox turn${taskText} after timeout. Marking the mailbox row processed to avoid an infinite loop. Last error: ${detail}`
  }
  return `${memberName} hit a Codex native mailbox timeout${taskText}. Scheduling one recovery turn that will inspect state before continuing. Error: ${detail}`
}

type BootstrapAttemptOutcome = 'member_briefing' | 'team_lead_fallback' | 'none'
type OrdinaryAttemptOutcome = 'user_send_message' | 'none'
type OrdinaryDirectReplyFallback = {
  text: string
}
type OrdinaryAttemptExecutionError = {
  type: 'api_error' | 'codex_native_timeout'
  detail: string
}
type BootstrapToolDescriptor = Pick<
  Tool,
  'alwaysLoad' | 'isMcp' | 'name' | 'shouldDefer'
>
type BootstrapReadinessDecision =
  | { type: 'wait'; remainingMs: number }
  | { type: 'proceed' }

function findBootstrapMemberBriefingTool(
  tools: readonly BootstrapToolDescriptor[],
): BootstrapToolDescriptor | undefined {
  return tools.find(tool => isMemberBriefingToolName(tool.name))
}

export function isBootstrapMemberBriefingCallableNow({
  toolSearchEnabledOptimistic,
  tools,
}: {
  toolSearchEnabledOptimistic: boolean
  tools: readonly BootstrapToolDescriptor[]
}): boolean {
  const tool = findBootstrapMemberBriefingTool(tools)
  if (!tool) {
    return false
  }

  if (!toolSearchEnabledOptimistic) {
    return true
  }

  return !isDeferredTool(tool)
}

export function getBootstrapReadinessDecision({
  now,
  toolCallableNow,
  graceMs = BOOTSTRAP_MEMBER_BRIEFING_READINESS_GRACE_MS,
  waitStartedAt,
}: {
  now: number
  toolCallableNow: boolean
  graceMs?: number
  waitStartedAt?: number
}): BootstrapReadinessDecision {
  if (toolCallableNow) {
    return { type: 'proceed' }
  }

  const startedAt = waitStartedAt ?? now
  const elapsedMs = now - startedAt
  if (elapsedMs >= graceMs) {
    return { type: 'proceed' }
  }

  return {
    type: 'wait',
    remainingMs: Math.max(1, graceMs - elapsedMs),
  }
}

export function getBootstrapTranscriptActivitySignature(
  messages: AppState['messages'],
): string {
  const lastMessage = messages.at(-1)
  return `${messages.length}:${lastMessage?.uuid ?? ''}:${lastMessage?.type ?? ''}`
}

function isToolResultUserMessage(message: AppState['messages'][number]): boolean {
  return (
    message.type === 'user' &&
    Array.isArray(message.message.content) &&
    message.message.content.some(block => block.type === 'tool_result')
  )
}

function hasAttemptObservedPostSubmitActivity({
  messages,
  submitUserMessageUuid,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
}): boolean {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return false
  }

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        return true
      }
      break
    }

    return true
  }

  return false
}

export function findBootstrapAttemptOutcome({
  messages,
  submitUserMessageUuid,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
}): BootstrapAttemptOutcome {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return 'none'
  }

  const pendingMemberBriefingToolUseIds = new Set<string>()
  const pendingTeamLeadFallbackToolUseIds = new Set<string>()

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        for (const block of message.message.content) {
          if (
            block.type === 'tool_result' &&
            pendingMemberBriefingToolUseIds.has(block.tool_use_id) &&
            block.is_error !== true
          ) {
            return 'member_briefing'
          }
          if (
            block.type === 'tool_result' &&
            pendingTeamLeadFallbackToolUseIds.has(block.tool_use_id) &&
            block.is_error !== true
          ) {
            return 'team_lead_fallback'
          }
        }
        continue
      }
      break
    }

    if (message.type !== 'assistant') {
      continue
    }

    for (const block of message.message.content) {
      if (block.type !== 'tool_use') {
        continue
      }
      if (isMemberBriefingToolName(block.name)) {
        pendingMemberBriefingToolUseIds.add(block.id)
        continue
      }
      if (
        block.name === SEND_MESSAGE_TOOL_NAME &&
        typeof block.input === 'object' &&
        block.input !== null &&
        'to' in block.input &&
        typeof block.input.to === 'string' &&
        block.input.to.toLowerCase() === TEAM_LEAD_NAME.toLowerCase()
      ) {
        pendingTeamLeadFallbackToolUseIds.add(block.id)
      }
    }
  }

  return 'none'
}

export function findOrdinaryDirectReplyOutcome({
  messages,
  submitUserMessageUuid,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
}): OrdinaryAttemptOutcome {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return 'none'
  }

  const pendingUserReplyToolUseIds = new Set<string>()

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        for (const block of message.message.content) {
          if (
            block.type === 'tool_result' &&
            pendingUserReplyToolUseIds.has(block.tool_use_id) &&
            block.is_error !== true
          ) {
            return 'user_send_message'
          }
        }
        continue
      }
      break
    }

    if (message.type !== 'assistant') {
      continue
    }

    for (const block of message.message.content) {
      if (block.type !== 'tool_use') {
        continue
      }
      if (
        block.name === SEND_MESSAGE_TOOL_NAME &&
        typeof block.input === 'object' &&
        block.input !== null &&
        'to' in block.input &&
        typeof block.input.to === 'string' &&
        block.input.to.toLowerCase() === 'user'
      ) {
        pendingUserReplyToolUseIds.add(block.id)
      }
    }
  }

  return 'none'
}

function extractAssistantText(message: AppState['messages'][number]): string {
  if (message.type !== 'assistant') {
    return ''
  }

  return message.message.content
    .flatMap(block => {
      if (block.type !== 'text') {
        return []
      }
      return typeof block.text === 'string' ? [block.text.trim()] : []
    })
    .filter(Boolean)
    .join('\n\n')
}

function isCodexNativeExecTimeoutText(text: string): boolean {
  return text.toLowerCase().includes(CODEX_NATIVE_EXEC_TIMEOUT_ERROR_TEXT)
}

export function findOrdinaryAttemptExecutionError({
  messages,
  submitUserMessageUuid,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
}): OrdinaryAttemptExecutionError | null {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return null
  }

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        continue
      }
      break
    }

    if (message.type !== 'assistant') {
      continue
    }

    const text = extractAssistantText(message)
    const errorDetails =
      'errorDetails' in message && typeof message.errorDetails === 'string'
        ? message.errorDetails
        : undefined
    const detail = errorDetails || text

    if (detail && isCodexNativeExecTimeoutText(detail)) {
      return {
        type: 'codex_native_timeout',
        detail,
      }
    }

    if (detail && message.isApiErrorMessage === true) {
      return {
        type: 'api_error',
        detail,
      }
    }

    if (text && isCodexNativeExecTimeoutText(text)) {
      return {
        type: 'codex_native_timeout',
        detail: text,
      }
    }
  }

  return null
}

export function findOrdinaryDirectReplyFallback({
  messages,
  submitUserMessageUuid,
}: {
  messages: AppState['messages']
  submitUserMessageUuid: string
}): OrdinaryDirectReplyFallback | null {
  const startIndex = messages.findIndex(
    message => message.type === 'user' && message.uuid === submitUserMessageUuid,
  )
  if (startIndex === -1) {
    return null
  }

  const assistantTextParts: string[] = []
  let sawUserSendMessageAttempt = false

  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type === 'user') {
      if (isToolResultUserMessage(message)) {
        continue
      }
      break
    }

    if (message.type !== 'assistant') {
      continue
    }

    const text = extractAssistantText(message)
    if (text) {
      assistantTextParts.push(text)
    }

    for (const block of message.message.content) {
      if (
        block.type === 'tool_use' &&
        block.name === SEND_MESSAGE_TOOL_NAME &&
        typeof block.input === 'object' &&
        block.input !== null &&
        'to' in block.input &&
        typeof block.input.to === 'string' &&
        block.input.to.toLowerCase() === 'user'
      ) {
        sawUserSendMessageAttempt = true
      }
    }
  }

  if (sawUserSendMessageAttempt || assistantTextParts.length === 0) {
    return null
  }

  return { text: assistantTextParts.join('\n\n') }
}

function getInboxReplySummary(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) {
    return 'teammate reply'
  }
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact
}

type BootstrapAttemptState = {
  submitUserMessageUuid: string
  submittedAt: number
  cooldownUntil: number
  status: 'in_flight' | 'cooling_down'
  timer: ReturnType<typeof setTimeout> | null
}
type BootstrapReadinessWaitState = {
  startedAt: number
  timer: ReturnType<typeof setTimeout> | null
}
type OrdinaryAttemptState = {
  submitUserMessageUuid: string
  submittedAt: number
  cooldownUntil: number
  status: 'in_flight' | 'cooling_down'
  timer: ReturnType<typeof setTimeout> | null
}
type OrdinaryRecoveryState = {
  attemptCount: number
  failureDetail: string
  taskRef?: string
  notifiedLead: boolean
}

type BootstrapProcessingAction =
  | { type: 'noop' }
  | { type: 'reset_to_pending' }
  | { type: 'finalize' }
  | { type: 'schedule_cooldown' }
type OrdinaryProcessingAction =
  | { type: 'noop' }
  | { type: 'reset_to_pending' }
  | { type: 'finalize' }
  | { type: 'schedule_cooldown' }
  | {
      type: 'schedule_recovery'
      detail: string
      taskRef?: string
    }
  | {
      type: 'notify_failure'
      detail: string
      taskRef?: string
    }
  | { type: 'deliver_assistant_text'; text: string }

export function getBootstrapProcessingAction({
  attempt,
  messages,
  processingBootstrapMessage,
}: {
  attempt?: BootstrapAttemptState
  messages: AppState['messages']
  processingBootstrapMessage?: PendingInboxMirrorMessage
}): BootstrapProcessingAction {
  if (!processingBootstrapMessage?.messageId) {
    return { type: 'noop' }
  }

  if (!attempt) {
    return { type: 'reset_to_pending' }
  }

  const outcome = findBootstrapAttemptOutcome({
    messages,
    submitUserMessageUuid: attempt.submitUserMessageUuid,
  })

  if (outcome !== 'none') {
    return { type: 'finalize' }
  }

  if (attempt.status === 'in_flight') {
    // A newly submitted bootstrap row enters "processing" immediately after
    // handleIncomingPrompt() accepts it. Do not start the retry cooldown until
    // the submitted turn has produced some post-submit transcript activity,
    // otherwise we can race ahead of the first member_briefing response and
    // strand the row in processing.
    if (
      !hasAttemptObservedPostSubmitActivity({
        messages,
        submitUserMessageUuid: attempt.submitUserMessageUuid,
      })
    ) {
      return { type: 'noop' }
    }
    return { type: 'schedule_cooldown' }
  }

  return { type: 'noop' }
}

export function getOrdinaryProcessingAction({
  attempt,
  messages,
  processingOrdinaryMessage,
  recoveryAttemptCount = 0,
}: {
  attempt?: OrdinaryAttemptState
  messages: AppState['messages']
  processingOrdinaryMessage?: PendingInboxMirrorMessage
  recoveryAttemptCount?: number
}): OrdinaryProcessingAction {
  if (!processingOrdinaryMessage?.messageId) {
    return { type: 'noop' }
  }

  if (!attempt) {
    return { type: 'reset_to_pending' }
  }

  const outcome = findOrdinaryDirectReplyOutcome({
    messages,
    submitUserMessageUuid: attempt.submitUserMessageUuid,
  })
  const executionError = findOrdinaryAttemptExecutionError({
    messages,
    submitUserMessageUuid: attempt.submitUserMessageUuid,
  })
  const observedPostSubmitActivity = hasAttemptObservedPostSubmitActivity({
    messages,
    submitUserMessageUuid: attempt.submitUserMessageUuid,
  })
  const requiresUserReply =
    processingOrdinaryMessage.from.toLowerCase() === 'user'

  if (outcome === 'user_send_message') {
    return { type: 'finalize' }
  }

  if (attempt.status === 'in_flight' && executionError) {
    const taskRef = extractTaskRefFromMailboxText(processingOrdinaryMessage.text)
    if (
      executionError.type === 'codex_native_timeout' &&
      recoveryAttemptCount <
        ORDINARY_DIRECT_MESSAGE_MAX_AUTO_RECOVERY_ATTEMPTS
    ) {
      return {
        type: 'schedule_recovery',
        detail: executionError.detail,
        taskRef,
      }
    }
    if (
      executionError.type === 'codex_native_timeout' ||
      recoveryAttemptCount > 0
    ) {
      return {
        type: 'notify_failure',
        detail: executionError.detail,
        taskRef,
      }
    }
    return { type: 'schedule_cooldown' }
  }

  if (attempt.status === 'cooling_down' && executionError) {
    return { type: 'noop' }
  }

  if (!requiresUserReply && observedPostSubmitActivity) {
    return { type: 'finalize' }
  }

  if (requiresUserReply) {
    const fallback = findOrdinaryDirectReplyFallback({
      messages,
      submitUserMessageUuid: attempt.submitUserMessageUuid,
    })
    if (fallback) {
      return { type: 'deliver_assistant_text', text: fallback.text }
    }
  }

  if (attempt.status === 'in_flight') {
    // Accepted means the handoff prompt entered the REPL. It does not mean
    // the teammate replied through SendMessage, so wait for transcript activity
    // before retrying instead of marking the mailbox row as read immediately.
    if (!observedPostSubmitActivity) {
      return { type: 'noop' }
    }
    return { type: 'schedule_cooldown' }
  }

  return { type: 'noop' }
}

/**
 * Polls the teammate inbox for new messages and submits them as turns.
 *
 * This hook:
 * 1. Polls every 1s for unread messages (teammates or team leads)
 * 2. When idle: submits messages immediately as a new turn
 * 3. When busy: queues messages in AppState.inbox for UI display, delivers when turn ends
 */
export function useInboxPoller({
  enabled,
  isLoading,
  focusedInputDialog,
  getMessages,
  transcriptActivitySignature,
  onSubmitMessage,
}: Props): void {
  // Assign to original name for clarity within the function
  const onSubmitTeammateMessage = onSubmitMessage
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const inboxStateSignature = useAppState(s =>
    s.inbox.messages.map(message => `${message.id}:${message.status}`).join('|'),
  )
  const mcpToolSignature = useAppState(s =>
    s.mcp.tools
      .map(tool => `${tool.name}:${tool.alwaysLoad === true ? '1' : '0'}`)
      .sort()
      .join('|'),
  )
  const terminal = useTerminalNotification()
  const pollInFlightRef = useRef(false)
  const bootstrapAttemptsRef = useRef<Map<string, BootstrapAttemptState>>(
    new Map(),
  )
  const ordinaryAttemptsRef = useRef<Map<string, OrdinaryAttemptState>>(
    new Map(),
  )
  const ordinaryRecoveryRef = useRef<Map<string, OrdinaryRecoveryState>>(
    new Map(),
  )
  const ordinaryFinalizationInFlightRef = useRef<Set<string>>(new Set())
  const bootstrapReadinessWaitsRef = useRef<
    Map<string, BootstrapReadinessWaitState>
  >(new Map())
  const [bootstrapReadinessTick, setBootstrapReadinessTick] = useState(0)

  useEffect(() => {
    return () => {
      for (const attempt of bootstrapAttemptsRef.current.values()) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
      }
      bootstrapAttemptsRef.current.clear()
      for (const attempt of ordinaryAttemptsRef.current.values()) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
      }
      ordinaryAttemptsRef.current.clear()
      ordinaryRecoveryRef.current.clear()
      for (const waitState of bootstrapReadinessWaitsRef.current.values()) {
        if (waitState.timer) {
          clearTimeout(waitState.timer)
        }
      }
      bootstrapReadinessWaitsRef.current.clear()
      ordinaryFinalizationInFlightRef.current.clear()
    }
  }, [])

  const poll = useCallback(async () => {
    if (!enabled) return
    if (pollInFlightRef.current) return
    pollInFlightRef.current = true

    try {
      // Use ref to avoid dependency on appState object (prevents infinite loop)
      const currentAppState = store.getState()
      const agentName = getAgentNameToPoll(currentAppState)
      if (!agentName) return
      const teamName = currentAppState.teamContext?.teamName
      const sessionId = getSessionId()
      const staleMirroredMessageIds = new Set(
        currentAppState.inbox.messages
          .filter(
            message => !isLiveInboxMirrorMessageOwnedBySession(message, sessionId),
          )
          .map(message => message.id),
      )
      if (staleMirroredMessageIds.size > 0) {
        setAppState(prev => ({
          ...prev,
          inbox: {
            messages: prev.inbox.messages.filter(
              message => !staleMirroredMessageIds.has(message.id),
            ),
          },
        }))
      }

      const mirroredMessageIds = new Set(
        currentAppState.inbox.messages
          .filter(message =>
            isLiveInboxMirrorMessageOwnedBySession(message, sessionId),
          )
          .map(message => message.messageId)
          .filter((messageId): messageId is string => !!messageId),
      )
      const { regularClaimed: claimedRegularMessages, protocolUnread: unread } =
        await readAndClaimInteractiveMailboxSnapshot(
          agentName,
          sessionId,
          teamName,
          { excludeMessageIds: [...mirroredMessageIds] },
        )
      const silentlyFinalizedRegularMessages = claimedRegularMessages.filter(
        message => isSilentRegularMailboxMessageForLiveContext(message),
      )
      const actionableClaimedRegularMessages = claimedRegularMessages.filter(
        message => !isSilentRegularMailboxMessageForLiveContext(message),
      )

      if (silentlyFinalizedRegularMessages.length > 0) {
        await finalizeClaimedMessagesAsRead(
          agentName,
          silentlyFinalizedRegularMessages.map(message => message.messageId),
          sessionId,
          teamName,
        )
        logForDebugging(
          `[InboxPoller] Silently finalized ${silentlyFinalizedRegularMessages.length} informational regular message(s)`,
        )
      }

      if (unread.length === 0 && actionableClaimedRegularMessages.length === 0) {
        return
      }

      logForDebugging(
        `[InboxPoller] Found ${unread.length} protocol unread message(s), ${actionableClaimedRegularMessages.length} actionable claimed regular message(s), and ${silentlyFinalizedRegularMessages.length} silent regular message(s)`,
      )

      // Check for plan approval responses and transition out of plan mode if approved
      // Security: Only accept approval responses from the team lead
      if (isTeammate() && isPlanModeRequired()) {
        for (const msg of unread) {
          const approvalResponse = isPlanApprovalResponse(msg.text)
          // Verify the message is from the team lead to prevent teammates from forging approvals
          if (approvalResponse && msg.from === 'team-lead') {
            logForDebugging(
              `[InboxPoller] Received plan approval response from team-lead: approved=${approvalResponse.approved}`,
            )
            if (approvalResponse.approved) {
              // Use leader's permission mode if provided, otherwise default
              const targetMode = approvalResponse.permissionMode ?? 'default'

              // Transition out of plan mode
              setAppState(prev => ({
                ...prev,
                toolPermissionContext: applyPermissionUpdate(
                  prev.toolPermissionContext,
                  {
                    type: 'setMode',
                    mode: toExternalPermissionMode(targetMode),
                    destination: 'session',
                  },
                ),
              }))
              logForDebugging(
                `[InboxPoller] Plan approved by team lead, exited plan mode to ${targetMode}`,
              )
            } else {
              logForDebugging(
                `[InboxPoller] Plan rejected by team lead: ${approvalResponse.feedback || 'No feedback provided'}`,
              )
            }
          } else if (approvalResponse) {
            logForDebugging(
              `[InboxPoller] Ignoring plan approval response from non-team-lead: ${msg.from}`,
            )
          }
        }
      }

      // Separate permission messages from regular teammate messages
      const permissionRequests: TeammateMessage[] = []
      const permissionResponses: TeammateMessage[] = []
      const sandboxPermissionRequests: TeammateMessage[] = []
      const sandboxPermissionResponses: TeammateMessage[] = []
      const shutdownRequests: TeammateMessage[] = []
      const shutdownApprovals: TeammateMessage[] = []
      const teamPermissionUpdates: TeammateMessage[] = []
      const modeSetRequests: TeammateMessage[] = []
      const planApprovalRequests: TeammateMessage[] = []
      const protocolMessagesHandledInline: TeammateMessage[] = []
      const protocolMessagesForLiveContext: TeammateMessage[] = []

      for (const m of unread) {
        if (isRegularInteractiveMailboxMessage(m)) {
          continue
        }

        const permReq = isPermissionRequest(m.text)
        const permResp = isPermissionResponse(m.text)
        const sandboxReq = isSandboxPermissionRequest(m.text)
        const sandboxResp = isSandboxPermissionResponse(m.text)
        const shutdownReq = isShutdownRequest(m.text)
        const shutdownApproval = isShutdownApproved(m.text)
        const teamPermUpdate = isTeamPermissionUpdate(m.text)
        const modeSetReq = isModeSetRequest(m.text)
        const planApprovalReq = isPlanApprovalRequest(m.text)

        if (permReq) {
          permissionRequests.push(m)
        } else if (permResp) {
          permissionResponses.push(m)
        } else if (sandboxReq) {
          sandboxPermissionRequests.push(m)
        } else if (sandboxResp) {
          sandboxPermissionResponses.push(m)
        } else if (shutdownReq) {
          shutdownRequests.push(m)
        } else if (shutdownApproval) {
          shutdownApprovals.push(m)
        } else if (teamPermUpdate) {
          teamPermissionUpdates.push(m)
        } else if (modeSetReq) {
          modeSetRequests.push(m)
        } else if (planApprovalReq) {
          planApprovalRequests.push(m)
        }
      }

      // Handle permission requests (leader side) - route to ToolUseConfirmQueue
      if (
        permissionRequests.length > 0 &&
        isTeamLead(currentAppState.teamContext)
      ) {
        logForDebugging(
          `[InboxPoller] Found ${permissionRequests.length} permission request(s)`,
        )

        const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()

        for (const m of permissionRequests) {
          const parsed = isPermissionRequest(m.text)
          if (!parsed) continue

          if (setToolUseConfirmQueue) {
            const tool = findToolByName(getAllBaseTools(), parsed.tool_name)
            if (!tool) {
              logForDebugging(
                `[InboxPoller] Unknown tool ${parsed.tool_name}, skipping permission request`,
              )
              continue
            }

            const entry: ToolUseConfirm = {
              assistantMessage: createAssistantMessage({ content: '' }),
              tool,
              description: parsed.description,
              input: parsed.input,
              toolUseContext: {} as ToolUseConfirm['toolUseContext'],
              toolUseID: parsed.tool_use_id,
              permissionResult: {
                behavior: 'ask',
                message: parsed.description,
              },
              permissionPromptStartTimeMs: Date.now(),
              workerBadge: {
                name: parsed.agent_id,
                color: 'cyan',
              },
              onUserInteraction() {
                // No-op for tmux workers (no classifier auto-approval)
              },
              onAbort() {
                void sendPermissionResponseViaMailbox(
                  parsed.agent_id,
                  { decision: 'rejected', resolvedBy: 'leader' },
                  parsed.request_id,
                  teamName,
                )
              },
              onAllow(
                updatedInput: Record<string, unknown>,
                permissionUpdates: PermissionUpdate[],
              ) {
                void sendPermissionResponseViaMailbox(
                  parsed.agent_id,
                  {
                    decision: 'approved',
                    resolvedBy: 'leader',
                    updatedInput,
                    permissionUpdates,
                  },
                  parsed.request_id,
                  teamName,
                )
              },
              onReject(feedback?: string) {
                void sendPermissionResponseViaMailbox(
                  parsed.agent_id,
                  {
                    decision: 'rejected',
                    resolvedBy: 'leader',
                    feedback,
                  },
                  parsed.request_id,
                  teamName,
                )
              },
              async recheckPermission() {
                // No-op for tmux workers — permission state is on the worker side
              },
            }

            setToolUseConfirmQueue(queue => {
              if (queue.some(q => q.toolUseID === parsed.tool_use_id)) {
                return queue
              }
              return [...queue, entry]
            })
          } else {
            logForDebugging(
              `[InboxPoller] ToolUseConfirmQueue unavailable, dropping permission request from ${parsed.agent_id}`,
            )
          }
        }

        const firstParsed = isPermissionRequest(permissionRequests[0]?.text ?? '')
        if (firstParsed && !isLoading && !focusedInputDialog) {
          void sendNotification(
            {
              message: `${firstParsed.agent_id} needs permission for ${firstParsed.tool_name}`,
              notificationType: 'worker_permission_prompt',
            },
            terminal,
          )
        }
        protocolMessagesHandledInline.push(...permissionRequests)
      }

      if (permissionResponses.length > 0 && isTeammate()) {
        logForDebugging(
          `[InboxPoller] Found ${permissionResponses.length} permission response(s)`,
        )

        for (const m of permissionResponses) {
          const parsed = isPermissionResponse(m.text)
          if (!parsed) continue

          if (hasPermissionCallback(parsed.request_id)) {
            logForDebugging(
              `[InboxPoller] Processing permission response for ${parsed.request_id}: ${parsed.subtype}`,
            )

            if (parsed.subtype === 'success') {
              processMailboxPermissionResponse({
                requestId: parsed.request_id,
                decision: 'approved',
                updatedInput: parsed.response?.updated_input,
                permissionUpdates: parsed.response?.permission_updates,
              })
            } else {
              processMailboxPermissionResponse({
                requestId: parsed.request_id,
                decision: 'rejected',
                feedback: parsed.error,
              })
            }
          }
        }
        protocolMessagesHandledInline.push(...permissionResponses)
      }

      if (
        sandboxPermissionRequests.length > 0 &&
        isTeamLead(currentAppState.teamContext)
      ) {
        logForDebugging(
          `[InboxPoller] Found ${sandboxPermissionRequests.length} sandbox permission request(s)`,
        )

        const newSandboxRequests: Array<{
          requestId: string
          workerId: string
          workerName: string
          workerColor?: string
          host: string
          createdAt: number
        }> = []

        for (const m of sandboxPermissionRequests) {
          const parsed = isSandboxPermissionRequest(m.text)
          if (!parsed) continue

          if (!parsed.hostPattern?.host) {
            logForDebugging(
              `[InboxPoller] Invalid sandbox permission request: missing hostPattern.host`,
            )
            continue
          }

          newSandboxRequests.push({
            requestId: parsed.requestId,
            workerId: parsed.workerId,
            workerName: parsed.workerName,
            workerColor: parsed.workerColor,
            host: parsed.hostPattern.host,
            createdAt: parsed.createdAt,
          })
        }

        if (newSandboxRequests.length > 0) {
          setAppState(prev => ({
            ...prev,
            workerSandboxPermissions: {
              ...prev.workerSandboxPermissions,
              queue: [
                ...prev.workerSandboxPermissions.queue,
                ...newSandboxRequests,
              ],
            },
          }))

          const firstRequest = newSandboxRequests[0]
          if (firstRequest && !isLoading && !focusedInputDialog) {
            void sendNotification(
              {
                message: `${firstRequest.workerName} needs network access to ${firstRequest.host}`,
                notificationType: 'worker_permission_prompt',
              },
              terminal,
            )
          }
        }
        protocolMessagesHandledInline.push(...sandboxPermissionRequests)
      }

      if (sandboxPermissionResponses.length > 0 && isTeammate()) {
        logForDebugging(
          `[InboxPoller] Found ${sandboxPermissionResponses.length} sandbox permission response(s)`,
        )

        for (const m of sandboxPermissionResponses) {
          const parsed = isSandboxPermissionResponse(m.text)
          if (!parsed) continue

          if (hasSandboxPermissionCallback(parsed.requestId)) {
            logForDebugging(
              `[InboxPoller] Processing sandbox permission response for ${parsed.requestId}: allow=${parsed.allow}`,
            )

            processSandboxPermissionResponse({
              requestId: parsed.requestId,
              host: parsed.host,
              allow: parsed.allow,
            })

            setAppState(prev => ({
              ...prev,
              pendingSandboxRequest: null,
            }))
          }
        }
        protocolMessagesHandledInline.push(...sandboxPermissionResponses)
      }

      if (teamPermissionUpdates.length > 0 && isTeammate()) {
        logForDebugging(
          `[InboxPoller] Found ${teamPermissionUpdates.length} team permission update(s)`,
        )

        for (const m of teamPermissionUpdates) {
          const parsed = isTeamPermissionUpdate(m.text)
          if (!parsed) {
            logForDebugging(
              `[InboxPoller] Failed to parse team permission update: ${m.text.substring(0, 100)}`,
            )
            continue
          }
          if (
            !parsed.permissionUpdate?.rules ||
            !parsed.permissionUpdate?.behavior
          ) {
            logForDebugging(
              `[InboxPoller] Invalid team permission update: missing permissionUpdate.rules or permissionUpdate.behavior`,
            )
            continue
          }

          logForDebugging(
            `[InboxPoller] Applying team permission update: ${parsed.toolName} allowed in ${parsed.directoryPath}`,
          )
          logForDebugging(
            `[InboxPoller] Permission update rules: ${jsonStringify(parsed.permissionUpdate.rules)}`,
          )

          setAppState(prev => {
            const updated = applyPermissionUpdate(prev.toolPermissionContext, {
              type: 'addRules',
              rules: parsed.permissionUpdate.rules,
              behavior: parsed.permissionUpdate.behavior,
              destination: 'session',
            })
            logForDebugging(
              `[InboxPoller] Updated session allow rules: ${jsonStringify(updated.alwaysAllowRules.session)}`,
            )
            return {
              ...prev,
              toolPermissionContext: updated,
            }
          })
        }
        protocolMessagesHandledInline.push(...teamPermissionUpdates)
      }

      if (modeSetRequests.length > 0 && isTeammate()) {
        logForDebugging(
          `[InboxPoller] Found ${modeSetRequests.length} mode set request(s)`,
        )

        for (const m of modeSetRequests) {
          if (m.from !== 'team-lead') {
            logForDebugging(
              `[InboxPoller] Ignoring mode set request from non-team-lead: ${m.from}`,
            )
            continue
          }

          const parsed = isModeSetRequest(m.text)
          if (!parsed) {
            logForDebugging(
              `[InboxPoller] Failed to parse mode set request: ${m.text.substring(0, 100)}`,
            )
            continue
          }

          const targetMode = permissionModeFromString(parsed.mode)
          logForDebugging(
            `[InboxPoller] Applying mode change from team-lead: ${targetMode}`,
          )

          setAppState(prev => ({
            ...prev,
            toolPermissionContext: applyPermissionUpdate(
              prev.toolPermissionContext,
              {
                type: 'setMode',
                mode: toExternalPermissionMode(targetMode),
                destination: 'session',
              },
            ),
          }))

          const currentAgentName = getAgentName()
          if (teamName && currentAgentName) {
            await setMemberMode(teamName, currentAgentName, targetMode)
          }
        }
        protocolMessagesHandledInline.push(...modeSetRequests)
      }

      if (
        planApprovalRequests.length > 0 &&
        isTeamLead(currentAppState.teamContext)
      ) {
        logForDebugging(
          `[InboxPoller] Found ${planApprovalRequests.length} plan approval request(s), auto-approving`,
        )

        const leaderExternalMode = toExternalPermissionMode(
          currentAppState.toolPermissionContext.mode,
        )
        const modeToInherit =
          leaderExternalMode === 'plan' ? 'default' : leaderExternalMode

        for (const m of planApprovalRequests) {
          const parsed = isPlanApprovalRequest(m.text)
          if (!parsed) continue

          const approvalResponse = {
            type: 'plan_approval_response',
            requestId: parsed.requestId,
            approved: true,
            timestamp: new Date().toISOString(),
            permissionMode: modeToInherit,
          }

          void writeToMailbox(
            m.from,
            {
              from: TEAM_LEAD_NAME,
              text: jsonStringify(approvalResponse),
              timestamp: new Date().toISOString(),
            },
            teamName,
          )

          const taskId = findInProcessTeammateTaskId(m.from, currentAppState)
          if (taskId) {
            handlePlanApprovalResponse(
              taskId,
              {
                type: 'plan_approval_response',
                requestId: parsed.requestId,
                approved: true,
                timestamp: new Date().toISOString(),
                permissionMode: modeToInherit,
              },
              setAppState,
            )
          }

          logForDebugging(
            `[InboxPoller] Auto-approved plan from ${m.from} (request ${parsed.requestId})`,
          )
          protocolMessagesForLiveContext.push(m)
        }
      }

      if (shutdownRequests.length > 0 && isTeammate()) {
        logForDebugging(
          `[InboxPoller] Found ${shutdownRequests.length} shutdown request(s)`,
        )
        protocolMessagesForLiveContext.push(...shutdownRequests)
      }

      if (
        shutdownApprovals.length > 0 &&
        isTeamLead(currentAppState.teamContext)
      ) {
        logForDebugging(
          `[InboxPoller] Found ${shutdownApprovals.length} shutdown approval(s)`,
        )

        for (const m of shutdownApprovals) {
          const parsed = isShutdownApproved(m.text)
          if (!parsed) continue

          if (parsed.paneId && parsed.backendType) {
            void (async () => {
              try {
                await ensureBackendsRegistered()
                const insideTmux = await isInsideTmux()
                const backend = getBackendByType(
                  parsed.backendType as PaneBackendType,
                )
                const success = await backend?.killPane(
                  parsed.paneId!,
                  !insideTmux,
                )
                logForDebugging(
                  `[InboxPoller] Killed pane ${parsed.paneId} for ${parsed.from}: ${success}`,
                )
              } catch (error) {
                logForDebugging(
                  `[InboxPoller] Failed to kill pane for ${parsed.from}: ${error}`,
                )
              }
            })()
          }

          const teammateToRemove = parsed.from
          if (teammateToRemove && currentAppState.teamContext?.teammates) {
            const teammateId = Object.entries(
              currentAppState.teamContext.teammates,
            ).find(([, t]) => t.name === teammateToRemove)?.[0]

            if (teammateId) {
              if (teamName) {
                await removeTeammateFromTeamFile(teamName, {
                  agentId: teammateId,
                  name: teammateToRemove,
                })
              }

              const { notificationMessage } = teamName
                ? await unassignTeammateTasks(
                    teamName,
                    teammateId,
                    teammateToRemove,
                    'shutdown',
                  )
                : { notificationMessage: `${teammateToRemove} has shut down.` }

              setAppState(prev => {
                if (!prev.teamContext?.teammates) return prev
                if (!(teammateId in prev.teamContext.teammates)) return prev
                const { [teammateId]: _, ...remainingTeammates } =
                  prev.teamContext.teammates

                const updatedTasks = { ...prev.tasks }
                for (const [tid, task] of Object.entries(updatedTasks)) {
                  if (
                    isInProcessTeammateTask(task) &&
                    task.identity.agentId === teammateId
                  ) {
                    updatedTasks[tid] = {
                      ...task,
                      status: 'completed' as const,
                      endTime: Date.now(),
                    }
                  }
                }

                return {
                  ...prev,
                  tasks: updatedTasks,
                  teamContext: {
                    ...prev.teamContext,
                    teammates: remainingTeammates,
                  },
                  inbox: {
                    messages: [
                      ...prev.inbox.messages,
                      {
                        id: randomUUID(),
                        from: 'system',
                        text: jsonStringify({
                          type: 'teammate_terminated',
                          message: notificationMessage,
                        }),
                        timestamp: new Date().toISOString(),
                        status: 'pending' as const,
                      },
                    ],
                  },
                }
              })
              logForDebugging(
                `[InboxPoller] Removed ${teammateToRemove} (${teammateId}) from teamContext`,
              )
            }
          }

          protocolMessagesForLiveContext.push(m)
        }
      }

      const handledStructuredIds = protocolMessagesHandledInline.map(
        message => message.messageId,
      )
      if (handledStructuredIds.length > 0) {
        await markMessagesAsReadByIds(agentName, handledStructuredIds, teamName)
      }

      const enqueueMailboxMessages = (
        messages: readonly TeammateMessage[],
        options: { claimedBySessionId?: string } = {},
      ) => {
        if (messages.length === 0) {
          return
        }
        setAppState(prev => {
          const seenMessageIds = new Set(
            prev.inbox.messages
              .map(message => message.messageId)
              .filter((messageId): messageId is string => !!messageId),
          )
          const additions = messages
            .filter(message => !seenMessageIds.has(message.messageId))
            .map(message => ({
              id: randomUUID(),
              messageId: message.messageId,
              mailboxClaimedBySessionId: options.claimedBySessionId,
              from: message.from,
              text: message.text,
              timestamp: message.timestamp,
              status: 'pending' as const,
              color: message.color,
              summary: message.summary,
            }))
          if (additions.length === 0) {
            return prev
          }
          return {
            ...prev,
            inbox: {
              messages: [...prev.inbox.messages, ...additions],
            },
          }
        })
      }

      enqueueMailboxMessages(actionableClaimedRegularMessages, {
        claimedBySessionId: sessionId,
      })
      enqueueMailboxMessages(protocolMessagesForLiveContext)

      const protocolContextIds = protocolMessagesForLiveContext.map(
        message => message.messageId,
      )
      if (protocolContextIds.length > 0) {
        await markMessagesAsReadByIds(agentName, protocolContextIds, teamName)
      }
    } finally {
      pollInFlightRef.current = false
    }
  }, [
    enabled,
    setAppState,
    terminal,
    store,
  ])

  // When session becomes idle, deliver any pending messages and clean up processed ones
  useEffect(() => {
    if (!enabled) return

    // Use ref to avoid dependency on appState object (prevents infinite loop)
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) return
    const sessionId = getSessionId()
    const teamName = currentAppState.teamContext?.teamName
    const now = Date.now()

    const liveOwnedMessagesForGate = currentAppState.inbox.messages.filter(message =>
      isLiveInboxMirrorMessageOwnedBySession(message, sessionId),
    )

    if (
      shouldDeferPendingInboxDelivery({
        isLoading,
        focusedInputDialog,
        isTeammateSession: isTeammate(),
        pendingMessages: liveOwnedMessagesForGate,
      })
    ) {
      return
    }

    const staleMirroredMessageIds = new Set(
      currentAppState.inbox.messages
        .filter(
          message => !isLiveInboxMirrorMessageOwnedBySession(message, sessionId),
        )
        .map(message => message.id),
    )
    if (staleMirroredMessageIds.size > 0) {
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(
            message => !staleMirroredMessageIds.has(message.id),
          ),
        },
      }))
    }

    const liveOwnedMessages = liveOwnedMessagesForGate
    const activeBootstrapMessages = liveOwnedMessages.filter(
      message =>
        isBootstrapMailboxInstructionText(message.text) &&
        message.from === TEAM_LEAD_NAME,
    )
    const activeBootstrapMessageIds = new Set(
      activeBootstrapMessages
        .map(message => message.messageId)
        .filter((messageId): messageId is string => !!messageId),
    )
    const activeOrdinaryMessages = liveOwnedMessages.filter(
      message =>
        isRegularInteractiveMailboxMessage({ text: message.text }) &&
        !(
          message.from === TEAM_LEAD_NAME &&
          isBootstrapMailboxInstructionText(message.text)
        ),
    )
    const activeOrdinaryMessageIds = new Set(
      activeOrdinaryMessages
        .map(message => message.messageId)
        .filter((messageId): messageId is string => !!messageId),
    )
    const processingOrdinaryMessage = activeOrdinaryMessages.find(
      message => message.status === 'processing' && !!message.messageId,
    )

    for (const [messageId, attempt] of bootstrapAttemptsRef.current.entries()) {
      if (!activeBootstrapMessageIds.has(messageId)) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        bootstrapAttemptsRef.current.delete(messageId)
      }
    }
    for (const [messageId, attempt] of ordinaryAttemptsRef.current.entries()) {
      if (!activeOrdinaryMessageIds.has(messageId)) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        ordinaryAttemptsRef.current.delete(messageId)
      }
    }
    for (const messageId of ordinaryRecoveryRef.current.keys()) {
      if (!activeOrdinaryMessageIds.has(messageId)) {
        ordinaryRecoveryRef.current.delete(messageId)
      }
    }
    for (const [messageId, waitState] of bootstrapReadinessWaitsRef.current) {
      if (!activeBootstrapMessageIds.has(messageId)) {
        if (waitState.timer) {
          clearTimeout(waitState.timer)
        }
        bootstrapReadinessWaitsRef.current.delete(messageId)
      }
    }

    if (processingOrdinaryMessage?.messageId) {
      if (
        ordinaryFinalizationInFlightRef.current.has(
          processingOrdinaryMessage.messageId,
        )
      ) {
        return
      }

      const attempt = ordinaryAttemptsRef.current.get(
        processingOrdinaryMessage.messageId,
      )
      const processingAction = getOrdinaryProcessingAction({
        attempt,
        messages: getMessages(),
        processingOrdinaryMessage,
        recoveryAttemptCount:
          ordinaryRecoveryRef.current.get(processingOrdinaryMessage.messageId)
            ?.attemptCount ?? 0,
      })

      if (processingAction.type === 'schedule_recovery' && attempt) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }

        const existingRecovery = ordinaryRecoveryRef.current.get(
          processingOrdinaryMessage.messageId,
        )
        const recoveryState: OrdinaryRecoveryState = {
          attemptCount: (existingRecovery?.attemptCount ?? 0) + 1,
          failureDetail: processingAction.detail,
          taskRef: processingAction.taskRef,
          notifiedLead: existingRecovery?.notifiedLead ?? false,
        }
        ordinaryRecoveryRef.current.set(
          processingOrdinaryMessage.messageId,
          recoveryState,
        )

        const timer = setTimeout(() => {
          ordinaryAttemptsRef.current.delete(processingOrdinaryMessage.messageId!)
          setAppState(prev => ({
            ...prev,
            inbox: {
              messages: prev.inbox.messages.map(message =>
                message.messageId === processingOrdinaryMessage.messageId &&
                message.status === 'processing'
                  ? { ...message, status: 'pending' as const }
                  : message,
              ),
            },
          }))
        }, ORDINARY_DIRECT_MESSAGE_RETRY_COOLDOWN_MS)

        ordinaryAttemptsRef.current.set(processingOrdinaryMessage.messageId, {
          ...attempt,
          timer,
          cooldownUntil: now + ORDINARY_DIRECT_MESSAGE_RETRY_COOLDOWN_MS,
          status: 'cooling_down',
        })

        if (!recoveryState.notifiedLead && teamName) {
          ordinaryRecoveryRef.current.set(processingOrdinaryMessage.messageId, {
            ...recoveryState,
            notifiedLead: true,
          })
          void writeToMailbox(
            TEAM_LEAD_NAME,
            {
              from: agentName,
              text: buildCodexNativeMailboxTimeoutLeadNotificationText({
                memberName: agentName,
                taskRef: recoveryState.taskRef,
                detail: recoveryState.failureDetail,
                final: false,
              }),
              summary: 'Codex native mailbox timeout',
              timestamp: new Date().toISOString(),
              color: getTeammateColor(),
            },
            teamName,
          ).catch(error => {
            logForDebugging(
              `[InboxPoller] Failed to notify team-lead about Codex native timeout for ordinary mailbox row ${processingOrdinaryMessage.messageId}: ${String(error)}`,
            )
          })
        }
        return
      }

      if (processingAction.type === 'notify_failure' && attempt) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        ordinaryAttemptsRef.current.delete(processingOrdinaryMessage.messageId)
        ordinaryRecoveryRef.current.delete(processingOrdinaryMessage.messageId)
        ordinaryFinalizationInFlightRef.current.add(
          processingOrdinaryMessage.messageId,
        )

        void (async () => {
          try {
            if (teamName) {
              try {
                await writeToMailbox(
                  TEAM_LEAD_NAME,
                  {
                    from: agentName,
                    text: buildCodexNativeMailboxTimeoutLeadNotificationText({
                      memberName: agentName,
                      taskRef: processingAction.taskRef,
                      detail: processingAction.detail,
                      final: true,
                    }),
                    summary: 'Codex native mailbox recovery failed',
                    timestamp: new Date().toISOString(),
                    color: getTeammateColor(),
                  },
                  teamName,
                )
              } catch (error) {
                logForDebugging(
                  `[InboxPoller] Failed to notify team-lead about Codex native recovery failure for ordinary mailbox row ${processingOrdinaryMessage.messageId}: ${String(error)}`,
                )
              }
            }

            await finalizeClaimedMessagesAsRead(
              agentName,
              [processingOrdinaryMessage.messageId!],
              sessionId,
              teamName,
            )

            const processingRowId = processingOrdinaryMessage.id
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingRowId
                    ? { ...message, status: 'processed' as const }
                    : message,
                ),
              },
            }))
          } catch (error) {
            logForDebugging(
              `[InboxPoller] Failed to finalize ordinary mailbox row ${processingOrdinaryMessage.messageId} after Codex native recovery failure: ${String(error)}`,
            )
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingOrdinaryMessage.id &&
                  message.status === 'processing'
                    ? { ...message, status: 'processed' as const }
                    : message,
                ),
              },
            }))
          } finally {
            ordinaryFinalizationInFlightRef.current.delete(
              processingOrdinaryMessage.messageId!,
            )
          }
        })()
        return
      }

      if (processingAction.type === 'finalize' && attempt) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        ordinaryAttemptsRef.current.delete(processingOrdinaryMessage.messageId)
        ordinaryRecoveryRef.current.delete(processingOrdinaryMessage.messageId)

        ordinaryFinalizationInFlightRef.current.add(
          processingOrdinaryMessage.messageId,
        )

        void (async () => {
          try {
            await finalizeClaimedMessagesAsRead(
              agentName,
              [processingOrdinaryMessage.messageId!],
              sessionId,
              teamName,
            )

            const processingRowId = processingOrdinaryMessage.id
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingRowId
                    ? { ...message, status: 'processed' as const }
                    : message,
                ),
              },
            }))
          } catch (error) {
            logForDebugging(
              `[InboxPoller] Failed to finalize ordinary mailbox row ${processingOrdinaryMessage.messageId}: ${String(error)}`,
            )
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingOrdinaryMessage.id &&
                  message.status === 'processing'
                    ? { ...message, status: 'pending' as const }
                    : message,
                ),
              },
            }))
          } finally {
            ordinaryFinalizationInFlightRef.current.delete(
              processingOrdinaryMessage.messageId!,
            )
          }
        })()
        return
      }

      if (processingAction.type === 'deliver_assistant_text' && attempt) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        ordinaryAttemptsRef.current.delete(processingOrdinaryMessage.messageId)
        ordinaryRecoveryRef.current.delete(processingOrdinaryMessage.messageId)
        ordinaryFinalizationInFlightRef.current.add(
          processingOrdinaryMessage.messageId,
        )

        void (async () => {
          try {
            await writeToMailbox(
              'user',
              {
                from: agentName,
                text: processingAction.text,
                summary: getInboxReplySummary(processingAction.text),
                timestamp: new Date().toISOString(),
                color: getTeammateColor(),
              },
              teamName,
            )
            await finalizeClaimedMessagesAsRead(
              agentName,
              [processingOrdinaryMessage.messageId!],
              sessionId,
              teamName,
            )

            const processingRowId = processingOrdinaryMessage.id
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingRowId
                    ? { ...message, status: 'processed' as const }
                    : message,
                ),
              },
            }))
          } catch (error) {
            logForDebugging(
              `[InboxPoller] Failed to relay plain assistant text for ordinary mailbox row ${processingOrdinaryMessage.messageId}: ${String(error)}`,
            )
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingOrdinaryMessage.id &&
                  message.status === 'processing'
                    ? { ...message, status: 'pending' as const }
                    : message,
                ),
              },
            }))
          } finally {
            ordinaryFinalizationInFlightRef.current.delete(
              processingOrdinaryMessage.messageId!,
            )
          }
        })()
        return
      }

      if (processingAction.type === 'schedule_cooldown' && attempt) {
        const timer = setTimeout(() => {
          ordinaryAttemptsRef.current.delete(processingOrdinaryMessage.messageId!)
          setAppState(prev => ({
            ...prev,
            inbox: {
              messages: prev.inbox.messages.map(message =>
                message.messageId === processingOrdinaryMessage.messageId &&
                message.status === 'processing'
                  ? { ...message, status: 'pending' as const }
                  : message,
              ),
            },
          }))
        }, ORDINARY_DIRECT_MESSAGE_RETRY_COOLDOWN_MS)

        ordinaryAttemptsRef.current.set(processingOrdinaryMessage.messageId, {
          ...attempt,
          timer,
          cooldownUntil: now + ORDINARY_DIRECT_MESSAGE_RETRY_COOLDOWN_MS,
          status: 'cooling_down',
        })
        return
      }

      if (processingAction.type === 'reset_to_pending') {
        setAppState(prev => ({
          ...prev,
          inbox: {
            messages: prev.inbox.messages.map(message =>
              message.id === processingOrdinaryMessage.id
                ? { ...message, status: 'pending' as const }
                : message,
            ),
          },
        }))
        return
      }

      if (processingAction.type === 'noop') {
        return
      }
    }

    const processingBootstrapMessage = activeBootstrapMessages.find(
      message => message.status === 'processing' && !!message.messageId,
    )

    if (processingBootstrapMessage?.messageId) {
      const attempt = bootstrapAttemptsRef.current.get(
        processingBootstrapMessage.messageId,
      )
      const processingAction = getBootstrapProcessingAction({
        attempt,
        // Bootstrap outcome lives in the live REPL transcript. AppState.inbox
        // is store-backed, but the conversation transcript itself is local REPL
        // state, so use the current transcript getter here rather than a stale
        // store snapshot.
        messages: getMessages(),
        processingBootstrapMessage,
      })

      if (processingAction.type === 'finalize' && attempt) {
        if (attempt.timer) {
          clearTimeout(attempt.timer)
        }
        bootstrapAttemptsRef.current.delete(processingBootstrapMessage.messageId)

        void (async () => {
          try {
            await finalizeClaimedMessagesAsRead(
              agentName,
              [processingBootstrapMessage.messageId!],
              sessionId,
              teamName,
            )

            const processingRowId = processingBootstrapMessage.id
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingRowId
                    ? { ...message, status: 'processed' as const }
                    : message,
                ),
              },
            }))
          } catch (error) {
            logForDebugging(
              `[InboxPoller] Failed to finalize bootstrap row ${processingBootstrapMessage.messageId}: ${String(error)}`,
            )
            setAppState(prev => ({
              ...prev,
              inbox: {
                messages: prev.inbox.messages.map(message =>
                  message.id === processingBootstrapMessage.id &&
                  message.status === 'processing'
                    ? { ...message, status: 'pending' as const }
                    : message,
                ),
              },
            }))
          }
        })()
        return
      }

      if (processingAction.type === 'schedule_cooldown' && attempt) {
        // Leave the row in the existing "processing" state during cooldown so
        // the idle delivery path does not immediately resubmit the same
        // bootstrap prompt in a tight loop when the model fails to comply.
        const timer = setTimeout(() => {
          bootstrapAttemptsRef.current.delete(processingBootstrapMessage.messageId!)
          setAppState(prev => ({
            ...prev,
            inbox: {
              messages: prev.inbox.messages.map(message =>
                message.messageId === processingBootstrapMessage.messageId &&
                message.status === 'processing'
                  ? { ...message, status: 'pending' as const }
                  : message,
              ),
            },
          }))
        }, BOOTSTRAP_RETRY_COOLDOWN_MS)

        bootstrapAttemptsRef.current.set(processingBootstrapMessage.messageId, {
          ...attempt,
          timer,
          cooldownUntil: now + BOOTSTRAP_RETRY_COOLDOWN_MS,
          status: 'cooling_down',
        })
        return
      }

      if (processingAction.type === 'reset_to_pending') {
        setAppState(prev => ({
          ...prev,
          inbox: {
            messages: prev.inbox.messages.map(message =>
              message.id === processingBootstrapMessage.id
                ? { ...message, status: 'pending' as const }
                : message,
            ),
          },
        }))
        return
      }

      if (processingAction.type === 'noop') {
        return
      }
    }

    const pendingMessages = currentAppState.inbox.messages.filter(
      m =>
        m.status === 'pending' &&
        isLiveInboxMirrorMessageOwnedBySession(m, sessionId),
    )
    const processedMessages = currentAppState.inbox.messages.filter(
      m => m.status === 'processed',
    )

    // Clean up processed messages (they were already delivered mid-turn as attachments)
    if (processedMessages.length > 0) {
      logForDebugging(
        `[InboxPoller] Cleaning up ${processedMessages.length} processed message(s) that were delivered mid-turn`,
      )
      const processedIds = new Set(processedMessages.map(m => m.id))
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(m => !processedIds.has(m.id)),
        },
      }))
    }

    if (pendingMessages.length === 0) return

    const bootstrapPendingMessage = getBootstrapPendingMessage({
      pendingMessages,
      isTeammateSession: isTeammate(),
    })
    const ordinaryPendingMessage =
      bootstrapPendingMessage == null
        ? getOrdinaryPendingMessage({ pendingMessages })
        : undefined

    void (async () => {
      logForDebugging(
        `[InboxPoller] Session idle, delivering ${pendingMessages.length} pending message(s)`,
      )

      const bootstrapPrompt =
        bootstrapPendingMessage != null
          ? getBootstrapInlineHandoffPrompt({
              bootstrapInstructionText: bootstrapPendingMessage.text,
              memberName: currentAppState.teamContext?.selfAgentName,
              teamName: currentAppState.teamContext?.teamName,
            })
          : null

      if (bootstrapPendingMessage?.messageId) {
        const effectiveTools = assembleToolPool(
          currentAppState.toolPermissionContext,
          currentAppState.mcp.tools,
        )
        const memberBriefingCallableNow =
          isBootstrapMemberBriefingCallableNow({
            toolSearchEnabledOptimistic: isToolSearchEnabledOptimistic(),
            tools: effectiveTools,
          })
        const shouldBypassReadinessWait = shouldSkipBootstrapReadinessWait({
          bootstrapInstructionText: bootstrapPendingMessage.text,
          teamName: currentAppState.teamContext?.teamName,
          memberName: currentAppState.teamContext?.selfAgentName,
          toolCallableNow: memberBriefingCallableNow,
        })
        const readinessWait = bootstrapReadinessWaitsRef.current.get(
          bootstrapPendingMessage.messageId,
        )
        const readinessDecision = shouldBypassReadinessWait
          ? ({ type: 'proceed' } as const)
          : getBootstrapReadinessDecision({
              now,
              toolCallableNow: memberBriefingCallableNow,
              waitStartedAt: readinessWait?.startedAt,
            })

        if (readinessDecision.type === 'wait') {
          if (!readinessWait) {
            const timer = setTimeout(() => {
              setBootstrapReadinessTick(value => value + 1)
            }, readinessDecision.remainingMs)
            bootstrapReadinessWaitsRef.current.set(
              bootstrapPendingMessage.messageId,
              {
                startedAt: now,
                timer,
              },
            )
            logForDebugging(
              `[InboxPoller] Waiting up to ${BOOTSTRAP_MEMBER_BRIEFING_READINESS_GRACE_MS}ms for member_briefing to appear before first bootstrap turn`,
            )
          }
          return
        }

        if (readinessWait) {
          if (readinessWait.timer) {
            clearTimeout(readinessWait.timer)
          }
          bootstrapReadinessWaitsRef.current.delete(
            bootstrapPendingMessage.messageId,
          )
          if (!memberBriefingCallableNow && !shouldBypassReadinessWait) {
            logForDebugging(
              '[InboxPoller] member_briefing still not callable after bootstrap readiness grace period; falling back to current bootstrap handoff behavior',
            )
          }
        }
      }
      const ordinaryRecovery =
        ordinaryPendingMessage?.messageId != null
          ? ordinaryRecoveryRef.current.get(ordinaryPendingMessage.messageId)
          : undefined
      const ordinaryPrompt =
        ordinaryPendingMessage != null
          ? ordinaryRecovery != null
            ? getOrdinaryRecoveryInlineHandoffPrompt({
                from: ordinaryPendingMessage.from,
                text: ordinaryPendingMessage.text,
                timestamp: ordinaryPendingMessage.timestamp,
                failureDetail: ordinaryRecovery.failureDetail,
                taskRef: ordinaryRecovery.taskRef,
              })
            : getOrdinaryInlineHandoffPrompt({
                from: ordinaryPendingMessage.from,
                text: ordinaryPendingMessage.text,
                timestamp: ordinaryPendingMessage.timestamp,
              })
          : null
      // The bootstrap turn is submitted through handleIncomingPrompt(), which
      // bypasses processUserInput/getAttachmentMessages. Inline the claimed
      // bootstrap text here so teammate bootstrap never depends on hidden
      // teammate_mailbox attachment delivery.
      const prompt =
        bootstrapPrompt ??
        ordinaryPrompt ??
        getQueuedMailboxMetaPrompt({
          pendingMessages: bootstrapPendingMessage
            ? [bootstrapPendingMessage]
            : pendingMessages,
          isTeammateSession: isTeammate(),
        })

      const submitted = onSubmitTeammateMessage(prompt, { isMeta: true })
      if (!submitted.accepted) {
        logForDebugging(
          `[InboxPoller] Submission rejected, keeping messages queued`,
        )
        return
      }

      if (bootstrapPendingMessage?.messageId && submitted.userMessageUuid) {
        bootstrapAttemptsRef.current.set(bootstrapPendingMessage.messageId, {
          submitUserMessageUuid: submitted.userMessageUuid,
          submittedAt: Date.now(),
          cooldownUntil: 0,
          status: 'in_flight',
          timer: null,
        })

        const bootstrapRowId = bootstrapPendingMessage.id
        setAppState(prev => ({
          ...prev,
          inbox: {
            messages: prev.inbox.messages.map(message =>
              message.id === bootstrapRowId
                ? { ...message, status: 'processing' as const }
                : message,
            ),
          },
        }))
      } else if (ordinaryPendingMessage?.messageId) {
        if (!submitted.userMessageUuid) {
          logForDebugging(
            `[InboxPoller] Ordinary mailbox submission for ${ordinaryPendingMessage.messageId} was accepted without a transcript user message UUID; keeping row pending`,
          )
          return
        }

        ordinaryAttemptsRef.current.set(ordinaryPendingMessage.messageId, {
          submitUserMessageUuid: submitted.userMessageUuid,
          submittedAt: Date.now(),
          cooldownUntil: 0,
          status: 'in_flight',
          timer: null,
        })

        const ordinaryRowId = ordinaryPendingMessage.id
        setAppState(prev => ({
          ...prev,
          inbox: {
            messages: prev.inbox.messages.map(message =>
              message.id === ordinaryRowId
                ? { ...message, status: 'processing' as const }
                : message,
            ),
          },
        }))
      }
    })()
  }, [
    bootstrapReadinessTick,
    transcriptActivitySignature,
    mcpToolSignature,
    enabled,
    isLoading,
    focusedInputDialog,
    getMessages,
    onSubmitTeammateMessage,
    setAppState,
    inboxStateSignature,
    store,
  ])

  // Poll if running as a teammate or as a team lead
  const shouldPoll = enabled && !!getAgentNameToPoll(store.getState())
  useInterval(() => void poll(), shouldPoll ? INBOX_POLL_INTERVAL_MS : null)

  // Initial poll on mount (only once)
  const hasDoneInitialPollRef = useRef(false)
  useEffect(() => {
    if (!enabled) return
    if (hasDoneInitialPollRef.current) return
    // Use store.getState() to avoid dependency on appState object
    if (getAgentNameToPoll(store.getState())) {
      hasDoneInitialPollRef.current = true
      void poll()
    }
    // Note: poll uses store.getState() (not appState) so it won't re-run on appState changes
    // The ref guard is a safety measure to ensure initial poll only happens once
  }, [enabled, poll, store])
}
