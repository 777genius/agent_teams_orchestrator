import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import {
  getCandidateClaudeTeamRootsForBridgeRoot,
  OpenCodeMcpManager,
  resolveOpenCodeBridgeRepoRootForStartDir,
  resolveOpenCodeAppMcpLaunchConfig,
} from './OpenCodeMcpManager.js'
import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
} from './OpenCodeManagedPaths.js'

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

  test('ignores a blank remote URL env value when an app MCP server is already present', async () => {
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
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: '   ',
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
    expect(result.summary.diagnostics).toEqual([])
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

  test('reattaches an existing app MCP server when MCP child env changed', async () => {
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
        command: ['/opt/Agent Teams AI/agent-teams-ai', '/tmp/agent-teams-mcp.js'],
        environment: {},
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
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/opt/Agent Teams AI/agent-teams-ai',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: JSON.stringify([
          '/tmp/agent-teams-mcp.js',
        ]),
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: JSON.stringify({
          ELECTRON_RUN_AS_NODE: '1',
        }),
      },
      resolveLaunchConfig: async () => ({
        source: 'env-override',
        config: {
          type: 'local',
          command: ['/opt/Agent Teams AI/agent-teams-ai', '/tmp/agent-teams-mcp.js'],
          environment: {
            ELECTRON_RUN_AS_NODE: '1',
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
    expect(result.summary.diagnostics[0]).toContain('current MCP child environment')
    expect(currentMcp['agent-teams'].environment.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  test('uses resolved config to verify an existing app MCP server when /mcp omits environment', async () => {
    let addCalls = 0

    const manager = new OpenCodeMcpManager({
      clientFactory: {
        create: () => ({
          getMcp: async () => ({
            'agent-teams': {
              status: 'connected',
            },
          }),
          getConfig: async () => ({
            mcp: {
              'agent-teams': {
                type: 'local',
                command: ['node', '/tmp/agent-teams-mcp.js'],
                environment: {
                  AGENT_TEAMS_MCP_CLAUDE_DIR: '/tmp/current-claude-root',
                },
              },
            },
          }),
          addMcp: async () => {
            addCalls += 1
            return {}
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

    expect(result.summary.status).toBe('present')
    expect(result.summary.connected).toBe(true)
    expect(result.summary.diagnostics).toEqual([])
    expect(addCalls).toBe(0)
  })

  test('reattaches an existing app MCP server when resolved config lacks the forced Claude root', async () => {
    let addCalls = 0
    const userHome = path.join(path.parse(process.cwd()).root, 'opencode-test-home')
    const expectedClaudeDir = path.join(userHome, '.claude')
    let currentConfig: {
      type: 'local'
      command: string[]
      environment?: Record<string, string>
      enabled?: boolean
      timeout?: number
    } = {
      type: 'local',
      command: ['node', '/tmp/agent-teams-mcp.js'],
      environment: {},
    }

    const manager = new OpenCodeMcpManager({
      clientFactory: {
        create: () => ({
          getMcp: async () => ({
            'agent-teams': {
              status: 'connected',
            },
          }),
          getConfig: async () => ({
            mcp: {
              'agent-teams': currentConfig,
            },
          }),
          addMcp: async (_name, config) => {
            addCalls += 1
            currentConfig = {
              type: 'local',
              command: config.command ?? [],
              environment: config.environment ?? {},
              enabled: config.enabled,
              timeout: config.timeout,
            }
            return {
              'agent-teams': {
                status: 'connected',
              },
            }
          },
        }),
      },
      env: {
        HOME: userHome,
      },
      resolveLaunchConfig: async () => ({
        source: 'workspace-dist',
        config: {
          type: 'local',
          command: ['node', '/tmp/agent-teams-mcp.js'],
          environment: {
            AGENT_TEAMS_MCP_CLAUDE_DIR: expectedClaudeDir,
          },
          enabled: true,
          timeout: 30000,
        },
      }),
    })

    const result = await manager.ensureAppMcp({
      baseUrl: 'http://127.0.0.1:4096',
      attachIfMissing: true,
    })

    expect(addCalls).toBe(1)
    expect(result.summary.status).toBe('attached')
    expect(result.summary.diagnostics[0]).toContain('AGENT_TEAMS_MCP_CLAUDE_DIR')
    expect(currentConfig.environment?.AGENT_TEAMS_MCP_CLAUDE_DIR).toBe(expectedClaudeDir)
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
        ELECTRON_RUN_AS_NODE: '1',
        PATH: '/usr/local/bin:/usr/bin',
        CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43123',
        AGENT_TEAMS_MCP_CLAUDE_DIR: '/Users/test/.claude',
        [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: '/Users/test/Library/Application Support/claude-multimodel-nodejs',
        [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: '/Users/test/Library/Caches/claude-multimodel-nodejs',
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
        [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: '/Users/test/Library/Application Support/claude-multimodel-nodejs',
        [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: '/Users/test/Library/Caches/claude-multimodel-nodejs',
      },
    })
    expect(result.config.environment?.SAFE_ENV).toBeUndefined()
    expect(result.config.environment?.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(result.config.environment?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    expect(result.config.environment?.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  })

  test('uses the runtime Node fallback when the app forwards only a packaged MCP entry', async () => {
    const entry = path.resolve('/tmp/agent-teams-mcp.js')
    const result = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: entry,
      },
      pathExists: async () => false,
    })

    expect(result.source).toBe('env-override')
    expect(result.config).toMatchObject({
      type: 'local',
      command: [Bun.which('node') ?? 'node', entry],
      enabled: true,
      timeout: 30000,
    })
  })

  test('adds the real user Claude root to local MCP launch config when env omits it', async () => {
    const userHome = path.join(path.parse(process.cwd()).root, 'opencode-test-home')
    const result = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
        HOME: userHome,
      },
      pathExists: async () => false,
    })

    expect(result.source).toBe('env-override')
    expect(result.config.environment?.AGENT_TEAMS_MCP_CLAUDE_DIR).toBe(
      path.join(userHome, '.claude'),
    )
  })

  test('prefers env override remote MCP URL over local command overrides', async () => {
    const result = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
      },
      pathExists: async () => false,
    })

    expect(result.source).toBe('env-override')
    expect(result.config).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:41001/mcp',
      enabled: true,
      timeout: 30000,
      oauth: false,
    })
  })

  test('passes explicit remote authorization without putting it in the URL', async () => {
    const authorization = `Bearer ${'a'.repeat(48)}`
    const result = await resolveOpenCodeAppMcpLaunchConfig({ env: {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp#agent-teams-app',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON: JSON.stringify({ Authorization: authorization }),
    } })
    expect(result.config.headers).toEqual({ Authorization: authorization })
    expect(result.config.url).toBe('http://127.0.0.1:41001/mcp#agent-teams-app')
    expect(result.config.oauth).toBe(false)
  })

  test('fails closed on malformed headers and credentialed URLs without exposing credentials', async () => {
    const secret = 'TEST-secret-value-must-not-appear-in-errors'
    const authorization = `Bearer ${secret}`
    for (const [url, headers] of [
      ['http://127.0.0.1:41001/mcp', `{ "Authorization": "${secret}`],
      ['http://127.0.0.1:41001/mcp', JSON.stringify({ Authorization: authorization, Cookie: secret })],
      ['http://127.0.0.1:41001/mcp', JSON.stringify({ Authorization: 'Bearer short' })],
      ['http://127.0.0.1:41001/mcp', JSON.stringify({ Authorization: `${authorization}\r\nInjected: value` })],
      ['http://127.0.0.1:41001/mcp?token=legacy', JSON.stringify({ Authorization: authorization })],
      ['http://user:password@127.0.0.1:41001/mcp', JSON.stringify({ Authorization: authorization })],
      ['', JSON.stringify({ Authorization: authorization })],
    ]) {
      let thrown: unknown
      try {
        await resolveOpenCodeAppMcpLaunchConfig({ env: {
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: url,
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON: headers,
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/TEST/never-use-unauthenticated-fallback.js',
        }, pathExists: async () => false })
      } catch (error) { thrown = error }
      expect(thrown).toBeInstanceOf(Error)
      expect(String(thrown)).toContain('exactly one Authorization Bearer header')
      expect(String(thrown)).not.toContain(secret)
    }
  })

  test('reattaches on authorization rotation and keeps diagnostics free of authorization values', async () => {
    const oldAuthorization = `Bearer ${'o'.repeat(48)}`
    const authorization = `Bearer ${'n'.repeat(48)}`
    const url = 'http://127.0.0.1:41001/mcp'
    let current: Record<string, Record<string, unknown>> = {
      'agent-teams': { connected: true, type: 'remote', url, headers: { Authorization: oldAuthorization } },
    }
    const calls: string[] = []
    const manager = new OpenCodeMcpManager({ env: {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: url,
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON: JSON.stringify({ Authorization: authorization }),
    }, clientFactory: { create: () => ({
      getMcp: async () => current,
      getConfig: async () => ({ mcp: current }),
      addMcp: async (_name, config) => {
        calls.push(config.headers!.Authorization!)
        current = { 'agent-teams': { ...config, connected: true } }
        return current
      },
    }) } })
    const first = await manager.ensureAppMcp({ baseUrl: 'http://127.0.0.1:4096', attachIfMissing: true })
    const second = await manager.ensureAppMcp({ baseUrl: 'http://127.0.0.1:4096', attachIfMissing: true })
    expect(calls).toEqual([authorization])
    expect(first.summary.status).toBe('attached')
    expect(second.summary.status).toBe('present')
    expect(JSON.stringify(first.summary)).not.toContain(authorization)
    expect(JSON.stringify(first.summary)).not.toContain(oldAuthorization)
  })

  test('serializes concurrent credential rotation without deduping the new generation', async () => {
    const oldAuthorization = `Bearer ${'a'.repeat(48)}`
    const newAuthorization = `Bearer ${'b'.repeat(48)}`
    const env = {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON: JSON.stringify({ Authorization: oldAuthorization }),
    }
    let current: Record<string, Record<string, unknown>> = {}
    const attached: string[] = []
    const manager = new OpenCodeMcpManager({ env, clientFactory: { create: () => ({
      getMcp: async () => current,
      addMcp: async (_name, config) => {
        attached.push(config.headers!.Authorization!)
        current = { 'agent-teams': { ...config, connected: true } }
        return current
      },
    }) } })
    const first = manager.ensureAppMcp({ baseUrl: 'http://127.0.0.1:4096', attachIfMissing: true })
    env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON = JSON.stringify({ Authorization: newAuthorization })
    const second = manager.ensureAppMcp({ baseUrl: 'http://127.0.0.1:4096', attachIfMissing: true })
    await Promise.all([first, second])
    expect(attached).toEqual([oldAuthorization, newAuthorization])
    expect(current['agent-teams']?.headers).toEqual({ Authorization: newAuthorization })
  })

  test('returns queued abort/deadline promptly while keeping later callers behind physical work', async () => {
    const oldAuthorization = `Bearer ${'a'.repeat(48)}`
    const newAuthorization = `Bearer ${'b'.repeat(48)}`
    const env = {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON: JSON.stringify({ Authorization: oldAuthorization }),
    }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let current: Record<string, Record<string, unknown>> = {}
    const attached: string[] = []
    let creates = 0
    const manager = new OpenCodeMcpManager({ env, clientFactory: { create: () => {
      creates += 1
      return {
        getMcp: async () => current,
        addMcp: async (_name, config) => {
          if (config.headers?.Authorization === oldAuthorization) {
            entered.resolve()
            await release.promise
          }
          attached.push(config.headers!.Authorization!)
          current = { 'agent-teams': { ...config, connected: true } }
          return current
        },
      }
    } } })
    const first = manager.ensureAppMcp({ baseUrl: 'http://127.0.0.1:4096', attachIfMissing: true,
      requestContext: { signal: new AbortController().signal } })
    await entered.promise
    env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON = JSON.stringify({ Authorization: newAuthorization })
    const second = manager.ensureAppMcp({ baseUrl: 'http://127.0.0.1:4096', attachIfMissing: true,
      requestContext: { signal: new AbortController().signal } })
    const aborted = new AbortController()
    const third = manager.ensureAppMcp({ baseUrl: 'http://127.0.0.1:4096', attachIfMissing: true,
      requestContext: { signal: aborted.signal } })
    const fourth = manager.ensureAppMcp({ baseUrl: 'http://127.0.0.1:4096', attachIfMissing: true,
      requestContext: { remainingMs: () => 1 } })
    aborted.abort()
    let fifthCompleted = false
    let fifth: Promise<unknown> | undefined
    try {
      // These must reject before the delayed old attach is released.
      const cancelled = await Promise.allSettled([third, fourth])
      expect(cancelled.map(result => result.status)).toEqual(['rejected', 'rejected'])
      expect(creates).toBe(1)
      fifth = manager.ensureAppMcp({ baseUrl: 'http://127.0.0.1:4096', attachIfMissing: true })
        .then(result => { fifthCompleted = true; return result })
      await Promise.resolve()
      expect(fifthCompleted).toBe(false)
      expect(creates).toBe(1)
    } finally {
      release.resolve()
    }
    await Promise.all([first, second, fifth])
    expect(creates).toBe(3)
    expect(attached).toEqual([oldAuthorization, newAuthorization])
    expect(current['agent-teams']?.headers).toEqual({ Authorization: newAuthorization })
  })

  test('rejects malformed explicit remote credentials before client construction', async () => {
    let creates = 0
    const manager = new OpenCodeMcpManager({ env: {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON: '{invalid',
    }, clientFactory: { create: () => {
      creates += 1
      return { getMcp: async () => ({}) }
    } } })
    await expect(manager.ensureAppMcp({ baseUrl: 'http://127.0.0.1:4096', attachIfMissing: true }))
      .rejects.toThrow('exactly one Authorization Bearer header')
    expect(creates).toBe(0)
  })

  test('does not expose an authenticated attach error that echoes the request', async () => {
    const authorization = `Bearer ${'s'.repeat(48)}`
    const manager = new OpenCodeMcpManager({ env: {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON: JSON.stringify({ Authorization: authorization }),
    }, clientFactory: { create: () => ({
      getMcp: async () => ({}),
      addMcp: async () => { throw new Error(`request rejected: ${authorization}`) },
    }) } })
    const result = await manager.ensureAppMcp({ baseUrl: 'http://127.0.0.1:4096', attachIfMissing: true })
    expect(result.summary.status).toBe('attach_failed')
    expect(result.summary.diagnostics).toEqual(['authenticated MCP request failed'])
  })

  test('rejects invalid env override remote MCP URLs', async () => {
    await expect(
      resolveOpenCodeAppMcpLaunchConfig({
        env: {
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'ws://127.0.0.1:41001/mcp',
        },
        pathExists: async () => false,
      }),
    ).rejects.toThrow('CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL must be an http(s) URL')
  })

  test('reattaches an existing local app MCP server when the runtime provides a remote URL', async () => {
    let addCalls = 0
    let currentMcp: Record<string, Record<string, unknown>> = {
      'agent-teams': {
        connected: true,
        type: 'local',
        command: ['node', '/tmp/agent-teams-mcp.js'],
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
                ...config,
              },
            }
            return currentMcp
          },
        }),
      },
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41002/mcp',
      },
      pathExists: async () => false,
    })

    const result = await manager.ensureAppMcp({
      baseUrl: 'http://127.0.0.1:4096',
      attachIfMissing: true,
    })

    expect(addCalls).toBe(1)
    expect(result.summary.status).toBe('attached')
    expect(result.summary.diagnostics[0]).toContain('Reattached stale OpenCode app MCP server')
    expect(currentMcp['agent-teams']).toMatchObject({
      type: 'remote',
      url: 'http://127.0.0.1:41002/mcp',
      oauth: false,
    })
  })

  test('reattaches an existing remote app MCP server when the runtime URL changed', async () => {
    let addCalls = 0
    let currentMcp: Record<string, Record<string, unknown>> = {
      'agent-teams': {
        connected: true,
        type: 'remote',
        url: 'http://127.0.0.1:41001/mcp',
      },
    }

    const manager = new OpenCodeMcpManager({
      clientFactory: {
        create: () => ({
          getMcp: async () => currentMcp,
          getConfig: async () => ({
            mcp: currentMcp,
          }),
          addMcp: async (_name, config) => {
            addCalls += 1
            currentMcp = {
              'agent-teams': {
                connected: true,
                ...config,
              },
            }
            return currentMcp
          },
        }),
      },
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41002/mcp',
      },
      pathExists: async () => false,
    })

    const result = await manager.ensureAppMcp({
      baseUrl: 'http://127.0.0.1:4096',
      attachIfMissing: true,
    })

    expect(addCalls).toBe(1)
    expect(result.summary.status).toBe('attached')
    expect(result.summary.diagnostics[0]).toContain('existing app MCP URL does not match')
    expect(currentMcp['agent-teams']).toMatchObject({
      type: 'remote',
      url: 'http://127.0.0.1:41002/mcp',
      oauth: false,
    })
  })

  test('uses resolved config URL when /mcp omits remote MCP config details', async () => {
    let addCalls = 0
    const manager = new OpenCodeMcpManager({
      clientFactory: {
        create: () => ({
          getMcp: async () => ({
            'agent-teams': {
              status: 'connected',
            },
          }),
          getConfig: async () => ({
            mcp: {
              'agent-teams': {
                type: 'remote',
                url: 'http://127.0.0.1:41003/mcp',
              },
            },
          }),
          addMcp: async () => {
            addCalls += 1
            return {}
          },
        }),
      },
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41003/mcp',
      },
      pathExists: async () => false,
    })

    const result = await manager.ensureAppMcp({
      baseUrl: 'http://127.0.0.1:4096',
      attachIfMissing: true,
    })

    expect(result.summary.status).toBe('present')
    expect(result.summary.connected).toBe(true)
    expect(addCalls).toBe(0)
  })

  test('resolves env override MCP launch config with full args JSON', async () => {
    const result = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/ignored-legacy-entry.js',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: JSON.stringify([
          '/tmp/tsx-cli.mjs',
          '/tmp/agent-teams-mcp/src/index.ts',
        ]),
      },
      pathExists: async () => false,
    })

    expect(result.source).toBe('env-override')
    expect(result.config.command).toEqual([
      '/usr/local/bin/node',
      '/tmp/tsx-cli.mjs',
      '/tmp/agent-teams-mcp/src/index.ts',
    ])
  })

  test('preserves module URLs and literal operands in full args JSON', async () => {
    const args = [
      '--import',
      'file:///TEST%20project/100%25/tsx/loader.mjs',
      '/TEST project/agent-teams-mcp/src/index.ts',
      '--label',
      'literal value 100%',
    ]
    const result = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/TEST/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: JSON.stringify(args),
      },
      pathExists: async () => false,
    })

    expect(result.config.command).toEqual(['/TEST/node', ...args])
  })

  test('applies MCP env JSON only to local MCP launch config', async () => {
    const result = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/opt/Agent Teams AI/agent-teams-ai',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp/index.js',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: JSON.stringify([
          '/tmp/agent-teams-mcp/index.js',
        ]),
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: JSON.stringify({
          ELECTRON_RUN_AS_NODE: '1',
        }),
      },
      pathExists: async () => false,
    })

    expect(result.source).toBe('env-override')
    expect(result.config.command).toEqual([
      '/opt/Agent Teams AI/agent-teams-ai',
      '/tmp/agent-teams-mcp/index.js',
    ])
    expect(result.config.environment?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  test('rejects invalid MCP env JSON for local MCP launch config', async () => {
    await expect(
      resolveOpenCodeAppMcpLaunchConfig({
        env: {
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/opt/Agent Teams AI/agent-teams-ai',
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp/index.js',
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: '{',
        },
        pathExists: async () => false,
      }),
    ).rejects.toThrow('CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON must be a JSON object')
  })

  test('rejects non-string MCP env JSON values for local MCP launch config', async () => {
    await expect(
      resolveOpenCodeAppMcpLaunchConfig({
        env: {
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/opt/Agent Teams AI/agent-teams-ai',
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp/index.js',
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: JSON.stringify({
            ELECTRON_RUN_AS_NODE: true,
          }),
        },
        pathExists: async () => false,
      }),
    ).rejects.toThrow(
      'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON value for ELECTRON_RUN_AS_NODE must be a string',
    )
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

  test('resolves the runtime repo root from bundled dist entrypoints', () => {
    const repoRoot = path.resolve('/repo/agent_teams_orchestrator')
    const root = resolveOpenCodeBridgeRepoRootForStartDir(
      path.join(repoRoot, 'dist', 'local-cli-dev'),
      {
        pathExists: targetPath =>
          normalizePath(targetPath) === normalizePath(path.join(repoRoot, 'package.json')),
        readText: () => JSON.stringify({ name: 'claude-multimodel' }),
      },
    )

    expect(normalizePath(root ?? '')).toBe(normalizePath(repoRoot))
  })
})
