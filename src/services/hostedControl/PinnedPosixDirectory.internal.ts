import { dlopen, FFIType, ptr } from 'bun:ffi'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync } from 'node:fs'

const libcPath = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'
const libc = process.platform === 'win32' ? null : dlopen(libcPath, {
  openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  mknodat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.u64], returns: FFIType.i32 },
  renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  linkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  fstatat: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const)
const AT_SYMLINK_NOFOLLOW = process.platform === 'darwin' ? 0x0020 : 0x0100

function name(value: string): Buffer {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('Unsafe pinned-directory child name')
  }
  return Buffer.from(`${value}\0`)
}

export class PinnedPosixDirectory {
  private constructor(readonly path: string, readonly fd: number, readonly identity: { dev: number | bigint; ino: number | bigint }) {}

  static async open(path: string): Promise<PinnedPosixDirectory> {
    if (!libc) throw new Error('Pinned durable namespace requires POSIX *at support')
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = fstatSync(fd); const linked = lstatSync(path)
      if (!stat.isDirectory() || !linked.isDirectory() || linked.isSymbolicLink() ||
        stat.dev !== linked.dev || stat.ino !== linked.ino || (stat.mode & 0o022) !== 0 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
        throw new Error('Unsafe pinned durable directory')
      }
      return new PinnedPosixDirectory(path, fd, { dev: stat.dev, ino: stat.ino })
    } catch (error) { closeSync(fd); throw error }
  }

  assertLinked(): void {
    const opened = fstatSync(this.fd); const linked = lstatSync(this.path)
    if (!opened.isDirectory() || !linked.isDirectory() || linked.isSymbolicLink() ||
      opened.dev !== this.identity.dev || opened.ino !== this.identity.ino ||
      linked.dev !== this.identity.dev || linked.ino !== this.identity.ino ||
      (opened.mode & 0o022) !== 0) throw new Error('Pinned durable directory was replaced')
  }

  openChild(child: string, flags: number): number {
    if (!libc) throw new Error('Pinned durable namespace requires POSIX *at support')
    const encoded = name(child); const fd = libc.symbols.openat(this.fd, ptr(encoded), flags | (constants.O_NOFOLLOW ?? 0))
    if (fd < 0) throw new Error(`Pinned durable open failed: ${child}`)
    return fd
  }

  createExclusive(child: string): number {
    if (!libc) throw new Error('Pinned durable namespace requires POSIX *at support')
    const encoded = name(child)
    if (libc.symbols.mknodat(this.fd, ptr(encoded), constants.S_IFREG | 0o600, 0) !== 0) {
      throw new Error(`Pinned durable create failed: ${child}`)
    }
    try { return this.openChild(child, constants.O_RDWR) } catch (error) { this.unlink(child); throw error }
  }

  exists(child: string): boolean {
    if (!libc) return false
    const encoded = name(child); const stat = Buffer.alloc(512)
    return libc.symbols.fstatat(this.fd, ptr(encoded), ptr(stat), AT_SYMLINK_NOFOLLOW) === 0
  }

  link(from: string, to: string): void {
    if (!libc || libc.symbols.linkat(this.fd, ptr(name(from)), this.fd, ptr(name(to)), 0) !== 0) {
      throw new Error('Pinned durable link failed')
    }
  }

  rename(from: string, to: string): void {
    if (!libc || libc.symbols.renameat(this.fd, ptr(name(from)), this.fd, ptr(name(to))) !== 0) {
      throw new Error('Pinned durable rename failed')
    }
  }

  unlink(child: string): void {
    if (!libc || libc.symbols.unlinkat(this.fd, ptr(name(child)), 0) !== 0) {
      throw new Error('Pinned durable unlink failed')
    }
  }

  unlinkIfExists(child: string): void { if (this.exists(child)) this.unlink(child) }
  async sync(): Promise<void> { fsyncSync(this.fd) }
  async close(): Promise<void> { closeSync(this.fd) }
}

export function flockPinned(fd: number, operation: number): boolean {
  return !!libc && libc.symbols.flock(fd, operation) === 0
}

export function closePinnedFd(fd: number): void { closeSync(fd) }
