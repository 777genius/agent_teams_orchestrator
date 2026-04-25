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

export type ProviderManagementView = {
  runtimeId: ProviderManagementRuntimeId
  title: string
  runtime: ProviderManagementRuntimeView
  providers: readonly ProviderConnection[]
  defaultModel: string | null
  fallbackModel: string | null
  diagnostics: readonly string[]
}

export type ProviderModelAvailability =
  | 'available'
  | 'unavailable'
  | 'not-authenticated'
  | 'unknown'
  | 'untested'

export type RuntimeProviderModel = {
  modelId: string
  providerId: string
  displayName: string
  sourceLabel: string
  free: boolean
  default: boolean
  availability: ProviderModelAvailability
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

export type ProviderSelectionInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
} & ProjectScopedProviderManagementInput

export type SetDefaultModelInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
  modelId: string
  probe?: boolean
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
