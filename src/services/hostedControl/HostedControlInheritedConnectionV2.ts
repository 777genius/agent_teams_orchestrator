import { EventEmitter } from 'node:events'
import { closeSync } from 'node:fs'
import { dlopen, FFIType, ptr, read } from 'bun:ffi'
import type { OwnedDescriptorV2 } from './HostedControlBootstrapV2Descriptors.js'
import type { HostedControlConnection, HostedControlConnectionEvents } from './HostedControlConnection.js'

// Bun 1.3.11 does not read an inherited socketpair through node:net.Socket({fd}).
// Operate on the admitted open descriptor, without changing flags or making a
// duplicate. MSG_DONTWAIT bounds every syscall; MSG_NOSIGNAL suppresses SIGPIPE.
const native = process.platform === 'linux' ? dlopen('libc.so.6', {
  poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  send: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  shutdown: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
} as const) : null
const DONTWAIT = 0x40, NOSIGNAL = 0x4000, PEEK = 2
const CHUNK = 16 * 1024, HIGH_WATER = 64 * 1024, MAX_QUEUED = 2 * HIGH_WATER
const MAX_WRITES = 4, WRITE_DEADLINE_MS = 5000, POLL_MS = 2
type Write = { bytes: Buffer; offset: number; deadline: number; done?: (error?: Error | null) => void }
export function socketCookieV2(fd: number): bigint {
  const bytes = Buffer.alloc(8), size = new Uint32Array([8])
  if (native!.symbols.getsockopt(fd, 1, 57, ptr(bytes), ptr(size)) !== 0 || size[0] !== 8) {
    throw new Error('hosted_owner_v2_activation_socket_cookie')
  }
  return bytes.readBigUInt64LE(0) // Linux SO_COOKIE: identity survives peer loss, never follows FD reuse.
}
function result(n: number): number {
  if (n >= 0) return n
  // Read thread-local errno before any other native call.
  const errno = read.i32(native!.symbols.__errno_location()!)
  if (errno === 11 || errno === 4) return -1 // EAGAIN (also EWOULDBLOCK on Linux), EINTR
  throw new Error(`hosted_owner_v2_activation_io_${errno}`)
}

/** Internal byte transport, not launch authority. The resource supplies the
 * admitted identity check. It must remain synchronous and must not close FDs. */
export class HostedControlInheritedConnectionV2 extends EventEmitter<HostedControlConnectionEvents> implements HostedControlConnection {
  #fd: number | null
  #paused = true
  #ending = false
  #ended = false
  #endDeadline = Infinity
  readonly #cookie: bigint
  #queue: Write[] = []
  #queuedBytes = 0
  #backpressured = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #idleMs = 0
  #idleAt = Infinity
  readonly #scratch = Buffer.alloc(CHUNK)
  constructor(owner: OwnedDescriptorV2, private readonly matchesIdentity: (fd: number) => boolean) {
    super()
    if (!native || !matchesIdentity(owner.fd)) throw new Error('hosted_owner_v2_activation_descriptor')
    this.#cookie = socketCookieV2(owner.fd)
    this.#fd = owner.take()
    // Closing an unobserved resource must still be safe before server attachment.
    this.on('error', () => undefined)
  }
  get destroyed(): boolean { return this.#fd === null }
  #sameSocket(fd: number): boolean { try { return socketCookieV2(fd) === this.#cookie } catch { return false } }
  #currentFd(): number {
    const fd = this.#fd
    if (fd === null || !this.matchesIdentity(fd) || !this.#sameSocket(fd)) throw new Error('hosted_owner_v2_activation_descriptor_changed')
    return fd
  }
  /** Generic currency permits pending prepare/publication bytes. */
  isCurrent(): boolean {
    if (this.destroyed) return false
    try {
      const fd = this.#currentFd()
      if (result(Number(native!.symbols.recv(fd, ptr(this.#scratch), 1, DONTWAIT | PEEK))) !== 0) return true
      this.#eof()
    } catch (error) { this.destroy(error as Error) }
    return false
  }
  /** Synchronous effect-only observation. poll sees SHUT_WR behind queued
   * bytes; peek neither consumes protocol input nor changes descriptor flags.
   * Only the leased phase forbids pending input. Fail closed on EINTR/errors. */
  isEffectCurrent(rejectPending: boolean): boolean {
    if (this.destroyed) return false
    try {
      const fd = this.#currentFd(), pollfd = Buffer.alloc(8)
      pollfd.writeInt32LE(fd, 0)
      pollfd.writeInt16LE(0x2001, 4) // POLLIN | POLLRDHUP (Linux)
      const n = native!.symbols.poll(ptr(pollfd), 1, 0)
      if (n < 0 || (pollfd.readUInt16LE(6) & 0x2038)) {
        throw new Error('hosted_owner_v2_activation_peer_closed') // RDHUP/HUP/ERR/NVAL
      }
      const pending = Number(native!.symbols.recv(fd, ptr(this.#scratch), 1, DONTWAIT | PEEK))
      if (pending < 0) {
        const errno = read.i32(native!.symbols.__errno_location()!)
        if (errno === 11) return true // EAGAIN only; uncertainty rejects effects.
      } else if (pending > 0 && !rejectPending) return true
      throw new Error('hosted_owner_v2_activation_effect_input')
    } catch (error) { this.destroy(error as Error); return false }
  }
  pause(): this { this.#paused = true; return this }
  resume(): this { this.#paused = false; this.#schedule(); return this }
  setTimeout(milliseconds: number, callback?: () => void): this {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('Invalid transport timeout')
    if (callback) this.once('timeout', callback)
    this.#idleMs = milliseconds; this.#activity(); this.#schedule(); return this
  }
  #activity(): void { this.#idleAt = this.#idleMs ? performance.now() + this.#idleMs : Infinity }
  write(data: string | Uint8Array, done?: Write['done']): boolean {
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
    if (this.destroyed || this.#ending || size > HIGH_WATER ||
      this.#queue.length >= MAX_WRITES || this.#queuedBytes + size > MAX_QUEUED) {
      const error = new Error('hosted_owner_v2_activation_write_rejected')
      this.destroy(error); queueMicrotask(() => done?.(error)); return false
    }
    // Copy only after admission to the bounded queue. Callers cannot change a
    // frame during a partial send. Completion always occurs on a later turn.
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    this.#queue.push({ bytes, offset: 0, deadline: performance.now() + WRITE_DEADLINE_MS, done })
    this.#queuedBytes += size
    this.#backpressured ||= this.#queuedBytes >= HIGH_WATER || this.#queue.length === MAX_WRITES
    this.#schedule()
    return !this.#backpressured
  }
  end(data?: string | Uint8Array): this {
    if (data !== undefined) this.write(data)
    if (!this.#ending) this.#endDeadline = performance.now() + WRITE_DEADLINE_MS
    this.#ending = true; this.#schedule(); return this
  }
  destroy(error?: Error): this {
    const fd = this.#fd
    if (fd === null) return this
    // Detach before close, callbacks or events. Never close a reused numeric
    // slot, including when identity loss itself caused destruction.
    this.#fd = null; clearTimeout(this.#timer); this.#timer = undefined
    // SO_COOKIE still identifies our socket after EOF/error or flag drift;
    // full admission checks may already fail then and must not leak that FD.
    if (this.#sameSocket(fd)) { try { closeSync(fd) } catch {} }
    const pending = this.#queue; this.#queue = []; this.#queuedBytes = 0
    this.#scratch.fill(0)
    const failure = error ?? new Error('hosted_owner_v2_activation_closed')
    for (const write of pending) {
      write.bytes.fill(0); queueMicrotask(() => write.done?.(failure))
    }
    queueMicrotask(() => { try { if (error) this.emit('error', error) } finally { this.emit('close', !!error) } })
    return this
  }
  #eof(): void { queueMicrotask(() => this.emit('end')); this.destroy() }
  #schedule(): void {
    if (this.destroyed || this.#timer || (this.#paused && !this.#queue.length &&
      (!this.#ending || this.#ended) && this.#idleAt === Infinity)) return
    this.#timer = setTimeout(() => { this.#timer = undefined; this.#tick() }, POLL_MS)
  }
  #tick(): void {
    if (this.destroyed) return
    try {
      if (performance.now() >= this.#idleAt) {
        this.#idleAt = Infinity; this.emit('timeout')
        if (this.destroyed) return
      }
      if (this.#queue.some(write => performance.now() >= write.deadline) ||
        (this.#ending && !this.#ended && performance.now() >= this.#endDeadline)) {
        throw new Error('hosted_owner_v2_activation_write_deadline')
      }
      // One bounded receive and one bounded send per turn. No read queue is
      // retained here: pausing leaves incoming bytes in the kernel socket buffer.
      // Receive precedes send so write callbacks/phase transitions complete in
      // microtasks before any response to that write can be delivered as data.
      if (!this.#paused) {
        const fd = this.#currentFd()
        const n = result(Number(native!.symbols.recv(fd, ptr(this.#scratch), CHUNK, DONTWAIT)))
        if (n === 0) { this.#eof(); return }
        if (n > 0) { this.#activity(); this.emit('data', Buffer.from(this.#scratch.subarray(0, n))) }
      }
      if (this.destroyed) return
      const write = this.#queue[0]
      if (write) {
        const fd = this.#currentFd()
        const remaining = write.bytes.subarray(write.offset, write.offset + CHUNK)
        const n = remaining.length ? result(Number(native!.symbols.send(fd, ptr(remaining), remaining.length, DONTWAIT | NOSIGNAL))) : 0
        if (n === 0 && remaining.length) throw new Error('hosted_owner_v2_activation_write_zero')
        if (n >= 0) {
          write.offset += n
          if (n) this.#activity()
          if (write.offset === write.bytes.length) {
            this.#queue.shift(); this.#queuedBytes -= write.bytes.length; write.bytes.fill(0)
            queueMicrotask(() => write.done?.())
            if (this.#backpressured && !this.#queue.length) {
              this.#backpressured = false
              queueMicrotask(() => { if (!this.destroyed) this.emit('drain') })
            }
          }
        }
      }
      if (this.#ending && !this.#ended && !this.#queue.length && !this.destroyed) {
        this.#ended = result(native!.symbols.shutdown(this.#currentFd(), 1)) === 0
      }
    } catch (error) { this.destroy(error as Error) }
    this.#schedule()
  }
}
