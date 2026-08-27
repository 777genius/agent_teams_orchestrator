import { afterAll, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  canonicalizeOpenCodeProjectIdentity,
  openCodeProjectIdentityKey,
} from './OpenCodeProjectIdentity.js'

const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

describe('canonical OpenCode project identity', () => {
  test('real paths and symlink aliases share one durable identity', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-identity-')); roots.push(root)
    const project = path.join(root, 'project'); const alias = path.join(root, 'alias')
    await mkdir(project); await symlink(project, alias)
    const projectIdentity = await canonicalizeOpenCodeProjectIdentity(project)
    const aliasIdentity = await canonicalizeOpenCodeProjectIdentity(alias)
    expect(projectIdentity).toBe(aliasIdentity)
    expect(openCodeProjectIdentityKey(projectIdentity)).toBe(openCodeProjectIdentityKey(aliasIdentity))
  })

  test('different real projects remain distinct and Windows folds canonical case', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-distinct-')); roots.push(root)
    const first = path.join(root, 'First'); const second = path.join(root, 'Second')
    await mkdir(first); await mkdir(second)
    expect(await canonicalizeOpenCodeProjectIdentity(first))
      .not.toBe(await canonicalizeOpenCodeProjectIdentity(second))
    expect(openCodeProjectIdentityKey(await canonicalizeOpenCodeProjectIdentity(first)))
      .not.toBe(openCodeProjectIdentityKey(await canonicalizeOpenCodeProjectIdentity(second)))
    expect(await canonicalizeOpenCodeProjectIdentity(first, { platform: 'win32' }))
      .toBe(path.resolve(first).toLowerCase())
  })

  test('Windows case-only realpath observations retain one stable identity', async () => {
    let reads = 0
    const stat = { dev: 7, ino: 11, isDirectory: () => true }
    const canonical = await canonicalizeOpenCodeProjectIdentity('C:\\Project', {
      platform: 'win32',
      filesystem: {
        realpath: async () => reads++ === 0 ? 'C:\\Project' : 'c:\\project',
        lstat: async () => stat,
      },
    })
    expect(canonical).toBe('c:\\project')
    expect(openCodeProjectIdentityKey(canonical))
      .toBe(openCodeProjectIdentityKey('c:\\project'))
  })

  test('missing, deleted, and broken symlink inputs fail conservatively', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-missing-')); roots.push(root)
    const deleted = path.join(root, 'deleted'); const alias = path.join(root, 'alias')
    await mkdir(deleted); await rm(deleted, { recursive: true }); await symlink(deleted, alias)
    await expect(canonicalizeOpenCodeProjectIdentity(deleted)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(canonicalizeOpenCodeProjectIdentity(alias)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('missing children under a symlink retain the canonical ancestor identity', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-missing-alias-')); roots.push(root)
    const real = path.join(root, 'real'); const alias = path.join(root, 'alias')
    await mkdir(real); await symlink(real, alias)
    const aliasChild = path.join(alias, 'new-project')
    const realChild = path.join(real, 'new-project')
    const missingIdentity = await canonicalizeOpenCodeProjectIdentity(aliasChild, { allowMissing: true })
    expect(missingIdentity).toBe(
      await canonicalizeOpenCodeProjectIdentity(realChild, { allowMissing: true }),
    )
    await mkdir(realChild)
    expect(await canonicalizeOpenCodeProjectIdentity(aliasChild)).toBe(missingIdentity)
  })

  test('appends the complete nested missing suffix to the nearest canonical ancestor', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-nested-missing-')); roots.push(root)
    const real = path.join(root, 'real'); const alias = path.join(root, 'alias')
    await mkdir(real); await symlink(real, alias)
    expect(await canonicalizeOpenCodeProjectIdentity(path.join(alias, 'one', 'two', 'project'), {
      allowMissing: true,
    })).toBe(path.join(real, 'one', 'two', 'project'))
  })

  test('Windows missing suffix canonicalizes its nearest alias ancestor and folds case', async () => {
    const missing = (message: string) => Object.assign(new Error(message), { code: 'ENOENT' })
    const stat = { dev: 5, ino: 8, isDirectory: () => true }
    const realpathCalls: string[] = []
    const identity = await canonicalizeOpenCodeProjectIdentity('C:\\Alias\\One\\Two', {
      platform: 'win32',
      allowMissing: true,
      filesystem: {
        realpath: async value => {
          realpathCalls.push(value)
          if (value.toLowerCase() === 'c:\\alias') return 'D:\\Real'
          throw missing('missing')
        },
        lstat: async value => {
          if (value.toLowerCase() === 'd:\\real') return stat
          throw missing('missing')
        },
      },
    })
    expect(identity).toBe('d:\\real\\one\\two')
    expect(realpathCalls).toContain('C:\\Alias')
  })

  test('a symlink retarget during canonicalization fails closed', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-race-')); roots.push(root)
    const first = path.join(root, 'first'); const second = path.join(root, 'second')
    const alias = path.join(root, 'alias')
    await mkdir(first); await mkdir(second); await symlink(first, alias)
    let observations = 0
    await expect(canonicalizeOpenCodeProjectIdentity(alias, { filesystem: {
      realpath,
      lstat: async value => {
        const observed = await lstat(value)
        if (++observations === 1) {
          await rm(alias); await symlink(second, alias)
        }
        return observed
      },
    } })).rejects.toThrow('changed during canonicalization')
  })

  test('pre-cancelled canonicalization stays bounded and preserves the abort reason', async () => {
    const controller = new AbortController()
    const reason = new Error('outer deadline')
    controller.abort(reason)
    await expect(canonicalizeOpenCodeProjectIdentity('/never-inspected', { signal: controller.signal }))
      .rejects.toBe(reason)
  })
})
