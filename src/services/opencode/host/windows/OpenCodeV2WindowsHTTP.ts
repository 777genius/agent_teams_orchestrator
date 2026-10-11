import { randomUUID } from 'node:crypto'
import { windowsExecutionChildControl, windowsExecutionSelfBirth } from './OpenCodeV2WindowsChildControl.js'

const WINDOW = 32768, CHUNK = 3072, MAX_ACTIVE = 16
const UUID = /^[a-f0-9-]{36}$/
type Frame = Record<string, unknown>
type Send = (frame: Frame) => Promise<void>
function assert(value: unknown): asserts value { if (!value) throw new Error('execution_http_transport_unknown') }
function row(value: unknown): Frame { assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Frame }
function origin(value: string): string {
  const url = new URL(value)
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) > 0 && Number(url.port) <= 65535 &&
    !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash)
  return url.origin
}
function headers(value: unknown): [string, string][] {
  assert(Array.isArray(value) && value.length <= 256)
  let size = 0
  const result = value.map(item => {
    assert(Array.isArray(item) && item.length === 2 && typeof item[0] === 'string' && typeof item[1] === 'string')
    size += Buffer.byteLength(item[0]) + Buffer.byteLength(item[1]); assert(size <= 32768)
    return [item[0], item[1]] as [string, string]
  })
  // Native web constructors reject invalid field names and CR/LF values.
  new Headers(result); return result
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

/** One bounded byte direction. Credits are returned only on consumer pulls;
 * no UTF-8 decoding, internal stream prefetch, or unbounded SSE buffering. */
class Direction {
  private queue: Uint8Array[] = []
  private queued = 0
  private received = 0
  private ended = false
  private failure: unknown
  private changed = deferred<void>()
  private credit = WINDOW
  private available = deferred<void>()
  private reader?: ReadableStreamDefaultReader<Uint8Array>
  private streamController?: ReadableStreamDefaultController<Uint8Array>
  private cancellation: Promise<void> = Promise.resolve()
  private senderStopped = false
  private consumed = false
  constructor(private send: Send, private name: 'request' | 'response', private limit: number,
    private abort: AbortSignal, private onFinish: () => void | Promise<void>) {
    abort.addEventListener('abort', () => this.fail(abort.reason), { once: true })
  }
  private wake() { this.changed.resolve(); this.changed = deferred<void>() }
  fail(error: unknown) {
    if (this.failure) return
    this.failure = error ?? new Error('execution_http_cancelled'); this.queue = []; this.queued = 0
    // Error the Web stream itself, including bytes already queued by a native
    // Response reader. Normal consumed EOF is settled by onFinish instead.
    if (!this.consumed) this.streamController?.error(this.failure)
    this.wake(); this.available.resolve()
    this.cancellation = this.reader?.cancel(this.failure).then(() => undefined, () => undefined) ?? Promise.resolve()
  }
  stopped(): Promise<void> { return this.cancellation }
  pumpWasStopped(): boolean { return this.senderStopped }
  async stopPump() {
    this.senderStopped = true; this.available.resolve()
    await this.reader?.cancel(new Error('execution_http_upload_closed'))
  }
  private assertSender() { this.abort.throwIfAborted(); assert(!this.senderStopped) }
  hasEnded(): boolean { return this.ended }
  accept(frame: Frame) {
    assert(frame.direction === this.name)
    if (frame.action === 'credit') {
      assert(Number.isSafeInteger(frame.bytes) && Number(frame.bytes) > 0 && Number(frame.bytes) <= WINDOW && this.credit + Number(frame.bytes) <= WINDOW)
      this.credit += Number(frame.bytes); this.available.resolve(); this.available = deferred<void>(); return
    }
    assert(!this.ended && !this.failure)
    if (frame.action === 'end') { this.ended = true; this.wake(); return }
    assert(frame.action === 'data' && typeof frame.bytes === 'string' && frame.bytes.length <= CHUNK / 3 * 4)
    const bytes = Buffer.from(frame.bytes, 'base64')
    assert(bytes.length > 0 && bytes.length <= CHUNK && bytes.toString('base64') === frame.bytes)
    this.received += bytes.length; this.queued += bytes.length
    assert(this.received <= this.limit && this.queued <= WINDOW)
    this.queue.push(bytes); this.wake()
  }
  stream(cancel: (reason: unknown) => void | Promise<void>): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: controller => { this.streamController = controller; if (this.failure) controller.error(this.failure) },
      pull: async controller => {
        try {
          while (!this.queue.length && !this.ended && !this.failure) await this.changed.promise
          if (this.failure) throw this.failure
          const bytes = this.queue.shift()
          if (bytes) {
            this.queued -= bytes.length
            await this.send({ action: 'credit', direction: this.name, bytes: bytes.length })
            // A peer failure can occur while the credit acknowledgement waits.
            if (this.failure) throw this.failure
            this.abort.throwIfAborted()
            controller.enqueue(bytes)
          } else { await this.finish(); controller.close() }
        } catch (error) { controller.error(error); await cancel(error) }
      },
      cancel: reason => cancel(reason),
    }, { highWaterMark: 0 })
  }
  private async finish() { if (!this.consumed) { this.consumed = true; await this.onFinish() } }
  async pump(body: ReadableStream<Uint8Array> | null): Promise<void> {
    let sent = 0
    this.reader = body?.getReader()
    try {
      if (this.reader) for (;;) {
        this.assertSender()
        // Wait before reading, so backpressure also bounds the source reader.
        while (this.credit === 0) { await this.available.promise; this.assertSender() }
        const part = await this.reader.read(); this.assertSender()
        if (part.done) break
        assert(part.value instanceof Uint8Array)
        assert(part.value.length <= this.limit && sent + part.value.length <= this.limit)
        for (let offset = 0; offset < part.value.length;) {
          while (this.credit === 0) { await this.available.promise; this.assertSender() }
          const bytes = part.value.subarray(offset, offset + Math.min(CHUNK, this.credit))
          offset += bytes.length; sent += bytes.length; assert(sent <= this.limit)
          this.credit -= bytes.length
          await this.send({ action: 'data', direction: this.name, bytes: Buffer.from(bytes).toString('base64') })
        }
      }
      await this.send({ action: 'end', direction: this.name })
    } finally { this.reader?.releaseLock(); this.reader = undefined }
  }
}

type ParentTransaction = {
  controller: AbortController; request: Direction; response: Direction
  head: ReturnType<typeof deferred<Frame>>; done: ReturnType<typeof deferred<void>>
  headReceived: boolean
  cancel(): Promise<void>; dispose(): Promise<void>
}
export function createWindowsExecutionHttpClient(sendFrame: Send, failTransport: (error: Error) => void) {
  const active = new Map<string, ParentTransaction>(), finished = new Set<string>()
  let selectedOrigin: string | undefined, closing = false, broken = false
  function forget(id: string) { active.delete(id); finished.add(id); if (finished.size > 4096) finished.delete(finished.values().next().value!) }
  function disconnect(error: unknown) {
    closing = true
    const safe = error instanceof Error ? error : new Error('execution_http_transport_unknown')
    for (const transaction of active.values()) { transaction.controller.abort(safe); transaction.head.reject(safe); transaction.done.reject(safe) }
    return safe
  }
  function fatal(error: unknown) {
    const safe = disconnect(error)
    if (!broken) { broken = true; failTransport(safe) }
  }
  return Object.freeze({
    bindOrigin(value: string) { assert(!selectedOrigin && !closing); selectedOrigin = origin(value) },
    accept(value: unknown): boolean {
      const frame = row(value); if (frame.type !== 'windowsHTTP') return false
      try {
        assert(typeof frame.id === 'string' && UUID.test(frame.id))
        const transaction = active.get(frame.id)
        if (!transaction) { assert(finished.has(frame.id) && ['credit', 'done', 'cancelled', 'error'].includes(String(frame.action))); return true }
        if (frame.action === 'head') {
          assert(!transaction.headReceived && Number.isInteger(frame.status) && Number(frame.status) >= 200 && Number(frame.status) <= 599 && typeof frame.statusText === 'string' && frame.statusText.length <= 1024 && typeof frame.body === 'boolean')
          transaction.headReceived = true
          headers(frame.headers); transaction.head.resolve(frame)
        } else if (frame.action === 'done' || frame.action === 'cancelled') {
          assert(frame.action === 'cancelled' ? transaction.controller.signal.aborted : transaction.headReceived && transaction.response.hasEnded())
          transaction.done.resolve()
          void transaction.request.stopPump().catch(fatal)
          if (frame.action === 'cancelled') void transaction.dispose().catch(fatal)
        } else if (frame.action === 'error') {
          transaction.controller.abort(new Error('execution_http_request_failed')); transaction.head.reject(new Error('execution_http_request_failed')); transaction.done.resolve(); void transaction.dispose().catch(fatal)
        } else if (!transaction.controller.signal.aborted) {
          assert(frame.action === 'credit' ? frame.direction === 'request' : frame.direction === 'response')
          ;(frame.direction === 'request' ? transaction.request : transaction.response).accept(frame)
        }
        return true
      } catch (error) { fatal(error); return true }
    },
    async fetch(input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> {
      assert(selectedOrigin && !closing && !broken && active.size < MAX_ACTIVE)
      const request = input instanceof Request && init === undefined ? input : new Request(input, init)
      const url = new URL(request.url)
      assert(url.origin === selectedOrigin && !url.username && !url.password && !url.hash && Buffer.byteLength(url.pathname + url.search) <= 8192)
      request.signal.throwIfAborted()
      const id = randomUUID(), controller = new AbortController(), head = deferred<Frame>(), done = deferred<void>()
      const uploaded = deferred<void>()
      let uploadStarted = false
      const send: Send = frame => sendFrame({ ...frame, type: 'windowsHTTP', id })
      let cancellation: Promise<void> | undefined
      const cancel = () => cancellation ??= (async () => {
        controller.abort(new DOMException('Request aborted', 'AbortError')); head.reject(controller.signal.reason)
        await send({ action: 'cancel' })
        let timer: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([done.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('execution_http_cleanup_unknown')), 10000) })]); await dispose() }
        finally { clearTimeout(timer) }
      })().catch(error => { fatal(error); throw error })
      const onAbort = () => { void cancel().catch(() => undefined) }
      const dispose = async () => {
        await done.promise
        controller.abort(new Error('execution_http_transaction_closed')); await uploaded.promise
        request.signal.removeEventListener('abort', onAbort); forget(id)
      }
      const response = new Direction(send, 'response', 64 * 1024 * 1024, controller.signal, dispose)
      const upload = new Direction(send, 'request', 8 * 1024 * 1024, controller.signal, () => {})
      active.set(id, { controller, request: upload, response, head, done, headReceived: false, cancel, dispose })
      request.signal.addEventListener('abort', onAbort, { once: true })
      try {
        await send({ action: 'request', method: request.method, path: url.pathname + url.search, headers: headers([...request.headers]), body: request.body !== null })
        uploadStarted = true
        void upload.pump(request.body).catch(error => { if (!controller.signal.aborted && !upload.pumpWasStopped()) { controller.abort(error); head.reject(error); void cancel().catch(() => undefined) } }).finally(() => uploaded.resolve())
        if (request.signal.aborted) onAbort()
        const value = await head.promise; controller.signal.throwIfAborted()
        const body = value.body === true ? response.stream(() => cancel()) : null
        if (!body) await dispose()
        return new Response(body, { status: Number(value.status), statusText: String(value.statusText), headers: headers(value.headers) })
      } catch (error) { if (!uploadStarted) uploaded.resolve(); await cancel().catch(() => undefined); throw error }
    },
    async close() { closing = true; await Promise.all([...active.values()].map(value => value.cancel())) },
    fail: disconnect,
  })
}

/** Child-local HTTP only; no host-loopback exemption or global fetch override.
 * Prepared native PID/FILETIME pipe identity is required before construction. */
export function bindWindowsExecutionHttp(baseUrl: string, signal?: AbortSignal): Readonly<{ close(): Promise<void> }> {
  assert(windowsExecutionSelfBirth().format === 'windows-filetime')
  const selectedOrigin = origin(baseUrl), control = windowsExecutionChildControl()
  assert(control.connected())
  const nonce = process.env.OPENCODE_V2_WINDOWS_NONCE!, leaseOwnerId = process.env.OPENCODE_V2_WINDOWS_LEASE!
  const active = new Map<string, { controller: AbortController; request: Direction; response: Direction; task: Promise<void> }>()
  const finished = new Map<string, number>()
  let closing = false, closure: Promise<void> | undefined
  function failed() { control.disconnect() }
  function accept(value: unknown) {
    try {
      const frame = row(value); if (frame.type !== 'windowsHTTP') return
      assert(frame.nonce === nonce && frame.leaseOwnerId === leaseOwnerId && typeof frame.id === 'string' && UUID.test(frame.id))
      const id = frame.id, send: Send = message => control.send({ ...message, type: 'windowsHTTP', id, nonce, leaseOwnerId }, Date.now() + 15000)
      if (frame.action === 'request') {
        assert(!closing && !active.has(id) && !finished.has(id) && active.size < MAX_ACTIVE && typeof frame.method === 'string' && /^[A-Z]{1,32}$/.test(frame.method) && typeof frame.path === 'string' && Buffer.byteLength(frame.path) <= 8192 && frame.path.startsWith('/') && !frame.path.startsWith('//') && typeof frame.body === 'boolean')
        const target = new URL(frame.path, selectedOrigin); assert(target.origin === selectedOrigin && !target.hash && !target.username && !target.password)
        const requestHeaders = headers(frame.headers), controller = new AbortController()
        const request = new Direction(send, 'request', 8 * 1024 * 1024, controller.signal, () => {})
        const response = new Direction(send, 'response', 64 * 1024 * 1024, controller.signal, () => {})
        const body = frame.body ? request.stream(reason => controller.abort(reason)) : null
        // Schedule after registration so immediate cancellation cannot lose it.
        const task = Promise.resolve().then(async () => {
          let result: Response | undefined
          try {
            // Bun 1.3.11 can reuse an unfinished streamed upload after an
            // early response. Keep these requests out of its shared pool.
            result = await fetch(target, { method: String(frame.method), headers: requestHeaders, body, signal: controller.signal, redirect: 'manual', ...(body ? { duplex: 'half' as const, keepalive: false } : {}) })
            await send({ action: 'head', status: result.status, statusText: result.statusText, headers: headers([...result.headers]), body: result.body !== null })
            await response.pump(result.body)
            await send({ action: 'done' })
          } catch {
            const cancelled = controller.signal.aborted
            controller.abort(new Error('execution_http_request_closed'))
            await response.stopped(); await request.stopped()
            if (result?.body && !result.body.locked) await result.body.cancel().catch(() => undefined)
            await send({ action: cancelled ? 'cancelled' : 'error' })
          } finally {
            controller.abort(new Error('execution_http_transaction_closed')); active.delete(id); finished.set(id, WINDOW)
            if (finished.size > 4096) finished.delete(finished.keys().next().value!)
          }
        })
        active.set(id, { controller, request, response, task }); void task.catch(failed)
      } else {
        const transaction = active.get(id)
        if (!transaction) {
          assert(finished.has(id) && ['credit', 'end', 'cancel', 'data'].includes(String(frame.action)))
          // An early response can cross the remaining bounded upload window.
          // Stop credits; accept only already-in-flight request bytes.
          if (frame.action === 'data') {
            assert(frame.direction === 'request' && typeof frame.bytes === 'string' && frame.bytes.length <= CHUNK / 3 * 4)
            const bytes = Buffer.from(frame.bytes, 'base64'), remaining = finished.get(id)!
            assert(bytes.length > 0 && bytes.length <= CHUNK && bytes.toString('base64') === frame.bytes && bytes.length <= remaining)
            finished.set(id, remaining - bytes.length)
          }
          if (frame.action === 'cancel') void send({ action: 'cancelled' }).catch(failed)
          return
        }
        if (frame.action === 'cancel') transaction.controller.abort(new DOMException('Request aborted', 'AbortError'))
        else if (!transaction.controller.signal.aborted) {
          assert(frame.action === 'credit' ? frame.direction === 'response' : frame.direction === 'request')
          ;(frame.direction === 'request' ? transaction.request : transaction.response).accept(frame)
        }
      }
    } catch { failed() }
  }
  const disconnect = () => { for (const transaction of active.values()) transaction.controller.abort(new Error('execution_http_disconnected')) }
  control.events.on('message', accept); control.events.on('disconnect', disconnect)
  const close = () => closure ??= (async () => {
    closing = true; signal?.removeEventListener('abort', onAbort)
    for (const transaction of active.values()) transaction.controller.abort(new DOMException('Server closing', 'AbortError'))
    try { await Promise.all([...active.values()].map(value => value.task)) }
    finally { control.events.removeListener('message', accept); control.events.removeListener('disconnect', disconnect) }
  })()
  const onAbort = () => { void close().catch(failed) }
  signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort()
  return Object.freeze({ close })
}
