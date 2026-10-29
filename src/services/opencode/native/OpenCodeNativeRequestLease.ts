// Bun maps bare "undici" to its fetch shim. The explicit installed entrypoint
// preserves the connector contract on the production Bun runtime.
import { Client, type Dispatcher } from 'undici/index.js'
import { connect, type Socket } from 'node:net'
import { nativeCustodyForRequest, recheckNativeRequestAuthority } from './OpenCodeNativeCustody.js'

/** One admitted socket and one dispatch; neither redirects nor reconnects replay a request. */
export async function fetchNativeOpenCode(input: RequestInfo | URL, init?: RequestInit, owner?: object): Promise<Response> {
  const request = new Request(input, init), url = new URL(request.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash)
    throw new Error('native_custody_unavailable')
  const custody = nativeCustodyForRequest(owner, url.origin)
  let attempted = false, socket: Socket | undefined
  const client = new Client(url.origin, {
    pipelining: 0,
    connect(_options, callback) {
      if (attempted) { callback(new Error('native_custody_reconnect_refused'), null); return }
      attempted = true
      let completed = false
      const finish = (error: Error | null) => {
        if (completed) return
        completed = true
        if (error) { socket?.destroy(); callback(error, null) }
        else callback(null, socket!)
      }
      const abort = () => { socket?.destroy(); finish(new Error('native_custody_cancelled')) }
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) { abort(); return }
      socket = connect({ host: '127.0.0.1', port: Number(url.port) })
      socket.once('close', () => request.signal.removeEventListener('abort', abort))
      socket.once('error', () => finish(new Error('native_custody_unavailable')))
      socket.once('connect', () => { void (async () => {
        try {
          request.signal.throwIfAborted()
          if (!socket?.localPort || socket.destroyed) throw new Error('native_custody_unavailable')
          await custody.verifyPeer(socket.localPort)
          request.signal.throwIfAborted()
          await recheckNativeRequestAuthority(custody)
          request.signal.throwIfAborted()
          if (socket.destroyed) throw new Error('native_custody_unavailable')
          // Only now may Undici see the exact socket and flush its private headers.
          finish(null)
        } catch { finish(new Error('native_custody_unavailable')) }
      })() })
    },
  })
  let disposal: Promise<void> | undefined
  const dispose = () => disposal ??= Promise.resolve().then(() => client.destroy()).catch(() => undefined)
  try {
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
    request.signal.throwIfAborted()
    const headers = new Headers(request.headers)
    headers.set('authorization', custody.reference.authorization)
    const incoming = await client.request({ path: url.pathname + url.search, method: request.method as Dispatcher.HttpMethod,
      headers: Object.fromEntries(headers), body, signal: request.signal, idempotent: false, headersTimeout: 0, bodyTimeout: 0 })
    const responseHeaders = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item)
      else if (value !== undefined) responseHeaders.set(name, value)
    }
    const empty = request.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode)
    let stream: ReadableStream<Uint8Array> | null = null
    if (empty) { await incoming.body.dump(); await dispose() }
    else {
      // Bun's Readable.toWeb adapter can enqueue buffered data after cancel has
      // closed its controller. Own this bridge's state instead; async iteration
      // retains Node's backpressure without an intermediate Web controller.
      const body = incoming.body
      // Cancellation can precede the iterator's first next()/error listener.
      body.on('error', () => undefined)
      const iterator = body[Symbol.asyncIterator]()
      let state: 'open' | 'ended' | 'failed' | 'cancelled' = 'open'
      stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (state !== 'open') return
          try {
            const part = await iterator.next()
            // cancel() can finish while next() is waiting for transport data.
            if (state !== 'open') return
            if (part.done) { state = 'ended'; controller.close(); void dispose() }
            else if (part.value instanceof Uint8Array) controller.enqueue(part.value)
            else throw new Error('native_custody_response_failed')
          } catch {
            if (state !== 'open') return
            state = 'failed'
            controller.error(new Error('native_custody_response_failed'))
            void dispose()
          }
        },
        async cancel() {
          if (state !== 'open') { await dispose(); return }
          state = 'cancelled'
          // Destroy first: iterator.return() queues behind any pending next().
          // Waiting for return before closing the body would hang cancellation.
          body.destroy()
          await Promise.allSettled([iterator.return?.(), dispose()])
        },
      })
    }
    return new Response(stream, { status: incoming.statusCode, headers: responseHeaders })
  } catch {
    void dispose()
    // Transport errors may retain request headers; never expose their cause.
    throw new Error(request.signal.aborted ? 'native_custody_cancelled' : 'native_custody_unavailable')
  }
}

export const productionOpenCodeFetch = (input: RequestInfo | URL, init?: RequestInit, owner?: object): Promise<Response> =>
  process.platform === 'linux' ? fetchNativeOpenCode(input, init, owner) : globalThis.fetch(input, init)
