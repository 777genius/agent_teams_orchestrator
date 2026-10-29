import { openCodeV2EngineVersion } from '../../../../services/opencode/compatibility/OpenCodeV2Registry.js'
import { recordOpenCodeV2ProviderFailure } from '../../../../services/opencode/execution/OpenCodeV2Diagnostics.js'
import { openCodeV2Refusal } from '../../../../services/opencode/execution/OpenCodeV2RefusalReason.js'
export { recordOpenCodeV2ProviderFailure } from '../../../../services/opencode/execution/OpenCodeV2Diagnostics.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile, lstat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { importOpenCodeV2ClientModule, resolveOpenCodeV2ClientEntry } from '../../../../services/opencode/transport/OpenCodeV2ClientModule.js'
import { getOpenCodeV2DeclaredInputModalities } from '../../../../services/opencode/OpenCodeDeclaredInputModalities.js'
import { readIntegration } from '../../../../services/opencode/catalog/OpenCodeV2ReadStatus.js'
import { isOpenCodeV2AnonymousProvider, isOpenCodeV2ModelFree } from '../../../../services/opencode/catalog/OpenCodeV2ModelPricing.js'
import { inspectOpenCodeReadSelection } from '../../../../services/opencode/compatibility/OpenCodeNativeIdentity.js'
export { inspectOpenCodeReadSelection } from '../../../../services/opencode/compatibility/OpenCodeNativeIdentity.js'
import { canonicalizeOpenCodeProjectPath, resolveOpenCodeV2CatalogProfileScope, materializeOpenCodeV2CatalogScope } from '../../../../services/opencode/OpenCodeProfileManager.js'
import { resolveClaudeMultimodelPaths } from '../../../../services/opencode/OpenCodeManagedPaths.js'
import { createOpenCodeV2ExecutionReceipt } from '../../../../services/opencode/profile/OpenCodeV2ExecutionReceipt.js'
import { acquireOpenCodeV2CatalogLease, requireExecutionEndpoint, registerExecutionDisposer } from '../../../../services/opencode/host/OpenCodeV2ExecutionHost.js'
import type { CatalogExecutionProfile, ValidatedExecutionNative } from '../../../../services/opencode/host/OpenCodeV2ExecutionBinding.js'
import { executionAssert, executionHash, executionRecord, openCodeV2RunInitializationMs, type ExecutionAuthority } from '../../../../services/opencode/execution/OpenCodeV2ExecutionContracts.js'
import { OpenCodeV2ProviderWire as ProviderWire } from '../../../../services/opencode/transport/OpenCodeV2ProviderWire.js'
import { type OpenCodeAuthCredential, readOpenCodeAuthCredential, upsertOpenCodeApiAuthCredential } from '../../../../services/opencode/OpenCodeAuthStore.js'
import { withOpenCodeAuthCoordinationLock } from '../../../../services/opencode/OpenCodeAuthCoordinationLock.js'
import { inspectOpenCodeV2SourceAvailability, createOpenCodeV2OwnedProfileEnvironment } from '../../../../services/opencode/bridge/OpenCodeV2LaunchPlan.js'
import { resolveOpenCodeV2ExecutionProbe, type OpenCodeV2ProbeIntent } from '../../../../services/opencode/bridge/OpenCodeV2ExecutionProbe.js'
import { assertLegacyOpenCodeV2ProbePreEffect, ensureOpenCodeV2ProbeStore } from '../../../../services/opencode/bridge/OpenCodeV2ProbeStore.js'
import { prepareOpenCodeV2ConnectVerification, readRetiredOpenCodeV2CatalogProfile,
  readOpenCodeV2ConnectIntent, writeOpenCodeV2ConnectIntent, type OpenCodeV2ConnectIntent } from './OpenCodeV2ProviderConnectIntent.js'
import { parseOpenCodeExecutionProof } from '../../../../services/opencode/OpenCodeExecutionProof.js'
import { normalizeOpenCodeProjectIdentity } from '../../../../services/opencode/OpenCodeProjectIdentity.js'
import { pageOpenCodeV2ProviderModels } from './OpenCodeV2ModelPagination.js'
import type { OpenCodeExecutionProof } from '../../../../services/opencode/types.js'
import type { BridgeEnvelope } from '../../../../services/opencode/bridge/OpenCodeBridgeProtocol.js'
import type { ConnectProviderInput, LoadProviderModelsInput, LoadProviderSetupFormInput, TestProviderModelInput, ProviderConnection, RuntimeProviderModel, RuntimeProviderModelsView, ProviderModelTestResult, ProviderManagementResult, ProviderSetupForm } from '../../domain/types.js'
import { OPENCODE_V2_NATIVE_KEY_OPTION_ID, openCodeV2KeyIntegration, openCodeV2ProviderConnectionsDirectory } from '../../../../services/opencode/catalog/OpenCodeV2KeyIntegrations.js'
import type { OpenCodeV2Pin } from '../../../../services/opencode/compatibility/OpenCodeV2Registry.js'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const text = (value: unknown): string => { executionAssert(typeof value === 'string' && value.length > 0, 'provider_response_invalid'); return value }
const resultError = (code: 'auth-failed' | 'runtime-unhealthy' | 'unsupported-auth-method', message: string) => ({ ok: false as const, error: { code, message, recoverable: true } })
/** A provider intent marker is a small regular file of this user. POSIX proves that by owner and
 * mode bits; Windows reports neither (no uid, mode 0o666) and its files inherit the user's ACL. */
export function isOwnedProviderIntentMarker(stat: Pick<Stats, 'isFile' | 'isSymbolicLink' | 'uid' | 'mode' | 'size'>,
  platform: NodeJS.Platform = process.platform): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.size < 64 * 1024 &&
    (platform === 'win32' || stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0)
}

export async function selectedProviderUsesOpenCodeV2(): Promise<boolean> {
  return (await selectedOpenCodeV2Version()) !== null
}
export async function selectedOpenCodeV2Version(): Promise<OpenCodeV2Pin | null> {
  const { policy, native } = await inspectOpenCodeReadSelection()
  return policy.generation === 'v2' && native ? openCodeV2EngineVersion(native) : null
}


type CatalogOwner = {
  native: ValidatedExecutionNative;
  authority: ExecutionAuthority; profile: CatalogExecutionProfile; authPath: string; preferredModel: string | null; scopeToken: string;
  providers(): Promise<unknown>; models(): Promise<unknown>; integration(id: string): Promise<unknown>;
  connect(id: string, key: string): Promise<void>; remove(id: string): Promise<void>
}
async function catalog<T>(input: { providerId: string; projectPath?: string | null }, use: (value: CatalogOwner) => Promise<T>,
  selectedRead?: Awaited<ReturnType<typeof inspectOpenCodeReadSelection>>, options?: { includeSelectedApiKey?: boolean }): Promise<T> {
  // Reuse this request's generation decision; receipt/owner/child checks still revalidate the bytes.
  const selected = selectedRead ?? await inspectOpenCodeReadSelection(); executionAssert(selected.native && selected.policy.generation === 'v2', 'provider_v2_required')
  const project = await canonicalizeOpenCodeProjectPath(input.projectPath)
  const scope = await resolveOpenCodeV2CatalogProfileScope({ projectPath: project, providerId: input.providerId })
  const parent = path.join(resolveClaudeMultimodelPaths().data, 'opencode/v2/provider-profiles'); await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await realpath(await mkdtemp(path.join(parent, 'catalog-')))
  let imported: Awaited<ReturnType<typeof materializeOpenCodeV2CatalogScope>>
  let profile: CatalogExecutionProfile
  let native: ValidatedExecutionNative
  try {
    for (const name of ['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata']) await mkdir(path.join(root, name), { mode: 0o700 })
    const directory = path.join(root, 'config/opencode'), data = path.join(root, 'data/opencode'); await mkdir(directory, { mode: 0o700 }); await mkdir(data, { mode: 0o700 })
    imported = await materializeOpenCodeV2CatalogScope(scope, project, path.join(data, 'auth.json'), options)
    const provider = { ...(imported.provider.package ? { package: imported.provider.package } : {}),
      ...(imported.provider.baseURL || imported.provider.apiKey ? { settings: {
        ...(imported.provider.baseURL ? { baseURL: imported.provider.baseURL } : {}),
        ...(imported.provider.apiKey ? { apiKey: imported.provider.apiKey } : {}),
      } } : {}), ...(imported.provider.models ? { models: imported.provider.models } : {}) }
    const content = JSON.stringify({ update: 'disable', share: 'disabled', snapshots: false, warming: false, plugins: [], providers: { [input.providerId]: provider } })
    await writeFile(path.join(directory, 'opencode.json'), content, { flag: 'wx', mode: 0o600 })
    const env = createOpenCodeV2OwnedProfileEnvironment(root)
    env.OPENCODE_CONFIG_DIR = directory
    profile = { epoch: randomUUID(), root, directory: project, databasePath: path.join(data, 'opencode.db'), env,
      envSha256: executionHash(env), config: { directory, content, sha256: createHash('sha256').update(content).digest('hex') }, selection: { purpose: 'catalog' } }
    native = await createOpenCodeV2ExecutionReceipt(sourceRoot, selected.native)
  } catch (error) {
    // No lease acquisition has begun, so no native owner can use these sealed
    // key/config files. Once acquisition starts, its failure path retains custody.
    try { await rm(root, { recursive: true, force: true }) }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'provider_catalog_prelease_cleanup_unknown', { cause: error })
    }
    throw error
  }
  const nonce = randomUUID(), deadline = Date.now() + 240_000
  const lease = await acquireOpenCodeV2CatalogLease(native, profile, { teamId: `catalog-${nonce}`, runId: nonce, laneId: 'provider-catalog', memberId: input.providerId, deadline })
  const wire = new ProviderWire(lease.authority, deadline), endpoint = requireExecutionEndpoint(lease.authority)
  const unregister = registerExecutionDisposer(lease.authority, () => wire.dispose())
  try {
    const location = { directory: project }
    const selected = await importOpenCodeV2ClientModule(lease.authority.pin, await resolveOpenCodeV2ClientEntry(lease.authority.pin, undefined, native.graph.delivery))
    const sdk = selected.wire === 'floor' ? selected.module.OpenCode.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch })
      : selected.module.OpenCode.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch })
    return await use({ native, authority: lease.authority, profile, authPath: imported.authPath, preferredModel: imported.preferredModel, scopeToken: scope.scopeToken,
      providers: () => sdk.provider.list({ location }), models: () => sdk.model.list({ location }), integration: integrationID => sdk.integration.get({ location, integrationID }),
      connect: (integrationID, key) => sdk.integration.connect.key({ location, integrationID, key }),
      remove: credentialID => selected.wire === 'floor'
        ? selected.module.OpenCode.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch }).credential.remove({ location, credentialID })
        : selected.module.OpenCode.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch }).credential.remove({ credentialID }) })
  } finally { await retireOpenCodeV2CatalogOwner(wire, lease, unregister) }
}

/** Reopen only the retired original catalog for GET readback, never key connect/remove. */
async function readOriginalConnection(owner: CatalogOwner, saved: Record<string, unknown>, providerId: string): Promise<{ credentialID: string; models: Record<string, unknown>[] }> {
  const original = await readRetiredOpenCodeV2CatalogProfile(await realpath(resolveClaudeMultimodelPaths().data),
    text(saved.profileRoot), providerId, owner.native.graph.sha256)
  const env = createOpenCodeV2OwnedProfileEnvironment(original.root); env.OPENCODE_CONFIG_DIR = original.directory
  const profile: CatalogExecutionProfile = { epoch: randomUUID(), root: original.root, directory: owner.authority.directory,
    databasePath: original.databasePath, env, envSha256: executionHash(env), selection: { purpose: 'catalog' },
    config: { directory: original.directory, content: original.content, sha256: createHash('sha256').update(original.content).digest('hex') } }
  const nonce = randomUUID(), deadline = Date.now() + 240_000
  const lease = await acquireOpenCodeV2CatalogLease(owner.native, profile, { teamId: `catalog-readback-${nonce}`, runId: nonce,
    laneId: 'provider-catalog', memberId: providerId, deadline })
  const wire = new ProviderWire(lease.authority, deadline), endpoint = requireExecutionEndpoint(lease.authority)
  const unregister = registerExecutionDisposer(lease.authority, () => wire.dispose())
  try {
    const selected = await importOpenCodeV2ClientModule(lease.authority.pin, await resolveOpenCodeV2ClientEntry(lease.authority.pin, undefined, owner.native.graph.delivery))
    const sdk = selected.module.OpenCode.make({ baseUrl: endpoint.baseUrl, fetch: wire.fetch })
    const info = scopedIntegration(await sdk.integration.get({ location: { directory: owner.authority.directory },
      integrationID: text(saved.integrationID) }), owner.authority.directory, text(saved.integrationID))
    const ids = openCodeV2ConnectionIDs(info)
    executionAssert(ids.length === 1 && (info.connections as unknown[]).length === 1, 'provider_owned_connection_unknown')
    return { credentialID: ids[0]!, models: scopedRows(await sdk.model.list({ location: { directory: owner.authority.directory } }), owner.authority.directory) }
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
async function executionProof(project: string, selectedModel: string, run = true, verification?: {
  native: { path: string; sha256: string; version: string }; sourceKey?: string; probe?: OpenCodeV2ProbeIntent;
  prepared(sourceKey: string): Promise<void>; persisted(probe: OpenCodeV2ProbeIntent): Promise<void>;
}) {
  const envelope: BridgeEnvelope = { schemaVersion: 1, requestId: randomUUID(), command: 'opencode.readiness', cwd: project,
    startedAt: new Date().toISOString(), timeoutMs: Math.max(150_000, openCodeV2RunInitializationMs(process.platform)), body: { projectPath: project, selectedModel, effort: 'default', requireExecutionProbe: true } }
  const selection = await inspectOpenCodeV2SourceAvailability(envelope)
  if (verification) executionAssert(executionHash(verification.native) === executionHash({
    path: selection.native.executablePath, sha256: selection.native.executableSha256, version: selection.native.version }), 'provider_execution_target_changed')
  return resolveOpenCodeV2ExecutionProbe(envelope, selection, run, verification ? {
    requireExisting: verification.probe,
    onPrepared: async sourceKey => {
      executionAssert(!verification.sourceKey || verification.sourceKey === sourceKey, 'provider_execution_target_changed')
      await verification.prepared(sourceKey)
    }, onIntentPersisted: verification.persisted,
  } : {})
}

/** Only the probe's exact settled terminal reasons distinguish failure from cleanup uncertainty. */
export function openCodeV2ConnectProofFailureCode(state: string, reason: string | null): string {
  return state === 'failed' && (reason === 'native_execution_failed' || reason === 'native_execution_cancelled')
    ? 'provider_original_execution_failed' : 'provider_original_execution_pending'
}

export function openCodeV2ConnectFailureMessage(error: unknown, retainedOriginal: boolean): string {
  if (retainedOriginal && error instanceof Error && error.message === 'provider_original_execution_failed') {
    return 'The selected-model verification failed. Check provider access, limits and connection diagnostics. The original attempt was retained; no automatic reconnect or prompt retry was performed.'
  }
  return retainedOriginal
    ? 'The original V2 provider connection or execution remains unresolved. No automatic reconnect or prompt retry is authorized.'
    : 'V2 provider connection could not be qualified. Existing credentials were preserved.'
}

export async function connectOpenCodeV2Provider(input: ConnectProviderInput): Promise<ProviderManagementResult<ProviderConnection>> {
  if (input.method !== 'api') return resultError('unsupported-auth-method', 'This V2 source path supports API-key provider connection only.')
  const apiKey = input.apiKey?.trim()
  if (!apiKey) return resultError('auth-failed', 'API key is required.')
  if (input.metadata && Object.keys(input.metadata).length || input.authMethodIndex !== undefined && input.authMethodIndex !== null ||
    input.authOptionId && input.authOptionId !== OPENCODE_V2_NATIVE_KEY_OPTION_ID)
    return resultError('unsupported-auth-method', 'This V2 source path requires the native key method without an additional setup form.')
  let retainUnknown = false, marker: string | undefined, acceptedProof: OpenCodeExecutionProof | undefined
  let pendingIntent: OpenCodeV2ConnectIntent | undefined, originalIntent: Record<string, unknown> | undefined
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
      const requestedDirectory = openCodeV2ProviderConnectionsDirectory(); await mkdir(requestedDirectory, { recursive: true, mode: 0o700 })
      const directory = await realpath(requestedDirectory), intentDirectory = await lstat(requestedDirectory)
      executionAssert(intentDirectory.isDirectory() && !intentDirectory.isSymbolicLink() &&
        (process.platform === 'win32' || directory === requestedDirectory), 'provider_intent_foreign')
      marker = path.join(directory, executionHash({ project: owner.authority.directory, provider: input.providerId, key: apiKey }) + '.json')
      const finishVerification = async (saved: Record<string, unknown>, originalConnection: () => Promise<{ credentialID: string; models?: Record<string, unknown>[] }>): Promise<ProviderConnection> => {
        executionAssert(saved.state === 'pending' && saved.providerId === input.providerId && saved.project === owner.authority.directory &&
          saved.integrationID === integrationID, 'provider_original_intent_changed')
        executionAssert(isDeepStrictEqual(await readOpenCodeAuthCredential({ authPath: owner.authPath, providerId: input.providerId }), published), 'provider_auth_publication_changed')
        phase = 'selected-model-catalog'
        const original = await originalConnection()
        const models = (original.models ?? scopedRows(await owner.models(), owner.authority.directory))
          .filter(row => row.providerID === input.providerId && row.enabled !== false)
        const chosen = models.find(row => `${input.providerId}/${row.id}` === owner.preferredModel) ??
          models.find(row => executionRecord(row.capabilities).tools === true)
        executionAssert(chosen, 'provider_selected_model_missing')
        pendingIntent = await prepareOpenCodeV2ConnectVerification({ saved, providerId: input.providerId,
          project: owner.authority.directory, integrationID, mirrorIdentity: executionHash(published), native: { ...owner.authority.selectedCli },
          selectedModel: `${input.providerId}/${text(chosen.id)}`, readOriginalCredential: async () => original.credentialID,
          proveLegacyPreEffect: () => assertLegacyOpenCodeV2ProbePreEffect(path.resolve(resolveClaudeMultimodelPaths().data), marker!, saved) })
        await writeOpenCodeV2ConnectIntent(marker!, pendingIntent)
        const target = pendingIntent.verification!; phase = 'selected-model-execution-proof'
        const proof = await executionProof(owner.authority.directory, target.modelId, true, { ...target,
          prepared: async sourceKey => {
            pendingIntent = { ...pendingIntent!, verification: { ...pendingIntent!.verification!, sourceKey } }
            await writeOpenCodeV2ConnectIntent(marker!, pendingIntent)
          }, persisted: async probe => {
            if (pendingIntent!.verification!.probe) executionAssert(executionHash(pendingIntent!.verification!.probe) === executionHash(probe), 'provider_original_execution_changed')
            pendingIntent = { ...pendingIntent!, phase: 'probe-owned', verification: { ...pendingIntent!.verification!, probe } }
            await writeOpenCodeV2ConnectIntent(marker!, pendingIntent)
          } })
        executionAssert(proof.state === 'available' && proof.proof, openCodeV2ConnectProofFailureCode(proof.state, proof.reason))
        executionAssert(proof.proof.modelId === target.modelId && proof.proof.projectPath === normalizeOpenCodeProjectIdentity(owner.authority.directory), 'provider_execution_target_changed')
        executionAssert(isDeepStrictEqual(await readOpenCodeAuthCredential({ authPath: owner.authPath, providerId: input.providerId }), published), 'provider_auth_publication_changed')
        acceptedProof = proof.proof; phase = 'catalog-retirement'
        return { providerId: input.providerId, displayName: text(provider.name), state: 'connected', ownership: ['managed'],
          recommended: false, modelCount: models.length, defaultModelId: owner.preferredModel, authMethods: ['api'], actions: [], detail: null,
          connectedAuthHint: 'api', verifiedModelId: target.modelId }
      }
      const saved = await readOpenCodeV2ConnectIntent(marker)
      if (saved) {
        originalIntent = saved
        if (saved.state === 'complete' && isDeepStrictEqual(previous, published)) {
          const connection = parseSavedConnection(saved.connection), originalProof = parseOpenCodeExecutionProof(saved.proof)
          executionAssert(connection.providerId === input.providerId && originalProof, 'provider_saved_proof_changed')
          phase = 'original-proof-readback'
          const current = await executionProof(owner.authority.directory, text(connection.verifiedModelId), false)
          executionAssert(current.state === 'available' && current.proof && executionHash(current.proof) === executionHash(originalProof) &&
            current.proof.opencodeVersion === owner.authority.selectedCli.version && current.proof.binaryPath === owner.authority.selectedCli.path && Date.parse(current.proof.expiresAt) > Date.now(), 'provider_saved_proof_unqualified')
          acceptedProof = current.proof
          phase = 'catalog-retirement'
          return connection
        }
        retainUnknown = true
        phase = 'original-credential-readback'
        return await finishVerification(saved, () => readOriginalConnection(owner, saved, input.providerId))
      }
      executionAssert(Array.isArray(before.connections) && before.connections.length === 0, 'provider_existing_credentials_unsupported')
      executionAssert((await resolveOpenCodeV2CatalogProfileScope({ projectPath: owner.authority.directory, providerId: input.providerId })).scopeToken === owner.scopeToken, 'provider_catalog_scope_changed')
      await ensureOpenCodeV2ProbeStore(path.resolve(resolveClaudeMultimodelPaths().data))
      phase = 'credential-intent-publication'
      pendingIntent = { schemaVersion: 2, state: 'pending', phase: 'credential-intent', providerId: input.providerId,
        project: owner.authority.directory, profileRoot: owner.profile.root, integrationID }
      await writeOpenCodeV2ConnectIntent(marker, pendingIntent, true)
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
      pendingIntent = { ...pendingIntent, phase: 'credential-published', credentialID, mirrorIdentity: executionHash(published) }
      await writeOpenCodeV2ConnectIntent(marker, pendingIntent)
      return await finishVerification(pendingIntent, async () => ({ credentialID }))
    } }))
    // Catalog physical retirement must succeed before publishing a completed transaction receipt.
    executionAssert(marker && acceptedProof, 'provider_intent_missing')
    phase = 'completion-publication'
    await writeOpenCodeV2ConnectIntent(marker, { ...originalIntent, ...pendingIntent, state: 'complete', connection: connected, proof: acceptedProof })
    return { ok: true, value: connected }
  } catch (error) {
    await recordOpenCodeV2ProviderFailure(phase, error, retainUnknown)
    // A refusal the user can act on (platform qualification, the Linux sandbox) is not an
    // authentication failure; name it instead of the generic text.
    const refusal = retainUnknown ? null : openCodeV2Refusal(error)
    if (refusal) return resultError('runtime-unhealthy', refusal.message)
    return resultError(retainUnknown ? 'runtime-unhealthy' : 'auth-failed', openCodeV2ConnectFailureMessage(error, retainUnknown))
  }
}

/** The native key method form for a registered V2 key integration; null for every other provider. */
export function buildOpenCodeV2KeySetupForm(providerId: string, version: OpenCodeV2Pin): ProviderSetupForm | null {
  const integration = openCodeV2KeyIntegration(providerId, version)
  if (!integration) return null
  return nativeKeySetupForm(providerId, integration.displayName)
}

function nativeKeySetupForm(providerId: string, displayName: string): ProviderSetupForm {
  const secret = { key: 'key' as const, label: 'API key', placeholder: null, required: true }
  return { runtimeId: 'opencode', providerId, displayName, method: 'api', supported: true,
    title: `Connect ${displayName}`,
    description: 'The key is connected through the selected OpenCode V2 native integration and verified with one model request.',
    submitLabel: 'Connect', disabledReason: null, source: 'opencode-auth', secret, prompts: [],
    authOptions: [{ id: OPENCODE_V2_NATIVE_KEY_OPTION_ID, method: 'api', methodIndex: null, label: 'API key', supported: true,
      disabledReason: null, secret, prompts: [] }],
    defaultAuthOptionId: OPENCODE_V2_NATIVE_KEY_OPTION_ID,
    verification: { kind: 'model-request', freeModelPreferred: false, mayUseQuotaOrBalance: true } }
}

/** Read the selected native provider's actual integration; opening a form never submits a key or a model request. */
export async function loadOpenCodeV2ProviderSetupForm(input: LoadProviderSetupFormInput,
  selectedRead?: Awaited<ReturnType<typeof inspectOpenCodeReadSelection>>): Promise<ProviderManagementResult<ProviderSetupForm>> {
  try {
    return await catalog(input, async owner => {
      const provider = scopedRows(await owner.providers(), owner.authority.directory).find(row => row.id === input.providerId)
      if (!provider || typeof provider.integrationID !== 'string') {
        return resultError('unsupported-auth-method', 'This provider does not expose a supported API-key setup method. Configure it in OpenCode.')
      }
      const integrationID = text(provider.integrationID)
      const integration = readIntegration(scopedIntegration(await owner.integration(integrationID), owner.authority.directory, integrationID))
      if (!integration.plainKey) {
        return resultError('unsupported-auth-method', 'This provider requires sign-in or additional setup in OpenCode. API-key setup without an additional form is not available.')
      }
      return { ok: true as const, value: nativeKeySetupForm(input.providerId, integration.name) }
    }, selectedRead)
  } catch (error) {
    return resultError('runtime-unhealthy', openCodeV2Refusal(error)?.message ?? 'The OpenCode provider setup could not be loaded. Refresh providers and try again.')
  }
}

/** Terminal failures must not be presented as an execution still in progress. */
export function openCodeV2ModelTestMessage(ok: boolean, state: string): string {
  if (ok) return 'Selected V2 model execution and physical retirement verified.'
  if (state === 'failed') return 'The original selected-model execution failed. No alternate input was submitted. Check provider limits and connection diagnostics.'
  return 'Original selected-model execution is pending or unverified; no alternate input was submitted.'
}

export async function testOpenCodeV2ProviderModel(input: TestProviderModelInput): Promise<ProviderManagementResult<ProviderModelTestResult>> {
  try {
    const project = await canonicalizeOpenCodeProjectPath(input.projectPath)
    executionAssert(input.modelId.startsWith(input.providerId + '/'), 'provider_model_changed')
    const proof = await executionProof(project, input.modelId)
    const ok = proof.state === 'available' && proof.proof?.modelId === input.modelId && proof.proof.projectPath === normalizeOpenCodeProjectIdentity(project)
    return { ok: true, value: { providerId: input.providerId, modelId: input.modelId, ok,
      availability: ok ? 'available' : 'unknown', message: openCodeV2ModelTestMessage(ok, proof.state), diagnostics: [] } }
  } catch (error) { return resultError('runtime-unhealthy', openCodeV2Refusal(error)?.message ?? 'V2 selected-model execution could not be qualified. No alternate model was tried.') }
}

export async function loadOpenCodeV2ProviderModels(input: LoadProviderModelsInput,
  selectedRead?: Awaited<ReturnType<typeof inspectOpenCodeReadSelection>>): Promise<ProviderManagementResult<RuntimeProviderModelsView>> {
  try {
    const value = await catalog(input, async owner => {
      const rows = scopedRows(await owner.models(), owner.authority.directory).filter(row => row.providerID === input.providerId)
      let anonymousProvider = false
      if (input.providerId === 'opencode') {
        try {
          const providers = scopedRows(await owner.providers(), owner.authority.directory).filter(row => row.id === input.providerId)
          if (providers.length === 1 && isOpenCodeV2AnonymousProvider(providers[0]!)) {
            const integration = scopedIntegration(await owner.integration('opencode'), owner.authority.directory, 'opencode')
            anonymousProvider = Array.isArray(integration.connections) && integration.connections.length === 0
          }
        } catch {
          // These optional reads classify access, not the already validated model
          // catalog. Missing native evidence cannot grant anonymous availability.
          anonymousProvider = false
        }
      }
      const models = rows.map(row => buildOpenCodeV2RuntimeProviderModel(row, input.providerId, owner.preferredModel, anonymousProvider))
      return { runtimeId: 'opencode' as const, providerId: input.providerId,
        ...pageOpenCodeV2ProviderModels(models, { ...input, projectPath: owner.authority.directory }),
        defaultModelId: owner.preferredModel, diagnostics: [], catalogState: 'fresh' as const }
    }, selectedRead, { includeSelectedApiKey: true })
    return { ok: true, value }
  } catch (error) { return resultError('runtime-unhealthy', error instanceof Error && error.message === 'provider_catalog_page_changed'
    ? 'The OpenCode model catalog changed while loading more models. Refresh models and try again.'
    : openCodeV2Refusal(error)?.message ?? 'V2 native provider catalog is unavailable; no legacy CLI catalog command was invoked.') }
}

export function buildOpenCodeV2RuntimeProviderModel(row: Record<string, unknown>, providerId: string, preferredModel: string | null,
  anonymousProvider = false): RuntimeProviderModel {
  const free = isOpenCodeV2ModelFree(providerId, row.cost)
  const builtinFree = anonymousProvider && providerId === 'opencode' && free && row.enabled === true && row.status === 'active'
  return { modelId: `${providerId}/${text(row.id)}`, providerId, displayName: text(row.name), sourceLabel: 'OpenCode V2 native catalog',
    declaredInputModalities: getOpenCodeV2DeclaredInputModalities(row.capabilities),
    free, default: `${providerId}/${row.id}` === preferredModel,
    catalogStatus: row.status === 'alpha' || row.status === 'beta' || row.status === 'deprecated' ? row.status : 'active',
    availability: row.enabled === false ? 'unavailable' : 'untested',
    accessKind: builtinFree ? 'builtin_free' : 'credentialed', routeKind: builtinFree ? 'builtin_free' : 'catalog_provider',
    proofState: 'needs_probe', requiresExecutionProof: true,
    accessReason: builtinFree ? 'Listed as free by OpenCode; access is subject to OpenCode limits and selected-model verification.' : 'Selected-model execution proof is required.',
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
