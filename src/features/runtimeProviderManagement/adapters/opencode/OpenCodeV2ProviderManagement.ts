import { recordOpenCodeV2ProviderFailure } from '../../../../services/opencode/execution/OpenCodeV2Diagnostics.js'
import { openCodeV2Refusal } from '../../../../services/opencode/execution/OpenCodeV2RefusalReason.js'
export { recordOpenCodeV2ProviderFailure } from '../../../../services/opencode/execution/OpenCodeV2Diagnostics.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, writeFile, readFile, lstat } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { importOpenCodeV2ClientModule, resolveOpenCodeV2ClientEntry } from '../../../../services/opencode/transport/OpenCodeV2ClientModule.js'
import { getOpenCodeV2DeclaredInputModalities } from '../../../../services/opencode/OpenCodeDeclaredInputModalities.js'
import { inspectOpenCodeReadSelection } from '../../../../services/opencode/compatibility/OpenCodeNativeIdentity.js'
import { canonicalizeOpenCodeProjectPath, resolveOpenCodeV2CatalogProfileScope, materializeOpenCodeV2CatalogScope } from '../../../../services/opencode/OpenCodeProfileManager.js'
import { resolveClaudeMultimodelPaths } from '../../../../services/opencode/OpenCodeManagedPaths.js'
import { ensureWindowsPrivateDirectories } from '../../../../services/opencode/profile/OpenCodePrivateDirectories.js'
import { createOpenCodeV2ExecutionReceipt } from '../../../../services/opencode/profile/OpenCodeV2ExecutionReceipt.js'
import { acquireOpenCodeV2CatalogLease, requireExecutionEndpoint, registerExecutionDisposer } from '../../../../services/opencode/host/OpenCodeV2ExecutionHost.js'
import type { CatalogExecutionProfile } from '../../../../services/opencode/host/OpenCodeV2ExecutionBinding.js'
import { executionAssert, executionHash, executionRecord, type ExecutionAuthority } from '../../../../services/opencode/execution/OpenCodeV2ExecutionContracts.js'
import { OpenCodeV2ProviderWire as ProviderWire } from '../../../../services/opencode/transport/OpenCodeV2ProviderWire.js'
import { type OpenCodeAuthCredential, readOpenCodeAuthCredential, upsertOpenCodeApiAuthCredential, upsertOpenCodeAuthCredential, removeOpenCodeAuthCredential } from '../../../../services/opencode/OpenCodeAuthStore.js'
import { withOpenCodeAuthCoordinationLock } from '../../../../services/opencode/OpenCodeAuthCoordinationLock.js'
import { inspectOpenCodeV2SourceAvailability, createOpenCodeV2OwnedProfileEnvironment } from '../../../../services/opencode/bridge/OpenCodeV2LaunchPlan.js'
import { resolveOpenCodeV2ExecutionProbe } from '../../../../services/opencode/bridge/OpenCodeV2ExecutionProbe.js'
import { parseOpenCodeExecutionProof } from '../../../../services/opencode/OpenCodeExecutionProof.js'
import type { OpenCodeExecutionProof } from '../../../../services/opencode/types.js'
import type { BridgeEnvelope } from '../../../../services/opencode/bridge/OpenCodeBridgeProtocol.js'
import type { ConnectProviderInput, LoadProviderModelsInput, TestProviderModelInput, ProviderConnection, RuntimeProviderModel, RuntimeProviderModelsView, ProviderModelTestResult, ProviderManagementResult, ProviderSetupForm } from '../../domain/types.js'
import { OPENCODE_V2_NATIVE_KEY_OPTION_ID, openCodeV2KeyIntegration, openCodeV2ProviderConnectionsDirectory } from '../../../../services/opencode/catalog/OpenCodeV2KeyIntegrations.js'
import type { OpenCodeV2Pin } from '../../../../services/opencode/compatibility/OpenCodeV2Registry.js'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const text = (value: unknown): string => { executionAssert(typeof value === 'string' && value.length > 0, 'provider_response_invalid'); return value }
const resultError = (code: 'auth-failed' | 'runtime-unhealthy' | 'unsupported-auth-method', message: string) => ({ ok: false as const, error: { code, message, recoverable: true } })
export async function selectedProviderUsesOpenCodeV2(): Promise<boolean> {
  return (await selectedOpenCodeV2Version()) !== null
}
export async function selectedOpenCodeV2Version(): Promise<OpenCodeV2Pin | null> {
  const { policy } = await inspectOpenCodeReadSelection()
  return policy.generation === 'v2' ? policy.version : null
}


async function catalog<T>(input: { providerId: string; projectPath?: string | null }, use: (value: {
  authority: ExecutionAuthority; profile: CatalogExecutionProfile; authPath: string; preferredModel: string | null; scopeToken: string;
  providers(): Promise<unknown>; models(): Promise<unknown>; integration(id: string): Promise<unknown>;
  connect(id: string, key: string): Promise<void>; remove(id: string): Promise<void>
}) => Promise<T>): Promise<T> {
  const selected = await inspectOpenCodeReadSelection(); executionAssert(selected.native && selected.policy.generation === 'v2', 'provider_v2_required')
  const project = await canonicalizeOpenCodeProjectPath(input.projectPath)
  const scope = await resolveOpenCodeV2CatalogProfileScope({ projectPath: project, providerId: input.providerId })
  const managed = resolveClaudeMultimodelPaths().data, parent = path.join(managed, 'opencode/v2/provider-profiles')
  const names = ['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata']
  let root: string
  if (process.platform === 'win32') {
    // A default mkdir leaves the creator token's default owner (Administrators
    // for an elevated or UAC-less admin) on the shared V2 namespace, and every
    // later private V2 store refuses it. Create the namespace and this profile
    // with the private owner and DACL the execution host requires.
    await ensureWindowsPrivateDirectories([managed, path.join(managed, 'opencode'), path.join(managed, 'opencode', 'v2'), parent])
    root = path.join(await realpath(parent), `catalog-${randomUUID()}`)
    await ensureWindowsPrivateDirectories([root, ...names.map(name => path.join(root, name)),
      path.join(root, 'config', 'opencode'), path.join(root, 'data', 'opencode')], [root])
  } else {
    await mkdir(parent, { recursive: true, mode: 0o700 })
    root = await realpath(await mkdtemp(path.join(parent, 'catalog-')))
    for (const name of names) await mkdir(path.join(root, name), { mode: 0o700 })
  }
  const directory = path.join(root, 'config/opencode'), data = path.join(root, 'data/opencode')
  if (process.platform !== 'win32') { await mkdir(directory, { mode: 0o700 }); await mkdir(data, { mode: 0o700 }) }
  const imported = await materializeOpenCodeV2CatalogScope(scope, project, path.join(data, 'auth.json'))
  const provider = { ...(imported.provider.package ? { package: imported.provider.package } : {}),
    ...(imported.provider.baseURL ? { settings: { baseURL: imported.provider.baseURL } } : {}), ...(imported.provider.models ? { models: imported.provider.models } : {}) }
  const content = JSON.stringify({ update: 'disable', share: 'disabled', snapshots: false, warming: false, plugins: [], providers: { [input.providerId]: provider } })
  await writeFile(path.join(directory, 'opencode.json'), content, { flag: 'wx', mode: 0o600 })
  const env = createOpenCodeV2OwnedProfileEnvironment(root)
  env.OPENCODE_CONFIG_DIR = directory
  const profile: CatalogExecutionProfile = { epoch: randomUUID(), root, directory: project, databasePath: path.join(data, 'opencode.db'), env,
    envSha256: executionHash(env), config: { directory, content, sha256: createHash('sha256').update(content).digest('hex') }, selection: { purpose: 'catalog' } }
  const native = await createOpenCodeV2ExecutionReceipt(sourceRoot, selected.native)
  const nonce = randomUUID(), deadline = Date.now() + 240_000
  const lease = await acquireOpenCodeV2CatalogLease(native, profile, { teamId: `catalog-${nonce}`, runId: nonce, laneId: 'provider-catalog', memberId: input.providerId, deadline })
  const wire = new ProviderWire(lease.authority, deadline), endpoint = requireExecutionEndpoint(lease.authority)
  const unregister = registerExecutionDisposer(lease.authority, () => wire.dispose())
  try {
    const location = { directory: project }
    const selected = await importOpenCodeV2ClientModule(lease.authority.pin, await resolveOpenCodeV2ClientEntry(lease.authority.pin))
    const sdk = selected.wire === 'floor' ? selected.module.OpenCode.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch })
      : selected.module.OpenCode.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch })
    return await use({ authority: lease.authority, profile, authPath: imported.authPath, preferredModel: imported.preferredModel, scopeToken: scope.scopeToken,
      providers: () => sdk.provider.list({ location }), models: () => sdk.model.list({ location }), integration: integrationID => sdk.integration.get({ location, integrationID }),
      connect: (integrationID, key) => sdk.integration.connect.key({ location, integrationID, key }),
      remove: credentialID => selected.wire === 'floor'
        ? selected.module.OpenCode.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch }).credential.remove({ location, credentialID })
        : selected.module.OpenCode.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch }).credential.remove({ credentialID }) })
  } finally { await retireOpenCodeV2CatalogOwner(wire, lease, unregister) }
}

function scopedRows(value: unknown, directory: string): Record<string, unknown>[] {
  const response = executionRecord(value)
  executionAssert(executionRecord(response.location).directory === directory && Array.isArray(response.data), 'provider_catalog_location_changed')
  return response.data.map(executionRecord)
}
function scopedIntegration(value: unknown, directory: string, integrationID: string) {
  const response = executionRecord(value), info = executionRecord(response.data)
  executionAssert(executionRecord(response.location).directory === directory && info.id === integrationID && Array.isArray(info.connections) && Array.isArray(info.methods), 'provider_integration_changed')
  return info
}
export function openCodeV2ConnectionIDs(info: Record<string, unknown>): string[] {
  executionAssert(Array.isArray(info.connections), 'provider_integration_changed')
  const ids = info.connections.map(executionRecord).filter(value => value.type === 'credential').map(value => text(value.id))
  executionAssert(new Set(ids).size === ids.length && ids.every(id => /^cred_[A-Za-z0-9]+$/.test(id)), 'provider_credential_identity_changed')
  return ids
}
export function requireOpenCodeV2OwnedConnection(before: Record<string, unknown>, after: Record<string, unknown>, integrationID: string): string {
  executionAssert(before.id === integrationID && after.id === integrationID && Array.isArray(before.connections) && before.connections.length === 0, 'provider_existing_credentials_unsupported')
  const ids = openCodeV2ConnectionIDs(after)
  executionAssert(ids.length === 1 && Array.isArray(after.connections) && after.connections.length === 1, 'provider_owned_connection_unknown')
  // Both pinned primary implementations order active credential first. No DTO active flag is invented.
  executionAssert(executionRecord(after.connections[0]).id === ids[0], 'provider_active_connection_changed')
  return ids[0]!
}
async function executionProof(project: string, selectedModel: string, onNativeStart?: () => void, run = true) {
  const envelope: BridgeEnvelope = { schemaVersion: 1, requestId: randomUUID(), command: 'opencode.readiness', cwd: project,
    startedAt: new Date().toISOString(), timeoutMs: 150_000, body: { projectPath: project, selectedModel, effort: 'default', requireExecutionProbe: true } }
  const selection = await inspectOpenCodeV2SourceAvailability(envelope)
  onNativeStart?.()
  return resolveOpenCodeV2ExecutionProbe(envelope, selection, run)
}

export async function connectOpenCodeV2Provider(input: ConnectProviderInput): Promise<ProviderManagementResult<ProviderConnection>> {
  if (input.method !== 'api') return resultError('unsupported-auth-method', 'This V2 source path supports API-key provider connection only.')
  const apiKey = input.apiKey?.trim()
  if (!apiKey) return resultError('auth-failed', 'API key is required.')
  if (input.metadata && Object.keys(input.metadata).length || input.authMethodIndex !== undefined && input.authMethodIndex !== null ||
    input.authOptionId && !(input.authOptionId === OPENCODE_V2_NATIVE_KEY_OPTION_ID && openCodeV2KeyIntegration(input.providerId)))
    return resultError('unsupported-auth-method', 'This V2 source path requires the native key method without an additional setup form.')
  let retainUnknown = false, marker: string | undefined, acceptedProof: OpenCodeExecutionProof | undefined
  let phase = 'catalog-acquisition'
  try {
    const connected = await catalog<ProviderConnection>(input, async owner => withOpenCodeAuthCoordinationLock({ authPath: owner.authPath, timeoutMs: 240_000, operation: async () => {
      phase = 'provider-catalog-readback'
      const provider = scopedRows(await owner.providers(), owner.authority.directory).find(row => row.id === input.providerId)
      executionAssert(provider, 'provider_missing')
      const integrationID = text(provider.integrationID), before = scopedIntegration(await owner.integration(integrationID), owner.authority.directory, integrationID)
      executionAssert(Array.isArray(before.methods) && before.methods.some(value => executionRecord(value).type === 'key' && executionRecord(value).form === undefined), 'provider_key_method_unsupported')
      const previous = await readOpenCodeAuthCredential({ authPath: owner.authPath, providerId: input.providerId })
      const published = { type: 'api' as const, key: apiKey }
      const directory = openCodeV2ProviderConnectionsDirectory()
      // Missing V2 ancestors are created privately on Windows, never with a default owner.
      if (process.platform === 'win32') await ensureWindowsPrivateDirectories([directory])
      else await mkdir(directory, { recursive: true, mode: 0o700 })
      marker = path.join(directory, executionHash({ project: owner.authority.directory, provider: input.providerId, key: apiKey }) + '.json')
      try {
        const stat = await lstat(marker); executionAssert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size < 64 * 1024, 'provider_intent_foreign')
        const saved = executionRecord(JSON.parse(await readFile(marker, 'utf8')))
        if (saved.state === 'complete' && isDeepStrictEqual(previous, published)) {
          const connection = parseSavedConnection(saved.connection), originalProof = parseOpenCodeExecutionProof(saved.proof)
          executionAssert(connection.providerId === input.providerId && originalProof, 'provider_saved_proof_changed')
          phase = 'original-proof-readback'
          const current = await executionProof(owner.authority.directory, text(connection.verifiedModelId), undefined, false)
          executionAssert(current.state === 'available' && current.proof && executionHash(current.proof) === executionHash(originalProof) &&
            current.proof.opencodeVersion === owner.authority.pin && current.proof.binaryPath === owner.authority.selectedCli.path && Date.parse(current.proof.expiresAt) > Date.now(), 'provider_saved_proof_unqualified')
          acceptedProof = current.proof
          phase = 'catalog-retirement'
          return connection
        }
        retainUnknown = true; throw new Error('provider_original_connect_unknown')
      } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
      executionAssert(Array.isArray(before.connections) && before.connections.length === 0, 'provider_existing_credentials_unsupported')
      executionAssert((await resolveOpenCodeV2CatalogProfileScope({ projectPath: owner.authority.directory, providerId: input.providerId })).scopeToken === owner.scopeToken, 'provider_catalog_scope_changed')
      phase = 'credential-intent-publication'
      await writeFile(marker, JSON.stringify({ state: 'pending', providerId: input.providerId, project: owner.authority.directory, profileRoot: owner.profile.root, integrationID }), { flag: 'wx', mode: 0o600 })
      retainUnknown = true // Any uncertain connect retains the original marker; a subsequent caller never repeats POST.
      phase = 'native-key-connect'
      await owner.connect(integrationID, apiKey)
      phase = 'native-key-readback'
      const after = scopedIntegration(await owner.integration(integrationID), owner.authority.directory, integrationID)
      const credentialID = requireOpenCodeV2OwnedConnection(before, after, integrationID)
      const mirror = { authPath: owner.authPath, providerId: input.providerId }
      executionAssert(isDeepStrictEqual(await readOpenCodeAuthCredential(mirror), previous), 'provider_auth_publication_changed')
      executionAssert((await resolveOpenCodeV2CatalogProfileScope({ projectPath: owner.authority.directory, providerId: input.providerId })).scopeToken === owner.scopeToken, 'provider_catalog_scope_changed')
      phase = 'selected-auth-publication'
      await upsertOpenCodeApiAuthCredential({ ...mirror, apiKey })
      executionAssert(isDeepStrictEqual(await readOpenCodeAuthCredential(mirror), published), 'provider_auth_publication_unknown')
      phase = 'selected-model-catalog'
      const models = scopedRows(await owner.models(), owner.authority.directory).filter(row => row.providerID === input.providerId && row.enabled !== false)
      const preferred = models.find(row => `${input.providerId}/${row.id}` === owner.preferredModel)
      const chosen = preferred ?? models.find(row => executionRecord(row.capabilities).tools === true)
      executionAssert(chosen, 'provider_selected_model_missing')
      const selectedModel = `${input.providerId}/${text(chosen.id)}`
      let executionStarted = false
      try {
        phase = 'selected-model-execution-proof'
        const proof = await executionProof(owner.authority.directory, selectedModel, () => { executionStarted = true })
        if (!proof.proof || proof.state !== 'available') throw new Error('provider_original_execution_pending')
        executionAssert(proof.proof.modelId === selectedModel && proof.proof.projectPath === owner.authority.directory, 'provider_execution_target_changed')
        acceptedProof = proof.proof
        phase = 'catalog-retirement'
        return { providerId: input.providerId, displayName: text(provider.name), state: 'connected' as const, ownership: ['managed'] as const,
          recommended: false, modelCount: models.length, defaultModelId: owner.preferredModel, authMethods: ['api'] as const, actions: [], detail: null,
          connectedAuthHint: 'api' as const, verifiedModelId: selectedModel }
      } catch (error) {
        // Pending/UNKNOWN native model work owns its original input and credential snapshot. Do not replay or invalidate it.
        if (executionStarted) throw error
        // Exact owned empty-store rollback only; never a provider-wide delete or a peer credential restoration.
        phase = 'owned-no-effect-rollback'
        await rollbackOpenCodeV2OwnedConnection({ integrationID, credentialID, published, predecessor: previous,
          readConnections: async () => scopedIntegration(await owner.integration(integrationID), owner.authority.directory, integrationID),
          remove: id => owner.remove(id), readMirror: () => readOpenCodeAuthCredential(mirror),
          restoreMirror: async predecessor => { if (predecessor) await upsertOpenCodeAuthCredential({ ...mirror, credential: predecessor }); else await removeOpenCodeAuthCredential(mirror) } })
        throw error
      }
    } }))
    // Catalog physical retirement must succeed before publishing a completed transaction receipt.
    executionAssert(marker && acceptedProof, 'provider_intent_missing')
    phase = 'completion-publication'
    await writeFile(marker, JSON.stringify({ state: 'complete', connection: connected, proof: acceptedProof }), { mode: 0o600 })
    return { ok: true, value: connected }
  } catch (error) {
    await recordOpenCodeV2ProviderFailure(phase, error, retainUnknown)
    // A refusal the user can act on (platform qualification, the Linux sandbox) is not an
    // authentication failure; name it instead of the generic text.
    const refusal = retainUnknown ? null : openCodeV2Refusal(error)
    if (refusal) return resultError('runtime-unhealthy', refusal.message)
    return resultError(retainUnknown ? 'runtime-unhealthy' : 'auth-failed', retainUnknown
      ? 'The original V2 provider connection or execution remains unresolved. No automatic reconnect or prompt retry is authorized.'
      : 'V2 provider connection could not be qualified. Existing credentials were preserved.')
  }
}

/** The native key method form for a registered V2 key integration; null for every other provider. */
export function buildOpenCodeV2KeySetupForm(providerId: string, version: OpenCodeV2Pin): ProviderSetupForm | null {
  const integration = openCodeV2KeyIntegration(providerId, version)
  if (!integration) return null
  const secret = { key: 'key' as const, label: 'API key', placeholder: null, required: true }
  return { runtimeId: 'opencode', providerId, displayName: integration.displayName, method: 'api', supported: true,
    title: `Connect ${integration.displayName}`,
    description: 'The key is connected through the selected OpenCode V2 native integration and verified with one model request.',
    submitLabel: 'Connect', disabledReason: null, source: 'opencode-auth', secret, prompts: [],
    authOptions: [{ id: OPENCODE_V2_NATIVE_KEY_OPTION_ID, method: 'api', methodIndex: null, label: 'API key', supported: true,
      disabledReason: null, secret, prompts: [] }],
    defaultAuthOptionId: OPENCODE_V2_NATIVE_KEY_OPTION_ID,
    verification: { kind: 'model-request', freeModelPreferred: false, mayUseQuotaOrBalance: true } }
}

export async function testOpenCodeV2ProviderModel(input: TestProviderModelInput): Promise<ProviderManagementResult<ProviderModelTestResult>> {
  try {
    const project = await canonicalizeOpenCodeProjectPath(input.projectPath)
    executionAssert(input.modelId.startsWith(input.providerId + '/'), 'provider_model_changed')
    const proof = await executionProof(project, input.modelId)
    const ok = proof.state === 'available' && proof.proof?.modelId === input.modelId && proof.proof.projectPath === project
    return { ok: true, value: { providerId: input.providerId, modelId: input.modelId, ok,
      availability: ok ? 'available' : 'unknown', message: ok ? 'Selected V2 model execution and physical retirement verified.' : 'Original selected-model execution is pending; no alternate input was submitted.', diagnostics: [] } }
  } catch (error) { return resultError('runtime-unhealthy', openCodeV2Refusal(error)?.message ?? 'V2 selected-model execution could not be qualified. No alternate model was tried.') }
}

export async function loadOpenCodeV2ProviderModels(input: LoadProviderModelsInput): Promise<ProviderManagementResult<RuntimeProviderModelsView>> {
  try {
    if (input.cursor) return resultError('runtime-unhealthy', 'V2 catalog cursors require a fresh bounded catalog query.')
    const value = await catalog(input, async owner => {
      let rows = scopedRows(await owner.models(), owner.authority.directory).filter(row => row.providerID === input.providerId)
      if (input.query) rows = rows.filter(row => `${row.id} ${row.name}`.toLowerCase().includes(input.query!.toLowerCase()))
      const totalCount = rows.length, limit = input.limit == null ? null : Math.max(1, Math.min(200, input.limit))
      if (limit) rows = rows.slice(0, limit)
      return { runtimeId: 'opencode' as const, providerId: input.providerId, totalCount, returnedCount: rows.length, limit, cursor: null, nextCursor: null,
        defaultModelId: owner.preferredModel, diagnostics: [], catalogState: 'fresh' as const,
        models: rows.map(row => buildOpenCodeV2RuntimeProviderModel(row, input.providerId, owner.preferredModel)) }
    })
    return { ok: true, value }
  } catch (error) { return resultError('runtime-unhealthy', openCodeV2Refusal(error)?.message ?? 'V2 native provider catalog is unavailable; no legacy CLI catalog command was invoked.') }
}

export function buildOpenCodeV2RuntimeProviderModel(row: Record<string, unknown>, providerId: string, preferredModel: string | null): RuntimeProviderModel {
  return { modelId: `${providerId}/${text(row.id)}`, providerId, displayName: text(row.name), sourceLabel: 'OpenCode V2 native catalog',
    declaredInputModalities: getOpenCodeV2DeclaredInputModalities(row.capabilities),
    free: false, default: `${providerId}/${row.id}` === preferredModel, catalogStatus: 'active',
    availability: row.enabled === false ? 'unavailable' : 'untested', accessKind: 'credentialed', routeKind: 'catalog_provider',
    proofState: 'needs_probe', requiresExecutionProof: true, accessReason: 'Selected-model execution proof is required.',
    catalogContextTokens: finiteNumber(executionRecord(row.limit).context),
    catalogOutputTokens: finiteNumber(executionRecord(row.limit).output),
    managedContextTokens: null, managedOutputTokens: null, managedUpdatedAt: null }
}

function finiteNumber(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }
function parseSavedConnection(value: unknown): ProviderConnection {
  const record = executionRecord(value)
  executionAssert(record.state === 'connected' && record.connectedAuthHint === 'api' && Array.isArray(record.ownership) && record.ownership.length === 1 && record.ownership[0] === 'managed', 'provider_saved_connection_changed')
  return { providerId: text(record.providerId), displayName: text(record.displayName), state: 'connected', ownership: ['managed'], recommended: record.recommended === true,
    modelCount: finiteNumber(record.modelCount) ?? 0, defaultModelId: record.defaultModelId === null ? null : text(record.defaultModelId), authMethods: ['api'], actions: [], detail: null,
    connectedAuthHint: 'api', verifiedModelId: text(record.verifiedModelId) }
}

/** One owned ID in an initially empty private store; never provider-wide deletion. */
export async function rollbackOpenCodeV2OwnedConnection(input: {
  integrationID: string; credentialID: string; published: OpenCodeAuthCredential; predecessor: OpenCodeAuthCredential | null;
  readConnections(): Promise<Record<string, unknown>>; remove(id: string): Promise<void>;
  readMirror(): Promise<OpenCodeAuthCredential | null>; restoreMirror(predecessor: OpenCodeAuthCredential | null): Promise<void>
}): Promise<void> {
  const current = await input.readConnections()
  executionAssert(current.id === input.integrationID && isDeepStrictEqual(openCodeV2ConnectionIDs(current), [input.credentialID]), 'provider_rollback_peer_changed')
  executionAssert(isDeepStrictEqual(await input.readMirror(), input.published), 'provider_rollback_publication_changed')
  await input.remove(input.credentialID)
  const after = await input.readConnections()
  executionAssert(after.id === input.integrationID && openCodeV2ConnectionIDs(after).length === 0, 'provider_rollback_unknown')
  executionAssert(isDeepStrictEqual(await input.readMirror(), input.published), 'provider_rollback_publication_changed')
  await input.restoreMirror(input.predecessor)
  executionAssert(isDeepStrictEqual(await input.readMirror(), input.predecessor), 'provider_rollback_publication_unknown')
}

export async function retireOpenCodeV2CatalogOwner(wire: { dispose(): Promise<void> }, lease: { close(): Promise<unknown> }, unregister: () => void): Promise<void> {
  let transportError: unknown, retirementError: unknown
  try { await wire.dispose() } catch (error) { transportError = error }
  finally {
    unregister()
    try { await lease.close() } catch (error) { retirementError = error }
  }
  if (transportError || retirementError) throw new AggregateError([transportError, retirementError].filter(Boolean), 'provider_physical_cleanup_unknown')
}
