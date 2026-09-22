import { createHash, randomBytes } from 'node:crypto'

export type HostedHttpOperation =
  | { kind: 'capability' }
  | { kind: 'observe'; sessionId: string }
  | {
      kind: 'reply'; sessionId: string; requestId: string
      runtimeInstanceId: string; configGeneration: string
      sessionIncarnation: string; requestIncarnation: string
      permissionDigest: string; decision: 'allow_once' | 'reject'
    }

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
export type RawHttpResponse = {
  status: number; contentEncoding: string | null
  // O1/P1 has not admitted a response nonce header. Never infer a native join.
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
      peerOperationNonce: null; correlation: 'unavailable'; body: RetainedBody; complete: boolean }
  | { phase: 'failure'; request: RetainedRequest | null; failure: RawHttpFailure }

/** W1-B supplies the admitted recorder/descriptor and canonical RawRecord adapter.
 * There is deliberately no path, fd number, environment lookup or default sink.
 * encode must use its independently admitted Owner recorder/peer/activation context.
 */
export interface OpenCodeRawRetentionSink {
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
  let closed = false
  let total = 0
  let queued = 0
  let tail: Promise<unknown> = Promise.resolve()
  let closing: Promise<void> | undefined
  const bindings = new WeakSet<object>()
  const requests = new WeakMap<object, boolean>()
  const storageCurrent = () => {
    if (storageFailed || closed) return false
    try {
      if (!sinkCurrent()) storageFailed = true
    } catch { storageFailed = true }
    if (storageFailed) poisoned = true
    return !storageFailed
  }
  const current = () => !poisoned && storageCurrent()
  const requireCurrent = () => {
    if (!current()) { poisoned = true; throw new Error('OpenCode raw retention unavailable') }
  }
  const body = (bytes: Uint8Array): RetainedBody => {
    if (bytes.byteLength > MAX_BODY) { poisoned = true; throw new Error('OpenCode raw body limit') }
    return Object.freeze({ byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bodyBase64: Buffer.from(bytes).toString('base64') })
  }
  const append = (observation: OpenCodeRawObservation, terminal = false): Promise<string> => {
    // Terminal evidence cannot grant dispatch authority. It may still be written
    // after revocation, provided the original storage capability is current.
    const revokedAppend = new Error('OpenCode raw dispatch revoked')
    const requireStorage = () => {
      if (!storageCurrent()) throw new Error('OpenCode raw retention unavailable')
    }
    const requireAppend = () => {
      requireStorage()
      if (!terminal && poisoned) throw revokedAppend
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
      if (error !== revokedAppend) storageFailed = true
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
      return result
    },
    async retainResponse(request, response) {
      if (requests.get(request) !== false) {
        poisoned = true
        throw new Error('OpenCode raw request substituted or completed')
      }
      requests.set(request, true)
      if (!response.complete || (response.contentEncoding !== null && response.contentEncoding !== 'identity')) {
        poisoned = true
      }
      const retained = body(Buffer.from(response.bytes))
      await append({ phase: 'response', request, status: response.status,
        contentEncoding: response.contentEncoding, peerOperationNonce: null,
        correlation: 'unavailable', body: retained, complete: response.complete }, true)
      return retained
    },
    async recordFailure(request, failure) {
      poisoned = true
      if (request && !requests.has(request)) throw new Error('OpenCode raw request substituted')
      await append({ phase: 'failure', request, failure: { ...failure } }, true)
    },
    poison() { poisoned = true },
    close() {
      closed = true
      return closing ??= tail.then(() => closeSink())
    },
  }
  ports.add(port)
  return Object.freeze(port)
}
