import { describe, expect, test } from 'bun:test'

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
    snapshot: false,
  },
  managedConfigFingerprint: 'managed-config-v1',
  homePath: '/tmp/profile-root/home',
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
  test('collects live host verification details', async () => {
    let releaseCalls = 0
    let createCalls = 0
    let refreshCalls = 0

    const probe = new OpenCodeProvisioningProbe({
      inventoryService: {
        probe: async () => inventory,
      },
      hostManager: {
        ensureHost: async () => host,
        refreshResolvedConfigFingerprint: async () => {
          refreshCalls += 1
          return 'resolved-fingerprint'
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
                snapshot: false,
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
    expect(snapshot.providers?.connected).toEqual(['openai'])
    expect(snapshot.agents.map(agent => agent.name)).toEqual(['teammate'])
    expect(Object.keys(snapshot.mcp ?? {})).toEqual(['agent-teams'])
    expect(snapshot.appMcp?.status).toBe('present')
    expect(createCalls).toBe(1)
    expect(refreshCalls).toBe(0)
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
            snapshot: true,
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
    expect(snapshot.providers?.connected).toEqual(['anthropic', 'openai'])
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
            snapshot: false,
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
})
