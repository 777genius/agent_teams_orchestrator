export type RuntimeProviderId = 'anthropic' | 'codex' | 'gemini'

export type GeminiRuntimeBackendId = 'auto' | 'api' | 'cli-sdk'
export type CodexRuntimeBackendId = 'auto' | 'adapter' | 'api'
export type RuntimeBackendId = GeminiRuntimeBackendId | CodexRuntimeBackendId

export type RuntimeCapabilityInfo = {
  id: string
  label: string
  enabled: boolean
}

export type RuntimeBackendOptionStatus = {
  id: RuntimeBackendId
  label: string
  description: string
  selectable: boolean
  recommended: boolean
  available: boolean
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
  schemaVersion: 1
  providers: Partial<Record<RuntimeProviderId, RuntimeProviderStatus>>
}
