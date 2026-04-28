import { getAuthTokenSource, getAnthropicApiKeyWithSource } from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getGeminiApiVersion, getGeminiBaseUrl } from '../../utils/geminiAuth.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { GEMINI_MODELS } from '../../utils/model/gemini.js'
import { geminiApiBackend } from '../gemini/backends/apiBackend.js'
import { geminiCliBackend } from '../gemini/backends/cliBackend.js'
import {
  buildOpenCodeCapabilityInfo,
  buildOpenCodeDetailMessage,
  buildOpenCodeStatusMessage,
} from '../opencode/OpenCodeDiagnostics.js'
import { openCodeInventoryService } from '../opencode/OpenCodeInventoryService.js'
import type { GeminiBackendStatus } from '../gemini/types.js'
import {
  getAnthropicRuntimeFastModeCapability,
  getAnthropicRuntimeModelCatalog,
  getAnthropicRuntimeReasoningEfforts,
  getAnthropicVisibleRuntimeModels,
} from './anthropicCatalog.js'
import { buildAnthropicRuntimeStatus } from './anthropicStatus.js'
import {
  resolveCodexCliBinary,
  resolveCodexRuntimeSelection,
} from './codexBackendResolver.js'
import {
  getCodexRuntimeModelCatalog,
  getVisibleCodexRuntimeModels,
} from './codexModelCatalog.js'
import type {
  RuntimeBackendOptionAudience,
  CodexRuntimeBackendId,
  ExternalRuntimeDiagnostic,
  GeminiRuntimeBackendId,
  RuntimeBackendOptionState,
  RuntimeExtensionCapabilities,
  RuntimeBackendOptionStatus,
  RuntimeProviderModelCatalog,
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
  'codex-native': 'Codex native',
}

const CODEX_BACKEND_DESCRIPTIONS: Record<CodexRuntimeBackendId, string> = {
  'codex-native': 'Use the local codex exec JSON seam as the supported Codex runtime path',
}

function detectExternalBinary(
  binaryName: 'gemini' | 'codex',
  label: string,
): ExternalRuntimeDiagnostic {
  const binaryPath = Bun.which(binaryName)
  return {
    id: 'cli-bin',
    label,
    detected: Boolean(binaryPath),
    statusMessage: binaryPath ? `${label} detected` : `${label} not found`,
    detailMessage: binaryPath ?? null,
  }
}

function detectCodexExternalBinary(): ExternalRuntimeDiagnostic {
  const binaryResolution = resolveCodexCliBinary()
  return {
    id: 'cli-bin',
    label: 'Codex CLI',
    detected: Boolean(binaryResolution),
    statusMessage: binaryResolution ? 'Codex CLI detected' : 'Codex CLI not found',
    detailMessage: binaryResolution?.executablePath ?? null,
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
  state: RuntimeBackendOptionState = ok ? 'ready' : 'degraded',
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

type RuntimeStatusRegistryDeps = {
  getCodexModelCatalog?: typeof getCodexRuntimeModelCatalog
}

async function buildAnthropicStatus(): Promise<RuntimeProviderStatus> {
  const anthropicAuth = getAnthropicAuthenticated()
  const modelCatalog = await getAnthropicRuntimeModelCatalog()
  const reasoningEfforts = getAnthropicRuntimeReasoningEfforts(modelCatalog)
  const fastMode = getAnthropicRuntimeFastModeCapability()
  return buildAnthropicRuntimeStatus({
    auth: anthropicAuth,
    modelCatalog,
    visibleModels: getAnthropicVisibleRuntimeModels(modelCatalog),
    reasoningEfforts,
    fastMode,
    extensions: buildExtensionCapabilities(),
  })
}

function getGeminiModels(): string[] {
  return filterDisplayModels(GEMINI_MODELS.map(model => model.id))
}

function filterDisplayModels(models: string[]): string[] {
  return models.filter(model => isModelAllowed(model))
}

function filterCodexModelCatalog(
  catalog: RuntimeProviderModelCatalog,
): RuntimeProviderModelCatalog {
  const models = catalog.models.filter(
    model => isModelAllowed(model.launchModel) || isModelAllowed(model.id),
  )
  const defaultModel =
    models.find(
      model =>
        model.id === catalog.defaultModelId ||
        model.launchModel === catalog.defaultLaunchModel,
    ) ??
    models.find(model => model.isDefault) ??
    models.find(model => !model.hidden) ??
    models[0] ??
    null

  if (
    models.length === catalog.models.length &&
    defaultModel?.id === catalog.defaultModelId &&
    defaultModel?.launchModel === catalog.defaultLaunchModel
  ) {
    return catalog
  }

  return {
    ...catalog,
    defaultModelId: defaultModel?.id ?? null,
    defaultLaunchModel: defaultModel?.launchModel ?? null,
    models: models.map(model => ({
      ...model,
      isDefault:
        defaultModel !== null &&
        (model.id === defaultModel.id || model.launchModel === defaultModel.launchModel),
    })),
  }
}

async function buildOpenCodeStatus(): Promise<RuntimeProviderStatus> {
  const snapshot = await openCodeInventoryService.probe()
  const authenticated = snapshot.connectedProviders.length > 0

  return {
    providerId: 'opencode',
    displayName: 'OpenCode (75+ LLM providers)',
    supported: snapshot.detected,
    authenticated,
    authMethod: authenticated ? 'opencode_managed' : null,
    verificationState: !snapshot.detected
      ? 'offline'
      : snapshot.probeError && snapshot.models.length === 0 && !authenticated
        ? 'error'
        : 'verified',
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: snapshot.detected && authenticated,
      oneShot: false,
      extensions: buildExtensionCapabilities({
        plugins: {
          status: 'read-only',
          ownership: 'provider-scoped',
          reason: 'OpenCode manages plugin lifecycle. Desktop management wiring is not enabled yet.',
        },
        mcp: {
          status: 'read-only',
          ownership: 'provider-scoped',
          reason: 'OpenCode manages MCP lifecycle. Team launch uses app-owned runtime MCP proof.',
        },
        skills: {
          status: 'read-only',
          ownership: 'provider-scoped',
          reason: 'OpenCode skill roots are detected by the runtime, but desktop control is not enabled yet.',
        },
        apiKeys: {
          status: 'read-only',
          ownership: 'provider-scoped',
          reason: 'Provider credentials are managed through OpenCode providers and auth storage.',
        },
      }),
    },
    statusMessage: buildOpenCodeStatusMessage(snapshot),
    detailMessage: buildOpenCodeDetailMessage(snapshot),
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [
      {
        id: 'cli-bin',
        label: 'OpenCode CLI',
        detected: snapshot.detected,
        statusMessage: snapshot.detected ? 'OpenCode CLI detected' : 'OpenCode CLI not found',
        detailMessage: snapshot.binaryPath,
      },
    ],
    models: snapshot.models,
    backend: snapshot.detected
      ? {
          kind: 'opencode-cli',
          label: 'OpenCode CLI',
          authMethodDetail: snapshot.profile?.authState ?? null,
        }
      : null,
    capabilitiesInfo: buildOpenCodeCapabilityInfo(snapshot),
  }
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
  const codexNativeAvailable = resolution.resolvedBackendId === 'codex-native'
  const codexNativeState: RuntimeBackendOptionState = codexNativeAvailable
    ? 'ready'
    : !resolution.nativeBinaryDetected
      ? 'runtime-missing'
      : !resolution.nativeApiKeyConfigured
        ? 'authentication-required'
        : 'degraded'
  const codexNativeStatusMessage = codexNativeAvailable
    ? 'Ready'
    : !resolution.nativeBinaryDetected
      ? 'Codex CLI not found'
      : !resolution.nativeApiKeyConfigured
        ? 'Authentication required'
        : 'Degraded'

  return {
    selectedBackendId: resolution.selectedBackendId,
    resolvedBackendId: resolution.resolvedBackendId,
    availableBackends: [
      buildCodexOptionStatus(
        'codex-native',
        codexNativeAvailable,
        codexNativeStatusMessage,
        resolution.detailMessage,
        true,
        codexNativeAvailable,
        codexNativeState,
        'general',
      ),
    ],
    authenticated: resolution.authenticated,
    authMethod: resolution.authMethod,
    verificationState: resolution.authenticated ? 'verified' : 'unknown',
    statusMessage: resolution.statusMessage,
    detailMessage: resolution.detailMessage,
    canLoginFromUi: resolution.canLoginFromUi,
    backend:
      resolution.resolvedBackendId === 'codex-native'
        ? {
            kind: 'codex-native',
            label: 'Codex native',
            endpointLabel: 'codex exec --json',
            authMethodDetail: resolution.authMethod,
          }
        : null,
  }
}

export async function getUnifiedRuntimeStatusPayload(
  providerFilter?: RuntimeProviderId | null,
  deps: RuntimeStatusRegistryDeps = {},
): Promise<RuntimeStatusPayload> {
  const providers: Partial<Record<RuntimeProviderId, RuntimeProviderStatus>> = {}

  if (!providerFilter || providerFilter === 'anthropic') {
    providers.anthropic = await buildAnthropicStatus()
  }

  if (!providerFilter || providerFilter === 'codex') {
    const codex = buildCodexStatuses()
    const modelCatalog = filterCodexModelCatalog(
      await (deps.getCodexModelCatalog ?? getCodexRuntimeModelCatalog)(),
    )
    const codexModels = getVisibleCodexRuntimeModels(modelCatalog)
    const modelCatalogDynamic =
      modelCatalog.source === 'app-server' &&
      (modelCatalog.status === 'ready' || modelCatalog.status === 'stale')
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
              'Plugins are not currently guaranteed for codex-native sessions in the multimodel runtime.',
          },
        }),
      },
      statusMessage: codex.statusMessage,
      detailMessage: codex.detailMessage,
      selectedBackendId: codex.selectedBackendId,
      resolvedBackendId: codex.resolvedBackendId,
      availableBackends: codex.availableBackends,
      externalRuntimeDiagnostics: [detectCodexExternalBinary()],
      models: codexModels,
      modelCatalog,
      runtimeCapabilities: {
        modelCatalog: {
          dynamic: modelCatalogDynamic,
          source: modelCatalog.source,
        },
        reasoningEffort: {
          supported: true,
          values: ['minimal', 'low', 'medium', 'high', 'xhigh'],
          configPassthrough: true,
        },
      },
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

  if (!providerFilter || providerFilter === 'opencode') {
    providers.opencode = await buildOpenCodeStatus()
  }

  return {
    schemaVersion: 2,
    providers,
  }
}
