export type ProviderManagementRuntimeId = 'opencode'

export type ProviderRuntimeState =
  | 'ready'
  | 'needs-auth'
  | 'needs-setup'
  | 'degraded'

export type ManagedProfileState = 'active' | 'missing' | 'stale'

export type LocalAuthState = 'synced' | 'missing' | 'stale' | 'disabled'

export type ProviderConnectionState =
  | 'connected'
  | 'available'
  | 'not-connected'
  | 'ignored'
  | 'error'

export type ProviderOwnership =
  | 'managed'
  | 'local'
  | 'env'
  | 'project'

export type ProviderAuthMethod = 'api' | 'oauth' | 'wellknown'

export type ProviderSetupMethod = 'api' | 'oauth' | 'manual'

export type ProviderSetupPromptType = 'text' | 'select'

export type ProviderSetupPromptOption = {
  label: string
  value: string
  hint: string | null
}

export type ProviderSetupPromptCondition = {
  key: string
  op: string
  value: string
}

export type ProviderSetupPrompt = {
  key: string
  type: ProviderSetupPromptType
  label: string
  placeholder: string | null
  required: boolean
  secret: boolean
  options: readonly ProviderSetupPromptOption[]
  when: ProviderSetupPromptCondition | null
}

export type ProviderSetupFormSource =
  | 'opencode-auth'
  | 'curated'
  | 'oauth'
  | 'manual'

export type ProviderSetupForm = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
  displayName: string
  method: ProviderSetupMethod
  supported: boolean
  title: string
  description: string | null
  submitLabel: string
  disabledReason: string | null
  source: ProviderSetupFormSource
  secret: {
    key: 'key'
    label: string
    placeholder: string | null
    required: boolean
  } | null
  prompts: readonly ProviderSetupPrompt[]
}

export type ProviderActionId =
  | 'connect'
  | 'use'
  | 'test'
  | 'set-default'
  | 'forget'
  | 'configure'
  | 'unignore'

export type ProviderActionOwnershipScope =
  | ProviderOwnership
  | 'runtime'

export type ProviderActionDescriptor = {
  id: ProviderActionId
  label: string
  enabled: boolean
  disabledReason: string | null
  requiresSecret: boolean
  ownershipScope: ProviderActionOwnershipScope
}

export type ProviderManagementErrorCode =
  | 'unsupported-runtime'
  | 'unsupported-action'
  | 'runtime-missing'
  | 'runtime-unhealthy'
  | 'provider-missing'
  | 'auth-required'
  | 'auth-failed'
  | 'model-missing'
  | 'model-test-failed'
  | 'unsupported-auth-method'

export type ProviderManagementError = {
  code: ProviderManagementErrorCode
  message: string
  recoverable: boolean
}

export type ProviderManagementResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProviderManagementError }

export type ProviderManagementRuntimeView = {
  state: ProviderRuntimeState
  cliPath: string | null
  version: string | null
  managedProfile: ManagedProfileState
  localAuth: LocalAuthState
}

export type ProviderConnection = {
  providerId: string
  displayName: string
  state: ProviderConnectionState
  ownership: readonly ProviderOwnership[]
  recommended: boolean
  modelCount: number
  defaultModelId: string | null
  authMethods: readonly ProviderAuthMethod[]
  actions: readonly ProviderActionDescriptor[]
  detail: string | null
}

export type ProviderDirectoryFilter =
  | 'all'
  | 'connected'
  | 'configured'
  | 'connectable'
  | 'manual'
  | 'has-models'

export type ProviderSetupKind =
  | 'connected'
  | 'connect-api-key'
  | 'configure-manually'
  | 'requires-environment'
  | 'available-readonly'
  | 'unsupported'

export type ProviderDirectorySource =
  | 'opencode-provider'
  | 'config-provider'
  | 'inventory'
  | 'seed'

export type ProviderDirectoryEntry = {
  providerId: string
  displayName: string
  state: ProviderConnectionState
  setupKind: ProviderSetupKind
  ownership: readonly ProviderOwnership[]
  recommended: boolean
  modelCount: number | null
  authMethods: readonly ProviderAuthMethod[]
  defaultModelId: string | null
  sources: readonly ProviderDirectorySource[]
  sourceLabel: string | null
  providerSource: string | null
  detail: string | null
  actions: readonly ProviderActionDescriptor[]
  metadata: {
    hasKnownModels: boolean
    requiresManualConfig: boolean
    supportedInlineAuth: boolean
    configuredAuthless: boolean
  }
}

export type ProviderDirectoryView = {
  runtimeId: ProviderManagementRuntimeId
  totalCount: number
  returnedCount: number
  query: string | null
  filter: ProviderDirectoryFilter
  limit: number
  cursor: string | null
  nextCursor: string | null
  entries: readonly ProviderDirectoryEntry[]
  diagnostics: readonly string[]
  fetchedAt: string
}

export type ProviderManagementView = {
  runtimeId: ProviderManagementRuntimeId
  title: string
  runtime: ProviderManagementRuntimeView
  providers: readonly ProviderConnection[]
  configuredModels: readonly RuntimeProviderModel[]
  projectPath?: string | null
  projectDefaultModel?: string | null
  allProjectsDefaultModel?: string | null
  defaultModelSource?: RuntimeProviderDefaultModelSource | null
  defaultModel: string | null
  fallbackModel: string | null
  diagnostics: readonly string[]
}

export type RuntimeProviderDefaultModelSource =
  | 'project'
  | 'all_projects'
  | 'opencode_config'
  | 'fallback'

export type RuntimeProviderDefaultScope = 'project' | 'all_projects'

export type ProviderModelAvailability =
  | 'available'
  | 'unavailable'
  | 'not-authenticated'
  | 'unknown'
  | 'untested'

export type OpenCodeRuntimeModelAccessKind =
  | 'no_model'
  | 'unknown_model'
  | 'credentialed'
  | 'builtin_free'
  | 'configured_authless'
  | 'verified'
  | 'not_authenticated'
  | 'execution_failed'

export type OpenCodeRuntimeModelRouteKind =
  | 'connected_provider'
  | 'builtin_free'
  | 'configured_local'
  | 'catalog_provider'

export type OpenCodeRuntimeModelProofState =
  | 'not_required'
  | 'needs_probe'
  | 'verified'
  | 'failed'

export type RuntimeProviderModel = {
  modelId: string
  providerId: string
  displayName: string
  sourceLabel: string
  free: boolean
  default: boolean
  availability: ProviderModelAvailability
  accessKind: OpenCodeRuntimeModelAccessKind
  routeKind: OpenCodeRuntimeModelRouteKind
  proofState: OpenCodeRuntimeModelProofState
  requiresExecutionProof: boolean
  accessReason: string | null
}

export type RuntimeProviderModelsView = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
  models: readonly RuntimeProviderModel[]
  defaultModelId: string | null
  diagnostics: readonly string[]
}

export type ProjectScopedProviderManagementInput = {
  projectPath?: string | null
}

export type LoadProviderManagementViewInput = ProjectScopedProviderManagementInput & {
  runtimeId: ProviderManagementRuntimeId
}

export type ConnectProviderApiKeyInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
  apiKey: string
} & ProjectScopedProviderManagementInput

export type LoadProviderSetupFormInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
} & ProjectScopedProviderManagementInput

export type ConnectProviderInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
  method: ProviderSetupMethod
  apiKey?: string | null
  metadata?: Record<string, string> | null
} & ProjectScopedProviderManagementInput

export type ProviderSelectionInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
} & ProjectScopedProviderManagementInput

export type SetDefaultModelInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
  modelId: string
  probe?: boolean
  scope?: RuntimeProviderDefaultScope
} & ProjectScopedProviderManagementInput

export type TestProviderModelInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
  modelId: string
} & ProjectScopedProviderManagementInput

export type ProviderModelTestResult = {
  providerId: string
  modelId: string
  ok: boolean
  availability: ProviderModelAvailability
  message: string
  diagnostics: readonly string[]
}

export type LoadProviderModelsInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
  query?: string | null
  limit?: number | null
} & ProjectScopedProviderManagementInput

export type LoadProviderDirectoryInput = {
  runtimeId: ProviderManagementRuntimeId
  query?: string | null
  filter?: ProviderDirectoryFilter | null
  limit?: number | null
  cursor?: string | null
  refresh?: boolean | null
} & ProjectScopedProviderManagementInput
