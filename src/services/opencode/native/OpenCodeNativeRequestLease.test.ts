import { afterEach, expect, spyOn, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'
import { Client } from 'undici/index.js'
import * as custody from './OpenCodeNativeCustody.js'
import { fetchNativeOpenCode } from './OpenCodeNativeRequestLease.js'
import { OpenCodeClientFactory, OpenCodeHttpError } from '../OpenCodeClientFactory.js'

const servers = new Set<Server>(), sockets = new Set<Socket>()
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()))
  servers.clear(); sockets.clear()
})
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function endpoint(reply: (socket: Socket, bytes: Buffer) => void) {
  const connections = deferred<void>(), received: Buffer[] = []
  const server = createServer(socket => {
    sockets.add(socket); connections.resolve()
    socket.on('data', bytes => { received.push(bytes); reply(socket, bytes) })
  })
  servers.add(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { baseUrl: `http://127.0.0.1:${address.port}`, connections, received }
}
const ok = (socket: Socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}')

// Synthetic peers/authority only. This exercises the real Bun + installed Undici
// + net.Socket path, and does not claim kernel/native-helper qualification.
async function withAuthority(baseUrl: string, peer: () => Promise<void>, run: (owner: object, change: () => void, checks: object[]) => Promise<void>) {
  const owner = {}, checks: object[] = []
  const admitted = { reference: { baseUrl, epoch: 'TEST-A', authorization: 'Basic VEVTVDozMjBiaXRz' }, verifyPeer: peer } as unknown as custody.NativeCustody
  let durable = admitted
  const select = spyOn(custody, 'nativeCustodyForRequest').mockImplementation((candidate, origin) => {
    if (candidate !== owner || origin !== baseUrl) throw new Error('native_custody_unavailable')
    return admitted
  })
  const recheck = spyOn(custody, 'recheckNativeRequestAuthority').mockImplementation(async captured => {
    checks.push(captured)
    if (captured !== durable) throw new Error('native_custody_unavailable')
  })
  try { await run(owner, () => { durable = { ...admitted } }, checks) }
  finally { select.mockRestore(); recheck.mockRestore() }
}

test('Bun sends zero HTTP/Basic bytes until the exact connected socket passes peer proof', async () => {
  const gate = deferred<void>()
  const e = await endpoint(ok)
  await withAuthority(e.baseUrl, () => gate.promise, async (owner, _change, checks) => {
    const pending = fetchNativeOpenCode(e.baseUrl + '/config', { signal: AbortSignal.timeout(2000) }, owner)
    await e.connections.promise
    await Bun.sleep(30)
    expect(Buffer.concat(e.received).length).toBe(0)
    gate.resolve()
    expect(await (await pending).text()).toBe('{}')
    expect(checks).toHaveLength(1)
    expect(Buffer.concat(e.received).toString()).toContain('authorization: Basic VEVTVDozMjBiaXRz')
  })
})

test('stale A-to-new B handoff after peer proof cannot adopt B by its reused URL', async () => {
  const gate = deferred<void>(), peerReached = deferred<void>()
  const events: string[] = []
  const e = await endpoint(ok)
  await withAuthority(e.baseUrl, async () => {
    events.push('peer-enter'); peerReached.resolve()
    await gate.promise
    events.push('peer-complete')
  }, async (owner, change, checks) => {
    const signal = AbortSignal.timeout(2000)
    const pending = fetchNativeOpenCode(e.baseUrl + '/session', { method: 'POST', body: '{}', signal }, owner)
    // Observe rejection immediately, including failures before verifyPeer entry.
    const settled = pending.then(() => null, error => error)
    const phase = await Promise.race([
      peerReached.promise.then(() => 'peer-entered' as const),
      settled.then(() => 'settled-before-peer' as const),
    ])
    if (phase === 'settled-before-peer') {
      const error = await settled
      const refusal = error instanceof Error && error.message === 'native_custody_unavailable' ? 'unavailable'
        : error instanceof Error && error.message === 'native_custody_cancelled' ? 'cancelled' : 'other'
      console.info('TEST stale handoff witness', JSON.stringify({ phase, events, rechecks: checks.length,
        aborted: signal.aborted, refusal }))
      expect(phase).toBe('peer-entered')
      return
    }
    await e.connections.promise
    const started = performance.now()
    change(); gate.resolve()
    const error = await settled
    const elapsedMs = performance.now() - started
    // On a platform regression, retain the admission witnesses before the exact
    // refusal assertion; no private headers or custody objects are reported.
    console.info('TEST stale handoff witness', JSON.stringify({ events, rechecks: checks.length,
      aborted: signal.aborted, elapsedMs, refusal: error instanceof Error && error.message === 'native_custody_unavailable' ? 'unavailable'
        : error instanceof Error && error.message === 'native_custody_cancelled' ? 'cancelled' : 'other' }))
    expect(events).toEqual(['peer-enter', 'peer-complete'])
    expect(checks).toHaveLength(1)
    expect(Buffer.concat(e.received).length).toBe(0)
    expect(signal.aborted).toBe(false)
    expect(elapsedMs).toBeLessThan(1000)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('native_custody_unavailable')
  })
})

test('a committed POST followed by reset is dispatched once with no reconnect or path replay', async () => {
  let requests = 0
  const e = await endpoint(socket => { requests++; socket.destroy() })
  await withAuthority(e.baseUrl, async () => {}, async owner => {
    const client = new OpenCodeClientFactory({ fetchImpl: (input, init) => fetchNativeOpenCode(input, init, owner) }).create(e.baseUrl)
    await expect(client.answerPermission({ requestId: 'TEST-once', decision: 'allow' })).rejects.toThrow('native_custody_unavailable')
    expect(requests).toBe(1)
  })
})

test('redirect response never sends Basic to another endpoint', async () => {
  let foreign = 0
  const other = await endpoint(socket => { foreign++; ok(socket) })
  const e = await endpoint(socket => socket.end(`HTTP/1.1 302 Found\r\nLocation: ${other.baseUrl}/foreign\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`))
  await withAuthority(e.baseUrl, async () => {}, async owner => {
    const response = await fetchNativeOpenCode(e.baseUrl + '/config', { signal: AbortSignal.timeout(2000) }, owner)
    expect(response.status).toBe(302)
    await response.text()
    expect(foreign).toBe(0)
  })
})

test('bare URLs and serialized DTOs cannot capture a request authority', async () => {
  await expect(fetchNativeOpenCode('http://127.0.0.1:1/config')).rejects.toThrow('native_custody_unavailable')
  await expect(fetchNativeOpenCode('http://127.0.0.1:1/config', undefined, { baseUrl: 'http://127.0.0.1:1' })).rejects.toThrow('native_custody_unavailable')
})

test('permission fallback is restricted to typed HTTP 404/405', async () => {
  const paths: string[] = []
  const client = new OpenCodeClientFactory({ fetchImpl: async input => {
    paths.push(String(input))
    return new Response(paths.length === 1 ? 'unsupported' : '{}', { status: paths.length === 1 ? 404 : 200 })
  } }).create('http://TEST-loopback')
  expect(await client.answerPermission({ requestId: 'TEST-fallback', decision: 'reject' })).toEqual({})
  expect(paths).toHaveLength(2)
  expect(paths[1]).toEndWith('/permission/TEST-fallback/reply')
  expect(new OpenCodeHttpError(405).status).toBe(405)
})

for (const failure of [401, 403, 500, new Error('connection reset (404 unsupported)'), new DOMException('cancelled', 'AbortError')]) {
  test(`permission uncertainty does not replay: ${typeof failure === 'number' ? failure : failure.name}`, async () => {
    let requests = 0
    const client = new OpenCodeClientFactory({ fetchImpl: async () => {
      requests++
      if (typeof failure !== 'number') throw failure
      return new Response('TEST-failure', { status: failure })
    } }).create('http://TEST-loopback')
    await expect(client.answerPermission({ requestId: 'TEST-no-replay', decision: 'always' })).rejects.toThrow()
    expect(requests).toBe(1)
  })
}

test('bounded reconciliation 404 keeps typed message pagination fallback reachable', async () => {
  const paths: string[] = []
  const client = new OpenCodeClientFactory({ fetchImpl: async input => {
    paths.push(String(input))
    return paths.length === 1
      ? new Response('TEST-unsupported', { status: 404 })
      : Response.json([{ info: { id: 'msg_TEST', sessionID: 'ses_TEST' }, parts: [] }])
  } }).create('http://TEST-loopback', { boundedReconciliation: true })
  expect(await client.getSessionMessage?.('ses_TEST', 'msg_TEST')).toMatchObject({ info: { id: 'msg_TEST' } })
  expect(paths).toHaveLength(2)
  expect(paths[1]).toEndWith('/session/ses_TEST/message?limit=50')
})

test('bounded reconciliation permission fallback accepts typed405 without leaking its body', async () => {
  let requests = 0
  const client = new OpenCodeClientFactory({ fetchImpl: async () => {
    requests++
    return requests === 1 ? new Response('TEST-private-response', { status: 405 }) : Response.json({ accepted: true })
  } }).create('http://TEST-loopback', { boundedReconciliation: true })
  expect(await client.answerPermission({ requestId: 'TEST-unsupported', decision: 'allow' })).toEqual({ accepted: true })
  expect(requests).toBe(2)
})

test('bounded reconciliation transport reset cannot become an unsupported-route replay', async () => {
  let requests = 0
  const client = new OpenCodeClientFactory({ fetchImpl: async () => { requests++; throw new Error('TEST-reset (404 route)') } })
    .create('http://TEST-loopback', { boundedReconciliation: true })
  await expect(client.answerPermission({ requestId: 'TEST-reset', decision: 'allow' })).rejects.toThrow('TEST-reset')
  expect(requests).toBe(1)
})

test('cancelling an unread admitted response tolerates already-buffered and late data', async () => {
  const e = await endpoint(socket => {
    socket.on('error', () => undefined)
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 131072\r\nConnection: close\r\n\r\n')
    socket.write(Buffer.alloc(65536, 120))
    setTimeout(() => { if (!socket.destroyed) socket.end(Buffer.alloc(65536, 121)) }, 10)
  })
  await withAuthority(e.baseUrl, async () => {}, async owner => {
    const response = await fetchNativeOpenCode(e.baseUrl + '/TEST-cancel', { signal: AbortSignal.timeout(2000) }, owner)
    await response.body!.cancel()
    // Let Bun's queued readable resume/data callbacks run after cancellation.
    await Bun.sleep(30)
    expect(response.body!.locked).toBe(false)
  })
})

test('cancelling a pending body read closes it without waiting for late data and disposes once', async () => {
  const late = deferred<void>(), closed = deferred<void>()
  const e = await endpoint(socket => {
    socket.on('error', () => undefined)
    socket.once('close', () => closed.resolve())
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n')
    setTimeout(() => { if (!socket.destroyed) socket.end('xy'); late.resolve() }, 20)
  })
  const destroy = spyOn(Client.prototype, 'destroy')
  try {
    await withAuthority(e.baseUrl, async () => {}, async owner => {
      const response = await fetchNativeOpenCode(e.baseUrl + '/TEST-pending-cancel', { signal: AbortSignal.timeout(2000) }, owner)
      const reader = response.body!.getReader()
      const pending = reader.read()
      await reader.cancel()
      expect(await pending).toEqual({ done: true, value: undefined })
      await reader.cancel()
      await Promise.all([closed.promise, late.promise])
      // Undici's promise overload re-enters its callback overload internally.
      expect(destroy.mock.calls.filter(args => args.length === 0)).toHaveLength(1)
      reader.releaseLock()
    })
  } finally { destroy.mockRestore() }
})

test('abort during a pending body read rejects with a sanitized error and disposes once', async () => {
  const e = await endpoint(socket => {
    socket.on('error', () => undefined)
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n')
  })
  const destroy = spyOn(Client.prototype, 'destroy')
  try {
    await withAuthority(e.baseUrl, async () => {}, async owner => {
      const controller = new AbortController()
      const response = await fetchNativeOpenCode(e.baseUrl + '/TEST-abort', { signal: controller.signal }, owner)
      const pending = response.text()
      controller.abort()
      await expect(pending).rejects.toThrow('native_custody_response_failed')
      await Bun.sleep(0)
      // Undici's promise overload re-enters its callback overload internally.
      expect(destroy.mock.calls.filter(args => args.length === 0)).toHaveLength(1)
    })
  } finally { destroy.mockRestore() }
})

test('body EOF closes once and subsequent cancel does not dispose twice', async () => {
  const e = await endpoint(ok)
  const destroy = spyOn(Client.prototype, 'destroy')
  try {
    await withAuthority(e.baseUrl, async () => {}, async owner => {
      const response = await fetchNativeOpenCode(e.baseUrl + '/TEST-eof', undefined, owner)
      const reader = response.body!.getReader()
      let text = ''
      while (true) {
        const value = await reader.read()
        if (value.done) break
        text += new TextDecoder().decode(value.value)
      }
      expect(text).toBe('{}')
      expect(await reader.read()).toEqual({ done: true, value: undefined })
      await reader.cancel()
      await Bun.sleep(0)
      // Undici's promise overload re-enters its callback overload internally.
      expect(destroy.mock.calls.filter(args => args.length === 0)).toHaveLength(1)
      reader.releaseLock()
    })
  } finally { destroy.mockRestore() }
})

test('truncated body errors stay sanitized after partial data and dispose once', async () => {
  const e = await endpoint(socket => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nTEST-partial'))
  const destroy = spyOn(Client.prototype, 'destroy')
  try {
    await withAuthority(e.baseUrl, async () => {}, async owner => {
      const response = await fetchNativeOpenCode(e.baseUrl + '/TEST-truncated', undefined, owner)
      const error = await response.text().then(() => null, error => error)
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe('native_custody_response_failed')
      expect(error.cause).toBeUndefined()
      await Bun.sleep(0)
      // Undici's promise overload re-enters its callback overload internally.
      expect(destroy.mock.calls.filter(args => args.length === 0)).toHaveLength(1)
    })
  } finally { destroy.mockRestore() }
})

test('manual body streaming delivers the first chunk before the server releases the remainder', async () => {
  let release!: () => void
  const e = await endpoint(socket => {
    socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n')
    release = () => socket.end('5\r\nworld\r\n0\r\n\r\n')
  })
  await withAuthority(e.baseUrl, async () => {}, async owner => {
    const response = await fetchNativeOpenCode(e.baseUrl + '/TEST-stream', { signal: AbortSignal.timeout(2000) }, owner)
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('hello')
    release()
    let text = 'hello'
    while (true) {
      const value = await reader.read()
      if (value.done) break
      text += new TextDecoder().decode(value.value)
    }
    expect(text).toBe('helloworld')
    reader.releaseLock()
  })
})
