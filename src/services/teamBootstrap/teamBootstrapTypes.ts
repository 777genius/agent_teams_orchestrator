import type { TeamBootstrapPhase } from './teamBootstrapStateMachine.js'

export type BootstrapProvider = 'anthropic' | 'codex' | 'gemini'

export type NativeAppManagedBootstrapSpec = {
  schemaVersion: 1
  mode: 'startup_context_file'
  contextText: string
  contextHash: string
  briefingHash: string
  generatedAt: string
}

/**
 * Final narrow per-member env patch applied after all inherited-auth env
 * transformations at spawn time. Values may contain secret literals and must
 * never be logged, persisted to diagnostics, or fed into request hashes.
 */
export type BootstrapMemberEnvPatch = import('../../utils/swarm/memberEnvPatch.js').MemberEnvPatch

/**
 * Per-member Codex provider overrides. These belong to the member's runtime,
 * not the lead's settings: when present they replace (never merge with) the
 * lead's codex settings namespace for that member's spawn.
 */
export type BootstrapMemberCodexSettings = {
  configOverrides?: string[]
  forcedLoginMethod?: 'api'
}

export type TeamBootstrapSpec = {
  version: 1
  runId: string
  mode: 'create' | 'launch'
  initiator: {
    kind: 'app' | 'tool'
    source: 'claude_team_agent_teams_orchestrator' | 'TeamBootstrap'
  }
  team: {
    name: string
    displayName?: string
    description?: string
    color?: string
    cwd: string
  }
  lead: {
    agentLanguage?: string
    permissionSeedTools?: string[]
  }
  members: Array<{
    name: string
    prompt?: string
    role?: string
    workflow?: string
    agentType?: string
    provider?: BootstrapProvider
    model?: string
    effort?: string
    isolation?: 'worktree'
    cwd?: string
    useSplitPane?: boolean
    planModeRequired?: boolean
    description?: string
    mcpConfigPath?: string
    mcpSettingSources?: string
    strictMcpConfig?: boolean
    nativeAppManagedBootstrap?: NativeAppManagedBootstrapSpec
    env?: BootstrapMemberEnvPatch
    codex?: BootstrapMemberCodexSettings
    gatewayUsageRef?: string
  }>
  launch?: {
    bootstrapTimeoutMs?: number
    continueOnPartialFailure?: boolean
  }
  ui?: {
    emitStructuredEvents?: boolean
  }
}

export type TeamBootstrapRequest = {
  version: 1
  runId: string
  requestHash: string
  mode: 'create' | 'launch'
  teamName: string
  teamDisplayName?: string
  description?: string
  color?: string
  cwd: string
  members: NormalizedBootstrapMember[]
  bootstrapTimeoutMs: number
  continueOnPartialFailure: boolean
  permissionSeedTools: string[]
  emitStructuredEvents: boolean
  policy: {
    persistentTeam: true
    registerForSessionCleanup: false
    writeConversationSummaryMessage: false
  }
  initiator: {
    kind: 'app' | 'tool'
    source: 'claude_team_agent_teams_orchestrator' | 'TeamBootstrap'
  }
}

export type NormalizedBootstrapMember = {
  originalName: string
  displayName: string
  normalizedName: string
  prompt: string
  role?: string
  workflow?: string
  agentType?: string
  provider?: BootstrapProvider
  model?: string
  effort?: string
  isolation?: 'worktree'
  cwd?: string
  useSplitPane?: boolean
  planModeRequired?: boolean
  description?: string
  mcpConfigPath?: string
  mcpSettingSources?: string
  strictMcpConfig?: boolean
  nativeAppManagedBootstrap?: NativeAppManagedBootstrapSpec
  env?: BootstrapMemberEnvPatch
  codex?: BootstrapMemberCodexSettings
  gatewayUsageRef?: string
}

export type BootstrapMemberLifecycleStatus =
  | 'pending'
  | 'spawn_started'
  | 'registered'
  | 'runtime_alive'
  | 'bootstrap_confirmed'
  | 'failed'
  | 'unverifiable'

export type BootstrapMemberState = {
  name: string
  logicalIdentity: string
  desiredRole?: string
  status: BootstrapMemberLifecycleStatus
  lastAttemptAt?: number
  lastObservedAt?: number
  failureReason?: string
  agentId?: string
  backendType?: string
  runtimePid?: number
  /** Opaque usage identity marker for later usage accounting. Never a secret. */
  gatewayUsageRef?: string
}

export type TeamBootstrapSummary = {
  runId: string
  requestHash: string
  teamName: string
  mode: 'create' | 'launch'
  createdTeam: boolean
  reusedExistingTeam: boolean
  expectedMembers: string[]
  registeredMembers: string[]
  failedMembers: Array<{ name: string; reason: string }>
  terminalStatus: 'completed' | 'partial_success' | 'failed' | 'canceled'
}

export type TeamBootstrapResult =
  | { ok: true; fatal: false; summary: TeamBootstrapSummary }
  | { ok: false; fatal: true; error: string; summary?: TeamBootstrapSummary }

export type PersistedBootstrapState = {
  version: 1
  runId: string
  requestHash: string
  teamName: string
  mode: 'create' | 'launch'
  ownerPid?: number
  ownerStartedAt?: number
  phase: TeamBootstrapPhase
  phaseEnteredAt: number
  startedAt: number
  updatedAt: number
  realTaskSubmissionState: 'not_submitted' | 'submitted' | 'unknown'
  members: BootstrapMemberState[]
  terminal?: {
    status: 'completed' | 'partial_success' | 'failed' | 'canceled'
    reason?: string
    finishedAt: number
  }
}
