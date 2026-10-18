import { ClientError, OpenCode } from '@opencode/client-v2-floor'
import type { ExecutionOperations } from './OpenCodeV2ExecutionClientFactory.js'
import type { OpenCodeV2ExecutionFetch } from './OpenCodeV2ExecutionFetch.js'

// Loaded only after the factory qualifies this selected pin's installed graph.
export const executionFloorClientErrorPrototype: object = ClientError.prototype

/** Exact floor Promise API stays private to this adapter. */
export function executionFloorOperations(baseUrl: string, directory: string, wire: OpenCodeV2ExecutionFetch, bridgeFetch: typeof globalThis.fetch): ExecutionOperations {
  const sdk = OpenCode.make({ baseUrl, fetch: wire.fetch })
  const bridge = OpenCode.make({ baseUrl, fetch: bridgeFetch })
  return {
    identity: () => sdk.health.get(),
    location: () => sdk.location.get({ location: { directory } }),
    config: () => sdk.config.get({ location: { directory } }),
    ready: async () => { await sdk.plugin.awaitActivation({ location: { directory } }); wire.check() },
    agent: agentID => sdk.agent.get({ location: { directory }, agentID }),
    models: () => sdk.model.list({ location: { directory } }),
    create: input => sdk.session.create({ id: input.sessionID, title: input.title, agent: input.agent,
      model: input.model, location: { directory } }),
    get: sessionID => sdk.session.get({ sessionID }),
    prompt: (sessionID, input) => sdk.session.prompt({ sessionID, id: input.nativeInputID, text: input.text,
      files: input.files, agents: input.agents, skills: input.skills, delivery: 'queue', resume: input.resume }),
    inbox: sessionID => sdk.session.inbox.list({ sessionID }),
    messages: (sessionID, cursor) => sdk.message.list({ sessionID, cursor, limit: 200, ...(cursor === undefined ? { order: 'asc' as const } : {}) }),
    log: (sessionID, after) => sdk.session.log({ sessionID, after, follow: false }),
    putInstruction: (sessionID, key, value) => bridge.session.instructions.entry.put({ sessionID, key, value }),
    instructions: sessionID => bridge.session.instructions.entry.list({ sessionID }),
    interrupt: sessionID => bridge.session.interrupt({ sessionID, continue: false }),
    cancelInbox: (sessionID, inboxID) => bridge.session.inbox.cancel({ sessionID, inboxID }),
    addMcp: (server, config) => bridge.mcp.add({ location: { directory }, server, config }),
    connectMcp: server => bridge.mcp.connect({ location: { directory }, server }),
    disconnectMcp: server => bridge.mcp.disconnect({ location: { directory }, server }),
    mcp: () => bridge.mcp.list({ location: { directory } }),
    permissions: sessionID => bridge.permission.list({ sessionID }),
    permission: (sessionID, requestID) => bridge.permission.get({ sessionID, requestID }),
    replyPermission: (sessionID, requestID, decision) => bridge.permission.reply({ sessionID, requestID, reply: decision }),
  }
}
