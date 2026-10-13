import {
  NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV,
  readNativeAppManagedBootstrapContextFile,
} from '../teamBootstrap/nativeAppManagedBootstrapContext.js'
import type { CodexManualTurnStartParams } from './appServerApproval.js'

type NativeTurnPrompt = {
  prompt: string
  input?: CodexManualTurnStartParams['input']
}

/** Codex starts a fresh thread per turn, so its trusted operating context must travel with each prompt. */
export async function buildCodexNativeStartupContextPrompt(
  prompt: string,
  input?: CodexManualTurnStartParams['input'],
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeTurnPrompt> {
  const contextPath = env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV]?.trim()
  if (!contextPath) return { prompt, input }

  const { contextText } = await readNativeAppManagedBootstrapContextFile(contextPath)
  // Private readiness controls and proof tokens belong to the bootstrap owner,
  // not to ordinary direct/group model requests.
  return {
    prompt: `${contextText}\n\n${prompt}`,
    // A separate block preserves offsets and ordering in the caller's input.
    input: input
      ? [{ type: 'text', text: contextText, text_elements: [] }, ...input]
      : undefined,
  }
}
