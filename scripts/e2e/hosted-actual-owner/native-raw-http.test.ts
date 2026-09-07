import { expect, test } from 'bun:test'
import { parseHttpCanonical, parseHttpOperation, parseOwnerHttpOperationV2,
  ownerHttpOperationRouteV2, httpHeaderStatus } from './native-raw-http.js'

test('P1 remains closed while explicit v2 names actual ordinary and streaming consumers', () => {
  const operations = [
    { kind: 'provider', name: 'session-create', method: 'POST', path: '/session' },
    { kind: 'events', path: '/global/event' },
    { kind: 'transcript', sessionId: 'ses_1', limit: 50 },
  ]
  for (const op of operations) {
    expect(() => parseHttpOperation(op)).toThrow()
    expect(parseOwnerHttpOperationV2(op)).toEqual(op)
  }
  expect(ownerHttpOperationRouteV2(operations[2])).toEqual({ method: 'GET', path: '/session/ses_1/message?limit=50' })
  expect(parseOwnerHttpOperationV2({ kind: 'capability' })).toEqual(parseHttpOperation({ kind: 'capability' }))
})

test('v2 rejects fabricated classifications, credentials, alternate routes and unbounded transcript', () => {
  for (const op of [
    { kind: 'provider', name: 'health', method: 'POST', path: '/session' },
    { kind: 'provider', name: 'health', method: 'POST', path: '/auth/provider' },
    { kind: 'events', path: '/event?other=1' },
    { kind: 'transcript', sessionId: 'ses_1', limit: 500 },
    { kind: 'transcript', sessionId: '../event', limit: 50 },
    { kind: 'capability', authority: true },
  ]) expect(() => parseOwnerHttpOperationV2(op)).toThrow()
})

test('canonical framing rejects duplicate keys, BOM and alternative spellings', () => {
  for (const text of ['{"a":1,"a":1}', '{ "a":1}', '{"a":1.0}', '\ufeff{"a":1}', '{"a":"\\ud800"}']) {
    expect(() => parseHttpCanonical(Buffer.from(text), 'fixture')).toThrow()
  }
  expect(parseHttpCanonical(Buffer.from('{"a":1}'), 'fixture')).toEqual({ a: 1 })
})

test('duplicate nonce occurrences remain invalid and never become correlated evidence', () => {
  const nonce = 'a'.repeat(64)
  expect(httpHeaderStatus([['x-agent-teams-hosted-operation-nonce', nonce],
    ['X-Agent-Teams-Hosted-Operation-Nonce', nonce]])).toEqual({
    nonceStatus: 'invalid', peerOperationNonce: null, identityEncoding: true,
  })
})

import { canonicalJson, sha256 } from './native-http-contract.js'
import { encodeNativeRawEnvelope, inspectNativeRawPrefix } from './native-raw-envelope.js'
import { createNativeHttpEncoderV2 } from './native-raw-sink-v2.js'
import { decodeOwnerHttpRecordV2, decodeHttpRecord } from './native-raw-http.js'
import type { HostedHttpContext } from './native-raw-http-types.js'
import type { TrustedHttpOperationBinding } from '../../../src/services/opencode/OpenCodeHostedRawRetention.js'

const hex = 'a'.repeat(64)
const context: HostedHttpContext = {
  bootstrapV2HeaderSha256: hex, expectedHostSha256: hex, descriptorMapSha256: hex,
  captureId: hex, row: '01_pending_before_http', routeId: null,
  activation: { controllerNonce: hex, runId: hex, stackManifestSha256: hex, bootstrapDigest: hex,
    admissionDocumentDigest: `sha256:${hex}`, ownerArtifactDigest: `sha256:${hex}`,
    ownerGeneration: 1, ownerSessionId: 'owner_1' },
  recorder: { role: 'owner', pid: 123, startTicks: '1', processStartToken: hex,
    ownerGeneration: 1, ownerSessionId: 'owner_1' },
  expectedPeer: { pid: 124, startTicks: '2', startIdentity: `start_${sha256('124\0proc:2')}`,
    supervisorProcessStartToken: hex, pidNamespaceInode: '3', networkNamespaceInode: '4' },
}
const emptyBinding = { initialByteLength: 0, initialSha256: sha256(Buffer.alloc(0)), nextSequence: 1 }

test('actual encoder emits explicit v2 in canonical unchanged RawRecord outer envelope', () => {
  const encode = createNativeHttpEncoderV2(context, Buffer.alloc(0), emptyBinding)
  const bytes = Buffer.from('actual request body')
  const output = encode({ phase: 'request', method: 'POST', path: '/session',
    binding: { ownerExchangeNonce: hex,
      operation: { kind: 'provider', name: 'session-create', method: 'POST', path: '/session' } } as TrustedHttpOperationBinding,
    body: { byteLength: bytes.length, bodyBase64: bytes.toString('base64'), sha256: sha256(bytes) } })
  const line = Buffer.from(output.bytes)
  const outer = JSON.parse(line.toString())
  expect(Buffer.from(canonicalJson(outer) + '\n')).toEqual(line)
  expect(outer.recordId).toBe(output.recordId)
  expect(outer.effectCount).toBe(0)
  const payload = JSON.parse(Buffer.from(outer.payloadBase64, 'base64').toString())
  expect(() => decodeHttpRecord(payload)).toThrow()
  expect(decodeOwnerHttpRecordV2(payload).observation).toMatchObject({ phase: 'request-retained',
    method: 'POST', path: '/session', body: { bodyBase64: bytes.toString('base64') } })
  expect(inspectNativeRawPrefix(line, { initialByteLength: line.length,
    initialSha256: sha256(line), nextSequence: 2 }, hex).nextSequence).toBe(2)
})

test('prefix continuity rejects truncation, sequence substitutions and digest-valid reversed clocks', () => {
  const record = (sequence: number, monotonicNs: string) => encodeNativeRawEnvelope({
    controllerNonce: hex, origin: 'opencode', row: context.row, sequence, monotonicNs,
    processStartToken: hex, event: 'fixture_record', correlation: hex, effectCount: 0, payload: { fixture: true },
  }).bytes
  const first = Buffer.from(record(1, '10'))
  for (const prefix of [first.subarray(0, -1), Buffer.concat([first, record(3, '11')]),
    Buffer.concat([first, record(2, '9')])]) {
    expect(() => inspectNativeRawPrefix(prefix, { initialByteLength: prefix.length,
      initialSha256: sha256(prefix), nextSequence: 3 }, hex)).toThrow()
  }
  expect(() => inspectNativeRawPrefix(first, { initialByteLength: first.length,
    initialSha256: sha256(first), nextSequence: 3 }, hex)).toThrow()
})

test('encoder fails permanently on exchange nonce reuse without fabricating another request', () => {
  const encode = createNativeHttpEncoderV2(context, Buffer.alloc(0), emptyBinding)
  const request = { phase: 'request' as const, method: 'GET', path: '/global/health',
    binding: { ownerExchangeNonce: hex, operation: { kind: 'provider', name: 'health',
      method: 'GET', path: '/global/health' } } as TrustedHttpOperationBinding,
    body: { byteLength: 0, bodyBase64: '', sha256: sha256(Buffer.alloc(0)) } }
  encode(request)
  expect(() => encode(request)).toThrow('encoder_nonce_reuse')
  expect(() => encode({ ...request, binding: { ...request.binding,
    ownerExchangeNonce: 'b'.repeat(64) } })).toThrow('encoder_failed')
})

test('private config/MCP bytes survive retention while public records omit credentials including failures', async () => {
  const { createOpenCodeRawRetention } = await import('../../../src/services/opencode/OpenCodeHostedRawRetention.js')
  const { classifySupervisedProviderOperation } = await import('../../../src/services/opencode/OpenCodeSupervisedOperation.js')
  for (const [method, path] of [['GET','/config'], ['GET','/config/providers'], ['GET','/provider'],
    ['GET','/provider/auth'], ['GET','/agent'], ['GET','/mcp'], ['POST','/mcp'], ['POST','/mcp/private-name/connect']] as const) {
    const lines: Buffer[] = []
    let syncs = 0
    const port = createOpenCodeRawRetention({
      encode: createNativeHttpEncoderV2(context, Buffer.alloc(0), emptyBinding, Buffer.alloc(32, 7)),
      isCurrent: () => true, write: async (bytes, offset, length) => {
        lines.push(Buffer.from(bytes.subarray(offset, offset + length))); return length
      }, sync: async () => { syncs++ }, close: async () => {},
    })
    const bytes = Buffer.from(JSON.stringify({nested:{environment:{TOKEN:'sentinel-private-r1098'},
      arguments:['sentinel-private-r1098'], url:'https://sentinel-private-r1098@example.test'}}))
    const request = await port.retainRequest(port.bindOperation(classifySupervisedProviderOperation(method,path)),
      { method, path, bytes })
    expect(syncs).toBe(1)
    expect(Buffer.from(request.body.bodyBase64,'base64')).toEqual(bytes)
    const retained = await port.retainResponse(request, { status: 500, contentEncoding: null,
      peerOperationNonce:null, bytes, complete:true, responseHeaders:[['x-error','sentinel-private-r1098']],
      connectedPeer:{localAddress:'127.0.0.1',localPort:50000,remoteAddress:'127.0.0.1',remotePort:4096} })
    expect(syncs).toBe(2)
    expect(Buffer.from(retained.bodyBase64,'base64')).toEqual(bytes)
    await port.recordFailure(request,{phase:'response-incomplete',code:'sentinel-private-r1098'})
    for (const line of lines) {
      const outer = JSON.parse(line.toString())
      const payload = JSON.parse(Buffer.from(outer.payloadBase64,'base64').toString())
      expect(payload.kind).toBe('opencode-http-private-observation/v1')
      const record = Buffer.from(payload.recordBase64,'base64').toString()
      for (const forbidden of ['sentinel-private-r1098', bytes.toString('base64'), sha256(bytes), 'bodyBase64', 'private-name']) {
        expect(record).not.toContain(forbidden)
      }
      expect(outer.effectCount).toBe(0)
    }
    await port.close()
  }
})

test('private commitment binds bytes, direction, context and response status', async () => {
  const { privateHttpObservation } = await import('./native-private-http.js')
  const key = Buffer.alloc(32, 7)
  const makeBody = (value: string) => ({ byteLength:Buffer.byteLength(value),
    bodyBase64:Buffer.from(value).toString('base64'), sha256:sha256(value) })
  const request = { phase:'request' as const, method:'GET',path:'/config',body:makeBody('secret'),
    binding:{ownerExchangeNonce:hex,operation:{kind:'provider',name:'config',method:'GET',path:'/config'}} as TrustedHttpOperationBinding }
  const digest = (ctx: HostedHttpContext, observation: any) =>
    (privateHttpObservation(ctx,key,'config',observation).privateBody as {hmacSha256:string}).hmacSha256
  const original = digest(context,request)
  expect(digest(context,{...request,body:makeBody('mutant')})).not.toBe(original)
  expect(digest({...context,captureId:'b'.repeat(64)},request)).not.toBe(original)
  const response = { phase:'response',request:{recordId:hex,ownerExchangeNonce:hex},body:request.body,
    status:200,complete:true,contentEncoding:null,nonceStatus:'missing',connectedPeer:{
      localAddress:'127.0.0.1',localPort:50000,remoteAddress:'127.0.0.1',remotePort:4096} }
  expect(digest(context,response)).not.toBe(original)
  expect(digest(context,{...response,status:500})).not.toBe(digest(context,response))
  expect(digest(context,{...response,complete:false})).not.toBe(digest(context,response))
})

test('private bytes count toward capture budget and sync failure prevents consumer completion', async () => {
  const {createOpenCodeRawRetention} = await import('../../../src/services/opencode/OpenCodeHostedRawRetention.js')
  for (const mode of ['budget','sync'] as const) {
    let writes = 0, completed = false
    const encoder = createNativeHttpEncoderV2(context,Buffer.alloc(0),emptyBinding,Buffer.alloc(32,7))
    const port = createOpenCodeRawRetention({encode:encoder,
      initialByteLength:mode === 'budget' ? 64*1024*1024 - 8192 : 0,
      isCurrent:()=>true,write:async (_bytes,_offset,length)=>{writes++;return length},
      sync:async()=>{if(mode === 'sync') throw new Error('sentinel-private-sync')},close:async()=>{},
    })
    const bytes = Buffer.alloc(16384,0x61)
    try {
      await port.retainRequest(port.bindOperation({kind:'provider',name:'mcp-add',method:'POST',path:'/mcp'}),
        {method:'POST',path:'/mcp',bytes}).then(()=>{completed=true})
      throw new Error('Expected retention refusal')
    } catch (error) {
      expect(String(error)).toContain('append failed')
      expect(String(error)).not.toContain('sentinel-private-sync')
    }
    expect(completed).toBe(false)
    expect(port.isCurrent()).toBe(false)
    if(mode === 'budget') expect(writes).toBe(0)
    await port.close()
  }
})

test('replacement prefix carries private byte budget forward without publishing original hashes', () => {
  const encode = createNativeHttpEncoderV2(context,Buffer.alloc(0),emptyBinding,Buffer.alloc(32,7))
  const body=Buffer.from('private-prefix')
  const encoded=encode({phase:'request',method:'POST',path:'/mcp',
    binding:{ownerExchangeNonce:hex,operation:{kind:'provider',name:'mcp-add',method:'POST',path:'/mcp'}} as TrustedHttpOperationBinding,
    body:{byteLength:body.length,bodyBase64:body.toString('base64'),sha256:sha256(body)}})
  const bytes=Buffer.from(encoded.bytes)
  const prefix=inspectNativeRawPrefix(bytes,{initialByteLength:bytes.length,initialSha256:sha256(bytes),nextSequence:2},hex)
  expect(prefix.privateByteLength).toBe(body.length)
  const next=createNativeHttpEncoderV2(context,bytes,{initialByteLength:bytes.length,initialSha256:sha256(bytes),nextSequence:2},Buffer.alloc(32,7))
  expect(next.initialPrivateByteLength).toBe(body.length)
})

test('private decoder stays closed and partial encoded bodies remain private poisoned observations', async () => {
  const {decodePrivateHttpRecord} = await import('./native-private-http.js')
  const {createOpenCodeRawRetention} = await import('../../../src/services/opencode/OpenCodeHostedRawRetention.js')
  const lines: Buffer[]=[]
  const port=createOpenCodeRawRetention({
    encode:createNativeHttpEncoderV2(context,Buffer.alloc(0),emptyBinding,Buffer.alloc(32,7)),isCurrent:()=>true,
    write:async(bytes,offset,length)=>{const copy=Buffer.from(bytes.subarray(offset,offset+length));lines.push(copy);return copy.length},
    sync:async()=>{},close:async()=>{},
  })
  const request=await port.retainRequest(port.bindOperation({kind:'provider',name:'config',method:'GET',path:'/config'}),
    {method:'GET',path:'/config',bytes:Buffer.alloc(0)})
  await port.retainResponse(request,{status:500,contentEncoding:'gzip',peerOperationNonce:null,
    bytes:Buffer.from('partial-private-sentinel'),complete:false,
    connectedPeer:{localAddress:'127.0.0.1',localPort:50000,remoteAddress:'127.0.0.1',remotePort:4096}})
  expect(port.isCurrent()).toBe(false)
  const outer=JSON.parse(lines[1]!.toString())
  const payload=JSON.parse(Buffer.from(outer.payloadBase64,'base64').toString())
  const record=decodePrivateHttpRecord(payload)
  expect(record.observation).toMatchObject({phase:'response-retained',complete:false,encoding:'unexpected',status:500})
  expect(JSON.stringify(record)).not.toContain('partial-private-sentinel')
  expect(()=>decodeOwnerHttpRecordV2(payload)).toThrow()
  const changed=JSON.parse(Buffer.from(payload.recordBase64,'base64').toString())
  changed.observation.privateBody.bodyBase64=Buffer.from('secret').toString('base64')
  const bytes=Buffer.from(canonicalJson(changed))
  expect(()=>decodePrivateHttpRecord({...payload,recordBase64:bytes.toString('base64'),recordSha256:sha256(bytes)})).toThrow()
  await port.close()
})
