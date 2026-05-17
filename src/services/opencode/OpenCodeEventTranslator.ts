import { openCodeTranscriptProjector } from './OpenCodeTranscriptProjector.js'

import type {
  OpenCodeCanonicalMessage,
  OpenCodeCanonicalMessageRole,
  OpenCodeMessage,
  OpenCodeSessionReconcileSummary,
  OpenCodeSessionStatus,
  OpenCodeSessionStatusInput,
} from './types.js'

type OpenCodeEventTranslatorDeps = {
  transcriptProjector?: Pick<typeof openCodeTranscriptProjector, 'projectSessionMessages'>
}

function getLastMessageId(
  messages: OpenCodeCanonicalMessage[],
  role: OpenCodeCanonicalMessageRole,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (candidate.role === role && candidate.id) {
      return candidate.id
    }
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeOpenCodeSessionStatus(
  rawStatus: OpenCodeSessionStatusInput | null,
): {
  status: OpenCodeSessionStatus | null
  diagnostic: string | null
} {
  if (rawStatus === 'idle' || rawStatus === 'busy' || rawStatus === 'retry') {
    return { status: rawStatus, diagnostic: null }
  }

  const record = asRecord(rawStatus)
  if (!record) {
    const value = asString(rawStatus)
    return {
      status: null,
      diagnostic: value ? `OpenCode session status was unrecognized: ${value}` : null,
    }
  }

  const rawType = asString(record.type) ?? asString(record.status)
  const status =
    rawType === 'idle' || rawType === 'busy' || rawType === 'retry'
      ? rawType
      : null
  const message = asString(record.message)
  const attempt = typeof record.attempt === 'number' ? record.attempt : null
  const next = typeof record.next === 'number' ? record.next : null
  const parts = [
    status ? `OpenCode session status ${status}` : 'OpenCode session status was unrecognized',
    attempt !== null ? `attempt=${attempt}` : null,
    message,
    next !== null ? `next=${new Date(next).toISOString()}` : null,
  ].filter(Boolean)

  return {
    status,
    diagnostic: parts.length > 0 ? parts.join(' - ') : null,
  }
}

export class OpenCodeEventTranslator {
  constructor(private readonly deps: OpenCodeEventTranslatorDeps = {}) {}

  private get transcriptProjector() {
    return this.deps.transcriptProjector ?? openCodeTranscriptProjector
  }

  reconcileSessionMessages(params: {
    sessionId: string
    rawStatus: OpenCodeSessionStatusInput | null
    messages: OpenCodeMessage[]
  }): OpenCodeSessionReconcileSummary {
    const projection = this.transcriptProjector.projectSessionMessages({
      sessionId: params.sessionId,
      messages: params.messages,
    })
    const canonicalMessages = projection.messages
    const diagnostics: string[] = []
    const normalizedStatus = normalizeOpenCodeSessionStatus(params.rawStatus)
    if (normalizedStatus.diagnostic) {
      diagnostics.push(normalizedStatus.diagnostic)
    }
    const respondedParentIds = new Set<string>()

    for (const message of canonicalMessages) {
      if (message.parentId) {
        respondedParentIds.add(message.parentId)
      }
    }

    let replyPendingSinceMessageId: string | null = null
    for (let index = canonicalMessages.length - 1; index >= 0; index -= 1) {
      const candidate = canonicalMessages[index]
      if (candidate.role !== 'user' || !candidate.id) {
        continue
      }
      if (!respondedParentIds.has(candidate.id)) {
        replyPendingSinceMessageId = candidate.id
      }
      break
    }

    const latestAssistantMessageId = getLastMessageId(canonicalMessages, 'assistant')
    const latestUserMessageId = getLastMessageId(canonicalMessages, 'user')
    const latestAssistantMessage =
      latestAssistantMessageId
        ? canonicalMessages.find(message => message.id === latestAssistantMessageId) ?? null
        : null

    let durableState: OpenCodeSessionReconcileSummary['durableState'] = 'unknown'
    if (normalizedStatus.status === 'retry') {
      durableState = 'retrying'
    } else if (normalizedStatus.status === 'busy') {
      durableState = 'running'
    } else if (latestAssistantMessage?.hasError) {
      durableState = 'error'
    } else if (replyPendingSinceMessageId) {
      durableState = 'reply_pending'
    } else if (normalizedStatus.status === 'idle' || canonicalMessages.length > 0) {
      durableState = 'idle'
    }

    if (replyPendingSinceMessageId && normalizedStatus.status === 'idle') {
      diagnostics.push(
        `Latest user message ${replyPendingSinceMessageId} has no assistant reply while OpenCode session is idle`,
      )
    }

    if (latestAssistantMessage?.hasError) {
      diagnostics.push(
        `Latest assistant message ${latestAssistantMessage.id ?? 'unknown'} failed with ${latestAssistantMessage.errorName ?? 'UnknownError'}${latestAssistantMessage.errorMessage ? ` - ${latestAssistantMessage.errorMessage}` : ''}`,
      )
    }

    for (const message of canonicalMessages) {
      if (!message.id) {
        diagnostics.push('Encountered OpenCode message without info.id')
      }
    }

    return {
      sessionId: params.sessionId,
      reconcileOutcome: 'reconciled',
      rawStatus: normalizedStatus.status,
      durableState,
      staleReason: null,
      profileAuthState: null,
      pendingPermissionRequestIds: [],
      messageCount: projection.messageCount,
      toolCallCount: projection.toolCallCount,
      errorCount: projection.errorCount,
      lastCanonicalCursor:
        canonicalMessages[canonicalMessages.length - 1]?.id
        ?? latestAssistantMessageId
        ?? latestUserMessageId,
      latestUserMessageId,
      latestAssistantMessageId,
      latestAssistantText: latestAssistantMessage?.text || null,
      latestAssistantPreview:
        latestAssistantMessage?.previewText
        ?? latestAssistantMessage?.errorMessage
        ?? null,
      replyPendingSinceMessageId,
      messages: canonicalMessages,
      diagnostics,
    }
  }
}

export const openCodeEventTranslator = new OpenCodeEventTranslator()
