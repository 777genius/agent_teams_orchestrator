import { mkdir, stat } from 'node:fs/promises'

type DirectoryOperations = {
  stat: (directory: string) => Promise<{ isDirectory(): boolean }>
  mkdir: (directory: string, options: { recursive: true }) => Promise<unknown>
}

function errno(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}

/**
 * Avoid Bun's Windows EEXIST on existing ReadOnly directories. Follow junctions.
 * https://github.com/oven-sh/bun/issues/34413
 */
export async function ensureOpenCodeDirectory(
  directory: string,
  operations: DirectoryOperations = { stat, mkdir },
): Promise<void> {
  try {
    if ((await operations.stat(directory)).isDirectory()) return
    throw Object.assign(new Error(`Not a directory: ${directory}`), {
      code: 'EEXIST', path: directory, syscall: 'mkdir',
    })
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error
  }

  try {
    await operations.mkdir(directory, { recursive: true })
  } catch (error) {
    if (errno(error) !== 'EEXIST') throw error
    // A concurrent creator may have won. EEXIST alone is never success.
    const existing = await operations.stat(directory).catch(statError => {
      if (errno(statError) !== 'ENOENT') throw statError
      // Preserve mkdir's conflict for dangling links and concurrently removed paths.
      return null
    })
    if (!existing?.isDirectory()) throw error
  }
}
