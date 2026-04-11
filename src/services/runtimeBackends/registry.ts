import { getCodexOAuthTokens, getAuthTokenSource, getAnthropicApiKeyWithSource } from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getGeminiApiVersion, getGeminiBaseUrl } from '../../utils/geminiAuth.js'
import {
  CLAUDE_HAIKU_4_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_SONNET_4_6_CONFIG,
} from '../../utils/model/configs.js'
import { CODEX_MODELS } from '../../utils/model/codex.js'
import { GEMINI_MODELS } from '../../utils/model/gemini.js'
import { geminiApiBackend } from '../gemini/backends/apiBackend.js'
import { geminiCliBackend } from '../gemini/backends/cliBackend.js'
import type { GeminiBackendStatus } from '../gemini/types.js'
import type {
  CodexRuntimeBackendId,
  ExternalRuntimeDiagnostic,
  GeminiRuntimeBackendId,
  RuntimeBackendOptionStatus,
  RuntimeProviderId,
  RuntimeProviderStatus,
  RuntimeStatusPayload,
} from './types.js'

const GEMINI_BACKEND_LABELS: Record<GeminiRuntimeBackendId, string> = {
  auto: 'Auto',
  api: 'API',
  'cli-sdk': 'CLI SDK',
}

const GEMINI_BACKEND_DESCRIPTIONS: Record<GeminiRuntimeBackendId, string> = {
  auto: 'Automatically prefer the best available Gemini backend',
  api: 'Use Gemini API credentials directly',
  'cli-sdk': 'Use the embedded Gemini CLI SDK runtime',
}

const CODEX_BACKEND_LABELS: Record<CodexRuntimeBackendId, string> = {
  auto: 'Auto',
  adapter: 'Default adapter',
}

const CODEX_BACKEND_DESCRIPTIONS: Record<CodexRuntimeBackendId, string> = {
  auto: 'Automatically use the default Codex runtime path',
  adapter: 'Use the built-in Codex fetch adapter',
}

function detectExternalBinary(binaryName: 'gemini' | 'codex', label: string): ExternalRuntimeDiagnostic {
  const binaryPath = Bun.which(binaryName)
  return {
    id: 'cli-bin',
    label,
    detected: Boolean(binaryPath),
    statusMessage: binaryPath ? `${label} detected` : `${label} not found`,
    detailMessage: binaryPath ?? null,
  }
}

export function normalizeGeminiBackendPreference(
  value: string | null | undefined,
): GeminiRuntimeBackendId {
  if (value === 'api') return 'api'
  if (value === 'cli' || value === 'cli-sdk') return 'cli-sdk'
  return 'auto'
}

export function normalizeGeminiBackendStorageValue(
  value: string | null | undefined,
): 'auto' | 'api' | 'cli' {
  if (value === 'api') return 'api'
  if (value === 'cli' || value === 'cli-sdk') return 'cli'
  return 'auto'
}

export function normalizeCodexBackendPreference(
  value: string | null | undefined,
): CodexRuntimeBackendId {
  return value === 'adapter' ? 'adapter' : 'auto'
}

export function getGeminiRuntimeBackendPreference(): GeminiRuntimeBackendId {
  return normalizeGeminiBackendPreference(
    process.env.CLAUDE_CODE_GEMINI_BACKEND ?? getGlobalConfig().geminiBackendPreference,
  )
}

export function getCodexRuntimeBackendPreference(): CodexRuntimeBackendId {
  return normalizeCodexBackendPreference(
    process.env.CLAUDE_CODE_CODEX_BACKEND ?? getGlobalConfig().codexBackendPreference,
  )
}

function buildGeminiOptionStatus(
  id: GeminiRuntimeBackendId,
  ok: boolean,
  statusMessage: string | null,
  detailMessage: string | null,
  recommended = false,
): RuntimeBackendOptionStatus {
  return {
    id,
    label: GEMINI_BACKEND_LABELS[id],
    description: GEMINI_BACKEND_DESCRIPTIONS[id],
    selectable: true,
    recommended,
    available: ok,
    statusMessage,
    detailMessage,
  }
}

function buildCodexOptionStatus(
  id: CodexRuntimeBackendId,
  ok: boolean,
  statusMessage: string | null,
  detailMessage: string | null,
  recommended = false,
): RuntimeBackendOptionStatus {
  return {
    id,
    label: CODEX_BACKEND_LABELS[id],
    description: CODEX_BACKEND_DESCRIPTIONS[id],
    selectable: true,
    recommended,
    available: ok,
    statusMessage,
    detailMessage,
  }
}

function getAnthropicAuthenticated(): {
  authenticated: boolean
  authMethod: string | null
} {
  const { source: authTokenSource, hasToken } = getAuthTokenSource()
  const { source: apiKeySource } = getAnthropicApiKeyWithSource()
  const authenticated = hasToken || apiKeySource !== 'none'
  let authMethod: string | null = null

  if (authTokenSource === 'claude.ai') {
    authMethod = 'claude.ai'
  } else if (authTokenSource === 'apiKeyHelper') {
    authMethod = 'api_key_helper'
  } else if (authTokenSource !== 'none') {
    authMethod = 'oauth_token'
  } else if (apiKeySource === 'ANTHROPIC_API_KEY') {
    authMethod = 'api_key'
  } else if (apiKeySource === '/login managed key') {
    authMethod = 'claude.ai'
  }

  return { authenticated, authMethod }
}

function getAnthropicModels(): string[] {
  return [
    CLAUDE_SONNET_4_6_CONFIG.firstParty,
    `${CLAUDE_SONNET_4_6_CONFIG.firstParty}[1m]`,
    CLAUDE_OPUS_4_6_CONFIG.firstParty,
    `${CLAUDE_OPUS_4_6_CONFIG.firstParty}[1m]`,
    CLAUDE_HAIKU_4_5_CONFIG.firstParty,
  ]
}

function buildAnthropicStatus(): RuntimeProviderStatus {
  const anthropicAuth = getAnthropicAuthenticated()

  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: anthropicAuth.authenticated,
    authMethod: anthropicAuth.authMethod,
    verificationState: 'verified',
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
    },
    statusMessage: anthropicAuth.authenticated ? null : 'Not connected',
    detailMessage: null,
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    models: getAnthropicModels(),
    backend: null,
  }
}

function getCodexModels(): string[] {
  return CODEX_MODELS.map(model => model.id)
}

function getGeminiModels(): string[] {
  return GEMINI_MODELS.map(model => model.id)
}

async function buildGeminiStatuses(): Promise<{
  selectedBackendId: GeminiRuntimeBackendId
  resolvedBackendId: GeminiRuntimeBackendId | null
  availableBackends: RuntimeBackendOptionStatus[]
  authenticated: boolean
  authMethod: string | null
  verificationState: 'verified' | 'unknown' | 'offline' | 'error'
  statusMessage: string | null
  detailMessage: string | null
  canLoginFromUi: boolean
  backend: RuntimeProviderStatus['backend']
}> {
  const selectedBackendId = getGeminiRuntimeBackendPreference()
  const apiStatus = await geminiApiBackend.validate()
  const cliStatus = await geminiCliBackend.validate()

  const apiOption = buildGeminiOptionStatus(
    'api',
    apiStatus.ok,
    apiStatus.ok ? 'Ready' : 'Authentication required',
    apiStatus.message ?? null,
  )
  const cliOption = buildGeminiOptionStatus(
    'cli-sdk',
    cliStatus.ok,
    cliStatus.ok ? 'Ready' : 'Authentication required',
    cliStatus.message ?? null,
  )

  const autoResolvedBackendId: GeminiRuntimeBackendId | null = apiStatus.ok
    ? 'api'
    : cliStatus.ok
      ? 'cli-sdk'
      : null

  const resolvedBackendId =
    selectedBackendId === 'auto'
      ? autoResolvedBackendId
      : selectedBackendId === 'api'
        ? apiStatus.ok
          ? 'api'
          : null
        : cliStatus.ok
          ? 'cli-sdk'
          : null

  const autoStatusDetail =
    autoResolvedBackendId === 'api'
      ? 'Auto selected Gemini API'
      : autoResolvedBackendId === 'cli-sdk'
        ? 'Auto selected Gemini CLI SDK'
        : apiStatus.message ?? cliStatus.message ?? 'No Gemini backend is currently ready.'

  const autoOption = buildGeminiOptionStatus(
    'auto',
    autoResolvedBackendId !== null,
    autoResolvedBackendId ? `Resolved to ${GEMINI_BACKEND_LABELS[autoResolvedBackendId]}` : 'Unavailable',
    autoStatusDetail,
    true,
  )

  const preferredStatus: GeminiBackendStatus | null =
    resolvedBackendId === 'api'
      ? apiStatus
      : resolvedBackendId === 'cli-sdk'
        ? cliStatus
        : selectedBackendId === 'api'
          ? apiStatus
          : selectedBackendId === 'cli-sdk'
            ? cliStatus
            : null

  return {
    selectedBackendId,
    resolvedBackendId,
    availableBackends: [autoOption, apiOption, cliOption],
    authenticated: resolvedBackendId !== null,
    authMethod:
      preferredStatus?.authMethod && preferredStatus.authMethod !== 'none'
        ? preferredStatus.authMethod
        : null,
    verificationState: resolvedBackendId ? 'verified' : 'unknown',
    statusMessage:
      resolvedBackendId !== null
        ? selectedBackendId === 'auto'
          ? `Resolved to ${GEMINI_BACKEND_LABELS[resolvedBackendId]}`
          : `${GEMINI_BACKEND_LABELS[selectedBackendId]} ready`
        : selectedBackendId === 'api'
          ? 'Gemini API not ready'
          : selectedBackendId === 'cli-sdk'
            ? 'Gemini CLI SDK not ready'
            : 'No Gemini runtime backend is ready',
    detailMessage: preferredStatus?.message ?? autoStatusDetail,
    canLoginFromUi: selectedBackendId !== 'api',
    backend:
      resolvedBackendId === 'api'
        ? {
            kind: 'api',
            label: 'Gemini API',
            endpointLabel: apiStatus.endpointLabel ?? `${getGeminiBaseUrl()}/${getGeminiApiVersion()}`,
            projectId: apiStatus.projectId ?? null,
            authMethodDetail:
              preferredStatus?.authMethod && preferredStatus.authMethod !== 'none'
                ? preferredStatus.authMethod
                : null,
          }
        : resolvedBackendId === 'cli-sdk'
          ? {
              kind: 'cli-sdk',
              label: 'Gemini CLI SDK',
              endpointLabel: cliStatus.endpointLabel,
              projectId: cliStatus.projectId ?? null,
              authMethodDetail:
                preferredStatus?.authMethod && preferredStatus.authMethod !== 'none'
                  ? preferredStatus.authMethod
                  : null,
            }
          : null,
  }
}

function buildCodexStatuses(): {
  selectedBackendId: CodexRuntimeBackendId
  resolvedBackendId: CodexRuntimeBackendId | null
  availableBackends: RuntimeBackendOptionStatus[]
  authenticated: boolean
  authMethod: string | null
  verificationState: 'verified' | 'unknown' | 'offline' | 'error'
  statusMessage: string | null
  detailMessage: string | null
  canLoginFromUi: boolean
  backend: RuntimeProviderStatus['backend']
} {
  const selectedBackendId = getCodexRuntimeBackendPreference()
  const tokens = getCodexOAuthTokens()
  const authenticated = Boolean(tokens?.accessToken)
  const resolvedBackendId = authenticated ? 'adapter' : null
  const detailMessage = authenticated
    ? 'Codex adapter is ready'
    : 'Codex OAuth session not found. Sign in to use the built-in adapter.'

  return {
    selectedBackendId,
    resolvedBackendId:
      selectedBackendId === 'auto'
        ? resolvedBackendId
        : selectedBackendId === 'adapter'
          ? authenticated
            ? 'adapter'
            : null
          : null,
    availableBackends: [
      buildCodexOptionStatus(
        'auto',
        authenticated,
        authenticated ? 'Resolved to Default adapter' : 'Unavailable',
        detailMessage,
        true,
      ),
      buildCodexOptionStatus(
        'adapter',
        authenticated,
        authenticated ? 'Ready' : 'Authentication required',
        detailMessage,
      ),
    ],
    authenticated,
    authMethod: authenticated ? 'oauth_token' : null,
    verificationState: authenticated ? 'verified' : 'unknown',
    statusMessage: authenticated ? 'Default adapter ready' : 'Codex adapter not ready',
    detailMessage,
    canLoginFromUi: true,
    backend: authenticated
      ? {
          kind: 'adapter',
          label: 'Default adapter',
          endpointLabel: 'chatgpt.com/backend-api/codex/responses',
          authMethodDetail: 'oauth_token',
        }
      : null,
  }
}

export async function getUnifiedRuntimeStatusPayload(
  providerFilter?: RuntimeProviderId | null,
): Promise<RuntimeStatusPayload> {
  const providers: Partial<Record<RuntimeProviderId, RuntimeProviderStatus>> = {}

  if (!providerFilter || providerFilter === 'anthropic') {
    providers.anthropic = buildAnthropicStatus()
  }

  if (!providerFilter || providerFilter === 'codex') {
    const codex = buildCodexStatuses()
    providers.codex = {
      providerId: 'codex',
      displayName: 'Codex',
      supported: true,
      authenticated: codex.authenticated,
      authMethod: codex.authMethod,
      verificationState: codex.verificationState,
      canLoginFromUi: codex.canLoginFromUi,
      capabilities: {
        teamLaunch: true,
        oneShot: true,
      },
      statusMessage: codex.statusMessage,
      detailMessage: codex.detailMessage,
      selectedBackendId: codex.selectedBackendId,
      resolvedBackendId: codex.resolvedBackendId,
      availableBackends: codex.availableBackends,
      externalRuntimeDiagnostics: [detectExternalBinary('codex', 'Codex CLI')],
      models: getCodexModels(),
      backend: codex.backend,
    }
  }

  if (!providerFilter || providerFilter === 'gemini') {
    const gemini = await buildGeminiStatuses()
    providers.gemini = {
      providerId: 'gemini',
      displayName: 'Gemini',
      supported: true,
      authenticated: gemini.authenticated,
      authMethod: gemini.authMethod,
      verificationState: gemini.verificationState,
      canLoginFromUi: gemini.canLoginFromUi,
      capabilities: {
        teamLaunch: true,
        oneShot: true,
      },
      statusMessage: gemini.statusMessage,
      detailMessage: gemini.detailMessage,
      selectedBackendId: gemini.selectedBackendId,
      resolvedBackendId: gemini.resolvedBackendId,
      availableBackends: gemini.availableBackends,
      externalRuntimeDiagnostics: [detectExternalBinary('gemini', 'Gemini CLI')],
      models: getGeminiModels(),
      backend: gemini.backend,
    }
  }

  return {
    schemaVersion: 1,
    providers,
  }
}
