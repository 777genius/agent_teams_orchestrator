import { expect } from 'bun:test'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

/** Transport compatibility only. The inspected OpenCode checkout at
 * 417435f750ed322a4c26efd7e14bc035e230eb9e uses node:http + NodeHttpServer,
 * not Bun.serve/Hono: packages/opencode/src/server/server.ts:201-216.
 * Its permission handler uses HttpServerResponse.empty/jsonUnsafe. Load those
 * actual installed implementations without importing OpenCode's app, providers,
 * provenance initialization or project startup. No response Connection override,
 * socket.end(), or listener shutdown is used to manufacture response EOF.
 * The source root may be relocated by the root-run sandbox gate.
 */
export async function openCodeHttpServerFixture(status: number, receipt: unknown) {
  expect(Bun.version).toBe('1.3.11')
  const sourceRoot = process.env.CLAUDE_TEAM_OPENCODE_HTTP_SERVER_SOURCE_ROOT
  if (!sourceRoot) throw new Error('Explicit OpenCode compatibility source root required')
  const packageRoot = join(sourceRoot, 'packages/opencode')
  const serverSource = await readFile(join(packageRoot, 'src/server/server.ts'), 'utf8')
  // Fail on implementation drift instead of silently qualifying another stack.
  expect(serverSource).toContain('import { createServer } from "node:http"')
  expect(serverSource).toContain('NodeHttpServer.layer(() => server,')
  const adapterManifest = JSON.parse(await readFile(
    Bun.resolveSync('@effect/platform-node/package.json', packageRoot), 'utf8'))
  expect(adapterManifest.version).toBe('4.0.0-beta.83')
  const [NodeHttpServer, Effect, Scope, Exit, HttpServerResponse] = await Promise.all([
    import(Bun.resolveSync('@effect/platform-node/NodeHttpServer', packageRoot)),
    import(Bun.resolveSync('effect/Effect', packageRoot)),
    import(Bun.resolveSync('effect/Scope', packageRoot)),
    import(Bun.resolveSync('effect/Exit', packageRoot)),
    import(Bun.resolveSync('effect/unstable/http/HttpServerResponse', packageRoot)),
  ])
  const scope = Scope.makeUnsafe()
  const handler = await Effect.runPromise(NodeHttpServer.makeHandler(Effect.sync(() => status === 200
    ? HttpServerResponse.jsonUnsafe(receipt)
    : HttpServerResponse.empty({ status })), { scope }))
  const requests: Array<{ method: string | undefined; url: string | undefined; headers: IncomingHttpHeaders
    peerAddress: string | undefined; peerPort: number | undefined; body: Buffer }> = []
  const failures: unknown[] = []
  const server = createServer((request, response) => {
    const observed = { method: request.method, url: request.url, headers: request.headers,
      peerAddress: request.socket.remoteAddress, peerPort: request.socket.remotePort, body: Buffer.alloc(0) }
    requests.push(observed)
    void (async () => {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk)
        size += bytes.length
        if (size > 16 * 1024) throw new Error('Compatibility request exceeded bound')
        chunks.push(bytes)
      }
      observed.body = Buffer.concat(chunks)
      handler(request, response)
    })().catch(error => { failures.push(error); response.destroy() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: (server.address() as AddressInfo).port, requests, failures,
    async close() {
      const closed = new Promise<void>(resolve => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
      await Effect.runPromise(Scope.close(scope, Exit.void))
    },
  }
}
