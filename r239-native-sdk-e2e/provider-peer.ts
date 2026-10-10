import { createServer, type ServerResponse } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.argv[2]!, mode = process.argv[3]
if (!root.split('/').some(x => x.startsWith('TEST-')) || !['complete', 'held'].includes(mode!)) throw new Error('owned fixture arguments required')
let calls = 0, closed = 0, finished = 0
let failure: string | undefined
let closing = false
const responses = new Set<ServerResponse>()
function fixtureFailure(message: string): void { failure ??= message; process.send?.({ kind: 'failed', message, calls, closed, finished, active: responses.size }) }
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') throw new Error('unexpected provider operation')
    const parts: Buffer[] = []; let bytes = 0
    for await (const part of request) { bytes += part.length; if (bytes > 256 * 1024) throw new Error('request budget'); parts.push(Buffer.from(part)) }
    calls++; if (calls !== 1) throw new Error('provider duplicate: fixture refuses additional effects')
    const raw = Buffer.concat(parts).toString('utf8'), body: unknown = JSON.parse(raw)
    if (!body || typeof body !== 'object' || !('model' in body) || body.model !== 'TEST-upstream' || !('stream' in body) || body.stream !== true || !raw.includes('TEST-R239-original')) throw new Error('provider request contract')
    await writeFile(join(root, 'provider-request.json'), raw, { flag: 'wx', mode: 0o600 })
    responses.add(response)
    response.once('close', () => { responses.delete(response); closed++; process.send?.({ kind: 'body_closed', calls, closed, finished, active: responses.size }) })
    response.once('finish', () => { finished++; process.send?.({ kind: 'body_finished', calls, closed, finished, active: responses.size }) })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const frame = (delta: Record<string, unknown>, finish_reason: string | null = null, usage?: Record<string, number>) => response.write('data: ' + JSON.stringify({ id: 'chatcmpl_TESTr239', object: 'chat.completion.chunk', created: 1, model: 'TEST-upstream', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n')
    frame({ role: 'assistant', content: 'TEST-R239-completed' })
    process.send?.({ kind: 'requested', calls, closed, finished, active: responses.size })
    if (mode === 'complete') { frame({}, 'stop', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }); response.end('data: [DONE]\n\n') }
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure)
    fixtureFailure(message)
    response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":{"message":"TEST fixture refused"}}')
  }
})
server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address'); process.send?.({ kind: 'ready', port: address.port, nativeNode: !('bun' in process.versions), node: process.versions.node }) })
process.on('message', message => { if (message && typeof message === 'object' && 'kind' in message && message.kind === 'close') { if (closing) return; closing = true; for (const response of responses) response.destroy(); server.closeAllConnections(); server.close(() => {
  if (!process.send || !process.connected) return process.exit(1)
  process.send({ kind: 'finished', calls, closed, finished, active: responses.size, ...(failure ? { failure } : {}) }, error => { process.disconnect?.(); process.exit(error ? 1 : 0) })
}) } })
process.on('disconnect', () => { if (closing) return; closing = true; server.closeAllConnections(); server.close(() => process.exit(1)) })
