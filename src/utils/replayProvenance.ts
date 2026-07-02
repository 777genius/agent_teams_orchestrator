import {
  BASH_STDERR_TAG,
  BASH_STDOUT_TAG,
  CHANNEL_MESSAGE_TAG,
  CROSS_SESSION_MESSAGE_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../constants/xml.js'

type ReplayOrigin = {
  kind?: string
}

export type UserTurnProvenanceKind =
  | 'human'
  | 'synthetic-replay'
  | 'coordinator'
  | 'teammate-protocol'
  | 'task-notification'
  | 'channel'
  | 'cross-session'
  | 'tick'
  | 'tool-result'
  | 'local-command-output'

type UserTurnContentBlock = {
  type?: string
  text?: string
}

export type QueuedCommandReplayProvenance = {
  isMeta?: boolean
  commandMode?: string
  mode?: string
  origin?: ReplayOrigin
  protocolKind?: string
}

export type SDKUserReplayProvenance = {
  isSynthetic?: boolean
  isReplay?: boolean
  origin?: ReplayOrigin
  protocolKind?: string
  message?: {
    content?: unknown
  }
  tool_use_result?: unknown
}

export type SyntheticMessageProvenance = {
  isSynthetic?: boolean
}

export type UserTurnProvenanceInput = {
  type?: string
  isMeta?: boolean
  isSynthetic?: boolean
  isReplay?: boolean
  isCompactSummary?: boolean
  toolUseResult?: unknown
  tool_use_result?: unknown
  sourceToolUseID?: unknown
  origin?: ReplayOrigin
  protocolKind?: string
  commandMode?: string
  mode?: string
  message?: {
    content?: unknown
  }
  content?: unknown
  toolResults?: readonly unknown[]
}

export function hasNonHumanOrigin(
  origin: ReplayOrigin | undefined,
): boolean {
  return origin?.kind !== undefined && origin.kind !== 'human'
}

export function isSyntheticQueuedCommandReplay(
  command: QueuedCommandReplayProvenance,
): boolean {
  return classifyUserTurnProvenance(command) !== 'human'
}

export function classifyUserTurnProvenance(
  message: UserTurnProvenanceInput,
): UserTurnProvenanceKind {
  if (hasToolResultProvenance(message)) {
    return 'tool-result'
  }

  if (hasSystemOutputContent(getMessageContent(message))) {
    return 'local-command-output'
  }

  if (message.isCompactSummary === true) {
    return 'synthetic-replay'
  }

  const protocolKind = normalizeProtocolKind(message.protocolKind)
  if (protocolKind) {
    return protocolKind
  }

  const originKind = normalizeOriginKind(message.origin)
  if (originKind) {
    return originKind
  }

  if (
    message.commandMode === 'task-notification' ||
    message.mode === 'task-notification'
  ) {
    return 'task-notification'
  }

  if (shouldUseLegacyProtocolFallback(message)) {
    const legacyProtocolKind = classifyLegacyProtocolText(
      getTextContent(getMessageContent(message)),
    )
    if (legacyProtocolKind) {
      return legacyProtocolKind
    }
  }

  if (message.isSynthetic === true) {
    return 'synthetic-replay'
  }

  if (message.isMeta === true) {
    return 'coordinator'
  }

  return 'human'
}

export function isHumanAuthoredTurn(
  message: UserTurnProvenanceInput,
): boolean {
  return classifyUserTurnProvenance(message) === 'human'
}

export function isSyntheticSDKUserReplay(
  message: SDKUserReplayProvenance,
): boolean {
  const provenance = classifyUserTurnProvenance({
    type: 'user',
    isSynthetic: message.isSynthetic,
    isReplay: message.isReplay,
    origin: message.origin,
    protocolKind: message.protocolKind,
    message: message.message,
    tool_use_result: message.tool_use_result,
  })

  return (
    provenance !== 'human' &&
    provenance !== 'tool-result' &&
    provenance !== 'local-command-output'
  )
}

export function hasSyntheticMessageProvenance(
  message: SyntheticMessageProvenance,
): boolean {
  return message.isSynthetic === true
}

export function protocolKindForOrigin(
  origin: ReplayOrigin | undefined,
): string | undefined {
  switch (origin?.kind) {
    case 'task-notification':
      return TASK_NOTIFICATION_TAG
    case 'channel':
      return CHANNEL_MESSAGE_TAG
    case 'cross-session':
      return CROSS_SESSION_MESSAGE_TAG
    case 'tick':
      return TICK_TAG
    default:
      return undefined
  }
}

export function protocolKindFromUserContent(
  content: unknown,
): string | undefined {
  return protocolKindFromLegacyUserText(getTextContent(content))
}

export function shouldInferProtocolKindFromLegacyContent(
  message: Pick<
    UserTurnProvenanceInput,
    | 'commandMode'
    | 'isMeta'
    | 'isReplay'
    | 'isSynthetic'
    | 'mode'
    | 'origin'
  >,
): boolean {
  return (
    message.isReplay === true ||
    message.isSynthetic === true ||
    message.isMeta === true ||
    message.commandMode === 'task-notification' ||
    message.mode === 'task-notification' ||
    hasNonHumanOrigin(message.origin)
  )
}

export function protocolKindFromLegacyUserText(
  text: string | undefined,
): string | undefined {
  if (!text) {
    return undefined
  }

  const normalized = stripHumanReplayPrefix(text.trimStart())
  if (normalized.startsWith(`<${TEAMMATE_MESSAGE_TAG}`)) {
    return TEAMMATE_MESSAGE_TAG
  }
  if (normalized.startsWith(`<${TASK_NOTIFICATION_TAG}`)) {
    return TASK_NOTIFICATION_TAG
  }
  if (normalized.startsWith(`<${CHANNEL_MESSAGE_TAG}`)) {
    return CHANNEL_MESSAGE_TAG
  }
  if (normalized.startsWith(`<${CROSS_SESSION_MESSAGE_TAG}`)) {
    return CROSS_SESSION_MESSAGE_TAG
  }
  if (normalized.startsWith(`<${TICK_TAG}`)) {
    return TICK_TAG
  }
  return undefined
}

function normalizeProtocolKind(
  protocolKind: string | undefined,
): UserTurnProvenanceKind | undefined {
  switch (protocolKind) {
    case TEAMMATE_MESSAGE_TAG:
      return 'teammate-protocol'
    case TASK_NOTIFICATION_TAG:
      return 'task-notification'
    case CHANNEL_MESSAGE_TAG:
      return 'channel'
    case CROSS_SESSION_MESSAGE_TAG:
      return 'cross-session'
    case TICK_TAG:
      return 'tick'
    default:
      return undefined
  }
}

function normalizeOriginKind(
  origin: ReplayOrigin | undefined,
): UserTurnProvenanceKind | undefined {
  switch (origin?.kind) {
    case undefined:
    case 'human':
      return undefined
    case 'task-notification':
      return 'task-notification'
    case 'channel':
      return 'channel'
    case 'cross-session':
      return 'cross-session'
    case 'tick':
      return 'tick'
    case 'teammate':
      return 'teammate-protocol'
    case 'coordinator':
    default:
      return 'coordinator'
  }
}

function shouldUseLegacyProtocolFallback(
  message: UserTurnProvenanceInput,
): boolean {
  return shouldInferProtocolKindFromLegacyContent(message)
}

function classifyLegacyProtocolText(
  text: string | undefined,
): UserTurnProvenanceKind | undefined {
  return normalizeProtocolKind(protocolKindFromLegacyUserText(text))
}

function stripHumanReplayPrefix(text: string): string {
  return text.replace(/^(?:Human|User):\s*/i, '').trimStart()
}

function hasToolResultProvenance(message: UserTurnProvenanceInput): boolean {
  if (message.toolUseResult !== undefined || message.tool_use_result !== undefined) {
    return true
  }
  if (message.sourceToolUseID !== undefined) {
    return true
  }
  if ((message.toolResults?.length ?? 0) > 0) {
    return true
  }

  const content = getMessageContent(message)
  return (
    Array.isArray(content) &&
    content.some(
      block => isReplayContentBlock(block) && block.type === 'tool_result',
    )
  )
}

function hasSystemOutputContent(content: unknown): boolean {
  if (typeof content === 'string') {
    return startsWithSystemOutputTag(content)
  }

  return (
    Array.isArray(content) &&
    content.some(
      block =>
        isReplayContentBlock(block) &&
        block.type === 'text' &&
        startsWithSystemOutputTag(block.text),
    )
  )
}

function startsWithSystemOutputTag(text: string | undefined): boolean {
  if (!text) {
    return false
  }

  return (
    text.startsWith(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
    text.startsWith(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
    text.startsWith(`<${BASH_STDOUT_TAG}>`) ||
    text.startsWith(`<${BASH_STDERR_TAG}>`)
  )
}

function isReplayContentBlock(value: unknown): value is UserTurnContentBlock {
  return value !== null && typeof value === 'object'
}

function getMessageContent(message: UserTurnProvenanceInput): unknown {
  return message.message?.content ?? message.content
}

function getTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return undefined
  }
  return content
    .filter(
      (block): block is UserTurnContentBlock =>
        isReplayContentBlock(block) && block.type === 'text',
    )
    .map(block => block.text ?? '')
    .join('\n')
}
