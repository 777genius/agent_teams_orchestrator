import { describe, expect, test } from 'bun:test'
import { ClientRequest } from 'node:http'
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

  test('retains zero/malformed/noncanonical failures, poisons and never falls back to another POST', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from('{'),
      Buffer.from('{"a":1,"a":2}'), Buffer.from('{"z":0,"a":1}')]) {
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
          expect(error).toBeInstanceOf(Error)
          expect(error).not.toBeInstanceOf(OpenCodePermissionConditionRejectedError)
          expect(error).not.toBeInstanceOf(OpenCodeRequestNotDispatchedError)
          const retained = fixture.observations.find(record => record.phase === 'response')!
          expect(retained.phase === 'response' && Buffer.from(retained.body.bodyBase64, 'base64')).toEqual(bytes)
          expect(custody.rawRetention.isCurrent()).toBe(false)
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
          response.end(canonicalHostedApprovalJson(mode === 'valid-409' ? { error: 'condition_failed' } : receipt))
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
