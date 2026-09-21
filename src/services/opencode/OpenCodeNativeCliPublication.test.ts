import { afterEach, expect, test } from 'bun:test'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { publishNativeCliFile, scavengeNativeCliPublicationTombstones } from './OpenCodeNativeCliPublication.js'

const exec = promisify(execFile)
const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'native-wrapper-publication-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function nativeTemps(root: string, targetName: string): Promise<string[]> {
  const namespace = path.join(root, `.${targetName}.native-cli-tombstones`)
  try {
    return (await readdir(namespace)).filter(name => name.endsWith('.tmp'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

test('publishes concurrent wrapper generations without truncation on every platform', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const initial = '@echo off\r\necho ready\r\n'
  await Promise.all(Array.from({ length: 32 }, () => publishNativeCliFile(target, initial, 0o700)))
  expect(await readFile(target, 'utf8')).toBe(initial)
  const before = await lstat(target)
  await Promise.all(Array.from({ length: 32 }, () => publishNativeCliFile(target, initial, 0o700)))
  expect((await lstat(target)).mtimeMs).toBe(before.mtimeMs)
  const changed = `${initial}rem ${'complete-generation'.repeat(1024)}\r\n`
  await Promise.all(Array.from({ length: 32 }, () => publishNativeCliFile(target, changed, 0o700)))
  expect(await readFile(target, 'utf8')).toBe(changed)
  expect(await readdir(root)).toEqual(['kiro-cli.cmd'])
})

test.skipIf(process.platform === 'win32')('preserves matching identity, repairs mode, replaces symlinks and cleans failed publication', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const content = '#!/bin/sh\nprintf ready\n'
  await publishNativeCliFile(target, content, 0o700)
  const first = await lstat(target)
  await publishNativeCliFile(target, content, 0o700)
  expect((await lstat(target)).ino).toBe(first.ino)
  expect((await lstat(target)).mtimeMs).toBe(first.mtimeMs)
  await chmod(target, 0o777)
  await publishNativeCliFile(target, content, 0o700)
  expect((await lstat(target)).mode & 0o7777).toBe(0o700)
  const external = path.join(root, 'external')
  await writeFile(external, 'untouched')
  await rm(target)
  await symlink(external, target)
  await publishNativeCliFile(target, content, 0o700)
  expect((await lstat(target)).isSymbolicLink()).toBe(false)
  expect(await readFile(external, 'utf8')).toBe('untouched')
  const preload = path.join(root, 'preload.cjs')
  await publishNativeCliFile(preload, 'module.exports = {}', 0o600)
  expect((await lstat(preload)).mode & 0o7777).toBe(0o600)
  const directory = path.join(root, 'directory')
  await mkdir(directory)
  await expect(publishNativeCliFile(directory, content, 0o700)).rejects.toThrow()
  expect(await nativeTemps(root, 'directory')).toHaveLength(1)
})

test.skipIf(process.platform === 'win32')('reuses an existing wrapper when lstat returns BigIntStats', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const content = '#!/bin/sh\nprintf ready\n'
  await publishNativeCliFile(target, content, 0o700)
  const before = await lstat(target, { bigint: true })
  const receipt = await publishNativeCliFile(target, content, 0o700, {
    platform: process.platform,
    lstat: source => lstat(source, { bigint: true }),
    rename: async () => { throw new Error('matching BigIntStats wrapper must be reused') },
  })
  expect(receipt.status).toBe('unchanged')
  expect((await lstat(target, { bigint: true })).ino).toBe(before.ino)
})

test('native reuse revalidates a concurrently replaced destination instead of returning a mixed generation', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const replacement = path.join(root, 'replacement')
  const content = '#!/bin/sh\nprintf ready\n'
  await writeFile(target, content)
  await chmod(target, 0o700)
  await writeFile(replacement, 'outside generation')
  let observations = 0
  const receipt = await publishNativeCliFile(target, content, 0o700, {
    rename,
    lstat: async source => {
      if (String(source) === target && ++observations === 2) await rename(replacement, target)
      return lstat(source, { bigint: true })
    },
  })
  // The descriptor saw the first file, but the path changed before the final
  // identity check; publication must not claim the old descriptor was reused.
  expect(receipt.status).toBe('committed')
  expect(await readFile(target, 'utf8')).toBe(content)
})

test.skipIf(process.platform === 'win32')('native reuse republishes when final POSIX permissions change after content is read', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const content = '#!/bin/sh\nprintf ready\n'
  await writeFile(target, content, { mode: 0o700 })
  let targetObservations = 0
  const receipt = await publishNativeCliFile(target, content, 0o700, {
    rename,
    lstat: async source => {
      if (String(source) === target && ++targetObservations === 2) {
        // This is a real POSIX chmod race. Windows mode bits are synthesized,
        // so that platform deliberately does not run this permission check.
        await chmod(target, 0o777)
      }
      return lstat(source, { bigint: true })
    },
  })
  expect(receipt.status).toBe('committed')
  expect(await readFile(target, 'utf8')).toBe(content)
})

test('native Windows namespace accepts synthesized mode bits', async () => {
  const root = await fixture()
  const windowsTarget = path.join(root, 'windows.cmd')
  const synthesizedMode = async (source: string | Buffer | URL) => {
    const stats = await lstat(source, { bigint: true })
    if (String(source).includes('.native-cli-tombstones')) {
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { mode: 0o777n })
    }
    return stats
  }
  await expect(publishNativeCliFile(windowsTarget, 'ready', 0o700, {
    platform: 'win32', rename, lstat: synthesizedMode as typeof lstat,
  })).resolves.toMatchObject({ status: 'committed' })
})

test('native Windows namespace establishes its principal-only ACL before publication', async () => {
  const root = await fixture()
  const target = path.join(root, 'windows-secured.cmd')
  const secured: string[] = []
  await expect(publishNativeCliFile(target, 'ready', 0o700, {
    platform: 'win32', rename,
    secureNamespace: async directory => { secured.push(directory) },
  })).resolves.toMatchObject({ status: 'committed' })
  expect(secured).toEqual([
    path.join(root, '.windows-secured.cmd.native-cli-tombstones'),
    path.join(root, '.windows-secured.cmd.native-cli-tombstones'),
  ])
})

test('native Darwin publication rejects a namespace whose hostile ACL cannot be cleared', async () => {
  const root = await fixture()
  const target = path.join(root, 'darwin-acl-cli')
  let checked = false
  await expect(publishNativeCliFile(target, 'ready', 0o700, {
    platform: 'darwin', rename,
    secureNamespace: async (_directory, platform) => {
      checked = platform === 'darwin'
      throw new Error('hostile ACL grants another principal traversal')
    },
  })).rejects.toThrow('hostile ACL')
  expect(checked).toBe(true)
  await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

test.skipIf(process.platform === 'win32')('native POSIX namespace rejects synthesized permissive mode bits', async () => {
  const root = await fixture()
  const synthesizedMode = async (source: string | Buffer | URL) => {
    const stats = await lstat(source, { bigint: true })
    if (String(source).includes('.native-cli-tombstones')) {
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { mode: 0o777n })
    }
    return stats
  }
  await expect(publishNativeCliFile(path.join(root, 'posix-cli'), 'ready', 0o700, {
    platform: process.platform, rename, lstat: synthesizedMode as typeof lstat,
  })).rejects.toThrow('tombstone namespace is not private')
})

test.skipIf(process.platform === 'win32')('native POSIX namespace rejects a foreign owner even at mode 0700', async () => {
  const root = await fixture()
  const foreignOwner = async (source: string | Buffer | URL) => {
    const stats = await lstat(source, { bigint: true })
    if (String(source).includes('.native-cli-tombstones')) {
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: BigInt(process.getuid!() + 1) })
    }
    return stats
  }
  await expect(publishNativeCliFile(path.join(root, 'foreign-owner-cli'), 'ready', 0o700, {
    platform: process.platform, rename, lstat: foreignOwner as typeof lstat,
  })).rejects.toThrow('tombstone namespace is not private')
})

test.skipIf(process.platform !== 'linux')('Linux replaces an executing inode without ETXTBSY', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  await copyFile('/bin/sleep', target)
  await chmod(target, 0o700)
  const child = spawn(target, ['20'], { stdio: 'ignore' })
  const exited = once(child, 'exit')
  try {
    await once(child, 'spawn')
    // Positive control: this is the actual Linux kernel failure, without a mock.
    await expect(writeFile(target, 'broken')).rejects.toMatchObject({ code: 'ETXTBSY' })
    await publishNativeCliFile(target, '#!/bin/sh\nprintf ready\n', 0o700)
    expect((await exec(target, [], { timeout: 5_000 })).stdout).toBe('ready')
  } finally {
    child.kill('SIGKILL')
    await exited
  }
})

test.skipIf(process.platform !== 'linux')('Linux separate publishers and executors observe complete executable generations', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  await publishNativeCliFile(target, '#!/bin/sh\nprintf A\n', 0o700)
  const worker = path.join(root, 'worker.ts')
  await writeFile(worker, `
import { publishNativeCliFile } from ${JSON.stringify(import.meta.dir + '/OpenCodeNativeCliPublication.ts')}
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout } from 'node:timers/promises'
const exec = promisify(execFile)
const [target, role, start] = process.argv.slice(2)
while (Date.now() < Number(start)) await setTimeout(1)
for (let i = 0; i < 100; i++) {
  if (role === 'publish') {
    await publishNativeCliFile(target, '#!/bin/sh\\nprintf ' + (i % 2 ? 'A' : 'B') + '\\n', 0o700)
  } else {
    const { stdout } = await exec(target, [], { timeout: 2000 })
    if (stdout !== 'A' && stdout !== 'B') throw new Error('partial wrapper: ' + stdout)
  }
}
`)
  const start = String(Date.now() + 500)
  const results = await Promise.allSettled(['publish', 'publish', 'execute', 'execute'].map(role =>
    exec(process.execPath, [worker, target, role, start], { timeout: 15_000 })))
  for (const result of results) expect(result.status === 'fulfilled' ? null : result.reason).toBeNull()
  expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
}, 20_000)

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`Windows ${code} rename contention retries the same prepared inode`, async () => {
    const root = await fixture()
    const target = path.join(root, 'kiro-cli.cmd')
    await writeFile(target, 'old')
    const original = await lstat(target)
    let attempts = 0
    let prepared: Awaited<ReturnType<typeof lstat>> | undefined
    let preparedPath: unknown
    await publishNativeCliFile(target, 'complete new generation', 0o700, {
      platform: 'win32',
      rename: async (source, destination) => {
        const current = await lstat(source)
        if (!prepared) { prepared = current; preparedPath = source }
        expect(source).toBe(preparedPath)
        expect(current.ino).toBe(prepared.ino)
        expect(current.mtimeMs).toBe(prepared.mtimeMs)
        expect(await readFile(source, 'utf8')).toBe('complete new generation')
        expect(await readFile(target, 'utf8')).toBe('old')
        expect((await lstat(target)).ino).toBe(original.ino)
        if (++attempts < 3) throw Object.assign(new Error('sharing violation'), { code, syscall: 'rename' })
        await rename(source, destination)
      },
    })
    expect(attempts).toBe(3)
    expect((await lstat(target)).ino).toBe(prepared!.ino)
    expect(await readFile(target, 'utf8')).toBe('complete new generation')
    // A successful rename consumes the body; no tombstone is retained merely
    // because this test simulates Windows rename contention on this host.
    expect(await nativeTemps(root, 'kiro-cli.cmd')).toHaveLength(0)
    await publishNativeCliFile(target, 'complete new generation', 0o700, {
      platform: 'win32', rename: async () => { throw new Error('matching publication must be a no-op') },
    })
  })
}

for (const [platform, code, syscall, expectedAttempts] of [
  ['win32', 'EPERM', 'rename', 8],
  ['win32', 'EACCES', 'rename', 8],
  ['win32', 'EBUSY', 'rename', 8],
  ['linux', 'EPERM', 'rename', 1],
  ['darwin', 'EBUSY', 'rename', 1],
  ['win32', 'ENOENT', 'rename', 1],
  ['win32', 'EIO', 'rename', 1],
  ['win32', 'EPERM', 'open', 1],
] as const) {
  test(`${platform} persistent ${code}/${syscall} fails after ${expectedAttempts} attempts and cleans temp`, async () => {
    const root = await fixture()
    const target = path.join(root, 'kiro-cli.cmd')
    await writeFile(target, 'old')
    const original = await lstat(target)
    const denial = Object.assign(new Error('denied'), { code, syscall })
    let attempts = 0
    let preparedPath: unknown
    let preparedInode: number | undefined
    await expect(publishNativeCliFile(target, 'new', 0o700, {
      platform,
      rename: async source => {
        const current = await lstat(source)
        if (!attempts) { preparedPath = source; preparedInode = current.ino }
        expect(source).toBe(preparedPath)
        expect(current.ino).toBe(preparedInode)
        expect(await readFile(source, 'utf8')).toBe('new')
        expect(await readFile(target, 'utf8')).toBe('old')
        attempts++
        throw denial
      },
    })).rejects.toBe(denial)
    expect(attempts).toBe(expectedAttempts)
    expect(await readFile(target, 'utf8')).toBe('old')
    expect((await lstat(target)).ino).toBe(original.ino)
    expect((await lstat(target)).mtimeMs).toBe(original.mtimeMs)
    expect(await readdir(root)).toEqual(['kiro-cli.cmd'])
  })
}

test('post-commit receipt distinguishes an immediate destination replacement', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const replacement = path.join(root, 'outside-replacement')
  await writeFile(replacement, 'outside writer')
  const receipt = await publishNativeCliFile(target, 'ours', 0o700, {
    rename: async (source, destination) => {
      await rename(source, destination)
      await rename(replacement, destination)
    },
  })
  expect(receipt.status).toBe('committed')
  if (receipt.status === 'committed') {
    expect(receipt.destinationMatchesCommit).toBe(false)
    expect(receipt.destination?.ino).not.toBe(receipt.committed.ino)
  }
  expect(await readFile(target, 'utf8')).toBe('outside writer')
})

test.skipIf(process.platform === 'win32')('uses a private source namespace before native publication rename', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  await publishNativeCliFile(target, 'ours', 0o700, {
    rename: async (source, destination) => {
      expect((await lstat(path.dirname(String(source)))).mode & 0o077).toBe(0)
      await rename(source, destination)
    },
  })
  expect(await readFile(target, 'utf8')).toBe('ours')
})

test('rejects an adversarial source replacement before native rename', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  let injected = false
  await expect(publishNativeCliFile(target, 'ours', 0o700, {
    rename,
    lstat: async source => {
      // This lstat is the pathname half of the descriptor/path revalidation
      // immediately before rename, not an earlier setup observation.
      if (String(source).endsWith('.tmp') && !injected) {
        injected = true
        await rm(source)
        await writeFile(source, 'replacement')
      }
      return lstat(source)
    },
  })).rejects.toThrow('source was replaced before rename')
  expect(injected).toBe(true)
  expect(await Bun.file(target).exists()).toBe(false)
})

test('successful native publication retains its shared private namespace without cleanup debt', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const namespace = path.join(root, '.kiro-cli.native-cli-tombstones')
  const receipt = await publishNativeCliFile(target, 'ours', 0o700, {
    rmdir: async directory => {
      throw new Error(`must not remove shared namespace: ${directory}`)
    },
  })
  expect(receipt).toMatchObject({ status: 'committed' })
  expect(receipt.status === 'committed' && receipt.cleanupDebt).toBeUndefined()
  expect(await Bun.file(namespace).exists()).toBe(true)
  expect(await readdir(namespace)).toEqual([])
})

test('a concurrent publisher namespace remains established through another publication', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const namespace = path.join(root, '.kiro-cli.native-cli-tombstones')
  // This is the deterministic cross-publisher seam: another process has
  // already validated the shared namespace and created its exclusive name.
  // A successful publication must not rmdir the directory beneath it.
  await mkdir(namespace, { recursive: true, mode: 0o700 })
  await writeFile(path.join(namespace, 'concurrent-tombstone'), 'new writer')
  const receipt = await publishNativeCliFile(target, 'ours', 0o700)
  expect(receipt).toMatchObject({ status: 'committed' })
  expect(receipt.status === 'committed' && receipt.cleanupDebt).toBeUndefined()
  expect(await readFile(path.join(namespace, 'concurrent-tombstone'), 'utf8')).toBe('new writer')
})

test('failed publication cleanup preserves a concurrent replacement of its temporary name', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  await expect(publishNativeCliFile(target, 'ours', 0o700, {
    rename: async source => {
      await rm(source)
      await writeFile(source, 'concurrent replacement')
      throw Object.assign(new Error('rename denied'), { code: 'EPERM', syscall: 'rename' })
    },
  })).rejects.toThrow('rename denied')
  const [temporary] = await nativeTemps(root, 'kiro-cli')
  expect(temporary).toBeDefined()
  expect(await readFile(path.join(root, '.kiro-cli.native-cli-tombstones', temporary!), 'utf8')).toBe('concurrent replacement')
  expect(await Bun.file(target).exists()).toBe(false)
  const report = await scavengeNativeCliPublicationTombstones(target)
  // Young, below-limit replacement state is retained; collection does not
  // mistake a stale receipt for authority over the new body.
  expect(report).toMatchObject({ retained: 2, removed: 0 })
  expect(report.skippedReplacements).toBeGreaterThan(0)
})

test('partial native wrapper write has durable ownership before failure and is safely collectible', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  await expect(publishNativeCliFile(target, 'complete wrapper', 0o700, {
    rename,
    open: (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('.tmp') && args[1] === 'wx') {
        const write = handle.writeFile.bind(handle)
        handle.writeFile = async () => {
          await write('partial', 'utf8')
          throw new Error('deterministic partial native write')
        }
      }
      return handle
    }) as typeof open,
  })).rejects.toThrow('deterministic partial native write')
  const [temporary] = await nativeTemps(root, 'kiro-cli')
  expect(temporary).toBeDefined()
  const tombstone = path.join(root, '.kiro-cli.native-cli-tombstones', temporary!)
  expect(await readFile(tombstone, 'utf8')).toBe('partial')
  expect(await Bun.file(`${tombstone}.identity.json`).exists()).toBe(true)
  // A fresh failed publication is forensic evidence, not quota pressure.
  expect(await scavengeNativeCliPublicationTombstones(target)).toMatchObject({ retained: 2, removed: 0 })
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1_000)
  await utimes(tombstone, expired, expired)
  expect((await scavengeNativeCliPublicationTombstones(target)).removed).toBe(1)
})

test('partial identity sidecars are preserved and accounted without aborting scavenging', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const directory = path.join(root, '.kiro-cli.native-cli-tombstones')
  const body = path.join(directory, 'kiro-cli.partial-sidecar.tmp')
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1_000)
  await ownedTombstone(root, target, 'kiro-cli.partial-sidecar.tmp', 7, expired)
  await writeFile(`${body}.identity.json`, '{"dev":"partial"')
  const sidecarBytes = (await lstat(`${body}.identity.json`)).size
  const report = await scavengeNativeCliPublicationTombstones(target)
  // The expired body is bounded now; the torn receipt is immediately
  // reclassified as a same-sweep orphan rather than escaping accounting.
  expect(report.removed).toBe(1)
  expect(report.skippedReplacements).toBe(0)
  expect(report.retained).toBe(1)
  expect(report.retainedBytes).toBe(sidecarBytes)
  expect(await Bun.file(body).exists()).toBe(false)
  expect(await Bun.file(`${body}.identity.json`).exists()).toBe(true)
})

test('failed sidecar removal remains retained, byte-accounted, and visible as cleanup debt', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const directory = path.join(root, '.kiro-cli.native-cli-tombstones')
  const body = path.join(directory, 'kiro-cli.remove-sidecar.tmp')
  await ownedTombstone(root, target, 'kiro-cli.remove-sidecar.tmp', 11,
    new Date(Date.now() - 25 * 60 * 60 * 1_000))
  const sidecar = `${body}.identity.json`
  const sidecarBytes = (await lstat(sidecar)).size
  const report = await scavengeNativeCliPublicationTombstones(target, {
    rm: async (targetPath, options) => {
      if (String(targetPath) === sidecar) throw Object.assign(new Error('sidecar removal denied'), { code: 'EACCES' })
      return rm(targetPath, options)
    },
  })
  expect(report.removed).toBe(1)
  expect(report.retained).toBe(1)
  expect(report.retainedBytes).toBe(sidecarBytes)
  expect(report.cleanupDebt?.paths).toEqual([sidecar])
  expect(await Bun.file(body).exists()).toBe(false)
  expect(await Bun.file(sidecar).exists()).toBe(true)
})

async function ownedTombstone(root: string, target: string, name: string, bytes: number, modifiedAt: Date) {
  const directory = path.join(root, `.${path.basename(target)}.native-cli-tombstones`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const tombstone = path.join(directory, name)
  await writeFile(tombstone, 'x'.repeat(bytes))
  await utimes(tombstone, modifiedAt, modifiedAt)
  const stats = await lstat(tombstone, { bigint: true })
  await writeFile(`${tombstone}.identity.json`, JSON.stringify({
    dev: stats.dev.toString(), ino: stats.ino.toString(),
    owner: { pid: 999_999, instance: null, active: false },
  }), { mode: 0o600 })
}

async function ownedActiveTombstone(root: string, target: string, name: string, owner: { pid: number; instance: string | null; active: boolean }) {
  const directory = path.join(root, `.${path.basename(target)}.native-cli-tombstones`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const body = path.join(directory, name)
  await writeFile(body, 'live')
  await utimes(body, new Date(0), new Date(0))
  const stats = await lstat(body, { bigint: true })
  await writeFile(`${body}.identity.json`, JSON.stringify({ dev: stats.dev.toString(), ino: stats.ino.toString(), owner }))
  return body
}

test('active and torn cross-process publishers are never retention-deleted', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const body = await ownedActiveTombstone(root, target, 'kiro-cli.p412.sinstance-a.writer.tmp',
    { pid: 412, instance: 'instance-a', active: true })
  const active = await scavengeNativeCliPublicationTombstones(target, { isOwnerActive: async owner => {
    expect(owner).toMatchObject({ pid: 412, instance: 'instance-a', active: true }); return true
  } })
  expect(active.removed).toBe(0)
  expect(await Bun.file(body).exists()).toBe(true)
  // A torn receipt still carries an owner in the temporary filename.
  await writeFile(`${body}.identity.json`, '{torn')
  expect((await scavengeNativeCliPublicationTombstones(target, { isOwnerActive: async () => true })).removed).toBe(0)
  expect((await scavengeNativeCliPublicationTombstones(target, { isOwnerActive: async () => false })).removed).toBe(1)
})

test('PID-reuse and ENOENT-between-passes are stale, bounded, and sidecar-accounted once', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const body = await ownedActiveTombstone(root, target, 'kiro-cli.p412.sold-instance.writer.tmp',
    { pid: 412, instance: 'old-instance', active: true })
  // The injected false result models a live numeric PID with a mismatched
  // process-instance token, which must not pin abandoned storage forever.
  expect((await scavengeNativeCliPublicationTombstones(target, { isOwnerActive: async () => false })).removed).toBe(1)

  await ownedTombstone(root, target, 'kiro-cli.enoent.tmp', 9, new Date(0))
  const second = path.join(root, '.kiro-cli.native-cli-tombstones', 'kiro-cli.enoent.tmp')
  const sidecar = `${second}.identity.json`
  let observations = 0
  const report = await scavengeNativeCliPublicationTombstones(target, {
    lstat: async source => {
      if (String(source) === second && ++observations > 1) throw Object.assign(new Error('body gone'), { code: 'ENOENT' })
      return lstat(source, { bigint: true })
    },
  })
  // ENOENT at the exact removal revalidation means the body was already
  // consumed; a valid receipt is consequently disposable in this sweep.
  expect(report).toMatchObject({ retained: 0, retainedBytes: 0, removed: 1 })
  expect(await Bun.file(sidecar).exists()).toBe(false)
})

test.skipIf(process.platform === 'win32')('fsyncs the body before rename and both changed directories before acknowledgment', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const events: string[] = []
  const originalOpen = open
  await publishNativeCliFile(target, 'durable', 0o700, {
    open: (async (...args: Parameters<typeof open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]).endsWith('.tmp') && args[1] === 'wx') {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { events.push('body-sync'); await sync() }
      }
      return handle
    }) as typeof open,
    rename: async (source, destination) => { events.push('rename'); await rename(source, destination) },
    syncDirectory: async directory => { events.push(`dir-sync:${path.basename(directory)}`) },
  })
  expect(events.indexOf('body-sync')).toBeLessThan(events.indexOf('rename'))
  expect(events.slice(events.indexOf('rename') + 1)).toEqual([
    'dir-sync:.kiro-cli.native-cli-tombstones', 'dir-sync:' + path.basename(root),
  ])

  await expect(publishNativeCliFile(path.join(root, 'failed-durability'), 'published-but-unacknowledged', 0o700, {
    rename,
    syncDirectory: async () => { throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' }) },
  })).rejects.toThrow('directory fsync failed')
  expect(await Bun.file(path.join(root, 'failed-durability')).exists()).toBe(true)
})

test('scavenger really removes exact owned tombstones for age, count, and byte retention', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const now = new Date()
  await ownedTombstone(root, target, 'kiro-cli.expired.tmp', 1, new Date(now.getTime() - 25 * 60 * 60 * 1_000))
  let report = await scavengeNativeCliPublicationTombstones(target)
  expect(report.removed).toBe(1)
  expect(await Bun.file(path.join(report.directory, 'kiro-cli.expired.tmp')).exists()).toBe(false)

  await Promise.all(Array.from({ length: 33 }, (_, index) =>
    ownedTombstone(root, target, `kiro-cli.count-${index}.tmp`, 1, new Date(now.getTime() + index))))
  report = await scavengeNativeCliPublicationTombstones(target)
  expect(report.removed).toBeGreaterThan(0)
  expect(report.retained).toBeLessThanOrEqual(32)

  await rm(report.directory, { recursive: true, force: true })
  await ownedTombstone(root, target, 'kiro-cli.bytes-a.tmp', 6 * 1024 * 1024, now)
  await ownedTombstone(root, target, 'kiro-cli.bytes-b.tmp', 6 * 1024 * 1024, new Date(now.getTime() + 1))
  report = await scavengeNativeCliPublicationTombstones(target)
  expect(report.removed).toBe(1)
  expect(report.retainedBytes).toBeLessThanOrEqual(10 * 1024 * 1024)
})

for (const code of ['EACCES', 'EPERM', 'EIO']) {
  test(`post-commit ${code} tombstone cleanup returns its committed receipt with debt`, async () => {
    const root = await fixture()
    const target = path.join(root, 'kiro-cli')
    const receipt = await publishNativeCliFile(target, 'ours', 0o700, {
      rename,
      rm: async (targetPath, options) => {
        if (String(targetPath).endsWith('.identity.json')) {
          throw Object.assign(new Error('cleanup denied'), { code })
        }
        return rm(targetPath, options)
      },
    })
    expect(receipt.status).toBe('committed')
    if (receipt.status === 'committed') {
      expect(receipt.cleanupDebt?.paths).toEqual([
        expect.stringMatching(/\.identity\.json$/),
        expect.stringMatching(/native-cli-tombstones$/),
      ])
      expect(receipt.destinationMatchesCommit).toBe(true)
    }
    expect(await readFile(target, 'utf8')).toBe('ours')
  })
}

test('a native post-rename scavenger stat failure returns the committed receipt with namespace debt', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const namespace = path.join(root, '.kiro-cli.native-cli-tombstones')
  const receipt = await publishNativeCliFile(target, 'ours', 0o700, {
    rename,
    rm: async (targetPath, options) => {
      if (String(targetPath).endsWith('.identity.json')) {
        // Preserve the namespace through the post-rename sweep, but make its
        // native stat fail the private-namespace validation.
        await chmod(namespace, 0o755)
        throw Object.assign(new Error('sidecar removal denied'), { code: 'EIO' })
      }
      return rm(targetPath, options)
    },
  })
  expect(receipt.status).toBe('committed')
  if (receipt.status === 'committed') {
    expect(receipt.destinationMatchesCommit).toBe(true)
    expect(receipt.cleanupDebt?.paths).toContain(namespace)
  }
  expect(await readFile(target, 'utf8')).toBe('ours')
})

test('native descriptor observation and close failures after rename preserve committed receipts as debt', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const originalOpen = open
  let committedStats = 0
  const statReceipt = await publishNativeCliFile(target, 'stat', 0o700, {
    rename,
    open: (async (...args: Parameters<typeof open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]).endsWith('.tmp') && args[1] === 'r') {
        const stat = handle.stat.bind(handle)
        handle.stat = async (...statArgs: Parameters<typeof handle.stat>) => {
          if (++committedStats === 2) throw Object.assign(new Error('descriptor EIO'), { code: 'EIO' })
          return stat(...statArgs)
        }
      }
      return handle
    }) as typeof open,
  })
  expect(statReceipt).toMatchObject({ status: 'committed', cleanupDebt: { paths: [target] } })
  expect(await readFile(target, 'utf8')).toBe('stat')

  const closeTarget = path.join(root, 'kiro-cli-close')
  const closeReceipt = await publishNativeCliFile(closeTarget, 'close', 0o700, {
    rename,
    open: (async (...args: Parameters<typeof open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]).endsWith('.tmp') && args[1] === 'r') {
        const close = handle.close.bind(handle)
        handle.close = async () => { await close(); throw Object.assign(new Error('descriptor close EIO'), { code: 'EIO' }) }
      }
      return handle
    }) as typeof open,
  })
  expect(closeReceipt).toMatchObject({ status: 'committed', cleanupDebt: { paths: [closeTarget] } })
  expect(await readFile(closeTarget, 'utf8')).toBe('close')
})

test('native unreadable orphan receipt retains trusted bytes and final absence I/O is cleanup debt', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const namespace = path.join(root, '.kiro-cli.native-cli-tombstones')
  await mkdir(namespace, { recursive: true, mode: 0o700 })
  const body = path.join(namespace, 'kiro-cli.orphan.tmp')
  const sidecar = `${body}.identity.json`
  await writeFile(sidecar, '{torn')
  const bytes = (await lstat(sidecar)).size
  const unreadable = await scavengeNativeCliPublicationTombstones(target, {
    readFile: async source => {
      if (String(source) === sidecar) throw Object.assign(new Error('receipt EIO'), { code: 'EIO' })
      return readFile(source, 'utf8')
    },
  })
  expect(unreadable).toMatchObject({ retained: 1, retainedBytes: bytes, cleanupDebt: { paths: [sidecar] } })

  await utimes(sidecar, new Date(0), new Date(0))
  const preservedUnreadable = await scavengeNativeCliPublicationTombstones(target, {
    readFile: async source => {
      if (String(source) === sidecar) throw Object.assign(new Error('receipt EACCES'), { code: 'EACCES' })
      return readFile(source, 'utf8')
    },
  })
  expect(preservedUnreadable).toMatchObject({ retained: 1, retainedBytes: bytes, removed: 0, cleanupDebt: { paths: [sidecar] } })
  expect(await Bun.file(sidecar).exists()).toBe(true)

  let bodyChecks = 0
  const finalCheck = await scavengeNativeCliPublicationTombstones(target, {
    lstat: async source => {
      if (String(source) === body && ++bodyChecks > 1) throw Object.assign(new Error('final absence EIO'), { code: 'EIO' })
      return lstat(source)
    },
    readFile,
  })
  expect(finalCheck.cleanupDebt?.paths).toContain(body)
  expect(finalCheck.skippedReplacements).toBe(0)
  expect(finalCheck.retainedBytes).toBe(bytes)
})

test('native operational body inspection independently accounts for a stat-able sidecar', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const namespace = path.join(root, '.kiro-cli.native-cli-tombstones')
  await mkdir(namespace, { recursive: true, mode: 0o700 })
  const body = path.join(namespace, 'kiro-cli.inspect-failure.tmp')
  const sidecar = `${body}.identity.json`
  await writeFile(sidecar, '{opaque')
  const bytes = (await lstat(sidecar)).size
  const report = await scavengeNativeCliPublicationTombstones(target, {
    lstat: async source => {
      if (String(source) === body) throw Object.assign(new Error('body EIO'), { code: 'EIO' })
      return lstat(source)
    },
  })
  expect(report).toMatchObject({ retained: 1, retainedBytes: bytes, removed: 0, cleanupDebt: { paths: [body] } })
  expect(await Bun.file(sidecar).exists()).toBe(true)
})

test('native scavenger retains young tombstones below retention bounds while reporting receipt-read debt', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  await ownedTombstone(root, target, 'kiro-cli.young.tmp', 1, new Date())
  const sidecar = path.join(root, '.kiro-cli.native-cli-tombstones', 'kiro-cli.young.tmp.identity.json')
  const report = await scavengeNativeCliPublicationTombstones(target, {
    readFile: async source => {
      if (String(source) === sidecar) throw Object.assign(new Error('receipt EACCES'), { code: 'EACCES' })
      return readFile(source, 'utf8')
    },
  })
  expect(report).toMatchObject({ retained: 2, removed: 0, cleanupDebt: { paths: [sidecar] } })
  expect(await Bun.file(path.join(root, '.kiro-cli.native-cli-tombstones', 'kiro-cli.young.tmp')).exists()).toBe(true)
  expect(await Bun.file(sidecar).exists()).toBe(true)
})

test('native publication retains specific pre-publication scavenger debt', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  await ownedTombstone(root, target, 'kiro-cli.young.tmp', 1, new Date())
  const sidecar = path.join(root, '.kiro-cli.native-cli-tombstones', 'kiro-cli.young.tmp.identity.json')
  const receipt = await publishNativeCliFile(target, 'published', 0o700, {
    rename,
    readFile: async source => {
      if (String(source) === sidecar) throw Object.assign(new Error('receipt EACCES'), { code: 'EACCES' })
      return readFile(source, 'utf8')
    },
  })
  expect(receipt).toMatchObject({ status: 'committed', cleanupDebt: { paths: expect.arrayContaining([sidecar]) } })
})

test('native malformed orphan receipts are bounded by count, bytes, and age', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const namespace = path.join(root, '.kiro-cli.native-cli-tombstones')
  await mkdir(namespace, { recursive: true, mode: 0o700 })
  for (let index = 0; index < 34; index += 1) {
    await writeFile(path.join(namespace, `kiro-cli.malformed-${index}.tmp.identity.json`), '{torn')
  }
  let report = await scavengeNativeCliPublicationTombstones(target)
  expect(report.retained).toBeLessThanOrEqual(32)
  expect(report.retainedBytes).toBeLessThanOrEqual(10 * 1024 * 1024)
  expect(report.removed).toBeGreaterThan(0)
  for (const name of await readdir(namespace)) await utimes(path.join(namespace, name), new Date(0), new Date(0))
  report = await scavengeNativeCliPublicationTombstones(target)
  expect(report.retained).toBe(0)
})
