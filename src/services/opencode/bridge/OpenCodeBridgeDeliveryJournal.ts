import { openCodeCommandOutcomeStore, type OpenCodeCommandOutcomeStore, type OpenCodeCommandOutcomeRecord, type OpenCodeCommandOutcomePatch, type OpenCodeCommandOutcomeSendMessageData, type OpenCodeCommandOutcomeStatus } from '../OpenCodeCommandOutcomeStore.js'
import type { OpenCodeSnapshotBoundary } from '../OpenCodeChangeEvidence.js'
import type { OpenCodeDeliveryResponseObservation } from '../OpenCodeDeliveryResponseObserver.js'

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export type TeamDiagnostic = {
  code: string
  severity: 'info' | 'warning' | 'error'
  message: string
}


export type SendMessageCommandData = {
  accepted: boolean
  runId?: string
  sessionId?: string
  memberName: string
  runtimePid?: number
  prePromptCursor?: string | null
  runtimePromptMessageId?: string
  snapshotBoundary?: OpenCodeSnapshotBoundary
  responseObservation?: OpenCodeDeliveryResponseObservation
  diagnostics: TeamDiagnostic[]
  idempotencyKey?: string
  manifestHighWatermark?: number | null
  runtimeStoreManifestHighWatermark?: number | null
}


export type SendMessageOutcomeBase = {
  requestId: string
  body: Record<string, unknown>
  teamId: string
  teamName: string
  laneId: string
  memberName: string
  projectPath: string
  runId: string | null
}

export function teamDiagnosticToOutcomeString(diagnostic: TeamDiagnostic): string {
  return `${diagnostic.code}: ${diagnostic.message}`
}

function toOutcomeSendMessageData(data: SendMessageCommandData): OpenCodeCommandOutcomeSendMessageData | undefined {
  if (data.accepted !== true) {
    return undefined
  }
  return {
    accepted: true,
    ...(data.sessionId ? { sessionId: data.sessionId } : {}),
    memberName: data.memberName,
    ...(typeof data.runtimePid === 'number' && data.runtimePid > 0
      ? { runtimePid: data.runtimePid }
      : {}),
    ...(data.prePromptCursor !== undefined ? { prePromptCursor: data.prePromptCursor } : {}),
    ...(data.runtimePromptMessageId ? { runtimePromptMessageId: data.runtimePromptMessageId } : {}),
    ...(data.responseObservation ? { responseObservation: data.responseObservation } : {}),
    diagnostics: data.diagnostics,
  }
}

export async function markSendMessageOutcome(
  base: SendMessageOutcomeBase,
  input: {
    status: OpenCodeCommandOutcomeStatus
    definitelyUnsubmitted?: { runtimePromptMessageId: string }
    sessionId?: string | null
    runtimePid?: number | null
    prePromptCursor?: string | null
    runtimePromptMessageId?: string | null
    acceptedAt?: string | null
    turnObservedAt?: string | null
    completedAt?: string | null
    error?: string | null
    diagnostics?: string[]
    sendMessageData?: SendMessageCommandData
  },
  store: Pick<OpenCodeCommandOutcomeStore, 'upsert'> = openCodeCommandOutcomeStore,
): Promise<void> {
  const patch: OpenCodeCommandOutcomePatch = {
    requestId: base.requestId,
    status: input.status,
    teamId: base.teamId,
    teamName: base.teamName,
    laneId: base.laneId,
    memberName: base.memberName,
    projectPath: base.projectPath,
    runId: base.runId,
    deliveryAttemptId: asString(base.body.deliveryAttemptId) ?? undefined,
    messageId: asString(base.body.messageId),
    payloadHash: asString(base.body.payloadHash),
    sessionId: input.sessionId ?? undefined,
    runtimePid: input.runtimePid ?? undefined,
    prePromptCursor: input.prePromptCursor ?? undefined,
    runtimePromptMessageId: input.runtimePromptMessageId ?? undefined,
    acceptedAt: input.acceptedAt ?? undefined,
    turnObservedAt: input.turnObservedAt ?? undefined,
    completedAt: input.completedAt ?? undefined,
    error: input.error ?? undefined,
    diagnostics: input.diagnostics,
    sendMessageData: input.sendMessageData ? toOutcomeSendMessageData(input.sendMessageData) : undefined,
  }
  // OutcomeStore owns the locked identity check and durable transition. Older
  // stores ignore this option and conservatively retain prompt_submitting.
  const options = {
    requireRetryable: input.status === 'received' || input.status === 'prompt_submitting',
    ...(input.definitelyUnsubmitted ? { definitelyUnsubmitted: input.definitelyUnsubmitted } : {}),
  }
  await store.upsert(patch, options)
}


export type CommandStatusCommandData = {
  status:
    | 'unknown'
    | 'received'
    | 'prompt_submitting'
    | 'prompt_accepted'
    | 'turn_observed'
    | 'reconciled'
    | 'failed_before_accept'
    | 'failed_after_accept'
    | 'precondition_mismatch'
  safeToRetry: boolean
  accepted: boolean
  originalRequestId?: string
  deliveryAttemptId?: string
  sessionId?: string
  runtimePid?: number
  runtimePromptMessageId?: string
  prePromptCursor?: string | null
  sendMessageData?: SendMessageCommandData
  diagnostics: string[]
}


export function commandStatusFromOutcomeStatus(
  status: OpenCodeCommandOutcomeStatus,
): CommandStatusCommandData['status'] {
  if (
    status === 'received' ||
    status === 'preconditions_checked' ||
    status === 'session_resolved' ||
    status === 'mcp_ready'
  ) {
    return 'received'
  }
  return status
}

export function isAcceptedOutcomeStatus(status: CommandStatusCommandData['status']): boolean {
  return (
    status === 'prompt_accepted' ||
    status === 'turn_observed' ||
    status === 'reconciled' ||
    status === 'failed_after_accept'
  )
}

export function outcomeSendMessageDataToCommandData(
  data: OpenCodeCommandOutcomeSendMessageData | undefined,
): SendMessageCommandData | undefined {
  if (!data) {
    return undefined
  }
  return {
    accepted: true,
    ...(data.sessionId ? { sessionId: data.sessionId } : {}),
    memberName: data.memberName,
    ...(typeof data.runtimePid === 'number' && data.runtimePid > 0
      ? { runtimePid: data.runtimePid }
      : {}),
    ...(data.prePromptCursor !== undefined ? { prePromptCursor: data.prePromptCursor } : {}),
    ...(data.runtimePromptMessageId ? { runtimePromptMessageId: data.runtimePromptMessageId } : {}),
    ...(data.responseObservation ? { responseObservation: data.responseObservation } : {}),
    diagnostics: data.diagnostics,
  }
}


export function commandStatusMismatchReason(
  record: OpenCodeCommandOutcomeRecord,
  body: Record<string, unknown>,
): string | null {
  const expectedCommand = asString(body.originalCommand)
  if (expectedCommand && expectedCommand !== 'opencode.sendMessage') {
    return 'originalCommand mismatch'
  }
  const teamId = asString(body.teamId)
  if (teamId && teamId !== record.teamId) {
    return 'teamId mismatch'
  }
  const teamName = asString(body.teamName)
  if (teamName && teamName !== record.teamName) {
    return 'teamName mismatch'
  }
  const laneId = asString(body.laneId)
  if (laneId && laneId !== record.laneId) {
    return 'laneId mismatch'
  }
  const memberName = asString(body.memberName)
  if (memberName && memberName !== record.memberName) {
    return 'memberName mismatch'
  }
  const messageId = asString(body.messageId)
  if (messageId && messageId !== record.messageId) {
    return 'messageId mismatch'
  }
  const payloadHash = asString(body.payloadHash)
  if (payloadHash && payloadHash !== record.payloadHash) {
    return 'payloadHash mismatch'
  }
  const projectPath = asString(body.projectPath)
  if (projectPath && projectPath !== record.projectPath) {
    return 'projectPath mismatch'
  }
  const runId = asString(body.runId)
  if (runId && runId !== record.runId) {
    return 'runId mismatch'
  }
  return null
}


/** Delivery repair is app-owned for both generations. This performs no replay. */
export function openCodeDeliveryJournalRecoveryData() {
  return {
    recovered: false,
    diagnostics: ['Delivery journal recovery is currently app-owned; no orchestrator repair was required.'],
  }
}
