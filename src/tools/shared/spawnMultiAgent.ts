/**
 * Shared spawn module for teammate creation.
 * Extracted from TeammateTool to allow reuse by AgentTool.
 */

import React from 'react'
import { randomUUID } from 'crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { access, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  getChromeFlagOverride,
  getFlagDisallowedTools,
  getFlagMcpConfig,
  getFlagSettingsInline,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getOriginalCwd,
  getSessionBypassPermissionsMode,
  getSessionId,
  getSessionProjectDir,
  getStrictMcpConfig,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
} from '../../tasks/InProcessTeammateTask/types.js'
import { formatAgentId } from '../../utils/agentId.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { getGlobalConfig, isPathTrusted } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import type { EffortLevel } from '../../utils/effort.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { parseArguments } from '../../utils/argumentSubstitution.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { isProcessAlive, killProcessTree } from '../../utils/processKill.js'
import {
  IT2_COMMAND,
  isTmuxAvailable,
} from '../../utils/swarm/backends/detection.js'
import {
  detectAndGetBackend,
  getBackendByType,
  isInProcessEnabled,
  markInProcessFallback,
  resetBackendDetection,
} from '../../utils/swarm/backends/registry.js'
import { getTeammateModeFromSnapshot } from '../../utils/swarm/backends/teammateModeSnapshot.js'
import type {
  BackendType,
  TeammateProvider,
} from '../../utils/swarm/backends/types.js'
import { isPaneBackend } from '../../utils/swarm/backends/types.js'
import {
  getSwarmSocketName,
  SWARM_SESSION_NAME,
  TEAM_LEAD_NAME,
  TEAMMATE_COMMAND_ENV_VAR,
  TMUX_COMMAND,
} from '../../utils/swarm/constants.js'
import { It2SetupPrompt } from '../../utils/swarm/It2SetupPrompt.js'
import { startInProcessTeammate } from '../../utils/swarm/inProcessRunner.js'
import {
  type InProcessSpawnConfig,
  killInProcessTeammate,
  spawnInProcessTeammate,
} from '../../utils/swarm/spawnInProcess.js'
import {
  buildPaneLauncherCommand,
  buildAppManagedAnthropicApiKeyHelperSettingsFlag,
  buildInheritedEnvObject,
  buildInheritedEnvVars,
  probeTmuxTeammateSpawn,
  stripInheritedCliFlag,
  stripProviderBoundaryInheritedRuntimeFlags,
  wrapTeammateSpawnCommand,
} from '../../utils/swarm/spawnUtils.js'
import {
  buildProcessBackendPaneId,
  isProcessBackendCommandForTeammate as isProcessBackendCommandForTeammateValue,
  isProcessBackendRuntimeAlive,
  killProcessBackendRuntime,
  parseProcessBackendPid as parseProcessBackendPidValue,
} from '../../utils/swarm/processBackend.js'
import {
  cleanupSpawnReadySentinelDir,
  createSpawnReadySentinel,
  TEAMMATE_STARTUP_READY_SENTINEL_ENV,
} from '../../utils/swarm/startupReadySentinel.js'
import {
  ensureTeammateRuntimePaths,
  getTeammateRuntimePaths,
  readTeammateRuntimeEvents,
  TEAMMATE_BOOTSTRAP_PROOF_TOKEN_ENV,
  TEAMMATE_RUNTIME_EVENTS_ENV,
  waitForBootstrapSubmissionOutcome,
  waitForTeammateRuntimeEvent,
  writeParentOwnedTeammateRuntimeEvent,
} from '../../utils/swarm/teammateRuntimeEvents.js'
import {
  prepareNativeAppManagedBootstrapContextFile,
  type NativeAppManagedBootstrapSpec,
} from '../../services/teamBootstrap/nativeAppManagedBootstrapContext.js'
import {
  parseBootstrapRuntimeProofDetail,
  validateBootstrapRuntimeProofEnvelope,
} from '../../services/teamBootstrap/bootstrapProofValidation.js'
import {
  readTeamFileAsync,
  sanitizeAgentName,
  sanitizeName,
  updateTeamFileAsync,
  upsertTeamMember,
} from '../../utils/swarm/teamHelpers.js'
import {
  assignTeammateColor,
  createTeammatePaneInSwarmView,
  enablePaneBorderStatus,
  isInsideTmux,
  sendCommandToPane,
} from '../../utils/swarm/teammateLayoutManager.js'
import { getHardcodedTeammateModelFallback } from '../../utils/swarm/teammateModel.js'
import { registerTask } from '../../utils/task/framework.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { resolveCodexRuntimeSelection } from '../../services/runtimeBackends/codexBackendResolver.js'
import {
  TASK_CHANGE_BASE_WORKSPACE_ROOT_ENV,
  TASK_CHANGE_LEDGER_PROJECT_DIR_ENV,
  TASK_CHANGE_WORKTREE_BRANCH_ENV,
  TASK_CHANGE_WORKTREE_DIRTY_WARNING_ENV,
  TASK_CHANGE_WORKTREE_PATH_ENV,
} from '../../services/taskChangeLedger/env.js'
import {
  classifyIdleNotification,
  readMailbox,
  type TeammateMessage,
  writeToMailbox,
} from '../../utils/teammateMailbox.js'
import { assertNotWindowsReservedBasename } from '../../utils/windowsReservedNames.js'
import type { CustomAgentDefinition } from '../AgentTool/loadAgentsDir.js'
import { isCustomAgent } from '../AgentTool/loadAgentsDir.js'
import {
  createTeammateWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
} from '../../utils/worktree.js'

function getDefaultTeammateModel(leaderModel: string | null): string {
  const configured = getGlobalConfig().teammateDefaultModel
  if (configured === null) {
    // User picked "Default" in the /config picker — follow the leader.
    return leaderModel ?? getHardcodedTeammateModelFallback()
  }
  if (configured !== undefined) {
    return parseUserSpecifiedModel(configured)
  }
  return getHardcodedTeammateModelFallback()
}

/**
 * Resolve a teammate model value. Handles the 'inherit' alias (from agent
 * frontmatter) by substituting the leader's model. gh-31069: 'inherit' was
 * passed literally to --model, producing "It may not exist or you may not
 * have access". If leader model is null (not yet set), falls through to the
 * default.
 *
 * Exported for testing.
 */
export function resolveTeammateModel(
  inputModel: string | undefined,
  leaderModel: string | null,
): string {
  if (inputModel === 'inherit') {
    return leaderModel ?? getDefaultTeammateModel(leaderModel)
  }
  return inputModel ?? getDefaultTeammateModel(leaderModel)
}

function getCurrentTeammateProvider(): TeammateProvider {
  const provider = getAPIProvider()
  if (provider === 'openai') {
    return 'codex'
  }
  if (provider === 'gemini') {
    return 'gemini'
  }
  return 'anthropic'
}

function resolveTeammateProvider(
  inputProvider: TeammateProvider | undefined,
): TeammateProvider {
  return inputProvider ?? getCurrentTeammateProvider()
}

function crossesProviderBoundary(
  inputProvider: TeammateProvider | undefined,
): boolean {
  return (
    inputProvider !== undefined && inputProvider !== getCurrentTeammateProvider()
  )
}

type SeparateProcessRequirementReason =
  | 'provider-mismatch'
  | 'codex-native-runtime'

export function getSeparateProcessRequirement(
  inputProvider: TeammateProvider | undefined,
): {
  required: boolean
  reason: SeparateProcessRequirementReason | null
  provider: TeammateProvider
} {
  const provider = resolveTeammateProvider(inputProvider)

  if (crossesProviderBoundary(inputProvider)) {
    return {
      required: true,
      reason: 'provider-mismatch',
      provider,
    }
  }

  if (
    provider === 'codex' &&
    resolveCodexRuntimeSelection().resolvedBackendId === 'codex-native'
  ) {
    return {
      required: true,
      reason: 'codex-native-runtime',
      provider,
    }
  }

  return {
    required: false,
    reason: null,
    provider,
  }
}

function resolveSpawnModel(
  inputModel: string | undefined,
  leaderModel: string | null,
  inputProvider: TeammateProvider | undefined,
): string | undefined {
  if (crossesProviderBoundary(inputProvider)) {
    // Do not inherit the leader's model across provider boundaries.
    // Let the spawned process pick its provider-native default unless a
    // teammate-specific model was explicitly requested.
    if (inputModel === undefined || inputModel === 'inherit') {
      return undefined
    }
  }
  return resolveTeammateModel(inputModel, leaderModel)
}

function stripInheritedModelFlag(flags: string): string {
  return stripInheritedCliFlag(flags, '--model')
}

function stripInheritedEffortFlag(flags: string): string {
  return stripInheritedCliFlag(flags, '--effort')
}

function summarizePromptSize(prompt: string): string {
  const chars = prompt.length.toLocaleString('en-US')
  const lines = prompt.length === 0 ? 0 : prompt.split(/\r?\n/g).length
  return `${chars} chars/${lines} lines`
}

function logTeammateSpawnSnapshot(params: {
  teamName: string
  teammateName: string
  provider: TeammateProvider
  model: string | undefined
  effort: EffortLevel | undefined
  prompt: string
  strictMcpConfig: boolean
}): void {
  logForDebugging(
    `[teammate-spawn] team=${params.teamName} teammate=${params.teammateName} provider=${params.provider} model=${params.model ?? 'default'} effort=${params.effort ?? 'default'} prompt=${summarizePromptSize(params.prompt)} strictMcpConfig=${params.strictMcpConfig} env.entryProvider=${process.env.CLAUDE_CODE_ENTRY_PROVIDER ?? 'unset'} env.geminiBackend=${process.env.CLAUDE_CODE_GEMINI_BACKEND ?? 'unset'} env.codexBackend=${process.env.CLAUDE_CODE_CODEX_BACKEND ?? 'unset'}`,
  )
}

function normalizeTeammateIdentity(name: string): string {
  return sanitizeAgentName(name).trim().toLowerCase()
}

function buildBootstrapConfirmationIdentitySet(
  identities: Array<string | null | undefined>,
): Set<string> {
  const result = new Set<string>()
  for (const identity of identities) {
    const trimmed = identity?.trim()
    if (!trimmed) {
      continue
    }
    result.add(trimmed.toLowerCase())
    result.add(normalizeTeammateIdentity(trimmed))
  }
  return result
}

const BOOTSTRAP_TRANSCRIPT_MTIME_SLOP_MS = 30_000
const BOOTSTRAP_TRANSCRIPT_MAX_CANDIDATE_FILES = 128

function getRecordTimestampMs(record: unknown): number | null {
  if (!record || typeof record !== 'object') {
    return null
  }
  const timestamp = (record as { timestamp?: unknown }).timestamp
  if (typeof timestamp !== 'string') {
    return null
  }
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : null
}

function isMemberBriefingToolName(name: unknown): boolean {
  return (
    name === 'member_briefing' ||
    name === 'mcp__agent-teams__member_briefing'
  )
}

function contentParts(content: unknown): unknown[] {
  if (Array.isArray(content)) {
    return content
  }
  return [content]
}

function textFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(part => {
      if (typeof part === 'string') {
        return part
      }
      if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text
        return typeof text === 'string' ? text : ''
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function recordContent(record: unknown): unknown {
  if (!record || typeof record !== 'object') {
    return undefined
  }
  return (record as { message?: { content?: unknown } }).message?.content
}

function recordMatchesBootstrapTranscriptIdentity(
  record: unknown,
  teamName: string,
  allowedIdentities: Set<string>,
): boolean {
  if (!record || typeof record !== 'object') {
    return false
  }
  const candidate = record as { teamName?: unknown; agentName?: unknown }
  if (candidate.teamName !== teamName || typeof candidate.agentName !== 'string') {
    return false
  }
  const agentName = candidate.agentName.trim()
  return (
    allowedIdentities.has(agentName.toLowerCase()) ||
    allowedIdentities.has(normalizeTeammateIdentity(agentName))
  )
}

function contentHasMatchingMemberBriefingToolUse(
  content: unknown,
  teamName: string,
  allowedIdentities: Set<string>,
): boolean {
  for (const part of contentParts(content)) {
    if (!part || typeof part !== 'object') {
      continue
    }
    const toolPart = part as { type?: unknown; name?: unknown; input?: unknown }
    if (toolPart.type !== 'tool_use' || !isMemberBriefingToolName(toolPart.name)) {
      continue
    }
    const input = toolPart.input
    if (!input || typeof input !== 'object') {
      continue
    }
    const payload = input as { teamName?: unknown; memberName?: unknown }
    if (payload.teamName !== teamName || typeof payload.memberName !== 'string') {
      continue
    }
    const memberName = payload.memberName.trim()
    if (
      allowedIdentities.has(memberName.toLowerCase()) ||
      allowedIdentities.has(normalizeTeammateIdentity(memberName))
    ) {
      return true
    }
  }
  return false
}

function contentHasSuccessfulMemberBriefingToolResult(
  content: unknown,
  teamName: string,
  allowedIdentities: Set<string>,
): boolean {
  for (const part of contentParts(content)) {
    if (!part || typeof part !== 'object') {
      continue
    }
    const toolPart = part as { type?: unknown; content?: unknown }
    if (toolPart.type !== 'tool_result') {
      continue
    }
    const text = textFromToolResultContent(toolPart.content)
    if (!text.includes(` on team "${teamName}" (${teamName}).`)) {
      continue
    }
    for (const identity of allowedIdentities) {
      if (text.includes(`Member briefing for ${identity} on team "${teamName}"`)) {
        return true
      }
    }
  }
  return false
}

function scanBootstrapTranscriptText(params: {
  text: string
  teamName: string
  teammateId: string
  teammateName?: string | null
  boundaryMs: number
}): boolean {
  const allowedIdentities = buildBootstrapConfirmationIdentitySet([
    params.teammateId,
    params.teammateName,
  ])
  let matchedTranscriptIdentity = false
  let matchedMemberBriefingToolUse = false

  for (const line of params.text.split(/\r?\n/g)) {
    if (!line.includes(params.teamName) && !line.includes('member_briefing')) {
      continue
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const timestampMs = getRecordTimestampMs(record)
    if (timestampMs === null || timestampMs < params.boundaryMs) {
      continue
    }
    if (
      recordMatchesBootstrapTranscriptIdentity(
        record,
        params.teamName,
        allowedIdentities,
      )
    ) {
      matchedTranscriptIdentity = true
    }
    const content = recordContent(record)
    if (
      contentHasMatchingMemberBriefingToolUse(
        content,
        params.teamName,
        allowedIdentities,
      )
    ) {
      matchedMemberBriefingToolUse = true
    }
    if (
      matchedTranscriptIdentity &&
      matchedMemberBriefingToolUse &&
      contentHasSuccessfulMemberBriefingToolResult(
        content,
        params.teamName,
        allowedIdentities,
      )
    ) {
      return true
    }
  }

  return false
}

async function hasBootstrapTranscriptConfirmation(
  teamName: string,
  teammateId: string,
  bootstrapExpectedAfter: string | null | undefined,
  teammateName?: string | null,
): Promise<boolean> {
  if (!bootstrapExpectedAfter) {
    return false
  }
  const boundaryMs = Date.parse(bootstrapExpectedAfter)
  if (!Number.isFinite(boundaryMs)) {
    return false
  }

  const projectDir = getLeaderTaskLedgerProjectDir()
  const minMtimeMs = boundaryMs - BOOTSTRAP_TRANSCRIPT_MTIME_SLOP_MS
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(projectDir, { withFileTypes: true })
  } catch (error) {
    logForDebugging(
      `[teammate-spawn] bootstrap transcript scan unavailable for ${teammateId}: ${errorMessage(error)}`,
    )
    return false
  }

  const candidates: Array<{ path: string; mtimeMs: number }> = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue
    }
    const path = join(projectDir, entry.name)
    try {
      const fileStat = await stat(path)
      if (fileStat.mtimeMs >= minMtimeMs) {
        candidates.push({ path, mtimeMs: fileStat.mtimeMs })
      }
    } catch {
      // The transcript writer may rotate/remove files while we are scanning.
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const candidate of candidates.slice(
    0,
    BOOTSTRAP_TRANSCRIPT_MAX_CANDIDATE_FILES,
  )) {
    try {
      if (
        scanBootstrapTranscriptText({
          text: await readFile(candidate.path, 'utf8'),
          teamName,
          teammateId,
          teammateName,
          boundaryMs,
        })
      ) {
        logForDebugging(
          `[teammate-spawn] bootstrap confirmed via transcript for ${teammateId}`,
        )
        return true
      }
    } catch {
      // Treat unreadable partial transcript files as no evidence.
    }
  }

  return false
}

function buildTeammateSpawnReservationKey(
  teamName: string,
  name: string,
): string {
  return `${teamName.toLowerCase()}::${normalizeTeammateIdentity(name)}`
}

async function isTmuxPaneAlive(
  paneId: string,
  useExternalSession: boolean,
): Promise<boolean> {
  const socketArgs = useExternalSession ? ['-L', getSwarmSocketName()] : []
  const result = await execFileNoThrow(TMUX_COMMAND, [
    ...socketArgs,
    'display-message',
    '-p',
    '-t',
    paneId,
    '#{pane_id}',
  ])
  return result.code === 0 && result.stdout.trim() === paneId
}

async function isItermPaneAlive(paneId: string): Promise<boolean> {
  const result = await execFileNoThrow(IT2_COMMAND, ['session', 'list'])
  if (result.code !== 0) {
    return false
  }
  return result.stdout.includes(paneId)
}

export function isBootstrapConfirmationMailboxMessage(
  message: Pick<TeammateMessage, 'text' | 'timestamp'>,
  teammateId: string,
  bootstrapExpectedAfter?: string | null,
  teammateName?: string | null,
): boolean {
  const classified = classifyIdleNotification(message.text)
  if (!classified) {
    return false
  }

  if (bootstrapExpectedAfter) {
    const boundaryMs = Date.parse(bootstrapExpectedAfter)
    if (!Number.isFinite(boundaryMs)) {
      logForDebugging(
        `[teammate-spawn] invalid bootstrapExpectedAfter for ${teammateId}: ${bootstrapExpectedAfter}`,
      )
      return false
    }

    const messageTsMs = Date.parse(message.timestamp)
    if (!Number.isFinite(messageTsMs)) {
      logForDebugging(
        `[teammate-spawn] invalid bootstrap confirmation mailbox timestamp for ${teammateId}: ${message.timestamp}`,
      )
      return false
    }

    if (messageTsMs < boundaryMs) {
      return false
    }
  }

  const confirmationFrom = classified.payload.from?.trim()
  if (!confirmationFrom) {
    return false
  }
  const allowedIdentities = buildBootstrapConfirmationIdentitySet([
    teammateId,
    teammateName,
  ])
  const normalizedConfirmationFrom = normalizeTeammateIdentity(confirmationFrom)

  return (
    (allowedIdentities.has(confirmationFrom.toLowerCase()) ||
      allowedIdentities.has(normalizedConfirmationFrom)) &&
    classified.countsAsBootstrapConfirmation
  )
}

function getBootstrapExpectedAfterForTeammate(
  teamFile: Awaited<ReturnType<typeof readTeamFileAsync>>,
  teammateId: string,
  teammateName: string,
): string | null {
  if (!teamFile) {
    logForDebugging(
      `[teammate-spawn] bootstrap boundary unavailable for ${teammateId}: team file missing`,
    )
    return null
  }

  const normalizedTargetName = normalizeTeammateIdentity(teammateName)
  const byAgentId = teamFile.members.find(member => member.agentId === teammateId)
  if (byAgentId?.bootstrapExpectedAfter) {
    return byAgentId.bootstrapExpectedAfter
  }

  const byName = teamFile.members.find(
    member => normalizeTeammateIdentity(member.name) === normalizedTargetName,
  )
  if (byAgentId || byName) {
    logForDebugging(
      `[teammate-spawn] bootstrap boundary unavailable for ${teammateId}: member has no bootstrapExpectedAfter`,
    )
  }
  return byName?.bootstrapExpectedAfter ?? null
}

async function hasBootstrapRuntimeEventConfirmation(
  teamName: string,
  teammateId: string,
  bootstrapExpectedAfter?: string | null,
  teammateName?: string | null,
): Promise<boolean> {
  let teamFile: Awaited<ReturnType<typeof readTeamFileAsync>>
  try {
    teamFile = await readTeamFileAsync(teamName)
  } catch {
    teamFile = null
  }
  const normalizedTargetName = normalizeTeammateIdentity(
    teammateName ?? teammateId,
  )
  const member =
    teamFile?.members.find(candidate => candidate.agentId === teammateId) ??
    teamFile?.members.find(
      candidate =>
        normalizeTeammateIdentity(candidate.name) === normalizedTargetName,
    )
  const runtimeEventsPath =
    member?.bootstrapRuntimeEventsPath ??
    getTeammateRuntimePaths({
      teamName,
      agentName: member?.name ?? teammateName ?? teammateId,
    }).eventsPath
  const expectedProofToken = member?.bootstrapProofToken?.trim()
  const boundaryMs = bootstrapExpectedAfter
    ? Date.parse(bootstrapExpectedAfter)
    : Number.NaN
  if (!expectedProofToken && !Number.isFinite(boundaryMs)) {
    return false
  }
  const allowedIdentities = buildBootstrapConfirmationIdentitySet([
    teammateId,
    teammateName,
    member?.name,
  ])

  let events: Awaited<ReturnType<typeof readTeammateRuntimeEvents>>
  try {
    events = await readTeammateRuntimeEvents(runtimeEventsPath)
  } catch {
    return false
  }

  return events.some(event => {
    if (event.type !== 'bootstrap_confirmed') {
      return false
    }
    if (event.teamName && event.teamName !== teamName) {
      return false
    }

    const eventAgentId = event.agentId?.trim()
    const eventAgentName = event.agentName?.trim()
    const matchesIdentity =
      (eventAgentId &&
        (allowedIdentities.has(eventAgentId.toLowerCase()) ||
          allowedIdentities.has(normalizeTeammateIdentity(eventAgentId)))) ||
      (eventAgentName &&
        (allowedIdentities.has(eventAgentName.toLowerCase()) ||
          allowedIdentities.has(normalizeTeammateIdentity(eventAgentName))))
    if (!matchesIdentity) {
      return false
    }

    if (Number.isFinite(boundaryMs)) {
      const eventMs = Date.parse(event.timestamp)
      if (!Number.isFinite(eventMs) || eventMs < boundaryMs) {
        return false
      }
    }

    const detail = parseBootstrapRuntimeProofDetail(event.detail)
    const nativeMember = member as
      | {
          bootstrapProofMode?: string
          bootstrapRunId?: string
          bootstrapContextHash?: string
          bootstrapBriefingHash?: string
        }
      | undefined
    if (
      !validateBootstrapRuntimeProofEnvelope({
        event,
        detail,
        expected: {
          teamName,
          boundaryMs,
          proofToken: expectedProofToken,
          proofMode: nativeMember?.bootstrapProofMode?.trim(),
          runId: nativeMember?.bootstrapRunId?.trim(),
          contextHash: nativeMember?.bootstrapContextHash?.trim(),
          briefingHash: nativeMember?.bootstrapBriefingHash?.trim(),
        },
      })
    ) {
      return false
    }
    return true
  })
}

export async function hasBootstrapConfirmation(
  teamName: string,
  teammateId: string,
  bootstrapExpectedAfter?: string | null,
  teammateName?: string | null,
): Promise<boolean> {
  if (
    await hasBootstrapRuntimeEventConfirmation(
      teamName,
      teammateId,
      bootstrapExpectedAfter,
      teammateName,
    )
  ) {
    return true
  }

  if (
    await hasBootstrapTranscriptConfirmation(
      teamName,
      teammateId,
      bootstrapExpectedAfter,
      teammateName,
    )
  ) {
    return true
  }

  const leaderMessages = await readMailbox(TEAM_LEAD_NAME, teamName)
  if (leaderMessages.some(message =>
    isBootstrapConfirmationMailboxMessage(
      message,
      teammateId,
      bootstrapExpectedAfter,
      teammateName,
    ),
  )) {
    return true
  }
  return false
}

// ============================================================================
// Types
// ============================================================================

export type SpawnOutput = {
  teammate_id: string
  agent_id: string
  agent_type?: string
  model?: string
  provider?: TeammateProvider
  effort?: EffortLevel
  name: string
  color?: string
  tmux_session_name: string
  tmux_window_name: string
  tmux_pane_id: string
  team_name?: string
  is_splitpane?: boolean
  backend_type?: BackendType
  runtime_pid?: number
  runtime_events_log?: string
  runtime_stdout_log?: string
  runtime_stderr_log?: string
  plan_mode_required?: boolean
  worktreePath?: string
  worktreeBranch?: string
  dirtyLeaderWarning?: string
}

export type DuplicateSkippedReason = 'already_running' | 'bootstrap_pending'

export type DuplicateSkippedOutput = {
  status: 'duplicate_skipped'
  reason: DuplicateSkippedReason
  spawned: false
  teammate_id: string
  agent_id: string
  agent_type?: string
  model?: string
  provider?: TeammateProvider
  effort?: EffortLevel
  name: string
  team_name: string
  plan_mode_required?: boolean
}

export type SpawnTeammateConfig = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  provider?: TeammateProvider
  effort?: EffortLevel
  agent_type?: string
  isolation?: 'worktree'
  description?: string
  nativeAppManagedBootstrap?: NativeAppManagedBootstrapSpec
  bootstrapRunId?: string
  /** request_id of the API call whose response contained the tool_use that
   *  spawned this teammate. Threaded through to TeammateAgentContext for
   *  lineage tracing on tengu_api_* events. */
  invokingRequestId?: string
}

// Internal input type matching TeammateTool's spawn parameters
type SpawnInput = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  provider?: TeammateProvider
  effort?: EffortLevel
  agent_type?: string
  isolation?: 'worktree'
  description?: string
  nativeAppManagedBootstrap?: NativeAppManagedBootstrapSpec
  bootstrapRunId?: string
  invokingRequestId?: string
  worktreeInfo?: TeammateWorktreeInfo
}

type TeammateWorktreeInfo = {
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
  baseWorkspaceRoot: string
  dirtyLeaderWarning?: string
}

type SpawnResult = {
  data: SpawnOutput | DuplicateSkippedOutput
}

type ExistingTeammateDecision =
  | { decision: 'allow_spawn' | 'allow_respawn_after_terminal_failure' }
  | {
      decision: 'duplicate_already_running' | 'duplicate_bootstrap_pending'
      reason: DuplicateSkippedReason
    }

const pendingTeammateSpawnReservations = new Set<string>()

function getLeaderTaskLedgerProjectDir(): string {
  return getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
}

function buildTeammateWorktreeSlug(teamName: string, teammateName: string): string {
  const teamSegment = sanitizeName(teamName).replace(/^-+|-+$/g, '') || 'team'
  const nameSegment = sanitizeName(teammateName).replace(/^-+|-+$/g, '') || 'teammate'
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  return `team-${teamSegment.slice(0, 18)}-${nameSegment.slice(0, 18)}-${suffix}`
}

async function createWorktreeForTeammate(
  teamName: string,
  teammateName: string,
): Promise<TeammateWorktreeInfo> {
  return createTeammateWorktree(buildTeammateWorktreeSlug(teamName, teammateName))
}

async function cleanupCreatedTeammateWorktree(
  worktreeInfo: TeammateWorktreeInfo | undefined,
): Promise<void> {
  if (!worktreeInfo) {
    return
  }
  if (worktreeInfo.hookBased || !worktreeInfo.headCommit || !worktreeInfo.gitRoot) {
    logForDebugging(
      `[spawnTeammate] Keeping teammate worktree after failed spawn: ${worktreeInfo.worktreePath}`,
    )
    return
  }
  const changed = await hasWorktreeChanges(
    worktreeInfo.worktreePath,
    worktreeInfo.headCommit,
  )
  if (changed) {
    logForDebugging(
      `[spawnTeammate] Keeping dirty teammate worktree after failed spawn: ${worktreeInfo.worktreePath}`,
    )
    return
  }
  await removeAgentWorktree(
    worktreeInfo.worktreePath,
    worktreeInfo.worktreeBranch,
    worktreeInfo.gitRoot,
    worktreeInfo.hookBased,
  )
}

function worktreeEnv(worktreeInfo: TeammateWorktreeInfo | undefined): Record<string, string | undefined> {
  if (!worktreeInfo) {
    return {}
  }
  return {
    [TASK_CHANGE_LEDGER_PROJECT_DIR_ENV]: getLeaderTaskLedgerProjectDir(),
    [TASK_CHANGE_WORKTREE_PATH_ENV]: worktreeInfo.worktreePath,
    [TASK_CHANGE_WORKTREE_BRANCH_ENV]: worktreeInfo.worktreeBranch,
    [TASK_CHANGE_BASE_WORKSPACE_ROOT_ENV]: worktreeInfo.baseWorkspaceRoot,
    [TASK_CHANGE_WORKTREE_DIRTY_WARNING_ENV]: worktreeInfo.dirtyLeaderWarning,
  }
}

async function resolveExistingTeammateState(
  input: SpawnInput,
  context: ToolUseContext,
  teamName: string,
): Promise<ExistingTeammateDecision> {
  const appState = context.getAppState()
  const normalizedTargetName = normalizeTeammateIdentity(input.name)
  const canonicalName = sanitizeAgentName(input.name).trim()
  const canonicalAgentId = formatAgentId(canonicalName, teamName)
  const teamFile = await readTeamFileAsync(teamName)

  const inProcessTask = Object.values(appState.tasks).find(task => {
    if (!isInProcessTeammateTask(task) || task.status !== 'running') {
      return false
    }
    return (
      task.identity.teamName === teamName &&
      normalizeTeammateIdentity(task.identity.agentName) === normalizedTargetName
    )
  })
  if (inProcessTask) {
    const bootstrapExpectedAfter = getBootstrapExpectedAfterForTeammate(
      teamFile,
      inProcessTask.identity.agentId,
      canonicalName,
    )
    const bootstrapConfirmed = await hasBootstrapConfirmation(
      teamName,
      inProcessTask.identity.agentId,
      bootstrapExpectedAfter,
      canonicalName,
    )
    return {
      decision: bootstrapConfirmed
        ? 'duplicate_already_running'
        : 'duplicate_bootstrap_pending',
      reason: bootstrapConfirmed ? 'already_running' : 'bootstrap_pending',
    }
  }

  const inMemoryTeammate = Object.entries(appState.teamContext?.teammates || {}).find(
    ([, teammate]) =>
      normalizeTeammateIdentity(teammate.name) === normalizedTargetName,
  )
  if (inMemoryTeammate) {
    const [teammateId, teammate] = inMemoryTeammate
    let runtimeAlive = false
    const paneId = teammate.tmuxPaneId?.trim()
    const processPid = parseProcessBackendPid(paneId)
    if (processPid) {
      runtimeAlive = await isProcessBackendRuntimeAlive(
        processPid,
        teammateId,
        teamName,
      )
    } else if (paneId && paneId !== 'in-process') {
      runtimeAlive =
        (await isTmuxPaneAlive(paneId, false)) ||
        (await isTmuxPaneAlive(paneId, true)) ||
        (await isItermPaneAlive(paneId))
    }
    if (runtimeAlive) {
      const bootstrapExpectedAfter = getBootstrapExpectedAfterForTeammate(
        teamFile,
        teammateId,
        canonicalName,
      )
      const bootstrapConfirmed = await hasBootstrapConfirmation(
        teamName,
        teammateId,
        bootstrapExpectedAfter,
        teammate.name || canonicalName,
      )
      return {
        decision: bootstrapConfirmed
          ? 'duplicate_already_running'
          : 'duplicate_bootstrap_pending',
        reason: bootstrapConfirmed ? 'already_running' : 'bootstrap_pending',
      }
    }
  }

  const existingMember =
    teamFile?.members.find(member => member.agentId === canonicalAgentId) ??
    teamFile?.members.find(
      member => normalizeTeammateIdentity(member.name) === normalizedTargetName,
    )
  if (!existingMember) {
    return { decision: 'allow_spawn' }
  }

  let runtimeAlive = false
  const paneId = existingMember.tmuxPaneId?.trim()
  const persistedProcessPid =
    parseProcessBackendPid(paneId) ?? existingMember.runtimePid
  if (existingMember.backendType === 'in-process') {
    runtimeAlive = Boolean(
      Object.values(appState.tasks).find(task => {
        if (!isInProcessTeammateTask(task) || task.status !== 'running') {
          return false
        }
        return task.identity.agentId === existingMember.agentId
      }),
    )
  } else if (paneId && existingMember.backendType === 'tmux') {
    runtimeAlive =
      (await isTmuxPaneAlive(paneId, false)) ||
      (await isTmuxPaneAlive(paneId, true))
  } else if (paneId && existingMember.backendType === 'iterm2') {
    runtimeAlive = await isItermPaneAlive(paneId)
  } else if (existingMember.backendType === 'process') {
    runtimeAlive = persistedProcessPid
      ? await isProcessBackendRuntimeAlive(
          persistedProcessPid,
          existingMember.agentId || canonicalAgentId,
          teamName,
        )
      : false
  } else if (paneId) {
    runtimeAlive = persistedProcessPid
      ? await isProcessBackendRuntimeAlive(
          persistedProcessPid,
          existingMember.agentId || canonicalAgentId,
          teamName,
        )
      : (await isTmuxPaneAlive(paneId, false)) ||
        (await isTmuxPaneAlive(paneId, true)) ||
        (await isItermPaneAlive(paneId))
  } else if (persistedProcessPid) {
    runtimeAlive = await isProcessBackendRuntimeAlive(
      persistedProcessPid,
      existingMember.agentId || canonicalAgentId,
      teamName,
    )
  }

  if (!runtimeAlive) {
    return { decision: 'allow_respawn_after_terminal_failure' }
  }

  const bootstrapConfirmed = await hasBootstrapConfirmation(
    teamName,
    existingMember.agentId || canonicalAgentId,
    existingMember.bootstrapExpectedAfter ?? null,
    existingMember.name || canonicalName,
  )
  return {
    decision: bootstrapConfirmed
      ? 'duplicate_already_running'
      : 'duplicate_bootstrap_pending',
    reason: bootstrapConfirmed ? 'already_running' : 'bootstrap_pending',
  }
}

function buildDuplicateSkippedResult(
  input: SpawnInput,
  teamName: string,
  reason: DuplicateSkippedReason,
  context: ToolUseContext,
): { data: DuplicateSkippedOutput } {
  const appState = context.getAppState()
  const provider = resolveTeammateProvider(input.provider)
  const model = resolveSpawnModel(
    input.model,
    appState.mainLoopModel,
    input.provider,
  )
  const canonicalName = sanitizeAgentName(input.name).trim()
  const teammateId = formatAgentId(canonicalName, teamName)

  logForDebugging(
    `[teammate-spawn] duplicate spawn skipped: team=${teamName} teammate=${canonicalName} reason=${reason}`,
  )

  return {
    data: {
      status: 'duplicate_skipped',
      reason,
      spawned: false,
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type: input.agent_type,
      model,
      provider,
      effort: input.effort,
      name: canonicalName,
      team_name: teamName,
      plan_mode_required: input.plan_mode_required,
    },
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Checks if a tmux session exists
 */
async function hasSession(sessionName: string): Promise<boolean> {
  const result = await execFileNoThrow(TMUX_COMMAND, [
    'has-session',
    '-t',
    sessionName,
  ])
  return result.code === 0
}

/**
 * Creates a new tmux session if it doesn't exist
 */
async function ensureSession(sessionName: string): Promise<void> {
  const exists = await hasSession(sessionName)
  if (!exists) {
    const result = await execFileNoThrow(TMUX_COMMAND, [
      'new-session',
      '-d',
      '-s',
      sessionName,
    ])
    if (result.code !== 0) {
      throw new Error(
        `Failed to create tmux session '${sessionName}': ${result.stderr || 'Unknown error'}`,
      )
    }
  }
}

/**
 * Gets the shell command prefix to spawn a teammate.
 * For native builds (compiled binaries), execute process.execPath directly.
 * For non-native (bun/node running a script), execute the current script via
 * process.execPath plus process.argv[1].
 */
function getTeammateCommand(): string {
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  if (isInBundledMode()) {
    return quote([process.execPath])
  }
  return `${quote([process.execPath])} ${quote([process.argv[1]!])}`
}

function getTeammateCommandArgv(): { command: string; args: string[] } {
  const override = process.env[TEAMMATE_COMMAND_ENV_VAR]?.trim()
  if (override) {
    const parts = parseArguments(override)
    if (parts.length === 0) {
      throw new Error(`${TEAMMATE_COMMAND_ENV_VAR} is set but empty`)
    }
    return { command: parts[0]!, args: parts.slice(1) }
  }
  if (isInBundledMode()) {
    return { command: process.execPath, args: [] }
  }
  return { command: process.execPath, args: [process.argv[1]!] }
}

export function parseProcessBackendPid(value: string | undefined): number | null {
  return parseProcessBackendPidValue(value)
}

export function isProcessBackendCommandForTeammate(
  command: string,
  teammateId: string,
  teamName: string,
): boolean {
  return isProcessBackendCommandForTeammateValue(command, teammateId, teamName)
}

function toTeamFileEffort(
  effort: EffortLevel | undefined,
): 'low' | 'medium' | 'high' | 'max' | undefined {
  return effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'max'
    ? effort
    : undefined
}

export function shouldUseNativeProcessBackendForSpawn(options?: {
  teammateMode?: 'auto' | 'tmux' | 'in-process'
  forceProcessTeammates?: string | boolean
  separateProcessRequired?: boolean
}): boolean {
  const teammateMode = options?.teammateMode ?? getTeammateModeFromSnapshot()
  if (teammateMode !== 'auto') {
    return false
  }

  const forceProcessTeammates =
    options?.forceProcessTeammates ?? process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES
  return isEnvTruthy(forceProcessTeammates) || options?.separateProcessRequired === true
}

export function shouldDetachNativeProcessBackend(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32'
}

const PROCESS_SPAWN_SMOKE_DELAY_MS = 800
const PROCESS_RUNTIME_READY_TIMEOUT_MS = 30_000
const PROCESS_BOOTSTRAP_SUBMITTED_TIMEOUT_MS = 45_000
const PROCESS_LOG_TAIL_BYTES = 8 * 1024
const TEAMMATE_RUNTIME_ENV = 'CLAUDE_CODE_TEAMMATE_RUNTIME'

async function probeNativeProcessTeammateSpawn(
  child: ChildProcess,
  teammateId: string,
): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (failure: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      child.off('error', onError)
      child.off('exit', onExit)
      resolve(failure)
    }

    const onError = (error: Error): void => {
      finish(`Teammate process ${teammateId} failed to start: ${error.message}`)
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const suffix =
        code !== null ? ` with code ${code}` : signal ? ` from signal ${signal}` : ''
      finish(`Teammate process ${teammateId} exited immediately${suffix}.`)
    }

    child.once('error', onError)
    child.once('exit', onExit)
    timer = setTimeout(() => finish(null), PROCESS_SPAWN_SMOKE_DELAY_MS)
  })
}

async function readProcessLogTail(filePath: string): Promise<string> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return raw.slice(-PROCESS_LOG_TAIL_BYTES).trim()
  } catch {
    return ''
  }
}

function finishRuntimeLogStreams(streams: Array<WriteStream | undefined>): void {
  for (const stream of streams) {
    if (!stream || stream.destroyed) {
      continue
    }
    stream.end()
  }
}

/**
 * Builds CLI flags to propagate from the current session to spawned teammates.
 * This ensures teammates inherit important settings like permission mode,
 * model selection, and plugin configuration from their parent.
 *
 * @param options.planModeRequired - If true, don't inherit bypass permissions (plan mode takes precedence)
 * @param options.permissionMode - Permission mode to propagate
 */
function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
  effortValue?: string
  strictMcpConfig?: boolean
  provider?: TeammateProvider
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode, effortValue, strictMcpConfig, provider } = options || {}

  // Propagate permission mode to teammates, but NOT if plan mode is required
  // Plan mode takes precedence over bypass permissions for safety
  if (planModeRequired) {
    // Don't inherit bypass permissions when plan mode is required
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
  } else if (permissionMode === 'auto') {
    // Teammates inherit auto mode so the classifier auto-approves their tool
    // calls too. The teammate's own startup (permissionSetup.ts) handles
    // GrowthBook gate checks and setAutoModeActive(true) independently.
    flags.push('--permission-mode auto')
  }

  // Propagate --model if explicitly set via CLI
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  if (effortValue) {
    flags.push(`--effort ${quote([effortValue])}`)
  }

  // Propagate --settings if set via CLI
  const settingsPath = getFlagSettingsPath()
  const settingsInline = getFlagSettingsInline()
  const appManagedAnthropicSettingsFlag =
    buildAppManagedAnthropicApiKeyHelperSettingsFlag(provider, settingsPath)
  const helperSettingsPath =
    process.env.CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH?.trim()
  const suppressAppManagedAnthropicPath =
    provider !== 'anthropic' &&
    process.env.CLAUDE_TEAM_ANTHROPIC_AUTH_MODE === 'api_key_helper' &&
    !!settingsPath &&
    !!helperSettingsPath &&
    (settingsPath === helperSettingsPath ||
      settingsPath.startsWith(`${dirname(helperSettingsPath)}/`))
  if (settingsPath && !appManagedAnthropicSettingsFlag && !suppressAppManagedAnthropicPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }
  if (appManagedAnthropicSettingsFlag) {
    flags.push(appManagedAnthropicSettingsFlag)
  } else if (settingsInline && (!settingsPath || suppressAppManagedAnthropicPath)) {
    flags.push(`--settings ${quote([JSON.stringify(settingsInline)])}`)
  }

  const disallowedTools = getFlagDisallowedTools()
  for (const disallowedTool of disallowedTools) {
    flags.push(`--disallowedTools ${quote([disallowedTool])}`)
  }

  const mcpConfigs = getFlagMcpConfig()
  for (const mcpConfig of mcpConfigs) {
    flags.push(`--mcp-config ${quote([mcpConfig])}`)
  }
  if (strictMcpConfig || getStrictMcpConfig()) {
    flags.push('--strict-mcp-config')
  }

  // Propagate --plugin-dir for each inline plugin
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // Propagate --chrome / --no-chrome if explicitly set on the CLI
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  return flags.join(' ')
}

/**
 * Generates a unique teammate name by checking existing team members.
 * If the name already exists, appends a numeric suffix (e.g., tester-2, tester-3).
 * @internal Exported for testing
 */
export async function generateUniqueTeammateName(
  baseName: string,
  teamName: string | undefined,
): Promise<string> {
  if (!teamName) {
    return baseName
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    return baseName
  }

  const existingNames = new Set(teamFile.members.map(m => m.name.toLowerCase()))

  // If the base name doesn't exist, use it as-is
  if (!existingNames.has(baseName.toLowerCase())) {
    return baseName
  }

  // Find the next available suffix
  let suffix = 2
  while (existingNames.has(`${baseName}-${suffix}`.toLowerCase())) {
    suffix++
  }

  return `${baseName}-${suffix}`
}

// ============================================================================
// Spawn Handlers
// ============================================================================

/**
 * Handle spawn operation using split-pane view (default).
 * When inside tmux: Creates teammates in a shared window with leader on left, teammates on right.
 * When outside tmux: Creates a claude-swarm session with all teammates in a tiled layout.
 */
async function handleSpawnSplitPane(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, cwd, plan_mode_required } = input
  const provider = resolveTeammateProvider(input.provider)
  const effort = input.effort
  const worktreeInfo = input.worktreeInfo

  // Resolve model: 'inherit' → leader's model; undefined → default Opus alias
  const model = resolveSpawnModel(
    input.model,
    getAppState().mainLoopModel,
    input.provider,
  )

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }
  assertNotWindowsReservedBasename(teamName, 'team_name')
  assertNotWindowsReservedBasename(name, 'name')

  // Persistent team teammates must keep their canonical identity. Duplicate
  // requests are handled before we get here; a legitimate respawn must reuse
  // the same teammate name instead of drifting into alice-2/bob-2.
  const sanitizedName = sanitizeAgentName(name)

  // Generate deterministic agent ID from name and team
  const teammateId = formatAgentId(sanitizedName, teamName)
  const workingDir = worktreeInfo?.worktreePath ?? cwd ?? getCwd()

  // Detect the appropriate backend and check if setup is needed
  let detectionResult = await detectAndGetBackend()

  // If in iTerm2 but it2 isn't set up, prompt the user
  if (detectionResult.needsIt2Setup && context.setToolJSX) {
    const tmuxAvailable = await isTmuxAvailable()

    // Show the setup prompt and wait for user decision
    const setupResult = await new Promise<
      'installed' | 'use-tmux' | 'cancelled'
    >(resolve => {
      context.setToolJSX!({
        jsx: React.createElement(It2SetupPrompt, {
          onDone: resolve,
          tmuxAvailable,
        }),
        shouldHidePromptInput: true,
      })
    })

    // Clear the JSX
    context.setToolJSX(null)

    if (setupResult === 'cancelled') {
      throw new Error('Teammate spawn cancelled - iTerm2 setup required')
    }

    // If they installed it2 or chose tmux, clear cached detection and re-fetch
    // so the local detectionResult matches the backend that will actually
    // spawn the pane.
    // - 'installed': re-detect to pick up the ITermBackend (it2 is now available)
    // - 'use-tmux': re-detect so needsIt2Setup is false (preferTmux is now saved)
    //   and subsequent spawns skip this prompt
    if (setupResult === 'installed' || setupResult === 'use-tmux') {
      resetBackendDetection()
      detectionResult = await detectAndGetBackend()
    }
  }

  // Check if we're inside tmux to determine session naming
  const insideTmux = await isInsideTmux()

  // Assign a unique color to this teammate
  const teammateColor = assignTeammateColor(teammateId)

  // Create a pane in the swarm view
  // - Inside tmux: splits current window (leader on left, teammates on right)
  // - In iTerm2 with it2: uses native iTerm2 split panes
  // - Outside both: creates claude-swarm session with tiled teammates
  const { paneId, isFirstTeammate } = await createTeammatePaneInSwarmView(
    sanitizedName,
    teammateColor,
  )

  // Enable pane border status on first teammate when inside tmux
  // (outside tmux, this is handled in createTeammatePaneInSwarmView)
  if (isFirstTeammate && insideTmux) {
    await enablePaneBorderStatus()
  }

  // Build the command to spawn Claude Code with teammate identity
  // Note: We spawn without a prompt - initial instructions are sent via mailbox
  const binaryPath = getTeammateCommand()

  // Build teammate identity CLI args (replaces CLAUDE_CODE_* env vars)
  const teammateArgs = [
    `--agent-id ${quote([teammateId])}`,
    `--agent-name ${quote([sanitizedName])}`,
    `--team-name ${quote([teamName])}`,
    `--agent-color ${quote([teammateColor])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    plan_mode_required ? '--plan-mode-required' : '',
    agent_type ? `--agent-type ${quote([agent_type])}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // Build CLI flags to propagate to teammate
  // Pass plan_mode_required to prevent inheriting bypass permissions
  let inheritedFlags = buildInheritedCliFlags({
    planModeRequired: plan_mode_required,
    permissionMode: appState.toolPermissionContext.mode,
    effortValue: typeof appState.effortValue === 'string' ? appState.effortValue : undefined,
    strictMcpConfig: Boolean(teamName),
    provider,
  })

  if (crossesProviderBoundary(input.provider)) {
    inheritedFlags = stripProviderBoundaryInheritedRuntimeFlags(inheritedFlags)
  }

  // If teammate has a custom model, add --model flag (or replace inherited one)
  if (model) {
    // Remove any inherited --model flag first
    inheritedFlags = stripInheritedModelFlag(inheritedFlags)
    // Add the teammate's model
    inheritedFlags = inheritedFlags
      ? `${inheritedFlags} --model ${quote([model])}`
      : `--model ${quote([model])}`
  }

  if (effort) {
    inheritedFlags = stripInheritedEffortFlag(inheritedFlags)
    inheritedFlags = inheritedFlags
      ? `${inheritedFlags} --effort ${quote([effort])}`
      : `--effort ${quote([effort])}`
  }

  const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
  // Propagate env vars that teammates need but may not inherit from tmux split-window shells.
  // Includes CLAUDECODE, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, and API provider vars.
  logTeammateSpawnSnapshot({
    teamName,
    teammateName: sanitizedName,
    provider,
    model,
    effort,
    prompt,
    strictMcpConfig: Boolean(teamName),
  })
  const startupReadySentinel =
    detectionResult.backend.type === 'tmux'
      ? await createSpawnReadySentinel()
      : undefined
  const launchBoundaryIso = new Date().toISOString()
  const bootstrapProofToken = randomUUID()
  // This id fences transport/evidence rows for one concrete process launch.
  // It prevents stale runtime JSONL from a previous process with the same
  // member name from satisfying this launch.
  const bootstrapRunId = input.bootstrapRunId ?? getSessionId()
  const runtimePaths = getTeammateRuntimePaths({
    teamName,
    agentName: sanitizedName,
  })
  await ensureTeammateRuntimePaths(runtimePaths)
  const nativeAppManagedBootstrapEnv =
    await prepareNativeAppManagedBootstrapContextFile({
      teamName,
      memberName: sanitizedName,
      agentId: teammateId,
      provider,
      runId: bootstrapRunId,
      bootstrapProofToken,
      spec: input.nativeAppManagedBootstrap,
    })
  try {
    const envStr = buildInheritedEnvVars({
      provider,
      extraEnv: {
        ...worktreeEnv(worktreeInfo),
        ...nativeAppManagedBootstrapEnv,
        [TEAMMATE_RUNTIME_EVENTS_ENV]: runtimePaths.eventsPath,
        [TEAMMATE_BOOTSTRAP_PROOF_TOKEN_ENV]: bootstrapProofToken,
        ...(startupReadySentinel
          ? {
              [TEAMMATE_STARTUP_READY_SENTINEL_ENV]:
                startupReadySentinel.filePath,
            }
          : {}),
      },
    })
    const spawnCommand = wrapTeammateSpawnCommand(
      `cd ${quote([workingDir])} && env ${envStr} ${binaryPath} ${teammateArgs}${flagsStr}`,
    )
    const paneCommand = await buildPaneLauncherCommand(spawnCommand)

    // Send the command to the new pane
    // Use swarm socket when running outside tmux (external swarm session)
    await sendCommandToPane(paneId, paneCommand, !insideTmux)

    if (detectionResult.backend.type === 'tmux') {
      const spawnFailure = await probeTmuxTeammateSpawn(paneId, {
        useExternalSession: !insideTmux,
        readySentinelPath: startupReadySentinel?.filePath,
      })
      if (spawnFailure) {
        await detectionResult.backend.killPane(paneId, !insideTmux)
        throw new Error(spawnFailure)
      }
    }
  } finally {
    await cleanupSpawnReadySentinelDir(startupReadySentinel?.dir)
  }

  // Determine session/window names for output
  const sessionName = insideTmux ? 'current' : SWARM_SESSION_NAME
  const windowName = insideTmux ? 'current' : 'swarm-view'

  // Track the teammate in AppState's teamContext with color
  // If spawning without spawnTeam, set up the leader as team lead
  setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
      teamFilePath: prev.teamContext?.teamFilePath ?? '',
      leadAgentId: prev.teamContext?.leadAgentId ?? '',
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [teammateId]: {
          name: sanitizedName,
          agentType: agent_type,
          color: teammateColor,
          tmuxSessionName: sessionName,
          tmuxPaneId: paneId,
          cwd: workingDir,
          ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // Register background task so teammates appear in the tasks pill/dialog
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux,
    backendType: detectionResult.backend.type,
    toolUseId: context.toolUseId,
    worktreeInfo,
  })

  // Register agent in the team file
  const updateResult = await updateTeamFileAsync(teamName, teamFile =>
    upsertTeamMember(teamFile, {
      agentId: teammateId,
      name: sanitizedName,
      agentType: agent_type,
      model,
      provider,
      effort,
      prompt,
      color: teammateColor,
      planModeRequired: plan_mode_required,
      joinedAt: Date.now(),
      bootstrapExpectedAfter: launchBoundaryIso,
      bootstrapProofToken,
      bootstrapRunId,
      bootstrapRuntimeEventsPath: runtimePaths.eventsPath,
      ...(input.nativeAppManagedBootstrap
        ? {
            bootstrapProofMode: 'native_app_managed_context',
            bootstrapContextHash: input.nativeAppManagedBootstrap.contextHash,
            bootstrapBriefingHash: input.nativeAppManagedBootstrap.briefingHash,
          }
        : {}),
      tmuxPaneId: paneId,
      cwd: workingDir,
      ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
      ...(worktreeInfo?.worktreeBranch ? { worktreeBranch: worktreeInfo.worktreeBranch } : {}),
      ...(worktreeInfo?.headCommit ? { worktreeHeadCommit: worktreeInfo.headCommit } : {}),
      ...(worktreeInfo?.gitRoot ? { worktreeGitRoot: worktreeInfo.gitRoot } : {}),
      ...(worktreeInfo?.hookBased ? { worktreeHookBased: true } : {}),
      ...(worktreeInfo?.baseWorkspaceRoot
        ? { worktreeBaseWorkspaceRoot: worktreeInfo.baseWorkspaceRoot }
        : {}),
      ...(worktreeInfo?.dirtyLeaderWarning
        ? { worktreeDirtyWarning: worktreeInfo.dirtyLeaderWarning }
        : {}),
      subscriptions: [],
      backendType: detectionResult.backend.type,
    }),
  )
  if (updateResult.status === 'missing') {
    throw new Error(
      `Team "${teamName}" does not exist. Call spawnTeam first to create the team.`,
    )
  }

  // Send initial instructions to teammate via mailbox
  // The teammate's inbox poller will pick this up and submit it as their first turn
  await writeToMailbox(
    sanitizedName,
    {
      from: TEAM_LEAD_NAME,
      text: prompt,
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      provider,
      effort,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: sessionName,
      tmux_window_name: windowName,
      tmux_pane_id: paneId,
      team_name: teamName,
      is_splitpane: true,
      backend_type: detectionResult.backend.type,
      plan_mode_required,
      ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
      ...(worktreeInfo?.worktreeBranch ? { worktreeBranch: worktreeInfo.worktreeBranch } : {}),
      ...(worktreeInfo?.dirtyLeaderWarning
        ? { dirtyLeaderWarning: worktreeInfo.dirtyLeaderWarning }
        : {}),
    },
  }
}

/**
 * Handle spawn operation using separate windows (legacy behavior).
 * Creates each teammate in its own tmux window.
 */
async function handleSpawnSeparateWindow(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, cwd, plan_mode_required } = input
  const provider = resolveTeammateProvider(input.provider)
  const effort = input.effort
  const worktreeInfo = input.worktreeInfo

  // Resolve model: 'inherit' → leader's model; undefined → default Opus alias
  const model = resolveSpawnModel(
    input.model,
    getAppState().mainLoopModel,
    input.provider,
  )

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // Persistent team teammates must keep their canonical identity. Duplicate
  // requests are handled before we get here; a legitimate respawn must reuse
  // the same teammate name instead of drifting into alice-2/bob-2.
  const sanitizedName = sanitizeAgentName(name)

  // Generate deterministic agent ID from name and team
  const teammateId = formatAgentId(sanitizedName, teamName)
  const windowName = `teammate-${sanitizeName(sanitizedName)}`
  const workingDir = worktreeInfo?.worktreePath ?? cwd ?? getCwd()

  // Ensure the swarm session exists
  await ensureSession(SWARM_SESSION_NAME)

  // Assign a unique color to this teammate
  const teammateColor = assignTeammateColor(teammateId)

  // Create a new window for this teammate
  const createWindowResult = await execFileNoThrow(TMUX_COMMAND, [
    'new-window',
    '-t',
    SWARM_SESSION_NAME,
    '-n',
    windowName,
    '-P',
    '-F',
    '#{pane_id}',
  ])

  if (createWindowResult.code !== 0) {
    throw new Error(
      `Failed to create tmux window: ${createWindowResult.stderr}`,
    )
  }

  const paneId = createWindowResult.stdout.trim()

  // Build the command to spawn Claude Code with teammate identity
  // Note: We spawn without a prompt - initial instructions are sent via mailbox
  const binaryPath = getTeammateCommand()

  // Build teammate identity CLI args (replaces CLAUDE_CODE_* env vars)
  const teammateArgs = [
    `--agent-id ${quote([teammateId])}`,
    `--agent-name ${quote([sanitizedName])}`,
    `--team-name ${quote([teamName])}`,
    `--agent-color ${quote([teammateColor])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    plan_mode_required ? '--plan-mode-required' : '',
    agent_type ? `--agent-type ${quote([agent_type])}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // Build CLI flags to propagate to teammate
  // Pass plan_mode_required to prevent inheriting bypass permissions
  let inheritedFlags = buildInheritedCliFlags({
    planModeRequired: plan_mode_required,
    permissionMode: appState.toolPermissionContext.mode,
    effortValue: typeof appState.effortValue === 'string' ? appState.effortValue : undefined,
    strictMcpConfig: Boolean(teamName),
    provider,
  })

  if (crossesProviderBoundary(input.provider)) {
    inheritedFlags = stripProviderBoundaryInheritedRuntimeFlags(inheritedFlags)
  }

  // If teammate has a custom model, add --model flag (or replace inherited one)
  if (model) {
    // Remove any inherited --model flag first
    inheritedFlags = stripInheritedModelFlag(inheritedFlags)
    // Add the teammate's model
    inheritedFlags = inheritedFlags
      ? `${inheritedFlags} --model ${quote([model])}`
      : `--model ${quote([model])}`
  }

  if (effort) {
    inheritedFlags = stripInheritedEffortFlag(inheritedFlags)
    inheritedFlags = inheritedFlags
      ? `${inheritedFlags} --effort ${quote([effort])}`
      : `--effort ${quote([effort])}`
  }

  const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
  // Propagate env vars that teammates need but may not inherit from tmux split-window shells.
  // Includes CLAUDECODE, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, and API provider vars.
  logTeammateSpawnSnapshot({
    teamName,
    teammateName: sanitizedName,
    provider,
    model,
    effort,
    prompt,
    strictMcpConfig: Boolean(teamName),
  })
  const startupReadySentinel = await createSpawnReadySentinel()
  const launchBoundaryIso = new Date().toISOString()
  const bootstrapProofToken = randomUUID()
  const bootstrapRunId = input.bootstrapRunId ?? getSessionId()
  const runtimePaths = getTeammateRuntimePaths({
    teamName,
    agentName: sanitizedName,
  })
  await ensureTeammateRuntimePaths(runtimePaths)
  const nativeAppManagedBootstrapEnv =
    await prepareNativeAppManagedBootstrapContextFile({
      teamName,
      memberName: sanitizedName,
      agentId: teammateId,
      provider,
      runId: bootstrapRunId,
      bootstrapProofToken,
      spec: input.nativeAppManagedBootstrap,
    })
  try {
    const envStr = buildInheritedEnvVars({
      provider,
      extraEnv: {
        ...worktreeEnv(worktreeInfo),
        ...nativeAppManagedBootstrapEnv,
        [TEAMMATE_RUNTIME_EVENTS_ENV]: runtimePaths.eventsPath,
        [TEAMMATE_BOOTSTRAP_PROOF_TOKEN_ENV]: bootstrapProofToken,
        [TEAMMATE_STARTUP_READY_SENTINEL_ENV]: startupReadySentinel.filePath,
      },
    })
    const spawnCommand = wrapTeammateSpawnCommand(
      `cd ${quote([workingDir])} && env ${envStr} ${binaryPath} ${teammateArgs}${flagsStr}`,
    )
    const paneCommand = await buildPaneLauncherCommand(spawnCommand)

    // Send the command to the new window
    const sendKeysResult = await execFileNoThrow(TMUX_COMMAND, [
      'send-keys',
      '-t',
      `${SWARM_SESSION_NAME}:${windowName}`,
      paneCommand,
      'Enter',
    ])

    if (sendKeysResult.code !== 0) {
      throw new Error(
        `Failed to send command to tmux window: ${sendKeysResult.stderr}`,
      )
    }

    const spawnFailure = await probeTmuxTeammateSpawn(paneId, {
      useExternalSession: true,
      readySentinelPath: startupReadySentinel.filePath,
    })
    if (spawnFailure) {
      await getBackendByType('tmux').killPane(paneId, true)
      throw new Error(spawnFailure)
    }
  } finally {
    await cleanupSpawnReadySentinelDir(startupReadySentinel.dir)
  }

  // Track the teammate in AppState's teamContext
  setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
      teamFilePath: prev.teamContext?.teamFilePath ?? '',
      leadAgentId: prev.teamContext?.leadAgentId ?? '',
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [teammateId]: {
          name: sanitizedName,
          agentType: agent_type,
          color: teammateColor,
          tmuxSessionName: SWARM_SESSION_NAME,
          tmuxPaneId: paneId,
          cwd: workingDir,
          ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // Register background task so tmux teammates appear in the tasks pill/dialog
  // Separate window spawns are always outside tmux (external swarm session)
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux: false,
    backendType: 'tmux',
    toolUseId: context.toolUseId,
    worktreeInfo,
  })

  // Register agent in the team file
  const updateResult = await updateTeamFileAsync(teamName, teamFile =>
    upsertTeamMember(teamFile, {
      agentId: teammateId,
      name: sanitizedName,
      agentType: agent_type,
      model,
      provider,
      effort,
      prompt,
      color: teammateColor,
      planModeRequired: plan_mode_required,
      joinedAt: Date.now(),
      bootstrapExpectedAfter: launchBoundaryIso,
      bootstrapProofToken,
      bootstrapRunId,
      bootstrapRuntimeEventsPath: runtimePaths.eventsPath,
      ...(input.nativeAppManagedBootstrap
        ? {
            bootstrapProofMode: 'native_app_managed_context',
            bootstrapContextHash: input.nativeAppManagedBootstrap.contextHash,
            bootstrapBriefingHash: input.nativeAppManagedBootstrap.briefingHash,
          }
        : {}),
      tmuxPaneId: paneId,
      cwd: workingDir,
      ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
      ...(worktreeInfo?.worktreeBranch ? { worktreeBranch: worktreeInfo.worktreeBranch } : {}),
      ...(worktreeInfo?.headCommit ? { worktreeHeadCommit: worktreeInfo.headCommit } : {}),
      ...(worktreeInfo?.gitRoot ? { worktreeGitRoot: worktreeInfo.gitRoot } : {}),
      ...(worktreeInfo?.hookBased ? { worktreeHookBased: true } : {}),
      ...(worktreeInfo?.baseWorkspaceRoot
        ? { worktreeBaseWorkspaceRoot: worktreeInfo.baseWorkspaceRoot }
        : {}),
      ...(worktreeInfo?.dirtyLeaderWarning
        ? { worktreeDirtyWarning: worktreeInfo.dirtyLeaderWarning }
        : {}),
      subscriptions: [],
      backendType: 'tmux', // This handler always uses tmux directly
    }),
  )
  if (updateResult.status === 'missing') {
    throw new Error(
      `Team "${teamName}" does not exist. Call spawnTeam first to create the team.`,
    )
  }

  // Send initial instructions to teammate via mailbox
  // The teammate's inbox poller will pick this up and submit it as their first turn
  await writeToMailbox(
    sanitizedName,
    {
      from: TEAM_LEAD_NAME,
      text: prompt,
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      provider,
      effort,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: SWARM_SESSION_NAME,
      tmux_window_name: windowName,
      tmux_pane_id: paneId,
      team_name: teamName,
      is_splitpane: false,
      backend_type: 'tmux',
      plan_mode_required,
      ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
      ...(worktreeInfo?.worktreeBranch ? { worktreeBranch: worktreeInfo.worktreeBranch } : {}),
      ...(worktreeInfo?.dirtyLeaderWarning
        ? { dirtyLeaderWarning: worktreeInfo.dirtyLeaderWarning }
        : {}),
    },
  }
}

/**
 * Register a background task entry for an out-of-process (tmux/iTerm2) teammate.
 * This makes tmux teammates visible in the background tasks pill and dialog,
 * matching how in-process teammates are tracked.
 */
function registerOutOfProcessTeammateTask(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux,
    backendType,
    toolUseId,
    worktreeInfo,
  }: {
    teammateId: string
    sanitizedName: string
    teamName: string
    teammateColor: string
    prompt: string
    plan_mode_required?: boolean
    paneId: string
    insideTmux: boolean
    backendType: BackendType
    toolUseId?: string
    worktreeInfo?: TeammateWorktreeInfo
  },
): void {
  const taskId = generateTaskId('in_process_teammate')
  const description = `${sanitizedName}: ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`

  const abortController = new AbortController()

  const taskState: InProcessTeammateTaskState = {
    ...createTaskStateBase(
      taskId,
      'in_process_teammate',
      description,
      toolUseId,
    ),
    type: 'in_process_teammate',
    status: 'running',
    identity: {
      agentId: teammateId,
      agentName: sanitizedName,
      teamName,
      color: teammateColor,
      planModeRequired: plan_mode_required ?? false,
      parentSessionId: getSessionId(),
    },
    prompt,
    ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
    ...(worktreeInfo?.worktreeBranch ? { worktreeBranch: worktreeInfo.worktreeBranch } : {}),
    ...(worktreeInfo?.baseWorkspaceRoot
      ? { baseWorkspaceRoot: worktreeInfo.baseWorkspaceRoot }
      : {}),
    ...(worktreeInfo?.dirtyLeaderWarning
      ? { dirtyLeaderWarning: worktreeInfo.dirtyLeaderWarning }
      : {}),
    abortController,
    awaitingPlanApproval: false,
    permissionMode: plan_mode_required ? 'plan' : 'default',
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingUserMessages: [],
  }

  registerTask(taskState, setAppState)

  // When abort is signaled, kill the pane using the backend that created it
  // (tmux kill-pane for tmux panes, it2 session close for iTerm2 native panes).
  // SDK task_notification bookend is emitted by killInProcessTeammate (the
  // sole abort trigger for this controller).
  abortController.signal.addEventListener(
    'abort',
    () => {
      if (isPaneBackend(backendType)) {
        void getBackendByType(backendType).killPane(paneId, !insideTmux)
      } else if (backendType === 'process') {
        void killProcessBackendRuntime(paneId, {
          signal: 'SIGTERM',
          expectedAgentId: teammateId,
          teamName,
        })
      }
    },
    { once: true },
  )
}

/**
 * Handle spawn operation for separate CLI processes without terminal panes.
 * This is the Windows-friendly fallback when the desktop host requires real
 * teammate processes but tmux/iTerm2 panes are unavailable.
 */
async function handleSpawnNativeProcess(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, plan_mode_required } = input
  const { provider } = getSeparateProcessRequirement(input.provider)
  const model = resolveSpawnModel(
    input.model,
    getAppState().mainLoopModel,
    input.provider,
  )
  const effort = input.effort
  const worktreeInfo = input.worktreeInfo

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName
  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }
  assertNotWindowsReservedBasename(teamName, 'team_name')
  assertNotWindowsReservedBasename(name, 'name')

  const sanitizedName = sanitizeAgentName(name)
  const teammateId = formatAgentId(sanitizedName, teamName)
  const teammateColor = assignTeammateColor(teammateId)
  const workingDir = worktreeInfo?.worktreePath ?? input.cwd ?? getCwd()
  const runtimePaths = getTeammateRuntimePaths({
    teamName,
    agentName: sanitizedName,
  })

  try {
    await access(workingDir)
  } catch (error) {
    throw new Error(
      `Teammate "${sanitizedName}" cannot start because cwd "${workingDir}" is unavailable: ${errorMessage(error)}`,
    )
  }
  if (!isPathTrusted(workingDir)) {
    throw new Error(
      `Teammate "${sanitizedName}" cannot start in headless process runtime because workspace trust is not accepted for "${workingDir}". Open that workspace once interactively and accept trust, then launch the team again.`,
    )
  }
  await ensureTeammateRuntimePaths(runtimePaths)
  await writeFile(runtimePaths.eventsPath, '', {
    encoding: 'utf8',
    mode: 0o600,
  })

  const teammateArgs = [
    '--teammate-runtime',
    'headless',
    '--agent-id',
    teammateId,
    '--agent-name',
    sanitizedName,
    '--team-name',
    teamName,
    '--agent-color',
    teammateColor,
    '--parent-session-id',
    getSessionId(),
    ...(plan_mode_required ? ['--plan-mode-required'] : []),
    ...(agent_type ? ['--agent-type', agent_type] : []),
  ]

  let inheritedFlags = buildInheritedCliFlags({
    planModeRequired: plan_mode_required,
    permissionMode: appState.toolPermissionContext.mode,
    effortValue:
      typeof appState.effortValue === 'string' ? appState.effortValue : undefined,
    strictMcpConfig: Boolean(teamName),
    provider,
  })

  if (crossesProviderBoundary(input.provider)) {
    inheritedFlags = stripProviderBoundaryInheritedRuntimeFlags(inheritedFlags)
  }
  if (model) {
    inheritedFlags = stripInheritedModelFlag(inheritedFlags)
    inheritedFlags = inheritedFlags
      ? `${inheritedFlags} --model ${quote([model])}`
      : `--model ${quote([model])}`
  }
  if (effort) {
    inheritedFlags = stripInheritedEffortFlag(inheritedFlags)
    inheritedFlags = inheritedFlags
      ? `${inheritedFlags} --effort ${quote([effort])}`
      : `--effort ${quote([effort])}`
  }

  logTeammateSpawnSnapshot({
    teamName,
    teammateName: sanitizedName,
    provider,
    model,
    effort,
    prompt,
    strictMcpConfig: Boolean(teamName),
  })

  const { command, args: commandArgs } = getTeammateCommandArgv()
  const argv = [...commandArgs, ...teammateArgs, ...parseArguments(inheritedFlags)]
  const launchBoundaryIso = new Date().toISOString()
  const bootstrapProofToken = randomUUID()
  const bootstrapRunId = input.bootstrapRunId ?? getSessionId()
  const persistedEffort = toTeamFileEffort(effort)
  let child: ChildProcess | null = null
  let stdoutLog: WriteStream | undefined
  let stderrLog: WriteStream | undefined
  const startupReadySentinel = await createSpawnReadySentinel()
  const nativeAppManagedBootstrapEnv =
    await prepareNativeAppManagedBootstrapContextFile({
      teamName,
      memberName: sanitizedName,
      agentId: teammateId,
      provider,
      runId: bootstrapRunId,
      bootstrapProofToken,
      spec: input.nativeAppManagedBootstrap,
    })

  try {
    stdoutLog = createWriteStream(runtimePaths.stdoutPath, {
      flags: 'a',
      mode: 0o600,
    })
    stderrLog = createWriteStream(runtimePaths.stderrPath, {
      flags: 'a',
      mode: 0o600,
    })
    stdoutLog.on('error', error => {
      logForDebugging(
        `[handleSpawnNativeProcess] stdout log write failed for ${teammateId}: ${error.message}`,
        { level: 'warn' },
      )
    })
    stderrLog.on('error', error => {
      logForDebugging(
        `[handleSpawnNativeProcess] stderr log write failed for ${teammateId}: ${error.message}`,
        { level: 'warn' },
      )
    })

    child = spawn(command, argv, {
      cwd: workingDir,
      detached: shouldDetachNativeProcessBackend(),
      env: {
        ...process.env,
        ...buildInheritedEnvObject({
          provider,
          extraEnv: {
            ...worktreeEnv(worktreeInfo),
            ...nativeAppManagedBootstrapEnv,
            [TEAMMATE_RUNTIME_ENV]: 'headless',
            [TEAMMATE_STARTUP_READY_SENTINEL_ENV]:
              startupReadySentinel.filePath,
            [TEAMMATE_RUNTIME_EVENTS_ENV]: runtimePaths.eventsPath,
            [TEAMMATE_BOOTSTRAP_PROOF_TOKEN_ENV]: bootstrapProofToken,
          },
        }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    if (!child.pid) {
      throw new Error(`Failed to spawn teammate process for ${teammateId}: missing pid`)
    }

    const runtimePid = child.pid
    const processPaneId = buildProcessBackendPaneId(runtimePid)
    child.stdin?.on('error', error => {
      logForDebugging(
        `[handleSpawnNativeProcess] stdin pipe failed for ${teammateId}: ${error.message}`,
        { level: 'warn' },
      )
    })
    child.stdout?.pipe(stdoutLog)
    child.stderr?.pipe(stderrLog)
    ;(child.stdin as { unref?: () => void } | null)?.unref?.()
    ;(child.stdout as { unref?: () => void } | null)?.unref?.()
    ;(child.stderr as { unref?: () => void } | null)?.unref?.()
    child.once('close', (code, signal) => {
      void writeParentOwnedTeammateRuntimeEvent({
        type: 'exited',
        eventsPath: runtimePaths.eventsPath,
        pid: runtimePid,
        teamName,
        agentName: sanitizedName,
        agentId: teammateId,
        runId: getSessionId(),
        bootstrapRunId,
        source: 'spawnMultiAgent.process',
        detail:
          code !== null
            ? `process exited with code ${code}`
            : signal
              ? `process exited from signal ${signal}`
              : 'process exited',
      })
      finishRuntimeLogStreams([stdoutLog, stderrLog])
    })
    child.once('error', error => {
      void writeParentOwnedTeammateRuntimeEvent({
        type: 'failed',
        eventsPath: runtimePaths.eventsPath,
        pid: runtimePid,
        teamName,
        agentName: sanitizedName,
        agentId: teammateId,
        runId: getSessionId(),
        bootstrapRunId,
        source: 'spawnMultiAgent.process',
        detail: `process error: ${error.message}`,
      })
    })
    await writeParentOwnedTeammateRuntimeEvent({
      type: 'process_spawned',
      eventsPath: runtimePaths.eventsPath,
      pid: runtimePid,
      teamName,
      agentName: sanitizedName,
      agentId: teammateId,
      runId: getSessionId(),
      bootstrapRunId,
      source: 'spawnMultiAgent.process',
      detail: 'process spawned',
    })
    await writeParentOwnedTeammateRuntimeEvent({
      type: 'stdout_attached',
      eventsPath: runtimePaths.eventsPath,
      pid: runtimePid,
      teamName,
      agentName: sanitizedName,
      agentId: teammateId,
      runId: getSessionId(),
      bootstrapRunId,
      source: 'spawnMultiAgent.process',
      detail: 'stdout and stderr attached',
    })
    const spawnFailure = await probeNativeProcessTeammateSpawn(child, teammateId)
    if (spawnFailure) {
      killProcessTree(runtimePid, 'SIGTERM')
      await writeParentOwnedTeammateRuntimeEvent({
        type: 'failed',
        eventsPath: runtimePaths.eventsPath,
        pid: runtimePid,
        teamName,
        agentName: sanitizedName,
        agentId: teammateId,
        runId: getSessionId(),
        bootstrapRunId,
        source: 'spawnMultiAgent.process',
        detail: spawnFailure,
      })
      const stderrTail = await readProcessLogTail(runtimePaths.stderrPath)
      throw new Error(
        stderrTail ? `${spawnFailure}\nLast stderr:\n${stderrTail}` : spawnFailure,
      )
    }

    const runtimeReady = await waitForTeammateRuntimeEvent({
      eventsPath: runtimePaths.eventsPath,
      type: 'runtime_ready',
      timeoutMs: PROCESS_RUNTIME_READY_TIMEOUT_MS,
      pid: runtimePid,
      isStillAlive: () => isProcessAlive(runtimePid),
    })
    if (!runtimeReady.ok) {
      killProcessTree(runtimePid, 'SIGTERM')
      const stderrTail = await readProcessLogTail(runtimePaths.stderrPath)
      const stdoutTail = await readProcessLogTail(runtimePaths.stdoutPath)
      const detail = [
        runtimeReady.reason,
        stderrTail ? `Last stderr:\n${stderrTail}` : '',
        stdoutTail ? `Last stdout:\n${stdoutTail}` : '',
      ]
        .filter(Boolean)
        .join('\n')
      await writeParentOwnedTeammateRuntimeEvent({
        type: 'failed',
        eventsPath: runtimePaths.eventsPath,
        pid: runtimePid,
        teamName,
        agentName: sanitizedName,
        agentId: teammateId,
        runId: getSessionId(),
        bootstrapRunId,
        source: 'spawnMultiAgent.process',
        detail,
      })
      throw new Error(
        `Teammate process ${teammateId} did not become runtime_ready: ${detail}`,
      )
    }

    const updateResult = await updateTeamFileAsync(teamName, teamFile =>
      upsertTeamMember(teamFile, {
        agentId: teammateId,
        name: sanitizedName,
        agentType: agent_type,
        model,
        provider,
        effort: persistedEffort,
        prompt,
        color: teammateColor,
        planModeRequired: plan_mode_required,
        joinedAt: Date.now(),
        bootstrapExpectedAfter: launchBoundaryIso,
        bootstrapProofToken,
        bootstrapRunId,
        bootstrapRuntimeEventsPath: runtimePaths.eventsPath,
        ...(input.nativeAppManagedBootstrap
          ? {
              bootstrapProofMode: 'native_app_managed_context',
              bootstrapContextHash: input.nativeAppManagedBootstrap.contextHash,
              bootstrapBriefingHash: input.nativeAppManagedBootstrap.briefingHash,
            }
          : {}),
        tmuxPaneId: processPaneId,
        runtimePid,
        cwd: workingDir,
        ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
        ...(worktreeInfo?.worktreeBranch ? { worktreeBranch: worktreeInfo.worktreeBranch } : {}),
        ...(worktreeInfo?.headCommit ? { worktreeHeadCommit: worktreeInfo.headCommit } : {}),
        ...(worktreeInfo?.gitRoot ? { worktreeGitRoot: worktreeInfo.gitRoot } : {}),
        ...(worktreeInfo?.hookBased ? { worktreeHookBased: true } : {}),
        ...(worktreeInfo?.baseWorkspaceRoot
          ? { worktreeBaseWorkspaceRoot: worktreeInfo.baseWorkspaceRoot }
          : {}),
        ...(worktreeInfo?.dirtyLeaderWarning
          ? { worktreeDirtyWarning: worktreeInfo.dirtyLeaderWarning }
          : {}),
        subscriptions: [],
        backendType: 'process',
      }),
    )
    if (updateResult.status === 'missing') {
      throw new Error(
        `Team "${teamName}" does not exist. Call spawnTeam first to create the team.`,
      )
    }

    await writeToMailbox(
      sanitizedName,
      {
        from: TEAM_LEAD_NAME,
        text: prompt,
        timestamp: new Date().toISOString(),
      },
      teamName,
    )
    // The app wrote the prompt into the teammate mailbox. The child still has
    // to observe and submit it; this event is progress evidence, not readiness.
    await writeParentOwnedTeammateRuntimeEvent({
      type: 'mailbox_bootstrap_written',
      eventsPath: runtimePaths.eventsPath,
      pid: runtimePid,
      teamName,
      agentName: sanitizedName,
      agentId: teammateId,
      runId: getSessionId(),
      bootstrapRunId,
      source: 'spawnMultiAgent.process',
    })

    const inboxPollerReady = await waitForTeammateRuntimeEvent({
      eventsPath: runtimePaths.eventsPath,
      type: 'inbox_poller_ready',
      timeoutMs: 10_000,
      pid: runtimePid,
      isStillAlive: () => isProcessAlive(runtimePid),
    })
    if (!inboxPollerReady.ok) {
      // After team metadata registration, cleanup goes through the process
      // backend guard so a reused pid cannot be killed without matching the
      // expected agent/team identity.
      await killProcessBackendRuntime(processPaneId, {
        expectedAgentId: teammateId,
        teamName,
      })
      await writeParentOwnedTeammateRuntimeEvent({
        type: 'failed',
        eventsPath: runtimePaths.eventsPath,
        pid: runtimePid,
        teamName,
        agentName: sanitizedName,
        agentId: teammateId,
        runId: getSessionId(),
        bootstrapRunId,
        source: 'spawnMultiAgent.process',
        detail: inboxPollerReady.reason,
      })
      throw new Error(
        `Teammate process ${teammateId} did not become inbox_poller_ready: ${inboxPollerReady.reason}`,
      )
    }

    const bootstrapSubmitted = await waitForBootstrapSubmissionOutcome({
      eventsPath: runtimePaths.eventsPath,
      // Process-backend teammates may need a full model turn after the mailbox
      // row is written before the child records bootstrap_submitted. Keep this
      // bounded, but avoid killing slow Anthropic/Codex teammates at 15s.
      timeoutMs: PROCESS_BOOTSTRAP_SUBMITTED_TIMEOUT_MS,
      pid: runtimePid,
      teamName,
      agentName: sanitizedName,
      agentId: teammateId,
      bootstrapRunId,
      sinceMs: Date.parse(launchBoundaryIso),
      isStillAlive: () => isProcessAlive(runtimePid),
    })
    if (bootstrapSubmitted.type !== 'submitted') {
      // Same guarded cleanup path as above: bootstrap transport failure is
      // terminal for this launch, but process termination must remain scoped.
      await killProcessBackendRuntime(processPaneId, {
        expectedAgentId: teammateId,
        teamName,
      })
      const stderrTail = await readProcessLogTail(runtimePaths.stderrPath)
      const detail = stderrTail
        ? `${bootstrapSubmitted.reason}\nLast stderr:\n${stderrTail}`
        : bootstrapSubmitted.reason
      await writeParentOwnedTeammateRuntimeEvent({
        type: 'failed',
        eventsPath: runtimePaths.eventsPath,
        pid: runtimePid,
        teamName,
        agentName: sanitizedName,
        agentId: teammateId,
        runId: getSessionId(),
        bootstrapRunId,
        source: 'spawnMultiAgent.process',
        detail,
      })
      throw new Error(
        `Teammate process ${teammateId} did not submit bootstrap prompt: ${detail}`,
      )
    }

    setAppState(prev => ({
      ...prev,
      teamContext: {
        ...prev.teamContext,
        teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
        teamFilePath: prev.teamContext?.teamFilePath ?? '',
        leadAgentId: prev.teamContext?.leadAgentId ?? '',
        teammates: {
          ...(prev.teamContext?.teammates || {}),
          [teammateId]: {
            name: sanitizedName,
            agentType: agent_type,
            color: teammateColor,
            tmuxSessionName: 'process',
            tmuxPaneId: processPaneId,
            cwd: workingDir,
            ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
            spawnedAt: Date.now(),
          },
        },
      },
    }))

    registerOutOfProcessTeammateTask(setAppState, {
      teammateId,
      sanitizedName,
      teamName,
      teammateColor,
      prompt,
      plan_mode_required,
      paneId: processPaneId,
      insideTmux: false,
      backendType: 'process',
      toolUseId: context.toolUseId,
      worktreeInfo,
    })

    child.unref()
    logForDebugging(
      `[handleSpawnNativeProcess] Spawned teammate ${teammateId} as pid ${runtimePid}`,
    )

    return {
      data: {
        teammate_id: teammateId,
        agent_id: teammateId,
        agent_type,
        model,
        provider,
        effort,
        name: sanitizedName,
        color: teammateColor,
        tmux_session_name: 'process',
        tmux_window_name: 'process',
        tmux_pane_id: processPaneId,
        team_name: teamName,
        is_splitpane: false,
        backend_type: 'process',
        runtime_pid: runtimePid,
        runtime_events_log: runtimePaths.eventsPath,
        runtime_stdout_log: runtimePaths.stdoutPath,
        runtime_stderr_log: runtimePaths.stderrPath,
        plan_mode_required,
        ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
        ...(worktreeInfo?.worktreeBranch ? { worktreeBranch: worktreeInfo.worktreeBranch } : {}),
        ...(worktreeInfo?.dirtyLeaderWarning
          ? { dirtyLeaderWarning: worktreeInfo.dirtyLeaderWarning }
          : {}),
      },
    }
  } catch (error) {
    if (child?.pid) {
      killProcessTree(child.pid, 'SIGTERM')
    }
    finishRuntimeLogStreams([stdoutLog, stderrLog])
    throw error
  } finally {
    void cleanupSpawnReadySentinelDir(startupReadySentinel.dir)
  }
}

/**
 * Handle spawn operation for in-process teammates.
 * In-process teammates run in the same Node.js process using AsyncLocalStorage.
 */
async function handleSpawnInProcess(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, plan_mode_required } = input
  const separateProcessRequirement = getSeparateProcessRequirement(input.provider)
  const { provider } = separateProcessRequirement
  const effort = input.effort
  const worktreeInfo = input.worktreeInfo

  if (separateProcessRequirement.required) {
    if (separateProcessRequirement.reason === 'codex-native-runtime') {
      throw new Error(
        `Teammate "${name}" uses Codex native runtime, which must execute through a separate process and the dedicated codex-native lane, not the in-process adapter lane.`,
      )
    }
    throw new Error(
      `Teammate "${name}" requests provider "${provider}" which differs from the leader provider "${getCurrentTeammateProvider()}". Mixed-provider teammates must run in a separate process.`,
    )
  }

  // Resolve model: 'inherit' → leader's model; undefined → default Opus alias
  const model = resolveSpawnModel(
    input.model,
    getAppState().mainLoopModel,
    input.provider,
  )

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // Persistent team teammates must keep their canonical identity. Duplicate
  // requests are handled before we get here; a legitimate respawn must reuse
  // the same teammate name instead of drifting into alice-2/bob-2.
  const sanitizedName = sanitizeAgentName(name)

  // Generate deterministic agent ID from name and team
  const teammateId = formatAgentId(sanitizedName, teamName)

  // Assign a unique color to this teammate
  const teammateColor = assignTeammateColor(teammateId)

  // Look up custom agent definition if agent_type is provided
  let agentDefinition: CustomAgentDefinition | undefined
  if (agent_type) {
    const allAgents = context.options.agentDefinitions.activeAgents
    const foundAgent = allAgents.find(a => a.agentType === agent_type)
    if (foundAgent && isCustomAgent(foundAgent)) {
      agentDefinition = foundAgent
    }
    logForDebugging(
      `[handleSpawnInProcess] agent_type=${agent_type}, found=${!!agentDefinition}`,
    )
  }

  // Spawn in-process teammate
  const config: InProcessSpawnConfig = {
    name: sanitizedName,
    teamName,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required ?? false,
    model,
    effort,
    ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
    ...(worktreeInfo?.worktreeBranch ? { worktreeBranch: worktreeInfo.worktreeBranch } : {}),
    ...(worktreeInfo?.baseWorkspaceRoot
      ? { baseWorkspaceRoot: worktreeInfo.baseWorkspaceRoot }
      : {}),
    ...(worktreeInfo?.dirtyLeaderWarning
      ? { dirtyLeaderWarning: worktreeInfo.dirtyLeaderWarning }
      : {}),
  }

  logTeammateSpawnSnapshot({
    teamName,
    teammateName: sanitizedName,
    provider,
    model,
    effort,
    prompt,
    strictMcpConfig: false,
  })

  const launchBoundaryIso = new Date().toISOString()
  const result = await spawnInProcessTeammate(config, context)

  if (!result.success) {
    throw new Error(result.error ?? 'Failed to spawn in-process teammate')
  }

  try {
    // Track the teammate in AppState's teamContext
    // Auto-register leader if spawning without prior spawnTeam call
    setAppState(prev => {
      const needsLeaderSetup = !prev.teamContext?.leadAgentId
      const leadAgentId = needsLeaderSetup
        ? formatAgentId(TEAM_LEAD_NAME, teamName)
        : prev.teamContext!.leadAgentId

      // Build teammates map, including leader if needed for inbox polling
      const existingTeammates = prev.teamContext?.teammates || {}
      const leadEntry = needsLeaderSetup
        ? {
            [leadAgentId]: {
              name: TEAM_LEAD_NAME,
              agentType: TEAM_LEAD_NAME,
              color: assignTeammateColor(leadAgentId),
              tmuxSessionName: 'in-process',
              tmuxPaneId: 'leader',
              cwd: getCwd(),
              spawnedAt: Date.now(),
            },
          }
        : {}

      return {
        ...prev,
        teamContext: {
          ...prev.teamContext,
          teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
          teamFilePath: prev.teamContext?.teamFilePath ?? '',
          leadAgentId,
          teammates: {
            ...existingTeammates,
            ...leadEntry,
            [teammateId]: {
              name: sanitizedName,
              agentType: agent_type,
              color: teammateColor,
              tmuxSessionName: 'in-process',
              tmuxPaneId: 'in-process',
              cwd: worktreeInfo?.worktreePath ?? getCwd(),
              ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
              spawnedAt: Date.now(),
            },
          },
        },
      }
    })

    // Register agent in the team file
    const updateResult = await updateTeamFileAsync(teamName, teamFile =>
      upsertTeamMember(teamFile, {
        agentId: teammateId,
        name: sanitizedName,
        agentType: agent_type,
        model,
        provider,
        effort,
        prompt,
        color: teammateColor,
        planModeRequired: plan_mode_required,
        joinedAt: Date.now(),
        bootstrapExpectedAfter: launchBoundaryIso,
        tmuxPaneId: 'in-process',
        cwd: worktreeInfo?.worktreePath ?? getCwd(),
        ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
        ...(worktreeInfo?.worktreeBranch ? { worktreeBranch: worktreeInfo.worktreeBranch } : {}),
        ...(worktreeInfo?.headCommit ? { worktreeHeadCommit: worktreeInfo.headCommit } : {}),
        ...(worktreeInfo?.gitRoot ? { worktreeGitRoot: worktreeInfo.gitRoot } : {}),
        ...(worktreeInfo?.hookBased ? { worktreeHookBased: true } : {}),
        ...(worktreeInfo?.baseWorkspaceRoot
          ? { worktreeBaseWorkspaceRoot: worktreeInfo.baseWorkspaceRoot }
          : {}),
        ...(worktreeInfo?.dirtyLeaderWarning
          ? { worktreeDirtyWarning: worktreeInfo.dirtyLeaderWarning }
          : {}),
        subscriptions: [],
        backendType: 'in-process',
      }),
    )
    if (updateResult.status === 'missing') {
      throw new Error(
        `Team "${teamName}" does not exist. Call spawnTeam first to create the team.`,
      )
    }

    // Debug: log what spawn returned
    logForDebugging(
      `[handleSpawnInProcess] spawn result: taskId=${result.taskId}, hasContext=${!!result.teammateContext}, hasAbort=${!!result.abortController}`,
    )

    // Start the agent execution loop (fire-and-forget) only after durable
    // teammate registration stores the current launch boundary.
    if (result.taskId && result.teammateContext && result.abortController) {
      startInProcessTeammate({
        identity: {
          agentId: teammateId,
          agentName: sanitizedName,
          teamName,
          color: teammateColor,
          planModeRequired: plan_mode_required ?? false,
          parentSessionId: result.teammateContext.parentSessionId,
        },
        taskId: result.taskId,
        prompt,
        description: input.description,
        model,
        effort,
        agentDefinition,
        teammateContext: result.teammateContext,
        // Strip messages: the teammate never reads toolUseContext.messages
        // (it builds its own history via allMessages in inProcessRunner).
        // Passing the parent's full conversation here would pin it for the
        // teammate's lifetime, surviving /clear and auto-compact.
        toolUseContext: { ...context, messages: [] },
        abortController: result.abortController,
        invokingRequestId: input.invokingRequestId,
        ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
        ...(worktreeInfo?.worktreeBranch ? { worktreeBranch: worktreeInfo.worktreeBranch } : {}),
        ...(worktreeInfo?.baseWorkspaceRoot
          ? { baseWorkspaceRoot: worktreeInfo.baseWorkspaceRoot }
          : {}),
        ...(worktreeInfo?.dirtyLeaderWarning
          ? { dirtyLeaderWarning: worktreeInfo.dirtyLeaderWarning }
          : {}),
      })
      logForDebugging(
        `[handleSpawnInProcess] Started agent execution for ${teammateId}`,
      )
    }
  } catch (error) {
    if (result.taskId) {
      logForDebugging(
        `[handleSpawnInProcess] Cleaning up partial in-process spawn for ${teammateId}: ${errorMessage(error)}`,
      )
      await killInProcessTeammate(result.taskId, setAppState)
    } else {
      result.abortController?.abort()
    }
    throw error
  }

  // Note: Do NOT send the prompt via mailbox for in-process teammates.
  // In-process teammates receive the prompt directly via startInProcessTeammate().
  // The mailbox is only needed for tmux-based teammates which poll for their initial message.
  // Sending via both paths would cause duplicate welcome messages.

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      provider,
      effort,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: 'in-process',
      tmux_window_name: 'in-process',
      tmux_pane_id: 'in-process',
      team_name: teamName,
      is_splitpane: false,
      backend_type: 'in-process',
      plan_mode_required,
      ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
      ...(worktreeInfo?.worktreeBranch ? { worktreeBranch: worktreeInfo.worktreeBranch } : {}),
      ...(worktreeInfo?.dirtyLeaderWarning
        ? { dirtyLeaderWarning: worktreeInfo.dirtyLeaderWarning }
        : {}),
    },
  }
}

export async function __handleSpawnNativeProcessForTests(
  input: SpawnTeammateConfig,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__handleSpawnNativeProcessForTests is only available in tests')
  }
  return handleSpawnNativeProcess(input, context)
}

type SpawnMultiAgentDepsForTests = {
  detectAndGetBackend?: typeof detectAndGetBackend
  getTeammateModeFromSnapshot?: typeof getTeammateModeFromSnapshot
  isInProcessEnabled?: typeof isInProcessEnabled
}

let spawnMultiAgentDepsForTests: SpawnMultiAgentDepsForTests | null = null

export function __setSpawnMultiAgentDepsForTests(
  deps: SpawnMultiAgentDepsForTests | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setSpawnMultiAgentDepsForTests is only available in tests')
  }
  spawnMultiAgentDepsForTests = deps
}

function getSpawnMultiAgentDeps(): Required<SpawnMultiAgentDepsForTests> {
  return {
    detectAndGetBackend:
      spawnMultiAgentDepsForTests?.detectAndGetBackend ?? detectAndGetBackend,
    getTeammateModeFromSnapshot:
      spawnMultiAgentDepsForTests?.getTeammateModeFromSnapshot ??
      getTeammateModeFromSnapshot,
    isInProcessEnabled:
      spawnMultiAgentDepsForTests?.isInProcessEnabled ?? isInProcessEnabled,
  }
}

/**
 * Handle spawn operation - creates a new Claude Code instance.
 * Uses in-process mode when enabled, otherwise uses tmux/iTerm2 split-pane view.
 * Falls back to in-process if pane backend detection fails (e.g., iTerm2 without
 * it2 CLI or tmux installed).
 */
async function handleSpawn(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const requestedProvider = resolveTeammateProvider(input.provider)
  const separateProcessRequirement = getSeparateProcessRequirement(input.provider)
  const forceSeparateProcess = separateProcessRequirement.required
  if (input.isolation === 'worktree' && input.cwd) {
    throw new Error('cwd is mutually exclusive with isolation: "worktree" for teammate spawn.')
  }

  let spawnedWorktreeInfo: TeammateWorktreeInfo | undefined
  let spawnInput = input
  if (input.isolation === 'worktree') {
    const appState = context.getAppState()
    const teamName = input.team_name || appState.teamContext?.teamName
    if (!teamName || !input.name) {
      throw new Error('team_name and name are required for worktree-isolated teammate spawn.')
    }
    const sanitizedName = sanitizeAgentName(input.name)
    spawnedWorktreeInfo = await createWorktreeForTeammate(teamName, sanitizedName)
    spawnInput = {
      ...input,
      cwd: spawnedWorktreeInfo.worktreePath,
      worktreeInfo: spawnedWorktreeInfo,
    }
  }

  try {
    const spawnDeps = getSpawnMultiAgentDeps()

    // Check if in-process mode is enabled via feature flag
    if (spawnDeps.isInProcessEnabled() && !forceSeparateProcess) {
      return await handleSpawnInProcess(spawnInput, context)
    }

    if (
      shouldUseNativeProcessBackendForSpawn({
        separateProcessRequired: forceSeparateProcess,
      })
    ) {
      logForDebugging(
        `[handleSpawn] Using native process backend for ${input.name ?? input.agent_type ?? 'teammate'} because auto mode requires a launch-owned process runtime`,
      )
      return await handleSpawnNativeProcess(spawnInput, context)
    }

    // Pre-flight: ensure a pane backend is available before attempting pane-based spawn.
    // This handles auto-mode cases like iTerm2 without it2 or tmux installed, where
    // isInProcessEnabled() returns false but detectAndGetBackend() has no viable backend.
    // Narrowly scoped so user cancellation and other spawn errors propagate normally.
    try {
      await spawnDeps.detectAndGetBackend()
    } catch (error) {
      if (
        shouldUseNativeProcessBackendForSpawn({
          separateProcessRequired: forceSeparateProcess,
        })
      ) {
        logForDebugging(
          `[handleSpawn] No pane backend available, using native process backend: ${errorMessage(error)}`,
        )
        return await handleSpawnNativeProcess(spawnInput, context)
      }
      if (forceSeparateProcess) {
        if (separateProcessRequirement.reason === 'codex-native-runtime') {
          throw new Error(
            `Teammate "${input.name}" uses Codex native runtime, which must run in a separate process through the dedicated codex-native lane. No pane-based transport is available. Use teammate mode auto to allow the native process backend, or enable an explicit pane transport such as tmux/iTerm2.`,
          )
        }
        throw new Error(
          `Teammate "${input.name}" requests provider "${requestedProvider}" which differs from the leader provider "${getCurrentTeammateProvider()}". This teammate must run outside the in-process lane, but no pane-based transport is available. Use teammate mode auto to allow the native process backend, or enable an explicit pane transport such as tmux/iTerm2.`,
        )
      }
      // Only fall back silently in auto mode. If the user explicitly configured
      // teammateMode: 'tmux', let the error propagate so they see the actionable
      // install instructions from getTmuxInstallInstructions().
      if (spawnDeps.getTeammateModeFromSnapshot() !== 'auto') {
        throw error
      }
      logForDebugging(
        `[handleSpawn] No pane backend available, falling back to in-process: ${errorMessage(error)}`,
      )
      // Record the fallback so isInProcessEnabled() reflects the actual mode
      // (fixes banner and other UI that would otherwise show tmux attach commands).
      markInProcessFallback()
      return await handleSpawnInProcess(spawnInput, context)
    }

    // Backend is available (and now cached) - proceed with pane spawning.
    // Any errors here (user cancellation, validation, etc.) propagate to the caller.
    const useSplitPane = spawnInput.use_splitpane !== false
    if (useSplitPane) {
      return await handleSpawnSplitPane(spawnInput, context)
    }
    return await handleSpawnSeparateWindow(spawnInput, context)
  } catch (error) {
    await cleanupCreatedTeammateWorktree(spawnedWorktreeInfo)
    throw error
  }
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Spawns a new teammate with the given configuration.
 * This is the main entry point for teammate spawning, used by both TeammateTool and AgentTool.
 */
export async function spawnTeammate(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
): Promise<SpawnResult> {
  const appState = context.getAppState()
  const teamName = config.team_name || appState.teamContext?.teamName
  const teammateName = config.name?.trim()

  if (!teamName || !teammateName) {
    return handleSpawn(config, context)
  }

  const reservationKey = buildTeammateSpawnReservationKey(teamName, teammateName)
  if (pendingTeammateSpawnReservations.has(reservationKey)) {
    return buildDuplicateSkippedResult(
      config,
      teamName,
      'bootstrap_pending',
      context,
    )
  }

  pendingTeammateSpawnReservations.add(reservationKey)
  try {
    const existingState = await resolveExistingTeammateState(
      config,
      context,
      teamName,
    )
    if (existingState.decision === 'duplicate_already_running') {
      return buildDuplicateSkippedResult(
        config,
        teamName,
        existingState.reason,
        context,
      )
    }
    if (existingState.decision === 'duplicate_bootstrap_pending') {
      return buildDuplicateSkippedResult(
        config,
        teamName,
        existingState.reason,
        context,
      )
    }
    return handleSpawn(config, context)
  } finally {
    pendingTeammateSpawnReservations.delete(reservationKey)
  }
}
