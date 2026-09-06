import { describe, expect, test } from 'bun:test'
import { once } from 'node:events'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import { encodeOpenCodeSocketHttpRequest, readOpenCodeSocketHttpResponse } from './OpenCodeAuthorizedSocketHttp.js'

// Parser gates use real TCP without paying custody's executable-hash cost for
// every malformed frame. Factory/dispatch gates separately prove OS authority.
async function exchange(parts: Array<string | Buffer>, maximumBytes = 16 * 1024, abortAfterPrefix = false) {
  const accepted: Socket[] = []
  const written: Buffer[] = []
  const unsafe: string[] = []
  const controller = new AbortController()
  let client: Socket | undefined
  let serverSent = false
  const server = createServer(socket => {
    accepted.push(socket)
    socket.on('error', () => {})
    socket.once('data', () => {
      serverSent = true
      void (async () => {
        for (const part of parts) {
          const bytes = typeof part === 'string' ? Buffer.from(part, 'latin1') : part
          if (socket.destroyed) return
          written.push(bytes)
          socket.write(bytes)
          // Exercise header, CRLF, chunk-size and entity boundaries in separate
          // writes; receiving packet boundaries are deliberately unrestricted.
          await new Promise<void>(resolve => setImmediate(resolve))
        }
        if (!abortAfterPrefix) socket.end()
      })()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  const timer = setTimeout(() => controller.abort(), 2000)
  try {
    const didAccept = once(server, 'connection')
    client = connect({ host: '127.0.0.1', port })
    client.on('error', () => {})
    await once(client, 'connect')
    await didAccept
    expect(accepted).toHaveLength(1)
    expect(client.localAddress).toBe(accepted[0]!.remoteAddress)
    expect(client.localPort).toBe(accepted[0]!.remotePort)
    expect(client.remoteAddress).toBe(accepted[0]!.localAddress)
    expect(client.remotePort).toBe(accepted[0]!.localPort)
    const reader = readOpenCodeSocketHttpResponse(client, controller.signal, maximumBytes, code => unsafe.push(code))
    if (abortAfterPrefix) {
      let received = 0
      const total = parts.reduce((size, part) => size + part.length, 0)
      client.on('data', bytes => {
        received += bytes.length
        if (received >= total) controller.abort()
      })
    }
    client.write(encodeOpenCodeSocketHttpRequest(new URL(`http://127.0.0.1:${port}/fixture`), {}, Buffer.alloc(0)))
    const response = await reader.response
    expect(serverSent).toBe(true)
    expect(accepted).toHaveLength(1)
    return { response, unsafe, emitted: Buffer.concat(written) }
  } finally {
    clearTimeout(timer)
    client?.destroy()
    for (const socket of accepted) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe('OpenCode authorized socket HTTP framing', () => {
  test('retains exact undecodable and Unicode entity bytes without HTTP normalization', async () => {
    const bytes = Buffer.concat([Buffer.from('é雪'), Buffer.from([0xff, 0, 0xef, 0xbb, 0xbf])])
    const result = await exchange(['HTTP/1.1 200 OK\r', '\nContent-Length: ', String(bytes.length), '\r\n\r', '\n', bytes])
    expect(result.response).toMatchObject({ status: 200, complete: true, bytes, contentEncoding: null })
    expect(result.unsafe).toEqual([])
    expect(result.emitted.subarray(result.emitted.indexOf('\r\n\r\n') + 4)).toEqual(bytes)
  })

  test('dechunks actual entity bytes across informational headers, extensions and trailers', async () => {
    const bytes = Buffer.from('雪é')
    const result = await exchange(['HTTP/1.1 103 Early Hints\r\nLink: </fixture>\r\n\r\n',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Encoding: identity\r\n\r\n',
      '2;fixture="yes"\r', '\n', bytes.subarray(0, 2), '\r', '\n', '3\r\n', bytes.subarray(2),
      '\r\n0\r\nX-Fixture-Trailer: bounded\r\n\r\n'])
    expect(result.response).toMatchObject({ status: 200, complete: true, bytes, contentEncoding: 'identity' })
    expect(result.response.headers.has('link')).toBe(false)
    expect(result.response.headers.has('x-fixture-trailer')).toBe(false)
    expect(result.unsafe).toEqual([])
  })

  for (const status of [204, 205]) for (const complete of [true, false]) {
    test(`${status} immediate EOF retains prefix with complete=${complete}`, async () => {
      const result = await exchange([
        `HTTP/1.1 ${status} No Content\r\nContent-Length: ${complete ? 6 : 100}\r\n\r\nprefix`,
      ])
      expect(result.response).toMatchObject({ status, complete, bytes: Buffer.from('prefix') })
    })
  }

  test('duplicate encoding declarations survive as metadata before rejection', async () => {
    const result = await exchange(['HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n',
      'Content-Encoding: identity\r\ncOnTeNt-EnCoDiNg: identity\r\n\r\n'])
    expect(result.response).toMatchObject({ status: 409, complete: true, contentEncoding: 'identity, identity', bytes: Buffer.alloc(0) })
    expect(result.unsafe).toContain('unexpected_encoding')
  })

  for (const version of ['1.0', '1.1']) {
    test(`HTTP/${version} permits an empty reason phrase only after its separator`, async () => {
      const valid = await exchange([`HTTP/${version} 409 \r\nContent-Length: 0\r\n\r\n`])
      expect(valid.response).toMatchObject({ status: 409, statusText: '', complete: true, bytes: Buffer.alloc(0) })
      expect(valid.unsafe).toEqual([])
      const invalid = await exchange([`HTTP/${version} 409\r\nContent-Length: 0\r\n\r\n`])
      expect(invalid.response).toMatchObject({ status: 409, complete: false, bytes: Buffer.alloc(0) })
      expect(invalid.unsafe).toContain('invalid_status')
    })
  }

  for (const tail of ['0\r\n\r\n', '6\r\nprefix\r\n0\r\n\r\n']) {
    test(`HTTP/1.0 transfer coding keeps ${tail.length} raw tail bytes as incomplete evidence`, async () => {
      const result = await exchange(['HTTP/1.0 409 Conflict\r\ntRaNsFeR-EnCoDiNg: chunked\r\n\r\n', tail])
      expect(result.response).toMatchObject({ status: 409, complete: false, bytes: Buffer.from(tail) })
      expect(result.unsafe).toContain('invalid_framing')
    })
  }

  test('the final response version determines whether transfer coding is allowed', async () => {
    const result = await exchange(['HTTP/1.1 103 Early Hints\r\n\r\n',
      'HTTP/1.0 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'])
    expect(result.response).toMatchObject({ status: 200, complete: false, bytes: Buffer.from('0\r\n\r\n') })
    expect(result.unsafe).toContain('invalid_framing')
  })

  test('malformed status or version/framing retains only the bounded raw tail', async () => {
    const tail = Buffer.from('10\r\n0123456789abcdef\r\n0\r\n\r\n')
    for (const head of ['HTTP/1.0 200 OK\r\nTransfer-Encoding: chunked', 'HTTP/1.1 200\r\nContent-Length: 16']) {
      const result = await exchange([`${head}\r\n\r\n`, tail], 8)
      expect(result.response).toMatchObject({ status: 200, complete: false, bytes: tail.subarray(0, 8) })
      expect(result.unsafe).toContain('response_limit')
    }
  })

  const badFrames = [
    { name: 'duplicate identical length', header: 'Content-Length: 0\r\nContent-Length: 0', tail: '', prefix: '' },
    { name: 'conflicting length', header: 'Content-Length: 0\r\nContent-Length: 1', tail: '', prefix: '' },
    { name: 'comma length', header: 'Content-Length: 0, 0', tail: '', prefix: '' },
    { name: 'length with chunked', header: 'Content-Length: 0\r\nTransfer-Encoding: chunked', tail: '', prefix: '' },
    { name: 'duplicate chunked', header: 'Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked', tail: '', prefix: '' },
    { name: 'unsupported transfer coding', header: 'Transfer-Encoding: gzip', tail: '', prefix: '' },
    { name: 'folded header', header: 'Content-Length: 0\r\n folded', tail: '', prefix: '' },
    { name: 'incomplete length', header: 'Content-Length: 100', tail: 'prefix', prefix: 'prefix' },
    { name: 'incomplete chunk', header: 'Transfer-Encoding: chunked', tail: 'a\r\nprefix', prefix: 'prefix' },
    { name: 'missing final chunk', header: 'Transfer-Encoding: chunked', tail: '6\r\nprefix\r\n', prefix: 'prefix' },
    { name: 'invalid chunk size', header: 'Transfer-Encoding: chunked', tail: '+6\r\nprefix\r\n0\r\n\r\n', prefix: '' },
    { name: 'chunk size tail', header: 'Transfer-Encoding: chunked', tail: '6junk\r\nprefix\r\n0\r\n\r\n', prefix: '' },
    { name: 'chunk terminator', header: 'Transfer-Encoding: chunked', tail: '6\r\nprefixXX', prefix: 'prefix' },
    { name: 'encoding in trailer', header: 'Transfer-Encoding: chunked', tail: '0\r\nContent-Encoding: identity\r\n\r\n', prefix: '' },
    { name: 'operation nonce in trailer', header: 'Transfer-Encoding: chunked', tail: `0\r\nx-agent-teams-hosted-operation-nonce: ${'a'.repeat(64)}\r\n\r\n`, prefix: '' },
  ]
  for (const frame of badFrames) {
    test(`fails closed and keeps the observed prefix: ${frame.name}`, async () => {
      const result = await exchange([`HTTP/1.1 412 Precondition Failed\r\n${frame.header}\r\n\r\n${frame.tail}`])
      expect(result.response).toMatchObject({ status: 412, complete: false, bytes: Buffer.from(frame.prefix) })
      expect(result.unsafe.length).toBeGreaterThan(0)
    })
  }

  test('surplus bytes in a later write cannot validate a completed length', async () => {
    const result = await exchange(['HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}', 'surplus'])
    expect(result.response).toMatchObject({ complete: false, bytes: Buffer.from('{}') })
    expect(result.unsafe).toContain('surplus_response_bytes')
  })

  test('close-delimited entity completes only at EOF', async () => {
    const result = await exchange(['HTTP/1.0 200 OK\r\n\r\nprefix'])
    expect(result.response).toMatchObject({ complete: true, bytes: Buffer.from('prefix') })
    const cancelled = await exchange(['HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nprefix'], 16 * 1024, true)
    expect(cancelled.response).toMatchObject({ complete: false, bytes: Buffer.from('prefix') })
  })

  test('complete length or chunk framing without EOF remains incomplete', async () => {
    for (const wire of ['HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n']) {
      const cancelled = await exchange([wire], 16 * 1024, true)
      expect(cancelled.response.complete).toBe(false)
      expect(cancelled.unsafe).toContain('incomplete_body')
    }
  })

  test('header, field, chunk metadata and body allocation limits fail closed', async () => {
    for (const wire of [
      `HTTP/1.1 200 OK\r\nX-Fill: ${'x'.repeat(16 * 1024)}`,
      `HTTP/1.1 200 OK\r\n${'X-Fill: x\r\n'.repeat(129)}\r\n`,
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1;fill=${'x'.repeat(1024)}\r\na\r\n0\r\n\r\n`,
    ]) expect((await exchange([wire])).response.complete).toBe(false)
    const bytes = Buffer.alloc(16 * 1024 + 1, 0x61)
    const result = await exchange([`HTTP/1.1 200 OK\r\nContent-Length: ${bytes.length}\r\n\r\n`, bytes])
    expect(result.response).toMatchObject({ complete: false, bytes: bytes.subarray(0, 16 * 1024) })
    expect(result.unsafe).toContain('response_limit')
  })

  test('one MiB observation bound retains the full entity', async () => {
    const bytes = Buffer.alloc(1024 * 1024, 0x61)
    const result = await exchange([`HTTP/1.1 200 OK\r\nContent-Length: ${bytes.length}\r\n\r\n`, bytes], bytes.length)
    expect(result.response).toMatchObject({ complete: true, bytes })
  })

  test('serialization binds exact entity bytes, Host and close framing before dispatch', () => {
    const bytes = Buffer.from('雪é')
    const url = new URL('http://127.0.0.1:12345/session/exact?key=value')
    const wire = encodeOpenCodeSocketHttpRequest(url, { method: 'POST', headers: { host: 'substitute', 'content-length': '0' } }, bytes)
    const boundary = wire.indexOf('\r\n\r\n')
    expect(wire.subarray(boundary + 4)).toEqual(bytes)
    expect(wire.toString()).toContain('host: 127.0.0.1:12345\r\n')
    expect(wire.toString()).toContain(`content-length: ${bytes.length}\r\n`)
    expect(wire.toString()).toContain('connection: close\r\n')
    expect(wire.toString()).toContain('accept-encoding: identity\r\n')
    for (const name of ['transfer-encoding', 'trailer', 'upgrade', 'expect']) {
      expect(() => encodeOpenCodeSocketHttpRequest(url, { headers: { [name]: 'unsafe' } }, bytes)).toThrow()
    }
    expect(() => encodeOpenCodeSocketHttpRequest(url, { headers: { 'x-fill': 'x'.repeat(16 * 1024) } }, bytes)).toThrow()
    expect(() => encodeOpenCodeSocketHttpRequest(new URL(`http://127.0.0.1:12345/${'x'.repeat(16 * 1024)}`), {}, bytes)).toThrow()
    expect(() => encodeOpenCodeSocketHttpRequest(url, { headers: Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`x-field-${index}`, 'value']),
    ) }, bytes)).toThrow()
    expect(() => encodeOpenCodeSocketHttpRequest(url, {}, Buffer.alloc(1024 * 1024 + 1))).toThrow()
  })
})
