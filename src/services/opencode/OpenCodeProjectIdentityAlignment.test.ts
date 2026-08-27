import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  canonicalizeOpenCodeProjectIdentity,
  openCodeProjectIdentityKey,
} from './OpenCodeProjectIdentity.js'

describe('OpenCode managed profile and preference identity alignment', () => {
  test('POSIX symlink aliases derive the same profile/preference key and real projects do not collide', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-key-'))
    try {
      const first = path.join(root, 'first')
      const second = path.join(root, 'second')
      const alias = path.join(root, 'alias')
      await mkdir(first); await mkdir(second); await symlink(first, alias)
      const firstKey = openCodeProjectIdentityKey(await canonicalizeOpenCodeProjectIdentity(first))
      const aliasKey = openCodeProjectIdentityKey(await canonicalizeOpenCodeProjectIdentity(alias))
      const secondKey = openCodeProjectIdentityKey(await canonicalizeOpenCodeProjectIdentity(second))
      expect(aliasKey).toBe(firstKey)
      expect(secondKey).not.toBe(firstKey)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('missing aliased projects derive the same shared profile/cache/preference key before creation', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-missing-key-'))
    try {
      const real = path.join(root, 'real')
      const alias = path.join(root, 'alias')
      await mkdir(real); await symlink(real, alias)
      const canonical = path.join(real, 'nested', 'project')
      const aliased = path.join(alias, 'nested', 'project')
      const canonicalIdentity = await canonicalizeOpenCodeProjectIdentity(canonical, { allowMissing: true })
      const aliasIdentity = await canonicalizeOpenCodeProjectIdentity(aliased, { allowMissing: true })
      expect(aliasIdentity).toBe(canonicalIdentity)
      expect(openCodeProjectIdentityKey(aliasIdentity)).toBe(openCodeProjectIdentityKey(canonicalIdentity))
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('Windows case variants share a key through deterministic filesystem evidence', async () => {
    const stat = { dev: 9, ino: 17, isDirectory: () => true }
    const canonicalize = (value: string) => canonicalizeOpenCodeProjectIdentity(value, {
      platform: 'win32',
      filesystem: { realpath: async () => value, lstat: async () => stat },
    })
    const upper = await canonicalize('C:\\Work\\Project')
    const lower = await canonicalize('c:\\work\\project')
    expect(upper).toBe(lower)
    expect(openCodeProjectIdentityKey(upper)).toBe(openCodeProjectIdentityKey(lower))
  })

  test('profile preparation and preference actions consume the shared canonical key contract', async () => {
    const [manager, adapter] = await Promise.all([
      readFile('src/services/opencode/OpenCodeProfileManager.ts', 'utf8'),
      readFile('src/features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.ts', 'utf8'),
    ])
    expect(manager).toContain('await canonicalizeOpenCodeProjectIdentity(')
    expect(manager).toContain('return openCodeProjectIdentityKey(projectPath)')
    expect(adapter).toContain('openCodeProjectIdentityKey(canonicalProjectIdentity)')
    expect(adapter).toContain('await (this.deps.managedPreferences?.canonicalizeProjectIdentity')
    expect(adapter).toContain('(projectPath, { allowMissing: true })')
    expect(adapter).toContain('return preferences.resolveProjectRoot(canonical)')
  })
})
