import { executionAssert, executionRecord, type ExecutionAuthority, type ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import { OpenCodeV2ProviderWire } from '../transport/OpenCodeV2ProviderWire.js'
import { requireExecutionEndpoint, registerExecutionDisposer } from './OpenCodeV2ExecutionHost.js'
import type { OwnedNativeProfile } from './OpenCodeV2ExecutionBinding.js'
import { readOpenCodeV2SelectedAuth, type SelectedAuthMetadata } from './OpenCodeV2ExecutionOAuth.js'

type SelectedKeyPort = {
  providers(): Promise<unknown>; integration(id: string): Promise<unknown>
  connect(id: string, key: string): Promise<void>
  provider?(id: string): Promise<unknown>
  models?(): Promise<unknown>
}

/** Fresh native databases bootstrap their schema without running the legacy auth migration.
 * Attach sealed keys through the API; read back OAuth imported by the sealed child. */
export async function attachOpenCodeV2SelectedKey(profile: OwnedNativeProfile, port: SelectedKeyPort,
  auth?: Readonly<{ metadata?: SelectedAuthMetadata; deadline: number; signal?: AbortSignal }>): Promise<void> {
  executionAssert(!('purpose' in profile.selection), 'execution_selected_auth_required')
  const selectedModel = profile.selection.model
  const providerId = selectedModel.providerID
  // Both pinned native plugins publish this sentinel only for their anonymous lane.
  // No caller provider name or absent auth file alone grants anonymous admission.
  if (profile.authSha256 === undefined) {
    executionAssert(typeof port.models === 'function', 'execution_selected_auth_anonymous_unproven')
    const scoped = (value: unknown) => {
      const row = executionRecord(value)
      executionAssert(executionRecord(row.location).directory === profile.directory, 'execution_selected_auth_location_changed')
      return row.data
    }
    const providers = scoped(await port.providers())
    executionAssert(Array.isArray(providers), 'execution_selected_auth_provider_unknown')
    const matches = providers.map(executionRecord).filter(row => row.id === providerId)
    const provider = matches[0]
    executionAssert(matches.length === 1 && provider?.activation === 'enabled' &&
      executionRecord(provider.settings).apiKey === 'public' && typeof provider.integrationID === 'string' &&
      provider.integrationID.length > 0, 'execution_selected_auth_anonymous_unproven')
    const integration = executionRecord(scoped(await port.integration(provider.integrationID)))
    executionAssert(integration.id === provider.integrationID && Array.isArray(integration.connections) &&
      integration.connections.length === 0, 'execution_selected_auth_anonymous_unproven')
    const models = scoped(await port.models())
    executionAssert(Array.isArray(models), 'execution_selected_auth_anonymous_unproven')
    const selected = models.map(executionRecord).filter(row => row.providerID === providerId && row.id === selectedModel.id)
    const model = selected[0]
    executionAssert(selected.length === 1 && model?.enabled === true && model.status === 'active' &&
      Array.isArray(model.cost) && model.cost.length > 0 && model.cost.every(value => {
        const cost = executionRecord(value), cache = executionRecord(cost.cache)
        return cost.input === 0 && cost.output === 0 && cache.read === 0 && cache.write === 0
      }), 'execution_selected_auth_anonymous_unproven')
    return
  }
  const { credential, check } = await readOpenCodeV2SelectedAuth(profile, auth?.metadata,
    auth?.deadline ?? Date.now() + 15_000, auth?.signal)
  const scoped = (value: unknown) => {
    const row = executionRecord(value)
    executionAssert(executionRecord(row.location).directory === profile.directory, 'execution_selected_auth_location_changed')
    return row.data
  }
  const providers = scoped(await port.providers())
  executionAssert(Array.isArray(providers), 'execution_selected_auth_provider_unknown')
  const matches = providers.map(executionRecord).filter(row => row.id === providerId)
  executionAssert(matches.length <= 1, 'execution_selected_auth_provider_unknown')
  let provider = matches[0]
  if (matches.length === 0 && credential.type === 'api' && typeof port.provider === 'function') {
    const detail = scoped(await port.provider(providerId))
    executionAssert(detail !== null && typeof detail === 'object' && !Array.isArray(detail),
      'execution_selected_auth_provider_unknown')
    provider = executionRecord(detail)
    executionAssert(provider.id === providerId && (provider.activation === 'auto' || provider.activation === 'enabled'),
      'execution_selected_auth_provider_unknown')
  }
  // Both native catalogs default an omitted integrationID to this exact provider ID.
  const integrationId = credential.type === 'api' && provider?.integrationID === undefined
    ? provider?.id : provider?.integrationID
  executionAssert(provider !== undefined && typeof integrationId === 'string' && integrationId.length > 0,
    'execution_selected_auth_provider_unknown')
  const before = executionRecord(scoped(await port.integration(integrationId)))
  if (credential.type === 'oauth') {
    // Provider.Info settings are optional; the official OAuth plugin owns Codex routing.
    const baseURL = matches[0]?.settings === undefined ? undefined : executionRecord(matches[0]?.settings).baseURL
    executionAssert(typeof port.models === 'function' && integrationId === 'openai' &&
      (matches[0]?.activation === 'enabled' || matches[0]?.activation === 'auto') &&
      (baseURL === undefined || baseURL === 'https://chatgpt.com/backend-api/codex'),
    'execution_selected_oauth_provider_unknown')
    executionAssert(before.id === integrationId && Array.isArray(before.methods) && before.methods.some(value => {
        const method = executionRecord(value); return method.type === 'oauth' && method.id === 'chatgpt-browser'
      }), 'execution_selected_oauth_integration_unknown')
    executionAssert(Array.isArray(before.connections) && before.connections.length === 1,
      'execution_selected_oauth_connection_unknown')
    const connected = executionRecord(before.connections[0])
    executionAssert(connected.type === 'credential' && typeof connected.id === 'string' && /^cred_[A-Za-z0-9]+$/.test(connected.id) &&
      (!Object.hasOwn(connected, 'method') || connected.method === 'oauth'), 'execution_selected_oauth_connection_unknown')
    const models = scoped(await port.models())
    executionAssert(Array.isArray(models), 'execution_selected_oauth_model_unknown')
    const selected = models.map(executionRecord).filter(row => row.providerID === providerId && row.id === selectedModel.id)
    executionAssert(selected.length === 1 && selected[0]?.enabled === true && selected[0].status === 'active',
      'execution_selected_oauth_model_unknown')
    await check()
    return
  }
  executionAssert(before.id === integrationId && Array.isArray(before.connections) && before.connections.length === 0 &&
    Array.isArray(before.methods) && before.methods.some(value => {
      const method = executionRecord(value); return method.type === 'key' && method.form === undefined
    }), 'execution_selected_auth_existing_or_unsupported')
  await check()
  await port.connect(integrationId, credential.key)
  const after = executionRecord(scoped(await port.integration(integrationId)))
  executionAssert(after.id === integrationId && Array.isArray(after.connections) && after.connections.length === 1,
    'execution_selected_auth_readback_unknown')
  const connected = executionRecord(after.connections[0])
  executionAssert(connected.type === 'credential' && typeof connected.id === 'string' && /^cred_[A-Za-z0-9]+$/.test(connected.id),
    'execution_selected_auth_readback_unknown')
  await check()
}

export async function initializeOpenCodeV2ExecutionAuth(authority: ExecutionAuthority,
  profile: OwnedNativeProfile, context: ExecutionContext): Promise<void> {
  executionAssert(authority.profileRoot === profile.root && authority.profileEpoch === profile.epoch &&
    authority.directory === profile.directory, 'execution_selected_auth_profile_changed')
  const endpoint = requireExecutionEndpoint(authority)
  const wire = new OpenCodeV2ProviderWire(authority, Math.min(context.deadline, Date.now() + 30_000))
  const unregister = registerExecutionDisposer(authority, () => wire.dispose())
  try {
    const location = { directory: profile.directory }
    // Listener readiness precedes plugin transforms; await each pin's official activation barrier.
    const sdk = authority.pin === '2.0.0'
      ? await (async () => {
        const { OpenCode: Floor } = await import('@opencode/client-v2-floor')
        const sdk = Floor.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch })
        await sdk.plugin.awaitActivation({ location })
        return sdk
      })()
      : await (async () => {
        const { OpenCode: Current } = await import('@opencode/client')
        const sdk = Current.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch })
        await sdk.integration.list({ location })
        return sdk
      })()
    await attachOpenCodeV2SelectedKey(profile, {
      providers: () => sdk.provider.list({ location }),
      provider: providerID => sdk.provider.get({ location, providerID }),
      models: () => sdk.model.list({ location }),
      integration: integrationID => sdk.integration.get({ location, integrationID }),
      connect: (integrationID, key) => sdk.integration.connect.key({ location, integrationID, key }),
    }, { metadata: endpoint.selectedAuth, deadline: context.deadline, signal: context.signal })
  } finally { await wire.dispose(); unregister() }
}
