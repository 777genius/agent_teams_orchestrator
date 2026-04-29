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
      'mcp_servers.agent-teams.default_tools_approval_mode="approve"',
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
        'mcp_servers.agent-teams.default_tools_approval_mode="approve"',
      ])
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })
})

afterEach(() => {
  delete process.env.TEAMS_ENV
})
