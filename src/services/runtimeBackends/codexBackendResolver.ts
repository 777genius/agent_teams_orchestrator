import { getFlagSettingsInline } from '../../bootstrap/state.js'
import { spawnSyncPortableCli } from '../../utils/portableCli.js'
import type { CodexRuntimeBackendId } from './types.js'

export const CODEX_NATIVE_API_KEY_ENV_VAR = 'CODEX_API_KEY'
export const OPENAI_API_KEY_ENV_VAR = 'OPENAI_API_KEY'
export const CODEX_RUNTIME_BACKEND_ENV_VAR = 'CLAUDE_CODE_CODEX_BACKEND'
export type CodexForcedLoginMethod = 'chatgpt' | 'api'
export type CodexCliLoginState = 'logged_in' | 'not_logged_in' | 'unknown'

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

const CODEX_LOGIN_STATUS_CACHE_MS = 5_000

let cachedCodexCliLoginState:
  | {
      checkedAtMs: number
      value: CodexCliLoginState
    }
  | null = null

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

export function getCodexForcedLoginMethod(
  settingsInline: Record<string, unknown> | null = getFlagSettingsInline(),
): CodexForcedLoginMethod | null {
  const codexSettings = asRecord(settingsInline)?.codex
  const forcedLoginMethod = asRecord(codexSettings)?.forced_login_method
  return forcedLoginMethod === 'chatgpt' || forcedLoginMethod === 'api'
    ? forcedLoginMethod
    : null
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

export function detectCodexCliLoginState(
  nowMs: number = Date.now(),
): CodexCliLoginState {
  if (
    cachedCodexCliLoginState
    && nowMs - cachedCodexCliLoginState.checkedAtMs < CODEX_LOGIN_STATUS_CACHE_MS
  ) {
    return cachedCodexCliLoginState.value
  }

  const codexExecutable = Bun.which('codex')
  if (!codexExecutable) {
    cachedCodexCliLoginState = { checkedAtMs: nowMs, value: 'unknown' }
    return 'unknown'
  }

  let nextValue: CodexCliLoginState = 'unknown'

  try {
    const result = spawnSyncPortableCli(codexExecutable, ['login', 'status'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()

    if (result.status === 0) {
      nextValue = 'logged_in'
    } else if (/not logged in/i.test(combinedOutput)) {
      nextValue = 'not_logged_in'
    }
  } catch {
    nextValue = 'unknown'
  }

  cachedCodexCliLoginState = { checkedAtMs: nowMs, value: nextValue }
  return nextValue
}

export function resolveCodexRuntimeSelection(params?: {
  env?: NodeJS.ProcessEnv
  preference?: CodexRuntimeBackendId
  oauthAuthenticated?: boolean
  forcedLoginMethod?: CodexForcedLoginMethod | null
  settingsInline?: Record<string, unknown> | null
  apiKeyConfigured?: boolean
  featureFlagEnabled?: boolean
  nativeFeatureFlagEnabled?: boolean
  nativeInternalUnlockEnabled?: boolean
  nativeApiKeyConfigured?: boolean
  nativeBinaryDetected?: boolean
  chatgptLoginState?: CodexCliLoginState
}): CodexRuntimeResolution {
  const env = params?.env ?? process.env
  const featureFlagEnabled = params?.featureFlagEnabled ?? true
  const nativeFeatureFlagEnabled = params?.nativeFeatureFlagEnabled ?? true
  const nativeInternalUnlockEnabled =
    params?.nativeInternalUnlockEnabled ?? true
  const selectedBackendId = params?.preference ?? getCodexRuntimeBackendPreference(env)
  const oauthAuthenticated = params?.oauthAuthenticated ?? false
  const forcedLoginMethod =
    params?.forcedLoginMethod
    ?? getCodexForcedLoginMethod(params?.settingsInline ?? getFlagSettingsInline())
  const apiKeyConfigured = params?.apiKeyConfigured ?? Boolean(getCodexApiKey(env))
  const nativeApiKeyConfigured = params?.nativeApiKeyConfigured ?? apiKeyConfigured
  const nativeBinaryDetected =
    params?.nativeBinaryDetected ?? Boolean(Bun.which('codex'))
  const chatgptModePinned = forcedLoginMethod === 'chatgpt'
  const hostManagedChatGptAuthSelected =
    chatgptModePinned || (forcedLoginMethod == null && oauthAuthenticated)
  const chatgptLoginState =
    params?.chatgptLoginState
    ?? (hostManagedChatGptAuthSelected ? detectCodexCliLoginState() : 'unknown')
  const hostManagedChatGptAuthReady =
    hostManagedChatGptAuthSelected && chatgptLoginState === 'logged_in'
  const apiKeyFallbackAllowed = forcedLoginMethod !== 'chatgpt'

  const nativeBackendAvailable =
    nativeBinaryDetected &&
    (hostManagedChatGptAuthReady || (apiKeyFallbackAllowed && nativeApiKeyConfigured))
  const resolvedBackendId = nativeBackendAvailable ? 'codex-native' : null
  const authenticated = resolvedBackendId !== null
  const authMethod =
    resolvedBackendId == null
      ? null
      : hostManagedChatGptAuthReady
        ? 'oauth_token'
        : 'api_key'
  const canLoginFromUi = false

  let statusMessage: string | null
  let detailMessage: string | null
  if (authenticated) {
    statusMessage = 'Codex native runtime ready'
    detailMessage =
      authMethod === 'oauth_token'
        ? 'Codex native runtime is ready through the local codex exec seam using the host-managed ChatGPT account path.'
        : 'Codex native runtime is ready through the local codex exec seam.'
  } else if (!nativeBinaryDetected) {
    statusMessage = 'Codex native runtime unavailable'
    detailMessage =
      'Codex native runtime requires the codex CLI binary to be installed and discoverable.'
  } else if (!nativeApiKeyConfigured) {
    statusMessage = 'Codex native runtime unavailable'
    detailMessage =
      chatgptModePinned && chatgptLoginState !== 'logged_in'
        ? 'Codex native runtime requires an active `codex login` ChatGPT session.'
        : hostManagedChatGptAuthSelected && chatgptLoginState !== 'logged_in'
          ? `Codex native runtime requires an active \`codex login\` ChatGPT session or ${CODEX_NATIVE_API_KEY_ENV_VAR}/${OPENAI_API_KEY_ENV_VAR}.`
          : `Codex native runtime requires ${CODEX_NATIVE_API_KEY_ENV_VAR} or ${OPENAI_API_KEY_ENV_VAR}.`
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
