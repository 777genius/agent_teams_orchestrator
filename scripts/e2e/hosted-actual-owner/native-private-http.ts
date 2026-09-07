import { createHmac } from 'node:crypto'
import type { OpenCodeRawObservation, RetainedBody } from '../../../src/services/opencode/OpenCodeHostedRawRetention.js'
import { classifySupervisedProviderOperation, PRIVATE_SUPERVISED_PROVIDER_OPERATIONS } from '../../../src/services/opencode/OpenCodeSupervisedOperation.js'
import { canonicalJson, exactRecord, sha256, type RawRecord } from './native-http-contract.js'
import { HTTP_LIMITS, type HostedHttpContext } from './native-raw-http-types.js'
import { httpCheck, httpHex, decodeHttpBase64, parseHttpCanonical, parseHttpContext, parseConnectedHttpPeer, freezeHttpData } from './native-raw-http.js'

export const PRIVATE_HTTP_KIND = 'opencode-http-private-observation/v1' as const
export const PRIVATE_HTTP_PURPOSE = 'agent-teams.p3c.opencode-http-private-observation/v1' as const
export const PRIVATE_HTTP_DOMAIN = `${PRIVATE_HTTP_PURPOSE}\0`
export type PrivateHttpOperationName = typeof PRIVATE_SUPERVISED_PROVIDER_OPERATIONS[number]
export type PrivateHttpBody = Readonly<{ byteLength: number; hmacSha256: string }>
type PrivateHttpCommon = Readonly<{ ownerExchangeNonce: string; operation: PrivateHttpOperationName }>
export type PrivateHttpObservation =
  | (PrivateHttpCommon & Readonly<{ phase: 'request-retained'; method: 'GET' | 'POST'; privateBody: PrivateHttpBody }>)
  | (PrivateHttpCommon & Readonly<{ phase: 'response-retained'; requestRecordId: string; status: number;
      connectedPeer: import('./native-raw-http-types.js').ConnectedHttpPeer; complete: boolean;
      encoding: 'absent' | 'identity' | 'unexpected'; nonceStatus: 'present' | 'missing' | 'invalid'; privateBody: PrivateHttpBody }>)
  | (PrivateHttpCommon & Readonly<{ phase: 'exchange-failed'; requestRecordId: string;
      failure: Readonly<{phase: 'before-end' | 'end-attempted' | 'response-incomplete'; code: 'http_exchange_failed'}>;
      privateBody: null }>)
export type PrivateHttpRecord = Readonly<{ schemaVersion: 1; purpose: typeof PRIVATE_HTTP_PURPOSE;
  context: HostedHttpContext; observation: PrivateHttpObservation }>
export type PrivateHttpPayload = Readonly<{kind: typeof PRIVATE_HTTP_KIND; recordBase64: string; recordSha256: string}>

const names = new Set<string>(PRIVATE_SUPERVISED_PROVIDER_OPERATIONS)
export function privateHttpOperation(input: Extract<OpenCodeRawObservation, { phase: 'request' }>): string | null {
  const privatePath = /^\/(?:config(?:\/providers)?|provider(?:\/auth)?|agent|mcp(?:\/[A-Za-z0-9_.-]{1,256}\/connect)?)$/.test(input.path)
  if (!privatePath && input.binding.operation.kind !== 'provider') return null
  const actual = classifySupervisedProviderOperation(input.method, input.path)
  httpCheck(canonicalJson(actual) === canonicalJson(input.binding.operation), 'private_operation_binding')
  return actual.kind === 'provider' && names.has(actual.name) ? actual.name : null
}

/** Only this deliberately constructed public object is serialized. Original
 * digest, headers, URL, error text and body encoding stay inside the consumer. */
export function privateHttpObservation(context: HostedHttpContext, key: Buffer,
  operation: string, input: OpenCodeRawObservation): PrivateHttpObservation {
  httpCheck(key.length === 32 && names.has(operation), 'private_http_authority')
  const ownerExchangeNonce = input.phase === 'request' ? input.binding.ownerExchangeNonce : input.request?.ownerExchangeNonce
  httpCheck(!!ownerExchangeNonce, 'private_http_exchange')
  let metadata: Record<string, unknown>
  let body: RetainedBody | null = null
  if (input.phase === 'request') {
    body = input.body
    metadata = { phase: 'request-retained', ownerExchangeNonce, operation, method: input.method }
  } else if (input.phase === 'response') {
    body = input.body
    metadata = { phase: 'response-retained', ownerExchangeNonce, operation,
      requestRecordId: input.request.recordId, status: input.status, connectedPeer: input.connectedPeer,
      complete: input.complete, encoding: input.contentEncoding === null ? 'absent' :
        input.contentEncoding === 'identity' ? 'identity' : 'unexpected', nonceStatus: input.nonceStatus }
  } else {
    metadata = { phase: 'exchange-failed', ownerExchangeNonce, operation,
      requestRecordId: input.request!.recordId,
      failure: { phase: input.failure.phase, code: 'http_exchange_failed' } }
  }
  let privateBody: { byteLength: number; hmacSha256: string } | null = null
  if (body) {
    const bytes = Buffer.from(body.bodyBase64, 'base64')
    try {
      httpCheck(bytes.length <= HTTP_LIMITS.body && bytes.length === body.byteLength &&
        bytes.toString('base64') === body.bodyBase64 && sha256(bytes) === body.sha256, 'private_http_body')
      privateBody = { byteLength: bytes.length, hmacSha256: createHmac('sha256', key)
        .update(PRIVATE_HTTP_DOMAIN).update(canonicalJson({ context, observation: metadata,
          byteLength: bytes.length, originalSha256: body.sha256 })).digest('hex') }
    } finally { bytes.fill(0) }
  }
  return { ...metadata, privateBody } as PrivateHttpObservation
}

/** Strict structural decoder. A valid commitment remains unverified observation
 * data; this routine never exposes an approval/native receipt constructor. */
export function decodePrivateHttpRecord(payload: Record<string, unknown>): PrivateHttpRecord {
  exactRecord(payload, ['kind', 'recordBase64', 'recordSha256'], 'private_http_payload')
  httpCheck(payload.kind === PRIVATE_HTTP_KIND && httpHex(payload.recordSha256), 'private_http_kind')
  const bytes = decodeHttpBase64(payload.recordBase64, HTTP_LIMITS.record, 'private_http_record')
  httpCheck(sha256(bytes) === payload.recordSha256, 'private_http_digest')
  const record = exactRecord(parseHttpCanonical(bytes, 'private_http_record'),
    ['schemaVersion', 'purpose', 'context', 'observation'], 'private_http_record')
  httpCheck(record.schemaVersion === 1 && record.purpose === PRIVATE_HTTP_PURPOSE, 'private_http_version')
  const context = parseHttpContext(record.context)
  const raw = record.observation as Record<string, unknown>
  httpCheck(raw && typeof raw === 'object' && !Array.isArray(raw), 'private_http_observation')
  const common = ['phase', 'ownerExchangeNonce', 'operation', 'privateBody']
  const extra = raw.phase === 'request-retained' ? ['method'] : raw.phase === 'response-retained' ?
    ['requestRecordId', 'status', 'connectedPeer', 'complete', 'encoding', 'nonceStatus'] :
    raw.phase === 'exchange-failed' ? ['requestRecordId', 'failure'] : null
  httpCheck(extra, 'private_http_phase')
  const observation = exactRecord(raw, [...common, ...extra], 'private_http_observation')
  httpCheck(httpHex(observation.ownerExchangeNonce) && typeof observation.operation === 'string' &&
    names.has(observation.operation), 'private_http_operation')
  if (observation.phase === 'request-retained') {
    const method = ['mcp-add', 'mcp-connect'].includes(observation.operation as string) ? 'POST' : 'GET'
    httpCheck(observation.method === method, 'private_http_method')
  } else {
    httpCheck(httpHex(observation.requestRecordId), 'private_http_request')
    if (observation.phase === 'response-retained') {
      httpCheck(Number.isSafeInteger(observation.status) && Number(observation.status) >= 100 &&
        Number(observation.status) <= 599 && typeof observation.complete === 'boolean' &&
        ['absent', 'identity', 'unexpected'].includes(observation.encoding as string) &&
        ['present', 'missing', 'invalid'].includes(observation.nonceStatus as string), 'private_http_response')
      parseConnectedHttpPeer(observation.connectedPeer)
    } else {
      const failure = exactRecord(observation.failure, ['phase', 'code'], 'private_http_failure')
      httpCheck(['before-end', 'end-attempted', 'response-incomplete'].includes(failure.phase as string) &&
        failure.code === 'http_exchange_failed' && observation.privateBody === null, 'private_http_failure')
    }
  }
  if (observation.phase !== 'exchange-failed') {
    const body = exactRecord(observation.privateBody, ['byteLength', 'hmacSha256'], 'private_http_body')
    httpCheck(Number.isSafeInteger(body.byteLength) && Number(body.byteLength) >= 0 &&
      Number(body.byteLength) <= HTTP_LIMITS.body && httpHex(body.hmacSha256), 'private_http_body')
  }
  return freezeHttpData({ schemaVersion: 1 as const, purpose: PRIVATE_HTTP_PURPOSE, context, observation: observation as unknown as PrivateHttpObservation })
}

export function assertPrivateHttpOuterBinding(outer: RawRecord, record: ReturnType<typeof decodePrivateHttpRecord>) {
  const c = record.context, o = record.observation
  const event = o.phase === 'request-retained' ? 'hosted_http_request_retained' :
    o.phase === 'response-retained' ? 'hosted_http_response_retained' : 'hosted_http_exchange_failed'
  httpCheck(outer.origin === 'opencode' && outer.effectCount === 0 && outer.event === event &&
    outer.row === c.row && outer.processStartToken === c.recorder.processStartToken &&
    outer.controllerNonce === c.activation.controllerNonce && outer.correlation === o.ownerExchangeNonce,
  'private_http_outer_binding')
}
