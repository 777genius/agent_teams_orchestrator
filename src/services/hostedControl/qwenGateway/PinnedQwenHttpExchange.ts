import { writeSync } from 'node:fs'
import { connect, type Socket } from 'node:net'

const MAX_HEADER_BYTES = 16 * 1024

type FdSocket = Socket & { _handle?: { fd?: number } }

export async function connectPinnedQwen(port: number, timeoutMs: number): Promise<Socket> {
  const socket = connect({ host: '127.0.0.1', port, family: 4 })
  socket.setNoDelay(true)
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('hosted-qwen-upstream-timeout')))
  try {
    await new Promise<void>((resolve, reject) => {
      const connected = () => { socket.off('error', failed); resolve() }
      const failed = (error: Error) => { socket.off('connect', connected); reject(error) }
      socket.once('connect', connected)
      socket.once('error', failed)
    })
    if (socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== port ||
      !Number.isSafeInteger((socket as FdSocket)._handle?.fd)) {
      throw new Error('hosted-qwen-upstream-pin-invalid')
    }
    // The caller installs its response handler after its awaited Product decision.
    // Keep socket errors from becoming uncaught during that gap.
    socket.on('error', () => undefined)
    return socket
  } catch (error) { socket.destroy(); throw error }
}

/** Exactly one kernel write is permitted under the Product lock. A partial write is ambiguous. */
export function writePinnedQwen(socket: Socket, frame: Buffer,
  writer: typeof writeSync = writeSync): void {
  const fd = (socket as FdSocket)._handle?.fd
  if (!Number.isSafeInteger(fd) || socket.destroyed || socket.connecting) {
    throw new Error('hosted-qwen-upstream-fd-invalid')
  }
  try {
    const written = writer(fd as number, frame, 0, frame.length)
    if (written !== frame.length) throw new Error('hosted-qwen-dispatch-partial')
  } catch (error) {
    socket.destroy()
    throw error
  }
}

export function qwenHttpFrame(method: 'GET' | 'POST', path: string, body: Buffer): Buffer {
  const head = `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n` +
    (method === 'POST' ? `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n` : '') + '\r\n'
  return Buffer.concat([Buffer.from(head, 'ascii'), body])
}

type ParsedHeader = Readonly<{ status: number; contentType: string }>

/** Small HTTP/1.1 response framer. It strips upstream framing and never forwards headers verbatim. */
export class PinnedQwenResponseParser {
  private pending = Buffer.alloc(0)
  private header: ParsedHeader | null = null
  private mode: 'length' | 'chunked' | 'close' | null = null
  private remaining = 0
  private chunkRemaining = -1
  private total = 0
  private complete = false

  constructor(private readonly maxBytes: number) {}

  get headers(): ParsedHeader | null { return this.header }
  get done(): boolean { return this.complete }
  get closeDelimited(): boolean { return this.mode === 'close' }

  feed(input: Buffer): Buffer[] {
    if (this.complete) throw new Error('hosted-qwen-response-extra-bytes')
    this.pending = Buffer.concat([this.pending, input])
    if (!this.header) this.parseHeader()
    if (!this.header) return []
    const output: Buffer[] = []
    if (this.mode === 'length') {
      const count = Math.min(this.remaining, this.pending.length)
      if (count) this.emit(output, this.take(count))
      this.remaining -= count
      if (this.remaining === 0) this.complete = true
    } else if (this.mode === 'close') {
      if (this.pending.length) this.emit(output, this.take(this.pending.length))
    } else {
      while (this.pending.length && !this.complete) {
        if (this.chunkRemaining === -2) {
          if (this.pending.length < 2) break
          if (this.take(2).toString('ascii') !== '\r\n') throw new Error('hosted-qwen-trailer-forbidden')
          this.complete = true
          break
        }
        if (this.chunkRemaining < 0) {
          const lineEnd = this.pending.indexOf('\r\n')
          if (lineEnd < 0) {
            if (this.pending.length > 32) throw new Error('hosted-qwen-chunk-header-limit')
            break
          }
          const line = this.take(lineEnd + 2).toString('ascii').slice(0, -2)
          if (!/^[0-9a-fA-F]{1,8}$/.test(line)) throw new Error('hosted-qwen-chunk-invalid')
          this.chunkRemaining = Number.parseInt(line, 16)
          if (this.chunkRemaining === 0) {
            this.chunkRemaining = -2
            continue
          }
        }
        if (this.chunkRemaining === 0) {
          if (this.pending.length < 2) break
          if (this.take(2).toString('ascii') !== '\r\n') throw new Error('hosted-qwen-chunk-invalid')
          this.chunkRemaining = -1
          continue
        }
        const count = Math.min(this.chunkRemaining, this.pending.length)
        if (!count) break
        this.emit(output, this.take(count))
        this.chunkRemaining -= count
      }
    }
    if (this.complete && this.pending.length) throw new Error('hosted-qwen-response-extra-bytes')
    return output
  }

  ended(): void {
    if (this.mode === 'close') this.complete = true
    if (!this.complete) throw new Error('hosted-qwen-response-truncated')
  }

  private parseHeader(): void {
    const end = this.pending.indexOf('\r\n\r\n')
    if (end < 0) {
      if (this.pending.length > MAX_HEADER_BYTES) throw new Error('hosted-qwen-header-limit')
      return
    }
    if (end > MAX_HEADER_BYTES) throw new Error('hosted-qwen-header-limit')
    const lines = this.take(end + 4).toString('latin1').slice(0, -4).split('\r\n')
    const match = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: |$)/.exec(lines.shift() ?? '')
    if (!match) throw new Error('hosted-qwen-status-invalid')
    const status = Number(match[1])
    if (status < 200 || status >= 300) throw new Error('hosted-qwen-status-denied')
    const headers = new Map<string, string>()
    for (const line of lines) {
      const separator = line.indexOf(':')
      if (separator < 1) throw new Error('hosted-qwen-header-invalid')
      const key = line.slice(0, separator).toLowerCase()
      if (headers.has(key)) throw new Error('hosted-qwen-header-duplicate')
      headers.set(key, line.slice(separator + 1).trim())
    }
    const transfer = headers.get('transfer-encoding')
    const length = headers.get('content-length')
    if (transfer && (transfer.toLowerCase() !== 'chunked' || length !== undefined)) {
      throw new Error('hosted-qwen-framing-invalid')
    }
    if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) ||
      !Number.isSafeInteger(Number(length)) || Number(length) > this.maxBytes)) {
      throw new Error('hosted-qwen-response-limit')
    }
    this.header = { status, contentType: headers.get('content-type') ?? 'application/json' }
    this.mode = transfer ? 'chunked' : length !== undefined ? 'length' : 'close'
    if (this.mode === 'length') this.remaining = Number(length)
  }

  private take(count: number): Buffer {
    const part = this.pending.subarray(0, count)
    this.pending = this.pending.subarray(count)
    return part
  }

  private emit(output: Buffer[], part: Buffer): void {
    this.total += part.length
    if (this.total > this.maxBytes) throw new Error('hosted-qwen-response-limit')
    output.push(part)
  }
}
