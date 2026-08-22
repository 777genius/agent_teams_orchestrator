import { AsyncLocalStorage } from 'node:async_hooks'
import { chmod, constants, lstat, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import * as lockfile from './lockfile.js'
import { safeWindowsPathSegment } from './windowsReservedNames.js'

type LaneToken = { active: boolean }
type CoordinatorContext = ReadonlyMap<string, LaneToken>

const activeTeams = new AsyncLocalStorage<CoordinatorContext>()
const teamTails = new Map<string, Promise<void>>()
const CROSS_PROCESS_LOCK_OPTIONS = { retries: { retries: 30, minTimeout: 5, maxTimeout: 100 } }

export class TaskMutationLockUnavailableError extends Error {}

/**
 * Serializes every in-process task-board mutation for a team. Calls made by a
 * mutation while it already owns the same team lane are reentrant; this is
 * required by compound operations such as delete cascades and block updates.
 * The outermost lane also owns a shared proper-lockfile anchor so dedicated
 * companion and legacy CLI processes serialize on the same task-list lock.
 */
export async function withTaskMutationCoordination<T>(
  teamId: string,
  mutation: () => Promise<T>,
  options: { claudeRoot?: string } = {},
): Promise<T> {
  const inherited = activeTeams.getStore()
  if (inherited?.get(teamId)?.active) {
    return mutation()
  }

  const previous = teamTails.get(teamId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  teamTails.set(teamId, tail)

  await previous.catch(() => undefined)
  const token: LaneToken = { active: true }
  let releaseFileLock: (() => Promise<void>) | undefined
  try {
    const claudeRoot = options.claudeRoot ?? getClaudeConfigHomeDir(); const tasksRoot = join(claudeRoot, 'tasks'); const uid = process.getuid?.()
    const claudeRootStat = await lstat(claudeRoot)
    if (!claudeRootStat.isDirectory() || claudeRootStat.isSymbolicLink() || (uid !== undefined && claudeRootStat.uid !== uid)) throw new TaskMutationLockUnavailableError('Unsafe Claude root for task mutation lock')
    await mkdir(tasksRoot, { recursive: true, mode: 0o700 }); const tasksRootStat = await lstat(tasksRoot)
    if (!tasksRootStat.isDirectory() || tasksRootStat.isSymbolicLink() || (uid !== undefined && tasksRootStat.uid !== uid)) throw new TaskMutationLockUnavailableError('Unsafe tasks root for task mutation lock')
    const lockRoot = join(tasksRoot, '.mutation-locks')
    await mkdir(lockRoot, { recursive: true, mode: 0o700 })
    let rootStat = await lstat(lockRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (uid !== undefined && rootStat.uid !== uid)) throw new TaskMutationLockUnavailableError('Unsafe task mutation lock directory')
    await chmod(lockRoot, 0o700); rootStat = await lstat(lockRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) throw new TaskMutationLockUnavailableError('Unsafe task mutation lock directory')
    const lockPath = join(lockRoot, `${safeWindowsPathSegment(teamId.replace(/[^a-zA-Z0-9_-]/g, '-'))}.lock`)
    const anchor = await open(lockPath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600)
    const anchorStat = await anchor.stat(); await anchor.close()
    if (!anchorStat.isFile() || (uid !== undefined && anchorStat.uid !== uid) || (anchorStat.mode & 0o077) !== 0) throw new TaskMutationLockUnavailableError('Unsafe task mutation lock anchor')
    try { releaseFileLock = await lockfile.lock(lockPath, { ...CROSS_PROCESS_LOCK_OPTIONS, realpath: false }) } catch (error) { throw new TaskMutationLockUnavailableError(`Task mutation lock unavailable: ${String(error)}`) }
    const [lockedRootStat, lockedAnchorStat] = await Promise.all([lstat(lockRoot), lstat(lockPath)])
    if (lockedRootStat.dev !== rootStat.dev || lockedRootStat.ino !== rootStat.ino || lockedAnchorStat.dev !== anchorStat.dev || lockedAnchorStat.ino !== anchorStat.ino || !lockedAnchorStat.isFile() || lockedAnchorStat.isSymbolicLink()) throw new TaskMutationLockUnavailableError('Task mutation lock path was substituted')
    const releaseVerified = releaseFileLock!
    releaseFileLock = async () => {
      let validationError: TaskMutationLockUnavailableError | undefined
      try { const [finalRoot, finalAnchor] = await Promise.all([lstat(lockRoot), lstat(lockPath)]); if (finalRoot.dev !== rootStat.dev || finalRoot.ino !== rootStat.ino || finalAnchor.dev !== anchorStat.dev || finalAnchor.ino !== anchorStat.ino) validationError = new TaskMutationLockUnavailableError('Task mutation lock path changed while held') } catch { validationError = new TaskMutationLockUnavailableError('Task mutation lock path disappeared while held') }
      await releaseVerified()
      if (validationError) throw validationError
    }
    const context = new Map(inherited ?? [])
    context.set(teamId, token)
    return await activeTeams.run(context, mutation)
  } finally {
    token.active = false
    try { await releaseFileLock?.() } finally {
      release()
      if (teamTails.get(teamId) === tail) teamTails.delete(teamId)
    }
  }
}

export function isTaskMutationCoordinated(teamId: string): boolean {
  return activeTeams.getStore()?.get(teamId)?.active ?? false
}
