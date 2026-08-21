import { createHash } from 'node:crypto'
import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'

export function normalizeOpenCodeProjectIdentity(
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.resolve(projectPath)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Stable path key shared by every durable project-scoped compatibility root. */
export function openCodeProjectIdentityKey(canonicalProjectIdentity: string): string {
  return createHash('sha256').update(canonicalProjectIdentity).digest('hex').slice(0, 16)
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
    /** Compatibility profiles historically accepted not-yet-created projects. */
    allowMissing?: boolean
    filesystem?: Readonly<{
      realpath(path: string): Promise<string>
      lstat(path: string): Promise<{ dev: number; ino: number; isDirectory(): boolean }>
    }>
  }> = {},
): Promise<string> {
  throwIfAborted(options.signal)
  const platform = options.platform ?? process.platform
  const input = projectPath.trim()
  if (!input) throw new Error('OpenCode project path is empty')
  const pathApi = platform === 'win32' && isWindowsPath(input) ? path.win32 : path
  const resolved = pathApi.resolve(input)
  const filesystem = options.filesystem ?? { realpath, lstat }
  let canonical: string
  try {
    canonical = await abortable(filesystem.realpath(resolved), options.signal)
  } catch (error) {
    if (!options.allowMissing || !isMissing(error)) throw error
    // A broken alias is not a missing project: accepting it would create a
    // second durable identity for an already-named filesystem object.
    try { await abortable(filesystem.lstat(resolved), options.signal) }
    catch (metadataError) {
      if (isMissing(metadataError)) {
        return canonicalizeMissingProjectIdentity(
          resolved, platform, pathApi, filesystem, options.signal,
        )
      }
      throw metadataError
    }
    throw error
  }
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

async function canonicalizeMissingProjectIdentity(
  resolved: string,
  platform: NodeJS.Platform,
  pathApi: typeof path | typeof path.win32,
  filesystem: Readonly<{
    realpath(path: string): Promise<string>
    lstat(path: string): Promise<{ dev: number; ino: number; isDirectory(): boolean }>
  }>,
  signal?: AbortSignal,
): Promise<string> {
  const suffix: string[] = []
  const missingPaths: string[] = []
  let cursor = resolved
  let canonicalAncestor: string

  for (;;) {
    throwIfAborted(signal)
    try {
      canonicalAncestor = await abortable(filesystem.realpath(cursor), signal)
      break
    } catch (error) {
      if (!isMissing(error)) throw error
      // ENOENT from realpath may describe either an absent component or a
      // broken symlink. Only the former is eligible for compatibility identity.
      try {
        await abortable(filesystem.lstat(cursor), signal)
      } catch (metadataError) {
        if (!isMissing(metadataError)) throw metadataError
        const parent = pathApi.dirname(cursor)
        if (parent === cursor) throw error
        suffix.unshift(pathApi.basename(cursor))
        missingPaths.unshift(cursor)
        cursor = parent
        continue
      }
      throw error
    }
  }

  const first = await abortable(filesystem.lstat(canonicalAncestor), signal)
  if (!first.isDirectory()) throw new Error('OpenCode project ancestor must be a directory')
  const confirmed = await abortable(filesystem.realpath(cursor), signal)
  const second = await abortable(filesystem.lstat(confirmed), signal)
  if (normalizeCanonicalPath(canonicalAncestor, platform) !== normalizeCanonicalPath(confirmed, platform)
    || first.dev !== second.dev || first.ino !== second.ino || !second.isDirectory()) {
    throw new Error('OpenCode project path changed during canonicalization')
  }
  // The nearest missing component is the mutation boundary. If it appeared
  // while the ancestor was inspected, it could now be a symlink and the
  // appended suffix would no longer name the path we proved.
  try {
    await abortable(filesystem.lstat(missingPaths[0]!), signal)
    throw new Error('OpenCode project path changed during canonicalization')
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  throwIfAborted(signal)
  return normalizeCanonicalPath(pathApi.join(canonicalAncestor, ...suffix), platform)
}

function normalizeCanonicalPath(value: string, platform: NodeJS.Platform): string {
  const normalized = platform === 'win32' && isWindowsPath(value)
    ? path.win32.normalize(value)
    : path.normalize(value)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
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

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT')
}
