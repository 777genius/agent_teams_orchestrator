import { randomUUID } from 'node:crypto'

/** One App HTTP endpoint for discovery and real staged bridge/CLI calls. */
export function serveAppMcpOverHttp() {
  const calls: Array<{ tool: string; arguments: unknown; receipt: string }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    async fetch(request: Request) {
      if (request.method !== 'POST') {
        return new Response(null, { status: request.method === 'GET' ? 405 : 200 })
      }
      const body = await request.json() as {
        id?: number | string; method?: string
        params?: { name?: string; arguments?: unknown }
      }
      if (body.id === undefined) return new Response(null, { status: 202 })
      let result: unknown
      if (body.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'agent-teams', version: '1' } }
      } else if (body.method === 'tools/list') {
        result = { tools: [{ name: 'team_receipt', description: 'Returns an Agent Teams receipt.',
          inputSchema: { type: 'object', properties: { challenge: { type: 'string' } }, additionalProperties: false } }] }
      } else if (body.method === 'tools/call' && body.params?.name === 'team_receipt') {
        const receipt = `receipt-${randomUUID()}`
        calls.push({ tool: body.params.name, arguments: body.params.arguments, receipt })
        result = { content: [{ type: 'text', text: receipt }] }
      } else {
        return Response.json({ jsonrpc: '2.0', id: body.id,
          error: { code: -32601, message: 'Unknown method or tool' } })
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    },
  })
  return { port: server.port, calls, stop: () => server.stop(true) }
}
