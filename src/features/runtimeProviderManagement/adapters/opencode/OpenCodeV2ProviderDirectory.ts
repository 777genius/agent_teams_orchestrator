import type { OpenCodeInventorySnapshot } from '../../../../services/opencode/types.js'
import { openCodeV2KeyIntegration } from '../../../../services/opencode/catalog/OpenCodeV2KeyIntegrations.js'
import { isRecommendedProvider } from '../../domain/providerOrdering.js'
import type { ProviderActionDescriptor, ProviderDirectoryEntry } from '../../domain/types.js'

// The pinned @opencode/core plugin/websearch/{exa,tavily} modules register search
// integrations without an AI provider. Integration.Info has no category field.
// An actual provider-to-integration mapping still takes precedence over this list.
const SEARCH_ONLY_INTEGRATIONS = new Set(['exa', 'tavily'])

/** Discovery is metadata, never credential or selected-model execution evidence. */
export function buildOpenCodeV2ProviderDirectoryEntries(inventory: OpenCodeInventorySnapshot): {
  entries: ProviderDirectoryEntry[]
  modelIdsByProviderId: Record<string, string[]>
} {
  const read = inventory.readStatus
  const integrations = new Map((read?.integrations ?? []).map(row => [row.id, row]))
  const providers = new Map((read?.providers ?? []).map(row => [row.id, row]))
  const connected = new Set(inventory.connectedProviders.map(row => row.id))
  const providerIds = new Set([
    ...integrations.keys(), ...providers.keys(), ...inventory.availableProviders, ...connected,
  ])
  const modelIdsByProviderId: Record<string, string[]> = Object.create(null)
  for (const model of read?.models ?? []) {
    (modelIdsByProviderId[model.providerId] ??= []).push(`${model.providerId}/${model.catalogId}`)
  }
  const entries: ProviderDirectoryEntry[] = []
  for (const providerId of providerIds) {
    const provider = providers.get(providerId)
    if (SEARCH_ONLY_INTEGRATIONS.has(providerId) && !provider?.integrationId) continue
    // Configured aliases may use a different integration, or no integration at all.
    const integration = integrations.get(provider ? provider.integrationId ?? '' : providerId)
    const plainKey = read?.catalog === 'ready' && integration?.plainKey === true
    const isConnected = connected.has(providerId)
    // The isolated reader has no saved credentials. An inactive provider's models
    // are unknown, including when a completed connection receipt exists elsewhere.
    const modelCount = read?.catalog === 'ready' && provider ? (modelIdsByProviderId[providerId]?.length ?? 0) : null
    const hasModels = modelCount !== null && modelCount > 0
    const actions: ProviderActionDescriptor[] = []
    if (plainKey && !isConnected) actions.push({ id: 'connect', label: 'Connect', enabled: true,
      disabledReason: null, requiresSecret: true, ownershipScope: 'managed' })
    if (isConnected || hasModels) {
      actions.push({ id: 'use', label: 'View models', enabled: true, disabledReason: null,
        requiresSecret: false, ownershipScope: 'runtime' })
    }
    if (!isConnected && !plainKey) actions.push({ id: 'configure', label: 'Set up in OpenCode', enabled: false,
      disabledReason: 'This provider does not expose a supported API-key setup method. Configure it in OpenCode.',
      requiresSecret: false, ownershipScope: 'runtime' })
    const nativeCatalog = integrations.has(providerId) || providers.has(providerId)
    const preferred = read?.defaultModel
    entries.push({ providerId,
      displayName: integration?.name ?? openCodeV2KeyIntegration(providerId)?.displayName ?? providerId,
      state: isConnected ? 'connected' : hasModels ? 'available' : 'not-connected',
      connectedAuthHint: isConnected ? 'api' : null,
      setupKind: isConnected ? 'connected' : plainKey ? 'connect-api-key' : 'configure-manually',
      ownership: isConnected ? ['managed'] : [], recommended: isRecommendedProvider(providerId), modelCount,
      authMethods: plainKey || isConnected ? ['api'] : [],
      defaultModelId: preferred?.providerId === providerId ? `${providerId}/${preferred.catalogId}` : null,
      sources: nativeCatalog ? ['opencode-provider'] : ['inventory'],
      sourceLabel: nativeCatalog ? 'OpenCode catalog' : 'inventory', providerSource: null,
      detail: isConnected ? 'Connected with a verified API key'
        : plainKey ? 'Connect with an API key; verification uses one model request'
          : 'Configure this provider in OpenCode. Model access still requires verification.',
      actions,
      metadata: { hasKnownModels: hasModels, requiresManualConfig: !isConnected && !plainKey,
        supportedInlineAuth: plainKey, configuredAuthless: false } })
  }
  return { entries, modelIdsByProviderId }
}
