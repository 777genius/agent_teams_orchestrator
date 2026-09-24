import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/

function ipv4(value: string): boolean {
  return IPV4.test(value) && value.split('.').every(octet => Number(octet) <= 255)
}

export interface HostedQwenGatewayOptions {
  readonly bindAddress: string
  readonly port: number
  readonly upstreamPort?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxConcurrent?: number
  readonly timeoutMs?: number
  /** Allows an inert loopback fixture in tests only. Production requires root and a bridge address. */
  readonly testOnlyAllowNonRoot?: boolean
}

/** Fixed-destination HTTP gateway. It never resolves a name or consults proxy variables. */
export class HostedQwenGateway {
  private readonly server: Server
  private admittedIp: string | null = null
  private admissionEpoch = 0
  private readonly active = new Set<{ cancel(): void }>()
  private started = false
  private readonly maxRequestBytes: number
  private readonly maxResponseBytes: number
  private readonly timeoutMs: number
  private readonly maxConcurrent: number

  constructor(private readonly options: HostedQwenGatewayOptions) {
    if (options.testOnlyAllowNonRoot) {
      if (process.env.NODE_ENV !== 'test' || options.bindAddress !== '127.0.0.1') {
        throw new Error('hosted-qwen-test-mode-invalid')
      }
    } else if (process.platform !== 'linux' || process.getuid?.() !== 0 ||
      !ipv4(options.bindAddress) || options.bindAddress.startsWith('127.')) {
      throw new Error('hosted-qwen-root-bridge-required')
    }
    if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535 ||
      options.upstreamPort !== undefined && options.upstreamPort !== 18993 && !options.testOnlyAllowNonRoot) {
      throw new Error('hosted-qwen-port-invalid')
    }
    this.maxRequestBytes = options.maxRequestBytes ?? 8 * 1024 * 1024
    this.maxResponseBytes = options.maxResponseBytes ?? 32 * 1024 * 1024
    this.timeoutMs = options.timeoutMs ?? 300_000
    this.maxConcurrent = options.maxConcurrent ?? 4
    if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1 || this.maxRequestBytes > 32 * 1024 * 1024 ||
      !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 128 * 1024 * 1024 ||
      !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 600_000 ||
      !Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 8) {
      throw new Error('hosted-qwen-bounds-invalid')
    }
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (res.destroyed) return
        if (!res.headersSent) res.writeHead(502).end()
        else res.destroy()
      })
    })
    this.server.on('connect', (_req, socket) => socket.destroy())
    this.server.on('upgrade', (_req, socket) => socket.destroy())
    this.server.maxConnections = this.maxConcurrent * 2
    this.server.maxHeadersCount = 32
    this.server.headersTimeout = 10_000
    this.server.requestTimeout = this.timeoutMs
    this.server.keepAliveTimeout = 1000
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('hosted-qwen-already-started')
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.options.port, this.options.bindAddress, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    this.started = true
    this.attest()
  }

  /** Call only after the root network policy has admitted this exact container IP. */
  admitClient(ip: string): void {
    if (!this.started || !ipv4(ip)) throw new Error('hosted-qwen-client-invalid')
    this.revokeClient()
    this.admittedIp = ip
    this.admissionEpoch++
  }

  revokeClient(): void {
    this.admittedIp = null
    this.admissionEpoch++
    for (const exchange of [...this.active]) exchange.cancel()
  }

  attest(): void {
    const address = this.server.address() as AddressInfo | null
    if (!this.started || !address || address.family !== 'IPv4' ||
      address.address !== this.options.bindAddress || address.port !== this.options.port) {
      throw new Error('hosted-qwen-listener-mismatch')
    }
  }

  async stop(): Promise<void> {
    this.revokeClient()
    if (!this.started) return
    this.started = false
    const closed = new Promise<void>(resolve => this.server.close(() => resolve()))
    this.server.closeAllConnections()
    await closed
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress
    if (!this.started || !this.admittedIp || remote !== this.admittedIp) {
      res.writeHead(403).end()
      return
    }
    const target = req.url
    const allowed = target === '/v1/models' && req.method === 'GET' ||
      target === '/v1/chat/completions' && req.method === 'POST'
    if (!allowed || req.headers.upgrade || req.headers['proxy-authorization'] ||
      req.rawHeaders.filter((_, i) => i % 2 === 0).filter(k => k.toLowerCase() === 'host').length !== 1) {
      res.writeHead(400).end()
      return
    }
    if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
      res.writeHead(415).end()
      return
    }
    const length = Number(req.headers['content-length'] ?? 0)
    if (req.headers['content-length'] !== undefined && (!Number.isSafeInteger(length) || length > this.maxRequestBytes)) {
      res.writeHead(413).end()
      return
    }
    if (this.active.size >= this.maxConcurrent) {
      res.writeHead(429, { connection: 'close' }).end()
      return
    }
    const epoch = this.admissionEpoch
    let upstream: ClientRequest | null = null
    let deadline: ReturnType<typeof setTimeout> | null = null
    let drainListener: (() => void) | null = null
    let cancelled = false
    let finished = false
    const onAbort = () => exchange.cancel()
    const cleanup = () => {
      if (deadline) clearTimeout(deadline)
      this.active.delete(exchange)
      req.off('aborted', onAbort)
      req.socket.off('close', onAbort)
      req.socket.off('end', onAbort)
      req.socket.off('error', onAbort)
      res.off('close', onResponseClose)
      if (drainListener) res.off('drain', drainListener)
    }
    const finish = () => {
      if (finished) return false
      finished = true
      cleanup()
      return true
    }
    const onResponseClose = () => {
      cancelled = true
      if (finish()) upstream?.destroy()
    }
    const exchange = {
      cancel: () => {
        if (cancelled) return
        cancelled = true
        if (!finish()) return
        upstream?.destroy()
        req.destroy()
        res.destroy()
      },
    }
    this.active.add(exchange)
    req.once('aborted', onAbort)
    req.socket.once('close', onAbort)
    req.socket.once('end', onAbort)
    req.socket.once('error', onAbort)
    res.once('close', onResponseClose)
    const chunks: Buffer[] = []
    let bodyBytes = 0
    try {
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bodyBytes += bytes.length
        if (bodyBytes > this.maxRequestBytes) {
          res.writeHead(413).end()
          return
        }
        chunks.push(bytes)
      }
    } catch {
      if (!cancelled && !res.destroyed && !res.headersSent) res.writeHead(400).end()
      return
    }
    if (cancelled || !this.started || this.admissionEpoch !== epoch ||
      this.admittedIp !== remote || res.destroyed) {
      exchange.cancel()
      return
    }
    if (req.method === 'GET' && bodyBytes !== 0) {
      res.writeHead(400).end()
      return
    }
    upstream = httpRequest({
      host: '127.0.0.1', port: this.options.upstreamPort ?? 18993,
      path: target, method: req.method,
      agent: false, timeout: this.timeoutMs,
      headers: {
        host: '127.0.0.1',
        ...(req.method === 'POST' ? { 'content-type': req.headers['content-type'] } : {}),
        ...(req.headers.accept ? { accept: req.headers.accept } : {}),
      },
    }, upstreamResponse => {
      if (finished) { upstreamResponse.destroy(); return }
      const upstreamLength = Number(upstreamResponse.headers['content-length'] ?? 0)
      if ((upstreamResponse.statusCode ?? 500) >= 300 && (upstreamResponse.statusCode ?? 500) < 400 ||
        upstreamResponse.headers['content-length'] !== undefined &&
          (!Number.isSafeInteger(upstreamLength) || upstreamLength > this.maxResponseBytes)) {
        if (!finish()) return
        upstreamResponse.destroy()
        if (!res.headersSent) res.writeHead(502).end()
        return
      }
      res.writeHead(upstreamResponse.statusCode ?? 502, {
        'content-type': upstreamResponse.headers['content-type'] ?? 'application/json',
        'cache-control': 'no-store',
      })
      let received = 0
      upstreamResponse.on('data', (chunk: Buffer) => {
        if (finished) return
        received += chunk.length
        if (received > this.maxResponseBytes) {
          if (!finish()) return
          upstreamResponse.destroy()
          res.destroy(new Error('hosted-qwen-response-limit'))
        } else if (!res.write(chunk)) upstreamResponse.pause()
      })
      drainListener = () => upstreamResponse.resume()
      res.on('drain', drainListener)
      upstreamResponse.on('end', () => { if (finish() && !res.destroyed) res.end() })
      upstreamResponse.on('error', () => { if (finish() && !res.destroyed) res.destroy() })
    })
    deadline = setTimeout(() => {
      if (!finish()) return
      upstream?.destroy(new Error('hosted-qwen-absolute-timeout'))
      if (!res.destroyed) {
        if (!res.headersSent) res.writeHead(502, { connection: 'close' }).end()
        else res.destroy()
      }
    }, this.timeoutMs)
    deadline.unref()
    upstream.on('timeout', () => {
      if (!finish()) return
      upstream?.destroy(new Error('hosted-qwen-upstream-timeout'))
      if (!res.destroyed) {
        if (!res.headersSent) res.writeHead(502, { connection: 'close' }).end()
        else res.destroy()
      }
    })
    upstream.on('error', () => {
      if (!finish()) return
      if (!res.headersSent) res.writeHead(502, { connection: 'close' }).end(); else res.destroy()
    })
    upstream.end(Buffer.concat(chunks, bodyBytes))
  }
}
