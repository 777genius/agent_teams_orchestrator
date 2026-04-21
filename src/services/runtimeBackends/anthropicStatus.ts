import type {
  RuntimeExtensionCapabilities,
  RuntimeProviderCapabilities,
  RuntimeProviderModelCatalog,
  RuntimeProviderStatus,
} from './types.js'

type AnthropicAuthenticatedState = {
  authenticated: boolean
  authMethod: string | null
}

export function buildAnthropicRuntimeStatus(params: {
  auth: AnthropicAuthenticatedState
  modelCatalog: RuntimeProviderModelCatalog
  visibleModels: string[]
  reasoningEfforts: NonNullable<RuntimeProviderCapabilities['reasoningEffort']>['values']
  fastMode: NonNullable<RuntimeProviderCapabilities['fastMode']>
  extensions: RuntimeExtensionCapabilities
}): RuntimeProviderStatus {
  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: params.auth.authenticated,
    authMethod: params.auth.authMethod,
    verificationState: 'verified',
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: params.extensions,
    },
    statusMessage: params.auth.authenticated ? null : 'Not connected',
    detailMessage: null,
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    models: params.visibleModels,
    modelCatalog: params.modelCatalog,
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
    backend: null,
  }
}
