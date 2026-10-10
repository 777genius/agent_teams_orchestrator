import { describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenCode } from '@opencode/client-v2-floor'
import { privateOpenCodeReadEnvironment } from '../profile/OpenCodeV2ManagedConfig.js'
import { OpenCodeBoundedFetch, boundOpenCodeRead } from './OpenCodeBoundedFetch.js'

// Independent HTTP peers exercise real socket/body lifetime and genuine official SDK decoding.
describe('OpenCode V2 finite read transport', () => {
  test('body deadline stays active after headers and joins cancellation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-opencode-node-body-peer-'))
    let child: ChildProcess | undefined, wire: OpenCodeBoundedFetch | undefined
    let exited: Promise<number | null> | undefined, spawnError: Error | undefined
    let stderr = '', qualified = false
    try {
      await Promise.all(['home', 'tmp', 'config', 'data', 'cache', 'state', 'appdata', 'localappdata']
        .map(directory => mkdir(path.join(root, directory))))
      const fixture = fileURLToPath(new URL('./fixtures/NodeBodyDeadlinePeer.ts', import.meta.url))
      const build = await Bun.build({ entrypoints: [fixture], target: 'node', format: 'esm',
        outdir: root, naming: 'NodeBodyDeadlinePeer.mjs' })
      if (!build.success) throw new Error(`Node TEST peer build failed: ${build.logs.join('\n')}`)
      const node = process.env.TEST_OPENCODE_NODE_BINARY ?? 'node'
      if (node !== 'node' && !path.isAbsolute(node)) throw new Error('TEST Node override must be absolute')
      let readyResolve: (port: number) => void = () => undefined
      let startedResolve: () => void = () => undefined, closedResolve: () => void = () => undefined
      const ready = new Promise<number>(resolve => { readyResolve = resolve })
      const started = new Promise<void>(resolve => { startedResolve = resolve })
      const closed = new Promise<void>(resolve => { closedResolve = resolve })
      const peer = spawn(node, [path.join(root, 'NodeBodyDeadlinePeer.mjs')], {
        cwd: root, env: privateOpenCodeReadEnvironment(root), serialization: 'json',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      child = peer
      exited = new Promise(resolve => { peer.once('close', code => resolve(code)) })
      child.once('error', error => { spawnError = error })
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384) })
      child.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('pid' in message) || message.pid !== child?.pid ||
          !('kind' in message)) return
        if (message.kind === 'ready' && 'nativeNode' in message && message.nativeNode === true &&
          'port' in message && typeof message.port === 'number' && Number.isInteger(message.port) &&
          message.port > 0 && message.port <= 65_535) readyResolve(message.port)
        if ('method' in message && message.method === 'GET' && 'url' in message && message.url === '/api/health') {
          if (message.kind === 'body_started') startedResolve()
          if (message.kind === 'body_closed') closedResolve()
        }
      })
      const port = await boundOpenCodeRead(Promise.race([ready, exited.then(() => {
        throw spawnError ?? new Error(`Node TEST peer exited before ready: ${stderr}`)
      })]), 5000)
      const baseUrl = `http://127.0.0.1:${port}`
      wire = new OpenCodeBoundedFetch(baseUrl, '2.0.0', '/TEST', 'Basic TEST', { remainingMs: () => 150 })
      const sdk = OpenCode.make({ baseUrl, fetch: wire.fetch })
      await expect(sdk.health.get()).rejects.toBeDefined()
      await boundOpenCodeRead(started, 2000)
      await wire.dispose()
      // Only the real Node response close callback can resolve this receipt.
      // Teardown is sent in finally, after this assertion succeeds or fails.
      await boundOpenCodeRead(closed, 2000)
      expect(child.exitCode).toBeNull()
      qualified = true
    } finally {
      try { await wire?.dispose() }
      finally {
        if (child && exited) {
          if (child.connected) child.send({ kind: 'stop' }, error => { if (error) stderr += error.message })
          let code: number | null
          try { code = await boundOpenCodeRead(exited, 3000) }
          catch {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
            await boundOpenCodeRead(exited, 2000)
            throw new Error(`Node TEST peer cleanup_unknown; retained ${root}: ${stderr}`)
          }
          if (code !== 0 || stderr) throw new Error(`Node TEST peer failed; retained ${root}: ${stderr}`)
        }
        if (qualified) await rm(root, { recursive: true, force: true })
      }
    }
  }, 20_000)

  test('consumed UTF-8 bytes, malformed JSON, redirects and forbidden routes fail closed', async () => {
    let requests = 0, writes = 0
    let mode: 'large' | 'malformed' | 'redirect' = 'large'
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      requests++; if (request.method !== 'GET') writes++
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: '/foreign' } })
      return new Response(mode === 'large' ? JSON.stringify({ healthy: true, version: '2.0.0', pid: 1, extra: '界'.repeat(200) }) : '{',
        { headers: { 'content-type': 'application/json' } })
    } })
    const baseUrl = `http://127.0.0.1:${server.port}`
    try {
      for (const scenario of ['large', 'malformed', 'redirect'] as const) {
        mode = scenario
        const wire = new OpenCodeBoundedFetch(baseUrl, '2.0.0', '/TEST', 'Basic TEST', {}, globalThis.fetch, 128)
        try { await expect(OpenCode.make({ baseUrl, fetch: wire.fetch }).health.get()).rejects.toBeDefined() }
        finally { await wire.dispose() }
      }
      const before = requests
      const wire = new OpenCodeBoundedFetch(baseUrl, '2.0.0', '/TEST', 'Basic TEST')
      try {
        await expect(wire.fetch(`${baseUrl}/api/session`, { method: 'POST' })).rejects.toBeDefined()
        await expect(wire.fetch(`${baseUrl}/global/health`)).rejects.toBeDefined()
        await expect(wire.fetch('http://127.0.0.1:1/api/health')).rejects.toBeDefined()
        await expect(wire.fetch(`${baseUrl}/api/model?location[directory]=/OTHER`)).rejects.toBeDefined()
        expect(requests).toBe(before)
        expect(writes).toBe(0)
      } finally { await wire.dispose() }
    } finally { await server.stop(true) }
  })

  test('preconnect cannot bypass the finite read route authority', async () => {
    let delegated = 0
    const wire = new OpenCodeBoundedFetch('http://127.0.0.1:1', '2.0.0', '/TEST', 'Basic TEST', {},
      async () => { delegated++; throw new Error('unexpected HTTP delegation') })
    try {
      expect(() => wire.fetch.preconnect('http://127.0.0.1:1/api/session')).toThrow('capabilities_pending')
      expect(delegated).toBe(0)
    } finally { await wire.dispose() }
  })

  test('floor official activation POST consumes real HTTP 204 and has no session writes', async () => {
    const methods: string[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      methods.push(`${request.method} ${new URL(request.url).pathname}`)
      return new Response(null, { status: 204 })
    } })
    const baseUrl = `http://127.0.0.1:${server.port}`
    const wire = new OpenCodeBoundedFetch(baseUrl, '2.0.0', '/TEST', 'Basic TEST')
    try {
      await OpenCode.make({ baseUrl, fetch: wire.fetch }).plugin.awaitActivation({ location: { directory: '/TEST' } })
      expect(methods).toEqual(['POST /api/plugin/await-activation'])
    } finally { await wire.dispose(); await server.stop(true) }
  })
})
