import { expect, mock, test } from 'bun:test'
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import type { DescriptorSnapshotV2 } from './HostedControlBootstrapV2Descriptors.js'

// Process-global filesystem model: run separately. It proves the identity
// predicates, not FD-exec or actual read-only mount authority.
const realReadFile = fs.readFileSync
const imageBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46]), sourceBytes = Buffer.from('src!')
const imageStat = { dev: 1n, ino: 2n, size: 4n, mode: 0o100500n, nlink: 1n, uid: 0n, gid: 0n,
  mtimeNs: 1n, ctimeNs: 1n, isFile: () => true }
const fixed = '/p3b2/bin/hosted-owner'
let mounted = { ...imageStat }, spawned = { ...imageStat }, next = 100
const opened = new Map<number, string>()
const reset = () => { mounted = { ...imageStat }; spawned = { ...imageStat }; opened.clear() }
const stat = (path: string) => path === fixed ? { ...mounted } : path === process.execPath ? { ...spawned } :
  path === '/source.ts' ? { ...imageStat, ino: 3n } : { ...imageStat }
mock.module('node:fs', () => ({ ...fs,
  statSync: stat, lstatSync: stat,
  fstatSync(fd: number) { return stat(fd === 11 ? '/proc/self/exe' : opened.get(fd)!) },
  openSync(path: string) { const fd = next++; opened.set(fd, path); return fd },
  closeSync(fd: number) { if (!opened.delete(fd)) throw new Error('unexpected_close') },
  readFileSync(path: string, encoding: any) { return realReadFile(path, encoding) },
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
    const bytes = opened.get(fd) === '/source.ts' ? sourceBytes : imageBytes
    const count = Math.min(length, bytes.length - position)
    bytes.copy(buffer, offset, position, position + count); return count
  },
}))
const { assertCompiledOwnerImageCurrent, observeExecutingOwnerV2 } = await import('./HostedControlBootstrapV2Launch.js')
const { createOwnerProvenanceNodeOperations } = await import('./HostedApprovalOwnerProvenance.js')
const expected = { device: '1', inode: '2', size: 4 }
const anchor = { device: '1', inode: '2', size: '4' } as DescriptorSnapshotV2

test('fixed compiled module binds mounted path, executing image, spawn image and FD11 digest', () => {
  reset(); assertCompiledOwnerImageCurrent(expected)
  const observed = observeExecutingOwnerV2(anchor, fixed, Infinity)
  expect(observed.moduleSha256).toBe(createHash('sha256').update(imageBytes).digest('hex'))
  expect(observed.moduleSha256).toBe(observed.executableSha256)
  expect(opened.size).toBe(0) // hash handles closed; borrowed FD11 remains caller-owned
  expect(() => observeExecutingOwnerV2({ ...anchor, inode: '99' }, fixed, Infinity)).toThrow(/executed_anchor/)
})

test('substituted mounted image, symlink, wrong mode and broker spawn executable fail closed', () => {
  for (const change of [() => { mounted.ino = 99n }, () => { mounted.mode = 0o100555n },
    () => { mounted.isFile = () => false }, () => { spawned.ino = 99n }]) {
    reset(); change(); expect(() => assertCompiledOwnerImageCurrent(expected)).toThrow(/compiled_image_identity/)
  }
})

test('source identity remains separate, while provenance rejects a physically different compiled module', () => {
  reset()
  const observed = observeExecutingOwnerV2(anchor, '/source.ts', Infinity)
  expect(observed.moduleSha256).not.toBe(observed.executableSha256)
  const operations = createOwnerProvenanceNodeOperations()
  expect(operations.identity('/source.ts').moduleSha256).toBe(observed.moduleSha256)
  expect(operations.identity(fixed).moduleSha256).toBe(observed.executableSha256)
  mounted.ino = 99n // identical bytes are insufficient
  expect(() => operations.identity(fixed)).toThrow(/owner-provenance-compiled-image/)
  expect(opened.size).toBe(0)
})
