import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes,
  writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { cleanupOpenCodeCatalogProfile, janitorOpenCodeCatalogProfiles,
  writeOpenCodeCatalogProfileManifest } from './OpenCodeCatalogProfileJanitor.js'
import { ensureOpenCodeManagedDirectoryPath } from './OpenCodeProfileManager.js'

const roots: string[] = []
setDefaultTimeout(20_000)
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

describe('catalog profile janitor', () => {
  test('restart scanning is bounded and refuses malformed links/identity replacements', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'catalog-profiles-')); roots.push(parent)
    const valid = path.join(parent, 'scope-catalog-valid'); await mkdir(valid)
    await writeOpenCodeCatalogProfileManifest({ profileRootPath: valid,
      runtimeInstanceId: 'catalog-test', profileRootKey: path.basename(valid), createdAt: 1,
      ownerPid: 999_999, processBirthId: '11111111-1111-1111-1111-111111111111' })
    const malformed = path.join(parent, 'scope-catalog-malformed'); await mkdir(malformed)
    await writeFile(path.join(malformed, '.catalog-attempt.json'), '{bad')
    if (process.platform !== 'win32') await symlink(valid, path.join(parent, 'scope-catalog-link'))
    expect(await janitorOpenCodeCatalogProfiles(parent)).toBe(1)
    expect((await cleanupOpenCodeCatalogProfile(malformed)).disposition).toBe('rejected')
  })

  test('authority generation preserves live/newer profiles and removes only older attempts', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'catalog-profile-generations-')); roots.push(parent)
    const profile = async (name: string, generation: number) => {
      const root = path.join(parent, name); await mkdir(root)
      await writeOpenCodeCatalogProfileManifest({ profileRootPath: root,
        runtimeInstanceId: `catalog-g${generation}-${name}`, profileRootKey: name, createdAt: generation,
        ownerPid: 999_999, processBirthId: '22222222-2222-2222-2222-222222222222' })
      return root
    }
    const old = await profile('scope-catalog-old', 1)
    const live = await profile('scope-catalog-live', 3)
    const newer = await profile('scope-catalog-newer', 4)
    expect(await janitorOpenCodeCatalogProfiles(parent, 3)).toBe(1)
    await expect(lstat(old)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(live)).isDirectory()).toBe(true)
    expect((await lstat(newer)).isDirectory()).toBe(true)
  })

  test('trash removal is capped at 32 and ordered oldest first', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'catalog-profile-trash-')); roots.push(parent)
    for (let index = 0; index < 40; index += 1) {
      const target = path.join(parent, `.catalog-trash-${index.toString().padStart(2, '0')}`)
      await mkdir(target); await utimes(target, index + 1, index + 1)
    }
    expect(await janitorOpenCodeCatalogProfiles(parent)).toBe(32)
    expect((await readdir(parent)).sort()).toEqual(Array.from({ length: 8 }, (_, offset) =>
      `.catalog-trash-${(offset + 32).toString().padStart(2, '0')}`))
  })

  test('manifest links and identity replacement are rejected', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'catalog-profile-identity-')); roots.push(parent)
    const profile = path.join(parent, 'scope-catalog-identity'); await mkdir(profile)
    const replacement = path.join(parent, 'replacement.json')
    await writeFile(replacement, JSON.stringify({ schema: 'opencode-catalog-attempt-profile-v1',
      createdAt: 1, runtimeInstanceId: 'catalog-g1-link', profileRootKey: path.basename(profile) }))
    if (process.platform !== 'win32') {
      await symlink(replacement, path.join(profile, '.catalog-attempt.json'))
      expect((await cleanupOpenCodeCatalogProfile(profile)).disposition).toBe('rejected')
      await rm(path.join(profile, '.catalog-attempt.json'))
    }
    await writeOpenCodeCatalogProfileManifest({ profileRootPath: profile,
      runtimeInstanceId: 'catalog-g1-original', profileRootKey: path.basename(profile), createdAt: 1 })
    await expect(writeOpenCodeCatalogProfileManifest({ profileRootPath: profile,
      runtimeInstanceId: 'catalog-g2-replacement', profileRootKey: path.basename(profile), createdAt: 2 }))
      .rejects.toThrow('identity replacement')
  })

  test('publishes preparing then ready atomically and keeps one lease identity', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'catalog-profile-state-')); roots.push(parent)
    const profile = path.join(parent, 'scope-catalog-state'); await mkdir(profile)
    const input = { profileRootPath: profile, runtimeInstanceId: 'catalog-g1-state',
      profileRootKey: path.basename(profile) }
    await writeOpenCodeCatalogProfileManifest({ ...input, state: 'preparing' })
    const preparing = JSON.parse(await readFile(path.join(profile, '.catalog-attempt.json'), 'utf8'))
    expect(preparing.state).toBe('preparing')
    await writeOpenCodeCatalogProfileManifest({ ...input, state: 'ready' })
    const ready = JSON.parse(await readFile(path.join(profile, '.catalog-attempt.json'), 'utf8'))
    expect(ready.state).toBe('ready'); expect(ready.leaseId).toBe(preparing.leaseId)
    expect((await readdir(profile)).filter(name => name.endsWith('.tmp'))).toEqual([])
    const incompleteKey = 'scope-catalog-incomplete'
    const incomplete = path.join(parent, incompleteKey); await mkdir(incomplete)
    expect((await cleanupOpenCodeCatalogProfile(incomplete)).disposition).toBe('rejected')
    expect((await cleanupOpenCodeCatalogProfile(incomplete, incompleteKey)).disposition).toBe('removed')
    await expect(lstat(incomplete)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('newer B cannot collect live A, while crashed A is collectible after lease expiry', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'catalog-profile-live-')); roots.push(parent)
    const now = Date.now()
    const a = path.join(parent, 'scope-catalog-a'); await mkdir(a)
    const aInput = { profileRootPath: a, runtimeInstanceId: 'catalog-g1-a',
      profileRootKey: path.basename(a) }
    await writeOpenCodeCatalogProfileManifest({ ...aInput, state: 'ready', createdAt: now,
      heartbeatAt: now, leaseExpiresAt: now + 60_000 })
    expect(await janitorOpenCodeCatalogProfiles(parent, 2)).toBe(0)
    expect((await lstat(a)).isDirectory()).toBe(true)
    const crashed = path.join(parent, 'scope-catalog-crashed'); await mkdir(crashed)
    await writeOpenCodeCatalogProfileManifest({ profileRootPath: crashed,
      runtimeInstanceId: 'catalog-g1-crashed', profileRootKey: path.basename(crashed),
      state: 'preparing', createdAt: now, heartbeatAt: now, leaseExpiresAt: now,
      ownerPid: 999_999, processBirthId: '11111111-1111-1111-1111-111111111111' })
    expect(await janitorOpenCodeCatalogProfiles(parent, 2)).toBe(1)
    expect((await lstat(a)).isDirectory()).toBe(true)
    await expect(lstat(crashed)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('restart janitor safely collects an aged manifestless mkdir preparation root', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'catalog-janitor-mkdir-')); roots.push(parent)
    const abandoned = path.join(parent, `${'a'.repeat(64)}-catalog-${'b'.repeat(64)}`)
    await mkdir(abandoned)
    const old = new Date(Date.now() - 121_000); await utimes(abandoned, old, old)
    expect(await janitorOpenCodeCatalogProfiles(parent, 9)).toBe(1)
    await expect(lstat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('mkdir ownership is established before a manifest-stage abort and cleanup removes the root', async () => {
    if (process.platform === 'win32') return
    const parent = await mkdtemp(path.join(os.tmpdir(), 'catalog-janitor-abort-')); roots.push(parent)
    const key = `${'c'.repeat(64)}-catalog-${'d'.repeat(64)}`; const target = path.join(parent, key)
    let cleanupOwned = false
    await expect(ensureOpenCodeManagedDirectoryPath(target, parent, undefined, process.platform,
      undefined, undefined, component => {
        if (component === target) { cleanupOwned = true; throw new Error('manifest-stage abort') }
      })).rejects.toThrow('manifest-stage abort')
    expect(cleanupOwned).toBe(true)
    expect((await cleanupOpenCodeCatalogProfile(target, key)).disposition).toBe('removed')
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
