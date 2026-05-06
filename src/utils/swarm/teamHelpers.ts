import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { getSessionCreatedTeams } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { getTeamsDir } from '../envUtils.js'
import { errorMessage, getErrnoCode } from '../errors.js'
import { lazySchema } from '../lazySchema.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { getTasksDir, notifyTasksUpdated } from '../tasks.js'
import { getAgentName, getTeamName, isTeammate } from '../teammate.js'
import { hasWorktreeChanges, removeAgentWorktree } from '../worktree.js'
import { type BackendType, isPaneBackend } from './backends/types.js'
import { TEAM_LEAD_NAME } from './constants.js'
import {
  buildProcessBackendPaneId,
  killProcessBackendRuntime,
} from './processBackend.js'
import { safeWindowsPathSegment } from '../windowsReservedNames.js'

export const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum(['spawnTeam', 'cleanup'])
      .describe(
        'Operation: spawnTeam to create a team, cleanup to remove team and task directories.',
      ),
    agent_type: z
      .string()
      .optional()
      .describe(
        'Type/role of the team lead (e.g., "researcher", "test-runner"). ' +
          'Used for team file and inter-agent coordination.',
      ),
    team_name: z
      .string()
      .optional()
      .describe('Name for the new team to create (required for spawnTeam).'),
    description: z
      .string()
      .optional()
      .describe('Team description/purpose (only used with spawnTeam).'),
  }),
)

// Output types for different operations
export type SpawnTeamOutput = {
  team_name: string
  team_file_path: string
  lead_agent_id: string
}

export type CleanupOutput = {
  success: boolean
  message: string
  team_name?: string
}

export type TeamAllowedPath = {
  path: string // Directory path (absolute)
  toolName: string // The tool this applies to (e.g., "Edit", "Write")
  addedBy: string // Agent name who added this rule
  addedAt: number // Timestamp when added
}

export type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string // Actual session UUID of the leader (for discovery)
  hiddenPaneIds?: string[] // Pane IDs that are currently hidden from the UI
  teamAllowedPaths?: TeamAllowedPath[] // Paths all teammates can edit without asking
  members: Array<{
    agentId: string
    name: string
    agentType?: string
    model?: string
    provider?: 'anthropic' | 'codex' | 'gemini'
    effort?: 'low' | 'medium' | 'high' | 'max'
    prompt?: string
    color?: string
    planModeRequired?: boolean
    joinedAt: number
    bootstrapExpectedAfter?: string
    bootstrapProofToken?: string
    bootstrapRunId?: string
    bootstrapProofMode?: 'member_briefing_tool' | 'native_app_managed_context'
    bootstrapContextHash?: string
    bootstrapBriefingHash?: string
    bootstrapRuntimeEventsPath?: string
    tmuxPaneId: string
    cwd: string
    worktreePath?: string
    worktreeBranch?: string
    worktreeHeadCommit?: string
    worktreeGitRoot?: string
    worktreeHookBased?: boolean
    worktreeBaseWorkspaceRoot?: string
    worktreeDirtyWarning?: string
    sessionId?: string
    runtimePid?: number
    subscriptions: string[]
    backendType?: BackendType
    isActive?: boolean // false when idle, undefined/true when active
    mode?: PermissionMode // Current permission mode for this teammate
  }>
}

type TeamMember = TeamFile['members'][number]

type TeamFileMutationResult = {
  teamFile: TeamFile
  changed: boolean
}

export type TeamFileUpdateResult =
  | { status: 'missing'; teamFile: null }
  | { status: 'unchanged'; teamFile: TeamFile }
  | { status: 'updated'; teamFile: TeamFile }

type MemberActiveSyncEntry = {
  syncedState?: boolean
  inflightState?: boolean
  queuedState?: boolean
  chain: Promise<void>
}

export type Input = z.infer<ReturnType<typeof inputSchema>>
// Export SpawnTeamOutput as Output for backward compatibility
export type Output = SpawnTeamOutput

/**
 * Sanitizes a name for use in tmux window names, worktree paths, and file paths.
 * Replaces all non-alphanumeric characters with hyphens and lowercases.
 */
export function sanitizeName(name: string): string {
  return safeWindowsPathSegment(name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase())
}

/**
 * Sanitizes an agent name for use in deterministic agent IDs.
 * Replaces @ with - to prevent ambiguity in the agentName@teamName format.
 */
export function sanitizeAgentName(name: string): string {
  return name.replace(/@/g, '-')
}

/**
 * Gets the path to a team's directory
 */
export function getTeamDir(teamName: string): string {
  return join(getTeamsDir(), sanitizeName(teamName))
}

/**
 * Gets the path to a team's config.json file
 */
export function getTeamFilePath(teamName: string): string {
  return join(getTeamDir(teamName), 'config.json')
}

function getTeamFileLockDir(teamName: string): string {
  return join(getTeamDir(teamName), '.config.lock')
}

const TEAM_FILE_LOCK_TIMEOUT_MS = 10_000
const TEAM_FILE_LOCK_STALE_MS = 30_000
const TEAM_FILE_LOCK_RETRY_BASE_MS = 25
const TEAM_FILE_LOCK_SLOW_WAIT_MS = 100

const memberActiveSyncByKey = new Map<string, MemberActiveSyncEntry>()

export function getTrackedMemberActiveState(
  teamName: string,
  memberName: string,
): boolean | undefined {
  const entry = memberActiveSyncByKey.get(`${teamName}\u0000${memberName}`)
  if (!entry) {
    return undefined
  }
  return entry.queuedState ?? entry.inflightState ?? entry.syncedState
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = getErrnoCode(error)
    return code === 'EPERM'
  }
}

async function writeTeamFileAtomicAsync(
  teamName: string,
  teamFile: TeamFile,
): Promise<void> {
  const teamDir = getTeamDir(teamName)
  const teamFilePath = getTeamFilePath(teamName)
  const tempPath = join(
    teamDir,
    `config.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(teamDir, { recursive: true })
  await writeFile(tempPath, jsonStringify(teamFile, null, 2))
  await rename(tempPath, teamFilePath)
}

async function reclaimStaleTeamFileLock(lockDir: string): Promise<boolean> {
  try {
    const [lockStat, metadataContent] = await Promise.all([
      stat(lockDir),
      readFile(join(lockDir, 'metadata.json'), 'utf-8').catch(() => null),
    ])
    const ageMs = Date.now() - lockStat.mtimeMs
    if (ageMs < TEAM_FILE_LOCK_STALE_MS) {
      return false
    }

    let lockPid: number | null = null
    if (metadataContent) {
      try {
        const parsed = jsonParse(metadataContent) as { pid?: unknown }
        if (typeof parsed.pid === 'number') {
          lockPid = parsed.pid
        }
      } catch {
        // Ignore malformed metadata; age-based stale detection still applies.
      }
    }

    if (lockPid !== null && isProcessAlive(lockPid)) {
      return false
    }

    await rm(lockDir, { recursive: true, force: true })
    logForDebugging(`[TeammateTool] Reclaimed stale team file lock: ${lockDir}`)
    return true
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return true
    }
    logForDebugging(
      `[TeammateTool] Failed to reclaim stale team file lock ${lockDir}: ${errorMessage(error)}`,
    )
    return false
  }
}

export async function withTeamFileLock<T>(
  teamName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const teamDir = getTeamDir(teamName)
  const lockDir = getTeamFileLockDir(teamName)
  const start = Date.now()
  let attempt = 0
  let acquiredAt = 0

  await mkdir(teamDir, { recursive: true })

  while (true) {
    try {
      await mkdir(lockDir)
      try {
        await writeFile(
          join(lockDir, 'metadata.json'),
          jsonStringify({ pid: process.pid, createdAt: Date.now() }),
        )
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      acquiredAt = Date.now()
      break
    } catch (error) {
      if (getErrnoCode(error) !== 'EEXIST') {
        throw error
      }
      const reclaimed = await reclaimStaleTeamFileLock(lockDir)
      if (reclaimed) {
        continue
      }
      if (Date.now() - start >= TEAM_FILE_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for team file lock for "${teamName}" after ${TEAM_FILE_LOCK_TIMEOUT_MS}ms`,
        )
      }
      attempt += 1
      const jitter = Math.floor(Math.random() * 10)
      await sleep(
        Math.min(200, TEAM_FILE_LOCK_RETRY_BASE_MS * attempt) + jitter,
      )
    }
  }

  const waitMs = acquiredAt > 0 ? acquiredAt - start : 0
  if (waitMs >= TEAM_FILE_LOCK_SLOW_WAIT_MS) {
    logForDebugging(
      `[TeammateTool] Waited ${waitMs}ms for team file lock for "${teamName}" (${attempt} retries)`,
    )
  }

  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(error => {
      logForDebugging(
        `[TeammateTool] Failed to release team file lock for ${teamName}: ${errorMessage(error)}`,
      )
    })
  }
}

export async function updateTeamFileAsync(
  teamName: string,
  mutator: (
    teamFile: Readonly<TeamFile>,
  ) => TeamFileMutationResult | Promise<TeamFileMutationResult>,
): Promise<TeamFileUpdateResult> {
  return withTeamFileLock(teamName, async () => {
    const teamFile = await readTeamFileAsync(teamName)
    if (!teamFile) {
      return { status: 'missing', teamFile: null }
    }
    const { teamFile: updatedTeamFile, changed } = await mutator(teamFile)
    if (!changed) {
      return { status: 'unchanged', teamFile }
    }
    await writeTeamFileAtomicAsync(teamName, updatedTeamFile)
    return { status: 'updated', teamFile: updatedTeamFile }
  })
}

function arraysEqual<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return !a && !b
  }
  if (a.length !== b.length) {
    return false
  }
  return a.every((value, index) => value === b[index])
}

function teamMembersEqual(a: TeamMember, b: TeamMember): boolean {
  return (
    a.agentId === b.agentId &&
    a.name === b.name &&
    a.agentType === b.agentType &&
    a.model === b.model &&
    a.provider === b.provider &&
    a.effort === b.effort &&
    a.prompt === b.prompt &&
    a.color === b.color &&
    a.planModeRequired === b.planModeRequired &&
    a.joinedAt === b.joinedAt &&
    a.bootstrapExpectedAfter === b.bootstrapExpectedAfter &&
    a.bootstrapProofToken === b.bootstrapProofToken &&
    a.bootstrapRunId === b.bootstrapRunId &&
    a.bootstrapProofMode === b.bootstrapProofMode &&
    a.bootstrapContextHash === b.bootstrapContextHash &&
    a.bootstrapBriefingHash === b.bootstrapBriefingHash &&
    a.bootstrapRuntimeEventsPath === b.bootstrapRuntimeEventsPath &&
    a.tmuxPaneId === b.tmuxPaneId &&
    a.cwd === b.cwd &&
    a.worktreePath === b.worktreePath &&
    a.worktreeBranch === b.worktreeBranch &&
    a.worktreeHeadCommit === b.worktreeHeadCommit &&
    a.worktreeGitRoot === b.worktreeGitRoot &&
    a.worktreeHookBased === b.worktreeHookBased &&
    a.worktreeBaseWorkspaceRoot === b.worktreeBaseWorkspaceRoot &&
    a.worktreeDirtyWarning === b.worktreeDirtyWarning &&
    a.sessionId === b.sessionId &&
    a.runtimePid === b.runtimePid &&
    a.backendType === b.backendType &&
    a.isActive === b.isActive &&
    a.mode === b.mode &&
    arraysEqual(a.subscriptions, b.subscriptions)
  )
}

export function upsertTeamMember(
  teamFile: TeamFile,
  member: TeamMember,
): TeamFileMutationResult {
  const normalizedName = sanitizeAgentName(member.name)
  const existingIndex = teamFile.members.findIndex(
    existing =>
      existing.agentId === member.agentId ||
      sanitizeAgentName(existing.name) === normalizedName,
  )

  if (existingIndex === -1) {
    return {
      changed: true,
      teamFile: {
        ...teamFile,
        members: [...teamFile.members, { ...member, name: normalizedName }],
      },
    }
  }

  const updatedMembers = [...teamFile.members]
  const updatedMember = {
    ...updatedMembers[existingIndex],
    ...member,
    name: normalizedName,
  }
  if (teamMembersEqual(updatedMembers[existingIndex], updatedMember)) {
    return { changed: false, teamFile }
  }
  updatedMembers[existingIndex] = updatedMember
  return {
    changed: true,
    teamFile: {
      ...teamFile,
      members: updatedMembers,
    },
  }
}

/**
 * Reads a team file by name (sync — for sync contexts like React render paths)
 * @internal Exported for team discovery UI
 */
// sync IO: called from sync context
export function readTeamFile(teamName: string): TeamFile | null {
  try {
    const content = readFileSync(getTeamFilePath(teamName), 'utf-8')
    return jsonParse(content) as TeamFile
  } catch (e) {
    if (getErrnoCode(e) === 'ENOENT') return null
    logForDebugging(
      `[TeammateTool] Failed to read team file for ${teamName}: ${errorMessage(e)}`,
    )
    return null
  }
}

/**
 * Reads a team file by name (async — for tool handlers and other async contexts)
 */
export async function readTeamFileAsync(
  teamName: string,
): Promise<TeamFile | null> {
  try {
    const content = await readFile(getTeamFilePath(teamName), 'utf-8')
    return jsonParse(content) as TeamFile
  } catch (e) {
    if (getErrnoCode(e) === 'ENOENT') return null
    logForDebugging(
      `[TeammateTool] Failed to read team file for ${teamName}: ${errorMessage(e)}`,
    )
    return null
  }
}

/**
 * Writes a team file (sync — for sync contexts)
 */
// sync IO: called from sync context
function writeTeamFile(teamName: string, teamFile: TeamFile): void {
  const teamDir = getTeamDir(teamName)
  mkdirSync(teamDir, { recursive: true })
  writeFileSync(getTeamFilePath(teamName), jsonStringify(teamFile, null, 2))
}

/**
 * Writes a team file (async — for tool handlers)
 */
export async function writeTeamFileAsync(
  teamName: string,
  teamFile: TeamFile,
): Promise<void> {
  await writeTeamFileAtomicAsync(teamName, teamFile)
}

/**
 * Removes a teammate from the team file by agent ID or name.
 * Used by the leader when processing shutdown approvals.
 */
export async function removeTeammateFromTeamFile(
  teamName: string,
  identifier: { agentId?: string; name?: string },
): Promise<boolean> {
  const identifierStr = identifier.agentId || identifier.name
  if (!identifierStr) {
    logForDebugging(
      '[TeammateTool] removeTeammateFromTeamFile called with no identifier',
    )
    return false
  }

  let removed = false
  const updated = await updateTeamFileAsync(teamName, teamFile => {
    const nextMembers = teamFile.members.filter(m => {
      if (identifier.agentId && m.agentId === identifier.agentId) {
        removed = true
        return false
      }
      if (identifier.name && m.name === identifier.name) {
        removed = true
        return false
      }
      return true
    })
    return removed
      ? { changed: true, teamFile: { ...teamFile, members: nextMembers } }
      : { changed: false, teamFile }
  })

  if (updated.status === 'missing') {
    logForDebugging(
      `[TeammateTool] Cannot remove teammate ${identifierStr}: failed to read team file for "${teamName}"`,
    )
    return false
  }

  if (!removed) {
    logForDebugging(
      `[TeammateTool] Teammate ${identifierStr} not found in team file for "${teamName}"`,
    )
    return false
  }

  logForDebugging(
    `[TeammateTool] Removed teammate from team file: ${identifierStr}`,
  )
  return true
}

/**
 * Adds a pane ID to the hidden panes list in the team file.
 * @param teamName - The name of the team
 * @param paneId - The pane ID to hide
 * @returns true if the pane was added to hidden list, false if team doesn't exist
 */
export async function addHiddenPaneId(
  teamName: string,
  paneId: string,
): Promise<boolean> {
  let added = false
  const updated = await updateTeamFileAsync(teamName, teamFile => {
    const hiddenPaneIds = teamFile.hiddenPaneIds ?? []
    if (hiddenPaneIds.includes(paneId)) {
      return { changed: false, teamFile }
    }
    added = true
    return {
      changed: true,
      teamFile: {
        ...teamFile,
        hiddenPaneIds: [...hiddenPaneIds, paneId],
      },
    }
  })
  if (updated.status === 'missing') {
    return false
  }
  if (added) {
    logForDebugging(
      `[TeammateTool] Added ${paneId} to hidden panes for team ${teamName}`,
    )
  }
  return true
}

/**
 * Removes a pane ID from the hidden panes list in the team file.
 * @param teamName - The name of the team
 * @param paneId - The pane ID to show (remove from hidden list)
 * @returns true if the pane was removed from hidden list, false if team doesn't exist
 */
export async function removeHiddenPaneId(
  teamName: string,
  paneId: string,
): Promise<boolean> {
  let removed = false
  const updated = await updateTeamFileAsync(teamName, teamFile => {
    const hiddenPaneIds = teamFile.hiddenPaneIds ?? []
    if (!hiddenPaneIds.includes(paneId)) {
      return { changed: false, teamFile }
    }
    removed = true
    return {
      changed: true,
      teamFile: {
        ...teamFile,
        hiddenPaneIds: hiddenPaneIds.filter(id => id !== paneId),
      },
    }
  })
  if (updated.status === 'missing') {
    return false
  }
  if (removed) {
    logForDebugging(
      `[TeammateTool] Removed ${paneId} from hidden panes for team ${teamName}`,
    )
  }
  return true
}

/**
 * Removes a teammate from the team config file by pane ID.
 * Also removes from hiddenPaneIds if present.
 * @param teamName - The name of the team
 * @param tmuxPaneId - The pane ID of the teammate to remove
 * @returns true if the member was removed, false if team or member doesn't exist
 */
export async function removeMemberFromTeam(
  teamName: string,
  tmuxPaneId: string,
): Promise<boolean> {
  let removed = false
  const updated = await updateTeamFileAsync(teamName, teamFile => {
    const memberIndex = teamFile.members.findIndex(
      m => m.tmuxPaneId === tmuxPaneId,
    )
    if (memberIndex === -1) {
      return { changed: false, teamFile }
    }
    removed = true
    return {
      changed: true,
      teamFile: {
        ...teamFile,
        members: teamFile.members.filter(m => m.tmuxPaneId !== tmuxPaneId),
        hiddenPaneIds: teamFile.hiddenPaneIds?.filter(id => id !== tmuxPaneId),
      },
    }
  })
  if (updated.status === 'missing' || !removed) {
    return false
  }

  logForDebugging(
    `[TeammateTool] Removed member with pane ${tmuxPaneId} from team ${teamName}`,
  )
  return true
}

/**
 * Removes a teammate from a team's member list by agent ID.
 * Use this for in-process teammates which all share the same tmuxPaneId.
 * @param teamName - The name of the team
 * @param agentId - The agent ID of the teammate to remove (e.g., "researcher@my-team")
 * @returns true if the member was removed, false if team or member doesn't exist
 */
export async function removeMemberByAgentId(
  teamName: string,
  agentId: string,
): Promise<boolean> {
  let removed = false
  const updated = await updateTeamFileAsync(teamName, teamFile => {
    const memberIndex = teamFile.members.findIndex(m => m.agentId === agentId)
    if (memberIndex === -1) {
      return { changed: false, teamFile }
    }
    removed = true
    return {
      changed: true,
      teamFile: {
        ...teamFile,
        members: teamFile.members.filter(m => m.agentId !== agentId),
      },
    }
  })
  if (updated.status === 'missing' || !removed) {
    return false
  }

  logForDebugging(
    `[TeammateTool] Removed member ${agentId} from team ${teamName}`,
  )
  return true
}

/**
 * Sets a team member's permission mode.
 * Called when the team leader changes a teammate's mode via the TeamsDialog.
 * @param teamName - The name of the team
 * @param memberName - The name of the member to update
 * @param mode - The new permission mode
 */
export async function setMemberMode(
  teamName: string,
  memberName: string,
  mode: PermissionMode,
): Promise<boolean> {
  let found = false
  let changed = false
  const updated = await updateTeamFileAsync(teamName, teamFile => {
    const updatedMembers = teamFile.members.map(member => {
      if (member.name !== memberName) {
        return member
      }
      found = true
      if (member.mode === mode) {
        return member
      }
      changed = true
      return { ...member, mode }
    })
    return changed
      ? { changed: true, teamFile: { ...teamFile, members: updatedMembers } }
      : { changed: false, teamFile }
  })
  if (updated.status === 'missing') {
    return false
  }
  if (!found) {
    logForDebugging(
      `[TeammateTool] Cannot set member mode: member ${memberName} not found in team ${teamName}`,
    )
    return false
  }
  if (!changed) {
    return true
  }

  logForDebugging(
    `[TeammateTool] Set member ${memberName} in team ${teamName} to mode: ${mode}`,
  )
  return true
}

/**
 * Sync the current teammate's mode to config.json so team lead sees it.
 * No-op if not running as a teammate.
 * @param mode - The permission mode to sync
 * @param teamNameOverride - Optional team name override (uses env var if not provided)
 */
export async function syncTeammateMode(
  mode: PermissionMode,
  teamNameOverride?: string,
): Promise<void> {
  if (!isTeammate()) return
  const teamName = teamNameOverride ?? getTeamName()
  const agentName = getAgentName()
  if (teamName && agentName) {
    await setMemberMode(teamName, agentName, mode)
  }
}

/**
 * Sets multiple team members' permission modes in a single atomic operation.
 * Avoids race conditions when updating multiple teammates at once.
 * @param teamName - The name of the team
 * @param modeUpdates - Array of {memberName, mode} to update
 */
export async function setMultipleMemberModes(
  teamName: string,
  modeUpdates: Array<{ memberName: string; mode: PermissionMode }>,
): Promise<boolean> {
  const updateMap = new Map(modeUpdates.map(u => [u.memberName, u.mode]))
  let anyChanged = false
  const updated = await updateTeamFileAsync(teamName, teamFile => {
    const updatedMembers = teamFile.members.map(member => {
      const newMode = updateMap.get(member.name)
      if (newMode !== undefined && member.mode !== newMode) {
        anyChanged = true
        return { ...member, mode: newMode }
      }
      return member
    })
    return anyChanged
      ? { changed: true, teamFile: { ...teamFile, members: updatedMembers } }
      : { changed: false, teamFile }
  })
  if (updated.status === 'missing') {
    return false
  }
  if (anyChanged) {
    logForDebugging(
      `[TeammateTool] Set ${modeUpdates.length} member modes in team ${teamName}`,
    )
  }
  return true
}

/**
 * Sets a team member's active status.
 * Called when a teammate becomes idle (isActive=false) or starts a new turn (isActive=true).
 * @param teamName - The name of the team
 * @param memberName - The name of the member to update
 * @param isActive - Whether the member is active (true) or idle (false)
 */
export async function setMemberActive(
  teamName: string,
  memberName: string,
  isActive: boolean,
): Promise<void> {
  const syncKey = `${teamName}\u0000${memberName}`
  let entry = memberActiveSyncByKey.get(syncKey)
  if (!entry) {
    entry = {
      chain: Promise.resolve(),
    }
    memberActiveSyncByKey.set(syncKey, entry)
  }

  if (
    entry.syncedState === isActive &&
    entry.inflightState === undefined &&
    entry.queuedState === undefined
  ) {
    return
  }

  if (entry.inflightState === isActive || entry.queuedState === isActive) {
    return entry.chain
  }

  entry.queuedState = isActive
  entry.chain = entry.chain
    .catch(() => {})
    .then(async () => {
      const currentEntry = memberActiveSyncByKey.get(syncKey)
      if (!currentEntry) {
        return
      }

      while (
        currentEntry.queuedState !== undefined &&
        currentEntry.queuedState !== currentEntry.syncedState
      ) {
        const desiredState = currentEntry.queuedState
        currentEntry.queuedState = undefined
        currentEntry.inflightState = desiredState

        let found = false
        let changed = false
        try {
          const updated = await updateTeamFileAsync(teamName, teamFile => {
            const updatedMembers = teamFile.members.map(member => {
              if (member.name !== memberName) {
                return member
              }
              found = true
              if (member.isActive === desiredState) {
                return member
              }
              changed = true
              return { ...member, isActive: desiredState }
            })
            return changed
              ? { changed: true, teamFile: { ...teamFile, members: updatedMembers } }
              : { changed: false, teamFile }
          })

          if (updated.status === 'missing') {
            logForDebugging(
              `[TeammateTool] Cannot set member active: team ${teamName} not found`,
            )
            continue
          }

          if (!found) {
            logForDebugging(
              `[TeammateTool] Cannot set member active: member ${memberName} not found in team ${teamName}`,
            )
            continue
          }

          currentEntry.syncedState = desiredState

          if (changed) {
            logForDebugging(
              `[TeammateTool] Set member ${memberName} in team ${teamName} to ${desiredState ? 'active' : 'idle'}`,
            )
          }
        } finally {
          currentEntry.inflightState = undefined
        }
      }
    })
    .finally(() => {
      const currentEntry = memberActiveSyncByKey.get(syncKey)
      if (
        currentEntry &&
        currentEntry.inflightState === undefined &&
        currentEntry.queuedState === undefined &&
        currentEntry.syncedState === false
      ) {
        memberActiveSyncByKey.delete(syncKey)
      }
    })

  return entry.chain
}

async function cleanupTeamMemberWorktree(member: TeamMember): Promise<void> {
  if (!member.worktreePath) {
    return
  }
  if (member.worktreeHookBased) {
    logForDebugging(
      `[TeammateTool] Keeping hook-based teammate worktree: ${member.worktreePath}`,
    )
    return
  }
  if (!member.worktreeHeadCommit || !member.worktreeGitRoot) {
    logForDebugging(
      `[TeammateTool] Keeping teammate worktree with incomplete cleanup metadata: ${member.worktreePath}`,
      { level: 'warn' },
    )
    return
  }

  const changed = await hasWorktreeChanges(
    member.worktreePath,
    member.worktreeHeadCommit,
  )
  if (changed) {
    logForDebugging(
      `[TeammateTool] Keeping dirty teammate worktree: ${member.worktreePath}`,
    )
    return
  }

  await removeAgentWorktree(
    member.worktreePath,
    member.worktreeBranch,
    member.worktreeGitRoot,
    member.worktreeHookBased,
  )
}

/**
 * Mark a team as created this session so it gets cleaned up on exit.
 * Call this right after the initial writeTeamFile. TeamDelete should
 * call unregisterTeamForSessionCleanup to prevent double-cleanup.
 * Backing Set lives in bootstrap/state.ts so resetStateForTests()
 * clears it between tests (avoids the PR #17615 cross-shard leak class).
 */
export function registerTeamForSessionCleanup(teamName: string): void {
  getSessionCreatedTeams().add(teamName)
}

/**
 * Remove a team from session cleanup tracking (e.g., after explicit
 * TeamDelete — already cleaned, don't try again on shutdown).
 */
export function unregisterTeamForSessionCleanup(teamName: string): void {
  getSessionCreatedTeams().delete(teamName)
}

/**
 * Clean up all teams created this session that weren't explicitly deleted.
 * Registered with gracefulShutdown from init.ts.
 */
export async function cleanupSessionTeams(): Promise<void> {
  const sessionCreatedTeams = getSessionCreatedTeams()
  if (sessionCreatedTeams.size === 0) return
  const teams = Array.from(sessionCreatedTeams)
  logForDebugging(
    `cleanupSessionTeams: removing ${teams.length} orphan team dir(s): ${teams.join(', ')}`,
  )
  // Kill panes first — on SIGINT the teammate processes are still running;
  // deleting directories alone would orphan them in open tmux/iTerm2 panes.
  // (TeamDeleteTool's path doesn't need this — by then teammates have
  // gracefully exited and useInboxPoller has already closed their panes.)
  await Promise.allSettled(teams.map(name => killOrphanedTeammateRuntimes(name)))
  await Promise.allSettled(teams.map(name => cleanupTeamDirectories(name)))
  sessionCreatedTeams.clear()
}

/**
 * Best-effort kill of all out-of-process teammate runtimes for a team.
 * Called from cleanupSessionTeams on ungraceful leader exit (SIGINT/SIGTERM).
 * Dynamic imports avoid adding registry/detection to this module's static
 * dep graph — this only runs at shutdown, so the import cost is irrelevant.
 */
async function killOrphanedTeammateRuntimes(teamName: string): Promise<void> {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return

  const processMembers = teamFile.members.filter(
    m =>
      m.name !== TEAM_LEAD_NAME &&
      (m.backendType === 'process' ||
        (!m.backendType && m.tmuxPaneId?.trim().startsWith('process:')) ||
        (!m.backendType &&
          typeof m.runtimePid === 'number' &&
          m.runtimePid > 0)),
  )
  const paneMembers = teamFile.members.filter(
    m =>
      m.name !== TEAM_LEAD_NAME &&
      m.tmuxPaneId &&
      m.backendType &&
      isPaneBackend(m.backendType),
  )

  await Promise.allSettled(
    processMembers.map(async m => {
      const paneId =
        m.tmuxPaneId?.trim() ||
        (typeof m.runtimePid === 'number' && m.runtimePid > 0
          ? buildProcessBackendPaneId(m.runtimePid)
          : undefined)
      const ok = await killProcessBackendRuntime(paneId, {
        expectedAgentId: m.agentId,
        teamName,
      })
      logForDebugging(
        `cleanupSessionTeams: killProcess ${m.name} (${m.tmuxPaneId}) => ${ok}`,
      )
    }),
  )

  if (paneMembers.length === 0) return

  const [{ ensureBackendsRegistered, getBackendByType }, { isInsideTmux }] =
    await Promise.all([
      import('./backends/registry.js'),
      import('./backends/detection.js'),
    ])
  await ensureBackendsRegistered()
  const useExternalSession = !(await isInsideTmux())

  await Promise.allSettled(
    paneMembers.map(async m => {
      // filter above guarantees these; narrow for the type system
      if (!m.tmuxPaneId || !m.backendType || !isPaneBackend(m.backendType)) {
        return
      }
      const ok = await getBackendByType(m.backendType).killPane(
        m.tmuxPaneId,
        useExternalSession,
      )
      logForDebugging(
        `cleanupSessionTeams: killPane ${m.name} (${m.backendType} ${m.tmuxPaneId}) → ${ok}`,
      )
    }),
  )
}

/**
 * Cleans up team and task directories for a given team name.
 * Also cleans up git worktrees created for teammates.
 * Called when a swarm session is terminated.
 */
export async function cleanupTeamDirectories(teamName: string): Promise<void> {
  const sanitizedName = sanitizeName(teamName)

  // Read team file to get worktree metadata BEFORE deleting the team directory
  const teamFile = readTeamFile(teamName)
  const worktreeMembers: TeamMember[] = []
  if (teamFile) {
    for (const member of teamFile.members) {
      if (member.worktreePath) {
        worktreeMembers.push(member)
      }
    }
  }

  // Clean up only clean teammate worktrees. Dirty/unknown worktrees are user
  // work and must survive TeamDelete.
  for (const member of worktreeMembers) {
    await cleanupTeamMemberWorktree(member)
  }

  // Clean up team directory (~/.claude/teams/{team-name}/)
  const teamDir = getTeamDir(teamName)
  try {
    await rm(teamDir, { recursive: true, force: true })
    logForDebugging(`[TeammateTool] Cleaned up team directory: ${teamDir}`)
  } catch (error) {
    logForDebugging(
      `[TeammateTool] Failed to clean up team directory ${teamDir}: ${errorMessage(error)}`,
    )
  }

  // Clean up tasks directory (~/.claude/tasks/{taskListId}/)
  // The leader and teammates all store tasks under the sanitized team name.
  const tasksDir = getTasksDir(sanitizedName)
  try {
    await rm(tasksDir, { recursive: true, force: true })
    logForDebugging(`[TeammateTool] Cleaned up tasks directory: ${tasksDir}`)
    notifyTasksUpdated()
  } catch (error) {
    logForDebugging(
      `[TeammateTool] Failed to clean up tasks directory ${tasksDir}: ${errorMessage(error)}`,
    )
  }
}
