import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../types/message.js'
import { getAgentId, getAgentName, getTeamName } from '../../utils/teammate.js'
import {
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  isSyntheticMessage,
} from '../../utils/messages.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  BOARD_TASK_ACTIVITY_SCHEMA_VERSION,
  type BoardTaskActorContext,
  type BoardTaskLinkV1,
  type BoardTaskToolActionV1,
  type BoardTaskLocator,
  type TaskAwareMessage,
  type TaskAwareUserMessage,
} from './contract.js'
import { interpretBoardTaskToolCall } from './BoardTaskToolInterpreter.js'
import { getRuntimeBoardTaskExecutionStore } from './RuntimeBoardTaskExecutionStore.js'
import { isBoardTaskLinksWriteEnabled } from './featureGates.js'

function cloneActorContext(
  actorContext: BoardTaskActorContext,
): BoardTaskActorContext {
  return {
    relation: actorContext.relation,
    ...(actorContext.activeTask
      ? {
          activeTask: {
            ref: actorContext.activeTask.ref,
            refKind: actorContext.activeTask.refKind,
            ...(actorContext.activeTask.canonicalId
              ? { canonicalId: actorContext.activeTask.canonicalId }
              : {}),
          },
        }
      : {}),
    ...(actorContext.activePhase ? { activePhase: actorContext.activePhase } : {}),
    ...(actorContext.activeExecutionSeq
      ? { activeExecutionSeq: actorContext.activeExecutionSeq }
      : {}),
  }
}

function hasToolResultBlock(message: UserMessage): boolean {
  return (
    Array.isArray(message.message.content) &&
    message.message.content.some(block => block.type === 'tool_result')
  )
}

function hasErrorToolResultBlock(message: UserMessage): boolean {
  if (!Array.isArray(message.message.content)) {
    return false
  }

  return message.message.content.some(
    block => block.type === 'tool_result' && block.is_error === true,
  )
}

function isSyntheticToolResult(result: unknown): boolean {
  if (typeof result !== 'string') {
    return false
  }

  return (
    result === CANCEL_MESSAGE ||
    result === REJECT_MESSAGE ||
    result === 'User rejected tool use' ||
    result === 'Streaming fallback - tool execution discarded'
  )
}

function noteWriterDiagnostic(
  event: string,
  details: Record<string, string | number | boolean | undefined> = {},
): void {
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')

  logForDebugging(
    `[board_task_activity.${event}]${suffix ? ` ${suffix}` : ''}`,
    { level: 'debug' },
  )
}

function isEligibleAmbientAssistantMessage(message: AssistantMessage): boolean {
  if (message.isApiErrorMessage || isSyntheticMessage(message)) {
    return false
  }
  if (!Array.isArray(message.message.content)) {
    return false
  }

  let hasText = false
  for (const block of message.message.content) {
    if (block.type === 'tool_use') {
      return false
    }
    if (block.type === 'text' && block.text.trim()) {
      hasText = true
    }
  }
  return hasText
}

function isEligibleAmbientUserCarrierMessage(
  message: UserMessage,
): boolean {
  if (message.isMeta || message.isVisibleInTranscriptOnly || isSyntheticMessage(message)) {
    return false
  }
  return true
}

function isEligibleAmbientUserMessage(message: UserMessage): boolean {
  if (!isEligibleAmbientUserCarrierMessage(message)) {
    return false
  }
  return !hasToolResultBlock(message)
}

function isEligibleAmbientUserToolResultMessage(
  message: UserMessage,
): boolean {
  return isEligibleAmbientUserCarrierMessage(message) && hasToolResultBlock(message)
}

function extractSyntheticToolResultText(
  content: unknown,
): string | undefined {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (!Array.isArray(content)) {
    return undefined
  }

  const parts = content
    .filter(
      (
        block,
      ): block is {
        type: 'text'
        text: string
      } =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string',
    )
    .map(block => block.text.trim())
    .filter(Boolean)

  if (parts.length === 0) {
    return undefined
  }

  return parts.join('\n')
}

function isSyntheticAmbientToolResultBlock(
  block: Extract<UserMessage['message']['content'], unknown[]>[number],
): boolean {
  if (block.type !== 'tool_result' || block.is_error !== true) {
    return false
  }

  const syntheticText = extractSyntheticToolResultText(block.content)
  return syntheticText ? isSyntheticToolResult(syntheticText) : false
}

function resolveEffectiveBoardTaskAgentId(
  agentId?: string,
): string | undefined {
  return agentId ?? getAgentId()
}

function normalizeBoardTaskActor(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined
  }
  const normalized = String(value).trim()
  return normalized || undefined
}

function extractBoardTaskInputActor(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined
  }
  return normalizeBoardTaskActor((input as Record<string, unknown>).actor)
}

function currentActorCandidates(effectiveAgentId?: string): Set<string> {
  const candidates = new Set<string>()
  const push = (value: string | undefined) => {
    const normalized = value?.trim().toLowerCase()
    if (normalized) {
      candidates.add(normalized)
    }
  }

  push(effectiveAgentId)
  if (effectiveAgentId?.includes('@')) {
    push(effectiveAgentId.split('@')[0])
  }
  push(getAgentName())
  return candidates
}

function shouldApplyBoardTaskTransitions(args: {
  input: unknown
  effectiveAgentId?: string
}): boolean {
  const actor = extractBoardTaskInputActor(args.input)
  if (!actor) {
    return true
  }
  return currentActorCandidates(args.effectiveAgentId).has(actor.toLowerCase())
}

function isEligibleAmbientBoardTaskActor(
  agentId?: string,
): boolean {
  if (agentId) {
    return true
  }

  const teamName = getTeamName()
  const agentName = getAgentName()?.trim()
  if (!teamName || !agentName) {
    return false
  }

  return agentName !== TEAM_LEAD_NAME
}

function buildAmbientExecutionLink(args: {
  locator: BoardTaskLocator
  toolUseId?: string
}): BoardTaskLinkV1 {
  return {
    schemaVersion: BOARD_TASK_ACTIVITY_SCHEMA_VERSION,
    ...(args.toolUseId ? { toolUseId: args.toolUseId } : {}),
    task: args.locator,
    targetRole: 'subject',
    linkKind: 'execution',
    actorContext: { relation: 'same_task' },
  }
}

function buildAmbientExecutionToolResultLinks(args: {
  message: UserMessage
  locator: BoardTaskLocator
}): BoardTaskLinkV1[] {
  if (!Array.isArray(args.message.message.content)) {
    return []
  }

  const seenToolUseIds = new Set<string>()
  const links: BoardTaskLinkV1[] = []
  for (const block of args.message.message.content) {
    if (block.type !== 'tool_result') {
      continue
    }
    if (isSyntheticAmbientToolResultBlock(block)) {
      continue
    }
    if (typeof block.tool_use_id !== 'string' || block.tool_use_id.length === 0) {
      continue
    }
    if (seenToolUseIds.has(block.tool_use_id)) {
      continue
    }
    seenToolUseIds.add(block.tool_use_id)
    links.push(
      buildAmbientExecutionLink({
        locator: args.locator,
        toolUseId: block.tool_use_id,
      }),
    )
  }

  return links
}

function attachBoardTaskLinks(
  message: TaskAwareMessage,
  boardTaskLinks: BoardTaskLinkV1[],
): TaskAwareMessage {
  if (boardTaskLinks.length === 0) {
    return message
  }
  message.boardTaskLinks = boardTaskLinks
  return message
}

function attachBoardTaskToolActions(
  message: TaskAwareUserMessage,
  boardTaskToolActions: BoardTaskToolActionV1[],
): TaskAwareUserMessage {
  if (boardTaskToolActions.length === 0) {
    return message
  }
  message.boardTaskToolActions = boardTaskToolActions
  return message
}

export function annotateBoardTaskToolResultMessage(args: {
  message: UserMessage
  toolName: string
  input: unknown
  result: unknown
  toolUseId: string
  sessionId: string
  agentId?: string
}): TaskAwareUserMessage {
  const message = args.message as TaskAwareUserMessage
  const effectiveAgentId = resolveEffectiveBoardTaskAgentId(args.agentId)
  if (!isBoardTaskLinksWriteEnabled()) {
    return message
  }

  const hasToolResult = hasToolResultBlock(message)
  const hasErrorToolResult = hasErrorToolResultBlock(message)
  const interpretation = interpretBoardTaskToolCall({
    toolName: args.toolName,
    input: args.input,
    result: args.result,
  })
  if (!interpretation) {
    return message
  }

  if (!hasToolResult) {
    noteWriterDiagnostic('tool_result_unpaired', {
      tool: interpretation.canonicalToolName,
    })
    return message
  }

  if (hasErrorToolResult) {
    if (isSyntheticToolResult(args.result)) {
      noteWriterDiagnostic('synthetic_tool_result_skipped', {
        tool: interpretation.canonicalToolName,
      })
      return message
    }

    if (interpretation.links.some(link => link.linkKind === 'lifecycle')) {
      noteWriterDiagnostic('lifecycle_skipped_unsuccessful', {
        tool: interpretation.canonicalToolName,
      })
    }
    return message
  }

  const store = getRuntimeBoardTaskExecutionStore()
  if (store.hasProcessedToolUseId(args.sessionId, effectiveAgentId, args.toolUseId)) {
    return message
  }

  const boardTaskLinks: BoardTaskLinkV1[] = interpretation.links.map(link => ({
    schemaVersion: BOARD_TASK_ACTIVITY_SCHEMA_VERSION,
    toolUseId: args.toolUseId,
    task: link.task,
    targetRole: link.targetRole,
    linkKind: link.linkKind,
    ...(link.taskArgumentSlot ? { taskArgumentSlot: link.taskArgumentSlot } : {}),
    actorContext: cloneActorContext(
      store.getActorContextForTarget(args.sessionId, effectiveAgentId, link.task),
    ),
  }))

  const boardTaskToolActions: BoardTaskToolActionV1[] = interpretation.action
    ? [
        {
          schemaVersion: BOARD_TASK_ACTIVITY_SCHEMA_VERSION,
          toolUseId: args.toolUseId,
          canonicalToolName: interpretation.action.canonicalToolName,
          ...(interpretation.action.input
            ? { input: interpretation.action.input }
            : {}),
          ...(interpretation.action.resultRefs
            ? { resultRefs: interpretation.action.resultRefs }
            : {}),
        },
      ]
    : []

  attachBoardTaskLinks(message, boardTaskLinks)
  attachBoardTaskToolActions(message, boardTaskToolActions)

  noteWriterDiagnostic('tool_result_paired', {
    tool: interpretation.canonicalToolName,
    links: boardTaskLinks.length,
  })
  if (boardTaskLinks.some(link => link.linkKind === 'lifecycle')) {
    noteWriterDiagnostic('lifecycle_emitted', {
      tool: interpretation.canonicalToolName,
    })
  }

  const transitions = shouldApplyBoardTaskTransitions({
    input: args.input,
    effectiveAgentId,
  })
    ? interpretation.transitions
    : []
  store.applyTransitions(args.sessionId, effectiveAgentId, transitions)
  store.markProcessedToolUseId(args.sessionId, effectiveAgentId, args.toolUseId)
  return message
}

export function annotateAmbientBoardTaskExecutionMessage(args: {
  message: Message
  sessionId: string
  agentId?: string
}): TaskAwareMessage {
  const message = args.message as TaskAwareMessage
  const effectiveAgentId = resolveEffectiveBoardTaskAgentId(args.agentId)
  if (!isBoardTaskLinksWriteEnabled()) {
    return message
  }
  if (!isEligibleAmbientBoardTaskActor(effectiveAgentId)) {
    return message
  }
  if (message.boardTaskLinks?.length || message.boardTaskToolActions?.length) {
    return message
  }

  const isEligible =
    (message.type === 'assistant' && isEligibleAmbientAssistantMessage(message)) ||
    (message.type === 'user' &&
      (isEligibleAmbientUserMessage(message) ||
        isEligibleAmbientUserToolResultMessage(message)))
  if (!isEligible) {
    return message
  }

  const store = getRuntimeBoardTaskExecutionStore()
  const openScopeCount = store.getOpenScopeCount(args.sessionId, effectiveAgentId)
  if (openScopeCount > 1) {
    noteWriterDiagnostic('ambient_execution_skipped_ambiguous', {
      scopes: openScopeCount,
    })
    return message
  }

  const activeScope = store.getSingleActiveScope(args.sessionId, effectiveAgentId)
  if (!activeScope) {
    return message
  }

  if (message.type === 'user' && isEligibleAmbientUserToolResultMessage(message)) {
    const toolResultLinks = buildAmbientExecutionToolResultLinks({
      message,
      locator: activeScope.locator,
    })
    if (toolResultLinks.length > 0) {
      noteWriterDiagnostic('ambient_execution_tool_results_emitted', {
        phase: activeScope.phase,
        links: toolResultLinks.length,
      })
      return attachBoardTaskLinks(message, toolResultLinks)
    }
    return message
  }

  noteWriterDiagnostic('ambient_execution_emitted', {
    phase: activeScope.phase,
  })

  return attachBoardTaskLinks(message, [
    buildAmbientExecutionLink({
      locator: activeScope.locator,
    }),
  ])
}
