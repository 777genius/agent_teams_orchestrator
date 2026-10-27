import { shouldUseCodexProviderRoutingForCurrentProcess } from '../../utils/auth.js'
import { getCodexRuntimeBackendPreference } from '../runtimeBackends/codexBackendResolver.js'

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
  const label = {
    rewind: 'rewinding conversation history',
    'partial-resume': 'resuming only part of a conversation',
    fork: 'forking a conversation',
  }[operation]
  return `Native Codex does not support ${label}. Resume the full session or start a new session.`
}

export function assertCodexNativeHistoryOperationSupported(
  operation: CodexNativeHistoryOperation,
): void {
  const error = getCodexNativeHistoryOperationError(operation)
  if (error) throw new Error(error)
}
