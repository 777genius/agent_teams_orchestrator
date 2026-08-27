import {
  getAuthTokenSource,
  getAnthropicApiKeyWithSource,
} from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  getGeminiApiVersion,
  getGeminiBaseUrl,
} from '../../utils/geminiAuth.js'
import {
  getAPIProvider,
  type APIProvider,
} from '../../utils/model/providers.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { CODEX_MODELS } from '../../utils/model/codex.js'
import { GEMINI_MODELS } from '../../utils/model/gemini.js'
import { geminiApiBackend } from '../gemini/backends/apiBackend.js'
import { geminiCliBackend } from '../gemini/backends/cliBackend.js'
import type { OpenCodeInventorySnapshot } from '../opencode/types.js'
import type { GeminiBackendStatus } from '../gemini/types.js'
import {
  getAnthropicCompatibleRuntimeBackendLabel,
  getAnthropicCustomAuthorizationHeader,
  getAnthropicRuntimeFastModeCapability,
  getAnthropicRuntimeModelCatalog,
  getAnthropicRuntimeReasoningEfforts,
  getAnthropicVisibleRuntimeModels,
  isAnthropicCompatibleRuntimeBaseUrl,
} from './anthropicCatalog.js'
import { getAnthropicSubscriptionRateLimitSnapshotForRuntimeStatus } from './anthropicSubscriptionRateLimits.js'
import {
  type AnthropicRuntimeBackendInfo,
  buildAnthropicRuntimeStatus,
  isAnthropicSubscriptionAuthMethod,
} from './anthropicStatus.js'
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
  RuntimeReasoningEffort,
  RuntimeProviderStatus,
  RuntimeProviderSubscriptionRateLimitSnapshot,
  RuntimeStatusDetailLevel,
  RuntimeStatusPayload,
} from './types.js'
import {
  buildOpenCodePassiveRuntimeStatus,
  dispatchOpenCodeRuntimeStatus,
  type OpenCodePassiveRuntimeStatusDeps,
} from './openCodePassiveStatus.js'

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
  'codex-native':
    'Use the local codex exec JSON seam as the supported Codex runtime path',
}

const ANTHROPIC_SUMMARY_MODELS = ['opus', 'claude-opus-4-6', 'sonnet', 'haiku']
const ANTHROPIC_SUMMARY_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'max',
] as const

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
    statusMessage: binaryResolution
      ? 'Codex CLI detected'
      : 'Codex CLI not found',
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
    process.env.CLAUDE_CODE_GEMINI_BACKEND ??
      getGlobalConfig().geminiBackendPreference,
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

function getClaudePlatformAwsBackendInfo(): AnthropicRuntimeBackendInfo | null {
  const workspaceId = process.env.ANTHROPIC_AWS_WORKSPACE_ID?.trim()
  if (!workspaceId) {
    return null
  }

  const region =
    (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION)?.trim() || null
  const usesApiKey = Boolean(process.env.ANTHROPIC_AWS_API_KEY?.trim())
  if (!region) {
    return {
      id: 'claude-platform-aws',
      label: 'Claude Platform on AWS',
      endpointLabel: 'AWS region not configured',
      projectId: workspaceId,
      authenticated: false,
      authMethodDetail: 'aws_platform_configuration_incomplete',
      statusMessage:
        'Claude Platform on AWS requires AWS_REGION or AWS_DEFAULT_REGION',
      detailMessage:
        'Set AWS_REGION or AWS_DEFAULT_REGION to the region bound to the Claude Platform on AWS workspace.',
    }
  }

  return {
    id: 'claude-platform-aws',
    label: 'Claude Platform on AWS',
    endpointLabel: `AWS region ${region}`,
    projectId: workspaceId,
    authenticated: false,
    authMethodDetail: usesApiKey
      ? 'aws_platform_api_key_transport_unavailable'
      : 'aws_platform_sigv4_transport_unavailable',
    statusMessage: 'Claude Platform on AWS transport is not enabled',
    detailMessage:
      'Claude Platform on AWS was detected, but this runtime does not include the AnthropicAws request transport yet. Amazon Bedrock remains supported through CLAUDE_CODE_USE_BEDROCK.',
  }
}

function getAnthropicCompatibleBackendInfo(): AnthropicRuntimeBackendInfo | null {
  if (!isAnthropicCompatibleRuntimeBaseUrl()) {
    return null
  }

  const backendId = getAnthropicCompatibleRuntimeBackendLabel()
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim() ?? ''
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? ''
  const customAuthorization = getAnthropicCustomAuthorizationHeader()
  const hasAuth = Boolean(authToken || apiKey || customAuthorization)
  const authMethodDetail = authToken
    ? backendId === 'ollama' && authToken.toLowerCase() === 'ollama'
      ? 'ollama_token'
      : 'anthropic_compatible_bearer_token'
    : apiKey
      ? 'anthropic_compatible_api_key'
      : customAuthorization
        ? 'anthropic_compatible_custom_authorization'
        : 'anthropic_compatible_no_auth'

  return {
    id: backendId,
    label: backendId === 'ollama' ? 'Ollama' : 'Anthropic-compatible API',
    endpointLabel: process.env.ANTHROPIC_BASE_URL?.trim() ?? null,
    authenticated: hasAuth,
    authMethodDetail,
    statusMessage:
      backendId === 'ollama'
        ? 'Configured for Ollama'
        : 'Configured for Anthropic-compatible API',
    detailMessage: hasAuth
      ? 'Requests use the configured ANTHROPIC_BASE_URL and Anthropic-compatible auth environment.'
      : 'Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY for this Anthropic-compatible endpoint.',
  }
}

function getExternalAnthropicBackendInfo(
  apiProvider: APIProvider,
): AnthropicRuntimeBackendInfo | null {
  switch (apiProvider) {
    case 'bedrock': {
      const usesBearerToken = Boolean(
        process.env.AWS_BEARER_TOKEN_BEDROCK?.trim(),
      )
      const skipsAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)
      const authMethodDetail = usesBearerToken
        ? 'bedrock_api_key'
        : skipsAuth
          ? 'bedrock_skip_auth'
          : 'aws_credentials'
      const region =
        process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null
      return {
        id: 'bedrock',
        label: 'Amazon Bedrock',
        endpointLabel: region ? `AWS region ${region}` : 'Amazon Bedrock',
        authMethodDetail,
        statusMessage: 'Configured for Amazon Bedrock',
        detailMessage:
          'Authentication is handled by AWS credentials, AWS SSO, Bedrock API keys, or the configured Bedrock gateway.',
      }
    }
    case 'vertex': {
      const authMethodDetail = isEnvTruthy(
        process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH,
      )
        ? 'vertex_skip_auth'
        : 'gcp_credentials'
      const projectId =
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT_ID ||
        process.env.GCLOUD_PROJECT ||
        process.env.ANTHROPIC_VERTEX_PROJECT_ID ||
        null
      return {
        id: 'vertex',
        label: 'Google Vertex AI',
        endpointLabel: process.env.CLOUD_ML_REGION
          ? `Vertex region ${process.env.CLOUD_ML_REGION}`
          : 'Google Vertex AI',
        projectId,
        authMethodDetail,
        statusMessage: 'Configured for Google Vertex AI',
        detailMessage:
          'Authentication is handled by Google ADC, service account credentials, gcloud auth, or the configured Vertex gateway.',
      }
    }
    case 'foundry': {
      const authMethodDetail = process.env.ANTHROPIC_FOUNDRY_API_KEY
        ? 'foundry_api_key'
        : isEnvTruthy(process.env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH)
          ? 'foundry_skip_auth'
          : 'azure_credentials'
      return {
        id: 'foundry',
        label: 'Azure AI Foundry',
        endpointLabel:
          process.env.ANTHROPIC_FOUNDRY_RESOURCE ?? 'Azure AI Foundry',
        authMethodDetail,
        statusMessage: 'Configured for Azure AI Foundry',
        detailMessage:
          'Authentication is handled by Azure credentials, a Foundry API key, or the configured Foundry gateway.',
      }
    }
    default:
      return apiProvider === 'firstParty'
        ? (getAnthropicCompatibleBackendInfo() ??
            getClaudePlatformAwsBackendInfo())
        : null
  }
}

function getAnthropicAuthenticated(): {
  authenticated: boolean
  authMethod: string | null
} {
  const externalBackend = getExternalAnthropicBackendInfo(getAPIProvider())
  if (externalBackend) {
    return {
      authenticated: externalBackend.authenticated ?? true,
      authMethod: externalBackend.authMethodDetail,
    }
  }

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

type RuntimeStatusRegistryDeps = OpenCodePassiveRuntimeStatusDeps & {
  getCodexModelCatalog?: typeof getCodexRuntimeModelCatalog
  getAnthropicSubscriptionRateLimits?: (
    authMethod: string | null,
  ) =>
    | RuntimeProviderSubscriptionRateLimitSnapshot
    | null
    | Promise<RuntimeProviderSubscriptionRateLimitSnapshot | null>
  getOpenCodeInventorySnapshot?: () => Promise<OpenCodeInventorySnapshot>
  openCodeInventoryTimeoutMs?: number
}

async function buildAnthropicStatus(
  deps: RuntimeStatusRegistryDeps = {},
): Promise<RuntimeProviderStatus> {
  const externalBackend = getExternalAnthropicBackendInfo(getAPIProvider())
  const anthropicAuth = getAnthropicAuthenticated()
  const modelCatalog = await getAnthropicRuntimeModelCatalog()
  const reasoningEfforts = getAnthropicRuntimeReasoningEfforts(modelCatalog)
  const fastMode = getAnthropicRuntimeFastModeCapability()
  const subscriptionRateLimits = isAnthropicSubscriptionAuthMethod(
    anthropicAuth.authMethod,
  )
    ? deps.getAnthropicSubscriptionRateLimits
      ? await deps.getAnthropicSubscriptionRateLimits(anthropicAuth.authMethod)
      : await getAnthropicSubscriptionRateLimitSnapshotForRuntimeStatus({
          authMethod: anthropicAuth.authMethod,
        })
    : null
  return buildAnthropicRuntimeStatus({
    auth: anthropicAuth,
    modelCatalog,
    visibleModels: getAnthropicVisibleRuntimeModels(modelCatalog),
    reasoningEfforts,
    fastMode,
    extensions: buildExtensionCapabilities(),
    subscriptionRateLimits,
    backend: externalBackend,
  })
}

async function buildAnthropicSummaryStatus(
  _deps: RuntimeStatusRegistryDeps = {},
): Promise<RuntimeProviderStatus> {
  const externalBackend = getExternalAnthropicBackendInfo(getAPIProvider())
  const anthropicAuth = getAnthropicAuthenticated()
  const fastMode = getAnthropicRuntimeFastModeCapability()
  const backend = externalBackend ?? null
  const modelCatalogSource =
    backend?.id === 'ollama' || backend?.id === 'anthropic-compatible'
      ? 'anthropic-compatible-api'
      : 'anthropic-models-api'
  const summaryModels =
    modelCatalogSource === 'anthropic-compatible-api'
      ? []
      : ANTHROPIC_SUMMARY_MODELS.filter(isModelAllowed)

  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: anthropicAuth.authenticated,
    authMethod: anthropicAuth.authMethod,
    verificationState: backend ? 'unknown' : 'verified',
    canLoginFromUi: backend ? false : true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: buildExtensionCapabilities(),
    },
    statusMessage: backend
      ? backend.statusMessage
      : anthropicAuth.authenticated
        ? null
        : 'Not connected',
    detailMessage: backend?.detailMessage ?? null,
    selectedBackendId: backend?.id ?? null,
    resolvedBackendId: backend?.id ?? null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    models: summaryModels,
    subscriptionRateLimits: null,
    runtimeCapabilities: {
      modelCatalog: {
        dynamic: true,
        source: modelCatalogSource,
      },
      reasoningEffort: {
        supported: true,
        values: [...ANTHROPIC_SUMMARY_REASONING_EFFORTS],
        configPassthrough: true,
      },
      fastMode,
    },
    backend: backend
      ? {
          kind: backend.id,
          label: backend.label,
          endpointLabel: backend.endpointLabel,
          projectId: backend.projectId ?? null,
          authMethodDetail: backend.authMethodDetail,
        }
      : null,
  }
}

function getGeminiModels(): string[] {
  return filterDisplayModels(GEMINI_MODELS.map((model) => model.id))
}

function filterDisplayModels(models: string[]): string[] {
  return models.filter((model) => isModelAllowed(model))
}

function getCodexSummaryModels(): string[] {
  return filterDisplayModels(CODEX_MODELS.map((model) => model.id))
}

function filterCodexModelCatalog(
  catalog: RuntimeProviderModelCatalog,
): RuntimeProviderModelCatalog {
  const models = catalog.models.filter(
    (model) => isModelAllowed(model.launchModel) || isModelAllowed(model.id),
  )
  const defaultModel =
    models.find(
      (model) =>
        model.id === catalog.defaultModelId ||
        model.launchModel === catalog.defaultLaunchModel,
    ) ??
    models.find((model) => model.isDefault) ??
    models.find((model) => !model.hidden) ??
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
    models: models.map((model) => ({
      ...model,
      isDefault:
        defaultModel !== null &&
        (model.id === defaultModel.id ||
          model.launchModel === defaultModel.launchModel),
    })),
  }
}

function getOpenCodeModelReasoningProfile(modelId: string): {
  supportedReasoningEfforts: RuntimeReasoningEffort[]
  defaultReasoningEffort: RuntimeReasoningEffort | null
} {
  if (modelId.trim().toLowerCase() === 'kimi-for-coding/k3') {
    return {
      supportedReasoningEfforts: ['low', 'high', 'max'],
      defaultReasoningEffort: 'high',
    }
  }
  return {
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
  }
}

async function buildOpenCodeStatus(
  deps: RuntimeStatusRegistryDeps = {},
  options: { detailLevel?: RuntimeStatusDetailLevel } = {},
): Promise<RuntimeProviderStatus> {
  return dispatchOpenCodeRuntimeStatus(options.detailLevel, {
    readPassive: () => buildOpenCodePassiveRuntimeStatus(deps),
    readActive: () => buildOpenCodeActiveStatus(deps),
  })
}

async function buildOpenCodeActiveStatus(
  deps: RuntimeStatusRegistryDeps = {},
): Promise<RuntimeProviderStatus> {
  const [diagnostics, inventoryModule, modelAccess, agentCompatibility] = await Promise.all([
    import('../opencode/OpenCodeDiagnostics.js'),
    import('../opencode/OpenCodeInventoryService.js'),
    import('../opencode/OpenCodeModelAccessPolicy.js'),
    import('../opencode/OpenCodeAgentModelCompatibility.js'),
  ])
  const {
    buildOpenCodeCapabilityInfo,
    buildOpenCodeDetailMessage,
    buildOpenCodeStatusMessage,
  } = diagnostics
  const {
    OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS,
    createOpenCodeInventoryProbeProgressTracker,
    hasOpenCodeBuiltinFreeModel,
    isOpenCodeModelFree,
    openCodeInventoryService,
    withOpenCodeInventoryProbeTimeout,
  } = inventoryModule
  const {
    buildOpenCodeModelAccessCatalogFromInventorySnapshot,
    buildOpenCodeModelRouteMetadata,
    hasOpenCodeConfiguredAuthlessModel,
  } = modelAccess
  const {
    evaluateOpenCodeAgentModelCompatibility,
    filterOpenCodeAgentModels,
    getOpenCodeModelInputModalities,
  } = agentCompatibility
  const timeoutMs =
    deps.openCodeInventoryTimeoutMs ??
    OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS
  const abortController = new AbortController()
  const progress = createOpenCodeInventoryProbeProgressTracker()
  const snapshot = await withOpenCodeInventoryProbeTimeout(
    deps.getOpenCodeInventorySnapshot
      ? deps.getOpenCodeInventorySnapshot()
      : openCodeInventoryService.probe(
          null,
          {
            mode: 'full',
            includeAppMcp: false,
            abortSignal: abortController.signal,
            progress,
          },
        ),
    {
      timeoutMs,
      progress,
      onTimeout: () => abortController.abort(),
    },
  )
  const runtimeModels = snapshot.models
  const agentModels = filterOpenCodeAgentModels(runtimeModels, snapshot.modelMetadata)
  const hasConnectedProvider = snapshot.connectedProviders.length > 0
  const hasBuiltinFreeModel = hasOpenCodeBuiltinFreeModel(
    snapshot.models,
    snapshot.modelMetadata,
  )
  const hasConfiguredAuthlessModel = hasOpenCodeConfiguredAuthlessModel(
    buildOpenCodeModelAccessCatalogFromInventorySnapshot(snapshot),
  )
  const accessCatalog =
    buildOpenCodeModelAccessCatalogFromInventorySnapshot(snapshot)
  const authenticated =
    hasConnectedProvider || hasBuiltinFreeModel || hasConfiguredAuthlessModel
  const fetchedAt = new Date()
  const defaultModel =
    agentModels.find((model) => model === 'opencode/big-pickle') ??
    agentModels[0] ??
    null
  const metadataByModelId = new Map(
    snapshot.modelMetadata?.map((metadata) => [metadata.id, metadata]) ?? [],
  )
  const modelCatalog: RuntimeProviderModelCatalog = {
    schemaVersion: 1,
    providerId: 'opencode',
    source: 'app-server',
    status: snapshot.detected ? 'ready' : 'unavailable',
    fetchedAt: fetchedAt.toISOString(),
    staleAt: new Date(fetchedAt.getTime() + 10 * 60 * 1000).toISOString(),
    defaultModelId: defaultModel,
    defaultLaunchModel: defaultModel,
    models: runtimeModels.map((model) => {
      const metadata = metadataByModelId.get(model) ?? null
      const agentCompatibility = evaluateOpenCodeAgentModelCompatibility(model, metadata)
      const reasoningProfile = getOpenCodeModelReasoningProfile(model)
      const opencodeMetadata = buildOpenCodeModelRouteMetadata({
        selectedModel: model,
        catalog: accessCatalog,
      })
      return {
        id: model,
        launchModel: model,
        displayName: model,
        hidden: !agentCompatibility.compatible,
        supportedReasoningEfforts: reasoningProfile.supportedReasoningEfforts,
        defaultReasoningEffort: reasoningProfile.defaultReasoningEffort,
        inputModalities: getOpenCodeModelInputModalities(metadata),
        supportsPersonality: true,
        isDefault: model === defaultModel,
        upgrade: false,
        source: 'app-server',
        badgeLabel: isOpenCodeModelFree(model, snapshot.modelMetadata)
          ? 'Free'
          : null,
        statusMessage: agentCompatibility.reason,
        metadata: metadata
          ? {
              cost: metadata.cost,
              context: metadata.context,
              limits: metadata.limits,
              free: metadata.free,
              releaseDate:
                typeof metadata.raw.release_date === 'string'
                  ? metadata.raw.release_date
                  : null,
              opencode: opencodeMetadata,
            }
          : {
              opencode: opencodeMetadata,
            },
      }
    }),
    diagnostics: {
      configReadState: snapshot.detected ? 'ready' : 'skipped',
      appServerState: snapshot.detected ? 'healthy' : 'runtime-missing',
      message: snapshot.probeError,
      code: snapshot.probeError ? 'opencode-probe-error' : null,
    },
  }

  const provider: RuntimeProviderStatus = {
    providerId: 'opencode',
    displayName: 'OpenCode (75+ LLM providers)',
    supported: snapshot.detected,
    authenticated,
    authMethod: hasConnectedProvider
      ? 'opencode_managed'
      : hasBuiltinFreeModel
        ? 'opencode_builtin_free'
        : hasConfiguredAuthlessModel
          ? 'opencode_configured_local'
          : null,
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
          reason:
            'OpenCode manages plugin lifecycle. Desktop management wiring is not enabled yet.',
        },
        mcp: {
          status: 'read-only',
          ownership: 'provider-scoped',
          reason:
            'OpenCode manages MCP lifecycle. Team launch uses app-owned runtime MCP proof.',
        },
        skills: {
          status: 'read-only',
          ownership: 'provider-scoped',
          reason:
            'OpenCode skill roots are detected by the runtime, but desktop control is not enabled yet.',
        },
        apiKeys: {
          status: 'read-only',
          ownership: 'provider-scoped',
          reason:
            'Provider credentials are managed through OpenCode providers and auth storage.',
        },
      }),
    },
    statusMessage: authenticated ? null : buildOpenCodeStatusMessage(snapshot),
    detailMessage: buildOpenCodeDetailMessage(snapshot),
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [
      {
        id: 'cli-bin',
        label: 'OpenCode CLI',
        detected: snapshot.detected,
        statusMessage: snapshot.detected
          ? 'OpenCode CLI detected'
          : 'OpenCode CLI not found',
        detailMessage: snapshot.binaryPath,
      },
    ],
    models: agentModels,
    runtimeCapabilities: {
      modelCatalog: {
        dynamic: true,
        source: 'app-server',
      },
    },
    backend: snapshot.detected
      ? {
          kind: 'opencode-cli',
          label: 'OpenCode CLI',
          authMethodDetail: hasConnectedProvider
            ? (snapshot.profile?.authState ?? null)
            : hasBuiltinFreeModel
              ? 'built-in free models'
              : hasConfiguredAuthlessModel
                ? 'configured local OpenCode model'
                : (snapshot.profile?.authState ?? null),
        }
      : null,
  }

  provider.modelCatalog = modelCatalog
  provider.capabilitiesInfo = buildOpenCodeCapabilityInfo(snapshot)

  return provider
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
        : (apiStatus.message ??
          cliStatus.message ??
          'No Gemini backend is currently ready.')

  const autoOption = buildGeminiOptionStatus(
    'auto',
    autoResolvedBackendId !== null,
    autoResolvedBackendId
      ? `Resolved to ${GEMINI_BACKEND_LABELS[autoResolvedBackendId]}`
      : 'Unavailable',
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
            endpointLabel:
              apiStatus.endpointLabel ??
              `${getGeminiBaseUrl()}/${getGeminiApiVersion()}`,
            projectId: apiStatus.projectId ?? null,
            authMethodDetail:
              preferredStatus?.authMethod &&
              preferredStatus.authMethod !== 'none'
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
                preferredStatus?.authMethod &&
                preferredStatus.authMethod !== 'none'
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
  options: { detailLevel?: RuntimeStatusDetailLevel } = {},
): Promise<RuntimeStatusPayload> {
  const summary = options.detailLevel === 'summary'
  const providers: Partial<Record<RuntimeProviderId, RuntimeProviderStatus>> =
    {}

  if (!providerFilter || providerFilter === 'anthropic') {
    providers.anthropic = summary
      ? await buildAnthropicSummaryStatus(deps)
      : await buildAnthropicStatus(deps)
  }

  if (!providerFilter || providerFilter === 'codex') {
    const codex = buildCodexStatuses()
    if (summary) {
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
        models: getCodexSummaryModels(),
        runtimeCapabilities: {
          modelCatalog: {
            dynamic: true,
            source: 'app-server',
          },
          reasoningEffort: {
            supported: true,
            values: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
            configPassthrough: true,
          },
        },
        backend: codex.backend,
      }
    } else {
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
            values: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
            configPassthrough: true,
          },
        },
        backend: codex.backend,
      }
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
            reason:
              'Plugin execution is not currently guaranteed for Gemini sessions.',
          },
        }),
      },
      statusMessage: gemini.statusMessage,
      detailMessage: gemini.detailMessage,
      selectedBackendId: gemini.selectedBackendId,
      resolvedBackendId: gemini.resolvedBackendId,
      availableBackends: gemini.availableBackends,
      externalRuntimeDiagnostics: [
        detectExternalBinary('gemini', 'Gemini CLI'),
      ],
      models: getGeminiModels(),
      backend: gemini.backend,
    }
  }

  if (!providerFilter || providerFilter === 'opencode') {
    providers.opencode = await buildOpenCodeStatus(deps, {
      detailLevel: options.detailLevel,
    })
  }

  return {
    schemaVersion: 2,
    providers,
  }
}
