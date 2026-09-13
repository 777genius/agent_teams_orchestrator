import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'

export const OPEN_CODE_AUTHORITY_FILE_MAX_BYTES = 1024 * 1024
const AUTHORITY_TIMEOUT_MS = 1_000

/** Each operation owns its late completion. The caller never waits past its budget. */
export async function boundedOpenCodeAuthorityOperation<T>(
  operation: () => Promise<T>, timeoutMs = AUTHORITY_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('OpenCode authority operation timed out')), timeoutMs)
      }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

function unchanged(left: Stats, right: Stats): boolean {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

/** Asynchronous descriptor I/O, including close, never blocks the main event loop.
 * A timeout retires the read. Any late open is closed by its owning operation;
 * no further reads are issued after expiry, and late errors remain observed.
 * Only initial absence preserves errno; all other errors are deliberately opaque.
 */
export async function readOpenCodeAuthorityFileBytes(
  file: string, options: { timeoutMs?: number } = {},
): Promise<Buffer> {
  let expired = false
  let handle: FileHandle | undefined
  let closing: Promise<void> | undefined
  const close = () => {
    if (!handle) return Promise.resolve()
    return closing ??= Promise.resolve().then(() => handle!.close())
      .catch(() => { throw new Error('OpenCode authority file cleanup failed') })
  }
  const check = () => { if (expired) throw new Error() }
  try {
    return await boundedOpenCodeAuthorityOperation(async () => {
      let before: Stats
      try { before = await stat(file) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          throw Object.assign(new Error('OpenCode authority file is absent'), { code })
        }
        throw new Error('OpenCode authority file is unavailable')
      }
      check()
      if (!before.isFile() || before.size > OPEN_CODE_AUTHORITY_FILE_MAX_BYTES) {
        throw new Error('OpenCode authority file is unavailable')
      }
      // O_NONBLOCK also protects a regular-file to FIFO replacement before open.
      try { handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK) }
      catch { throw new Error('OpenCode authority file is unavailable') }
      try {
        check()
        const opened = await handle.stat()
        check()
        if (!unchanged(before, opened)) throw new Error()
        const bytes = Buffer.alloc(Math.min(opened.size + 1, OPEN_CODE_AUTHORITY_FILE_MAX_BYTES + 1))
        let length = 0
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
          check()
          if (!bytesRead) break
          length += bytesRead
        }
        const after = await handle.stat()
        check()
        const current = await stat(file)
        check()
        if (length !== opened.size || !unchanged(opened, after) || !unchanged(after, current)) throw new Error()
        return bytes.subarray(0, length)
      } catch { throw new Error('OpenCode authority file is unavailable') }
      finally { await close() }
    }, options.timeoutMs)
  } finally {
    expired = true
    // Request close immediately for an acquired descriptor. Node waits for any
    // in-flight kernel read; the same close promise is shared with late unwind.
    void close().catch(() => {})
  }
}

export async function readOpenCodeAuthorityFile(
  file: string, options: { timeoutMs?: number } = {},
): Promise<string> {
  return (await readOpenCodeAuthorityFileBytes(file, options)).toString('utf8')
}
