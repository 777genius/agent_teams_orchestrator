import { describe, expect, test } from 'bun:test'

import { OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID } from './OpenCodeHostManager.js'
import { OpenCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'

import type {
  OpenCodeConfigProvidersResponse,
  OpenCodeConfigResponse,
  OpenCodeHostHandle,
  OpenCodeInventorySnapshot,
  OpenCodePreparedProfile,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderResponse,
} from './types.js'

const profile: OpenCodePreparedProfile = {
  projectPath: '/tmp/project',
  profileRootKey: 'profile-root',
  profileRootPath: '/tmp/profile-root',
  projectBehaviorFingerprint: 'behavior-v1',
  behaviorSources: ['AGENTS.md', 'opencode.json'],
  managedConfig: {
    default_agent: 'teammate',
    share: 'disabled',
    autoupdate: false,
    snapshot: true,
  },
  managedConfigFingerprint: 'managed-config-v1',
  homePath: '/tmp/profile-root/home',
  tmpPath: '/tmp/profile-root/tmp',
  xdgConfigHome: '/tmp/profile-root/config',
  xdgDataHome: '/tmp/profile-root/data',
  xdgCacheHome: '/tmp/profile-root/cache',
  managedAuthPath: '/tmp/profile-root/data/opencode/auth.json',
  sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
  sourceAuthFingerprint: 'source-auth',
  managedAuthFingerprint: 'managed-auth',
  authState: 'ok',
  env: {},
}

const inventory: OpenCodeInventorySnapshot = {
  detected: true,
  binaryPath: '/opt/homebrew/bin/opencode',
  version: '1.4.0',
  projectPath: '/tmp/project',
  profile,
  connectedProviders: [{ id: 'openai', authHint: 'oauth', source: 'credentials' }],
  availableProviders: ['openai'],
  models: ['openai/gpt-5.4-mini'],
  agents: [{ id: 'teammate', mode: 'primary' }],
  authStorePath: profile.managedAuthPath,
  probeError: null,
  diagnostics: [],
}

const host: OpenCodeHostHandle = {
  hostKey: 'host-key',
  profileRootKey: 'profile-root',
  projectPath: '/tmp/project',
  projectBehaviorFingerprint: 'behavior-v1',
  baseUrl: 'http://127.0.0.1:4096',
  port: 4096,
  pid: 123,
  version: '1.4.0',
  state: 'healthy',
  profile,
  resolvedConfigFingerprint: 'resolved-fingerprint',
  diagnostics: [],
}

describe('OpenCodeProvisioningProbe', () => {
  test('keeps inventory warnings diagnostic-only when host startup fails', async () => {
    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => ({
          ...inventory,
          probeError: 'SuperGrok OAuth requires OpenCode 1.15.7 or newer; detected 1.15.6',
          diagnostics: [
            'SuperGrok OAuth requires OpenCode 1.15.7 or newer; detected 1.15.6',
          ],
        }),
      },
      hostManager: {
        ensureHost: async () => {
          throw new Error('OpenCode request timed out after 15000ms for /config')
        },
        releaseHost: async () => {},
      },
    })

    const snapshot = await probe.probe('/tmp/project')

    expect(snapshot.hostHealthy).toBe(false)
    expect(snapshot.probeError).toBe('OpenCode request timed out after 15000ms for /config')
    expect(snapshot.diagnostics).toEqual([
      'SuperGrok OAuth requires OpenCode 1.15.7 or newer; detected 1.15.6',
      'OpenCode request timed out after 15000ms for /config',
    ])
  })

  test('collects live host verification details', async () => {
    let releaseCalls = 0
    const retainedLeaseTeamIds: string[] = []
    const releasedLeaseTeamIds: string[] = []
    let createCalls = 0
    let refreshCalls = 0

    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => ({
          ...inventory,
          connectedProviders: [
            ...inventory.connectedProviders,
            {
              id: 'Z.AI Coding Plan',
              authHint: 'api',
              source: 'credentials' as const,
            },
          ],
        }),
      },
      hostManager: {
        ensureHost: async () => host,
        refreshResolvedConfigFingerprint: async () => {
          refreshCalls += 1
          return 'resolved-fingerprint'
        },
        retainHostLease: async (_hostKey, input) => {
          retainedLeaseTeamIds.push(input.teamId)
        },
        releaseHostLease: async (_hostKey, input) => {
          releasedLeaseTeamIds.push(input.teamId)
        },
        releaseHost: async () => {
          releaseCalls += 1
        },
      },
      clientFactory: {
        create: () => {
          createCalls += 1
          return {
            getConfig: async () =>
              ({
                username: 'belief',
                plugin: [],
                agent: {},
                mode: {},
                command: {},
                default_agent: 'teammate',
                share: 'disabled',
                autoupdate: false,
                snapshot: true,
              }) satisfies OpenCodeConfigResponse,
            getConfigProviders: async () =>
              ({
                providers: [{ id: 'openai', name: 'OpenAI' }],
                default: { openai: 'gpt-5.4-mini' },
              }) satisfies OpenCodeConfigProvidersResponse,
            getProviders: async () =>
              ({
                all: [{ id: 'openai', name: 'OpenAI' }],
                default: { openai: 'gpt-5.4-mini' },
                connected: ['openai', 'zai-coding-plan'],
              }) satisfies OpenCodeProviderResponse,
            getProviderAuth: async () =>
              ({
                openai: [{ type: 'oauth', label: 'ChatGPT Pro/Plus (browser)' }],
              }) satisfies Record<string, OpenCodeProviderAuthMethod[]>,
            listAgents: async () => [{ name: 'teammate', mode: 'primary' }],
            getMcp: async () => ({ 'agent-teams': { connected: true } }),
            addMcp: async () => {
              throw new Error('not used')
            },
            createSession: async () => {
              throw new Error('not used')
            },
            getSession: async () => {
              throw new Error('not used')
            },
            getSessionStatus: async () => {
              throw new Error('not used')
            },
            getSessionMessages: async () => {
              throw new Error('not used')
            },
            getPermissions: async () => [],
            sendSessionMessage: async () => {
              throw new Error('not used')
            },
            promptSessionAsync: async () => {
              throw new Error('not used')
            },
            abortSession: async () => {
              throw new Error('not used')
            },
          }
        },
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {
            'agent-teams': { connected: true },
          },
          summary: {
            serverName: 'agent-teams',
            matchedServerName: 'agent-teams',
            status: 'present',
            connected: true,
            launchSource: null,
            availableServerNames: ['agent-teams'],
            diagnostics: [],
          },
        }),
      },
    })

    const snapshot = await probe.probe('/tmp/project')

    expect(snapshot.hostHealthy).toBe(true)
    expect(snapshot.config?.username).toBe('belief')
    expect(snapshot.providers?.connected).toEqual(['openai', 'zai-coding-plan'])
    expect(snapshot.diagnostics.some(item => item.includes('missing from live host'))).toBe(false)
    expect(snapshot.agents.map(agent => agent.name)).toEqual(['teammate'])
    expect(Object.keys(snapshot.mcp ?? {})).toEqual(['agent-teams'])
    expect(snapshot.appMcp?.status).toBe('present')
    expect(createCalls).toBe(1)
    expect(refreshCalls).toBe(1)
    expect(retainedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releasedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releaseCalls).toBe(1)
  })

  test('can release readiness lease without disposing the live host', async () => {
    let releaseCalls = 0
    const releasedLeaseTeamIds: string[] = []

    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => inventory,
      },
      hostManager: {
        ensureHost: async () => host,
        refreshResolvedConfigFingerprint: async () => 'resolved-fingerprint',
        retainHostLease: async () => {},
        releaseHostLease: async (_hostKey, input) => {
          releasedLeaseTeamIds.push(input.teamId)
        },
        releaseHost: async () => {
          releaseCalls += 1
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () =>
            ({
              username: 'belief',
              plugin: [],
              agent: {},
              mode: {},
              command: {},
              default_agent: 'teammate',
              share: 'disabled',
              autoupdate: false,
              snapshot: true,
            }) satisfies OpenCodeConfigResponse,
          getConfigProviders: async () =>
            ({
              providers: [{ id: 'openai', name: 'OpenAI' }],
              default: { openai: 'gpt-5.4-mini' },
            }) satisfies OpenCodeConfigProvidersResponse,
          getProviders: async () =>
            ({
              all: [{ id: 'openai', name: 'OpenAI' }],
              default: { openai: 'gpt-5.4-mini' },
              connected: ['openai'],
            }) satisfies OpenCodeProviderResponse,
          getProviderAuth: async () =>
            ({
              openai: [{ type: 'oauth', label: 'ChatGPT Pro/Plus (browser)' }],
            }) satisfies Record<string, OpenCodeProviderAuthMethod[]>,
          listAgents: async () => [{ name: 'teammate', mode: 'primary' }],
          getMcp: async () => ({ 'agent-teams': { connected: true } }),
          addMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            throw new Error('not used')
          },
          getSession: async () => {
            throw new Error('not used')
          },
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            throw new Error('not used')
          },
          promptSessionAsync: async () => {
            throw new Error('not used')
          },
          abortSession: async () => {
            throw new Error('not used')
          },
        }),
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {
            'agent-teams': { connected: true },
          },
          summary: {
            serverName: 'agent-teams',
            matchedServerName: 'agent-teams',
            status: 'present',
            connected: true,
            launchSource: null,
            availableServerNames: ['agent-teams'],
            diagnostics: [],
          },
        }),
      },
    })

    const snapshot = await probe.probe('/tmp/project', { disposeHostOnRelease: false })

    expect(snapshot.hostHealthy).toBe(true)
    expect(releasedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releaseCalls).toBe(0)
  })

  test('can retain the live host for launch session creation', async () => {
    let releaseCalls = 0
    const retainedLeaseTeamIds: string[] = []
    const releasedLeaseTeamIds: string[] = []
    const ensureHostInputs: unknown[] = []

    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => inventory,
      },
      hostManager: {
        ensureHost: async (input) => {
          ensureHostInputs.push(input)
          return host
        },
        refreshResolvedConfigFingerprint: async () => 'resolved-fingerprint',
        retainHostLease: async (_hostKey, input) => {
          retainedLeaseTeamIds.push(input.teamId)
        },
        releaseHostLease: async (_hostKey, input) => {
          releasedLeaseTeamIds.push(input.teamId)
        },
        releaseHost: async () => {
          releaseCalls += 1
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () =>
            ({
              username: 'belief',
              plugin: [],
              agent: {},
              mode: {},
              command: {},
              default_agent: 'teammate',
              share: 'disabled',
              autoupdate: false,
              snapshot: true,
            }) satisfies OpenCodeConfigResponse,
          getConfigProviders: async () =>
            ({
              providers: [{ id: 'openai', name: 'OpenAI' }],
              default: { openai: 'gpt-5.4-mini' },
            }) satisfies OpenCodeConfigProvidersResponse,
          getProviders: async () =>
            ({
              all: [{ id: 'openai', name: 'OpenAI' }],
              default: { openai: 'gpt-5.4-mini' },
              connected: ['openai'],
            }) satisfies OpenCodeProviderResponse,
          getProviderAuth: async () =>
            ({
              openai: [{ type: 'oauth', label: 'ChatGPT Pro/Plus (browser)' }],
            }) satisfies Record<string, OpenCodeProviderAuthMethod[]>,
          listAgents: async () => [{ name: 'teammate', mode: 'primary' }],
          getMcp: async () => ({ 'agent-teams': { connected: true } }),
          addMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            throw new Error('not used')
          },
          getSession: async () => {
            throw new Error('not used')
          },
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            throw new Error('not used')
          },
          promptSessionAsync: async () => {
            throw new Error('not used')
          },
          abortSession: async () => {
            throw new Error('not used')
          },
        }),
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {
            'agent-teams': { connected: true },
          },
          summary: {
            serverName: 'agent-teams',
            matchedServerName: 'agent-teams',
            status: 'present',
            connected: true,
            launchSource: null,
            availableServerNames: ['agent-teams'],
            diagnostics: [],
          },
        }),
      },
    })

    const retained = await probe.probeRetainingHost('/tmp/project')

    expect(retained.snapshot.hostHealthy).toBe(true)
    expect(ensureHostInputs).toEqual([
      expect.objectContaining({
        projectPath: '/tmp/project',
        preparedProfile: profile,
        hostLifetime: 'persistent',
      }),
    ])
    expect(retainedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releasedLeaseTeamIds).toEqual([])
    expect(releaseCalls).toBe(0)

    await retained.release()
    await retained.release()

    expect(releasedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releaseCalls).toBe(1)
  })

  test('surfaces provider mismatches between inventory and live host', async () => {
    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => ({
          ...inventory,
          connectedProviders: [{ id: 'openai', authHint: 'oauth', source: 'credentials' }],
        }),
      },
      hostManager: {
        ensureHost: async () => host,
        refreshResolvedConfigFingerprint: async () => 'resolved-after-attach',
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => ({
            username: 'belief',
            default_agent: 'build',
            share: 'manual',
            autoupdate: true,
            snapshot: false,
          }),
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], default: {}, connected: ['anthropic'] }),
          getProviderAuth: async () => ({}),
          listAgents: async () => [],
          getMcp: async () => ({}),
          addMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            throw new Error('not used')
          },
          getSession: async () => {
            throw new Error('not used')
          },
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            throw new Error('not used')
          },
          promptSessionAsync: async () => {
            throw new Error('not used')
          },
          abortSession: async () => {
            throw new Error('not used')
          },
        }),
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {},
          summary: {
            serverName: 'agent-teams',
            matchedServerName: null,
            status: 'attach_failed',
            connected: null,
            launchSource: 'workspace-dist',
            availableServerNames: [],
            diagnostics: ['agent-teams MCP attach failed'],
          },
        }),
      },
    })

    const snapshot = await probe.probe('/tmp/project')
    expect(snapshot.diagnostics.some(item => item.includes('missing from live host'))).toBe(true)
    expect(snapshot.providers?.connected).toEqual(['anthropic'])
    expect(snapshot.diagnostics.some(item => item.includes('Managed default agent mismatch'))).toBe(true)
    expect(snapshot.diagnostics.some(item => item.includes('Managed teammate primary agent is missing'))).toBe(true)
    expect(snapshot.diagnostics.some(item => item.includes('agent-teams MCP attach failed'))).toBe(true)
    expect(snapshot.appMcp?.status).toBe('attach_failed')
  })

  test('refreshes resolved host fingerprint after attaching the app MCP server', async () => {
    let refreshCalls = 0

    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => inventory,
      },
      hostManager: {
        ensureHost: async () => ({ ...host, resolvedConfigFingerprint: 'before-attach' }),
        refreshResolvedConfigFingerprint: async () => {
          refreshCalls += 1
          return 'after-attach'
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => ({
            default_agent: 'teammate',
            share: 'disabled',
            autoupdate: false,
            snapshot: true,
          }),
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], default: {}, connected: ['openai'] }),
          getProviderAuth: async () => ({}),
          listAgents: async () => [{ name: 'teammate', mode: 'primary' }],
          getMcp: async () => ({}),
          addMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            throw new Error('not used')
          },
          getSession: async () => {
            throw new Error('not used')
          },
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            throw new Error('not used')
          },
          promptSessionAsync: async () => {
            throw new Error('not used')
          },
          abortSession: async () => {
            throw new Error('not used')
          },
        }),
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {
            'agent-teams': {
              connected: true,
            },
          },
          summary: {
            serverName: 'agent-teams',
            matchedServerName: 'agent-teams',
            status: 'attached',
            connected: true,
            launchSource: 'workspace-dist',
            availableServerNames: ['agent-teams'],
            diagnostics: [],
          },
        }),
      },
    })

    const snapshot = await probe.probe('/tmp/project')

    expect(refreshCalls).toBe(1)
    expect(snapshot.host?.resolvedConfigFingerprint).toBe('after-attach')
    expect(snapshot.appMcp?.status).toBe('attached')
  })

  test('refreshes resolved host fingerprint after verifying an existing app MCP server', async () => {
    let refreshCalls = 0

    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => inventory,
      },
      hostManager: {
        ensureHost: async () => ({ ...host, resolvedConfigFingerprint: 'before-present' }),
        refreshResolvedConfigFingerprint: async () => {
          refreshCalls += 1
          return 'after-present'
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => ({
            default_agent: 'teammate',
            share: 'disabled',
            autoupdate: false,
            snapshot: true,
          }),
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], default: {}, connected: ['openai'] }),
          getProviderAuth: async () => ({}),
          listAgents: async () => [{ name: 'teammate', mode: 'primary' }],
          getMcp: async () => ({}),
          addMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            throw new Error('not used')
          },
          getSession: async () => {
            throw new Error('not used')
          },
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            throw new Error('not used')
          },
          promptSessionAsync: async () => {
            throw new Error('not used')
          },
          abortSession: async () => {
            throw new Error('not used')
          },
        }),
      },
      mcpManager: {
        ensureAppMcp: async () => ({
          mcp: {
            'agent-teams': {
              connected: true,
            },
          },
          summary: {
            serverName: 'agent-teams',
            matchedServerName: 'agent-teams',
            status: 'present',
            connected: true,
            launchSource: 'workspace-dist',
            availableServerNames: ['agent-teams'],
            diagnostics: [],
          },
        }),
      },
    })

    const snapshot = await probe.probe('/tmp/project')

    expect(refreshCalls).toBe(1)
    expect(snapshot.host?.resolvedConfigFingerprint).toBe('after-present')
    expect(snapshot.appMcp?.status).toBe('present')
  })
})
