import path from 'node:path'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { executionAssert } from '../execution/OpenCodeV2ExecutionContracts.js'

const windows = process.platform === 'win32'
async function directory(file: string, shared: boolean, lexical = false): Promise<void> {
  await mkdir(file, { recursive: lexical, mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const info = await lstat(file)
  executionAssert(info.isDirectory() && !info.isSymbolicLink() &&
    (lexical && windows || await realpath(file) === file) &&
    (windows || info.uid === process.getuid?.() && (info.mode & (shared ? 0o022 : 0o077)) === 0), 'probe_store_foreign')
}

/** V1 owns the readable shared ancestors; V2 secrets stay behind private V2 directories.
 * Match RunControl's existing namespace contract without chmod or relocating user data. */
export async function ensureOpenCodeV2ProbeStore(requestedDataRoot: string): Promise<{ dataRoot: string; probeRoot: string }> {
  await directory(requestedDataRoot, true, true)
  const dataRoot = await realpath(requestedDataRoot)
  await directory(path.join(dataRoot, 'opencode'), true)
  await directory(path.join(dataRoot, 'opencode/v2'), false)
  const probeRoot = path.join(dataRoot, 'opencode/v2/execution-probes')
  await directory(probeRoot, false)
  return { dataRoot, probeRoot }
}

/** Darwin's ctime cannot be restored with utimes: an owned 0755 root whose last
 * metadata change predates the original private intent could never pass the old
 * 0700 guard. Missing birthtime or any subsequent metadata change fails closed. */
export async function assertLegacyOpenCodeV2ProbePreEffect(dataRoot: string, marker: string, saved: Record<string, unknown>): Promise<void> {
  const code = 'provider_original_execution_unknown'
  executionAssert(process.platform === 'darwin' && await realpath(dataRoot) === dataRoot && await realpath(marker) === marker, code)
  const root = await lstat(dataRoot, { bigint: true }), intent = await lstat(marker, { bigint: true })
  executionAssert(root.isDirectory() && !root.isSymbolicLink() && root.uid === BigInt(process.getuid!()) &&
    (root.mode & 0o7777n) === 0o755n && intent.isFile() && !intent.isSymbolicLink() &&
    intent.uid === root.uid && (intent.mode & 0o7777n) === 0o600n && intent.nlink === 1n &&
    intent.size < 65536n && root.dev === intent.dev && intent.birthtimeNs > 0n && root.ctimeNs > 0n &&
    root.ctimeNs <= intent.birthtimeNs, code)
  const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    executionAssert(opened.dev === intent.dev && opened.ino === intent.ino && opened.ctimeNs === intent.ctimeNs, code)
    const actual = JSON.parse(await handle.readFile('utf8'))
    executionAssert(JSON.stringify(actual) === JSON.stringify(saved), code)
    const after = await handle.stat({ bigint: true }), named = await lstat(marker, { bigint: true })
    executionAssert(after.ctimeNs === intent.ctimeNs && after.size === intent.size &&
      named.ino === intent.ino && named.dev === intent.dev && named.ctimeNs === intent.ctimeNs, code)
  } finally { await handle.close() }
  try {
    await lstat(path.join(dataRoot, 'opencode/v2/execution-probes'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const after = await lstat(dataRoot, { bigint: true })
    executionAssert(after.ino === root.ino && after.dev === root.dev && after.ctimeNs === root.ctimeNs && after.mode === root.mode, code)
    return
  }
  throw new Error(code)
}
