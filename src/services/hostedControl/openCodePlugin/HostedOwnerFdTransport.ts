import { randomUUID } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { Socket } from 'node:net'
import type { Readable, Writable } from 'node:stream'

const MAX_FRAME_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 5_000
let fd3Claimed = false

export type HostedOwnerToolName =
  | 'hosted_task_get' | 'hosted_task_start' | 'hosted_task_complete'
  | 'hosted_task_add_comment' | 'hosted_message_send'

export type HostedOwnerToolRequest = Readonly<{
  version: 1
  type: 'request'
  requestId: string
  tool: HostedOwnerToolName
  context: Readonly<{ sessionID: string; messageID: string; callID: string }>
  args: Readonly<Record<string, unknown>>
}>

export type HostedOwnerExchange = (
  request: Omit<HostedOwnerToolRequest, 'version' | 'type' | 'requestId'>,
  signal?: AbortSignal,
) => Promise<string>

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One fail-closed connection to the inherited Owner duplex descriptor. */
export class HostedOwnerFdTransport {
  private buffer = Buffer.alloc(0)
  private pending: {
    id: string
    resolve: (value: string) => void
    reject: (reason: Error) => void
  } | null = null
  private failed: Error | null = null
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    input.on('data', chunk => this.onData(chunk))
    input.on('end', () => this.fail(new Error('Hosted Owner FD closed')))
    input.on('close', () => this.fail(new Error('Hosted Owner FD closed')))
    input.on('error', () => this.fail(new Error('Hosted Owner FD read failed')))
    output.on('close', () => this.fail(new Error('Hosted Owner FD closed')))
    output.on('error', () => this.fail(new Error('Hosted Owner FD write failed')))
  }

  private fail(error: Error): void {
    if (this.failed) return
    this.failed = error
    this.pending?.reject(error)
    this.pending = null
    this.input.destroy()
    if ((this.output as unknown) !== this.input) this.output.destroy()
  }

  dispose(): void {
    this.fail(new Error('Hosted Owner FD disposed'))
  }

  private onData(chunk: unknown): void {
    if (this.failed) return
    if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') {
      this.fail(new Error('Hosted Owner FD emitted invalid bytes'))
      return
    }
    if (Buffer.byteLength(chunk) > MAX_FRAME_BYTES + 4 ||
      this.buffer.length + Buffer.byteLength(chunk) > MAX_FRAME_BYTES + 4) {
      this.fail(new Error('Hosted Owner FD buffer exceeded limit'))
      return
    }
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.fail(new Error('Hosted Owner FD frame size invalid'))
        return
      }
      if (this.buffer.length < length + 4) return
      const frame = this.buffer.subarray(4, length + 4)
      this.buffer = this.buffer.subarray(length + 4)
      let response: unknown
      try { response = JSON.parse(frame.toString('utf8')) }
      catch { this.fail(new Error('Hosted Owner FD response malformed')); return }
      const pending = this.pending
      if (!pending || !record(response) || Object.keys(response).sort().join(',') !==
          (response.ok === true ? 'ok,requestId,result,type,version' : 'error,ok,requestId,type,version') ||
        response.version !== 1 || response.type !== 'response' ||
        response.requestId !== pending.id || typeof response.ok !== 'boolean' ||
        (response.ok && typeof response.result !== 'string') ||
        (!response.ok && typeof response.error !== 'string')) {
        this.fail(new Error('Hosted Owner FD response mismatch'))
        return
      }
      this.pending = null
      if (response.ok) pending.resolve(response.result as string)
      else pending.reject(new Error('Hosted Owner rejected tool request'))
    }
    if (this.buffer.length > MAX_FRAME_BYTES + 4) this.fail(new Error('Hosted Owner FD buffer exceeded limit'))
  }

  exchange: HostedOwnerExchange = (request, signal) => {
    const operation = this.tail.then(() => this.send(request, signal))
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async send(request: Parameters<HostedOwnerExchange>[0], signal?: AbortSignal): Promise<string> {
    if (this.failed) throw this.failed
    if (signal?.aborted) throw new Error('Hosted tool call aborted')
    const id = randomUUID()
    const payload: HostedOwnerToolRequest = { version: 1, type: 'request', requestId: id, ...request }
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8')
    if (bytes.length > MAX_FRAME_BYTES) throw new Error('Hosted Owner FD request too large')
    const frame = Buffer.allocUnsafe(4 + bytes.length)
    frame.writeUInt32BE(bytes.length, 0)
    bytes.copy(frame, 4)
    // This check is at the queue's write edge, after all work that could have
    // waited behind a previous request. An aborted call must send no bytes.
    if (signal?.aborted) throw new Error('Hosted tool call aborted')
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Hosted Owner FD response timed out')), REQUEST_TIMEOUT_MS)
      const settleResolve = (value: string) => { clearTimeout(timer); resolve(value) }
      const settleReject = (error: Error) => { clearTimeout(timer); reject(error) }
      this.pending = { id, resolve: settleResolve, reject: settleReject }
      try {
        this.output.write(frame, error => {
          if (error) this.fail(new Error('Hosted Owner FD write failed'))
        })
      } catch {
        this.fail(new Error('Hosted Owner FD write failed'))
      }
    })
  }
}

export function createHostedOwnerFdExchange(): HostedOwnerExchange & { dispose(): void } {
  let transport: HostedOwnerFdTransport | null = null
  let disposed = false
  const exchange: HostedOwnerExchange = (request, signal) => {
    if (disposed) throw new Error('Hosted Owner FD disposed')
    if (!transport) {
      if (fd3Claimed) throw new Error('Hosted Owner FD3 already claimed')
      let isSocket: boolean
      try { isSocket = fstatSync(3).isSocket() }
      catch { throw new Error('Hosted Owner FD3 unavailable') }
      if (!isSocket) throw new Error('Hosted Owner FD3 is not a duplex socket')
      fd3Claimed = true
      // A single Socket owns FD3. destroy() closes it once; separate fs read and
      // write streams plus closeSync could close a newly reused descriptor.
      const socket = new Socket({ fd: 3, readable: true, writable: true })
      transport = new HostedOwnerFdTransport(socket, socket)
    }
    return transport.exchange(request, signal)
  }
  return Object.assign(exchange, {
    dispose(): void {
      if (disposed) return
      disposed = true
      transport?.dispose()
    },
  })
}
