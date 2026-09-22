import { mcpInfoFromString } from '../mcp/mcpStringUtils.js'
import type {
  BoardTaskArgumentSlot,
  BoardTaskLinkKind,
  BoardTaskLocator,
  BoardTaskPhase,
  BoardTaskTargetRole,
  BoardTaskToolActionInput,
  BoardTaskToolActionResultRefs,
} from './contract.js'

const BOARD_TASK_SERVER_NAMES = new Set(['agent-teams', 'agent_teams'])

const LIFECYCLE_TOOL_NAMES = new Set([
  'task_complete',
  'task_set_status',
  'task_start',
  'review_approve',
  'review_request_changes',
  'review_start',
])

const BOARD_ACTION_TOOL_NAMES = new Set([
  'review_request',
  'task_add_comment',
  'task_attach_comment_file',
  'task_attach_file',
  'task_get',
  'task_get_comment',
  'task_link',
  'task_set_clarification',
  'task_set_owner',
  'task_unlink',
])

const IGNORED_TOOL_NAMES = new Set([
  'member_briefing',
  'task_briefing',
  'task_create',
  'task_create_from_message',
  'task_list',
])

type TaskIdentityHint = {
  id?: string
  displayId?: string
}

export type BoardTaskTransition = {
  type: 'open' | 'close'
  phase: BoardTaskPhase
  task: BoardTaskLocator
}

export type InterpretedBoardTaskLink = {
  task: BoardTaskLocator
  targetRole: BoardTaskTargetRole
  linkKind: BoardTaskLinkKind
  taskArgumentSlot?: BoardTaskArgumentSlot
}

export type InterpretedBoardTaskToolResult = {
  canonicalToolName: string
  links: InterpretedBoardTaskLink[]
  action?: {
    canonicalToolName: string
    input?: BoardTaskToolActionInput
    resultRefs?: BoardTaskToolActionResultRefs
  }
  transitions: BoardTaskTransition[]
}

function stripProxyPrefix(toolName: string): string {
  let normalized = toolName
  while (normalized.startsWith('proxy_')) {
    normalized = normalized.slice('proxy_'.length)
  }
  return normalized
}

function normalizeTaskRef(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined
  }
  const normalized = String(value).trim().replace(/^#/, '')
  return normalized || undefined
}

function looksLikeCanonicalTaskId(value: string | undefined): boolean {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  )
}

function pickString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    const normalized = normalizeTaskRef(value)
    if (normalized) {
      return normalized
    }
  }
  return undefined
}

function extractTaskIdentityHint(value: unknown): TaskIdentityHint | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const record = value as Record<string, unknown>

  if (record.task && typeof record.task === 'object') {
    const nested = extractTaskIdentityHint(record.task)
    if (nested?.id || nested?.displayId) {
      return nested
    }
  }

  const id = pickString(record, 'id', 'taskId')
  const displayId = pickString(record, 'displayId')
  if (!id && !displayId) {
    return undefined
  }
  return { id, displayId }
}

function buildLocator(
  rawTaskRef: unknown,
  identityHint?: TaskIdentityHint,
): BoardTaskLocator | null {
  const normalizedRef = normalizeTaskRef(rawTaskRef)
  const hintedCanonicalId =
    identityHint?.id && looksLikeCanonicalTaskId(identityHint.id)
      ? identityHint.id
      : undefined
  const hintedDisplayId = normalizeTaskRef(identityHint?.displayId)

  if (!normalizedRef) {
    if (hintedCanonicalId) {
      return {
        ref: hintedCanonicalId,
        refKind: 'canonical',
        canonicalId: hintedCanonicalId,
      }
    }
    if (hintedDisplayId) {
      return {
        ref: hintedDisplayId,
        refKind: 'display',
        ...(hintedCanonicalId ? { canonicalId: hintedCanonicalId } : {}),
      }
    }
    return null
  }

  if (hintedCanonicalId && normalizedRef === hintedCanonicalId) {
    return {
      ref: hintedCanonicalId,
      refKind: 'canonical',
      canonicalId: hintedCanonicalId,
    }
  }

  if (hintedDisplayId && normalizedRef === hintedDisplayId) {
    return {
      ref: hintedDisplayId,
      refKind: 'display',
      ...(hintedCanonicalId ? { canonicalId: hintedCanonicalId } : {}),
    }
  }

  if (looksLikeCanonicalTaskId(normalizedRef)) {
    return {
      ref: normalizedRef,
      refKind: 'canonical',
      canonicalId: normalizedRef,
    }
  }

  return {
    ref: normalizedRef,
    refKind: 'display',
    ...(hintedCanonicalId ? { canonicalId: hintedCanonicalId } : {}),
  }
}

function buildTargetLink(
  rawTaskRef: unknown,
  identityHint: TaskIdentityHint | undefined,
  targetRole: BoardTaskTargetRole,
  linkKind: BoardTaskLinkKind,
  taskArgumentSlot?: BoardTaskArgumentSlot,
): InterpretedBoardTaskLink | null {
  const task = buildLocator(rawTaskRef, identityHint)
  if (!task) {
    return null
  }
  return {
    task,
    targetRole,
    linkKind,
    ...(taskArgumentSlot ? { taskArgumentSlot } : {}),
  }
}

function normalizeRelationship(input: Record<string, unknown>): string | undefined {
  const relationship = pickString(input, 'relationship', 'linkType')
  if (
    relationship === 'blocked-by' ||
    relationship === 'blocks' ||
    relationship === 'related'
  ) {
    return relationship
  }
  return undefined
}

function normalizeStatus(
  value: unknown,
): 'pending' | 'in_progress' | 'completed' | 'deleted' | undefined {
  const status = normalizeTaskRef(value)
  if (
    status === 'pending' ||
    status === 'in_progress' ||
    status === 'completed' ||
    status === 'deleted'
  ) {
    return status
  }
  return undefined
}

function normalizeOwner(value: unknown): string | null | undefined {
  if (value == null) {
    return null
  }
  const owner = normalizeTaskRef(value)
  if (!owner) {
    return undefined
  }
  if (owner === 'clear' || owner === 'none') {
    return null
  }
  return owner
}

function normalizeClarification(
  value: unknown,
): 'lead' | 'user' | null | undefined {
  if (value == null) {
    return null
  }
  const normalized = normalizeTaskRef(value)
  if (!normalized) {
    return undefined
  }
  if (normalized === 'lead' || normalized === 'user') {
    return normalized
  }
  if (normalized === 'clear') {
    return null
  }
  return undefined
}

function buildActionInput(
  canonicalToolName: string,
  input: Record<string, unknown>,
): BoardTaskToolActionInput | undefined {
  const actionInput: BoardTaskToolActionInput = {}

  if (canonicalToolName === 'task_set_status') {
    const status = normalizeStatus(input.status)
    if (status) {
      actionInput.status = status
    }
  }

  if (canonicalToolName === 'task_set_owner') {
    const owner = normalizeOwner(input.owner)
    if (owner !== undefined) {
      actionInput.owner = owner
    }
  }

  if (canonicalToolName === 'task_set_clarification') {
    const clarification = normalizeClarification(
      input.clarification ?? input.value,
    )
    if (clarification !== undefined) {
      actionInput.clarification = clarification
    }
  }

  if (canonicalToolName === 'review_request') {
    const reviewer = pickString(input, 'reviewer')
    if (reviewer) {
      actionInput.reviewer = reviewer
    }
  }

  if (
    canonicalToolName === 'task_link' ||
    canonicalToolName === 'task_unlink'
  ) {
    const relationship = normalizeRelationship(input)
    if (relationship) {
      actionInput.relationship = relationship
    }
  }

  if (canonicalToolName === 'task_get_comment') {
    const commentId = pickString(input, 'commentId')
    if (commentId) {
      actionInput.commentId = commentId
    }
  }

  return Object.keys(actionInput).length > 0 ? actionInput : undefined
}

function buildActionResultRefs(
  canonicalToolName: string,
  result: unknown,
): BoardTaskToolActionResultRefs | undefined {
  if (!result || typeof result !== 'object') {
    return undefined
  }

  const record = result as Record<string, unknown>
  const resultRefs: BoardTaskToolActionResultRefs = {}

  if (canonicalToolName === 'task_add_comment') {
    const commentId = pickString(record, 'commentId')
    if (commentId) {
      resultRefs.commentId = commentId
    }
  }

  if (
    canonicalToolName === 'task_attach_file' ||
    canonicalToolName === 'task_attach_comment_file'
  ) {
    const attachmentId = pickString(record, 'id')
    if (attachmentId) {
      resultRefs.attachmentId = attachmentId
    }
    const filename =
      typeof record.filename === 'string' && record.filename.trim()
        ? record.filename.trim()
        : undefined
    if (filename) {
      resultRefs.filename = filename
    }
  }

  return Object.keys(resultRefs).length > 0 ? resultRefs : undefined
}

function buildLifecycleTransitions(
  canonicalToolName: string,
  primaryTask: BoardTaskLocator | null,
  input: Record<string, unknown>,
): BoardTaskTransition[] {
  if (!primaryTask) {
    return []
  }

  switch (canonicalToolName) {
    case 'task_start':
      return [{ type: 'open', phase: 'work', task: primaryTask }]
    case 'task_complete':
      return [{ type: 'close', phase: 'work', task: primaryTask }]
    case 'task_set_status': {
      const status = normalizeStatus(input.status)
      if (status === 'in_progress') {
        return [{ type: 'open', phase: 'work', task: primaryTask }]
      }
      if (status === 'deleted') {
        return [
          { type: 'close', phase: 'work', task: primaryTask },
          { type: 'close', phase: 'review', task: primaryTask },
        ]
      }
      if (status === 'completed' || status === 'pending') {
        return [{ type: 'close', phase: 'work', task: primaryTask }]
      }
      return []
    }
    case 'review_start':
      return [{ type: 'open', phase: 'review', task: primaryTask }]
    case 'review_approve':
    case 'review_request_changes':
      return [{ type: 'close', phase: 'review', task: primaryTask }]
    default:
      return []
  }
}

export function canonicalizeBoardTaskToolName(
  toolName: string,
): string | undefined {
  const normalizedToolName = stripProxyPrefix(toolName)
  const mcpInfo = mcpInfoFromString(normalizedToolName)

  if (mcpInfo) {
    if (!BOARD_TASK_SERVER_NAMES.has(mcpInfo.serverName) || !mcpInfo.toolName) {
      return undefined
    }
    return mcpInfo.toolName
  }

  return normalizedToolName
}

export function interpretBoardTaskToolCall(args: {
  toolName: string
  input: unknown
  result: unknown
}): InterpretedBoardTaskToolResult | null {
  const canonicalToolName = canonicalizeBoardTaskToolName(args.toolName)
  if (!canonicalToolName) {
    return null
  }

  if (IGNORED_TOOL_NAMES.has(canonicalToolName)) {
    return null
  }

  const isLifecycle = LIFECYCLE_TOOL_NAMES.has(canonicalToolName)
  const isBoardAction = BOARD_ACTION_TOOL_NAMES.has(canonicalToolName)
  if (!isLifecycle && !isBoardAction) {
    return null
  }

  const input =
    args.input && typeof args.input === 'object'
      ? (args.input as Record<string, unknown>)
      : {}
  const resultIdentity = extractTaskIdentityHint(args.result)

  const primaryTask = buildLocator(input.taskId, resultIdentity)
  const links: InterpretedBoardTaskLink[] = []
  const primaryLink = buildTargetLink(
    input.taskId,
    resultIdentity,
    'subject',
    isLifecycle ? 'lifecycle' : 'board_action',
    'taskId',
  )
  if (primaryLink) {
    links.push(primaryLink)
  }

  if (
    canonicalToolName === 'task_link' ||
    canonicalToolName === 'task_unlink'
  ) {
    const relatedLink = buildTargetLink(
      input.targetId,
      undefined,
      'related',
      'board_action',
      'targetId',
    )
    if (relatedLink) {
      links.push(relatedLink)
    }
  }

  if (links.length === 0) {
    return null
  }

  return {
    canonicalToolName,
    links,
    action: {
      canonicalToolName,
      ...(buildActionInput(canonicalToolName, input)
        ? { input: buildActionInput(canonicalToolName, input) }
        : {}),
      ...(buildActionResultRefs(canonicalToolName, args.result)
        ? { resultRefs: buildActionResultRefs(canonicalToolName, args.result) }
        : {}),
    },
    transitions: buildLifecycleTransitions(canonicalToolName, primaryTask, input),
  }
}
