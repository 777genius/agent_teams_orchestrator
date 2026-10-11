import type { Socket } from 'node:net'

// TEST mechanism checkpoint only. Production requires overlapped native I/O.
const chunkSize = 3072, frameBudget = 8192, queueBudget = 32768
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
type Frame = { id: number; type: string; method?: string; path?: string; data?: string; status?: number; error?: string }
const encode = (frame: Frame) => {
  const text = JSON.stringify(frame) + '\n'
  if (Buffer.byteLength(text) > frameBudget) throw new Error('TEST bridge frame budget')
  return text
}
function parser(receive: (frame: Frame) => void) {
  let text = ''
  return (data: string) => {
    text += data
    for (;;) {
      const end = text.indexOf('\n')
      if (end < 0) { if (text.length > frameBudget) throw new Error('TEST bridge incomplete frame budget'); return }
      if (end > frameBudget) throw new Error('TEST bridge frame budget')
      const frame = JSON.parse(text.slice(0, end)) as Frame; text = text.slice(end + 1)
      if (!Number.isSafeInteger(frame.id) || frame.id < 1 || typeof frame.type !== 'string') throw new Error('TEST bridge invalid frame')
      receive(frame)
    }
  }
}
export function attachCheckpointChild(socket: Socket, baseUrl: string) {
  const target = new URL(baseUrl)
  if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:') throw new Error('TEST bridge target')
  type ChildRequest = { abort: AbortController; upload?: ReadableStreamDefaultController<Uint8Array>; uploadCredit: boolean; reader?: ReadableStreamDefaultReader<Uint8Array>; carry: Uint8Array; reading: boolean }
  const requests = new Map<number, ChildRequest>()
  let sendTail: Promise<void> = Promise.resolve()
  let queuedBytes = 0
  const send = (frame: Frame) => {
    const text = encode(frame)
    if (queuedBytes + text.length > queueBudget) return Promise.reject(new Error('TEST child bridge queue budget'))
    queuedBytes += text.length
    sendTail = sendTail.then(() => new Promise<void>((resolve, reject) => socket.write(text, error => error ? reject(error) : resolve()))).finally(() => { queuedBytes -= text.length })
    return sendTail
  }
  const fail = (id: number, error: unknown) => { if (!requests.has(id) || requests.get(id)!.abort.signal.aborted) return; void send({ id, type: 'error', error: String(error) }).catch(() => {}); requests.get(id)?.abort.abort(); requests.delete(id) }
  const receive = async (frame: Frame) => {
    if (frame.type === 'open') {
      if (requests.size >= 3 || requests.has(frame.id) || !['GET', 'POST'].includes(frame.method ?? '') || !['/health', '/echo', '/sse'].includes(frame.path ?? '')) throw new Error('TEST bridge request rejected')
      const state: ChildRequest = { abort: new AbortController(), uploadCredit: false, carry: new Uint8Array(), reading: false }
      requests.set(frame.id, state)
      const body = frame.method === 'POST' ? new ReadableStream<Uint8Array>({
        start(controller) { state.upload = controller },
        async pull() { if (state.uploadCredit) throw new Error('TEST upload double credit'); state.uploadCredit = true; await send({ id: frame.id, type: 'request-credit' }) },
      }, { highWaterMark: 0 }) : undefined
      const response = await fetch(new URL(frame.path!, target), { method: frame.method, body, signal: state.abort.signal })
      state.reader = response.body?.getReader()
      await send({ id: frame.id, type: 'headers', status: response.status })
      return
    }
    const state = requests.get(frame.id)
    if (!state) { if (frame.type === 'abort') await send({ id: frame.id, type: 'aborted' }); else throw new Error('TEST bridge unknown request'); return }
    if (frame.type === 'request-chunk') {
      if (!state.uploadCredit || typeof frame.data !== 'string') throw new Error('TEST upload without credit')
      const bytes = Buffer.from(frame.data, 'base64'); if (bytes.length > chunkSize) throw new Error('TEST upload chunk budget')
      state.uploadCredit = false; state.upload!.enqueue(bytes); return
    }
    if (frame.type === 'request-end') { if (!state.uploadCredit) throw new Error('TEST upload end without credit'); state.uploadCredit = false; state.upload!.close(); return }
    if (frame.type === 'abort') {
      state.abort.abort(); await state.reader?.cancel().catch(() => {}); requests.delete(frame.id)
      await send({ id: frame.id, type: 'aborted' }); return
    }
    if (frame.type !== 'response-credit' || state.reading) throw new Error('TEST response credit invalid')
    state.reading = true
    try {
      if (state.carry.length === 0) {
        const next = await state.reader?.read()
        if (!next || next.done) { requests.delete(frame.id); await send({ id: frame.id, type: 'response-end' }); return }
        state.carry = next.value
      }
      const data = state.carry.subarray(0, chunkSize); state.carry = state.carry.subarray(data.length)
      await send({ id: frame.id, type: 'response-chunk', data: Buffer.from(data).toString('base64') })
    } finally { state.reading = false }
  }
  const consume = parser(frame => { void receive(frame).catch(error => fail(frame.id, error)) })
  socket.on('data', bytes => { try { consume(bytes.toString('utf8')) } catch { for (const state of requests.values()) state.abort.abort(); socket.destroy() } })
  socket.on('close', () => { for (const state of requests.values()) state.abort.abort(); requests.clear() })
}
export async function runCheckpointHost(pipe: { read(): string; writeSome(text: string): number; clientPID(): number }, validatePeer: (pid: number) => { pid: number; birthFiletime: string }) {
  const peer = validatePeer(pipe.clientPID())
  const stats = { ...peer, requestChunks: 0, responseChunks: 0, partialWrites: 0, fragmentedWrites: 0, peakQueuedBytes: 0, abortAcknowledged: false }
  type HostRequest = { resolve(response: Response): void; reject(error: unknown): void; controller?: ReadableStreamDefaultController<Uint8Array>; upload?: ReadableStreamDefaultReader<Uint8Array>; carry: Uint8Array; responseCredit: boolean; aborted: boolean }
  const requests = new Map<number, HostRequest>()
  const writes: { text: string; resolve(): void; reject(error: unknown): void }[] = []
  let queuedBytes = 0, nextID = 0, running = true, pumpError: unknown
  const send = (frame: Frame) => new Promise<void>((resolve, reject) => {
    const text = encode(frame)
    if (queuedBytes + text.length > queueBudget) { reject(new Error('TEST bridge queue budget')); return }
    queuedBytes += text.length; stats.peakQueuedBytes = Math.max(stats.peakQueuedBytes, queuedBytes); writes.push({ text, resolve, reject })
  })
  const abort = (id: number, state: HostRequest) => { if (state.aborted) return; state.aborted = true; void state.upload?.cancel().catch(() => {}); void send({ id, type: 'abort' }).catch(() => {}) }
  const receive = async (frame: Frame) => {
    if (frame.type === 'aborted') { stats.abortAcknowledged = true; requests.delete(frame.id); return }
    const state = requests.get(frame.id); if (!state) throw new Error('TEST host unknown request')
    if (frame.type === 'request-credit') {
      if (state.carry.length === 0) {
        const next = await state.upload?.read()
        if (!next || next.done) { await send({ id: frame.id, type: 'request-end' }); return }
        state.carry = next.value
      }
      const bytes = state.carry.subarray(0, chunkSize); state.carry = state.carry.subarray(bytes.length); stats.requestChunks++
      await send({ id: frame.id, type: 'request-chunk', data: Buffer.from(bytes).toString('base64') }); return
    }
    if (frame.type === 'headers') {
      if (!Number.isInteger(frame.status) || frame.status! < 100 || frame.status! > 599) throw new Error('TEST HTTP status')
      const body = new ReadableStream<Uint8Array>({
        start(controller) { state.controller = controller },
        async pull() { if (state.aborted) return; if (state.responseCredit) throw new Error('TEST response double credit'); state.responseCredit = true; await send({ id: frame.id, type: 'response-credit' }) },
        cancel() { abort(frame.id, state) },
      }, { highWaterMark: 0 })
      state.resolve(new Response(body, { status: frame.status })); return
    }
    if (frame.type === 'response-chunk') {
      if (!state.responseCredit || typeof frame.data !== 'string') throw new Error('TEST response without credit')
      const bytes = Buffer.from(frame.data, 'base64'); if (bytes.length > chunkSize) throw new Error('TEST response chunk budget')
      state.responseCredit = false; stats.responseChunks++; if (!state.aborted) state.controller!.enqueue(bytes); return
    }
    if (frame.type === 'response-end') { state.responseCredit = false; if (!state.aborted) state.controller!.close(); requests.delete(frame.id); return }
    if (frame.type === 'error') { const error = new Error(frame.error); state.reject(error); state.controller?.error(error); requests.delete(frame.id); return }
    throw new Error('TEST host frame type')
  }
  const consume = parser(frame => { void receive(frame).catch(error => { pumpError = error }) })
  const pump = (async () => {
    while (running) {
      try {
        validatePeer(peer.pid); consume(pipe.read())
        const item = writes[0]
        if (item) {
          const fragment = item.text.slice(0, 1024), count = pipe.writeSome(fragment)
          if (count < fragment.length) stats.partialWrites++
          if (count) { stats.fragmentedWrites++; queuedBytes -= count; item.text = item.text.slice(count); if (!item.text) { writes.shift(); item.resolve() } }
        }
        if (pumpError) throw pumpError
      } catch (error) { pumpError = error; for (const item of writes.splice(0)) item.reject(error); for (const state of requests.values()) { state.reject(error); state.controller?.error(error) }; return }
      await sleep(2)
    }
  })()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url)
    if (!['/health', '/echo', '/sse'].includes(url.pathname) || requests.size >= 3) return new Response('TEST rejected', { status: 400 })
    const id = ++nextID
    return new Promise<Response>((resolve, reject) => {
      const state: HostRequest = { resolve, reject, upload: request.body?.getReader(), carry: new Uint8Array(), responseCredit: false, aborted: false }
      requests.set(id, state); request.signal.addEventListener('abort', () => abort(id, state), { once: true })
      void send({ id, type: 'open', method: request.method, path: url.pathname }).catch(reject)
    })
  } })
  try {
    const url = `http://127.0.0.1:${server.port}`
    const health = await (await fetch(url + '/health', { signal: AbortSignal.timeout(10000) })).text()
    const body = 'native-request-body-'.repeat(8192)
    const echo = await (await fetch(url + '/echo', { method: 'POST', body, signal: AbortSignal.timeout(10000) })).text()
    const streamAbort = new AbortController(), streamTimeout = setTimeout(() => streamAbort.abort(), 10000)
    let first: { value?: Uint8Array; done: boolean }
    try {
      const stream = await fetch(url + '/sse', { signal: streamAbort.signal }), reader = stream.body!.getReader()
      first = await reader.read(); streamAbort.abort(); await reader.cancel().catch(() => {})
    } finally { clearTimeout(streamTimeout) }
    const deadline = Date.now() + 3000
    while (!stats.abortAcknowledged && !pumpError && Date.now() < deadline) await sleep(5)
    if (pumpError) throw pumpError
    const ssePassed = Buffer.from(first.value ?? []).toString().includes('data: native-sse')
    return { ...stats, healthPassed: health === 'native-http-ok', postPassed: echo === body, ssePassed, passed: health === 'native-http-ok' && echo === body && ssePassed && stats.abortAcknowledged && stats.requestChunks > 1 && stats.responseChunks > 1 }
  } catch (error) { return { ...stats, passed: false, error: String(error) } }
  finally {
    for (const [id, state] of requests) abort(id, state)
    server.stop(true); running = false; await pump
  }
}
