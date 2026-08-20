import { lstat } from 'node:fs/promises'
import path from 'node:path'

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

/**
 * Standard Node APIs provide no Windows mkdirat/openat equivalent with a held,
 * no-follow directory handle. Runtime support is therefore bounded to a
 * trusted, pre-provisioned app root and its already-existing descendants.
 */
export async function ensureOpenCodeWindowsManagedDirectoryPath(
  resolved: string,
  ownershipBoundary: string,
  afterComponentOpened?: (componentPath: string) => void | Promise<void>,
): Promise<void> {
  const parsed = path.parse(resolved)
  const relativeParts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
  const boundaryMetadata = await lstat(ownershipBoundary, { bigint: true }).catch(error => {
    if (errnoCode(error) === 'ENOENT') return null
    throw error
  })
  if (!boundaryMetadata?.isDirectory() || boundaryMetadata.isSymbolicLink()) {
    throw new Error('OpenCode Windows managed root must be trusted and pre-existing [redacted]')
  }

  const walk = async (notify: boolean): Promise<bigint[]> => {
    const identities: bigint[] = []
    let current = parsed.root
    for (const part of relativeParts) {
      current = path.join(current, part)
      const metadata = await lstat(current, { bigint: true }).catch(error => {
        if (errnoCode(error) === 'ENOENT') return null
        throw error
      })
      if (!metadata) {
        throw new Error('OpenCode Windows managed path must be pre-provisioned [redacted]')
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('OpenCode scoped managed path ancestry is not canonical [redacted]')
      }
      if (notify) await afterComponentOpened?.(current)
      identities.push(metadata.dev, metadata.ino)
    }
    return identities
  }

  const observedIdentities = await walk(true)
  const reachableIdentities = await walk(false)
  if (observedIdentities.length !== reachableIdentities.length
    || observedIdentities.some((identity, index) => identity !== reachableIdentities[index])) {
    throw new Error('OpenCode scoped managed path ancestry changed during creation [redacted]')
  }
}
