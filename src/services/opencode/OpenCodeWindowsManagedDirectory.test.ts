import { expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureOpenCodeWindowsManagedDirectoryPath } from './OpenCodeWindowsManagedDirectory.js'

test('Windows first use establishes the managed root and dynamic descendants', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-windows-managed-first-use-'))
  try {
    const boundary = path.join(root, 'app-data')
    const target = path.join(boundary, 'opencode', 'scoped', 'attempt', 'cache')
    const mutations: string[] = []
    await ensureOpenCodeWindowsManagedDirectoryPath(target, boundary, undefined, {
      beforeMutation: mutation => mutations.push(`before:${mutation.kind}:${path.basename(mutation.componentPath)}`),
      afterMutation: mutation => mutations.push(`after:${mutation.kind}:${path.basename(mutation.componentPath)}`),
    })
    expect((await lstat(target)).isDirectory()).toBe(true)
    expect(mutations).toEqual([
      'before:managed-root:app-data', 'after:managed-root:app-data',
      'before:descendant:opencode', 'after:descendant:opencode',
      'before:descendant:scoped', 'after:descendant:scoped',
      'before:descendant:attempt', 'after:descendant:attempt',
      'before:descendant:cache', 'after:descendant:cache',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows pre-mutation hook swap is rejected without external mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-windows-managed-pre-swap-'))
  try {
    const boundary = path.join(root, 'trusted')
    const displaced = path.join(root, 'trusted-original')
    const outside = path.join(root, 'outside')
    const target = path.join(boundary, 'profiles', 'attempt')
    await Promise.all([mkdir(boundary), mkdir(outside)])
    let swapped = false
    await expect(ensureOpenCodeWindowsManagedDirectoryPath(target, boundary, undefined, {
      beforeMutation: async mutation => {
        if (swapped || path.basename(mutation.componentPath) !== 'profiles') return
        swapped = true
        await rename(boundary, displaced)
        await symlink(outside, boundary, 'dir')
      },
    })).rejects.toThrow(/canonical|changed/)
    expect(await lstat(path.join(outside, 'profiles')).catch(() => null)).toBeNull()
    expect(await lstat(path.join(displaced, 'profiles')).catch(() => null)).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows post-mutation hook swap is rejected and never cleans through external target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-windows-managed-post-swap-'))
  try {
    const boundary = path.join(root, 'trusted')
    const displaced = path.join(root, 'trusted-original')
    const outside = path.join(root, 'outside')
    const target = path.join(boundary, 'profiles', 'attempt')
    await Promise.all([mkdir(boundary), mkdir(outside)])
    await writeFile(path.join(outside, 'sentinel'), 'preserve')
    let swapped = false
    await expect(ensureOpenCodeWindowsManagedDirectoryPath(target, boundary, undefined, {
      afterMutation: async mutation => {
        if (swapped || path.basename(mutation.componentPath) !== 'profiles') return
        swapped = true
        await rename(boundary, displaced)
        await symlink(outside, boundary, 'dir')
      },
    })).rejects.toThrow(/canonical|changed/)
    expect(await lstat(path.join(outside, 'profiles')).catch(() => null)).toBeNull()
    expect(await lstat(path.join(outside, 'sentinel')).then(() => true)).toBe(true)
    // Creation happened under the trusted tree before the injected swap. It is
    // deliberately not removed through the now-ambiguous reachable path.
    expect((await lstat(path.join(displaced, 'profiles'))).isDirectory()).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows later failure rolls back reachable components created in this attempt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-windows-managed-rollback-'))
  try {
    const boundary = path.join(root, 'trusted')
    const target = path.join(boundary, 'profiles', 'attempt')
    await mkdir(boundary)
    await expect(ensureOpenCodeWindowsManagedDirectoryPath(target, boundary, undefined, {
      afterMutation: mutation => {
        if (path.basename(mutation.componentPath) === 'attempt') throw new Error('injected failure')
      },
    })).rejects.toThrow('injected failure')
    expect(await lstat(path.join(boundary, 'profiles')).catch(() => null)).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
