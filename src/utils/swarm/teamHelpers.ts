import { closeSync, constants, readFileSync } from 'fs'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { z } from 'zod/v4'
import { getSessionCreatedTeams } from '../../bootstrap/state.js'
import { writeFileAtomicSync, writeJsonFileAtomic } from '../atomicWrite.js'
import { logForDebugging } from '../debug.js'
import { getTeamsDir } from '../envUtils.js'
import { errorMessage, getErrnoCode } from '../errors.js'
import { lazySchema } from '../lazySchema.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { removeTaskList } from '../tasks.js'
import { withTaskMutationCoordination } from '../taskMutationCoordinator.js'
import { getAgentName, getTeamName, isTeammate } from '../teammate.js'
import { hasWorktreeChanges, removeAgentWorktree } from '../worktree.js'
import { type BackendType, isPaneBackend } from './backends/types.js'
import { TEAM_LEAD_NAME } from './constants.js'
import {
  buildProcessBackendPaneId,
  killProcessBackendRuntime,
} from './processBackend.js'
import { safeWindowsPathSegment } from '../windowsReservedNames.js'
import { CanonicalTeamDirectory } from './canonicalTeamDirectory.js'
import {
  activeCanonicalTeamRootFd,
  resolveCanonicalTeamLockAuthority,
  withCanonicalTeamLock,
  withValidatedCanonicalTeamRoot,
  type CanonicalTeamLockAuthority,
} from './canonicalTeamLockAuthority.js'

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
    processStartedAtMs?: number
    processOsIdentity?: string
    processOwnerToken?: string
    processRunId?: string
    spawnClaimToken?: string
    spawnClaimRunId?: string
    spawnClaimOwnerPid?: number
    spawnClaimOwnerStartedAtMs?: number
    spawnClaimRuntimeMayExist?: boolean
    terminationRecovery?: {
      requestId?: string
      agentId: string
      backendType?: BackendType
      paneId?: string
      processStartedAtMs?: number
      processOsIdentity?: string
      processOwnerToken?: string
      processRunId?: string
      spawnClaimToken?: string
      spawnClaimRunId?: string
      detail?: string
      recordedAt: string
    }
    outstandingShutdownRequestId?: string
    subscriptions: string[]
    backendType?: BackendType
    isActive?: boolean // false when idle, undefined/true when active
    mode?: PermissionMode // Current permission mode for this teammate
  }>
  /** Private hosted-runtime binding. Never exposed through the public launch plan. */
  hostedNative?: {
    version: 1
    publicTeamId: string
    legacyKey: string
    primaryDisplayName: string
    primaryAgentId: string
    primaryAlias: typeof TEAM_LEAD_NAME
    launchIdentityToken: string
    envelopeDigest: string
    materialDigest: string
    profileDigest: string
    permissionMode: 'bypassPermissions'
    canonicalDataRoot: string
    canonicalTeamRoot: string
    canonicalTasksRoot: string
    runId: string
    role: 'native-lead' | 'external-lead'
    readyAckPath?: string
    mailboxCustody?: 'hosted-lead-pump' | 'external-session'
  }
}

export type TeamMember = TeamFile['members'][number]

export type TeamMemberIdentity = Pick<
  TeamMember,
  | 'agentId'
  | 'tmuxPaneId'
  | 'processStartedAtMs'
  | 'processOsIdentity'
  | 'processOwnerToken'
  | 'processRunId'
  | 'spawnClaimToken'
  | 'spawnClaimRunId'
  | 'spawnClaimOwnerPid'
  | 'spawnClaimOwnerStartedAtMs'
  | 'spawnClaimRuntimeMayExist'
>

type TeamFileMutationResult = {
  teamFile: TeamFile
  changed: boolean
}

type CanonicalTeamFileMutationResult =
  | TeamFileMutationResult
  | { changed: true; teamFile: TeamFileMutationResult }

function isWrappedCanonicalTeamMutation(
  result: CanonicalTeamFileMutationResult,
): result is { changed: true; teamFile: TeamFileMutationResult } {
  return result.changed &&
    'changed' in result.teamFile &&
    'teamFile' in result.teamFile
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

/**
 * Explicit-root variants for hosted supervisors. These deliberately never
 * consult CLAUDE_CONFIG_DIR, so two admitted roots can safely use the same
 * legacy team key in one supervisor process.
 */
export function getTeamFilePathAtCanonicalRoot(canonicalTeamRoot: string): string {
  if (!isAbsolute(canonicalTeamRoot)) {
    throw new Error('Canonical team root must be absolute')
  }
  return join(canonicalTeamRoot, 'config.json')
}

async function readTeamFileAtBoundCanonicalRoot(
  canonicalTeamRoot: string,
  rootFd: number,
  legacyKey: string,
): Promise<TeamFile | null> {
  const directory = await CanonicalTeamDirectory.fromRootFd(rootFd)
  const file = directory.readFile('config.json')
  await teamFileLockExchangeTestHook?.({
    phase: 'after-config-read',
    lockPath: join(canonicalTeamRoot, '.config.lock'),
    stagingPath: getTeamFilePathAtCanonicalRoot(canonicalTeamRoot),
  })
  if (!file) return null
  const parsed = jsonParse(file.text) as TeamFile
  if (parsed.name !== legacyKey) {
    throw new Error(
      `Team directory collision: "${legacyKey}" resolves to storage owned by "${String(parsed.name)}"`,
    )
  }
  return parsed
}

function canonicalAuthority(canonicalTeamRoot: string, legacyKey: string): CanonicalTeamLockAuthority {
  if (!isAbsolute(canonicalTeamRoot)) throw new Error('Canonical team root must be absolute')
  return resolveCanonicalTeamLockAuthority(canonicalTeamRoot, legacyKey)
}

export async function readTeamFileAtCanonicalRoot(
  canonicalTeamRoot: string,
  legacyKey: string,
): Promise<TeamFile | null> {
  const authority = canonicalAuthority(canonicalTeamRoot, legacyKey)
  const borrowed = activeCanonicalTeamRootFd(authority)
  if (borrowed !== null) return readTeamFileAtBoundCanonicalRoot(canonicalTeamRoot, borrowed, legacyKey)
  return withValidatedCanonicalTeamRoot(authority, rootFd =>
    readTeamFileAtBoundCanonicalRoot(canonicalTeamRoot, rootFd, legacyKey))
}

export async function withTeamFileLockAtCanonicalRoot<T>(
  canonicalTeamRoot: string,
  legacyKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const authority = canonicalAuthority(canonicalTeamRoot, legacyKey)
  return withCanonicalTeamLock(
    authority,
    { deadlineMs: Date.now() + TEAM_FILE_LOCK_MIGRATION_WAIT_MS },
    async () => fn(),
  )
}

async function writeTeamFileAtAdmittedCanonicalRoot(
  authority: CanonicalTeamLockAuthority,
  canonicalTeamRoot: string,
  legacyKey: string,
  teamFile: TeamFile,
): Promise<void> {
  const rootFd = activeCanonicalTeamRootFd(authority)
  if (rootFd === null) throw new Error('Canonical team write requires the active host-issued lock authority')
  await readTeamFileAtBoundCanonicalRoot(canonicalTeamRoot, rootFd, legacyKey)
  const directory = await CanonicalTeamDirectory.fromRootFd(rootFd)
  const temporaryName = `config.json.tmp.${process.pid}.${randomUUID()}`
  await teamFileLockExchangeTestHook?.({
    phase: 'before-config-create',
    lockPath: join(canonicalTeamRoot, '.config.lock'),
    stagingPath: join(canonicalTeamRoot, temporaryName),
  })
  // The borrowed ALS store can outlive its callback when a caller detaches
  // this promise. Recheck the live acquisition after the last await and
  // immediately before the synchronous create syscall.
  if (activeCanonicalTeamRootFd(authority) !== rootFd) {
    throw new Error('Canonical team write authority ended before staging create')
  }
  const owned = directory.createFile(temporaryName, jsonStringify(teamFile, null, 2))
  try {
    await teamFileLockExchangeTestHook?.({
      phase: 'before-config-publish',
      lockPath: join(canonicalTeamRoot, '.config.lock'),
      stagingPath: join(canonicalTeamRoot, temporaryName),
    })
    if (!directory.namedFileIs(temporaryName, owned)) {
      throw new Error('Canonical team config staging file was replaced')
    }
    // namedFileIs is synchronous. This final live-fence check is adjacent to
    // renameat, so revocation or callback completion cannot publish a cached
    // borrowed write after an earlier await.
    if (activeCanonicalTeamRootFd(authority) !== rootFd) {
      throw new Error('Canonical team write authority ended before config publish')
    }
    directory.rename(temporaryName, 'config.json')
  } finally {
    if (owned.fd !== undefined) closeSync(owned.fd)
    // An uncertain temporary entry is deliberately retained. Its name is not
    // an ownership proof, and canonical lock release never unlinks paths.
  }
}

export async function writeTeamFileAtCanonicalRoot(
  canonicalTeamRoot: string,
  legacyKey: string,
  teamFile: TeamFile,
): Promise<void> {
  if (teamFile.name !== legacyKey) {
    throw new Error(`Team file name mismatch: expected "${legacyKey}", got "${teamFile.name}"`)
  }
  const authority = canonicalAuthority(canonicalTeamRoot, legacyKey)
  if (activeCanonicalTeamRootFd(authority) !== null) {
    return writeTeamFileAtAdmittedCanonicalRoot(authority, canonicalTeamRoot, legacyKey, teamFile)
  }
  return withCanonicalTeamLock(
    authority,
    { deadlineMs: Date.now() + TEAM_FILE_LOCK_MIGRATION_WAIT_MS },
    () => writeTeamFileAtAdmittedCanonicalRoot(authority, canonicalTeamRoot, legacyKey, teamFile),
  )
}

export async function updateTeamFileAtCanonicalRoot(
  canonicalTeamRoot: string,
  legacyKey: string,
  mutator: (
    teamFile: Readonly<TeamFile>,
  ) => CanonicalTeamFileMutationResult | Promise<CanonicalTeamFileMutationResult>,
): Promise<TeamFileUpdateResult> {
  return withTeamFileLockAtCanonicalRoot(canonicalTeamRoot, legacyKey, async () => {
    const current = await readTeamFileAtCanonicalRoot(canonicalTeamRoot, legacyKey)
    if (!current) return { status: 'missing', teamFile: null }
    const callbackResult = await mutator(current)
    // Canonical-root acquisition callbacks wrap shared mutation helpers so
    // they can attach their own reservation decision. Preserve the shared
    // helper's actual callback contract instead of treating that result
    // object itself as a TeamFile.
    const next = isWrappedCanonicalTeamMutation(callbackResult)
      ? callbackResult.teamFile
      : callbackResult
    if (!next.changed) return { status: 'unchanged', teamFile: current }
    await writeTeamFileAtCanonicalRoot(canonicalTeamRoot, legacyKey, next.teamFile)
    return { status: 'updated', teamFile: next.teamFile }
  })
}

const TEAM_FILE_LOCK_STALE_MS = 30_000
const TEAM_FILE_LOCK_SLOW_WAIT_MS = 100
const TEAM_FILE_LOCK_MIGRATION_WAIT_MS = 30_000

type WindowsTeamLockGuard =
  | { state: 'pending'; token: symbol }
  | { state: 'owned'; handle: bigint; close: () => void }

const windowsTeamLockGuards = new Map<string, WindowsTeamLockGuard>()
type TeamLockPlatform = Extract<NodeJS.Platform, 'linux' | 'darwin' | 'win32'>
let teamFileLockPlatformForTests: TeamLockPlatform | null = null

export type WindowsTeamLockMutexApi = {
  create(name: string): bigint
  wait(handle: bigint, timeoutMs: number): number
  release(handle: bigint): boolean
  close(handle: bigint): void
  dispose(): void
}

let windowsTeamLockMutexApiForTests: WindowsTeamLockMutexApi | null = null
let windowsTeamLockBeforeMutexApiAwaitTestHook: (() => Promise<void>) | null = null

async function createWindowsTeamLockMutexApi(): Promise<WindowsTeamLockMutexApi> {
  if (windowsTeamLockMutexApiForTests) return windowsTeamLockMutexApiForTests
  const { dlopen, FFIType, ptr } = await import('bun:ffi')
  const kernel32 = dlopen('kernel32.dll', {
    CreateMutexW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.u64,
    },
    WaitForSingleObject: {
      args: [FFIType.u64, FFIType.u32],
      returns: FFIType.u32,
    },
    ReleaseMutex: { args: [FFIType.u64], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.u32 },
  })
  return {
    create: name => {
      const encoded = Buffer.from(`${name}\0`, 'utf16le')
      return kernel32.symbols.CreateMutexW(null, 0, ptr(encoded))
    },
    wait: (handle, timeoutMs) => Number(kernel32.symbols.WaitForSingleObject(handle, timeoutMs)),
    release: handle => kernel32.symbols.ReleaseMutex(handle) !== 0,
    close: handle => { kernel32.symbols.CloseHandle(handle) },
    dispose: () => { kernel32.close() },
  }
}

async function acquireWindowsTeamLockGuard(lockPath: string): Promise<boolean> {
  if (windowsTeamLockGuards.has(lockPath)) return false
  // A Windows mutex is recursive for its owning thread. Publish an in-process
  // reservation synchronously, before loading the FFI API, so a second async
  // acquisition on this JS thread cannot enter the native wait recursively.
  const pendingToken = Symbol(lockPath)
  windowsTeamLockGuards.set(lockPath, { state: 'pending', token: pendingToken })
  let api: WindowsTeamLockMutexApi | null = null
  let handle = 0n
  try {
    await windowsTeamLockBeforeMutexApiAwaitTestHook?.()
    api = await createWindowsTeamLockMutexApi()
    handle = api.create(`Local\\ClaudeTeamLock-${Buffer.from(lockPath).toString('base64url')}`)
    if (handle === 0n) {
      api.dispose()
      return false
    }
    const waitResult = api.wait(handle, 0)
    // WAIT_OBJECT_0 and WAIT_ABANDONED both transfer mutex ownership.
    if (waitResult !== 0 && waitResult !== 0x80) {
      api.close(handle)
      api.dispose()
      return false
    }
    windowsTeamLockGuards.set(lockPath, {
      state: 'owned',
      handle,
      close: () => {
        try { api!.release(handle) } finally {
          try { api!.close(handle) } finally { api!.dispose() }
        }
      },
    })
    return true
  } catch {
    if (api && handle !== 0n) {
      try { api.close(handle) } catch {}
    }
    try { api?.dispose() } catch {}
    return false
  } finally {
    const guard = windowsTeamLockGuards.get(lockPath)
    if (guard?.state === 'pending' && guard.token === pendingToken) {
      windowsTeamLockGuards.delete(lockPath)
    }
  }
}

function releaseWindowsTeamLockGuard(lockPath: string): void {
  const guard = windowsTeamLockGuards.get(lockPath)
  if (!guard || guard.state !== 'owned') return
  windowsTeamLockGuards.delete(lockPath)
  try { guard.close() } catch {}
}

type TeamFileLockExchangeTestEvent = {
  phase: 'before-acquire-publish' | 'before-reclaim-exchange' | 'after-reclaim-exchange' | 'after-reclaim-restore' | 'before-release-exchange' | 'after-release-exchange' | 'after-release-restore' |
    'before-config-create' | 'before-config-publish' | 'after-config-read'
  lockPath: string
  stagingPath: string
}

let teamFileLockExchangeTestHook:
  | ((event: TeamFileLockExchangeTestEvent) => Promise<void>)
  | null = null

export function __setTeamFileLockExchangeTestHook(
  hook: ((event: TeamFileLockExchangeTestEvent) => Promise<void>) | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setTeamFileLockExchangeTestHook is only available in tests')
  }
  teamFileLockExchangeTestHook = hook
}

export function __setTeamFileLockPlatformForTests(platform: TeamLockPlatform | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setTeamFileLockPlatformForTests is only available in tests')
  }
  teamFileLockPlatformForTests = platform
}

export function __setWindowsTeamLockMutexApiForTests(api: WindowsTeamLockMutexApi | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setWindowsTeamLockMutexApiForTests is only available in tests')
  }
  windowsTeamLockMutexApiForTests = api
}

export function __setWindowsTeamLockBeforeMutexApiAwaitTestHook(
  hook: (() => Promise<void>) | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setWindowsTeamLockBeforeMutexApiAwaitTestHook is only available in tests')
  }
  windowsTeamLockBeforeMutexApiAwaitTestHook = hook
}

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

async function exchangeTeamLockPaths(left: string, right: string): Promise<boolean> {
  const platform = teamFileLockPlatformForTests ?? process.platform
  if (platform === 'win32') {
    const guardOwner = windowsTeamLockGuards.get(left)
    if (guardOwner?.state !== 'owned') return false
    const temporary = `${left}.windows-exchange-${randomUUID()}`
    try {
      await rename(left, temporary)
      try {
        await rename(right, left)
        await rename(temporary, right)
        return true
      } catch (error) {
        await rename(temporary, left).catch(() => undefined)
        throw error
      }
    } catch {
      return false
    }
  }
  if (platform !== 'linux' && platform !== 'darwin') return false
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const leftBuffer = Buffer.from(`${left}\0`)
    const rightBuffer = Buffer.from(`${right}\0`)
    if (platform === 'darwin') {
      const libc = dlopen('/usr/lib/libSystem.B.dylib', {
        renamex_np: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
      })
      try {
        return libc.symbols.renamex_np(ptr(leftBuffer), ptr(rightBuffer), 0x2) === 0
      } finally {
        libc.close()
      }
    }
    const libc = dlopen('libc.so.6', {
      renameat2: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
    })
    try {
      return libc.symbols.renameat2(-100, ptr(leftBuffer), -100, ptr(rightBuffer), 0x2) === 0
    } finally {
      libc.close()
    }
  } catch {
    return false
  }
}

async function publishTeamLockWithoutReplace(candidatePath: string, lockPath: string): Promise<boolean> {
  const platform = teamFileLockPlatformForTests ?? process.platform
  if (platform === 'win32') {
    const guardOwner = windowsTeamLockGuards.get(lockPath)
    if (guardOwner?.state !== 'owned') return false
    try {
      await rename(candidatePath, lockPath)
      return true
    } catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(getErrnoCode(error) ?? '')) return false
      throw error
    }
  }
  if (platform !== 'linux' && platform !== 'darwin') return false
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const candidateBuffer = Buffer.from(`${candidatePath}\0`)
    const lockBuffer = Buffer.from(`${lockPath}\0`)
    if (platform === 'darwin') {
      const libc = dlopen('/usr/lib/libSystem.B.dylib', {
        renamex_np: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
      })
      try {
        // RENAME_EXCL gives rename(2) atomic publication with O_EXCL semantics.
        return libc.symbols.renamex_np(ptr(candidateBuffer), ptr(lockBuffer), 0x4) === 0
      } finally {
        libc.close()
      }
    }
    const libc = dlopen('libc.so.6', {
      renameat2: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
    })
    try {
      // RENAME_NOREPLACE atomically fails if even an empty legacy lock exists.
      return libc.symbols.renameat2(-100, ptr(candidateBuffer), -100, ptr(lockBuffer), 0x1) === 0
    } finally {
      libc.close()
    }
  } catch {
    // Fail closed on kernels/filesystems without an atomic no-replace primitive.
    return false
  }
}

async function writeTeamFileAtomicAsync(
  teamName: string,
  teamFile: TeamFile,
): Promise<void> {
  if (teamFile.name !== teamName) {
    throw new Error(`Team file name mismatch: expected "${teamName}", got "${teamFile.name}"`)
  }
  const teamFilePath = getTeamFilePath(teamName)
  const existing = await readFile(teamFilePath, 'utf8').catch(error => {
    if (getErrnoCode(error) === 'ENOENT') return null
    throw error
  })
  if (existing !== null) {
    let existingName: unknown
    try { existingName = (jsonParse(existing) as { name?: unknown }).name } catch {}
    if (existingName !== teamName) {
      throw new Error(
        `Team directory collision: "${teamName}" resolves to storage owned by "${String(existingName ?? 'unknown')}"`,
      )
    }
  }
  await writeJsonFileAtomic(teamFilePath, teamFile, { indent: 2 })
}

async function writeUnpublishedTeamLockMetadata(
  directoryPath: string,
  metadata: { pid: number; generation: string; acquiredAt: string },
  assertRootCustody?: () => Promise<void>,
): Promise<void> {
  if (!assertRootCustody) {
    await writeJsonFileAtomic(join(directoryPath, 'metadata.json'), metadata)
    return
  }
  const handle = await open(join(directoryPath, 'metadata.json'), 'wx', 0o600)
  try {
    await handle.writeFile(jsonStringify(metadata))
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function withTeamFileLock<T>(
  teamName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const teamDir = getTeamDir(teamName)
  await mkdir(teamDir, { recursive: true })
  return withTeamFileLockInRoot(teamName, teamDir, fn)
}

async function withTeamFileLockInRoot<T>(
  teamName: string,
  teamDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = join(teamDir, '.config.lock')
  const start = Date.now()
  const generation = randomUUID()
  const metadataPath = join(lockPath, 'metadata.json')
  const platform = teamFileLockPlatformForTests ?? process.platform
  if (platform === 'win32') {
    while (!await acquireWindowsTeamLockGuard(lockPath)) {
      if (Date.now() - start >= TEAM_FILE_LOCK_MIGRATION_WAIT_MS) {
        throw new Error(`Timed out waiting for team file CAS guard for "${teamName}"`)
      }
      await sleep(25)
    }
  }
  try {
  while (true) {
    const candidatePath = `${lockPath}.acquire-${process.pid}-${randomUUID()}`
    try {
      await mkdir(candidatePath)
      await writeUnpublishedTeamLockMetadata(candidatePath, {
        pid: process.pid,
        generation,
        acquiredAt: new Date().toISOString(),
      })
      // Publish a fully initialized generation in one namespace operation.
      // Older binaries therefore never observe our lock without legacy
      // metadata and cannot age-reclaim a half-published live owner.
      await teamFileLockExchangeTestHook?.({
        phase: 'before-acquire-publish',
        lockPath,
        stagingPath: candidatePath,
      })
      if (await publishTeamLockWithoutReplace(candidatePath, lockPath)) break
      await rm(candidatePath, { recursive: true, force: true })
    } catch (error) {
      await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined)
      if (!['EEXIST', 'ENOTEMPTY'].includes(getErrnoCode(error) ?? '')) throw error
    }

    // Keep the observed directory object alive through the namespace exchange.
    // An open handle prevents its inode/file-id from being recycled for a
    // successor while we validate the displaced path.
    const observedHandle = await open(
      lockPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    ).catch(() => null)
    try {
    const observedStat = await observedHandle?.stat().catch(() => null) ?? null
    const metadata = await readFile(metadataPath, 'utf-8').catch(() => null)
    let ownerPid: number | null = null
    let observedGeneration: string | null = null
    try {
      const parsed = metadata ? jsonParse(metadata) as { pid?: unknown; generation?: unknown } : null
      ownerPid = typeof parsed?.pid === 'number' ? parsed.pid : null
      observedGeneration = typeof parsed?.generation === 'string' ? parsed.generation : null
    } catch {
      // A malformed lock is reclaimed only after the stale grace below.
    }

    const lockAgeMs = await stat(lockPath)
      .then(value => Date.now() - value.mtimeMs)
      .catch(() => 0)
    const reclaimable = ownerPid !== null
      ? !isProcessAlive(ownerPid)
      : lockAgeMs >= TEAM_FILE_LOCK_STALE_MS
    if (reclaimable) {
      const replacementPath = `${lockPath}.replacement-${process.pid}-${randomUUID()}`
      try {
        await mkdir(replacementPath)
        await writeUnpublishedTeamLockMetadata(replacementPath, {
          pid: process.pid,
          generation,
          acquiredAt: new Date().toISOString(),
        })
        await teamFileLockExchangeTestHook?.({
          phase: 'before-reclaim-exchange',
          lockPath,
          stagingPath: replacementPath,
        })
        if (!await exchangeTeamLockPaths(lockPath, replacementPath)) {
          // Platforms without atomic exchange fail closed instead of risking
          // deletion of a successor generation.
          await rm(replacementPath, { recursive: true, force: true })
        } else {
          const displacedStat = await stat(replacementPath).catch(() => null)
          const displacedMetadataText = await readFile(join(replacementPath, 'metadata.json'), 'utf8')
            .catch(() => null)
          const displacedMetadata = displacedMetadataText === null
            ? null
            : (() => {
                try { return jsonParse(displacedMetadataText) as { generation?: unknown } }
                catch { return null }
              })()
          const heldStat = await observedHandle?.stat().catch(() => null) ?? null
          if (
            observedStat && heldStat && displacedStat &&
            observedStat.dev === heldStat.dev &&
            observedStat.ino === heldStat.ino &&
            heldStat.dev === displacedStat.dev &&
            heldStat.ino === displacedStat.ino &&
            displacedMetadataText === metadata &&
            (observedGeneration === null
              ? displacedMetadata?.generation === undefined
              : displacedMetadata?.generation === observedGeneration)
          ) {
            await rm(replacementPath, { recursive: true, force: true })
            break
          }
          if (!await exchangeTeamLockPaths(lockPath, replacementPath)) {
            throw new Error(`Failed to restore changed team lock generation for "${teamName}"`)
          }
          await teamFileLockExchangeTestHook?.({
            phase: 'after-reclaim-restore',
            lockPath,
            stagingPath: replacementPath,
          })
          await rm(replacementPath, { recursive: true, force: true })
        }
      } catch (error) {
        await rm(replacementPath, { recursive: true, force: true }).catch(() => undefined)
        if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(getErrnoCode(error) ?? '')) {
          throw error
        }
      }
    }

    if (Date.now() - start >= TEAM_FILE_LOCK_MIGRATION_WAIT_MS) {
      throw new Error(
        `Timed out waiting for team file lock for "${teamName}"`,
      )
    }
    await sleep(25)
    } finally {
      await observedHandle?.close().catch(() => undefined)
    }
  }

  const waitMs = Date.now() - start
  if (waitMs >= TEAM_FILE_LOCK_SLOW_WAIT_MS) {
    logForDebugging(
      `[TeammateTool] Waited ${waitMs}ms for team file lock for "${teamName}"`,
    )
  }

  try {
    const result = await fn()
    return result
  } finally {
    await (async () => {
      const observedStat = await stat(lockPath).catch(() => null)
      const metadata = await readFile(metadataPath, 'utf-8').catch(() => null)
      const parsed = metadata ? jsonParse(metadata) as { generation?: unknown } : null
      if (parsed?.generation !== generation) return
      const releasePath = `${lockPath}.release-${process.pid}-${generation}`
      await mkdir(releasePath)
      // Keep a non-empty, immediately reclaimable tombstone at the public
      // path. Removing an empty public directory here would race a successor
      // rename and could delete the successor after it acquired the lock.
      await writeUnpublishedTeamLockMetadata(releasePath, {
        pid: 0,
        generation: `released:${generation}`,
        acquiredAt: new Date().toISOString(),
      })
      await teamFileLockExchangeTestHook?.({
        phase: 'before-release-exchange',
        lockPath,
        stagingPath: releasePath,
      })
      if (!await exchangeTeamLockPaths(lockPath, releasePath)) {
        await rm(releasePath, { recursive: true, force: true })
        return
      }
      const displacedStat = await stat(releasePath).catch(() => null)
      const displacedMetadata = await readFile(join(releasePath, 'metadata.json'), 'utf8')
        .then(value => jsonParse(value) as { generation?: unknown })
        .catch(() => null)
      if (
        observedStat && displacedStat &&
        observedStat.dev === displacedStat.dev &&
        observedStat.ino === displacedStat.ino &&
        displacedMetadata?.generation === generation
      ) {
        await rm(releasePath, { recursive: true, force: true })
        return
      }
      if (!await exchangeTeamLockPaths(lockPath, releasePath)) {
        throw new Error(`Failed to restore changed team lock generation for "${teamName}"`)
      }
      await teamFileLockExchangeTestHook?.({
        phase: 'after-release-restore',
        lockPath,
        stagingPath: releasePath,
      })
      await rm(releasePath, { recursive: true, force: true })
    })().catch(error => {
      logForDebugging(
        `[TeammateTool] Failed to release team file lock for ${teamName}: ${errorMessage(error)}`,
      )
    })
  }
  } finally {
    if (platform === 'win32') releaseWindowsTeamLockGuard(lockPath)
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
    a.processStartedAtMs === b.processStartedAtMs &&
    a.processOsIdentity === b.processOsIdentity &&
    a.processOwnerToken === b.processOwnerToken &&
    a.processRunId === b.processRunId &&
    a.spawnClaimToken === b.spawnClaimToken &&
    a.spawnClaimRunId === b.spawnClaimRunId &&
    a.spawnClaimOwnerPid === b.spawnClaimOwnerPid &&
    a.spawnClaimOwnerStartedAtMs === b.spawnClaimOwnerStartedAtMs &&
    a.spawnClaimRuntimeMayExist === b.spawnClaimRuntimeMayExist &&
    jsonStringify(a.terminationRecovery) === jsonStringify(b.terminationRecovery) &&
    a.outstandingShutdownRequestId === b.outstandingShutdownRequestId &&
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
      normalizedMemberName(existing.name) === normalizedMemberName(normalizedName),
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
    const teamFile = jsonParse(content) as TeamFile
    if (teamFile.name !== teamName) {
      logForDebugging(
        `[TeammateTool] Refusing colliding team directory for "${teamName}" owned by "${String(teamFile.name)}"`,
      )
      return null
    }
    return teamFile
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
    const teamFile = jsonParse(content) as TeamFile
    if (teamFile.name !== teamName) {
      logForDebugging(
        `[TeammateTool] Refusing colliding team directory for "${teamName}" owned by "${String(teamFile.name)}"`,
      )
      return null
    }
    return teamFile
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
  if (teamFile.name !== teamName) {
    throw new Error(`Team file name mismatch: expected "${teamName}", got "${teamFile.name}"`)
  }
  const existing = (() => {
    try { return readFileSync(getTeamFilePath(teamName), 'utf8') } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') return null
      throw error
    }
  })()
  if (existing !== null) {
    let existingName: unknown
    try { existingName = (jsonParse(existing) as { name?: unknown }).name } catch {}
    if (existingName !== teamName) {
      throw new Error(
        `Team directory collision: "${teamName}" resolves to storage owned by "${String(existingName ?? 'unknown')}"`,
      )
    }
  }
  writeFileAtomicSync(getTeamFilePath(teamName), jsonStringify(teamFile, null, 2))
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

export async function removeTeammateFromTeamFileIfIdentityMatches(
  teamName: string,
  expected: {
    agentId: string
    paneId?: string
    processStartedAtMs?: number
    processOsIdentity?: string
    processOwnerToken?: string
    processRunId?: string
    spawnClaimToken?: string
    spawnClaimRunId?: string
  },
): Promise<boolean> {
  let removed = false
  await updateTeamFileAsync(teamName, teamFile => {
    const member = teamFile.members.find(candidate => candidate.agentId === expected.agentId)
    if (!member) return { changed: false, teamFile }
    if (
      member.tmuxPaneId !== expected.paneId ||
      member.processStartedAtMs !== expected.processStartedAtMs ||
      member.processOsIdentity !== expected.processOsIdentity ||
      member.processOwnerToken !== expected.processOwnerToken ||
      member.processRunId !== expected.processRunId ||
      member.spawnClaimToken !== expected.spawnClaimToken ||
      member.spawnClaimRunId !== expected.spawnClaimRunId
    ) return { changed: false, teamFile }
    removed = true
    return { changed: true, teamFile: { ...teamFile, members: teamFile.members.filter(candidate => candidate !== member) } }
  })
  return removed
}

function memberIdentityMatches(
  member: TeamMember,
  expected: TeamMemberIdentity,
): boolean {
  return member.agentId === expected.agentId &&
    member.tmuxPaneId === expected.tmuxPaneId &&
    member.processStartedAtMs === expected.processStartedAtMs &&
    member.processOsIdentity === expected.processOsIdentity &&
    member.processOwnerToken === expected.processOwnerToken &&
    member.processRunId === expected.processRunId &&
    member.spawnClaimToken === expected.spawnClaimToken &&
    member.spawnClaimRunId === expected.spawnClaimRunId &&
    member.spawnClaimOwnerPid === expected.spawnClaimOwnerPid &&
    member.spawnClaimOwnerStartedAtMs === expected.spawnClaimOwnerStartedAtMs &&
    member.spawnClaimRuntimeMayExist === expected.spawnClaimRuntimeMayExist
}

function normalizedMemberName(name: string): string {
  return sanitizeAgentName(name).trim().toLocaleLowerCase('en-US')
}

export async function claimTeamMemberForSpawn(
  teamName: string,
  reservation: TeamMember & { spawnClaimToken: string; spawnClaimRunId: string },
  expectedExisting?: TeamMemberIdentity,
): Promise<boolean> {
  let claimed = false
  await updateTeamFileAsync(teamName, teamFile => {
    const current = teamFile.members.find(member =>
      member.agentId === reservation.agentId ||
      normalizedMemberName(member.name) === normalizedMemberName(reservation.name),
    )
    if (current && (!expectedExisting || !memberIdentityMatches(current, expectedExisting))) {
      return { changed: false, teamFile }
    }
    claimed = true
    if (!current) return upsertTeamMember(teamFile, reservation)
    // Respawn is a new runtime generation. Replace the old record instead of
    // merging it so shutdown fences and recovery state cannot bleed into the
    // new incarnation.
    return {
      changed: true,
      teamFile: {
        ...teamFile,
        members: teamFile.members.map(member => member === current ? reservation : member),
      },
    }
  })
  return claimed
}

export async function publishClaimedTeamMember(
  teamName: string,
  claimToken: string,
  member: TeamMember,
): Promise<boolean> {
  let published = false
  await updateTeamFileAsync(teamName, teamFile => {
    const current = teamFile.members.find(candidate => candidate.agentId === member.agentId)
    if (current?.spawnClaimToken !== claimToken) {
      return { changed: false, teamFile }
    }
    published = true
    return upsertTeamMember(teamFile, {
      ...member,
      spawnClaimToken: undefined,
      spawnClaimRunId: undefined,
    })
  })
  return published
}

export async function armTeamMemberSpawnClaim(
  teamName: string,
  agentId: string,
  claimToken: string,
): Promise<boolean> {
  let armed = false
  await updateTeamFileAsync(teamName, teamFile => {
    const current = teamFile.members.find(candidate => candidate.agentId === agentId)
    if (
      current?.spawnClaimToken !== claimToken ||
      current.tmuxPaneId !== `spawn:pending:${claimToken}`
    ) return { changed: false, teamFile }
    armed = true
    return upsertTeamMember(teamFile, { ...current, spawnClaimRuntimeMayExist: true })
  })
  return armed
}

export async function recordArmedTeamMemberSpawnRuntime(
  teamName: string,
  agentId: string,
  claimToken: string,
  runtime: { paneId: string; backendType: Extract<BackendType, 'tmux' | 'iterm2'> },
): Promise<boolean> {
  let recorded = false
  await updateTeamFileAsync(teamName, teamFile => {
    const current = teamFile.members.find(candidate => candidate.agentId === agentId)
    if (
      current?.spawnClaimToken !== claimToken ||
      current.spawnClaimRuntimeMayExist !== true ||
      current.tmuxPaneId !== `spawn:pending:${claimToken}`
    ) return { changed: false, teamFile }
    recorded = true
    return upsertTeamMember(teamFile, {
      ...current,
      tmuxPaneId: runtime.paneId,
      backendType: runtime.backendType,
    })
  })
  return recorded
}

export async function releaseTeamMemberSpawnClaim(
  teamName: string,
  agentId: string,
  claimToken: string,
): Promise<boolean> {
  let removed = false
  await updateTeamFileAsync(teamName, teamFile => {
    const current = teamFile.members.find(candidate => candidate.agentId === agentId)
    if (
      current?.spawnClaimToken !== claimToken ||
      current.tmuxPaneId !== `spawn:pending:${claimToken}`
    ) {
      return { changed: false, teamFile }
    }
    removed = true
    return {
      changed: true,
      teamFile: {
        ...teamFile,
        members: teamFile.members.filter(candidate => candidate !== current),
      },
    }
  })
  return removed
}

export async function finalizeTeamMemberSpawnClaim(
  teamName: string,
  agentId: string,
  claimToken: string,
  claimRunId?: string,
): Promise<boolean> {
  let finalized = false
  await updateTeamFileAsync(teamName, teamFile => {
    const current = teamFile.members.find(candidate => candidate.agentId === agentId)
    if (!current) {
      return { changed: false, teamFile }
    }
    if (
      current.spawnClaimToken === undefined &&
      claimRunId !== undefined &&
      current.spawnClaimRunId === claimRunId &&
      current.tmuxPaneId !== `spawn:pending:${claimToken}`
    ) {
      finalized = true
      return { changed: false, teamFile }
    }
    if (current.spawnClaimToken !== claimToken || current.tmuxPaneId === `spawn:pending:${claimToken}`) {
      return { changed: false, teamFile }
    }
    finalized = true
    return upsertTeamMember(teamFile, {
      ...current,
      spawnClaimToken: undefined,
      spawnClaimOwnerPid: undefined,
      spawnClaimOwnerStartedAtMs: undefined,
      spawnClaimRuntimeMayExist: undefined,
    })
  })
  return finalized
}

export async function recordOutstandingShutdownRequest(
  teamName: string,
  memberName: string,
  requestId: string,
): Promise<boolean> {
  let recorded = false
  await updateTeamFileAsync(teamName, teamFile => {
    const current = teamFile.members.find(
      member => normalizedMemberName(member.name) === normalizedMemberName(memberName),
    )
    if (!current) return { changed: false, teamFile }
    recorded = true
    return upsertTeamMember(teamFile, {
      ...current,
      outstandingShutdownRequestId: requestId,
    })
  })
  return recorded
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
    `cleanupSessionTeams: checking ${teams.length} orphan team dir(s): ${teams.join(', ')}`,
  )
  // Kill panes first — on SIGINT the teammate processes are still running;
  // deleting directories alone would orphan them in open tmux/iTerm2 panes.
  // (TeamDeleteTool's path doesn't need this — by then teammates have
  // gracefully exited and useInboxPoller has already closed their panes.)
  await Promise.all(teams.map(async name => {
    const terminationConfirmed = await killOrphanedTeammateRuntimes(name).catch(
      () => false,
    )
    if (!terminationConfirmed) {
      logForDebugging(
        `cleanupSessionTeams: retaining ${name} recovery state because runtime termination was not confirmed`,
      )
      return
    }
    await cleanupTeamDirectories(name)
    sessionCreatedTeams.delete(name)
  }))
}

/**
 * Attempt to stop all out-of-process teammate runtimes for a team. Returns
 * false unless every runtime termination was confirmed, so callers retain the
 * recovery files on any uncertain result.
 * Called from cleanupSessionTeams on ungraceful leader exit (SIGINT/SIGTERM).
 * Dynamic imports avoid adding registry/detection to this module's static
 * dep graph — this only runs at shutdown, so the import cost is irrelevant.
 */
async function killOrphanedTeammateRuntimes(teamName: string): Promise<boolean> {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return true

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
  const unknownRuntimeMembers = teamFile.members.filter(
    m =>
      m.name !== TEAM_LEAD_NAME &&
      !processMembers.includes(m) &&
      !paneMembers.includes(m),
  )
  if (unknownRuntimeMembers.length > 0) {
    logForDebugging(
      `cleanupSessionTeams: retaining unknown runtime member(s): ${unknownRuntimeMembers.map(member => member.name).join(', ')}`,
    )
    return false
  }

  const processResults = await Promise.allSettled(
    processMembers.map(async m => {
      const paneId =
        m.tmuxPaneId?.trim() ||
        (typeof m.runtimePid === 'number' && m.runtimePid > 0
          ? buildProcessBackendPaneId(m.runtimePid)
          : undefined)
      const ok = await killProcessBackendRuntime(paneId, {
        expectedAgentId: m.agentId,
        teamName,
        expectedStartedAtMs: m.processStartedAtMs,
        expectedOwnerToken: m.processOwnerToken,
        expectedRunId: m.processRunId,
        expectedOsIdentity: m.processOsIdentity,
      })
      logForDebugging(
        `cleanupSessionTeams: killProcess ${m.name} (${m.tmuxPaneId}) => ${ok}`,
      )
      return ok
    }),
  )

  const processTerminationConfirmed = processResults.every(
    result => result.status === 'fulfilled' && result.value === true,
  )
  if (paneMembers.length === 0) return processTerminationConfirmed

  const [{ ensureBackendsRegistered, getBackendByType }, { isInsideTmux }] =
    await Promise.all([
      import('./backends/registry.js'),
      import('./backends/detection.js'),
    ])
  await ensureBackendsRegistered()
  const useExternalSession = !(await isInsideTmux())

  const paneResults = await Promise.allSettled(
    paneMembers.map(async m => {
      // filter above guarantees these; narrow for the type system
      if (!m.tmuxPaneId || !m.backendType || !isPaneBackend(m.backendType)) {
        return false
      }
      const ok = await getBackendByType(m.backendType).killPane(
        m.tmuxPaneId,
        useExternalSession,
      )
      logForDebugging(
        `cleanupSessionTeams: killPane ${m.name} (${m.backendType} ${m.tmuxPaneId}) → ${ok}`,
      )
      return ok
    }),
  )
  return processTerminationConfirmed && paneResults.every(
    result => result.status === 'fulfilled' && result.value === true,
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
  // A lossy legacy directory key can collide (for example a/b and a-b).
  // Missing state is safe to remove, but an existing config owned by another
  // exact name must never be killed or deleted through the requested alias.
  if (!teamFile) {
    const existingConfig = await readFile(getTeamFilePath(teamName), 'utf8').catch(error => {
      if (getErrnoCode(error) === 'ENOENT') return null
      throw error
    })
    if (existingConfig !== null) {
      logForDebugging(
        `[TeammateTool] Refusing cleanup for colliding team name "${teamName}"`,
        { level: 'warn' },
      )
      return
    }
  }
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

  await withTaskMutationCoordination(sanitizedName, async () => {
    const teamDir = getTeamDir(teamName)
    try {
      await rm(teamDir, { recursive: true, force: true })
      logForDebugging(`[TeammateTool] Cleaned up team directory: ${teamDir}`)
    } catch (error) {
      logForDebugging(`[TeammateTool] Failed to clean up team directory ${teamDir}: ${errorMessage(error)}`)
    }
    try {
      await removeTaskList(sanitizedName)
      logForDebugging(`[TeammateTool] Cleaned up tasks directory for: ${sanitizedName}`)
    } catch (error) {
      logForDebugging(`[TeammateTool] Failed to clean up tasks directory for ${sanitizedName}: ${errorMessage(error)}`)
    }
  })
}
