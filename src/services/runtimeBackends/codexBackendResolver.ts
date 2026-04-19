import type { CodexRuntimeBackendId } from './types.js'

export const CODEX_NATIVE_API_KEY_ENV_VAR = 'CODEX_API_KEY'
export const OPENAI_API_KEY_ENV_VAR = 'OPENAI_API_KEY'
export const CODEX_RUNTIME_BACKEND_ENV_VAR = 'CLAUDE_CODE_CODEX_BACKEND'

export type CodexResolvedRuntimeBackendId = CodexRuntimeBackendId

export type CodexRuntimeResolution = {
  selectedBackendId: CodexRuntimeBackendId
  resolvedBackendId: CodexResolvedRuntimeBackendId | null
  featureFlagEnabled: boolean
  nativeFeatureFlagEnabled: boolean
  nativeInternalUnlockEnabled: boolean
  oauthAuthenticated: boolean
  apiKeyConfigured: boolean
  nativeApiKeyConfigured: boolean
  nativeBinaryDetected: boolean
  authenticated: boolean
  authMethod: 'oauth_token' | 'api_key' | null
  canLoginFromUi: boolean
  statusMessage: string | null
  detailMessage: string | null
}

export function getCodexApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates = [env[CODEX_NATIVE_API_KEY_ENV_VAR], env[OPENAI_API_KEY_ENV_VAR]]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue
    }
    const trimmed = candidate.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return null
}

export function getCodexNativeApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return getCodexApiKey(env)
}

export function normalizeCodexBackendPreference(
  _value: string | null | undefined,
): CodexRuntimeBackendId {
  return 'codex-native'
}

export function getCodexRuntimeBackendPreference(
  _env: NodeJS.ProcessEnv = process.env,
): CodexRuntimeBackendId {
  return 'codex-native'
}

export function resolveCodexRuntimeSelection(params?: {
  env?: NodeJS.ProcessEnv
  preference?: CodexRuntimeBackendId
  oauthAuthenticated?: boolean
  apiKeyConfigured?: boolean
  featureFlagEnabled?: boolean
  nativeFeatureFlagEnabled?: boolean
  nativeInternalUnlockEnabled?: boolean
  nativeApiKeyConfigured?: boolean
  nativeBinaryDetected?: boolean
}): CodexRuntimeResolution {
  const env = params?.env ?? process.env
  const featureFlagEnabled = params?.featureFlagEnabled ?? true
  const nativeFeatureFlagEnabled = params?.nativeFeatureFlagEnabled ?? true
  const nativeInternalUnlockEnabled =
    params?.nativeInternalUnlockEnabled ?? true
  const selectedBackendId = params?.preference ?? getCodexRuntimeBackendPreference(env)
  const oauthAuthenticated = params?.oauthAuthenticated ?? false
  const apiKeyConfigured = params?.apiKeyConfigured ?? Boolean(getCodexApiKey(env))
  const nativeApiKeyConfigured = params?.nativeApiKeyConfigured ?? apiKeyConfigured
  const nativeBinaryDetected =
    params?.nativeBinaryDetected ?? Boolean(Bun.which('codex'))

  const nativeBackendAvailable = nativeBinaryDetected && nativeApiKeyConfigured
  const resolvedBackendId = nativeBackendAvailable ? 'codex-native' : null
  const authenticated = resolvedBackendId !== null
  const authMethod = resolvedBackendId ? 'api_key' : null
  const canLoginFromUi = false

  let statusMessage: string | null
  let detailMessage: string | null
  if (authenticated) {
    statusMessage = 'Codex native runtime ready'
    detailMessage = 'Codex native runtime is ready through the local codex exec seam.'
  } else if (!nativeBinaryDetected) {
    statusMessage = 'Codex native runtime unavailable'
    detailMessage =
      'Codex native runtime requires the codex CLI binary to be installed and discoverable.'
  } else if (!nativeApiKeyConfigured) {
    statusMessage = 'Codex native runtime unavailable'
    detailMessage =
      `Codex native runtime requires ${CODEX_NATIVE_API_KEY_ENV_VAR} or ${OPENAI_API_KEY_ENV_VAR}.`
  } else {
    statusMessage = 'Codex native runtime degraded'
    detailMessage = 'Codex native runtime is not ready.'
  }

  return {
    selectedBackendId,
    resolvedBackendId,
    featureFlagEnabled,
    nativeFeatureFlagEnabled,
    nativeInternalUnlockEnabled,
    oauthAuthenticated,
    apiKeyConfigured,
    nativeApiKeyConfigured,
    nativeBinaryDetected,
    authenticated,
    authMethod,
    canLoginFromUi,
    statusMessage,
    detailMessage,
  }
}
