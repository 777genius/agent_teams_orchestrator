import {
  openCodeClientFactory,
  type OpenCodeClient,
} from '../../../../services/opencode/OpenCodeClientFactory.js'
import { openCodeHostManager } from '../../../../services/opencode/OpenCodeHostManager.js'
import { openCodeInventoryService } from '../../../../services/opencode/OpenCodeInventoryService.js'
import type {
  OpenCodeConfigProvidersResponse,
  OpenCodeConnectedProvider,
  OpenCodeHostHandle,
  OpenCodeInventorySnapshot,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderListEntry,
  OpenCodeProviderResponse,
} from '../../../../services/opencode/types.js'
import { isRecommendedProvider, sortProviderConnections } from '../../domain/providerOrdering.js'
import type {
  LocalAuthState,
  ManagedProfileState,
  ProviderAuthMethod,
  ProviderConnection,
  ProviderManagementResult,
  ProviderManagementRuntimeId,
  ProviderManagementView,
  ProviderOwnership,
  ProviderRuntimeState,
} from '../../domain/types.js'
import type { ProviderManagementQueryPort } from '../../ports/ProviderManagementPorts.js'

type OpenCodeInventoryServiceLike = Pick<typeof openCodeInventoryService, 'probe'>

type OpenCodeHostManagerLike = Pick<
  typeof openCodeHostManager,
  'ensureHost' | 'releaseHost'
>

type OpenCodeClientFactoryLike = Pick<typeof openCodeClientFactory, 'create'>

type OpenCodeProviderManagementAdapterDeps = {
  inventoryService?: OpenCodeInventoryServiceLike
  hostManager?: OpenCodeHostManagerLike
  clientFactory?: OpenCodeClientFactoryLike
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeProviderId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized && /^[a-z0-9][a-z0-9._-]*$/i.test(normalized) ? normalized : null
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

  if (normalized.size === 0) {
    normalized.add('api')
  }

  return Array.from(normalized)
}

function getOwnership(input: {
  connectedProvider: OpenCodeConnectedProvider | null | undefined
  inventory: OpenCodeInventorySnapshot
}): ProviderOwnership[] {
  if (input.connectedProvider?.source === 'environment') {
    return ['env']
  }

  if (input.connectedProvider?.source === 'credentials') {
    return input.inventory.profile?.sourceAuthPath
      ? ['managed', 'local']
      : ['managed']
  }

  return []
}

function getDefaultModelForProvider(
  providerId: string,
  configProviders: OpenCodeConfigProvidersResponse | null,
): string | null {
  const modelId = asString(configProviders?.default?.[providerId])
  return modelId ? `${providerId}/${modelId}` : null
}

function getDefaultModel(configProviders: OpenCodeConfigProvidersResponse | null): string | null {
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
  connectedProviderCount: number
  diagnostics: readonly string[]
}): ProviderRuntimeState {
  if (!input.inventory.detected) return 'needs-setup'
  if (input.host && input.host.state !== 'healthy') return 'degraded'
  if (input.connectedProviderCount === 0) return 'needs-auth'
  if (input.diagnostics.length > 0 && input.inventory.models.length === 0) return 'degraded'
  return 'ready'
}

function getPrimaryAction(input: {
  connected: boolean
  modelCount: number
  authMethods: readonly ProviderAuthMethod[]
}): ProviderConnection['primaryAction'] {
  if (input.connected) {
    return input.modelCount > 0 ? 'use' : 'test'
  }
  return input.authMethods.includes('api') ? 'connect' : null
}

function buildProviderConnections(input: {
  inventory: OpenCodeInventorySnapshot
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
  providerAuth: Record<string, OpenCodeProviderAuthMethod[]> | null
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
    const state: ProviderConnection['state'] = connected
      ? 'connected'
      : modelCount > 0
        ? 'available'
        : 'not-connected'

    connections.push({
      providerId,
      displayName: getProviderDisplayName(providerId, entries.get(providerId)),
      state,
      ownership: getOwnership({
        connectedProvider,
        inventory: input.inventory,
      }),
      recommended: isRecommendedProvider(providerId),
      modelCount,
      defaultModelId: getDefaultModelForProvider(providerId, input.configProviders),
      authMethods,
      primaryAction: getPrimaryAction({
        connected,
        modelCount,
        authMethods,
      }),
      detail: connected
        ? 'Connected in the app-managed OpenCode profile'
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
  diagnostics: readonly string[]
}): ProviderManagementView {
  const providerConnections = buildProviderConnections({
    inventory: input.inventory,
    configProviders: input.configProviders,
    providers: input.providers,
    providerAuth: input.providerAuth,
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
        connectedProviderCount,
        diagnostics: input.diagnostics,
      }),
      cliPath: input.inventory.binaryPath,
      version: input.host?.version ?? input.inventory.version,
      managedProfile: getManagedProfileState(input.inventory),
      localAuth: getLocalAuthState(input.inventory),
    },
    providers: providerConnections,
    defaultModel: getDefaultModel(input.configProviders),
    fallbackModel: getFallbackModel(input.inventory),
    diagnostics: input.diagnostics,
  }
}

export class OpenCodeProviderManagementAdapter implements ProviderManagementQueryPort {
  constructor(private readonly deps: OpenCodeProviderManagementAdapterDeps = {}) {}

  async loadView(
    runtimeId: ProviderManagementRuntimeId,
  ): Promise<ProviderManagementResult<ProviderManagementView>> {
    if (runtimeId !== 'opencode') {
      return {
        ok: false,
        error: {
          code: 'unsupported-runtime',
          message: `Provider management is not available for ${runtimeId}`,
          recoverable: false,
        },
      }
    }

    const inventoryService = this.deps.inventoryService ?? openCodeInventoryService
    const inventory = await inventoryService.probe()

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
      const client: OpenCodeClient = clientFactory.create(host.baseUrl)
      const [configProvidersResult, providersResult, providerAuthResult] = await Promise.all([
        safeRead(() => client.getConfigProviders()),
        safeRead(() => client.getProviders()),
        safeRead(() => client.getProviderAuth()),
      ])

      const diagnostics = [
        ...inventory.diagnostics,
        ...(configProvidersResult.ok ? [] : [configProvidersResult.message]),
        ...(providersResult.ok ? [] : [providersResult.message]),
        ...(providerAuthResult.ok ? [] : [providerAuthResult.message]),
      ]

      return {
        ok: true,
        value: buildView({
          inventory,
          host,
          configProviders: configProvidersResult.ok ? configProvidersResult.value : null,
          providers: providersResult.ok ? providersResult.value : null,
          providerAuth: providerAuthResult.ok ? providerAuthResult.value : null,
          diagnostics,
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
        }),
      }
    } finally {
      if (host) {
        await hostManager.releaseHost(host.hostKey)
      }
    }
  }
}

export const openCodeProviderManagementAdapter = new OpenCodeProviderManagementAdapter()
