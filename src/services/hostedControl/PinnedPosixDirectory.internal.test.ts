import { afterEach, describe, expect, test } from 'bun:test'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PinnedPosixDirectory } from './PinnedPosixDirectory.internal.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('PinnedPosixDirectory', () => {
  test('revokes a retained namespace after its linked pathname is replaced', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pinned-posix-parent-')); roots.push(parent)
    const directoryPath = join(parent, 'durable'); const displaced = join(parent, 'displaced')
    await mkdir(directoryPath, { mode: 0o700 })
    const pinned = await PinnedPosixDirectory.open(directoryPath)
    try {
      await rename(directoryPath, displaced)
      await mkdir(directoryPath, { mode: 0o700 })
      expect(() => pinned.assertLinked()).toThrow('replaced')
    } finally { await pinned.close() }
  })

  test('never follows a substituted child symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pinned-posix-child-')); roots.push(root)
    const target = join(root, 'target'); await writeFile(target, 'secret', { mode: 0o600 })
    await symlink(target, join(root, 'child'))
    const pinned = await PinnedPosixDirectory.open(root)
    try {
      expect(() => pinned.openChild('child', constants.O_RDONLY)).toThrow('open failed')
    } finally { await pinned.close() }
  })
})
