import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { serveAppMcpOverHttp } from '../../../scripts/cursor-plugin/app-mcp-http-fixture.js'
import { stageCursorManagedAssets } from '../../../scripts/cursor-plugin/stage.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'
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
 * Spends real Cursor subscription usage, so it is opt-in.
 * Run with CURSOR_APP_MCP_LIVE_E2E=1 on a logged-in macOS host.
 *
 * Proves the supported path end to end: a real Cursor agent reaches an App MCP
 * server through the plugin's own bridge and its mcptool CLI, using only what
 * prepareProfile produced. The user's ~/.cursor is asserted untouched.
 */
const liveTest = process.env.CURSOR_APP_MCP_LIVE_E2E === '1' && process.platform === 'darwin'
  ? test
  : test.skip

const ENVIRONMENT_KEYS = [
  CLAUDE_MULTIMODEL_DATA_HOME_ENV, CLAUDE_MULTIMODEL_CACHE_HOME_ENV, CURSOR_MANAGED_ASSET_ROOT_ENV,
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON',
]

describe('Cursor App MCP live e2e', () => {
  liveTest('a Cursor agent calls an App MCP tool without touching the user Cursor config', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cursor-app-mcp-live-')))
    const projectPath = path.join(root, 'project')
    const sessionLabel = randomUUID()
    const userCursorConfig = path.join(os.homedir(), '.cursor', 'mcp.json')
    const original = Object.fromEntries(ENVIRONMENT_KEYS.map(key => [key, process.env[key]]))
    let hostManager: OpenCodeHostManager | null = null
    let hostKey: string | null = null
    let appMcp: ReturnType<typeof serveAppMcpOverHttp> | null = null
    const userConfigBefore = await readFile(userCursorConfig, 'utf8').catch(() => null)
    try {
      await mkdir(projectPath, { recursive: true })
      await Promise.all(['source-config', 'source-data', 'source-cache']
        .map(dir => mkdir(path.join(root, dir), { recursive: true })))
      await stageCursorManagedAssets(path.join(root, 'assets'))

      appMcp = serveAppMcpOverHttp()

      process.env[CURSOR_MANAGED_ASSET_ROOT_ENV] = path.join(root, 'assets')
      process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(root, 'managed-data')
      process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(root, 'managed-cache')
      process.env.XDG_CONFIG_HOME = path.join(root, 'source-config')
      process.env.XDG_DATA_HOME = path.join(root, 'source-data')
      process.env.XDG_CACHE_HOME = path.join(root, 'source-cache')
      // Stand in for the desktop app's MCP server through the supported override.
      delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
      delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
      delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = `http://127.0.0.1:${appMcp.port}/mcp`

      const profileManager = new OpenCodeProfileManager()
      const profile = await profileManager.prepareProfile(projectPath, {
        includeAppMcp: true, includeManagedSubscriptionPlugins: true, toolApprovalMode: 'auto',
      })
      // The bridge only discovers servers from a config file, so it must exist.
      const configFile = profile.env.OPENCODE_CONFIG!
      expect(Object.keys(JSON.parse(await readFile(configFile, 'utf8')).mcp ?? {}))
        .toContain('agent-teams')

      const binaryPath = await resolveOpenCodeBinaryPath()
      if (!binaryPath) throw new Error('OpenCode binary is unavailable for the App MCP live E2E')
      const cold = await execOpenCodePortableCommand({
        binaryPath, args: getOpenCodeVerboseModelsArgs(), profile, timeoutMs: 300_000,
      })
      expect(cold.code, (cold.stderr || cold.stdout).slice(-600)).toBe(0)

      hostManager = new OpenCodeHostManager({
        prepareProfile: profileManager.prepareProfile.bind(profileManager),
        persistentRegistryPath: path.join(root, 'hosts.json'),
      })
      const host = await hostManager.ensureHost({
        projectPath, preparedProfile: profile, hostLifetime: 'process', healthTimeoutMs: 120_000,
      })
      hostKey = host.hostKey
      const client = new OpenCodeClientFactory().create(host.baseUrl)
      const session = await client.createSession({ title: `app mcp ${sessionLabel}` })
      await client.promptSessionAsync(session.id, {
        agent: 'teammate', model: { providerID: 'cursor-acp', modelID: 'auto' },
        // Deliberately does not name a tool or a command: the agent must find
        // the App MCP tool from what the profile published to it.
        parts: [{ type: 'text', text: [
          'Get the Agent Teams receipt by calling the tool that returns it. Call it exactly once.',
          'Do not explore the project. Then reply with exactly what the tool returned, nothing else.',
        ].join('\n') }],
      })

      const deadline = Date.now() + 300_000
      let assistantText = ''
      let toolNames: string[] = []
      while (Date.now() < deadline) {
        const [statuses, messages] = await Promise.all([
          client.getSessionStatus(), client.getSessionMessages(session.id),
        ])
        if (/usage limit|ActionRequiredError/i.test(JSON.stringify(messages))) {
          throw new Error('Cursor account usage limit reached; the live E2E cannot spend a turn')
        }
        const summary = openCodeEventTranslator.reconcileSessionMessages({
          sessionId: session.id, rawStatus: statuses[session.id] ?? null, messages,
        })
        assistantText = summary.latestAssistantText ?? ''
        toolNames = messages.flatMap(message => (message.parts ?? [])
          .filter((part: { type?: string }) => part.type === 'tool')
          .map((part: { tool?: string; state?: { status?: string } }) =>
            `${part.tool}:${part.state?.status}`))
        if (summary.durableState === 'idle') break
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      // Printed so a failure names what the agent did instead of calling the tool.
      console.log('[live] tools:', JSON.stringify(toolNames))
      // Exactly one call: presence alone would hide a retry loop billing the user.
      expect(appMcp.calls.map(call => call.tool)).toEqual(['team_receipt'])
      expect(assistantText).toContain(appMcp.calls[0]!.receipt)
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
      // Check even when startup or the turn fails; never print config contents.
      const userConfigAfter = await readFile(userCursorConfig, 'utf8').catch(() => null)
      expect(userConfigAfter === userConfigBefore).toBe(true)
    }
  }, 900_000)
})
