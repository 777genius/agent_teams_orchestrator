import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON',
]

describe('Cursor App MCP live e2e', () => {
  liveTest('a Cursor agent calls an App MCP tool without touching the user Cursor config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-app-mcp-live-'))
    const projectPath = path.join(root, 'project')
    const callLog = path.join(root, 'calls.jsonl')
    const token = `receipt-${randomUUID().slice(0, 8)}`
    const userCursorConfig = path.join(os.homedir(), '.cursor', 'mcp.json')
    const original = Object.fromEntries(ENVIRONMENT_KEYS.map(key => [key, process.env[key]]))
    let hostManager: OpenCodeHostManager | null = null
    let hostKey: string | null = null
    try {
      const userConfigBefore = await readFile(userCursorConfig, 'utf8').catch(() => null)
      await mkdir(projectPath, { recursive: true })
      await Promise.all(['source-config', 'source-data', 'source-cache']
        .map(dir => mkdir(path.join(root, dir), { recursive: true })))
      await stageCursorManagedAssets(path.join(root, 'assets'))

      const sdk = (file: string) => JSON.stringify(pathToFileURL(path.join(
        import.meta.dir, `../../../node_modules/@modelcontextprotocol/sdk/dist/esm/${file}`)).href)
      const serverPath = path.join(root, 'app-mcp-server.mjs')
      await writeFile(serverPath, [
        "import { appendFile } from 'node:fs/promises'",
        `import { Server } from ${sdk('server/index.js')}`,
        `import { StdioServerTransport } from ${sdk('server/stdio.js')}`,
        `import { CallToolRequestSchema, ListToolsRequestSchema } from ${sdk('types.js')}`,
        "const server = new Server({ name: 'agent-teams', version: '1.0.0' }, { capabilities: { tools: {} } })",
        'server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{',
        "  name: 'team_receipt',",
        "  description: 'Returns an Agent Teams receipt that cannot be guessed.',",
        "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
        '}] }))',
        'server.setRequestHandler(CallToolRequestSchema, async request => {',
        `  await appendFile(${JSON.stringify(callLog)}, JSON.stringify({ tool: request.params.name }) + '\\n', 'utf8')`,
        `  return { content: [{ type: 'text', text: ${JSON.stringify(token)} }] }`,
        '})',
        'await server.connect(new StdioServerTransport())',
      ].join('\n') + '\n', 'utf8')

      process.env[CURSOR_MANAGED_ASSET_ROOT_ENV] = path.join(root, 'assets')
      process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(root, 'managed-data')
      process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(root, 'managed-cache')
      process.env.XDG_CONFIG_HOME = path.join(root, 'source-config')
      process.env.XDG_DATA_HOME = path.join(root, 'source-data')
      process.env.XDG_CACHE_HOME = path.join(root, 'source-cache')
      // Stand in for the desktop app's MCP server through the supported override.
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = process.execPath
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = JSON.stringify([serverPath])

      const profileManager = new OpenCodeProfileManager()
      const profile = await profileManager.prepareProfile(projectPath, {
        includeAppMcp: true, includeManagedSubscriptionPlugins: true, toolApprovalMode: 'auto',
      })
      // The bridge only discovers servers from a config file, so it must exist.
      const configFile = path.join(profile.xdgConfigHome, 'opencode', 'opencode.json')
      expect(Object.keys(JSON.parse(await readFile(configFile, 'utf8')).mcp ?? {}))
        .toContain('agent-teams')
      expect(await readFile(path.join(profile.profileRootPath,
        'native-subscription-cli-bin/mcptool'), 'utf8')).toContain('mcptool.js')

      const binaryPath = resolveOpenCodeBinaryPath()
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
      const session = await client.createSession({ title: `app mcp ${token}` })
      await client.promptSessionAsync(session.id, {
        agent: 'teammate', model: { providerID: 'cursor-acp', modelID: 'auto' },
        parts: [{ type: 'text', text: [
          'Run this shell command exactly once: mcptool call agent-teams team_receipt',
          'Do not explore the project. Then reply with exactly what the tool returned.',
        ].join('\n') }],
      })

      const deadline = Date.now() + 300_000
      let assistantText = ''
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
        if (summary.durableState === 'idle') break
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      expect(await readFile(callLog, 'utf8').catch(() => '')).toContain('team_receipt')
      expect(assistantText).toContain(token)
      // The whole point of using the plugin's own bridge: the user's Cursor
      // configuration is never a party to this.
      expect(await readFile(userCursorConfig, 'utf8').catch(() => null)).toBe(userConfigBefore)
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
