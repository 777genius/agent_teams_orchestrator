import { Agent, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { Readable } from 'node:stream'
import { nativeCustodyForEndpoint, recheckNativeRequestAuthority } from './OpenCodeNativeCustody.js'

/** A new socket for every request. HTTP receives it only after native peer admission. */
export async function fetchNativeOpenCode(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init), url = new URL(request.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash)
    throw new Error('native_custody_unavailable')
  const custody = nativeCustodyForEndpoint(url.origin) // Locator only; native proof follows for the actual socket.
  const agent = new Agent({ keepAlive: false, maxSockets: 1 })
  agent.createConnection = ((_options, callback) => {
    if (!callback) throw new Error('native_custody_protocol')
    const socket = connect({ host: '127.0.0.1', port: Number(url.port) })
    let completed = false
    const finish = (error: Error | null): void => {
      if (completed) return
      completed = true
      request.signal.removeEventListener('abort', abort)
      if (error) socket.destroy()
      callback(error, socket)
    }
    const abort = () => finish(new Error('native_custody_cancelled'))
    request.signal.addEventListener('abort', abort, { once: true })
    socket.once('error', error => finish(error))
    socket.once('connect', () => { void (async () => {
      try {
        request.signal.throwIfAborted()
        if (!socket.localPort || socket.destroyed) throw new Error('native_custody_unavailable')
        await custody.verifyPeer(socket.localPort)
        await recheckNativeRequestAuthority(url.origin)
        request.signal.throwIfAborted()
        if (socket.destroyed) throw new Error('native_custody_unavailable')
        finish(null)
      } catch { finish(new Error('native_custody_unavailable')) }
    })() })
    // Agent's documented asynchronous callback supplies the *same* socket after
    // proof. Returning a socket here would flush buffered HTTP before admission.
    return undefined
  }) as typeof agent.createConnection
  try {
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
    request.signal.throwIfAborted()
    return await new Promise<Response>((resolve, reject) => {
      const authenticated = new Headers(request.headers)
      authenticated.set('authorization', custody.reference.authorization)
      const operation = httpRequest(url, {
        agent, method: request.method, headers: Object.fromEntries(authenticated), signal: request.signal,
      }, incoming => {
        const status = incoming.statusCode ?? 502
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item)
          else if (value !== undefined) headers.set(name, value)
        }
        const empty = request.method === 'HEAD' || [204, 205, 304].includes(status)
        if (empty) incoming.resume()
        let bodyStream: ReadableStream<Uint8Array> | null = null
        if (!empty) {
          const reader = Readable.toWeb(incoming).getReader()
          bodyStream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const part = await reader.read()
                if (part.done) { reader.releaseLock(); controller.close() }
                else if (part.value instanceof Uint8Array) controller.enqueue(part.value)
                else throw new Error('native_custody_response_failed')
              } catch {
                controller.error(new Error('native_custody_response_failed'))
                agent.destroy()
              }
            },
            async cancel() { try { await reader.cancel() } finally { agent.destroy() } },
          })
        }
        // Node HTTP never follows redirects; a redirect cannot acquire a second socket.
        resolve(new Response(bodyStream, {
          status, statusText: incoming.statusMessage, headers,
        }))
      })
      operation.once('error', reject)
      operation.end(body)
    })
  } catch {
    agent.destroy()
    // ClientRequest/transport error objects may retain private request headers.
    // Public failure paths carry only an allowlisted phase code, never a cause.
    throw new Error(request.signal.aborted ? 'native_custody_cancelled' : 'native_custody_unavailable')
  }
}

export const productionOpenCodeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  process.platform === 'linux' ? fetchNativeOpenCode(input, init) : globalThis.fetch(input, init)
