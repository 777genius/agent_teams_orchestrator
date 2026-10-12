import { hasGroupMailboxMarker, type GroupMailboxEnvelope } from '../utils/groupMailbox.js'
import { randomUUID } from 'node:crypto'
import type { AppState } from '../state/AppStateStore.js'
import type { TeammateMessage } from '../utils/teammateMailbox.js'

export function isHumanDirectMailboxMessage(message: GroupMailboxEnvelope & { from: string; source?: string }): boolean {
  // A system task assignment can retain its human initiator as the sender.
  // Legacy rows without source metadata still require a direct user reply.
  return !hasGroupMailboxMarker(message) && message.from.trim().toLowerCase() === 'user' && message.source !== 'system_notification'
}

export function createPendingMailboxMirrorMessage(
  message: TeammateMessage,
  claimedBySessionId?: string,
): AppState['inbox']['messages'][number] {
  return {
    id: randomUUID(),
    messageId: message.messageId,
    messageKind: message.messageKind,
    ...(message.groupChatId !== undefined ? {
      groupChatId: message.groupChatId,
      groupChatName: message.groupChatName,
      groupMessageId: message.groupMessageId,
      groupChatProtocolVersion: message.groupChatProtocolVersion,
      groupRunKey: message.groupRunKey,
      groupRecipientNames: message.groupRecipientNames,
      groupRecipientRunKeys: message.groupRecipientRunKeys,
      relayOfMessageId: message.relayOfMessageId,
    } : {}),
    mailboxClaimedBySessionId: claimedBySessionId,
    from: message.from,
    source: message.source,
    text: message.text,
    timestamp: message.timestamp,
    status: 'pending',
    color: message.color,
    summary: message.summary,
    ...(message.attachments ? { attachments: message.attachments } : {}),
    ...(message.nativeAttachmentDelivery
      ? { nativeAttachmentDelivery: message.nativeAttachmentDelivery }
      : {}),
    ...(message.workSyncRuntimeTicketId
      ? { workSyncRuntimeTicketId: message.workSyncRuntimeTicketId }
      : {}),
    ...(message.workSyncRuntimeGeneration != null
      ? { workSyncRuntimeGeneration: message.workSyncRuntimeGeneration }
      : {}),
    ...(message.workSyncRuntimeInstanceId
      ? { workSyncRuntimeInstanceId: message.workSyncRuntimeInstanceId }
      : {}),
    ...(message.workSyncControlRevision != null
      ? { workSyncControlRevision: message.workSyncControlRevision }
      : {}),
    ...(message.workSyncIntentId ? { workSyncIntentId: message.workSyncIntentId } : {}),
    ...(message.workSyncPayloadHash
      ? { workSyncPayloadHash: message.workSyncPayloadHash }
      : {}),
    ...(message.workSyncAdmissionPayloadHash
      ? { workSyncAdmissionPayloadHash: message.workSyncAdmissionPayloadHash }
      : {}),
  }
}
