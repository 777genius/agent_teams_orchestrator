import { PRIVATE_HTTP_KIND, decodePrivateHttpRecord, assertPrivateHttpOuterBinding } from './native-private-http.js'
import { canonicalJson, exactRecord, MATRIX_ROWS, RAW_RECORD_PURPOSE, sha256, type RawRecord } from './native-http-contract.js'
import { HTTP_LIMITS, HTTP_OBSERVATION_KIND } from './native-raw-http-types.js'
import { assertHttpOuterBinding, decodeHttpBase64, decodeHttpRecord, decodeOwnerHttpRecordV2,
  httpCheck, httpHex, httpId, OWNER_HTTP_OBSERVATION_KIND, parseHttpCanonical } from './native-raw-http.js'

const keys = ['schemaVersion', 'purpose', 'controllerNonce', 'origin', 'row', 'sequence',
  'monotonicNs', 'processStartToken', 'recordId', 'event', 'correlation', 'effectCount', 'payloadBase64', 'payloadSha256']
const recordId = (unsigned: unknown) => sha256(`agent-teams.p3c.raw-record-id/v1\0${canonicalJson(unsigned)}`)

/** Exact Product outer framing. Valid framing alone does not accept legacy
 * provider evidence or prove an effect; Product's semantic reader owns that. */
export function parseNativeRawEnvelope(bytes: Buffer, sequence: number, controllerNonce: string): RawRecord {
  httpCheck(bytes.length > 0 && bytes.length + 1 <= HTTP_LIMITS.line, 'outer_limit')
  const value = exactRecord(parseHttpCanonical(bytes, 'outer'), keys, 'raw_record')
  httpCheck(value.schemaVersion === 1 && value.purpose === RAW_RECORD_PURPOSE &&
    value.origin === 'opencode' && value.controllerNonce === controllerNonce && httpHex(controllerNonce) &&
    Number.isSafeInteger(sequence) && sequence >= 1 && value.sequence === sequence &&
    MATRIX_ROWS.includes(value.row as never) && httpId(value.event) && httpHex(value.correlation) &&
    httpHex(value.processStartToken) && httpHex(value.recordId) && httpHex(value.payloadSha256) &&
    Number.isSafeInteger(value.effectCount) && (value.effectCount as number) >= 0 &&
    (value.effectCount as number) <= 16 && typeof value.monotonicNs === 'string' &&
    /^(?:0|[1-9][0-9]{0,19})$/.test(value.monotonicNs) &&
    BigInt(value.monotonicNs) <= 18446744073709551615n, 'outer_fields')
  const payload = decodeHttpBase64(value.payloadBase64, HTTP_LIMITS.payload, 'outer_base64')
  httpCheck(payload.length >= 2 && sha256(payload) === value.payloadSha256, 'outer_payload_digest')
  const unsigned = { ...value }; delete unsigned.recordId
  httpCheck(recordId(unsigned) === value.recordId, 'outer_identity')
  const outer = Object.freeze(value) as unknown as RawRecord
  const data = parseHttpCanonical(payload, 'payload') as Record<string, unknown>
  httpCheck(data !== null && typeof data === 'object' && !Array.isArray(data), 'outer_payload')
  if (data.kind === HTTP_OBSERVATION_KIND) assertHttpOuterBinding(outer, decodeHttpRecord(data))
  if (data.kind === OWNER_HTTP_OBSERVATION_KIND) assertHttpOuterBinding(outer, decodeOwnerHttpRecordV2(data))
  if (data.kind === PRIVATE_HTTP_KIND) assertPrivateHttpOuterBinding(outer, decodePrivateHttpRecord(data))
  return outer
}

export function encodeNativeRawEnvelope(input: Omit<RawRecord,
  'schemaVersion' | 'purpose' | 'recordId' | 'payloadBase64' | 'payloadSha256'> & { payload: unknown }) {
  const payload = Buffer.from(canonicalJson(input.payload))
  httpCheck(payload.length <= HTTP_LIMITS.payload, 'outer_payload_limit')
  const unsigned = { schemaVersion: 1 as const, purpose: RAW_RECORD_PURPOSE,
    controllerNonce: input.controllerNonce, origin: input.origin, row: input.row, sequence: input.sequence,
    monotonicNs: input.monotonicNs, processStartToken: input.processStartToken, event: input.event,
    correlation: input.correlation, effectCount: input.effectCount,
    payloadBase64: payload.toString('base64'), payloadSha256: sha256(payload) }
  const record = { ...unsigned, recordId: recordId(unsigned) }
  const line = Buffer.from(canonicalJson(record))
  parseNativeRawEnvelope(line, input.sequence, input.controllerNonce)
  return { bytes: Buffer.concat([line, Buffer.from('\n')]), recordId: record.recordId }
}

/** Preserve actual prefix bytes and sequence, including non-HTTP provider
 * records. Does not turn those records into Owner HTTP observations. */
export function inspectNativeRawPrefix(bytes: Buffer, binding: {
  initialByteLength: number; initialSha256: string; nextSequence: number
}, controllerNonce: string): Readonly<{ nextSequence: number; lastMonotonicNs: bigint; privateByteLength: number }> {
  httpCheck(bytes.length <= HTTP_LIMITS.ledger && bytes.length === binding.initialByteLength &&
    sha256(bytes) === binding.initialSha256 && Number.isSafeInteger(binding.nextSequence), 'prefix_binding')
  httpCheck(bytes.length === 0 || bytes.at(-1) === 10, 'prefix_framing')
  let offset = 0, sequence = 1, previous = -1n, privateByteLength = 0
  const ids = new Set<string>()
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset)
    httpCheck(end > offset, 'prefix_line')
    const record = parseNativeRawEnvelope(bytes.subarray(offset, end), sequence, controllerNonce)
    const payload = parseHttpCanonical(decodeHttpBase64(record.payloadBase64, HTTP_LIMITS.payload, 'prefix_payload'), 'prefix_payload') as Record<string, unknown>
    if (payload.kind === PRIVATE_HTTP_KIND) {
      const body = decodePrivateHttpRecord(payload).observation.privateBody as { byteLength: number } | null
      privateByteLength += body?.byteLength ?? 0
      httpCheck(bytes.length + privateByteLength <= HTTP_LIMITS.ledger, 'prefix_private_budget')
    }
    const clock = BigInt(record.monotonicNs)
    httpCheck(clock > previous && !ids.has(record.recordId), 'prefix_order')
    ids.add(record.recordId); previous = clock; sequence += 1; offset = end + 1
  }
  httpCheck(sequence === binding.nextSequence, 'prefix_sequence')
  return Object.freeze({ nextSequence: sequence, lastMonotonicNs: previous, privateByteLength })
}
