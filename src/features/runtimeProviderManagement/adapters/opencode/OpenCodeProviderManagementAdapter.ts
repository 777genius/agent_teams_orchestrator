import {
  openCodeClientFactory,
} from '../../../../services/opencode/OpenCodeClientFactory.js'
import {
  removeOpenCodeAuthCredential,
  upsertOpenCodeApiAuthCredential,
} from '../../../../services/opencode/OpenCodeAuthStore.js'
import { openCodeHostManager } from '../../../../services/opencode/OpenCodeHostManager.js'
import { openCodeInventoryService } from '../../../../services/opencode/OpenCodeInventoryService.js'
import { openCodeExecutionProbe } from '../../../../services/opencode/OpenCodeExecutionProbe.js'
import { openCodeProfileManager } from '../../../../services/opencode/OpenCodeProfileManager.js'
import { setOpenCodeManagedDefaultModel } from '../../../../services/opencode/OpenCodeManagedPreferences.js'
import type {
  OpenCodeApiAuthInput,
  OpenCodeConfigProvidersResponse,
  OpenCodeConnectedProvider,
  OpenCodeExecutionProbeOutcome,
  OpenCodeExecutionProbeResult,
  OpenCodeHostHandle,
  OpenCodeInventorySnapshot,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderListEntry,
  OpenCodeProviderResponse,
  OpenCodeServerDocResponse,
} from '../../../../services/opencode/types.js'
import { isRecommendedProvider, sortProviderConnections } from '../../domain/providerOrdering.js'
import type {
  ConnectProviderApiKeyInput,
  LoadProviderDirectoryInput,
  LoadProviderModelsInput,
  LoadProviderManagementViewInput,
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
  ProviderModelAvailability,
  ProviderModelTestResult,
  ProviderOwnership,
  ProviderRuntimeState,
  ProviderSelectionInput,
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
    options?: { bypassCache?: boolean },
  ): ReturnType<typeof openCodeInventoryService.probe>
}

type OpenCodeHostManagerLike = Pick<
  typeof openCodeHostManager,
  'ensureHost' | 'releaseHost'
>

type OpenCodeProviderManagementClient = {
  getConfigProviders(): Promise<OpenCodeConfigProvidersResponse>
  getProviders(): Promise<OpenCodeProviderResponse>
  getProviderAuth(): Promise<Record<string, OpenCodeProviderAuthMethod[]>>
  getServerDoc?(): Promise<OpenCodeServerDocResponse>
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
    upsertApiKey(input: {
      authPath: string
      providerId: string
      apiKey: string
    }): Promise<void>
    removeCredential(input: {
      authPath: string
      providerId: string
    }): Promise<void>
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
    }): Promise<OpenCodeExecutionProbeResult>
  }
  managedPreferences?: {
    setDefaultModel(profileRootPath: string, modelId: string): Promise<unknown>
  }
}

type SafeValue<T> =
  | { ok: true; value: T }
  | { ok: false; message: string }

const KNOWN_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  opencode: 'OpenCode Zen',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
}

const SEEDED_PROVIDER_IDS = ['openrouter', 'opencode'] as const
const SEEDED_API_BOOTSTRAP_PROVIDER_IDS = new Set<string>(SEEDED_PROVIDER_IDS)
const DEFAULT_DIRECTORY_LIMIT = 50
const MAX_DIRECTORY_LIMIT = 100
const DIRECTORY_CACHE_TTL_MS = 30_000

type ProviderDirectoryCacheEntry = {
  expiresAt: number
  value: ProviderDirectoryView
  modelIdsByProviderId: Record<string, string[]>
}

type OpenCodeProviderManagementCapabilities = {
  deleteAuth: boolean
}

const EMPTY_CAPABILITIES: OpenCodeProviderManagementCapabilities = {
  deleteAuth: false,
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
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
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/([?&](?:key|token|api_key|apikey|access_token)=)[^&\s"']+/gi, '$1[redacted]')
    .slice(0, 1_600)
}

function redactDiagnostics(messages: readonly string[]): string[] {
  return messages.map(redactDiagnostic).filter(Boolean)
}

function getProviderDisplayName(providerId: string, entry?: OpenCodeProviderListEntry): string {
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

function getConnectedProviderMap(
  inventory: OpenCodeInventorySnapshot,
  providers: OpenCodeProviderResponse | null,
): Map<string, OpenCodeConnectedProvider | null> {
  const connected = new Map<string, OpenCodeConnectedProvider | null>()

  for (const provider of inventory.connectedProviders) {
    const providerId = normalizeProviderId(provider.id)
    if (providerId) {
      connected.set(providerId, provider)
    }
  }

  for (const providerId of providers?.connected ?? []) {
    const normalizedProviderId = normalizeProviderId(providerId)
    if (normalizedProviderId && !connected.has(normalizedProviderId)) {
      connected.set(normalizedProviderId, null)
    }
  }

  return connected
}

function getModelCounts(
  inventory: OpenCodeInventorySnapshot,
  configProviders: OpenCodeConfigProvidersResponse | null,
  providers?: OpenCodeProviderResponse | null,
): Map<string, number> {
  const counts = new Map<string, number>()

  for (const model of inventory.models) {
    const slashIndex = model.indexOf('/')
    const providerId = normalizeProviderId(slashIndex > 0 ? model.slice(0, slashIndex) : null)
    if (providerId) {
      counts.set(providerId, (counts.get(providerId) ?? 0) + 1)
    }
  }

  for (const provider of configProviders?.providers ?? []) {
    const providerId = normalizeProviderId(provider.id)
    const models = asRecord(provider.models)
    if (!providerId || !models) {
      continue
    }
    counts.set(providerId, Math.max(counts.get(providerId) ?? 0, Object.keys(models).length))
  }

  for (const provider of providers?.all ?? []) {
    const providerId = normalizeProviderId(provider.id)
    const models = asRecord(provider.models)
    if (!providerId || !models) {
      continue
    }
    counts.set(providerId, Math.max(counts.get(providerId) ?? 0, Object.keys(models).length))
  }

  return counts
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

function getKnownProviderIds(input: {
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
}): Set<string> {
  const providerIds = new Set<string>()

  for (const providerId of SEEDED_PROVIDER_IDS) {
    providerIds.add(providerId)
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
      return input.connectedProvider.credentialScopes
        .filter(scope => scope === 'managed' || scope === 'local')
    }
    return ['managed']
  }

  if (input.connected) {
    return ['managed']
  }

  return []
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
    asString(configProviders?.default?.[providerId]) ??
    asString(providers?.default?.[providerId])
  if (!modelId) {
    return null
  }
  return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`
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
      return normalizedModelId.startsWith(`${normalizedProviderId}/`)
        ? normalizedModelId
        : `${normalizedProviderId}/${normalizedModelId}`
    }
  }
  return null
}

function getFallbackModel(inventory: OpenCodeInventorySnapshot): string | null {
  return inventory.models[0] ?? null
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
  diagnostics: readonly string[]
}): ProviderRuntimeState {
  if (!input.inventory.detected) return 'needs-setup'
  if (input.hostStartError) return 'degraded'
  if (input.host && input.host.state !== 'healthy') return 'degraded'
  if (input.connectedProviderCount === 0) return 'needs-auth'
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
  }
}

function canConnectWithApiKey(
  providerId: string,
  authMethods: readonly ProviderAuthMethod[],
): boolean {
  return authMethods.includes('api') || SEEDED_API_BOOTSTRAP_PROVIDER_IDS.has(providerId)
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
  modelCount: number | null
  authMethods: readonly ProviderAuthMethod[]
  ownership: readonly ProviderOwnership[]
  capabilities: OpenCodeProviderManagementCapabilities
}): ProviderActionDescriptor[] {
  if (!input.connected) {
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

    return [
      providerAction({
        id: 'configure',
        label: 'Configure manually',
        enabled: false,
        disabledReason: 'OpenCode did not advertise API-key auth for this provider',
        requiresSecret: false,
        ownershipScope: 'runtime',
      }),
    ]
  }

  const actions: ProviderActionDescriptor[] = []
  const hasModels = input.modelCount !== 0
  const noModelsReason = input.modelCount === 0
    ? 'No models reported for this provider'
    : null

  if (hasModels) {
    actions.push(providerAction({
      id: 'use',
      label: 'Use',
      enabled: true,
      requiresSecret: false,
      ownershipScope: 'runtime',
    }))
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

  if (input.ownership.includes('managed') && input.capabilities.deleteAuth) {
    actions.push(providerAction({
      id: 'forget',
      label: 'Forget',
      enabled: true,
      requiresSecret: false,
      ownershipScope: 'managed',
    }))
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
    const connected = connectedProviders.has(providerId)
    const modelCount = modelCounts.get(providerId) ?? 0
    const authMethods = normalizeAuthMethods(input.providerAuth?.[providerId])
    const ownership = getOwnership({
      connected,
      connectedProvider,
      inventory: input.inventory,
    })
    const state: ProviderConnection['state'] = connected
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
      actions: buildProviderActions({
        providerId,
        connected,
        modelCount,
        authMethods,
        ownership,
        capabilities: input.capabilities,
      }),
      detail: connected
        ? getConnectedProviderDetail(ownership)
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
    input.inventory.availableProviders.some(providerId => normalizeProviderId(providerId) === input.providerId) ||
    input.inventory.connectedProviders.some(provider => normalizeProviderId(provider.id) === input.providerId)
  ) {
    sources.add('inventory')
  }
  if (input.configProviders?.providers?.some(provider => normalizeProviderId(provider.id) === input.providerId)) {
    sources.add('config-provider')
  }
  if (
    input.providers?.all?.some(provider => normalizeProviderId(provider.id) === input.providerId) ||
    input.providers?.connected?.some(providerId => normalizeProviderId(providerId) === input.providerId)
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

function getProviderSetupKind(input: {
  connected: boolean
  providerId: string
  modelCount: number | null
  authMethods: readonly ProviderAuthMethod[]
}): ProviderDirectoryEntry['setupKind'] {
  if (input.connected) {
    return 'connected'
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
  modelCount: number | null
  authMethods: readonly ProviderAuthMethod[]
  ownership: readonly ProviderOwnership[]
  capabilities: OpenCodeProviderManagementCapabilities
  setupKind: ProviderDirectoryEntry['setupKind']
}): ProviderActionDescriptor[] {
  if (input.setupKind === 'available-readonly' || input.setupKind === 'requires-environment') {
    return [
      providerAction({
        id: 'configure',
        label: input.setupKind === 'requires-environment' ? 'Requires environment' : 'Configure manually',
        enabled: false,
        disabledReason: 'OpenCode did not advertise an app-managed API-key setup flow for this provider',
        requiresSecret: false,
        ownershipScope: 'runtime',
      }),
    ]
  }

  return buildProviderActions(input)
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
      return entry.setupKind === 'connect-api-key'
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
  return [...entries].sort((left, right) => {
    const leftRecommended = isRecommendedProvider(left.providerId) ? 0 : 1
    const rightRecommended = isRecommendedProvider(right.providerId) ? 0 : 1
    if (leftRecommended !== rightRecommended) return leftRecommended - rightRecommended

    if (left.state !== right.state) {
      if (left.state === 'connected') return -1
      if (right.state === 'connected') return 1
      if (left.setupKind === 'connect-api-key') return -1
      if (right.setupKind === 'connect-api-key') return 1
    }

    return left.displayName.localeCompare(right.displayName)
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
  const limit = input.limit === Number.MAX_SAFE_INTEGER
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
    const connected = connectedProviders.has(providerId)
    const modelCount = modelCounts.has(providerId) ? modelCounts.get(providerId)! : null
    const authMethods = normalizeAuthMethods(input.providerAuth?.[providerId])
    const ownership = getOwnership({
      connected,
      connectedProvider,
      inventory: input.inventory,
    })
    const setupKind = getProviderSetupKind({
      connected,
      providerId,
      modelCount,
      authMethods,
    })
    const state: ProviderConnection['state'] = connected
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
      detail: connected
        ? getConnectedProviderDetail(ownership)
        : setupKind === 'connect-api-key'
          ? 'OpenCode advertises API-key auth for this provider'
          : modelCount !== null && modelCount > 0
            ? 'Models are visible, but no connected credential was reported'
            : 'Inline setup is not supported for this provider yet',
      actions: buildProviderDirectoryActions({
        providerId,
        connected,
        modelCount,
        authMethods,
        ownership,
        capabilities,
        setupKind,
      }),
      metadata: {
        hasKnownModels: modelCount !== null && modelCount > 0,
        requiresManualConfig: setupKind === 'configure-manually' || setupKind === 'requires-environment',
        supportedInlineAuth: setupKind === 'connect-api-key',
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
  const returnedEntries = limit === Number.MAX_SAFE_INTEGER
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
  const matchingEntries = input.directory.entries.filter(entry =>
    providerDirectoryEntryMatchesQuery(
      entry,
      input.modelIdsByProviderId?.[entry.providerId] ?? [],
      query,
    ) &&
    providerDirectoryEntryMatchesFilter(entry, filter)
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

  return {
    runtimeId: 'opencode',
    title: 'OpenCode Providers',
    runtime: {
      state: getRuntimeState({
        inventory: input.inventory,
        host: input.host,
        hostStartError: input.hostStartError ?? null,
        connectedProviderCount,
        diagnostics: input.diagnostics,
      }),
      cliPath: input.inventory.binaryPath,
      version: input.host?.version ?? input.inventory.version,
      managedProfile: getManagedProfileState(input.inventory),
      localAuth: getLocalAuthState(input.inventory),
    },
    providers: providerConnections,
    defaultModel: getDefaultModel(input.inventory, input.configProviders, input.providers),
    fallbackModel: getFallbackModel(input.inventory),
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
    : Promise.resolve({ ok: true, value: null } as SafeValue<OpenCodeServerDocResponse | null>)

  const [
    configProvidersResult,
    providersResult,
    providerAuthResult,
    serverDocResult,
  ] = await Promise.all([
    safeRead(() => input.client.getConfigProviders()),
    safeRead(() => input.client.getProviders()),
    safeRead(() => input.client.getProviderAuth()),
    serverDocRead,
  ])

  const diagnostics = [
    ...(input.diagnostics ?? []),
    ...(configProvidersResult.ok ? [] : [configProvidersResult.message]),
    ...(providersResult.ok ? [] : [providersResult.message]),
    ...(providerAuthResult.ok ? [] : [providerAuthResult.message]),
    ...(serverDocResult.ok ? [] : [serverDocResult.message]),
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

function collectProviderModelIds(input: {
  providerId: string
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
}): string[] {
  const modelIds = new Set<string>()
  const prefix = `${input.providerId}/`

  for (const modelId of input.inventory.models) {
    const normalizedModelId = modelId.trim()
    if (normalizedModelId.startsWith(prefix) && normalizedModelId.length > prefix.length) {
      modelIds.add(normalizedModelId)
    }
  }

  const configProvider = input.configProviders?.providers?.find(provider =>
    normalizeProviderId(provider.id) === input.providerId)
  const configModels = asRecord(configProvider?.models)
  for (const modelId of Object.keys(configModels ?? {})) {
    const normalizedModelId = modelId.trim()
    if (normalizedModelId) {
      modelIds.add(`${input.providerId}/${normalizedModelId}`)
    }
  }

  const liveProvider = input.providers?.all?.find(provider =>
    normalizeProviderId(provider.id) === input.providerId)
  const liveModels = asRecord(liveProvider?.models)
  for (const modelId of Object.keys(liveModels ?? {})) {
    const normalizedModelId = modelId.trim()
    if (normalizedModelId) {
      modelIds.add(`${input.providerId}/${normalizedModelId}`)
    }
  }

  return Array.from(modelIds).sort((left, right) => left.localeCompare(right))
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
    model.free ? 'free' : '',
  ].some(value => value.toLowerCase().includes(query))
}

function buildRuntimeProviderModel(input: {
  providerId: string
  modelId: string
  providerEntry?: OpenCodeProviderListEntry
  defaultModelId: string | null
  availability?: ProviderModelAvailability
}): RuntimeProviderModel {
  const nestedModelId = input.modelId.slice(`${input.providerId}/`.length)
  return {
    modelId: input.modelId,
    providerId: input.providerId,
    displayName: nestedModelId || input.modelId,
    sourceLabel: getProviderDisplayName(input.providerId, input.providerEntry),
    free: input.modelId.toLowerCase().includes(':free'),
    default: input.defaultModelId === input.modelId,
    availability: input.availability ?? 'untested',
  }
}

function buildProviderModelsView(input: {
  providerId: string
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
  query?: string | null
  limit?: number | null
  diagnostics?: readonly string[]
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
  const models = collectProviderModelIds({
    providerId: input.providerId,
    inventory: input.inventory,
    configProviders: input.configProviders,
    providers: input.providers,
  })
    .map(modelId => buildRuntimeProviderModel({
      providerId: input.providerId,
      modelId,
      providerEntry: entries.get(input.providerId),
      defaultModelId,
    }))
    .filter(model => providerModelMatchesQuery(model, query))

  return {
    runtimeId: 'opencode',
    providerId: input.providerId,
    models: limit ? models.slice(0, limit) : models,
    defaultModelId,
    diagnostics: input.diagnostics ?? [],
  }
}

function providerIsConnected(input: {
  inventory: OpenCodeInventorySnapshot
  providers: OpenCodeProviderResponse | null
  providerId: string
}): boolean {
  return getConnectedProviderMap(input.inventory, input.providers).has(input.providerId)
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
    message: input.probe.outcome === 'available'
      ? 'Model probe passed'
      : input.probe.reason ?? 'Model probe failed',
    diagnostics: input.probe.diagnostics,
  }
}

export class OpenCodeProviderManagementAdapter implements ProviderManagementQueryPort, ProviderManagementDirectoryQueryPort, ProviderManagementCommandPort {
  private readonly directoryCache = new Map<string, ProviderDirectoryCacheEntry>()

  constructor(private readonly deps: OpenCodeProviderManagementAdapterDeps = {}) {}

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

  private getAuthStore() {
    return this.deps.authStore ?? {
      upsertApiKey: upsertOpenCodeApiAuthCredential,
      removeCredential: removeOpenCodeAuthCredential,
    }
  }

  private getExecutionProbe() {
    return this.deps.executionProbe ?? openCodeExecutionProbe
  }

  private getManagedPreferences() {
    return this.deps.managedPreferences ?? {
      setDefaultModel: setOpenCodeManagedDefaultModel,
    }
  }

  private getProfileManager() {
    return this.deps.profileManager ?? openCodeProfileManager
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
    const inventory = await inventoryService.probe(projectPath)

    if (!inventory.detected) {
      return providerManagementError(
        'runtime-missing',
        'OpenCode CLI not detected on PATH',
      )
    }

    const hostManager = this.deps.hostManager ?? openCodeHostManager
    const clientFactory = this.deps.clientFactory ?? openCodeClientFactory
    let host: OpenCodeHostHandle | null = null

    try {
      host = await hostManager.ensureHost({ projectPath: inventory.projectPath })
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
        await hostManager.releaseHost(host.hostKey).catch(() => undefined)
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
    const inventory = await inventoryService.probe(request.projectPath)

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

    const hostManager = this.deps.hostManager ?? openCodeHostManager
    const clientFactory = this.deps.clientFactory ?? openCodeClientFactory
    let host: OpenCodeHostHandle | null = null

    try {
      host = await hostManager.ensureHost({ projectPath: inventory.projectPath })
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
        await hostManager.releaseHost(host.hostKey).catch(() => undefined)
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
    const inventory = await inventoryService.probe(input.projectPath)

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

    const hostManager = this.deps.hostManager ?? openCodeHostManager
    const clientFactory = this.deps.clientFactory ?? openCodeClientFactory
    let host: OpenCodeHostHandle | null = null

    try {
      host = await hostManager.ensureHost({ projectPath: inventory.projectPath })
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
        : Promise.resolve({ ok: true, value: null } as SafeValue<OpenCodeServerDocResponse | null>)
      const [
        configProvidersResult,
        providersResult,
        providerAuthResult,
        serverDocResult,
      ] = await Promise.all([
        safeRead(() => client.getConfigProviders()),
        safeRead(() => client.getProviders()),
        safeRead(() => client.getProviderAuth()),
        serverDocRead,
      ])
      const diagnostics = [
        ...inventory.diagnostics,
        ...(configProvidersResult.ok ? [] : [configProvidersResult.message]),
        ...(providersResult.ok ? [] : [providersResult.message]),
        ...(providerAuthResult.ok ? [] : [providerAuthResult.message]),
        ...(serverDocResult.ok ? [] : [serverDocResult.message]),
      ]
      const directorySource = {
        inventory,
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
        await hostManager.releaseHost(host.hostKey).catch(() => undefined)
      }
    }
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
        const [configProvidersResult, providersResult] = await Promise.all([
          safeRead(() => client.getConfigProviders()),
          safeRead(() => client.getProviders()),
        ])
        const diagnostics = [
          ...inventory.diagnostics,
          ...(configProvidersResult.ok ? [] : [configProvidersResult.message]),
          ...(providersResult.ok ? [] : [providersResult.message]),
        ]
        const modelsView = buildProviderModelsView({
          providerId,
          inventory,
          configProviders: configProvidersResult.ok ? configProvidersResult.value : null,
          providers: providersResult.ok ? providersResult.value : null,
          query: input.query,
          limit: input.limit,
          diagnostics,
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
    const providerId = normalizeProviderId(input.providerId)
    if (!providerId) {
      return providerManagementError('provider-missing', 'Provider id is invalid')
    }

    const apiKey = input.apiKey.trim()
    if (!apiKey) {
      return providerManagementError('auth-required', 'API key is required')
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

        const authApplied = await client.setProviderAuth(providerId, {
          type: 'api',
          key: apiKey,
        })
        if (authApplied !== true) {
          return providerManagementError(
            'auth-failed',
            `OpenCode did not apply API-key auth for provider ${providerId}`,
          )
        }

        const authStore = this.getAuthStore()
        await authStore.upsertApiKey({ authPath: globalAuthPath, providerId, apiKey })
        await authStore.upsertApiKey({ authPath: managedAuthPath, providerId, apiKey })
        this.invalidateDirectoryCache()
        const refreshedInventory = await inventoryService.probe(inventory.projectPath, {
          bypassCache: true,
        })
        const view = await readLiveView({
          inventory: refreshedInventory,
          host,
          client,
          diagnostics: refreshedInventory.diagnostics,
        })
        const provider = findProviderConnection(view, providerId)
        if (!provider) {
          return providerManagementError(
            'provider-missing',
            `OpenCode did not return provider ${providerId} after connecting`,
          )
        }
        if (provider.state !== 'connected' && !provider.ownership.includes('managed')) {
          return providerManagementError(
            'auth-failed',
            `OpenCode accepted the auth request but did not report provider ${providerId} as connected`,
          )
        }
        return { ok: true, value: provider }
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
        const refreshedInventory = await inventoryService.probe(inventory.projectPath, {
          bypassCache: true,
        })
        const view = await readLiveView({
          inventory: refreshedInventory,
          host,
          client,
          diagnostics: refreshedInventory.diagnostics,
        })
        const provider = findProviderConnection(view, providerId)
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

        if (!providerIsConnected({ inventory, providers, providerId })) {
          return providerManagementError(
            'auth-required',
            `Provider ${providerId} must be connected before setting a default model`,
          )
        }

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

        if (input.probe !== false) {
          const probeResult = await this.getExecutionProbe().probeModel({
            selectedModel: modelId,
            projectPath: inventory.projectPath,
          })
          if (probeResult.outcome !== 'available') {
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

        const profileRootPath = inventory.profile?.profileRootPath
        if (!profileRootPath) {
          return providerManagementError(
            'runtime-unhealthy',
            'OpenCode managed profile root is unavailable',
          )
        }
        await this.getManagedPreferences().setDefaultModel(profileRootPath, modelId)
        this.invalidateDirectoryCache()

        const refreshedInventory = await inventoryService.probe(inventory.projectPath, {
          bypassCache: true,
        })
        const refreshedView = await readLiveView({
          inventory: refreshedInventory,
          host,
          client,
          diagnostics: refreshedInventory.diagnostics,
        })

        return {
          ok: true,
          value: {
            ...refreshedView,
            defaultModel: modelId,
            providers: refreshedView.providers.map(provider =>
              provider.providerId === providerId
                ? { ...provider, defaultModelId: modelId }
                : provider
            ),
          },
        }
      },
      { failureCode: 'model-test-failed' },
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

        if (!providerIsConnected({ inventory, providers, providerId })) {
          return providerManagementError(
            'auth-required',
            `Provider ${providerId} must be connected before testing a model`,
          )
        }

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

        const probe = await this.getExecutionProbe().probeModel({
          selectedModel: modelId,
          projectPath: inventory.projectPath,
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
}

export const openCodeProviderManagementAdapter = new OpenCodeProviderManagementAdapter()
