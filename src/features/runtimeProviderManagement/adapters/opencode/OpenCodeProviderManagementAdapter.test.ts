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
      globalAuthPath: '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
      managedAuthPath: '/tmp/profile/data/opencode/auth.json',
      sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
      sourceAuthFingerprint: 'source-auth',
      managedAuthFingerprint: 'managed-auth',
      authState: 'ok',
      env: {},
    },
    connectedProviders: [
      {
        id: 'openai',
        authHint: 'oauth',
        source: 'credentials',
        credentialScopes: ['managed', 'local'],
      },
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

function authStore() {
  return {
    upsertApiKey: async () => {},
    removeCredential: async () => {},
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
      detail: 'Connected via app-managed and local OpenCode credentials',
      modelCount: 1,
    })
    expect(openai?.actions.map(action => action.id)).toEqual([
      'use',
      'test',
      'set-default',
    ])
    expect(openai?.actions.find(action => action.id === 'use')?.enabled).toBe(true)

    const openrouter = result.value.providers.find(provider => provider.providerId === 'openrouter')
    expect(openrouter).toMatchObject({
      state: 'available',
      recommended: true,
    })
    expect(openrouter?.actions.map(action => action.id)).toEqual(['connect'])
  })

  test('labels environment-connected providers without claiming app-managed credentials', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [
            { id: 'openai', authHint: 'OPENAI_API_KEY', source: 'environment' },
          ],
          availableProviders: ['openai'],
          models: ['openai/gpt-5.4-mini'],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [{ id: 'openai', name: 'OpenAI', models: { 'gpt-5.4-mini': {} } }],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'openai', name: 'OpenAI' }],
            connected: ['openai'],
            default: {},
          }),
          getProviderAuth: async () => ({ openai: [{ type: 'api' }] }),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const openai = result.value.providers.find(provider => provider.providerId === 'openai')
    expect(openai).toMatchObject({
      state: 'connected',
      ownership: ['env'],
      detail: 'Connected via OpenCode environment credential',
    })
    expect(openai?.actions.map(action => action.id)).not.toContain('forget')

    const directoryResult = await adapter.loadDirectory({ runtimeId: 'opencode' })

    expect(directoryResult.ok).toBe(true)
    if (!directoryResult.ok) return
    const directoryOpenai = directoryResult.value.entries.find(entry => entry.providerId === 'openai')
    expect(directoryOpenai).toMatchObject({
      state: 'connected',
      ownership: ['env'],
      detail: 'Connected via OpenCode environment credential',
    })
  })

  test('loads a sanitized paged provider directory from the live OpenCode catalog', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [
            {
              id: 'openrouter',
              authHint: 'api',
              source: 'credentials',
              credentialScopes: ['managed'],
            },
          ],
          availableProviders: ['openrouter'],
          models: ['openrouter/google/gemini-3-flash-preview'],
          diagnostics: ['authorization: Bearer sk-test-secret'],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [
              { id: 'openrouter', name: 'OpenRouter', source: 'configured', models: { 'google/gemini-3-flash-preview': {} } },
              { id: 'bad provider id', name: 'Bad Provider' },
            ],
            default: {
              openrouter: 'google/gemini-3-flash-preview',
            },
          }),
          getProviders: async () => ({
            all: [
              {
                id: 'openrouter',
                name: 'OpenRouter',
                source: 'models.dev',
                models: {
                  'google/gemini-3-flash-preview': {
                    headers: { authorization: 'Bearer sk-test-secret' },
                  },
                },
              },
              { id: 'deepseek', name: 'DeepSeek', source: 'models.dev', models: { 'deepseek-chat': {} } },
              { id: '', name: 'Malformed' },
            ],
            connected: ['openrouter'],
            default: {},
          }),
          getProviderAuth: async () => ({
            openrouter: [{ type: 'api' }],
          }),
          getServerDoc: async () => ({ paths: { '/auth/{providerID}': { delete: {} } } }),
        }),
      },
    })

    const result = await adapter.loadDirectory({
      runtimeId: 'opencode',
      query: 'deep',
      limit: 10,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.entries.map(entry => entry.providerId)).toEqual(['deepseek'])
    expect(result.value.entries[0]).toMatchObject({
      displayName: 'DeepSeek',
      setupKind: 'available-readonly',
      modelCount: 1,
      sources: ['opencode-provider'],
      sourceLabel: 'OpenCode catalog',
    })
    expect(JSON.stringify(result.value)).not.toContain('sk-test-secret')
    expect(result.value.diagnostics.join('\n')).toContain('Skipped 2 malformed OpenCode provider row(s)')
  })

  test('directory exposes connectable providers only when API auth is supported', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [],
          availableProviders: ['custom-provider'],
          models: [],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [
              { id: 'custom-provider', name: 'Custom Provider' },
              { id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI' },
            ],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({
            'cloudflare-workers-ai': [{ type: 'api' }],
            'custom-provider': [{ type: 'oauth' }],
          }),
        }),
      },
    })

    const result = await adapter.loadDirectory({
      runtimeId: 'opencode',
      filter: 'connectable',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.entries.map(entry => entry.providerId)).toEqual([
      'opencode',
      'openrouter',
      'cloudflare-workers-ai',
    ])
    expect(result.value.entries.find(entry =>
      entry.providerId === 'cloudflare-workers-ai')?.actions.map(action => action.id)).toEqual(['connect'])
  })

  test('keeps model-id search working from the cached provider directory', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [],
          availableProviders: ['gateway'],
          models: [],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [
              {
                id: 'gateway',
                name: 'Gateway',
                models: {
                  'qwen/qwen3-coder': {},
                },
              },
            ],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const unfiltered = await adapter.loadDirectory({
      runtimeId: 'opencode',
      limit: 10,
    })
    expect(unfiltered.ok).toBe(true)
    if (!unfiltered.ok) return
    expect(unfiltered.value.entries.map(entry => entry.providerId)).toContain('gateway')

    const cachedSearch = await adapter.loadDirectory({
      runtimeId: 'opencode',
      query: 'qwen3-coder',
      limit: 10,
    })

    expect(cachedSearch.ok).toBe(true)
    if (!cachedSearch.ok) return
    expect(cachedSearch.value.entries.map(entry => entry.providerId)).toEqual(['gateway'])
  })

  test('loads the provider view from the selected project profile', async () => {
    const probeCalls: Array<string | null | undefined> = []
    const ensureHostCalls: string[] = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (projectPath) => {
          probeCalls.push(projectPath)
          return inventory({ projectPath: projectPath ?? '/tmp/project' })
        },
      },
      hostManager: {
        ensureHost: async ({ projectPath }) => {
          ensureHostCalls.push(projectPath)
          return host()
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], connected: [], default: {} }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const result = await adapter.loadView({
      runtimeId: 'opencode',
      projectPath: '/tmp/selected-project',
    })

    expect(result.ok).toBe(true)
    expect(probeCalls).toEqual(['/tmp/selected-project'])
    expect(ensureHostCalls).toEqual(['/tmp/selected-project'])
  })

  test('does not invent API-key connect for unknown providers without advertised API auth', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          availableProviders: ['custom-ai'],
          models: ['custom-ai/model-a'],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [{ id: 'custom-ai', name: 'Custom AI', models: { 'model-a': {} } }],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'custom-ai', name: 'Custom AI' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const custom = result.value.providers.find(provider => provider.providerId === 'custom-ai')
    expect(custom?.authMethods).toEqual([])
    expect(custom?.actions.map(action => action.id)).toEqual(['configure'])
    expect(custom?.actions[0]?.enabled).toBe(false)
  })

  test('rejects non-api provider connects before OpenCode auth writes', async () => {
    let setProviderAuthCalled = false
    const authWrites: Array<{ authPath: string; providerId: string; apiKey: string }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          availableProviders: ['custom-ai'],
          models: ['custom-ai/model-a'],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [{ id: 'custom-ai', name: 'Custom AI', models: { 'model-a': {} } }],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'custom-ai', name: 'Custom AI' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({}),
          setProviderAuth: async () => {
            setProviderAuthCalled = true
            return true
          },
        }),
      },
      authStore: {
        upsertApiKey: async input => {
          authWrites.push(input)
        },
        removeCredential: async () => {},
      },
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'custom-ai',
      apiKey: 'sk-test-secret',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsupported-auth-method')
    expect(setProviderAuthCalled).toBe(false)
    expect(authWrites).toEqual([])
  })

  test('shows forget only when the OpenCode server doc advertises auth delete', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory(),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], connected: ['openai'], default: {} }),
          getProviderAuth: async () => ({ openai: [{ type: 'oauth' }] }),
          getServerDoc: async () => ({
            paths: {
              '/auth/{providerID}': {
                delete: {},
                put: {},
              },
            },
          }),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const openai = result.value.providers.find(provider => provider.providerId === 'openai')
    expect(openai?.actions.map(action => action.id)).toContain('forget')
    expect(openai?.actions.find(action => action.id === 'forget')?.enabled).toBe(true)
  })

  test('connects providers through OpenCode auth set on the managed host', async () => {
    const authWrites: Array<{ providerId: string; key: string }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [],
          availableProviders: [],
          models: [],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [{ id: 'openrouter', name: 'OpenRouter', models: { 'moonshotai/kimi-k2': {} } }],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'openrouter', name: 'OpenRouter' }],
            connected: ['openrouter'],
            default: {},
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
          setProviderAuth: async (providerId, body) => {
            authWrites.push({ providerId, key: body.key })
            return true
          },
        }),
      },
      authStore: authStore(),
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      apiKey: 'sk-test-secret',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(authWrites).toEqual([{ providerId: 'openrouter', key: 'sk-test-secret' }])
    expect(result.value).toMatchObject({
      providerId: 'openrouter',
      state: 'connected',
      ownership: ['managed'],
    })
  })

  test('persists accepted OpenCode auth writes into the managed auth store after live provider evidence', async () => {
    const authWrites: Array<{ authPath: string; providerId: string; apiKey: string }> = []
    const probeCalls: Array<{ bypassCache: boolean | undefined }> = []
    let authApplied = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => {
          probeCalls.push({ bypassCache: options?.bypassCache })
          return inventory(options?.bypassCache
            ? {
                connectedProviders: [
                  {
                    id: 'openrouter',
                    authHint: 'api',
                    source: 'credentials',
                    credentialScopes: ['managed'],
                  },
                ],
                availableProviders: ['openrouter'],
                models: ['openrouter/moonshotai/kimi-k2:free'],
              }
            : {
                connectedProviders: [],
                availableProviders: [],
                models: [],
              })
        },
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [{ id: 'openrouter', name: 'OpenRouter' }],
            connected: authApplied ? ['openrouter'] : [],
            default: {},
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
          setProviderAuth: async () => {
            authApplied = true
            return true
          },
        }),
      },
      authStore: {
        upsertApiKey: async input => {
          authWrites.push(input)
        },
        removeCredential: async () => {},
      },
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      apiKey: 'sk-test-secret',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(authWrites).toEqual([
      {
        authPath: '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
        providerId: 'openrouter',
        apiKey: 'sk-test-secret',
      },
      {
        authPath: '/tmp/profile/data/opencode/auth.json',
        providerId: 'openrouter',
        apiKey: 'sk-test-secret',
      },
    ])
    expect(probeCalls).toEqual([
      { bypassCache: undefined },
      { bypassCache: true },
    ])
    expect(result.value).toMatchObject({
      providerId: 'openrouter',
      state: 'connected',
      modelCount: 1,
      ownership: ['managed'],
    })
  })

  test('refuses API-key connect when the app-owned global auth path is unavailable', async () => {
    let setProviderAuthCalled = false
    const authWrites: Array<{ authPath: string; providerId: string; apiKey: string }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          profile: {
            ...inventory().profile!,
            globalAuthPath: undefined,
          },
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [{ id: 'openrouter', name: 'OpenRouter' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
          setProviderAuth: async () => {
            setProviderAuthCalled = true
            return true
          },
        }),
      },
      authStore: {
        upsertApiKey: async input => {
          authWrites.push(input)
        },
        removeCredential: async () => {},
      },
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      apiKey: 'sk-test-secret',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('runtime-unhealthy')
    expect(result.error.message).toContain('global auth store path')
    expect(setProviderAuthCalled).toBe(false)
    expect(authWrites).toEqual([])
  })

  test('redacts API keys from connect failures', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory(),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], connected: [], default: {} }),
          getProviderAuth: async () => ({}),
          setProviderAuth: async () => {
            throw new Error('failed for sk-test-secret')
          },
        }),
      },
      authStore: authStore(),
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      apiKey: 'sk-test-secret',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('auth-failed')
    expect(result.error.message).toContain('[redacted]')
    expect(result.error.message).not.toContain('sk-test-secret')
  })

  test('treats false OpenCode auth writes as connect failures', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory(),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], connected: [], default: {} }),
          getProviderAuth: async () => ({}),
          setProviderAuth: async () => false,
        }),
      },
      authStore: authStore(),
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      apiKey: 'sk-test-secret',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('auth-failed')
    expect(result.error.message).not.toContain('sk-test-secret')
  })

  test('treats OpenCode auth writes without connected provider evidence as failures', async () => {
    let deleteCalled = false
    const authWrites: Array<{ authPath: string; providerId: string; apiKey: string }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [],
          availableProviders: [],
          models: [],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], connected: [], default: {} }),
          getProviderAuth: async () => ({}),
          setProviderAuth: async () => true,
          deleteProviderAuth: async () => {
            deleteCalled = true
            return true
          },
        }),
      },
      authStore: {
        upsertApiKey: async input => {
          authWrites.push(input)
        },
        removeCredential: async () => {},
      },
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      apiKey: 'sk-test-secret',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('auth-failed')
    expect(result.error.message).not.toContain('sk-test-secret')
    expect(deleteCalled).toBe(true)
    expect(authWrites).toEqual([])
  })

  test('does not persist API keys when OpenCode only reports environment-owned evidence', async () => {
    let deleteCalled = false
    const authWrites: Array<{ authPath: string; providerId: string; apiKey: string }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [{
            id: 'openrouter',
            authHint: 'api',
            source: 'environment',
          }],
          availableProviders: ['openrouter'],
          models: ['openrouter/moonshotai/kimi-k2:free'],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [{ id: 'openrouter', name: 'OpenRouter' }],
            connected: ['openrouter'],
            default: {},
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
          setProviderAuth: async () => true,
          deleteProviderAuth: async () => {
            deleteCalled = true
            return true
          },
        }),
      },
      authStore: {
        upsertApiKey: async input => {
          authWrites.push(input)
        },
        removeCredential: async () => {},
      },
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      apiKey: 'sk-test-secret',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('auth-failed')
    expect(deleteCalled).toBe(true)
    expect(authWrites).toEqual([])
  })

  test('guards forget behind OpenCode auth delete capability', async () => {
    let deleteCalled = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory(),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], connected: ['openai'], default: {} }),
          getProviderAuth: async () => ({ openai: [{ type: 'oauth' }] }),
          getServerDoc: async () => ({ paths: { '/auth/{providerID}': { put: {} } } }),
          deleteProviderAuth: async () => {
            deleteCalled = true
            return true
          },
        }),
      },
    })

    const result = await adapter.forgetManagedCredential({
      runtimeId: 'opencode',
      providerId: 'openai',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsupported-action')
    expect(deleteCalled).toBe(false)
  })

  test('forget removes credentials from global auth and every managed profile auth store', async () => {
    const removedAuthPaths: string[] = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => inventory(options?.bypassCache
          ? {
              connectedProviders: [],
              availableProviders: ['openrouter'],
              models: [],
            }
          : {
              connectedProviders: [{
                id: 'openrouter',
                authHint: 'api',
                source: 'credentials',
                credentialScopes: ['managed', 'local'],
              }],
              availableProviders: ['openrouter'],
              models: ['openrouter/moonshotai/kimi-k2:free'],
            }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [{ id: 'openrouter', name: 'OpenRouter' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
          getServerDoc: async () => ({ paths: { '/auth/{providerID}': { delete: {} } } }),
          deleteProviderAuth: async () => true,
        }),
      },
      authStore: {
        upsertApiKey: async () => {},
        removeCredential: async input => {
          removedAuthPaths.push(input.authPath)
        },
      },
      profileManager: {
        listManagedAuthPaths: async () => [
          '/tmp/profile/data/opencode/auth.json',
          '/tmp/other-profile/data/opencode/auth.json',
        ],
      },
    })

    const result = await adapter.forgetManagedCredential({
      runtimeId: 'opencode',
      providerId: 'openrouter',
    })

    expect(result.ok).toBe(true)
    expect(removedAuthPaths).toEqual([
      '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
      '/tmp/profile/data/opencode/auth.json',
      '/tmp/other-profile/data/opencode/auth.json',
    ])
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

  test('loads provider-scoped models lazily with query filtering', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [
            {
              id: 'openrouter',
              authHint: 'api',
              source: 'credentials',
              credentialScopes: ['managed'],
            },
          ],
          availableProviders: ['openrouter'],
          models: [
            'openrouter/openai/gpt-oss-20b:free',
            'openrouter/moonshotai/kimi-k2',
            'openai/gpt-5.4-mini',
          ],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [
              {
                id: 'openrouter',
                name: 'OpenRouter',
                models: {
                  'openai/gpt-oss-20b:free': {},
                  'moonshotai/kimi-k2': {},
                },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'openrouter', name: 'OpenRouter' }],
            connected: ['openrouter'],
            default: {},
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
        }),
      },
    })

    const result = await adapter.loadModels({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      query: 'gpt-oss',
      limit: 10,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.models.map(model => model.modelId)).toEqual([
      'openrouter/openai/gpt-oss-20b:free',
    ])
    expect(result.value.models[0]).toMatchObject({
      providerId: 'openrouter',
      sourceLabel: 'OpenRouter',
      free: true,
      availability: 'untested',
    })
  })

  test('loads provider-scoped models reported only by the live provider catalog', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [
            {
              id: 'openrouter',
              authHint: 'api',
              source: 'credentials',
              credentialScopes: ['managed'],
            },
          ],
          availableProviders: ['openrouter'],
          models: [],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [
              {
                id: 'openrouter',
                name: 'OpenRouter',
                models: {
                  'qwen/qwen3-coder': {},
                },
              },
            ],
            connected: ['openrouter'],
            default: {},
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
        }),
      },
    })

    const result = await adapter.loadModels({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      query: 'qwen3-coder',
      limit: 10,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.models.map(model => model.modelId)).toEqual([
      'openrouter/qwen/qwen3-coder',
    ])
  })

  test('uses live provider defaults when managed config has no default model', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [
            {
              id: 'openrouter',
              authHint: 'api',
              source: 'credentials',
              credentialScopes: ['managed'],
            },
          ],
          availableProviders: ['openrouter'],
          models: [],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [
              {
                id: 'openrouter',
                name: 'OpenRouter',
                models: {
                  'qwen/qwen3-coder': {},
                },
              },
            ],
            connected: ['openrouter'],
            default: {
              openrouter: 'qwen/qwen3-coder',
            },
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.defaultModel).toBe('openrouter/qwen/qwen3-coder')
    expect(
      result.value.providers.find(provider => provider.providerId === 'openrouter')?.defaultModelId,
    ).toBe('openrouter/qwen/qwen3-coder')
  })

  test('sets an app-managed OpenCode default only after a successful probe', async () => {
    const writes: Array<{ profileRootPath: string; modelId: string }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => inventory({
          connectedProviders: [
            {
              id: 'openrouter',
              authHint: 'api',
              source: 'credentials',
              credentialScopes: ['managed'],
            },
          ],
          availableProviders: ['openrouter'],
          models: ['openrouter/openai/gpt-oss-20b:free'],
          profile: {
            ...inventory().profile!,
            managedConfig: options?.bypassCache
              ? { model: 'openrouter/openai/gpt-oss-20b:free' }
              : {},
          },
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [
              {
                id: 'openrouter',
                name: 'OpenRouter',
                models: { 'openai/gpt-oss-20b:free': {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'openrouter', name: 'OpenRouter' }],
            connected: ['openrouter'],
            default: {},
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
        }),
      },
      executionProbe: {
        probeModel: async input => ({
          providerId: 'opencode',
          modelId: input.selectedModel,
          probePrompt: 'Output only the single word PONG.',
          expectedOutput: 'PONG',
          outcome: 'available',
          reason: null,
          durationMs: 10,
          rawStatus: null,
          durableState: 'idle',
          latestAssistantText: 'PONG',
          latestAssistantPreview: 'PONG',
          toolCallCount: 0,
          errorCount: 0,
          diagnostics: [],
        }),
      },
      managedPreferences: {
        setDefaultModel: async (profileRootPath, modelId) => {
          writes.push({ profileRootPath, modelId })
        },
      },
    })

    const result = await adapter.setDefaultModel({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      modelId: 'openrouter/openai/gpt-oss-20b:free',
      probe: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(writes).toEqual([
      {
        profileRootPath: '/tmp/profile',
        modelId: 'openrouter/openai/gpt-oss-20b:free',
      },
    ])
    expect(result.value.defaultModel).toBe('openrouter/openai/gpt-oss-20b:free')
    expect(
      result.value.providers.find(provider => provider.providerId === 'openrouter')?.defaultModelId,
    ).toBe('openrouter/openai/gpt-oss-20b:free')
  })

  test('invalidates the provider directory cache after changing the default model', async () => {
    let managedDefaultModel: string | null = null
    const buildInventory = () => inventory({
      connectedProviders: [
        {
          id: 'openrouter',
          authHint: 'api',
          source: 'credentials',
          credentialScopes: ['managed'],
        },
      ],
      availableProviders: ['openrouter'],
      models: [],
      profile: {
        ...inventory().profile!,
        managedConfig: managedDefaultModel ? { model: managedDefaultModel } : {},
      },
    })
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => buildInventory(),
      },
      hostManager: {
        ensureHost: async () => ({
          ...host(),
          profile: buildInventory().profile!,
        }),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [
              {
                id: 'openrouter',
                name: 'OpenRouter',
                models: {
                  'old-model': {},
                  'new-model': {},
                },
              },
            ],
            connected: ['openrouter'],
            default: {
              openrouter: 'old-model',
            },
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
        }),
      },
      managedPreferences: {
        setDefaultModel: async (_profileRootPath, modelId) => {
          managedDefaultModel = modelId
        },
      },
    })

    const firstDirectory = await adapter.loadDirectory({
      runtimeId: 'opencode',
      limit: 10,
    })
    expect(firstDirectory.ok).toBe(true)
    if (!firstDirectory.ok) return
    expect(
      firstDirectory.value.entries.find(entry => entry.providerId === 'openrouter')?.defaultModelId,
    ).toBe('openrouter/old-model')

    const setDefaultResult = await adapter.setDefaultModel({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      modelId: 'openrouter/new-model',
      probe: false,
    })
    expect(setDefaultResult.ok).toBe(true)

    const secondDirectory = await adapter.loadDirectory({
      runtimeId: 'opencode',
      limit: 10,
    })
    expect(secondDirectory.ok).toBe(true)
    if (!secondDirectory.ok) return
    expect(
      secondDirectory.value.entries.find(entry => entry.providerId === 'openrouter')?.defaultModelId,
    ).toBe('openrouter/new-model')
  })

  test('tests models when live OpenCode server reports the provider as connected', async () => {
    let probedModel: string | null = null
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [],
          availableProviders: ['opencode'],
          models: ['opencode/nemotron-3-super-free'],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [
              {
                id: 'opencode',
                name: 'OpenCode Zen',
                models: { 'nemotron-3-super-free': {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'opencode', name: 'OpenCode Zen' }],
            connected: ['opencode'],
            default: {},
          }),
          getProviderAuth: async () => ({ opencode: [{ type: 'api' }] }),
        }),
      },
      executionProbe: {
        probeModel: async input => {
          probedModel = input.selectedModel
          return {
            providerId: 'opencode',
            modelId: input.selectedModel,
            probePrompt: 'Output only the single word PONG.',
            expectedOutput: 'PONG',
            outcome: 'available',
            reason: null,
            durationMs: 10,
            rawStatus: null,
            durableState: 'idle',
            latestAssistantText: 'PONG',
            latestAssistantPreview: 'PONG',
            toolCallCount: 0,
            errorCount: 0,
            diagnostics: [],
          }
        },
      },
    })

    const result = await adapter.testModel({
      runtimeId: 'opencode',
      providerId: 'opencode',
      modelId: 'opencode/nemotron-3-super-free',
    })

    expect(result.ok).toBe(true)
    expect(probedModel).toBe('opencode/nemotron-3-super-free')
    if (!result.ok) return
    expect(result.value.availability).toBe('available')
  })

  test('does not save the app-managed default when the probe fails', async () => {
    let wrote = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [
            {
              id: 'openrouter',
              authHint: 'api',
              source: 'credentials',
              credentialScopes: ['managed'],
            },
          ],
          availableProviders: ['openrouter'],
          models: ['openrouter/openai/gpt-oss-20b:free'],
        }),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [
              {
                id: 'openrouter',
                name: 'OpenRouter',
                models: { 'openai/gpt-oss-20b:free': {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'openrouter', name: 'OpenRouter' }],
            connected: ['openrouter'],
            default: {},
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
        }),
      },
      executionProbe: {
        probeModel: async input => ({
          providerId: 'opencode',
          modelId: input.selectedModel,
          probePrompt: 'Output only the single word PONG.',
          expectedOutput: 'PONG',
          outcome: 'unavailable',
          reason: 'model denied',
          durationMs: 10,
          rawStatus: null,
          durableState: 'error',
          latestAssistantText: null,
          latestAssistantPreview: null,
          toolCallCount: 0,
          errorCount: 1,
          diagnostics: ['model denied'],
        }),
      },
      managedPreferences: {
        setDefaultModel: async () => {
          wrote = true
        },
      },
    })

    const result = await adapter.setDefaultModel({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      modelId: 'openrouter/openai/gpt-oss-20b:free',
      probe: true,
    })

    expect(result.ok).toBe(false)
    expect(wrote).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('model-test-failed')
  })
})
