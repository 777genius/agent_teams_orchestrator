import { checkOpenCodeReadJson } from './OpenCodeBoundedFetch.js'

type ExecutionFetchInput = Parameters<typeof globalThis.fetch>[0]
type ExecutionFetchInit = Parameters<typeof globalThis.fetch>[1]

function executionResponseReader(response: Response) {
  return response.body?.getReader()
}

export class ExecutionTransportFailure extends Error {
  constructor(readonly code: string, readonly disposition: 'not_submitted' | 'unknown') { super(code) }
}
const unsubmitted = new WeakSet<object>()
const missingSessions = new WeakMap<object, string>()
export function executionSessionIsMissing(error: unknown, sessionID: string): boolean {
  if (error === null || typeof error !== 'object') return false
  if (missingSessions.get(error) === sessionID) return true
  const wrapped = error as { name?: unknown; reason?: unknown; cause?: unknown }
  return wrapped.name === 'ClientError' && wrapped.reason === 'Transport' &&
    wrapped.cause !== null && typeof wrapped.cause === 'object' && missingSessions.get(wrapped.cause) === sessionID
}
export function executionWasNotSubmitted(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  if (unsubmitted.has(error)) return true
  // Both exact Promise clients wrap a fetch rejection in ClientError(Transport)
  // with its original cause. Trust only the privately minted cause identity.
  const wrapped = error as { name?: unknown; reason?: unknown; cause?: unknown }
  return wrapped.name === 'ClientError' && wrapped.reason === 'Transport' &&
    wrapped.cause !== null && typeof wrapped.cause === 'object' && unsubmitted.has(wrapped.cause)
}
export function rejectExecutionBeforeInvocation(code: string): never {
  const failure = new ExecutionTransportFailure(code, 'not_submitted')
  unsubmitted.add(failure); throw failure
}
export function executionAssert(value: unknown, code = 'invalid_response'): asserts value {
  if (!value) throw new ExecutionTransportFailure(code, 'not_submitted')
}
export type ExecutionWireContext = { signal?: AbortSignal; deadline: number }

/** Finite execution operations only. SSE is consumed within the same deadline,
 * then handed to the official decoder. This slice exposes no live subscription. */
export class OpenCodeV2ExecutionFetch {
  private closed = false
  private readonly controllers = new Set<AbortController>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly io = new Set<Promise<unknown>>()
  constructor(private readonly endpoint: string, private readonly pin: '2.0.0' | '2.0.21',
    private readonly directory: string, private readonly password: string,
    private readonly context: ExecutionWireContext,
    private readonly fetchImpl: (input: ExecutionFetchInput, init?: ExecutionFetchInit) => Promise<Response> = globalThis.fetch) {
    executionAssert(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(endpoint), 'authority_mismatch')
    executionAssert(pin === '2.0.0' || pin === '2.0.21', 'unqualified_version')
    executionAssert(Number.isFinite(context.deadline), 'deadline')
  }
  check(): void {
    executionAssert(!this.closed, 'disposed')
    executionAssert(!this.context.signal?.aborted && Date.now() < this.context.deadline, 'deadline')
  }
  private track<T>(work: Promise<T>, set = this.io): Promise<T> {
    set.add(work)
    void work.finally(() => set.delete(work)).catch(() => undefined)
    return work
  }
  private async bound<T>(work: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      executionAssert(!signal.aborted && ms > 0, 'deadline')
      return await Promise.race([work, new Promise<never>((_, reject) => {
        abort = () => reject(new Error('deadline'))
        signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(abort, ms)
      })])
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort) }
  }
  fetch: typeof globalThis.fetch = Object.assign((input: ExecutionFetchInput, init?: ExecutionFetchInit) =>
    this.track(this.request(input, init), this.pending),
  { preconnect(): never { throw new ExecutionTransportFailure('capabilities_pending', 'not_submitted') } })

  private async request(input: ExecutionFetchInput, init?: ExecutionFetchInit): Promise<Response> {
    let invoked = false
    let reader: ReturnType<typeof executionResponseReader> = undefined
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    this.controllers.add(controller)
    try {
      this.check()
      let request = new Request(input, init)
      const url = new URL(request.url)
      executionAssert(url.origin === this.endpoint && !url.username && !url.password && !url.hash, 'authority_mismatch')
      const session = /^\/api\/session\/[^/]+$/.test(url.pathname)
      const prompt = /^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)
      const list = /^\/api\/session\/[^/]+\/(?:inbox|message)$/.test(url.pathname)
      const log = /^\/api\/experimental\/session\/[^/]+\/log$/.test(url.pathname)
      const scoped = /^\/api\/(?:location|agent\/[^/]+|model|integration|config)$/.test(url.pathname)
      const activation = this.pin === '2.0.0' && url.pathname === '/api/plugin/await-activation'
      const identity = (this.pin === '2.0.0' ? ['/api/health', '/api/server'] : ['/api/info']).includes(url.pathname)
      const create = url.pathname === '/api/session'
      executionAssert(request.method === 'GET' && (session || list || log || scoped || identity) ||
        request.method === 'POST' && (create || prompt || activation), 'capabilities_pending')
      const allowed = scoped || activation ? ['location[directory]'] : log ? ['after', 'follow'] :
        url.pathname.endsWith('/message') ? ['cursor', 'limit'] : []
      for (const key of url.searchParams.keys()) {
        executionAssert(allowed.includes(key) && url.searchParams.getAll(key).length === 1, 'authority_mismatch')
      }
      if (scoped || activation) executionAssert(url.searchParams.get('location[directory]') === this.directory, 'authority_mismatch')
      if (log) executionAssert(url.searchParams.get('follow') === 'false', 'capabilities_pending')
      if (create || prompt) {
        const validationSignal = AbortSignal.any([controller.signal, request.signal,
          ...(this.context.signal ? [this.context.signal] : [])])
        reader = request.body?.getReader()
        executionAssert(reader, 'invalid_input')
        const pieces: Uint8Array[] = []; let bodyBytes = 0
        for (;;) {
          const part = await this.bound(this.track(reader.read()), validationSignal, this.context.deadline - Date.now())
          if (part.done) break
          const chunk: unknown = part.value
          executionAssert(chunk instanceof Uint8Array, 'invalid_input')
          bodyBytes += chunk.byteLength; executionAssert(bodyBytes <= 1024 * 1024, 'body_limit')
          pieces.push(chunk)
        }
        reader.releaseLock(); reader = undefined
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces))
        checkOpenCodeReadJson(body)
        const parsed: unknown = JSON.parse(body)
        executionAssert(typeof parsed === 'object' && parsed !== null)
        if (create) {
          executionAssert('location' in parsed)
          const location = (parsed as { location: unknown }).location
          executionAssert(typeof location === 'object' && location !== null && 'directory' in location &&
            location.directory === this.directory, 'authority_mismatch')
        } else {
          const fields = parsed as Record<string, unknown>
          executionAssert(Object.keys(fields).every(key => ['id', 'text', 'files', 'agents', 'skills', 'delivery', 'resume'].includes(key)) &&
            typeof fields.id === 'string' && /^msg_[A-Za-z0-9]+$/.test(fields.id) &&
            typeof fields.text === 'string' && fields.text.trim().length > 0 && Buffer.byteLength(fields.text) <= 256 * 1024 &&
            fields.delivery === 'queue' && typeof fields.resume === 'boolean', 'invalid_input')
          for (const key of ['files', 'agents', 'skills']) {
            const values = fields[key]; if (values === undefined) continue
            executionAssert(Array.isArray(values) && values.length <= 256, 'invalid_input')
            for (const value of values) {
              executionAssert(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_input')
              const attachment = value as Record<string, unknown>, required = key === 'files' ? 'uri' : key === 'agents' ? 'name' : 'id'
              const names = key === 'files' ? ['uri', 'name', 'description', 'mention'] : [required, 'mention']
              executionAssert(Object.keys(attachment).every(name => names.includes(name)) &&
                typeof attachment[required] === 'string' && (attachment[required] as string).length > 0 &&
                (attachment[required] as string).length <= 4096, 'invalid_input')
              for (const optional of ['name', 'description']) if (attachment[optional] !== undefined) {
                executionAssert(typeof attachment[optional] === 'string' && (attachment[optional] as string).length <= 4096, 'invalid_input')
              }
              if (attachment.mention !== undefined) {
                const mention = attachment.mention as Record<string, unknown>
                executionAssert(mention !== null && typeof mention === 'object' && !Array.isArray(mention) &&
                  Object.keys(mention).sort().join(',') === 'end,start,text' && Number.isSafeInteger(mention.start) &&
                  Number.isSafeInteger(mention.end) && (mention.start as number) >= 0 &&
                  (mention.end as number) >= (mention.start as number) && (mention.end as number) <= fields.text.length &&
                  typeof mention.text === 'string', 'invalid_input')
              }
            }
          }
        }
        request = new Request(request.url, { method: request.method, headers: request.headers, body, signal: request.signal })
      }
      if (activation) executionAssert(!request.body, 'capabilities_pending')
      this.check(); request.signal.throwIfAborted()
      const signal = AbortSignal.any([controller.signal, request.signal, ...(this.context.signal ? [this.context.signal] : [])])
      timer = setTimeout(() => controller.abort(), Math.min(30_000, this.context.deadline - Date.now()))
      const headers = new Headers(request.headers)
      headers.set('authorization', 'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64'))
      invoked = true
      const responseWork = this.track(this.fetchImpl(request, { headers, signal, redirect: 'error' }).then(async response => {
        if (signal.aborted) { await response.body?.cancel(); throw new Error('deadline') }
        return response
      }))
      const response = await this.bound(responseWork, signal, this.context.deadline - Date.now())
      executionAssert(!response.redirected && (!response.url || new URL(response.url).origin === this.endpoint), 'authority_mismatch')
      reader = executionResponseReader(response)
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (reader) for (;;) {
        const part = await this.bound(this.track(reader.read()), signal, this.context.deadline - Date.now())
        this.check(); signal.throwIfAborted()
        if (part.done) break
        const chunk: unknown = part.value
        executionAssert(chunk instanceof Uint8Array, 'invalid_response')
        bytes += chunk.byteLength
        executionAssert(bytes <= 8 * 1024 * 1024, 'body_limit')
        chunks.push(chunk)
      }
      this.check(); signal.throwIfAborted()
      if (response.status === 204) {
        executionAssert(activation && bytes === 0, 'invalid_response')
        return new Response(null, { status: 204 })
      }
      const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (request.method === 'GET' && session && response.status === 404 && media === 'application/json') {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
        checkOpenCodeReadJson(text)
        const error: unknown = JSON.parse(text)
        const sessionID = decodeURIComponent(url.pathname.slice('/api/session/'.length))
        executionAssert(error !== null && typeof error === 'object' && !Array.isArray(error), 'invalid_response')
        const fields = error as Record<string, unknown>
        executionAssert(Object.keys(fields).sort().join(',') === '_tag,message,sessionID' &&
          fields._tag === 'SessionNotFoundError' && fields.sessionID === sessionID &&
          typeof fields.message === 'string' && Buffer.byteLength(fields.message) <= 4096, 'invalid_response')
        reader?.releaseLock(); reader = undefined
        this.check(); signal.throwIfAborted()
        // Both pinned public protocol errors declare this exact 404 shape.
        // Retain only the identity-bound absence fact, never the native message.
        const failure = new ExecutionTransportFailure('session_missing', 'unknown')
        missingSessions.set(failure, sessionID)
        throw failure
      }
      // No response body/tag from an SDK error escapes this boundary.
      executionAssert(response.status >= 200 && response.status < 300, 'http_failure')
      executionAssert(media === (log ? 'text/event-stream' : 'application/json'), 'media_type')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      if (log) checkExecutionSse(text)
      else { checkOpenCodeReadJson(text); JSON.parse(text) }
      return new Response(text, { status: response.status, headers: response.headers })
    } catch (error) {
      controller.abort()
      if (reader) await this.bound(this.track(reader.cancel()), new AbortController().signal, 1000).catch(() => undefined)
      const code = error instanceof ExecutionTransportFailure ? error.code : 'transport_failure'
      const failure = new ExecutionTransportFailure(code, invoked ? 'unknown' : 'not_submitted')
      if (error !== null && typeof error === 'object') {
        const sessionID = missingSessions.get(error)
        if (sessionID !== undefined) missingSessions.set(failure, sessionID)
      }
      if (!invoked) unsubmitted.add(failure)
      throw failure
    } finally {
      clearTimeout(timer); this.controllers.delete(controller)
      reader?.releaseLock()
    }
  }
  async dispose(): Promise<void> {
    this.closed = true
    for (const controller of this.controllers) controller.abort()
    const work = Promise.allSettled([...this.pending, ...this.io])
    try { await this.bound(work, new AbortController().signal, 2000) }
    catch { throw new ExecutionTransportFailure('cleanup_unknown', 'unknown') }
    executionAssert(this.pending.size === 0 && this.io.size === 0, 'cleanup_unknown')
  }
}

function checkExecutionSse(text: string): void {
  const frames = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n')
  executionAssert(frames.length <= 4097, 'frame_limit')
  executionAssert(frames.at(-1) === '', 'incomplete_stream')
  for (const frame of frames) {
    executionAssert(Buffer.byteLength(frame) <= 256 * 1024, 'frame_limit')
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (data) { checkOpenCodeReadJson(data); JSON.parse(data) }
  }
}
