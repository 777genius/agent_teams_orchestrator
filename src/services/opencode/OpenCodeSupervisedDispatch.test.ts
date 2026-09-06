import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { ClientRequest } from 'node:http'
import { createInterface } from 'node:readline'
import { canonicalHostedApprovalJson, OpenCodeClientFactory,
  OpenCodePermissionConditionRejectedError, OpenCodeRequestNotDispatchedError } from './OpenCodeClientFactory.js'
import { supervisedFixture } from './OpenCodeSupervisedCustody.test-fixture.js'

const condition = { runtimeInstanceId: `runtime_instance_${'1'.repeat(32)}`,
  configGeneration: `config_generation_${'2'.repeat(32)}`, sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
  requestIncarnation: `request_incarnation_${'4'.repeat(32)}`, permissionDigest: '5'.repeat(64) }
const receipt = { schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2', status: 'applied',
  ...condition, requestId: 'per_test', sessionId: 'ses_test', decision: 'allow_once' }
const reply = { requestId: 'per_test', sessionId: 'ses_test', decision: 'allow' as const,
  condition: { ...condition, authorizeConnected: async () => () => true } }

describe.skipIf(process.platform !== 'linux')('OpenCode supervised dispatch', () => {
  test('durable request precedes finalizer/end; raw response precedes validation; frames stay 10/11', async () => {
    let release!: () => void
    let syncing!: () => void
    const started = new Promise<void>(resolve => { syncing = resolve })
    const synced = new Promise<void>(resolve => { release = resolve })
    let firstSync = true
    const fixture = await supervisedFixture({
      async sync() { if (firstSync) { firstSync = false; syncing(); await synced } },
      handle(_request, response) { response.end(canonicalHostedApprovalJson(receipt)) },
    })
    let finalized = false
    let changed = false
    let atEnd = true
    const originalEnd = ClientRequest.prototype.end
    ClientRequest.prototype.end = function (...args: unknown[]) {
      atEnd = changed
      return originalEnd.apply(this, args as never)
    } as typeof ClientRequest.prototype.end
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl, {}, { password: 'override', directory: '/wrong' })
      const pending = client.answerPermission({ ...reply, condition: { ...condition,
        authorizeConnected: async () => () => {
          finalized = true; queueMicrotask(() => { changed = true }); return true
        } } })
      await started
      expect(finalized).toBe(false)
      expect(fixture.requests).toHaveLength(0)
      expect(fixture.connections.flatMap(connection => connection.chunks)).toHaveLength(0)
      release()
      await expect(pending).resolves.toEqual(receipt)
      expect(finalized).toBe(true)
      expect(atEnd).toBe(false)
      expect(Object.keys(JSON.parse(fixture.requests[0]!.body.toString()))).toHaveLength(10)
      expect(Object.keys(receipt)).toHaveLength(11)
      expect(fixture.requests[0]!.headers.authorization).not.toContain('override')
      expect(fixture.observations.map(record => record.phase)).toEqual(['request', 'response'])
      expect(fixture.observations[1]).toMatchObject({ correlation: 'unavailable', peerOperationNonce: null })
    } finally { ClientRequest.prototype.end = originalEnd; release?.(); await fixture.close() }
  })

  test('only accepted empty 409/412 are no-effect; all other retained failures remain uncertain', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{'),
      Buffer.from('{"a":1,"a":2}'), Buffer.from('{"z":0,"a":1}'),
      Buffer.from('{}'), Buffer.from('[]'), Buffer.from('{"error":"condition_failed"}')]) {
      for (const status of [400, 409, 412]) {
        const fixture = await supervisedFixture({ handle(_request, response) {
          response.statusCode = status; response.end(bytes)
        } })
        try {
          const custody = await fixture.acquire()
          const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
            .create(fixture.expected.endpoint.baseUrl)
          let error: unknown
          try { await client.answerPermission(reply) } catch (caught) { error = caught }
          const noEffect = bytes.length === 0 && (status === 409 || status === 412)
          expect(error).toBeInstanceOf(Error)
          expect(error instanceof OpenCodePermissionConditionRejectedError).toBe(noEffect)
          expect(error).not.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
          const retained = fixture.observations.find(record => record.phase === 'response')!
          expect(retained.phase === 'response' && Buffer.from(retained.body.bodyBase64, 'base64')).toEqual(bytes)
          expect(custody.rawRetention.isCurrent()).toBe(noEffect)
          expect(fixture.requests).toHaveLength(1)
        } finally { await fixture.close() }
      }
    }
  }, 120_000)

  test('capture poison at the finalizer transmits zero HTTP credentials', async () => {
    const fixture = await supervisedFixture()
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      await expect(client.answerPermission({ ...reply, condition: { ...condition,
        authorizeConnected: async () => () => { custody.rawRetention.poison('test-revocation'); return true },
      } })).rejects.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
      await Promise.all(fixture.connections.map(connection => connection.closed))
      expect(fixture.connections).toHaveLength(1)
      expect(fixture.connections[0]!.chunks).toHaveLength(0)
      expect(fixture.requests).toHaveLength(0)
    } finally { await fixture.close() }
  })

  test('retains encoded or truncated bytes before poisoning', async () => {
    for (const incomplete of [false, true]) {
      const fixture = await supervisedFixture({ handle(_request, response) {
        if (incomplete) {
          response.setHeader('content-length', '1000')
          response.write('prefix')
          setTimeout(() => response.destroy(), 20)
        } else {
          response.setHeader('content-encoding', 'gzip')
          response.end('compressed-bytes')
        }
      } })
      try {
        const custody = await fixture.acquire()
        const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
          .create(fixture.expected.endpoint.baseUrl)
        await expect(client.answerPermission(reply)).rejects.toThrow()
        const retained = fixture.observations.find(record => record.phase === 'response')!
        expect(retained).toMatchObject({ complete: !incomplete })
        expect(retained.phase === 'response' && Buffer.from(retained.body.bodyBase64, 'base64').toString())
          .toBe(incomplete ? 'prefix' : 'compressed-bytes')
        expect(custody.rawRetention.isCurrent()).toBe(false)
      } finally { await fixture.close() }
    }
  }, 120_000)

  test('end throw and response-sync failure remain uncertain, while retained valid 409 is no-effect', async () => {
    for (const mode of ['end-throw', 'response-sync-failure', 'valid-409']) {
      let syncs = 0
      const fixture = await supervisedFixture({
        async sync() { if (++syncs === 2 && mode === 'response-sync-failure') throw new Error('sync failed') },
        handle(_request, response) {
          response.statusCode = mode === 'valid-409' ? 409 : 200
          response.end(mode === 'valid-409' ? '' : canonicalHostedApprovalJson(receipt))
        },
      })
      const originalEnd = ClientRequest.prototype.end
      try {
        const custody = await fixture.acquire()
        if (mode === 'end-throw') ClientRequest.prototype.end = function () {
          throw new Error('end failed')
        } as typeof ClientRequest.prototype.end
        const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
          .create(fixture.expected.endpoint.baseUrl)
        let error: unknown
        try { await client.answerPermission(reply) } catch (caught) { error = caught }
        expect(error).toBeInstanceOf(Error)
        expect(error).not.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
        if (mode === 'valid-409') {
          expect(error).toBeInstanceOf(OpenCodePermissionConditionRejectedError)
          expect(custody.rawRetention.isCurrent()).toBe(true)
        } else {
          expect(error).not.toBeInstanceOf(OpenCodePermissionConditionRejectedError)
          expect(custody.rawRetention.isCurrent()).toBe(false)
        }
      } finally { ClientRequest.prototype.end = originalEnd; await fixture.close() }
    }
  }, 120_000)

  test('dependency substitution during retention cannot replace transport or receipt expectations', async () => {
    let release!: () => void
    let syncing!: () => void
    const started = new Promise<void>(resolve => { syncing = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const fixture = await supervisedFixture({
      async sync(record) { if (record?.phase === 'request') { syncing(); await gate } },
      handle(_request, response) { response.end(canonicalHostedApprovalJson(receipt)) },
    })
    try {
      const custody = await fixture.acquire()
      const deps = { acquisitionPolicy: { mode: 'supervisor-adopt-only' as const, custody }, fetchImpl: undefined as typeof fetch | undefined }
      const factory = new OpenCodeClientFactory(deps)
      const body = { ...reply, condition: { ...reply.condition } }
      const pending = factory.create(fixture.expected.endpoint.baseUrl).answerPermission(body)
      await started
      let stolen = 0
      deps.fetchImpl = async () => { stolen += 1; throw new Error('substituted transport') }
      body.sessionId = 'ses_substitute'
      body.condition.permissionDigest = '0'.repeat(64)
      expect(Reflect.set(factory, 'create', () => { throw new Error('substituted factory') })).toBe(false)
      release()
      await expect(pending).resolves.toEqual(receipt)
      await factory.create(fixture.expected.endpoint.baseUrl).getHealth!()
      await expect(factory.create(fixture.expected.endpoint.baseUrl).getHostedApprovalCapability!()).rejects.toThrow()
      expect(stolen).toBe(0)
      expect(fixture.requests[0]!.url).toContain('/session/ses_test/')
      expect(JSON.parse(fixture.requests[0]!.body.toString()).expectedPermissionDigest).toBe(condition.permissionDigest)
    } finally { release?.(); await fixture.close() }
  }, 120_000)

  test('a replacement process receives zero partial HTTP or credential bytes', async () => {
    const fixture = await supervisedFixture()
    let child: ReturnType<typeof spawn> | undefined
    try {
      const custody = await fixture.acquire()
      await new Promise<void>(resolve => fixture.server.close(() => resolve()))
      child = spawn(process.execPath, ['-e', `
        const net = require('node:net');
        net.createServer(socket => {
          let bytes = 0;
          socket.on('data', chunk => { bytes += chunk.length });
          socket.on('close', () => process.stdout.write('closed:' + bytes + '\\n'));
        }).listen(${fixture.expected.endpoint.port}, '127.0.0.1', () => process.stdout.write('ready\\n'));
      `], { stdio: ['ignore', 'pipe', 'pipe'] })
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]()
      expect((await lines.next()).value).toBe('ready')
      const closed = lines.next()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      await expect(client.answerPermission(reply)).rejects.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
      expect((await closed).value).toBe('closed:0')
      expect(fixture.requests).toHaveLength(0)
      await lines.return?.()
    } finally {
      if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
      await fixture.close()
    }
  }, 120_000)

  test('205 retains native bytes and truncation before status normalization', async () => {
    for (const complete of [true, false]) {
      const fixture = await supervisedFixture({ handle(request) {
        request.socket.end(`HTTP/1.1 205 Reset Content\r\nContent-Length: ${complete ? 6 : 100}\r\nConnection: close\r\n\r\nprefix`)
      } })
      try {
        const custody = await fixture.acquire()
        const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
          .create(fixture.expected.endpoint.baseUrl)
        const failure = await client.answerPermission(reply).catch(error => error)
        expect(failure).toBeInstanceOf(Error)
        expect(failure).not.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
        expect(failure).not.toBeInstanceOf(OpenCodePermissionConditionRejectedError)
        const retained = fixture.observations.find(record => record.phase === 'response')!
        expect(retained).toMatchObject({ status: 205, complete })
        expect(retained.phase === 'response' && Buffer.from(retained.body.bodyBase64, 'base64').toString()).toBe('prefix')
        expect(custody.rawRetention.isCurrent()).toBe(false)
      } finally { await fixture.close() }
    }
  }, 120_000)

  test('failure revokes a concurrent retained request while terminal append or sync is stalled', async () => {
    for (const mode of ['malformed', 'encoded', 'incomplete'] as const) {
      let releasePeer!: () => void
      let peerReady!: () => void
      let releaseEvidence!: () => void
      let evidenceStarted!: () => void
      const peerGate = new Promise<void>(resolve => { releasePeer = resolve })
      const ready = new Promise<void>(resolve => { peerReady = resolve })
      const evidenceGate = new Promise<void>(resolve => { releaseEvidence = resolve })
      const stalled = new Promise<void>(resolve => { evidenceStarted = resolve })
      const fixture = await supervisedFixture({
        async sync(record) {
          if (mode === 'encoded' && record?.phase === 'response') {
            evidenceStarted(); await evidenceGate
          }
        },
        async write(_bytes, _offset, length, record) {
          if ((mode === 'malformed' && record?.phase === 'failure') ||
            (mode === 'incomplete' && record?.phase === 'response')) {
            evidenceStarted(); await evidenceGate
          }
          return length
        },
        handle(_request, response) {
          response.statusCode = 412
          if (mode === 'encoded') response.setHeader('content-encoding', 'gzip')
          if (mode === 'incomplete') {
            response.setHeader('content-length', '100')
            response.write('prefix')
            setTimeout(() => response.destroy(), 20)
          } else response.end(mode === 'malformed' ? '{' : 'encoded')
        },
      })
      try {
        const custody = await fixture.acquire()
        const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
          .create(fixture.expected.endpoint.baseUrl)
        const waiting = client.answerPermission({ ...reply, requestId: 'per_waiting', condition: { ...condition,
          authorizeConnected: async () => { peerReady(); await peerGate; return () => true },
        } }).catch(error => error)
        await ready
        const failed = client.answerPermission({ ...reply, requestId: 'per_failed' }).catch(error => error)
        await stalled
        expect(custody.rawRetention.isCurrent()).toBe(false)
        releasePeer()
        expect(await waiting).toBeInstanceOf(OpenCodeRequestNotDispatchedError)
        await fixture.connections[0]!.closed
        expect(fixture.connections[0]!.chunks).toHaveLength(0)
        expect(fixture.requests).toHaveLength(1)
        // Terminal storage is still stalled: failure delivery has a real bound.
        const failure = await failed
        expect(failure).toBeInstanceOf(Error)
        expect(failure).not.toBeInstanceOf(OpenCodePermissionConditionRejectedError)
        expect(failure).not.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
        releaseEvidence()
      } finally { releasePeer?.(); releaseEvidence?.(); await fixture.close() }
    }
  }, 120_000)

  test('supervised preparation and response have separate real bounded deadlines', async () => {
    let slowProof = false
    let hangingProof = false
    let proofFinished!: () => void
    const proofGate = new Promise<void>(resolve => { proofFinished = resolve })
    let receivedAt = 0
    let hangResponse = false
    const fixture = await supervisedFixture({
      mutateBundle(bundle) {
        const prepare = bundle.prepareEffectToken
        bundle.prepareEffectToken = async () => {
          if (hangingProof) await proofGate
          else if (slowProof) await new Promise<void>(resolve => setTimeout(resolve, 250))
          return prepare()
        }
      },
      handle(_request, response) {
        receivedAt = performance.now()
        if (!hangResponse) response.end('{"healthy":true}')
      },
    })
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl, { requestTimeoutMs: 100 })
      slowProof = true
      await expect(client.getHealth!()).resolves.toEqual({ healthy: true })
      slowProof = false; hangResponse = true
      await expect(client.getHealth!()).rejects.toThrow('timed out')
      const elapsedResponse = performance.now() - receivedAt
      expect(elapsedResponse).toBeGreaterThanOrEqual(80)
      expect(elapsedResponse).toBeLessThan(1000)
      hangingProof = true
      const started = performance.now()
      const before = fixture.requests.length
      await expect(client.getHealth!()).rejects.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
      expect(performance.now() - started).toBeGreaterThanOrEqual(4900)
      expect(performance.now() - started).toBeLessThan(6500)
      expect(fixture.requests).toHaveLength(before)
      proofFinished()
    } finally { proofFinished?.(); await fixture.close() }
  }, 120_000)

  test('empty numeric rejection with encoding or incomplete framing remains uncertain', async () => {
    for (const encoded of [true, false]) {
      const fixture = await supervisedFixture({ handle(request) {
        request.socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n' +
          (encoded ? 'Content-Length: 0\r\nContent-Encoding: gzip' : 'Content-Length: 1') + '\r\n\r\n')
      } })
      try {
        const custody = await fixture.acquire()
        const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
          .create(fixture.expected.endpoint.baseUrl)
        const error = await client.answerPermission(reply).catch(error => error)
        expect(error).toBeInstanceOf(Error)
        expect(error).not.toBeInstanceOf(OpenCodePermissionConditionRejectedError)
        expect(error).not.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
        expect(fixture.observations.find(record => record.phase === 'response'))
          .toMatchObject({ status: 409, complete: encoded, body: { byteLength: 0 } })
        expect(custody.rawRetention.isCurrent()).toBe(false)
      } finally { await fixture.close() }
    }
  }, 120_000)

  test('an exhausted total budget cannot gain a new response deadline after proof', async () => {
    const fixture = await supervisedFixture()
    try {
      const custody = await fixture.acquire()
      const expires = performance.now() + 100
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl, { remainingMs: () => expires - performance.now() })
      await expect(client.answerPermission({ ...reply, condition: { ...condition,
        authorizeConnected: async () => { await new Promise(resolve => setTimeout(resolve, 150)); return () => true },
      } })).rejects.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
      await Promise.all(fixture.connections.map(connection => connection.closed))
      expect(fixture.connections.flatMap(connection => connection.chunks)).toHaveLength(0)
    } finally { await fixture.close() }
  }, 120_000)

  test('generic consumers inherit auth and redirects never select a different credential origin', async () => {
    const fixture = await supervisedFixture({ handle(request, response) {
      if (request.url === '/session/redirect') {
        response.statusCode = 302; response.setHeader('location', 'http://127.0.0.1:1/stolen')
      }
      response.end('{}')
    } })
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      await client.getProviders()
      await client.getSession('ses_test')
      await client.getMcp()
      await expect(client.getSession('redirect')).rejects.toThrow('redirect rejected')
      expect(fixture.requests).toHaveLength(4)
      for (const request of fixture.requests) expect(request.headers.authorization)
        .toBe(`Basic ${Buffer.from('opencode:fixture-secret').toString('base64')}`)
      expect(fixture.observations).toHaveLength(0)
    } finally { await fixture.close() }
  }, 120_000)
})
