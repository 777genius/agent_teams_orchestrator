import { createHash } from 'node:crypto'
import { isLiteralLoopbackOpenCodeUrl } from '../OpenCodeProviderIdentity.js'
import { executionAssert, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { OwnedNativeProfile } from './OpenCodeV2ExecutionBinding.js'

const LOCAL_ROUTE_UNPROVEN = 'execution_selected_auth_local_route_unproven'
const CONFIG_PACKAGE = 'aisdk:@ai-sdk/openai-compatible'
const NATIVE_PACKAGE = '@opencode/ai/providers/openai-compatible'
type LocalRoute = Readonly<{ providerID: string; modelID: string; upstreamModelID: string; baseURL: string;
  configContent: string; configSha256: string }>

const optionalRecord = (value: unknown): Record<string, unknown> => value === undefined ? {} : executionRecord(value)
function assertLocalRoute(value: unknown): asserts value { executionAssert(value, LOCAL_ROUTE_UNPROVEN) }

/** Inspect only the owner's sealed selected configuration. A caller's provider name,
 * absent key or model price cannot grant access to a remote or inherited route. */
export function readOpenCodeV2AuthlessLocalRoute(profile: OwnedNativeProfile): LocalRoute | null {
  executionAssert(!('purpose' in profile.selection), 'execution_selected_auth_required')
  const config = executionRecord(JSON.parse(profile.config.content))
  const provider = optionalRecord(optionalRecord(config.providers)[profile.selection.model.providerID])
  if (provider.package !== CONFIG_PACKAGE) return null
  const endpoint = optionalRecord(provider.settings).baseURL
  // A nonlocal declaration retains the existing native public/free admission path.
  // This helper grants it no authority and never weakens that path's checks.
  if (typeof endpoint !== 'string' || endpoint !== endpoint.trim() || !isLiteralLoopbackOpenCodeUrl(endpoint)) return null
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname === '0.0.0.0' || url.search || url.hash) return null
  assertLocalRoute(createHash('sha256').update(profile.config.content).digest('hex') === profile.config.sha256)
  const selected = profile.selection.model, configuredModel = executionRecord(config.model)
  assertLocalRoute(configuredModel.providerID === selected.providerID && configuredModel.model === selected.id &&
    configuredModel.variant === selected.variant)
  const models = executionRecord(provider.models)
  assertLocalRoute(Object.hasOwn(models, selected.id))
  const model = executionRecord(models[selected.id])
  assertRouteOverlay(provider, endpoint, selected.providerID, true)
  assertRouteOverlay(model, endpoint, selected.providerID, true)
  assertLocalRoute(model.disabled !== true && (model.modelID === undefined || typeof model.modelID === 'string' && model.modelID.length > 0))
  return { providerID: selected.providerID, modelID: selected.id,
    upstreamModelID: typeof model.modelID === 'string' ? model.modelID : selected.id, baseURL: endpoint,
    configContent: profile.config.content, configSha256: profile.config.sha256 }
}

/** Model and variant overrides cannot replace the endpoint or attach a hidden key.
 * Headers/body overrides are outside this narrowly admitted authless route. */
function assertRouteOverlay(row: Record<string, unknown>, baseURL: string, providerID: string, configured = false): void {
  assertLocalRoute(row.package === undefined || row.package === NATIVE_PACKAGE || configured && row.package === CONFIG_PACKAGE)
  assertLocalRoute(row.canonical === undefined || row.canonical === providerID)
  const settings = optionalRecord(row.settings)
  assertLocalRoute(settings.baseURL === undefined || settings.baseURL === baseURL)
  assertLocalRoute(settings.apiKey === undefined || settings.apiKey === '')
  assertLocalRoute(settings.provider === undefined || settings.provider === providerID)
  for (const key of ['headers', 'body', 'extraBody']) assertLocalRoute(Object.keys(optionalRecord(settings[key])).length === 0)
  assertLocalRoute(Object.keys(optionalRecord(row.headers)).length === 0 && Object.keys(optionalRecord(row.body)).length === 0)
  if (row.variants !== undefined) {
    assertLocalRoute(Array.isArray(row.variants))
    for (const variant of row.variants) assertRouteOverlay(executionRecord(variant), baseURL, providerID, configured)
  }
}

/** This is route admission only. The normal owned native execution probe must still
 * observe the fresh model response and physical cleanup before it can grant launch. */
export async function assertOpenCodeV2AuthlessLocalReadback(profile: OwnedNativeProfile, route: LocalRoute,
  provider: Record<string, unknown>, read: { integration(id: string): Promise<unknown>; models(): Promise<unknown> }): Promise<void> {
  assertLocalRoute(provider.id === route.providerID && provider.activation === 'enabled' && provider.package === NATIVE_PACKAGE &&
    (provider.integrationID === undefined || provider.integrationID === route.providerID))
  assertRouteOverlay(provider, route.baseURL, route.providerID)
  assertLocalRoute(optionalRecord(provider.settings).baseURL === route.baseURL)
  const integration = executionRecord(await read.integration(route.providerID))
  assertLocalRoute(integration.id === route.providerID && Array.isArray(integration.connections) && integration.connections.length === 0)
  const models = await read.models()
  assertLocalRoute(Array.isArray(models))
  const selected = models.map(executionRecord).filter(row => row.providerID === route.providerID && row.id === route.modelID)
  const model = selected[0]
  assertLocalRoute(selected.length === 1 && model?.enabled === true && model.status === 'active' && model.modelID === route.upstreamModelID)
  assertRouteOverlay(model, route.baseURL, route.providerID)
  assertLocalRoute(profile.config.content === route.configContent && profile.config.sha256 === route.configSha256)
}
