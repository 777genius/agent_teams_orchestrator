import type { OpenCodeMessage } from './types.js'

function nonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Normalize OpenCode's two session-id spellings while rejecting absent or contradictory identity. */
export function readOpenCodeMessageSessionId(message: OpenCodeMessage): string | null {
  const canonical = message.info.sessionID
  const compatibility = message.info.sessionId
  if (canonical !== undefined && nonemptyString(canonical) === null) return null
  if (compatibility !== undefined && nonemptyString(compatibility) === null) return null
  const canonicalId = nonemptyString(canonical)
  const compatibilityId = nonemptyString(compatibility)
  if (canonicalId && compatibilityId && canonicalId !== compatibilityId) return null
  return canonicalId ?? compatibilityId
}

export function hasExactOpenCodeMessageOwnership(
  message: OpenCodeMessage | null | undefined,
  expectedMessageId: string,
  expectedSessionId: string,
): message is OpenCodeMessage {
  return message?.info.id === expectedMessageId
    && readOpenCodeMessageSessionId(message) === expectedSessionId
}
