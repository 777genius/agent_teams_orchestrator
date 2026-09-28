import { constants, lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_WAL_BYTES = 8 * 1024 * 1024
/** Names the retired Owner task writer used; its legacy name is shared with Product's old writer. */
const RETIRED_OWNER_TASK_WAL_FILES = [
  'hosted-task-board-owner-mutation.wal.v1.json',
  'hosted-task-board-mutation.wal.v1.json',
] as const

export class HostedOwnerTaskWalPreparedError extends Error {
  constructor(readonly path: string) {
    super(`A task mutation of the retired Owner task writer is still prepared in ${path}. ` +
      'Stop the stack, check the task board, then remove the file before starting again.')
    this.name = 'HostedOwnerTaskWalPreparedError'
  }
}

/**
 * Tasks now go through the agent-teams controller, which never reads this WAL. A mutation the old
 * Owner writer prepared but did not finish would be silently lost, so the Owner refuses to start
 * until the operator has looked at it. A finished (terminal) WAL is only history and is left alone.
 */
export async function assertNoPreparedRetiredOwnerTaskMutation(teamRoot: string): Promise<void> {
  for (const name of RETIRED_OWNER_TASK_WAL_FILES) {
    const path = join(teamRoot, name)
    const text = await readRegularFile(path)
    if (text === null) continue
    let state: unknown
    try { state = JSON.parse(text) } catch { throw new HostedOwnerTaskWalPreparedError(path) }
    if (isPreparedOwnerIntent(state)) throw new HostedOwnerTaskWalPreparedError(path)
  }
}

function isPreparedOwnerIntent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  const intent = state.intent as Record<string, unknown> | undefined
  return state.phase === 'prepared' && !!intent && typeof intent === 'object' && intent.recordType === 'intent'
}

async function readRegularFile(path: string): Promise<string | null> {
  const stat = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!stat) return null
  if (!stat.isFile() || stat.size > MAX_WAL_BYTES) throw new HostedOwnerTaskWalPreparedError(path)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try { return await handle.readFile('utf8') } finally { await handle.close() }
}
