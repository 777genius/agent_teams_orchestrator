import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

// Narrow injection point for reproducing Windows sharing violations on any OS.
type PublicationRename = {
  platform: NodeJS.Platform
  rename: typeof rename
}

// Never open a published wrapper for writing: another process may execute it
// (ETXTBSY on Linux), read it, or publish concurrently (EBUSY on Windows).
export async function publishNativeCliFile(
  filePath: string, content: string, mode: number,
  publication: PublicationRename = { platform: process.platform, rename },
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
    for (let attempt = 0; ; attempt++) {
      try {
        await publication.rename(temporaryPath, filePath)
        break
      } catch (error) {
        const { code, syscall } = error as NodeJS.ErrnoException
        // Windows readers can temporarily deny replacement. Retry only rename
        // sharing/access failures, with the same closed, fully prepared inode.
        // Eight attempts, seven delays totalling 1,270 ms; never unlink target.
        if (publication.platform !== 'win32' || syscall !== 'rename'
          || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 7) throw error
        await setTimeout(10 * 2 ** attempt)
      }
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
