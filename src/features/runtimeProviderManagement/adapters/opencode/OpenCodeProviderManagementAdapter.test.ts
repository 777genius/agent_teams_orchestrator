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

  test('persists accepted OpenCode auth writes into the managed auth store before re-probing', async () => {
    const authWrites: Array<{ authPath: string; providerId: string; apiKey: string }> = []
    const probeCalls: Array<{ bypassCache: boolean | undefined }> = []
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
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
          setProviderAuth: async () => true,
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
