import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { OpenCodeSafePublicationDirectory } from './OpenCodeSafePublication.js'

describe('OpenCodeSafePublication', () => {
  test('a coordinated parent swap creates zero files in the attacker directory', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-safe-publication-'))
    const owned = path.join(root, 'owned')
    const displaced = path.join(root, 'displaced')
    const outside = path.join(root, 'outside')
    await Promise.all([mkdir(owned), mkdir(outside)])
    const directory = await OpenCodeSafePublicationDirectory.open(owned)
    try {
      await rename(owned, displaced)
      await symlink(outside, owned, 'dir')
      await directory.writeFileAtomic('registry.json', '{"safe":true}', 0o600)
      expect(await readdir(outside)).toEqual([])
      expect(await readFile(path.join(displaced, 'registry.json'), 'utf8')).toBe('{"safe":true}')
    } finally {
      await directory.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a coordinated parent swap cannot redirect a bounded regular-file read', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-safe-read-swap-'))
    const owned = path.join(root, 'owned')
    const displaced = path.join(root, 'displaced')
    const outside = path.join(root, 'outside')
    await Promise.all([mkdir(owned), mkdir(outside)])
    await writeFile(path.join(owned, 'snapshot.json'), 'trusted')
    await writeFile(path.join(outside, 'snapshot.json'), 'attacker')
    const directory = await OpenCodeSafePublicationDirectory.open(owned)
    try {
      const value = await directory.readBoundedRegularFile(
        'snapshot.json', 64, undefined, { afterPathIdentityCaptured: async () => {
          await rename(owned, displaced)
          await symlink(outside, owned, 'dir')
        } },
      )
      expect(value).toBe('trusted')
      expect(await readFile(path.join(outside, 'snapshot.json'), 'utf8')).toBe('attacker')
    } finally {
      await directory.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('immutable publication accepts identical bytes and rejects collisions', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-safe-immutable-'))
    const directory = await OpenCodeSafePublicationDirectory.open(root)
    try {
      await directory.publishImmutableFile('bridge', 'one', 0o500)
      await directory.publishImmutableFile('bridge', 'one', 0o500)
      await expect(directory.publishImmutableFile('bridge', 'two', 0o500)).rejects.toThrow(
        'safe publication primitive is unavailable',
      )
    } finally {
      await directory.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('failed immutable publication exposes no incomplete final inode and retry recovers', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-safe-immutable-retry-'))
    const directory = await OpenCodeSafePublicationDirectory.open(root)
    try {
      await expect(directory.publishImmutableFile('bridge', 'complete', 0o500, {
        afterTemporaryWrite: () => { throw new Error('injected publication failure') },
      })).rejects.toThrow('injected publication failure')
      expect(await readdir(root)).toEqual([])
      await directory.publishImmutableFile('bridge', 'complete', 0o500)
      expect(await readFile(path.join(root, 'bridge'), 'utf8')).toBe('complete')
    } finally {
      await directory.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('immutable publication observes the exact attempt abort before its final link', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-safe-immutable-abort-'))
    const directory = await OpenCodeSafePublicationDirectory.open(root)
    const controller = new AbortController()
    const reason = new Error('catalog profile attempt expired')
    try {
      await expect(directory.publishImmutableFile('native-bridge', 'complete', 0o500, {
        afterTemporaryWrite: () => controller.abort(reason),
      }, controller.signal)).rejects.toBe(reason)
      expect(await readdir(root)).toEqual([])
    } finally {
      await directory.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('atomic publication cancellation preserves the complete old file and removes its temp', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-safe-atomic-cancel-'))
    const directory = await OpenCodeSafePublicationDirectory.open(root)
    try {
      await directory.writeFileAtomic('auth.json', '{"generation":"old"}', 0o600)
      const cancellation = new AbortController()
      cancellation.abort(new Error('cancelled before publication'))
      await expect(directory.writeFileAtomic(
        'auth.json', '{"generation":"new"}', 0o600, cancellation.signal,
      )).rejects.toThrow('cancelled before publication')
      expect(await readFile(path.join(root, 'auth.json'), 'utf8')).toBe('{"generation":"old"}')
      expect((await stat(path.join(root, 'auth.json'))).mode & 0o777).toBe(0o600)
      expect((await readdir(root)).filter(name => name.includes('.tmp.'))).toEqual([])
    } finally {
      await directory.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('abort immediately after visibility restores only the attempt-owned prior artifact', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-safe-atomic-visible-abort-'))
    const directory = await OpenCodeSafePublicationDirectory.open(root)
    try {
      await directory.writeFileAtomic('auth.json', '{"generation":"old"}', 0o600)
      const cancellation = new AbortController()
      await expect(directory.writeFileAtomic(
        'auth.json', '{"generation":"aborted"}', 0o600, cancellation.signal,
        { afterRenameBeforeVerification: () => cancellation.abort(new Error('visibility abort')) },
      )).rejects.toThrow('visibility abort')
      expect(await readFile(path.join(root, 'auth.json'), 'utf8')).toBe('{"generation":"old"}')
      expect((await readdir(root)).filter(name => name.includes('.tmp.') || name.includes('.rollback.')))
        .toEqual([])
    } finally {
      await directory.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('an aborted visible attempt never rolls back over a successor-owned inode', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-safe-atomic-successor-'))
    const directory = await OpenCodeSafePublicationDirectory.open(root)
    try {
      await directory.writeFileAtomic('auth.json', '{"generation":"old"}', 0o600)
      const cancellation = new AbortController()
      await expect(directory.writeFileAtomic(
        'auth.json', '{"generation":"aborted"}', 0o600, cancellation.signal,
        { afterRenameBeforeVerification: async () => {
          await directory.writeFileAtomic('auth.json', '{"generation":"successor"}', 0o600)
          cancellation.abort(new Error('visibility abort'))
        } },
      )).rejects.toThrow('visibility abort')
      expect(await readFile(path.join(root, 'auth.json'), 'utf8')).toBe('{"generation":"successor"}')
      expect((await readdir(root)).filter(name => name.includes('.tmp.') || name.includes('.rollback.')))
        .toEqual([])
    } finally {
      await directory.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rollback ownership capture cannot rename prior auth over successor B', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-safe-atomic-owned-rollback-'))
    const directory = await OpenCodeSafePublicationDirectory.open(root)
    try {
      await directory.writeFileAtomic('auth.json', '{"generation":"old"}', 0o600)
      const cancellation = new AbortController()
      await expect(directory.writeFileAtomic(
        'auth.json', '{"generation":"attempt-a"}', 0o600, cancellation.signal,
        {
          afterRenameBeforeVerification: () => cancellation.abort(new Error('abort A')),
          afterRollbackOwnershipCaptured: () => directory.writeFileAtomic(
            'auth.json', '{"generation":"successor-b"}', 0o600,
          ),
        },
      )).rejects.toThrow('abort A')
      expect(await readFile(path.join(root, 'auth.json'), 'utf8')).toBe('{"generation":"successor-b"}')
      expect((await readdir(root)).filter(name => name.includes('.rollback.')
        || name.includes('.quarantine.') || name.includes('.tmp.'))).toEqual([])
    } finally {
      await directory.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('concurrent readers observe only complete old or new atomic auth bytes', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(process.cwd(), '.opencode-safe-atomic-reader-'))
    const directory = await OpenCodeSafePublicationDirectory.open(root)
    const authPath = path.join(root, 'auth.json')
    const oldBytes = JSON.stringify({ generation: 'old', padding: 'a'.repeat(128 * 1024) })
    const newBytes = JSON.stringify({ generation: 'new', padding: 'b'.repeat(128 * 1024) })
    try {
      await directory.writeFileAtomic('auth.json', oldBytes, 0o600)
      const observations: string[] = []
      const publication = directory.writeFileAtomic('auth.json', newBytes, 0o600)
      for (let index = 0; index < 64; index += 1) {
        observations.push(await readFile(authPath, 'utf8'))
      }
      await publication
      observations.push(await readFile(authPath, 'utf8'))
      expect(observations.every(value => value === oldBytes || value === newBytes)).toBe(true)
      expect(observations.at(-1)).toBe(newBytes)
    } finally {
      await directory.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
