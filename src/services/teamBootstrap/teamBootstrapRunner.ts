import * as fs from 'fs/promises'
import { getSessionId } from 'src/bootstrap/state.js'
import type { ToolUseContext } from 'src/Tool.js'
import { TeamCreateTool } from 'src/tools/TeamCreateTool/TeamCreateTool.js'
import type { DuplicateSkippedOutput } from 'src/tools/shared/spawnMultiAgent.js'
import {
  hasBootstrapConfirmation,
  spawnTeammate,
} from 'src/tools/shared/spawnMultiAgent.js'
import { getCwd } from 'src/utils/cwd.js'
import { errorMessage } from 'src/utils/errors.js'
import { addPermissionRulesToSettings } from 'src/utils/permissions/permissionsLoader.js'
import { sleep } from 'src/utils/sleep.js'
import { logForDebugging } from 'src/utils/debug.js'
import { setLeaderTeamName } from 'src/utils/tasks.js'
import { assignTeammateColor } from 'src/utils/swarm/teammateLayoutManager.js'
import {
  getTeamFilePath,
  readTeamFileAsync,
  sanitizeName,
  unregisterTeamForSessionCleanup,
  updateTeamFileAsync,
} from 'src/utils/swarm/teamHelpers.js'
import {
  getTeammateRuntimePaths,
  readRecentTeammateRuntimeEvents,
  type TeammateRuntimeEvent,
} from 'src/utils/swarm/teammateRuntimeEvents.js'
import type { TeamBootstrapProgressSink } from './teamBootstrapEvents.js'
import { withBootstrapOwnershipLock } from './teamBootstrapLock.js'
import { getBootstrapSpawnDelayMs } from './teamBootstrapSpawnSchedule.js'
import { normalizeBootstrapModelSelection } from './teamBootstrapModelSelection.js'
import { TeamBootstrapStateStore } from './teamBootstrapStateStore.js'
import {
  assertStableTeamBootstrapRuntimeIdentity,
  getCurrentTeamBootstrapRuntimeIdentity,
} from './teamBootstrapRuntimeIdentity.js'
import type {
  TeamBootstrapRequest,
  TeamBootstrapResult,
  TeamBootstrapSummary,
} from './teamBootstrapTypes.js'

type TeamCreateCall = (
  input: {
    team_name: string
    description?: string
    agent_type?: string
  },
  context: ToolUseContext,
) => Promise<unknown>

export type TeamBootstrapRunnerDeps = {
  readTeamFileAsync: typeof readTeamFileAsync
  updateTeamFileAsync: typeof updateTeamFileAsync
  unregisterTeamForSessionCleanup: typeof unregisterTeamForSessionCleanup
  spawnTeammate: typeof spawnTeammate
  teamCreateCall: TeamCreateCall
}

type SpawnTeammateInput = Parameters<TeamBootstrapRunnerDeps['spawnTeammate']>[0]
type SpawnTeammateResult = Awaited<ReturnType<TeamBootstrapRunnerDeps['spawnTeammate']>>

const TRANSIENT_STARTUP_RETRY_LIMIT = 1
const TRANSIENT_STARTUP_RETRY_DELAY_MS = 2_000
const TRANSIENT_STARTUP_RETRY_MIN_REMAINING_BUDGET_MS = 15_000
const DEFAULT_BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_MS = 180_000
const BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_ENV =
  'CLAUDE_TEAM_BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_MS'
const BOOTSTRAP_SUBMITTED_EVENT_FUTURE_TOLERANCE_MS = 5_000

let testDeps: Partial<TeamBootstrapRunnerDeps> | null = null

export function __setTeamBootstrapRunnerDepsForTests(
  deps: Partial<TeamBootstrapRunnerDeps> | null,
): void {
  testDeps = deps
}

function getTeamBootstrapRunnerDeps(): TeamBootstrapRunnerDeps {
  return {
    readTeamFileAsync: testDeps?.readTeamFileAsync ?? readTeamFileAsync,
    updateTeamFileAsync: testDeps?.updateTeamFileAsync ?? updateTeamFileAsync,
    unregisterTeamForSessionCleanup:
      testDeps?.unregisterTeamForSessionCleanup ?? unregisterTeamForSessionCleanup,
    spawnTeammate: testDeps?.spawnTeammate ?? spawnTeammate,
    teamCreateCall:
      testDeps?.teamCreateCall
      ?? ((input, context) =>
        (TeamCreateTool.call as unknown as TeamCreateCall)(input, context)),
  }
}

function isRetryableTransientStartupFailure(error: unknown): boolean {
  const message = errorMessage(error)
  return (
    message.includes('did not become runtime_ready: teammate process exited before runtime_ready') ||
    message.includes('did not become runtime_ready: timed out waiting for runtime_ready')
  )
}

async function spawnTeammateWithTransientStartupRetry(params: {
  deps: TeamBootstrapRunnerDeps
  context: ToolUseContext
  teamName: string
  memberName: string
  buildInput: () => SpawnTeammateInput
  remainingBudgetMs: () => number
}): Promise<SpawnTeammateResult> {
  let attempt = 0

  while (true) {
    try {
      return await params.deps.spawnTeammate(params.buildInput(), params.context)
    } catch (error) {
      const remainingMs = params.remainingBudgetMs()
      if (
        attempt >= TRANSIENT_STARTUP_RETRY_LIMIT ||
        remainingMs <= TRANSIENT_STARTUP_RETRY_MIN_REMAINING_BUDGET_MS ||
        !isRetryableTransientStartupFailure(error)
      ) {
        throw error
      }

      attempt += 1
      const delayMs = Math.min(
        TRANSIENT_STARTUP_RETRY_DELAY_MS,
        Math.max(1, remainingMs - TRANSIENT_STARTUP_RETRY_MIN_REMAINING_BUDGET_MS),
      )
      logForDebugging(
        `[team-bootstrap] retrying transient startup failure for teammate "${params.memberName}" in team "${params.teamName}" after ${delayMs}ms: ${errorMessage(error)}`,
        { level: 'warn' },
      )
      await sleep(delayMs)
    }
  }
}

export function shouldCreateTeamForBootstrap(params: {
  mode: TeamBootstrapRequest['mode']
  attachState: 'already_attached' | 'attached_existing' | 'missing'
  teamName: string
}): boolean {
  if (params.attachState !== 'missing') {
    return false
  }
  if (params.mode === 'launch') {
    throw new Error(
      `Deterministic bootstrap cannot launch team "${params.teamName}" because the team config does not exist.`,
    )
  }
  return true
}

export async function assertBootstrapRuntimeWorkspace(
  request: Pick<TeamBootstrapRequest, 'teamName' | 'cwd'>,
  stage?: string,
): Promise<void> {
  let runtimeCwd: string
  try {
    runtimeCwd = await fs.realpath(getCwd())
  } catch (error) {
    throw new Error(
      `Deterministic bootstrap cannot start team "${request.teamName}"${stage ? ` ${stage}` : ''} because the lead runtime workspace is unavailable: ${errorMessage(error)}`,
    )
  }
  if (runtimeCwd !== request.cwd) {
    throw new Error(
      `Deterministic bootstrap cannot start team "${request.teamName}"${stage ? ` ${stage}` : ''} because the runtime workspace "${runtimeCwd}" does not match the requested workspace "${request.cwd}".`,
    )
  }
}

export async function emitBootstrapProgressSafely(
  label: string,
  emit: () => Promise<void>,
): Promise<void> {
  try {
    await emit()
  } catch (error) {
    logForDebugging(
      `[team-bootstrap] progress emission failed for ${label}: ${errorMessage(error)}`,
      { level: 'warn' },
    )
  }
}

export function assertBootstrapTimeoutBudget(params: {
  teamName: string
  startedAtMs: number
  timeoutMs: number
  monotonicNowMs?: number
  stage?: string
}): void {
  const elapsedMs = (params.monotonicNowMs ?? performance.now()) - params.startedAtMs
  if (elapsedMs <= params.timeoutMs) {
    return
  }
  const roundedElapsedMs = Math.max(0, Math.round(elapsedMs))
  throw new Error(
    `Deterministic bootstrap for "${params.teamName}" timed out${params.stage ? ` ${params.stage}` : ''} after ${roundedElapsedMs}ms (budget ${params.timeoutMs}ms).`,
  )
}

export function deriveBootstrapTerminalStatus(params: {
  continueOnPartialFailure: boolean
  failedMembersCount: number
  registeredMembersCount: number
}): TeamBootstrapSummary['terminalStatus'] {
  if (params.failedMembersCount <= 0) {
    return 'completed'
  }
  if (!params.continueOnPartialFailure || params.registeredMembersCount <= 0) {
    return 'failed'
  }
  return 'partial_success'
}

function buildBootstrapFailureReason(params: {
  teamName: string
  continueOnPartialFailure: boolean
  failedMembers: Array<{ name: string; reason: string }>
}): string {
  const preview = params.failedMembers
    .slice(0, 3)
    .map(member => `${member.name}: ${member.reason}`)
    .join('; ')
  const suffix =
    params.failedMembers.length > 3
      ? ` (+${params.failedMembers.length - 3} more)`
      : ''
  const policyReason = params.continueOnPartialFailure
    ? 'no teammates were bootstrap-confirmed'
    : 'continueOnPartialFailure=false'
  return preview.length > 0
    ? `Deterministic bootstrap for "${params.teamName}" failed because teammate startup failed and ${policyReason}. ${preview}${suffix}`
    : `Deterministic bootstrap for "${params.teamName}" failed because teammate startup failed and ${policyReason}.`
}

function seedBootstrapPermissionRules(params: {
  teamName: string
  permissionSeedTools: string[]
}): void {
  if (params.permissionSeedTools.length === 0) {
    return
  }

  try {
    const applied = addPermissionRulesToSettings(
      {
        ruleValues: params.permissionSeedTools.map(toolName => ({ toolName })),
        ruleBehavior: 'allow',
      },
      'localSettings',
    )
    if (!applied) {
      logForDebugging(
        `[team-bootstrap] ${params.teamName}: local permission seeding skipped by settings policy`,
        { level: 'warn' },
      )
    }
  } catch (error) {
    logForDebugging(
      `[team-bootstrap] ${params.teamName}: failed to seed teammate operational permission rules: ${errorMessage(error)}`,
      { level: 'warn' },
    )
  }
}

async function ensureLeaderAttachedToTeam(
  request: TeamBootstrapRequest,
  context: ToolUseContext,
  deps: Pick<
    TeamBootstrapRunnerDeps,
    'readTeamFileAsync' | 'updateTeamFileAsync' | 'unregisterTeamForSessionCleanup'
  >,
): Promise<'already_attached' | 'attached_existing' | 'missing'> {
  const currentTeamName = context.getAppState().teamContext?.teamName
  if (currentTeamName === request.teamName) {
    deps.unregisterTeamForSessionCleanup(request.teamName)
    setLeaderTeamName(sanitizeName(request.teamName))
    return 'already_attached'
  }

  const existingTeam = await deps.readTeamFileAsync(request.teamName)
  if (!existingTeam) {
    return 'missing'
  }

  await deps.updateTeamFileAsync(request.teamName, teamFile => {
    const nextMembers = teamFile.members.map(member =>
      member.agentId === teamFile.leadAgentId
        ? {
            ...member,
            sessionId: getSessionId(),
            cwd: request.cwd,
          }
        : member,
    )
    const nextTeamFile = {
      ...teamFile,
      leadSessionId: getSessionId(),
      members: nextMembers,
    }
    const changed =
      nextTeamFile.leadSessionId !== teamFile.leadSessionId ||
      nextTeamFile.members.some(
        (member, index) =>
          member.sessionId !== teamFile.members[index]?.sessionId ||
          member.cwd !== teamFile.members[index]?.cwd,
      )
    return {
      changed,
      teamFile: changed ? nextTeamFile : teamFile,
    }
  })

  const refreshedTeam = (await deps.readTeamFileAsync(request.teamName)) ?? existingTeam
  const teamFilePath = getTeamFilePath(request.teamName)
  setLeaderTeamName(sanitizeName(request.teamName))
  context.setAppState(prev => ({
    ...prev,
    teamContext: {
      teamName: request.teamName,
      teamFilePath,
      leadAgentId: refreshedTeam.leadAgentId,
      teammates: Object.fromEntries(
        refreshedTeam.members.map(member => [
          member.agentId,
          {
            name: member.name,
            agentType: member.agentType,
            color: member.color ?? assignTeammateColor(member.agentId),
            tmuxSessionName: '',
            tmuxPaneId: member.tmuxPaneId ?? '',
            cwd: member.cwd || getCwd(),
            worktreePath: member.worktreePath,
            spawnedAt: member.joinedAt,
          },
        ]),
      ),
    },
  }))
  return 'attached_existing'
}

function assertPrimaryBootstrapProviderSupported(member: TeamBootstrapRequest['members'][number]): void {
  const provider = member.provider
  if (!provider || provider === 'anthropic' || provider === 'codex' || provider === 'gemini') {
    return
  }
  throw new Error(
    `Provider "${provider}" cannot be launched in primary bootstrap. OpenCode teammates must use secondary OpenCode runtime lanes.`,
  )
}

function resolveBootstrapSubmittedConfirmationTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return DEFAULT_BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_MS
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_MS
  }

  const normalized = Math.floor(parsed)
  return normalized > 0
    ? normalized
    : DEFAULT_BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_MS
}

function formatBootstrapTimeoutMs(timeoutMs: number): string {
  if (timeoutMs >= 60_000 && timeoutMs % 60_000 === 0) {
    return `${timeoutMs / 60_000}m`
  }
  if (timeoutMs >= 1_000 && timeoutMs % 1_000 === 0) {
    return `${timeoutMs / 1_000}s`
  }
  return `${timeoutMs}ms`
}

function resolveBootstrapSubmittedElapsedAtObservationMs(params: {
  submittedTimestamp: string
  observedWallNowMs: number
  bootstrapExpectedAfter?: string | null
}): number {
  const submittedAtMs = Date.parse(params.submittedTimestamp)
  if (!Number.isFinite(submittedAtMs)) {
    return 0
  }

  if (
    submittedAtMs >
    params.observedWallNowMs + BOOTSTRAP_SUBMITTED_EVENT_FUTURE_TOLERANCE_MS
  ) {
    return 0
  }

  if (params.bootstrapExpectedAfter) {
    const boundaryMs = Date.parse(params.bootstrapExpectedAfter)
    if (Number.isFinite(boundaryMs) && submittedAtMs < boundaryMs) {
      return 0
    }
  }

  return Math.max(0, params.observedWallNowMs - submittedAtMs)
}

function resolveBootstrapSubmittedElapsedMs(params: {
  elapsedAtObservationMs: number
  observedAtMs: number
  observedNowMs: number
}): number {
  return Math.max(
    0,
    params.elapsedAtObservationMs + params.observedNowMs - params.observedAtMs,
  )
}

export function __resolveBootstrapSubmittedElapsedForTests(params: {
  submittedTimestamp: string
  observedWallNowMs: number
  observedAtMs: number
  observedNowMs: number
  bootstrapExpectedAfter?: string | null
}): number {
  const elapsedAtObservationMs =
    resolveBootstrapSubmittedElapsedAtObservationMs({
      submittedTimestamp: params.submittedTimestamp,
      observedWallNowMs: params.observedWallNowMs,
      bootstrapExpectedAfter: params.bootstrapExpectedAfter,
    })
  return resolveBootstrapSubmittedElapsedMs({
    elapsedAtObservationMs,
    observedAtMs: params.observedAtMs,
    observedNowMs: params.observedNowMs,
  })
}

function buildSummary(params: {
  request: TeamBootstrapRequest
  reusedExistingTeam: boolean
  failedMembers: Array<{ name: string; reason: string }>
  registeredMembers: string[]
}): TeamBootstrapSummary {
  return {
    runId: params.request.runId,
    requestHash: params.request.requestHash,
    teamName: params.request.teamName,
    mode: params.request.mode,
    createdTeam: !params.reusedExistingTeam,
    reusedExistingTeam: params.reusedExistingTeam,
    expectedMembers: params.request.members.map(member => member.displayName),
    registeredMembers: params.registeredMembers,
    failedMembers: params.failedMembers,
    terminalStatus: deriveBootstrapTerminalStatus({
      continueOnPartialFailure: params.request.continueOnPartialFailure,
      failedMembersCount: params.failedMembers.length,
      registeredMembersCount: params.registeredMembers.length,
    }),
  }
}

function isCurrentProcessBootstrapEvent(
  event: TeammateRuntimeEvent,
  params: {
    teamName: string
    memberName: string
    runtimePid?: number
    bootstrapRunId?: string | null
    bootstrapExpectedAfter?: string | null
  },
): boolean {
  if (event.teamName && event.teamName !== params.teamName) {
    return false
  }
  if (event.agentName && event.agentName !== params.memberName) {
    return false
  }
  if (typeof params.runtimePid === 'number' && event.pid !== params.runtimePid) {
    return false
  }
  if (
    params.bootstrapRunId &&
    event.bootstrapRunId &&
    event.bootstrapRunId !== params.bootstrapRunId
  ) {
    return false
  }
  if (params.bootstrapExpectedAfter) {
    const boundaryMs = Date.parse(params.bootstrapExpectedAfter)
    if (Number.isFinite(boundaryMs)) {
      const eventMs = Date.parse(event.timestamp)
      if (!Number.isFinite(eventMs) || eventMs < boundaryMs) {
        return false
      }
    }
  }
  return true
}

function isTerminalProcessBootstrapTransportEvent(
  event: TeammateRuntimeEvent,
): boolean {
  if (event.type === 'failed' || event.type === 'exited') {
    return true
  }
  if (event.type === 'bootstrap_submit_accepted_without_uuid') {
    return true
  }
  return event.type === 'bootstrap_submit_rejected' && event.retryable === false
}

function isBootstrapTransportStageEvent(event: TeammateRuntimeEvent): boolean {
  return (
    event.type === 'process_spawned' ||
    event.type === 'stdout_attached' ||
    event.type === 'cli_started' ||
    event.type === 'startup_checkpoint' ||
    event.type === 'runtime_ready' ||
    event.type === 'inbox_poller_ready' ||
    event.type === 'mailbox_bootstrap_written' ||
    event.type === 'bootstrap_prompt_observed' ||
    event.type === 'bootstrap_submit_attempted' ||
    event.type === 'bootstrap_submit_deferred' ||
    event.type === 'bootstrap_submit_rejected' ||
    event.type === 'bootstrap_submit_accepted_without_uuid' ||
    event.type === 'bootstrap_submitted' ||
    event.type === 'failed' ||
    event.type === 'exited'
  )
}

function describeBootstrapTransportStage(event: TeammateRuntimeEvent): string {
  return event.detail ? `${event.type}: ${event.detail}` : event.type
}

function describeTerminalBootstrapFailure(event: TeammateRuntimeEvent): string {
  return event.detail ?? `Runtime transport failed before bootstrap confirmation: ${event.type}`
}

async function readProcessBootstrapRuntimeEvents(params: {
  teamName: string
  memberName: string
  backendType?: string
  runtimePid?: number
  bootstrapRunId?: string | null
  bootstrapExpectedAfter?: string | null
}): Promise<TeammateRuntimeEvent[]> {
  if (params.backendType !== 'process') {
    return []
  }

  const eventsPath = getTeammateRuntimePaths({
    teamName: params.teamName,
    agentName: params.memberName,
  }).eventsPath
  const events = await readRecentTeammateRuntimeEvents(eventsPath)
  return events.filter(event => isCurrentProcessBootstrapEvent(event, params))
}

async function readBootstrapRuntimeFailure(params: {
  teamName: string
  memberName: string
  backendType?: string
  runtimePid?: number
  bootstrapRunId?: string | null
  bootstrapExpectedAfter?: string | null
}): Promise<string | null> {
  const failure = [
    ...(await readProcessBootstrapRuntimeEvents(params)),
  ].reverse().find(isTerminalProcessBootstrapTransportEvent)

  return failure ? describeTerminalBootstrapFailure(failure) : null
}

async function readLastBootstrapTransportStage(params: {
  teamName: string
  memberName: string
  backendType?: string
  runtimePid?: number
  bootstrapRunId?: string | null
  bootstrapExpectedAfter?: string | null
}): Promise<string | null> {
  const lastStage = [
    ...(await readProcessBootstrapRuntimeEvents(params)),
  ].reverse().find(isBootstrapTransportStageEvent)

  return lastStage ? describeBootstrapTransportStage(lastStage) : null
}

async function readLastBootstrapSubmittedStage(params: {
  teamName: string
  memberName: string
  backendType?: string
  runtimePid?: number
  bootstrapRunId?: string | null
  bootstrapExpectedAfter?: string | null
}): Promise<{ stage: string; timestamp: string } | null> {
  const submitted = [
    ...(await readProcessBootstrapRuntimeEvents(params)),
  ].reverse().find(event => event.type === 'bootstrap_submitted')

  return submitted
    ? {
        stage: describeBootstrapTransportStage(submitted),
        timestamp: submitted.timestamp,
      }
    : null
}

async function waitForRequiredBootstrapConfirmations(params: {
  request: TeamBootstrapRequest
  stateStore: TeamBootstrapStateStore
  failedMembers: Array<{ name: string; reason: string }>
  membersByName: Map<
    string,
    {
      agentId?: string
      bootstrapExpectedAfter?: string | null
      backendType?: string
      runtimePid?: number
      bootstrapRunId?: string | null
    }
  >
  timeoutStartedAt: number
  monotonicNow: () => number
  now: () => number
}): Promise<string[]> {
  const submittedConfirmationTimeoutMs =
    resolveBootstrapSubmittedConfirmationTimeoutMs()
  const pending = new Map<
    string,
    {
      agentId: string
      bootstrapExpectedAfter?: string | null
      backendType?: string
      runtimePid?: number
      bootstrapRunId?: string | null
      bootstrapSubmittedObservedAtMs?: number
      bootstrapSubmittedElapsedAtObservedMs?: number
      bootstrapSubmittedEventTimestamp?: string
      bootstrapSubmittedStage?: string
    }
  >()
  const confirmedMembers = new Set<string>()

  for (const member of params.request.members) {
    const registered = params.membersByName.get(member.displayName)
    const agentId = registered?.agentId
    if (!agentId) {
      continue
    }
    pending.set(member.displayName, {
      agentId,
      bootstrapExpectedAfter: registered.bootstrapExpectedAfter ?? null,
      backendType: registered.backendType,
      runtimePid: registered.runtimePid,
      bootstrapRunId: registered.bootstrapRunId,
    })
  }

  while (pending.size > 0) {
    for (const [memberName, pendingMember] of [...pending]) {
      if (
        await hasBootstrapConfirmation(
          params.request.teamName,
          pendingMember.agentId,
          pendingMember.bootstrapExpectedAfter,
          memberName,
        )
      ) {
        pending.delete(memberName)
        confirmedMembers.add(memberName)
        await params.stateStore.markMemberResult(
          memberName,
          {
            status: 'bootstrap_confirmed',
            agentId: pendingMember.agentId,
          },
          params.now,
        )
        continue
      }

      const runtimeFailure = await readBootstrapRuntimeFailure({
        teamName: params.request.teamName,
        memberName,
        backendType: pendingMember.backendType,
        runtimePid: pendingMember.runtimePid,
        bootstrapRunId: pendingMember.bootstrapRunId,
        bootstrapExpectedAfter: pendingMember.bootstrapExpectedAfter,
      })
      if (runtimeFailure) {
        pending.delete(memberName)
        if (
          !params.failedMembers.some(failed => failed.name === memberName)
        ) {
          params.failedMembers.push({ name: memberName, reason: runtimeFailure })
        }
        await params.stateStore.markMemberResult(
          memberName,
          {
            status: 'failed',
            failureReason: runtimeFailure,
          },
          params.now,
        )
        continue
      }

      const submittedStage = await readLastBootstrapSubmittedStage({
        teamName: params.request.teamName,
        memberName,
        backendType: pendingMember.backendType,
        runtimePid: pendingMember.runtimePid,
        bootstrapRunId: pendingMember.bootstrapRunId,
        bootstrapExpectedAfter: pendingMember.bootstrapExpectedAfter,
      })
      if (!submittedStage) {
        continue
      }

      const observedNowMs = params.monotonicNow()
      if (
        pendingMember.bootstrapSubmittedEventTimestamp !==
          submittedStage.timestamp ||
        pendingMember.bootstrapSubmittedStage !== submittedStage.stage ||
        pendingMember.bootstrapSubmittedObservedAtMs == null
      ) {
        pendingMember.bootstrapSubmittedEventTimestamp =
          submittedStage.timestamp
        pendingMember.bootstrapSubmittedObservedAtMs = observedNowMs
        pendingMember.bootstrapSubmittedElapsedAtObservedMs =
          resolveBootstrapSubmittedElapsedAtObservationMs({
            submittedTimestamp: submittedStage.timestamp,
            observedWallNowMs: params.now(),
            bootstrapExpectedAfter: pendingMember.bootstrapExpectedAfter,
          })
        pendingMember.bootstrapSubmittedStage = submittedStage.stage
      }

      const submittedElapsedMs = resolveBootstrapSubmittedElapsedMs({
        elapsedAtObservationMs:
          pendingMember.bootstrapSubmittedElapsedAtObservedMs ?? 0,
        observedAtMs: pendingMember.bootstrapSubmittedObservedAtMs,
        observedNowMs,
      })
      if (submittedElapsedMs < submittedConfirmationTimeoutMs) {
        continue
      }

      if (
        await hasBootstrapConfirmation(
          params.request.teamName,
          pendingMember.agentId,
          pendingMember.bootstrapExpectedAfter,
          memberName,
        )
      ) {
        pending.delete(memberName)
        confirmedMembers.add(memberName)
        await params.stateStore.markMemberResult(
          memberName,
          {
            status: 'bootstrap_confirmed',
            agentId: pendingMember.agentId,
          },
          params.now,
        )
        continue
      }

      const reason = [
        `Bootstrap prompt was submitted, but teammate did not bootstrap-confirm before submitted-confirmation timeout (${formatBootstrapTimeoutMs(submittedConfirmationTimeoutMs)}).`,
        `Last transport stage: ${pendingMember.bootstrapSubmittedStage ?? submittedStage.stage}`,
      ].join(' ')
      pending.delete(memberName)
      if (!params.failedMembers.some(failed => failed.name === memberName)) {
        params.failedMembers.push({ name: memberName, reason })
      }
      await params.stateStore.markMemberResult(
        memberName,
        {
          status: 'failed',
          failureReason: reason,
        },
        params.now,
      )
    }

    if (pending.size === 0) {
      break
    }

    const elapsedMs = params.monotonicNow() - params.timeoutStartedAt
    const remainingMs = params.request.bootstrapTimeoutMs - elapsedMs
    if (remainingMs <= 0) {
      for (const [memberName, pendingMember] of pending) {
        if (
          params.failedMembers.some(failed => failed.name === memberName)
        ) {
          continue
        }
        const lastStage = await readLastBootstrapTransportStage({
          teamName: params.request.teamName,
          memberName,
          backendType: pendingMember.backendType,
          runtimePid: pendingMember.runtimePid,
          bootstrapRunId: pendingMember.bootstrapRunId,
          bootstrapExpectedAfter: pendingMember.bootstrapExpectedAfter,
        })
        const reason = lastStage
          ? `Teammate was registered but did not bootstrap-confirm before timeout. Last transport stage: ${lastStage}`
          : 'Teammate was registered but did not bootstrap-confirm before timeout.'
        params.failedMembers.push({ name: memberName, reason })
        await params.stateStore.markMemberResult(
          memberName,
          {
            status: 'failed',
            failureReason: reason,
          },
          params.now,
        )
      }
      break
    }

    await sleep(Math.min(500, Math.max(50, remainingMs)))
  }

  return [...confirmedMembers]
}

export async function runTeamBootstrap(params: {
  request: TeamBootstrapRequest
  context: ToolUseContext
  emit: TeamBootstrapProgressSink
  onInitialized?: () => Promise<void> | void
  now?: () => number
  monotonicNow?: () => number
}): Promise<TeamBootstrapResult> {
  const now = params.now ?? (() => Date.now())
  const monotonicNow = params.monotonicNow ?? (() => performance.now())
  const deps = getTeamBootstrapRunnerDeps()
  const stateStore = new TeamBootstrapStateStore(params.request, now)
  const runtimeIdentity = getCurrentTeamBootstrapRuntimeIdentity()
  const timeoutStartedAt = monotonicNow()
  const getRemainingBootstrapBudgetMs = (): number =>
    Math.max(
      1,
      Math.floor(
        params.request.bootstrapTimeoutMs - (monotonicNow() - timeoutStartedAt),
      ),
    )
  const assertTimeoutBudget = (stage?: string): void => {
    assertBootstrapTimeoutBudget({
      teamName: params.request.teamName,
      startedAtMs: timeoutStartedAt,
      timeoutMs: params.request.bootstrapTimeoutMs,
      monotonicNowMs: monotonicNow(),
      ...(stage ? { stage } : {}),
    })
  }
  const validateWorkspace = async (stage?: string): Promise<void> => {
    await assertBootstrapRuntimeWorkspace(params.request, stage)
  }
  await stateStore.initialize()

  try {
    assertTimeoutBudget('before initializing deterministic bootstrap')
    await params.onInitialized?.()
    await emitBootstrapProgressSafely('started', () =>
      params.emit.started(params.request.members.map(member => member.displayName)),
    )
    await emitBootstrapProgressSafely('phase_changed:validating_spec', () =>
      params.emit.phaseChanged('validating_spec'),
    )
    await stateStore.transitionTo('loading_existing_state', now)
    await emitBootstrapProgressSafely('phase_changed:loading_existing_state', () =>
      params.emit.phaseChanged('loading_existing_state'),
    )
    await validateWorkspace('before acquiring bootstrap ownership lock')
    assertTimeoutBudget('before acquiring bootstrap ownership lock')
    await stateStore.transitionTo('acquiring_bootstrap_lock', now)
    await emitBootstrapProgressSafely('phase_changed:acquiring_bootstrap_lock', () =>
      params.emit.phaseChanged('acquiring_bootstrap_lock'),
    )

    const summary = await withBootstrapOwnershipLock({
      teamName: params.request.teamName,
      runId: params.request.runId,
      requestHash: params.request.requestHash,
      ownerStartedAt: stateStore.getState().ownerStartedAt ?? now(),
      timeoutMs: params.request.bootstrapTimeoutMs,
      fn: async () => {
        assertTimeoutBudget('after acquiring bootstrap ownership lock')
        await validateWorkspace('after acquiring bootstrap ownership lock')
        seedBootstrapPermissionRules({
          teamName: params.request.teamName,
          permissionSeedTools: params.request.permissionSeedTools,
        })
        const attachState = await ensureLeaderAttachedToTeam(
          params.request,
          params.context,
          deps,
        )
        const shouldCreateTeam = shouldCreateTeamForBootstrap({
          mode: params.request.mode,
          attachState,
          teamName: params.request.teamName,
        })
        const reusedExistingTeam = !shouldCreateTeam
        if (shouldCreateTeam) {
          assertTimeoutBudget('before creating team config')
          await validateWorkspace('before creating team config')
          await stateStore.transitionTo('creating_team', now)
          await emitBootstrapProgressSafely('phase_changed:creating_team', () =>
            params.emit.phaseChanged('creating_team'),
          )
          await deps.teamCreateCall(
            {
              team_name: params.request.teamName,
              ...(params.request.description
                ? { description: params.request.description }
                : {}),
            },
            params.context,
          )
        }
        deps.unregisterTeamForSessionCleanup(params.request.teamName)
        await emitBootstrapProgressSafely('team_created', () =>
          params.emit.teamCreated(reusedExistingTeam),
        )

        await stateStore.transitionTo('spawning_members', now)
        await emitBootstrapProgressSafely('phase_changed:spawning_members', () =>
          params.emit.phaseChanged('spawning_members'),
        )
        const failedMembers: Array<{ name: string; reason: string }> = []

        for (const [memberIndex, member] of params.request.members.entries()) {
          assertTimeoutBudget(`before spawning teammate "${member.displayName}"`)
          await validateWorkspace(
            `before spawning teammate "${member.displayName}"`,
          )
          assertStableTeamBootstrapRuntimeIdentity({
            teamName: params.request.teamName,
            expected: runtimeIdentity,
          })
          const spawnDelayMs = getBootstrapSpawnDelayMs(
            params.request.members,
            memberIndex,
          )
          if (spawnDelayMs > 0) {
            assertTimeoutBudget(
              `before staggered spawn delay for teammate "${member.displayName}"`,
            )
            await sleep(spawnDelayMs)
            assertTimeoutBudget(
              `after staggered spawn delay for teammate "${member.displayName}"`,
            )
            await validateWorkspace(
              `after staggered spawn delay for teammate "${member.displayName}"`,
            )
          }
          await stateStore.markMemberSpawnStarted(member.displayName, now)
          await emitBootstrapProgressSafely(
            `member_spawn_started:${member.displayName}`,
            () => params.emit.memberSpawnStarted(member.displayName),
          )
          try {
            assertPrimaryBootstrapProviderSupported(member)
            const model = normalizeBootstrapModelSelection(member.model)
            const result = await spawnTeammateWithTransientStartupRetry({
              deps,
              context: params.context,
              teamName: params.request.teamName,
              memberName: member.displayName,
              remainingBudgetMs: getRemainingBootstrapBudgetMs,
              buildInput: () => ({
                name: member.displayName,
                prompt: member.prompt,
                team_name: params.request.teamName,
                ...(member.cwd && member.isolation !== 'worktree'
                  ? { cwd: member.cwd }
                  : {}),
                ...(model ? { model } : {}),
                ...(member.provider ? { provider: member.provider } : {}),
                ...(member.effort ? { effort: member.effort as never } : {}),
                ...(member.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
                ...(member.agentType ? { agent_type: member.agentType } : {}),
                ...(member.description ? { description: member.description } : {}),
                ...(member.mcpConfigPath ? { mcp_config: member.mcpConfigPath } : {}),
                ...(member.mcpSettingSources
                  ? { mcp_setting_sources: member.mcpSettingSources }
                  : {}),
                ...(member.strictMcpConfig !== undefined
                  ? { strict_mcp_config: member.strictMcpConfig }
                  : {}),
                ...(member.nativeAppManagedBootstrap
                  ? { nativeAppManagedBootstrap: member.nativeAppManagedBootstrap }
                  : {}),
                bootstrapRunId: params.request.runId,
                bootstrapTimeoutMs: getRemainingBootstrapBudgetMs(),
                ...(member.useSplitPane !== undefined
                  ? { use_splitpane: member.useSplitPane }
                  : {}),
                ...(member.planModeRequired
                  ? { plan_mode_required: member.planModeRequired }
                  : {}),
              }),
            })

            const duplicate = result.data as Partial<DuplicateSkippedOutput>
            if (duplicate.status === 'duplicate_skipped') {
              const duplicateOutcome =
                duplicate.reason === 'already_running'
                  ? 'already_running'
                  : 'duplicate_pending'
              await stateStore.markMemberResult(
                member.displayName,
                {
                  status: 'registered',
                  agentId: duplicate.agent_id,
                  failureReason: duplicate.reason,
                },
                now,
              )
              await emitBootstrapProgressSafely(
                `member_spawn_result:${member.displayName}:${duplicateOutcome}`,
                () =>
                  params.emit.memberSpawnResult({
                    memberName: member.displayName,
                    outcome: duplicateOutcome,
                    agentId: duplicate.agent_id,
                    teammateId: duplicate.teammate_id,
                    reason: duplicate.reason,
                  }),
              )
              continue
            }

            const runtimePid =
              'runtime_pid' in result.data &&
              typeof result.data.runtime_pid === 'number' &&
              result.data.runtime_pid > 0
                ? result.data.runtime_pid
                : undefined
            await stateStore.markMemberResult(
              member.displayName,
              {
                status: 'registered',
                agentId: result.data.agent_id,
                backendType:
                  'backend_type' in result.data &&
                  typeof result.data.backend_type === 'string'
                    ? result.data.backend_type
                    : undefined,
                runtimePid,
              },
              now,
            )
            await emitBootstrapProgressSafely(
              `member_spawn_result:${member.displayName}:spawned`,
              () =>
                params.emit.memberSpawnResult({
                  memberName: member.displayName,
                  outcome: 'spawned',
                  agentId: result.data.agent_id,
                  teammateId: result.data.teammate_id,
                  backendType:
                    'backend_type' in result.data &&
                    typeof result.data.backend_type === 'string'
                      ? result.data.backend_type
                      : undefined,
                }),
            )
          } catch (error) {
            const reason = errorMessage(error)
            failedMembers.push({ name: member.displayName, reason })
            await stateStore.markMemberResult(
              member.displayName,
              {
                status: 'failed',
                failureReason: reason,
              },
              now,
            )
            await emitBootstrapProgressSafely(
              `member_spawn_result:${member.displayName}:failed`,
              () =>
                params.emit.memberSpawnResult({
                  memberName: member.displayName,
                  outcome: 'failed',
                  reason,
                }),
            )
          }
        }

        await stateStore.transitionTo('auditing_truth', now)
        await emitBootstrapProgressSafely('phase_changed:auditing_truth', () =>
          params.emit.phaseChanged('auditing_truth'),
        )
        assertTimeoutBudget('before auditing bootstrap truth')
        await validateWorkspace('before auditing bootstrap truth')
        const teamFile = await deps.readTeamFileAsync(params.request.teamName)
        const membersByName = new Map(
          (teamFile?.members ?? []).flatMap(member => {
            const memberName = member.name?.trim()
            if (!memberName || memberName === 'team-lead') {
              return []
            }
            return [
              [
                memberName,
                {
                  agentId: member.agentId,
                  bootstrapExpectedAfter: member.bootstrapExpectedAfter ?? null,
                  backendType: member.backendType,
                  runtimePid: member.runtimePid,
                  bootstrapRunId: member.bootstrapRunId ?? null,
                },
              ] as const,
            ]
          }),
        )
        for (const member of params.request.members) {
          if (membersByName.has(member.displayName)) {
            continue
          }
          const alreadyFailed = failedMembers.some(
            failed => failed.name === member.displayName,
          )
          if (alreadyFailed) {
            continue
          }
          const reason =
            'Teammate was not registered in config.json during deterministic bootstrap.'
          failedMembers.push({ name: member.displayName, reason })
          await stateStore.markMemberResult(
            member.displayName,
            {
              status: 'failed',
              failureReason: reason,
            },
            now,
          )
        }
        const confirmedMemberNames = await waitForRequiredBootstrapConfirmations({
          request: params.request,
          stateStore,
          failedMembers,
          membersByName,
          timeoutStartedAt,
          monotonicNow,
          now,
        })

        return buildSummary({
          request: params.request,
          reusedExistingTeam,
          failedMembers,
          registeredMembers: confirmedMemberNames,
        })
      },
    })
    if (summary.terminalStatus === 'failed') {
      const reason = buildBootstrapFailureReason({
        teamName: params.request.teamName,
        continueOnPartialFailure: params.request.continueOnPartialFailure,
        failedMembers: summary.failedMembers,
      })
      await stateStore.setTerminal(
        {
          status: 'failed',
          reason,
          finishedAt: now(),
        },
        now,
      )
      await emitBootstrapProgressSafely('failed', () => params.emit.failed(reason))
      return {
        ok: false,
        fatal: true,
        error: reason,
        summary,
      }
    }

    await stateStore.setTerminal(
      {
        status: summary.terminalStatus,
        finishedAt: now(),
      },
      now,
    )
    const terminalSuccessStatus =
      summary.terminalStatus === 'partial_success' ? 'partial_success' : 'completed'
    await emitBootstrapProgressSafely('completed', () =>
      params.emit.completed({
        status: terminalSuccessStatus,
        expectedMembers: summary.expectedMembers,
        registeredMembers: summary.registeredMembers,
        failedMembers: summary.failedMembers,
      }),
    )
    return {
      ok: true,
      fatal: false,
      summary,
    }
  } catch (error) {
    const reason = errorMessage(error)
    await stateStore.setTerminal(
      {
        status: 'failed',
        reason,
        finishedAt: now(),
      },
      now,
    )
    await emitBootstrapProgressSafely('failed', () => params.emit.failed(reason))
    return {
      ok: false,
      fatal: true,
      error: reason,
    }
  }
}
