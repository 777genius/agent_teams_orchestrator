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
