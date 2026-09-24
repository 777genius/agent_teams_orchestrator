import { afterEach, expect, test } from 'bun:test'
import { createServer, request } from 'node:http'
import { createConnection, type AddressInfo } from 'node:net'

import { HostedQwenGateway } from './HostedQwenGateway.js'

const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of close.splice(0).reverse()) await stop() })

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function raw(port: number, method: string, path: string, body = ''): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path,
      headers: body ? { 'content-type': 'application/json' } : {} }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('only the admitted client and exact OpenAI routes reach the fixed loopback upstream', async () => {
  const calls: string[] = []
  const upstream = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json', location: 'http://example.invalid' })
    res.end('{"ok":true}')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => upstream.close(() => resolve())))
  const port = await freePort()
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, testOnlyAllowNonRoot: true })
  await gateway.start()
  close.push(() => gateway.stop())

  expect((await raw(port, 'GET', '/v1/models')).status).toBe(403)
  gateway.admitClient('127.0.0.1')
  expect(await raw(port, 'GET', '/v1/models')).toEqual({ status: 200, body: '{"ok":true}' })
  expect(await raw(port, 'POST', '/v1/chat/completions', '{"model":"qwen3-8b"}')).toEqual(
    { status: 200, body: '{"ok":true}' })
  expect((await raw(port, 'GET', '/v1/other')).status).toBe(400)
  expect((await raw(port, 'POST', '/v1/models', '{}')).status).toBe(400)
  expect(calls).toEqual(['GET /v1/models', 'POST /v1/chat/completions'])
  gateway.revokeClient()
  expect((await raw(port, 'GET', '/v1/models')).status).toBe(403)
})

test('oversize body is rejected before any upstream request, and redirects are blocked', async () => {
  let calls = 0
  const upstream = createServer((_req, res) => { calls++; res.writeHead(302, { location: 'http://example.invalid' }).end() })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => upstream.close(() => resolve())))
  const port = await freePort()
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, maxRequestBytes: 8,
    testOnlyAllowNonRoot: true })
  await gateway.start()
  close.push(() => gateway.stop())
  gateway.admitClient('127.0.0.1')
  expect((await raw(port, 'POST', '/v1/chat/completions', '{"too":"large"}')).status).toBe(413)
  expect(calls).toBe(0)
  expect((await raw(port, 'GET', '/v1/models')).status).toBe(502)
  expect(calls).toBe(1)
})

test('revoking admission while a body is pending cannot dispatch it upstream', async () => {
  let calls = 0
  const upstream = createServer((_req, res) => { calls++; res.end('{}') })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => upstream.close(() => resolve())))
  const port = await freePort()
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, testOnlyAllowNonRoot: true })
  await gateway.start()
  close.push(() => gateway.stop())
  gateway.admitClient('127.0.0.1')

  const client = request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } })
  client.on('error', () => undefined)
  client.flushHeaders()
  await new Promise<void>(resolve => client.write('{', () => resolve()))
  await new Promise(resolve => setTimeout(resolve, 50))
  gateway.revokeClient()
  client.end('}')
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(calls).toBe(0)
})

test('one pending request consumes the finite capacity and disconnect releases it', async () => {
  let calls = 0
  const upstream = createServer((_req, res) => { calls++; res.end('{}') })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => upstream.close(() => resolve())))
  const port = await freePort()
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, maxConcurrent: 1,
    testOnlyAllowNonRoot: true })
  await gateway.start()
  close.push(() => gateway.stop())
  gateway.admitClient('127.0.0.1')

  const pending = request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } })
  pending.on('error', () => undefined)
  pending.flushHeaders()
  await new Promise<void>(resolve => pending.write('{', () => resolve()))
  await new Promise(resolve => setTimeout(resolve, 30))
  expect((await raw(port, 'GET', '/v1/models')).status).toBe(429)
  expect(calls).toBe(0)
  pending.destroy()
  await new Promise(resolve => setTimeout(resolve, 30))
  expect((await raw(port, 'GET', '/v1/models')).status).toBe(200)
  expect(calls).toBe(1)
})

test('gateway stop aborts active upstream HTTP', async () => {
  let started = 0
  let closed = 0
  const upstream = createServer((req, _res) => {
    started++
    req.socket.once('close', () => { closed++ })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) }))
  const port = await freePort()
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, testOnlyAllowNonRoot: true })
  await gateway.start()
  close.push(() => gateway.stop())
  gateway.admitClient('127.0.0.1')
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 50 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(predicate()).toBe(true)
  }
  const client = createConnection({ host: '127.0.0.1', port })
  client.on('error', () => undefined)
  await new Promise<void>(resolve => client.once('connect', () => resolve()))
  client.write('GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
  await until(() => started === 1)
  await gateway.stop()
  await until(() => closed === 1)
})

test('a disconnected held upstream expires and releases finite capacity', async () => {
  let calls = 0
  let closed = 0
  const upstream = createServer((req, res) => {
    calls++
    if (calls === 1) {
      req.socket.once('close', () => { closed++ })
      return
    }
    res.end('{}')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) }))
  const port = await freePort()
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, maxConcurrent: 1,
    timeoutMs: 1000, testOnlyAllowNonRoot: true })
  await gateway.start()
  close.push(() => gateway.stop())
  gateway.admitClient('127.0.0.1')
  const client = createConnection({ host: '127.0.0.1', port })
  client.on('error', () => undefined)
  await new Promise<void>(resolve => client.once('connect', () => resolve()))
  client.write('GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
  for (let i = 0; i < 50 && calls === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(calls).toBe(1)
  client.destroy()
  await new Promise(resolve => setTimeout(resolve, 1150))
  expect(closed).toBe(1)
  expect((await raw(port, 'GET', '/v1/models')).status).toBe(200)
  expect(calls).toBe(2)
})
