import type {
  OpenCodeOperationPolicy,
  OpenCodeOperationPurpose,
} from './OpenCodeOperationPolicy.js'

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
}

/** Required, fail-closed input for the additive provider-scoped runtime path. */
export type OpenCodeScopedProfilePlan = {
  purpose: OpenCodeOperationPurpose
  providerId?: string | null
  modelId?: string | null
  runtimeInstanceId: string
  projectPath?: string | null
  abortSignal?: AbortSignal
}

export type OpenCodeCurrentScopedProfilePlan = Omit<
  OpenCodeScopedProfilePlan,
  'providerId' | 'modelId' | 'projectPath' | 'abortSignal'
> & {
  providerId: string
  modelId: string | null
  projectPath: string
  evidence: OpenCodeScopedProfilePlanningEvidence
}

/**
 * Immutable evidence supplied to the pure scoped planner.  Values which can
 * contain credentials are accepted only as already-redacted SHA-256 digests;
 * the returned plan can therefore be logged or compared without retaining
 * provider material.
 */
export type OpenCodeScopedProfilePlanningEvidence = {
  canonicalProjectPathFingerprint: string
  projectBehaviorFingerprint: string
  providerEnvironmentFingerprint: string
  selectedAuthFingerprint: string
  binaryFingerprint: string
  configFingerprint: string
  nativeAccountIdentityFingerprint: string
  nativeAccountIdentitySource: 'official-provider-cli' | 'managed-auth'
  nativeTargetExecutableFingerprint: string
  profileLayoutFingerprint: string
  /** Digest of the synchronously captured automatic user-plugin file manifest. */
  automaticUserPluginFingerprint?: string
  plugins: readonly {
    spec: string
    /** Name read from the locally resolved root manifest; never inferred from mutable spec syntax. */
    packageName?: string
    provenance: 'user' | 'project' | 'environment' | 'app-managed'
    /** Exact immutable package/local tree bytes, including transitive dependencies. */
    dependencyTreeFingerprint: string
    /** Canonical tagged SHA-256 of the immutable resolved package identity. */
    resolvedIdentity: string
    /** Fake/caller-captured regular files relative to a node_modules snapshot root. */
    immutableTreeEntries: readonly {
      path: string
      bytesBase64: string
      mode: 0o400 | 0o500
    }[]
  }[]
}

export type OpenCodePlanScopedProfileInput = Omit<OpenCodeScopedProfilePlan, 'abortSignal'> & {
  abortSignal?: never
  evidence: OpenCodeScopedProfilePlanningEvidence
}

/** Preparation carries cancellation beside the immutable input consumed by the pure planner. */
export type OpenCodeScopedProfilePreparationInput = Omit<
  OpenCodePlanScopedProfileInput,
  'abortSignal'
> & { abortSignal?: AbortSignal; deadlineAtMs?: number }

/** Pure, redacted and read-only contract passed from planning to preparation. */
export type OpenCodeScopedProfilePlanContract = {
  schema: 'opencode-scoped-profile-plan-v1'
  purpose: OpenCodeOperationPurpose
  providerId: string
  modelId: string | null
  canonicalProjectPathFingerprint: string
  projectBehaviorFingerprint: string
  providerEnvironmentFingerprint: string
  selectedAuthFingerprint: string
  binaryFingerprint: string
  configFingerprint: string
  nativeAccountIdentityFingerprint: string
  nativeAccountIdentitySource: 'official-provider-cli' | 'managed-auth'
  nativeTargetExecutableFingerprint: string
  profileLayoutFingerprint: string
  automaticUserPluginFingerprint: string
  plugins: readonly {
    spec: string
    packageName: string
    provenance: 'user' | 'project' | 'environment' | 'app-managed'
    dependencyTreeFingerprint: string
    packageIntegrity: string
    manifestFingerprint: string
    lockBindingFingerprint: string
    resolvedIdentity: string
    executionSpecifier: string
  }[]
  pluginFingerprint: string
  cacheFingerprint: string
  profileFingerprint: string
  operationFingerprint: string
  accountFingerprint: string
  digest: string
  expectedHostKey: string
}

export type OpenCodePreparedProfile = {
  projectPath: string
  profileRootKey: string
  profileRootPath: string
  projectDefaultModelId?: string | null
  allProjectsDefaultModelId?: string | null
  importedConfigDefaultModelId?: string | null
  effectiveManagedDefaultModelId?: string | null
  effectiveManagedDefaultSource?: 'project' | 'all_projects' | null
  projectBehaviorFingerprint: string
  behaviorSources: string[]
  managedConfig: Record<string, unknown>
  managedConfigFingerprint: string
  /** Present when preparation captured the provider-facing environment. */
  providerEnvironmentFingerprint?: string
  /** Present when preparation resolved and fingerprinted the executable bytes. */
  binaryFingerprint?: string
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
  authState: OpenCodeAuthState
  env: NodeJS.ProcessEnv
}

/** Legacy compatibility profiles cannot carry scoped-policy proof fields. */
export type OpenCodeCompatibilityPreparedProfile = OpenCodePreparedProfile & {
  scopeSchema?: never
}

/**
 * A policy-proven profile. Compatibility profiles deliberately cannot satisfy
 * this type, which prevents scoped hosts from silently falling back to legacy
 * caller-controlled behavior.
 */
export type OpenCodeScopedPreparedProfile = OpenCodePreparedProfile & {
  scopeSchema: 'opencode-scoped-profile-v1'
  policy: OpenCodeOperationPolicy
  purpose: OpenCodeOperationPurpose
  providerId: string | null
  modelId: string | null
  runtimeInstanceId: string
  /** Digest of the canonical project path, distinct from project behavior bytes. */
  canonicalProjectPathFingerprint: string
  /** Immutable mirror used as the scoped host cwd; original-project discovery is forbidden. */
  executionProjectPath: string
  operationKey: string
  profileKey: string
  pluginKey: string
  cacheKey: string
  profileScopeIdentity: string
  selectedAuthBaselineFingerprint: string
  providerEnvironmentFingerprint: string
  nativeCredentialBridgeInputFingerprint: string
  nativeCredentialBridgeFingerprint: string
  /** Digest of the resolved native CLI target bytes, never the target bytes themselves. */
  nativeTargetExecutableFingerprint: string
  nativeTargetExecutablePath: string | null
  nativeCredentialHostHomePath: string | null
  /** Digest of allowlisted native account/credential artifacts; raw credentials are never retained. */
  nativeAccountEvidenceFingerprint: string
  /** Digest of every final child environment key/value after all derived values are installed. */
  executionEnvironmentFingerprint: string
  /** Immutable source snapshot used to fail closed if project/plugin inputs change after prepare. */
  expectedEntryManifest: {
    projectBehaviorFingerprint: string
    projectBehaviorSnapshotPath: string
    projectBehaviorEntryManifest: string[]
    userPluginDirectory: string
    userPluginEntries: string[]
    pluginConfigs: Array<{ path: string; provenance: 'user' | 'project' | 'environment' }>
    preservedPlugins: Array<{ spec: string; provenance: 'user' | 'project' | 'environment' }>
    preservedPluginsFingerprint: string
    inlinePluginsFingerprint: string
    pluginDependencyFingerprint?: string | null
    pluginDependencyEntries?: string[]
  }
  expectedEntryManifestFingerprint: string
  automaticUserPluginFingerprint: string
  binaryPath: string
  binaryFingerprint: string
  pluginNodeModulesPath: string
  preparationLockPath: string
  profileLayoutGeneration: string
  /** Attempt-local catalog filesystem identity bound into scopedPlanDigest. */
  catalogAttemptPlan: {
    schema: 'opencode-catalog-attempt-plan-v1'
    basePlanDigest: string
    runtimeInstanceId: string
    profileRootKey: string
    profileRootPath: string
    configDirectory: string
  } | null
  /** Digest of the mandatory pure plan/materialize contract. */
  scopedPlanDigest: string
  /** Canonical host key produced by that pure plan. */
  plannedHostKey: string
  nativeCredentialBridge: {
    providerId: 'kiro' | 'cursor-acp'
    binPath: string
    executablePath: string
  } | null
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
  /** Native process-generation authority (Linux boot id + /proc starttime). */
  processBirthToken?: string | null
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

export type OpenCodeInventoryEvidenceState = 'complete' | 'partial' | 'skipped' | 'failed'

export type OpenCodeInventoryEvidenceDimension<Provenance extends string> = {
  state: OpenCodeInventoryEvidenceState
  provenance: Provenance
}

/**
 * Per-dimension authority carried by active inventory. Empty arrays are only
 * authoritative when their corresponding dimension is complete.
 */
export type OpenCodeInventoryCompleteness = {
  profileConfig: OpenCodeInventoryEvidenceDimension<'managed_profile'>
  managedAuth: OpenCodeInventoryEvidenceDimension<'managed_auth_store'>
  environmentAuth: OpenCodeInventoryEvidenceDimension<'provider_environment'>
  providerInventory: OpenCodeInventoryEvidenceDimension<'provider_cli'>
  modelCatalog: OpenCodeInventoryEvidenceDimension<'model_cli'>
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
  /** Required from production probes; optional only for legacy/test adapters. */
  completeness?: OpenCodeInventoryCompleteness
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
  /** Require selected models to be affirmatively verified by the live profile catalog. */
  profileLiveModelVerification?: boolean
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

export type OpenCodeExecutionProbeFailureCode =
  | 'prompt_start_failed'
  | 'execution_timeout'
  | 'provider_endpoint_unreachable'
  | 'definitive_auth_rejected'
  | 'execution_identity_unverified'
  | 'uncertain_provider_rejection'

export type OpenCodeExecutionProbeResult = {
  providerId: 'opencode'
  modelId: string
  /** Exact provider metadata reported by the assistant message, when present. */
  observedProviderId?: string | null
  /** Exact provider-local model metadata reported by the assistant message, when present. */
  observedModelId?: string | null
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
  failureCode?: OpenCodeExecutionProbeFailureCode
  verifiedAt?: string
}

export type OpenCodeExecutionProofCredentialMode = 'api' | 'oauth' | 'none' | 'unknown'

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
  version: 2
  teamId: string
  laneId?: string
  memberName: string
  providerId: 'opencode'
  selectedModel: string
  selectedVariant?: string
  /** Canonical, persisted authority identity. It must equal projectPath. */
  projectIdentity: string
  projectPath: string
  /** Exact launch owner. Null is reserved for explicitly migrated legacy records. */
  runId: string | null
  profileRootKey: string
  hostKey: string
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
  opencodeVersion?: string
  bootstrapMode?: OpenCodeBootstrapMode
  bootstrapEvidenceSource?: OpenCodeBootstrapEvidenceSource
  appManagedBootstrap?: OpenCodeAppManagedBootstrapRecord
  /**
   * Durable refresh hand-off. Publication installs this atomically with the
   * successor; only exact successor/attempt CAS operations may advance or
   * remove it.
   */
  successorTransition?: OpenCodeSessionSuccessorTransition
  staleReason: string | null
  createdAt: string
  updatedAt: string
}

export type OpenCodeSessionSuccessorTransition = {
  version: 1
  attemptIdentity: string
  phase: 'successor_lease_pending' | 'predecessor_release_pending' | 'transition_complete'
  predecessorHostKey: string
  predecessorOpencodeSessionId: string
  predecessorRunId: string | null
}
