import { expect, mock, test } from 'bun:test'
import * as realFs from 'node:fs'
import { createHash } from 'node:crypto'

// Run this process-global fs model in its own Bun invocation. It exercises the
// real walker and streaming hasher; root separately proves actual Linux mounts.
const size = 33 * 1024 * 1024 + 13
const stat = (directory = false, inode = 2n) => ({ dev: 1n, ino: inode, size: directory ? 0n : BigInt(size),
  mode: directory ? 0o40500n : 0o100500n, nlink: 1n, uid: 0n, gid: 0n, mtimeNs: 1n, ctimeNs: 1n,
  isDirectory: () => directory, isFile: () => !directory })
type Handle = { kind: 'root' | 'dir' | 'image' | 'text'; text?: Buffer; offset?: number; identity?: ReturnType<typeof stat> }
let next = 100, mountReadonly = true, corrupt = false, truncated = false, failDuplicate = false
let current = stat(), largestImageRead = 0
const handles = new Map<number, Handle>()
function content(buffer: Buffer, offset: number, length: number, position: number) {
  buffer.fill(0, offset, offset + length)
  const magic = [0x7f, 0x45, 0x4c, 0x46]
  for (let i = 0; i < 4; i++) if (i >= position && i < position + length) buffer[offset + i - position] = magic[i]
  if (corrupt && position + length === size) buffer[offset + length - 1] = 1
}
const expected = createHash('sha256'), scratch = Buffer.alloc(64 * 1024)
for (let offset = 0; offset < size;) {
  const count = Math.min(scratch.length, size - offset); content(scratch, 0, count, offset)
  expected.update(scratch.subarray(0, count)); offset += count
}
const pin = { relativePath: 'bin/hosted-owner', device: '1', inode: '2', size, mode: 0o500, sha256: expected.digest('hex') }
const fresh = () => {
  handles.clear(); handles.set(10, { kind: 'root' }); current = stat()
  mountReadonly = true; corrupt = false; truncated = false; failDuplicate = false; largestImageRead = 0
}
mock.module('node:fs', () => ({ ...realFs,
  openSync(path: string, flags: number) {
    let value: Handle
    if (path === '/proc/self/mountinfo') value = { kind: 'text', text: Buffer.from(
      `42 1 8:1 / /p3b2 ${mountReadonly ? 'ro' : 'rw'},nosuid - ext4 /dev/test rw\n`) }
    else if (/^\/proc\/self\/fdinfo\/\d+$/.test(path)) value = { kind: 'text', text: Buffer.from('mnt_id:\t42\n') }
    else {
      const match = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(path)
      if (!match || !handles.has(Number(match[1]))) throw new Error('EBADF')
      const parent = handles.get(Number(match[1]))!
      if (!match[2]) {
        if (failDuplicate) throw new Error('duplicate_failed')
        expect(flags & 0o2000000).not.toBe(0)
        value = { ...parent }
      } else {
        expect(flags & realFs.constants.O_NOFOLLOW).not.toBe(0)
        if (parent.kind === 'root' && match[2] === 'bin') value = { kind: 'dir' }
        else if (parent.kind === 'dir' && match[2] === 'hosted-owner') value = { kind: 'image', identity: current }
        else throw new Error('unexpected_path')
      }
    }
    const fd = next++; handles.set(fd, value); return fd
  },
  fstatSync(fd: number) {
    const h = handles.get(fd); if (!h) throw new Error('EBADF')
    return h.kind === 'image' ? { ...h.identity! } : stat(h.kind === 'root' || h.kind === 'dir', 1n)
  },
  readSync(fd: number, bytes: Buffer, offset: number, length: number, position: number | null) {
    const h = handles.get(fd); if (!h) throw new Error('EBADF')
    if (h.kind === 'text') {
      const start = h.offset ?? 0, count = Math.min(length, h.text!.length - start)
      h.text!.copy(bytes, offset, start, start + count); h.offset = start + count; return count
    }
    if (h.kind !== 'image' || position === null) throw new Error('unexpected_read')
    largestImageRead = Math.max(largestImageRead, length)
    if (truncated && position > 0) return 0
    const count = Math.min(length, size - position); content(bytes, offset, count, position); return count
  },
  closeSync(fd: number) { if (!handles.delete(fd)) throw new Error('double_close') },
}))
const { retainReadonlyImage, readReadonlyArtifact } = await import('./native-readonly-artifact.js')

test('33 MiB ELF streams in at most 64 KiB reads and retains only its owned CLOEXEC image', () => {
  fresh()
  expect(() => readReadonlyArtifact(10, pin, 32 * 1024 * 1024)).toThrow(/pin/)
  expect(() => readReadonlyArtifact(10, pin, size)).toThrow(/pin/)
  const image = retainReadonlyImage(10, pin)
  expect(largestImageRead).toBeLessThanOrEqual(64 * 1024)
  expect(handles.size).toBe(2)
  image.assertCurrent(); expect(handles.size).toBe(2)
  image.close(); image.close()
  expect([...handles.keys()]).toEqual([10])
  expect(() => image.assertCurrent()).toThrow(/image_closed/)
})

test('retained old inode cannot authorize path replacement, writable remount or changed bytes', () => {
  for (const change of [() => { current = stat(false, 99n) }, () => { mountReadonly = false },
    () => { corrupt = true }, () => { current.mode = 0o100555n }]) {
    fresh(); const image = retainReadonlyImage(10, pin)
    change(); expect(() => image.assertCurrent()).toThrow()
    image.close(); expect([...handles.keys()]).toEqual([10])
  }
})

test('partial verification and duplicate failures close all owned handles; size/deadline remain bounded', () => {
  for (const change of [() => { truncated = true }, () => { corrupt = true }, () => { failDuplicate = true }]) {
    fresh(); change(); expect(() => retainReadonlyImage(10, pin)).toThrow()
    expect([...handles.keys()]).toEqual([10])
  }
  fresh()
  expect(() => retainReadonlyImage(-1, { ...pin, size: 1024 ** 3 + 1 })).toThrow(/pin/)
  expect(() => retainReadonlyImage(-1, pin, 0)).toThrow(/deadline/)
  expect([...handles.keys()]).toEqual([10])
})
