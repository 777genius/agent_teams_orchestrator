export type RuntimeProviderId = 'anthropic' | 'codex' | 'gemini'

export type GeminiRuntimeBackendId = 'auto' | 'api' | 'cli-sdk'
export type CodexRuntimeBackendId = 'codex-native'
export type RuntimeBackendId = GeminiRuntimeBackendId | CodexRuntimeBackendId

export type RuntimeCapabilityInfo = {
  id: string
  label: string
  enabled: boolean
}

export type RuntimeExtensionCapabilityStatus =
  | 'supported'
  | 'read-only'
  | 'unsupported'

export type RuntimeExtensionOwnership = 'shared' | 'provider-scoped'

export type RuntimeExtensionCapability = {
  status: RuntimeExtensionCapabilityStatus
  ownership: RuntimeExtensionOwnership
  reason: string | null
}

export type RuntimeExtensionCapabilities = {
  plugins: RuntimeExtensionCapability
  mcp: RuntimeExtensionCapability
  skills: RuntimeExtensionCapability
  apiKeys: RuntimeExtensionCapability
}

export type RuntimeBackendOptionState =
  | 'ready'
  | 'locked'
  | 'disabled'
  | 'authentication-required'
  | 'runtime-missing'
  | 'degraded'

export type RuntimeBackendOptionAudience = 'general' | 'internal'

export type RuntimeBackendOptionStatus = {
  id: RuntimeBackendId
  label: string
  description: string
  selectable: boolean
  recommended: boolean
  available: boolean
  state: RuntimeBackendOptionState
  audience: RuntimeBackendOptionAudience
  statusMessage: string | null
  detailMessage: string | null
}

export type ExternalRuntimeDiagnostic = {
  id: 'cli-bin'
  label: string
  detected: boolean
  statusMessage: string | null
  detailMessage: string | null
}

export type RuntimeProviderStatus = {
  providerId: RuntimeProviderId
  displayName: string
  supported: boolean
  authenticated: boolean
  authMethod: string | null
  verificationState: 'verified' | 'unknown' | 'offline' | 'error'
  canLoginFromUi: boolean
  capabilities: {
    teamLaunch: boolean
    oneShot: boolean
    extensions: RuntimeExtensionCapabilities
  }
  statusMessage: string | null
  detailMessage: string | null
  selectedBackendId: RuntimeBackendId | null
  resolvedBackendId: RuntimeBackendId | null
  availableBackends: RuntimeBackendOptionStatus[]
  externalRuntimeDiagnostics: ExternalRuntimeDiagnostic[]
  models: string[]
  backend: {
    kind: string
    label: string
    endpointLabel?: string | null
    projectId?: string | null
    authMethodDetail?: string | null
  } | null
  capabilitiesInfo?: RuntimeCapabilityInfo[]
}

export type RuntimeStatusPayload = {
  schemaVersion: 2
  providers: Partial<Record<RuntimeProviderId, RuntimeProviderStatus>>
}
