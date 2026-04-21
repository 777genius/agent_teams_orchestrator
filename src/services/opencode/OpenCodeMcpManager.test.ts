import { describe, expect, test } from 'bun:test'

import {
  OpenCodeMcpManager,
  resolveOpenCodeAppMcpLaunchConfig,
} from './OpenCodeMcpManager.js'

describe('OpenCodeMcpManager', () => {
  test('treats an existing app MCP server as present without reattaching', async () => {
    let addCalls = 0

    const manager = new OpenCodeMcpManager({
      clientFactory: {
        create: () => ({
          getMcp: async () => ({
            'agent-teams': {
              connected: true,
            },
          }),
          addMcp: async () => {
            addCalls += 1
            return {}
          },
        }),
      },
      resolveLaunchConfig: async () => {
        throw new Error('not used')
      },
    })

    const result = await manager.ensureAppMcp({
      baseUrl: 'http://127.0.0.1:4096',
      attachIfMissing: true,
    })

    expect(result.summary.status).toBe('present')
    expect(result.summary.matchedServerName).toBe('agent-teams')
    expect(result.summary.connected).toBe(true)
    expect(addCalls).toBe(0)
  })

  test('attaches the app MCP server when missing', async () => {
    let addCalls = 0
    let attached = false

    const manager = new OpenCodeMcpManager({
      clientFactory: {
        create: () => ({
          getMcp: async () =>
            attached
              ? {
                  'agent-teams': {
                    connected: true,
                  },
                }
              : {},
          addMcp: async (_name, config) => {
            addCalls += 1
            attached = true
            expect(config.type).toBe('local')
            expect(Array.isArray(config.command)).toBe(true)
            return {
              'agent-teams': {
                connected: true,
              },
            }
          },
        }),
      },
      resolveLaunchConfig: async () => ({
        source: 'workspace-dist',
        config: {
          type: 'local',
          command: ['node', '/tmp/agent-teams-mcp.js'],
          environment: {
            HOME: '/Users/test',
          },
          enabled: true,
          timeout: 8000,
        },
      }),
    })

    const result = await manager.ensureAppMcp({
      baseUrl: 'http://127.0.0.1:4096',
      attachIfMissing: true,
    })

    expect(addCalls).toBe(1)
    expect(result.summary.status).toBe('attached')
    expect(result.summary.launchSource).toBe('workspace-dist')
    expect(result.summary.matchedServerName).toBe('agent-teams')
    expect(result.summary.connected).toBe(true)
  })

  test('returns attach_failed when the server is still absent after POST /mcp', async () => {
    const manager = new OpenCodeMcpManager({
      clientFactory: {
        create: () => ({
          getMcp: async () => ({}),
          addMcp: async () => ({}),
        }),
      },
      verifyTimeoutMs: 1,
      verifyPollMs: 0,
      sleepMs: async () => {},
      resolveLaunchConfig: async () => ({
        source: 'workspace-dist',
        config: {
          type: 'local',
          command: ['node', '/tmp/agent-teams-mcp.js'],
        },
      }),
    })

    const result = await manager.ensureAppMcp({
      baseUrl: 'http://127.0.0.1:4096',
      attachIfMissing: true,
    })

    expect(result.summary.status).toBe('attach_failed')
    expect(result.summary.diagnostics[0]).toContain('still absent from /mcp')
  })

  test('resolves env override MCP launch config without forwarding OpenCode runtime env', async () => {
    const result = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
        OPENCODE_CONFIG_CONTENT: '{"mcp":{}}',
        OPENCODE_SERVER_PASSWORD: 'secret',
        SAFE_ENV: 'forward-me',
        PATH: '/usr/local/bin:/usr/bin',
        CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43123',
      },
      pathExists: async () => false,
    })

    expect(result.source).toBe('env-override')
    expect(result.config).toMatchObject({
      type: 'local',
      command: ['/usr/local/bin/node', '/tmp/agent-teams-mcp.js'],
      enabled: true,
      timeout: 8000,
      environment: {
        PATH: '/usr/local/bin:/usr/bin',
        CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43123',
      },
    })
    expect(result.config.environment?.SAFE_ENV).toBeUndefined()
    expect(result.config.environment?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    expect(result.config.environment?.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  })
})
