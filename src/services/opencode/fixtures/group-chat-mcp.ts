// Synthetic MCP boundary for the focused group bridge fixture. No user state.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { hasBoundGroupChatControl } from '../../../utils/groupChatControlClient.js'

const names: string[] = JSON.parse(process.env.SYNTHETIC_MCP_TOOL_NAMES ?? '[]')
const groupReady = process.env.SYNTHETIC_GROUP_TOOLS === '1' && hasBoundGroupChatControl()
if (groupReady) names.push('group_chat_list', 'mcp__agent-teams__group_chat_send')
const server = new Server({ name: 'synthetic-group-runtime', version: '1' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: names.map(name => ({ name, inputSchema: { type: 'object' as const, additionalProperties: true } })),
}))
server.setRequestHandler(CallToolRequestSchema, async request => {
  const args = request.params.arguments ?? {}
  if (!groupReady || !['group_chat_list', 'mcp__agent-teams__group_chat_send'].includes(request.params.name)) {
    return { isError: true, content: [{ type: 'text', text: 'Synthetic tool unavailable' }] }
  }
  const operation = request.params.name === 'group_chat_list' ? 'list' : 'send'
  const response = await fetch(`${process.env.AGENT_TEAMS_BOUND_CONTROL_URL}/api/teams/${encodeURIComponent(String(args.teamName))}/group-chats/${operation}`, {
    method: 'POST', redirect: 'error', headers: {
      'content-type': 'application/json', 'x-agent-teams-app-context': process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON!,
    }, body: JSON.stringify(args), signal: AbortSignal.timeout(5000),
  })
  return { isError: !response.ok, content: [{ type: 'text', text: await response.text() }] }
})
await server.connect(new StdioServerTransport())
