import { isOpenCodeEventStreamContentType } from './OpenCodeEventStreamContentType.js'
import { fetchHostedApprovalOverAuthorizedConnection } from './OpenCodeClientFactory.js'
import { assertTrustedOpenCodeCustody, type TrustedOpenCodeCustody, type OneUseFence } from './OpenCodeSupervisedHostCustody.js'
import type { HostedHttpOperation, RetainedRequest } from './OpenCodeHostedRawRetention.js'

/** A bounded live SSE body on the same authorized socket as its retained
 * response. The returned Response is only a stream handle, never completion. */
export function createOpenCodeSupervisedEventFetch(custody: TrustedOpenCodeCustody, includeTranscript = false) {
  assertTrustedOpenCodeCustody(custody)
  return (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    const path = url.slice(custody.expected.endpoint.baseUrl.length)
    const streaming = path === '/event' || path === '/global/event'
    const transcript = includeTranscript ? /^\/session\/([A-Za-z0-9_-]{1,256})\/message\?limit=50$/.exec(path) : null
    if (url !== custody.expected.endpoint.baseUrl + path ||
      (!streaming && !transcript) || (init.method && init.method !== 'GET') || init.body) {
      return Promise.reject(new Error('OpenCode supervised event endpoint invalid'))
    }
    const controller = new AbortController()
    let finish!: () => void
    const completion = new Promise<void>(resolve => { finish = resolve })
    custody.retainExchange(() => controller.abort(new Error('OpenCode custody revoked')), completion)
    let resolve!: (response: Response) => void
    let reject!: (error: unknown) => void
    const response = new Promise<Response>((yes, no) => { resolve = yes; reject = no })
    let bodyController!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    let observationCancelled = false
    const cancelObservation = (reason: unknown) => {
      // Preserve the first cause: a subsequent caller cancellation cannot turn
      // custody loss or malformed transport into an ordinary observation end.
      if (!controller.signal.aborted) {
        observationCancelled = streaming
        controller.abort(reason)
      }
    }
    const body = new ReadableStream<Uint8Array>({
      start(stream) { bodyController = stream },
      cancel(reason) { cancelled = true; cancelObservation(reason); return completion },
    })
    const abort = () => cancelObservation(init.signal?.reason)
    init.signal?.addEventListener('abort', abort, { once: true })
    if (init.signal?.aborted) abort()
    const timer = setTimeout(() => cancelObservation(new Error('OpenCode event observation timeout')), 30_000)
    const dispatch = { endAttempted: false, body: Buffer.alloc(0), captured: true }
    let retained: RetainedRequest | null = null
    let exposed = false
    let rejectedResponse = false
    const preparations: Promise<unknown>[] = []
    const unconsumed = new Set<OneUseFence>()
    let finished = false
    void (async () => {
      try {
        const operation: HostedHttpOperation = streaming
          ? { kind: 'events', path: path as '/event' | '/global/event' }
          : { kind: 'transcript', sessionId: transcript![1]!, limit: 50 }
        const operationToken = await custody.prepareOperationToken(operation)
        if (!operationToken) throw new Error('OpenCode event operation unavailable')
        try {
          retained = await custody.rawRetention.retainRequest(custody.rawRetention.bindOperation(operation), {
            method: 'GET', path, bytes: dispatch.body,
          })
          const request = custody.authenticatedRequest(url, { method: 'GET', headers: { accept: streaming ? 'text/event-stream' : 'application/json' } })
          const result = await fetchHostedApprovalOverAuthorizedConnection(url, request, controller.signal,
            connection => {
              const prepared = (async () => {
              const token = await custody.authorizeConnected(connection)
              if (!token) return null
              if (finished || controller.signal.aborted) { token.consume(); return null }
              unconsumed.add(token)
              return () => {
                unconsumed.delete(token)
                const effect = token.consume()
                const operation = operationToken.consume()
                return effect && operation && !controller.signal.aborted
              }
              })()
              preparations.push(prepared)
              return prepared
            }, dispatch, custody, 1024 * 1024, {
              isObservationCancelled: () => observationCancelled && exposed,
              headers(status, headers) {
                if (!streaming) return
                if (status !== 200 || !isOpenCodeEventStreamContentType(headers.get('content-type')) ||
                  (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity')) {
                  // Reject observation exposure, not the parser's already
                  // received packet. Its bounded entity tail still belongs in
                  // terminal evidence, including headers and body in one read.
                  rejectedResponse = true
                  return
                }
                exposed = true
                resolve(new Response(body, { status, headers }))
              },
              data(bytes) { if (exposed && !cancelled) bodyController.enqueue(bytes) },
            })
          await custody.rawRetention.retainResponse(retained, { status: result.status,
            contentEncoding: result.contentEncoding, peerOperationNonce: null,
            bytes: result.bytes, complete: result.complete,
            observationCancelled: observationCancelled && exposed,
            responseHeaders: result.responseHeaders, connectedPeer: result.connectedPeer })
          if (rejectedResponse) throw new Error('OpenCode event response invalid')
          if (observationCancelled && exposed) {
            // The actual incomplete prefix has finished persistence. Ending a
            // read-only subscription is not an ambiguous provider mutation.
            if (!cancelled) bodyController.close()
            return
          }
          if (!result.complete) throw new Error('OpenCode event response incomplete')
          if (!streaming) {
            resolve(new Response(result.bytes, { status: result.status, statusText: result.statusText, headers: result.headers }))
          } else if (!exposed) throw new Error('OpenCode event response unavailable')
          if (!cancelled) bodyController.close()
        } finally { operationToken.consume() }
      } catch (error) {
        await custody.rawRetention.recordFailure(retained, { phase: dispatch.endAttempted ? 'end-attempted' : 'before-end',
          code: 'event_exchange_failed' }).catch(() => undefined)
        reject(error)
        if (!cancelled) bodyController.error(error)
      } finally {
        finished = true
        clearTimeout(timer)
        init.signal?.removeEventListener('abort', abort)
        await Promise.allSettled(preparations)
        for (const token of unconsumed) { try { token.consume() } catch {} }
        unconsumed.clear()
        finish()
      }
    })()
    return response
  }
}
