import type { OpenCodeInventorySnapshot } from '../types.js'
import type { RuntimeExtensionCapability, RuntimeProviderStatus } from '../../runtimeBackends/types.js'

/** Catalog availability never participates in authentication or protocol1 launch readiness. */
export function buildOpenCodeV2RuntimeStatus(snapshot: OpenCodeInventorySnapshot): RuntimeProviderStatus {
  const read = snapshot.readStatus, ready = read?.catalog === 'ready'
  const unavailable: RuntimeExtensionCapability = {
    status: 'unsupported', ownership: 'provider-scoped', reason: 'capabilities_pending',
  }
  const now = new Date().toISOString()
  const defaultId = read?.defaultModel ? `${read.defaultModel.providerId}/${read.defaultModel.catalogId}` : null
  return {
    providerId: 'opencode', displayName: 'OpenCode (75+ LLM providers)', supported: Boolean(read),
    authenticated: false, authMethod: null, verificationState: 'unknown', canLoginFromUi: false,
    capabilities: { teamLaunch: false, oneShot: false,
      extensions: { plugins: unavailable, mcp: unavailable, skills: unavailable, apiKeys: unavailable } },
    statusMessage: ready ? 'OpenCode V2 catalog available; capabilities_pending' : 'OpenCode read capabilities_pending',
    detailMessage: 'Authentication, team launch and one-shot execution remain unqualified. Only an existing verified V2 native selection is supported for reads.',
    selectedBackendId: null, resolvedBackendId: null, availableBackends: [],
    externalRuntimeDiagnostics: [{ id: 'cli-bin', label: 'OpenCode CLI', detected: snapshot.detected,
      statusMessage: 'Read-scoped native selection', detailMessage: snapshot.binaryPath }],
    models: ready ? snapshot.models : [],
    backend: snapshot.detected ? { kind: 'opencode-cli', label: 'OpenCode CLI', authMethodDetail: null } : null,
    statusCheckOutcome: ready ? 'model_only' : 'transient_error', statusCheckErrorCode: ready ? null : 'unavailable',
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
    ...(read ? { openCodeReadStatus: read } : {}),
    modelCatalog: {
      schemaVersion: 1, providerId: 'opencode', source: 'app-server', status: ready ? 'ready' : 'unavailable',
      fetchedAt: now, staleAt: now, defaultModelId: defaultId, defaultLaunchModel: null,
      models: ready && read ? read.models.map(model => {
        const id = `${model.providerId}/${model.catalogId}`
        return { id, launchModel: id, displayName: id, hidden: !model.enabled,
          supportedReasoningEfforts: [], defaultReasoningEffort: null, inputModalities: model.input,
          supportsPersonality: false, isDefault: id === defaultId, upgrade: false, source: 'app-server',
          statusMessage: 'capabilities_pending: catalog entry only',
          metadata: { context: model.context, limits: { context: model.context, output: model.outputTokens } } }
      }) : [],
      diagnostics: { configReadState: ready ? 'ready' : 'failed', appServerState: ready ? 'healthy' : 'incompatible',
        message: 'capabilities_pending', code: 'capabilities_pending' },
    },
    capabilitiesInfo: [{ id: 'v2-catalog-read', label: 'OpenCode V2 catalog read', enabled: ready },
      { id: 'team-launch', label: 'Team launch', enabled: false }],
  }
}
