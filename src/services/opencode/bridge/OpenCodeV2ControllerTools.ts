import { constants } from 'node:fs'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { executionAssert, executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { ExecutionBridgeClient, ExecutionMcpConfig } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import type { SelectedExecutionProfile } from '../host/OpenCodeV2ExecutionHost.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'

export type ControllerToolProof = Readonly<{
  server: string; configHash: string; schemasHash: string
  tools: readonly Readonly<{ name: string; inputSchema: Readonly<Record<string, unknown>> }>[]
  nativeNames: readonly string[]
}>

/** Direct tools/list and native connection are joined to the same selected config transport.
 * Requested tool names are not schema evidence. The probe never calls a controller tool. */
export async function readOwnedControllerTools(client: ExecutionBridgeClient, profile: SelectedExecutionProfile,
  server: string, deadline: number, signal?: AbortSignal): Promise<ControllerToolProof> {
  const config = executionRecord(executionRecord(executionRecord(JSON.parse(profile.config.content)).mcp).servers)[server] as ExecutionMcpConfig
  executionAssert(config && config.disabled !== true && server === 'agent-teams', 'run_controller_config_unknown')
  const check = () => { signal?.throwIfAborted(); executionAssert(Date.now() < deadline, 'run_controller_timeout') }
  const connected = async () => {
    check(); const servers = await client.mcp(); check()
    executionAssert(servers.filter(row => row.name === server && row.status === 'connected').length === 1, 'run_controller_mcp_unknown')
  }
  await connected()
  const sdk = new Client({ name: 'agent-teams-v2-source-schema-proof', version: '1.0.0' })
  const transport = config.type === 'local'
    ? new StdioClientTransport({ command: config.command[0] ?? '', args: [...config.command.slice(1)],
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }), env: { ...profile.env, ...config.environment }, stderr: 'ignore' })
    : new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers, signal } })
  try {
    await boundOpenCodeRead(sdk.connect(transport), Math.max(1, deadline - Date.now()), signal)
    const tools: { name: string; inputSchema: Record<string, unknown> }[] = []
    let cursor: string | undefined; const seen = new Set<string>()
    for (let page = 0; page < 8; page++) {
      check()
      const result = await sdk.listTools(cursor ? { cursor } : {}, { signal, timeout: Math.max(1, deadline - Date.now()) })
      for (const tool of result.tools) {
        executionAssert(tool.name.length > 0 && !tools.some(row => row.name === tool.name) && tools.length < 256, 'run_controller_schemas_unknown')
        const schema = executionRecord(tool.inputSchema)
        executionAssert(schema.type === 'object', 'run_controller_schemas_unknown')
        tools.push({ name: tool.name, inputSchema: schema })
      }
      if (!result.nextCursor) { cursor = undefined; break }
      executionAssert(!seen.has(result.nextCursor), 'run_controller_schemas_unknown'); seen.add(result.nextCursor); cursor = result.nextCursor
    }
    executionAssert(cursor === undefined && tools.some(tool => /(?:^|_)message_send$/.test(tool.name)), 'run_controller_schemas_unknown')
    await connected()
    const nativeNames = tools.map(tool => `${server}_${tool.name}`)
    return Object.freeze({ server, configHash: executionHash(config), schemasHash: executionHash(tools),
      tools: Object.freeze(tools), nativeNames: Object.freeze(nativeNames) })
  } finally {
    await boundOpenCodeRead(sdk.close(), 2000).catch(() => undefined)
    await boundOpenCodeRead(transport.close(), 2000).catch(() => undefined)
  }
}

export type ControllerInboxBinding = Readonly<{ teamId: string; runId: string; memberId: string; sessionID: string }>
export type ControllerInboxProof = Readonly<{
  binding: ControllerInboxBinding
  messages: readonly Readonly<{ messageId: string; from: string; to: string; text: string;
    timestamp: string; read: boolean; relayOfMessageId?: string; source?: string }>[]
}>

/** Read only the canonical selected local controller inbox. Native output cannot supply this proof. */
export async function readOwnedControllerInbox(profile: SelectedExecutionProfile, proof: ControllerToolProof,
  binding: ControllerInboxBinding, deadline: number, signal?: AbortSignal): Promise<ControllerInboxProof | null> {
  const config = executionRecord(executionRecord(executionRecord(JSON.parse(profile.config.content)).mcp).servers)[proof.server] as ExecutionMcpConfig
  executionAssert(proof.server === 'agent-teams' && config && executionHash(config) === proof.configHash, 'run_controller_config_unknown')
  if (config.type !== 'local') return null
  const root = config.environment?.AGENT_TEAMS_MCP_CLAUDE_DIR
  if (!root) return null
  executionAssert(path.isAbsolute(root) && path.resolve(root) === root &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(binding.teamId), 'run_controller_inbox_unknown')
  const check = () => { signal?.throwIfAborted(); executionAssert(Date.now() < deadline, 'run_controller_timeout') }
  const handles: FileHandle[] = []
  const limit = 4 * 1024 * 1024
  try {
    let expected = root
    let address = root
    for (const segment of ['', 'teams', binding.teamId, 'inboxes']) {
      check()
      if (segment) { expected = path.join(expected, segment); address = `/proc/self/fd/${handles.at(-1)!.fd}/${segment}` }
      const handle = await open(address, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      handles.push(handle)
      const stat = await handle.stat()
      executionAssert(stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0 &&
        await realpath(`/proc/self/fd/${handle.fd}`) === expected, 'run_controller_inbox_unknown')
    }
    check()
    expected = path.join(expected, 'user.json')
    const file = await open(`/proc/self/fd/${handles.at(-1)!.fd}/user.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    handles.push(file)
    const before = await file.stat()
    executionAssert(before.isFile() && before.uid === process.getuid?.() && (before.mode & 0o022) === 0 &&
      before.size <= limit && await realpath(`/proc/self/fd/${file.fd}`) === expected, 'run_controller_inbox_unknown')
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      check()
      const read = await file.read(bytes, length, bytes.length - length, length)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    const after = await file.stat()
    executionAssert(length <= limit && before.size === length && after.size === before.size &&
      after.mtimeMs === before.mtimeMs && await realpath(`/proc/self/fd/${file.fd}`) === expected,
      'run_controller_inbox_unknown')
    const rows: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'))
    executionAssert(Array.isArray(rows) && rows.length <= 4096, 'run_controller_inbox_unknown')
    const messages = rows.map(value => {
      const row = executionRecord(value)
      executionAssert(['messageId', 'from', 'to', 'text', 'timestamp'].every(key => typeof row[key] === 'string' && row[key].length > 0) &&
        typeof row.read === 'boolean' && (row.relayOfMessageId === undefined || typeof row.relayOfMessageId === 'string') &&
        (row.source === undefined || typeof row.source === 'string'), 'run_controller_inbox_unknown')
      return Object.freeze({ messageId: row.messageId as string, from: row.from as string, to: row.to as string,
        text: row.text as string, timestamp: row.timestamp as string, read: row.read as boolean,
        ...(row.relayOfMessageId === undefined ? {} : { relayOfMessageId: row.relayOfMessageId as string }),
        ...(row.source === undefined ? {} : { source: row.source as string }) })
    })
    check()
    return Object.freeze({ binding: Object.freeze({ ...binding }), messages: Object.freeze(messages) })
  } catch (error) {
    // A pending native turn need not have created its inbox yet. No missing file grants a receipt.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ binding: Object.freeze({ ...binding }), messages: [] })
    throw error
  } finally { for (const handle of handles.reverse()) await handle.close() }
}
