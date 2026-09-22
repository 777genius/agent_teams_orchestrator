import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  getFlagSettingsInline,
  setFlagMcpConfig,
  setFlagSettingsInline,
  setStrictMcpConfig,
} from '../../bootstrap/state.js'
import type { SDKMessage, SDKUserMessageReplay } from '../../entrypoints/agentSdkTypes.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'
import { buildCodexNativeExecArgs } from './execRunner.js'
import { executeCodexNativeTurn } from './turnExecutor.js'

function baseParams(overrides: Partial<Parameters<typeof executeCodexNativeTurn>[0]> = {}) {
  return {
    prompt: 'Reply only with OK',
    cwd: '/tmp/demo',
    model: 'gpt-5.4-mini',
    effortValue: 'low' as const,
    permissionMode: 'bypassPermissions' as const,
    additionalWritableDirectories: [],
    persistSession: false,
    replayedUserMessages: [] as SDKUserMessageReplay[],
    transcriptMessages: [],
    mutableMessages: [],
    totalUsage: EMPTY_USAGE,
    permissionDenials: [],
    initialAppState: {
      fastMode: false,
    } as never,
    startTime: Date.now() - 10,
    setSDKStatus: () => {},
    ...overrides,
  }
}

async function drain(iterator: AsyncGenerator<SDKMessage, unknown, unknown>): Promise<void> {
  while (!(await iterator.next()).done) {}
}

afterEach(() => {
  setFlagMcpConfig([])
  setStrictMcpConfig(false)
})

describe('Codex Native strict MCP launch safe e2e', () => {
  test('strict MCP launch reads app-generated Agent Teams MCP only config files', async () => {
    const previousSettings = getFlagSettingsInline()
    const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-apponly-mcp-'))
    let execArgs: string[] | undefined

    try {
      const configPath = join(tempDirectory, 'agent-teams-app-only.json')
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            'agent-teams': {
              command: '/mock/node',
              args: ['/mock/agent-teams/dist/index.js'],
              enabled: true,
              env: {
                AGENT_TEAMS_MCP_CLAUDE_DIR: '/mock/.claude',
              },
            },
          },
        }),
        'utf8',
      )

      setStrictMcpConfig(true)
      setFlagSettingsInline({
        codex: {
          forced_login_method: 'chatgpt',
        },
      })
      setFlagMcpConfig([configPath])

      await drain(
        executeCodexNativeTurn(baseParams(), {
          runExec: async function* (options) {
            execArgs = buildCodexNativeExecArgs(options)
            yield {
              type: 'normalized_event',
              event: {
                type: 'assistant_text',
                itemId: 'item_0',
                text: 'OK',
              },
            }
            yield {
              type: 'normalized_event',
              event: { type: 'turn_completed' },
            }
            return {
              identity: {
                executablePath: '/usr/local/bin/codex',
                executableSource: 'system-path',
                version: 'codex-cli 0.117.0',
              },
              threadId: null,
              credentialSource: 'none',
              completionPolicy: 'ephemeral',
              finalHistoryCompleteness: 'live-only',
              finalUsageAuthority: 'live-turn-completed',
            }
          },
        }),
      )

      expect(execArgs).toContain('--ignore-user-config')
      expect(execArgs).toContain('mcp_servers.agent-teams.command="/mock/node"')
      expect(execArgs).toContain(
        'mcp_servers.agent-teams.args=["/mock/agent-teams/dist/index.js"]',
      )
      expect(execArgs).toContain(
        'mcp_servers.agent-teams.env.AGENT_TEAMS_MCP_CLAUDE_DIR="/mock/.claude"',
      )
      expect(execArgs).toContain(
        'mcp_servers.agent-teams.default_tools_approval_mode="approve"',
      )
      expect(execArgs).not.toContain('mcp_servers.agent-teams.enabled=true')
      expect(execArgs).toContain('forced_login_method="chatgpt"')
    } finally {
      setFlagSettingsInline(previousSettings)
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })

  test('strict MCP launch ignores user config while preserving agent-teams MCP overrides', async () => {
    const previousSettings = getFlagSettingsInline()
    let execArgs: string[] | undefined

    try {
      setStrictMcpConfig(true)
      setFlagSettingsInline({
        codex: {
          forced_login_method: 'chatgpt',
        },
      })
      setFlagMcpConfig([
        JSON.stringify({
          mcpServers: {
            'agent-teams': {
              command: '/usr/local/bin/node',
              args: ['/tmp/agent-teams/index.js'],
              env: {
                AGENT_TEAMS_MCP_CLAUDE_DIR: '/tmp/.claude',
              },
            },
          },
        }),
      ])

      await drain(
        executeCodexNativeTurn(baseParams(), {
          runExec: async function* (options) {
            execArgs = buildCodexNativeExecArgs(options)
            yield {
              type: 'normalized_event',
              event: {
                type: 'assistant_text',
                itemId: 'item_0',
                text: 'OK',
              },
            }
            yield {
              type: 'normalized_event',
              event: { type: 'turn_completed' },
            }
            return {
              identity: {
                executablePath: '/usr/local/bin/codex',
                executableSource: 'system-path',
                version: 'codex-cli 0.117.0',
              },
              threadId: null,
              credentialSource: 'none',
              completionPolicy: 'ephemeral',
              finalHistoryCompleteness: 'live-only',
              finalUsageAuthority: 'live-turn-completed',
            }
          },
        }),
      )

      expect(execArgs).toContain('--ignore-user-config')
      expect(execArgs).toContain('mcp_servers.agent-teams.command="/usr/local/bin/node"')
      expect(execArgs).toContain('mcp_servers.agent-teams.args=["/tmp/agent-teams/index.js"]')
      expect(execArgs).toContain(
        'mcp_servers.agent-teams.env.AGENT_TEAMS_MCP_CLAUDE_DIR="/tmp/.claude"',
      )
      expect(execArgs).toContain(
        'mcp_servers.agent-teams.default_tools_approval_mode="approve"',
      )
      expect(execArgs).toContain('forced_login_method="chatgpt"')
    } finally {
      setFlagSettingsInline(previousSettings)
    }
  })

  test('strict MCP launch lets the newest agent-teams config shadow stale dynamic entries', async () => {
    const previousSettings = getFlagSettingsInline()
    const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-shadow-mcp-'))
    let execArgs: string[] | undefined

    try {
      const staleConfigPath = join(tempDirectory, 'stale-agent-teams.json')
      const appOnlyConfigPath = join(tempDirectory, 'app-only-agent-teams.json')
      await writeFile(
        staleConfigPath,
        JSON.stringify({
          mcpServers: {
            'agent-teams': {
              command: '/stale/node',
              args: ['/stale/agent-teams/index.js'],
              env: {
                AGENT_TEAMS_MCP_CLAUDE_DIR: '/stale/.claude',
              },
            },
          },
        }),
        'utf8',
      )
      await writeFile(
        appOnlyConfigPath,
        JSON.stringify({
          mcpServers: {
            'agent-teams': {
              command: '/fresh/node',
              args: ['/fresh/agent-teams/index.js'],
              env: {
                AGENT_TEAMS_MCP_CLAUDE_DIR: '/fresh/.claude',
              },
            },
          },
        }),
        'utf8',
      )

      setStrictMcpConfig(true)
      setFlagSettingsInline({
        codex: {
          forced_login_method: 'chatgpt',
        },
      })
      setFlagMcpConfig([staleConfigPath, appOnlyConfigPath])

      await drain(
        executeCodexNativeTurn(baseParams(), {
          runExec: async function* (options) {
            execArgs = buildCodexNativeExecArgs(options)
            yield {
              type: 'normalized_event',
              event: {
                type: 'assistant_text',
                itemId: 'item_0',
                text: 'OK',
              },
            }
            yield {
              type: 'normalized_event',
              event: { type: 'turn_completed' },
            }
            return {
              identity: {
                executablePath: '/usr/local/bin/codex',
                executableSource: 'system-path',
                version: 'codex-cli 0.117.0',
              },
              threadId: null,
              credentialSource: 'none',
              completionPolicy: 'ephemeral',
              finalHistoryCompleteness: 'live-only',
              finalUsageAuthority: 'live-turn-completed',
            }
          },
        }),
      )

      expect(execArgs).toContain('--ignore-user-config')
      expect(execArgs).toContain('mcp_servers.agent-teams.command="/fresh/node"')
      expect(execArgs).toContain('mcp_servers.agent-teams.args=["/fresh/agent-teams/index.js"]')
      expect(execArgs).toContain(
        'mcp_servers.agent-teams.env.AGENT_TEAMS_MCP_CLAUDE_DIR="/fresh/.claude"',
      )
      expect(execArgs).not.toContain('mcp_servers.agent-teams.command="/stale/node"')
      expect(execArgs).not.toContain('mcp_servers.agent-teams.args=["/stale/agent-teams/index.js"]')
      expect(execArgs).not.toContain(
        'mcp_servers.agent-teams.env.AGENT_TEAMS_MCP_CLAUDE_DIR="/stale/.claude"',
      )
    } finally {
      setFlagSettingsInline(previousSettings)
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })

  test('strict MCP launch fails closed when the app-generated config file is missing', async () => {
    const previousSettings = getFlagSettingsInline()
    const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-missing-mcp-'))
    let execStarted = false

    try {
      const missingConfigPath = join(tempDirectory, 'missing app-only mcp.json')
      const params = baseParams({
        mutableMessages: [],
        transcriptMessages: [],
      })

      setStrictMcpConfig(true)
      setFlagSettingsInline({
        codex: {
          forced_login_method: 'chatgpt',
        },
      })
      setFlagMcpConfig([missingConfigPath])

      await drain(
        executeCodexNativeTurn(params, {
          runExec: async function* () {
            execStarted = true
            throw new Error('native exec must not start without agent-teams MCP config')
          },
        }),
      )

      expect(execStarted).toBe(false)
      expect(JSON.stringify(params.mutableMessages)).toContain(
        'Strict Codex MCP launch could not load dynamic MCP config',
      )
      expect(JSON.stringify(params.mutableMessages)).toContain(missingConfigPath)
    } finally {
      setFlagSettingsInline(previousSettings)
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })
})
