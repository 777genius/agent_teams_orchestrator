import { createServer } from 'node:http'

// Bundled by the Bun parent, executed by a separate genuine Node process.
// IPC receipts contain fixture facts only, never auth/config/model data.
if (!process.send || 'bun' in process.versions) throw new Error('TEST peer requires native Node IPC')
let stopping = false
const server = createServer((request, response) => {
  const facts = { pid: process.pid, method: request.method, url: request.url }
  response.once('close', () => { if (process.connected) process.send?.({ kind: 'body_closed', ...facts }) })
  response.writeHead(200, { 'content-type': 'application/json' })
  response.write('{"healthy":')
  process.send?.({ kind: 'body_started', ...facts })
})

function stop(): void {
  if (stopping) return
  stopping = true
  server.closeAllConnections()
  server.close(() => { if (process.connected) process.disconnect?.() })
}
process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'kind' in message && message.kind === 'stop') stop()
})
process.on('disconnect', stop)
process.on('SIGTERM', stop)
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TEST peer listener missing')
  process.send?.({ kind: 'ready', pid: process.pid, port: address.port,
    nativeNode: !('bun' in process.versions), nodeVersion: process.versions.node })
})
