import type { OpenCodeClientRequestContext } from '../OpenCodeClientRequestContext.js'
import type { OpenCodeV2Pin } from '../compatibility/OpenCodeGenerationPolicy.js'

type OpenCodeFetchInput = Parameters<typeof globalThis.fetch>[0]
type OpenCodeFetchInit = Parameters<typeof globalThis.fetch>[1]

function openCodeResponseReader(response: Response) {
  return response.body?.getReader()
}

export function openCodeReadAssert(value: unknown, code = 'invalid_response'): asserts value {
  if (!value) throw new Error(code)
}

export async function boundOpenCodeRead<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    signal?.throwIfAborted()
    openCodeReadAssert(Number.isFinite(ms) && ms > 0, 'timeout')
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms)
      abort = () => reject(new Error('cancelled'))
      signal?.addEventListener('abort', abort, { once: true })
    })])
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
}

/** Lexical complexity budget before the official Promise client's genuine JSON parser. */
export function checkOpenCodeReadJson(text: string): void {
  let depth = 0, tokens = 0, quoted = false, escaped = false, atom = false
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') { quoted = true; atom = false; tokens++ }
    else if (char === '{' || char === '[') { depth++; tokens++; atom = false }
    else if (char === '}' || char === ']') { depth--; atom = false }
    else if (char === ',' || char === ':' || /\s/.test(char)) atom = false
    else if (!atom) { tokens++; atom = true }
    openCodeReadAssert(depth <= 32 && tokens <= 200_000)
  }
}

/** Finite read slice: no SSE, retries, session routes or general mutations. */
export class OpenCodeBoundedFetch {
  private readonly controllers = new Set<AbortController>()
  private readonly pending = new Set<Promise<Response>>()
  private readonly io = new Set<Promise<unknown>>()
  private disposed = false
  private consumed = 0
  readonly deadline: number
  constructor(
    private readonly baseUrl: string,
    private readonly pin: OpenCodeV2Pin,
    private readonly directory: string,
    private readonly authorization: string,
    private readonly context: OpenCodeClientRequestContext = {},
    private readonly fetchImpl: (input: OpenCodeFetchInput, init?: OpenCodeFetchInit) => Promise<Response> = globalThis.fetch,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {
    openCodeReadAssert(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(baseUrl), 'identity_mismatch')
    openCodeReadAssert(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 8 * 1024 * 1024)
    const remaining = context.remainingMs?.() ?? 60_000
    openCodeReadAssert(Number.isFinite(remaining) && remaining > 0, 'timeout')
    this.deadline = Date.now() + Math.min(60_000, remaining)
  }
  check(): void {
    this.context.signal?.throwIfAborted()
    openCodeReadAssert(!this.disposed && Date.now() < this.deadline &&
      (this.context.remainingMs?.() ?? 1) > 0, 'timeout')
  }
  fetch: typeof globalThis.fetch = Object.assign((input: OpenCodeFetchInput, init?: OpenCodeFetchInit) => {
    const work = this.read(input, init)
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work)).catch(() => undefined)
    return work
  }, { preconnect(): never { throw new Error('capabilities_pending') } })
  private track<T>(work: Promise<T>): Promise<T> {
    this.io.add(work)
    void work.finally(() => this.io.delete(work)).catch(() => undefined)
    return work
  }
  private async read(input: OpenCodeFetchInput, init?: OpenCodeFetchInit): Promise<Response> {
    this.check()
    const request = new Request(input, init), url = new URL(request.url)
    openCodeReadAssert(url.origin === this.baseUrl && !url.username && !url.password && !url.hash, 'identity_mismatch')
    const scoped = /^\/api\/(?:location|model(?:\/default)?|provider(?:\/[^/]+)?|agent(?:\/[^/]+)?|config|integration)$/.test(url.pathname)
    const identity = this.pin === '2.0.0' ? ['/api/health', '/api/server'] : ['/api/info']
    const activation = this.pin === '2.0.0' && request.method === 'POST' && url.pathname === '/api/plugin/await-activation'
    openCodeReadAssert(activation || request.method === 'GET' && (scoped || identity.includes(url.pathname)), 'capabilities_pending')
    for (const key of url.searchParams.keys()) openCodeReadAssert(key === 'location[directory]', 'identity_mismatch')
    if (scoped || activation) openCodeReadAssert(url.searchParams.get('location[directory]') === this.directory, 'identity_mismatch')
    else openCodeReadAssert(!url.search, 'identity_mismatch')
    // The only allowed POST is an official floor activation barrier with no payload.
    if (activation) openCodeReadAssert(!request.body, 'capabilities_pending')
    const controller = new AbortController()
    this.controllers.add(controller)
    const signal = AbortSignal.any([request.signal, controller.signal,
      ...(this.context.signal ? [this.context.signal] : [])])
    const initialization = activation || url.pathname === '/api/location' || url.pathname === '/api/integration'
    const timer = setTimeout(() => controller.abort(), Math.min(initialization ? 30_000 : 15_000, this.deadline - Date.now()))
    let reader: ReturnType<typeof openCodeResponseReader> = undefined
    try {
      const headers = new Headers(request.headers)
      headers.set('authorization', this.authorization)
      const responseWork = this.track(this.fetchImpl(request, { headers, signal, redirect: 'error' }).then(async response => {
        if (signal.aborted) { await response.body?.cancel(); throw new Error('timeout') }
        return response
      }))
      const response = await boundOpenCodeRead(responseWork, this.deadline - Date.now(), signal)
      reader = openCodeResponseReader(response)
      openCodeReadAssert(!response.redirected && (!response.url || new URL(response.url).origin === this.baseUrl), 'identity_mismatch')
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (reader) for (;;) {
        signal.throwIfAborted(); this.check()
        const part = await boundOpenCodeRead(this.track(reader.read()), this.deadline - Date.now(), signal)
        signal.throwIfAborted(); this.check()
        if (part.done) break
        const chunk: unknown = part.value
        openCodeReadAssert(chunk instanceof Uint8Array)
        bytes += chunk.byteLength; this.consumed += chunk.byteLength
        openCodeReadAssert(bytes <= this.maxBytes && this.consumed <= 64 * 1024 * 1024)
        if (response.status === 204) openCodeReadAssert(chunk.byteLength === 0)
        chunks.push(chunk)
      }
      this.check(); signal.throwIfAborted()
      if (response.status === 204) {
        openCodeReadAssert(activation)
        return new Response(null, { status: 204, headers: response.headers })
      }
      openCodeReadAssert(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      checkOpenCodeReadJson(text)
      return new Response(text, { status: response.status, headers: response.headers })
    } catch {
      controller.abort()
      if (reader) await boundOpenCodeRead(this.track(reader.cancel()), 1000).catch(() => undefined)
      throw new Error(signal.aborted || Date.now() >= this.deadline ? 'timeout' : 'invalid_response')
    } finally {
      clearTimeout(timer); this.controllers.delete(controller)
      reader?.releaseLock()
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const controller of this.controllers) controller.abort()
    await boundOpenCodeRead(Promise.allSettled([...this.pending, ...this.io]), 2000)
    openCodeReadAssert(this.pending.size === 0 && this.io.size === 0, 'cleanup_unknown')
  }
}
