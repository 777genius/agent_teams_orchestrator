export type IncomingPromptSubmissionKind =
  | 'bootstrap'
  | 'runtime_delivery'
  | 'mailbox'
  | 'task'
  | 'tick'

export type IncomingPromptQueryGuardStatus =
  | 'idle'
  | 'dispatching'
  | 'running'

export type IncomingPromptRejectionReason =
  | 'query_active'
  | 'command_queue_busy'

export type IncomingPromptAdmissionDecision =
  | { accepted: true }
  | {
      accepted: false
      rejectionReason: IncomingPromptRejectionReason
      retryable: true
    }

const BLOCKING_QUEUE_MODES = new Set(['prompt', 'bash'])

export function getBlockingIncomingPromptQueueModes(
  queueModes: readonly string[],
): string[] {
  return [...new Set(queueModes.filter(mode => BLOCKING_QUEUE_MODES.has(mode)))]
}

export function decideIncomingPromptAdmission({
  submissionKind,
  queryGuardStatus,
  blockingQueueModes,
}: {
  submissionKind: IncomingPromptSubmissionKind
  queryGuardStatus: IncomingPromptQueryGuardStatus
  blockingQueueModes: readonly string[]
}): IncomingPromptAdmissionDecision {
  if (queryGuardStatus !== 'idle') {
    return {
      accepted: false,
      rejectionReason: 'query_active',
      retryable: true,
    }
  }

  if (submissionKind !== 'bootstrap' && blockingQueueModes.length > 0) {
    return {
      accepted: false,
      rejectionReason: 'command_queue_busy',
      retryable: true,
    }
  }

  return { accepted: true }
}
