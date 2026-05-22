import { describe, expect, test } from 'bun:test'

import { OpenCodeProviderManagementAdapter } from './OpenCodeProviderManagementAdapter.js'

import type {
  OpenCodeExecutionProbeResult,
  OpenCodeHostHandle,
  OpenCodeInventorySnapshot,
} from '../../../../services/opencode/types.js'
import type {
  ProviderManagementError,
  ProviderManagementResult,
} from '../../domain/types.js'

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
      projectDefaultModelId: null,
      allProjectsDefaultModelId: null,
      effectiveManagedDefaultModelId: null,
      effectiveManagedDefaultSource: null,
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

function expectFailure<T>(result: ProviderManagementResult<T>): ProviderManagementError {
  expect(result.ok).toBe(false)
  if ('error' in result) {
    return result.error
  }
  throw new Error('Expected provider management failure')
}

function executionProbeResult(
  modelId: string,
  outcome: 'available' | 'unavailable' | 'not_authenticated' | 'unknown' = 'available',
  reason: string | null = null,
): OpenCodeExecutionProbeResult {
  return {
    providerId: 'opencode',
    modelId,
    probePrompt: 'Output only the single word PONG.',
    expectedOutput: 'PONG',
    outcome,
    reason,
    durationMs: 10,
    rawStatus: null,
    durableState: outcome === 'available' ? 'idle' as const : 'error' as const,
    latestAssistantText: outcome === 'available' ? 'PONG' : null,
    latestAssistantPreview: outcome === 'available' ? 'PONG' : null,
    toolCallCount: 0,
    errorCount: outcome === 'available' ? 0 : 1,
    diagnostics: reason ? [reason] : [],
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
      'atlascloud',
    ])
  })

  test('returns degraded provider management data when OpenCode inventory probing stalls', async () => {
    const originalBinaryPath = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = process.execPath
    let ensureHostCalled = false
    const probeOptions: Array<{ includeAppMcp?: boolean; abortSignal?: AbortSignal }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryTimeoutMs: 1,
      inventoryService: {
        probe: async (_projectPath, options) => {
          probeOptions.push(options ?? {})
          return new Promise(() => {})
        },
      },
      hostManager: {
        ensureHost: async () => {
          ensureHostCalled = true
          return host()
        },
        releaseHost: async () => {},
      },
    })

    try {
      const viewResult = await adapter.loadView({
        runtimeId: 'opencode',
        projectPath: '/tmp/project',
      })
      const directoryResult = await adapter.loadDirectory({
        runtimeId: 'opencode',
        projectPath: '/tmp/project',
        query: null,
        filter: 'all',
        limit: 50,
        cursor: null,
        refresh: false,
      })

      expect(ensureHostCalled).toBe(false)
      expect(probeOptions).toHaveLength(2)
      expect(probeOptions.every(options => options.includeAppMcp === false)).toBe(true)
      expect(probeOptions.every(options => options.abortSignal?.aborted === true)).toBe(true)
      expect(viewResult.ok).toBe(true)
      expect(directoryResult.ok).toBe(true)
      if (!viewResult.ok || !directoryResult.ok) return
      expect(viewResult.value.runtime.state).toBe('degraded')
      expect(viewResult.value.diagnostics).toContain('OpenCode inventory probe timed out after 1ms')
      expect(directoryResult.value.diagnostics).toContain('OpenCode inventory probe timed out after 1ms')
    } finally {
      if (originalBinaryPath === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
      } else {
        process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = originalBinaryPath
      }
    }
  })

  test('does not run provider writes when OpenCode inventory probing stalls', async () => {
    const originalBinaryPath = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = process.execPath
    let ensureHostCalled = false
    let setProviderAuthCalled = false
    let authWriteCalled = false
    const probeOptions: Array<{ includeAppMcp?: boolean; abortSignal?: AbortSignal }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryTimeoutMs: 1,
      inventoryService: {
        probe: async (_projectPath, options) => {
          probeOptions.push(options ?? {})
          return new Promise(() => {})
        },
      },
      hostManager: {
        ensureHost: async () => {
          ensureHostCalled = true
          return host()
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], connected: [], default: {} }),
          getProviderAuth: async () => ({}),
          setProviderAuth: async () => {
            setProviderAuthCalled = true
            return true
          },
        }),
      },
      authStore: {
        upsertApiAuth: async () => {
          authWriteCalled = true
        },
        removeCredential: async () => {},
      },
    })

    try {
      const result = await adapter.connectProvider({
        runtimeId: 'opencode',
        providerId: 'openrouter',
        method: 'api',
        apiKey: 'sk-test-secret',
        metadata: {},
      })

      const failure = expectFailure(result)
      expect(failure.code).toBe('runtime-unhealthy')
      expect(failure.message).toBe('OpenCode inventory probe timed out after 1ms')
      expect(ensureHostCalled).toBe(false)
      expect(setProviderAuthCalled).toBe(false)
      expect(authWriteCalled).toBe(false)
      expect(probeOptions).toHaveLength(1)
      expect(probeOptions[0]?.includeAppMcp).toBe(false)
      expect(probeOptions[0]?.abortSignal?.aborted).toBe(true)
    } finally {
      if (originalBinaryPath === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
      } else {
        process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = originalBinaryPath
      }
    }
  })

  test('uses a bounded host startup budget only for read-only provider management views', async () => {
    const ensureHostCalls: Array<{
      projectPath?: string | null
      healthTimeoutMs?: number | null
      hostLifetime?: string
      preparedProfile?: unknown
      profileOptions?: { includeAppMcp?: boolean }
    }> = []
    const releasedHosts: string[] = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory(),
      },
      hostManager: {
        ensureHost: async (params) => {
          ensureHostCalls.push(params ?? {})
          return host()
        },
        releaseHost: async (hostKey) => {
          releasedHosts.push(hostKey)
        },
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [{ id: 'openai', name: 'OpenAI', models: { 'gpt-5.4-mini': {} } }],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'openai', name: 'OpenAI', models: { 'gpt-5.4-mini': {} } }],
            connected: ['openai'],
            default: {},
          }),
          getProviderAuth: async () => ({ openai: [{ type: 'api' }] }),
        }),
      },
    })

    const viewResult = await adapter.loadView('opencode')
    const directoryResult = await adapter.loadDirectory({
      runtimeId: 'opencode',
      query: null,
      filter: 'all',
      limit: 50,
      cursor: null,
      refresh: true,
    })
    const modelsResult = await adapter.loadModels({
      runtimeId: 'opencode',
      providerId: 'openai',
      query: null,
      limit: 50,
    })

    expect(viewResult.ok).toBe(true)
    expect(directoryResult.ok).toBe(true)
    expect(modelsResult.ok).toBe(true)
    expect(ensureHostCalls.map(call => ({
      projectPath: call.projectPath,
      hostLifetime: call.hostLifetime,
      healthTimeoutMs: call.healthTimeoutMs,
      preparedProfile: Boolean(call.preparedProfile),
      includeAppMcp: call.profileOptions?.includeAppMcp,
    }))).toEqual([
      {
        projectPath: '/tmp/project',
        hostLifetime: 'process',
        healthTimeoutMs: 10_000,
        preparedProfile: true,
        includeAppMcp: false,
      },
      {
        projectPath: '/tmp/project',
        hostLifetime: 'process',
        healthTimeoutMs: 10_000,
        preparedProfile: true,
        includeAppMcp: false,
      },
      {
        projectPath: '/tmp/project',
        hostLifetime: 'process',
        healthTimeoutMs: undefined,
        preparedProfile: false,
        includeAppMcp: undefined,
      },
    ])
    expect(releasedHosts).toEqual(['host-key', 'host-key', 'host-key'])
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
      'atlascloud',
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

  test('does not mark Atlas Cloud connected from config-only OpenCode provider state', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [],
          availableProviders: ['atlascloud'],
          models: ['atlascloud/deepseek-ai/deepseek-v3.2'],
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
                id: 'atlascloud',
                name: 'Atlas Cloud',
                models: {
                  'deepseek-ai/DeepSeek-V3.1': {},
                  'deepseek-ai/deepseek-v3.2': {},
                },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'atlascloud', name: 'Atlas Cloud' }],
            connected: ['atlascloud'],
            default: {},
          }),
          getProviderAuth: async () => ({ atlascloud: [{ type: 'api' }] }),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const atlasCloud = result.value.providers.find(provider => provider.providerId === 'atlascloud')
    expect(atlasCloud).toMatchObject({
      state: 'available',
      ownership: [],
      modelCount: 2,
      detail: 'Provider is visible in the OpenCode model catalog',
    })
    expect(atlasCloud?.actions.map(action => action.id)).toEqual(['connect'])
  })

  test('keeps the current OpenCode default in the configured models panel even before catalog hydration', async () => {
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
            providers: [{ id: 'openrouter', name: 'OpenRouter' }],
            default: {
              openrouter: 'moonshotai/kimi-k2',
            },
          }),
          getProviders: async () => ({
            all: [{ id: 'openrouter', name: 'OpenRouter' }],
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
    expect(result.value.defaultModel).toBe('openrouter/moonshotai/kimi-k2')
    expect(result.value.configuredModels).toHaveLength(1)
    expect(result.value.configuredModels[0]).toMatchObject({
      modelId: 'openrouter/moonshotai/kimi-k2',
      providerId: 'openrouter',
      sourceLabel: 'OpenRouter',
      default: true,
      routeKind: 'catalog_provider',
      accessKind: 'unknown_model',
    })
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
      setupKind: 'connect-api-key',
      modelCount: 1,
      sources: ['opencode-provider'],
      sourceLabel: 'OpenCode catalog',
      metadata: {
        supportedInlineAuth: true,
      },
    })
    expect(JSON.stringify(result.value)).not.toContain('sk-test-secret')
    expect(result.value.diagnostics.join('\n')).toContain('Skipped 2 malformed OpenCode provider row(s)')
  })

  test('directory exposes configured local providers as selectable without manual setup copy', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [],
          availableProviders: ['llama.cpp'],
          models: ['llama.cpp/qwen-test:0.5b'],
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
                id: 'llama.cpp',
                name: 'llama.cpp',
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: 'http://127.0.0.1:8080/v1' },
                models: { 'qwen-test:0.5b': {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({ all: [], connected: [], default: {} }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const result = await adapter.loadDirectory({
      runtimeId: 'opencode',
      query: 'llama',
      limit: 10,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.entries).toHaveLength(1)
    expect(result.value.entries[0]).toMatchObject({
      providerId: 'llama.cpp',
      setupKind: 'available-readonly',
      detail: 'Configured local OpenCode model route is available',
      metadata: {
        configuredAuthless: true,
        requiresManualConfig: false,
      },
    })
    expect(result.value.entries[0]?.actions.map(action => action.id)).toEqual([
      'use',
      'test',
      'set-default',
    ])
    expect(result.value.entries[0]?.actions.map(action => action.label)).not.toContain(
      'Manual setup required',
    )
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
      'atlascloud',
      'cloudflare-workers-ai',
    ])
    expect(result.value.entries.find(entry =>
      entry.providerId === 'cloudflare-workers-ai')?.actions.map(action => action.id)).toEqual(['connect'])
  })

  test('orders connectable directory providers before read-only available providers', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [],
          availableProviders: ['clarifai', 'cloudflare-ai-gateway'],
          models: ['clarifai/claude-sonnet-4-5', 'cloudflare-ai-gateway/claude-sonnet-4-5'],
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
              { id: 'clarifai', name: 'Clarifai', models: { 'claude-sonnet-4-5': {} } },
              {
                id: 'cloudflare-ai-gateway',
                name: 'Cloudflare AI Gateway',
                models: { 'claude-sonnet-4-5': {} },
              },
            ],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({
            'cloudflare-ai-gateway': [{ type: 'api' }],
          }),
        }),
      },
    })

    const result = await adapter.loadDirectory({
      runtimeId: 'opencode',
      query: 'cl',
      limit: 10,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.entries.map(entry => entry.providerId)).toEqual([
      'atlascloud',
      'cloudflare-ai-gateway',
      'clarifai',
    ])
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

    const failure = expectFailure(result)
    expect(failure.code).toBe('unsupported-auth-method')
    expect(setProviderAuthCalled).toBe(false)
    expect(authWrites).toEqual([])
  })

  test('loads setup forms from OpenCode auth prompts', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          availableProviders: ['cloudflare-ai-gateway'],
          models: ['cloudflare-ai-gateway/claude-sonnet-4-5'],
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
            all: [{ id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({
            'cloudflare-ai-gateway': [{
              type: 'api',
              label: 'Gateway API token',
              prompts: [
                {
                  type: 'text',
                  key: 'accountId',
                  message: 'Enter your Cloudflare Account ID',
                  placeholder: 'account-id',
                },
                {
                  type: 'text',
                  key: 'gatewayId',
                  message: 'Enter your Cloudflare AI Gateway ID',
                  placeholder: 'gateway-id',
                },
              ],
            }],
          }),
        }),
      },
    })

    const result = await adapter.loadSetupForm({
      runtimeId: 'opencode',
      providerId: 'cloudflare-ai-gateway',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      providerId: 'cloudflare-ai-gateway',
      method: 'api',
      supported: true,
      source: 'opencode-auth',
      secret: {
        label: 'Gateway API token',
      },
    })
    expect(result.value.prompts.map(prompt => prompt.key)).toEqual(['accountId', 'gatewayId'])
  })

  test('loads curated setup forms for documented catalog providers without provider auth schema', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
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
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [{ id: 'openrouter', name: 'OpenRouter' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const result = await adapter.loadSetupForm({
      runtimeId: 'opencode',
      providerId: 'openrouter',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      providerId: 'openrouter',
      method: 'api',
      supported: true,
      source: 'curated',
      secret: {
        label: 'API key',
      },
    })
  })

  test('connects prompted API auth with metadata and persists the full app-managed auth shape', async () => {
    const authBodies: unknown[] = []
    const authWrites: Array<{ authPath: string; providerId: string; auth: unknown }> = []
    let authApplied = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => inventory(options?.bypassCache
          ? {
              connectedProviders: [{
                id: 'cloudflare-ai-gateway',
                authHint: 'api',
                source: 'credentials',
                credentialScopes: ['managed'],
              }],
              availableProviders: ['cloudflare-ai-gateway'],
              models: ['cloudflare-ai-gateway/claude-sonnet-4-5'],
            }
          : {
              connectedProviders: [],
              availableProviders: ['cloudflare-ai-gateway'],
              models: ['cloudflare-ai-gateway/claude-sonnet-4-5'],
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
            all: [{ id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway' }],
            connected: authApplied ? ['cloudflare-ai-gateway'] : [],
            default: {},
          }),
          getProviderAuth: async () => ({
            'cloudflare-ai-gateway': [{
              type: 'api',
              label: 'Gateway API token',
              prompts: [
                { type: 'text', key: 'accountId', message: 'Account ID' },
                { type: 'text', key: 'gatewayId', message: 'Gateway ID' },
              ],
            }],
          }),
          setProviderAuth: async (_providerId, body) => {
            authBodies.push(body)
            authApplied = true
            return true
          },
        }),
      },
      authStore: {
        upsertApiAuth: async input => {
          authWrites.push(input)
        },
        removeCredential: async () => {},
      },
    })

    const result = await adapter.connectProvider({
      runtimeId: 'opencode',
      providerId: 'cloudflare-ai-gateway',
      method: 'api',
      apiKey: 'cf-secret',
      metadata: {
        accountId: 'account-123',
        gatewayId: 'gateway-123',
      },
    })

    expect(result.ok).toBe(true)
    expect(authBodies).toEqual([{
      type: 'api',
      key: 'cf-secret',
      metadata: {
        accountId: 'account-123',
        gatewayId: 'gateway-123',
      },
    }])
    expect(authWrites.map(write => write.auth)).toEqual(authBodies.concat(authBodies))
  })

  test('rolls back OpenCode and mirrored auth when app-managed persistence fails', async () => {
    let deleteCalled = false
    const removedAuthPaths: string[] = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [{
            id: 'openrouter',
            authHint: 'api',
            source: 'credentials',
            credentialScopes: ['managed'],
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
          getConfigProviders: async () => ({
            providers: [{ id: 'openrouter', name: 'OpenRouter', models: { 'moonshotai/kimi-k2:free': {} } }],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'openrouter', name: 'OpenRouter' }],
            connected: ['openrouter'],
            default: {},
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
          getServerDoc: async () => ({ paths: { '/auth/{providerID}': { delete: {} } } }),
          setProviderAuth: async () => true,
          deleteProviderAuth: async () => {
            deleteCalled = true
            return true
          },
        }),
      },
      authStore: {
        upsertApiAuth: async input => {
          if (input.authPath.endsWith('/data/opencode/auth.json')) {
            throw new Error('managed auth write failed')
          }
        },
        removeCredential: async input => {
          removedAuthPaths.push(input.authPath)
        },
      },
    })

    const result = await adapter.connectProvider({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      method: 'api',
      apiKey: 'sk-test-secret',
      metadata: {},
    })

    const failure = expectFailure(result)
    expect(failure.code).toBe('auth-failed')
    expect(failure.message).not.toContain('sk-test-secret')
    expect(deleteCalled).toBe(true)
    expect(removedAuthPaths).toEqual([
      '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
      '/tmp/profile/data/opencode/auth.json',
    ])
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

  test('connects Atlas Cloud only after storing the user-provided API key', async () => {
    const authWrites: Array<{ authPath: string; providerId: string; key: string }> = []
    const modelProbes: Array<{ selectedModel: string; bypassCache: boolean | undefined }> = []
    let authApplied = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => inventory(options?.bypassCache
          ? {
              connectedProviders: [
                {
                  id: 'atlascloud',
                  authHint: 'api',
                  source: 'credentials',
                  credentialScopes: ['managed'],
                },
              ],
              availableProviders: ['atlascloud'],
              models: ['atlascloud/deepseek-ai/deepseek-v3.2'],
            }
          : {
              connectedProviders: [],
              availableProviders: ['atlascloud'],
              models: ['atlascloud/deepseek-ai/deepseek-v3.2'],
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
                id: 'atlascloud',
                name: 'Atlas Cloud',
                models: {
                  'deepseek-ai/DeepSeek-V3.1': {},
                  'deepseek-ai/deepseek-v3.2': {},
                },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'atlascloud', name: 'Atlas Cloud' }],
            connected: authApplied ? ['atlascloud'] : [],
            default: {},
          }),
          getProviderAuth: async () => ({ atlascloud: [{ type: 'api' }] }),
          setProviderAuth: async () => {
            authApplied = true
            return true
          },
        }),
      },
      authStore: {
        upsertApiAuth: async input => {
          authWrites.push({
            authPath: input.authPath,
            providerId: input.providerId,
            key: input.auth.key,
          })
        },
        removeCredential: async () => {},
      },
      executionProbe: {
        probeModel: async input => {
          modelProbes.push({
            selectedModel: input.selectedModel,
            bypassCache: input.bypassCache,
          })
          return executionProbeResult(input.selectedModel)
        },
      },
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'atlascloud',
      apiKey: 'atlas-user-token',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(authWrites).toEqual([
      {
        authPath: '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
        providerId: 'atlascloud',
        key: 'atlas-user-token',
      },
      {
        authPath: '/tmp/profile/data/opencode/auth.json',
        providerId: 'atlascloud',
        key: 'atlas-user-token',
      },
    ])
    expect(modelProbes).toEqual([{
      selectedModel: 'atlascloud/deepseek-ai/deepseek-v3.2',
      bypassCache: true,
    }])
    expect(result.value).toMatchObject({
      providerId: 'atlascloud',
      state: 'connected',
      ownership: ['managed'],
    })
  })

  test('rejects Atlas Cloud connect when the user-provided API key fails model execution proof', async () => {
    const authWrites: Array<{ authPath: string; providerId: string; key: string }> = []
    const removedCredentials: Array<{ authPath: string; providerId: string }> = []
    let deleteProviderAuthCalled = false
    let authApplied = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => inventory(options?.bypassCache
          ? {
              connectedProviders: [
                {
                  id: 'atlascloud',
                  authHint: 'api',
                  source: 'credentials',
                  credentialScopes: ['managed'],
                },
              ],
              availableProviders: ['atlascloud'],
              models: ['atlascloud/deepseek-ai/deepseek-v3.2'],
            }
          : {
              connectedProviders: [],
              availableProviders: ['atlascloud'],
              models: ['atlascloud/deepseek-ai/deepseek-v3.2'],
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
                id: 'atlascloud',
                name: 'Atlas Cloud',
                models: { 'deepseek-ai/deepseek-v3.2': {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'atlascloud', name: 'Atlas Cloud' }],
            connected: authApplied ? ['atlascloud'] : [],
            default: {},
          }),
          getProviderAuth: async () => ({ atlascloud: [{ type: 'api' }] }),
          getServerDoc: async () => ({ paths: { '/auth/{providerID}': { delete: {} } } }),
          setProviderAuth: async () => {
            authApplied = true
            return true
          },
          deleteProviderAuth: async () => {
            deleteProviderAuthCalled = true
            return true
          },
        }),
      },
      authStore: {
        upsertApiAuth: async input => {
          authWrites.push({
            authPath: input.authPath,
            providerId: input.providerId,
            key: input.auth.key,
          })
        },
        removeCredential: async input => {
          removedCredentials.push(input)
        },
      },
      executionProbe: {
        probeModel: async input =>
          executionProbeResult(
            input.selectedModel,
            'not_authenticated',
            'Unauthorized bad-atlas-token',
          ),
      },
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'atlascloud',
      apiKey: 'bad-atlas-token',
    })

    const failure = expectFailure(result)
    expect(failure.code).toBe('auth-failed')
    expect(failure.message).toContain('Unauthorized')
    expect(failure.message).not.toContain('bad-atlas-token')
    expect(authWrites).toHaveLength(2)
    expect(deleteProviderAuthCalled).toBe(true)
    expect(removedCredentials).toEqual([
      {
        authPath: '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
        providerId: 'atlascloud',
      },
      {
        authPath: '/tmp/profile/data/opencode/auth.json',
        providerId: 'atlascloud',
      },
    ])
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

  test('keeps a successful connect when post-write inventory refresh times out', async () => {
    const authWrites: Array<{ authPath: string; providerId: string; apiKey: string }> = []
    const removedCredentials: Array<{ authPath: string; providerId: string }> = []
    let probeCallCount = 0
    let authApplied = false
    const timeoutMessage = 'OpenCode inventory probe timed out after 1ms'
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => {
          probeCallCount += 1
          if (probeCallCount > 1) {
            return inventory({
              connectedProviders: [],
              availableProviders: [],
              models: [],
              profile: null,
              probeError: timeoutMessage,
              diagnostics: [timeoutMessage],
            })
          }
          return inventory({
            connectedProviders: [],
            availableProviders: ['openrouter'],
            models: ['openrouter/moonshotai/kimi-k2:free'],
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
        removeCredential: async input => {
          removedCredentials.push(input)
        },
      },
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      apiKey: 'sk-test-secret',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(authWrites).toHaveLength(2)
    expect(removedCredentials).toEqual([])
    expect(result.value).toMatchObject({
      providerId: 'openrouter',
      state: 'connected',
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

    const failure = expectFailure(result)
    expect(failure.code).toBe('runtime-unhealthy')
    expect(failure.message).toContain('global auth store path')
    expect(setProviderAuthCalled).toBe(false)
    expect(authWrites).toEqual([])
  })

  test('redacts API keys from connect failures', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
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

    const failure = expectFailure(result)
    expect(failure.code).toBe('auth-failed')
    expect(failure.message).toContain('[redacted]')
    expect(failure.message).not.toContain('sk-test-secret')
  })

  test('treats false OpenCode auth writes as connect failures', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
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

    const failure = expectFailure(result)
    expect(failure.code).toBe('auth-failed')
    expect(failure.message).not.toContain('sk-test-secret')
  })

  test('rejects seeded curated providers absent from the live catalog before OpenCode auth writes', async () => {
    let setProviderAuthCalled = false
    const authWrites: Array<{ authPath: string; providerId: string; apiKey: string }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
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

    const failure = expectFailure(result)
    expect(failure.code).toBe('provider-missing')
    expect(setProviderAuthCalled).toBe(false)
    expect(authWrites).toEqual([])
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
          getProviders: async () => ({
            all: [{ id: 'openrouter', name: 'OpenRouter' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({}),
          getServerDoc: async () => ({ paths: { '/auth/{providerID}': { delete: {} } } }),
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

    const failure = expectFailure(result)
    expect(failure.code).toBe('auth-failed')
    expect(failure.message).not.toContain('sk-test-secret')
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
          getServerDoc: async () => ({ paths: { '/auth/{providerID}': { delete: {} } } }),
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

    const failure = expectFailure(result)
    expect(failure.code).toBe('auth-failed')
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

    const failure = expectFailure(result)
    expect(failure.code).toBe('unsupported-action')
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

  test('keeps a successful forget when post-delete inventory refresh times out', async () => {
    const removedAuthPaths: string[] = []
    let probeCallCount = 0
    let deleteCalled = false
    const timeoutMessage = 'OpenCode inventory probe timed out after 1ms'
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => {
          probeCallCount += 1
          if (probeCallCount > 1) {
            return inventory({
              connectedProviders: [],
              availableProviders: [],
              models: [],
              profile: null,
              probeError: timeoutMessage,
              diagnostics: [timeoutMessage],
            })
          }
          return inventory({
            connectedProviders: [{
              id: 'openrouter',
              authHint: 'api',
              source: 'credentials',
              credentialScopes: ['managed'],
            }],
            availableProviders: ['openrouter'],
            models: ['openrouter/moonshotai/kimi-k2:free'],
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
            connected: ['openrouter'],
            default: {},
          }),
          getProviderAuth: async () => ({ openrouter: [{ type: 'api' }] }),
          getServerDoc: async () => ({ paths: { '/auth/{providerID}': { delete: {} } } }),
          deleteProviderAuth: async () => {
            deleteCalled = true
            return true
          },
        }),
      },
      authStore: {
        upsertApiKey: async () => {},
        removeCredential: async input => {
          removedAuthPaths.push(input.authPath)
        },
      },
      profileManager: {
        listManagedAuthPaths: async () => [],
      },
    })

    const result = await adapter.forgetManagedCredential({
      runtimeId: 'opencode',
      providerId: 'openrouter',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(deleteCalled).toBe(true)
    expect(removedAuthPaths).toEqual([
      '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
      '/tmp/profile/data/opencode/auth.json',
    ])
    expect(result.value).toMatchObject({
      providerId: 'openrouter',
      state: 'available',
      ownership: [],
    })
  })

  test('preserves local OpenCode auth when managed forget refresh times out', async () => {
    const removedAuthPaths: string[] = []
    let probeCallCount = 0
    const timeoutMessage = 'OpenCode inventory probe timed out after 1ms'
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => {
          probeCallCount += 1
          if (probeCallCount > 1) {
            return inventory({
              connectedProviders: [],
              availableProviders: [],
              models: [],
              profile: null,
              probeError: timeoutMessage,
              diagnostics: [timeoutMessage],
            })
          }
          return inventory({
            connectedProviders: [{
              id: 'openrouter',
              authHint: 'api',
              source: 'credentials',
              credentialScopes: ['managed', 'local'],
            }],
            availableProviders: ['openrouter'],
            models: ['openrouter/moonshotai/kimi-k2:free'],
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
            connected: ['openrouter'],
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
        listManagedAuthPaths: async () => [],
      },
    })

    const result = await adapter.forgetManagedCredential({
      runtimeId: 'opencode',
      providerId: 'openrouter',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(removedAuthPaths).toEqual([
      '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
      '/tmp/profile/data/opencode/auth.json',
    ])
    expect(result.value).toMatchObject({
      providerId: 'openrouter',
      state: 'connected',
      ownership: ['local'],
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

  test('marks provider-scoped zero-cost OpenRouter models as free', async () => {
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
          models: ['openrouter/anthropic/claude-haiku-4.5'],
          modelMetadata: [
            {
              id: 'openrouter/anthropic/claude-haiku-4.5',
              cost: { input: 0, output: 0 },
              context: null,
              limits: null,
              free: true,
              raw: { cost: { input: 0, output: 0 } },
            },
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
                models: { 'anthropic/claude-haiku-4.5': {} },
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
      query: 'haiku',
      limit: 10,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.models[0]).toMatchObject({
      modelId: 'openrouter/anthropic/claude-haiku-4.5',
      providerId: 'openrouter',
      sourceLabel: 'OpenRouter',
      free: true,
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

  test('marks configured local OpenCode models as authless routes that need proof', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [],
          availableProviders: ['llama.cpp'],
          models: ['llama.cpp/qwen-test:0.5b'],
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
                id: 'llama.cpp',
                name: 'llama.cpp',
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: 'http://127.0.0.1:8080/v1' },
                models: { 'qwen-test:0.5b': {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [],
            connected: ['ollama'],
            default: {},
          }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const result = await adapter.loadModels({
      runtimeId: 'opencode',
      providerId: 'llama.cpp',
      limit: 10,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.models).toHaveLength(1)
    expect(result.value.models[0]).toMatchObject({
      modelId: 'llama.cpp/qwen-test:0.5b',
      providerId: 'llama.cpp',
      routeKind: 'configured_local',
      accessKind: 'configured_authless',
      proofState: 'needs_probe',
      requiresExecutionProof: true,
      availability: 'untested',
    })
  })

  test('surfaces configured Ollama Cloud models as launchable authless routes', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [],
          availableProviders: [],
          models: [],
          profile: {
            ...inventory().profile!,
            managedConfig: {
              model: 'ollama/kimi-k2.6:cloud',
              provider: {
                ollama: {
                  models: {
                    'kimi-k2.6:cloud': {
                      limit: {
                        context: 262_144,
                        output: 262_144,
                      },
                      attachment: true,
                      modalities: {
                        input: ['text', 'image'],
                        output: ['text'],
                      },
                      name: 'kimi-k2.6:cloud',
                    },
                  },
                },
              },
            },
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
                id: 'ollama',
                name: 'Ollama',
                models: {
                  'kimi-k2.6:cloud': {
                    limit: {
                      context: 262_144,
                      output: 262_144,
                    },
                    attachment: true,
                    modalities: {
                      input: ['text', 'image'],
                      output: ['text'],
                    },
                    name: 'kimi-k2.6:cloud',
                  },
                },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const viewResult = await adapter.loadView('opencode')
    const directoryResult = await adapter.loadDirectory({
      runtimeId: 'opencode',
      query: 'ollama',
      limit: 10,
    })
    const modelsResult = await adapter.loadModels({
      runtimeId: 'opencode',
      providerId: 'ollama',
      query: 'kimi',
      limit: 10,
    })

    expect(viewResult.ok).toBe(true)
    expect(directoryResult.ok).toBe(true)
    expect(modelsResult.ok).toBe(true)
    if (!viewResult.ok || !directoryResult.ok || !modelsResult.ok) return

    expect(viewResult.value.defaultModel).toBe('ollama/kimi-k2.6:cloud')
    expect(viewResult.value.configuredModels.map(model => model.modelId)).toContain(
      'ollama/kimi-k2.6:cloud',
    )
    expect(viewResult.value.providers.find(provider => provider.providerId === 'ollama')).toMatchObject({
      state: 'available',
      ownership: [],
      detail: 'Configured local OpenCode model route is available',
    })
    expect(
      viewResult.value.providers
        .find(provider => provider.providerId === 'ollama')
        ?.actions.map(action => action.id),
    ).toEqual(['use', 'test', 'set-default'])
    expect(directoryResult.value.entries[0]).toMatchObject({
      providerId: 'ollama',
      displayName: 'Ollama',
      state: 'available',
      ownership: [],
      setupKind: 'available-readonly',
      detail: 'Configured local OpenCode model route is available',
      metadata: {
        configuredAuthless: true,
      },
    })
    expect(directoryResult.value.entries[0]?.actions.map(action => action.id)).toEqual([
      'use',
      'test',
      'set-default',
    ])
    expect(modelsResult.value.models).toHaveLength(1)
    expect(modelsResult.value.models[0]).toMatchObject({
      modelId: 'ollama/kimi-k2.6:cloud',
      providerId: 'ollama',
      displayName: 'kimi-k2.6:cloud',
      sourceLabel: 'Ollama',
      default: true,
      routeKind: 'configured_local',
      accessKind: 'configured_authless',
      proofState: 'needs_probe',
      requiresExecutionProof: true,
    })
  })

  test('tests configured authless local models without requiring a connected provider', async () => {
    let probedModel: string | null = null
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [],
          availableProviders: ['llama.cpp'],
          models: ['llama.cpp/qwen-test:0.5b'],
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
                id: 'llama.cpp',
                name: 'llama.cpp',
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: 'http://127.0.0.1:8080/v1' },
                models: { 'qwen-test:0.5b': {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({ all: [], connected: [], default: {} }),
          getProviderAuth: async () => ({}),
        }),
      },
      executionProbe: {
        probeModel: async input => {
          probedModel = input.selectedModel
          return executionProbeResult(input.selectedModel)
        },
      },
    })

    const result = await adapter.testModel({
      runtimeId: 'opencode',
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
    })

    expect(result.ok).toBe(true)
    expect(probedModel).toBe('llama.cpp/qwen-test:0.5b')
    if (!result.ok) return
    expect(result.value.availability).toBe('available')
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

  test('keeps a successful default update when post-write inventory refresh times out', async () => {
    const writes: Array<{ profileRootPath: string; modelId: string }> = []
    let probeCallCount = 0
    const timeoutMessage = 'OpenCode inventory probe timed out after 1ms'
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => {
          probeCallCount += 1
          if (probeCallCount > 1) {
            return inventory({
              connectedProviders: [],
              availableProviders: [],
              models: [],
              profile: null,
              probeError: timeoutMessage,
              diagnostics: [timeoutMessage],
            })
          }
          return inventory({
            connectedProviders: [
              {
                id: 'openrouter',
                authHint: 'api',
                source: 'credentials',
                credentialScopes: ['managed'],
              },
            ],
            availableProviders: ['openrouter'],
            models: ['openrouter/old-model', 'openrouter/new-model'],
            profile: {
              ...inventory().profile!,
              projectDefaultModelId: 'openrouter/old-model',
              effectiveManagedDefaultModelId: 'openrouter/old-model',
              effectiveManagedDefaultSource: 'project',
              managedConfig: { model: 'openrouter/old-model' },
            },
          })
        },
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
                  'old-model': {},
                  'new-model': {},
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
      managedPreferences: {
        setDefaultModel: async (profileRootPath, modelId) => {
          writes.push({ profileRootPath, modelId })
        },
      },
    })

    const result = await adapter.setDefaultModel({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      modelId: 'openrouter/new-model',
      probe: false,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(writes).toEqual([
      {
        profileRootPath: '/tmp/profile',
        modelId: 'openrouter/new-model',
      },
    ])
    expect(result.value.runtime.state).toBe('ready')
    expect(result.value.projectDefaultModel).toBe('openrouter/new-model')
    expect(result.value.defaultModel).toBe('openrouter/new-model')
    expect(result.value.diagnostics).toContain(timeoutMessage)
  })

  test('sets all-projects default without writing project preferences', async () => {
    const projectWrites: Array<{ profileRootPath: string; modelId: string }> = []
    const allProjectWrites: string[] = []
    let allProjectsDefaultModel: string | null = null
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
          models: ['openrouter/qwen/qwen3-coder'],
          profile: {
            ...inventory().profile!,
            allProjectsDefaultModelId: allProjectsDefaultModel,
            effectiveManagedDefaultModelId: allProjectsDefaultModel,
            effectiveManagedDefaultSource: allProjectsDefaultModel ? 'all_projects' : null,
            managedConfig:
              options?.bypassCache && allProjectsDefaultModel
                ? { model: allProjectsDefaultModel }
                : {},
          },
        }),
        clearCache: () => {},
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
                models: { 'qwen/qwen3-coder': {} },
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
      managedPreferences: {
        setDefaultModel: async (profileRootPath, modelId) => {
          projectWrites.push({ profileRootPath, modelId })
        },
        setAllProjectsDefaultModel: async (modelId) => {
          allProjectWrites.push(modelId)
          allProjectsDefaultModel = modelId
        },
      },
    })

    const result = await adapter.setDefaultModel({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      modelId: 'openrouter/qwen/qwen3-coder',
      scope: 'all_projects',
      probe: false,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(projectWrites).toEqual([])
    expect(allProjectWrites).toEqual(['openrouter/qwen/qwen3-coder'])
    expect(result.value.defaultModel).toBe('openrouter/qwen/qwen3-coder')
    expect(result.value.allProjectsDefaultModel).toBe('openrouter/qwen/qwen3-coder')
    expect(result.value.projectDefaultModel).toBeNull()
    expect(result.value.defaultModelSource).toBe('all_projects')
  })

  test('keeps project default effective after setting all-projects default', async () => {
    const projectWrites: Array<{ profileRootPath: string; modelId: string }> = []
    const allProjectWrites: string[] = []
    let allProjectsDefaultModel: string | null = null
    const projectDefaultModel = 'openrouter/project-model'
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
          models: ['openrouter/qwen/qwen3-coder', projectDefaultModel],
          profile: {
            ...inventory().profile!,
            projectDefaultModelId: projectDefaultModel,
            allProjectsDefaultModelId: allProjectsDefaultModel,
            effectiveManagedDefaultModelId: projectDefaultModel,
            effectiveManagedDefaultSource: 'project',
            managedConfig: {
              model: projectDefaultModel,
              ...(options?.bypassCache && allProjectsDefaultModel
                ? { allProjectsProbeObserved: true }
                : {}),
            },
          },
        }),
        clearCache: () => {},
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
                  'qwen/qwen3-coder': {},
                  'project-model': {},
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
      managedPreferences: {
        setDefaultModel: async (profileRootPath, modelId) => {
          projectWrites.push({ profileRootPath, modelId })
        },
        setAllProjectsDefaultModel: async (modelId) => {
          allProjectWrites.push(modelId)
          allProjectsDefaultModel = modelId
        },
      },
    })

    const result = await adapter.setDefaultModel({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      modelId: 'openrouter/qwen/qwen3-coder',
      scope: 'all_projects',
      probe: false,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(projectWrites).toEqual([])
    expect(allProjectWrites).toEqual(['openrouter/qwen/qwen3-coder'])
    expect(result.value.defaultModel).toBe(projectDefaultModel)
    expect(result.value.projectDefaultModel).toBe(projectDefaultModel)
    expect(result.value.allProjectsDefaultModel).toBe('openrouter/qwen/qwen3-coder')
    expect(result.value.defaultModelSource).toBe('project')
  })

  test('sets configured authless local model as default only after execution proof', async () => {
    const writes: Array<{ profileRootPath: string; modelId: string }> = []
    let probedModel: string | null = null
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => inventory({
          connectedProviders: [],
          availableProviders: ['llama.cpp'],
          models: ['llama.cpp/qwen-test:0.5b'],
          profile: {
            ...inventory().profile!,
            managedConfig: options?.bypassCache ? { model: 'llama.cpp/qwen-test:0.5b' } : {},
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
                id: 'llama.cpp',
                name: 'llama.cpp',
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: 'http://127.0.0.1:8080/v1' },
                models: { 'qwen-test:0.5b': {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({ all: [], connected: [], default: {} }),
          getProviderAuth: async () => ({}),
        }),
      },
      executionProbe: {
        probeModel: async input => {
          probedModel = input.selectedModel
          return executionProbeResult(input.selectedModel)
        },
      },
      managedPreferences: {
        setDefaultModel: async (profileRootPath, modelId) => {
          writes.push({ profileRootPath, modelId })
        },
      },
    })

    const result = await adapter.setDefaultModel({
      runtimeId: 'opencode',
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
      probe: false,
    })

    expect(result.ok).toBe(true)
    expect(probedModel).toBe('llama.cpp/qwen-test:0.5b')
    expect(writes).toEqual([
      {
        profileRootPath: '/tmp/profile',
        modelId: 'llama.cpp/qwen-test:0.5b',
      },
    ])
  })

  test('sets configured authless all-projects default only after execution proof', async () => {
    const allProjectWrites: string[] = []
    let probedModel: string | null = null
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => inventory({
          connectedProviders: [],
          availableProviders: ['llama.cpp'],
          models: ['llama.cpp/qwen-test:0.5b'],
          profile: {
            ...inventory().profile!,
            allProjectsDefaultModelId: options?.bypassCache
              ? 'llama.cpp/qwen-test:0.5b'
              : null,
            effectiveManagedDefaultModelId: options?.bypassCache
              ? 'llama.cpp/qwen-test:0.5b'
              : null,
            effectiveManagedDefaultSource: options?.bypassCache ? 'all_projects' : null,
            managedConfig: options?.bypassCache ? { model: 'llama.cpp/qwen-test:0.5b' } : {},
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
                id: 'llama.cpp',
                name: 'llama.cpp',
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: 'http://127.0.0.1:8080/v1' },
                models: { 'qwen-test:0.5b': {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({ all: [], connected: [], default: {} }),
          getProviderAuth: async () => ({}),
        }),
      },
      executionProbe: {
        probeModel: async input => {
          probedModel = input.selectedModel
          return executionProbeResult(input.selectedModel)
        },
      },
      managedPreferences: {
        setDefaultModel: async () => {
          throw new Error('project preferences should not be written')
        },
        setAllProjectsDefaultModel: async (modelId) => {
          allProjectWrites.push(modelId)
        },
      },
    })

    const result = await adapter.setDefaultModel({
      runtimeId: 'opencode',
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
      scope: 'all_projects',
      probe: false,
    })

    expect(result.ok).toBe(true)
    expect(probedModel).toBe('llama.cpp/qwen-test:0.5b')
    expect(allProjectWrites).toEqual(['llama.cpp/qwen-test:0.5b'])
  })

  test('does not set configured authless local default when execution proof fails', async () => {
    let wrote = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory({
          connectedProviders: [],
          availableProviders: ['llama.cpp'],
          models: ['llama.cpp/qwen-test:0.5b'],
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
                id: 'llama.cpp',
                name: 'llama.cpp',
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: 'http://127.0.0.1:8080/v1' },
                models: { 'qwen-test:0.5b': {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({ all: [], connected: [], default: {} }),
          getProviderAuth: async () => ({}),
        }),
      },
      executionProbe: {
        probeModel: async input => executionProbeResult(input.selectedModel, 'unavailable', 'model denied'),
      },
      managedPreferences: {
        setDefaultModel: async () => {
          wrote = true
        },
      },
    })

    const result = await adapter.setDefaultModel({
      runtimeId: 'opencode',
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
      probe: false,
    })

    expect(wrote).toBe(false)
    const failure = expectFailure(result)
    expect(failure.code).toBe('model-test-failed')
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

    expect(wrote).toBe(false)
    const failure = expectFailure(result)
    expect(failure.code).toBe('model-test-failed')
  })
})
