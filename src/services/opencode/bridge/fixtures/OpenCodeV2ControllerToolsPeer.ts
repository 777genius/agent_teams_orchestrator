import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
// Synthetic controller contract only. No native host, model, auth, or tool effects.
const server = new Server({ name: 'TEST-controller-schema-peer', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...(process.argv.includes('--group-tools') ? ['group_chat_list', 'group_chat_send', 'group_chat_react'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) : []), { name: 'message_send',
  description: 'TEST schema only', inputSchema: { type: 'object', properties: {
    text: { type: 'string' }, relayOfMessageId: { type: 'string' } }, required: ['text'] } }] }))
await server.connect(new StdioServerTransport())
