import { expect, test } from 'bun:test'
import { supervisedFixture } from '../../../src/services/opencode/OpenCodeSupervisedCustody.test-fixture.js'
import { OpenCodeClientFactory } from '../../../src/services/opencode/OpenCodeClientFactory.js'
import { createNativeHttpEncoderV2 } from './native-raw-sink-v2.js'
import { decodePrivateHttpRecord } from './native-private-http.js'
import { sha256 } from './native-http-contract.js'

// Actual TCP client + established socket proof + real private encoder. Local
// synthetic responses test consumer preservation, not native producer effects.
for (const failResponse of [false, true]) test.skipIf(process.platform !== 'linux')(`actual private consumers retain exact bytes and redact records, HTTP500=${failResponse}`, async () => {
  const sentinel = 'nested-private-consumer-r1098'
  const config = {type:'local' as const,command:['node',sentinel],environment:{TOKEN:sentinel}}
  const body = {mcp:{'private-mcp':config},nested:{options:{apiKey:sentinel},environment:{TOKEN:sentinel},
    command:['node',sentinel],url:`https://${sentinel}@example.invalid/mcp`}}
  const records: Buffer[] = []
  let encoder: ReturnType<typeof createNativeHttpEncoderV2> | undefined
  let syncs = 0
  const fixture = await supervisedFixture({
    initialManagedConfig: {mcp:body.mcp},
    handle(_request,response) {response.statusCode = failResponse ? 500 : 200;response.setHeader('content-type','application/json');response.setHeader('x-private-error',sentinel);response.end(JSON.stringify(body))},
    encode(observation,expected) {
      encoder ??= createNativeHttpEncoderV2({bootstrapV2HeaderSha256:sha256('header'),expectedHostSha256:sha256('expected'),
        descriptorMapSha256:sha256('map'),captureId:sha256('capture'),row:'01_pending_before_http',routeId:null,
        activation:expected.activation,recorder:{role:'owner',pid:process.pid,startTicks:expected.process.startTicks,
          processStartToken:sha256('owner-start'),ownerGeneration:expected.activation.ownerGeneration,
          ownerSessionId:expected.activation.ownerSessionId},expectedPeer:expected.process},Buffer.alloc(0),
        {initialByteLength:0,initialSha256:sha256(Buffer.alloc(0)),nextSequence:1},Buffer.alloc(32,7))
      return encoder(observation)
    },
    async write(bytes,offset,length) {const copy=Buffer.from(bytes.subarray(offset,offset+length));records.push(copy);return copy.length},
    async sync() {syncs++},
  })
  try {
    const custody = await fixture.acquire()
    const client = new OpenCodeClientFactory({acquisitionPolicy:{mode:'supervisor-adopt-only',custody}}).create(fixture.expected.endpoint.baseUrl)
    if (!failResponse) {
      expect(await client.getConfig()).toEqual(body)
      expect(syncs).toBe(2)
      expect(await client.getConfigProviders()).toEqual(body)
      expect(await client.getMcp()).toEqual(body)
      expect(await client.connectMcp!('private-mcp')).toEqual(body)
      expect(fixture.requests.map(request => request.url)).toEqual([
        '/config', '/config/providers', '/mcp', '/mcp/private-mcp/connect',
      ])
      expect(syncs).toBe(8)
      expect(custody.rawRetention.isCurrent()).toBe(true)
    } else {
      const failure = await client.getConfig().catch(error => error)
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).toContain('500')
      expect(String(failure)).not.toContain(sentinel)
      expect(fixture.requests).toHaveLength(1)
      expect(syncs).toBe(3) // request, raw 500 body, terminal failure
      expect(custody.rawRetention.isCurrent()).toBe(false)
    }
    const failureResponse = fixture.observations.findLast(record => record.phase === 'response')!
    expect(failureResponse.phase === 'response' && Buffer.from(failureResponse.body.bodyBase64,'base64').toString()).toBe(JSON.stringify(body))
    for(const line of records) {
      const outer = JSON.parse(line.toString())
      const payload = JSON.parse(Buffer.from(outer.payloadBase64,'base64').toString())
      const record = decodePrivateHttpRecord(payload)
      expect(JSON.stringify(record)).not.toContain(sentinel)
      expect(JSON.stringify(record)).not.toContain(sha256(JSON.stringify(body)))
      expect(outer.effectCount).toBe(0)
    }
  } finally {await fixture.close()}
},120_000)


test.skipIf(process.platform !== 'linux')('private MCP add rejects before HTTP and invalidates previously prepared authority', async () => {
  const fixture = await supervisedFixture()
  try {
    const custody = await fixture.acquire()
    const token = await custody.prepareOperationToken({kind:'provider',name:'session-create',method:'POST',path:'/session'})
    expect(token).not.toBeNull()
    const client = new OpenCodeClientFactory({acquisitionPolicy:{mode:'supervisor-adopt-only',custody}})
      .create(fixture.expected.endpoint.baseUrl)
    const pending = client.addMcp!('unadmitted', {type:'local',command:['node','private-sentinel']})
    expect(token!.consume()).toBe(false)
    await expect(pending).rejects.toThrow()
    expect(fixture.requests).toHaveLength(0)
    expect(fixture.connections).toHaveLength(0)
    expect(custody.rawRetention.isCurrent()).toBe(false)
  } finally { await fixture.close() }
},120_000)
