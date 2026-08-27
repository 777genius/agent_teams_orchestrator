import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises'
import path from 'node:path'

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

type DirectoryIdentity = {
  dev: bigint
  ino: bigint
}

export type OpenCodeWindowsManagedDirectoryMutation = {
  kind: 'managed-root' | 'descendant'
  parentPath: string
  componentPath: string
}

/**
 * Test seam around the only path-based mutation in the Windows implementation.
 * Node exposes neither mkdirat nor a no-follow handle-relative Windows mkdir,
 * so production keeps this boundary deliberately narrow and validates the
 * complete trusted ancestry immediately before and after it.
 */
export type OpenCodeWindowsManagedDirectoryHooks = {
  beforeMutation?: (mutation: OpenCodeWindowsManagedDirectoryMutation) => void | Promise<void>
  afterMutation?: (mutation: OpenCodeWindowsManagedDirectoryMutation) => void | Promise<void>
}

function canonicalWindowsPath(value: string): string {
  return path.resolve(value)
    .replace(/^\\\\\?\\/, '')
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function captureDirectoryIdentity(directoryPath: string): Promise<DirectoryIdentity | null> {
  const metadata = await lstat(directoryPath, { bigint: true }).catch(error => {
    if (errnoCode(error) === 'ENOENT') return null
    throw error
  })
  if (!metadata) return null
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('OpenCode scoped managed path ancestry is not canonical [redacted]')
  }
  const canonical = await realpath(directoryPath).catch(error => {
    throw new Error('OpenCode scoped managed path ancestry is not canonical [redacted]', {
      cause: error,
    })
  })
  if (canonicalWindowsPath(canonical) !== canonicalWindowsPath(directoryPath)) {
    throw new Error('OpenCode scoped managed path ancestry is not canonical [redacted]')
  }
  const identity = { dev: metadata.dev, ino: metadata.ino }
  if (identity.dev === 0n && identity.ino === 0n) {
    throw new Error('OpenCode Windows managed path identity is ambiguous [redacted]')
  }
  return identity
}

async function assertIdentitiesUnchanged(
  expected: ReadonlyMap<string, DirectoryIdentity>,
): Promise<void> {
  for (const [directoryPath, identity] of expected) {
    const actual = await captureDirectoryIdentity(directoryPath)
    if (!actual || !sameIdentity(actual, identity)) {
      throw new Error('OpenCode scoped managed path ancestry changed during creation [redacted]')
    }
  }
}

/**
 * Establishes the app-owned managed root once, then creates runtime-generated
 * descendants one component at a time. Existing components must be canonical
 * non-reparse directories. Each mutation is surrounded by full ancestry
 * identity checks, and created empty components are rolled back when they are
 * still reachable through the unchanged trusted ancestry.
 *
 * This is intentionally the complete Windows platform boundary. Standard Node
 * cannot make the final mkdir handle-relative, so the checks do not claim an
 * atomic guarantee that the runtime cannot provide. A detected swap never
 * causes cleanup through the swapped path, which avoids mutating an external
 * reparse target.
 */
export async function ensureOpenCodeWindowsManagedDirectoryPath(
  resolved: string,
  ownershipBoundary: string,
  afterComponentOpened?: (componentPath: string) => void | Promise<void>,
  hooks: OpenCodeWindowsManagedDirectoryHooks = {},
  trustedRoot: string = path.dirname(ownershipBoundary),
  abortSignal?: AbortSignal,
): Promise<void> {
  const assertActive = () => {
    if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('OpenCode managed directory creation cancelled')
  }
  assertActive()
  resolved = path.resolve(resolved)
  ownershipBoundary = path.resolve(ownershipBoundary)
  trustedRoot = path.resolve(trustedRoot)
  const relative = path.relative(ownershipBoundary, resolved)
  if (relative !== '' && (
    relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  )) throw new Error('OpenCode scoped managed ownership boundary is invalid [redacted]')

  const boundaryFromTrustedRoot = path.relative(trustedRoot, ownershipBoundary)
  if (boundaryFromTrustedRoot !== '' && (
    boundaryFromTrustedRoot === '..' || boundaryFromTrustedRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(boundaryFromTrustedRoot)
  )) {
    throw new Error('OpenCode Windows trusted managed root is invalid [redacted]')
  }
  const trustedRootIdentity = await captureDirectoryIdentity(trustedRoot)
  if (!trustedRootIdentity) {
    throw new Error('OpenCode Windows managed trusted OS root must be pre-existing [redacted]')
  }

  const identities = new Map<string, DirectoryIdentity>([[trustedRoot, trustedRootIdentity]])
  const created: Array<{ path: string; identity: DirectoryIdentity; parents: Map<string, DirectoryIdentity> }> = []
  const rollback = async (): Promise<void> => {
    for (const entry of created.reverse()) {
      try {
        await assertIdentitiesUnchanged(entry.parents)
        const reachable = await captureDirectoryIdentity(entry.path)
        if (!reachable || !sameIdentity(reachable, entry.identity)) continue
        await rmdir(entry.path)
      } catch {
        // Never traverse or delete through ancestry whose identity changed.
        // The original empty directory may remain under a displaced trusted
        // root, but an external reparse target is left completely untouched.
      }
    }
  }

  try {
    let current = trustedRoot
    for (const component of boundaryFromTrustedRoot.split(path.sep).filter(Boolean)) {
      assertActive()
      const componentPath = path.join(current, component)
      let componentIdentity = await captureDirectoryIdentity(componentPath)
      if (!componentIdentity) {
        const mutation = { kind: 'managed-root' as const, parentPath: current, componentPath }
        await hooks.beforeMutation?.(mutation)
        assertActive()
        await assertIdentitiesUnchanged(identities)
        try { await mkdir(path.join(current, component), { mode: 0o700 }) } catch (error) {
          if (errnoCode(error) !== 'EEXIST') throw error
        }
        componentIdentity = await captureDirectoryIdentity(componentPath)
        if (!componentIdentity) {
          throw new Error('OpenCode Windows managed root changed during creation [redacted]')
        }
        created.push({ path: componentPath, identity: componentIdentity, parents: new Map(identities) })
        await hooks.afterMutation?.(mutation)
        assertActive()
        await assertIdentitiesUnchanged(identities)
      }
      identities.set(componentPath, componentIdentity)
      await afterComponentOpened?.(componentPath)
      current = componentPath
    }

    current = ownershipBoundary
    for (const component of relative.split(path.sep).filter(Boolean)) {
      assertActive()
      const componentPath = path.join(current, component)
      let componentIdentity = await captureDirectoryIdentity(componentPath)
      if (!componentIdentity) {
        const mutation = {
          kind: 'descendant' as const,
          parentPath: current,
          componentPath,
        }
        await hooks.beforeMutation?.(mutation)
        assertActive()
        await assertIdentitiesUnchanged(identities)
        try {
          await mkdir(path.join(current, component), { mode: 0o700 })
        } catch (error) {
          if (errnoCode(error) !== 'EEXIST') throw error
        }
        componentIdentity = await captureDirectoryIdentity(componentPath)
        if (!componentIdentity) {
          throw new Error('OpenCode Windows managed path changed during creation [redacted]')
        }
        created.push({ path: componentPath, identity: componentIdentity, parents: new Map(identities) })
        await hooks.afterMutation?.(mutation)
        assertActive()
        await assertIdentitiesUnchanged(identities)
      }
      identities.set(componentPath, componentIdentity)
      await afterComponentOpened?.(componentPath)
      current = componentPath
    }

    assertActive()
    await assertIdentitiesUnchanged(identities)
  } catch (error) {
    await rollback()
    throw error
  }
}
