import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo, type Socket } from 'node:net'

import type { HostedProductCurrentMember, HostedProductMemberBinding } from '../productAuthority/HostedProductCurrentMemberDecision.js'
import { connectPinnedQwen, PinnedQwenResponseParser, qwenHttpFrame, writePinnedQwen } from './PinnedQwenHttpExchange.js'

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const MAX_GATEWAY_REQUEST_BYTES = 64 * 1024

function ipv4(value: string): boolean {
  return IPV4.test(value) && value.split('.').every(octet => Number(octet) <= 255)
}

export type HostedQwenContainerBinding = Readonly<{
  containerId: string
  networkId: string
  containerGeneration: number
  containerIp: string
}>

export type HostedQwenAdmission = Readonly<{
  member: HostedProductMemberBinding
  container: HostedQwenContainerBinding
  model: string
}>

export interface HostedQwenGatewayDispatchAuthority {
  withCurrentMemberDecision<T>(binding: HostedProductMemberBinding, kind: 'observe',
    callback: (current: HostedProductCurrentMember) => T): Promise<T>
  /** Root-owned, synchronous view of current Docker identity. */
  currentContainer(): HostedQwenContainerBinding | null
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
  /** Omission keeps production dispatch closed. */
  readonly dispatchAuthority?: HostedQwenGatewayDispatchAuthority
}

/** Fixed-destination HTTP gateway. All request bytes cross the kernel under Product's SQLite lock. */
export class HostedQwenGateway {
  private readonly server: Server
  private admitted: HostedQwenAdmission | string | null = null
  private admissionEpoch = 0
  private readonly active = new Set<{ cancel(): void }>()
  private started = false
  private readonly maxRequestBytes: number
  private readonly maxResponseBytes: number
  private readonly timeoutMs: number
  private readonly maxConcurrent: number

  constructor(private readonly options: HostedQwenGatewayOptions) {
    if (options.testOnlyAllowNonRoot) {
      if (process.env.NODE_ENV !== 'test' || process.getuid?.() === 0 ||
        options.bindAddress !== '127.0.0.1') {
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
    this.maxRequestBytes = options.maxRequestBytes ?? MAX_GATEWAY_REQUEST_BYTES
    this.maxResponseBytes = options.maxResponseBytes ?? 32 * 1024 * 1024
    this.timeoutMs = options.timeoutMs ?? 300_000
    this.maxConcurrent = options.maxConcurrent ?? 4
    if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1 ||
      this.maxRequestBytes > MAX_GATEWAY_REQUEST_BYTES ||
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

  /** Root calls this only after the exact container IP is admitted by network policy. */
  admitClient(admission: HostedQwenAdmission | string): void {
    if (!this.started) throw new Error('hosted-qwen-client-invalid')
    if (typeof admission === 'string') {
      if (!this.options.testOnlyAllowNonRoot || !ipv4(admission)) throw new Error('hosted-qwen-client-invalid')
      this.revokeClient()
      this.admitted = admission
      return
    }
    if (!this.options.dispatchAuthority || !admission?.member || !admission.container ||
      !ipv4(admission.container.containerIp) || !admission.container.containerId || !admission.container.networkId ||
      !Number.isSafeInteger(admission.container.containerGeneration) || admission.container.containerGeneration < 1 ||
      typeof admission.model !== 'string' || !admission.model || admission.model.length > 256) {
      throw new Error('hosted-qwen-admission-invalid')
    }
    this.revokeClient()
    this.admitted = Object.freeze({
      member: Object.freeze({ ...admission.member }),
      container: Object.freeze({ ...admission.container }),
      model: admission.model,
    })
  }

  revokeClient(): void {
    this.admitted = null
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

  private sameAdmission(admission: HostedQwenAdmission | string, epoch: number, remote: string): boolean {
    return this.started && this.admissionEpoch === epoch && this.admitted === admission &&
      (typeof admission === 'string' ? admission : admission.container.containerIp) === remote
  }

  private matchesCurrent(admission: HostedQwenAdmission, current: HostedProductCurrentMember): boolean {
    const container = this.options.dispatchAuthority?.currentContainer()
    const expected = admission.container
    return current.runId === admission.member.runId && current.memberId === admission.member.memberId &&
      current.model === admission.model && !!container &&
      container.containerId === expected.containerId && container.networkId === expected.networkId &&
      container.containerGeneration === expected.containerGeneration && container.containerIp === expected.containerIp
  }

  private async responseEffect<T>(admission: HostedQwenAdmission | string, epoch: number,
    remote: string, effect: () => T): Promise<{ allowed: true; value: T } | { allowed: false }> {
    if (!this.sameAdmission(admission, epoch, remote)) return { allowed: false }
    if (typeof admission === 'string') return { allowed: true, value: effect() } // synthetic test fixture only
    try {
      return await this.options.dispatchAuthority!.withCurrentMemberDecision(admission.member, 'observe', current =>
        this.sameAdmission(admission, epoch, remote) && this.matchesCurrent(admission, current)
          ? { allowed: true as const, value: effect() } : { allowed: false as const })
    } catch { return { allowed: false } }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress ?? ''
    const admission = this.admitted
    if (!admission || !this.sameAdmission(admission, this.admissionEpoch, remote)) {
      res.writeHead(403).end()
      return
    }
    const target = req.url
    const method = req.method
    const allowed = target === '/v1/models' && method === 'GET' ||
      target === '/v1/chat/completions' && method === 'POST'
    if (!allowed || req.headers.upgrade || req.headers['proxy-authorization'] ||
      req.rawHeaders.filter((_, i) => i % 2 === 0).filter(k => k.toLowerCase() === 'host').length !== 1) {
      res.writeHead(400).end()
      return
    }
    if (method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
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
    let upstream: Socket | null = null
    let deadline: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    let finished = false
    const cleanup = () => {
      if (deadline) clearTimeout(deadline)
      this.active.delete(exchange)
      req.off('aborted', onAbort)
      req.socket.off('close', onAbort)
      req.socket.off('end', onAbort)
      req.socket.off('error', onAbort)
      res.off('close', onResponseClose)
    }
    const finish = () => {
      if (finished) return false
      finished = true
      cleanup()
      return true
    }
    const onAbort = () => exchange.cancel()
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
          finish()
          return
        }
        chunks.push(bytes)
      }
    } catch {
      if (!cancelled && !res.destroyed && !res.headersSent) res.writeHead(400).end()
      finish()
      return
    }
    if (cancelled || !this.sameAdmission(admission, epoch, remote) || res.destroyed) {
      exchange.cancel()
      return
    }
    if (method === 'GET' && bodyBytes !== 0 ||
      req.headers['content-length'] !== undefined && bodyBytes !== length) {
      res.writeHead(400).end()
      finish()
      return
    }
    const body = Buffer.concat(chunks, bodyBytes)
    if (method === 'POST' && typeof admission !== 'string') {
      try {
        const json: unknown = JSON.parse(body.toString('utf8'))
        if (!json || typeof json !== 'object' || Array.isArray(json) ||
          (json as Record<string, unknown>).model !== admission.model) throw new Error('model-mismatch')
      } catch {
        res.writeHead(403).end()
        finish()
        return
      }
    }
    try {
      upstream = await connectPinnedQwen(this.options.upstreamPort ?? 18993, this.timeoutMs)
      if (!this.sameAdmission(admission, epoch, remote) || cancelled) {
        upstream.destroy()
        exchange.cancel()
        return
      }
      const frame = qwenHttpFrame(method as 'GET' | 'POST', target!, body)
      if (frame.length > MAX_GATEWAY_REQUEST_BYTES + 256) throw new Error('hosted-qwen-frame-limit')
      if (typeof admission === 'string') {
        writePinnedQwen(upstream, frame)
      } else {
        await this.options.dispatchAuthority!.withCurrentMemberDecision(admission.member, 'observe', current => {
          if (!this.sameAdmission(admission, epoch, remote) || !this.matchesCurrent(admission, current)) {
            throw new Error('hosted-qwen-binding-not-current')
          }
          writePinnedQwen(upstream!, frame)
        })
      }
      if (upstream.destroyed) throw new Error('hosted-qwen-upstream-closed-before-response')
      if (!this.sameAdmission(admission, epoch, remote) || cancelled) { exchange.cancel(); return }
    } catch {
      upstream?.destroy()
      if (finish() && !res.destroyed) res.writeHead(502, { connection: 'close' }).end()
      return
    }
    const socket = upstream
    const parser = new PinnedQwenResponseParser(this.maxResponseBytes)
    const fail = () => {
      if (!finish()) return
      socket.destroy()
      if (!res.destroyed) {
        if (res.headersSent) res.destroy()
        else res.writeHead(502, { connection: 'close' }).end()
      }
    }
    deadline = setTimeout(fail, this.timeoutMs)
    deadline.unref()
    socket.on('error', fail)
    socket.on('close', () => {
      if (finished) return
      try { parser.ended() } catch { fail(); return }
      void (async () => {
        const result = await this.responseEffect(admission, epoch, remote, () => {
          if (!res.destroyed) res.end()
        })
        if (!result.allowed) { fail(); return }
        finish()
      })()
    })
    socket.on('data', chunk => {
      socket.pause()
      void (async () => {
        try {
          const pieces = parser.feed(Buffer.from(chunk))
          if (parser.headers && !res.headersSent) {
            const result = await this.responseEffect(admission, epoch, remote, () => {
              if (finished || cancelled || res.destroyed) return
              res.writeHead(parser.headers!.status, {
                'content-type': parser.headers!.contentType,
                'cache-control': 'no-store',
              })
            })
            if (!result.allowed || finished || cancelled) { fail(); return }
          }
          for (const piece of pieces) {
            const result = await this.responseEffect(admission, epoch, remote, () =>
              !finished && !cancelled && !res.destroyed ? res.write(piece) : false)
            if (!result.allowed || finished || cancelled) { fail(); return }
            if (!result.value) await new Promise<void>(resolve => {
              const done = () => { res.off('drain', done); res.off('close', done); resolve() }
              res.once('drain', done)
              res.once('close', done)
            })
            if (finished || cancelled) return
          }
          if (parser.done) {
            const result = await this.responseEffect(admission, epoch, remote, () => {
              if (!finished && !cancelled && !res.destroyed) res.end()
            })
            if (!result.allowed) { fail(); return }
            finish()
            socket.destroy()
          } else socket.resume()
        } catch { fail() }
      })()
    })
  }
}
