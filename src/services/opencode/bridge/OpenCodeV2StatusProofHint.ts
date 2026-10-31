import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import { normalizeOpenCodeProjectIdentity } from '../OpenCodeProjectIdentity.js'

const windows = process.platform === 'win32'
function hintFile(root: string, project: string): string {
  return path.join(root, `latest-${executionHash(normalizeOpenCodeProjectIdentity(project))}.json`)
}
/** Discovery only. A hint is never proof, even when written by the producer. */
export async function readOpenCodeV2StatusProofHint(root: string, project: string, signal?: AbortSignal): Promise<string | null> {
  try {
    signal?.throwIfAborted()
    const handle = await open(hintFile(root, project), constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW))
    try {
      signal?.throwIfAborted()
      const stat = await handle.stat()
      signal?.throwIfAborted()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1024 ||
        !windows && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) return null
      const row = JSON.parse(await handle.readFile({ encoding: 'utf8', signal }))
      signal?.throwIfAborted()
      return row?.schemaVersion === 1 && typeof row.sourceKey === 'string' && /^[a-f0-9]{64}$/.test(row.sourceKey)
        ? row.sourceKey : null
    } finally { await handle.close() }
  } catch { return null }
}
/** Atomic per-project hint avoids scanning arbitrarily many historical probes.
 * Best effort: a display-index failure must not undo completed native evidence. */
export async function writeOpenCodeV2StatusProofHint(root: string, project: string, sourceKey: string): Promise<void> {
  let temporary: string | undefined
  try {
    if (!/^[a-f0-9]{64}$/.test(sourceKey)) return
    const stat = await lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root ||
      !windows && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) return
    temporary = path.join(root, `.latest-${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, sourceKey }), { flag: 'wx', mode: 0o600 })
    await rename(temporary, hintFile(root, project))
  } catch { /* The resolver's private probe record remains the only authority. */ }
  finally { if (temporary) await rm(temporary, { force: true }).catch(() => undefined) }
}
