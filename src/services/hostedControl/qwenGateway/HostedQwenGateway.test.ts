import { afterEach, expect, test } from 'bun:test'
import { createServer, request, ServerResponse } from 'node:http'
import { createConnection, type AddressInfo } from 'node:net'

import { HostedQwenGateway } from './HostedQwenGateway.js'
import type { HostedQwenAdmission, HostedQwenContainerBinding, HostedQwenGatewayDispatchAuthority } from './HostedQwenGateway.js'
import type { HostedProductCurrentMember } from '../productAuthority/HostedProductCurrentMemberDecision.js'

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
  gateway.admitClient('127.0.0.2')
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

test('a stalled request body loses its lease before any upstream dispatch', async () => {
  let calls = 0
  const upstream = createServer((_req, res) => { calls++; res.end('{}') })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => upstream.close(() => resolve())))
  const port = await freePort()
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, timeoutMs: 1000,
    testOnlyAllowNonRoot: true })
  await gateway.start()
  close.push(() => gateway.stop())
  gateway.admitClient('127.0.0.1')

  const client = createConnection({ host: '127.0.0.1', port })
  client.on('error', () => undefined)
  try {
    await new Promise<void>(resolve => client.once('connect', resolve))
    const closed = new Promise<void>(resolve => client.once('close', () => resolve()))
    client.write('POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n')
    await Promise.race([closed, new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('stalled request was not closed')), 2500)
    })])
    expect(calls).toBe(0)
  } finally { client.destroy() }
})

test('listener opens only while the prepared bridge lease attests its address and generation', async () => {
  const port = await freePort()
  expect(() => new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    maxConcurrent: 2, testOnlyAllowNonRoot: true })).toThrow('hosted-qwen-bounds-invalid')
  const checks: string[] = []
  const bridgeAuthority = {
    async assertBridgeBind(address: string, checkedPort: number, checkedGeneration: string) {
      checks.push(`${address}:${checkedPort}:${checkedGeneration}`)
      if (address !== '127.0.0.1' || checkedPort !== port || checkedGeneration !== 'b'.repeat(32)) {
        throw new Error('hosted-qwen-bind-mismatch')
      }
    },
    assertContainerSource() { throw new Error('not admitted in this listener test') },
  }
  const rejected = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    generation: 'c'.repeat(32), bridgeAuthority, testOnlyAllowNonRoot: true })
  await expect(rejected.start()).rejects.toThrow('hosted-qwen-bind-mismatch')
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    generation: 'b'.repeat(32), bridgeAuthority, testOnlyAllowNonRoot: true })
  await gateway.start()
  close.push(() => gateway.stop())
  expect(checks).toEqual([
    `127.0.0.1:${port}:${'c'.repeat(32)}`,
    `127.0.0.1:${port}:${'b'.repeat(32)}`,
    `127.0.0.1:${port}:${'b'.repeat(32)}`,
  ])
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

const productAdmission: HostedQwenAdmission = {
  member: {
    runId: `run_${'a'.repeat(32)}`, memberId: `member_${'b'.repeat(32)}`,
    teamId: 'team_12345678', laneId: 'lane_12345678', deploymentId: 'deployment_12345678',
    runtimeWorkspaceId: 'workspace_12345678', planSha256: 'c'.repeat(64),
    rosterBindingSha256: 'd'.repeat(64), restoreGeneration: 0, mountGeneration: 1,
  },
  container: { containerId: 'container-1', networkId: 'network-1', containerGeneration: 1,
    containerIp: '127.0.0.1' },
  model: 'local-llama/qwen3-8b',
}

function fakeAuthority(): { authority: HostedQwenGatewayDispatchAuthority;
  setModel(model: string): void; setContainer(container: HostedQwenContainerBinding): void } {
  let model = productAdmission.model
  let container = productAdmission.container
  return {
    authority: {
      async withCurrentMemberDecision(_binding, _kind, callback) {
        return callback({ ...productAdmission.member, model } as HostedProductCurrentMember)
      },
      currentContainer: () => container,
    },
    setModel: next => { model = next },
    setContainer: next => { container = next },
  }
}

test('Product admission denies changed container generation, IP, and model before upstream bytes', async () => {
  let calls = 0
  const upstream = createServer((_req, res) => { calls++; res.end('{}') })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => upstream.close(() => resolve())))
  const fixture = fakeAuthority()
  const port = await freePort()
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, testOnlyAllowNonRoot: true,
    dispatchAuthority: fixture.authority })
  await gateway.start()
  close.push(() => gateway.stop())
  expect(() => gateway.admitClient({ ...productAdmission, model: 'qwen/other' }))
    .toThrow('hosted-qwen-admission-invalid')
  gateway.admitClient(productAdmission)
  fixture.setContainer({ ...productAdmission.container, containerGeneration: 2 })
  expect((await raw(port, 'GET', '/v1/models')).status).toBe(502)
  fixture.setContainer({ ...productAdmission.container, containerIp: '127.0.0.2' })
  expect((await raw(port, 'GET', '/v1/models')).status).toBe(502)
  fixture.setContainer(productAdmission.container)
  fixture.setModel('qwen/changed')
  expect((await raw(port, 'POST', '/v1/chat/completions', '{"model":"qwen3-8b"}')).status).toBe(502)
  expect(calls).toBe(0)
  fixture.setModel(productAdmission.model)
  expect((await raw(port, 'POST', '/v1/chat/completions', '{"model":"qwen/other"}')).status).toBe(403)
  expect(calls).toBe(0)
  expect((await raw(port, 'POST', '/v1/chat/completions', '{"model":"local-llama/qwen3-8b"}')).status).toBe(403)
  expect((await raw(port, 'POST', '/v1/chat/completions', '{"model":"qwen3-8b"}')).status).toBe(200)
  expect(calls).toBe(1)
})

test('Product admission cannot borrow a different firewall source lease', async () => {
  let calls = 0
  const upstream = createServer((_req, res) => { calls++; res.end('{}') })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => upstream.close(() => resolve())))
  const port = await freePort()
  const generation = 'e'.repeat(32)
  const bridgeAuthority = {
    async assertBridgeBind(_address: string, _port: number, checkedGeneration: string) {
      if (checkedGeneration !== generation) throw new Error('hosted-qwen-bind-mismatch')
    },
    assertContainerSource(networkId: string, containerId: string, containerIp: string,
      checkedGeneration: string) {
      if (networkId !== productAdmission.container.networkId ||
        containerId !== productAdmission.container.containerId ||
        containerIp !== productAdmission.container.containerIp || checkedGeneration !== generation) {
        throw new Error('hosted-qwen-source-mismatch')
      }
    },
  }
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, generation, bridgeAuthority,
    dispatchAuthority: fakeAuthority().authority, testOnlyAllowNonRoot: true })
  await gateway.start()
  close.push(() => gateway.stop())
  gateway.admitClient(productAdmission)
  expect((await raw(port, 'GET', '/v1/models')).status).toBe(200)
  expect(() => gateway.admitClient({ ...productAdmission,
    container: { ...productAdmission.container, networkId: 'foreign-network' } }))
    .toThrow('hosted-qwen-source-mismatch')
  expect((await raw(port, 'GET', '/v1/models')).status).toBe(403)
  expect(calls).toBe(1)
})

test('Product revoke before body completion causes zero upstream requests', async () => {
  let calls = 0
  const upstream = createServer((_req, res) => { calls++; res.end('{}') })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => upstream.close(() => resolve())))
  const port = await freePort()
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, testOnlyAllowNonRoot: true,
    dispatchAuthority: fakeAuthority().authority })
  await gateway.start()
  close.push(() => gateway.stop())
  gateway.admitClient(productAdmission)
  const client = request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } })
  client.on('error', () => undefined)
  client.flushHeaders()
  await new Promise<void>(resolve => client.write('{', () => resolve()))
  gateway.revokeClient()
  client.end('}')
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(calls).toBe(0)
})

test('a revoker queued during the Product callback runs after the dispatch write', async () => {
  const events: string[] = []
  const upstream = createServer((_req, res) => res.end('{}'))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => upstream.close(() => resolve())))
  let gateway: HostedQwenGateway
  const authority: HostedQwenGatewayDispatchAuthority = {
    async withCurrentMemberDecision(_binding, _kind, callback) {
      events.push('decision-enter')
      if (events.filter(event => event === 'decision-enter').length === 1) {
        queueMicrotask(() => { events.push('revoke'); gateway.revokeClient() })
      }
      const result = callback({ ...productAdmission.member, model: productAdmission.model } as HostedProductCurrentMember)
      events.push('decision-exit')
      return result
    },
    currentContainer: () => productAdmission.container,
  }
  const port = await freePort()
  gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, testOnlyAllowNonRoot: true,
    dispatchAuthority: authority })
  await gateway.start()
  close.push(() => gateway.stop())
  gateway.admitClient(productAdmission)
  await raw(port, 'GET', '/v1/models').catch(() => undefined)
  expect(events).toEqual(['decision-enter', 'decision-exit', 'revoke'])
})

test('late Product model change aborts held upstream response', async () => {
  let started: (() => void) | null = null
  let release: (() => void) | null = null
  const began = new Promise<void>(resolve => { started = resolve })
  const upstream = createServer((_req, res) => {
    started?.()
    release = () => res.end('{"ok":true}')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) }))
  const fixture = fakeAuthority()
  const port = await freePort()
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, testOnlyAllowNonRoot: true,
    dispatchAuthority: fixture.authority })
  await gateway.start()
  close.push(() => gateway.stop())
  gateway.admitClient(productAdmission)
  const response = raw(port, 'GET', '/v1/models')
  await began
  fixture.setModel('qwen/changed')
  release?.()
  expect((await response).status).toBe(502)
})

test('streaming stops before forwarding a chunk after Product revocation', async () => {
  let release: (() => void) | null = null
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('first')
    release = () => res.end('second')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) }))
  const fixture = fakeAuthority()
  const port = await freePort()
  const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
    upstreamPort: (upstream.address() as AddressInfo).port, testOnlyAllowNonRoot: true,
    dispatchAuthority: fixture.authority })
  await gateway.start()
  close.push(() => gateway.stop())
  gateway.admitClient(productAdmission)
  const received = await new Promise<string>(resolve => {
    const client = request({ host: '127.0.0.1', port, path: '/v1/models' }, res => {
      let text = ''
      res.on('data', (chunk: Buffer) => {
        text += chunk.toString()
        if (text.startsWith('first')) {
          fixture.setModel('qwen/revoked')
          release?.()
        }
      })
      res.on('close', () => resolve(text))
    })
    client.on('error', () => resolve(''))
    client.end()
  })
  expect(received.startsWith('first')).toBe(true)
  expect(received).not.toContain('second')
})

test('response body write executes inside the synchronous Product decision callback', async () => {
  const upstream = createServer((_req, res) => res.end('SECRET'))
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => upstream.close(() => resolve())))
  let inDecision = false
  let protectedWrite: boolean | null = null
  const originalWrite = ServerResponse.prototype.write
  ServerResponse.prototype.write = function(chunk: unknown, ...args: unknown[]) {
    if (Buffer.isBuffer(chunk) && chunk.toString() === 'SECRET') protectedWrite = inDecision
    return Reflect.apply(originalWrite, this, [chunk, ...args])
  } as typeof ServerResponse.prototype.write
  try {
    const authority: HostedQwenGatewayDispatchAuthority = {
      async withCurrentMemberDecision(_binding, _kind, callback) {
        inDecision = true
        try {
          return callback({ ...productAdmission.member, model: productAdmission.model } as HostedProductCurrentMember)
        } finally { inDecision = false }
      },
      currentContainer: () => productAdmission.container,
    }
    const port = await freePort()
    const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
      upstreamPort: (upstream.address() as AddressInfo).port, testOnlyAllowNonRoot: true,
      dispatchAuthority: authority })
    await gateway.start()
    close.push(() => gateway.stop())
    gateway.admitClient(productAdmission)
    expect((await raw(port, 'GET', '/v1/models')).body).toBe('SECRET')
    expect(protectedWrite).toBe(true)
  } finally { ServerResponse.prototype.write = originalWrite }
})

test('backpressure drain during Product decision does not stall later streaming chunks', async () => {
  const upstream = createServer((_req, res) => {
    res.write('SECRET')
    setTimeout(() => res.end('NEXT'), 50)
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise(resolve => upstream.close(() => resolve())))
  const originalWrite = ServerResponse.prototype.write
  let simulated = false
  ServerResponse.prototype.write = function(chunk: unknown, ...args: unknown[]) {
    const result = Reflect.apply(originalWrite, this, [chunk, ...args])
    if (!simulated && Buffer.isBuffer(chunk) && chunk.toString() === 'SECRET') {
      simulated = true
      queueMicrotask(() => this.emit('drain'))
      return false
    }
    return result
  } as typeof ServerResponse.prototype.write
  try {
    const port = await freePort()
    const gateway = new HostedQwenGateway({ bindAddress: '127.0.0.1', port,
      upstreamPort: (upstream.address() as AddressInfo).port, testOnlyAllowNonRoot: true,
      timeoutMs: 1000, dispatchAuthority: fakeAuthority().authority })
    await gateway.start()
    close.push(() => gateway.stop())
    gateway.admitClient(productAdmission)
    expect(await raw(port, 'GET', '/v1/models')).toEqual({ status: 200, body: 'SECRETNEXT' })
    expect(simulated).toBe(true)
  } finally { ServerResponse.prototype.write = originalWrite }
})
