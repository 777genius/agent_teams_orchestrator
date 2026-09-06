import type { Socket } from 'node:net'

// One bounded HTTP/1 exchange on a socket supplied by the custody transport.
// This module has no connector, Agent, fetch, redirect or retry implementation.
const MAX_HEADER_BYTES = 16 * 1024
const MAX_HEADER_FIELDS = 128
export const MAX_OPENCODE_SOCKET_HTTP_BODY_BYTES = 1024 * 1024
const MAX_CHUNK_LINE_BYTES = 1024
const MAX_CHUNK_METADATA_BYTES = 64 * 1024
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

export type OpenCodeSocketHttpResponse = {
  status: number
  statusText: string
  headers: Headers
  contentEncoding: string | null
  bytes: Buffer
  complete: boolean
}

/** Serialize before consuming any final fence. The body is the retained byte
 * sequence, never parsed, encoded again or handed to another HTTP transport. */
export function encodeOpenCodeSocketHttpRequest(url: URL, init: RequestInit, body: Buffer): Buffer {
  const method = init.method ?? 'GET'
  const target = `${url.pathname}${url.search}`
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
    target.length > MAX_HEADER_BYTES || !target.startsWith('/') || target.startsWith('//') || /[^\x21-\x7e]/.test(target) ||
    body.length > MAX_OPENCODE_SOCKET_HTTP_BODY_BYTES) throw new Error('OpenCode HTTP request outside transport bounds')
  const headers = new Headers(init.headers)
  if (['transfer-encoding', 'trailer', 'upgrade', 'expect'].some(name => headers.has(name))) {
    throw new Error('OpenCode HTTP request framing unsupported')
  }
  headers.set('host', url.host)
  headers.set('connection', 'close')
  headers.set('accept-encoding', 'identity')
  headers.set('content-length', String(body.length))
  const lines = [`${method} ${target} HTTP/1.1`]
  let headLength = lines[0]!.length + 4 // request-line CRLF and final empty line
  for (const [name, value] of headers) {
    // All accepted characters are single latin1 octets. Enforce the bound
    // before joining/allocating the head, including caller-selected targets.
    headLength += name.length + value.length + 4
    if (headLength > MAX_HEADER_BYTES || lines.length > MAX_HEADER_FIELDS) {
      throw new Error('OpenCode HTTP request headers exceeded limit')
    }
    if (!TOKEN.test(name) || !FIELD_VALUE.test(value)) throw new Error('OpenCode HTTP request header invalid')
    lines.push(`${name}: ${value}`)
  }
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1')
  return Buffer.concat([head, body])
}

/** Observe data directly, before an EOF/reset can discard a stream's queued
 * prefix. Transfer framing is removed; content encoding is never decoded.
 * Completion requires the requested connection-close EOF, so surplus bytes in
 * later packets cannot be silently accepted after a Content-Length/chunk end. */
export function readOpenCodeSocketHttpResponse(
  socket: Socket,
  signal: AbortSignal,
  maximumBytes: number,
  unsafe: (code: string) => void,
): { response: Promise<OpenCodeSocketHttpResponse>; cancel(): void } {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_OPENCODE_SOCKET_HTTP_BODY_BYTES) {
    throw new Error('OpenCode HTTP response bound invalid')
  }
  let resolve!: (response: OpenCodeSocketHttpResponse) => void
  let reject!: (error: Error) => void
  const response = new Promise<OpenCodeSocketHttpResponse>((yes, no) => { resolve = yes; reject = no })
  // Preparation/finalizer failure can abandon this reader before awaiting it.
  void response.catch(() => undefined)
  let settled = false
  let valid = true
  let status = 0
  let statusText = ''
  let headers = new Headers()
  let contentEncoding: string | null = null
  let pending: Buffer = Buffer.alloc(0)
  const body = Buffer.allocUnsafe(maximumBytes)
  let size = 0
  let remaining = 0
  let headerBytes = 0
  let headerFields = 0
  let informational = 0
  let chunkMetadata = 0
  let trailerBytes = 0
  let state: 'headers' | 'length' | 'close' | 'chunk-size' | 'chunk-data' | 'chunk-crlf' | 'trailers' | 'done' = 'headers'

  const markUnsafe = (code: string) => { valid = false; unsafe(code) }
  const finish = (eof: boolean) => {
    if (settled) return
    settled = true
    const complete = eof && valid && (state === 'done' || state === 'close')
    if (!complete) unsafe('incomplete_body')
    socket.off('data', data)
    socket.off('end', ended)
    // Keep the error observer until close: a reset already queued by the
    // runtime must not become unhandled after the response has been retained.
    signal.removeEventListener('abort', aborted)
    socket.destroy()
    if (status) resolve({ status, statusText, headers, contentEncoding,
      bytes: Buffer.from(body.subarray(0, size)), complete })
    else reject(new Error('OpenCode HTTP response headers incomplete or invalid'))
  }
  const fail = (code: string) => { markUnsafe(code); finish(false) }
  const appendBody = (bytes: Buffer): boolean => {
    const count = Math.min(bytes.length, maximumBytes - size)
    bytes.copy(body, size, 0, count)
    size += count
    if (size && [204, 205, 304].includes(status)) unsafe('unexpected_status_body')
    if (count !== bytes.length) { fail('response_limit'); return false }
    return true
  }
  const readStatus = (line: string): boolean => {
    const match = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: ([\t\x20-\x7e\x80-\xff]*))?$/.exec(line)
    if (!match) return false
    status = Number(match[1]); statusText = match[2] ?? ''
    return true
  }
  const field = (line: string): [string, string] | null => {
    const colon = line.indexOf(':')
    const name = line.slice(0, colon)
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, '')
    if (colon <= 0 || !TOKEN.test(name) || !FIELD_VALUE.test(value)) return null
    return [name.toLowerCase(), value]
  }
  const readHeaders = (block: Buffer): boolean => {
    const [line, ...fields] = block.toString('latin1').split('\r\n')
    if (!readStatus(line!)) { fail('invalid_status'); return false }
    headers = new Headers()
    const values = new Map<string, string[]>()
    for (const line of fields) {
      const parsed = field(line)
      if (!parsed || ++headerFields > MAX_HEADER_FIELDS) { fail('invalid_headers'); return false }
      const [name, value] = parsed
      const list = values.get(name) ?? []
      list.push(value); values.set(name, list)
      if (name === 'content-encoding') contentEncoding = list.join(', ')
      try { headers.append(name, value) } catch { fail('invalid_headers'); return false }
    }
    // Read the original occurrences, not a runtime HTTP API's deduplicated map.
    contentEncoding = values.get('content-encoding')?.join(', ') ?? null
    if (contentEncoding !== null && contentEncoding !== 'identity') unsafe('unexpected_encoding')
    const lengths = values.get('content-length') ?? []
    const transfers = values.get('transfer-encoding') ?? []
    if (status < 200) {
      if (status === 101 || ++informational > 4 || lengths.length || transfers.length) {
        fail('unsupported_informational_response'); return false
      }
      status = 0; statusText = ''; headers = new Headers(); contentEncoding = null
      return true
    }
    // Ambiguous framing can never validate a receipt or an empty 409/412.
    // Keep its bounded received tail as incomplete evidence until EOF.
    if (lengths.length > 1 || (lengths.length && transfers.length) ||
      (transfers.length && (transfers.length !== 1 || transfers[0]!.toLowerCase() !== 'chunked')) ||
      (lengths.length && (!/^[0-9]+$/.test(lengths[0]!) || !Number.isSafeInteger(Number(lengths[0]))))) {
      markUnsafe('invalid_framing'); state = 'close'; return true
    }
    if (transfers.length) state = 'chunk-size'
    else if (lengths.length) {
      remaining = Number(lengths[0]); state = remaining === 0 ? 'done' : 'length'
    } else state = 'close'
    return true
  }
  const data = (chunk: Buffer) => {
    if (settled) return
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (!settled && pending.length) {
      if (state === 'headers') {
        // Preserve a received status even if EOF/overflow interrupts headers.
        const lineEnd = pending.indexOf('\r\n')
        if (lineEnd >= 0) readStatus(pending.subarray(0, lineEnd).toString('latin1'))
        const boundary = pending.indexOf('\r\n\r\n')
        if (boundary < 0) {
          if (headerBytes + pending.length > MAX_HEADER_BYTES) fail('header_limit')
          return
        }
        headerBytes += boundary + 4
        if (headerBytes > MAX_HEADER_BYTES) { fail('header_limit'); return }
        const block = pending.subarray(0, boundary)
        pending = pending.subarray(boundary + 4)
        if (!readHeaders(block)) return
      } else if (state === 'length' || state === 'chunk-data') {
        const count = Math.min(remaining, pending.length)
        if (!appendBody(pending.subarray(0, count))) return
        pending = pending.subarray(count); remaining -= count
        if (remaining === 0) state = state === 'length' ? 'done' : 'chunk-crlf'
      } else if (state === 'close') {
        appendBody(pending); pending = Buffer.alloc(0)
      } else if (state === 'done') {
        fail('surplus_response_bytes')
      } else if (state === 'chunk-crlf') {
        if (pending.length < 2) return
        if (pending[0] !== 13 || pending[1] !== 10) { fail('invalid_chunk_terminator'); return }
        pending = pending.subarray(2); chunkMetadata += 2; state = 'chunk-size'
      } else {
        const boundary = pending.indexOf('\r\n')
        const limit = state === 'chunk-size' ? MAX_CHUNK_LINE_BYTES : MAX_HEADER_BYTES
        if (boundary < 0) { if (pending.length > limit) fail('chunk_metadata_limit'); return }
        chunkMetadata += boundary + 2
        if (boundary > limit || chunkMetadata > MAX_CHUNK_METADATA_BYTES) { fail('chunk_metadata_limit'); return }
        const line = pending.subarray(0, boundary).toString('latin1')
        pending = pending.subarray(boundary + 2)
        if (state === 'chunk-size') {
          // Bounded token/quoted-string extensions; no permissive parseInt tail.
          if (!/^[0-9a-f]+(?:;[!#$%&'*+.^_`|~0-9a-z-]+(?:=(?:[!#$%&'*+.^_`|~0-9a-z-]+|"(?:[\t !#-\[\]-~\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"))?)*$/i.test(line)) {
            fail('invalid_chunk_size'); return
          }
          remaining = Number.parseInt(line.split(';', 1)[0]!, 16)
          if (!Number.isSafeInteger(remaining)) { fail('invalid_chunk_size'); return }
          state = remaining === 0 ? 'trailers' : 'chunk-data'
        } else {
          trailerBytes += boundary + 2
          if (trailerBytes > MAX_HEADER_BYTES) { fail('trailer_limit'); return }
          if (!line) { state = 'done'; continue }
          const parsed = field(line)
          if (!parsed || ++headerFields > MAX_HEADER_FIELDS ||
            ['content-length', 'transfer-encoding', 'content-encoding', 'connection', 'trailer',
              'location', 'x-agent-teams-hosted-operation-nonce'].includes(parsed[0])) {
            fail('invalid_trailer'); return
          }
          // Trailers do not enter the response-header metadata/authority domain.
        }
      }
    }
  }
  const ended = () => finish(true)
  const failed = () => finish(false)
  const closed = () => { socket.off('error', failed); finish(false) }
  const aborted = () => finish(false)
  socket.on('data', data)
  socket.once('end', ended)
  socket.once('error', failed)
  socket.once('close', closed)
  signal.addEventListener('abort', aborted, { once: true })
  if (signal.aborted || socket.destroyed) finish(false)
  return { response, cancel: () => finish(false) }
}
