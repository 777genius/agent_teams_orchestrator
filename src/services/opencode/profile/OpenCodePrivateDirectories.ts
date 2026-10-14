import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../host/windows/OpenCodeV2WindowsOwnerFilesystem.js'

type PrivateDirectories = Pick<ReturnType<typeof createWindowsOwnerFilesystem>, 'createDirectory' | 'openDirectory'>

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
    for (const directory of directories) await acquire(directory)
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
