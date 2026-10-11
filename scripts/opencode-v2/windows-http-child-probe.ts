import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { bindWindowsExecutionHttp } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsHTTP.js'
import { prepareWindowsExecutionChild, windowsExecutionChildControl } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsChildControl.js'

// Builtin-only TEST origin. The transport modules are the actual production
// inputs bundled without source changes; this is not an official-server claim.
const control = windowsExecutionChildControl()
control.events.on('error', () => {})
let bridge: ReturnType<typeof bindWindowsExecutionHttp> | undefined
let selectedBirth: unknown, selectedNamespace: unknown
const sockets = new Set<import('node:net').Socket>()
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/get') {
      response.setHeader('x-native-http', 'production-transport'); response.end('native-http-get-é')
    } else if (request.url === '/post') {
      const chunks: Buffer[] = []; let length = 0
      for await (const chunk of request) { length += chunk.length; if (length > 23000) throw new Error('test-body-limit'); chunks.push(chunk) }
      const body = Buffer.concat(chunks)
      if (body.length !== 23000 || body.some((value, index) => value !== index % 251)) throw new Error('test-body-mismatch')
      response.statusCode = 201; response.setHeader('x-upload-bytes', String(body.length))
      response.end(Buffer.alloc(100000, 0xa7))
    } else if (request.url === '/early') {
      response.statusCode = 413; response.end('early-response')
    } else if (request.url === '/sse' || request.url === '/disconnect') {
      response.setHeader('content-type', 'text/event-stream'); response.flushHeaders()
      let blocked = false
      const timer = setInterval(() => {
        if (!blocked) blocked = !response.write('data: ' + 's'.repeat(3064) + '\n\n')
      }, 1)
      response.on('drain', () => { blocked = false })
      response.once('close', () => {
        clearInterval(timer)
        if (request.url === '/sse') void writeFile('sse-cancelled.txt', 'server-observed-cancel')
      })
    } else { response.statusCode = 404; response.end() }
  } catch { response.destroy() }
})
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
control.events.on('message', (value: Record<string, unknown>) => {
  void (async () => {
    if (value.type === 'prepare') {
      const prepared = await prepareWindowsExecutionChild(value)
      selectedBirth = prepared.birth; selectedNamespace = prepared.namespace
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test-http-origin')
      const baseUrl = `http://127.0.0.1:${address.port}`
      bridge = bindWindowsExecutionHttp(baseUrl)
      await control.send({ ...prepared, type: 'ready', baseUrl })
    } else if (value.type === 'close') {
      await bridge?.close()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await control.send({ type: 'closed', nonce: value.nonce, leaseOwnerId: value.leaseOwnerId,
        pid: process.pid, birth: selectedBirth, namespace: selectedNamespace, scopeClosed: true })
      control.disconnect()
    } else if (value.type === 'testDisconnect') control.disconnect()
  })().catch(() => { control.disconnect(); process.exitCode = 9 })
})
