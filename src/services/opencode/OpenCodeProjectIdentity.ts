import path from 'node:path'
import { realpath } from 'node:fs/promises'

export function normalizeOpenCodeProjectIdentity(
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.resolve(projectPath)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Canonical identity for durable project-scoped state. Missing paths use their
 * normalized absolute spelling; existing paths use realpath so symlink aliases
 * converge. Other identity failures are not silently reinterpreted.
 */
export async function canonicalizeOpenCodeProjectIdentity(
  projectPath: string,
  options: Readonly<{ platform?: NodeJS.Platform; signal?: AbortSignal }> = {},
): Promise<string> {
  if (options.signal?.aborted) throw options.signal.reason
  const resolved = path.resolve(projectPath.trim())
  let canonical: string
  try { canonical = await realpath(resolved) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    canonical = resolved
  }
  if (options.signal?.aborted) throw options.signal.reason
  const normalized = path.normalize(canonical)
  return (options.platform ?? process.platform) === 'win32'
    ? normalized.toLowerCase() : normalized
}
