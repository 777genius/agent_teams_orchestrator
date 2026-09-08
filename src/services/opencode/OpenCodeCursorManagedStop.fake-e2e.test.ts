import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { serveAppMcpOverHttp } from '../../../scripts/cursor-plugin/app-mcp-http-fixture.js'
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
 * Speaks the plugin stream-json contract and invokes the managed mcptool shim.
 * The staged CLI discovers App HTTP MCP through the materialized profile config.
 * A prompt containing SLOW keeps the turn open so Stop lands while the tree is alive.
 */
function fakeCursorAgentSource(): string {
  return [
    '#!/usr/bin/env node',
    "const { readFileSync } = require('node:fs')",
    "const { execFileSync } = require('node:child_process')",
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
    "  return execFileSync('mcptool', ['call', 'agent-teams', 'team_receipt', JSON.stringify({ challenge: value })], { encoding: 'utf8', timeout: 30000 })",
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
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cursor-managed-fake-e2e-')))
      const projectPath = path.join(root, 'project')
      const pidFile = path.join(root, 'agent.pid')
      const original = Object.fromEntries(ENVIRONMENT_KEYS.map(key => [key, process.env[key]]))
      let appMcp: ReturnType<typeof serveAppMcpOverHttp> | null = null
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
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
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
        expect(await readFile(profile.env.CURSOR_AGENT_EXECUTABLE!, 'utf8')).toContain('OPENCODE_CONFIG=')
        expect(await readFile(path.join(path.dirname(profile.env.CURSOR_AGENT_EXECUTABLE!), 'mcptool'), 'utf8'))
          .toContain('assets/plugin/dist/cli/mcptool.js')

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

        // A session is retired when the managed auth import changes, so the
        // runtime rewriting its own auth store during a turn would silently end
        // every session after the first message.
        const managedAuthPath = path.join(profile.xdgDataHome, 'opencode', 'auth.json')
        const managedAuthBytes = async () =>
          await readFile(managedAuthPath, 'utf8').catch(() => '<absent>')
        const authBeforeTurn = await managedAuthBytes()

        const warmToken = `warm-${randomUUID().slice(0, 8)}`
        await prompt(stopped.id, `TOKEN:${warmToken}`)
        await until('managed turn', () => replied(stopped.id, warmToken), 180_000)

        // Invoke the real staged CLI through the managed shim, against the same
        // App server whose tool the first-class bridge published above.
        const challenge = randomUUID()
        expect(appMcp.calls).toHaveLength(0)
        await prompt(stopped.id, `MCP:${challenge}`)
        await until('MCP result inside the managed turn',
          () => replied(stopped.id, appMcp!.calls[0]?.receipt || '\u0000'), 180_000)
        expect(appMcp.calls).toHaveLength(1)
        expect(appMcp.calls[0]).toMatchObject({ tool: 'team_receipt', arguments: { challenge } })

        expect(await managedAuthBytes()).toBe(authBeforeTurn)

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

        // This host test observes parent exit and text. Ordinary descendant and
        // delayed-effect coverage lives in the focused transport fixture.
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
