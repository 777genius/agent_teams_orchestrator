import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'

import { RootOpenCodeLoopbackWire } from '../openCodeRootHttpProxy/RootOpenCodeLoopbackWire.js'
import { RootManagedOpenCodeEndpointAuthority, type RootManagedOpenCodeEndpointSnapshot,
  type RootManagedOpenCodeEndpointLeaseSource } from './RootManagedOpenCodeEndpointAuthority.js'

const binding = { runId: `run_${'a'.repeat(32)}`, memberId: `member_${'b'.repeat(32)}`,
  incarnation: 'owner_session_12345678' }
const handle = `opencode_${'c'.repeat(32)}`
const generation = 'd'.repeat(32)
const password = 'e'.repeat(64)
const body = JSON.stringify({ title: `hosted-member-attempt:member_attempt_${'f'.repeat(64)}` })
const request = { method: 'POST' as const, path: '/session', body,
  contentSha256: createHash('sha256').update(body).digest('hex') }

test('root lease pins a live loopback socket and keeps credential inside the wire', async () => {
  let received = ''
  const server = createServer(socket => socket.on('data', chunk => {
    received += chunk.toString('utf8')
    if (!received.endsWith(body)) return
    socket.end('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n')
  }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test-port-unavailable')
    const snapshot: RootManagedOpenCodeEndpointSnapshot = { ...binding, handle, generation,
      endpoint: `http://127.0.0.1:${address.port}`, state: 'running', effectEnabled: true }
    let releases = 0
    const source: RootManagedOpenCodeEndpointLeaseSource = { async acquire() {
      return { ...snapshot, password, expiresAt: Date.now() + 10_000,
        signal: new AbortController().signal, readCurrentSync: () => snapshot,
        async release() { releases++ } }
    } }
    const wire = new RootOpenCodeLoopbackWire(new RootManagedOpenCodeEndpointAuthority(binding, source))
    const connection = await wire.prepare(handle, generation)
    expect(Object.keys(connection).sort()).toEqual(['close', 'emitSync', 'response'])
    connection.emitSync(request)
    expect(await connection.response).toEqual({ statusCode: 204, body: null })
    expect(received).toContain(`Authorization: Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`)
    await connection.close()
    expect(releases).toBe(1)
  } finally { server.close() }
})

test('swapped member, incarnation, or endpoint fails before HTTP bytes', async () => {
  let received = 0
  const server = createServer(socket => socket.on('data', chunk => { received += chunk.length }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test-port-unavailable')
    const snapshot: RootManagedOpenCodeEndpointSnapshot = { ...binding, handle, generation,
      endpoint: `http://127.0.0.1:${address.port}`, state: 'running', effectEnabled: true }
    for (const changed of [
      { ...snapshot, memberId: `member_${'1'.repeat(32)}` },
      { ...snapshot, incarnation: 'owner_session_87654321' },
      { ...snapshot, endpoint: 'http://example.invalid:49152' },
    ]) {
      let released = 0
      const authority = new RootManagedOpenCodeEndpointAuthority(binding, { async acquire() {
        return { ...changed, password, expiresAt: Date.now() + 10_000,
          signal: new AbortController().signal, readCurrentSync: () => changed,
          async release() { released++ } }
      } })
      await expect(authority.acquireConnected(handle, generation)).rejects.toThrow('endpoint-unavailable')
      expect(released).toBe(1)
    }
    let current = snapshot
    let released = 0
    const wire = new RootOpenCodeLoopbackWire(new RootManagedOpenCodeEndpointAuthority(binding,
      { async acquire() { return { ...snapshot, password, expiresAt: Date.now() + 10_000,
        signal: new AbortController().signal, readCurrentSync: () => current,
        async release() { released++ } } } }))
    const prepared = await wire.prepare(handle, generation)
    current = { ...snapshot, endpoint: 'http://127.0.0.1:49152' }
    expect(() => prepared.emitSync(request)).toThrow('endpoint-revoked')
    await prepared.close()
    await prepared.response.catch(() => undefined)
    expect(released).toBe(1)
    expect(received).toBe(0)
  } finally { server.close() }
})

test('revocation closes a prepared socket and blocks its one write', async () => {
  let received = 0
  const server = createServer(socket => socket.on('data', chunk => { received += chunk.length }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test-port-unavailable')
    const snapshot: RootManagedOpenCodeEndpointSnapshot = { ...binding, handle, generation,
      endpoint: `http://127.0.0.1:${address.port}`, state: 'running', effectEnabled: true }
    const revocation = new AbortController()
    let releases = 0
    const authority = new RootManagedOpenCodeEndpointAuthority(binding, { async acquire() {
      return { ...snapshot, password, expiresAt: Date.now() + 10_000,
        signal: revocation.signal, readCurrentSync: () => snapshot,
        async release() { releases++ } }
    } })
    const wire = new RootOpenCodeLoopbackWire(authority)
    const prepared = await wire.prepare(handle, generation)
    revocation.abort()
    expect(() => prepared.emitSync(request)).toThrow()
    await prepared.close()
    await prepared.response.catch(() => undefined)
    expect(releases).toBe(1)
    expect(received).toBe(0)
    await expect(authority.acquireConnected(handle, generation)).rejects.toThrow('endpoint-unavailable')
    expect(releases).toBe(2)
  } finally { server.close() }
})
