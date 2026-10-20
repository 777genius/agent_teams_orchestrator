import { chmodSync, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerCleanup } from '../cleanupRegistry.js'

/** Keep inherited settings out of argv and shared, predictable temp paths. */
export function writeOwnedMemberSettingsFile(settings: Record<string, unknown>): string | null {
  const directory = mkdtempSync(join(tmpdir(), 'agent-teams-member-settings-'))
  const directoryStat = lstatSync(directory)
  const path = join(directory, 'settings.json')
  let fileStat: ReturnType<typeof lstatSync> | undefined
  const cleanup = async (): Promise<void> => {
    try {
      const currentDirectory = lstatSync(directory)
      if (!currentDirectory.isDirectory() || currentDirectory.dev !== directoryStat.dev ||
          currentDirectory.ino !== directoryStat.ino) {
        throw new Error('Owned member settings directory changed')
      }
      if (fileStat) {
        const current = lstatSync(path)
        if (!current.isFile() || current.dev !== fileStat.dev || current.ino !== fileStat.ino) {
          throw new Error('Owned member settings file changed')
        }
        unlinkSync(path)
      }
      rmdirSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    chmodSync(directory, 0o700)
    const descriptor = openSync(path, 'wx', 0o600)
    try {
      fileStat = fstatSync(descriptor)
      writeFileSync(descriptor, `${JSON.stringify(settings, null, 2)}\n`)
    } finally {
      closeSync(descriptor)
    }
    // Keep the file through startup and teammate lifetime. Spawned runtimes
    // snapshot flag settings when loading them; normal owner shutdown removes
    // this private copy through the existing runtime cleanup registry.
    registerCleanup(cleanup)
    return path
  } catch {
    // No child can have received a path if materialization failed.
    void cleanup().catch(() => {})
    return null
  }
}
