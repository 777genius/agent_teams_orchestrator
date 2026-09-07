import { describe, expect, test } from 'bun:test'
import { createOpenCodeSupervisedEventFetch } from './OpenCodeSupervisedEventStream.js'
import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'
import { supervisedFixture, supervisedTestWait } from './OpenCodeSupervisedCustody.test-fixture.js'

describe.skipIf(process.platform !== 'linux')('supervised SSE completion over the actual socket', () => {
  test('a connected token abandoned by socket closure is consumed before custody release', async () => {
    let entered!: () => void, release!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0, consumed = 0, closed = false
    const fixture = await supervisedFixture({ mutateBundle(bundle) {
      const original = bundle.prepareEffectToken.bind(bundle)
      bundle.prepareEffectToken = async () => {
        if (++calls === 1) return original() // Actual initial custody admission.
        entered()
        await gate
        return { consume() { consumed++; return true } }
      }
      bundle.closeOwnerResources = async () => { closed = true }
    } })
    let custody: Awaited<ReturnType<typeof fixture.acquire>> | undefined
    try {
      custody = await fixture.acquire()
      const response = createOpenCodeSupervisedEventFetch(custody)(fixture.expected.endpoint.baseUrl + '/event')
        .catch(error => error)
      await supervisedTestWait(preparing, 'connected authorization')
      expect(fixture.connections).toHaveLength(1)
      fixture.connections[0]!.socket.destroy()
      await supervisedTestWait(fixture.connections[0]!.closed, 'remote socket closure')
      const closing = custody.closeOwnerResources()
      expect(closed).toBe(false)
      expect(consumed).toBe(0)
      release()
      expect(await supervisedTestWait(response, 'cancelled SSE authorization')).toBeInstanceOf(Error)
      await supervisedTestWait(closing, 'SSE authorization resource drain')
      expect(consumed).toBe(1)
      expect(closed).toBe(true)
      expect(fixture.requests).toHaveLength(0)
      expect(fixture.observations.some(record => record.phase === 'response')).toBe(false)
    } finally { release(); await custody?.closeOwnerResources(); await fixture.close() }
  }, 120_000)

  test('rejected SSE headers retain the diagnostic entity from the same received packet', async () => {
    const bytes = Buffer.from('{"error":"actual diagnostic"}')
    const fixture = await supervisedFixture({ rawResponse(_request, socket) {
      socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 404 Missing\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length}\r\n\r\n`), bytes]))
    } })
    let custody: Awaited<ReturnType<typeof fixture.acquire>> | undefined
    try {
      custody = await fixture.acquire()
      await expect(supervisedTestWait(createOpenCodeSupervisedEventFetch(custody)(
        fixture.expected.endpoint.baseUrl + '/event'), 'rejected SSE response')).rejects.toThrow('response invalid')
      expect(fixture.observations.find(record => record.phase === 'response')).toMatchObject({
        status: 404, complete: true, body: { bodyBase64: bytes.toString('base64') },
      })
      expect(fixture.observations.map(record => record.phase)).toEqual(['request', 'response', 'failure'])
      expect(custody.rawRetention.isCurrent()).toBe(false)
    } finally { await custody?.closeOwnerResources(); await fixture.close() }
  }, 120_000)

  test('a media-type substring in JSON parameters never exposes an SSE stream', async () => {
    const bytes = Buffer.from('{"diagnostic":"not an event stream"}')
    const fixture = await supervisedFixture({ rawResponse(_request, socket) {
      socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/json; note="text/event-stream"\r\nContent-Length: ${bytes.length}\r\n\r\n`), bytes]))
    } })
    let custody: Awaited<ReturnType<typeof fixture.acquire>> | undefined
    try {
      custody = await fixture.acquire()
      await expect(supervisedTestWait(createOpenCodeSupervisedEventFetch(custody)(
        fixture.expected.endpoint.baseUrl + '/event'), 'non-SSE response')).rejects.toThrow('response invalid')
      expect(fixture.observations.find(record => record.phase === 'response')).toMatchObject({
        status: 200, complete: true, body: { bodyBase64: bytes.toString('base64') },
      })
      expect(custody.rawRetention.isCurrent()).toBe(false)
    } finally { await custody?.closeOwnerResources(); await fixture.close() }
  }, 120_000)

  test('reader cancellation persists the actual prefix before resolving and permits a later provider request', async () => {
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const syncing = new Promise<void>(resolve => { entered = resolve })
    const bytes = Buffer.from('data: {"partial":')
    const fixture = await supervisedFixture({
      handle(request, response) {
        if (request.url === '/event') {
          response.setHeader('content-type', 'Text/Event-Stream; charset=utf-8')
          response.write(bytes)
        } else response.end('{"healthy":true}')
      },
      async sync(observation) {
        if (observation?.phase === 'response' && !observation.complete) { entered(); await gate }
      },
    })
    let custody: Awaited<ReturnType<typeof fixture.acquire>> | undefined
    try {
      custody = await fixture.acquire()
      const response = await supervisedTestWait(createOpenCodeSupervisedEventFetch(custody)(
        fixture.expected.endpoint.baseUrl + '/event'), 'SSE headers')
      const reader = response.body!.getReader()
      expect(Buffer.from((await supervisedTestWait(reader.read(), 'SSE prefix')).value!)).toEqual(bytes)
      let completed = false
      const cancellation = reader.cancel().then(() => { completed = true })
      await supervisedTestWait(syncing, 'SSE response sync')
      expect(completed).toBe(false)
      expect(custody.rawRetention.isCurrent()).toBe(true)
      expect(fixture.observations[1]).toMatchObject({ phase: 'response', complete: false,
        body: { bodyBase64: bytes.toString('base64') } })
      release()
      await supervisedTestWait(cancellation, 'SSE cancellation completion')
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      expect(await client.getHealth()).toEqual({ healthy: true })
      expect(fixture.observations.map(record => record.phase)).toEqual(['request', 'response', 'request', 'response'])
    } finally { release(); await custody?.closeOwnerResources(); await fixture.close() }
  }, 120_000)

  test('remote truncation remains fail closed and retains received SSE bytes', async () => {
    const bytes = Buffer.from('data: partial\n')
    const fixture = await supervisedFixture({ rawResponse(_request, socket) {
      socket.end(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 999\r\n\r\n'), bytes]))
    } })
    let custody: Awaited<ReturnType<typeof fixture.acquire>> | undefined
    try {
      custody = await fixture.acquire()
      const response = await supervisedTestWait(createOpenCodeSupervisedEventFetch(custody)(
        fixture.expected.endpoint.baseUrl + '/event'), 'truncated SSE headers')
      await expect(supervisedTestWait(response.text(), 'truncated SSE settlement')).rejects.toThrow()
      expect(custody.rawRetention.isCurrent()).toBe(false)
      expect(fixture.observations.find(record => record.phase === 'response')).toMatchObject({
        complete: false, body: { bodyBase64: bytes.toString('base64') },
      })
    } finally { await custody?.closeOwnerResources(); await fixture.close() }
  }, 120_000)
})
