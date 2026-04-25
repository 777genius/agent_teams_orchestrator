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

export type ProviderPrimaryAction =
  | 'connect'
  | 'use'
  | 'test'
  | 'forget'
  | 'unignore'

export type ProviderManagementErrorCode =
  | 'unsupported-runtime'
  | 'runtime-missing'
  | 'runtime-unhealthy'
  | 'provider-missing'
  | 'auth-required'
  | 'auth-failed'
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
  primaryAction: ProviderPrimaryAction | null
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

export type ConnectProviderApiKeyInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
  apiKey: string
}

export type ProviderSelectionInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
}

export type SetDefaultModelInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
  modelId: string
}

export type TestProviderModelInput = {
  runtimeId: ProviderManagementRuntimeId
  providerId: string
  modelId: string
}

export type ProviderModelTestResult = {
  providerId: string
  modelId: string
  ok: boolean
  message: string
}
