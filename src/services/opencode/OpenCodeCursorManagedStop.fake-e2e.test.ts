import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { stageCursorManagedAssets } from '../../../scripts/cursor-plugin/stage.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import { OpenCodeClientFactory, type OpenCodeClient } from './OpenCodeClientFactory.js'
import { CURSOR_MANAGED_ASSET_ROOT_ENV } from './OpenCodeCursorManagedAssets.js'
import { openCodeEventTranslator } from './OpenCodeEventTranslator.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import {
  execOpenCodePortableCommand,
  getOpenCodeVerboseModelsArgs,
} from './OpenCodeInventoryService.js'
import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
} from './OpenCodeManagedPaths.js'
import { OpenCodeProfileManager } from './OpenCodeProfileManager.js'

/**
 * The same managed Cursor path as the live E2E, driven by a fake native CLI so it
 * spends no Cursor subscription usage and stays runnable when an account is rate
 * limited. The live test remains the proof that the real CLI behaves this way.
 */
const MODEL = { providerID: 'cursor-acp', modelID: 'auto' } as const
const ENVIRONMENT_KEYS = [
  CLAUDE_MULTIMODEL_DATA_HOME_ENV, CLAUDE_MULTIMODEL_CACHE_HOME_ENV, CURSOR_MANAGED_ASSET_ROOT_ENV,
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CURSOR_AGENT_EXECUTABLE',
  'FAKE_CURSOR_PID_FILE',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL',
]

/**
 * Stands in for the desktop app's MCP server over HTTP, which is the transport
 * the product actually registers. A stdio stand-in would pass while the shipped
 * configuration could not connect at all.
 */
function serveAppMcpOverHttp(): { port: number; calls: () => number; stop: () => void } {
  let calls = 0
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    async fetch(request: Request) {
      // The client opens a GET stream and may DELETE the session. Declining the
      // stream is allowed and keeps this stand-in to the one path under test.
      if (request.method !== 'POST') {
        return new Response(null, { status: request.method === 'GET' ? 405 : 200 })
      }
      const body = await request.json() as { id?: number; method?: string }
      if (body.id === undefined) return new Response(null, { status: 202 })
      const result = body.method === 'initialize'
        ? {
          protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'agent-teams', version: '1' },
        }
        : body.method === 'tools/list'
          ? { tools: [{
            name: 'team_receipt', description: 'Returns an Agent Teams receipt.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          }] }
          : (calls += 1, { content: [{ type: 'text', text: 'receipt' }] })
      return Response.json({ jsonrpc: '2.0', id: body.id, result },
        { headers: { 'content-type': 'application/json' } })
    },
  })
  return { port: server.port, calls: () => calls, stop: () => server.stop(true) }
}

/** The fake records its own pid, so Stop has something observable to end. */
function agentPid(pidFile: string): number {
  try {
    return Number.parseInt(execFileSync('/bin/cat', [pidFile], { encoding: 'utf8' }).trim(), 10) || 0
  } catch {
    return 0
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function summarize(client: OpenCodeClient, sessionId: string) {
  const [statuses, messages] = await Promise.all([
    client.getSessionStatus(), client.getSessionMessages(sessionId),
  ])
  return openCodeEventTranslator.reconcileSessionMessages({
    sessionId, rawStatus: statuses[sessionId] ?? null, messages,
  })
}

/**
 * Speaks the same stream-json contract the plugin parses, and resolves MCP the way
 * the native CLI does: from the workspace registration file, over HTTP JSON-RPC.
 * A prompt containing SLOW keeps the turn open so Stop lands while the tree is alive.
 */
function fakeCursorAgentSource(): string {
  return [
    '#!/usr/bin/env node',
    "const { readFileSync } = require('node:fs')",
    "const path = require('node:path')",
    "if (process.argv.includes('status')) { console.log('Logged in as fake@example.com'); process.exit(0) }",
    "if (process.argv.includes('--version')) { console.log('fake-cursor-agent 0.0.0'); process.exit(0) }",
    `require('node:fs').writeFileSync(process.env.FAKE_CURSOR_PID_FILE, String(process.pid))`,
    "let prompt = ''",
    "try { prompt = readFileSync(0, 'utf8') } catch { prompt = '' }",
    "// A follow-up carries the whole conversation, so only the newest turn counts.",
    "const tokens = [...prompt.matchAll(/TOKEN:([A-Za-z0-9-]+)/g)].map(m => m[1])",
    "const token = tokens.length > 0 ? tokens[tokens.length - 1] : 'no-token'",
    "const slow = /SLOW TOKEN:[A-Za-z0-9-]+\\s*$/.test(prompt.trim())",
    "const challenges = [...prompt.matchAll(/MCP:([A-Za-z0-9-]+)/g)].map(m => m[1])",
    "// Only the newest instruction counts: history repeats every earlier marker.",
    "const lastMcpAt = prompt.lastIndexOf('MCP:')",
    "const lastTokenAt = prompt.lastIndexOf('TOKEN:')",
    "const challenge = challenges.length > 0 && lastMcpAt > lastTokenAt",
    "  ? challenges[challenges.length - 1] : null",
    "const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')",
    "const say = text => emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })",
    "process.on('SIGTERM', () => process.exit(143))",
    '',
    'async function callRegisteredMcpTool(value) {',
    "  const workspace = process.argv[process.argv.indexOf('--workspace') + 1] || process.cwd()",
    "  const registration = JSON.parse(readFileSync(path.join(workspace, '.cursor/mcp.json'), 'utf8'))",
    '  const [name, server] = Object.entries(registration.mcpServers || {})',
    "    .find(([, entry]) => entry && entry.type === 'http' && entry.url) || []",
    '  if (!server) throw new Error(\'No HTTP MCP server registered for this workspace\')',
    '  let id = 0',
    '  const rpc = async (method, params) => {',
    '    const response = await fetch(server.url, {',
    "      method: 'POST', headers: { 'content-type': 'application/json' },",
    "      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),",
    '    })',
    '    const body = await response.json()',
    '    if (body.error) throw new Error(JSON.stringify(body.error))',
    '    return body.result',
    '  }',
    "  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })",
    "  const listed = await rpc('tools/list', {})",
    '  const tool = (listed.tools || [])[0]',
    "  if (!tool) throw new Error('Registered MCP server exposed no tools')",
    "  const called = await rpc('tools/call', { name: tool.name, arguments: { challenge: value } })",
    "  return (called.content || []).map(part => part.text).filter(Boolean).join('') || 'empty-mcp-result'",
    '}',
    '',
    'async function main() {',
    '  if (challenge) {',
    '    const text = await callRegisteredMcpTool(challenge)',
    '    say(text)',
    "    emit({ type: 'result', subtype: 'success', result: text })",
    '    process.exit(0)',
    '  }',
    '  if (!slow) {',
    '    say(token)',
    "    emit({ type: 'result', subtype: 'success', result: token })",
    '    process.exit(0)',
    '  }',
    '  let count = 0',
    '  setInterval(() => {',
    '    count += 1',
    '    say(`${token}-${count}`)',
    '    if (count >= 600) process.exit(0)',
    '  }, 100)',
    '}',
    'main().catch(error => { process.stderr.write(String(error && error.message) + String.fromCharCode(10)); process.exit(1) })',
    '',
  ].join('\n')
}

describe('OpenCode managed Cursor Stop fake e2e', () => {
  test.skipIf(process.platform !== 'darwin')(
    'runs a managed turn, stops it and leaves siblings and later turns working',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-managed-fake-e2e-'))
      const projectPath = path.join(root, 'project')
      const pidFile = path.join(root, 'agent.pid')
      const original = Object.fromEntries(ENVIRONMENT_KEYS.map(key => [key, process.env[key]]))
      let appMcp: { port: number; calls: () => number; stop: () => void } | null = null
      let hostManager: OpenCodeHostManager | null = null
      let hostKey: string | null = null
      try {
        await mkdir(projectPath, { recursive: true })
        await Promise.all(['source-config', 'source-data', 'source-cache']
          .map(dir => mkdir(path.join(root, dir), { recursive: true })))
        await stageCursorManagedAssets(path.join(root, 'assets'))
        const fakeAgent = path.join(root, 'cursor-agent')
        await writeFile(fakeAgent, fakeCursorAgentSource(), 'utf8')
        await chmod(fakeAgent, 0o700)

        process.env[CURSOR_MANAGED_ASSET_ROOT_ENV] = path.join(root, 'assets')
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(root, 'managed-data')
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(root, 'managed-cache')
        process.env.XDG_CONFIG_HOME = path.join(root, 'source-config')
        process.env.XDG_DATA_HOME = path.join(root, 'source-data')
        process.env.XDG_CACHE_HOME = path.join(root, 'source-cache')
        process.env.CURSOR_AGENT_EXECUTABLE = fakeAgent
        process.env.FAKE_CURSOR_PID_FILE = pidFile
        appMcp = serveAppMcpOverHttp()
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL =
          `http://127.0.0.1:${appMcp.port}/mcp`

        const profileManager = new OpenCodeProfileManager()
        const profile = await profileManager.prepareProfile(projectPath, {
          includeAppMcp: true, includeManagedSubscriptionPlugins: true, toolApprovalMode: 'auto',
        })
        const assignedPort = profile.env.AGENT_TEAMS_CURSOR_PROXY_PORT
        expect(JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT ?? '{}').plugin)
          .toContain(path.join(root, 'assets/plugin/dist/plugin-entry.js'))
        expect(Number(assignedPort)).toBeGreaterThan(1024)
        expect(assignedPort).not.toBe('32124')
        expect(profile.env.AGENT_TEAMS_CURSOR_READINESS).toMatch(/^[a-f0-9]{64}$/)
        // OpenCode merges this file with OPENCODE_CONFIG_CONTENT. Arrays append,
        // so a `plugin` key here loads the plugin twice and the launch readiness
        // authority rejects the host on selected_config_match:plugin.
        const bridgeConfig = JSON.parse(await readFile(
          path.join(profile.xdgConfigHome, 'opencode', 'opencode.json'), 'utf8'))
        expect(Object.keys(bridgeConfig.mcp ?? {})).toContain('agent-teams')
        expect(bridgeConfig).not.toHaveProperty('plugin')
        // The agent must be able to reach this profile's MCP servers.
        expect(await readFile(path.join(profile.profileRootPath,
          'native-subscription-cli-bin/cursor-agent'), 'utf8')).toContain('OPENCODE_CONFIG=')

        const binaryPath = resolveOpenCodeBinaryPath()
        if (!binaryPath) throw new Error('OpenCode binary is unavailable for the managed Cursor fake E2E')
        const cold = await execOpenCodePortableCommand({
          binaryPath, args: getOpenCodeVerboseModelsArgs(), profile, timeoutMs: 300_000,
        })
        expect(cold.code, (cold.stderr || cold.stdout).slice(-800)).toBe(0)

        hostManager = new OpenCodeHostManager({
          prepareProfile: profileManager.prepareProfile.bind(profileManager),
          persistentRegistryPath: path.join(root, 'persistent-hosts.json'),
        })
        const host = await hostManager.ensureHost({
          projectPath, preparedProfile: profile, hostLifetime: 'process', healthTimeoutMs: 120_000,
        })
        hostKey = host.hostKey
        const client = new OpenCodeClientFactory().create(host.baseUrl)
        expect((await client.getProviders()).connected).toContain('cursor-acp')
        // The product path for App MCP: the plugin bridge reads the materialized
        // config and publishes each App MCP tool as a first-class OpenCode tool,
        // so an agent reaches Agent Teams without any ~/.cursor registration.
        const toolIds = await fetch(new URL('/experimental/tool/ids', host.baseUrl))
          .then(response => response.json() as Promise<string[]>)
        expect(toolIds).toContain('mcp__agent_teams__team_receipt')

        const stopped = await client.createSession({ title: `FAKE_MANAGED_STOP ${randomUUID()}` })
        const sibling = await client.createSession({ title: `FAKE_MANAGED_SIBLING ${randomUUID()}` })
        const prompt = (sessionId: string, text: string) => client.promptSessionAsync(sessionId, {
          agent: 'teammate', model: MODEL, parts: [{ type: 'text', text }],
        })
        const replied = async (sessionId: string, token: string) => {
          const summary = await summarize(client, sessionId)
          return summary.durableState === 'idle' && Boolean(summary.latestAssistantText?.includes(token))
        }

        const warmToken = `warm-${randomUUID().slice(0, 8)}`
        await prompt(stopped.id, `TOKEN:${warmToken}`)
        await until('managed turn', () => replied(stopped.id, warmToken), 180_000)

        // An Agent Teams style MCP tool must reach the native CLI from its own
        // registration and return through the managed turn, not around it.
        const challenge = randomUUID()
        let mcpCalls = 0
        let receipt = ''
        const mcpServer = Bun.serve({
          hostname: '127.0.0.1', port: 0, idleTimeout: 0,
          async fetch(request: Request) {
            const body = await request.json() as Record<string, any>
            let result: unknown = {}
            if (body.method === 'initialize') {
              result = {
                protocolVersion: '2024-11-05', capabilities: { tools: {} },
                serverInfo: { name: 'agent-teams-fake-e2e', version: '1' },
              }
            }
            if (body.method === 'tools/list') {
              result = { tools: [{
                name: 'team_receipt',
                description: 'Returns a server-generated receipt that cannot be guessed.',
                inputSchema: {
                  type: 'object', properties: { challenge: { type: 'string' } },
                  required: ['challenge'], additionalProperties: false,
                },
              }] }
            }
            if (body.method === 'tools/call') {
              mcpCalls += 1
              expect(body.params?.arguments?.challenge).toBe(challenge)
              receipt = `receipt-${randomUUID().slice(0, 8)}`
              result = { content: [{ type: 'text', text: receipt }] }
            }
            return Response.json({ jsonrpc: '2.0', id: body.id, result })
          },
        })
        try {
          await mkdir(path.join(projectPath, '.cursor'), { recursive: true })
          await writeFile(path.join(projectPath, '.cursor/mcp.json'), `${JSON.stringify({
            mcpServers: { 'agent-teams': { type: 'http', url: `http://127.0.0.1:${mcpServer.port}/mcp` } },
          }, null, 2)}\n`, 'utf8')
          await prompt(stopped.id, `MCP:${challenge}`)
          await until('MCP result inside the managed turn',
            () => replied(stopped.id, receipt || '\u0000'), 180_000)
        } finally {
          mcpServer.stop(true)
        }
        expect(mcpCalls).toBe(1)

        // A completed turn must never seal the session.
        const followUpToken = `followup-${randomUUID().slice(0, 8)}`
        await prompt(stopped.id, `TOKEN:${followUpToken}`)
        await until('follow-up turn', () => replied(stopped.id, followUpToken), 180_000)

        await prompt(stopped.id, `SLOW TOKEN:slow-${randomUUID().slice(0, 8)}`)
        let running = 0
        await until('a live agent process', () => {
          running = agentPid(pidFile)
          return running > 0 && alive(running)
        }, 120_000)

        // Stop is the transport abort. The plugin cancels the request on that
        // signal and ends the agent child with it; nothing else is required.
        expect(await client.abortSession(stopped.id)).toBe(true)
        await sleep(2500)
        expect(alive(running)).toBe(false)
        const textAfterStop = (await summarize(client, stopped.id)).latestAssistantText ?? ''
        await sleep(2000)
        expect((await summarize(client, stopped.id)).latestAssistantText ?? '').toBe(textAfterStop)

        // A repeated Stop on an already stopped session stays harmless.
        expect(await client.abortSession(stopped.id)).toBe(true)

        const siblingToken = `sibling-${randomUUID().slice(0, 8)}`
        await prompt(sibling.id, `TOKEN:${siblingToken}`)
        await until('sibling turn after Stop', () => replied(sibling.id, siblingToken), 180_000)
        expect(JSON.stringify((await summarize(client, sibling.id)).messages)).not.toContain(warmToken)
        expect(alive(running)).toBe(false)
      } finally {
        appMcp?.stop()
        if (hostManager && hostKey) {
          await hostManager.releaseHost(hostKey).catch(() => undefined)
          await hostManager.disposeHost(hostKey).catch(() => undefined)
        }
        for (const [key, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        await rm(root, { recursive: true, force: true }).catch(() => undefined)
      }
    }, 600_000)
})
