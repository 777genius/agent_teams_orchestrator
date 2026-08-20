import { expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureOpenCodeWindowsManagedDirectoryPath } from './OpenCodeWindowsManagedDirectory.js'

test('Windows managed paths require pre-provisioned children and never create missing paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-windows-managed-missing-'))
  try {
    const boundary = path.join(root, 'trusted')
    await mkdir(boundary)
    await expect(ensureOpenCodeWindowsManagedDirectoryPath(
      path.join(boundary, 'profiles', 'attempt'), boundary,
    )).rejects.toThrow('pre-provisioned')
    expect(await lstat(path.join(boundary, 'profiles')).catch(() => null)).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows verification fails closed at an injected junction swap boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-windows-managed-swap-'))
  try {
    const boundary = path.join(root, 'trusted')
    const displaced = path.join(root, 'trusted-original')
    const outside = path.join(root, 'outside')
    const target = path.join(boundary, 'profiles', 'attempt')
    await Promise.all([
      mkdir(target, { recursive: true }),
      mkdir(path.join(outside, 'profiles', 'attempt'), { recursive: true }),
    ])
    let swapped = false
    await expect(ensureOpenCodeWindowsManagedDirectoryPath(target, boundary, async component => {
      if (swapped || component !== boundary) return
      swapped = true
      await rename(boundary, displaced)
      await symlink(outside, boundary, 'dir')
    })).rejects.toThrow(/canonical|changed/)
    await writeFile(path.join(displaced, 'profiles', 'attempt', 'owned'), 'inside')
    expect(await lstat(path.join(outside, 'profiles', 'attempt', 'owned')).catch(() => null)).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
