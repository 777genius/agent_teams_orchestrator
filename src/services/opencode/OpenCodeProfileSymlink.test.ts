import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as lockfile from '../../utils/lockfile.js'
import { ensureDirectorySymlink } from './OpenCodeProfileManager.js'

let root: string
let source: string
let target: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-symlink-'))
  source = path.join(root, 'profile-node_modules')
  target = path.join(root, 'shared-node_modules')
  await fs.mkdir(source)
  await fs.mkdir(target)
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('3645 existing shared files need no copies; missing nested files are preserved', async () => {
  // Match the observed legacy directory size, without copying real user data.
  for (let batch = 0; batch < 37; batch += 1) {
    await Promise.all(Array.from({ length: Math.min(100, 3645 - batch * 100) }, async (_, i) => {
      const name = `${batch * 100 + i}.js`
      await fs.writeFile(path.join(source, name), 'profile')
      await fs.writeFile(path.join(target, name), 'shared')
    }))
  }
  const copy = spyOn(fs, 'copyFile')
  try {
    await ensureDirectorySymlink(source, target)
    expect(copy).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(target, '0.js'), 'utf8')).toBe('shared')
    expect(await fs.readlink(source)).toBe(target)
    await ensureDirectorySymlink(source, target)
    expect(copy).not.toHaveBeenCalled()
  } finally { copy.mockRestore() }
}, 30_000)

test('merges missing files and preserves file, directory and symlink conflicts', async () => {
  await fs.mkdir(path.join(source, 'nested'))
  await fs.mkdir(path.join(target, 'nested'))
  await fs.writeFile(path.join(source, 'nested', 'new'), 'new')
  await fs.mkdir(path.join(source, 'dir-conflict'))
  await fs.writeFile(path.join(target, 'dir-conflict'), 'shared-file')
  await fs.writeFile(path.join(source, 'link-conflict'), 'profile-file')
  await fs.symlink('dir-conflict', path.join(target, 'link-conflict'))
  await fs.symlink('nested', path.join(source, 'new-link'))
  await ensureDirectorySymlink(source, target)
  expect(await fs.readFile(path.join(target, 'nested', 'new'), 'utf8')).toBe('new')
  expect(await fs.readFile(path.join(target, 'dir-conflict'), 'utf8')).toBe('shared-file')
  expect(await fs.readlink(path.join(target, 'link-conflict'))).toBe('dir-conflict')
  expect(await fs.readlink(path.join(target, 'new-link'))).toBe('nested')
})

test('retries transient Windows lock contention without broadening POSIX lock errors', async () => {
  const lockPath = `${source}.prepare-lock`
  const realLock = lockfile.lock
  let calls = 0
  const lock = spyOn(lockfile, 'lock').mockImplementation(async (...args) => {
    calls += 1
    if (calls === 1) {
      const error = Object.assign(new Error('transient TEST contention'), {
        code: process.platform === 'win32' ? 'EPERM' : 'ELOCKED',
      })
      throw error
    }
    return realLock(...args)
  })
  try {
    await ensureDirectorySymlink(source, target)
    expect(calls).toBe(2)
    expect(await fs.readlink(source)).toBe(target)
  } finally {
    lock.mockRestore()
  }
})

for (const kind of ['symlink', 'migration'] as const) {
  test(`abort while waiting for ${kind} lock does not acquire later or remove source`, async () => {
    const lockPath = kind === 'symlink' ? `${source}.prepare-lock` : `${target}.migration-lock`
    await fs.writeFile(lockPath, '')
    const release = await lockfile.lock(lockPath, { realpath: false })
    const controller = new AbortController()
    const copy = spyOn(fs, 'copyFile')
    const timer = setTimeout(() => controller.abort(new Error('cancel migration')), 50)
    try {
      await expect(ensureDirectorySymlink(source, target, { abortSignal: controller.signal }))
        .rejects.toThrow('cancel migration')
      expect((await fs.lstat(source)).isDirectory()).toBe(true)
      expect(copy).not.toHaveBeenCalled()
    } finally {
      clearTimeout(timer)
      copy.mockRestore()
      await release()
    }
    // A canceled waiter must not come back and replace the source after release.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await fs.lstat(source)).isDirectory()).toBe(true)
    expect(await lockfile.check(lockPath, { realpath: false })).toBe(false)
  })
}

test('abort during traversal leaves source intact and does not begin another copy', async () => {
  await fs.writeFile(path.join(source, 'a'), 'a')
  await fs.writeFile(path.join(source, 'b'), 'b')
  const controller = new AbortController()
  const realCopy = fs.copyFile
  const copy = spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
    await realCopy(...args)
    controller.abort(new Error('cancel traversal'))
  })
  try {
    await expect(ensureDirectorySymlink(source, target, { abortSignal: controller.signal }))
      .rejects.toThrow('cancel traversal')
    expect(copy).toHaveBeenCalledTimes(1)
    expect((await fs.lstat(source)).isDirectory()).toBe(true)
    expect((await fs.readdir(target)).length).toBe(1)
  } finally { copy.mockRestore() }
})

test('abort immediately before replacement never removes the migrated source', async () => {
  await fs.writeFile(path.join(source, 'new'), 'new')
  const controller = new AbortController()
  await expect(ensureDirectorySymlink(source, target, {
    abortSignal: controller.signal,
    enterStep(label) {
      if (label === 'replace legacy node_modules directory') controller.abort(new Error('cancel replace'))
    },
  })).rejects.toThrow('cancel replace')
  expect((await fs.lstat(source)).isDirectory()).toBe(true)
  expect(await fs.readFile(path.join(target, 'new'), 'utf8')).toBe('new')
})

test('abort during removal restores the symlink before reporting cancellation', async () => {
  await fs.writeFile(path.join(source, 'new'), 'new')
  const controller = new AbortController()
  const realRemove = fs.rm
  const remove = spyOn(fs, 'rm').mockImplementation(async (...args) => {
    await realRemove(...args)
    if (args[0] === source) controller.abort(new Error('cancel during removal'))
  })
  try {
    await expect(ensureDirectorySymlink(source, target, { abortSignal: controller.signal }))
      .rejects.toThrow('cancel during removal')
    expect(await fs.readlink(source)).toBe(target)
    expect(await fs.readFile(path.join(source, 'new'), 'utf8')).toBe('new')
  } finally { remove.mockRestore() }
})

for (const kind of ['file', 'dangling directory link'] as const) {
  test(`preserves a ${kind} that wins the race while merging a missing directory`, async () => {
    await fs.mkdir(path.join(source, 'nested'))
    await fs.writeFile(path.join(source, 'nested', 'new'), 'profile')
    const conflictPath = path.join(target, 'nested')
    const linkTarget = path.join(root, 'deleted-directory')
    if (kind === 'dangling directory link') await fs.mkdir(linkTarget)
    const realMkdir = fs.mkdir
    let raced = false
    const create = spyOn(fs, 'mkdir').mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
      if (String(args[0]) === conflictPath && !raced) {
        raced = true
        if (kind === 'file') {
          await fs.writeFile(conflictPath, 'shared-race-winner')
        } else {
          await fs.symlink(linkTarget, conflictPath, process.platform === 'win32' ? 'junction' : 'dir')
          await fs.rmdir(linkTarget)
        }
      }
      return realMkdir(...args)
    }) as typeof fs.mkdir)
    try {
      await ensureDirectorySymlink(source, target)
      expect(raced).toBe(true)
      if (kind === 'file') {
        expect(await fs.readFile(conflictPath, 'utf8')).toBe('shared-race-winner')
      } else {
        expect((await fs.lstat(conflictPath)).isSymbolicLink()).toBe(true)
        await expect(fs.stat(conflictPath)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(await fs.readlink(source)).toBe(target)
    } finally {
      create.mockRestore()
    }
  })
}
