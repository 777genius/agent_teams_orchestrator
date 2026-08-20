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

test('Windows fresh env-paths shape creates app container plus Data and Cache from LOCALAPPDATA', async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), 'opencode-windows-localappdata-'))
  try {
    const appRoot = path.join(localAppData, 'claude-multimodel-nodejs')
    const data = path.join(appRoot, 'Data')
    const cache = path.join(appRoot, 'Cache')
    await ensureOpenCodeWindowsManagedDirectoryPath(
      path.join(data, 'opencode', 'scoped-profiles'), data, undefined, {}, localAppData,
    )
    await ensureOpenCodeWindowsManagedDirectoryPath(
      path.join(cache, 'opencode', 'scoped'), cache, undefined, {}, localAppData,
    )
    expect((await lstat(path.join(data, 'opencode', 'scoped-profiles'))).isDirectory()).toBe(true)
    expect((await lstat(path.join(cache, 'opencode', 'scoped'))).isDirectory()).toBe(true)
  } finally {
    await rm(localAppData, { recursive: true, force: true })
  }
})

test.each(['container', 'data', 'component'] as const)(
  'Windows nested first-use rejects pre/post %s swap without external mutation',
  async swapKind => {
    for (const phase of ['beforeMutation', 'afterMutation'] as const) {
      const localAppData = await mkdtemp(path.join(os.tmpdir(), 'opencode-windows-nested-swap-'))
      const appRoot = path.join(localAppData, 'claude-multimodel-nodejs')
      const data = path.join(appRoot, 'Data')
      const target = path.join(data, 'opencode', 'profiles')
      const outside = path.join(localAppData, 'outside')
      const displaced = path.join(localAppData, 'displaced')
      await mkdir(outside)
      let swapped = false
      try {
        await expect(ensureOpenCodeWindowsManagedDirectoryPath(target, data, undefined, {
          [phase]: async mutation => {
            const basename = path.basename(mutation.componentPath)
            const wanted = phase === 'beforeMutation'
              ? swapKind === 'container' ? 'Data' : swapKind === 'data' ? 'opencode' : 'profiles'
              : swapKind === 'container' ? 'claude-multimodel-nodejs'
                : swapKind === 'data' ? 'Data' : 'opencode'
            if (swapped || basename !== wanted) return
            swapped = true
            const victim = phase === 'beforeMutation' ? mutation.parentPath : mutation.componentPath
            await rename(victim, displaced)
            await symlink(outside, victim, 'dir')
          },
        }, localAppData)).rejects.toThrow(/canonical|changed/)
        expect(await lstat(path.join(outside, 'profiles')).catch(() => null)).toBeNull()
      } finally {
        await rm(localAppData, { recursive: true, force: true })
      }
    }
  },
)

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
