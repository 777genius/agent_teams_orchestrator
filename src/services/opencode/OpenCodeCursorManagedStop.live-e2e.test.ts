import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { stageCursorManagedAssets } from '../../../scripts/cursor-plugin/stage.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import { OpenCodeClientFactory, type OpenCodeClient } from './OpenCodeClientFactory.js'
import { CURSOR_MANAGED_ASSET_ROOT_ENV } from './OpenCodeCursorManagedAssets.js'
import { stopCursorSessionWithNativeCleanup } from './OpenCodeCursorStopControl.js'
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
 * Spends real Cursor subscription usage, so it is opt-in.
 * Run with CURSOR_MANAGED_STOP_LIVE_E2E=1 on a logged-in macOS host.
 */
const liveTest = process.env.CURSOR_MANAGED_STOP_LIVE_E2E === '1' && process.platform === 'darwin'
  ? test
  : test.skip

const MODEL = { providerID: 'cursor-acp', modelID: 'auto' } as const
const ENVIRONMENT_KEYS = [
  CLAUDE_MULTIMODEL_DATA_HOME_ENV, CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CURSOR_MANAGED_ASSET_ROOT_ENV, 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
]

/**
 * Exec-time environment survives detach and reparenting, so this finds every
 * process the supervisor owns. Only pids are kept: the rest is foreign data.
 */
function supervisedPids(): number[] {
  const snapshot = execFileSync('/bin/ps', ['-Eww', '-ax', '-o', 'pid=,command='],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 4000, env: { PATH: '/bin:/usr/bin' } })
  return [...new Set(snapshot.split('\n')
    .filter(line => line.includes('CURSOR_OWNER_SCOPE='))
    .map(line => Number.parseInt(line, 10))
    .filter(pid => Number.isSafeInteger(pid) && pid > 1))]
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(500)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function summarize(client: OpenCodeClient, sessionId: string) {
  const [statuses, messages] = await Promise.all([
    client.getSessionStatus(), client.getSessionMessages(sessionId),
  ])
  const summary = openCodeEventTranslator.reconcileSessionMessages({
    sessionId, rawStatus: statuses[sessionId] ?? null, messages,
  })
  // An exhausted Cursor subscription otherwise surfaces only as a turn that never
  // settles, which reads like a product defect instead of an account limit.
  if (/usage limit|ActionRequiredError/i.test(JSON.stringify(messages))) {
    throw new Error('Cursor account usage limit reached; the live E2E cannot spend a turn')
  }
  return summary
}

/**
 * The Cursor native CLI restores the host home, so an Agent Teams MCP server is
 * only visible to a Cursor agent from `~/.cursor/mcp.json`. This mirrors the
 * shipped registration exactly, and removes exactly the entry it created.
 */
async function withCursorHomeMcpServer<T>(
  serverName: string,
  url: string,
  run: () => Promise<T>,
): Promise<T> {
  const configPath = path.join(os.homedir(), '.cursor', 'mcp.json')
  const desired = { type: 'http', url }
  const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>
  const writeConfig = async (value: Record<string, unknown>, suffix: string) => {
    const temp = `${configPath}.${serverName}.${suffix}.tmp`
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, configPath)
  }
  const before = await readConfig()
  if (Object.hasOwn(before.mcpServers ?? {}, serverName)) {
    throw new Error('Cursor MCP name collision; refusing to touch the user config')
  }
  await writeConfig({ ...before, mcpServers: { ...(before.mcpServers ?? {}), [serverName]: desired } }, 'add')
  try {
    return await run()
  } finally {
    const current = await readConfig()
    // Never delete an entry that stopped being ours between registration and cleanup.
    if (JSON.stringify(current.mcpServers?.[serverName]) === JSON.stringify(desired)) {
      const servers = { ...current.mcpServers }
      delete servers[serverName]
      await writeConfig({ ...current, mcpServers: servers }, 'remove')
    }
  }
}

async function replyContains(client: OpenCodeClient, sessionId: string, token: string) {
  const summary = await summarize(client, sessionId)
  return summary.durableState === 'idle' && Boolean(summary.latestAssistantText?.includes(token))
}

describe('OpenCode managed Cursor Stop live e2e', () => {
  liveTest('stops a live Cursor turn, leaves siblings alone and never replays a sealed prompt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-managed-stop-live-'))
    const projectPath = path.join(root, 'project')
    const original = Object.fromEntries(ENVIRONMENT_KEYS.map(key => [key, process.env[key]]))
    let hostManager: OpenCodeHostManager | null = null
    let hostKey: string | null = null
    try {
      await mkdir(projectPath, { recursive: true })
      await Promise.all(['source-config', 'source-data', 'source-cache']
        .map(dir => mkdir(path.join(root, dir), { recursive: true })))
      await stageCursorManagedAssets(path.join(root, 'assets'))
      process.env[CURSOR_MANAGED_ASSET_ROOT_ENV] = path.join(root, 'assets')
      process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(root, 'managed-data')
      process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(root, 'managed-cache')
      process.env.XDG_CONFIG_HOME = path.join(root, 'source-config')
      process.env.XDG_DATA_HOME = path.join(root, 'source-data')
      process.env.XDG_CACHE_HOME = path.join(root, 'source-cache')

      const profileManager = new OpenCodeProfileManager()
      const profile = await profileManager.prepareProfile(projectPath, {
        includeAppMcp: false, includeManagedSubscriptionPlugins: true, toolApprovalMode: 'auto',
      })
      // Staging must have replaced the upstream package and published the control scope.
      expect(JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT ?? '{}').plugin)
        .toContain(path.join(root, 'assets/plugin/dist/plugin-entry.js'))
      expect(profile.env.AGENT_TEAMS_CURSOR_CONTROL_DIR).toBeTruthy()
      // The provider endpoint and the plugin's bind target must be the same
      // profile-owned port, never the hijackable upstream default.
      const assignedPort = profile.env.AGENT_TEAMS_CURSOR_PROXY_PORT
      expect(Number(assignedPort)).toBeGreaterThan(1024)
      expect(assignedPort).not.toBe('32124')
      expect(JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT ?? '{}')
        .provider['cursor-acp'].options.baseURL).toBe(`http://127.0.0.1:${assignedPort}/v1`)

      const binaryPath = resolveOpenCodeBinaryPath()
      if (!binaryPath) throw new Error('OpenCode binary is unavailable for the managed Cursor live E2E')
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

      const stopped = await client.createSession({ title: `MANAGED_STOP ${randomUUID()}` })
      const sibling = await client.createSession({ title: `MANAGED_SIBLING ${randomUUID()}` })
      const reply = (sessionId: string, token: string) => client.promptSessionAsync(sessionId, {
        agent: 'teammate', model: MODEL,
        parts: [{ type: 'text', text: `Reply with exactly this text and nothing else: ${token}` }],
      })

      const warmToken = `warm-${randomUUID().slice(0, 8)}`
      await reply(stopped.id, warmToken)
      await until('managed transport turn', () => replyContains(client, stopped.id, warmToken), 240_000)

      // An Agent Teams MCP tool must reach the Cursor agent through its own native
      // catalog while the turn is driven by OpenCode and supervised by the barrier.
      const challenge = randomUUID()
      let receipt = ''
      let toolCalls = 0
      const mcpServer = Bun.serve({
        hostname: '127.0.0.1', port: 0, idleTimeout: 0,
        async fetch(request: Request) {
          if (request.method !== 'POST') return new Response(null, { status: 405 })
          const body = await request.json() as Record<string, any>
          if (body.id === undefined) return new Response(null, { status: 202 })
          let result: unknown = {}
          if (body.method === 'initialize') {
            result = {
              protocolVersion: '2024-11-05', capabilities: { tools: {} },
              serverInfo: { name: 'agent-teams-live-e2e', version: '1' },
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
            toolCalls += 1
            expect(body.params?.arguments?.challenge).toBe(challenge)
            receipt = `receipt-${randomUUID().slice(0, 8)}`
            result = { content: [{ type: 'text', text: receipt }] }
          }
          return Response.json({ jsonrpc: '2.0', id: body.id, result })
        },
      })
      try {
        await withCursorHomeMcpServer(
          `agent-teams-live-e2e-${randomUUID().slice(0, 8)}`,
          `http://127.0.0.1:${mcpServer.port}/mcp`,
          async () => {
            await client.promptSessionAsync(stopped.id, {
              agent: 'teammate', model: MODEL,
              parts: [{ type: 'text', text: [
                `Call the team_receipt MCP tool exactly once with challenge "${challenge}".`,
                'Then reply with exactly the text it returned and nothing else.',
                'Do not use any other MCP server and do not run shell commands.',
              ].join('\n') }],
            })
            await until('Cursor native MCP tool result', async () => {
              const summary = await summarize(client, stopped.id)
              return summary.durableState === 'idle' && toolCalls > 0
                && Boolean(summary.latestAssistantText?.includes(receipt))
            }, 300_000)
          },
        )
      } finally {
        mcpServer.stop(true)
      }
      expect(toolCalls).toBe(1)

      // A completed turn must never seal the session.
      const followUpToken = `followup-${randomUUID().slice(0, 8)}`
      await reply(stopped.id, followUpToken)
      await until('follow-up turn', () => replyContains(client, stopped.id, followUpToken), 240_000)

      await client.promptSessionAsync(stopped.id, {
        agent: 'teammate', model: MODEL,
        parts: [{ type: 'text', text: 'Write the numbers from 1 to 400, one per line, with no commentary or tools.' }],
      })
      let owned: number[] = []
      await until('supervised Cursor processes', () => {
        owned = supervisedPids()
        return owned.length > 0
      }, 240_000)
      const textBeforeStop = (await summarize(client, stopped.id)).latestAssistantText ?? ''

      expect(await stopCursorSessionWithNativeCleanup({
        profile, runtimePid: host.pid, sessionId: stopped.id,
        abortTransport: () => client.abortSession(stopped.id),
      })).toBe(true)
      await sleep(3000)
      expect(owned.filter(alive)).toEqual([])
      const textAfterStop = (await summarize(client, stopped.id)).latestAssistantText ?? ''
      await sleep(2500)
      expect((await summarize(client, stopped.id)).latestAssistantText ?? '').toBe(textAfterStop)
      expect(textAfterStop.length).toBeGreaterThanOrEqual(textBeforeStop.length)

      // A sealed session answers repeated Stops without reopening.
      expect(await stopCursorSessionWithNativeCleanup({
        profile, runtimePid: host.pid, sessionId: stopped.id,
        abortTransport: () => client.abortSession(stopped.id),
      })).toBe(true)

      const relaunchToken = `relaunch-${randomUUID().slice(0, 8)}`
      await reply(sibling.id, relaunchToken)
      await until('sibling turn after Stop', () => replyContains(client, sibling.id, relaunchToken), 240_000)
      const siblingSummary = await summarize(client, sibling.id)
      expect(JSON.stringify(siblingSummary.messages)).not.toContain(warmToken)
      expect(supervisedPids().filter(pid => owned.includes(pid))).toEqual([])
    } finally {
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
  }, 900_000)
})
