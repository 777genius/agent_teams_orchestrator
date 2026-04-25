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
  LoadProviderModelsInput,
  LoadProviderManagementViewInput,
  LocalAuthState,
  ManagedProfileState,
  ProviderActionDescriptor,
  ProviderAuthMethod,
  ProviderConnection,
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
    return input.inventory.profile?.sourceAuthPath ? ['managed', 'local'] : ['managed']
  }

  if (input.connected) {
    return ['managed']
  }

  return []
}

function getDefaultModelForProvider(
  providerId: string,
  inventory: OpenCodeInventorySnapshot,
  configProviders: OpenCodeConfigProvidersResponse | null,
): string | null {
  const managedDefault = asString(inventory.profile?.managedConfig?.model)
  if (managedDefault?.startsWith(`${providerId}/`)) {
    return managedDefault
  }

  const modelId = asString(configProviders?.default?.[providerId])
  return modelId ? `${providerId}/${modelId}` : null
}

function getDefaultModel(
  inventory: OpenCodeInventorySnapshot,
  configProviders: OpenCodeConfigProvidersResponse | null,
): string | null {
  const managedDefault = asString(inventory.profile?.managedConfig?.model)
  if (managedDefault) {
    return managedDefault
  }

  for (const [providerId, modelId] of Object.entries(configProviders?.default ?? {})) {
    const normalizedProviderId = normalizeProviderId(providerId)
    const normalizedModelId = asString(modelId)
    if (normalizedProviderId && normalizedModelId) {
      return `${normalizedProviderId}/${normalizedModelId}`
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
  modelCount: number
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

  if (input.modelCount > 0) {
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
      enabled: input.modelCount > 0,
      disabledReason: input.modelCount > 0 ? null : 'No models reported for this provider',
      requiresSecret: false,
      ownershipScope: 'runtime',
    }),
    providerAction({
      id: 'set-default',
      label: 'Set default',
      enabled: input.modelCount > 0,
      disabledReason: input.modelCount > 0 ? null : 'No models reported for this provider',
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
  const modelCounts = getModelCounts(input.inventory, input.configProviders)
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
      defaultModelId: getDefaultModelForProvider(providerId, input.inventory, input.configProviders),
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
        ? 'Connected via app-managed OpenCode credential'
        : modelCount > 0
          ? 'Provider is visible in the OpenCode model catalog'
          : null,
    })
  }

  return sortProviderConnections(connections)
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
    defaultModel: getDefaultModel(input.inventory, input.configProviders),
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

  return Array.from(modelIds).sort((left, right) => left.localeCompare(right))
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
  )
  const query = normalizeQuery(input.query)
  const limit = normalizePositiveLimit(input.limit)
  const models = collectProviderModelIds({
    providerId: input.providerId,
    inventory: input.inventory,
    configProviders: input.configProviders,
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

export class OpenCodeProviderManagementAdapter implements ProviderManagementQueryPort, ProviderManagementCommandPort {
  constructor(private readonly deps: OpenCodeProviderManagementAdapterDeps = {}) {}

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
        const globalAuthPath = inventory.profile?.globalAuthPath ?? inventory.profile?.sourceAuthPath
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
        if (inventory.profile?.sourceAuthPath) authPaths.add(inventory.profile.sourceAuthPath)
        if (inventory.profile?.managedAuthPath) authPaths.add(inventory.profile.managedAuthPath)
        for (const authPath of await this.getProfileManager().listManagedAuthPaths()) {
          authPaths.add(authPath)
        }
        const authStore = this.getAuthStore()
        for (const authPath of authPaths) {
          await authStore.removeCredential({ authPath, providerId })
        }
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
