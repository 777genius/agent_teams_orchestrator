import type { HostedControlBootstrapAdmissionV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2.js'
import type { OpenCodeRawObservation, OpenCodeRawRetentionSink } from '../../../src/services/opencode/OpenCodeHostedRawRetention.js'
import { canonicalJson, sha256, type MatrixRow } from './native-http-contract.js'
import { HTTP_LIMITS, type HostedHttpContext } from './native-raw-http-types.js'
import { decodeOwnerHttpRecordV2, httpCheck, OWNER_HTTP_OBSERVATION_KIND,
  OWNER_HTTP_OBSERVATION_PURPOSE, snapshotHttpContext } from './native-raw-http.js'
import { encodeNativeRawEnvelope, inspectNativeRawPrefix } from './native-raw-envelope.js'
import { retainNativeRawDescriptorV2 } from './native-raw-descriptor-v2.js'

/** Builds recorder/process/descriptor context from retained bootstrap facts.
 * Row and route are selected invocation data, never inferred from an effect. */
export function nativeHttpContextV2(bootstrap: HostedControlBootstrapAdmissionV2,
  location: Readonly<{ row: MatrixRow; routeId: string | null }>): HostedHttpContext {
  const h = bootstrap.header
  httpCheck(bootstrap.executedOwner.pid === h.supervisorBinding.ownerPid &&
    bootstrap.executedOwner.startTicks === h.supervisorBinding.ownerStartTicks, 'recorder_process')
  return snapshotHttpContext({ bootstrapV2HeaderSha256: bootstrap.bootstrapV2HeaderSha256,
    expectedHostSha256: sha256(canonicalJson(bootstrap.expectedHost)),
    descriptorMapSha256: sha256(canonicalJson(h.descriptorMap)),
    captureId: bootstrap.rawRetention.binding.captureId, row: location.row, routeId: location.routeId,
    activation: { ...bootstrap.expectedHost.activation },
    recorder: { role: 'owner', pid: bootstrap.executedOwner.pid, startTicks: bootstrap.executedOwner.startTicks,
      processStartToken: h.supervisorBinding.ownerProcessStartToken,
      ownerGeneration: h.ownerGeneration, ownerSessionId: h.ownerSessionId },
    expectedPeer: { ...bootstrap.expectedHost.process },
  })
}

/** Pure bounded encoder state. Neither context nor valid bytes confer custody.
 * Requests are indexed before completion so terminal records cannot substitute
 * another exchange or acquire a new context after authority loss. */
export function createNativeHttpEncoderV2(contextValue: HostedHttpContext,
  prefix: Buffer, binding: { initialByteLength: number; initialSha256: string; nextSequence: number }) {
  const context = snapshotHttpContext(contextValue)
  const state = inspectNativeRawPrefix(prefix, binding, context.activation.controllerNonce)
  let sequence = state.nextSequence, previous = state.lastMonotonicNs
  const requests = new Map<string, { nonce: string; responded: boolean; privateConfiguration: boolean }>()
  const nonces = new Set<string>()
  let failed = false
  return (input: OpenCodeRawObservation): { bytes: Uint8Array; recordId: string } => {
    httpCheck(!failed, 'encoder_failed')
    try {
      let observation: Record<string, unknown>
      if (input.phase === 'request') {
        // No admitted nonsecret body contract exists for configuration writes.
        httpCheck(!(input.method === 'POST' && input.path === '/mcp'), 'private_configuration_body')
        httpCheck(!nonces.has(input.binding.ownerExchangeNonce), 'encoder_nonce_reuse')
        observation = { phase: 'request-retained', ownerExchangeNonce: input.binding.ownerExchangeNonce,
          operation: input.binding.operation, method: input.method, path: input.path, body: input.body }
      } else {
        const request = input.request
        const retained = request && requests.get(request.recordId)
        httpCheck(!request || retained?.nonce === request.ownerExchangeNonce, 'encoder_request_binding')
        if (input.phase === 'response') {
          httpCheck(retained && !retained.responded && input.connectedPeer, 'encoder_response_binding')
          // Base64 and normalized fingerprints cannot establish nonsecret bytes.
          // Refuse publication before building any record/body hash envelope.
          httpCheck(!retained.privateConfiguration, 'private_configuration_body')
          observation = { phase: 'response-retained', ownerExchangeNonce: request!.ownerExchangeNonce,
            requestRecordId: request!.recordId, status: input.status, responseHeaders: input.responseHeaders,
            peerOperationNonce: input.peerOperationNonce, nonceStatus: input.nonceStatus,
            connectedPeer: input.connectedPeer, body: input.body, complete: input.complete }
        } else observation = { phase: 'exchange-failed', ownerExchangeNonce: request?.ownerExchangeNonce ?? null,
          requestRecordId: request?.recordId ?? null, failure: input.failure }
      }
      const record = Buffer.from(canonicalJson({ schemaVersion: 2, purpose: OWNER_HTTP_OBSERVATION_PURPOSE,
        context, observation }))
      httpCheck(record.length <= HTTP_LIMITS.record, 'encoder_record_limit')
      const payload = { kind: OWNER_HTTP_OBSERVATION_KIND, recordBase64: record.toString('base64'), recordSha256: sha256(record) }
      decodeOwnerHttpRecordV2(payload)
      // Never increment or synthesize the observed clock to clear prefix checks.
      const clock = process.hrtime.bigint()
      httpCheck(clock > previous, 'encoder_clock')
      const events = { request: 'hosted_http_request_retained', response: 'hosted_http_response_retained', failure: 'hosted_http_exchange_failed' }
      const encoded = encodeNativeRawEnvelope({ controllerNonce: context.activation.controllerNonce,
        origin: 'opencode', row: context.row, sequence, monotonicNs: clock.toString(),
        processStartToken: context.recorder.processStartToken, event: events[input.phase],
        correlation: observation.ownerExchangeNonce as string ?? context.captureId, effectCount: 0, payload })
      if (input.phase === 'request') {
        httpCheck(requests.size < 65536, 'encoder_request_limit')
        nonces.add(input.binding.ownerExchangeNonce)
        requests.set(encoded.recordId, { nonce: input.binding.ownerExchangeNonce, responded: false, privateConfiguration: input.path === '/config' || input.path === '/config/providers' })
      } else if (input.phase === 'response') requests.get(input.request.recordId)!.responded = true
      sequence += 1; previous = clock
      return encoded
    } catch (error) { failed = true; throw error }
  }
}

/** Takes the actual FD8 only; no path writer or injectable encoding callback. */
export async function createNativeRawSinkV2(bootstrap: HostedControlBootstrapAdmissionV2,
  location: Readonly<{ row: MatrixRow; routeId: string | null }>, deadline: number): Promise<OpenCodeRawRetentionSink> {
  const context = nativeHttpContextV2(bootstrap, location)
  const storage = retainNativeRawDescriptorV2(bootstrap.rawRetention, deadline, context.activation.controllerNonce)
  try {
    const encode = createNativeHttpEncoderV2(context, storage.readPrefix(), storage.binding)
    return Object.freeze({ initialByteLength: storage.initialByteLength, encode,
      isCurrent: storage.isCurrent, write: storage.write, sync: storage.sync, close: storage.close })
  } catch (error) { await storage.close(); throw error }
}
