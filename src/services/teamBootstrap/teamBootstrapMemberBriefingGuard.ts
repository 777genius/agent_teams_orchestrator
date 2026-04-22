import type { AppState } from '../../state/AppState.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'

const BOOTSTRAP_MEMBER_BRIEFING_MARKER =
  'Your FIRST action: call MCP tool member_briefing'
const BOOTSTRAP_PERSISTENT_TEAMMATE_MARKER =
  'The team has already been created and you are being attached as a persistent teammate.'

const BOOTSTRAP_MEMBER_BRIEFING_LOOP_THRESHOLD = 3
const BOOTSTRAP_MEMBER_BRIEFING_LOOP_TTL_MS = 10 * 60_000

export const BOOTSTRAP_MEMBER_BRIEFING_LOOP_ABORT_REASON =
  'bootstrap_member_briefing_loop_abort'

export class BootstrapMemberBriefingLoopAbortError extends Error {
  readonly bootstrapContext: BootstrapMemberBriefingContext

  constructor(context: BootstrapMemberBriefingContext) {
    super(
      [
        'Bootstrap member_briefing loop detected.',
        'The model repeatedly omitted required teamName/memberName arguments.',
        'Stopping this bootstrap turn.',
      ].join(' '),
    )
    this.name = 'BootstrapMemberBriefingLoopAbortError'
    this.bootstrapContext = context
  }
}

export type BootstrapMemberBriefingContext = {
  teamName: string
  memberName: string
  bootstrapMirrorId: string
  bootstrapMessageId?: string
}

export type PreparedBootstrapMemberBriefingCall = {
  args: Record<string, unknown>
  bootstrapContext: BootstrapMemberBriefingContext | null
  repairedFields: Array<'teamName' | 'memberName'>
}

type BootstrapLoopState = {
  count: number
  lastSeenAt: number
}

const bootstrapLoopState = new Map<string, BootstrapLoopState>()

function isMissingOrEmptyBootstrapArg(value: unknown): boolean {
  return (
    value == null || (typeof value === 'string' && value.trim().length === 0)
  )
}

function buildBootstrapLoopKey(
  context: BootstrapMemberBriefingContext,
): string {
  return [
    context.teamName,
    context.memberName,
    context.bootstrapMirrorId,
  ].join('\u0000')
}

function buildBootstrapLoopPrefix(params: {
  teamName: string
  memberName: string
}): string {
  return [params.teamName, params.memberName, ''].join('\u0000')
}

function pruneBootstrapLoopState(nowMs: number): void {
  for (const [key, value] of bootstrapLoopState.entries()) {
    if (nowMs - value.lastSeenAt > BOOTSTRAP_MEMBER_BRIEFING_LOOP_TTL_MS) {
      bootstrapLoopState.delete(key)
    }
  }
}

function clearBootstrapLoopStateByPrefix(prefix: string): void {
  for (const key of bootstrapLoopState.keys()) {
    if (key.startsWith(prefix)) {
      bootstrapLoopState.delete(key)
    }
  }
}

function clearBootstrapLoopStateForContextChange(
  context: BootstrapMemberBriefingContext,
): void {
  const currentKey = buildBootstrapLoopKey(context)
  const prefix = buildBootstrapLoopPrefix(context)
  for (const key of bootstrapLoopState.keys()) {
    if (key.startsWith(prefix) && key !== currentKey) {
      bootstrapLoopState.delete(key)
    }
  }
}

function noteMalformedBootstrapAttempt(
  context: BootstrapMemberBriefingContext,
  nowMs: number,
): void {
  pruneBootstrapLoopState(nowMs)
  clearBootstrapLoopStateForContextChange(context)
  const key = buildBootstrapLoopKey(context)
  const nextCount = (bootstrapLoopState.get(key)?.count ?? 0) + 1
  bootstrapLoopState.set(key, {
    count: nextCount,
    lastSeenAt: nowMs,
  })
  if (nextCount > BOOTSTRAP_MEMBER_BRIEFING_LOOP_THRESHOLD) {
    throw new BootstrapMemberBriefingLoopAbortError(context)
  }
}

export function clearBootstrapMemberBriefingLoopState(
  context: BootstrapMemberBriefingContext,
): void {
  bootstrapLoopState.delete(buildBootstrapLoopKey(context))
}

export function clearBootstrapMemberBriefingLoopStateForMember(params: {
  teamName: string
  memberName: string
  nowMs?: number
}): void {
  pruneBootstrapLoopState(params.nowMs ?? Date.now())
  clearBootstrapLoopStateByPrefix(buildBootstrapLoopPrefix(params))
}

export function isBootstrapMemberBriefingLoopAbortReason(
  reason: unknown,
): boolean {
  return reason === BOOTSTRAP_MEMBER_BRIEFING_LOOP_ABORT_REASON
}

export function resetBootstrapMemberBriefingGuardStateForTests(): void {
  bootstrapLoopState.clear()
}

export function isBootstrapMailboxInstructionText(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) {
    return false
  }
  if (normalized.includes(BOOTSTRAP_MEMBER_BRIEFING_MARKER)) {
    return true
  }
  return (
    normalized.includes(BOOTSTRAP_PERSISTENT_TEAMMATE_MARKER) &&
    normalized.includes('member_briefing')
  )
}

export function getActiveBootstrapMemberBriefingContext(params: {
  appState: Pick<AppState, 'inbox'>
  currentSessionId?: string
  isTeammateSession: boolean
  teamName?: string
  memberName?: string
}): BootstrapMemberBriefingContext | null {
  const { appState, currentSessionId, isTeammateSession, teamName, memberName } =
    params

  if (
    !isTeammateSession ||
    !currentSessionId ||
    !teamName ||
    !memberName ||
    memberName === TEAM_LEAD_NAME
  ) {
    return null
  }

  const bootstrapMirror = appState.inbox.messages.find(
    message =>
      (message.status === 'pending' || message.status === 'processing') &&
      message.from === TEAM_LEAD_NAME &&
      message.mailboxClaimedBySessionId === currentSessionId &&
      isBootstrapMailboxInstructionText(message.text),
  )

  if (!bootstrapMirror) {
    return null
  }

  return {
    teamName,
    memberName,
    bootstrapMirrorId: bootstrapMirror.id,
    bootstrapMessageId: bootstrapMirror.messageId,
  }
}

export function prepareBootstrapMemberBriefingCall(params: {
  serverName: string
  toolName: string
  args: Record<string, unknown>
  appState: Pick<AppState, 'inbox'>
  currentSessionId?: string
  isTeammateSession: boolean
  teamName?: string
  memberName?: string
  nowMs?: number
}): PreparedBootstrapMemberBriefingCall {
  const nowMs = params.nowMs ?? Date.now()
  const bootstrapContext = getActiveBootstrapMemberBriefingContext({
    appState: params.appState,
    currentSessionId: params.currentSessionId,
    isTeammateSession: params.isTeammateSession,
    teamName: params.teamName,
    memberName: params.memberName,
  })

  if (params.serverName !== 'agent-teams' || params.toolName !== 'member_briefing') {
    return {
      args: params.args,
      bootstrapContext: null,
      repairedFields: [],
    }
  }

  if (!bootstrapContext) {
    if (params.teamName && params.memberName) {
      clearBootstrapMemberBriefingLoopStateForMember({
        teamName: params.teamName,
        memberName: params.memberName,
        nowMs,
      })
    }
    return {
      args: params.args,
      bootstrapContext: null,
      repairedFields: [],
    }
  }

  clearBootstrapLoopStateForContextChange(bootstrapContext)

  const repairedFields: Array<'teamName' | 'memberName'> = []
  const repairedArgs = { ...params.args }
  const isMissingTeamName = isMissingOrEmptyBootstrapArg(repairedArgs.teamName)
  const isMissingMemberName = isMissingOrEmptyBootstrapArg(
    repairedArgs.memberName,
  )

  if (isMissingTeamName || isMissingMemberName) {
    noteMalformedBootstrapAttempt(bootstrapContext, nowMs)
    if (isMissingTeamName) {
      repairedArgs.teamName = bootstrapContext.teamName
      repairedFields.push('teamName')
    }
    if (isMissingMemberName) {
      repairedArgs.memberName = bootstrapContext.memberName
      repairedFields.push('memberName')
    }
  }

  return {
    args: repairedArgs,
    bootstrapContext,
    repairedFields,
  }
}
