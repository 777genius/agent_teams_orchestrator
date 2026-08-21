import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { canonicalizeOpenCodeProjectIdentity } from './OpenCodeProjectIdentity.js'

const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

describe('canonical OpenCode project identity', () => {
  test('real paths and symlink aliases share one durable identity', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-identity-')); roots.push(root)
    const project = path.join(root, 'project'); const alias = path.join(root, 'alias')
    await mkdir(project); await symlink(project, alias)
    expect(await canonicalizeOpenCodeProjectIdentity(project))
      .toBe(await canonicalizeOpenCodeProjectIdentity(alias))
  })

  test('missing paths have an explicit normalized spelling policy and Windows folds case', async () => {
    const missing = path.join(os.tmpdir(), 'Missing-OpenCode-Project')
    expect(await canonicalizeOpenCodeProjectIdentity(missing, { platform: 'win32' }))
      .toBe(path.resolve(missing).toLowerCase())
  })
})
