import { shouldUseCodexProviderRoutingForCurrentProcess } from '../../utils/auth.js'
import { getCodexRuntimeBackendPreference } from '../runtimeBackends/codexBackendResolver.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { readCodexConversationOwnerReference } from './conversationOwnerReference.js'

export type CodexNativeHistoryOperation = 'rewind' | 'partial-resume' | 'fork'

export function usesCodexNativeConversation(): boolean {
  // A missing binary or expired login does not make history edits safe: the
  // same native thread would return unchanged when availability is restored.
  return shouldUseCodexProviderRoutingForCurrentProcess() &&
    getCodexRuntimeBackendPreference() === 'codex-native'
}

export function getCodexNativeHistoryOperationError(
  operation: CodexNativeHistoryOperation,
): string | undefined {
  if (!usesCodexNativeConversation()) return undefined
  return historyOperationError(operation)
}

function historyOperationError(operation: CodexNativeHistoryOperation): string {
  const label = {
    rewind: 'rewinding conversation history',
    'partial-resume': 'resuming only part of a conversation',
    fork: 'forking a conversation',
  }[operation]
  return `Native Codex does not support ${label}. Resume the full session or start a new session.`
}

/** A provider switch does not detach an existing native conversation owner. */
export async function getCodexNativeHistoryOperationErrorForTranscript(
  operation: CodexNativeHistoryOperation,
  transcriptPath = getTranscriptPath(),
): Promise<string | undefined> {
  const selectedRouteError = getCodexNativeHistoryOperationError(operation)
  if (selectedRouteError) return selectedRouteError
  try {
    return await readCodexConversationOwnerReference(transcriptPath)
      ? historyOperationError(operation)
      : undefined
  } catch {
    return 'Cannot verify the conversation owner before changing history. Restore the session storage or start a new session.'
  }
}

export function assertCodexNativeHistoryOperationSupported(
  operation: CodexNativeHistoryOperation,
): void {
  const error = getCodexNativeHistoryOperationError(operation)
  if (error) throw new Error(error)
}

export async function assertCodexNativeHistoryOperationSupportedForTranscript(
  operation: CodexNativeHistoryOperation,
  transcriptPath?: string,
): Promise<void> {
  const error = await getCodexNativeHistoryOperationErrorForTranscript(operation, transcriptPath)
  if (error) throw new Error(error)
}
