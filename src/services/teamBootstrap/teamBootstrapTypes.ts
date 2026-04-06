import type { TeamBootstrapPhase } from './teamBootstrapStateMachine.js'

export type BootstrapProvider = 'anthropic' | 'codex' | 'gemini'

export type TeamBootstrapSpec = {
  version: 1
  runId: string
  mode: 'create' | 'launch'
  initiator: {
    kind: 'app' | 'tool'
    source: 'claude_team_freecode' | 'TeamBootstrap'
  }
  team: {
    name: string
    displayName?: string
    description?: string
    color?: string
    cwd: string
  }
  lead: {
    providerId?: BootstrapProvider
    model?: string
    effort?: string
    agentLanguage?: string
    skipPermissions?: boolean
    worktree?: string | null
    extraCliArgs?: string[]
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
    cwd?: string
    useSplitPane?: boolean
    planModeRequired?: boolean
    description?: string
  }>
  launch?: {
    initialUserPrompt?: string | null
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
  policy: {
    persistentTeam: true
    registerForSessionCleanup: false
    writeConversationSummaryMessage: false
  }
  initiator: {
    kind: 'app' | 'tool'
    source: 'claude_team_freecode' | 'TeamBootstrap'
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
  cwd?: string
  useSplitPane?: boolean
  planModeRequired?: boolean
  description?: string
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
