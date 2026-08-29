export type OpenCodeAuthSource = 'credentials' | 'environment'

export type OpenCodeAgentMode = 'primary' | 'subagent' | 'unknown'

export type OpenCodeAuthState = 'ok' | 'missing' | 'stale'

export type OpenCodeHostState = 'starting' | 'healthy' | 'degraded' | 'disposed'

export type OpenCodeModelOutputLimitOverride = {
  modelId: string
  outputTokens: number
  contextTokens?: number
}

export type OpenCodeToolApprovalMode = 'auto' | 'manual'

export type OpenCodePrepareProfileOptions = {
  abortSignal?: AbortSignal
  modelOutputLimitOverrides?: readonly OpenCodeModelOutputLimitOverride[]
  includeAppMcp?: boolean
  includeManagedSubscriptionPlugins?: boolean
  toolApprovalMode?: OpenCodeToolApprovalMode
  profileScope?: OpenCodeProfileScope
}

export type OpenCodeProfilePurpose = 'catalog' | 'execution_probe' | 'launch_runtime'

export type OpenCodeProfileScope = {
  purpose: OpenCodeProfilePurpose
  providerId: string
  configFingerprint: string
  selectedAuthIdentity: 'absent' | 'error' | `known:${string}`
  scopeToken: string
}

export type OpenCodePreparedProfile = {
  projectPath: string
  canonicalProjectPath: string
  workingDirectoryPath: string
  scopeToken: string | null
  profileRootKey: string
  profileRootPath: string
  profileScope?: OpenCodeProfileScope | null
  projectDefaultModelId?: string | null
  allProjectsDefaultModelId?: string | null
  importedConfigDefaultModelId?: string | null
  effectiveManagedDefaultModelId?: string | null
  effectiveManagedDefaultSource?: 'project' | 'all_projects' | null
  projectBehaviorFingerprint: string
  behaviorSources: string[]
  managedConfig: Record<string, unknown>
  managedConfigFingerprint: string
  homePath: string
  tmpPath: string
  xdgConfigHome: string
  xdgDataHome: string
  xdgCacheHome: string
  globalAuthPath?: string
  managedAuthPath: string
  sourceAuthPath: string | null
  sourceAuthFingerprint: string | null
  managedAuthFingerprint: string | null
  selectedSourceAuthIdentity?: 'absent' | 'error' | `known:${string}`
  selectedManagedAuthIdentity?: 'absent' | 'error' | `known:${string}`
  authState: OpenCodeAuthState
  env: NodeJS.ProcessEnv
}

export type OpenCodeHostHandle = {
  hostKey: string
  profileRootKey: string
  projectPath: string
  projectBehaviorFingerprint: string
  baseUrl: string
  port: number
  pid: number
  processStartedAtMs?: number | null
  version: string | null
  state: OpenCodeHostState
  profile: OpenCodePreparedProfile
  resolvedConfigFingerprint: string | null
  diagnostics: string[]
}

export type OpenCodeConnectedProvider = {
  id: string
  authHint: string | null
  source: OpenCodeAuthSource
  credentialScopes?: Array<'managed' | 'local'>
}

export type OpenCodeAgentSummary = {
  id: string
  mode: OpenCodeAgentMode
}

export type OpenCodeCatalogModelStatus = 'active' | 'alpha' | 'beta' | 'deprecated'

export type OpenCodeModelMetadata = {
  id: string
  cost: unknown | null
  context: number | null
  limits: unknown | null
  free: boolean
  catalogStatus?: OpenCodeCatalogModelStatus
  raw: Record<string, unknown>
}

export type OpenCodeInventorySnapshot = {
  detected: boolean
  binaryPath: string | null
  version: string | null
  projectPath: string
  profile: OpenCodePreparedProfile | null
  connectedProviders: OpenCodeConnectedProvider[]
  availableProviders: string[]
  models: string[]
  modelMetadata?: OpenCodeModelMetadata[]
  agents: OpenCodeAgentSummary[]
  authStorePath: string | null
  probeError: string | null
  diagnostics: string[]
}

export type OpenCodeConfigResponse = {
  agent?: Record<string, unknown>
  mode?: Record<string, unknown>
  plugin?: unknown[]
  command?: Record<string, unknown>
  username?: string
  default_agent?: string
  share?: 'manual' | 'auto' | 'disabled' | string
  autoupdate?: boolean | 'notify'
  snapshot?: boolean
  permission?: Record<string, unknown>
}

export type OpenCodeProviderAuthPromptOption = {
  label?: string
  value?: string
  hint?: string
}

export type OpenCodeProviderAuthPromptCondition = {
  key?: string
  op?: string
  value?: string
}

export type OpenCodeProviderAuthPrompt = {
  type?: string
  key?: string
  message?: string
  placeholder?: string
  options?: OpenCodeProviderAuthPromptOption[]
  when?: OpenCodeProviderAuthPromptCondition
}

export type OpenCodeProviderAuthMethod = {
  type?: string
  label?: string
  prompts?: OpenCodeProviderAuthPrompt[]
}

export type OpenCodeApiAuthInput = {
  type: 'api'
  key: string
  metadata?: Record<string, string>
}

export type OpenCodeProviderOAuthAuthorizeInput = {
  method: number
  inputs?: Record<string, string>
}

export type OpenCodeProviderOAuthAuthorization = {
  url: string
  method: 'auto' | 'code'
  instructions: string
}

export type OpenCodeProviderOAuthCallbackInput = {
  method: number
  code?: string
}

export type OpenCodeServerDocResponse = {
  paths?: Record<string, Record<string, unknown>>
}

export type OpenCodeMcpServerConfig = {
  type: 'local' | 'remote'
  command?: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
  url?: string
  headers?: Record<string, string>
  oauth?: boolean | Record<string, unknown>
}

export type OpenCodeProviderListEntry = {
  id?: string
  source?: string
  name?: string
  npm?: string
  options?: Record<string, unknown>
  models?: Record<string, unknown>
}

export type OpenCodeConfigProvidersResponse = {
  providers?: OpenCodeProviderListEntry[]
  default?: Record<string, string>
}

export type OpenCodeProviderResponse = {
  all?: OpenCodeProviderListEntry[]
  default?: Record<string, string>
  connected?: string[]
}

export type OpenCodeAgentResponse = {
  name?: string
  description?: string
  mode?: string
  native?: boolean
  hidden?: boolean
}

export type OpenCodeMcpStatusEntry = Record<string, unknown>

export type OpenCodeMcpResponse = Record<string, OpenCodeMcpStatusEntry>

export type OpenCodeAppMcpStatus = 'present' | 'attached' | 'missing' | 'attach_failed'

export type OpenCodeAppMcpLaunchSource = 'env-override' | 'workspace-dist' | 'workspace-src'

export type OpenCodeAppMcpSummary = {
  serverName: string
  matchedServerName: string | null
  status: OpenCodeAppMcpStatus
  connected: boolean | null
  launchSource: OpenCodeAppMcpLaunchSource | null
  availableServerNames: string[]
  diagnostics: string[]
}

export type OpenCodeProvisioningSnapshot = {
  detected: boolean
  hostHealthy: boolean
  projectPath: string
  models?: string[]
  modelMetadata?: OpenCodeModelMetadata[]
  profile: OpenCodePreparedProfile | null
  host: OpenCodeHostHandle | null
  config: OpenCodeConfigResponse | null
  configProviders: OpenCodeConfigProvidersResponse | null
  providers: OpenCodeProviderResponse | null
  providerAuth: Record<string, OpenCodeProviderAuthMethod[]> | null
  agents: OpenCodeAgentResponse[]
  mcp: OpenCodeMcpResponse | null
  appMcp: OpenCodeAppMcpSummary | null
  probeError: string | null
  diagnostics: string[]
}

export type OpenCodeSessionSummary = {
  id: string
  slug?: string
  title?: string
  projectID?: string
  directory?: string
  version?: string
}

export type OpenCodeSessionStatus = 'idle' | 'busy' | 'retry'

export type OpenCodeSessionStatusPayload = {
  type?: string
  status?: string
  message?: string
  attempt?: number
  next?: number
}

export type OpenCodeSessionStatusInput =
  | OpenCodeSessionStatus
  | OpenCodeSessionStatusPayload
  | string

export type OpenCodeBootstrapMode = 'app_managed_context' | 'model_tool_checkin'

export type OpenCodeBootstrapEvidenceSource = 'app_managed_bootstrap' | 'runtime_bootstrap_checkin'

export type OpenCodeAppManagedBootstrapRecord = {
  schemaVersion: 1
  messageID: string
  contextHash: string
  briefingHash: string
  injectionVerifiedAt: string
  model?: string
  agent?: string
}

export type OpenCodePendingPermission = {
  id?: string
  requestID?: string
  requestId?: string
  permissionID?: string
  permissionId?: string
  sessionID?: string
  sessionId?: string
  session?: string
  tool?: string
  toolName?: string
  name?: string
  title?: string
  description?: string
  kind?: string
  type?: string
  metadata?: Record<string, unknown>
  permission?: Record<string, unknown>
  [key: string]: unknown
}

export type OpenCodeNormalizedPermission = {
  requestId: string
  sessionId: string | null
  tool: string | null
  title: string | null
  kind: string | null
  raw: OpenCodePendingPermission
}

export type OpenCodeSseEvent = {
  type: string
  properties: Record<string, unknown>
  directory: string | null
  raw: unknown
}

export type OpenCodeMessagePart = {
  type?: string
  id?: string
  text?: string
  sessionID?: string
  messageID?: string
  [key: string]: unknown
}

export type OpenCodeMessage = {
  info: Record<string, unknown>
  parts: OpenCodeMessagePart[]
}

export type OpenCodeCanonicalMessageRole = 'user' | 'assistant' | 'system' | 'unknown'

export type OpenCodeDurableSessionState =
  | 'idle'
  | 'running'
  | 'retrying'
  | 'blocked'
  | 'error'
  | 'reply_pending'
  | 'unknown'

export type OpenCodePreviewRuntimeState =
  | 'idle'
  | 'running'
  | 'retrying'
  | 'blocked'
  | 'error'
  | 'unknown'

export type OpenCodeCanonicalMessage = {
  id: string | null
  parentId: string | null
  role: OpenCodeCanonicalMessageRole
  agent: string | null
  providerId: string | null
  modelId: string | null
  createdAt: number | null
  completedAt: number | null
  text: string
  reasoningText: string
  previewText: string | null
  partTypes: string[]
  reasoningPartCount: number
  toolCalls: OpenCodeCanonicalToolCall[]
  contentBlocks: OpenCodeCanonicalContentBlock[]
  finishReason: string | null
  errorName: string | null
  errorMessage: string | null
  hasError: boolean
}

export type OpenCodeCanonicalToolStatus = 'running' | 'completed' | 'errored' | 'unknown'

export type OpenCodeCanonicalToolCall = {
  callId: string | null
  toolName: string | null
  title: string | null
  status: OpenCodeCanonicalToolStatus
  input: Record<string, unknown> | null
  output: unknown
  outputText: string | null
  outputPreview: string | null
  startedAt: number | null
  completedAt: number | null
  isError: boolean
}

export type OpenCodeCanonicalContentBlock =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'reasoning'
      text: string
    }
  | {
      type: 'tool_use'
      id: string | null
      name: string | null
      title: string | null
      status: OpenCodeCanonicalToolStatus
      input: Record<string, unknown> | null
      startedAt: number | null
      completedAt: number | null
    }
  | {
      type: 'tool_result'
      toolUseId: string | null
      toolName: string | null
      title: string | null
      status: OpenCodeCanonicalToolStatus
      contentText: string | null
      contentPreview: string | null
      rawContent: unknown
      isError: boolean
      startedAt: number | null
      completedAt: number | null
    }
  | {
      type: 'step_start'
    }
  | {
      type: 'step_finish'
      reason: string | null
    }
  | {
      type: 'error'
      name: string
      message: string
    }

export type OpenCodeTranscriptProjection = {
  sessionId: string
  messageCount: number
  toolCallCount: number
  errorCount: number
  messages: OpenCodeCanonicalMessage[]
}

export type OpenCodeProjectedLogContentBlock =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'thinking'
      thinking: string
      signature: string
    }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string | OpenCodeProjectedLogContentBlock[]
      is_error?: boolean
    }

export type OpenCodeProjectedLogToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
  isTask: boolean
  taskDescription?: string
  taskSubagentType?: string
}

export type OpenCodeProjectedLogToolResult = {
  toolUseId: string
  content: string | OpenCodeProjectedLogContentBlock[]
  isError: boolean
}

export type OpenCodeProjectedLogMessage = {
  uuid: string
  parentUuid: string | null
  type: 'assistant' | 'user' | 'system'
  timestamp: string
  role?: string
  content: OpenCodeProjectedLogContentBlock[] | string
  model?: string
  agentName?: string
  isMeta: boolean
  isSynthetic?: boolean
  protocolKind?: string
  sessionId: string
  toolCalls: OpenCodeProjectedLogToolCall[]
  toolResults: OpenCodeProjectedLogToolResult[]
  sourceToolUseID?: string
  sourceToolAssistantUUID?: string
  subtype?: string
  level?: string
}

export type OpenCodeLogProjection = {
  sessionId: string
  durableState: OpenCodeDurableSessionState
  sourceMessageCount: number
  projectedMessageCount: number
  syntheticMessageCount: number
  toolCallCount: number
  errorCount: number
  diagnostics: string[]
  messages: OpenCodeProjectedLogMessage[]
}

export type OpenCodeExecutionProbeOutcome =
  | 'available'
  | 'unavailable'
  | 'not_authenticated'
  | 'unknown'

export type OpenCodeExecutionProbeResult = {
  providerId: 'opencode'
  modelId: string
  probePrompt: string
  expectedOutput: string
  outcome: OpenCodeExecutionProbeOutcome
  reason: string | null
  durationMs: number
  rawStatus: OpenCodeSessionStatus | null
  durableState: OpenCodeDurableSessionState
  latestAssistantText: string | null
  latestAssistantPreview: string | null
  toolCallCount: number
  errorCount: number
  diagnostics: string[]
  failureCode?: 'prompt_start_failed' | 'execution_timeout'
  verifiedAt?: string
}

export type OpenCodeExecutionProofCredentialMode = 'api' | 'oauth' | 'none' | 'unknown'

export type OpenCodeExpectedBehaviorEvidence = {
  canonicalProjectPathFingerprint: string
  modelProviderId: string
  fullModelId: string
  projectBehaviorFingerprint: string
  effectiveConfigFingerprint: string
  effectiveSelectedAuthFingerprint: string
  expectedBehaviorFingerprint: string
}

export type OpenCodeExecutionProof = {
  schemaVersion: 1
  providerId: 'opencode'
  modelId: string
  projectPath: string
  profileRootKey: string
  projectBehaviorFingerprint: string
  managedConfigFingerprint: string
  managedAuthFingerprint: string | null
  binaryPath: string
  binaryFingerprint: string
  opencodeVersion: string | null
  capabilitySnapshotId: string | null
  credentialMode: OpenCodeExecutionProofCredentialMode
  reusable: boolean
  expectedBehaviorEvidence: OpenCodeExpectedBehaviorEvidence
  verifiedAt: string
  expiresAt: string
  proofHash: string
}

export type OpenCodeSessionReconcileSummary = {
  sessionId: string
  reconcileOutcome: 'reconciled' | 'stale'
  rawStatus: OpenCodeSessionStatus | null
  durableState: OpenCodeDurableSessionState
  staleReason: string | null
  profileAuthState: OpenCodeAuthState | null
  pendingPermissionRequestIds: string[]
  pendingPermissions?: OpenCodeNormalizedPermission[]
  messageCount: number
  toolCallCount: number
  errorCount: number
  lastCanonicalCursor: string | null
  latestUserMessageId: string | null
  latestAssistantMessageId: string | null
  latestAssistantText: string | null
  latestAssistantPreview: string | null
  replyPendingSinceMessageId: string | null
  messages: OpenCodeCanonicalMessage[]
  diagnostics: string[]
}

export type OpenCodeSessionPreviewSummary = {
  sessionId: string
  previewOutcome: 'observed' | 'stale' | 'stream_unavailable'
  staleReason: string | null
  profileAuthState: OpenCodeAuthState | null
  streamEndpoint: '/event' | '/global/event' | null
  streamConnected: boolean
  observedEventCount: number
  matchedEventCount: number
  runtimeState: OpenCodePreviewRuntimeState
  latestEventType: string | null
  latestAssistantMessageId: string | null
  latestAssistantPreview: string | null
  pendingPermissionRequestIds: string[]
  diagnostics: string[]
}

export type OpenCodeSessionRecord = {
  teamId: string
  laneId?: string
  memberName: string
  providerId: 'opencode'
  selectedModel: string
  selectedVariant?: string
  projectPath: string
  profileRootKey: string
  hostKey: string
  profileScope?: OpenCodeProfileScope | null
  toolApprovalMode?: OpenCodeToolApprovalMode
  runtimePid?: number
  resolvedBehaviorFingerprint: string | null
  opencodeSessionId: string
  lastCanonicalCursor: string | null
  lastKnownRawStatus: string | null
  lastKnownDurableState: OpenCodeDurableSessionState | null
  sourceAuthFingerprint: string | null
  managedAuthFingerprint: string | null
  projectBehaviorFingerprint: string
  managedConfigFingerprint?: string
  expectedBehaviorFingerprint?: string
  opencodeVersion?: string
  bootstrapMode?: OpenCodeBootstrapMode
  bootstrapEvidenceSource?: OpenCodeBootstrapEvidenceSource
  appManagedBootstrap?: OpenCodeAppManagedBootstrapRecord
  staleReason: string | null
  createdAt: string
  updatedAt: string
}
