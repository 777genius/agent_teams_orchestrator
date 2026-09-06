import { dlopen, FFIType, ptr, read as readNative } from 'bun:ffi'
import { closeSync, fstatSync, readlinkSync, readSync, statSync, type BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { canonicalV2, OWNER_V2_ROLES, requireV2, type OwnerDescriptorV2, type OwnerV2Role } from './HostedControlBootstrapV2Wire.js'

// Same in-process libc primitive as PinnedPosixDirectory. No fork, executable,
// pathname reopen of an inherited resource, or caller-supplied seal assertion.
const libc = process.platform === 'linux' ? dlopen('libc.so.6', {
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  getpeername: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
} as const) : null
const GETFL = 3, SETFL = 4, GETFD = 1, SETFD = 2, GET_SEALS = 1034
const NONBLOCK = 0o4000, APPEND = 0o2000
export type DescriptorSnapshotV2 = OwnerDescriptorV2 & Readonly<{
  size: string; nlink: string; mtimeNs: string; ctimeNs: string; seals: number | null; target: string
}>
export function beforeDeadlineV2(deadline: number): void { requireV2(performance.now() < deadline, 'deadline') }
export function flagsV2(fd: number): number {
  requireV2(libc, 'linux_required'); const n = libc.symbols.fcntl(fd, GETFL, 0)
  requireV2(n >= 0, 'descriptor_flags'); return n
}
export function protectDescriptorV2(fd: number): void {
  requireV2(libc, 'linux_required'); const flags = libc.symbols.fcntl(fd, GETFD, 0)
  requireV2(flags >= 0 && libc.symbols.fcntl(fd, SETFD, flags | 1) === 0, 'close_on_exec')
}
export function nonblockV2(fd: number): void {
  requireV2(libc && libc.symbols.fcntl(fd, SETFL, flagsV2(fd) | NONBLOCK) === 0, 'nonblock')
}
function connectedV2(fd: number): void {
  requireV2(libc, 'linux_required')
  const type = new Int32Array(1), length = new Uint32Array([4]), peer = Buffer.alloc(128)
  requireV2(libc.symbols.getsockopt(fd, 1, 3, ptr(type), ptr(length)) === 0 && type[0] === 1, 'stream_socket')
  length[0] = peer.length
  requireV2(libc.symbols.getpeername(fd, ptr(peer), ptr(length)) === 0 && length[0] >= 2 &&
    peer.readUInt16LE(0) === 1, 'connected_socket') // AF_UNIX, the native launcher's socketpair
}
export function snapshotV2(role: OwnerV2Role): DescriptorSnapshotV2 {
  const fd = OWNER_V2_ROLES[role], s = fstatSync(fd, { bigint: true }), flags = flagsV2(fd)
  const linked = statSync(`/proc/self/fd/${fd}`, { bigint: true })
  requireV2(s.dev === linked.dev && s.ino === linked.ino, 'proc_fd_identity')
  const kind = s.isFile() ? 'regular-file' : s.isFIFO() ? 'fifo' : s.isSocket() ? 'socket' : null
  requireV2(kind, 'descriptor_kind')
  if (kind === 'socket') connectedV2(fd)
  const accessMode = (['read-only', 'write-only', 'read-write'] as const)[flags & 3]
  requireV2(accessMode, 'access_mode')
  return Object.freeze({ role, childFd: fd, kind, accessMode, append: !!(flags & APPEND),
    device: String(s.dev), inode: String(s.ino), uid: Number(s.uid), gid: Number(s.gid), mode: Number(s.mode & 0o7777n),
    size: String(s.size), nlink: String(s.nlink), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs),
    seals: role === 'sealed-launcher-lease' ? libc!.symbols.fcntl(fd, GET_SEALS, 0) : null,
    target: readlinkSync(`/proc/self/fd/${fd}`) })
}
export function descriptorRowV2(d: DescriptorSnapshotV2): OwnerDescriptorV2 {
  const { role, childFd, kind, device, inode, uid, gid, mode, accessMode, append } = d
  return { role, childFd, kind, device, inode, uid, gid, mode, accessMode, append }
}
export function sameDescriptorV2(before: DescriptorSnapshotV2, after: DescriptorSnapshotV2, growing = false): boolean {
  return canonicalV2(descriptorRowV2(before)) === canonicalV2(descriptorRowV2(after)) &&
    before.nlink === after.nlink && before.seals === after.seals && before.target === after.target &&
    (growing ? BigInt(after.size) >= BigInt(before.size) : before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs)
}
export function snapshotAllV2(): readonly DescriptorSnapshotV2[] {
  const rows = (Object.keys(OWNER_V2_ROLES) as OwnerV2Role[]).map(snapshotV2)
  requireV2(new Set(rows.map(r => `${r.device}:${r.inode}`)).size === 8, 'descriptor_alias')
  for (const r of rows) {
    requireV2(r.uid === process.getuid!() && r.gid === process.getgid!(), 'descriptor_owner')
    if (r.role === 'sealed-launcher-lease') {
      requireV2(r.kind === 'regular-file' && r.accessMode === 'read-only' && !r.append && r.mode === 0o600 &&
        r.nlink === '0' && /^\/?memfd:/.test(r.target) && r.seals !== null && r.seals >= 0 && (r.seals & 15) === 15 &&
        BigInt(r.size) > 0n && BigInt(r.size) <= 65536n, 'sealed_lease')
    } else if (r.role === 'executable-anchor') {
      requireV2(r.kind === 'regular-file' && r.accessMode === 'read-only' && !r.append && r.mode === 0o500 &&
        r.nlink === '1' && BigInt(r.size) > 0n && BigInt(r.size) <= 1024n ** 3n, 'executable_anchor')
    } else if (r.role === 'raw-opencode-retention' || r.role === 'owner-wal-native') {
      requireV2(r.kind === 'regular-file' && r.accessMode === 'write-only' && r.append && r.mode === 0o600 &&
        r.nlink === '1' && (r.role === 'owner-wal-native' ? r.size === '0' : BigInt(r.size) <= 64n * 1024n ** 2n), 'writer')
    } else {
      requireV2(!r.append && (r.kind === 'socket' && r.accessMode === 'read-write' ||
        r.role !== 'activation-v2' && r.kind === 'fifo' && r.accessMode === 'read-only'), 'input')
    }
    protectDescriptorV2(r.childFd)
  }
  return Object.freeze(rows)
}
export function readLeaseBytesV2(snapshot: DescriptorSnapshotV2): Buffer {
  const bytes = Buffer.alloc(Number(snapshot.size)); let offset = 0
  try {
    while (offset < bytes.length) {
      const n = readSync(3, bytes, offset, bytes.length - offset, offset)
      requireV2(n > 0, 'lease_eof'); offset += n
    }
    requireV2(sameDescriptorV2(snapshot, snapshotV2('sealed-launcher-lease')), 'lease_changed')
    return bytes
  } catch (error) { bytes.fill(0); throw error }
}
export function hashDescriptorV2(fd: number, expected: BigIntStats, deadline: number): string {
  requireV2(expected.isFile() && expected.size > 0n && expected.size <= 1024n ** 3n, 'image_size')
  const scratch = Buffer.alloc(64 * 1024), hash = createHash('sha256'); let offset = 0
  try {
    while (BigInt(offset) < expected.size) {
      beforeDeadlineV2(deadline)
      const n = readSync(fd, scratch, 0, Math.min(scratch.length, Number(expected.size) - offset), offset)
      requireV2(n > 0, 'image_eof'); hash.update(scratch.subarray(0, n)); offset += n
    }
    const after = fstatSync(fd, { bigint: true })
    requireV2(['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs'].every(k =>
      after[k as keyof BigIntStats] === expected[k as keyof BigIntStats]), 'image_changed')
    return hash.digest('hex')
  } finally { scratch.fill(0) }
}
// Ownership is detached BEFORE close or transfer. Never close a consumed numeric
// slot again: other runtime activity can immediately reuse FD4, FD7 or FD11.
export class OwnedDescriptorV2 {
  #fd: number | null
  constructor(fd: number) { this.#fd = fd }
  get fd(): number { requireV2(this.#fd !== null, 'descriptor_consumed'); return this.#fd }
  take(): number { const fd = this.fd; this.#fd = null; return fd }
  close(): void { if (this.#fd !== null) { const fd = this.take(); try { closeSync(fd) } catch {} } }
}

/** Nonblocking libc reads are cancellable even for FIFOs. No libuv worker can
 * remain stuck in a blocking read after the absolute deadline or peer failure. */
export async function readOneUseV2(owner: OwnedDescriptorV2, maximum: number, deadline: number, signal: AbortSignal): Promise<Buffer> {
  const bytes = Buffer.alloc(maximum + 1); let offset = 0
  try {
    nonblockV2(owner.fd)
    for (;;) {
      beforeDeadlineV2(deadline); signal.throwIfAborted()
      const n = readAvailableV2(owner.fd, bytes.subarray(offset))
      if (n === 0) return Buffer.from(bytes.subarray(0, offset))
      if (n > 0) { offset += n; requireV2(offset <= maximum, 'frame_overflow'); continue }
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(2, Math.max(1, deadline - performance.now()))))
    }
  } finally { bytes.fill(0); owner.close() }
}
export function readAvailableV2(fd: number, bytes: Buffer): number {
  requireV2(libc, 'linux_required')
  const n = Number(libc.symbols.read(fd, ptr(bytes), bytes.length))
  if (n >= 0) return n
  const errno = readNative.i32(libc.symbols.__errno_location()!)
  requireV2(errno === 11 || errno === 4, 'stream_read') // EAGAIN / EINTR
  return -1
}
