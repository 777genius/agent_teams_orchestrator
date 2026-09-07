import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Socket, createServer, type AddressInfo } from 'node:net'
import { createInterface } from 'node:readline'
import { canonicalHostedApprovalDigest, canonicalHostedApprovalJson, OpenCodeClientFactory,
  OpenCodePermissionConditionRejectedError, OpenCodeRequestNotDispatchedError } from './OpenCodeClientFactory.js'
import { supervisedFixture, supervisedTestStage, supervisedTestWait } from './OpenCodeSupervisedCustody.test-fixture.js'

function replyCase(requestId = 'per_test') {
  const raw = { id: requestId, sessionID: 'ses_test', permission: 'bash', patterns: ['echo test'], always: [], metadata: {} }
  const condition = { runtimeInstanceId: `runtime_instance_${'1'.repeat(32)}`,
    configGeneration: `config_generation_${'2'.repeat(32)}`, sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
    requestIncarnation: `request_incarnation_${canonicalHostedApprovalDigest(requestId).slice(0, 32)}`,
    permissionDigest: canonicalHostedApprovalDigest(raw) }
  const receipt = { schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2', status: 'applied',
    ...condition, requestId, sessionId: raw.sessionID, decision: 'allow_once' }
  const reply = { requestId, sessionId: raw.sessionID, decision: 'allow' as const,
    condition: { ...condition, authorizeConnected: async () => () => true } }
  const payload = { schemaVersion: 2, protocol: receipt.protocol, runtimeInstanceId: condition.runtimeInstanceId,
    expectedConfigGeneration: condition.configGeneration, requestId, sessionId: raw.sessionID,
    sessionIncarnation: condition.sessionIncarnation, requestIncarnation: condition.requestIncarnation,
    expectedPermissionDigest: condition.permissionDigest, decision: receipt.decision }
  return { raw, condition, receipt, reply, payload }
}
const { condition, receipt, reply, payload } = replyCase()

describe.skipIf(process.platform !== 'linux')('OpenCode supervised dispatch', () => {
  test('ordinary provider operations retain actual request and response through operation admission', async () => {
    const fixture = await supervisedFixture({
      handle(_request, response) { response.end('{"id":"ses_actual"}') },
    })
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      expect(await client.createSession({ title: 'actual request' })).toEqual({ id: 'ses_actual' })
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.observations).toHaveLength(2)
      expect(fixture.observations[0]).toMatchObject({ phase: 'request', method: 'POST', path: '/session',
        binding: { operation: { kind: 'provider', name: 'session-create', method: 'POST', path: '/session' } },
        body: { bodyBase64: Buffer.from('{"title":"actual request"}').toString('base64') } })
      expect(fixture.observations[1]).toMatchObject({ phase: 'response', complete: true,
        body: { bodyBase64: Buffer.from('{"id":"ses_actual"}').toString('base64') } })
    } finally { await fixture.close() }
  }, 120_000)

  test('native credential effects reject before retention or socket creation', async () => {
    const fixture = await supervisedFixture()
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      await expect(client.deleteProviderAuth('provider_test')).rejects.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
      expect(fixture.connections).toHaveLength(0)
      expect(fixture.observations).toHaveLength(0)
      expect(custody.rawRetention.isCurrent()).toBe(true)
    } finally { await fixture.close() }
  }, 120_000)

  test('oversized UTF-8 request is rejected before retaining or connecting', async () => {
    const fixture = await supervisedFixture()
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      await expect(client.sendSessionMessage('ses_test', { parts: [{ type: 'text', text: '雪'.repeat(400_000) }] }))
        .rejects.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
      expect(fixture.connections).toHaveLength(0)
      expect(fixture.requests).toHaveLength(0)
      expect(fixture.observations).toHaveLength(0)
      expect(custody.rawRetention.isCurrent()).toBe(true)
    } finally { await fixture.close() }
  }, 120_000)

  test('durable request precedes finalizer/first socket write; raw response precedes validation; frames stay 10/11', async () => {
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
    let atWrite: boolean | undefined
    let authorizedPort = 0
    let writes = 0
    const originalWrite = Socket.prototype.write
    Socket.prototype.write = function (this: Socket, ...args: unknown[]) {
      if (this.remotePort === fixture.expected.endpoint.port) {
        writes += 1; atWrite = changed
        expect(this.localPort).toBe(authorizedPort)
      }
      return originalWrite.apply(this, args as never)
    } as typeof Socket.prototype.write
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl, {}, { password: 'override', directory: '/wrong' })
      const pending = client.answerPermission({ ...reply, condition: { ...condition,
        authorizeConnected: async connection => {
          await fixture.waitForConnection(connection)
          authorizedPort = connection.localPort
          return () => {
            finalized = true; queueMicrotask(() => { changed = true }); return true
          }
        } } })
      await supervisedTestStage(started, pending, 'request retention')
      expect(finalized).toBe(false)
      expect(fixture.requests).toHaveLength(0)
      expect(fixture.connections.flatMap(connection => connection.chunks)).toHaveLength(0)
      release()
      await expect(pending).resolves.toEqual(receipt)
      expect(finalized).toBe(true)
      expect(atWrite).toBe(false)
      expect(writes).toBe(1)
      expect(fixture.connections).toHaveLength(1)
      expect(fixture.connections[0]!.identity.localPort).toBe(authorizedPort)
      fixture.assertSocketCustody()
      expect(Object.keys(JSON.parse(fixture.requests[0]!.body.toString()))).toHaveLength(10)
      expect(Object.keys(receipt)).toHaveLength(11)
      expect(fixture.requests[0]!.headers.authorization).not.toContain('override')
      expect(fixture.observations.map(record => record.phase)).toEqual(['request', 'response'])
      expect(fixture.observations[1]).toMatchObject({ correlation: 'unavailable', peerOperationNonce: null })
    } finally { Socket.prototype.write = originalWrite; release?.(); await fixture.close() }
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
    let connected = false
    let finalized = false
    let captureWasCurrent = false
    let finalizerCalls = 0
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      const failure = await client.answerPermission({ ...reply, condition: { ...condition,
        authorizeConnected: async connection => {
          await fixture.waitForConnection(connection)
          connected = connection.remotePort === fixture.expected.endpoint.port && connection.localPort > 0
          return () => {
            finalizerCalls += 1
            captureWasCurrent = custody.rawRetention.isCurrent()
            finalized = true; custody.rawRetention.poison('test-revocation'); return true
          }
        },
      } }).catch(error => error)
      expect(failure).toBeInstanceOf(OpenCodeRequestNotDispatchedError)
      expect(connected).toBe(true)
      expect(finalized).toBe(true)
      // Error/abort cleanup poisons capture before consuming leftover fences;
      // that cleanup path cannot satisfy this finalizer-entry assertion.
      expect(captureWasCurrent).toBe(true)
      expect(finalizerCalls).toBe(1)
      await supervisedTestWait(Promise.all(fixture.connections.map(connection => connection.closed)), 'finalizer socket close')
      expect(fixture.connections).toHaveLength(1)
      expect(fixture.connections[0]!.chunks).toHaveLength(0)
      expect(fixture.requests).toHaveLength(0)
      const retained = fixture.observations.find(record => record.phase === 'request')!
      expect(retained.phase === 'request' && JSON.parse(Buffer.from(retained.body.bodyBase64, 'base64').toString())).toEqual(payload)
    } finally { await fixture.close() }
  }, 120_000)

  for (const mode of ['false', 'throw', 'reuse'] as const) {
    test(`finalizer ${mode} closes the exact authorized socket with zero bytes`, async () => {
      const fixture = await supervisedFixture()
      let calls = 0
      let used = false
      const finalizer = () => {
        calls += 1
        if (mode === 'throw') throw new Error('finalizer drift')
        if (mode === 'false' || used) return false
        used = true; return true
      }
      if (mode === 'reuse') expect(finalizer()).toBe(true)
      try {
        const custody = await fixture.acquire()
        const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
          .create(fixture.expected.endpoint.baseUrl)
        const failure = await client.answerPermission({ ...reply, condition: { ...condition,
          authorizeConnected: async connection => {
            const accepted = await fixture.waitForConnection(connection)
            expect(accepted.identity).toEqual(connection)
            expect(custody.rawRetention.isCurrent()).toBe(true)
            return finalizer
          },
        } }).catch(error => error)
        expect(failure).toBeInstanceOf(OpenCodeRequestNotDispatchedError)
        expect(calls).toBe(mode === 'reuse' ? 2 : 1)
        expect(fixture.connections).toHaveLength(1)
        await supervisedTestWait(fixture.connections[0]!.closed, `${mode} finalizer socket close`)
        expect(fixture.connections[0]!.chunks).toHaveLength(0)
        expect(fixture.requests).toHaveLength(0)
      } finally { await fixture.close() }
    }, 120_000)
  }

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

  test('socket write throw and response-sync failure remain uncertain, while retained valid 409 is no-effect', async () => {
    for (const mode of ['write-throw', 'response-sync-failure', 'valid-409']) {
      let syncs = 0
      const fixture = await supervisedFixture({
        async sync() { if (++syncs === 2 && mode === 'response-sync-failure') throw new Error('sync failed') },
        handle(_request, response) {
          response.statusCode = mode === 'valid-409' ? 409 : 200
          response.end(mode === 'valid-409' ? '' : canonicalHostedApprovalJson(receipt))
        },
      })
      const originalWrite = Socket.prototype.write
      try {
        const custody = await fixture.acquire()
        if (mode === 'write-throw') Socket.prototype.write = function (this: Socket, ...args: unknown[]) {
          if (this.remotePort === fixture.expected.endpoint.port) throw new Error('write failed')
          return originalWrite.apply(this, args as never)
        } as typeof Socket.prototype.write
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
        expect(fixture.connections).toHaveLength(1)
        if (mode === 'write-throw') {
          await supervisedTestWait(fixture.connections[0]!.closed, 'throwing write socket close')
          expect(fixture.connections[0]!.chunks).toHaveLength(0)
        }
      } finally { Socket.prototype.write = originalWrite; await fixture.close() }
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
      await supervisedTestStage(started, pending, 'retention before dependency substitution')
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

  for (const status of [204, 205]) for (const complete of [true, false]) {
    test(`${status} retains exact prefix before normalization on immediate EOF, complete=${complete}`, async () => {
      const wire = `HTTP/1.1 ${status} No Content\r\nContent-Length: ${complete ? 6 : 100}\r\nConnection: close\r\n\r\nprefix`
      let emitted: string | undefined
      const fixture = await supervisedFixture({ rawResponse(_request, socket) {
        emitted = wire; socket.end(wire)
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
        expect(emitted).toBe(wire)
        expect(retained).toMatchObject({ status, complete })
        expect(retained.phase === 'response' && Buffer.from(retained.body.bodyBase64, 'base64').toString()).toBe('prefix')
        expect(custody.rawRetention.isCurrent()).toBe(false)
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.connections).toHaveLength(1)
        expect(fixture.requests[0]!.method).toBe('POST')
        expect(JSON.parse(fixture.requests[0]!.body.toString())).toEqual(payload)
      } finally { await fixture.close() }
    }, 120_000)
  }

  test('failure revokes a concurrent retained request while terminal append or sync is stalled', async () => {
    for (const mode of ['malformed', 'encoded', 'incomplete'] as const) {
      let releasePeer!: () => void
      let peerReady!: () => void
      let releaseEvidence!: () => void
      let evidenceStarted!: () => void
      let evidenceFinished!: () => void
      const peerGate = new Promise<void>(resolve => { releasePeer = resolve })
      const ready = new Promise<void>(resolve => { peerReady = resolve })
      const evidenceGate = new Promise<void>(resolve => { releaseEvidence = resolve })
      const stalled = new Promise<void>(resolve => { evidenceStarted = resolve })
      const evidenceComplete = new Promise<void>(resolve => { evidenceFinished = resolve })
      const fixture = await supervisedFixture({
        async sync(record) {
          if (mode === 'encoded' && record?.phase === 'response') {
            evidenceStarted(); await evidenceGate
          }
          if ((mode === 'malformed' && record?.phase === 'failure') ||
            (mode !== 'malformed' && record?.phase === 'response')) evidenceFinished()
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
        const waitingCase = replyCase('per_waiting')
        const failedCase = replyCase('per_failed')
        let waitingFinalized = false
        const waiting = client.answerPermission({ ...waitingCase.reply, condition: { ...waitingCase.condition,
          authorizeConnected: async connection => {
            await fixture.waitForConnection(connection)
            peerReady(); await peerGate; return () => { waitingFinalized = true; return true }
          },
        } }).catch(error => error)
        await supervisedTestStage(ready, waiting, 'waiting request connected authorization')
        expect(custody.rawRetention.isCurrent()).toBe(true)
        const retainedWaiting = fixture.observations.find(record => record.phase === 'request')!
        expect(retainedWaiting.phase === 'request' && JSON.parse(Buffer.from(retainedWaiting.body.bodyBase64, 'base64').toString()))
          .toEqual(waitingCase.payload)
        const failed = client.answerPermission(failedCase.reply).catch(error => error)
        await supervisedTestStage(stalled, failed, `${mode} terminal evidence`)
        expect(custody.rawRetention.isCurrent()).toBe(false)
        releasePeer()
        // Socket cancellation precedes terminal persistence. Both client
        // completions remain pending behind the same retained append queue.
        await supervisedTestWait(fixture.connections[0]!.closed, 'revoked waiting socket close')
        expect(waitingFinalized).toBe(true)
        expect(fixture.connections[0]!.chunks).toHaveLength(0)
        expect(fixture.connections).toHaveLength(2)
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.observations.filter(record => record.phase === 'request')).toHaveLength(2)
        expect(fixture.requests[0]!.url).toContain('/permission/per_failed/reply')
        expect(JSON.parse(fixture.requests[0]!.body.toString())).toEqual(failedCase.payload)
        let settled = false
        void Promise.all([waiting, failed]).then(() => { settled = true })
        await Promise.resolve()
        expect(settled).toBe(false)
        releaseEvidence()
        expect(await supervisedTestWait(waiting, 'waiting terminal persistence'))
          .toBeInstanceOf(OpenCodeRequestNotDispatchedError)
        const failure = await supervisedTestWait(failed, 'failure after terminal retention')
        expect(failure).toBeInstanceOf(Error)
        expect(failure).not.toBeInstanceOf(OpenCodePermissionConditionRejectedError)
        expect(failure).not.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
        releaseEvidence()
        await supervisedTestWait(evidenceComplete, 'terminal evidence release')
        expect(custody.rawRetention.isCurrent()).toBe(false)
      } finally { releasePeer?.(); releaseEvidence?.(); await fixture.close() }
    }
  }, 120_000)

  test('supervised preparation and response have separate real bounded deadlines', async () => {
    let slowProof = false
    let receivedAt = 0
    let hangResponse = false
    const fixture = await supervisedFixture({
      mutateBundle(bundle) {
        const prepare = bundle.prepareEffectToken
        bundle.prepareEffectToken = async () => {
          if (slowProof) await new Promise<void>(resolve => setTimeout(resolve, 250))
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
      expect(await client.getHealth!()).toEqual({ healthy: true })
      slowProof = false; hangResponse = true
      const responseFailure = await supervisedTestWait(client.getHealth!().catch(error => error), 'header deadline')
      expect(responseFailure.message).toContain('timed out')
      const elapsedResponse = performance.now() - receivedAt
      expect(elapsedResponse).toBeGreaterThanOrEqual(80)
      expect(elapsedResponse).toBeLessThan(1000)
      const before = fixture.requests.length
      const poisonedAt = performance.now()
      await expect(client.getHealth!()).rejects.toThrow()
      expect(performance.now() - poisonedAt).toBeLessThan(1000)
      expect(fixture.requests).toHaveLength(before)
    } finally { await fixture.close() }
  }, 120_000)

  test('preparation deadline settles before late proof while custody drain retains and invalidates it', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let hang = false, entered = false, consumed = 0
    const fixture = await supervisedFixture({ mutateBundle(bundle) {
      const prepare = bundle.prepareEffectToken
      bundle.prepareEffectToken = async () => {
        if (!hang) return prepare()
        entered = true
        await gate
        const token = await prepare()
        return token && { consume() { consumed++; return token.consume() } }
      }
    } })
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      hang = true
      const started = performance.now()
      const failure = await supervisedTestWait(client.getHealth!().catch(error => error), 'preparation deadline')
      expect(entered).toBe(true)
      expect(failure).toBeInstanceOf(OpenCodeRequestNotDispatchedError)
      expect(performance.now() - started).toBeGreaterThanOrEqual(4900)
      expect(performance.now() - started).toBeLessThan(6500)
      expect(fixture.requests).toHaveLength(0)
      expect(fixture.connections).toHaveLength(1)
      await supervisedTestWait(fixture.connections[0]!.closed, 'preparation exact socket close')
      expect(fixture.connections.flatMap(connection => connection.chunks)).toHaveLength(0)
      expect(custody.rawRetention.isCurrent()).toBe(false)
      let drained = false
      const drain = custody.closeOwnerResources().then(() => { drained = true })
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(consumed).toBe(0)
      release()
      await supervisedTestWait(drain, 'late proof custody drain')
      expect(consumed).toBe(1)
      expect(fixture.connections.flatMap(connection => connection.chunks)).toHaveLength(0)
      await expect(client.getHealth!()).rejects.toThrow()
      expect(fixture.requests).toHaveLength(0)
    } finally { release(); await fixture.close() }
  }, 120_000)

  test('response timeout retains the received prefix and closes only the authorized socket', async () => {
    const fixture = await supervisedFixture({ rawResponse(_request, socket) {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nprefix')
    } })
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl, { requestTimeoutMs: 100 })
      const failure = await supervisedTestWait(client.answerPermission(reply).catch(error => error), 'partial response timeout')
      expect(failure.message).toContain('timed out')
      expect(failure).not.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
      expect(failure).not.toBeInstanceOf(OpenCodePermissionConditionRejectedError)
      expect(fixture.connections).toHaveLength(1)
      expect(fixture.requests).toHaveLength(1)
      await supervisedTestWait(fixture.requests[0]!.connection.closed, 'partial response exact socket close')
      const retained = fixture.observations.find(record => record.phase === 'response')!
      expect(retained).toMatchObject({ status: 200, complete: false })
      expect(retained.phase === 'response' && Buffer.from(retained.body.bodyBase64, 'base64')).toEqual(Buffer.from('prefix'))
      expect(custody.rawRetention.isCurrent()).toBe(false)
    } finally { await fixture.close() }
  }, 120_000)

  for (const encoded of [true, false]) {
    test(`empty 409 on immediate EOF stays uncertain: ${encoded ? 'gzip' : 'incomplete length'}`, async () => {
      const fixture = await supervisedFixture({ rawResponse(_request, socket) {
        socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n' +
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
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.connections).toHaveLength(1)
        expect(JSON.parse(fixture.requests[0]!.body.toString())).toEqual(payload)
      } finally { await fixture.close() }
    }, 120_000)
  }

  for (const mode of ['duplicate-encoding', 'conflicting-encoding', 'duplicate-length'] as const) {
    test(`empty 409 retains metadata and stays uncertain for ${mode}`, async () => {
      const encoding = mode === 'duplicate-encoding' ? 'identity, identity' : mode === 'conflicting-encoding' ? 'identity, gzip' : null
      const fixture = await supervisedFixture({ rawResponse(_request, socket) {
        socket.end('HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n' +
          (mode === 'duplicate-length' ? 'Content-Length: 0\r\n' :
            `Content-Encoding: identity\r\ncOnTeNt-EnCoDiNg: ${mode === 'duplicate-encoding' ? 'identity' : 'gzip'}\r\n`) + '\r\n')
      } })
      try {
        const custody = await fixture.acquire()
        const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
          .create(fixture.expected.endpoint.baseUrl)
        const failure = await client.answerPermission(reply).catch(error => error)
        expect(failure).toBeInstanceOf(Error)
        expect(failure).not.toBeInstanceOf(OpenCodePermissionConditionRejectedError)
        expect(failure).not.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
        expect(fixture.observations.find(record => record.phase === 'response')).toMatchObject({
          status: 409, contentEncoding: encoding, complete: mode !== 'duplicate-length', body: { byteLength: 0 },
        })
        expect(fixture.connections).toHaveLength(1)
        expect(fixture.requests).toHaveLength(1)
        expect(custody.rawRetention.isCurrent()).toBe(false)
      } finally { await fixture.close() }
    }, 120_000)
  }

  for (const mode of ['http10-transfer-encoding', 'missing-status-separator'] as const) {
    for (const status of [409, 412, 200]) {
      test(`${mode} cannot establish ${status === 200 ? 'applied' : `empty ${status} no-effect`} after POST`, async () => {
        const bytes = status === 200 ? Buffer.from(canonicalHostedApprovalJson(receipt)) : Buffer.alloc(0)
        const tail = mode === 'http10-transfer-encoding'
          ? Buffer.concat([...(bytes.length ? [Buffer.from(`${bytes.length.toString(16)}\r\n`), bytes, Buffer.from('\r\n')] : []),
              Buffer.from('0\r\n\r\n')])
          : bytes
        const head = mode === 'http10-transfer-encoding'
          ? `HTTP/1.0 ${status} ${status === 200 ? 'OK' : status === 409 ? 'Conflict' : 'Precondition Failed'}\r\nTransfer-Encoding: chunked`
          : `HTTP/1.1 ${status}\r\nContent-Length: ${bytes.length}`
        const wire = Buffer.concat([Buffer.from(`${head}\r\n\r\n`), tail])
        let emitted: Buffer | undefined
        const fixture = await supervisedFixture({ rawResponse(_request, socket) {
          emitted = wire; socket.end(wire)
        } })
        try {
          const custody = await fixture.acquire()
          const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
            .create(fixture.expected.endpoint.baseUrl)
          const failure = await client.answerPermission(reply).catch(error => error)
          expect(failure).toBeInstanceOf(Error)
          expect(failure).not.toBeInstanceOf(OpenCodePermissionConditionRejectedError)
          expect(failure).not.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
          expect(emitted).toEqual(wire)
          const retained = fixture.observations.find(record => record.phase === 'response')!
          expect(retained).toMatchObject({ status, complete: false, body: { byteLength: tail.length } })
          expect(retained.phase === 'response' && Buffer.from(retained.body.bodyBase64, 'base64')).toEqual(tail)
          expect(custody.rawRetention.isCurrent()).toBe(false)
          expect(fixture.connections).toHaveLength(1)
          expect(fixture.requests).toHaveLength(1)
          expect(fixture.requests[0]!.method).toBe('POST')
          expect(JSON.parse(fixture.requests[0]!.body.toString())).toEqual(payload)
          fixture.assertSocketCustody()
          await supervisedTestWait(fixture.connections[0]!.closed, `${mode} authorized socket EOF/close`)
        } finally { await fixture.close() }
      }, 120_000)
    }
  }

  test('valid chunked reply retains exact entity bytes and actual nonce header without claiming a join', async () => {
    const bytes = Buffer.from(canonicalHostedApprovalJson(receipt))
    const fixture = await supervisedFixture({ rawResponse(_request, socket) {
      socket.end(Buffer.concat([
        Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Encoding: identity\r\n' +
          `x-agent-teams-hosted-operation-nonce: ${'a'.repeat(64)}\r\n\r\n7;fixture=yes\r\n`),
        bytes.subarray(0, 7), Buffer.from(`\r\n${(bytes.length - 7).toString(16)}\r\n`), bytes.subarray(7),
        Buffer.from('\r\n0\r\nX-Fixture: bounded\r\n\r\n'),
      ]))
    } })
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      expect(await client.answerPermission(reply)).toEqual(receipt)
      expect(fixture.connections).toHaveLength(1)
      expect(fixture.requests).toHaveLength(1)
      const retained = fixture.observations.find(record => record.phase === 'response')!
      expect(retained).toMatchObject({ status: 200, complete: true, contentEncoding: 'identity',
        peerOperationNonce: 'a'.repeat(64), nonceStatus: 'present', correlation: 'unavailable',
        responseHeaders: [['content-encoding', 'identity'], ['x-agent-teams-hosted-operation-nonce', 'a'.repeat(64)]],
        connectedPeer: fixture.connections[0]!.identity })
      expect(retained.phase === 'response' && Buffer.from(retained.body.bodyBase64, 'base64')).toEqual(bytes)
      expect(custody.rawRetention.isCurrent()).toBe(true)
    } finally { await fixture.close() }
  }, 120_000)

  test('an exhausted total budget cannot gain a new response deadline after proof', async () => {
    const fixture = await supervisedFixture()
    let connected = false
    let cleaned!: () => void
    const cleanup = new Promise<void>(resolve => { cleaned = resolve })
    try {
      const custody = await fixture.acquire()
      const expires = performance.now() + 4000
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl, { remainingMs: () => expires - performance.now() })
      const failure = await client.answerPermission({ ...reply, condition: { ...condition,
        authorizeConnected: async connection => {
          await fixture.waitForConnection(connection)
          connected = true
          await new Promise(resolve => setTimeout(resolve, Math.max(0, expires - performance.now()) + 50))
          return () => { cleaned(); return true }
        },
      } }).catch(error => error)
      expect(failure).toBeInstanceOf(OpenCodeRequestNotDispatchedError)
      expect(connected).toBe(true)
      await supervisedTestWait(cleanup, 'late finalizer cleanup')
      await supervisedTestWait(Promise.all(fixture.connections.map(connection => connection.closed)), 'expired proof socket close')
      expect(fixture.connections).toHaveLength(1)
      expect(fixture.connections.flatMap(connection => connection.chunks)).toHaveLength(0)
      expect(fixture.requests).toHaveLength(0)
    } finally { await fixture.close() }
  }, 120_000)

  test('generic consumers inherit auth and redirects never select a different credential origin', async () => {
    let redirectedConnections = 0, redirectedBytes = 0
    const redirectTarget = createServer(socket => {
      redirectedConnections++
      socket.on('data', bytes => { redirectedBytes += bytes.length })
      socket.end()
    })
    redirectTarget.listen(0, '127.0.0.1')
    await once(redirectTarget, 'listening')
    const redirectUrl = `http://127.0.0.1:${(redirectTarget.address() as AddressInfo).port}/stolen`
    const fixture = await supervisedFixture({ handle(request, response) {
      if (request.url === '/session/redirect') {
        response.statusCode = 302; response.setHeader('location', redirectUrl)
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
      expect(redirectedConnections).toBe(0)
      expect(redirectedBytes).toBe(0)
      expect(fixture.connections).toHaveLength(4)
      expect(fixture.observations).toHaveLength(9)
      const paths = ['/provider', '/session/ses_test', '/mcp', '/session/redirect']
      const names = ['providers', 'session-read', 'mcp-read', 'session-read']
      for (let i = 0; i < paths.length; i++) {
        const request = fixture.observations[i * 2]!
        const response = fixture.observations[i * 2 + 1]!
        expect(request).toMatchObject({ phase: 'request', method: 'GET', path: paths[i],
          binding: { operation: { kind: 'provider', name: names[i] } } })
        expect(response).toMatchObject({ phase: 'response', status: i === 3 ? 302 : 200, complete: true })
        if (request.phase !== 'request' || response.phase !== 'response') throw new Error('missing pair')
        expect(response.request.ownerExchangeNonce).toBe(request.binding.ownerExchangeNonce)
        expect(Buffer.from(request.body.bodyBase64, 'base64').length).toBe(0)
        expect(Buffer.from(response.body.bodyBase64, 'base64').toString()).toBe('{}')
      }
      const terminal = fixture.observations[8]!
      const redirected = fixture.observations[7]!
      expect(terminal).toMatchObject({ phase: 'failure', failure: { phase: 'end-attempted', code: 'exchange_failed' } })
      if (terminal.phase !== 'failure' || redirected.phase !== 'response') throw new Error('missing redirect evidence')
      expect(terminal.request).toBe(redirected.request)
      expect(custody.rawRetention.isCurrent()).toBe(false)
    } finally {
      await fixture.close()
      await new Promise<void>(resolve => redirectTarget.close(() => resolve()))
    }
  }, 120_000)

  test('complete authenticated generic 404 keeps typed status and missing-message fallback', async () => {
    const existing = { info: { id: 'msg_existing', role: 'user' }, parts: [{ type: 'text', text: 'existing' }] }
    const fixture = await supervisedFixture({ handle(request, response) {
      if (request.url === '/session/ses_test/message') { response.end(JSON.stringify([existing])); return }
      response.statusCode = 404
      response.end('private diagnostic body')
    } })
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      expect(await client.getSessionMessage!('ses_test', 'msg_missing')).toBeNull()
      expect(await client.getSessionMessage!('ses_test', 'msg_existing')).toEqual(existing)
      const failure = await client.getSession('ses_missing').catch(error => error)
      expect(failure).toMatchObject({ status: 404 })
      expect(failure.message).not.toContain('private diagnostic body')
      expect(failure).not.toBeInstanceOf(OpenCodePermissionConditionRejectedError)
      expect(fixture.requests.map(request => request.url)).toEqual([
        '/session/ses_test/message/msg_missing', '/session/ses_test/message',
        '/session/ses_test/message/msg_existing', '/session/ses_test/message', '/session/ses_missing',
      ])
      expect(fixture.observations).toHaveLength(10)
      for (let i = 0; i < 5; i++) {
        const request = fixture.observations[i * 2]!
        const response = fixture.observations[i * 2 + 1]!
        expect(request).toMatchObject({ phase: 'request', method: 'GET', path: fixture.requests[i]!.url })
        expect(response).toMatchObject({ phase: 'response', status: i === 1 || i === 3 ? 200 : 404, complete: true })
        if (request.phase !== 'request' || response.phase !== 'response') throw new Error('missing pair')
        expect(response.request.ownerExchangeNonce).toBe(request.binding.ownerExchangeNonce)
        expect(Buffer.from(response.body.bodyBase64, 'base64').toString()).toBe(
          i === 1 || i === 3 ? JSON.stringify([existing]) : 'private diagnostic body')
      }
      expect(custody.rawRetention.isCurrent()).toBe(true)
    } finally { await fixture.close() }
  }, 120_000)

  test('recoverable missing reads do not exempt private config, arbitrary statuses, parsing or retention failures', async () => {
    for (const scenario of ['config404', 'health404', 'session500', 'malformed200', 'unsynced404'] as const) {
      const fixture = await supervisedFixture({
        handle(_request, response) {
          response.statusCode = scenario === 'session500' ? 500 : scenario === 'malformed200' ? 200 : 404
          response.end('private diagnostic')
        },
        async sync(observation) {
          if (scenario === 'unsynced404' && observation?.phase === 'response') throw new Error('sync rejected')
        },
      })
      try {
        const custody = await fixture.acquire()
        const token = await custody.prepareOperationToken({kind:'provider',name:'session-read',method:'GET',path:'/session/next'})
        const client = new OpenCodeClientFactory({acquisitionPolicy:{mode:'supervisor-adopt-only',custody}})
          .create(fixture.expected.endpoint.baseUrl)
        const pending = scenario === 'config404' ? client.getConfig() : scenario === 'health404'
          ? client.getHealth!() : client.getSession('missing')
        expect(await pending.catch(error => error)).toBeInstanceOf(Error)
        expect(custody.rawRetention.isCurrent()).toBe(false)
        expect(token!.consume()).toBe(false)
        expect(fixture.requests).toHaveLength(1)
        await expect(client.getSession('next')).rejects.toThrow()
        expect(fixture.requests).toHaveLength(1)
      } finally { await fixture.close() }
    }
  }, 120_000)

  test('incomplete or encoded generic 404 cannot establish a missing message', async () => {
    for (const encoded of [true, false]) {
      const fixture = await supervisedFixture({ rawResponse(_request, socket) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n' +
          (encoded ? 'Content-Length: 0\r\nContent-Encoding: gzip' : 'Content-Length: 1') + '\r\n\r\n')
      } })
      try {
        const custody = await fixture.acquire()
        const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
          .create(fixture.expected.endpoint.baseUrl)
        const failure = await client.getSessionMessage!('ses_test', 'msg_missing').catch(error => error)
        expect(failure).toBeInstanceOf(Error)
        expect(failure).not.toBeInstanceOf(OpenCodePermissionConditionRejectedError)
        expect(fixture.requests).toHaveLength(1)
      } finally { await fixture.close() }
    }
  }, 120_000)
})
