import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import {
  getCandidateClaudeTeamRootsForBridgeRoot,
  OpenCodeMcpManager,
  resolveOpenCodeAppMcpLaunchConfig,
} from './OpenCodeMcpManager.js'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

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

  test('reattaches an existing app MCP server when the forced Claude root changed', async () => {
    let addCalls = 0
    let currentMcp: Record<
      string,
      {
        connected: boolean
        command?: string[]
        environment?: Record<string, string>
      }
    > = {
      'agent-teams': {
        connected: true,
        command: ['node', '/tmp/agent-teams-mcp.js'],
        environment: {
          AGENT_TEAMS_MCP_CLAUDE_DIR: '/tmp/old-claude-root',
        },
      },
    }

    const manager = new OpenCodeMcpManager({
      clientFactory: {
        create: () => ({
          getMcp: async () => currentMcp,
          addMcp: async (_name, config) => {
            addCalls += 1
            currentMcp = {
              'agent-teams': {
                connected: true,
                command: config.command ?? [],
                environment: config.environment ?? {},
              },
            }
            return currentMcp
          },
        }),
      },
      env: {
        AGENT_TEAMS_MCP_CLAUDE_DIR: '/tmp/current-claude-root',
      },
      resolveLaunchConfig: async () => ({
        source: 'env-override',
        config: {
          type: 'local',
          command: ['node', '/tmp/agent-teams-mcp.js'],
          environment: {
            AGENT_TEAMS_MCP_CLAUDE_DIR: '/tmp/current-claude-root',
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
    expect(result.summary.launchSource).toBe('env-override')
    expect(result.summary.diagnostics[0]).toContain('Reattached stale OpenCode app MCP server')
    expect(currentMcp['agent-teams'].environment.AGENT_TEAMS_MCP_CLAUDE_DIR).toBe(
      '/tmp/current-claude-root',
    )
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

  test('dedupes concurrent app MCP attach attempts for the same host', async () => {
    let addCalls = 0
    let attached = false
    let releaseAttach: (() => void) | null = null
    const attachStarted = new Promise<void>(resolve => {
      releaseAttach = resolve
    })

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
          addMcp: async () => {
            addCalls += 1
            await attachStarted
            attached = true
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
        },
      }),
    })

    const first = manager.ensureAppMcp({
      baseUrl: 'http://127.0.0.1:4096',
      attachIfMissing: true,
    })
    const second = manager.ensureAppMcp({
      baseUrl: 'http://127.0.0.1:4096',
      attachIfMissing: true,
    })

    releaseAttach?.()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(addCalls).toBe(1)
    expect(firstResult.summary.connected).toBe(true)
    expect(secondResult.summary.connected).toBe(true)
  })

  test('reattaches a disconnected app MCP server when OpenCode connect fails', async () => {
    let addCalls = 0
    let connectCalls = 0
    let currentMcp = {
      'agent-teams': {
        connected: false,
      },
    }

    const manager = new OpenCodeMcpManager({
      clientFactory: {
        create: () => ({
          getMcp: async () => currentMcp,
          connectMcp: async () => {
            connectCalls += 1
            throw new Error('Unable to connect. Is the computer able to access the url?')
          },
          addMcp: async () => {
            addCalls += 1
            currentMcp = {
              'agent-teams': {
                connected: true,
              },
            }
            return currentMcp
          },
        }),
      },
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

    expect(connectCalls).toBe(1)
    expect(addCalls).toBe(1)
    expect(result.summary.status).toBe('attached')
    expect(result.summary.connected).toBe(true)
    expect(result.summary.diagnostics[0]).toContain(
      'Reattached OpenCode app MCP server after connect failed',
    )
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
        AGENT_TEAMS_MCP_CLAUDE_DIR: '/Users/test/.claude',
      },
      pathExists: async () => false,
    })

    expect(result.source).toBe('env-override')
    expect(result.config).toMatchObject({
      type: 'local',
      command: ['/usr/local/bin/node', path.resolve('/tmp/agent-teams-mcp.js')],
      enabled: true,
      timeout: 30000,
      environment: {
        PATH: '/usr/local/bin:/usr/bin',
        CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43123',
        AGENT_TEAMS_MCP_CLAUDE_DIR: '/Users/test/.claude',
      },
    })
    expect(result.config.environment?.SAFE_ENV).toBeUndefined()
    expect(result.config.environment?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    expect(result.config.environment?.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  })

  test('resolves workspace source MCP launch through node and the tsx CLI entrypoint', async () => {
    const result = await resolveOpenCodeAppMcpLaunchConfig({
      env: {},
      pathExists: async targetPath => {
        const normalized = normalizePath(targetPath)
        return (
          normalized.endsWith('/mcp-server/src/index.ts') ||
          normalized.endsWith('/mcp-server/node_modules/.bin/tsx') ||
          normalized.endsWith('/mcp-server/node_modules/.bin/tsx.cmd') ||
          normalized.endsWith('/mcp-server/node_modules/tsx/dist/cli.mjs')
        )
      },
    })

    const command = result.config.command ?? []

    expect(result.source).toBe('workspace-src')
    expect(command.length).toBe(3)
    expect(['node', 'node.exe']).toContain(
      path.basename(command[0]!).toLowerCase(),
    )
    expect(
      normalizePath(command[1]!).endsWith(
        '/mcp-server/node_modules/tsx/dist/cli.mjs',
      ),
    ).toBe(true)
    expect(
      normalizePath(command[2]!).endsWith('/mcp-server/src/index.ts'),
    ).toBe(true)
  })

  test('orders the paired claude_team worktree before the main repo fallback', () => {
    const roots = getCandidateClaudeTeamRootsForBridgeRoot(
      '/repo/_worktrees/agent_teams_orchestrator_opencode_semantic_messaging',
    )
    const normalizedRoots = roots.map(normalizePath)

    expect(
      normalizedRoots[0].endsWith(
        '/repo/_worktrees/claude_team_opencode_semantic_messaging',
      ),
    ).toBe(true)
    expect(
      normalizedRoots[1].endsWith(
        '/repo/_worktrees/claude_agent_teams_ui_opencode_semantic_messaging',
      ),
    ).toBe(true)
    expect(
      normalizedRoots.some(root => root.endsWith('/repo/claude_agent_teams_ui')),
    ).toBe(true)
    expect(normalizedRoots.some(root => root.endsWith('/repo/claude_team'))).toBe(
      true,
    )
  })
})
