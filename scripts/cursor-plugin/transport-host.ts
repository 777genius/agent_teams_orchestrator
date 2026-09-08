import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [artifact, readyPath] = process.argv.slice(2)
if (!artifact || !readyPath) throw new Error('Missing transport fixture paths')

// Exercise the distributed entrypoint and ordinary hooks, not private exports.
const plugin = (await import(pathToFileURL(artifact).href)).default
const hooks = await plugin({
  directory: process.cwd(),
  worktree: process.cwd(),
  client: {},
  serverUrl: new URL('http://127.0.0.1:1'),
})
await hooks.auth.loader(async () => ({ type: 'api', key: 'cursor-agent' }))
const output = { options: {} as Record<string, unknown> }
await hooks['chat.params']({ model: { providerID: 'cursor-acp', id: 'auto' } }, output)
const headers: Record<string, Record<string, string>> = {}
if (process.env.AGENT_TEAMS_CURSOR_CONTROL_DIR) {
  for (const [name, sessionID] of [['a', 'session-a'], ['b', 'session-b'], ['followup', 'session-b']]) {
    const result = { headers: {} }
    await hooks['chat.headers']({ model: { providerID: 'cursor-acp', id: 'auto' }, sessionID, message: { id: `message-${name}` } }, result)
    headers[name!] = result.headers
  }
}
const mcpResults: Record<string, unknown> = {}
if (process.env.CURSOR_TRANSPORT_TEST_MCP) {
  for (const name of ['receipt', 'failure', 'protocol']) {
    try { mcpResults[name] = await hooks.tool[`mcp__fixture__${name}`].execute({ id: 'bridge' }, {}) }
    catch { mcpResults[name] = { failed: true } }
  }
}
await writeFile(readyPath, JSON.stringify({ baseURL: output.options.baseURL, headers, mcpResults }))
