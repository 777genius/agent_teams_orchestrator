import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertControlCleanupAuthority, atomicPrivateJson, EvidenceRefreshFence, readAnchoredFile,
} from './secure-files.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'actual-owner-secure-'))
  temporaryRoots.push(root)
  await chmod(root, 0o700)
  return root
}

async function renameExchange(root: string, left: string, right: string): Promise<void> {
  const source = join(root, 'rename-exchange.c')
  const executable = join(root, 'rename-exchange')
  await writeFile(source, [
    '#define _GNU_SOURCE',
    '#include <fcntl.h>',
    '#include <stdio.h>',
    'int main(int argc, char **argv) {',
    '  if (argc != 3) return 2;',
    '  if (renameat2(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_EXCHANGE) != 0) {',
    '    perror("renameat2"); return 1;',
    '  }',
    '  return 0;',
    '}',
    '',
  ].join('\n'), { mode: 0o600 })
  const compile = spawnSync('/usr/bin/cc', [source, '-o', executable], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  })
  if (compile.status !== 0) throw new Error(`rename-exchange compile failed: ${compile.stderr}`)
  const exchange = spawnSync(executable, [left, right], { encoding: 'utf8' })
  if (exchange.status !== 0) throw new Error(`rename-exchange failed: ${exchange.stderr}`)
}

async function compileSocketCreator(root: string): Promise<string> {
  const source = join(root, 'create-socket.c')
  const executable = join(root, 'create-socket')
  await writeFile(source, [
    '#define _GNU_SOURCE',
    '#include <sys/stat.h>',
    'int main(int argc, char **argv) {',
    '  if (argc != 2) return 2;',
    '  return mknod(argv[1], S_IFSOCK | S_IRUSR | S_IWUSR, 0) == 0 ? 0 : 3;',
    '}',
    '',
  ].join('\n'), { mode: 0o600 })
  const compile = spawnSync('/usr/bin/cc', [
    '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', executable,
  ], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  if (compile.status !== 0) throw new Error(`socket creator compile failed: ${compile.stderr}`)
  return executable
}

describe('hosted actual-owner descriptor fences', () => {
  test('serializes refresh generations so an older publisher cannot follow a newer one', async () => {
    const fence = new EvidenceRefreshFence()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve })
    let firstStarted!: () => void
    const firstEntered = new Promise<void>(resolve => { firstStarted = resolve })
    const first = fence.run(async generation => {
      fence.assertActive(generation)
      events.push(`start:${generation}`)
      firstStarted()
      await firstBlocked
      fence.assertActive(generation)
      events.push(`publish:${generation}`)
    })
    await firstEntered
    const second = fence.run(async generation => {
      fence.assertActive(generation)
      events.push(`start:${generation}`)
      events.push(`publish:${generation}`)
    })
    await Promise.resolve()
    expect(events).toEqual(['start:1'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['start:1', 'publish:1', 'start:2', 'publish:2'])
  })

  test('advances the refresh fence after failure without accepting stale generations', async () => {
    const fence = new EvidenceRefreshFence()
    await expect(fence.run(async generation => {
      fence.assertActive(generation)
      throw new Error('rejected')
    })).rejects.toThrow(/rejected/)
    await expect(fence.run(async generation => {
      expect(generation).toBe(2)
      fence.assertActive(generation)
      return 'published'
    })).resolves.toBe('published')
    expect(() => fence.assertActive(1)).toThrow(/generation_stale/)
  })

  test('keeps a queued newer atomic publication valid after an older refresh completes', async () => {
    const root = await privateRoot()
    const target = join(root, 'evidence.json')
    const fence = new EvidenceRefreshFence()
    let releaseOlder!: () => void
    const olderBlocked = new Promise<void>(resolve => { releaseOlder = resolve })
    let olderPublished!: () => void
    const olderEnteredValidation = new Promise<void>(resolve => { olderPublished = resolve })
    let newerStarted = false
    const older = fence.run(generation => atomicPrivateJson(
      target,
      root,
      { generation },
      undefined,
      async () => {
        olderPublished()
        await olderBlocked
        fence.assertActive(generation)
      },
    ))
    await olderEnteredValidation
    const newer = fence.run(generation => {
      newerStarted = true
      return atomicPrivateJson(target, root, { generation })
    })
    await Promise.resolve()
    expect(newerStarted).toBe(false)
    releaseOlder()
    await Promise.all([older, newer])
    expect(await Bun.file(target).json()).toEqual({ generation: 2 })
  })

  test('publishes evidence through the pinned parent and returns its identity', async () => {
    const root = await privateRoot()
    const target = join(root, 'evidence.json')
    const identity = await atomicPrivateJson(target, root, { accepted: true })
    const stat = await lstat(target, { bigint: true })
    expect(identity.inode).toBe(stat.ino.toString())
    expect(await Bun.file(target).json()).toEqual({ accepted: true })
  })

  test('rejects synchronized pathname substitution after descriptor read', async () => {
    const root = await privateRoot()
    const path = join(root, 'private.json')
    const displaced = join(root, 'displaced.json')
    await writeFile(path, '{"accepted":true}\n', { mode: 0o600 })
    await expect(readAnchoredFile(path, root, {
      minimumBytes: 2,
      maximumBytes: 1024,
      mode: 0o600,
      afterRead: async () => {
        await rename(path, displaced)
        await writeFile(path, '{"substituted":true}\n', { mode: 0o600 })
      },
    })).rejects.toThrow(/identity_drift/)
  })

  test('does not publish evidence after synchronized temporary substitution', async () => {
    const root = await privateRoot()
    const target = join(root, 'evidence.json')
    await expect(atomicPrivateJson(target, root, { accepted: true }, async temporary => {
      await unlink(temporary)
      await writeFile(temporary, '{"substituted":true}\n', { mode: 0o600 })
    })).rejects.toThrow(/temp_substituted/)
    await expect(Bun.file(target).exists()).resolves.toBe(false)
  })

  test('preserves the last valid publication after same-inode temporary mutation', async () => {
    const root = await privateRoot()
    const target = join(root, 'evidence.json')
    const previous = '{"generation":"previous"}\n'
    await writeFile(target, previous, { mode: 0o600 })
    await expect(atomicPrivateJson(target, root, { generation: 'next' }, async temporary => {
      const before = await lstat(temporary, { bigint: true })
      await writeFile(temporary, '{"generation":"mutated"}\n', { mode: 0o600 })
      const after = await lstat(temporary, { bigint: true })
      expect(after.ino).toBe(before.ino)
    })).rejects.toThrow(/temp_substituted|content_drift/)
    expect(await Bun.file(target).text()).toBe(previous)
  })

  test('fails closed after same-inode post-publication content mutation', async () => {
    const root = await privateRoot()
    const target = join(root, 'evidence.json')
    await expect(atomicPrivateJson(
      target,
      root,
      { accepted: true },
      undefined,
      async () => {
        const before = await lstat(target, { bigint: true })
        await writeFile(target, '{"accepted":false}\n', { mode: 0o600 })
        const after = await lstat(target, { bigint: true })
        expect(after.ino).toBe(before.ino)
      },
    )).rejects.toThrow(/membership_unproved|content_drift/)
    expect(await Bun.file(target).text()).toBe('')
  })

  test('invalidates the exact published inode when post-publication validation fails', async () => {
    const root = await privateRoot()
    const target = join(root, 'evidence.json')
    await expect(atomicPrivateJson(
      target,
      root,
      { accepted: true },
      undefined,
      () => { throw new Error('wal_source_stale') },
    )).rejects.toThrow(/wal_source_stale/)
    expect(await Bun.file(target).text()).toBe('')
  })

  test('invalidates renamed-away evidence without deleting replacement evidence', async () => {
    const root = await privateRoot()
    const target = join(root, 'evidence.json')
    const displaced = join(root, 'displaced-evidence.json')
    const unrelated = '{"unrelated":true}\n'
    await expect(atomicPrivateJson(
      target,
      root,
      { accepted: true },
      undefined,
      async () => {
        await rename(target, displaced)
        await writeFile(target, unrelated, { mode: 0o600 })
        throw new Error('wal_source_stale')
      },
    )).rejects.toThrow(/wal_source_stale/)
    expect(await Bun.file(displaced).text()).toBe('')
    expect(await Bun.file(target).text()).toBe(unrelated)
  })

  test('invalidates exchanged evidence without deleting the exchanged-in file', async () => {
    const root = await privateRoot()
    const target = join(root, 'evidence.json')
    const exchanged = join(root, 'unrelated-evidence.json')
    const unrelated = '{"unrelated":true}\n'
    await writeFile(exchanged, unrelated, { mode: 0o600 })
    await expect(atomicPrivateJson(
      target,
      root,
      { accepted: true },
      undefined,
      async () => {
        await renameExchange(root, target, exchanged)
        throw new Error('wal_source_stale')
      },
    )).rejects.toThrow(/wal_source_stale/)
    expect(await Bun.file(exchanged).text()).toBe('')
    expect(await Bun.file(target).text()).toBe(unrelated)
  })

  test('treats control socket rotation as cleanup unproved', async () => {
    const root = await privateRoot()
    const socket = join(root, 'control.sock')
    const createSocket = await compileSocketCreator(root)
    expect(spawnSync(createSocket, [socket]).status).toBe(0)
    await chmod(socket, 0o600)
    const [original, parent] = await Promise.all([lstat(socket), lstat(root)])
    await rename(socket, join(root, 'displaced.sock'))
    expect(spawnSync(createSocket, [socket]).status).toBe(0)
    await chmod(socket, 0o600)
    await expect(assertControlCleanupAuthority(socket,
      { device: original.dev, inode: original.ino }, { device: parent.dev, inode: parent.ino }))
      .rejects.toThrow(/cleanup_unproved/)
  })
})
