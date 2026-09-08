import { dlopen, FFIType, ptr } from 'bun:ffi'
import { readdirSync } from 'node:fs'

export function signal<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

// Linux-only fixture: identify TCP descriptors by kernel local port, never by
// a private Bun handle. In the isolated broker child, all sockets are ours.
const libc = dlopen('libc.so.6', {
  getsockname: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  getpeername: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
})

// Retain a kernel observation handle across Bun's close callback. A native
// close after local SHUT_WR need not emit end. Neither close nor an exact
// payload proves EOF: a positive-length, non-consuming recv must return zero.
// This duplicate never writes, shuts down, drains data, or manufactures FIN.
export function retainUnixEOF(peerPath: string) {
  const matches: number[] = []
  for (const name of readdirSync('/proc/self/fd')) {
    const fd = Number(name)
    if (fd < 4) continue
    const address = Buffer.alloc(128), length = new Uint32Array([128])
    if (libc.symbols.getpeername(fd, ptr(address), ptr(length)) !== 0 || address.readUInt16LE(0) !== 1) continue
    const path = address.subarray(2, length[0]).toString().replace(/\0.*$/, '')
    if (path === peerPath) matches.push(fd)
  }
  if (matches.length !== 1) throw new Error(`Expected one fixture peer descriptor, found ${matches.length}`)
  let fd = libc.symbols.fcntl(matches[0]!, 1030, 4) // F_DUPFD_CLOEXEC
  if (fd < 0) throw new Error('Cannot retain fixture EOF descriptor')
  return {
    peek() {
      if (fd < 0) throw new Error('EOF descriptor already released')
      const byte = Buffer.alloc(1)
      return Number(libc.symbols.recv(fd, ptr(byte), 1, 2 | 64)) // MSG_PEEK | MSG_DONTWAIT
    },
    release() { if (fd >= 0) { const owned = fd; fd = -1; libc.symbols.close(owned) } },
  }
}
export function constrainSockets(localPort?: number, notificationFD?: number): number[] {
  const sizes: number[] = []
  for (const name of readdirSync('/proc/self/fd')) {
    const fd = Number(name)
    // Inherited 'pipe' can be a socketpair: do not constrain diagnostic FD4.
    if (fd < 4 || fd === notificationFD) continue // leave private bootstrap FD3 alone
    const address = Buffer.alloc(128), length = new Uint32Array([128])
    if (libc.symbols.getsockname(fd, ptr(address), ptr(length)) !== 0) continue
    if (localPort !== undefined && (address.readUInt16LE(0) !== 2 || address.readUInt16BE(2) !== localPort)) continue
    // Keep the child receive window large enough to deliver chunks exceeding
    // the constrained UDS send capacity. Targets constrain both directions.
    for (const option of localPort === undefined ? [7] : [7, 8]) { // SO_SNDBUF / SO_RCVBUF
      const value = new Int32Array([4096]), size = new Uint32Array([4])
      if (libc.symbols.setsockopt(fd, 1, option, ptr(value), 4) !== 0 ||
          libc.symbols.getsockopt(fd, 1, option, ptr(value), ptr(size)) !== 0) {
        throw new Error('Fixture socket buffer constraint failed')
      }
      if (value[0]! < 4096 || value[0]! > 16384) throw new Error('Kernel did not retain constrained fixture buffers')
      sizes.push(value[0]!)
    }
  }
  if (!sizes.length) throw new Error('Fixture found no owned socket descriptors')
  return sizes
}

export type WriteObservation = { requested: number; accepted: number }
// Independent single-message endpoint writer, deliberately no production
// imports, queue, source pause/resume, reentrant scheduler or shared oracle.
// Positive native progress is retried immediately; a real zero waits for drain.
export class EndpointWriter {
  private bytes = Buffer.alloc(0)
  private offset = 0
  private finishing = false
  private stopped = false
  finSent = false
  constructor(private socket: Bun.Socket, private observe: (value: WriteObservation) => void = () => {}, private finished: () => void = () => {}) {}
  push(bytes: Buffer) {
    if (this.bytes.length) throw new Error('Fixture supports one message only')
    this.bytes = Buffer.from(bytes)
    this.drain()
  }
  end() { this.finishing = true; this.drain() }
  stop() { this.stopped = true }
  drain() {
    if (this.stopped || this.finSent) return
    while (this.offset < this.bytes.length) {
      const remaining = this.bytes.subarray(this.offset)
      const count = this.socket.write(remaining)
      this.observe({ requested: remaining.length, accepted: count })
      if (!Number.isInteger(count) || count < 0 || count > remaining.length) {
        this.stop(); this.socket.terminate(); return
      }
      this.offset += count
      if (count === 0) return
    }
    if (this.finishing) { this.finSent = true; this.socket.shutdown(false); this.finished() }
  }
}

export function patterned(length: number, seed: number) {
  const bytes = Buffer.alloc(length)
  // No repeated 32-byte credential run can occur in this pattern.
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + (i >>> 8) * 17 + seed) & 255
  return bytes
}

// Native 34cbb9a40 close's second argument is unknown, not a numeric code.
// Keep read errors visible even when no separate error callback is delivered.
export function closeArgument(value: unknown) {
  if (value === undefined) return { argumentKind: 'undefined' as const }
  if (value instanceof Error) {
    const error = value as NodeJS.ErrnoException
    return { argumentKind: 'Error' as const, message: error.message,
      code: error.code ?? null, errno: error.errno ?? null, syscall: error.syscall ?? null }
  }
  if (typeof value === 'number') return { argumentKind: 'number' as const,
    value: Number.isFinite(value) ? value : String(value) }
  return { argumentKind: 'other' as const, value: String(value) }
}
