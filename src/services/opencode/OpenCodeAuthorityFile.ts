import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs'

/** Bound content work for config, auth stores and configuration references. */
const OPEN_CODE_AUTHORITY_FILE_MAX_BYTES = 1024 * 1024

/** Follow regular-file symlinks, but bind each read to one unchanged descriptor.
 * Initial stat errno is retained so callers can distinguish optional absence. */
export function readOpenCodeAuthorityFile(file: string): string {
  const before = statSync(file)
  if (!before.isFile() || before.size > OPEN_CODE_AUTHORITY_FILE_MAX_BYTES) throw new Error()
  // Nonblocking open also closes the stat/open FIFO replacement race.
  let fd: number
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK) }
  catch { throw new Error() }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size > OPEN_CODE_AUTHORITY_FILE_MAX_BYTES
      || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs) throw new Error()
    const bytes = Buffer.alloc(OPEN_CODE_AUTHORITY_FILE_MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    const after = fstatSync(fd)
    const current = statSync(file)
    if (length > OPEN_CODE_AUTHORITY_FILE_MAX_BYTES || length !== opened.size || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || current.dev !== opened.dev || current.ino !== opened.ino
      || current.size !== after.size || current.mtimeMs !== after.mtimeMs
      || current.ctimeMs !== after.ctimeMs) throw new Error()
    return bytes.subarray(0, length).toString('utf8')
  } catch {
    throw new Error()
  } finally {
    closeSync(fd)
  }
}
