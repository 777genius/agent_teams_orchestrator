import { getFlagSettingsInline } from '../../bootstrap/state.js'
import { spawnSyncPortableCli } from '../../utils/portableCli.js'
import type { CodexRuntimeBackendId } from './types.js'

export const CODEX_NATIVE_API_KEY_ENV_VAR = 'CODEX_API_KEY'
export const OPENAI_API_KEY_ENV_VAR = 'OPENAI_API_KEY'
export const CODEX_CLI_PATH_ENV_VAR = 'CODEX_CLI_PATH'
export const CODEX_RUNTIME_BACKEND_ENV_VAR = 'CLAUDE_CODE_CODEX_BACKEND'
export const CODEX_FORCED_LOGIN_METHOD_ENV_VAR =
  'CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD'
export type CodexForcedLoginMethod = 'chatgpt' | 'api'
export type CodexCliLoginState = 'logged_in' | 'not_logged_in' | 'unknown'
export type CodexCliLoginProbeFailure = {
  reason: 'missing_binary' | 'execution_error' | 'terminated' | 'nonzero_exit'
  code?: string
  signal?: string
  exitCode?: number
}
export type CodexCliLoginProbeResult = {
  state: CodexCliLoginState
  failure?: CodexCliLoginProbeFailure
}
export type CodexCliBinarySource = 'configured-env' | 'system-path'

export type CodexCliBinaryResolution = {
  executablePath: string
  executableSource: CodexCliBinarySource
}

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
  authCheckIndeterminate: boolean
  authenticated: boolean
  authMethod: 'oauth_token' | 'api_key' | null
  canLoginFromUi: boolean
  statusMessage: string | null
  detailMessage: string | null
}

const CODEX_LOGIN_STATUS_CACHE_MS = 5_000
const CODEX_LOGIN_STATUS_TIMEOUT_MS = 10_000
const LOGIN_PROBE_ERROR_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ENOMEM', 'EAGAIN', 'EINVAL',
  'ENOTDIR', 'ENAMETOOLONG', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
])

let cachedCodexCliLoginState:
  | {
      checkedAtMs: number
      cacheKey: string
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
  env: NodeJS.ProcessEnv = process.env,
): CodexForcedLoginMethod | null {
  const codexSettings = asRecord(settingsInline)?.codex
  const forcedLoginMethod = asRecord(codexSettings)?.forced_login_method
  if (forcedLoginMethod === 'chatgpt' || forcedLoginMethod === 'api') {
    return forcedLoginMethod
  }

  const envForcedLoginMethod = env[CODEX_FORCED_LOGIN_METHOD_ENV_VAR]?.trim()
  return envForcedLoginMethod === 'chatgpt' || envForcedLoginMethod === 'api'
    ? envForcedLoginMethod
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

export function resolveCodexCliBinary(params?: {
  env?: NodeJS.ProcessEnv
  which?: (command: string) => string | null | undefined
}): CodexCliBinaryResolution | null {
  const env = params?.env ?? process.env
  const configuredPath = env[CODEX_CLI_PATH_ENV_VAR]?.trim()
  if (configuredPath) {
    return {
      executablePath: configuredPath,
      executableSource: 'configured-env',
    }
  }

  const which = params?.which ?? ((command: string) => Bun.which(command))
  const systemPath = which('codex')?.trim()
  if (!systemPath) {
    return null
  }

  return {
    executablePath: systemPath,
    executableSource: 'system-path',
  }
}

function getCodexLoginStateCacheKey(
  env: NodeJS.ProcessEnv,
  binaryResolution: CodexCliBinaryResolution | null,
): string {
  return [
    binaryResolution?.executableSource ?? 'missing',
    binaryResolution?.executablePath ?? '',
    env.CODEX_HOME?.trim() ?? '',
    env.HOME?.trim() ?? '',
    env.USERPROFILE?.trim() ?? '',
  ].join('\0')
}

export function probeCodexCliLoginState(
  nowMs: number = Date.now(),
  params?: {
    env?: NodeJS.ProcessEnv
    which?: (command: string) => string | null | undefined
    spawnSync?: typeof spawnSyncPortableCli
    monotonicNow?: () => number
  },
): CodexCliLoginProbeResult {
  const env = params?.env ?? process.env
  const codexBinary = resolveCodexCliBinary({
    env,
    which: params?.which,
  })
  const cacheKey = getCodexLoginStateCacheKey(env, codexBinary)
  if (
    cachedCodexCliLoginState
    && cachedCodexCliLoginState.cacheKey === cacheKey
    && nowMs - cachedCodexCliLoginState.checkedAtMs < CODEX_LOGIN_STATUS_CACHE_MS
  ) {
    return { state: cachedCodexCliLoginState.value }
  }

  if (!codexBinary) {
    return { state: 'unknown', failure: { reason: 'missing_binary' } }
  }

  let nextValue: CodexCliLoginState = 'unknown'
  let failure: CodexCliLoginProbeFailure | undefined
  const monotonicNow = params?.monotonicNow ?? (() => performance.now())
  const startedAt = monotonicNow()

  try {
    const result = (params?.spawnSync ?? spawnSyncPortableCli)(
      codexBinary.executablePath,
      ['login', 'status'],
      {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CODEX_LOGIN_STATUS_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    )
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()

    if (result.error) {
      failure = loginProbeFailure('execution_error', result.error, result.status, result.signal)
    } else if (result.signal) {
      failure = loginProbeFailure('terminated', null, result.status, result.signal)
    } else if (result.status === 0) {
      nextValue = 'logged_in'
    } else if (result.status != null && result.status > 0 && /not logged in/i.test(combinedOutput)) {
      nextValue = 'not_logged_in'
    } else {
      failure = loginProbeFailure('nonzero_exit', null, result.status, result.signal)
    }
  } catch (error) {
    failure = loginProbeFailure('execution_error', error)
  }

  const completedAtMs = nowMs + Math.max(0, monotonicNow() - startedAt)
  // An inconclusive probe must not suppress a fresh check on the next user retry.
  if (nextValue !== 'unknown') {
    cachedCodexCliLoginState = { checkedAtMs: completedAtMs, cacheKey, value: nextValue }
  }
  return { state: nextValue, ...(failure ? { failure } : {}) }
}

function loginProbeFailure(
  reason: CodexCliLoginProbeFailure['reason'],
  error: unknown,
  exitCode?: number | null,
  signal?: string | null,
): CodexCliLoginProbeFailure {
  const code = asRecord(error)?.code
  // Never expose raw messages, child output, or arbitrary error properties.
  return {
    reason,
    ...(typeof code === 'string' && LOGIN_PROBE_ERROR_CODES.has(code) ? { code } : {}),
    ...(typeof signal === 'string' && /^SIG[A-Z0-9]{1,20}$/.test(signal) ? { signal } : {}),
    ...(typeof exitCode === 'number' && Number.isInteger(exitCode) ? { exitCode } : {}),
  }
}

export function detectCodexCliLoginState(
  nowMs: number = Date.now(),
  params?: Parameters<typeof probeCodexCliLoginState>[1],
): CodexCliLoginState {
  return probeCodexCliLoginState(nowMs, params).state
}

function getLoginProbeFailureDetail(failure: CodexCliLoginProbeFailure | undefined): string {
  if (!failure) return ''
  return ` Probe: ${[
    `reason=${failure.reason}`,
    failure.code ? `code=${failure.code}` : null,
    failure.signal ? `signal=${failure.signal}` : null,
    failure.exitCode != null ? `exit=${failure.exitCode}` : null,
  ].filter(Boolean).join('; ')}.`
}

function getConfiguredCodexRuntimeContextDetail(
  env: NodeJS.ProcessEnv,
  binaryResolution: CodexCliBinaryResolution | null,
  loginState: CodexCliLoginState,
): string {
  if (!env[CODEX_CLI_PATH_ENV_VAR]?.trim() && !env.CODEX_HOME?.trim()) {
    return ''
  }

  const parts = [
    binaryResolution
      ? `binary=${binaryResolution.executableSource}:${binaryResolution.executablePath}`
      : 'binary=missing',
    env.CODEX_HOME?.trim() ? `CODEX_HOME=${env.CODEX_HOME.trim()}` : null,
    `login=${loginState}`,
  ].filter((part): part is string => Boolean(part))

  return ` Runtime context: ${parts.join('; ')}.`
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
    ?? getCodexForcedLoginMethod(params?.settingsInline ?? getFlagSettingsInline(), env)
  const apiKeyConfigured = params?.apiKeyConfigured ?? Boolean(getCodexApiKey(env))
  const nativeApiKeyConfigured = params?.nativeApiKeyConfigured ?? apiKeyConfigured
  const nativeBinaryResolution = resolveCodexCliBinary({ env })
  const nativeBinaryDetected =
    params?.nativeBinaryDetected ?? nativeBinaryResolution !== null
  const chatgptModePinned = forcedLoginMethod === 'chatgpt'
  const hostManagedChatGptAuthSelected =
    chatgptModePinned || (forcedLoginMethod == null && oauthAuthenticated)
  const loginProbe: CodexCliLoginProbeResult = params?.chatgptLoginState != null
    ? { state: params.chatgptLoginState }
    : hostManagedChatGptAuthSelected
      ? probeCodexCliLoginState(Date.now(), { env })
      : { state: 'unknown' }
  const chatgptLoginState = loginProbe.state
  const hostManagedChatGptAuthReady =
    hostManagedChatGptAuthSelected &&
    chatgptLoginState === 'logged_in'
  const authCheckIndeterminate =
    hostManagedChatGptAuthSelected && chatgptLoginState === 'unknown'
  const apiKeyFallbackAllowed = forcedLoginMethod !== 'chatgpt'

  const nativeBackendAvailable =
    nativeBinaryDetected &&
    !authCheckIndeterminate &&
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
  } else if (authCheckIndeterminate) {
    statusMessage = 'Codex login verification unavailable'
    detailMessage =
      `Codex login status could not be confirmed. Retry the status check before retrying the task.${getConfiguredCodexRuntimeContextDetail(
        env,
        nativeBinaryResolution,
        chatgptLoginState,
      )}${getLoginProbeFailureDetail(loginProbe.failure)}`
  } else if (!nativeApiKeyConfigured) {
    statusMessage = 'Codex native runtime unavailable'
    detailMessage =
      chatgptModePinned && chatgptLoginState !== 'logged_in'
        ? `Codex native runtime requires an active \`codex login\` ChatGPT session.${getConfiguredCodexRuntimeContextDetail(
            env,
            nativeBinaryResolution,
            chatgptLoginState,
          )}`
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
    authCheckIndeterminate,
    authenticated,
    authMethod,
    canLoginFromUi,
    statusMessage,
    detailMessage,
  }
}
