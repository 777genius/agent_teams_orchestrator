import { expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { hasWindowsPrivateProfileDirectoryDelivery, prepareWindowsPrivateDirectories } from './OpenCodePrivateDirectories.js'
import type { WindowsOwnerDirectory } from '../host/windows/OpenCodeV2WindowsOwnerFilesystem.js'

// This contract exercises the creation/retention boundary on real temporary
// paths. It does not claim native Windows ACL qualification on another OS.
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-private-directories-')))
  const calls: string[] = [], live = new Set<string>()
  const handle = (directory: string): WindowsOwnerDirectory => {
    live.add(directory)
    return {
      identity: { volumeSerial: '1', fileId: '0'.repeat(32), ownerSid: 'S-1-5-21-1' },
      assertOwned: async () => { expect(live.has(directory)).toBe(true) },
      close: async () => { calls.push(`close:${directory}`); live.delete(directory) },
      writeExclusive: async () => { throw new Error('unused') }, readRecord: async () => { throw new Error('unused') },
      readMetadata: async () => { throw new Error('unused') }, archive: async () => { throw new Error('unused') },
    }
  }
  const filesystem = {
    openDirectory: async (directory: string) => { calls.push(`open:${directory}`); return handle(directory) },
    createDirectory: async (directory: string) => {
      expect(live.has(path.dirname(directory)) || path.dirname(directory) === root).toBe(true)
      calls.push(`create:${directory}`); await mkdir(directory); return handle(directory)
    },
  }
  return { root, calls, live, filesystem, remove: () => rm(root, { recursive: true, force: true }) }
}

test('missing owned namespace components use exclusive native creation with retained parents', async () => {
  const f = await fixture()
  try {
    const namespace = path.join(f.root, 'opencode'), profile = path.join(namespace, 'profiles', 'TEST')
    await prepareWindowsPrivateDirectories([profile], f.filesystem)
    expect((await lstat(profile)).isDirectory()).toBe(true)
    expect(f.calls.filter(call => call.startsWith('create:'))).toEqual([
      `create:${namespace}`, `create:${path.dirname(profile)}`, `create:${profile}`,
    ])
    expect(f.live.size).toBe(0)
    expect(f.calls).not.toContain(`open:${f.root}`)
  } finally { await f.remove() }
})

test('unsafe existing namespace is refused without repair, replacement or deleting retained data', async () => {
  const f = await fixture()
  try {
    const namespace = path.join(f.root, 'opencode'), marker = path.join(namespace, 'TEST-preserved')
    await mkdir(namespace); await writeFile(marker, 'TEST-original')
    await expect(prepareWindowsPrivateDirectories([namespace, path.join(namespace, 'profiles')], {
      ...f.filesystem, openDirectory: async () => { throw new Error('execution_owner_not_private') },
    })).rejects.toThrow('execution_owner_not_private')
    expect(await readFile(marker, 'utf8')).toBe('TEST-original')
    expect(f.calls).toEqual([])
    await expect(prepareWindowsPrivateDirectories([namespace], f.filesystem, [namespace])).rejects.toThrow('execution_profile_owned')
  } finally { await f.remove() }
})

test('uncertain partial creation is retained and a competing creator is never reopened', async () => {
  const f = await fixture()
  try {
    const namespace = path.join(f.root, 'opencode')
    await expect(prepareWindowsPrivateDirectories([namespace], {
      ...f.filesystem, createDirectory: async directory => {
        await mkdir(directory); throw new Error('execution_native_unknown')
      },
    })).rejects.toThrow('execution_native_unknown')
    expect((await lstat(namespace)).isDirectory()).toBe(true)
    expect(f.calls).toEqual([])
    expect(f.live.size).toBe(0)
  } finally { await f.remove() }
})


test('V1 compiled, ARM64 and source-only deliveries do not require V2 native assets', async () => {
  const f = await fixture()
  try {
    const context = { platform: 'win32', arch: 'x64',
      moduleUrl: pathToFileURL(path.join(f.root, 'src/services/opencode/profile/OpenCodePrivateDirectories.ts')).href,
      entrypoint: path.join(f.root, 'cli-source') }
    expect(await hasWindowsPrivateProfileDirectoryDelivery(context)).toBe(false)
    await mkdir(path.join(f.root, 'native', 'win32-x64'), { recursive: true })
    // Even incomplete delivery selects mandatory native validation, not fallback.
    expect(await hasWindowsPrivateProfileDirectoryDelivery(context)).toBe(true)
    expect(await hasWindowsPrivateProfileDirectoryDelivery({ ...context, arch: 'arm64' })).toBe(false)
    expect(await hasWindowsPrivateProfileDirectoryDelivery({ ...context, moduleUrl: 'file:///C:/~BUN/root/cli.js' })).toBe(false)
    expect(await hasWindowsPrivateProfileDirectoryDelivery({ ...context, entrypoint: '/$bunfs/root/cli' })).toBe(false)
  } finally { await f.remove() }
})
