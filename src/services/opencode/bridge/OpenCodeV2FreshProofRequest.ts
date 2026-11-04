import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { executionAssert, executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'

const claimPath = (directory: string, requestId: string) => path.join(directory, `fresh-${executionHash(requestId)}.json`)
const marker = (sourceKey: string, requestId: string) => ({ schema: 1, sourceKey, freshExecutionProofRequestId: requestId })

/** Permanent per-admission tombstones share the probe's private directory and lock.
 * A retired successor never makes an older request eligible for paid execution again. */
export async function hasOpenCodeV2FreshProofClaim(directory: string, sourceKey: string, requestId: string): Promise<boolean> {
  const file = claimPath(directory, requestId)
  let before: Stats
  try { before = await lstat(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  executionAssert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size < 4096 &&
    await realpath(file) === file && (process.platform === 'win32' || before.uid === process.getuid?.() &&
      (before.mode & 0o077) === 0), 'probe_fresh_claim_foreign')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await handle.stat()
    executionAssert(current.dev === before.dev && current.ino === before.ino && current.size < 4096, 'probe_fresh_claim_foreign')
    const value: unknown = JSON.parse(await handle.readFile('utf8'))
    const after = await handle.stat(), named = await lstat(file)
    executionAssert(after.dev === current.dev && after.ino === current.ino && after.size === current.size &&
      after.mtimeMs === current.mtimeMs && named.dev === current.dev && named.ino === current.ino &&
      executionHash(value) === executionHash(marker(sourceKey, requestId)), 'probe_fresh_claim_foreign')
    return true
  } finally { await handle.close() }
}

/** Write-ahead only, never replaced or removed, even if the later probe save fails. */
export async function claimOpenCodeV2FreshProofRequest(directory: string, sourceKey: string, requestId: string): Promise<void> {
  const handle = await open(claimPath(directory, requestId), 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(marker(sourceKey, requestId))); await handle.sync() }
  finally { await handle.close() }
  if (process.platform !== 'win32') {
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await parent.sync() } finally { await parent.close() }
  }
}
