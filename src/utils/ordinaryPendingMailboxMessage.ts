import { hasGroupMailboxMarker, type GroupMailboxEnvelope } from './groupMailbox.js'
import { TEAM_LEAD_NAME } from './swarm/constants.js'
import {
  getBoundWorkSyncContinuationTicket,
  isWorkSyncPostTurnAdmissionWindowOpen,
  readWorkSyncAdmissionControlRevision,
} from './workSyncContinuationAdmission.js'
import {
  isMatchingWorkSyncContinuationTicket,
  readWorkSyncInboxContinuationTicket,
} from './workSyncInboxTicket.js'

const BOOTSTRAP_MEMBER_BRIEFING_MARKER =
  'Your FIRST action: call MCP tool member_briefing'
const BOOTSTRAP_PERSISTENT_TEAMMATE_MARKER =
  'The team has already been created and you are being attached as a persistent teammate.'

export type OrdinaryPendingMailboxMessage = GroupMailboxEnvelope & {
  messageId?: string
  messageKind?: string
  from?: string
  text: string
  workSyncRuntimeTicketId?: string
  workSyncRuntimeGeneration?: number
  workSyncRuntimeInstanceId?: string
  workSyncIntentId?: string
  workSyncAdmissionPayloadHash?: string
  workSyncControlRevision?: number
}

function isBootstrapMailboxInstructionText(text: string): boolean {
  return (
    text.includes(BOOTSTRAP_MEMBER_BRIEFING_MARKER) ||
    text.includes(BOOTSTRAP_PERSISTENT_TEAMMATE_MARKER)
  )
}

function isRegularInteractiveMailboxMessage(message: GroupMailboxEnvelope & { text: string }): boolean {
  if (hasGroupMailboxMarker(message)) return true
  try {
    const parsed: unknown = JSON.parse(message.text)
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      return true
    }
    const type = (parsed as { type: unknown }).type
    return (
      type !== 'permission_request' &&
      type !== 'permission_response' &&
      type !== 'sandbox_permission_request' &&
      type !== 'sandbox_permission_response' &&
      type !== 'shutdown_request' &&
      type !== 'shutdown_approved' &&
      type !== 'team_permission_update' &&
      type !== 'mode_set_request' &&
      type !== 'plan_approval_request' &&
      type !== 'plan_approval_response'
    )
  } catch {
    return true
  }
}

export function classifyTicketedWorkSyncEnvelope(
  message: Parameters<typeof readWorkSyncInboxContinuationTicket>[0],
): 'match' | 'wait' | 'stale' | 'none' {
  const ticket = readWorkSyncInboxContinuationTicket(message)
  if (!ticket) {
    return 'none'
  }
  const held = getBoundWorkSyncContinuationTicket()
  if (held) {
    return isMatchingWorkSyncContinuationTicket({
      message,
      runtimeInstanceId: held.runtimeInstanceId,
      reservationNonce: held.reservationNonce,
      intentId: held.intentId,
      expectedGeneration: held.expectedGeneration,
      admissionPayloadHash: held.admissionPayloadHash,
    })
      ? 'match'
      : 'stale'
  }
  return isWorkSyncPostTurnAdmissionWindowOpen() ? 'wait' : 'stale'
}

function isStaleUnticketedWorkSyncNudge(
  message: OrdinaryPendingMailboxMessage,
): boolean {
  if (message.messageKind !== 'member_work_sync_nudge') {
    return false
  }
  if (readWorkSyncInboxContinuationTicket(message)) {
    return false
  }
  const current = readWorkSyncAdmissionControlRevision()
  if (current == null) {
    return false
  }
  const envelopeRevision = message.workSyncControlRevision
  return envelopeRevision == null || envelopeRevision < current
}

export function getOrdinaryPendingMessage<T extends OrdinaryPendingMailboxMessage>({
  pendingMessages,
  deferUnticketedWorkSyncNudges = false,
}: {
  pendingMessages: readonly T[]
  deferUnticketedWorkSyncNudges?: boolean
}): T | undefined {
  const actionableMessages = pendingMessages.filter(
    message =>
      !!message.messageId &&
      message.messageKind !== 'agent_error' &&
      isRegularInteractiveMailboxMessage(message) &&
      !(
        message.from === TEAM_LEAD_NAME &&
        isBootstrapMailboxInstructionText(message.text)
      ),
  )
  const matchingTicketed = actionableMessages.find(
    message => classifyTicketedWorkSyncEnvelope(message) === 'match',
  )
  if (matchingTicketed) {
    return matchingTicketed
  }
  if (
    actionableMessages.some(message => classifyTicketedWorkSyncEnvelope(message) === 'wait')
  ) {
    return undefined
  }
  const remaining = actionableMessages.filter(
    message =>
      classifyTicketedWorkSyncEnvelope(message) !== 'stale' &&
      !isStaleUnticketedWorkSyncNudge(message),
  )
  if (!deferUnticketedWorkSyncNudges) {
    return (
      remaining.find(message => message.messageKind === 'member_work_sync_nudge') ??
      remaining[0]
    )
  }
  return remaining.find(message => message.messageKind !== 'member_work_sync_nudge')
}
