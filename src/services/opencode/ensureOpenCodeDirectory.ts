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

  let mkdirError: unknown
  try {
    await operations.mkdir(directory, { recursive: true })
  } catch (error) {
    if (errno(error) !== 'EEXIST') throw error
    mkdirError = error
  }
  // Bun can report mkdir success for a dangling Windows junction. Verify both
  // successful creation and EEXIST races before accepting the directory.
  const existing = await operations.stat(directory).catch(statError => {
    if (errno(statError) !== 'ENOENT') throw statError
    return null
  })
  if (!existing?.isDirectory()) {
    // Keep EEXIST so migration callers can inspect conflicts with lstat without
    // traversing or replacing dangling links. Preserve the original mkdir error.
    throw mkdirError ?? Object.assign(new Error(`Not a directory: ${directory}`), {
      code: 'EEXIST', path: directory, syscall: 'mkdir',
    })
  }
}
