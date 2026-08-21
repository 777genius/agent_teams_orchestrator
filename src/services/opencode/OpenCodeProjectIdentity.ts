import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'

export function normalizeOpenCodeProjectIdentity(
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.resolve(projectPath)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Canonical identity for durable project-scoped state. Launch identities must
 * name a stable, existing directory: guessing an identity for a missing path
 * would let a later-created symlink escape the global mutation fence.
 */
export async function canonicalizeOpenCodeProjectIdentity(
  projectPath: string,
  options: Readonly<{
    platform?: NodeJS.Platform
    signal?: AbortSignal
    filesystem?: Readonly<{
      realpath(path: string): Promise<string>
      lstat(path: string): Promise<{ dev: number; ino: number; isDirectory(): boolean }>
    }>
  }> = {},
): Promise<string> {
  throwIfAborted(options.signal)
  const resolved = path.resolve(projectPath.trim())
  if (!projectPath.trim()) throw new Error('OpenCode project path is empty')
  const filesystem = options.filesystem ?? { realpath, lstat }
  const platform = options.platform ?? process.platform
  const canonical = await abortable(filesystem.realpath(resolved), options.signal)
  const first = await abortable(filesystem.lstat(canonical), options.signal)
  if (!first.isDirectory()) throw new Error('OpenCode project path must be a directory')
  // Re-resolve after observing the target. A deleted or retargeted alias fails
  // closed instead of freezing an identity that was never actually inspected.
  const confirmed = await abortable(filesystem.realpath(resolved), options.signal)
  const second = await abortable(filesystem.lstat(confirmed), options.signal)
  const canonicalIdentity = normalizeCanonicalPath(canonical, platform)
  const confirmedIdentity = normalizeCanonicalPath(confirmed, platform)
  if (canonicalIdentity !== confirmedIdentity
    || first.dev !== second.dev || first.ino !== second.ino
    || !second.isDirectory()) {
    throw new Error('OpenCode project path changed during canonicalization')
  }
  throwIfAborted(options.signal)
  return canonicalIdentity
}

function normalizeCanonicalPath(value: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(value)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error('OpenCode project canonicalization cancelled')
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  throwIfAborted(signal)
  let remove = () => {}
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error
      ? signal.reason : new Error('OpenCode project canonicalization cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    remove = () => signal.removeEventListener('abort', onAbort)
  })
  try { return await Promise.race([operation, aborted]) }
  finally { remove() }
}
