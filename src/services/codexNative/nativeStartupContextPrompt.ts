import {
  NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV,
  readNativeAppManagedBootstrapContextFile,
} from '../teamBootstrap/nativeAppManagedBootstrapContext.js'
import type { CodexManualTurnStartParams } from './appServerApproval.js'

type NativeTurnPrompt = {
  prompt: string
  input?: CodexManualTurnStartParams['input']
  contextHash: string | null
}

/** Validate every turn, but do not repeatedly append unchanged context to a resumed thread. */
export async function buildCodexNativeStartupContextPrompt(
  prompt: string,
  input?: CodexManualTurnStartParams['input'],
  env: NodeJS.ProcessEnv = process.env,
  previousContextHash?: string | null,
): Promise<NativeTurnPrompt> {
  const contextPath = env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV]?.trim()
  if (!contextPath) {
    if (previousContextHash) {
      throw new Error('Codex startup context was removed from an existing conversation. Start a new conversation to change this boundary.')
    }
    return { prompt, input, contextHash: null }
  }

  const { contextText, contextHash } = await readNativeAppManagedBootstrapContextFile(contextPath)
  if (previousContextHash === contextHash) return { prompt, input, contextHash }
  const updatedContext = previousContextHash
    ? `Updated operating context (supersedes the earlier startup context):\n${contextText}`
    : contextText
  // Private readiness controls and proof tokens belong to the bootstrap owner,
  // not to ordinary direct/group model requests.
  return {
    prompt: `${updatedContext}\n\n${prompt}`,
    // A separate block preserves offsets and ordering in the caller's input.
    input: input
      ? [{ type: 'text', text: updatedContext, text_elements: [] }, ...input]
      : undefined,
    contextHash,
  }
}
