import path from 'node:path'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { OpenCode as Floor } from '@opencode/client-v2-floor'
import { OpenCode as Current } from '@opencode/client'
import { hashOpenCodeFile } from '../compatibility/OpenCodeNativeIdentity.js'
import { executionAssert, executionRecord, type ExecutionAuthority, type ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import { OpenCodeV2ProviderWire } from '../transport/OpenCodeV2ProviderWire.js'
import { requireExecutionEndpoint, registerExecutionDisposer } from './OpenCodeV2ExecutionHost.js'
import type { OwnedNativeProfile } from './OpenCodeV2ExecutionBinding.js'

type SelectedKeyPort = {
  providers(): Promise<unknown>; integration(id: string): Promise<unknown>
  connect(id: string, key: string): Promise<void>
  models?(): Promise<unknown>
}

/** Fresh native databases bootstrap their schema without running the legacy auth migration.
 * Attach only the sealed selected key through the native API before any session admission. */
export async function attachOpenCodeV2SelectedKey(profile: OwnedNativeProfile, port: SelectedKeyPort): Promise<void> {
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
  const file = path.join(profile.root, 'data/opencode/auth.json')
  const fingerprint = profile.authSha256
  executionAssert(typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint), 'execution_selected_auth_unbound')
  const check = async () => {
    const stat = await lstat(file)
    executionAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.() &&
      (stat.mode & 0o077) === 0 && stat.size <= 128 * 1024 && await realpath(file) === file &&
      await hashOpenCodeFile(file) === fingerprint, 'execution_selected_auth_changed')
  }
  await check()
  const bytes = await readFile(file)
  executionAssert(createHash('sha256').update(bytes).digest('hex') === fingerprint, 'execution_selected_auth_changed')
  const store = executionRecord(JSON.parse(bytes.toString('utf8')))
  executionAssert(Object.keys(store).length === 1 && Object.hasOwn(store, providerId), 'execution_selected_auth_missing')
  const credential = executionRecord(store[providerId])
  executionAssert(credential.type === 'api' && typeof credential.key === 'string' && credential.key.length > 0 &&
    Object.keys(credential).every(key => key === 'type' || key === 'key'), 'execution_selected_auth_unsupported')
  const scoped = (value: unknown) => {
    const row = executionRecord(value)
    executionAssert(executionRecord(row.location).directory === profile.directory, 'execution_selected_auth_location_changed')
    return row.data
  }
  const providers = scoped(await port.providers())
  executionAssert(Array.isArray(providers), 'execution_selected_auth_provider_unknown')
  const matches = providers.map(executionRecord).filter(row => row.id === providerId)
  const integrationId = matches[0]?.integrationID
  executionAssert(matches.length === 1 && typeof integrationId === 'string' && integrationId.length > 0, 'execution_selected_auth_provider_unknown')
  const before = executionRecord(scoped(await port.integration(integrationId)))
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
    const sdk = authority.pin === '2.0.0' ? Floor.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch })
      : Current.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch })
    const location = { directory: profile.directory }
    await attachOpenCodeV2SelectedKey(profile, {
      providers: () => sdk.provider.list({ location }),
      models: () => sdk.model.list({ location }),
      integration: integrationID => sdk.integration.get({ location, integrationID }),
      connect: (integrationID, key) => sdk.integration.connect.key({ location, integrationID, key }),
    })
  } finally { await wire.dispose(); unregister() }
}
