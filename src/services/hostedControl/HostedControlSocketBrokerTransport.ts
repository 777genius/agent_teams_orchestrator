/** Internal native transport cursor. No Node Duplex lifecycle or private handles.
 *
 * This follows the public short-write cursor used by upstreamproxy/relay.ts:
 * write's count consumes only that prefix; drain retries the retained suffix.
 * The supplied pinned net source uses INTERNAL @write, not this public API.
 * Root must validate the unbuffered public-write/FIN boundary on Bun 1.3.11;
 * an empty application queue alone would not prove drain for a buffered API.
 */
export class SocketBrokerWriteQueue {
  readonly limit = 1024 * 1024
  eof = false
  finSent = false
  private chunks: Buffer[] = []
  private offset = 0
  private retained = 0
  private blocked = false
  private pumping = false
  private drainVersion = 0
  private reentrantZero = false
  private stopped = false
  private sourceClosed = false
  private destination: Bun.Socket | undefined

  constructor(
    private readonly source: Bun.Socket | undefined,
    private readonly fail: () => void,
    private readonly changed: () => void,
  ) {}

  install(socket: Bun.Socket): void {
    if (this.stopped) { socket.terminate(); return }
    this.destination = socket
    this.pump()
  }

  push(bytes: Uint8Array): void {
    if (this.stopped) return
    if (this.eof || bytes.byteLength > this.limit - this.retained || this.chunks.length >= 1024) {
      this.fail(); return
    }
    if (!bytes.byteLength) return
    // Native callback buffers may be reused after return. Own even a blocked
    // suffix, including the token, rather than retaining callback memory.
    this.chunks.push(Buffer.from(bytes))
    this.retained += bytes.byteLength
    try { this.source?.pause() } catch { this.fail(); return }
    this.pump()
  }

  end(): void {
    if (this.stopped || this.eof) return
    this.eof = true
    this.pump()
  }

  drain(): void {
    if (this.stopped || this.finSent) return
    this.drainVersion += 1
    this.blocked = false
    this.pump()
  }

  closeSource(): void { this.sourceClosed = true }

  stop(): void {
    this.stopped = true
    for (const bytes of this.chunks) bytes.fill(0)
    this.chunks = []
    this.offset = this.retained = 0
    this.destination = undefined
  }

  private pump(): void {
    if (this.stopped || this.pumping || this.blocked || !this.destination || this.finSent) return
    this.pumping = true
    try {
      while (!this.stopped && this.chunks.length) {
        const bytes = this.chunks[0]!
        const remaining = bytes.length - this.offset
        const drainVersion = this.drainVersion
        const count = this.destination.write(bytes.subarray(this.offset))
        if (this.stopped) return // a native error/close can reenter teardown
        if (!Number.isInteger(count) || count < 0 || count > remaining) { this.fail(); return }
        this.offset += count
        if (count < remaining) {
          this.blocked = true
          if (this.drainVersion !== drainVersion) {
            // Preserve a wake delivered during write without overlapping the
            // cursor. Repeated synchronous zero-progress wakes are a transport
            // failure, not permission to spin forever in microtasks.
            if (count === 0 && this.reentrantZero) { this.fail(); return }
            this.reentrantZero = count === 0
            queueMicrotask(() => this.drain())
          } else this.reentrantZero = false
          return
        }
        this.reentrantZero = false
        this.chunks.shift()
        this.retained -= bytes.length
        this.offset = 0
        bytes.fill(0)
      }
      if (this.stopped) return
      if (this.eof) {
        // SHUT_WR: retain the destination's read half. Fence reentrant drain
        // before the syscall; never FIN a partially written application tail.
        this.finSent = true
        this.destination.shutdown(false)
      }
    } catch { this.fail() } finally { this.pumping = false }
    if (this.stopped) return
    try {
      this.changed()
      if (!this.stopped && !this.eof && !this.sourceClosed && !this.blocked) this.source?.resume()
    } catch { this.fail() }
  }
}
