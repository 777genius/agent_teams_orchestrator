import { getAuthTokenSource, getAnthropicApiKeyWithSource } from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getGeminiApiVersion, getGeminiBaseUrl } from '../../utils/geminiAuth.js'
import {
  CLAUDE_HAIKU_4_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_SONNET_4_6_CONFIG,
} from '../../utils/model/configs.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { CODEX_MODELS } from '../../utils/model/codex.js'
import { GEMINI_MODELS } from '../../utils/model/gemini.js'
import { geminiApiBackend } from '../gemini/backends/apiBackend.js'
import { geminiCliBackend } from '../gemini/backends/cliBackend.js'
import type { GeminiBackendStatus } from '../gemini/types.js'
import {
  CODEX_NATIVE_INTERNAL_UNLOCK_ENV_VAR,
  resolveCodexRuntimeSelection,
} from './codexBackendResolver.js'
import type {
  RuntimeBackendOptionAudience,
  CodexRuntimeBackendId,
  ExternalRuntimeDiagnostic,
  GeminiRuntimeBackendId,
  RuntimeBackendOptionState,
  RuntimeExtensionCapabilities,
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
  api: 'OpenAI API',
  'codex-native': 'Codex native',
}

const CODEX_BACKEND_DESCRIPTIONS: Record<CodexRuntimeBackendId, string> = {
  auto: 'Automatically prefer the best available Codex runtime path',
  adapter: 'Use the built-in Codex fetch adapter',
  api: 'Use OPENAI_API_KEY with the public OpenAI Responses API',
  'codex-native': 'Use the local codex exec JSON seam under the experimental codex-native lane',
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

function buildExtensionCapabilities(
  overrides: Partial<RuntimeExtensionCapabilities> = {},
): RuntimeExtensionCapabilities {
  return {
    plugins: {
      status: 'supported',
      ownership: 'shared',
      reason: null,
    },
    mcp: {
      status: 'supported',
      ownership: 'shared',
      reason: null,
    },
    skills: {
      status: 'supported',
      ownership: 'shared',
      reason: null,
    },
    apiKeys: {
      status: 'supported',
      ownership: 'shared',
      reason: null,
    },
    ...overrides,
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

export function getGeminiRuntimeBackendPreference(): GeminiRuntimeBackendId {
  return normalizeGeminiBackendPreference(
    process.env.CLAUDE_CODE_GEMINI_BACKEND ?? getGlobalConfig().geminiBackendPreference,
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
    state: ok ? 'ready' : 'authentication-required',
    audience: 'general',
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
  selectable = true,
  state: RuntimeBackendOptionState = ok
    ? selectable
      ? 'ready'
      : 'locked'
    : 'degraded',
  audience: RuntimeBackendOptionAudience = 'general',
): RuntimeBackendOptionStatus {
  return {
    id,
    label: CODEX_BACKEND_LABELS[id],
    description: CODEX_BACKEND_DESCRIPTIONS[id],
    selectable,
    recommended,
    available: ok,
    state,
    audience,
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
  return filterDisplayModels([
    CLAUDE_SONNET_4_6_CONFIG.firstParty,
    `${CLAUDE_SONNET_4_6_CONFIG.firstParty}[1m]`,
    CLAUDE_OPUS_4_6_CONFIG.firstParty,
    `${CLAUDE_OPUS_4_6_CONFIG.firstParty}[1m]`,
    CLAUDE_HAIKU_4_5_CONFIG.firstParty,
  ])
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
      extensions: buildExtensionCapabilities(),
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
  return filterDisplayModels(CODEX_MODELS.map(model => model.id))
}

function getGeminiModels(): string[] {
  return filterDisplayModels(GEMINI_MODELS.map(model => model.id))
}

function filterDisplayModels(models: string[]): string[] {
  return models.filter(model => isModelAllowed(model))
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
  const resolution = resolveCodexRuntimeSelection()
  const showCodexNativeOption =
    resolution.nativeFeatureFlagEnabled || resolution.selectedBackendId === 'codex-native'
  const codexNativeReady = resolution.resolvedBackendId === 'codex-native'

  let codexNativeStatusMessage: string | null
  let codexNativeDetailMessage: string | null
  const codexNativeSelectable = codexNativeReady && resolution.nativeInternalUnlockEnabled
  let codexNativeState: RuntimeBackendOptionState

  if (codexNativeReady) {
    if (codexNativeSelectable) {
      codexNativeStatusMessage = 'Ready for internal use'
      codexNativeDetailMessage =
        'The local codex exec JSON seam is wired for internal codex-native usage. The lane remains non-default and auto never resolves into it.'
      codexNativeState = 'ready'
    } else {
      codexNativeStatusMessage = 'Ready but locked'
      codexNativeDetailMessage =
        `The local codex exec JSON seam is wired, but the lane stays locked until ${CODEX_NATIVE_INTERNAL_UNLOCK_ENV_VAR} is enabled for internal rollout.`
      codexNativeState = 'locked'
    }
  } else if (!resolution.nativeFeatureFlagEnabled) {
    codexNativeStatusMessage = 'Disabled'
    codexNativeDetailMessage =
      'Enable CLAUDE_CODE_CODEX_NATIVE_BETA to expose the codex-native lane.'
    codexNativeState = 'disabled'
  } else if (!resolution.nativeBinaryDetected) {
    codexNativeStatusMessage = 'Codex CLI not found'
    codexNativeDetailMessage =
      'Install a Codex runtime binary before enabling the codex-native lane.'
    codexNativeState = 'runtime-missing'
  } else if (!resolution.nativeApiKeyConfigured) {
    codexNativeStatusMessage = 'Authentication required'
    codexNativeDetailMessage =
      'Set CODEX_API_KEY to use the codex-native lane.'
    codexNativeState = 'authentication-required'
  } else {
    codexNativeStatusMessage = 'Degraded'
    codexNativeDetailMessage = 'Codex native runtime is not ready.'
    codexNativeState = 'degraded'
  }

  return {
    selectedBackendId: resolution.selectedBackendId,
    resolvedBackendId: resolution.resolvedBackendId,
    availableBackends: [
      buildCodexOptionStatus(
        'auto',
        resolution.resolvedBackendId !== null,
        resolution.resolvedBackendId
          ? `Resolved to ${CODEX_BACKEND_LABELS[resolution.resolvedBackendId]}`
          : 'Unavailable',
        resolution.detailMessage,
        true,
      ),
      buildCodexOptionStatus(
        'adapter',
        resolution.oauthAuthenticated,
        resolution.oauthAuthenticated ? 'Ready' : 'Authentication required',
        resolution.oauthAuthenticated
          ? 'Uses the local Codex OAuth session via the built-in adapter.'
          : 'Sign in with Codex OAuth to use the built-in adapter.',
      ),
      ...(resolution.featureFlagEnabled
        ? [
            buildCodexOptionStatus(
              'api',
              resolution.apiKeyConfigured,
              resolution.apiKeyConfigured ? 'Ready' : 'Authentication required',
              resolution.apiKeyConfigured
                ? 'Uses OPENAI_API_KEY with api.openai.com/v1/responses.'
                : 'Set OPENAI_API_KEY to use the public OpenAI Responses API.',
            ),
          ]
        : []),
      ...(showCodexNativeOption
        ? [
            buildCodexOptionStatus(
              'codex-native',
              codexNativeReady,
              codexNativeStatusMessage,
              codexNativeDetailMessage,
              false,
              codexNativeSelectable,
              codexNativeState,
              'internal',
            ),
          ]
        : []),
    ],
    authenticated: resolution.authenticated,
    authMethod: resolution.authMethod,
    verificationState: resolution.authenticated ? 'verified' : 'unknown',
    statusMessage: resolution.statusMessage,
    detailMessage: resolution.detailMessage,
    canLoginFromUi: resolution.canLoginFromUi,
    backend:
      resolution.resolvedBackendId === 'adapter'
        ? {
            kind: 'adapter',
            label: 'Default adapter',
            endpointLabel: 'chatgpt.com/backend-api/codex/responses',
            authMethodDetail: 'oauth_token',
          }
        : resolution.resolvedBackendId === 'api'
          ? {
              kind: 'api',
              label: 'OpenAI API',
              endpointLabel: 'api.openai.com/v1/responses',
              authMethodDetail: 'api_key',
            }
          : resolution.resolvedBackendId === 'codex-native'
            ? {
                kind: 'codex-native',
                label: 'Codex native',
                endpointLabel: 'codex exec --json',
                authMethodDetail: 'api_key',
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
        extensions: buildExtensionCapabilities({
          plugins: {
            status: 'unsupported',
            ownership: 'shared',
            reason:
              'Plugins are currently guaranteed only for Anthropic sessions in the multimodel runtime.',
          },
        }),
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
        extensions: buildExtensionCapabilities({
          plugins: {
            status: 'unsupported',
            ownership: 'shared',
            reason: 'Plugin execution is not currently guaranteed for Gemini sessions.',
          },
        }),
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
    schemaVersion: 2,
    providers,
  }
}
