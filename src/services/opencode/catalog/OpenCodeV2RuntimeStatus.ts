import type { OpenCodeInventorySnapshot } from '../types.js'
import { readOpenCodeV2StatusProof } from './OpenCodeV2StatusProof.js'
import type { RuntimeExtensionCapability, RuntimeProviderStatus } from '../../runtimeBackends/types.js'

/** Catalog availability never participates in authentication or protocol1 launch readiness. */
export function buildOpenCodeV2RuntimeStatus(snapshot: OpenCodeInventorySnapshot, managedDefault: string | null = null): RuntimeProviderStatus {
  const read = snapshot.readStatus, ready = read?.catalog === 'ready'
  // A named refusal (version not qualified here, Linux sandbox unavailable) is a settled
  // answer, not a transient read failure: report it as unsupported with its cause.
  const refused = Boolean(read) && !ready && snapshot.probeRefusal === true && Boolean(snapshot.probeError)
  const unavailable: RuntimeExtensionCapability = {
    status: 'unsupported', ownership: 'provider-scoped', reason: 'capabilities_pending',
  }
  const now = new Date().toISOString()
  const defaultId = managedDefault ?? (read?.defaultModel ? `${read.defaultModel.providerId}/${read.defaultModel.catalogId}` : null)
  return {
    providerId: 'opencode', displayName: 'OpenCode (75+ LLM providers)', supported: Boolean(read) && !refused,
    authenticated: false, authMethod: null, verificationState: 'unknown', canLoginFromUi: false,
    capabilities: { teamLaunch: false, oneShot: false,
      extensions: { plugins: unavailable, mcp: unavailable, skills: unavailable, apiKeys: unavailable } },
    statusMessage: ready ? 'OpenCode V2 catalog available; capabilities_pending' : refused ? 'OpenCode V2 is not available on this system'
      : 'OpenCode read capabilities_pending',
    // A failed full read names its cause (fixed text from the V2 inventory probe, never a native error).
    detailMessage: read && !ready && snapshot.probeError ? snapshot.probeError
      : 'Authentication, team launch and one-shot execution remain unqualified. Only an existing verified V2 native selection is supported for reads.',
    selectedBackendId: null, resolvedBackendId: null, availableBackends: [],
    externalRuntimeDiagnostics: [{ id: 'cli-bin', label: 'OpenCode CLI', detected: snapshot.detected,
      statusMessage: 'Read-scoped native selection', detailMessage: snapshot.binaryPath }],
    models: ready ? snapshot.models : [],
    backend: snapshot.detected ? { kind: 'opencode-cli', label: 'OpenCode CLI', authMethodDetail: null } : null,
    statusCheckOutcome: ready ? 'model_only' : refused ? 'authoritative' : 'transient_error',
    statusCheckErrorCode: ready || refused ? null : 'unavailable',
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
    ...(read ? { openCodeReadStatus: read } : {}),
    modelCatalog: {
      schemaVersion: 1, providerId: 'opencode', source: 'app-server', status: ready ? 'ready' : 'unavailable',
      fetchedAt: now, staleAt: now, defaultModelId: defaultId, defaultLaunchModel: null,
      models: ready && read ? read.models.map(model => {
        const id = `${model.providerId}/${model.catalogId}`
        const builtinFree = model.free === true && model.enabled && model.status === 'active' &&
          read.providers.some(provider => provider.id === model.providerId && provider.anonymous === true)
        return { id, launchModel: id, displayName: id, hidden: !model.enabled,
          supportedReasoningEfforts: [], defaultReasoningEffort: null, inputModalities: model.input,
          supportsPersonality: false, isDefault: id === defaultId, upgrade: false, source: 'app-server',
          statusMessage: 'capabilities_pending: catalog entry only',
          badgeLabel: model.free === true ? 'Free' : null,
          metadata: { context: model.context, limits: { context: model.context, output: model.outputTokens }, free: model.free === true,
            ...(builtinFree ? { opencode: { providerId: model.providerId, modelId: model.catalogId, sourceLabel: 'OpenCode V2 native catalog',
              accessKind: 'builtin_free', routeKind: 'builtin_free', proofState: 'needs_probe', requiresExecutionProof: true,
              reason: 'Listed as free by OpenCode; selected-model execution proof is required.' } } : {}) } }
      }) : [],
      diagnostics: { configReadState: ready ? 'ready' : 'failed', appServerState: ready ? 'healthy' : 'incompatible',
        message: 'capabilities_pending', code: 'capabilities_pending' },
    },
    capabilitiesInfo: [{ id: 'v2-catalog-read', label: 'OpenCode V2 catalog read', enabled: ready },
      { id: 'team-launch', label: 'Team launch', enabled: false }],
  }
}

/** A successful Test becomes visible on the next status refresh, including a new
 * process. Catalog discovery alone still grants no launch/authentication claim. */
export async function buildOpenCodeV2RuntimeStatusWithProof(snapshot: OpenCodeInventorySnapshot,
  managedDefault: string | null = null, proofTimeoutMs = 15_000): Promise<RuntimeProviderStatus> {
  const status = buildOpenCodeV2RuntimeStatus(snapshot, managedDefault)
  const proof = await readOpenCodeV2StatusProof(snapshot, proofTimeoutMs)
  if (!proof || !status.modelCatalog) return status
  status.modelCatalog.models = status.modelCatalog.models.map(model => {
    if (model.id !== proof.modelId) return model
    const source = snapshot.readStatus!.models.find(row => `${row.providerId}/${row.catalogId}` === proof.modelId)!
    const route = model.metadata?.opencode
    return { ...model, statusMessage: 'Selected V2 model execution and physical retirement verified.',
      metadata: { ...model.metadata, opencode: { providerId: source.providerId, modelId: source.catalogId,
        sourceLabel: 'OpenCode V2 native catalog', accessKind: 'verified',
        routeKind: route?.routeKind === 'builtin_free' && proof.credentialMode === 'none' ? 'builtin_free' : 'catalog_provider',
        proofState: 'verified', requiresExecutionProof: true,
        reason: 'Recent execution proof matches the current project, configuration, authentication and native runtime.' } } }
  })
  return status
}
