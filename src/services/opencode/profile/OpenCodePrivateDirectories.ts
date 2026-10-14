import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../host/windows/OpenCodeV2WindowsOwnerFilesystem.js'

type PrivateDirectories = Pick<ReturnType<typeof createWindowsOwnerFilesystem>, 'createDirectory' | 'openDirectory'>

/** V1 also ships without V2 native assets (standalone Bun and Windows ARM64).
 * This is delivery routing only. Present/partial assets must pass the existing
 * native resolver; identity, ACL and native failures never enable fallback. */
export async function hasWindowsPrivateProfileDirectoryDelivery(context = {
  platform: process.platform as string, arch: process.arch as string,
  moduleUrl: import.meta.url, entrypoint: Bun.main,
}): Promise<boolean> {
  if (context.platform !== 'win32' || context.arch !== 'x64' ||
    [context.moduleUrl, context.entrypoint].some(value => value.includes('$bunfs') || /[/\\]~BUN[/\\]/.test(value))) return false
  const location = fileURLToPath(context.moduleUrl), marker = `${path.sep}src${path.sep}`
  const root = location.includes(marker) ? location.slice(0, location.lastIndexOf(marker)) : path.dirname(location)
  try { await lstat(path.join(root, 'native', 'win32-x64')); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Only SDK-owned namespaces call this boundary. Existing directories are
 * validated, never repaired; uncertain/partial native creations are preserved. */
export async function prepareWindowsPrivateDirectories(directories: readonly string[], filesystem: PrivateDirectories, exclusive: readonly string[] = []): Promise<void> {
  const held = new Map<string, WindowsOwnerDirectory>()
  const requested = new Set(directories)
  const acquire = async (directory: string): Promise<void> => {
    if (held.has(directory)) return
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    // Shared existing ancestors are retained/checked by the native child open,
    // not promoted to SDK-private directories. Explicit requested roots remain strict.
    if (info && !requested.has(directory)) return
    if (info && exclusive.includes(directory)) throw new Error('execution_profile_owned')
    if (!info) {
      const parent = path.dirname(directory)
      if (parent === directory) throw new Error('execution_owner_path_invalid')
      await acquire(parent)
    }
    // Native OPEN rechecks ownership, private ACL, reparse and exact identity.
    // CREATE is exclusive: a competing creator is not silently adopted.
    const handle = info ? await filesystem.openDirectory(directory) : await filesystem.createDirectory(directory)
    held.set(directory, handle)
    await handle.assertOwned()
  }
  try {
    if (directories.length > 64) throw new Error('execution_owner_path_invalid')
    for (let index = 0; index < directories.length; index++) {
      try { await acquire(directories[index]!) }
      catch (error) {
        if (error instanceof Error && error.message.length <= 200 &&
          /^(?:execution_owner_(?:not_private|unknown|path_invalid|platform_pending)|execution_path_alias|execution_profile_owned)(?::[a-z_0-9]+(?::[0-9]{1,10})?)?$/.test(error.message)) {
          error.message += `:private_dir_${index}`
        }
        throw error
      }
    }
    for (const handle of held.values()) await handle.assertOwned()
  } finally {
    const results = await Promise.allSettled([...held.values()].reverse().map(handle => handle.close()))
    if (results.some(result => result.status === 'rejected')) throw new Error('cleanup_unknown')
  }
}

export async function ensureWindowsPrivateDirectories(directories: readonly string[], exclusive: readonly string[] = []): Promise<void> {
  if (process.platform !== 'win32') throw new Error('execution_owner_platform_pending')
  const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
  broker.events.on('error', () => {})
  try {
    const filesystem = createWindowsOwnerFilesystem((request, deadline, signal) => broker.request(request.op, request, deadline, signal))
    await prepareWindowsPrivateDirectories(directories, filesystem, exclusive)
  } finally { await broker.close() }
}
