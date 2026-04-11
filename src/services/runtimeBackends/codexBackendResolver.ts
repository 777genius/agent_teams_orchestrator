import { getCodexOAuthTokens } from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

import type { CodexRuntimeBackendId } from './types.js'

export const CODEX_API_KEY_ENV_VAR = 'OPENAI_API_KEY'
export const CODEX_API_KEY_BETA_ENV_VAR = 'CLAUDE_CODE_CODEX_API_KEY_BETA'
export const CODEX_RUNTIME_BACKEND_ENV_VAR = 'CLAUDE_CODE_CODEX_BACKEND'

export type CodexResolvedRuntimeBackendId = Exclude<CodexRuntimeBackendId, 'auto'>

export type CodexRuntimeResolution = {
  selectedBackendId: CodexRuntimeBackendId
  resolvedBackendId: CodexResolvedRuntimeBackendId | null
  featureFlagEnabled: boolean
  oauthAuthenticated: boolean
  apiKeyConfigured: boolean
  authenticated: boolean
  authMethod: 'oauth_token' | 'api_key' | null
  canLoginFromUi: boolean
  statusMessage: string | null
  detailMessage: string | null
}

export function isCodexApiKeyBetaEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isEnvTruthy(env[CODEX_API_KEY_BETA_ENV_VAR])
}

export function getCodexApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[CODEX_API_KEY_ENV_VAR]
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function normalizeCodexBackendPreference(
  value: string | null | undefined,
): CodexRuntimeBackendId {
  if (value === 'adapter') return 'adapter'
  if (value === 'api') return 'api'
  return 'auto'
}

export function getCodexRuntimeBackendPreference(
  env: NodeJS.ProcessEnv = process.env,
): CodexRuntimeBackendId {
  return normalizeCodexBackendPreference(
    env[CODEX_RUNTIME_BACKEND_ENV_VAR] ?? getGlobalConfig().codexBackendPreference,
  )
}

export function resolveCodexRuntimeSelection(params?: {
  env?: NodeJS.ProcessEnv
  preference?: CodexRuntimeBackendId
  oauthAuthenticated?: boolean
  apiKeyConfigured?: boolean
  featureFlagEnabled?: boolean
}): CodexRuntimeResolution {
  const env = params?.env ?? process.env
  const featureFlagEnabled =
    params?.featureFlagEnabled ?? isCodexApiKeyBetaEnabled(env)
  const selectedBackendId =
    params?.preference ?? getCodexRuntimeBackendPreference(env)
  const oauthAuthenticated =
    params?.oauthAuthenticated ?? Boolean(getCodexOAuthTokens()?.accessToken)
  const apiKeyConfigured =
    params?.apiKeyConfigured ?? Boolean(getCodexApiKey(env))

  const apiBackendAvailable = featureFlagEnabled && apiKeyConfigured
  const adapterAvailable = oauthAuthenticated

  let resolvedBackendId: CodexResolvedRuntimeBackendId | null = null
  if (selectedBackendId === 'auto') {
    resolvedBackendId = apiBackendAvailable
      ? 'api'
      : adapterAvailable
        ? 'adapter'
        : null
  } else if (selectedBackendId === 'api') {
    resolvedBackendId = apiBackendAvailable ? 'api' : null
  } else {
    resolvedBackendId = adapterAvailable ? 'adapter' : null
  }

  const authenticated = resolvedBackendId !== null
  const authMethod =
    resolvedBackendId === 'api'
      ? 'api_key'
      : resolvedBackendId === 'adapter'
        ? 'oauth_token'
        : null
  const canLoginFromUi = selectedBackendId !== 'api'

  const statusMessage = authenticated
    ? resolvedBackendId === 'api'
      ? selectedBackendId === 'auto'
        ? 'Resolved to OpenAI API'
        : 'OpenAI API ready'
      : selectedBackendId === 'auto'
        ? 'Resolved to Default adapter'
        : 'Default adapter ready'
    : selectedBackendId === 'api'
      ? 'Codex OpenAI API not ready'
      : selectedBackendId === 'adapter'
        ? 'Codex adapter not ready'
        : 'No Codex runtime backend is ready'

  let detailMessage: string | null
  if (resolvedBackendId === 'api') {
    detailMessage = 'Codex OpenAI Responses API backend is ready.'
  } else if (resolvedBackendId === 'adapter') {
    detailMessage = 'Codex adapter is ready.'
  } else if (selectedBackendId === 'api') {
    detailMessage = featureFlagEnabled
      ? `Codex API key mode requires ${CODEX_API_KEY_ENV_VAR}.`
      : 'Codex API key mode is disabled until the beta flag is enabled.'
  } else if (!featureFlagEnabled) {
    detailMessage =
      'Codex OAuth session not found. Sign in to use the built-in adapter.'
  } else if (apiKeyConfigured) {
    detailMessage =
      'Codex API key is configured, but the selected backend is unavailable.'
  } else if (oauthAuthenticated) {
    detailMessage =
      'Codex OAuth session is available, but the selected backend is unavailable.'
  } else {
    detailMessage = `Set ${CODEX_API_KEY_ENV_VAR} or sign in with Codex OAuth.`
  }

  return {
    selectedBackendId,
    resolvedBackendId,
    featureFlagEnabled,
    oauthAuthenticated,
    apiKeyConfigured,
    authenticated,
    authMethod,
    canLoginFromUi,
    statusMessage,
    detailMessage,
  }
}
