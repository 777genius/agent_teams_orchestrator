import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, link, lstat, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { appendPrivateNdjson, assertControlCleanupAuthority, atomicPrivateJson, readAnchoredFile } from './secure-files.js'

const temporaryRoots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function privateRoot(): Promise<string> {
  const root = await mkdtemp('/tmp/actual-owner-secure-')
  temporaryRoots.push(root)
  await chmod(root, 0o700)
  return root
}

function listen(path: string): Promise<Server> {
  const server = createServer()
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve(server))
  })
}

describe('hosted actual-owner descriptor fences', () => {
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

  test('rejects a self-consistent replacement sandbox and marker tree', async () => {
    const root = await privateRoot()
    const stat = await lstat(root, { bigint: true })
    const anchor = { path: root, device: stat.dev.toString(), inode: stat.ino.toString() }
    const path = join(root, 'private.json')
    await writeFile(path, '{"accepted":true}\n', { mode: 0o600 })
    const displaced = `${root}-displaced`
    temporaryRoots.push(displaced)
    await rename(root, displaced)
    await mkdir(root, { mode: 0o700 })
    await writeFile(path, '{"accepted":true}\n', { mode: 0o600 })
    await expect(readAnchoredFile(path, anchor, {
      minimumBytes: 2, maximumBytes: 1024, mode: 0o600,
    })).rejects.toThrow(/untrusted_parent/)
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

  test('rejects in-place mutation and hardlinking before publication', async () => {
    for (const attack of [
      async (temporary: string) => writeFile(temporary, '{"mutated":true}\n'),
      async (temporary: string) => link(temporary, `${temporary}.hardlink`),
    ]) {
      const root = await privateRoot()
      await expect(atomicPrivateJson(join(root, 'evidence.json'), root, { accepted: true }, attack))
        .rejects.toThrow(/temp_substituted/)
    }
  })

  test('timeline append refuses a symlink target outside its pinned parent', async () => {
    const root = await privateRoot()
    const outside = join(await privateRoot(), 'outside.ndjson')
    await writeFile(outside, '', { mode: 0o600 })
    const timeline = join(root, 'timeline.ndjson')
    await symlink(outside, timeline)
    await expect(appendPrivateNdjson(timeline, root, { event: 'poll' })).rejects.toThrow()
    expect(await Bun.file(outside).text()).toBe('')
  })

  test('timeline append proves the exact prior bytes plus one canonical line', async () => {
    const root = await privateRoot()
    const timeline = join(root, 'timeline.ndjson')
    await writeFile(timeline, '{"sequence":1}\n', { mode: 0o600 })
    const result = await appendPrivateNdjson(timeline, root, { sequence: 2 })
    expect(await Bun.file(timeline).text()).toBe('{"sequence":1}\n{"sequence":2}\n')
    expect(result.size).toBe('30')
  })

  test('treats control socket rotation as cleanup unproved', async () => {
    const root = await privateRoot()
    const socket = join(root, 'control.sock')
    const first = await listen(socket)
    await chmod(socket, 0o600)
    const [original, parent] = await Promise.all([lstat(socket), lstat(root)])
    await rename(socket, join(root, 'displaced.sock'))
    await listen(socket)
    await chmod(socket, 0o600)
    await expect(assertControlCleanupAuthority(socket,
      { device: original.dev, inode: original.ino }, { device: parent.dev, inode: parent.ino }))
      .rejects.toThrow(/cleanup_unproved/)
  })
})
