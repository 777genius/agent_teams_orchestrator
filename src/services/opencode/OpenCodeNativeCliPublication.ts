import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'

// Never open a published wrapper for writing: another process may execute it
// (ETXTBSY on Linux), read it, or publish concurrently (EBUSY on Windows).
export async function publishNativeCliFile(
  filePath: string, content: string, mode: number,
): Promise<void> {
  try {
    const existing = await lstat(filePath)
    if (existing.isFile() && (process.platform === 'win32' || (existing.mode & 0o7777) === mode)
      && await readFile(filePath, 'utf8') === content) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  const file = await open(temporaryPath, 'wx', 0o600)
  try {
    try {
      await file.writeFile(content, 'utf8')
      await file.chmod(mode)
    } finally {
      // Close before publication so exec never sees an inode open for writing.
      await file.close()
    }
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
