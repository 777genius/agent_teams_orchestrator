import type {
  AnthropicRuntimeBackendId,
  RuntimeExtensionCapabilities,
  RuntimeProviderCapabilities,
  RuntimeProviderModelCatalog,
  RuntimeProviderSubscriptionRateLimitSnapshot,
  RuntimeProviderStatus,
} from './types.js'

type AnthropicAuthenticatedState = {
  authenticated: boolean
  authMethod: string | null
}

export type AnthropicRuntimeBackendInfo = {
  id: AnthropicRuntimeBackendId
  label: string
  endpointLabel: string | null
  projectId?: string | null
  authMethodDetail: string | null
  statusMessage: string
  detailMessage: string | null
}

export function isAnthropicSubscriptionAuthMethod(
  authMethod: string | null | undefined,
): boolean {
  return authMethod === 'claude.ai' || authMethod === 'oauth_token'
}

export function buildAnthropicRuntimeStatus(params: {
  auth: AnthropicAuthenticatedState
  modelCatalog: RuntimeProviderModelCatalog
  visibleModels: string[]
  reasoningEfforts: NonNullable<RuntimeProviderCapabilities['reasoningEffort']>['values']
  fastMode: NonNullable<RuntimeProviderCapabilities['fastMode']>
  extensions: RuntimeExtensionCapabilities
  subscriptionRateLimits?: RuntimeProviderSubscriptionRateLimitSnapshot | null
  backend?: AnthropicRuntimeBackendInfo | null
}): RuntimeProviderStatus {
  const backend = params.backend ?? null
  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: params.auth.authenticated,
    authMethod: params.auth.authMethod,
    verificationState: backend ? 'unknown' : 'verified',
    canLoginFromUi: backend ? false : true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: params.extensions,
    },
    statusMessage: backend
      ? backend.statusMessage
      : params.auth.authenticated
        ? null
        : 'Not connected',
    detailMessage: backend?.detailMessage ?? null,
    selectedBackendId: backend?.id ?? null,
    resolvedBackendId: backend?.id ?? null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    models: params.visibleModels,
    modelCatalog: params.modelCatalog,
    subscriptionRateLimits: isAnthropicSubscriptionAuthMethod(params.auth.authMethod)
      ? (params.subscriptionRateLimits ?? null)
      : null,
    runtimeCapabilities: {
      modelCatalog: {
        dynamic: true,
        source: params.modelCatalog.source,
      },
      reasoningEffort: {
        supported: params.reasoningEfforts.length > 0,
        values: params.reasoningEfforts,
        configPassthrough: true,
      },
      fastMode: params.fastMode,
    },
    backend: backend
      ? {
          kind: backend.id,
          label: backend.label,
          endpointLabel: backend.endpointLabel,
          projectId: backend.projectId ?? null,
          authMethodDetail: backend.authMethodDetail,
        }
      : null,
  }
}
