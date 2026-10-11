import { createServer } from 'node:http'
import { writeFile, readFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
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
    } else if (request.url === '/disconnect') {
      // A single known byte enters Bun's real response streaming path. The
      // parent consumes it fully before establishing the pending next read.
      response.setHeader('content-type', 'text/event-stream')
      response.setHeader('transfer-encoding', 'chunked')
      response.write(Buffer.of(0x71)); response.flushHeaders()
      await new Promise<void>((resolve, reject) => {
        const socket = request.socket
        const cleanup = () => {
          clearTimeout(timer); request.removeListener('aborted', closed)
          socket.removeListener('close', closed); response.removeListener('close', closed)
        }
        const closed = () => { cleanup(); resolve() }
        const timer = setTimeout(() => {
          cleanup(); reject(new Error('test-disconnect-fixture-timeout'))
          response.destroy()
        }, 15000)
        request.once('aborted', closed); socket.once('close', closed); response.once('close', closed)
        if (request.aborted || socket.destroyed) closed()
      })
    } else if (request.url === '/sse') {
      response.setHeader('content-type', 'text/event-stream'); response.flushHeaders()
      let blocked = false
      const timer = setInterval(() => {
        if (!blocked) blocked = !response.write('data: ' + 's'.repeat(3064) + '\n\n')
      }, 1)
      response.on('drain', () => { blocked = false })
      response.once('close', () => clearInterval(timer))
      // Bun 1.3.11 reports real peer cancellation on IncomingMessage; its
      // ServerResponse close event is not emitted in this path.
      request.once('aborted', () => {
        clearInterval(timer)
        if (request.url !== '/sse') return
        const observed = { event: 'request-aborted', requestAborted: request.aborted,
          socketDestroyed: request.socket.destroyed, responseDestroyed: response.destroyed ?? null }
        void (async () => {
          let markerWritten = false, markerError: string | undefined
          try { await writeFile('sse-cancelled.txt', JSON.stringify(observed)); markerWritten = true }
          catch (error) { const code = (error as NodeJS.ErrnoException).code; markerError = typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'UNKNOWN' }
          await control.send({ type: 'testSseCancellation', nonce: process.env.OPENCODE_V2_WINDOWS_NONCE,
            leaseOwnerId: process.env.OPENCODE_V2_WINDOWS_LEASE, ...observed, markerWritten, markerError })
        })().catch(() => control.disconnect())
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
    } else if (value.type === 'testFilesystem') {
      // Same bytes and same private root. These are actual API operations,
      // retained independently from HTTP cancellation qualification.
      const bytes = Buffer.from('native-fs-bytes-é\0\x01\xff', 'utf8')
      const absolute = (name: string) => path.join(process.cwd(), name)
      const cases: [string, string, () => void | Promise<unknown>][] = [
        ['node-relative', 'node-relative.txt', () => writeFile('node-relative.txt', bytes)],
        ['node-absolute', 'node-absolute.txt', () => writeFile(absolute('node-absolute.txt'), bytes)],
        ['node-sync-relative', 'node-sync.txt', () => writeFileSync('node-sync.txt', bytes)],
        ['node-relative-no-dot', 'nodeplain', () => writeFile('nodeplain', bytes)],
        ['bun-relative', 'bun-relative.txt', () => Bun.write('bun-relative.txt', bytes)],
        ['bun-absolute', 'bun-absolute.txt', () => Bun.write(absolute('bun-absolute.txt'), bytes)],
      ]
      const operations: Record<string, unknown>[] = []
      for (const [id, name, write] of cases) {
        let stage = 'write'
        try {
          await write(); stage = 'absolute-node-read'
          const read = await readFile(absolute(name))
          operations.push({ id, written: true, absoluteNodeReadMatches: read.equals(bytes), bytes: read.length })
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          operations.push({ id, failedStage: stage, code: typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'UNKNOWN' })
        }
      }
      await control.send({ type: 'testFilesystemResult', nonce: value.nonce, leaseOwnerId: value.leaseOwnerId, operations })
    } else if (value.type === 'testReopenCwd') {
      const before = process.cwd(), bytes = Buffer.from('native-fs-bytes-é\0\x01\xff', 'utf8')
      const observed: Record<string, unknown> = { testOnly: true, reopened: false, written: false }
      let stage = 'reopen-cwd'
      try {
        // Bun 1.3.11 resolves dotted relative node-fs paths by querying its cwd
        // HANDLE. Reopen this same selected directory; change no ACL or path.
        process.chdir(before); observed.reopened = true; observed.cwdUnchanged = process.cwd() === before
        stage = 'relative-node-write'; await writeFile('node-reopened.txt', bytes); observed.written = true
        stage = 'absolute-node-read'; const read = await readFile(path.join(before, 'node-reopened.txt'))
        observed.absoluteNodeReadMatches = read.equals(bytes); observed.bytes = read.length
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        observed.failedStage = stage; observed.code = typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'UNKNOWN'
      }
      await control.send({ type: 'testReopenCwdResult', nonce: value.nonce, leaseOwnerId: value.leaseOwnerId, ...observed })
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
