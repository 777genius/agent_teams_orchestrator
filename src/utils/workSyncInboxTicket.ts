export type WorkSyncInboxTicketFields = {
  workSyncRuntimeTicketId?: string
  workSyncRuntimeGeneration?: number
  workSyncRuntimeInstanceId?: string
  workSyncControlRevision?: number
  workSyncIntentId?: string
  workSyncPayloadHash?: string
  workSyncAdmissionPayloadHash?: string
}

export function readWorkSyncInboxContinuationTicket(
  message: WorkSyncInboxTicketFields & { messageKind?: string; messageId?: string },
): {
  ticketId: string
  generation: number
  intentId: string
  runtimeInstanceId?: string
  controlRevision?: number
  admissionPayloadHash?: string
  payloadHash?: string
} | null {
  if (message.messageKind !== 'member_work_sync_nudge') {
    return null
  }
  const ticketId = message.workSyncRuntimeTicketId?.trim()
  const generation = message.workSyncRuntimeGeneration
  if (!ticketId || generation == null || !Number.isInteger(generation)) {
    return null
  }
  return {
    ticketId,
    generation,
    intentId: message.workSyncIntentId?.trim() || message.messageId || ticketId,
    ...(message.workSyncRuntimeInstanceId?.trim()
      ? { runtimeInstanceId: message.workSyncRuntimeInstanceId.trim() }
      : {}),
    ...(message.workSyncControlRevision != null
      ? { controlRevision: message.workSyncControlRevision }
      : {}),
    ...(message.workSyncAdmissionPayloadHash?.trim()
      ? { admissionPayloadHash: message.workSyncAdmissionPayloadHash.trim() }
      : {}),
    ...(message.workSyncPayloadHash?.trim()
      ? { payloadHash: message.workSyncPayloadHash.trim() }
      : {}),
  }
}

export function isMatchingWorkSyncContinuationTicket(input: {
  message: WorkSyncInboxTicketFields & { messageKind?: string; messageId?: string }
  runtimeInstanceId: string
  reservationNonce: string
  intentId: string
  expectedGeneration: number
  admissionPayloadHash?: string
}): boolean {
  const ticket = readWorkSyncInboxContinuationTicket(input.message)
  if (!ticket) return false
  if (ticket.ticketId !== input.reservationNonce) return false
  if (ticket.intentId !== input.intentId) return false
  if (ticket.generation !== input.expectedGeneration) return false
  if (
    ticket.runtimeInstanceId &&
    ticket.runtimeInstanceId !== input.runtimeInstanceId
  ) {
    return false
  }
  const reservedHash = input.admissionPayloadHash?.trim()
  if (reservedHash && ticket.admissionPayloadHash !== reservedHash) {
    return false
  }
  return true
}
