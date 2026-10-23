import { afterEach, expect, test } from 'bun:test'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
// The exact MCP client the current official runtime connects with.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createWindowsControllerRelayServer, createWindowsExecutionHttpClient, readWindowsRemoteController,
  routeWindowsControllerFetch, type WindowsRemoteController } from './OpenCodeV2WindowsHTTP.js'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))) })

/** TEST desktop endpoint: stateful Streamable HTTP MCP on one loopback path. */
async function startController(seen: IncomingHttpHeaders[] = []): Promise<WindowsRemoteController> {
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const server = createServer(async (request, response) => {
    seen.push(request.headers)
    if (request.url?.split('?')[0] !== '/mcp') { response.writeHead(404).end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
    const id = request.headers['mcp-session-id']
    let transport = typeof id === 'string' ? transports.get(id) : undefined
    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: value => { transports.set(value, transport!) } })
      const mcp = new McpServer({ name: 'TEST-agent-teams', version: '1.0.0' })
      mcp.registerTool('message_send', { inputSchema: { text: z.string() } },
        async ({ text }) => ({ content: [{ type: 'text', text: `TEST-ack:${text}` }] }))
      await mcp.connect(transport)
    }
    await transport.handleRequest(request, response, body)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp#agent-teams-app-instance=TEST-instance`
  const controller = readWindowsRemoteController(JSON.stringify({ mcp: { servers: { 'agent-teams': { type: 'remote', url, oauth: false } } } }))
  expect(controller?.url).toBe(url)
  return controller!
}

/** Member client and owner relay joined only by JSON frames, like the pipe. */
function relayPair(controller: WindowsRemoteController) {
  const failures = { member: 0, owner: 0 }
  const deliver = (target: (frame: unknown) => unknown) => async (frame: Record<string, unknown>) => {
    const copy = JSON.parse(JSON.stringify(frame)); setImmediate(() => target(copy))
  }
  let owner!: ReturnType<typeof createWindowsControllerRelayServer>
  const member = createWindowsExecutionHttpClient(deliver(frame => owner.accept(frame)),
    () => { failures.member++ }, 'windowsControllerHTTP')
  owner = createWindowsControllerRelayServer(controller, deliver(frame => member.accept(frame)), () => {
    failures.owner++; member.fail(new Error('TEST-owner-refused'))
  })
  member.bindOrigin(controller.origin)
  return { member, owner, failures }
}

test('only a plain-HTTP loopback remote agent-teams controller selects the relay', () => {
  const config = (server: unknown) => JSON.stringify({ mcp: { servers: { 'agent-teams': server } } })
  expect(readWindowsRemoteController(config({ type: 'local', command: ['TEST'] }))).toBeUndefined()
  expect(readWindowsRemoteController(config({ type: 'remote', url: 'https://TEST.invalid/mcp', oauth: false }))).toBeUndefined()
  expect(readWindowsRemoteController(JSON.stringify({ mcp: { servers: {} } }))).toBeUndefined()
  expect(readWindowsRemoteController(JSON.stringify({}))).toBeUndefined()
  expect(readWindowsRemoteController(config({ type: 'remote', url: 'http://127.0.0.1:1/mcp', headers: { 'X-TEST': 'v' } }))?.headerNames).toEqual(['x-test'])
})

test('the runtime MCP client reaches the sealed endpoint only through the owner relay', async () => {
  const controller = await startController()
  const { member, owner, failures } = relayPair(controller)
  const direct: unknown[][] = []
  const original = Object.assign(async (...args: unknown[]) => { direct.push(args); return new Response('TEST-direct') },
    { preconnect: () => {} }) as unknown as typeof globalThis.fetch
  const routed = routeWindowsControllerFetch(original, controller, request => member.fetch(request))

  // Another origin, another path or method on the endpoint origin, and Request
  // or URL inputs keep the original fetch and the exact original arguments.
  const init = { method: 'POST', body: 'TEST-provider' }
  const foreign = new Request('https://TEST-provider.invalid/v1'), other = new URL('/api/teams', controller.origin)
  for (const call of [['https://TEST-provider.invalid/v1', init], [foreign], [other], [controller.url, { method: 'PUT' }]] as const)
    expect(await (await routed(...(call as unknown as Parameters<typeof fetch>))).text()).toBe('TEST-direct')
  expect(direct).toEqual([['https://TEST-provider.invalid/v1', init], [foreign, undefined], [other, undefined], [controller.url, { method: 'PUT' }]])

  const url = new URL(controller.url); url.searchParams.set('codemode', 'false')
  const client = new Client({ name: 'TEST-member', version: '1.0.0' }, { capabilities: { roots: {} } })
  const transport = new StreamableHTTPClientTransport(url, { fetch: routed })
  await client.connect(transport)
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['message_send'])
  expect(await client.callTool({ name: 'message_send', arguments: { text: 'TEST-hello' } }))
    .toMatchObject({ content: [{ type: 'text', text: 'TEST-ack:TEST-hello' }] })
  await transport.terminateSession()
  await client.close()
  expect(direct).toHaveLength(4)
  expect(failures).toEqual({ member: 0, owner: 0 })
  await member.close(); await owner.close()
})

test('the owner relay forwards only Streamable HTTP request fields and refuses other paths or methods', async () => {
  const seen: IncomingHttpHeaders[] = []
  const controller = await startController(seen)
  const pair = relayPair(controller)
  const response = await pair.member.fetch(new Request(new URL(controller.pathname, controller.origin), { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'TEST-session',
      'x-test-forbidden': 'TEST', upgrade: 'websocket', connection: 'upgrade', expect: '100-continue', te: 'trailers',
      'proxy-authorization': 'TEST' }, body: '{}' }))
  await response.arrayBuffer()
  expect(seen).toHaveLength(1)
  expect(seen[0]!['mcp-session-id']).toBe('TEST-session')
  for (const name of ['x-test-forbidden', 'upgrade', 'expect', 'te', 'proxy-authorization']) expect(seen[0]![name]).toBeUndefined()
  expect(seen[0]!.connection).not.toBe('upgrade')
  expect(seen[0]!.host).toBe(new URL(controller.origin).host)
  await pair.member.close(); await pair.owner.close()

  for (const request of [new Request(`${controller.origin}/api/teams`), new Request(new URL(controller.pathname, controller.origin), { method: 'PUT', body: '{}' })]) {
    const refused = relayPair(controller)
    await expect(refused.member.fetch(request)).rejects.toThrow()
    // The refused request and its follow-up cancel are both protocol violations.
    expect(refused.failures.owner).toBeGreaterThanOrEqual(1)
    await refused.owner.close()
  }
  expect(seen).toHaveLength(1)
})

test('a late owner reply after the member close drain never tears down the control pipe carrying the closed ACK', async () => {
  // Isolate the TEST child-control mock so it cannot alter another test's pipe.
  const childControl = pathToFileURL(import.meta.dir + '/OpenCodeV2WindowsChildControl.ts').href
  const relayModule = pathToFileURL(import.meta.dir + '/OpenCodeV2WindowsHTTP.ts').href
  const script = `
    const { mock } = await import('bun:test');
    const { EventEmitter } = await import('node:events');
    const events = new EventEmitter(), sent = [];
    let disconnects = 0;
    const control = { events, connected: () => true, send: async frame => { sent.push(frame) }, disconnect: () => { disconnects++ } };
    mock.module(${JSON.stringify(childControl)}, () => ({ windowsExecutionChildControl: () => control,
      windowsExecutionSelfBirth: () => ({ format: 'windows-filetime', value: '1', bootId: null }) }));
    const { bindWindowsControllerRelay, readWindowsRemoteController } = await import(${JSON.stringify(relayModule)});
    const controller = readWindowsRemoteController(JSON.stringify({ mcp: { servers: { 'agent-teams': { type: 'remote', url: 'http://127.0.0.1:9/mcp', oauth: false } } } }));
    const original = globalThis.fetch;
    // The member's open standalone SSE stream, whose cancel the owner never answers in time.
    async function openStream() {
      const response = globalThis.fetch(controller.url, { method: 'GET', headers: { accept: 'text/event-stream' } });
      await new Promise(resolve => setTimeout(resolve, 10));
      const request = sent.findLast(frame => frame.action === 'request');
      return { request, response };
    }
    const result = {};
    {
      // Protocol violation on a live relay: the control pipe is still torn down.
      disconnects = 0;
      const relay = bindWindowsControllerRelay(controller), { request, response } = await openStream();
      void response.catch(() => undefined);
      events.emit('message', { type: 'windowsControllerHTTP', id: request.id, action: 'head', status: 99, statusText: '', headers: [], body: true });
      await new Promise(resolve => setTimeout(resolve, 10));
      result.violation = disconnects;
      await relay.close();
    }
    {
      disconnects = 0;
      const relay = bindWindowsControllerRelay(controller), { request, response } = await openStream();
      events.emit('message', { type: 'windowsControllerHTTP', id: request.id, action: 'head', status: 200, statusText: 'OK',
        headers: [['content-type', 'text/event-stream']], body: true });
      await response;
      await relay.close();
      await new Promise(resolve => setTimeout(resolve, 50));
      result.lateReply = { disconnects, cancelled: sent.some(frame => frame.id === request.id && frame.action === 'cancel'),
        fetchRestored: globalThis.fetch === original };
    }
    console.log(JSON.stringify(result));
  `
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(exit).toBe(0); expect(stderr).toBe('')
  const value = JSON.parse(stdout)
  expect(value.violation).toBe(1)
  // The drain failed the stream locally; the shared pipe stays up for the ACK.
  expect(value.lateReply).toEqual({ disconnects: 0, cancelled: true, fetchRestored: true })
}, 30_000)
