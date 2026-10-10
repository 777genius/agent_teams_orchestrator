// Independent Node HTTP peer for execution transport tests; never a native proof.
import { createServer } from 'node:http'
import type { Socket } from 'node:net'

const sockets = new Set<Socket>()
const receipt = { id: 'msg_original', sessionID: 'ses_original', type: 'user',
  time: { created: 123 }, payload: { text: 'one input' }, delivery: 'queue' }
let mutations = 0
const server = createServer((request, response) => {
  const route = new URL(request.url ?? '/', 'http://TEST.invalid').pathname
  if (request.method === 'POST' && route.endsWith('/prompt')) {
    request.resume()
    request.once('end', () => {
      mutations++; process.send?.({ kind: 'admitted', mutations })
      if (route.includes('ses_html')) { response.setHeader('content-type', 'text/html'); response.end('<html>lost API body</html>') }
      else if (route.includes('ses_json')) { response.setHeader('content-type', 'application/json'); response.end('{') }
      else if (route.includes('ses_void')) { response.writeHead(204); response.end() }
      else request.socket.destroy() // Effect has happened; response is lost.
    })
  } else if (route.endsWith('/inbox')) {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(mutations ? [receipt] : []))
  } else if (route === '/api/info') {
    response.setHeader('content-type', 'application/json'); response.flushHeaders(); response.write('{')
    response.once('close', () => process.send?.({ kind: 'body_closed' }))
  } else if (route.endsWith('/log')) {
    response.setHeader('content-type', 'text/event-stream')
    response.end('data: {"type":"log.synced","aggregateID":"ses_original"}')
  } else if (route === '/api/plugin/await-activation') {
    response.writeHead(204); response.end()
  } else { response.setHeader('content-type', 'text/html'); response.end('<html>wrong API</html>') }
})
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address && typeof address === 'object') process.send?.({ kind: 'ready', port: address.port, nativeNode: Boolean(process.versions.node && !process.versions.bun) })
})
process.on('message', message => {
  if (message && typeof message === 'object' && 'kind' in message && message.kind === 'stop') {
    for (const socket of sockets) socket.destroy()
    server.close(() => process.disconnect?.())
  }
})
