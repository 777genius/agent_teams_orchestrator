import { afterEach, expect, test } from 'bun:test'
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { __testWithNativeWindowsAuthorityClaim, publishNativeCliFile, scavengeNativeCliPublicationTombstones } from './OpenCodeNativeCliPublication.js'
import { processInstance } from '../../utils/processInstanceOwnership.js'

const exec = promisify(execFile)
const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'native-wrapper-publication-'))
  roots.push(root)
  return root
}

async function protectWindowsFixture(pathname: string): Promise<void> {
  if (process.platform !== 'win32') return
  const literal = pathname.replace(/'/g, "''")
  const program = [
    "$ErrorActionPreference='Stop'",
    `$p='${literal}'`,
    '$identity=[Security.Principal.WindowsIdentity]::GetCurrent()',
    '$sid=$identity.User',
    '$acl=Get-Acl -LiteralPath $p',
    '$acl.SetAccessRuleProtection($true,$false)',
    'foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleAll($rule)}',
    "$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','None','None','Allow')",
    '$acl.AddAccessRule($rule)',
    'Set-Acl -LiteralPath $p -AclObject $acl',
    '$after=Get-Acl -LiteralPath $p',
    'if(-not $after.AreAccessRulesProtected){exit 1}',
  ].join(';')
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', program])
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

async function writeNativeAuthorityClaim(
  authority: string, claim: string, role: 'lease' | 'reclaimer', key: Buffer,
  owner: { pid: number; instance: string | null; active: true }, createdAt = Date.now(), filename = `${role}.json`,
): Promise<void> {
  const stats = await lstat(claim, { bigint: true })
  const unsigned = {
    format: 'native-cli-authority-claim-v1', role, owner,
    generation: `test-native-generation-${role}`, createdAt,
    claim: { dev: stats.dev.toString(), ino: stats.ino.toString() },
  }
  const authorityMac = createHmac('sha256', key).update(JSON.stringify({ authorityPath: authority, ...unsigned })).digest('base64url')
  await writeFile(path.join(claim, filename), JSON.stringify({ ...unsigned, authorityMac }), { mode: 0o600 })
}

async function writeNativeGenerationElection(claim: string, key: Buffer,
  owner: { pid: number; instance: string | null; active: true }, createdAt: number): Promise<void> {
  const stats = await lstat(claim, { bigint: true })
  const nonce = randomBytes(32)
  await writeFile(path.join(claim, 'generation.bootstrap'), JSON.stringify({
    format: 'native-cli-generation-bootstrap-v1', nonce: nonce.toString('base64url'), owner, createdAt,
    claim: { dev: stats.dev.toString(), ino: stats.ino.toString() },
  }), { mode: 0o600 })
  const unsigned = { format: 'native-cli-generation-key-v1', key: key.toString('base64url'), owner, createdAt }
  const keyMac = createHmac('sha256', nonce).update(JSON.stringify(unsigned)).digest('base64url')
  await writeFile(path.join(claim, 'generation.key'), JSON.stringify({ ...unsigned, keyMac }), { mode: 0o600 })
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
  expect(secured).toHaveLength(2)
  expect(secured[0]).toMatch(/\.windows-secured\.cmd\.native-cli-tombstones\.p\d+\.s[A-Za-z0-9_-]+\.r[0-9a-f-]{36}$/)
  expect(secured[1]).toMatch(new RegExp(`^${secured[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.pending\\.d\\d+\\.i\\d+$`))
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
  let bodyPublicationHookRan = false
  await expect(publishNativeCliFile(target, 'complete wrapper', 0o700, {
    rename,
    open: (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('.tmp') && args[1] === 'wx') {
        bodyPublicationHookRan = true
        const write = handle.writeFile.bind(handle)
        handle.writeFile = async () => {
          await write('partial', 'utf8')
          throw new Error('deterministic partial native write')
        }
      }
      return handle
    }) as typeof open,
  })).rejects.toThrow('deterministic partial native write')
  expect(bodyPublicationHookRan).toBe(true)
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
  let collectedSidecarRemovalHookRan = false
  const report = await scavengeNativeCliPublicationTombstones(target, {
    rm: async (targetPath, options) => {
      if (String(targetPath).startsWith(`${sidecar}.collected.`)) {
        collectedSidecarRemovalHookRan = true
        throw Object.assign(new Error('sidecar removal denied'), { code: 'EACCES' })
      }
      return rm(targetPath, options)
    },
  })
  expect(collectedSidecarRemovalHookRan).toBe(true)
  expect(report.removed).toBe(1)
  expect(report.retained).toBe(1)
  expect(report.retainedBytes).toBe(sidecarBytes)
  expect(report.cleanupDebt?.paths).toEqual([sidecar])
  expect(await Bun.file(body).exists()).toBe(false)
  expect(await Bun.file(sidecar).exists()).toBe(false)
  expect((await readdir(directory)).some(name => name.startsWith(`${path.basename(sidecar)}.collected.`))).toBe(true)
})

test('native crash recovery collects a claimed .collected body using its original durable receipt', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const directory = path.join(root, '.kiro-cli.native-cli-tombstones')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const original = path.join(directory, 'kiro-cli.p999999.sunknown.claimed.tmp')
  const collected = `${original}.collected.crash-window`
  await writeFile(collected, 'claimed body')
  const stats = await lstat(collected, { bigint: true })
  await writeFile(`${original}.identity.json`, JSON.stringify({
    dev: stats.dev.toString(), ino: stats.ino.toString(),
    owner: { pid: 999999, instance: null, active: false },
  }), { mode: 0o600 })
  const old = new Date(Date.now() - 25 * 60 * 60 * 1_000)
  await utimes(collected, old, old)
  const report = await scavengeNativeCliPublicationTombstones(target, { isOwnerActive: async () => false })
  expect(report.removed).toBe(1)
  expect(await Bun.file(collected).exists()).toBe(false)
  expect(await Bun.file(`${original}.identity.json`).exists()).toBe(false)
})

test('native repeated sweeps never orphan-delete a receipt while its collected body remains', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const directory = path.join(root, '.kiro-cli.native-cli-tombstones')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const original = path.join(directory, 'kiro-cli.p999998.sunknown.torn.tmp')
  const collected = `${original}.collected.recoverer-one`
  const receipt = `${original}.identity.json`
  await writeFile(collected, 'claimed but unauthenticated')
  await writeFile(receipt, '{torn', { mode: 0o600 })
  const old = new Date(Date.now() - 25 * 60 * 60 * 1_000)
  await utimes(collected, old, old)
  await utimes(receipt, old, old)

  for (let sweep = 0; sweep < 2; sweep += 1) {
    const report = await scavengeNativeCliPublicationTombstones(target, { isOwnerActive: async () => false })
    expect(report).toMatchObject({ removed: 0, retained: 2 })
    expect(await Bun.file(collected).exists()).toBe(true)
    expect(await Bun.file(receipt).exists()).toBe(true)
  }
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

test('native scavenger promotes and retires a synced interrupted body identity sidecar', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const directory = path.join(root, '.kiro-cli.native-cli-tombstones')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const body = path.join(directory, 'kiro-cli.interrupted.tmp')
  await writeFile(body, 'interrupted')
  const stats = await lstat(body, { bigint: true })
  const staged = `${body}.identity.json.staged.complete`
  await writeFile(staged, JSON.stringify({ dev: stats.dev.toString(), ino: stats.ino.toString(),
    owner: { pid: 999_999, instance: null, active: false } }), { mode: 0o600 })
  const old = new Date(0)
  await utimes(body, old, old)
  await utimes(staged, old, old)
  const report = await scavengeNativeCliPublicationTombstones(target)
  expect(report.removed).toBe(1)
  expect(await Bun.file(body).exists()).toBe(false)
  expect(await Bun.file(staged).exists()).toBe(false)
})

test('native staged sidecar recovery never promotes a live publisher', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const directory = path.join(root, '.kiro-cli.native-cli-tombstones')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const body = path.join(directory, 'kiro-cli.live.tmp')
  await writeFile(body, 'live')
  const stats = await lstat(body, { bigint: true })
  const staged = `${body}.identity.json.staged.live`
  await writeFile(staged, JSON.stringify({ dev: stats.dev.toString(), ino: stats.ino.toString(),
    owner: { pid: 424242, instance: 'still-live', active: true } }), { mode: 0o600 })
  const old = new Date(0)
  await utimes(body, old, old)
  await utimes(staged, old, old)
  const report = await scavengeNativeCliPublicationTombstones(target, { isOwnerActive: async () => true })
  expect(report.removed).toBe(0)
  expect(await Bun.file(staged).exists()).toBe(true)
  expect(await Bun.file(`${body}.identity.json`).exists()).toBe(false)
})

test('native crash recovery discards a synced staged sidecar only when final owns its recorded inode', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli')
  const directory = path.join(root, '.kiro-cli.native-cli-tombstones')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(target, 'final generation')
  const final = await lstat(target, { bigint: true })
  const original = path.join(directory, 'kiro-cli.p999999.sunknown.after-rename.tmp')
  const staged = `${original}.identity.json.staged.after-rename`
  await writeFile(staged, JSON.stringify({
    dev: final.dev.toString(), ino: final.ino.toString(),
    owner: { pid: 999999, instance: null, active: false },
  }), { mode: 0o600 })
  await scavengeNativeCliPublicationTombstones(target)
  expect(await Bun.file(staged).exists()).toBe(false)
})

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

async function windowsRunNamespace(
  root: string, target: string, owner: { pid: number; instance: string | null; active: boolean },
  run: string, modifiedAt: Date, foreign = false,
) {
  const name = `.${path.basename(target)}.native-cli-tombstones.p${owner.pid}.s${owner.instance ?? 'unknown'}.r${run}`
  const directory = path.join(root, name)
  await mkdir(directory, { mode: 0o700 })
  // Windows recovery validates an existing namespace rather than repairing
  // it. Make fixtures carry the same owner-only DACL provenance as v3/MAC
  // production receipts.
  await protectWindowsFixture(directory)
  const namespaceStats = await lstat(directory, { bigint: true })
  const unsigned = {
    format: foreign ? 'foreign-receipt' : 'atomic-write-namespace-v3', target, run, owner,
    namespace: { dev: namespaceStats.dev.toString(), ino: namespaceStats.ino.toString() },
    phase: owner.active ? 'active' : 'inactive',
  }
  const authorityPath = path.join(path.dirname(directory), '.native-cli-publication-authority.parent.private', 'authority')
  let authority: Buffer
  try { authority = await readFile(authorityPath) } catch {
    authority = randomBytes(32)
    await mkdir(path.dirname(authorityPath), { recursive: true, mode: 0o700 })
    await writeFile(authorityPath, '', { mode: 0o600, flag: 'wx' })
    await protectWindowsFixture(authorityPath)
    await writeFile(authorityPath, authority, { mode: 0o600 })
  }
  await writeFile(path.join(directory, '.native-cli-publication-namespace.json'), JSON.stringify({
    ...unsigned,
    ...(foreign ? {} : { authorityMac: createHmac('sha256', authority).update(JSON.stringify(unsigned)).digest('base64url') }),
  }))
  const debris = path.join(directory, `${path.basename(target)}.interrupted.tmp`)
  await writeFile(debris, 'interrupted')
  const debrisStats = await lstat(debris, { bigint: true })
  await writeFile(`${debris}.identity.json`, JSON.stringify({
    dev: debrisStats.dev.toString(), ino: debrisStats.ino.toString(), owner,
  }))
  for (const entry of await readdir(directory)) await utimes(path.join(directory, entry), modifiedAt, modifiedAt)
  return directory
}

test('Windows restart scavenging retains the final authenticated receipt without a durability proof', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const stale = await windowsRunNamespace(root, target, { pid: 412, instance: 'old-instance', active: true },
    '00000000-0000-4000-8000-000000000001', new Date(0))
  const report = await scavengeNativeCliPublicationTombstones(target, {
    platform: 'win32', isOwnerActive: async owner => {
      // A live PID with another start identity is stale, not a lease holder.
      expect(owner).toMatchObject({ pid: 412, instance: 'old-instance' })
      return false
    },
  })
  expect(report.removed).toBe(0)
  expect((await readdir(root)).some(name => name.startsWith(`${path.basename(stale)}.retired.`))).toBe(true)
})

test('Windows restart scavenging collects an authenticated abandoned final receipt on the later sweep', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const stale = await windowsRunNamespace(root, target, { pid: 411, instance: 'later-sweep', active: true },
    '00000000-0000-4000-8000-000000000009', new Date(0))
  const options = { platform: 'win32' as const, isOwnerActive: async () => false }
  const first = await scavengeNativeCliPublicationTombstones(target, options)
  expect(first.removed).toBe(0)
  const retired = path.join(root, (await readdir(root)).find(name => name.startsWith(`${path.basename(stale)}.retired.`))!)
  expect((await readdir(retired)).some(name => name.startsWith('.native-cli-publication-namespace.json.collected.'))).toBe(true)
  expect((await scavengeNativeCliPublicationTombstones(target, options)).removed).toBe(1)
  expect(await Bun.file(retired).exists()).toBe(false)
})

test('Windows restart scavenging completes the later sweep after final receipt claim to .collected', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const owner = { pid: 415, instance: 'claimed-receipt', active: true }
  const stale = await windowsRunNamespace(root, target, owner,
    '00000000-0000-4000-8000-000000000004', new Date(0))
  const receipt = path.join(stale, '.native-cli-publication-namespace.json')
  await rename(receipt, `${receipt}.collected.crash-after-claim`)
  const report = await scavengeNativeCliPublicationTombstones(target, {
    platform: 'win32', isOwnerActive: async candidate => candidate.pid !== owner.pid,
  })
  expect(report.removed).toBe(1)
  expect((await readdir(root)).some(name => name.startsWith(`${path.basename(stale)}.retired.`))).toBe(false)
})

test('Windows restart scavenging promotes a valid staged receipt over a torn final', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const owner = { pid: 416, instance: 'staged-torn', active: true }
  const stale = await windowsRunNamespace(root, target, owner,
    '00000000-0000-4000-8000-000000000005', new Date(0))
  const receipt = path.join(stale, '.native-cli-publication-namespace.json')
  await writeFile(`${receipt}.staged.recoverable`, await readFile(receipt))
  await writeFile(receipt, '{torn')
  const report = await scavengeNativeCliPublicationTombstones(target, {
    platform: 'win32', isOwnerActive: async candidate => candidate.pid !== owner.pid,
  })
  expect(report.removed).toBe(0)
  const retired = path.join(root, (await readdir(root)).find(name => name.startsWith(`${path.basename(stale)}.retired.`))!)
  const retiredReceipt = path.join(retired, path.basename(receipt))
  expect(await readFile(retiredReceipt, 'utf8')).not.toBe('{torn')
  expect(await Bun.file(`${retiredReceipt}.staged.recoverable`).exists()).toBe(false)
})

test('Windows restart scavenging never promotes or removes a live publisher staged receipt', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const owner = { pid: 417, instance: 'still-publishing', active: true }
  const stale = await windowsRunNamespace(root, target, owner,
    '00000000-0000-4000-8000-000000000006', new Date(0))
  const receipt = path.join(stale, '.native-cli-publication-namespace.json')
  const staged = `${receipt}.staged.live`
  await writeFile(staged, await readFile(receipt))
  await writeFile(receipt, '{torn')
  const report = await scavengeNativeCliPublicationTombstones(target, {
    platform: 'win32', isOwnerActive: async candidate => candidate.pid === owner.pid,
  })
  expect(report.removed).toBe(0)
  expect(await readFile(receipt, 'utf8')).toBe('{torn')
  expect(await Bun.file(staged).exists()).toBe(true)
})

test('Windows scavenging preserves live and foreign private-looking run namespaces', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const live = await windowsRunNamespace(root, target, { pid: 413, instance: 'live-instance', active: true },
    '00000000-0000-4000-8000-000000000002', new Date(0))
  const foreign = await windowsRunNamespace(root, target, { pid: 414, instance: 'foreign-instance', active: false },
    '00000000-0000-4000-8000-000000000003', new Date(0), true)
  const report = await scavengeNativeCliPublicationTombstones(target, {
    platform: 'win32', isOwnerActive: async owner => owner.pid === 413,
  })
  expect(report.removed).toBe(0)
  expect(await Bun.file(live).exists()).toBe(true)
  expect(await Bun.file(foreign).exists()).toBe(true)
})

test('Windows verified abandoned run namespaces obey bounded retention', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  await Promise.all(Array.from({ length: 33 }, async (_, index) => windowsRunNamespace(root, target,
    { pid: 10_000 + index, instance: `stale-${index}`, active: true },
    `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, new Date(Date.now() + index))))
  const report = await scavengeNativeCliPublicationTombstones(target, { platform: 'win32' })
  expect(report.removed).toBeGreaterThan(0)
  expect(report.retained).toBeLessThanOrEqual(32)
})

test('Windows recovery resumes a nonempty namespace retirement using its original inode', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const namespace = await windowsRunNamespace(root, target,
    { pid: 10_111, instance: 'retired-instance', active: true },
    '00000000-0000-4000-8000-000000000111', new Date(0))
  const stats = await lstat(namespace, { bigint: true })
  const retired = `${namespace}.retired.d${stats.dev}.i${stats.ino}`
  await rename(namespace, retired)
  const report = await scavengeNativeCliPublicationTombstones(target, {
    platform: 'win32', isOwnerActive: async () => false,
  })
  expect(report.removed).toBe(0)
  expect(await Bun.file(retired).exists()).toBe(true)
})

test('a successful Windows publication retains authenticated recovery state without a directory barrier', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  await expect(publishNativeCliFile(target, '@echo ready\r\n', 0o700, { platform: 'win32', rename })).resolves.toMatchObject({
    status: 'committed', cleanupDebt: { paths: expect.arrayContaining([expect.stringMatching(/\.native-cli-publication-namespace\.json$/)]) },
  })
  expect((await readdir(root)).filter(name => name.includes('.native-cli-tombstones'))).toHaveLength(1)
})

test('Windows native authority recovery completes the nlink=2 staging crash window', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const authority = path.join(root, '.native-cli-publication-authority.parent.private', 'authority')
  const staged = `${authority}.staged.crash-before-unlink`
  await mkdir(path.dirname(authority), { recursive: true, mode: 0o700 })
  await writeFile(staged, randomBytes(32), { mode: 0o600 })
  await link(staged, authority)
  expect((await lstat(authority, { bigint: true })).nlink).toBe(2n)

  await expect(publishNativeCliFile(target, '@echo recovered\r\n', 0o700, { platform: 'win32', rename }))
    .resolves.toMatchObject({ status: 'committed' })
  expect((await lstat(authority, { bigint: true })).nlink).toBe(1n)
  expect(await Bun.file(staged).exists()).toBe(false)
})

test('Windows native publication reopens every fsync target with write access', async () => {
  const root = await fixture()
  const syncedFlags: string[] = []
  await expect(publishNativeCliFile(path.join(root, 'kiro-cli.cmd'), '@echo ready\r\n', 0o700, {
    platform: 'win32',
    open: (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        syncedFlags.push(String(args[1]))
        await sync()
      }
      return handle
    }) as typeof open,
  })).resolves.toMatchObject({ status: 'committed' })
  // Observation handles may intentionally be retained read-only. Only the
  // handles on which fsync is invoked need write access.
  expect(syncedFlags).toContain('r+')
  expect(syncedFlags).not.toContain('r')
})

test('Windows native publication recovers an abandoned pre-authority generation claim', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const authority = path.join(root, '.native-cli-publication-authority.parent.private', 'authority')
  const claim = `${authority}.claim`
  const generationKey = randomBytes(32)
  await mkdir(path.dirname(authority), { recursive: true, mode: 0o700 })
  await writeFile(authority, '', { mode: 0o600 })
  await mkdir(claim, { mode: 0o700 })
  await writeFile(path.join(claim, 'generation.key'), generationKey, { mode: 0o600 })
  const staleAt = Date.now() - 31_000
  await writeNativeAuthorityClaim(authority, claim, 'lease', generationKey, { pid: 999_987, instance: null, active: true }, staleAt)
  await writeNativeAuthorityClaim(authority, claim, 'reclaimer', generationKey, { pid: 999_986, instance: null, active: true }, staleAt)
  await rm(path.join(claim, 'lease.json'))

  await expect(publishNativeCliFile(target, '@echo recovered\r\n', 0o700, { platform: 'win32' }))
    .resolves.toMatchObject({ status: 'committed' })
  expect(await Bun.file(claim).exists()).toBe(false)
  expect((await readFile(authority)).length).toBe(32)
  expect(await readFile(target, 'utf8')).toBe('@echo recovered\r\n')
})

test('a lease-less authenticated generation election is recovered after its owner is abandoned', async () => {
  const root = await fixture()
  const authority = path.join(root, '.native-cli-publication-authority.parent.private', 'authority')
  const claim = `${authority}.claim`
  await mkdir(path.dirname(authority), { recursive: true, mode: 0o700 })
  await writeFile(authority, '', { mode: 0o600 })
  await mkdir(claim, { mode: 0o700 })
  await writeNativeGenerationElection(claim, randomBytes(32),
    { pid: 999_981, instance: null, active: true }, Date.now() - 31_000)

  await expect(__testWithNativeWindowsAuthorityClaim(authority, async () => undefined)).resolves.toBeUndefined()
  expect(await Bun.file(claim).exists()).toBe(false)
})

test('Windows native publication resumes every collected authority-control crash boundary', async () => {
  for (const boundary of ['lease', 'reclaimer', 'election', 'key', 'key-link-before-unlink', 'recovery-key', 'recovery-key-collected'] as const) {
    const root = await fixture()
    const target = path.join(root, `kiro-${boundary}.cmd`)
    const authority = path.join(root, '.native-cli-publication-authority.parent.private', 'authority')
    const claim = `${authority}.claim`
    const generationKey = randomBytes(32)
    const staleAt = Date.now() - 31_000
    await mkdir(path.dirname(authority), { recursive: true, mode: 0o700 })
    await writeFile(authority, '', { mode: 0o600 })
    await mkdir(claim, { mode: 0o700 })
    await writeFile(path.join(claim, 'generation.key'), generationKey, { mode: 0o600 })
    await writeNativeAuthorityClaim(authority, claim, 'lease', generationKey,
      { pid: 999_970, instance: null, active: true }, staleAt)
    await writeNativeAuthorityClaim(authority, claim, 'reclaimer', generationKey,
      { pid: 999_969, instance: null, active: true }, staleAt)
    if (boundary === 'lease') {
      await rename(path.join(claim, 'lease.json'), path.join(claim, 'lease.json.collected.crash'))
    } else if (boundary === 'reclaimer') {
      await rm(path.join(claim, 'lease.json'))
      await rename(path.join(claim, 'reclaimer.json'), path.join(claim, 'reclaimer.json.collected.crash'))
    } else if (boundary === 'election') {
      await rm(path.join(claim, 'lease.json'))
      await writeNativeAuthorityClaim(authority, claim, 'reclaimer', generationKey,
        { pid: 999_968, instance: null, active: true }, staleAt, 'generation.claim.json')
      await rm(path.join(claim, 'reclaimer.json'))
      await rename(path.join(claim, 'generation.claim.json'), path.join(claim, 'generation.claim.json.collected.crash'))
    } else if (boundary === 'key') {
      await rename(path.join(claim, 'generation.key'), path.join(claim, 'generation.key.collected.crash'))
    } else if (boundary === 'key-link-before-unlink') {
      // A crash between link and unlink leaves two aliases of the same
      // generation; this is resumable authority, not an ambiguous election.
      await link(path.join(claim, 'generation.key'), path.join(claim, 'generation.key.collected.crash'))
    } else {
      // The final elected record is intentionally signed by the bootstrap
      // generation while its immutable recovery name is the only surviving
      // key. A restart must finish, not mistake this for a live initializer.
      await rm(path.join(claim, 'lease.json'))
      await rm(path.join(claim, 'reclaimer.json'))
      await writeNativeAuthorityClaim(authority, claim, 'reclaimer', generationKey,
        { pid: 999_968, instance: null, active: true }, staleAt, 'generation.claim.json')
      await link(path.join(claim, 'generation.key'), path.join(claim, 'recovery.key'))
      await rm(path.join(claim, 'generation.key'))
      if (boundary === 'recovery-key-collected') {
        await rename(path.join(claim, 'recovery.key'), path.join(claim, 'recovery.key.collected.crash'))
      }
    }

    await expect(publishNativeCliFile(target, '@echo recovered\r\n', 0o700, { platform: 'win32' }))
      .resolves.toMatchObject({ status: 'committed' })
    expect(await Bun.file(claim).exists()).toBe(false)
    expect((await readFile(authority)).length).toBe(32)
  }
})

test('Windows native recovery coalesces real same-inode collected aliases while another reclaimer survives', async () => {
  const root = await fixture()
  const authority = path.join(root, '.native-cli-publication-authority.parent.private', 'authority')
  const claim = `${authority}.claim`
  const generationKey = randomBytes(32)
  const staleAt = Date.now() - 31_000
  await mkdir(path.dirname(authority), { recursive: true, mode: 0o700 })
  await writeFile(authority, '', { mode: 0o600 })
  await mkdir(claim, { mode: 0o700 })
  await writeFile(path.join(claim, 'generation.key'), generationKey, { mode: 0o600 })
  await writeNativeAuthorityClaim(authority, claim, 'lease', generationKey,
    { pid: 999_979, instance: null, active: true }, staleAt)
  // This is the actual link-before-unlink crash prefix, not a copied fixture.
  await link(path.join(claim, 'lease.json'), path.join(claim, 'lease.json.collected.crash'))

  const first = __testWithNativeWindowsAuthorityClaim(authority, async () => undefined)
  const second = __testWithNativeWindowsAuthorityClaim(authority, async () => undefined)
  await Promise.allSettled([first, second])
  // One recoverer may observe the other live election, but neither treats
  // two aliases of the one inode as competing generations or leaves it busy.
  await expect(__testWithNativeWindowsAuthorityClaim(authority, async () => undefined)).resolves.toBeUndefined()
  expect(await Bun.file(claim).exists()).toBe(false)
})

test('an unauthenticated legacy generation claim is retained rather than used to delete a successor', async () => {
  const root = await fixture()
  const authority = path.join(root, '.native-cli-publication-authority.parent.private', 'authority')
  const claim = `${authority}.claim`
  const generationKey = randomBytes(32)
  await mkdir(path.dirname(authority), { recursive: true, mode: 0o700 })
  await writeFile(authority, '', { mode: 0o600 })
  await mkdir(claim, { mode: 0o700 })
  await writeFile(path.join(claim, 'generation.key'), generationKey, { mode: 0o600 })
  await writeNativeAuthorityClaim(authority, claim, 'reclaimer', generationKey,
    { pid: 999_982, instance: null, active: true }, Date.now() - 31_000)
  // The old direct `wx` protocol could leave this zero-byte final name after
  // a power loss. It is not authenticated, so the stale signed reclaimer
  // authorizes its replacement rather than treating EEXIST as permanent.
  await writeFile(path.join(claim, 'generation.claim.json'), '', { mode: 0o600 })

  await expect(__testWithNativeWindowsAuthorityClaim(authority, async () => undefined))
    .rejects.toThrow('authority claim is busy')
  // The legacy zero-byte name is not attributable to a dead owner.  Leaving
  // it visible is the safe behavior; a collector must never delete a live
  // election merely because an earlier read found it invalid.
  expect(await Bun.file(path.join(claim, 'generation.claim.json')).exists()).toBe(true)
})

test('competing on-disk recoverers adopt a durable generation election without deleting its valid successor', async () => {
  const root = await fixture()
  const authority = path.join(root, '.native-cli-publication-authority.parent.private', 'authority')
  const claim = `${authority}.claim`
  const generationKey = randomBytes(32)
  const staleAt = Date.now() - 31_000
  await mkdir(path.dirname(authority), { recursive: true, mode: 0o700 })
  // This is the pre-authority crash state: authority is deliberately not a
  // signing key, so recovery has to use generation.key.
  await writeFile(authority, '', { mode: 0o600 })
  await mkdir(claim, { mode: 0o700 })
  await writeFile(path.join(claim, 'generation.key'), generationKey, { mode: 0o600 })
  await writeNativeAuthorityClaim(authority, claim, 'reclaimer', generationKey,
    { pid: 999_983, instance: null, active: true }, staleAt)
  // Simulate the crash after the durable no-clobber election write. This is
  // intentionally a second pathname with the same signed generation.
  await writeNativeAuthorityClaim(authority, claim, 'reclaimer', generationKey,
    { pid: 999_983, instance: null, active: true }, staleAt, 'generation.claim.json')

  let pause!: () => void
  const resume = new Promise<void>(resolve => { pause = resolve })
  let paused!: () => void
  const atFinalValidation = new Promise<void>(resolve => { paused = resolve })
  const staleRecoverer = __testWithNativeWindowsAuthorityClaim(authority, async () => undefined, {
    beforeDelete: async () => { paused(); await resume },
  })
  await atFinalValidation

  // This direct second primitive deliberately bypasses the module's
  // process-local fence. Move the predecessor aside as a real competing
  // on-disk cleanup would, then let B establish its successor at the live
  // pathname while A remains paused after final validation.
  await rename(claim, `${claim}.predecessor`)
  let releaseSuccessor!: () => void
  const successorGate = new Promise<void>(resolve => { releaseSuccessor = resolve })
  let successorEntered!: () => void
  const successorReady = new Promise<void>(resolve => { successorEntered = resolve })
  const successor = __testWithNativeWindowsAuthorityClaim(authority, async () => {
    successorEntered()
    await successorGate
  })
  await successorReady
  expect((await lstat(claim)).isDirectory()).toBe(true)
  expect((await readFile(path.join(claim, 'generation.key'))).length).toBe(32)
  expect(JSON.parse(await readFile(path.join(claim, 'lease.json'), 'utf8'))).toMatchObject({
    format: 'native-cli-authority-claim-v1', role: 'lease', owner: { pid: process.pid, active: true },
  })

  pause()
  await expect(staleRecoverer).rejects.toThrow('native CLI publication authority claim is busy')
  // The stale recoverer must not remove the live successor's lease, key, or
  // claim directory after observing a different directory inode.
  expect(await Bun.file(path.join(claim, 'lease.json')).exists()).toBe(true)
  expect(await Bun.file(path.join(claim, 'generation.key')).exists()).toBe(true)
  releaseSuccessor()
  await successor
  expect(await Bun.file(claim).exists()).toBe(false)
})

test('Windows native publication authenticates a stale pre-authority lease with generation.key', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const authority = path.join(root, '.native-cli-publication-authority.parent.private', 'authority')
  const claim = `${authority}.claim`
  const generationKey = randomBytes(32)
  await mkdir(path.dirname(authority), { recursive: true, mode: 0o700 })
  await writeFile(authority, '', { mode: 0o600 })
  await mkdir(claim, { mode: 0o700 })
  await writeFile(path.join(claim, 'generation.key'), generationKey, { mode: 0o600 })
  await writeNativeAuthorityClaim(authority, claim, 'lease', generationKey,
    { pid: 999_984, instance: null, active: true }, Date.now() - 31_000)

  await expect(publishNativeCliFile(target, '@echo recovered lease\r\n', 0o700, { platform: 'win32' }))
    .resolves.toMatchObject({ status: 'committed' })
  expect(await Bun.file(claim).exists()).toBe(false)
  expect((await readFile(authority)).length).toBe(32)
})

test('Windows native recovery retains a selected staged lease until its exact consumer retires it', async () => {
  const root = await fixture()
  const authority = path.join(root, '.native-cli-publication-authority.parent.private', 'authority')
  const claim = `${authority}.claim`
  const key = randomBytes(32)
  await mkdir(path.dirname(authority), { recursive: true, mode: 0o700 })
  await writeFile(authority, '', { mode: 0o600 })
  await mkdir(claim, { mode: 0o700 })
  await writeFile(path.join(claim, 'generation.key'), key, { mode: 0o600 })
  await writeNativeAuthorityClaim(authority, claim, 'lease', key,
    { pid: 999_944, instance: null, active: true }, Date.now() - 31_000)
  await rename(path.join(claim, 'lease.json'), path.join(claim, 'lease.json.staged.crash'))
  await expect(__testWithNativeWindowsAuthorityClaim(authority, async () => undefined)).resolves.toBeUndefined()
  expect(await Bun.file(claim).exists()).toBe(false)
})

test('Windows native recovery rejects a forged self-key generation record without bootstrap debt', async () => {
  const root = await fixture()
  const authority = path.join(root, '.native-cli-publication-authority.parent.private', 'authority')
  const claim = `${authority}.claim`
  const key = randomBytes(32)
  const owner = { pid: 999_943, instance: null, active: true as const }
  const unsigned = { format: 'native-cli-generation-key-v1', key: key.toString('base64url'), owner, createdAt: Date.now() - 31_000 }
  await mkdir(path.dirname(authority), { recursive: true, mode: 0o700 })
  await writeFile(authority, '', { mode: 0o600 })
  await mkdir(claim, { mode: 0o700 })
  await writeFile(path.join(claim, 'generation.key'), JSON.stringify({ ...unsigned,
    keyMac: createHmac('sha256', key).update(JSON.stringify(unsigned)).digest('base64url') }))
  await expect(__testWithNativeWindowsAuthorityClaim(authority, async () => undefined)).rejects.toThrow('authority claim is busy')
  expect(await Bun.file(path.join(claim, 'generation.key')).exists()).toBe(true)
})

test('Windows native sidecar cleanup debt retains its namespace recovery authority', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  let collectedSidecarCleanupHookRan = false
  const receipt = await publishNativeCliFile(target, '@echo ready\r\n', 0o700, {
    platform: 'win32',
    rm: async (candidate, options) => {
      if (String(candidate).includes('.identity.json.collected.')) {
        collectedSidecarCleanupHookRan = true
        throw Object.assign(new Error('sidecar removal denied'), { code: 'EACCES' })
      }
      return rm(candidate, options)
    },
  })
  expect(collectedSidecarCleanupHookRan).toBe(true)
  expect(receipt).toMatchObject({ status: 'committed', cleanupDebt: { paths: expect.any(Array) } })
  expect((await readdir(root)).some(name => name.includes('.native-cli-tombstones'))).toBe(true)
})

test('Windows native open failure retires the exact empty run while this process remains alive', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  await expect(publishNativeCliFile(target, '@echo ready\r\n', 0o700, {
    platform: 'win32',
    open: async (candidate, flags, mode) => {
      if (flags === 'wx') throw Object.assign(new Error('open denied'), { code: 'EACCES' })
      return open(candidate, flags, mode)
    },
  })).rejects.toMatchObject({ code: 'EACCES' })
  expect((await readdir(root)).filter(name => name.includes('.native-cli-tombstones'))).toEqual([])
})

test('Windows native inactive failures retain receipts while their creator remains live, then clean after authenticated abandonment', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  for (let index = 0; index < 36; index += 1) {
    await expect(publishNativeCliFile(target, `@echo ${index}\r\n`, 0o700, {
      platform: 'win32',
      rename: async () => { throw Object.assign(new Error('rename denied'), { code: 'EIO' }) },
    })).rejects.toMatchObject({ code: 'EIO' })
  }
  const live = await scavengeNativeCliPublicationTombstones(target, {
    platform: 'win32', isOwnerActive: async () => true,
  })
  expect(live.removed).toBe(0)
  expect(live.retained).toBeGreaterThan(32)
  const abandoned = await scavengeNativeCliPublicationTombstones(target, {
    platform: 'win32', isOwnerActive: async () => false,
  })
  // Windows retains the final authenticated receipt after retirement because
  // Node cannot prove the directory-flush edge, but abandoned bodies were
  // still consumed and every retired namespace is durable recovery evidence.
  expect((await readdir(root)).some(name => name.includes('.retired.'))).toBe(true)
  expect(abandoned.cleanupDebt?.paths.length).toBeGreaterThan(0)
})

test('Windows native retirement refuses a namespace successor substituted after creation', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  let replacement = ''
  await publishNativeCliFile(target, '@echo ready\r\n', 0o700, {
    platform: 'win32',
    rm: async (candidate, options) => {
      if (String(candidate).includes('.identity.json.collected.')) {
        const namespace = path.dirname(String(candidate))
        await rm(candidate, options)
        replacement = namespace
        await rename(namespace, `${namespace}.displaced`)
        await mkdir(namespace, { mode: 0o700 })
        return
      }
      return rm(candidate, options)
    },
  })
  expect(replacement).not.toBe('')
  expect(await Bun.file(replacement).exists()).toBe(true)
})

test('Windows native recovery recognizes only inode-bearing pending creation state', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const base = path.join(root, '.kiro-cli.cmd.native-cli-tombstones.p777.sold.r00000000-0000-4000-8000-000000000099')
  await mkdir(base, { mode: 0o700 })
  const stats = await lstat(base, { bigint: true })
  const pending = `${base}.pending.d${stats.dev}.i${stats.ino}`
  await rename(base, pending)
  // This is the crash window after exclusive mkdir/ACL setup but before the
  // namespace receipt can be durably written.
  expect((await scavengeNativeCliPublicationTombstones(target, {
    platform: 'win32', isOwnerActive: async () => false,
  })).removed).toBe(1)
  expect(await Bun.file(pending).exists()).toBe(false)

  const forged = path.join(root, '.kiro-cli.cmd.native-cli-tombstones.p778.sold.r00000000-0000-4000-8000-000000000098')
  await mkdir(forged, { mode: 0o700 })
  await writeFile(path.join(forged, '.native-cli-publication-namespace.json'), JSON.stringify({
    format: 'native-cli-publication-namespace-v1', target, run: '00000000-0000-4000-8000-000000000098',
    owner: { pid: 778, instance: 'old', active: false }, namespace: { dev: '1', ino: '1' },
  }))
  await scavengeNativeCliPublicationTombstones(target, { platform: 'win32', isOwnerActive: async () => false })
  expect(await Bun.file(forged).exists()).toBe(true)
})

test('Windows native recovery rejects matching forged inactive metadata for a live creator', async () => {
  const root = await fixture()
  const target = path.join(root, 'kiro-cli.cmd')
  const instance = await processInstance(process.pid)
  const run = '00000000-0000-4000-8000-000000000197'
  // Start from a real current-process incarnation and production-order MAC
  // receipt, then alter only the tag. This reaches authentication rather
  // than being rejected by a legacy-format parser before the security check.
  const namespace = await windowsRunNamespace(root, target,
    { pid: process.pid, instance, active: true }, run, new Date(0))
  const receiptPath = path.join(namespace, '.native-cli-publication-namespace.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  await writeFile(receiptPath, JSON.stringify({ ...receipt, phase: 'inactive', authorityMac: 'forged' }))
  expect((await scavengeNativeCliPublicationTombstones(target, { platform: 'win32' })).removed).toBe(0)
  expect(await Bun.file(namespace).exists()).toBe(true)
})

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
  // A stale-looking name is not durable ownership evidence. Even a confirmed
  // dead PID cannot authorize deletion once the receipt is torn.
  expect((await scavengeNativeCliPublicationTombstones(target, { isOwnerActive: async () => false })).removed).toBe(0)
  expect(await Bun.file(body).exists()).toBe(true)
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
    let collectedSidecarCleanupHookRan = false
    const receipt = await publishNativeCliFile(target, 'ours', 0o700, {
      rename,
      rm: async (targetPath, options) => {
        if (String(targetPath).includes('.identity.json.collected.')) {
          collectedSidecarCleanupHookRan = true
          throw Object.assign(new Error('cleanup denied'), { code })
        }
        return rm(targetPath, options)
      },
    })
    expect(receipt.status).toBe('committed')
    expect(collectedSidecarCleanupHookRan).toBe(true)
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
  let collectedSidecarCleanupHookRan = false
  const receipt = await publishNativeCliFile(target, 'ours', 0o700, {
    rename,
    rm: async (targetPath, options) => {
      if (String(targetPath).includes('.identity.json.collected.')) {
        collectedSidecarCleanupHookRan = true
        // Preserve the namespace through the post-rename sweep, but make its
        // native stat fail the private-namespace validation.
        await chmod(namespace, 0o755)
        throw Object.assign(new Error('sidecar removal denied'), { code: 'EIO' })
      }
      return rm(targetPath, options)
    },
  })
  expect(receipt.status).toBe('committed')
  expect(collectedSidecarCleanupHookRan).toBe(true)
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
