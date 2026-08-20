import { openCodeClientFactory } from '../../../../services/opencode/OpenCodeClientFactory.js'
import {
  getOpenCodeCuratedSubscriptionProvider,
  getOpenCodeCuratedSubscriptionProviderIds,
  getOpenCodeFastCuratedSubscriptionProviderIds,
  getOpenCodeSeededSubscriptionProviderIds,
  OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS,
  validateOpenCodeCuratedSubscriptionKey,
} from '../../../../services/opencode/OpenCodeCuratedSubscriptionCatalog.js'
import {
  readOpenCodeAuthCredential,
  removeOpenCodeAuthCredential,
  upsertOpenCodeAuthCredential,
  upsertOpenCodeApiAuth,
  upsertOpenCodeApiAuthCredential,
  withOpenCodeOAuthRefreshLock,
} from '../../../../services/opencode/OpenCodeAuthStore.js'
import type { OpenCodeAuthCredential } from '../../../../services/opencode/OpenCodeAuthStore.js'
import {
  OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID,
  openCodeHostManager,
} from '../../../../services/opencode/OpenCodeHostManager.js'
import type { OpenCodeHostLeaseInput } from '../../../../services/opencode/OpenCodeHostManager.js'
import {
  OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS,
  OPEN_CODE_INVENTORY_SUMMARY_TIMEOUT_MS,
  OPEN_CODE_SUPERGROK_OAUTH_MIN_VERSION,
  createOpenCodeInventoryProbeProgressTracker,
  filterOpenCodeConnectedProvidersForRuntime,
  isOpenCodeInventoryTimeoutSnapshot,
  isOpenCodeModelFree,
  openCodeInventoryService,
  supportsOpenCodeSuperGrokOAuth,
  withOpenCodeInventoryProbeTimeout,
} from '../../../../services/opencode/OpenCodeInventoryService.js'
import { openCodeExecutionProbe } from '../../../../services/opencode/OpenCodeExecutionProbe.js'
import {
  buildOpenCodeModelRouteMetadata,
  evaluateOpenCodeModelAccess,
  type OpenCodeModelAccessCatalog,
} from '../../../../services/opencode/OpenCodeModelAccessPolicy.js'
import { openCodeProfileManager } from '../../../../services/opencode/OpenCodeProfileManager.js'
import { OpenCodeRuntimeDeadline } from '../../../../services/opencode/OpenCodeRuntimeDeadline.js'
import {
  OPEN_CODE_MANAGED_MODEL_LIMIT_MAX_TOKENS,
  clearOpenCodeManagedDefaultModel,
  readOpenCodeManagedRuntimePreferences,
  setOpenCodeManagedDefaultModel,
  setOpenCodeManagedGlobalDefaultModel,
  setOpenCodeManagedModelLimits,
  type OpenCodeManagedModelLimitOverride,
  type OpenCodeManagedRuntimePreferences,
} from '../../../../services/opencode/OpenCodeManagedPreferences.js'
import { resolveClaudeMultimodelPaths } from '../../../../services/opencode/OpenCodeManagedPaths.js'
import type {
  OpenCodeApiAuthInput,
  OpenCodeConfigProvidersResponse,
  OpenCodeConnectedProvider,
  OpenCodeExecutionProbeOutcome,
  OpenCodeExecutionProbeResult,
  OpenCodeHostHandle,
  OpenCodeInventorySnapshot,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderOAuthAuthorization,
  OpenCodeProviderOAuthAuthorizeInput,
  OpenCodeProviderOAuthCallbackInput,
  OpenCodeProviderListEntry,
  OpenCodeProviderResponse,
  OpenCodeServerDocResponse,
} from '../../../../services/opencode/types.js'
import { isRecommendedProvider, sortProviderConnections } from '../../domain/providerOrdering.js'
import type {
  ClearProjectDefaultModelInput,
  ConnectProviderApiKeyInput,
  ConnectProviderInput,
  ConfigureProviderModelLimitsInput,
  LoadProviderDirectoryInput,
  LoadProviderModelsInput,
  LoadProviderManagementViewInput,
  LoadProviderSetupFormInput,
  LocalAuthState,
  ManagedProfileState,
  ProviderActionDescriptor,
  ProviderAuthMethod,
  ProviderConnection,
  ProviderDirectoryEntry,
  ProviderDirectoryFilter,
  ProviderDirectorySource,
  ProviderDirectoryView,
  ProviderManagementErrorCode,
  ProviderManagementResult,
  ProviderManagementRuntimeId,
  ProviderManagementView,
  ProviderModelLimitsResult,
  ProviderModelAvailability,
  ProviderModelCatalogStatus,
  ProviderModelTestResult,
  ProviderOwnership,
  ProviderOAuthFlowObserver,
  ProviderRuntimeState,
  ProviderSelectionInput,
  ProviderSetupForm,
  ProviderSetupAuthOption,
  ProviderSetupPrompt,
  ProviderSetupPromptCondition,
  ProviderSetupPromptOption,
  RuntimeProviderModel,
  RuntimeProviderModelsView,
  SetDefaultModelInput,
  TestProviderModelInput,
} from '../../domain/types.js'
import type {
  ProviderManagementCommandPort,
  ProviderManagementDirectoryQueryPort,
  ProviderManagementQueryPort,
} from '../../ports/ProviderManagementPorts.js'

type OpenCodeInventoryServiceLike = {
  probe(
    projectPath?: string | null,
    options?: Parameters<typeof openCodeInventoryService.probe>[1],
  ): ReturnType<typeof openCodeInventoryService.probe>
  clearCache?(): void
}

type OpenCodeHostManagerLike = Pick<typeof openCodeHostManager, 'ensureHost' | 'releaseHost'> &
  Partial<
    Pick<
      typeof openCodeHostManager,
      'retainHostLease' | 'releaseHostLease' | 'reconcilePersistentHosts'
    >
  >

type OpenCodeProviderManagementClient = {
  getConfigProviders(): Promise<OpenCodeConfigProvidersResponse>
  getProviders(): Promise<OpenCodeProviderResponse>
  getProviderAuth(): Promise<Record<string, OpenCodeProviderAuthMethod[]>>
  getServerDoc?(): Promise<OpenCodeServerDocResponse>
  authorizeProviderOAuth?(
    providerId: string,
    body: OpenCodeProviderOAuthAuthorizeInput,
  ): Promise<OpenCodeProviderOAuthAuthorization>
  completeProviderOAuth?(
    providerId: string,
    body: OpenCodeProviderOAuthCallbackInput,
  ): Promise<boolean>
  setProviderAuth?(providerId: string, body: OpenCodeApiAuthInput): Promise<boolean>
  deleteProviderAuth?(providerId: string): Promise<boolean>
}

type OpenCodeClientFactoryLike = {
  create(baseUrl: string): OpenCodeProviderManagementClient
}

type OpenCodeProviderManagementAdapterDeps = {
  inventoryService?: OpenCodeInventoryServiceLike
  hostManager?: OpenCodeHostManagerLike
  clientFactory?: OpenCodeClientFactoryLike
  authStore?: {
    upsertApiAuth?(input: {
      authPath: string
      providerId: string
      auth: OpenCodeApiAuthInput
    }): Promise<void>
    upsertApiKey?(input: {
      authPath: string
      providerId: string
      apiKey: string
      metadata?: Record<string, string> | null
    }): Promise<void>
    readCredential?(input: {
      authPath: string
      providerId: string
    }): Promise<OpenCodeAuthCredential | null>
    upsertCredential?(input: {
      authPath: string
      providerId: string
      credential: OpenCodeAuthCredential
    }): Promise<void>
    removeCredential(input: { authPath: string; providerId: string }): Promise<void>
  }
  profileManager?: {
    listManagedAuthPaths(): Promise<string[]>
  }
  executionProbe?: {
    probeModel(input: {
      selectedModel: string
      projectPath?: string | null
      prompt?: string
      expectedOutput?: string
      contextTokens?: number
      outputTokens?: number
      bypassCache?: boolean
      runtimeDeadline?: OpenCodeRuntimeDeadline
    }): Promise<OpenCodeExecutionProbeResult>
  }
  managedPreferences?: {
    read?(profileRootPath: string): Promise<OpenCodeManagedRuntimePreferences>
    clearProjectDefaultModel?(profileRootPath: string): Promise<unknown>
    setDefaultModel(profileRootPath: string, modelId: string): Promise<unknown>
    setAllProjectsDefaultModel?(modelId: string): Promise<unknown>
    setModelLimits?(
      profileRootPath: string,
      input: { modelId: string; contextTokens: number; outputTokens: number },
    ): Promise<unknown>
  }
  inventoryTimeoutMs?: number
}

type SafeValue<T> = { ok: true; value: T } | { ok: false; message: string }

const FAST_CURATED_SETUP_PROVIDER_IDS = new Set<string>(
  getOpenCodeFastCuratedSubscriptionProviderIds(),
)
const CURATED_SUBSCRIPTION_PROVIDER_IDS = getOpenCodeCuratedSubscriptionProviderIds()
const SEEDED_SUBSCRIPTION_PROVIDER_IDS = getOpenCodeSeededSubscriptionProviderIds()
const CURATED_SUBSCRIPTION_PROVIDER_LABELS = Object.fromEntries(
  OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS.map(definition => [
    definition.id,
    definition.displayName,
  ]),
)

const KNOWN_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  atlascloud: 'Atlas Cloud',
  cerebras: 'Cerebras',
  deepseek: 'DeepSeek',
  'fireworks-ai': 'Fireworks AI',
  google: 'Google',
  groq: 'Groq',
  llmgateway: 'LLM Gateway',
  mistral: 'Mistral',
  moonshotai: 'Moonshot AI',
  ollama: 'Ollama',
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  togetherai: 'Together AI',
  vercel: 'Vercel AI Gateway',
  xai: 'xAI',
  zai: 'Z.AI',
  zenmux: 'ZenMux',
  ...CURATED_SUBSCRIPTION_PROVIDER_LABELS,
}

const SEEDED_PROVIDER_IDS = [
  'openrouter',
  'opencode',
  'atlascloud',
  ...SEEDED_SUBSCRIPTION_PROVIDER_IDS,
] as const
const SUMMARY_PROVIDER_IDS = new Set<string>([
  'xai',
  'github-copilot',
  ...CURATED_SUBSCRIPTION_PROVIDER_IDS,
])
const SUMMARY_PROVIDER_AUTH_METHODS: Record<string, OpenCodeProviderAuthMethod[]> = {
  xai: [{ type: 'oauth' }, { type: 'api' }],
  'github-copilot': [{ type: 'oauth' }],
  ...Object.fromEntries(
    OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS.map(definition => [
      definition.id,
      [{
        type:
          definition.credentialKind === 'api-key' || definition.id === 'cursor-acp'
            ? 'api'
            : 'oauth',
      }],
    ]),
  ),
}
const PROVIDERS_REQUIRING_EXPLICIT_CREDENTIAL_EVIDENCE = new Set<string>([
  'atlascloud',
  'github-copilot',
  'kiro',
  'cursor-acp',
  'xai',
  ...OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS.map(definition => definition.id),
])
const PROVIDERS_REQUIRING_CONNECT_EXECUTION_PROOF = new Set<string>([
  'opencode',
  'openrouter',
  'atlascloud',
  'google',
  'groq',
  'github-copilot',
  'xai',
  ...OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS
    .filter(definition => definition.requireConnectExecutionProof)
    .map(definition => definition.id),
])
const CONNECT_EXECUTION_PROOF_MODEL_PREFERENCES: Record<string, readonly string[]> = {
  google: [
    'google/gemini-3.1-flash-lite',
    'google/gemini-flash-lite-latest',
    'google/gemini-3.5-flash',
  ],
  groq: [
    'groq/llama-3.1-8b-instant',
    'groq/openai/gpt-oss-20b',
    'groq/openai/gpt-oss-120b',
  ],
  llmgateway: ['llmgateway/claude-haiku-4-5-free'],
  opencode: [
    'opencode/big-pickle',
    'opencode/mimo-v2.5-free',
    'opencode/nemotron-3-super-free',
    'opencode/nemotron-3-ultra-free',
  ],
  openrouter: ['openrouter/openrouter/free'],
  xai: [
    'xai/grok-4.5',
    'xai/grok-4.3',
    'xai/grok-4.20-0309-reasoning',
    'xai/grok-4.20-0309-non-reasoning',
  ],
  atlascloud: [
    'atlascloud/deepseek-ai/deepseek-v3.2',
    'atlascloud/deepseek-ai/deepseek-v4-flash',
    'atlascloud/zai-org/glm-5.1',
  ],
  'github-copilot': [
    'github-copilot/gpt-5-mini',
    'github-copilot/gpt-5.5',
    'github-copilot/claude-haiku-4.5',
    'github-copilot/claude-sonnet-4.6',
    'github-copilot/gpt-5.6-luna',
  ],
  ...Object.fromEntries(
    OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS
      .filter(definition => definition.modelProbePreferences.length > 0)
      .map(definition => [definition.id, definition.modelProbePreferences]),
  ),
}
const CURATED_API_BOOTSTRAP_PROVIDER_IDS = new Set<string>([
  ...OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS
    .filter(definition => definition.credentialKind === 'api-key')
    .map(definition => definition.id),
  'openrouter',
  'opencode',
  'atlascloud',
  'anthropic',
  'cerebras',
  'deepseek',
  'fireworks-ai',
  'google',
  'groq',
  'llmgateway',
  'mistral',
  'moonshotai',
  'opencode-go',
  'togetherai',
  'vercel',
  'xai',
  'zai',
  'zenmux',
])
const COPILOT_EXPLICIT_MODEL_UNSUPPORTED_MESSAGE =
  'GitHub sign-in succeeded, but OpenCode could not use any explicit Copilot model allowed for this account. Copilot Free and Student are Auto-only, which OpenCode does not currently support. On a paid or organization plan, check model policies.'

function isCopilotExplicitModelUnsupported(reason: string): boolean {
  const normalized = reason.trim().toLowerCase()
  return normalized.includes('requested model is not supported')
    || normalized.includes('selected model is not supported')
    || normalized.includes('model is unsupported for this copilot account')
    || normalized.includes('model is not supported for this copilot account')
}
const DEFAULT_DIRECTORY_LIMIT = 50
const MAX_DIRECTORY_LIMIT = 100
const DIRECTORY_CACHE_TTL_MS = 30_000
const OPEN_CODE_PROVIDER_MANAGEMENT_HOST_HEALTH_TIMEOUT_MS = 10_000
const OPEN_CODE_PROVIDER_MANAGEMENT_IDLE_HOST_TTL_MS = 10 * 60_000
const OPEN_CODE_PROVIDER_MANAGEMENT_LEASE_STALE_AGE_MS = 2 * 60 * 60_000
const AUTO_OAUTH_CREDENTIAL_POLL_INTERVAL_MS = 250
const CONNECT_EXECUTION_PROOF_MAX_CANDIDATES = 3
const CONNECT_EXECUTION_PROOF_CANDIDATE_TIMEOUT_MS = 45_000

type ProviderDirectoryCacheEntry = {
  expiresAt: number
  value: ProviderDirectoryView
  modelIdsByProviderId: Record<string, string[]>
}

type OpenCodeProviderManagementCapabilities = {
  deleteAuth: boolean
  authorizeOAuth: boolean
  completeOAuth: boolean
}

const EMPTY_CAPABILITIES: OpenCodeProviderManagementCapabilities = {
  deleteAuth: false,
  authorizeOAuth: false,
  completeOAuth: false,
}

const SUMMARY_CAPABILITIES: OpenCodeProviderManagementCapabilities = {
  deleteAuth: false,
  authorizeOAuth: true,
  completeOAuth: true,
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function canonicalizeCredentialValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeCredentialValue)
  }
  const record = asRecord(value)
  if (!record) {
    return value
  }
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map(key => [key, canonicalizeCredentialValue(record[key])]),
  )
}

function credentialsEqual(
  left: OpenCodeAuthCredential,
  right: OpenCodeAuthCredential,
): boolean {
  return JSON.stringify(canonicalizeCredentialValue(left)) ===
    JSON.stringify(canonicalizeCredentialValue(right))
}

function waitForAbortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false)
  }
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timeout)
      resolve(false)
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeOAuthOperationId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized && normalized.length <= 128 && /^[a-z0-9._:-]+$/i.test(normalized)
    ? normalized
    : null
}

function normalizeOAuthMethodIndex(value: number | null | undefined): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function normalizeOAuthAuthorizationUrl(value: string): string | null {
  if (!value.trim() || value.length > 8_192) {
    return null
  }
  try {
    const url = new URL(value)
    const loopbackHttp =
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
    if (url.protocol !== 'https:' && !loopbackHttp) {
      return null
    }
    if (url.username || url.password) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

function normalizeQuery(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function normalizeDirectoryFilter(
  value: ProviderDirectoryFilter | null | undefined,
): ProviderDirectoryFilter {
  const normalized = value?.trim()
  switch (normalized) {
    case 'connected':
    case 'configured':
    case 'connectable':
    case 'manual':
    case 'has-models':
      return normalized
    default:
      return 'all'
  }
}

function normalizeDirectoryLimit(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_DIRECTORY_LIMIT
  }
  const normalized = Math.floor(value)
  if (normalized <= 0) {
    return DEFAULT_DIRECTORY_LIMIT
  }
  return Math.min(normalized, MAX_DIRECTORY_LIMIT)
}

function normalizeDirectoryCursor(value: string | null | undefined): number {
  const normalized = Number.parseInt(value?.trim() ?? '', 10)
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0
}

function normalizeProviderId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized && /^[a-z0-9][a-z0-9._-]*$/i.test(normalized) ? normalized : null
}

function normalizePositiveLimit(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  const normalized = Math.floor(value)
  return normalized > 0 ? Math.min(normalized, 500) : null
}

function normalizeTokenLimit(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return null
  }
  return value > 0 && value <= OPEN_CODE_MANAGED_MODEL_LIMIT_MAX_TOKENS ? value : null
}

function getCatalogModelLimits(
  inventory: OpenCodeInventorySnapshot,
  modelId: string,
): { contextTokens: number | null; outputTokens: number | null } {
  const metadata = inventory.modelMetadata?.find(candidate => candidate.id.trim() === modelId)
  if (!metadata) {
    return { contextTokens: null, outputTokens: null }
  }
  const limits = asRecord(metadata.limits)
  return {
    contextTokens: normalizeTokenLimit(
      metadata.context ?? (limits?.context as number | undefined),
    ),
    outputTokens: normalizeTokenLimit(limits?.output as number | undefined),
  }
}

function normalizeProviderScopedModelId(input: {
  providerId: string
  modelId: string | null | undefined
}): string | null {
  const modelId = input.modelId?.trim()
  if (!modelId) {
    return null
  }
  if (!modelId.includes('/')) {
    return `${input.providerId}/${modelId}`
  }
  const separatorIndex = modelId.indexOf('/')
  const modelProviderId = normalizeProviderId(modelId.slice(0, separatorIndex))
  const nestedModelId = modelId.slice(separatorIndex + 1).trim()
  if (modelProviderId !== input.providerId || !nestedModelId) {
    return null
  }
  return `${modelProviderId}/${nestedModelId}`
}

function parseProviderScopedModelId(
  modelId: string | null | undefined,
): { providerId: string; modelId: string } | null {
  const normalizedModelId = modelId?.trim()
  if (!normalizedModelId?.includes('/')) {
    return null
  }
  const separatorIndex = normalizedModelId.indexOf('/')
  const providerId = normalizeProviderId(normalizedModelId.slice(0, separatorIndex))
  const nestedModelId = normalizedModelId.slice(separatorIndex + 1).trim()
  return providerId && nestedModelId ? { providerId, modelId: normalizedModelId } : null
}

function providerManagementError(
  code: ProviderManagementErrorCode,
  message: string,
  recoverable = true,
): ProviderManagementResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable,
    },
  }
}

function redactSecret(message: string, secret: string | null | undefined): string {
  const trimmedSecret = secret?.trim()
  if (!trimmedSecret) return message
  return message.split(trimmedSecret).join('[redacted]')
}

function redactDiagnostic(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/tp-[A-Za-z0-9_-]{5,}/g, '[redacted]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/([?&](?:key|token|api_key|apikey|access_token)=)[^&\s"']+/gi, '$1[redacted]')
    .slice(0, 1_600)
}

function redactDiagnostics(messages: readonly string[]): string[] {
  return messages.map(redactDiagnostic).filter(Boolean)
}

function appendViewDiagnostics(
  view: ProviderManagementView,
  diagnostics: readonly string[],
): ProviderManagementView {
  const appendedDiagnostics = redactDiagnostics(diagnostics)
  if (appendedDiagnostics.length === 0) {
    return view
  }
  return {
    ...view,
    diagnostics: [...view.diagnostics, ...appendedDiagnostics],
  }
}

function getProviderDisplayName(providerId: string, entry?: OpenCodeProviderListEntry): string {
  if (providerId === 'opencode') {
    return KNOWN_PROVIDER_LABELS.opencode ?? 'OpenCode Zen'
  }
  const name = asString(entry?.name)
  return name ?? KNOWN_PROVIDER_LABELS[providerId] ?? providerId
}

async function safeRead<T>(read: () => Promise<T>): Promise<SafeValue<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function safeReadDiagnostics<T>(result: SafeValue<T>): string[] {
  return 'message' in result ? [result.message] : []
}

function getConnectedProviderMap(
  inventory: OpenCodeInventorySnapshot,
  providers: OpenCodeProviderResponse | null,
): Map<string, OpenCodeConnectedProvider | null> {
  const connected = new Map<string, OpenCodeConnectedProvider | null>()
  const liveConnectedProviderIds = new Set(
    (providers?.connected ?? [])
      .map(providerId => normalizeProviderId(providerId))
      .filter((providerId): providerId is string => Boolean(providerId)),
  )

  for (const provider of inventory.connectedProviders) {
    const providerId = normalizeProviderId(provider.id)
    const requiresLiveEvidence =
      providers !== null
      && providerId !== null
      && PROVIDERS_REQUIRING_EXPLICIT_CREDENTIAL_EVIDENCE.has(providerId)
    if (providerId && (!requiresLiveEvidence || liveConnectedProviderIds.has(providerId))) {
      connected.set(providerId, provider)
    }
  }

  for (const providerId of providers?.connected ?? []) {
    const normalizedProviderId = normalizeProviderId(providerId)
    if (
      normalizedProviderId &&
      PROVIDERS_REQUIRING_EXPLICIT_CREDENTIAL_EVIDENCE.has(normalizedProviderId) &&
      !connected.has(normalizedProviderId)
    ) {
      continue
    }
    if (normalizedProviderId && !connected.has(normalizedProviderId)) {
      connected.set(normalizedProviderId, null)
    }
  }

  return connected
}

function addManagedProviderToInventory(
  inventory: OpenCodeInventorySnapshot,
  providerId: string,
): OpenCodeInventorySnapshot {
  const normalizedProviderId = normalizeProviderId(providerId)
  if (!normalizedProviderId) {
    return inventory
  }
  const connectedProviders = inventory.connectedProviders.filter(
    provider => normalizeProviderId(provider.id) !== normalizedProviderId,
  )
  connectedProviders.push({
    id: normalizedProviderId,
    authHint: 'api',
    source: 'credentials',
    credentialScopes: ['managed'],
  })
  const availableProviders = Array.from(
    new Set([...inventory.availableProviders, normalizedProviderId]),
  ).sort()
  return {
    ...inventory,
    connectedProviders,
    availableProviders,
  }
}

function removeManagedProviderFromInventory(
  inventory: OpenCodeInventorySnapshot,
  providerId: string,
): OpenCodeInventorySnapshot {
  const normalizedProviderId = normalizeProviderId(providerId)
  if (!normalizedProviderId) {
    return inventory
  }
  const availableProviders = Array.from(
    new Set([...inventory.availableProviders, normalizedProviderId]),
  ).sort()
  return {
    ...inventory,
    connectedProviders: inventory.connectedProviders.flatMap(provider => {
      if (normalizeProviderId(provider.id) !== normalizedProviderId) {
        return [provider]
      }
      if (provider.source !== 'credentials') {
        return [provider]
      }
      const remainingScopes = provider.credentialScopes?.filter(scope => scope === 'local') ?? []
      return remainingScopes.length > 0
        ? [
            {
              ...provider,
              credentialScopes: remainingScopes,
            },
          ]
        : []
    }),
    availableProviders,
  }
}

function applyManagedDefaultToInventory(
  inventory: OpenCodeInventorySnapshot,
  input: {
    modelId: string
    scope: 'project' | 'all_projects'
  },
): OpenCodeInventorySnapshot {
  const profile = inventory.profile
  if (!profile) {
    return inventory
  }
  const projectDefaultModelId =
    input.scope === 'project' ? input.modelId : profile.projectDefaultModelId
  const allProjectsDefaultModelId =
    input.scope === 'all_projects' ? input.modelId : profile.allProjectsDefaultModelId
  const effectiveManagedDefaultModelId = projectDefaultModelId ?? allProjectsDefaultModelId ?? null
  const effectiveManagedDefaultSource = projectDefaultModelId
    ? ('project' as const)
    : allProjectsDefaultModelId
      ? ('all_projects' as const)
      : null
  return {
    ...inventory,
    profile: {
      ...profile,
      projectDefaultModelId,
      allProjectsDefaultModelId,
      effectiveManagedDefaultModelId,
      effectiveManagedDefaultSource,
      managedConfig: {
        ...profile.managedConfig,
        ...(effectiveManagedDefaultModelId ? { model: effectiveManagedDefaultModelId } : {}),
      },
    },
  }
}

function applyClearedProjectDefaultToInventory(
  inventory: OpenCodeInventorySnapshot,
): OpenCodeInventorySnapshot {
  const profile = inventory.profile
  if (!profile) {
    return inventory
  }
  const effectiveManagedDefaultModelId = profile.allProjectsDefaultModelId ?? null
  const { model: _projectDefaultModel, ...managedConfigWithoutModel } = profile.managedConfig
  return {
    ...inventory,
    profile: {
      ...profile,
      projectDefaultModelId: null,
      effectiveManagedDefaultModelId,
      effectiveManagedDefaultSource: effectiveManagedDefaultModelId ? 'all_projects' : null,
      managedConfig: effectiveManagedDefaultModelId
        ? { ...managedConfigWithoutModel, model: effectiveManagedDefaultModelId }
        : managedConfigWithoutModel,
    },
  }
}

function useActionRefreshInventory(
  previousInventory: OpenCodeInventorySnapshot,
  refreshedInventory: OpenCodeInventorySnapshot,
  fallback?: (inventory: OpenCodeInventorySnapshot) => OpenCodeInventorySnapshot,
): {
  inventory: OpenCodeInventorySnapshot
  postViewDiagnostics: string[]
} {
  if (!isOpenCodeInventoryTimeoutSnapshot(refreshedInventory)) {
    return {
      inventory: refreshedInventory,
      postViewDiagnostics: [],
    }
  }
  const fallbackInventory = fallback?.(previousInventory) ?? previousInventory
  return {
    inventory: fallbackInventory,
    postViewDiagnostics: refreshedInventory.diagnostics,
  }
}

function getModelCounts(
  inventory: OpenCodeInventorySnapshot,
  configProviders: OpenCodeConfigProvidersResponse | null,
  providers?: OpenCodeProviderResponse | null,
): Map<string, number> {
  const modelIdsByProviderId = new Map<string, Set<string>>()

  const addModel = (rawProviderId: string | null | undefined, rawModelId: string): void => {
    const providerId = normalizeProviderId(rawProviderId)
    const modelId = rawModelId.trim()
    if (!providerId || !modelId) {
      return
    }
    const modelIds = modelIdsByProviderId.get(providerId) ?? new Set<string>()
    modelIds.add(`${providerId}/${modelId}`)
    modelIdsByProviderId.set(providerId, modelIds)
  }

  for (const model of inventory.models) {
    const normalizedModel = model.trim()
    const slashIndex = normalizedModel.indexOf('/')
    if (slashIndex > 0) {
      addModel(normalizedModel.slice(0, slashIndex), normalizedModel.slice(slashIndex + 1))
    }
  }

  for (const provider of configProviders?.providers ?? []) {
    const models = asRecord(provider.models)
    if (!models) {
      continue
    }
    for (const modelId of Object.keys(models)) {
      addModel(provider.id, modelId)
    }
  }

  for (const provider of providers?.all ?? []) {
    const models = asRecord(provider.models)
    if (!models) {
      continue
    }
    for (const modelId of Object.keys(models)) {
      addModel(provider.id, modelId)
    }
  }

  return new Map(
    Array.from(modelIdsByProviderId, ([providerId, modelIds]) => [providerId, modelIds.size]),
  )
}

function getProviderEntries(
  configProviders: OpenCodeConfigProvidersResponse | null,
  providers: OpenCodeProviderResponse | null,
): Map<string, OpenCodeProviderListEntry> {
  const entries = new Map<string, OpenCodeProviderListEntry>()

  for (const entry of providers?.all ?? []) {
    const providerId = normalizeProviderId(entry.id)
    if (providerId) {
      entries.set(providerId, entry)
    }
  }

  for (const entry of configProviders?.providers ?? []) {
    const providerId = normalizeProviderId(entry.id)
    if (providerId) {
      entries.set(providerId, {
        ...entries.get(providerId),
        ...entry,
      })
    }
  }

  return entries
}

function collectProviderIds(input: {
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
  includeSeeds: boolean
}): Set<string> {
  const providerIds = new Set<string>()

  if (input.includeSeeds) {
    for (const providerId of SEEDED_PROVIDER_IDS) {
      providerIds.add(providerId)
    }
  }
  for (const providerId of input.inventory.availableProviders) {
    const normalizedProviderId = normalizeProviderId(providerId)
    if (normalizedProviderId) providerIds.add(normalizedProviderId)
  }
  for (const provider of input.inventory.connectedProviders) {
    const normalizedProviderId = normalizeProviderId(provider.id)
    if (normalizedProviderId) providerIds.add(normalizedProviderId)
  }
  for (const provider of input.configProviders?.providers ?? []) {
    const normalizedProviderId = normalizeProviderId(provider.id)
    if (normalizedProviderId) providerIds.add(normalizedProviderId)
  }
  for (const provider of input.providers?.all ?? []) {
    const normalizedProviderId = normalizeProviderId(provider.id)
    if (normalizedProviderId) providerIds.add(normalizedProviderId)
  }
  for (const providerId of input.providers?.connected ?? []) {
    const normalizedProviderId = normalizeProviderId(providerId)
    if (normalizedProviderId) providerIds.add(normalizedProviderId)
  }
  for (const providerId of Object.keys(input.configProviders?.default ?? {})) {
    const normalizedProviderId = normalizeProviderId(providerId)
    if (normalizedProviderId) providerIds.add(normalizedProviderId)
  }
  for (const providerId of Object.keys(input.providers?.default ?? {})) {
    const normalizedProviderId = normalizeProviderId(providerId)
    if (normalizedProviderId) providerIds.add(normalizedProviderId)
  }

  return providerIds
}

function getKnownProviderIds(input: {
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
}): Set<string> {
  return collectProviderIds({
    ...input,
    includeSeeds: true,
  })
}

function getLiveProviderIds(input: {
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
}): Set<string> {
  return collectProviderIds({
    ...input,
    includeSeeds: false,
  })
}

function countMalformedProviderRows(input: {
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
}): number {
  let count = 0
  for (const provider of input.providers?.all ?? []) {
    if (!normalizeProviderId(provider.id)) count += 1
  }
  for (const provider of input.configProviders?.providers ?? []) {
    if (!normalizeProviderId(provider.id)) count += 1
  }
  return count
}

function normalizeAuthMethods(
  methods: readonly OpenCodeProviderAuthMethod[] | undefined,
): ProviderAuthMethod[] {
  const normalized = new Set<ProviderAuthMethod>()

  for (const method of methods ?? []) {
    const type = method.type?.trim().toLowerCase()
    if (type === 'api') normalized.add('api')
    else if (type === 'oauth') normalized.add('oauth')
    else if (type === 'wellknown' || type === 'well-known') normalized.add('wellknown')
  }

  return Array.from(normalized)
}

function normalizeProviderAuthMap(
  providerAuth: Record<string, OpenCodeProviderAuthMethod[]> | null,
): Map<string, OpenCodeProviderAuthMethod[]> {
  const authByProviderId = new Map<string, OpenCodeProviderAuthMethod[]>()
  for (const [rawProviderId, methods] of Object.entries(providerAuth ?? {})) {
    const providerId = normalizeProviderId(rawProviderId)
    if (providerId && Array.isArray(methods)) {
      authByProviderId.set(providerId, methods)
    }
  }
  return authByProviderId
}

function getProviderAuthMethods(
  providerAuth: Record<string, OpenCodeProviderAuthMethod[]> | null,
  providerId: string,
): OpenCodeProviderAuthMethod[] {
  return normalizeProviderAuthMap(providerAuth).get(providerId) ?? []
}

function normalizeSetupPromptOption(value: unknown): ProviderSetupPromptOption | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const label = asString(record.label) ?? asString(record.value)
  const optionValue = asString(record.value) ?? label
  if (!label || !optionValue) {
    return null
  }
  return {
    label,
    value: optionValue,
    hint: asString(record.hint),
  }
}

function normalizeSetupPromptCondition(value: unknown): ProviderSetupPromptCondition | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const key = asString(record.key)
  const op = asString(record.op)
  const conditionValue = asString(record.value)
  if (!key || !op || conditionValue === null) {
    return null
  }
  return {
    key,
    op,
    value: conditionValue,
  }
}

function normalizeSetupPrompt(value: unknown): ProviderSetupPrompt | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const key = asString(record.key)
  const type = asString(record.type)?.toLowerCase()
  const label = asString(record.message) ?? asString(record.label) ?? key
  if (!key || !label) {
    return null
  }
  const options = Array.isArray(record.options)
    ? record.options
        .map(normalizeSetupPromptOption)
        .filter((option): option is ProviderSetupPromptOption => Boolean(option))
    : []
  const promptType = type === 'select' ? 'select' : 'text'
  return {
    key,
    type: promptType,
    label,
    placeholder: asString(record.placeholder),
    required: true,
    secret: isSecretPromptKey(key),
    options,
    when: normalizeSetupPromptCondition(record.when),
  }
}

function isSecretPromptKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return (
    normalized === 'key' ||
    normalized === 'apikey' ||
    normalized === 'token' ||
    normalized === 'authtoken' ||
    normalized === 'accesstoken' ||
    normalized === 'personalaccesstoken' ||
    normalized === 'pat'
  )
}

function splitApiAuthPrompts(method: OpenCodeProviderAuthMethod): {
  secretLabel: string
  secretPlaceholder: string | null
  prompts: ProviderSetupPrompt[]
} {
  const prompts = (method.prompts ?? [])
    .map(normalizeSetupPrompt)
    .filter((prompt): prompt is ProviderSetupPrompt => Boolean(prompt))
  const secretPrompt = prompts.find(prompt => prompt.secret) ?? null
  return {
    secretLabel: secretPrompt?.label ?? asString(method.label) ?? 'API key',
    secretPlaceholder: secretPrompt?.placeholder ?? null,
    prompts: prompts
      .filter(prompt => prompt !== secretPrompt)
      .map(prompt => ({ ...prompt, secret: false })),
  }
}

function buildOpenCodeSetupAuthOptions(input: {
  methods: readonly OpenCodeProviderAuthMethod[]
  capabilities: OpenCodeProviderManagementCapabilities
}): ProviderSetupAuthOption[] {
  return input.methods.flatMap<ProviderSetupAuthOption>((method, methodIndex) => {
    const methodType = method.type?.trim().toLowerCase()
    const label =
      asString(method.label) ?? (methodType === 'oauth' ? 'Sign in with OAuth' : 'API key')
    if (methodType === 'api') {
      const { secretLabel, secretPlaceholder, prompts } = splitApiAuthPrompts(method)
      return [
        {
          id: `api:${methodIndex}`,
          method: 'api' as const,
          methodIndex,
          label,
          supported: true,
          disabledReason: null,
          secret: {
            key: 'key' as const,
            label: secretLabel,
            placeholder: secretPlaceholder,
            required: true,
          },
          prompts,
        },
      ]
    }
    if (methodType === 'oauth') {
      const supported = input.capabilities.authorizeOAuth && input.capabilities.completeOAuth
      const prompts = (method.prompts ?? [])
        .map(normalizeSetupPrompt)
        .filter((prompt): prompt is ProviderSetupPrompt => Boolean(prompt))
      return [
        {
          id: `oauth:${methodIndex}`,
          method: 'oauth' as const,
          methodIndex,
          label,
          supported,
          disabledReason: supported
            ? null
            : 'Update OpenCode to a version that exposes provider OAuth authorize and callback endpoints.',
          secret: null,
          prompts,
        },
      ]
    }
    return []
  })
}

function isSuperGrokDeviceAuthOption(option: ProviderSetupAuthOption): boolean {
  if (option.method !== 'oauth') {
    return false
  }
  const label = option.label.toLowerCase()
  return (
    label.includes('device') ||
    label.includes('browser code') ||
    label.includes('headless') ||
    label.includes('remote') ||
    label.includes('vps')
  )
}

function prepareSuperGrokAuthOptions(
  options: readonly ProviderSetupAuthOption[],
): ProviderSetupAuthOption[] {
  return options.map(option => {
    if (!isSuperGrokDeviceAuthOption(option)) {
      return option
    }
    return {
      ...option,
      label: 'SuperGrok browser code (recommended)',
    }
  })
}

function promptConditionMatches(
  condition: ProviderSetupPromptCondition | null,
  metadata: Record<string, string>,
): boolean {
  if (!condition) {
    return true
  }
  const currentValue = metadata[condition.key] ?? ''
  switch (condition.op) {
    case 'eq':
      return currentValue === condition.value
    case 'neq':
    case 'ne':
      return currentValue !== condition.value
    default:
      return true
  }
}

function normalizeSetupPromptMetadata(
  prompts: readonly ProviderSetupPrompt[],
  metadata: Record<string, string> | null | undefined,
): Record<string, string> {
  const source = metadata ?? {}
  const normalized: Record<string, string> = {}
  for (const prompt of prompts) {
    if (!promptConditionMatches(prompt.when, { ...source, ...normalized })) {
      continue
    }
    const value = source[prompt.key]?.trim() ?? ''
    if (prompt.required && !value) {
      throw new Error(`${prompt.label} is required`)
    }
    if (value) {
      normalized[prompt.key] = value
    }
  }
  return normalized
}

function getCuratedApiSetupProfile(providerId: string): {
  description: string
  secretLabel: string
  secretPlaceholder: string
} {
  const curatedSubscription = getOpenCodeCuratedSubscriptionProvider(providerId)
  if (curatedSubscription) {
    return curatedSubscription.setup
  }

  return {
    description:
      'OpenCode documents this provider as an API-key /connect provider. The app verifies the live OpenCode connection before saving.',
    secretLabel: 'API key',
    secretPlaceholder: 'Paste API key',
  }
}

function buildProviderSetupForm(input: {
  providerId: string
  displayName: string
  knownProviderIds: Set<string>
  methods: readonly OpenCodeProviderAuthMethod[]
  capabilities?: OpenCodeProviderManagementCapabilities
}): ProviderSetupForm {
  const capabilities = input.capabilities ?? EMPTY_CAPABILITIES
  let authOptions = buildOpenCodeSetupAuthOptions({
    methods: input.methods,
    capabilities,
  })

  if (input.providerId === 'xai') {
    authOptions = prepareSuperGrokAuthOptions(authOptions)
  }

  if (
    input.providerId === 'xai' &&
    input.knownProviderIds.has(input.providerId) &&
    !authOptions.some(option => option.method === 'oauth')
  ) {
    authOptions.unshift({
      id: 'oauth:update-required',
      method: 'oauth',
      methodIndex: null,
      label: 'SuperGrok subscription - update OpenCode to 1.15.7 or newer',
      supported: false,
      disabledReason:
        'SuperGrok OAuth requires OpenCode 1.15.7 or newer. Update OpenCode, then refresh providers.',
      secret: null,
      prompts: [],
    })
  }

  if (
    !authOptions.some(option => option.method === 'api') &&
    input.knownProviderIds.has(input.providerId) &&
    CURATED_API_BOOTSTRAP_PROVIDER_IDS.has(input.providerId)
  ) {
    const curatedProfile = getCuratedApiSetupProfile(input.providerId)
    authOptions.push({
      id: 'api:curated',
      method: 'api',
      methodIndex: null,
      label: curatedProfile.secretLabel,
      supported: true,
      disabledReason: null,
      secret: {
        key: 'key',
        label: curatedProfile.secretLabel,
        placeholder: curatedProfile.secretPlaceholder,
        required: true,
      },
      prompts: [],
    })
  }

  const selectedOption =
    (input.providerId === 'xai'
      ? authOptions.find(option => option.supported && isSuperGrokDeviceAuthOption(option))
      : null) ??
    authOptions.find(option => option.supported) ??
    authOptions[0] ??
    null
  if (selectedOption) {
    const curatedProfile =
      selectedOption.id === 'api:curated' ? getCuratedApiSetupProfile(input.providerId) : null
    return {
      runtimeId: 'opencode',
      providerId: input.providerId,
      displayName: input.displayName,
      method: selectedOption.method,
      supported: selectedOption.supported,
      title: `Connect ${input.displayName}`,
      description:
        curatedProfile?.description ??
        (input.providerId === 'xai' && isSuperGrokDeviceAuthOption(selectedOption)
          ? 'Open xAI in your browser, enter the short device code, and return here. OpenCode securely completes the SuperGrok sign-in and token refresh.'
          : selectedOption.method === 'oauth'
          ? 'Sign in through the provider in your browser. OpenCode handles authorization and token refresh without exposing OAuth tokens to the desktop UI.'
          : 'Credential is stored in the app-managed OpenCode profile.'),
      submitLabel:
        input.providerId === 'xai' && isSuperGrokDeviceAuthOption(selectedOption)
          ? 'Get browser code'
          : selectedOption.method === 'oauth'
            ? 'Continue in browser'
            : 'Connect',
      disabledReason: selectedOption.disabledReason,
      source: curatedProfile
        ? 'curated'
        : selectedOption.method === 'oauth'
          ? 'oauth'
          : 'opencode-auth',
      secret: selectedOption.secret,
      prompts: selectedOption.prompts,
      authOptions,
      defaultAuthOptionId: selectedOption.id,
      verification: selectedOption.method === 'api' || requiresConnectExecutionProof(input.providerId)
        ? {
            kind: 'model-request',
            freeModelPreferred: true,
            mayUseQuotaOrBalance: true,
          }
        : null,
    }
  }

  return {
    runtimeId: 'opencode',
    providerId: input.providerId,
    displayName: input.displayName,
    method: 'manual',
    supported: false,
    title: `Manual setup required for ${input.displayName}`,
    description: 'OpenCode did not expose an app-managed setup schema for this provider.',
    submitLabel: 'Manual setup required',
    disabledReason: 'Manual OpenCode config or environment setup is required',
    source: 'manual',
    secret: null,
    prompts: [],
    authOptions: [],
    defaultAuthOptionId: null,
  }
}

function getOwnership(input: {
  connected: boolean
  connectedProvider: OpenCodeConnectedProvider | null | undefined
  inventory: OpenCodeInventorySnapshot
}): ProviderOwnership[] {
  if (input.connectedProvider?.source === 'environment') {
    return ['env']
  }

  if (input.connectedProvider?.source === 'credentials') {
    if (input.connectedProvider.credentialScopes?.length) {
      return input.connectedProvider.credentialScopes.filter(
        scope => scope === 'managed' || scope === 'local',
      )
    }
    return ['managed']
  }

  if (input.connected) {
    return ['managed']
  }

  return []
}

function requiresExplicitCredentialEvidence(providerId: string): boolean {
  return PROVIDERS_REQUIRING_EXPLICIT_CREDENTIAL_EVIDENCE.has(providerId)
}

function requiresConnectExecutionProof(providerId: string): boolean {
  return PROVIDERS_REQUIRING_CONNECT_EXECUTION_PROOF.has(providerId)
}

function hasExplicitConnectionEvidence(
  connectedProvider: OpenCodeConnectedProvider | null | undefined,
): boolean {
  return connectedProvider?.source === 'environment' || connectedProvider?.source === 'credentials'
}

function shouldDisplayProviderAsConnected(input: {
  connected: boolean
  connectedProvider: OpenCodeConnectedProvider | null | undefined
  configuredAuthless: boolean
}): boolean {
  if (!input.connected) {
    return false
  }
  if (!input.configuredAuthless) {
    return true
  }
  return hasExplicitConnectionEvidence(input.connectedProvider)
}

function getConnectedProviderDetail(ownership: readonly ProviderOwnership[]): string {
  if (ownership.includes('env')) {
    return 'Connected via OpenCode environment credential'
  }
  if (ownership.includes('managed') && ownership.includes('local')) {
    return 'Connected via app-managed and local OpenCode credentials'
  }
  if (ownership.includes('managed')) {
    return 'Connected via app-managed OpenCode credential'
  }
  if (ownership.includes('local')) {
    return 'Connected via local OpenCode credential'
  }
  return 'Connected in the OpenCode runtime'
}

function getDefaultModelForProvider(
  providerId: string,
  inventory: OpenCodeInventorySnapshot,
  configProviders: OpenCodeConfigProvidersResponse | null,
  providers: OpenCodeProviderResponse | null,
): string | null {
  const managedDefault = asString(inventory.profile?.managedConfig?.model)
  if (managedDefault?.startsWith(`${providerId}/`)) {
    return managedDefault
  }

  const modelId =
    asString(configProviders?.default?.[providerId]) ?? asString(providers?.default?.[providerId])
  if (!modelId) {
    return null
  }
  const scopedModelId = modelId.startsWith(`${providerId}/`)
    ? modelId
    : `${providerId}/${modelId}`
  if (providerId !== 'xai' || !/\b(?:image|video)\b/i.test(scopedModelId)) {
    return scopedModelId
  }

  const availableModelIds = collectProviderModelIds({
    providerId,
    inventory,
    configProviders,
    providers,
  })
  return CONNECT_EXECUTION_PROOF_MODEL_PREFERENCES.xai?.find(modelId =>
    availableModelIds.includes(modelId)
  ) ?? availableModelIds.find(modelId => !/\b(?:image|video)\b/i.test(modelId)) ?? scopedModelId
}

function getDefaultModel(
  inventory: OpenCodeInventorySnapshot,
  configProviders: OpenCodeConfigProvidersResponse | null,
  providers: OpenCodeProviderResponse | null,
): string | null {
  const managedDefault = asString(inventory.profile?.managedConfig?.model)
  if (managedDefault) {
    return managedDefault
  }

  const defaults = {
    ...(providers?.default ?? {}),
    ...(configProviders?.default ?? {}),
  }
  for (const [providerId, modelId] of Object.entries(defaults)) {
    const normalizedProviderId = normalizeProviderId(providerId)
    const normalizedModelId = asString(modelId)
    if (normalizedProviderId && normalizedModelId) {
      return getDefaultModelForProvider(
        normalizedProviderId,
        inventory,
        configProviders,
        providers,
      )
    }
  }
  return null
}

function getFallbackModel(inventory: OpenCodeInventorySnapshot): string | null {
  return inventory.models[0] ?? null
}

function getDefaultModelSource(input: {
  inventory: OpenCodeInventorySnapshot
  defaultModel: string | null
  fallbackModel: string | null
}): ProviderManagementView['defaultModelSource'] {
  if (input.defaultModel) {
    return input.inventory.profile?.effectiveManagedDefaultSource ?? 'opencode_config'
  }
  return input.fallbackModel ? 'fallback' : null
}

function getManagedProfileState(inventory: OpenCodeInventorySnapshot): ManagedProfileState {
  if (!inventory.profile) return 'missing'
  return inventory.profile.authState === 'stale' ? 'stale' : 'active'
}

function getLocalAuthState(inventory: OpenCodeInventorySnapshot): LocalAuthState {
  if (!inventory.profile?.sourceAuthPath) return 'missing'
  return inventory.profile.authState === 'stale' ? 'stale' : 'synced'
}

function getRuntimeState(input: {
  inventory: OpenCodeInventorySnapshot
  host: OpenCodeHostHandle | null
  hostStartError: string | null
  connectedProviderCount: number
  launchableRouteCount: number
  diagnostics: readonly string[]
}): ProviderRuntimeState {
  if (!input.inventory.detected) return 'needs-setup'
  if (input.hostStartError) return 'degraded'
  if (input.host && input.host.state !== 'healthy') return 'degraded'
  if (input.inventory.probeError && input.inventory.models.length === 0) return 'degraded'
  if (input.connectedProviderCount === 0 && input.launchableRouteCount === 0) return 'needs-auth'
  if (input.diagnostics.length > 0 && input.inventory.models.length === 0) return 'degraded'
  return 'ready'
}

function hasOpenCodeServerMethod(
  doc: OpenCodeServerDocResponse | null,
  path: string,
  method: string,
): boolean {
  const pathMethods = asRecord(doc?.paths?.[path])
  if (!pathMethods) {
    return false
  }
  return Object.keys(pathMethods).some(key => key.toLowerCase() === method.toLowerCase())
}

function getCapabilities(
  serverDoc: OpenCodeServerDocResponse | null,
): OpenCodeProviderManagementCapabilities {
  return {
    deleteAuth: hasOpenCodeServerMethod(serverDoc, '/auth/{providerID}', 'delete'),
    authorizeOAuth: hasOpenCodeServerMethod(
      serverDoc,
      '/provider/{providerID}/oauth/authorize',
      'post',
    ),
    completeOAuth: hasOpenCodeServerMethod(
      serverDoc,
      '/provider/{providerID}/oauth/callback',
      'post',
    ),
  }
}

function canConnectWithOAuth(
  authMethods: readonly ProviderAuthMethod[],
  capabilities: OpenCodeProviderManagementCapabilities,
): boolean {
  return authMethods.includes('oauth') && capabilities.authorizeOAuth && capabilities.completeOAuth
}

function canConnectWithApiKey(
  providerId: string,
  authMethods: readonly ProviderAuthMethod[],
): boolean {
  return authMethods.includes('api') || CURATED_API_BOOTSTRAP_PROVIDER_IDS.has(providerId)
}

function providerAction(
  input: Omit<ProviderActionDescriptor, 'disabledReason'> & {
    disabledReason?: string | null
  },
): ProviderActionDescriptor {
  return {
    ...input,
    disabledReason: input.disabledReason ?? null,
  }
}

function buildProviderActions(input: {
  providerId: string
  connected: boolean
  connectedAuthHint?: ProviderAuthMethod | null
  modelCount: number | null
  authMethods: readonly ProviderAuthMethod[]
  ownership: readonly ProviderOwnership[]
  capabilities: OpenCodeProviderManagementCapabilities
  configuredAuthless?: boolean
}): ProviderActionDescriptor[] {
  if (!input.connected) {
    if (input.configuredAuthless && input.modelCount !== null && input.modelCount > 0) {
      return [
        providerAction({
          id: 'use',
          label: 'Use',
          enabled: true,
          requiresSecret: false,
          ownershipScope: 'runtime',
        }),
        providerAction({
          id: 'test',
          label: 'Test',
          enabled: true,
          requiresSecret: false,
          ownershipScope: 'runtime',
        }),
        providerAction({
          id: 'set-default',
          label: 'Set default',
          enabled: true,
          requiresSecret: false,
          ownershipScope: 'runtime',
        }),
      ]
    }

    if (canConnectWithOAuth(input.authMethods, input.capabilities)) {
      return [
        providerAction({
          id: 'connect',
          label: 'Connect',
          enabled: true,
          requiresSecret: false,
          ownershipScope: 'managed',
        }),
      ]
    }

    if (canConnectWithApiKey(input.providerId, input.authMethods)) {
      return [
        providerAction({
          id: 'connect',
          label: 'Connect',
          enabled: true,
          requiresSecret: true,
          ownershipScope: 'managed',
        }),
      ]
    }

    if (input.authMethods.includes('oauth')) {
      return [
        providerAction({
          id: 'configure',
          label: 'OpenCode update required',
          enabled: false,
          disabledReason:
            'This OpenCode runtime exposes OAuth methods but not the OAuth bridge endpoints. Update OpenCode and refresh providers.',
          requiresSecret: false,
          ownershipScope: 'runtime',
        }),
      ]
    }

    return [
      providerAction({
        id: 'configure',
        label: 'Manual setup required',
        enabled: false,
        disabledReason: 'OpenCode did not expose an app-managed setup schema for this provider',
        requiresSecret: false,
        ownershipScope: 'runtime',
      }),
    ]
  }

  const actions: ProviderActionDescriptor[] = []
  const hasModels = input.modelCount !== 0
  const noModelsReason = input.modelCount === 0 ? 'No models reported for this provider' : null

  if (hasModels) {
    actions.push(
      providerAction({
        id: 'use',
        label: 'Use',
        enabled: true,
        requiresSecret: false,
        ownershipScope: 'runtime',
      }),
    )
  }

  actions.push(
    providerAction({
      id: 'test',
      label: 'Test',
      enabled: hasModels,
      disabledReason: noModelsReason,
      requiresSecret: false,
      ownershipScope: 'runtime',
    }),
    providerAction({
      id: 'set-default',
      label: 'Set default',
      enabled: hasModels,
      disabledReason: noModelsReason,
      requiresSecret: false,
      ownershipScope: 'runtime',
    }),
  )

  const canReconnectWithOAuth = canConnectWithOAuth(input.authMethods, input.capabilities)
  const canReconnectWithApiKey = canConnectWithApiKey(input.providerId, input.authMethods)
  if (
    input.ownership.includes('managed') &&
    (canReconnectWithOAuth || canReconnectWithApiKey)
  ) {
    const effectiveAuthMethod =
      input.connectedAuthHint ??
      (canReconnectWithOAuth && !canReconnectWithApiKey
        ? 'oauth'
        : canReconnectWithApiKey && !canReconnectWithOAuth
          ? 'api'
          : null)
    actions.push(
      providerAction({
        id: 'reconnect',
        label:
          effectiveAuthMethod === 'api'
            ? 'Replace credential'
            : effectiveAuthMethod === 'oauth'
              ? 'Sign in again'
              : 'Reconnect',
        enabled: true,
        requiresSecret: effectiveAuthMethod === 'api',
        ownershipScope: 'managed',
      }),
    )
  }

  if (input.ownership.includes('managed') && input.capabilities.deleteAuth) {
    actions.push(
      providerAction({
        id: 'forget',
        label: 'Remove managed credential',
        enabled: true,
        requiresSecret: false,
        ownershipScope: 'managed',
      }),
    )
  }

  return actions
}

function buildProviderConnections(input: {
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
  providerAuth: Record<string, OpenCodeProviderAuthMethod[]> | null
  capabilities: OpenCodeProviderManagementCapabilities
}): ProviderConnection[] {
  const connectedProviders = getConnectedProviderMap(input.inventory, input.providers)
  const modelCounts = getModelCounts(input.inventory, input.configProviders, input.providers)
  const entries = getProviderEntries(input.configProviders, input.providers)
  const providerIds = getKnownProviderIds(input)

  const connections: ProviderConnection[] = []
  for (const providerId of providerIds) {
    const connectedProvider = connectedProviders.get(providerId)
    const modelCount = modelCounts.get(providerId) ?? 0
    const authMethods = normalizeAuthMethods(input.providerAuth?.[providerId])
    const connected = connectedProviders.has(providerId)
    const superGrokRuntimeUpdateRequired =
      providerId === 'xai'
      && !connected
      && !supportsOpenCodeSuperGrokOAuth(input.inventory.version)
      && input.inventory.diagnostics.some(diagnostic =>
        diagnostic.startsWith('SuperGrok OAuth requires OpenCode ')
      )
    const configuredAuthless = providerHasConfiguredAuthlessModels({
      providerId,
      inventory: input.inventory,
      configProviders: input.configProviders,
      providers: input.providers,
    })
    const displayConnected = shouldDisplayProviderAsConnected({
      connected,
      connectedProvider,
      configuredAuthless,
    })
    const ownership = getOwnership({
      connected: displayConnected,
      connectedProvider,
      inventory: input.inventory,
    })
    const state: ProviderConnection['state'] = superGrokRuntimeUpdateRequired
      ? 'error'
      : displayConnected
      ? 'connected'
      : modelCount > 0
        ? 'available'
        : 'not-connected'

    connections.push({
      providerId,
      displayName: getProviderDisplayName(providerId, entries.get(providerId)),
      state,
      ownership,
      recommended: isRecommendedProvider(providerId),
      modelCount,
      defaultModelId: getDefaultModelForProvider(
        providerId,
        input.inventory,
        input.configProviders,
        input.providers,
      ),
      authMethods,
      connectedAuthHint: displayConnected ? (connectedProvider?.authHint ?? null) : null,
      actions: superGrokRuntimeUpdateRequired
        ? [providerAction({
            id: 'configure',
            label: 'OpenCode update required',
            enabled: false,
            disabledReason:
              `SuperGrok OAuth requires OpenCode ${OPEN_CODE_SUPERGROK_OAUTH_MIN_VERSION} or newer. Update OpenCode, then refresh providers.`,
            requiresSecret: false,
            ownershipScope: 'runtime',
          })]
        : buildProviderActions({
            providerId,
            connected: displayConnected,
            connectedAuthHint: connectedProvider?.authHint ?? null,
            modelCount,
            authMethods,
            ownership,
            capabilities: input.capabilities,
            configuredAuthless,
          }),
      detail: superGrokRuntimeUpdateRequired
        ? `Saved SuperGrok OAuth needs OpenCode ${OPEN_CODE_SUPERGROK_OAUTH_MIN_VERSION} or newer before it can be used.`
        : displayConnected
        ? getConnectedProviderDetail(ownership)
        : configuredAuthless && modelCount > 0
          ? 'Configured local OpenCode model route is available'
          : modelCount > 0
            ? 'Provider is visible in the OpenCode model catalog'
            : null,
    })
  }

  return sortProviderConnections(connections)
}

function collectProviderDirectorySources(input: {
  providerId: string
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
}): ProviderDirectorySource[] {
  const sources = new Set<ProviderDirectorySource>()
  if ((SEEDED_PROVIDER_IDS as readonly string[]).includes(input.providerId)) {
    sources.add('seed')
  }
  if (
    input.inventory.availableProviders.some(
      providerId => normalizeProviderId(providerId) === input.providerId,
    ) ||
    input.inventory.connectedProviders.some(
      provider => normalizeProviderId(provider.id) === input.providerId,
    )
  ) {
    sources.add('inventory')
  }
  if (
    input.configProviders?.providers?.some(
      provider => normalizeProviderId(provider.id) === input.providerId,
    )
  ) {
    sources.add('config-provider')
  }
  if (
    input.providers?.all?.some(provider => normalizeProviderId(provider.id) === input.providerId) ||
    input.providers?.connected?.some(
      providerId => normalizeProviderId(providerId) === input.providerId,
    )
  ) {
    sources.add('opencode-provider')
  }
  return Array.from(sources)
}

function getProviderSourceLabel(sources: readonly ProviderDirectorySource[]): string | null {
  if (sources.includes('config-provider')) return 'configured'
  if (sources.includes('opencode-provider')) return 'OpenCode catalog'
  if (sources.includes('inventory')) return 'inventory'
  if (sources.includes('seed')) return 'seeded fallback'
  return null
}

function getProviderSourceValue(entry: OpenCodeProviderListEntry | undefined): string | null {
  const source = asString(entry?.source)
  return source ? source.slice(0, 80) : null
}

function buildProviderManagementAccessCatalog(input: {
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
}): OpenCodeModelAccessCatalog {
  return {
    connectedProviders: Array.from(
      getConnectedProviderMap(input.inventory, input.providers).keys(),
    ),
    models: input.inventory.models,
    modelMetadata: input.inventory.modelMetadata,
    configProviders: input.configProviders,
    providers: input.providers,
  }
}

function providerHasConfiguredAuthlessModels(input: {
  providerId: string
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
}): boolean {
  const accessCatalog = buildProviderManagementAccessCatalog(input)
  return collectProviderModelIds(input).some(modelId => {
    const metadata = buildOpenCodeModelRouteMetadata({
      selectedModel: modelId,
      catalog: accessCatalog,
    })
    return metadata.routeKind === 'configured_local'
  })
}

function getProviderSetupKind(input: {
  connected: boolean
  providerId: string
  modelCount: number | null
  authMethods: readonly ProviderAuthMethod[]
  capabilities: OpenCodeProviderManagementCapabilities
}): ProviderDirectoryEntry['setupKind'] {
  if (input.connected) {
    return 'connected'
  }
  if (canConnectWithOAuth(input.authMethods, input.capabilities)) {
    return 'connect-oauth'
  }
  if (canConnectWithApiKey(input.providerId, input.authMethods)) {
    return 'connect-api-key'
  }
  if (input.authMethods.length > 0) {
    return 'configure-manually'
  }
  if (input.modelCount !== null && input.modelCount > 0) {
    return 'available-readonly'
  }
  return 'requires-environment'
}

function buildProviderDirectoryActions(input: {
  providerId: string
  connected: boolean
  connectedAuthHint?: ProviderAuthMethod | null
  modelCount: number | null
  authMethods: readonly ProviderAuthMethod[]
  ownership: readonly ProviderOwnership[]
  capabilities: OpenCodeProviderManagementCapabilities
  setupKind: ProviderDirectoryEntry['setupKind']
  configuredAuthless: boolean
}): ProviderActionDescriptor[] {
  if (input.configuredAuthless && input.modelCount !== null && input.modelCount > 0) {
    return [
      providerAction({
        id: 'use',
        label: 'Use',
        enabled: true,
        requiresSecret: false,
        ownershipScope: 'runtime',
      }),
      providerAction({
        id: 'test',
        label: 'Test',
        enabled: true,
        requiresSecret: false,
        ownershipScope: 'runtime',
      }),
      providerAction({
        id: 'set-default',
        label: 'Set default',
        enabled: true,
        requiresSecret: false,
        ownershipScope: 'runtime',
      }),
    ]
  }

  if (input.setupKind === 'available-readonly' || input.setupKind === 'requires-environment') {
    return [
      providerAction({
        id: 'configure',
        label:
          input.setupKind === 'requires-environment'
            ? 'Requires environment'
            : 'Manual setup required',
        enabled: false,
        disabledReason: 'OpenCode did not expose an app-managed setup schema for this provider',
        requiresSecret: false,
        ownershipScope: 'runtime',
      }),
    ]
  }

  return buildProviderActions(input)
}

function getProviderDirectoryDetail(input: {
  connected: boolean
  setupKind: ProviderDirectoryEntry['setupKind']
  modelCount: number | null
  configuredAuthless: boolean
  ownership: readonly ProviderOwnership[]
}): string {
  if (input.connected) {
    return getConnectedProviderDetail(input.ownership)
  }
  if (input.configuredAuthless && input.modelCount !== null && input.modelCount > 0) {
    return 'Configured local OpenCode model route is available'
  }
  if (input.setupKind === 'connect-api-key') {
    return 'App-managed API-key setup is available for this provider'
  }
  if (input.setupKind === 'connect-oauth') {
    return 'App-managed OAuth setup is available for this provider'
  }
  if (input.modelCount !== null && input.modelCount > 0) {
    return 'Models are visible, but no connected credential was reported'
  }
  return 'Inline setup is not supported for this provider yet'
}

function providerDirectoryEntryMatchesQuery(
  entry: ProviderDirectoryEntry,
  modelIds: readonly string[],
  query: string,
): boolean {
  if (!query) {
    return true
  }
  return [
    entry.providerId,
    entry.displayName,
    entry.detail ?? '',
    entry.setupKind,
    entry.sourceLabel ?? '',
    entry.providerSource ?? '',
    ...entry.authMethods,
    ...modelIds,
  ].some(value => value.toLowerCase().includes(query))
}

function providerDirectoryEntryMatchesFilter(
  entry: ProviderDirectoryEntry,
  filter: ProviderDirectoryFilter,
): boolean {
  switch (filter) {
    case 'connected':
      return entry.state === 'connected'
    case 'configured':
      return entry.sources.includes('config-provider')
    case 'connectable':
      return entry.setupKind === 'connect-api-key' || entry.setupKind === 'connect-oauth'
    case 'manual':
      return (
        entry.setupKind === 'configure-manually' ||
        entry.setupKind === 'requires-environment' ||
        entry.setupKind === 'unsupported'
      )
    case 'has-models':
      return entry.modelCount !== null && entry.modelCount > 0
    case 'all':
      return true
  }
}

function sortProviderDirectoryEntries(
  entries: readonly ProviderDirectoryEntry[],
): ProviderDirectoryEntry[] {
  const getDirectorySortRank = (entry: ProviderDirectoryEntry): number => {
    if (entry.state === 'connected') return 0
    if (entry.metadata.configuredAuthless) return 1
    if (isRecommendedProvider(entry.providerId)) return 2
    if (entry.setupKind === 'connect-api-key' || entry.setupKind === 'connect-oauth') return 3
    if (entry.setupKind === 'available-readonly') return 4
    if (entry.setupKind === 'configure-manually' || entry.setupKind === 'requires-environment') {
      return 5
    }
    return 6
  }

  return [...entries].sort((left, right) => {
    const rank = getDirectorySortRank(left) - getDirectorySortRank(right)
    if (rank !== 0) {
      return rank
    }

    return left.displayName.localeCompare(right.displayName)
  })
}

function buildSummaryConfigProviders(
  inventory: OpenCodeInventorySnapshot,
): OpenCodeConfigProvidersResponse | null {
  const managedProviders = asRecord(inventory.profile?.managedConfig.provider)
  if (!managedProviders) {
    return null
  }

  const providers = Object.entries(managedProviders).flatMap(([rawProviderId, rawConfig]) => {
    const providerId = normalizeProviderId(rawProviderId)
    const config = asRecord(rawConfig)
    if (!providerId || !config || !SUMMARY_PROVIDER_IDS.has(providerId)) {
      return []
    }
    const name = asString(config.name)
    const npm = asString(config.npm)
    const source = asString(config.source)
    const options = asRecord(config.options)
    const models = asRecord(config.models)
    const provider: OpenCodeProviderListEntry = {
      id: providerId,
      ...(name ? { name } : {}),
      ...(npm ? { npm } : {}),
      ...(source ? { source } : {}),
      ...(options ? { options } : {}),
      ...(models ? { models } : {}),
    }
    return [provider]
  })

  return providers.length > 0 ? { providers } : null
}

function buildSummaryProviderDirectory(input: {
  inventory: OpenCodeInventorySnapshot
  query?: string | null
  filter?: ProviderDirectoryFilter | null
  limit?: number | null
  cursor?: string | null
}): ProviderDirectoryView {
  const inventory: OpenCodeInventorySnapshot = {
    ...input.inventory,
    availableProviders: Array.from(new Set([
      ...input.inventory.availableProviders,
      ...SUMMARY_PROVIDER_IDS,
    ])),
  }
  const configProviders = buildSummaryConfigProviders(inventory)
  const source = {
    inventory,
    configProviders,
    providers: null,
    providerAuth: SUMMARY_PROVIDER_AUTH_METHODS,
    capabilities: SUMMARY_CAPABILITIES,
    diagnostics: inventory.diagnostics,
  }
  const unpagedDirectory = buildProviderDirectory({
    ...source,
    query: null,
    filter: 'all',
    limit: Number.MAX_SAFE_INTEGER,
    cursor: null,
  })
  const entries = unpagedDirectory.entries.filter(entry =>
    SUMMARY_PROVIDER_IDS.has(entry.providerId),
  )
  const summaryDirectory: ProviderDirectoryView = {
    ...unpagedDirectory,
    totalCount: entries.length,
    returnedCount: entries.length,
    nextCursor: null,
    entries,
  }

  return filterAndPageProviderDirectory({
    directory: summaryDirectory,
    modelIdsByProviderId: buildProviderDirectoryModelSearchIndex(source),
    query: input.query,
    filter: input.filter,
    limit: input.limit,
    cursor: input.cursor,
  })
}

function buildProviderDirectory(input: {
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
  providerAuth: Record<string, OpenCodeProviderAuthMethod[]> | null
  capabilities?: OpenCodeProviderManagementCapabilities
  diagnostics: readonly string[]
  query?: string | null
  filter?: ProviderDirectoryFilter | null
  limit?: number | null
  cursor?: string | null
}): ProviderDirectoryView {
  const capabilities = input.capabilities ?? EMPTY_CAPABILITIES
  const connectedProviders = getConnectedProviderMap(input.inventory, input.providers)
  const modelCounts = getModelCounts(input.inventory, input.configProviders, input.providers)
  const entries = getProviderEntries(input.configProviders, input.providers)
  const providerIds = getKnownProviderIds(input)
  const query = normalizeQuery(input.query)
  const filter = normalizeDirectoryFilter(input.filter)
  const limit =
    input.limit === Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER
      : normalizeDirectoryLimit(input.limit)
  const offset = normalizeDirectoryCursor(input.cursor)
  const malformedProviderRows = countMalformedProviderRows({
    configProviders: input.configProviders,
    providers: input.providers,
  })
  const directoryEntries: ProviderDirectoryEntry[] = []

  for (const providerId of providerIds) {
    const entry = entries.get(providerId)
    const connectedProvider = connectedProviders.get(providerId)
    const modelCount = modelCounts.has(providerId) ? modelCounts.get(providerId)! : null
    const authMethods = normalizeAuthMethods(input.providerAuth?.[providerId])
    const connected = connectedProviders.has(providerId)
    const configuredAuthless = providerHasConfiguredAuthlessModels({
      providerId,
      inventory: input.inventory,
      configProviders: input.configProviders,
      providers: input.providers,
    })
    const displayConnected = shouldDisplayProviderAsConnected({
      connected,
      connectedProvider,
      configuredAuthless,
    })
    const ownership = getOwnership({
      connected: displayConnected,
      connectedProvider,
      inventory: input.inventory,
    })
    const setupKind = getProviderSetupKind({
      connected: displayConnected,
      providerId,
      modelCount,
      authMethods,
      capabilities,
    })
    const state: ProviderConnection['state'] = displayConnected
      ? 'connected'
      : modelCount !== null && modelCount > 0
        ? 'available'
        : 'not-connected'
    const sources = collectProviderDirectorySources({
      providerId,
      inventory: input.inventory,
      configProviders: input.configProviders,
      providers: input.providers,
    })
    const modelIds = collectProviderModelIds({
      providerId,
      inventory: input.inventory,
      configProviders: input.configProviders,
      providers: input.providers,
    })
    const directoryEntry: ProviderDirectoryEntry = {
      providerId,
      displayName: getProviderDisplayName(providerId, entry),
      state,
      connectedAuthHint: displayConnected ? (connectedProvider?.authHint ?? null) : null,
      setupKind,
      ownership,
      recommended: isRecommendedProvider(providerId),
      modelCount,
      authMethods,
      defaultModelId: getDefaultModelForProvider(
        providerId,
        input.inventory,
        input.configProviders,
        input.providers,
      ),
      sources,
      sourceLabel: getProviderSourceLabel(sources),
      providerSource: getProviderSourceValue(entry),
      detail: getProviderDirectoryDetail({
        connected: displayConnected,
        setupKind,
        modelCount,
        configuredAuthless,
        ownership,
      }),
      actions: buildProviderDirectoryActions({
        providerId,
        connected: displayConnected,
        connectedAuthHint: connectedProvider?.authHint ?? null,
        modelCount,
        authMethods,
        ownership,
        capabilities,
        setupKind,
        configuredAuthless,
      }),
      metadata: {
        hasKnownModels: modelCount !== null && modelCount > 0,
        requiresManualConfig:
          !configuredAuthless &&
          (setupKind === 'configure-manually' || setupKind === 'requires-environment'),
        supportedInlineAuth: setupKind === 'connect-api-key' || setupKind === 'connect-oauth',
        configuredAuthless,
      },
    }

    if (
      providerDirectoryEntryMatchesQuery(directoryEntry, modelIds, query) &&
      providerDirectoryEntryMatchesFilter(directoryEntry, filter)
    ) {
      directoryEntries.push(directoryEntry)
    }
  }

  const sortedEntries = sortProviderDirectoryEntries(directoryEntries)
  const returnedEntries =
    limit === Number.MAX_SAFE_INTEGER
      ? sortedEntries.slice(offset)
      : sortedEntries.slice(offset, offset + limit)
  const nextOffset = offset + returnedEntries.length

  return {
    runtimeId: 'opencode',
    totalCount: sortedEntries.length,
    returnedCount: returnedEntries.length,
    query: query || null,
    filter,
    limit,
    cursor: input.cursor?.trim() || null,
    nextCursor: nextOffset < sortedEntries.length ? String(nextOffset) : null,
    entries: returnedEntries,
    diagnostics: redactDiagnostics([
      ...input.diagnostics,
      ...(malformedProviderRows > 0
        ? [`Skipped ${malformedProviderRows} malformed OpenCode provider row(s)`]
        : []),
    ]),
    fetchedAt: new Date().toISOString(),
  }
}

function filterAndPageProviderDirectory(input: {
  directory: ProviderDirectoryView
  modelIdsByProviderId?: Record<string, readonly string[]> | null
  query?: string | null
  filter?: ProviderDirectoryFilter | null
  limit?: number | null
  cursor?: string | null
}): ProviderDirectoryView {
  const query = normalizeQuery(input.query)
  const filter = normalizeDirectoryFilter(input.filter)
  const limit = normalizeDirectoryLimit(input.limit)
  const offset = normalizeDirectoryCursor(input.cursor)
  const matchingEntries = input.directory.entries.filter(
    entry =>
      providerDirectoryEntryMatchesQuery(
        entry,
        input.modelIdsByProviderId?.[entry.providerId] ?? [],
        query,
      ) && providerDirectoryEntryMatchesFilter(entry, filter),
  )
  const returnedEntries = matchingEntries.slice(offset, offset + limit)
  const nextOffset = offset + returnedEntries.length

  return {
    ...input.directory,
    totalCount: matchingEntries.length,
    returnedCount: returnedEntries.length,
    query: query || null,
    filter,
    limit,
    cursor: input.cursor?.trim() || null,
    nextCursor: nextOffset < matchingEntries.length ? String(nextOffset) : null,
    entries: returnedEntries,
  }
}

function buildView(input: {
  inventory: OpenCodeInventorySnapshot
  host: OpenCodeHostHandle | null
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
  providerAuth: Record<string, OpenCodeProviderAuthMethod[]> | null
  capabilities?: OpenCodeProviderManagementCapabilities
  diagnostics: readonly string[]
  hostStartError?: string | null
}): ProviderManagementView {
  const providerConnections = buildProviderConnections({
    inventory: input.inventory,
    configProviders: input.configProviders,
    providers: input.providers,
    providerAuth: input.providerAuth,
    capabilities: input.capabilities ?? EMPTY_CAPABILITIES,
  })
  const connectedProviderCount = providerConnections.filter(
    provider => provider.state === 'connected',
  ).length
  const configuredModels = buildConfiguredOpenCodeModels({
    inventory: input.inventory,
    configProviders: input.configProviders,
    providers: input.providers,
  })
  const launchableRouteCount = configuredModels.filter(
    model =>
      model.routeKind === 'configured_local' ||
      model.routeKind === 'builtin_free' ||
      model.routeKind === 'connected_provider',
  ).length
  const defaultModel = getDefaultModel(input.inventory, input.configProviders, input.providers)
  const fallbackModel = getFallbackModel(input.inventory)

  return {
    runtimeId: 'opencode',
    title: 'OpenCode Providers',
    runtime: {
      state: getRuntimeState({
        inventory: input.inventory,
        host: input.host,
        hostStartError: input.hostStartError ?? null,
        connectedProviderCount,
        launchableRouteCount,
        diagnostics: input.diagnostics,
      }),
      cliPath: input.inventory.binaryPath,
      version: input.host?.version ?? input.inventory.version,
      managedProfile: getManagedProfileState(input.inventory),
      localAuth: getLocalAuthState(input.inventory),
    },
    providers: providerConnections,
    configuredModels,
    projectPath: input.inventory.projectPath,
    projectDefaultModel: input.inventory.profile?.projectDefaultModelId ?? null,
    allProjectsDefaultModel: input.inventory.profile?.allProjectsDefaultModelId ?? null,
    defaultModelSource: getDefaultModelSource({
      inventory: input.inventory,
      defaultModel,
      fallbackModel,
    }),
    defaultModel,
    fallbackModel,
    diagnostics: input.diagnostics,
  }
}

async function readLiveView(input: {
  inventory: OpenCodeInventorySnapshot
  host: OpenCodeHostHandle
  client: OpenCodeProviderManagementClient
  diagnostics?: readonly string[]
}): Promise<ProviderManagementView> {
  const serverDocRead = input.client.getServerDoc
    ? safeRead(() => input.client.getServerDoc!())
    : Promise.resolve({
        ok: true,
        value: null,
      } as SafeValue<OpenCodeServerDocResponse | null>)

  const [configProvidersResult, providersResult, providerAuthResult, serverDocResult] =
    await Promise.all([
      safeRead(() => input.client.getConfigProviders()),
      safeRead(() => input.client.getProviders()),
      safeRead(() => input.client.getProviderAuth()),
      serverDocRead,
    ])

  const diagnostics = [
    ...(input.diagnostics ?? []),
    ...safeReadDiagnostics(configProvidersResult),
    ...safeReadDiagnostics(providersResult),
    ...safeReadDiagnostics(providerAuthResult),
    ...safeReadDiagnostics(serverDocResult),
  ]

  return buildView({
    inventory: input.inventory,
    host: input.host,
    configProviders: configProvidersResult.ok ? configProvidersResult.value : null,
    providers: providersResult.ok ? providersResult.value : null,
    providerAuth: providerAuthResult.ok ? providerAuthResult.value : null,
    capabilities: getCapabilities(serverDocResult.ok ? serverDocResult.value : null),
    diagnostics,
  })
}

function findProviderConnection(
  view: ProviderManagementView,
  providerId: string,
): ProviderConnection | null {
  return view.providers.find(provider => provider.providerId === providerId) ?? null
}

function getCatalogStatusFromModelValue(value: unknown): ProviderModelCatalogStatus {
  const record = asRecord(value)
  const rawStatus = asString(record?.status)?.trim().toLowerCase()
  if (record?.deprecated === true || rawStatus === 'deprecated') return 'deprecated'
  if (rawStatus === 'alpha') return 'alpha'
  if (rawStatus === 'beta') return 'beta'
  return 'active'
}

function getProviderModelCatalogStatus(input: {
  providerId: string
  modelId: string
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
}): ProviderModelCatalogStatus {
  const nestedModelId = input.modelId.startsWith(`${input.providerId}/`)
    ? input.modelId.slice(input.providerId.length + 1)
    : input.modelId
  const statuses: ProviderModelCatalogStatus[] = []
  const inventoryStatus = input.inventory.modelMetadata?.find(
    metadata => metadata.id === input.modelId,
  )?.catalogStatus
  if (inventoryStatus) statuses.push(inventoryStatus)

  const configProvider = input.configProviders?.providers?.find(
    provider => normalizeProviderId(provider.id) === input.providerId,
  )
  const configModels = asRecord(configProvider?.models)
  if (configModels && nestedModelId in configModels) {
    statuses.push(getCatalogStatusFromModelValue(configModels[nestedModelId]))
  }

  const liveProvider = input.providers?.all?.find(
    provider => normalizeProviderId(provider.id) === input.providerId,
  )
  const liveModels = asRecord(liveProvider?.models)
  if (liveModels && nestedModelId in liveModels) {
    statuses.push(getCatalogStatusFromModelValue(liveModels[nestedModelId]))
  }

  if (statuses.includes('deprecated')) return 'deprecated'
  if (statuses.includes('alpha')) return 'alpha'
  if (statuses.includes('beta')) return 'beta'
  return 'active'
}

function collectProviderModelIds(input: {
  providerId: string
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
  includeDeprecatedModelIds?: ReadonlySet<string>
}): string[] {
  const modelIds = new Set<string>()
  const prefix = `${input.providerId}/`

  for (const modelId of input.inventory.models) {
    const normalizedModelId = modelId.trim()
    if (normalizedModelId.startsWith(prefix) && normalizedModelId.length > prefix.length) {
      modelIds.add(normalizedModelId)
    }
  }

  const configProvider = input.configProviders?.providers?.find(
    provider => normalizeProviderId(provider.id) === input.providerId,
  )
  const configModels = asRecord(configProvider?.models)
  for (const modelId of Object.keys(configModels ?? {})) {
    const normalizedModelId = modelId.trim()
    if (normalizedModelId) {
      modelIds.add(`${input.providerId}/${normalizedModelId}`)
    }
  }

  const liveProvider = input.providers?.all?.find(
    provider => normalizeProviderId(provider.id) === input.providerId,
  )
  const liveModels = asRecord(liveProvider?.models)
  for (const modelId of Object.keys(liveModels ?? {})) {
    const normalizedModelId = modelId.trim()
    if (normalizedModelId) {
      modelIds.add(`${input.providerId}/${normalizedModelId}`)
    }
  }

  return Array.from(modelIds)
    .filter(modelId =>
      input.includeDeprecatedModelIds?.has(modelId)
      || getProviderModelCatalogStatus({
        ...input,
        modelId,
      }) !== 'deprecated',
    )
    .sort((left, right) => left.localeCompare(right))
}

function getProviderCredentialValidationModelIds(input: {
  providerId: string
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
}): string[] {
  const modelIds = collectProviderModelIds(input)
  if (modelIds.length === 0) {
    return []
  }

  const candidates: string[] = []
  const appendCandidates = (candidateIds: readonly string[]): void => {
    for (const modelId of candidateIds) {
      if (modelIds.includes(modelId) && !candidates.includes(modelId)) {
        candidates.push(modelId)
      }
    }
  }
  const isFreeCandidate = (modelId: string): boolean =>
    modelId === `${input.providerId}/openrouter/free`
    || isOpenCodeModelFree(modelId, input.inventory.modelMetadata)
  const preferredModelIds = CONNECT_EXECUTION_PROOF_MODEL_PREFERENCES[input.providerId] ?? []

  appendCandidates(preferredModelIds.filter(isFreeCandidate))
  appendCandidates(modelIds.filter(isFreeCandidate))
  appendCandidates(preferredModelIds)

  const defaultModelId = getDefaultModelForProvider(
    input.providerId,
    input.inventory,
    input.configProviders,
    input.providers,
  )
  if (defaultModelId) appendCandidates([defaultModelId])
  appendCandidates(modelIds)

  const maxCandidates = input.providerId === 'github-copilot'
    ? Math.max(CONNECT_EXECUTION_PROOF_MAX_CANDIDATES, preferredModelIds.length)
    : CONNECT_EXECUTION_PROOF_MAX_CANDIDATES
  return candidates.slice(0, maxCandidates)
}

function buildProviderDirectoryModelSearchIndex(input: {
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
}): Record<string, string[]> {
  const modelIdsByProviderId: Record<string, string[]> = {}
  for (const providerId of getKnownProviderIds(input)) {
    modelIdsByProviderId[providerId] = collectProviderModelIds({
      providerId,
      inventory: input.inventory,
      configProviders: input.configProviders,
      providers: input.providers,
    })
  }
  return modelIdsByProviderId
}

function providerModelMatchesQuery(model: RuntimeProviderModel, query: string): boolean {
  if (!query) {
    return true
  }
  return [
    model.modelId,
    model.displayName,
    model.sourceLabel,
    model.routeKind,
    model.accessKind,
    model.proofState,
    model.catalogStatus,
    model.free ? 'free' : '',
    model.requiresExecutionProof ? 'needs test' : '',
  ].some(value => value.toLowerCase().includes(query))
}

function buildRuntimeProviderModel(input: {
  providerId: string
  modelId: string
  providerEntry?: OpenCodeProviderListEntry
  defaultModelId: string | null
  availability?: ProviderModelAvailability
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
  accessCatalog: OpenCodeModelAccessCatalog
  managedModelLimitOverrides?: Readonly<Record<string, OpenCodeManagedModelLimitOverride>>
}): RuntimeProviderModel {
  const nestedModelId = input.modelId.slice(`${input.providerId}/`.length)
  const sourceLabel = getProviderDisplayName(input.providerId, input.providerEntry)
  const routeMetadata = buildOpenCodeModelRouteMetadata({
    selectedModel: input.modelId,
    catalog: input.accessCatalog,
    sourceLabel,
  })
  const catalogLimits = getCatalogModelLimits(input.inventory, input.modelId)
  const managedLimits = input.managedModelLimitOverrides?.[input.modelId] ?? null
  return {
    modelId: input.modelId,
    providerId: input.providerId,
    displayName: nestedModelId || input.modelId,
    sourceLabel,
    free: isOpenCodeModelFree(input.modelId, input.inventory.modelMetadata),
    default: input.defaultModelId === input.modelId,
    catalogStatus: getProviderModelCatalogStatus({
      providerId: input.providerId,
      modelId: input.modelId,
      inventory: input.inventory,
      configProviders: input.configProviders,
      providers: input.providers,
    }),
    availability: input.availability ?? 'untested',
    accessKind: routeMetadata.accessKind,
    routeKind: routeMetadata.routeKind,
    proofState: routeMetadata.proofState,
    requiresExecutionProof: routeMetadata.requiresExecutionProof,
    accessReason: routeMetadata.reason,
    catalogContextTokens: catalogLimits.contextTokens,
    catalogOutputTokens: catalogLimits.outputTokens,
    managedContextTokens: managedLimits?.contextTokens ?? null,
    managedOutputTokens: managedLimits?.outputTokens ?? null,
    managedUpdatedAt: managedLimits?.updatedAt ?? null,
  }
}

function buildProviderModelsView(input: {
  providerId: string
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
  query?: string | null
  limit?: number | null
  cursor?: string | null
  diagnostics?: readonly string[]
  managedModelLimitOverrides?: Readonly<Record<string, OpenCodeManagedModelLimitOverride>>
}): RuntimeProviderModelsView {
  const entries = getProviderEntries(input.configProviders, input.providers)
  const defaultModelId = getDefaultModelForProvider(
    input.providerId,
    input.inventory,
    input.configProviders,
    input.providers,
  )
  const query = normalizeQuery(input.query)
  const limit = normalizePositiveLimit(input.limit)
  const offset = normalizeDirectoryCursor(input.cursor)
  const accessCatalog = buildProviderManagementAccessCatalog({
    inventory: input.inventory,
    configProviders: input.configProviders,
    providers: input.providers,
  })
  const matchingModels = collectProviderModelIds({
    providerId: input.providerId,
    inventory: input.inventory,
    configProviders: input.configProviders,
    providers: input.providers,
    includeDeprecatedModelIds: defaultModelId ? new Set([defaultModelId]) : undefined,
  })
    .map(modelId =>
      buildRuntimeProviderModel({
        providerId: input.providerId,
        modelId,
        providerEntry: entries.get(input.providerId),
        defaultModelId,
        inventory: input.inventory,
        configProviders: input.configProviders,
        providers: input.providers,
        accessCatalog,
        managedModelLimitOverrides: input.managedModelLimitOverrides,
      }),
    )
    .filter(model => providerModelMatchesQuery(model, query))
  const models = limit
    ? matchingModels.slice(offset, offset + limit)
    : matchingModels.slice(offset)
  const nextOffset = offset + models.length

  return {
    runtimeId: 'opencode',
    providerId: input.providerId,
    totalCount: matchingModels.length,
    returnedCount: models.length,
    limit,
    cursor: input.cursor?.trim() || null,
    nextCursor: nextOffset < matchingModels.length ? String(nextOffset) : null,
    models,
    defaultModelId,
    diagnostics: input.diagnostics ?? [],
  }
}

function buildConfiguredOpenCodeModels(input: {
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
}): RuntimeProviderModel[] {
  const entries = getProviderEntries(input.configProviders, input.providers)
  const accessCatalog = buildProviderManagementAccessCatalog(input)
  const defaultModel = getDefaultModel(input.inventory, input.configProviders, input.providers)
  const modelsById = new Map<string, RuntimeProviderModel>()

  for (const providerId of getKnownProviderIds(input)) {
    const defaultModelId = getDefaultModelForProvider(
      providerId,
      input.inventory,
      input.configProviders,
      input.providers,
    )
    for (const modelId of collectProviderModelIds({
      providerId,
      inventory: input.inventory,
      configProviders: input.configProviders,
      providers: input.providers,
    })) {
      const model = buildRuntimeProviderModel({
        providerId,
        modelId,
        providerEntry: entries.get(providerId),
        defaultModelId,
        inventory: input.inventory,
        configProviders: input.configProviders,
        providers: input.providers,
        accessCatalog,
      })
      if (
        model.routeKind === 'configured_local' ||
        model.routeKind === 'builtin_free' ||
        model.modelId === defaultModel
      ) {
        modelsById.set(model.modelId, {
          ...model,
          default: model.default || model.modelId === defaultModel,
        })
      }
    }
  }

  const defaultModelRef = parseProviderScopedModelId(defaultModel)
  if (defaultModelRef && !modelsById.has(defaultModelRef.modelId)) {
    modelsById.set(defaultModelRef.modelId, {
      ...buildRuntimeProviderModel({
        providerId: defaultModelRef.providerId,
        modelId: defaultModelRef.modelId,
        providerEntry: entries.get(defaultModelRef.providerId),
        defaultModelId: defaultModelRef.modelId,
        inventory: input.inventory,
        configProviders: input.configProviders,
        providers: input.providers,
        accessCatalog,
      }),
      default: true,
    })
  }

  const getRank = (model: RuntimeProviderModel): number => {
    if (model.routeKind === 'configured_local') return 0
    if (model.routeKind === 'builtin_free') return 1
    if (model.default) return 2
    if (model.routeKind === 'connected_provider') return 3
    return 4
  }

  return Array.from(modelsById.values()).sort((left, right) => {
    const rank = getRank(left) - getRank(right)
    if (rank !== 0) {
      return rank
    }
    return left.modelId.localeCompare(right.modelId)
  })
}

function mapProbeOutcomeToAvailability(
  outcome: OpenCodeExecutionProbeOutcome,
): ProviderModelAvailability {
  if (outcome === 'available') return 'available'
  if (outcome === 'not_authenticated') return 'not-authenticated'
  if (outcome === 'unavailable') return 'unavailable'
  return 'unknown'
}

function buildProviderModelTestResult(input: {
  providerId: string
  modelId: string
  probe: OpenCodeExecutionProbeResult
}): ProviderModelTestResult {
  const availability = mapProbeOutcomeToAvailability(input.probe.outcome)
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    ok: input.probe.outcome === 'available',
    availability,
    message:
      input.probe.outcome === 'available'
        ? 'Model probe passed'
        : (input.probe.reason ?? 'Model probe failed'),
    diagnostics: input.probe.diagnostics,
  }
}

function getModelAccessError(input: {
  access: ReturnType<typeof evaluateOpenCodeModelAccess>
  modelId: string
  action: 'test' | 'set-default'
}): ProviderManagementResult<never> | null {
  if (input.access.kind === 'unknown_model' || input.access.kind === 'no_model') {
    return providerManagementError(
      'model-missing',
      input.access.reason ?? `Model ${input.modelId} was not found in the OpenCode live catalog`,
    )
  }

  if (input.access.kind === 'not_authenticated') {
    return providerManagementError(
      'auth-required',
      input.access.reason ?? `Provider for ${input.modelId} is not connected`,
    )
  }

  if (input.access.kind === 'execution_failed') {
    return providerManagementError(
      'model-test-failed',
      input.access.reason ?? `Model probe failed for ${input.modelId}`,
    )
  }

  if (
    input.access.kind !== 'credentialed' &&
    input.access.kind !== 'builtin_free' &&
    input.access.kind !== 'configured_authless' &&
    input.access.kind !== 'verified'
  ) {
    return providerManagementError(
      input.action === 'test' ? 'model-test-failed' : 'auth-required',
      input.access.reason ?? `OpenCode model ${input.modelId} is not launchable`,
    )
  }

  return null
}

export class OpenCodeProviderManagementAdapter
  implements
    ProviderManagementQueryPort,
    ProviderManagementDirectoryQueryPort,
    ProviderManagementCommandPort
{
  private readonly directoryCache = new Map<string, ProviderDirectoryCacheEntry>()
  private hostLeaseSequence = 0

  constructor(private readonly deps: OpenCodeProviderManagementAdapterDeps = {}) {}

  private async retainProviderManagementHost(
    hostManager: OpenCodeHostManagerLike,
    host: OpenCodeHostHandle,
  ): Promise<OpenCodeHostLeaseInput | null> {
    if (!hostManager.retainHostLease) {
      return null
    }
    const lease: OpenCodeHostLeaseInput = {
      teamId: OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID,
      laneId: 'provider-management',
      memberName: `provider-management-${process.pid}-${++this.hostLeaseSequence}`,
      runId: null,
      sessionId: null,
    }
    try {
      await hostManager.retainHostLease(host.hostKey, lease)
      await hostManager.reconcilePersistentHosts?.({
        mode: 'stale',
        reason: 'provider-management-idle-eviction',
        staleAgeMs: OPEN_CODE_PROVIDER_MANAGEMENT_IDLE_HOST_TTL_MS,
        leaseStaleAgeMs: null,
        preflightLeaseStaleAgeMs: OPEN_CODE_PROVIDER_MANAGEMENT_LEASE_STALE_AGE_MS,
      })
      return lease
    } catch {
      await hostManager.releaseHostLease?.(host.hostKey, lease).catch(() => undefined)
      return null
    }
  }

  private async releaseProviderManagementHost(
    hostManager: OpenCodeHostManagerLike,
    host: OpenCodeHostHandle,
    lease: OpenCodeHostLeaseInput | null,
  ): Promise<void> {
    if (!lease || !hostManager.releaseHostLease) {
      return
    }
    await hostManager.releaseHostLease(host.hostKey, lease).catch(() => undefined)
  }

  private getDirectoryCacheKey(input: {
    runtimeId: ProviderManagementRuntimeId
    inventory: OpenCodeInventorySnapshot
    host: OpenCodeHostHandle | null
  }): string {
    return [
      input.runtimeId,
      input.inventory.projectPath,
      input.host?.version ?? input.inventory.version ?? 'unknown-version',
      input.inventory.profile?.profileRootKey ?? 'missing-profile',
      input.host?.resolvedConfigFingerprint ??
        input.inventory.profile?.managedConfigFingerprint ??
        input.inventory.profile?.projectBehaviorFingerprint ??
        'missing-config',
    ].join('|')
  }

  private readDirectoryCache(cacheKey: string): ProviderDirectoryCacheEntry | null {
    const entry = this.directoryCache.get(cacheKey)
    if (!entry) {
      return null
    }
    if (entry.expiresAt <= Date.now()) {
      this.directoryCache.delete(cacheKey)
      return null
    }
    return entry
  }

  private writeDirectoryCache(
    cacheKey: string,
    value: ProviderDirectoryView,
    modelIdsByProviderId: Record<string, string[]>,
  ): void {
    this.directoryCache.set(cacheKey, {
      expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS,
      value,
      modelIdsByProviderId,
    })
  }

  private invalidateDirectoryCache(): void {
    this.directoryCache.clear()
  }

  private async probeInventory(
    inventoryService: OpenCodeInventoryServiceLike,
    projectPath?: string | null,
    options?: Parameters<typeof openCodeInventoryService.probe>[1],
  ): Promise<OpenCodeInventorySnapshot> {
    const abortController = new AbortController()
    const progress = createOpenCodeInventoryProbeProgressTracker()
    return withOpenCodeInventoryProbeTimeout(
      inventoryService.probe(projectPath, {
        ...options,
        includeAppMcp: false,
        abortSignal: abortController.signal,
        progress,
      }),
      {
        projectPath,
        timeoutMs:
          this.deps.inventoryTimeoutMs ??
          (options?.mode === 'summary'
            ? OPEN_CODE_INVENTORY_SUMMARY_TIMEOUT_MS
            : OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS),
        progress,
        onTimeout: () => abortController.abort(),
      },
    )
  }

  private getAuthStore() {
    const configured = this.deps.authStore
    return {
      upsertApiAuth: async (input: {
        authPath: string
        providerId: string
        auth: OpenCodeApiAuthInput
      }) => {
        if (configured?.upsertApiAuth) {
          await configured.upsertApiAuth(input)
          return
        }
        if (configured?.upsertApiKey) {
          await configured.upsertApiKey({
            authPath: input.authPath,
            providerId: input.providerId,
            apiKey: input.auth.key,
            ...(input.auth.metadata ? { metadata: input.auth.metadata } : {}),
          })
          return
        }
        await upsertOpenCodeApiAuth(input.authPath, input.providerId, input.auth)
      },
      upsertApiKey: configured?.upsertApiKey ?? upsertOpenCodeApiAuthCredential,
      readCredential: configured?.readCredential ?? readOpenCodeAuthCredential,
      upsertCredential: configured?.upsertCredential ?? upsertOpenCodeAuthCredential,
      removeCredential: removeOpenCodeAuthCredential,
      ...(configured?.removeCredential ? { removeCredential: configured.removeCredential } : {}),
    }
  }

  private getExecutionProbe() {
    return this.deps.executionProbe ?? openCodeExecutionProbe
  }

  private getManagedPreferences() {
    const configured = this.deps.managedPreferences
    return configured
      ? {
          ...configured,
          read: configured.read ?? readOpenCodeManagedRuntimePreferences,
          clearProjectDefaultModel:
            configured.clearProjectDefaultModel ?? clearOpenCodeManagedDefaultModel,
        }
      : {
        read: readOpenCodeManagedRuntimePreferences,
        clearProjectDefaultModel: clearOpenCodeManagedDefaultModel,
        setDefaultModel: setOpenCodeManagedDefaultModel,
        setModelLimits: setOpenCodeManagedModelLimits,
        setAllProjectsDefaultModel: (modelId: string) =>
          setOpenCodeManagedGlobalDefaultModel(resolveClaudeMultimodelPaths().data, modelId),
      }
  }

  private getProfileManager() {
    return this.deps.profileManager ?? openCodeProfileManager
  }

  private async rollbackProviderAuth(input: {
    client: OpenCodeProviderManagementClient
    providerId: string
    authPaths: readonly (string | null | undefined)[]
    canDeleteProviderAuth: boolean
    previousCredentials?: ReadonlyMap<string, OpenCodeAuthCredential | null>
  }): Promise<void> {
    if (input.canDeleteProviderAuth && input.client.deleteProviderAuth) {
      await input.client.deleteProviderAuth(input.providerId).catch(() => undefined)
    }

    const authStore = this.getAuthStore()
    await Promise.all(
      input.authPaths
        .filter((authPath): authPath is string => Boolean(authPath))
        .map(authPath => {
          const previousCredential = input.previousCredentials?.get(authPath) ?? null
          return previousCredential
            ? authStore
                .upsertCredential({
                  authPath,
                  providerId: input.providerId,
                  credential: previousCredential,
                })
                .catch(() => undefined)
            : authStore
                .removeCredential({ authPath, providerId: input.providerId })
                .catch(() => undefined)
        }),
    )
  }

  private async captureProviderAuthSnapshot(input: {
    providerId: string
    authPaths: readonly string[]
  }): Promise<ReadonlyMap<string, OpenCodeAuthCredential | null>> {
    const authStore = this.getAuthStore()
    const uniquePaths = Array.from(new Set(input.authPaths))
    const credentials = await Promise.all(
      uniquePaths.map(authPath =>
        authStore.readCredential({ authPath, providerId: input.providerId }),
      ),
    )
    return new Map(uniquePaths.map((authPath, index) => [authPath, credentials[index] ?? null]))
  }

  private isNewOAuthCredential(
    credential: OpenCodeAuthCredential | null,
    previousCredentials: ReadonlyMap<string, OpenCodeAuthCredential | null>,
    acceptEquivalentCredential = false,
  ): credential is OpenCodeAuthCredential {
    if (credential?.type !== 'oauth') {
      return false
    }
    if (acceptEquivalentCredential) {
      return true
    }
    return !Array.from(previousCredentials.values()).some(
      previous => previous !== null && credentialsEqual(credential, previous),
    )
  }

  private async clearOAuthCredentialBaseline(input: {
    client: OpenCodeProviderManagementClient
    providerId: string
    authPaths: readonly string[]
    canDeleteProviderAuth: boolean
    previousCredentials: ReadonlyMap<string, OpenCodeAuthCredential | null>
  }): Promise<ProviderManagementResult<boolean>> {
    const hadCredential = Array.from(input.previousCredentials.values()).some(Boolean)
    if (!hadCredential) {
      return { ok: true, value: false }
    }
    if (!input.canDeleteProviderAuth || !input.client.deleteProviderAuth) {
      // Older OpenCode versions cannot prove that an equivalent token was
      // written by this reconnect attempt, so retain the stricter comparison.
      return { ok: true, value: false }
    }

    const authStore = this.getAuthStore()
    try {
      const deleted = await input.client.deleteProviderAuth(input.providerId)
      if (deleted !== true) {
        throw new Error('OpenCode did not confirm credential removal')
      }
      await Promise.all(
        input.authPaths.map(authPath =>
          authStore.removeCredential({ authPath, providerId: input.providerId }),
        ),
      )
      const cleared = await this.captureProviderAuthSnapshot({
        providerId: input.providerId,
        authPaths: input.authPaths,
      })
      if (Array.from(cleared.values()).some(Boolean)) {
        throw new Error('OpenCode credential remained after removal')
      }
      return { ok: true, value: true }
    } catch (error) {
      await this.rollbackProviderAuth({
        client: input.client,
        providerId: input.providerId,
        authPaths: input.authPaths,
        canDeleteProviderAuth: input.canDeleteProviderAuth,
        previousCredentials: input.previousCredentials,
      })
      return providerManagementError(
        'auth-failed',
        error instanceof Error
          ? `Unable to prepare ${input.providerId} for reconnect: ${error.message}`
          : `Unable to prepare ${input.providerId} for reconnect`,
      )
    }
  }

  private async waitForNewOAuthCredential(input: {
    authPath: string
    providerId: string
    previousCredentials: ReadonlyMap<string, OpenCodeAuthCredential | null>
    acceptEquivalentCredential?: boolean
    signal: AbortSignal
  }): Promise<OpenCodeAuthCredential | null> {
    const authStore = this.getAuthStore()
    while (!input.signal.aborted) {
      try {
        const credential = await authStore.readCredential({
          authPath: input.authPath,
          providerId: input.providerId,
        })
        if (
          this.isNewOAuthCredential(
            credential,
            input.previousCredentials,
            input.acceptEquivalentCredential,
          )
        ) {
          return credential
        }
      } catch {
        // Atomic auth-store replacement can make one poll transiently unreadable.
      }
      if (
        !(await waitForAbortableDelay(
          AUTO_OAUTH_CREDENTIAL_POLL_INTERVAL_MS,
          input.signal,
        ))
      ) {
        return null
      }
    }
    return null
  }

  private async verifyConnectedProviderExecution(input: {
    providerId: string
    inventory: OpenCodeInventorySnapshot
    configProviders: OpenCodeConfigProvidersResponse | null
    providers: OpenCodeProviderResponse | null
    secretToRedact?: string | null
    required?: boolean
  }): Promise<ProviderManagementResult<string | null>> {
    if (!input.required && !requiresConnectExecutionProof(input.providerId)) {
      return { ok: true, value: null }
    }

    const validationModelIds = getProviderCredentialValidationModelIds({
      providerId: input.providerId,
      inventory: input.inventory,
      configProviders: input.configProviders,
      providers: input.providers,
    })
    if (validationModelIds.length === 0) {
      return providerManagementError(
        'model-missing',
        `OpenCode did not expose a probeable model for provider ${input.providerId}`,
      )
    }

    const failedCandidates: string[] = []
    let copilotUnsupportedCandidateCount = 0
    for (const validationModelId of validationModelIds) {
      const runtimeDeadline = new OpenCodeRuntimeDeadline(
        CONNECT_EXECUTION_PROOF_CANDIDATE_TIMEOUT_MS,
      )
      let probeResult: OpenCodeExecutionProbeResult
      try {
        probeResult = await this.getExecutionProbe().probeModel({
          selectedModel: validationModelId,
          projectPath: input.inventory.projectPath,
          // Keep the probe's provider-safe output budget. Reasoning models can
          // exhaust tiny overrides before emitting the verification response.
          bypassCache: true,
          runtimeDeadline,
        })
      } catch (error) {
        const reason = redactSecret(
          error instanceof Error ? error.message : String(error),
          input.secretToRedact ?? '',
        )
        failedCandidates.push(`${validationModelId}: ${reason}`)
        if (
          input.providerId === 'github-copilot'
          && isCopilotExplicitModelUnsupported(reason)
        ) {
          copilotUnsupportedCandidateCount += 1
        }
        continue
      } finally {
        runtimeDeadline.dispose()
      }

      if (probeResult.outcome === 'available') {
        return { ok: true, value: validationModelId }
      }

      const probeReason = redactSecret(
        probeResult.reason ?? `Model probe failed for ${validationModelId}`,
        input.secretToRedact ?? '',
      )
      const copilotExplicitModelUnsupported = input.providerId === 'github-copilot'
        && isCopilotExplicitModelUnsupported(probeReason)
      if (copilotExplicitModelUnsupported) {
        failedCandidates.push(`${validationModelId}: ${probeReason}`)
        copilotUnsupportedCandidateCount += 1
        continue
      }
      if (probeResult.outcome === 'not_authenticated') {
        return providerManagementError(
          'auth-failed',
          probeResult.reason
            ? probeReason
            : `Provider authentication failed for ${validationModelId}`,
        )
      }
      failedCandidates.push(`${validationModelId}: ${probeReason}`)
    }

    if (
      input.providerId === 'github-copilot'
      && copilotUnsupportedCandidateCount === validationModelIds.length
    ) {
      return providerManagementError(
        'model-test-failed',
        COPILOT_EXPLICIT_MODEL_UNSUPPORTED_MESSAGE,
      )
    }

    return providerManagementError(
      'model-test-failed',
      `OpenCode could not verify provider ${input.providerId} with ${validationModelIds.length} model candidate${validationModelIds.length === 1 ? '' : 's'}: ${failedCandidates.join('; ')}`,
    )
  }

  private async withManagedOpenCodeClient<T>(
    runtimeId: ProviderManagementRuntimeId,
    projectPath: string | null | undefined,
    run: (input: {
      inventory: OpenCodeInventorySnapshot
      inventoryService: OpenCodeInventoryServiceLike
      host: OpenCodeHostHandle
      client: OpenCodeProviderManagementClient
    }) => Promise<ProviderManagementResult<T>>,
    options: {
      failureCode?: ProviderManagementErrorCode
      secretToRedact?: string | null
      inventoryMode?: 'full' | 'summary' | 'profile'
      hostLifetime?: 'persistent' | 'process'
    } = {},
  ): Promise<ProviderManagementResult<T>> {
    if (runtimeId !== 'opencode') {
      return providerManagementError(
        'unsupported-runtime',
        `Provider management is not available for ${runtimeId}`,
        false,
      )
    }

    const inventoryService = this.deps.inventoryService ?? openCodeInventoryService
    const inventory = await this.probeInventory(inventoryService, projectPath, {
      mode: options.inventoryMode ?? 'full',
    })

    if (!inventory.detected) {
      return providerManagementError('runtime-missing', 'OpenCode CLI not detected on PATH')
    }
    if (isOpenCodeInventoryTimeoutSnapshot(inventory)) {
      return providerManagementError(
        'runtime-unhealthy',
        inventory.probeError ?? 'OpenCode inventory probe timed out',
      )
    }

    const hostManager = this.deps.hostManager ?? openCodeHostManager
    const clientFactory = this.deps.clientFactory ?? openCodeClientFactory
    const hostLifetime = options.hostLifetime ?? 'persistent'
    let host: OpenCodeHostHandle | null = null
    let hostLease: OpenCodeHostLeaseInput | null = null

    try {
      host = await hostManager.ensureHost({
        projectPath: inventory.projectPath,
        hostLifetime,
        resolveConfigFingerprint: false,
      })
      if (hostLifetime === 'persistent') {
        hostLease = await this.retainProviderManagementHost(hostManager, host)
      }
      const client = clientFactory.create(host.baseUrl)
      return await run({ inventory, inventoryService, host, client })
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      return providerManagementError(
        options.failureCode ?? 'runtime-unhealthy',
        redactSecret(rawMessage, options.secretToRedact),
      )
    } finally {
      if (host) {
        await this.releaseProviderManagementHost(hostManager, host, hostLease)
        await hostManager
          .releaseHost(host.hostKey, {
            keepPersistentAlive: hostLifetime === 'persistent',
          })
          .catch(() => undefined)
      }
    }
  }

  async loadView(
    input: LoadProviderManagementViewInput | ProviderManagementRuntimeId,
  ): Promise<ProviderManagementResult<ProviderManagementView>> {
    const request = typeof input === 'string' ? { runtimeId: input } : input
    if (request.runtimeId !== 'opencode') {
      return {
        ok: false,
        error: {
          code: 'unsupported-runtime',
          message: `Provider management is not available for ${request.runtimeId}`,
          recoverable: false,
        },
      }
    }

    const inventoryService = this.deps.inventoryService ?? openCodeInventoryService
    const inventory = await this.probeInventory(inventoryService, request.projectPath)

    if (!inventory.detected) {
      return {
        ok: true,
        value: buildView({
          inventory,
          host: null,
          configProviders: null,
          providers: null,
          providerAuth: null,
          diagnostics: inventory.diagnostics,
        }),
      }
    }
    if (isOpenCodeInventoryTimeoutSnapshot(inventory)) {
      return {
        ok: true,
        value: buildView({
          inventory,
          host: null,
          configProviders: null,
          providers: null,
          providerAuth: null,
          diagnostics: inventory.diagnostics,
        }),
      }
    }
    const hostManager = this.deps.hostManager ?? openCodeHostManager
    const clientFactory = this.deps.clientFactory ?? openCodeClientFactory
    let host: OpenCodeHostHandle | null = null
    let hostLease: OpenCodeHostLeaseInput | null = null

    try {
      host = await hostManager.ensureHost({
        projectPath: inventory.projectPath,
        preparedProfile: inventory.profile ?? undefined,
        profileOptions: {
          includeAppMcp: false,
        },
        hostLifetime: 'persistent',
        resolveConfigFingerprint: false,
        healthTimeoutMs: OPEN_CODE_PROVIDER_MANAGEMENT_HOST_HEALTH_TIMEOUT_MS,
      })
      hostLease = await this.retainProviderManagementHost(hostManager, host)
      const client = clientFactory.create(host.baseUrl)

      return {
        ok: true,
        value: await readLiveView({
          inventory,
          host,
          client,
          diagnostics: inventory.diagnostics,
        }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: true,
        value: buildView({
          inventory,
          host,
          configProviders: null,
          providers: null,
          providerAuth: null,
          diagnostics: [...inventory.diagnostics, message],
          hostStartError: host ? null : message,
        }),
      }
    } finally {
      if (host) {
        await this.releaseProviderManagementHost(hostManager, host, hostLease)
        await hostManager
          .releaseHost(host.hostKey, { keepPersistentAlive: true })
          .catch(() => undefined)
      }
    }
  }

  async loadDirectory(
    input: LoadProviderDirectoryInput,
  ): Promise<ProviderManagementResult<ProviderDirectoryView>> {
    if (input.runtimeId !== 'opencode') {
      return providerManagementError(
        'unsupported-runtime',
        `Provider management is not available for ${input.runtimeId}`,
        false,
      )
    }

    const inventoryService = this.deps.inventoryService ?? openCodeInventoryService
    const inventory = await this.probeInventory(inventoryService, input.projectPath, {
      mode: input.summary ? 'summary' : input.refresh ? 'full' : 'profile',
      bypassCache: input.refresh === true,
      refreshModels: input.refresh === true && input.summary !== true,
    })

    if (!inventory.detected) {
      return {
        ok: true,
        value: buildProviderDirectory({
          inventory,
          configProviders: null,
          providers: null,
          providerAuth: null,
          diagnostics: inventory.diagnostics,
          query: input.query,
          filter: input.filter,
          limit: input.limit,
          cursor: input.cursor,
        }),
      }
    }
    if (isOpenCodeInventoryTimeoutSnapshot(inventory)) {
      return {
        ok: true,
        value: buildProviderDirectory({
          inventory,
          configProviders: null,
          providers: null,
          providerAuth: null,
          diagnostics: inventory.diagnostics,
          query: input.query,
          filter: input.filter,
          limit: input.limit,
          cursor: input.cursor,
        }),
      }
    }
    if (input.summary) {
      return {
        ok: true,
        value: buildSummaryProviderDirectory({
          inventory,
          query: input.query,
          filter: input.filter,
          limit: input.limit,
          cursor: input.cursor,
        }),
      }
    }

    const hostManager = this.deps.hostManager ?? openCodeHostManager
    const clientFactory = this.deps.clientFactory ?? openCodeClientFactory
    const hostLifetime = input.refresh ? 'process' : 'persistent'
    let host: OpenCodeHostHandle | null = null
    let hostLease: OpenCodeHostLeaseInput | null = null

    try {
      host = await hostManager.ensureHost({
        projectPath: inventory.projectPath,
        preparedProfile: inventory.profile ?? undefined,
        profileOptions: {
          includeAppMcp: false,
        },
        hostLifetime,
        resolveConfigFingerprint: false,
        healthTimeoutMs: OPEN_CODE_PROVIDER_MANAGEMENT_HOST_HEALTH_TIMEOUT_MS,
      })
      hostLease = await this.retainProviderManagementHost(hostManager, host)
      const cacheKey = this.getDirectoryCacheKey({
        runtimeId: input.runtimeId,
        inventory,
        host,
      })
      if (!input.refresh) {
        const cached = this.readDirectoryCache(cacheKey)
        if (cached) {
          return {
            ok: true,
            value: filterAndPageProviderDirectory({
              directory: cached.value,
              modelIdsByProviderId: cached.modelIdsByProviderId,
              query: input.query,
              filter: input.filter,
              limit: input.limit,
              cursor: input.cursor,
            }),
          }
        }
      }

      const client = clientFactory.create(host.baseUrl)
      const serverDocRead = client.getServerDoc
        ? safeRead(() => client.getServerDoc!())
        : Promise.resolve({
            ok: true,
            value: null,
          } as SafeValue<OpenCodeServerDocResponse | null>)
      const [configProvidersResult, providersResult, providerAuthResult, serverDocResult] =
        await Promise.all([
          safeRead(() => client.getConfigProviders()),
          safeRead(() => client.getProviders()),
          safeRead(() => client.getProviderAuth()),
          serverDocRead,
        ])
      const directoryVersion = inventory.version ?? host.version
      const {
        connectedProviders: directoryConnectedProviders,
        unsupportedSuperGrokOAuth,
      } = filterOpenCodeConnectedProvidersForRuntime({
        providers: inventory.connectedProviders,
        version: directoryVersion,
      })
      const directoryInventory = {
        ...inventory,
        version: directoryVersion,
        connectedProviders: directoryConnectedProviders,
        diagnostics: [
          ...inventory.diagnostics.filter(
            diagnostic => !diagnostic.startsWith('SuperGrok OAuth requires OpenCode '),
          ),
          ...(unsupportedSuperGrokOAuth
            ? [
                `SuperGrok OAuth requires OpenCode ${OPEN_CODE_SUPERGROK_OAUTH_MIN_VERSION} or newer; detected ${directoryVersion}`,
              ]
            : []),
        ],
      }
      const diagnostics = [
        ...directoryInventory.diagnostics,
        ...safeReadDiagnostics(configProvidersResult),
        ...safeReadDiagnostics(providersResult),
        ...safeReadDiagnostics(providerAuthResult),
        ...safeReadDiagnostics(serverDocResult),
      ]
      const directorySource = {
        inventory: directoryInventory,
        configProviders: configProvidersResult.ok ? configProvidersResult.value : null,
        providers: providersResult.ok ? providersResult.value : null,
        providerAuth: providerAuthResult.ok ? providerAuthResult.value : null,
        capabilities: getCapabilities(serverDocResult.ok ? serverDocResult.value : null),
        diagnostics,
      }
      const uncachedDirectory = buildProviderDirectory({
        ...directorySource,
        query: null,
        filter: 'all',
        limit: Number.MAX_SAFE_INTEGER,
        cursor: null,
      })
      this.writeDirectoryCache(
        cacheKey,
        uncachedDirectory,
        buildProviderDirectoryModelSearchIndex(directorySource),
      )

      return {
        ok: true,
        value: buildProviderDirectory({
          ...directorySource,
          query: input.query,
          filter: input.filter,
          limit: input.limit,
          cursor: input.cursor,
        }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: true,
        value: buildProviderDirectory({
          inventory,
          configProviders: null,
          providers: null,
          providerAuth: null,
          diagnostics: [...inventory.diagnostics, message],
          query: input.query,
          filter: input.filter,
          limit: input.limit,
          cursor: input.cursor,
        }),
      }
    } finally {
      if (host) {
        await this.releaseProviderManagementHost(hostManager, host, hostLease)
        await hostManager
          .releaseHost(host.hostKey, { keepPersistentAlive: hostLifetime === 'persistent' })
          .catch(() => undefined)
      }
    }
  }

  async loadSetupForm(
    input: LoadProviderSetupFormInput,
  ): Promise<ProviderManagementResult<ProviderSetupForm>> {
    const providerId = normalizeProviderId(input.providerId)
    if (!providerId) {
      return providerManagementError('provider-missing', 'Provider id is invalid')
    }
    if (input.runtimeId !== 'opencode') {
      return providerManagementError(
        'unsupported-runtime',
        `Provider management is not available for ${input.runtimeId}`,
        false,
      )
    }
    if (FAST_CURATED_SETUP_PROVIDER_IDS.has(providerId)) {
      return {
        ok: true,
        value: buildProviderSetupForm({
          providerId,
          displayName: getProviderDisplayName(providerId),
          knownProviderIds: new Set([providerId]),
          methods: [],
        }),
      }
    }

    return this.withManagedOpenCodeClient(
      input.runtimeId,
      input.projectPath,
      async ({ inventory, client }) => {
        const [configProvidersResult, providersResult, providerAuthResult, serverDocResult] =
          await Promise.all([
            safeRead(() => client.getConfigProviders()),
            safeRead(() => client.getProviders()),
            safeRead(() => client.getProviderAuth()),
            client.getServerDoc
              ? safeRead(() => client.getServerDoc!())
              : Promise.resolve({
                  ok: true,
                  value: null,
                } as SafeValue<OpenCodeServerDocResponse | null>),
          ])
        const configProviders = configProvidersResult.ok ? configProvidersResult.value : null
        const providers = providersResult.ok ? providersResult.value : null
        const providerAuth = providerAuthResult.ok ? providerAuthResult.value : null
        const liveProviderIds = getLiveProviderIds({
          inventory,
          configProviders,
          providers,
        })
        if (!liveProviderIds.has(providerId)) {
          return providerManagementError(
            'provider-missing',
            `OpenCode provider ${providerId} was not found in the live catalog`,
          )
        }

        const entries = getProviderEntries(configProviders, providers)
        return {
          ok: true,
          value: buildProviderSetupForm({
            providerId,
            displayName: getProviderDisplayName(providerId, entries.get(providerId)),
            knownProviderIds: liveProviderIds,
            methods: getProviderAuthMethods(providerAuth, providerId),
            capabilities: getCapabilities(serverDocResult.ok ? serverDocResult.value : null),
          }),
        }
      },
      { inventoryMode: 'profile' },
    )
  }

  async loadModels(
    input: LoadProviderModelsInput,
  ): Promise<ProviderManagementResult<RuntimeProviderModelsView>> {
    const providerId = normalizeProviderId(input.providerId)
    if (!providerId) {
      return providerManagementError('provider-missing', 'Provider id is invalid')
    }

    return this.withManagedOpenCodeClient(
      input.runtimeId,
      input.projectPath,
      async ({ inventory, client }) => {
        const managedPreferencesResult = inventory.profile
          ? safeRead(() => this.getManagedPreferences().read(inventory.profile!.profileRootPath))
          : Promise.resolve({ ok: true, value: null } as SafeValue<OpenCodeManagedRuntimePreferences | null>)
        const [configProvidersResult, providersResult, preferencesResult] = await Promise.all([
          safeRead(() => client.getConfigProviders()),
          safeRead(() => client.getProviders()),
          managedPreferencesResult,
        ])
        const diagnostics = [
          ...inventory.diagnostics,
          ...safeReadDiagnostics(configProvidersResult),
          ...safeReadDiagnostics(providersResult),
        ]
        const modelsView = buildProviderModelsView({
          providerId,
          inventory,
          configProviders: configProvidersResult.ok ? configProvidersResult.value : null,
          providers: providersResult.ok ? providersResult.value : null,
          query: input.query,
          limit: input.limit,
          cursor: input.cursor,
          diagnostics,
          managedModelLimitOverrides:
            preferencesResult.ok && preferencesResult.value
              ? preferencesResult.value.modelLimitOverrides
              : undefined,
        })

        if (modelsView.models.length === 0) {
          const knownProviderIds = getKnownProviderIds({
            inventory,
            configProviders: configProvidersResult.ok ? configProvidersResult.value : null,
            providers: providersResult.ok ? providersResult.value : null,
          })
          if (!knownProviderIds.has(providerId)) {
            return providerManagementError(
              'provider-missing',
              `OpenCode provider ${providerId} was not found in the live catalog`,
            )
          }
        }

        return { ok: true, value: modelsView }
      },
    )
  }

  async connectWithApiKey(
    input: ConnectProviderApiKeyInput,
  ): Promise<ProviderManagementResult<ProviderConnection>> {
    return this.connectProvider({
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      method: 'api',
      apiKey: input.apiKey,
      metadata: null,
      projectPath: input.projectPath,
    })
  }

  private async connectProviderWithOAuth(
    input: ConnectProviderInput,
    observer: ProviderOAuthFlowObserver | undefined,
  ): Promise<ProviderManagementResult<ProviderConnection>> {
    if (normalizeProviderId(input.providerId) !== 'xai') {
      return this.connectProviderWithOAuthUnlocked(input, observer)
    }

    const inventoryService = this.deps.inventoryService ?? openCodeInventoryService
    const inventory = await this.probeInventory(inventoryService, input.projectPath, {
      mode: 'profile',
    })
    const managedAuthPath = inventory.profile?.managedAuthPath
    if (!managedAuthPath) {
      return providerManagementError(
        'runtime-unhealthy',
        'OpenCode managed auth store is required for SuperGrok OAuth setup',
      )
    }

    return withOpenCodeOAuthRefreshLock({
      authPath: managedAuthPath,
      providerId: 'xai',
      operation: () => this.connectProviderWithOAuthUnlocked(input, observer),
    })
  }

  private async connectProviderWithOAuthUnlocked(
    input: ConnectProviderInput,
    observer: ProviderOAuthFlowObserver | undefined,
  ): Promise<ProviderManagementResult<ProviderConnection>> {
    const providerId = normalizeProviderId(input.providerId)
    const methodIndex = normalizeOAuthMethodIndex(input.authMethodIndex)
    const operationId = normalizeOAuthOperationId(input.oauthOperationId)
    if (!providerId) {
      return providerManagementError('provider-missing', 'Provider id is invalid')
    }
    if (methodIndex === null) {
      return providerManagementError('auth-required', 'OAuth auth method selection is required')
    }
    if (!operationId) {
      return providerManagementError('auth-required', 'OAuth operation id is required')
    }
    if (!observer) {
      return providerManagementError(
        'unsupported-auth-method',
        'This client cannot complete interactive OpenCode OAuth. Use an Agent Teams client with OAuth progress support.',
      )
    }

    return this.withManagedOpenCodeClient(
      input.runtimeId,
      input.projectPath,
      async ({ inventory, inventoryService, host, client }) => {
        if (!client.authorizeProviderOAuth || !client.completeProviderOAuth) {
          return providerManagementError(
            'unsupported-auth-method',
            'This OpenCode runtime does not expose provider OAuth bridge endpoints. Update OpenCode and refresh providers.',
          )
        }
        const managedAuthPath = inventory.profile?.managedAuthPath
        const globalAuthPath = inventory.profile?.globalAuthPath
        if (!managedAuthPath || !globalAuthPath) {
          return providerManagementError(
            'runtime-unhealthy',
            'OpenCode managed and global auth stores are required for OAuth setup',
          )
        }

        const [configProvidersResult, providersResult, providerAuthResult, serverDocResult] =
          await Promise.all([
            safeRead(() => client.getConfigProviders()),
            safeRead(() => client.getProviders()),
            safeRead(() => client.getProviderAuth()),
            client.getServerDoc
              ? safeRead(() => client.getServerDoc!())
              : Promise.resolve({
                  ok: true,
                  value: null,
                } as SafeValue<OpenCodeServerDocResponse | null>),
          ])
        const configProviders = configProvidersResult.ok ? configProvidersResult.value : null
        const providers = providersResult.ok ? providersResult.value : null
        const providerAuth = providerAuthResult.ok ? providerAuthResult.value : null
        const capabilities = getCapabilities(serverDocResult.ok ? serverDocResult.value : null)
        if (!capabilities.authorizeOAuth || !capabilities.completeOAuth) {
          return providerManagementError(
            'unsupported-auth-method',
            'Update OpenCode to a version that supports provider OAuth authorize and callback endpoints.',
          )
        }

        const liveProviderIds = getLiveProviderIds({
          inventory,
          configProviders,
          providers,
        })
        if (!liveProviderIds.has(providerId)) {
          return providerManagementError(
            'provider-missing',
            `OpenCode provider ${providerId} was not found in the live catalog`,
          )
        }
        const methods = getProviderAuthMethods(providerAuth, providerId)
        const selectedMethod = methods[methodIndex]
        if (selectedMethod?.type?.trim().toLowerCase() !== 'oauth') {
          return providerManagementError(
            'unsupported-auth-method',
            `OpenCode auth method ${methodIndex} is not an OAuth method for provider ${providerId}`,
          )
        }
        const entries = getProviderEntries(configProviders, providers)
        const displayName = getProviderDisplayName(providerId, entries.get(providerId))
        const setupForm = buildProviderSetupForm({
          providerId,
          displayName,
          knownProviderIds: liveProviderIds,
          methods,
          capabilities,
        })
        const authOption = setupForm.authOptions.find(
          option => option.method === 'oauth' && option.methodIndex === methodIndex,
        )
        if (!authOption?.supported) {
          return providerManagementError(
            'unsupported-auth-method',
            authOption?.disabledReason ??
              `OAuth method ${methodIndex} is not supported for ${providerId}`,
          )
        }
        if (input.authOptionId?.trim() && input.authOptionId.trim() !== authOption.id) {
          return providerManagementError(
            'auth-required',
            'OAuth auth option no longer matches the live OpenCode catalog',
          )
        }

        let oauthInputs: Record<string, string>
        try {
          oauthInputs = normalizeSetupPromptMetadata(authOption.prompts, input.metadata)
        } catch (error) {
          return providerManagementError(
            'auth-required',
            error instanceof Error ? error.message : 'OAuth setup metadata is invalid',
          )
        }

        const authPaths = new Set<string>([managedAuthPath, globalAuthPath])
        try {
          for (const authPath of await this.getProfileManager().listManagedAuthPaths()) {
            authPaths.add(authPath)
          }
        } catch (error) {
          return providerManagementError(
            'auth-failed',
            error instanceof Error
              ? `Unable to enumerate OpenCode auth stores: ${error.message}`
              : 'Unable to enumerate OpenCode auth stores',
          )
        }
        let previousCredentials: ReadonlyMap<string, OpenCodeAuthCredential | null>
        try {
          previousCredentials = await this.captureProviderAuthSnapshot({
            providerId,
            authPaths: Array.from(authPaths),
          })
        } catch (error) {
          return providerManagementError(
            'auth-failed',
            error instanceof Error
              ? `Unable to preserve the existing ${providerId} credential: ${error.message}`
              : `Unable to preserve the existing ${providerId} credential`,
          )
        }

        let authorization: OpenCodeProviderOAuthAuthorization
        try {
          authorization = await client.authorizeProviderOAuth(providerId, {
            method: methodIndex,
            ...(Object.keys(oauthInputs).length > 0 ? { inputs: oauthInputs } : {}),
          })
        } catch (error) {
          return providerManagementError(
            'auth-failed',
            error instanceof Error ? error.message : `Failed to start OAuth for ${providerId}`,
          )
        }
        const authorizationUrl = normalizeOAuthAuthorizationUrl(authorization.url)
        if (
          !authorizationUrl ||
          (authorization.method !== 'auto' && authorization.method !== 'code')
        ) {
          return providerManagementError(
            'auth-failed',
            'OpenCode returned an invalid OAuth authorization response',
          )
        }

        let observerResult: { code?: string | null } | void
        try {
          observerResult = await observer.authorizationReady({
            operationId,
            providerId,
            displayName,
            authOptionId: authOption.id,
            methodIndex,
            authorizationUrl,
            instructions:
              authorization.instructions?.trim() || 'Complete authorization in your browser.',
            completionMethod: authorization.method,
          })
        } catch (error) {
          return providerManagementError(
            'auth-failed',
            error instanceof Error ? error.message : 'OAuth authorization was interrupted',
          )
        }
        const authorizationCode =
          observerResult && 'code' in observerResult ? (observerResult.code?.trim() ?? '') : ''
        if (authorization.method === 'code' && !authorizationCode) {
          return providerManagementError('auth-required', 'OAuth authorization code is required')
        }

        const credentialBaselineResult = await this.clearOAuthCredentialBaseline({
          client,
          providerId,
          authPaths: Array.from(authPaths),
          canDeleteProviderAuth: capabilities.deleteAuth,
          previousCredentials,
        })
        if (!credentialBaselineResult.ok) {
          return credentialBaselineResult
        }
        const credentialBaselineCleared = credentialBaselineResult.value

        const callbackOutcomePromise = Promise.resolve()
          .then(() =>
            client.completeProviderOAuth!(providerId, {
              method: methodIndex,
              ...(authorizationCode ? { code: authorizationCode } : {}),
            }),
          )
          .then(
            completed => ({ kind: 'callback' as const, completed }),
            error => ({ kind: 'callback-error' as const, error }),
          )

        let oauthCredential: OpenCodeAuthCredential | null = null
        let callbackOutcome:
          | Awaited<typeof callbackOutcomePromise>
          | { kind: 'credential'; credential: OpenCodeAuthCredential }
        // Device OAuth can persist a valid credential before OpenCode's callback
        // request settles. Accept only a strictly new OAuth credential, then keep
        // the normal inventory and execution-proof checks below.
        if (
          (providerId === 'github-copilot' || providerId === 'xai') &&
          authorization.method === 'auto'
        ) {
          const credentialWatcher = new AbortController()
          callbackOutcome = await Promise.race([
            callbackOutcomePromise,
            this.waitForNewOAuthCredential({
              authPath: managedAuthPath,
              providerId,
              previousCredentials,
              acceptEquivalentCredential: credentialBaselineCleared,
              signal: credentialWatcher.signal,
            }).then(credential =>
              credential
                ? { kind: 'credential' as const, credential }
                : { kind: 'callback-error' as const, error: new Error('OAuth recovery stopped') },
            ),
          ])
          credentialWatcher.abort()
          if (callbackOutcome.kind === 'credential') {
            oauthCredential = callbackOutcome.credential
          }
        } else {
          callbackOutcome = await callbackOutcomePromise
        }

        if (callbackOutcome.kind === 'callback-error') {
          await this.rollbackProviderAuth({
            client,
            providerId,
            authPaths: Array.from(authPaths),
            canDeleteProviderAuth: capabilities.deleteAuth,
            previousCredentials,
          })
          return providerManagementError(
            'auth-failed',
            callbackOutcome.error instanceof Error
              ? callbackOutcome.error.message
              : `OAuth callback failed for ${providerId}`,
          )
        }
        if (callbackOutcome.kind === 'callback' && callbackOutcome.completed !== true) {
          await this.rollbackProviderAuth({
            client,
            providerId,
            authPaths: Array.from(authPaths),
            canDeleteProviderAuth: capabilities.deleteAuth,
            previousCredentials,
          })
          return providerManagementError(
            'auth-failed',
            `OpenCode did not complete OAuth for ${providerId}`,
          )
        }

        const authStore = this.getAuthStore()
        if (!oauthCredential) {
          try {
            oauthCredential = await authStore.readCredential({
              authPath: managedAuthPath,
              providerId,
            })
          } catch (error) {
            await this.rollbackProviderAuth({
              client,
              providerId,
              authPaths: Array.from(authPaths),
              canDeleteProviderAuth: capabilities.deleteAuth,
              previousCredentials,
            })
            return providerManagementError(
              'auth-failed',
              error instanceof Error
                ? `OpenCode OAuth credential could not be read: ${error.message}`
                : 'OpenCode OAuth credential could not be read',
            )
          }
        }
        if (
          !this.isNewOAuthCredential(
            oauthCredential,
            previousCredentials,
            credentialBaselineCleared,
          )
        ) {
          await this.rollbackProviderAuth({
            client,
            providerId,
            authPaths: Array.from(authPaths),
            canDeleteProviderAuth: capabilities.deleteAuth,
            previousCredentials,
          })
          return providerManagementError(
            'auth-failed',
            `OpenCode completed OAuth but did not persist a new OAuth credential for ${providerId}`,
          )
        }

        try {
          for (const authPath of authPaths) {
            await authStore.upsertCredential({
              authPath,
              providerId,
              credential: oauthCredential,
            })
          }
        } catch (error) {
          await this.rollbackProviderAuth({
            client,
            providerId,
            authPaths: Array.from(authPaths),
            canDeleteProviderAuth: capabilities.deleteAuth,
            previousCredentials,
          })
          return providerManagementError(
            'auth-failed',
            error instanceof Error ? error.message : 'OpenCode OAuth credential mirror failed',
          )
        }

        await observer.authorizationCompleted?.({
          operationId,
          providerId,
          displayName,
          authOptionId: authOption.id,
          methodIndex,
          completionMethod: authorization.method,
        })

        this.invalidateDirectoryCache()
        const refreshedInventory = await this.probeInventory(
          inventoryService,
          inventory.projectPath,
          {
            bypassCache: true,
          },
        )
        const refresh = useActionRefreshInventory(
          inventory,
          refreshedInventory,
          fallbackInventory => addManagedProviderToInventory(fallbackInventory, providerId),
        )
        const view = appendViewDiagnostics(
          await readLiveView({
            inventory: refresh.inventory,
            host,
            client,
            diagnostics: refresh.inventory.diagnostics,
          }),
          refresh.postViewDiagnostics,
        )
        const provider = findProviderConnection(view, providerId)
        if (
          !provider ||
          provider.state !== 'connected' ||
          !provider.ownership.includes('managed')
        ) {
          await this.rollbackProviderAuth({
            client,
            providerId,
            authPaths: Array.from(authPaths),
            canDeleteProviderAuth: capabilities.deleteAuth,
            previousCredentials,
          })
          return providerManagementError(
            'auth-failed',
            `OpenCode completed OAuth but did not report provider ${providerId} as connected`,
          )
        }
        const executionProof = await this.verifyConnectedProviderExecution({
          providerId,
          inventory: refresh.inventory,
          configProviders,
          providers,
        })
        if (!executionProof.ok) {
          await this.rollbackProviderAuth({
            client,
            providerId,
            authPaths: Array.from(authPaths),
            canDeleteProviderAuth: capabilities.deleteAuth,
            previousCredentials,
          })
          return executionProof
        }
        return {
          ok: true,
          value: {
            ...provider,
            connectedAuthHint: 'oauth',
            verifiedModelId: executionProof.value,
          },
        }
      },
      {
        failureCode: 'auth-failed',
        hostLifetime: 'process',
      },
    )
  }

  async connectProvider(
    input: ConnectProviderInput,
    observer?: ProviderOAuthFlowObserver,
  ): Promise<ProviderManagementResult<ProviderConnection>> {
    const providerId = normalizeProviderId(input.providerId)
    if (!providerId) {
      return providerManagementError('provider-missing', 'Provider id is invalid')
    }

    if (input.method === 'oauth') {
      return this.connectProviderWithOAuth(input, observer)
    }

    if (input.method !== 'api') {
      return providerManagementError(
        'unsupported-auth-method',
        `App-managed connect does not support ${input.method} auth for provider ${providerId}`,
      )
    }

    const apiKey = input.apiKey?.trim() ?? ''
    if (!apiKey) {
      return providerManagementError('auth-required', 'API key is required')
    }
    const curatedSubscriptionKeyError = validateOpenCodeCuratedSubscriptionKey(
      providerId,
      apiKey,
    )
    if (curatedSubscriptionKeyError) {
      return providerManagementError('auth-required', curatedSubscriptionKeyError)
    }

    return this.withManagedOpenCodeClient(
      input.runtimeId,
      input.projectPath,
      async ({ inventory, inventoryService, host, client }) => {
        if (!client.setProviderAuth) {
          return providerManagementError(
            'unsupported-action',
            'This OpenCode runtime does not support app-managed API-key auth',
          )
        }
        const managedAuthPath = inventory.profile?.managedAuthPath
        const globalAuthPath = inventory.profile?.globalAuthPath
        if (!managedAuthPath) {
          return providerManagementError(
            'runtime-unhealthy',
            'OpenCode managed profile auth store is unavailable',
          )
        }
        if (!globalAuthPath) {
          return providerManagementError(
            'runtime-unhealthy',
            'OpenCode global auth store path is unavailable',
          )
        }

        const serverDocRead = client.getServerDoc
          ? safeRead(() => client.getServerDoc!())
          : Promise.resolve({
              ok: true,
              value: null,
            } as SafeValue<OpenCodeServerDocResponse | null>)
        const [configProvidersResult, providersResult, providerAuthResult, serverDocResult] =
          await Promise.all([
            safeRead(() => client.getConfigProviders()),
            safeRead(() => client.getProviders()),
            safeRead(() => client.getProviderAuth()),
            serverDocRead,
          ])
        const configProviders = configProvidersResult.ok ? configProvidersResult.value : null
        const providers = providersResult.ok ? providersResult.value : null
        const providerAuth = providerAuthResult.ok ? providerAuthResult.value : null
        const capabilities = getCapabilities(serverDocResult.ok ? serverDocResult.value : null)
        const canDeleteProviderAuth = capabilities.deleteAuth
        const liveProviderIds = getLiveProviderIds({
          inventory,
          configProviders,
          providers,
        })
        if (!liveProviderIds.has(providerId)) {
          return providerManagementError(
            'provider-missing',
            `OpenCode provider ${providerId} was not found in the live catalog`,
          )
        }

        const entries = getProviderEntries(configProviders, providers)
        const setupForm = buildProviderSetupForm({
          providerId,
          displayName: getProviderDisplayName(providerId, entries.get(providerId)),
          knownProviderIds: liveProviderIds,
          methods: getProviderAuthMethods(providerAuth, providerId),
          capabilities,
        })
        const requestedMethodIndex = normalizeOAuthMethodIndex(input.authMethodIndex)
        const authOption = setupForm.authOptions.find(
          option =>
            option.method === 'api' &&
            (requestedMethodIndex === null || option.methodIndex === requestedMethodIndex),
        )
        if (
          !authOption?.supported ||
          !authOption.secret ||
          (input.authOptionId?.trim() && input.authOptionId.trim() !== authOption.id)
        ) {
          return providerManagementError(
            'unsupported-auth-method',
            authOption?.disabledReason ??
              `OpenCode did not expose app-managed API-key auth for provider ${providerId}`,
          )
        }

        let metadata: Record<string, string>
        try {
          metadata = normalizeSetupPromptMetadata(authOption.prompts, input.metadata)
        } catch (error) {
          return providerManagementError(
            'auth-required',
            error instanceof Error ? error.message : 'Provider setup metadata is invalid',
          )
        }
        const authBody: OpenCodeApiAuthInput = {
          type: 'api',
          key: apiKey,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        }

        let previousCredentials: ReadonlyMap<string, OpenCodeAuthCredential | null>
        try {
          previousCredentials = await this.captureProviderAuthSnapshot({
            providerId,
            authPaths: [globalAuthPath, managedAuthPath],
          })
        } catch (error) {
          return providerManagementError(
            'auth-failed',
            error instanceof Error
              ? `Unable to preserve the existing ${providerId} credential: ${error.message}`
              : `Unable to preserve the existing ${providerId} credential`,
          )
        }

        let authApplied: boolean
        try {
          authApplied = await client.setProviderAuth(providerId, { ...authBody })
        } catch (error) {
          await this.rollbackProviderAuth({
            client,
            providerId,
            authPaths: [globalAuthPath, managedAuthPath],
            canDeleteProviderAuth,
            previousCredentials,
          })
          const message = error instanceof Error
            ? redactSecret(error.message, apiKey)
            : `OpenCode failed to apply API-key auth for provider ${providerId}`
          return providerManagementError('auth-failed', message)
        }
        if (authApplied !== true) {
          await this.rollbackProviderAuth({
            client,
            providerId,
            authPaths: [globalAuthPath, managedAuthPath],
            canDeleteProviderAuth,
            previousCredentials,
          })
          return providerManagementError(
            'auth-failed',
            `OpenCode did not apply API-key auth for provider ${providerId}`,
          )
        }

        // OpenCode snapshots connected providers when an instance starts. The auth
        // endpoint persists the credential but does not refresh that in-memory
        // snapshot, so this host can legitimately remain stale after a successful
        // write. Confirm against the bypass-cache inventory below, which starts
        // from the updated managed auth store, and then prove providers that need
        // credential validation with a real model request.

        const authStore = this.getAuthStore()
        try {
          await authStore.upsertApiAuth({
            authPath: globalAuthPath,
            providerId,
            auth: authBody,
          })
          await authStore.upsertApiAuth({
            authPath: managedAuthPath,
            providerId,
            auth: authBody,
          })
        } catch (error) {
          await this.rollbackProviderAuth({
            client,
            providerId,
            authPaths: [globalAuthPath, managedAuthPath],
            canDeleteProviderAuth,
            previousCredentials,
          })
          return providerManagementError(
            'auth-failed',
            error instanceof Error ? error.message : 'OpenCode auth mirror failed',
          )
        }
        this.invalidateDirectoryCache()
        const refreshedInventory = await this.probeInventory(
          inventoryService,
          inventory.projectPath,
          {
            bypassCache: true,
          },
        )
        const refresh = useActionRefreshInventory(
          inventory,
          refreshedInventory,
          fallbackInventory => addManagedProviderToInventory(fallbackInventory, providerId),
        )
        const view = await readLiveView({
          inventory: refresh.inventory,
          host,
          client,
          diagnostics: refresh.inventory.diagnostics,
        })
        const viewWithRefreshDiagnostics = appendViewDiagnostics(view, refresh.postViewDiagnostics)
        const provider = findProviderConnection(viewWithRefreshDiagnostics, providerId)
        if (!provider) {
          await this.rollbackProviderAuth({
            client,
            providerId,
            authPaths: [globalAuthPath, managedAuthPath],
            canDeleteProviderAuth,
            previousCredentials,
          })
          return providerManagementError(
            'provider-missing',
            `OpenCode did not return provider ${providerId} after connecting`,
          )
        }
        if (provider.state !== 'connected' || !provider.ownership.includes('managed')) {
          await this.rollbackProviderAuth({
            client,
            providerId,
            authPaths: [globalAuthPath, managedAuthPath],
            canDeleteProviderAuth,
            previousCredentials,
          })
          return providerManagementError(
            'auth-failed',
            `OpenCode accepted the auth request but did not report provider ${providerId} as connected`,
          )
        }
        const executionProof = await this.verifyConnectedProviderExecution({
          providerId,
          inventory: refresh.inventory,
          configProviders,
          providers,
          secretToRedact: apiKey,
          required: true,
        })
        if (!executionProof.ok) {
          await this.rollbackProviderAuth({
            client,
            providerId,
            authPaths: [globalAuthPath, managedAuthPath],
            canDeleteProviderAuth,
            previousCredentials,
          })
          return executionProof
        }
        return {
          ok: true,
          value: {
            ...provider,
            connectedAuthHint: 'api',
            verifiedModelId: executionProof.value,
          },
        }
      },
      {
        failureCode: 'auth-failed',
        secretToRedact: apiKey,
      },
    )
  }

  async forgetManagedCredential(
    input: ProviderSelectionInput,
  ): Promise<ProviderManagementResult<ProviderConnection>> {
    const providerId = normalizeProviderId(input.providerId)
    if (!providerId) {
      return providerManagementError('provider-missing', 'Provider id is invalid')
    }

    return this.withManagedOpenCodeClient(
      input.runtimeId,
      input.projectPath,
      async ({ inventory, inventoryService, host, client }) => {
        const serverDoc = client.getServerDoc ? await client.getServerDoc() : null
        const capabilities = getCapabilities(serverDoc)
        if (!capabilities.deleteAuth || !client.deleteProviderAuth) {
          return providerManagementError(
            'unsupported-action',
            'This OpenCode runtime does not advertise credential removal through /doc',
          )
        }

        const authDeleted = await client.deleteProviderAuth(providerId)
        if (authDeleted !== true) {
          return providerManagementError(
            'unsupported-action',
            `OpenCode did not remove managed credentials for provider ${providerId}`,
          )
        }

        const authPaths = new Set<string>()
        if (inventory.profile?.globalAuthPath) authPaths.add(inventory.profile.globalAuthPath)
        if (inventory.profile?.managedAuthPath) authPaths.add(inventory.profile.managedAuthPath)
        for (const authPath of await this.getProfileManager().listManagedAuthPaths()) {
          authPaths.add(authPath)
        }
        const authStore = this.getAuthStore()
        for (const authPath of authPaths) {
          await authStore.removeCredential({ authPath, providerId })
        }
        this.invalidateDirectoryCache()
        const refreshedInventory = await this.probeInventory(
          inventoryService,
          inventory.projectPath,
          {
            bypassCache: true,
          },
        )
        const refresh = useActionRefreshInventory(
          inventory,
          refreshedInventory,
          fallbackInventory => removeManagedProviderFromInventory(fallbackInventory, providerId),
        )
        const viewWithRefreshDiagnostics =
          refresh.postViewDiagnostics.length > 0
            ? buildView({
                inventory: refresh.inventory,
                host,
                configProviders: null,
                providers: null,
                providerAuth: null,
                diagnostics: [
                  ...refresh.inventory.diagnostics,
                  ...redactDiagnostics(refresh.postViewDiagnostics),
                ],
              })
            : appendViewDiagnostics(
                await readLiveView({
                  inventory: refresh.inventory,
                  host,
                  client,
                  diagnostics: refresh.inventory.diagnostics,
                }),
                refresh.postViewDiagnostics,
              )
        const provider = findProviderConnection(viewWithRefreshDiagnostics, providerId)
        if (!provider) {
          return providerManagementError(
            'provider-missing',
            `OpenCode did not return provider ${providerId} after removing credentials`,
          )
        }
        return { ok: true, value: provider }
      },
      { failureCode: 'auth-failed' },
    )
  }

  async ignoreProvider(
    _input: ProviderSelectionInput,
  ): Promise<ProviderManagementResult<ProviderConnection>> {
    return providerManagementError(
      'unsupported-action',
      'Ignoring providers is planned for a later phase',
    )
  }

  async setDefaultModel(
    input: SetDefaultModelInput,
  ): Promise<ProviderManagementResult<ProviderManagementView>> {
    const providerId = normalizeProviderId(input.providerId)
    if (!providerId) {
      return providerManagementError('provider-missing', 'Provider id is invalid')
    }

    const modelId = normalizeProviderScopedModelId({
      providerId,
      modelId: input.modelId,
    })
    if (!modelId) {
      return providerManagementError(
        'model-missing',
        `Model id must be scoped to provider ${providerId}`,
      )
    }
    const scope = input.scope === 'all_projects' ? 'all_projects' : 'project'

    return this.withManagedOpenCodeClient(
      input.runtimeId,
      input.projectPath,
      async ({ inventory, inventoryService, host, client }) => {
        const [configProvidersResult, providersResult] = await Promise.all([
          safeRead(() => client.getConfigProviders()),
          safeRead(() => client.getProviders()),
        ])
        const configProviders = configProvidersResult.ok ? configProvidersResult.value : null
        const providers = providersResult.ok ? providersResult.value : null

        const modelsView = buildProviderModelsView({
          providerId,
          inventory,
          configProviders,
          providers,
        })
        if (!modelsView.models.some(model => model.modelId === modelId)) {
          return providerManagementError(
            'model-missing',
            `Model ${modelId} was not found in the OpenCode live catalog`,
          )
        }

        const accessCatalog = buildProviderManagementAccessCatalog({
          inventory,
          configProviders,
          providers,
        })
        const access = evaluateOpenCodeModelAccess({
          selectedModel: modelId,
          catalog: accessCatalog,
        })
        const accessError = getModelAccessError({
          access,
          modelId,
          action: 'set-default',
        })
        if (accessError) {
          return accessError
        }

        const mustProbe =
          input.probe !== false ||
          (access.kind === 'configured_authless' && access.requiresExecutionProof)
        if (mustProbe) {
          const probeResult = await this.getExecutionProbe().probeModel({
            selectedModel: modelId,
            projectPath: inventory.projectPath,
            bypassCache: true,
          })
          if (probeResult.outcome !== 'available') {
            if (probeResult.outcome === 'not_authenticated') {
              return providerManagementError(
                'auth-required',
                probeResult.reason ?? `Provider authentication failed for ${modelId}`,
              )
            }
            return {
              ok: false,
              error: {
                code: 'model-test-failed',
                message: probeResult.reason ?? `Model probe failed for ${modelId}`,
                recoverable: true,
              },
            }
          }
        }

        const profile = inventory.profile
        if (!profile) {
          return providerManagementError(
            'runtime-unhealthy',
            'OpenCode managed profile is unavailable',
          )
        }
        const managedPreferences = this.getManagedPreferences()
        if (scope === 'all_projects') {
          if (!managedPreferences.setAllProjectsDefaultModel) {
            return providerManagementError(
              'runtime-unhealthy',
              'OpenCode all-projects managed preferences are unavailable',
            )
          }
          await managedPreferences.setAllProjectsDefaultModel(modelId)
        } else {
          await managedPreferences.setDefaultModel(profile.profileRootPath, modelId)
        }
        this.invalidateDirectoryCache()
        inventoryService.clearCache?.()

        const refreshedInventory = await this.probeInventory(
          inventoryService,
          inventory.projectPath,
          {
            bypassCache: true,
          },
        )
        const refresh = useActionRefreshInventory(
          inventory,
          refreshedInventory,
          fallbackInventory =>
            applyManagedDefaultToInventory(fallbackInventory, {
              modelId,
              scope,
            }),
        )
        const view = await readLiveView({
          inventory: refresh.inventory,
          host,
          client,
          diagnostics: refresh.inventory.diagnostics,
        })
        return {
          ok: true,
          value: appendViewDiagnostics(view, refresh.postViewDiagnostics),
        }
      },
      { failureCode: 'model-test-failed' },
    )
  }

  async clearProjectDefaultModel(
    input: ClearProjectDefaultModelInput,
  ): Promise<ProviderManagementResult<ProviderManagementView>> {
    const projectPath = input.projectPath?.trim()
    if (!projectPath) {
      return providerManagementError(
        'runtime-misconfigured',
        'A project path is required to clear its OpenCode default model',
      )
    }
    return this.withManagedOpenCodeClient(
      input.runtimeId,
      projectPath,
      async ({ inventory, inventoryService, host, client }) => {
        const profile = inventory.profile
        if (!profile) {
          return providerManagementError(
            'runtime-unhealthy',
            'OpenCode managed profile is unavailable',
          )
        }

        await this.getManagedPreferences().clearProjectDefaultModel(profile.profileRootPath)
        this.invalidateDirectoryCache()
        inventoryService.clearCache?.()

        const refreshedInventory = await this.probeInventory(
          inventoryService,
          inventory.projectPath,
          {
            bypassCache: true,
            mode: 'summary',
          },
        )
        const refresh = useActionRefreshInventory(
          inventory,
          refreshedInventory,
          applyClearedProjectDefaultToInventory,
        )
        const view = await readLiveView({
          inventory: refresh.inventory,
          host,
          client,
          diagnostics: refresh.inventory.diagnostics,
        })
        return {
          ok: true,
          value: appendViewDiagnostics(view, refresh.postViewDiagnostics),
        }
      },
      { failureCode: 'runtime-unhealthy', inventoryMode: 'summary' },
    )
  }

  async testModel(
    input: TestProviderModelInput,
  ): Promise<ProviderManagementResult<ProviderModelTestResult>> {
    const providerId = normalizeProviderId(input.providerId)
    if (!providerId) {
      return providerManagementError('provider-missing', 'Provider id is invalid')
    }

    const modelId = normalizeProviderScopedModelId({
      providerId,
      modelId: input.modelId,
    })
    if (!modelId) {
      return providerManagementError(
        'model-missing',
        `Model id must be scoped to provider ${providerId}`,
      )
    }

    return this.withManagedOpenCodeClient(
      input.runtimeId,
      input.projectPath,
      async ({ inventory, client }) => {
        const configProvidersResult = await safeRead(() => client.getConfigProviders())
        const providersResult = await safeRead(() => client.getProviders())
        const configProviders = configProvidersResult.ok ? configProvidersResult.value : null
        const providers = providersResult.ok ? providersResult.value : null

        const modelsView = buildProviderModelsView({
          providerId,
          inventory,
          configProviders,
          providers,
        })
        if (!modelsView.models.some(model => model.modelId === modelId)) {
          return providerManagementError(
            'model-missing',
            `Model ${modelId} was not found in the OpenCode live catalog`,
          )
        }

        const access = evaluateOpenCodeModelAccess({
          selectedModel: modelId,
          catalog: buildProviderManagementAccessCatalog({
            inventory,
            configProviders,
            providers,
          }),
        })
        const accessError = getModelAccessError({
          access,
          modelId,
          action: 'test',
        })
        if (accessError) {
          return accessError
        }

        const probe = await this.getExecutionProbe().probeModel({
          selectedModel: modelId,
          projectPath: inventory.projectPath,
          bypassCache: true,
        })
        return {
          ok: true,
          value: buildProviderModelTestResult({
            providerId,
            modelId,
            probe,
          }),
        }
      },
      { failureCode: 'model-test-failed' },
    )
  }

  async configureModelLimits(
    input: ConfigureProviderModelLimitsInput,
  ): Promise<ProviderManagementResult<ProviderModelLimitsResult>> {
    const providerId = normalizeProviderId(input.providerId)
    if (!providerId) {
      return providerManagementError('provider-missing', 'Provider id is invalid')
    }
    const modelId = normalizeProviderScopedModelId({
      providerId,
      modelId: input.modelId,
    })
    if (!modelId) {
      return providerManagementError(
        'model-missing',
        `Model id must be scoped to provider ${providerId}`,
      )
    }
    const contextTokens = normalizeTokenLimit(input.contextTokens)
    const outputTokens = normalizeTokenLimit(input.outputTokens)
    if (!contextTokens || !outputTokens || outputTokens > contextTokens) {
      return providerManagementError(
        'model-test-failed',
        'Context window and max output must be positive integers, and max output cannot exceed context window',
      )
    }

    return this.withManagedOpenCodeClient(
      input.runtimeId,
      input.projectPath,
      async ({ inventory, inventoryService, client }) => {
        const [configProvidersResult, providersResult] = await Promise.all([
          safeRead(() => client.getConfigProviders()),
          safeRead(() => client.getProviders()),
        ])
        const configProviders = configProvidersResult.ok ? configProvidersResult.value : null
        const providers = providersResult.ok ? providersResult.value : null
        const modelsView = buildProviderModelsView({
          providerId,
          inventory,
          configProviders,
          providers,
        })
        const model = modelsView.models.find(candidate => candidate.modelId === modelId)
        if (!model) {
          return providerManagementError(
            'model-missing',
            `Model ${modelId} was not found in the OpenCode live catalog`,
          )
        }
        if (model.routeKind !== 'configured_local') {
          return providerManagementError(
            'unsupported-action',
            'App-managed context limits are only available for configured local OpenCode models',
          )
        }

        const access = evaluateOpenCodeModelAccess({
          selectedModel: modelId,
          catalog: buildProviderManagementAccessCatalog({
            inventory,
            configProviders,
            providers,
          }),
        })
        const accessError = getModelAccessError({ access, modelId, action: 'test' })
        if (accessError) {
          return accessError
        }

        const profile = inventory.profile
        if (!profile) {
          return providerManagementError(
            'runtime-unhealthy',
            'OpenCode managed profile is unavailable',
          )
        }
        const setModelLimits = this.getManagedPreferences().setModelLimits
        if (!setModelLimits) {
          return providerManagementError(
            'runtime-unhealthy',
            'OpenCode managed model limit preferences are unavailable',
          )
        }
        const probe = await this.getExecutionProbe().probeModel({
          selectedModel: modelId,
          projectPath: inventory.projectPath,
          contextTokens,
          outputTokens,
          bypassCache: true,
        })
        const verified = probe.outcome === 'available'
        if (!verified) {
          return providerManagementError(
            'model-test-failed',
            `Model probe failed, so no limits were saved: ${probe.reason ?? 'unknown error'}`,
          )
        }

        await setModelLimits(profile.profileRootPath, {
          modelId,
          contextTokens,
          outputTokens,
        })
        const cacheDiagnostics: string[] = []
        try {
          this.invalidateDirectoryCache()
        } catch (error) {
          cacheDiagnostics.push(
            `Directory cache refresh failed after limits were saved: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        try {
          inventoryService.clearCache?.()
        } catch (error) {
          cacheDiagnostics.push(
            `Inventory cache refresh failed after limits were saved: ${error instanceof Error ? error.message : String(error)}`,
          )
        }

        return {
          ok: true,
          value: {
            providerId,
            modelId,
            contextTokens,
            outputTokens,
            saved: true,
            verified: true,
            message:
              cacheDiagnostics.length === 0
                ? 'Context limits saved and model probe passed'
                : 'Context limits saved and model probe passed; cached views will refresh later',
            diagnostics: [...probe.diagnostics, ...redactDiagnostics(cacheDiagnostics)],
          },
        }
      },
      { failureCode: 'model-test-failed' },
    )
  }
}

export const openCodeProviderManagementAdapter = new OpenCodeProviderManagementAdapter()
