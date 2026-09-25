import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'

import { RootOpenCodeLoopbackWire } from './RootOpenCodeLoopbackWire.js'

const handle = `opencode_${'a'.repeat(32)}`
const generation = 'b'.repeat(32)
const password = 'c'.repeat(64)
const body = JSON.stringify({ title: `hosted-member-attempt:member_attempt_${'d'.repeat(64)}` })
const request = { method: 'POST' as const, path: '/session', body,
  contentSha256: createHash('sha256').update(body).digest('hex') }

test('root loopback wire emits one exact HTTP request and never returns Basic credential', async () => {
  let captured = ''
  const server = createServer(socket => {
    socket.on('data', chunk => {
      captured += chunk.toString('utf8')
      if (!captured.endsWith(body)) return
      const reply = JSON.stringify({ id: `ses${'e'.repeat(12)}` })
      socket.end(`HTTP/1.1 201 Created\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(reply)}\r\nConnection: close\r\n\r\n${reply}`)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test-port-missing')
    const wire = new RootOpenCodeLoopbackWire({ async resolve() {
      return { handle, generation, endpoint: `http://127.0.0.1:${address.port}`, password }
    } })
    const connection = await wire.prepare(handle, generation)
    connection.emitSync(request)
    expect(await connection.response).toEqual({ statusCode: 201, body: { id: `ses${'e'.repeat(12)}` } })
    expect(captured).toContain(`Authorization: Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`)
    expect(captured).toContain(`POST /session HTTP/1.1`)
    expect(() => connection.emitSync(request)).toThrow('wire-unavailable')
    connection.close()
  } finally { server.close() }
})

test('root loopback wire rejects an arbitrary route and unverified endpoint', async () => {
  const wire = new RootOpenCodeLoopbackWire({ async resolve() {
    return { handle, generation, endpoint: 'http://evil.invalid:8080', password }
  } })
  await expect(wire.prepare(handle, generation)).rejects.toThrow('proof-invalid')
})

test('root loopback wire rejects a forged POST body before sending bytes', async () => {
  let received = 0
  const server = createServer(socket => socket.on('data', data => { received += data.length }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test-port-missing')
    const wire = new RootOpenCodeLoopbackWire({ async resolve() {
      return { handle, generation, endpoint: `http://127.0.0.1:${address.port}`, password }
    } })
    const connection = await wire.prepare(handle, generation)
    const forged = JSON.stringify({ title: 'arbitrary' })
    expect(() => connection.emitSync({ ...request, body: forged,
      contentSha256: createHash('sha256').update(forged).digest('hex') })).toThrow('request-invalid')
    connection.close()
    await connection.response.catch(() => undefined)
    expect(received).toBe(0)
  } finally { server.close() }
})
