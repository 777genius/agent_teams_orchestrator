import { createHash } from 'node:crypto'
import { fstatSync, writeSync } from 'node:fs'
import { connect, type Socket } from 'node:net'

import type { RootOpenCodeHttpRequest, RootOpenCodeHttpWire } from './RootOpenCodeHttpProxy.js'

const ENDPOINT = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/
const PASSWORD = /^[0-9a-f]{64}$/
const MAX_RESPONSE = 96 * 1024
const MAX_HEADER = 16 * 1024

/** Root-only source. It must attest this live container generation before revealing its password. */
export interface RootOpenCodeLoopbackEndpointAuthority {
  resolve(handle: string, generation: string): Promise<{
    handle: string; generation: string; endpoint: string; password: string
  }>
}

function pinnedFd(socket: Socket): number {
  const fd = (socket as Socket & { _handle?: { fd?: unknown } })._handle?.fd
  if (!Number.isSafeInteger(fd) || (fd as number) < 0 || !fstatSync(fd as number).isSocket()) {
    throw new Error('root-opencode-socket-unavailable')
  }
  return fd as number
}

function writeComplete(fd: number, bytes: Buffer): void {
  let offset = 0
  const started = performance.now()
  while (offset < bytes.length) {
    if (performance.now() - started > 500) throw new Error('root-opencode-write-timeout')
    const count = writeSync(fd, bytes, offset, bytes.length - offset)
    if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) {
      throw new Error('root-opencode-write-incomplete')
    }
    offset += count
  }
}

function requestBytes(request: RootOpenCodeHttpRequest, password: string): Buffer {
  const validPath = request.method === 'POST'
    ? request.path === '/session' || /^\/session\/ses[A-Za-z0-9_-]{8,120}\/prompt_async$/.test(request.path)
    : /^\/session\?search=hosted-member-attempt%3Amember_attempt_[0-9a-f]{64}&limit=101$/.test(request.path) ||
      /^\/session\/ses[A-Za-z0-9_-]{8,120}\/message\/msg[A-Za-z0-9_-]{8,120}$/.test(request.path) ||
      /^\/session\/ses[A-Za-z0-9_-]{8,120}\/message\?limit=100$/.test(request.path)
  if ((request.method !== 'GET' && request.method !== 'POST') ||
    !validPath ||
    (request.method === 'GET') !== (request.body === null)) {
    throw new Error('root-opencode-wire-request-invalid')
  }
  const body = Buffer.from(request.body ?? '', 'utf8')
  if (body.length > 68 * 1024 || createHash('sha256').update(body).digest('hex') !== request.contentSha256) {
    throw new Error('root-opencode-wire-request-invalid')
  }
  if (request.method === 'POST' && !validPostBody(request.path, request.body!)) {
    throw new Error('root-opencode-wire-request-invalid')
  }
  const auth = Buffer.from(`opencode:${password}`).toString('base64')
  return Buffer.concat([Buffer.from(`${request.method} ${request.path} HTTP/1.1\r\n` +
    'Host: 127.0.0.1\r\nConnection: close\r\nAccept: application/json\r\n' +
    `Authorization: Basic ${auth}\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...fields].sort().join(',')
}

function validPostBody(path: string, body: string): boolean {
  let value: unknown
  try { value = JSON.parse(body) as unknown } catch { return false }
  if (path === '/session') {
    return exact(value, ['title']) && typeof value.title === 'string' &&
      /^hosted-member-attempt:member_attempt_[0-9a-f]{64}$/.test(value.title)
  }
  if (!exact(value, ['messageID', 'model', 'parts']) || typeof value.messageID !== 'string' ||
    !/^msg[A-Za-z0-9_-]{8,120}$/.test(value.messageID) ||
    !exact(value.model, ['providerID', 'modelID']) ||
    typeof value.model.providerID !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value.model.providerID) ||
    typeof value.model.modelID !== 'string' || !/^[A-Za-z0-9._:/\[\]-]+$/.test(value.model.modelID) ||
    !Array.isArray(value.parts) || value.parts.length !== 1 || !exact(value.parts[0], ['type', 'text']) ||
    value.parts[0].type !== 'text' || typeof value.parts[0].text !== 'string' ||
    !value.parts[0].text.trim() || Buffer.byteLength(value.parts[0].text) > 64 * 1024) return false
  return true
}

function decodeChunked(body: Buffer): Buffer {
  const parts: Buffer[] = []
  let cursor = 0
  let size = 0
  for (;;) {
    const end = body.indexOf('\r\n', cursor)
    if (end < 0 || end - cursor > 16) throw new Error('root-opencode-response-invalid')
    const digits = body.toString('ascii', cursor, end)
    if (!/^[0-9a-fA-F]+$/.test(digits)) throw new Error('root-opencode-response-invalid')
    const length = Number.parseInt(digits, 16)
    cursor = end + 2
    if (length === 0) {
      if (body.toString('ascii', cursor) !== '\r\n') throw new Error('root-opencode-response-invalid')
      break
    }
    if (!Number.isSafeInteger(length) || length > MAX_RESPONSE - size ||
      cursor + length + 2 > body.length || body.toString('ascii', cursor + length, cursor + length + 2) !== '\r\n') {
      throw new Error('root-opencode-response-invalid')
    }
    parts.push(body.subarray(cursor, cursor + length))
    size += length
    cursor += length + 2
  }
  return Buffer.concat(parts)
}

function parseResponse(raw: Buffer): { statusCode: number; body: unknown } {
  const boundary = raw.indexOf('\r\n\r\n')
  if (boundary < 0 || boundary > MAX_HEADER) throw new Error('root-opencode-response-invalid')
  const lines = raw.toString('latin1', 0, boundary).split('\r\n')
  const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: .*)?$/.exec(lines.shift() ?? '')
  if (!status) throw new Error('root-opencode-response-invalid')
  const headers = new Map<string, string>()
  for (const line of lines) {
    const match = /^([A-Za-z0-9-]+):\s*([^\r\n]*)$/.exec(line)
    if (!match || headers.has(match[1].toLowerCase())) throw new Error('root-opencode-response-invalid')
    headers.set(match[1].toLowerCase(), match[2])
  }
  const encoded = raw.subarray(boundary + 4)
  const body = headers.has('transfer-encoding')
    ? headers.get('transfer-encoding') === 'chunked' && !headers.has('content-length')
      ? decodeChunked(encoded) : (() => { throw new Error('root-opencode-response-invalid') })()
    : encoded
  const contentLength = headers.get('content-length')
  if (contentLength !== undefined && (!/^(0|[1-9][0-9]*)$/.test(contentLength) ||
    Number(contentLength) !== body.length)) throw new Error('root-opencode-response-invalid')
  if (body.length > MAX_RESPONSE) throw new Error('root-opencode-response-too-large')
  if (body.length === 0) return { statusCode: Number(status[1]), body: null }
  try { return { statusCode: Number(status[1]), body: JSON.parse(body.toString('utf8')) as unknown } }
  catch { throw new Error('root-opencode-response-invalid') }
}

function readResponse(socket: Socket, timeoutMs: number): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    const timer = setTimeout(() => finish(new Error('root-opencode-response-timeout')), timeoutMs)
    const finish = (error?: Error) => {
      clearTimeout(timer)
      socket.off('data', onData); socket.off('end', onEnd); socket.off('error', onError)
      socket.off('close', onClose)
      socket.destroy()
      if (error) reject(error)
      else {
        try { resolve(parseResponse(Buffer.concat(chunks))) } catch { reject(new Error('root-opencode-response-invalid')) }
      }
    }
    const onData = (chunk: Buffer) => {
      length += chunk.length
      if (length > MAX_RESPONSE + MAX_HEADER + 4096) finish(new Error('root-opencode-response-too-large'))
      else chunks.push(chunk)
    }
    const onEnd = () => finish()
    const onError = (_error: Error) => finish(new Error('root-opencode-response-failed'))
    const onClose = () => finish(new Error('root-opencode-response-closed'))
    socket.on('data', onData); socket.once('end', onEnd); socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/** Holds Basic only in root memory; emits exactly one prepared HTTP request with a synchronous kernel write. */
export class RootOpenCodeLoopbackWire implements RootOpenCodeHttpWire {
  constructor(private readonly authority: RootOpenCodeLoopbackEndpointAuthority,
    private readonly timeoutMs = 10_000) {
    if (!authority || typeof authority.resolve !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 30_000) throw new Error('root-opencode-wire-policy-invalid')
  }

  async prepare(handle: string, generation: string) {
    const proof = await this.authority.resolve(handle, generation)
    const match = ENDPOINT.exec(proof.endpoint)
    if (proof.handle !== handle || proof.generation !== generation || !match ||
      Number(match[1]) > 65535 || !PASSWORD.test(proof.password)) {
      throw new Error('root-opencode-endpoint-proof-invalid')
    }
    const socket = await new Promise<Socket>((resolve, reject) => {
      const pending = connect({ host: '127.0.0.1', port: Number(match[1]) })
      const timer = setTimeout(() => { pending.destroy(); reject(new Error('root-opencode-connect-timeout')) },
        this.timeoutMs)
      pending.once('connect', () => { clearTimeout(timer); pending.off('error', onError); resolve(pending) })
      const onError = () => { clearTimeout(timer); pending.destroy(); reject(new Error('root-opencode-connect-failed')) }
      pending.once('error', onError)
    })
    const fd = pinnedFd(socket)
    const response = readResponse(socket, this.timeoutMs)
    let emitted = false
    return {
      emitSync(request: RootOpenCodeHttpRequest) {
        if (emitted || socket.destroyed || pinnedFd(socket) !== fd) {
          throw new Error('root-opencode-wire-unavailable')
        }
        emitted = true
        writeComplete(fd, requestBytes(request, proof.password))
      },
      response,
      close() { socket.destroy() },
    }
  }
}
