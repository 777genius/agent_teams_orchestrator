import { describe, expect, test } from 'bun:test'

import { OpenCodeProviderManagementAdapter } from './OpenCodeProviderManagementAdapter.js'

import type { OpenCodeHostHandle, OpenCodeInventorySnapshot } from '../../../../services/opencode/types.js'

function inventory(
  overrides: Partial<OpenCodeInventorySnapshot> = {},
): OpenCodeInventorySnapshot {
  return {
    detected: true,
    binaryPath: '/opt/homebrew/bin/opencode',
    version: '1.14.19',
    projectPath: '/tmp/project',
    profile: {
      projectPath: '/tmp/project',
      profileRootKey: 'profile-key',
      profileRootPath: '/tmp/profile',
      projectBehaviorFingerprint: 'behavior',
      behaviorSources: ['AGENTS.md'],
      managedConfig: {},
      managedConfigFingerprint: 'managed-config',
      homePath: '/tmp/profile/home',
      xdgConfigHome: '/tmp/profile/config',
      xdgDataHome: '/tmp/profile/data',
      xdgCacheHome: '/tmp/profile/cache',
      managedAuthPath: '/tmp/profile/data/opencode/auth.json',
      sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
      sourceAuthFingerprint: 'source-auth',
      managedAuthFingerprint: 'managed-auth',
      authState: 'ok',
      env: {},
    },
    connectedProviders: [
      { id: 'openai', authHint: 'oauth', source: 'credentials' },
    ],
    availableProviders: ['openai'],
    models: ['openai/gpt-5.4-mini'],
    agents: [],
    authStorePath: '/tmp/profile/data/opencode/auth.json',
    probeError: null,
    diagnostics: [],
    ...overrides,
  }
}

function host(): OpenCodeHostHandle {
  return {
    hostKey: 'host-key',
    profileRootKey: 'profile-key',
    projectPath: '/tmp/project',
    projectBehaviorFingerprint: 'behavior',
    baseUrl: 'http://127.0.0.1:47919',
    port: 47919,
    pid: 123,
    version: '1.14.19',
    state: 'healthy',
    profile: inventory().profile!,
    resolvedConfigFingerprint: 'config',
    diagnostics: [],
  }
}

describe('OpenCodeProviderManagementAdapter', () => {
  test('returns a needs-setup view when OpenCode is missing', async () => {
    let ensureHostCalled = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          detected: false,
          binaryPath: null,
          version: null,
          profile: null,
          connectedProviders: [],
          availableProviders: [],
          models: [],
          authStorePath: null,
          diagnostics: ['OpenCode CLI not detected on PATH'],
        }),
      },
      hostManager: {
        ensureHost: async () => {
          ensureHostCalled = true
          return host()
        },
        releaseHost: async () => {},
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(ensureHostCalled).toBe(false)
    expect(result.value.runtime.state).toBe('needs-setup')
    expect(result.value.providers.map(provider => provider.providerId)).toEqual([
      'openrouter',
      'opencode',
    ])
  })

  test('normalizes OpenCode provider catalog into the feature view model', async () => {
    const releasedHosts: string[] = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory(),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async (hostKey) => {
          releasedHosts.push(hostKey)
        },
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [
              { id: 'openai', name: 'OpenAI', models: { 'gpt-5.4-mini': {} } },
              { id: 'openrouter', name: 'OpenRouter', models: { 'moonshotai/kimi-k2': {} } },
            ],
            default: {
              openai: 'gpt-5.4-mini',
            },
          }),
          getProviders: async () => ({
            all: [
              { id: 'openai', name: 'OpenAI' },
              { id: 'openrouter', name: 'OpenRouter' },
            ],
            connected: ['openai'],
            default: {},
          }),
          getProviderAuth: async () => ({
            openai: [{ type: 'oauth' }],
            openrouter: [{ type: 'api' }],
          }),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(releasedHosts).toEqual(['host-key'])
    expect(result.value.runtime.state).toBe('ready')
    expect(result.value.defaultModel).toBe('openai/gpt-5.4-mini')
    expect(result.value.providers.map(provider => provider.providerId)).toEqual([
      'openrouter',
      'opencode',
      'openai',
    ])

    const openai = result.value.providers.find(provider => provider.providerId === 'openai')
    expect(openai).toMatchObject({
      state: 'connected',
      ownership: ['managed', 'local'],
      modelCount: 1,
      primaryAction: 'use',
    })

    const openrouter = result.value.providers.find(provider => provider.providerId === 'openrouter')
    expect(openrouter).toMatchObject({
      state: 'available',
      recommended: true,
      primaryAction: 'connect',
    })
  })

  test('marks the runtime degraded when the managed host cannot start', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory(),
      },
      hostManager: {
        ensureHost: async () => {
          throw new Error('OpenCode host did not become healthy')
        },
        releaseHost: async () => {
          throw new Error('release should not be called')
        },
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.runtime.state).toBe('degraded')
    expect(result.value.diagnostics).toContain('OpenCode host did not become healthy')
  })

  test('does not fail the view when host release fails', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory(),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {
          throw new Error('release failed')
        },
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], connected: ['openai'], default: {} }),
          getProviderAuth: async () => ({ openai: [{ type: 'oauth' }] }),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.runtime.state).toBe('ready')
  })
})
