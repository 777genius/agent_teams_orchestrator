import { createHash, randomBytes } from 'node:crypto'

export type HostedHttpOperation =
  | { kind: 'capability' }
  | { kind: 'provider'; name: SupervisedProviderOperationName; method: 'GET' | 'POST'; path: string }
  | { kind: 'events'; path: '/event' | '/global/event' }
  | { kind: 'transcript'; sessionId: string; limit: 50 }
  | { kind: 'observe'; sessionId: string }
  | {
      kind: 'reply'; sessionId: string; requestId: string
      runtimeInstanceId: string; configGeneration: string
      sessionIncarnation: string; requestIncarnation: string
      permissionDigest: string; decision: 'allow_once' | 'reject'
    }

export type SupervisedProviderOperationName =
  | 'health' | 'config' | 'config-providers' | 'providers' | 'provider-auth-methods' | 'server-doc'
  | 'agents' | 'mcp-read' | 'mcp-add' | 'mcp-connect' | 'session-create' | 'session-read'
  | 'session-status' | 'messages-read' | 'message-read' | 'message-send' | 'prompt-async'
  | 'session-abort' | 'tool-ids' | 'tools'

export type RetainedBody = Readonly<{
  byteLength: number; sha256: string; bodyBase64: string
}>
declare const operationBrand: unique symbol
export type TrustedHttpOperationBinding = Readonly<{
  [operationBrand]: true
  ownerExchangeNonce: string
  operation: HostedHttpOperation
}>
declare const requestBrand: unique symbol
export type RetainedRequest = Readonly<{
  [requestBrand]: true
  ownerExchangeNonce: string
  recordId: string
  body: RetainedBody
}>
export type RawHttpPeer = Readonly<{ localAddress: string; localPort: number; remoteAddress: string; remotePort: number }>
export type RawHttpResponse = {
  /** Local bounded SSE observation ended; never implies HTTP framing completion. */
  observationCancelled?: boolean
  responseHeaders?: readonly (readonly [string, string])[]
  connectedPeer?: RawHttpPeer
  status: number; contentEncoding: string | null
  // Legacy input is never nonce authority; derive status from original header occurrences.
  peerOperationNonce: null
  bytes: Uint8Array; complete: boolean
}
export type RawHttpFailure = {
  phase: 'before-end' | 'end-attempted' | 'response-incomplete'; code: string
}
export interface OpenCodeRawRetentionPort {
  bindOperation(operation: HostedHttpOperation): TrustedHttpOperationBinding
  isCurrent(): boolean
  retainRequest(binding: TrustedHttpOperationBinding, request: {
    method: 'GET' | 'POST'; path: string; bytes: Uint8Array
  }): Promise<RetainedRequest>
  retainResponse(request: RetainedRequest, response: RawHttpResponse): Promise<RetainedBody>
  recordFailure(request: RetainedRequest | null, failure: RawHttpFailure): Promise<void>
  poison(code: string): void
  close(): Promise<void>
}

/** Internal observations, NOT a second RawRecord schema or a producer envelope. */
export type OpenCodeRawObservation =
  | { phase: 'request'; binding: TrustedHttpOperationBinding; method: string; path: string; body: RetainedBody }
  | { phase: 'response'; request: RetainedRequest; status: number; contentEncoding: string | null
      peerOperationNonce: string | null; nonceStatus: 'present' | 'missing' | 'invalid';
      responseHeaders: readonly (readonly [string, string])[]; connectedPeer?: RawHttpPeer;
      correlation: 'unavailable'; body: RetainedBody; complete: boolean }
  | { phase: 'failure'; request: RetainedRequest | null; failure: RawHttpFailure }

/** W1-B supplies the admitted recorder/descriptor and canonical RawRecord adapter.
 * There is deliberately no path, fd number, environment lookup or default sink.
 * encode must use its independently admitted Owner recorder/peer/activation context.
 */
export interface OpenCodeRawRetentionSink {
  /** Verified inherited bytes already occupying this capture, before appends. */
  readonly initialByteLength?: number
  encode(observation: OpenCodeRawObservation): { bytes: Uint8Array; recordId: string }
  isCurrent(): boolean
  write(bytes: Uint8Array, offset: number, length: number): Promise<number>
  sync(): Promise<void>
  close(): Promise<void>
}
const MAX_BODY = 1024 * 1024
const MAX_RECORD = 4 * 1024 * 1024
const MAX_CAPTURE = 64 * 1024 * 1024
const ports = new WeakSet<object>()
export function assertOpenCodeRawRetentionPort(port: OpenCodeRawRetentionPort): void {
  if (!port || !ports.has(port)) throw new Error('OpenCode admitted raw retention unavailable')
}

/** Bounded serial append/fsync implementation; descriptor alias/currentness is the
 * injected admitted sink's responsibility. Failure permanently revokes dispatch.
 */
export function createOpenCodeRawRetention(sink: OpenCodeRawRetentionSink): OpenCodeRawRetentionPort {
  // Retain the admitted operations, never methods subsequently installed on sink.
  const encode = sink.encode.bind(sink)
  const sinkCurrent = sink.isCurrent.bind(sink)
  const write = sink.write.bind(sink)
  const sync = sink.sync.bind(sink)
  const closeSink = sink.close.bind(sink)
  let poisoned = false
  let storageFailed = false
  let sealed = false
  let closed = false
  let total = sink.initialByteLength ?? 0
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_CAPTURE) {
    throw new Error('OpenCode raw prefix byte length invalid')
  }
  let queued = 0
  let tail: Promise<unknown> = Promise.resolve()
  let closing: Promise<void> | undefined
  const bindings = new WeakSet<object>()
  const requests = new WeakMap<object, boolean>()
  const eventRequests = new WeakSet<object>()
  const storageCurrent = () => {
    if (storageFailed || closed) return false
    try {
      if (!sinkCurrent()) storageFailed = true
    } catch { storageFailed = true }
    if (storageFailed) poisoned = true
    return !storageFailed
  }
  const current = () => !sealed && !poisoned && storageCurrent()
  const requireCurrent = () => {
    if (!current()) { poisoned = true; throw new Error('OpenCode raw retention unavailable') }
  }
  const body = (bytes: Uint8Array): RetainedBody => {
    if (bytes.byteLength > MAX_BODY) { poisoned = true; throw new Error('OpenCode raw body limit') }
    return Object.freeze({ byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bodyBase64: Buffer.from(bytes).toString('base64') })
  }
  const append = (observation: OpenCodeRawObservation): Promise<string> => {
    // Terminal evidence cannot grant dispatch authority. It may still be written
    // after revocation, provided the original storage capability is current.
    if (sealed) throw new Error('OpenCode raw retention sealed')
    const requireStorage = () => {
      if (!storageCurrent()) throw new Error('OpenCode raw retention unavailable')
    }
    const requireAppend = () => {
      requireStorage()
      // Admission was checked synchronously; admitted bytes survive dispatch loss.
    }
    requireAppend()
    if (queued >= 16) { poisoned = true; throw new Error('OpenCode raw queue limit') }
    queued += 1
    const pending = tail.then(async () => {
      requireAppend()
      const encoded = encode(observation)
      const bytes = Buffer.from(encoded.bytes)
      const recordId = encoded.recordId
      if (!/^[0-9a-f]{64}$/.test(recordId) || bytes.length < 1 ||
        bytes.length > MAX_RECORD || total + bytes.length > MAX_CAPTURE) {
        throw new Error('OpenCode raw record limit or identity')
      }
      total += bytes.length
      let offset = 0
      while (offset < bytes.length) {
        // Finish an append already begun even if dispatch is revoked midway;
        // cancellation must not tear a line and prevent later terminal evidence.
        requireStorage()
        const written = await write(bytes, offset, bytes.length - offset)
        if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) {
          throw new Error('OpenCode raw append made invalid progress')
        }
        offset += written
      }
      await sync()
      requireAppend()
      return recordId
    }).catch(error => {
      poisoned = true
      storageFailed = true
      throw new Error('OpenCode raw append failed')
    }).finally(() => { queued -= 1 })
    tail = pending.catch(() => undefined)
    return pending
  }
  const port: OpenCodeRawRetentionPort = {
    isCurrent: current,
    bindOperation(operation) {
      requireCurrent()
      if (Buffer.byteLength(JSON.stringify(operation), 'utf8') > 16 * 1024) {
        poisoned = true
        throw new Error('OpenCode raw operation metadata limit')
      }
      const binding = Object.freeze({ ownerExchangeNonce: randomBytes(32).toString('hex'),
        operation: Object.freeze({ ...operation }) }) as TrustedHttpOperationBinding
      bindings.add(binding)
      return binding
    },
    async retainRequest(binding, request) {
      requireCurrent()
      if (!bindings.delete(binding) || request.path.length > 16 * 1024) {
        poisoned = true
        throw new Error('OpenCode raw operation substituted, reused or oversized')
      }
      // Copy synchronously before the first await, including empty GET bodies.
      const retained = body(Buffer.from(request.bytes))
      const recordId = await append({ phase: 'request', binding,
        method: request.method, path: request.path, body: retained })
      const result = Object.freeze({ ownerExchangeNonce: binding.ownerExchangeNonce,
        recordId, body: retained }) as RetainedRequest
      requests.set(result, false)
      if (binding.operation.kind === 'events' && request.method === 'GET' &&
        request.path === binding.operation.path) eventRequests.add(result)
      return result
    },
    async retainResponse(request, response) {
      if (requests.get(request) !== false) {
        poisoned = true
        throw new Error('OpenCode raw request substituted or completed')
      }
      requests.set(request, true)
      const boundedEventEnd = response.observationCancelled === true && eventRequests.has(request)
      if ((!response.complete && !boundedEventEnd) || (response.contentEncoding !== null && response.contentEncoding !== 'identity')) {
        poisoned = true
      }
      const retained = body(Buffer.from(response.bytes))
      const headers = Object.freeze((response.responseHeaders ?? []).map(([name, value]) => Object.freeze([name, value] as const)))
      const nonces = headers.filter(([name]) => name.toLowerCase() === 'x-agent-teams-hosted-operation-nonce')
      const present = nonces.length === 1 && /^[0-9a-f]{64}$/.test(nonces[0]![1])
      const nonceStatus = present ? 'present' : nonces.length === 0 ? 'missing' : 'invalid'
      const connectedPeer = response.connectedPeer && Object.freeze({ ...response.connectedPeer })
      await append({ phase: 'response', request, status: response.status,
        contentEncoding: response.contentEncoding, peerOperationNonce: present ? nonces[0]![1] : null,
        nonceStatus, responseHeaders: headers, connectedPeer,
        correlation: 'unavailable', body: retained, complete: response.complete })
      return retained
    },
    async recordFailure(request, failure) {
      poisoned = true
      if (request && !requests.has(request)) throw new Error('OpenCode raw request substituted')
      await append({ phase: 'failure', request, failure: { ...failure } })
    },
    poison() { poisoned = true },
    close() {
      sealed = true
      poisoned = true
      return closing ??= tail.then(async () => {
        try { await closeSink() } finally { closed = true }
      })
    },
  }
  ports.add(port)
  return Object.freeze(port)
}
