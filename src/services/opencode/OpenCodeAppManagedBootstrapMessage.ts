import type { OpenCodeCanonicalMessage, OpenCodeMessage } from './types.js'

export const OPENCODE_APP_MANAGED_BOOTSTRAP_MARKER = 'AGENT_TEAMS_APP_MANAGED_BOOTSTRAP_V1'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function collectRawMessageText(message: OpenCodeMessage): string {
  return message.parts
    .map(part => typeof part.text === 'string' ? part.text : '')
    .filter(text => text.length > 0)
    .join('\n')
}

export function isOpenCodeAppManagedBootstrapText(value: unknown): boolean {
  return typeof value === 'string' && value.includes(OPENCODE_APP_MANAGED_BOOTSTRAP_MARKER)
}

export function isOpenCodeAppManagedBootstrapMessage(
  message: OpenCodeMessage | OpenCodeCanonicalMessage,
): boolean {
  // App-managed bootstrap is internal session context. It must stay out of
  // projected transcripts so delivery observers do not treat it as user input
  // and UI/history do not show synthetic bootstrap instructions as messages.
  const raw = message as OpenCodeMessage
  if (Array.isArray(raw.parts)) {
    const info = asRecord(raw.info)
    const role = typeof info?.role === 'string' ? info.role : null
    return role === 'user' && isOpenCodeAppManagedBootstrapText(collectRawMessageText(raw))
  }

  const canonical = message as OpenCodeCanonicalMessage
  return canonical.role === 'user' && isOpenCodeAppManagedBootstrapText(canonical.text)
}
