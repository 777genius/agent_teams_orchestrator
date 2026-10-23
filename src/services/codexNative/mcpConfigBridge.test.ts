import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildCodexNativeMcpConfigOverrides } from './mcpConfigBridge.js'

describe('buildCodexNativeMcpConfigOverrides', () => {
  test('bridges dynamic stdio MCP configs into codex -c overrides and auto-approves agent-teams tools', () => {
    const overrides = buildCodexNativeMcpConfigOverrides({
      mcpConfigEntries: [
        JSON.stringify({
          mcpServers: {
            'agent-teams': {
              command: '/usr/local/bin/node',
              args: ['/tmp/agent-teams/index.js'],
              env: {
                TEAMS_ENV: '1',
              },
            },
          },
        }),
      ],
    })

    expect(overrides).toEqual([
      'mcp_servers.agent-teams.command="/usr/local/bin/node"',
      'mcp_servers.agent-teams.args=["/tmp/agent-teams/index.js"]',
      'mcp_servers.agent-teams.env.TEAMS_ENV="1"',
      'mcp_servers.agent-teams.required=true',
      'mcp_servers.agent-teams.default_tools_approval_mode="approve"',
    ])
  })

  test('does not require unrelated optional MCP servers', () => {
    const overrides = buildCodexNativeMcpConfigOverrides({
      mcpConfigEntries: [JSON.stringify({ mcpServers: {
        optional: { command: '/TEST/optional', args: [] },
      } })],
    })
    expect(overrides).toEqual([
      'mcp_servers.optional.command="/TEST/optional"',
      'mcp_servers.optional.args=[]',
    ])
  })

  test('bridges MCP env vars as nested TOML keys instead of JSON strings', () => {
    const overrides = buildCodexNativeMcpConfigOverrides({
      mcpConfigEntries: [
        JSON.stringify({
          mcpServers: {
            'agent-teams': {
              command: '/usr/local/bin/node',
              args: ['/tmp/agent-teams/index.js'],
              env: {
                AGENT_TEAMS_MCP_CLAUDE_DIR: '/tmp/app/.claude',
                'AGENT-TEAMS-MODE': 'test',
              },
            },
          },
        }),
      ],
    })

    expect(overrides).toContain(
      'mcp_servers.agent-teams.env.AGENT_TEAMS_MCP_CLAUDE_DIR="/tmp/app/.claude"',
    )
    expect(overrides).toContain(
      'mcp_servers.agent-teams.env.AGENT-TEAMS-MODE="test"',
    )
    expect(overrides.some(override => override.includes('env={'))).toBe(false)
  })

  test('parses file-based dynamic MCP config entries', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-native-mcp-'))
    try {
      const configPath = join(tempDirectory, 'mcp.json')
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            'agent-teams': {
              command: '/opt/homebrew/bin/node',
              args: ['/tmp/mcp/index.js'],
            },
          },
        }),
        'utf8',
      )

      const overrides = buildCodexNativeMcpConfigOverrides({
        mcpConfigEntries: [configPath],
      })

      expect(overrides).toEqual([
        'mcp_servers.agent-teams.command="/opt/homebrew/bin/node"',
        'mcp_servers.agent-teams.args=["/tmp/mcp/index.js"]',
        'mcp_servers.agent-teams.required=true',
        'mcp_servers.agent-teams.default_tools_approval_mode="approve"',
      ])
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })

  test('fails closed for strict MCP launches when the dynamic config cannot be loaded', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-native-missing-mcp-'))
    try {
      const missingConfigPath = join(tempDirectory, 'missing app-only mcp.json')

      expect(() =>
        buildCodexNativeMcpConfigOverrides({
          mcpConfigEntries: [missingConfigPath],
          strictMcpConfig: true,
        }),
      ).toThrow('Strict Codex MCP launch could not load dynamic MCP config')
      expect(
        buildCodexNativeMcpConfigOverrides({
          mcpConfigEntries: [missingConfigPath],
          strictMcpConfig: false,
        }),
      ).toEqual([])
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })

  test('fails closed for strict MCP launches when agent-teams is absent', () => {
    expect(() =>
      buildCodexNativeMcpConfigOverrides({
        mcpConfigEntries: [
          JSON.stringify({
            mcpServers: {
              tavily: {
                command: '/usr/local/bin/node',
                args: ['/tmp/tavily/index.js'],
              },
            },
          }),
        ],
        strictMcpConfig: true,
      }),
    ).toThrow('Strict Codex MCP launch did not load the required agent-teams MCP server')
  })
})

afterEach(() => {
  delete process.env.TEAMS_ENV
})
