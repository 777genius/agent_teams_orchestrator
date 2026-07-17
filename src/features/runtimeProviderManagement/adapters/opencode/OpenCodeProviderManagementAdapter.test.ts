import { describe, expect, test } from 'bun:test'

import { OpenCodeProviderManagementAdapter } from './OpenCodeProviderManagementAdapter.js'

import type {
  OpenCodeExecutionProbeResult,
  OpenCodeHostHandle,
  OpenCodeInventorySnapshot,
} from '../../../../services/opencode/types.js'
import type {
  OpenCodeHostLeaseInput,
  OpenCodePersistentHostReconcileOptions,
} from '../../../../services/opencode/OpenCodeHostManager.js'
import type { ProviderManagementError, ProviderManagementResult } from '../../domain/types.js'

function inventory(overrides: Partial<OpenCodeInventorySnapshot> = {}): OpenCodeInventorySnapshot {
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
      globalAuthPath:
        '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
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
    durableState: outcome === 'available' ? ('idle' as const) : ('error' as const),
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
        probe: async () =>
          inventory({
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
      'kiro',
      'atlascloud',
      'cursor-acp',
      'kimi-for-coding',
      'xiaomi-token-plan-cn',
      'xiaomi-token-plan-ams',
      'xiaomi-token-plan-sgp',
      'zai-coding-plan',
    ])
  })

  test('returns degraded provider management data when OpenCode inventory probing stalls', async () => {
    const originalBinaryPath = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = process.execPath
    let ensureHostCalled = false
    const probeOptions: Array<{
      includeAppMcp?: boolean
      abortSignal?: AbortSignal
    }> = []
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
      expect(directoryResult.value.diagnostics).toContain(
        'OpenCode inventory probe timed out after 1ms',
      )
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
    const probeOptions: Array<{
      includeAppMcp?: boolean
      abortSignal?: AbortSignal
    }> = []
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
    const retainedHostLeases: Array<{ hostKey: string; lease: OpenCodeHostLeaseInput }> = []
    const releasedHostLeases: Array<{ hostKey: string; lease: OpenCodeHostLeaseInput }> = []
    const reconcileCalls: OpenCodePersistentHostReconcileOptions[] = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory(),
      },
      hostManager: {
        ensureHost: async params => {
          ensureHostCalls.push(params ?? {})
          return host()
        },
        releaseHost: async hostKey => {
          releasedHosts.push(hostKey)
        },
        retainHostLease: async (hostKey, lease) => {
          retainedHostLeases.push({ hostKey, lease })
        },
        releaseHostLease: async (hostKey, lease) => {
          releasedHostLeases.push({ hostKey, lease })
        },
        reconcilePersistentHosts: async options => {
          reconcileCalls.push(options)
          return { cleaned: 0, remaining: 1, hosts: [], diagnostics: [] }
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
    expect(
      ensureHostCalls.map(call => ({
        projectPath: call.projectPath,
        hostLifetime: call.hostLifetime,
        healthTimeoutMs: call.healthTimeoutMs,
        preparedProfile: Boolean(call.preparedProfile),
        includeAppMcp: call.profileOptions?.includeAppMcp,
      })),
    ).toEqual([
      {
        projectPath: '/tmp/project',
        hostLifetime: 'persistent',
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
        hostLifetime: 'persistent',
        healthTimeoutMs: undefined,
        preparedProfile: false,
        includeAppMcp: undefined,
      },
    ])
    expect(releasedHosts).toEqual(['host-key', 'host-key', 'host-key'])
    expect(retainedHostLeases).toHaveLength(3)
    expect(releasedHostLeases).toEqual(retainedHostLeases)
    expect(new Set(retainedHostLeases.map(({ lease }) => lease.memberName)).size).toBe(3)
    expect(
      retainedHostLeases.every(
        ({ hostKey, lease }) =>
          hostKey === 'host-key' &&
          lease.teamId === '__opencode_preflight__' &&
          lease.laneId === 'provider-management',
      ),
    ).toBe(true)
    expect(reconcileCalls).toHaveLength(3)
    expect(
      reconcileCalls.every(
        options =>
          options.reason === 'provider-management-idle-eviction' &&
          options.staleAgeMs === 10 * 60_000 &&
          options.leaseStaleAgeMs === null &&
          options.preflightLeaseStaleAgeMs === 2 * 60 * 60_000,
      ),
    ).toBe(true)
  })

  test('does not leave a provider-management lease behind when idle eviction fails', async () => {
    const retained: OpenCodeHostLeaseInput[] = []
    const released: OpenCodeHostLeaseInput[] = []
    const releasedHosts: string[] = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory(),
      },
      hostManager: {
        ensureHost: async () => host(),
        retainHostLease: async (_hostKey, lease) => {
          retained.push(lease)
        },
        releaseHostLease: async (_hostKey, lease) => {
          released.push(lease)
        },
        reconcilePersistentHosts: async () => {
          throw new Error('registry temporarily unavailable')
        },
        releaseHost: async hostKey => {
          releasedHosts.push(hostKey)
        },
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({ all: [], connected: [], default: {} }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    expect(retained).toHaveLength(1)
    expect(released).toEqual(retained)
    expect(releasedHosts).toEqual(['host-key'])
  })

  test('uses the live host version for fast directory capability checks', async () => {
    const liveHost = host()
    liveHost.version = '1.17.18'
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            version: null,
            connectedProviders: [
              { id: 'xai', authHint: 'oauth', source: 'credentials' },
            ],
            availableProviders: ['xai'],
            models: ['xai/grok-4.3'],
            diagnostics: [
              'SuperGrok OAuth requires OpenCode 1.15.7 or newer; detected an unknown version',
            ],
          }),
      },
      hostManager: {
        ensureHost: async () => liveHost,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [{ id: 'xai', name: 'xAI', models: { 'grok-4.3': {} } }],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'xai', name: 'xAI', models: { 'grok-4.3': {} } }],
            connected: ['xai'],
            default: {},
          }),
          getProviderAuth: async () => ({ xai: [{ type: 'oauth' }] }),
        }),
      },
    })

    const result = await adapter.loadDirectory({
      runtimeId: 'opencode',
      query: null,
      filter: 'all',
      limit: 50,
      cursor: null,
      refresh: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.diagnostics).not.toContain(
      'SuperGrok OAuth requires OpenCode 1.15.7 or newer; detected an unknown version',
    )
    expect(result.value.entries.find(entry => entry.providerId === 'xai')).toMatchObject({
      state: 'connected',
      ownership: ['managed'],
    })
  })

  test('filters SuperGrok OAuth when the live host version is too old', async () => {
    const liveHost = host()
    liveHost.version = '1.15.6'
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            version: null,
            connectedProviders: [
              { id: 'xai', authHint: 'oauth', source: 'credentials' },
            ],
            availableProviders: ['xai'],
            models: ['xai/grok-4.3'],
          }),
      },
      hostManager: {
        ensureHost: async () => liveHost,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [{ id: 'xai', name: 'xAI', models: { 'grok-4.3': {} } }],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'xai', name: 'xAI', models: { 'grok-4.3': {} } }],
            connected: ['xai'],
            default: {},
          }),
          getProviderAuth: async () => ({ xai: [{ type: 'oauth' }] }),
        }),
      },
    })

    const result = await adapter.loadDirectory({
      runtimeId: 'opencode',
      query: null,
      filter: 'all',
      limit: 50,
      cursor: null,
      refresh: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.entries.find(entry => entry.providerId === 'xai')).toMatchObject({
      state: 'available',
      ownership: [],
      connectedAuthHint: null,
    })
    expect(result.value.diagnostics).toContain(
      'SuperGrok OAuth requires OpenCode 1.15.7 or newer; detected 1.15.6',
    )
  })

  test('normalizes OpenCode provider catalog into the feature view model', async () => {
    const releasedHosts: string[] = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => inventory(),
      },
      hostManager: {
        ensureHost: async () => host(),
        releaseHost: async hostKey => {
          releasedHosts.push(hostKey)
        },
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({
            providers: [
              { id: 'openai', name: 'OpenAI', models: { 'gpt-5.4-mini': {} } },
              {
                id: 'openrouter',
                name: 'OpenRouter',
                models: { 'moonshotai/kimi-k2': {} },
              },
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
      'kiro',
      'atlascloud',
      'cursor-acp',
      'kimi-for-coding',
      'xiaomi-token-plan-cn',
      'xiaomi-token-plan-ams',
      'xiaomi-token-plan-sgp',
      'zai-coding-plan',
    ])

    const openai = result.value.providers.find(provider => provider.providerId === 'openai')
    expect(openai).toMatchObject({
      state: 'connected',
      ownership: ['managed', 'local'],
      detail: 'Connected via app-managed and local OpenCode credentials',
      modelCount: 1,
    })
    expect(openai?.actions.map(action => action.id)).toEqual(['use', 'test', 'set-default'])
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
        probe: async () =>
          inventory({
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

  test('does not report plugin-backed plans connected from config-only provider rows', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: [],
            availableProviders: ['kiro', 'cursor-acp', 'github-copilot', 'xai'],
            models: [
              'kiro/auto',
              'cursor-acp/auto',
              'github-copilot/gpt-5-mini',
              'xai/grok-4.3',
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
              { id: 'kiro', name: 'Kiro', models: { auto: {} } },
              { id: 'cursor-acp', name: 'Cursor ACP', models: { auto: {} } },
              {
                id: 'github-copilot',
                name: 'GitHub Copilot',
                models: { 'gpt-5-mini': {} },
              },
              { id: 'xai', name: 'xAI', models: { 'grok-4.3': {} } },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [
              { id: 'kiro', name: 'Kiro' },
              { id: 'cursor-acp', name: 'Cursor ACP' },
              { id: 'github-copilot', name: 'GitHub Copilot' },
              { id: 'xai', name: 'xAI' },
            ],
            connected: ['kiro', 'cursor-acp', 'github-copilot', 'xai'],
            default: {},
          }),
          getProviderAuth: async () => ({
            kiro: [{ type: 'oauth' }],
            'cursor-acp': [{ type: 'api' }],
            'github-copilot': [{ type: 'oauth' }],
            xai: [{ type: 'oauth' }],
          }),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const providerId of ['kiro', 'cursor-acp', 'github-copilot', 'xai']) {
      const provider = result.value.providers.find(entry => entry.providerId === providerId)
      expect(provider?.state).toBe('available')
      expect(provider?.ownership).toEqual([])
      expect(provider?.actions.some(action => action.id === 'forget')).toBe(false)
    }
  })

  test('reports saved SuperGrok OAuth as unusable when OpenCode is too old', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            version: '1.15.6',
            connectedProviders: [],
            availableProviders: ['xai'],
            models: ['xai/grok-4.3', 'xai/grok-imagine-video'],
            diagnostics: [
              'SuperGrok OAuth requires OpenCode 1.15.7 or newer; detected 1.15.6',
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
            providers: [{
              id: 'xai',
              name: 'xAI',
              models: { 'grok-4.3': {}, 'grok-imagine-video': {} },
            }],
            default: { xai: 'grok-imagine-video' },
          }),
          getProviders: async () => ({
            all: [{
              id: 'xai',
              name: 'xAI',
              models: { 'grok-4.3': {}, 'grok-imagine-video': {} },
            }],
            connected: ['xai'],
            default: { xai: 'grok-imagine-video' },
          }),
          getProviderAuth: async () => ({
            xai: [{ type: 'api', label: 'xAI API key' }],
          }),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const xai = result.value.providers.find(provider => provider.providerId === 'xai')
    expect(result.value.defaultModel).toBe('xai/grok-4.3')
    expect(xai).toMatchObject({
      state: 'error',
      ownership: [],
      defaultModelId: 'xai/grok-4.3',
      detail: expect.stringContaining('1.15.7'),
      actions: [
        expect.objectContaining({
          id: 'configure',
          enabled: false,
          label: 'OpenCode update required',
        }),
      ],
    })
  })

  test('keeps xAI connected through an environment API key when old SuperGrok OAuth is unusable', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            version: '1.15.6',
            connectedProviders: [
              {
                id: 'xai',
                authHint: 'xai_api_key',
                source: 'environment',
              },
            ],
            availableProviders: ['xai'],
            models: ['xai/grok-4.3'],
            diagnostics: [
              'SuperGrok OAuth requires OpenCode 1.15.7 or newer; detected 1.15.6',
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
            providers: [{ id: 'xai', name: 'xAI', models: { 'grok-4.3': {} } }],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'xai', name: 'xAI', models: { 'grok-4.3': {} } }],
            connected: ['xai'],
            default: {},
          }),
          getProviderAuth: async () => ({
            xai: [{ type: 'api', label: 'xAI API key' }],
          }),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.providers.find(provider => provider.providerId === 'xai')).toMatchObject({
      state: 'connected',
      ownership: ['env'],
      detail: 'Connected via OpenCode environment credential',
    })
  })

  test('does not report curated subscription plans connected from config-only provider rows', async () => {
    const providerIds = [
      'zai-coding-plan',
      'kimi-for-coding',
      'xiaomi-token-plan-ams',
    ]
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: [],
            availableProviders: providerIds,
            models: [
              'zai-coding-plan/glm-5.1',
              'kimi-for-coding/kimi-for-coding',
              'xiaomi-token-plan-ams/mimo-v2.5-pro',
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
            providers: providerIds.map(id => ({ id, name: id, models: { default: {} } })),
            default: {},
          }),
          getProviders: async () => ({
            all: providerIds.map(id => ({ id, name: id })),
            connected: providerIds,
            default: {},
          }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const providerId of providerIds) {
      const provider = result.value.providers.find(entry => entry.providerId === providerId)
      expect(provider?.state).toBe('available')
      expect(provider?.ownership).toEqual([])
      expect(provider?.actions.map(action => action.id)).toEqual(['connect'])
    }
  })

  test('keeps the current OpenCode default in the configured models panel even before catalog hydration', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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
        probe: async () =>
          inventory({
            connectedProviders: [
              {
                id: 'openai',
                authHint: 'OPENAI_API_KEY',
                source: 'environment',
              },
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

    const directoryResult = await adapter.loadDirectory({
      runtimeId: 'opencode',
    })

    expect(directoryResult.ok).toBe(true)
    if (!directoryResult.ok) return
    const directoryOpenai = directoryResult.value.entries.find(
      entry => entry.providerId === 'openai',
    )
    expect(directoryOpenai).toMatchObject({
      state: 'connected',
      connectedAuthHint: 'OPENAI_API_KEY',
      ownership: ['env'],
      detail: 'Connected via OpenCode environment credential',
    })
  })

  test('loads a sanitized paged provider directory from the live OpenCode catalog', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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
              {
                id: 'openrouter',
                name: 'OpenRouter',
                source: 'configured',
                models: { 'google/gemini-3-flash-preview': {} },
              },
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
              {
                id: 'deepseek',
                name: 'DeepSeek',
                source: 'models.dev',
                models: { 'deepseek-chat': {} },
              },
              { id: '', name: 'Malformed' },
            ],
            connected: ['openrouter'],
            default: {},
          }),
          getProviderAuth: async () => ({
            openrouter: [{ type: 'api' }],
          }),
          getServerDoc: async () => ({
            paths: { '/auth/{providerID}': { delete: {} } },
          }),
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
    expect(result.value.diagnostics.join('\n')).toContain(
      'Skipped 2 malformed OpenCode provider row(s)',
    )
  })

  test('uses profile-only inventory for provider directory discovery instead of spawning duplicate CLI probes', async () => {
    const inventoryModes: Array<string | undefined> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => {
          inventoryModes.push(options?.mode)
          return inventory({ availableProviders: ['xai'] })
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
            all: [{ id: 'xai', name: 'xAI', models: { 'grok-4': {} } }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({
            xai: [{ type: 'oauth', label: 'SuperGrok' }],
          }),
          getServerDoc: async () => ({ paths: {} }),
        }),
      },
    })

    await adapter.loadDirectory({ runtimeId: 'opencode' })

    expect(inventoryModes).toEqual(['profile'])
  })

  test('forces a full catalog refresh and reads it through a fresh process host', async () => {
    const probeCalls: Array<{
      mode?: string
      bypassCache?: boolean
      refreshModels?: boolean
      includeAppMcp?: boolean
    }> = []
    const hostLifetimes: Array<string | undefined> = []
    const releaseOptions: Array<{ keepPersistentAlive?: boolean } | undefined> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => {
          probeCalls.push({
            mode: options?.mode,
            bypassCache: options?.bypassCache,
            refreshModels: options?.refreshModels,
            includeAppMcp: options?.includeAppMcp,
          })
          return inventory({
            availableProviders: ['google'],
            models: ['google/gemini-3.1-flash-lite'],
          })
        },
      },
      hostManager: {
        ensureHost: async options => {
          hostLifetimes.push(options?.hostLifetime)
          return host()
        },
        releaseHost: async (_hostKey, options) => {
          releaseOptions.push(options)
        },
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [{ id: 'google', name: 'Google', models: { 'gemini-3.1-flash-lite': {} } }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({ google: [{ type: 'api' }] }),
        }),
      },
    })

    const result = await adapter.loadDirectory({
      runtimeId: 'opencode',
      refresh: true,
    })

    expect(result.ok).toBe(true)
    expect(probeCalls).toEqual([
      {
        mode: 'full',
        bypassCache: true,
        refreshModels: true,
        includeAppMcp: false,
      },
    ])
    expect(hostLifetimes).toEqual(['process'])
    expect(releaseOptions).toEqual([{ keepPersistentAlive: false }])
  })

  test('loads dashboard provider summaries without starting a live OpenCode host', async () => {
    const inventoryModes: Array<string | undefined> = []
    let ensureHostCalls = 0
    let clientFactoryCalls = 0
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => {
          inventoryModes.push(options?.mode)
          return inventory({
            profile: {
              ...inventory().profile!,
              managedConfig: {
                provider: {
                  kiro: { name: 'Kiro', models: { auto: {} } },
                  'cursor-acp': { name: 'Cursor ACP', models: { auto: {} } },
                  'zai-coding-plan': {
                    name: 'Z.AI Coding Plan',
                    models: { 'glm-5.2': {} },
                  },
                  'kimi-for-coding': {
                    name: 'Kimi Code Membership',
                    models: { 'kimi-for-coding': {} },
                  },
                  'xiaomi-token-plan-ams': { models: { 'mimo-v2.5-pro': {} } },
                  'xiaomi-token-plan-sgp': { models: { 'mimo-v2.5-pro': {} } },
                  'xiaomi-token-plan-cn': { models: { 'mimo-v2.5-pro': {} } },
                },
              },
            },
            connectedProviders: [
              {
                id: 'xai',
                authHint: 'oauth',
                source: 'credentials',
                credentialScopes: ['managed'],
              },
              {
                id: 'github-copilot',
                authHint: 'oauth',
                source: 'credentials',
                credentialScopes: ['local'],
              },
              {
                id: 'minimax-coding-plan',
                authHint: 'api',
                source: 'credentials',
                credentialScopes: ['managed'],
              },
              {
                id: 'xiaomi-token-plan-sgp',
                authHint: 'api',
                source: 'credentials',
                credentialScopes: ['managed'],
              },
              {
                id: 'kiro',
                authHint: 'oauth',
                source: 'credentials',
                credentialScopes: ['managed'],
              },
              {
                id: 'cursor-acp',
                authHint: 'api',
                source: 'credentials',
                credentialScopes: ['managed'],
              },
            ],
            availableProviders: [],
            models: [],
          })
        },
      },
      hostManager: {
        ensureHost: async () => {
          ensureHostCalls += 1
          return host()
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => {
          clientFactoryCalls += 1
          throw new Error('Summary directory must not create a live client')
        },
      },
    })

    const result = await adapter.loadDirectory({
      runtimeId: 'opencode',
      summary: true,
      limit: 100,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(inventoryModes).toEqual(['summary'])
    expect(ensureHostCalls).toBe(0)
    expect(clientFactoryCalls).toBe(0)
    expect(result.value.entries.map(entry => entry.providerId).sort()).toEqual([
      'cursor-acp',
      'github-copilot',
      'kimi-for-coding',
      'kiro',
      'minimax-coding-plan',
      'xai',
      'xiaomi-token-plan-ams',
      'xiaomi-token-plan-cn',
      'xiaomi-token-plan-sgp',
      'zai-coding-plan',
    ])

    const entry = (providerId: string) =>
      result.value.entries.find(candidate => candidate.providerId === providerId)
    expect(entry('xai')).toMatchObject({
      state: 'connected',
      connectedAuthHint: 'oauth',
      setupKind: 'connected',
    })
    expect(entry('github-copilot')).toMatchObject({
      state: 'connected',
      connectedAuthHint: 'oauth',
      ownership: ['local'],
    })
    expect(entry('minimax-coding-plan')).toMatchObject({
      state: 'connected',
      connectedAuthHint: 'api',
    })
    expect(entry('xiaomi-token-plan-sgp')).toMatchObject({
      state: 'connected',
      connectedAuthHint: 'api',
    })
    expect(entry('zai-coding-plan')).toMatchObject({
      state: 'available',
      setupKind: 'connect-api-key',
      modelCount: 1,
    })
    expect(entry('kimi-for-coding')).toMatchObject({
      state: 'available',
      setupKind: 'connect-api-key',
      modelCount: 1,
    })
    expect(entry('kiro')).toMatchObject({
      state: 'connected',
      metadata: { configuredAuthless: true },
    })
    expect(entry('cursor-acp')).toMatchObject({
      state: 'connected',
      metadata: { configuredAuthless: true },
    })
  })

  test('does not infer companion connectivity from summary config alone', async () => {
    let ensureHostCalls = 0
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            profile: {
              ...inventory().profile!,
              managedConfig: {
                provider: {
                  kiro: { models: { auto: {} } },
                  'cursor-acp': { models: { auto: {} } },
                },
              },
            },
            connectedProviders: [],
            availableProviders: [],
            models: [],
          }),
      },
      hostManager: {
        ensureHost: async () => {
          ensureHostCalls += 1
          return host()
        },
        releaseHost: async () => {},
      },
    })

    const result = await adapter.loadDirectory({ runtimeId: 'opencode', summary: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(ensureHostCalls).toBe(0)
    for (const providerId of ['kiro', 'cursor-acp']) {
      expect(result.value.entries.find(entry => entry.providerId === providerId)).toMatchObject({
        state: 'available',
        metadata: { configuredAuthless: true },
      })
    }
    for (const providerId of ['xai', 'github-copilot']) {
      expect(result.value.entries.find(entry => entry.providerId === providerId)).toMatchObject({
        state: 'not-connected',
        setupKind: 'connect-oauth',
      })
    }
    for (const providerId of [
      'minimax-coding-plan',
      'zai-coding-plan',
      'kimi-for-coding',
      'xiaomi-token-plan-ams',
      'xiaomi-token-plan-sgp',
      'xiaomi-token-plan-cn',
    ]) {
      expect(result.value.entries.find(entry => entry.providerId === providerId)).toMatchObject({
        state: 'not-connected',
        setupKind: 'connect-api-key',
      })
    }
  })

  test('directory exposes configured local providers as selectable without manual setup copy', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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
        probe: async () =>
          inventory({
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
      'kimi-for-coding',
      'xiaomi-token-plan-cn',
      'xiaomi-token-plan-ams',
      'xiaomi-token-plan-sgp',
      'zai-coding-plan',
    ])
    expect(
      result.value.entries
        .find(entry => entry.providerId === 'cloudflare-workers-ai')
        ?.actions.map(action => action.id),
    ).toEqual(['connect'])
  })

  test('orders connectable directory providers before read-only available providers', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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
              {
                id: 'clarifai',
                name: 'Clarifai',
                models: { 'claude-sonnet-4-5': {} },
              },
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
        probe: async () =>
          inventory({
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
        probe: async projectPath => {
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
        probe: async () =>
          inventory({
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
    const authWrites: Array<{
      authPath: string
      providerId: string
      apiKey: string
    }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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
        probe: async () =>
          inventory({
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
            'cloudflare-ai-gateway': [
              {
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
              },
            ],
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

  test('exposes every live OpenCode OAuth and API auth method through one setup form', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: [],
            availableProviders: ['xai'],
            models: ['xai/grok-4'],
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
            all: [{ id: 'xai', name: 'xAI' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({
            xai: [
              { type: 'oauth', label: 'SuperGrok browser login' },
              { type: 'oauth', label: 'SuperGrok device login' },
              { type: 'api', label: 'xAI API key' },
            ],
          }),
          getServerDoc: async () => ({
            paths: {
              '/provider/{providerID}/oauth/authorize': { post: {} },
              '/provider/{providerID}/oauth/callback': { post: {} },
            },
          }),
        }),
      },
    })

    const result = await adapter.loadSetupForm({
      runtimeId: 'opencode',
      providerId: 'xai',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      method: 'oauth',
      supported: true,
      source: 'oauth',
      defaultAuthOptionId: 'oauth:1',
      submitLabel: 'Get browser code',
      description: expect.stringContaining('short device code'),
    })
    expect(result.value.authOptions).toMatchObject([
      { id: 'oauth:0', method: 'oauth', methodIndex: 0, supported: true },
      {
        id: 'oauth:1',
        method: 'oauth',
        methodIndex: 1,
        supported: true,
        label: 'SuperGrok browser code (recommended)',
      },
      { id: 'api:2', method: 'api', methodIndex: 2, supported: true },
    ])
  })

  test('explains the OpenCode update required for SuperGrok while preserving xAI API setup', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: [],
            availableProviders: ['xai'],
            models: ['xai/grok-4'],
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
            all: [{ id: 'xai', name: 'xAI' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({
            xai: [{ type: 'api', label: 'xAI API key' }],
          }),
          getServerDoc: async () => ({ paths: {} }),
        }),
      },
    })

    const result = await adapter.loadSetupForm({
      runtimeId: 'opencode',
      providerId: 'xai',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.defaultAuthOptionId).toBe('api:0')
    expect(result.value.authOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'oauth:update-required',
          method: 'oauth',
          supported: false,
          disabledReason: expect.stringContaining('1.15.7'),
        }),
        expect.objectContaining({
          id: 'api:0',
          method: 'api',
          supported: true,
        }),
      ]),
    )
  })

  test('connects SuperGrok when auto OAuth persists the credential before its callback settles', async () => {
    let connected = false
    const authorizations: Array<Record<string, unknown>> = []
    const ensureHostCalls: Array<{ hostLifetime?: string }> = []
    const releaseHostCalls: Array<{ keepPersistentAlive?: boolean }> = []
    const modelProbes: Array<{ selectedModel: string; bypassCache?: boolean }> = []
    const verificationEvents: Array<Record<string, unknown>> = []
    const credentialWrites: Array<{
      authPath: string
      providerId: string
      credential: Record<string, unknown>
    }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: connected
              ? [
                  {
                    id: 'xai',
                    authHint: 'oauth',
                    source: 'credentials',
                    credentialScopes: ['managed'],
                  },
                ]
              : [],
            availableProviders: ['xai'],
            models: ['xai/grok-4'],
          }),
      },
      hostManager: {
        ensureHost: async params => {
          ensureHostCalls.push(params ?? {})
          return host()
        },
        releaseHost: async (_hostKey, options) => {
          releaseHostCalls.push(options ?? {})
        },
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [{ id: 'xai', name: 'xAI' }],
            connected: connected ? ['xai'] : [],
            default: {},
          }),
          getProviderAuth: async () => ({
            xai: [{ type: 'oauth', label: 'SuperGrok browser login' }],
          }),
          getServerDoc: async () => ({
            paths: {
              '/auth/{providerID}': { delete: {} },
              '/provider/{providerID}/oauth/authorize': { post: {} },
              '/provider/{providerID}/oauth/callback': { post: {} },
            },
          }),
          authorizeProviderOAuth: async (_providerId, body) => {
            authorizations.push(body)
            return {
              url: 'https://auth.x.ai/oauth2/authorize?state=test-state',
              method: 'auto',
              instructions: 'Complete authorization in your browser.',
            }
          },
          completeProviderOAuth: async () => {
            connected = true
            return new Promise<boolean>(() => {})
          },
          deleteProviderAuth: async () => true,
        }),
      },
      authStore: {
        readCredential: async () =>
          connected
            ? {
                type: 'oauth',
                access: 'access-token-never-sent-to-ui',
                refresh: 'refresh-token-never-sent-to-ui',
                expires: 1_900_000_000_000,
              }
            : null,
        upsertCredential: async input => {
          credentialWrites.push(input)
        },
        removeCredential: async () => {},
      },
      profileManager: {
        listManagedAuthPaths: async () => ['/tmp/other-profile/data/opencode/auth.json'],
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

    const result = await adapter.connectProvider(
      {
        runtimeId: 'opencode',
        providerId: 'xai',
        method: 'oauth',
        authMethodIndex: 0,
        authOptionId: 'oauth:0',
        oauthOperationId: 'oauth-test-operation',
        metadata: {},
      },
      {
        authorizationReady: async authorization => {
          expect(authorization).toEqual({
            operationId: 'oauth-test-operation',
            providerId: 'xai',
            displayName: 'xAI',
            authOptionId: 'oauth:0',
            methodIndex: 0,
            authorizationUrl: 'https://auth.x.ai/oauth2/authorize?state=test-state',
            instructions: 'Complete authorization in your browser.',
            completionMethod: 'auto',
          })
        },
        authorizationCompleted: async verification => {
          verificationEvents.push(verification)
        },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      providerId: 'xai',
      state: 'connected',
      connectedAuthHint: 'oauth',
      verifiedModelId: 'xai/grok-4',
    })
    expect(authorizations).toEqual([{ method: 0 }])
    expect(ensureHostCalls).toEqual([expect.objectContaining({ hostLifetime: 'process' })])
    expect(releaseHostCalls).toEqual([{ keepPersistentAlive: false }])
    expect(modelProbes).toEqual([{ selectedModel: 'xai/grok-4', bypassCache: true }])
    expect(verificationEvents).toEqual([
      {
        operationId: 'oauth-test-operation',
        providerId: 'xai',
        displayName: 'xAI',
        authOptionId: 'oauth:0',
        methodIndex: 0,
        completionMethod: 'auto',
      },
    ])
    expect(credentialWrites.map(write => write.authPath).sort()).toEqual(
      [
        '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
        '/tmp/other-profile/data/opencode/auth.json',
        '/tmp/profile/data/opencode/auth.json',
      ].sort(),
    )
  })

  test('restores the previous SuperGrok OAuth credential when reconnect verification fails', async () => {
    const previousCredential = {
      type: 'oauth',
      access: 'previous-supergrok-access',
      refresh: 'previous-supergrok-refresh',
    }
    const replacementCredential = {
      type: 'oauth',
      access: 'replacement-supergrok-access',
      refresh: 'replacement-supergrok-refresh',
    }
    const credentialWrites: Array<{
      authPath: string
      providerId: string
      credential: Record<string, unknown>
    }> = []
    const removedCredentials: Array<{ authPath: string; providerId: string }> = []
    let oauthCompleted = false
    let deleteProviderAuthCalled = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: [],
            availableProviders: ['xai'],
            models: ['xai/grok-4.3'],
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
            all: [{ id: 'xai', name: 'xAI' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({
            xai: [{ type: 'oauth', label: 'SuperGrok browser login' }],
          }),
          getServerDoc: async () => ({
            paths: {
              '/auth/{providerID}': { delete: {} },
              '/provider/{providerID}/oauth/authorize': { post: {} },
              '/provider/{providerID}/oauth/callback': { post: {} },
            },
          }),
          authorizeProviderOAuth: async () => ({
            url: 'https://auth.x.ai/oauth2/authorize?state=reconnect-state',
            method: 'auto',
            instructions: 'Complete authorization in your browser.',
          }),
          completeProviderOAuth: async () => {
            oauthCompleted = true
            return true
          },
          deleteProviderAuth: async () => {
            deleteProviderAuthCalled = true
            return true
          },
        }),
      },
      authStore: {
        readCredential: async () =>
          oauthCompleted ? replacementCredential : previousCredential,
        upsertCredential: async input => {
          credentialWrites.push(input)
        },
        removeCredential: async input => {
          removedCredentials.push(input)
        },
      },
      profileManager: {
        listManagedAuthPaths: async () => ['/tmp/other-profile/data/opencode/auth.json'],
      },
    })

    const result = await adapter.connectProvider(
      {
        runtimeId: 'opencode',
        providerId: 'xai',
        method: 'oauth',
        authMethodIndex: 0,
        authOptionId: 'oauth:0',
        oauthOperationId: 'supergrok-reconnect-test',
        metadata: {},
      },
      { authorizationReady: async () => undefined },
    )

    const failure = expectFailure(result)
    expect(failure.code).toBe('auth-failed')
    expect(deleteProviderAuthCalled).toBe(true)
    expect(removedCredentials).toEqual([])
    const restoredWrites = credentialWrites.filter(
      write => write.credential.access === previousCredential.access,
    )
    expect(restoredWrites.map(write => write.authPath).sort()).toEqual(
      [
        '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
        '/tmp/other-profile/data/opencode/auth.json',
        '/tmp/profile/data/opencode/auth.json',
      ].sort(),
    )
  })

  test('recovers a changed Copilot credential from a hanging callback and returns the real unsupported-plan error', async () => {
    let connected = false
    let callbackStarted = false
    let rejectCallback: (reason?: unknown) => void = () => {
      throw new Error('Copilot callback did not start')
    }
    let deleteProviderAuthCalled = false
    const probedModelIds: string[] = []
    const removedCredentials: Array<{ authPath: string; providerId: string }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: connected
              ? [
                  {
                    id: 'github-copilot',
                    authHint: 'oauth',
                    source: 'credentials',
                    credentialScopes: ['managed'],
                  },
                ]
              : [],
            availableProviders: ['github-copilot'],
            models: ['github-copilot/gpt-5-mini', 'github-copilot/gpt-4.1'],
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
            all: [{ id: 'github-copilot', name: 'GitHub Copilot' }],
            connected: connected ? ['github-copilot'] : [],
            default: {},
          }),
          getProviderAuth: async () => ({
            'github-copilot': [{ type: 'oauth', label: 'Sign in with GitHub' }],
          }),
          getServerDoc: async () => ({
            paths: {
              '/auth/{providerID}': { delete: {} },
              '/provider/{providerID}/oauth/authorize': { post: {} },
              '/provider/{providerID}/oauth/callback': { post: {} },
            },
          }),
          authorizeProviderOAuth: async () => ({
            url: 'https://github.com/login/device',
            method: 'auto',
            instructions: 'Complete authorization in your browser.',
          }),
          completeProviderOAuth: async () => {
            callbackStarted = true
            return new Promise<boolean>((_resolve, reject) => {
              rejectCallback = reject
            })
          },
          deleteProviderAuth: async () => {
            deleteProviderAuthCalled = true
            connected = false
            return true
          },
        }),
      },
      authStore: {
        readCredential: async () =>
          connected ? { type: 'oauth', access: 'copilot-free-token' } : null,
        upsertCredential: async () => {},
        removeCredential: async input => {
          removedCredentials.push(input)
        },
      },
      profileManager: {
        listManagedAuthPaths: async () => [],
      },
      executionProbe: {
        probeModel: async input => {
          probedModelIds.push(input.selectedModel)
          return executionProbeResult(
            input.selectedModel,
            'unavailable',
            'The selected model is unsupported for this Copilot account',
          )
        },
      },
    })

    const result = await adapter.connectProvider(
      {
        runtimeId: 'opencode',
        providerId: 'github-copilot',
        method: 'oauth',
        authMethodIndex: 0,
        authOptionId: 'oauth:0',
        oauthOperationId: 'copilot-free-test',
        metadata: {},
      },
      {
        authorizationReady: async () => {
          connected = true
        },
      },
    )

    const failure = expectFailure(result)
    expect(failure.code).toBe('model-test-failed')
    expect(failure.message).toContain('unsupported for this Copilot account')
    expect(probedModelIds).toEqual([
      'github-copilot/gpt-4.1',
      'github-copilot/gpt-5-mini',
    ])
    expect(callbackStarted).toBe(true)
    rejectCallback(new Error('late callback shutdown'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(deleteProviderAuthCalled).toBe(true)
    expect(removedCredentials).toEqual([
      {
        authPath: '/tmp/profile/data/opencode/auth.json',
        providerId: 'github-copilot',
      },
      {
        authPath:
          '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
        providerId: 'github-copilot',
      },
    ])
  })

  test('does not accept a stale pre-existing Copilot credential as OAuth completion evidence', async () => {
    const previousCredential = {
      type: 'oauth',
      access: 'stale-copilot-access',
      refresh: 'stale-copilot-refresh',
    }
    const restoredCredentials: Array<{
      authPath: string
      providerId: string
      credential: Record<string, unknown>
    }> = []
    const removedCredentials: Array<{ authPath: string; providerId: string }> = []
    let executionProbeCalled = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: [],
            availableProviders: ['github-copilot'],
            models: ['github-copilot/gpt-5-mini'],
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
            all: [{ id: 'github-copilot', name: 'GitHub Copilot' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({
            'github-copilot': [{ type: 'oauth', label: 'Sign in with GitHub' }],
          }),
          getServerDoc: async () => ({
            paths: {
              '/auth/{providerID}': { delete: {} },
              '/provider/{providerID}/oauth/authorize': { post: {} },
              '/provider/{providerID}/oauth/callback': { post: {} },
            },
          }),
          authorizeProviderOAuth: async () => ({
            url: 'https://github.com/login/device',
            method: 'auto',
            instructions: 'Complete authorization in your browser.',
          }),
          completeProviderOAuth: async () => true,
          deleteProviderAuth: async () => true,
        }),
      },
      authStore: {
        readCredential: async () => previousCredential,
        upsertCredential: async input => {
          restoredCredentials.push(input)
        },
        removeCredential: async input => {
          removedCredentials.push(input)
        },
      },
      profileManager: {
        listManagedAuthPaths: async () => [],
      },
      executionProbe: {
        probeModel: async input => {
          executionProbeCalled = true
          return executionProbeResult(input.selectedModel)
        },
      },
    })

    const result = await adapter.connectProvider(
      {
        runtimeId: 'opencode',
        providerId: 'github-copilot',
        method: 'oauth',
        authMethodIndex: 0,
        authOptionId: 'oauth:0',
        oauthOperationId: 'copilot-stale-credential-test',
        metadata: {},
      },
      { authorizationReady: async () => undefined },
    )

    const failure = expectFailure(result)
    expect(failure.code).toBe('auth-failed')
    expect(failure.message).toContain('did not persist a new OAuth credential')
    expect(executionProbeCalled).toBe(false)
    expect(removedCredentials).toEqual([])
    expect(restoredCredentials.map(write => write.authPath).sort()).toEqual(
      [
        '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
        '/tmp/profile/data/opencode/auth.json',
      ].sort(),
    )
  })

  test('passes a future provider authorization code through the generic OAuth callback contract', async () => {
    let connected = false
    const callbacks: Array<Record<string, unknown>> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: connected
              ? [
                  {
                    id: 'future-oauth-provider',
                    authHint: 'oauth',
                    source: 'credentials',
                    credentialScopes: ['managed'],
                  },
                ]
              : [],
            availableProviders: ['future-oauth-provider'],
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
            all: [{ id: 'future-oauth-provider', name: 'Future OAuth Provider' }],
            connected: connected ? ['future-oauth-provider'] : [],
            default: {},
          }),
          getProviderAuth: async () => ({
            'future-oauth-provider': [{ type: 'oauth', label: 'Future OAuth code flow' }],
          }),
          getServerDoc: async () => ({
            paths: {
              '/provider/{providerID}/oauth/authorize': { post: {} },
              '/provider/{providerID}/oauth/callback': { post: {} },
            },
          }),
          authorizeProviderOAuth: async () => ({
            url: 'https://login.example.test/authorize?state=opaque',
            method: 'code',
            instructions: 'Paste the returned code.',
          }),
          completeProviderOAuth: async (_providerId, body) => {
            callbacks.push(body)
            connected = true
            return true
          },
        }),
      },
      authStore: {
        readCredential: async () =>
          connected ? { type: 'oauth', access: 'opaque' } : null,
        upsertCredential: async () => {},
        removeCredential: async () => {},
      },
      profileManager: {
        listManagedAuthPaths: async () => [],
      },
    })

    const result = await adapter.connectProvider(
      {
        runtimeId: 'opencode',
        providerId: 'future-oauth-provider',
        method: 'oauth',
        authMethodIndex: 0,
        authOptionId: 'oauth:0',
        oauthOperationId: 'oauth-code-operation-123',
        metadata: {},
      },
      {
        authorizationReady: async authorization => {
          expect(authorization.completionMethod).toBe('code')
          return { code: 'provider-returned-code' }
        },
      },
    )

    expect(result.ok).toBe(true)
    expect(callbacks).toEqual([{ method: 0, code: 'provider-returned-code' }])
  })

  test('loads curated setup forms for documented catalog providers without provider auth schema', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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

  test('loads plan-specific curated setup forms without starting the OpenCode runtime', async () => {
    let probeCalled = false
    let ensureHostCalled = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => {
          probeCalled = true
          throw new Error('plan setup form must not probe inventory')
        },
      },
      hostManager: {
        ensureHost: async () => {
          ensureHostCalled = true
          throw new Error('plan setup form must not start a host')
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: async () => ({ providers: [], default: {} }),
          getProviders: async () => ({
            all: [
              {
                id: 'minimax-coding-plan',
                name: 'MiniMax Token Plan (minimax.io)',
              },
              { id: 'zai-coding-plan', name: 'Z.AI Coding Plan' },
            ],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const miniMaxResult = await adapter.loadSetupForm({
      runtimeId: 'opencode',
      providerId: 'minimax-coding-plan',
    })
    const zaiResult = await adapter.loadSetupForm({
      runtimeId: 'opencode',
      providerId: 'zai-coding-plan',
    })
    const kimiResult = await adapter.loadSetupForm({
      runtimeId: 'opencode',
      providerId: 'kimi-for-coding',
    })

    expect(miniMaxResult.ok).toBe(true)
    if (!miniMaxResult.ok) return
    expect(miniMaxResult.value).toMatchObject({
      method: 'api',
      supported: true,
      source: 'curated',
      secret: {
        label: 'Token Plan subscription key',
        placeholder: 'sk-cp-...',
      },
    })
    expect(miniMaxResult.value.description).toContain('Token Plan endpoint and quota')

    expect(zaiResult.ok).toBe(true)
    if (!zaiResult.ok) return
    expect(zaiResult.value).toMatchObject({
      method: 'api',
      supported: true,
      source: 'curated',
      secret: {
        label: 'GLM Coding Plan API key',
        placeholder: 'Paste Coding Plan key',
      },
    })
    expect(zaiResult.value.description).toContain('dedicated Z.AI coding endpoint')

    expect(kimiResult.ok).toBe(true)
    if (!kimiResult.ok) return
    expect(kimiResult.value).toMatchObject({
      displayName: 'Kimi Code Membership',
      method: 'api',
      supported: true,
      source: 'curated',
      secret: {
        label: 'Kimi Code membership key',
        placeholder: 'Paste Kimi Code membership key',
      },
    })
    expect(kimiResult.value.description).toContain('Kimi membership quota')
    expect(probeCalled).toBe(false)
    expect(ensureHostCalled).toBe(false)
  })

  test('finds Kimi Code Membership as an inline-connectable curated provider', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            availableProviders: ['kimi-for-coding'],
            models: [
              'kimi-for-coding/kimi-for-coding',
              'kimi-for-coding/kimi-for-coding-highspeed',
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
                id: 'kimi-for-coding',
                name: 'Kimi Code Membership',
                models: {
                  'kimi-for-coding': {},
                  'kimi-for-coding-highspeed': {},
                },
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
      query: 'kimi-for-coding',
      limit: 10,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.entries).toHaveLength(1)
    expect(result.value.entries[0]).toMatchObject({
      providerId: 'kimi-for-coding',
      displayName: 'Kimi Code Membership',
      setupKind: 'connect-api-key',
      actions: [{ id: 'connect', label: 'Connect', enabled: true }],
      metadata: {
        supportedInlineAuth: true,
      },
    })
  })

  test('finds MiniMax Coding Plan as an inline-connectable directory provider', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            availableProviders: ['minimax-coding-plan'],
            models: ['minimax-coding-plan/MiniMax-M3'],
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
                id: 'minimax-coding-plan',
                name: 'MiniMax Token Plan (minimax.io)',
              },
            ],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const result = await adapter.loadDirectory({
      runtimeId: 'opencode',
      query: 'minimax-coding-plan',
      limit: 10,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.totalCount).toBe(1)
    expect(result.value.entries[0]).toMatchObject({
      providerId: 'minimax-coding-plan',
      setupKind: 'connect-api-key',
      actions: [{ id: 'connect', label: 'Connect', enabled: true }],
      metadata: {
        supportedInlineAuth: true,
      },
    })
  })

  test('loads curated Xiaomi MiMo Token Plan setup with Token Plan key copy', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            availableProviders: ['xiaomi-token-plan-ams'],
            models: ['xiaomi-token-plan-ams/mimo-v2.5-pro'],
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
                id: 'xiaomi-token-plan-ams',
                name: 'Xiaomi MiMo Token Plan - Europe',
                models: { 'mimo-v2.5-pro': {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({ all: [], connected: [], default: {} }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const result = await adapter.loadSetupForm({
      runtimeId: 'opencode',
      providerId: 'xiaomi-token-plan-ams',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      providerId: 'xiaomi-token-plan-ams',
      displayName: 'Xiaomi MiMo Token Plan - Europe',
      method: 'api',
      supported: true,
      source: 'curated',
      secret: {
        label: 'Token Plan API Key (tp-...)',
        placeholder: 'tp-xxxxx',
      },
    })
    expect(result.value.description).toContain('token-plan-ams.xiaomimimo.com/v1')
    expect(result.value.description).toContain('shown once')
  })

  test('rejects Xiaomi Token Plan pay-as-you-go keys before OpenCode auth writes', async () => {
    let probeCalled = false
    let setProviderAuthCalled = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => {
          probeCalled = true
          return inventory()
        },
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
    })

    const result = await adapter.connectProvider({
      runtimeId: 'opencode',
      providerId: 'xiaomi-token-plan-ams',
      method: 'api',
      apiKey: 'sk-paygo-secret',
      metadata: {},
    })

    const failure = expectFailure(result)
    expect(failure.code).toBe('auth-required')
    expect(failure.message).toContain('tp-...')
    expect(failure.message).not.toContain('sk-paygo-secret')
    expect(probeCalled).toBe(false)
    expect(setProviderAuthCalled).toBe(false)
  })

  test('rejects MiniMax pay-as-you-go keys before OpenCode auth writes', async () => {
    let probeCalled = false
    let setProviderAuthCalled = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () => {
          probeCalled = true
          return inventory()
        },
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
    })

    const result = await adapter.connectProvider({
      runtimeId: 'opencode',
      providerId: 'minimax-coding-plan',
      method: 'api',
      apiKey: 'sk-paygo-secret',
      metadata: {},
    })

    const failure = expectFailure(result)
    expect(failure.code).toBe('auth-required')
    expect(failure.message).toContain('sk-cp-...')
    expect(failure.message).not.toContain('sk-paygo-secret')
    expect(probeCalled).toBe(false)
    expect(setProviderAuthCalled).toBe(false)
  })

  test('connects prompted API auth with metadata and persists the full app-managed auth shape', async () => {
    const authBodies: unknown[] = []
    const authWrites: Array<{
      authPath: string
      providerId: string
      auth: unknown
    }> = []
    let authApplied = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) =>
          inventory(
            options?.bypassCache
              ? {
                  connectedProviders: [
                    {
                      id: 'cloudflare-ai-gateway',
                      authHint: 'api',
                      source: 'credentials',
                      credentialScopes: ['managed'],
                    },
                  ],
                  availableProviders: ['cloudflare-ai-gateway'],
                  models: ['cloudflare-ai-gateway/claude-sonnet-4-5'],
                }
              : {
                  connectedProviders: [],
                  availableProviders: ['cloudflare-ai-gateway'],
                  models: ['cloudflare-ai-gateway/claude-sonnet-4-5'],
                },
          ),
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
            'cloudflare-ai-gateway': [
              {
                type: 'api',
                label: 'Gateway API token',
                prompts: [
                  { type: 'text', key: 'accountId', message: 'Account ID' },
                  { type: 'text', key: 'gatewayId', message: 'Gateway ID' },
                ],
              },
            ],
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
      executionProbe: {
        probeModel: async input => executionProbeResult(input.selectedModel),
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
    expect(authBodies).toEqual([
      {
        type: 'api',
        key: 'cf-secret',
        metadata: {
          accountId: 'account-123',
          gatewayId: 'gateway-123',
        },
      },
    ])
    expect(authWrites.map(write => write.auth)).toEqual(authBodies.concat(authBodies))
  })

  test('rolls back OpenCode and mirrored auth when app-managed persistence fails', async () => {
    let deleteCalled = false
    const removedAuthPaths: string[] = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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
                models: { 'moonshotai/kimi-k2:free': {} },
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
          getServerDoc: async () => ({
            paths: { '/auth/{providerID}': { delete: {} } },
          }),
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
          getProviders: async () => ({
            all: [],
            connected: ['openai'],
            default: {},
          }),
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

  test('offers transactional reauthorization separately from managed credential removal', async () => {
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
          getProviders: async () => ({
            all: [],
            connected: ['openai'],
            default: {},
          }),
          getProviderAuth: async () => ({ openai: [{ type: 'oauth' }] }),
          getServerDoc: async () => ({
            paths: {
              '/auth/{providerID}': { delete: {}, put: {} },
              '/provider/{providerID}/oauth/authorize': { post: {} },
              '/provider/{providerID}/oauth/callback': { post: {} },
            },
          }),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const openai = result.value.providers.find(provider => provider.providerId === 'openai')
    expect(openai?.connectedAuthHint).toBe('oauth')
    expect(openai?.actions.find(action => action.id === 'reconnect')).toMatchObject({
      label: 'Sign in again',
      requiresSecret: false,
      ownershipScope: 'managed',
    })
    expect(openai?.actions.find(action => action.id === 'forget')?.label).toBe(
      'Remove managed credential',
    )
  })

  test('offers credential replacement for a connected curated subscription plan', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: [
              {
                id: 'zai-coding-plan',
                authHint: 'api',
                source: 'credentials',
                credentialScopes: ['managed'],
              },
            ],
            availableProviders: ['zai-coding-plan'],
            models: ['zai-coding-plan/glm-5'],
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
            all: [{ id: 'zai-coding-plan', name: 'Z.AI Coding Plan' }],
            connected: ['zai-coding-plan'],
            default: {},
          }),
          getProviderAuth: async () => ({}),
        }),
      },
    })

    const result = await adapter.loadView('opencode')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const zai = result.value.providers.find(provider => provider.providerId === 'zai-coding-plan')
    expect(zai?.actions.find(action => action.id === 'reconnect')).toMatchObject({
      label: 'Replace credential',
      requiresSecret: true,
    })
  })

  test('connects providers through OpenCode auth set on the managed host', async () => {
    const authWrites: Array<{ providerId: string; key: string }> = []
    const modelProbes: Array<{ selectedModel: string; outputTokens?: number }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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
            providers: [
              {
                id: 'openrouter',
                name: 'OpenRouter',
                models: { 'moonshotai/kimi-k2': {} },
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
          setProviderAuth: async (providerId, body) => {
            authWrites.push({ providerId, key: body.key })
            return true
          },
        }),
      },
      authStore: authStore(),
      executionProbe: {
        probeModel: async input => {
          modelProbes.push({
            selectedModel: input.selectedModel,
            outputTokens: input.outputTokens,
          })
          return executionProbeResult(input.selectedModel)
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
    expect(authWrites).toEqual([{ providerId: 'openrouter', key: 'sk-test-secret' }])
    expect(modelProbes).toEqual([
      { selectedModel: 'openrouter/moonshotai/kimi-k2', outputTokens: undefined },
    ])
    expect(result.value).toMatchObject({
      providerId: 'openrouter',
      state: 'connected',
      ownership: ['managed'],
      verifiedModelId: 'openrouter/moonshotai/kimi-k2',
    })
  })

  test('verifies every API-key provider instead of trusting an accepted auth write', async () => {
    const modelProbes: string[] = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: [
              {
                id: 'anthropic',
                authHint: 'api',
                source: 'credentials',
                credentialScopes: ['managed'],
              },
            ],
            availableProviders: ['anthropic'],
            models: ['anthropic/claude-haiku-4-5'],
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
                id: 'anthropic',
                name: 'Anthropic',
                models: { 'claude-haiku-4-5': {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'anthropic', name: 'Anthropic' }],
            connected: ['anthropic'],
            default: {},
          }),
          getProviderAuth: async () => ({ anthropic: [{ type: 'api' }] }),
          setProviderAuth: async () => true,
        }),
      },
      authStore: authStore(),
      executionProbe: {
        probeModel: async input => {
          modelProbes.push(input.selectedModel)
          return executionProbeResult(input.selectedModel)
        },
      },
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'anthropic',
      apiKey: 'anthropic-test-key',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(modelProbes).toEqual(['anthropic/claude-haiku-4-5'])
    expect(result.value.verifiedModelId).toBe('anthropic/claude-haiku-4-5')
  })

  test('falls back to the next active model when the first connect probe is unavailable', async () => {
    const modelProbes: string[] = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: [
              {
                id: 'google',
                authHint: 'api',
                source: 'credentials',
                credentialScopes: ['managed'],
              },
            ],
            availableProviders: ['google'],
            models: [
              'google/gemini-3.1-flash-lite',
              'google/gemini-flash-lite-latest',
              'google/gemini-3.5-flash',
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
                id: 'google',
                name: 'Google',
                models: {
                  'gemini-3.1-flash-lite': {},
                  'gemini-flash-lite-latest': {},
                  'gemini-3.5-flash': {},
                },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'google', name: 'Google' }],
            connected: ['google'],
            default: {},
          }),
          getProviderAuth: async () => ({ google: [{ type: 'api' }] }),
          setProviderAuth: async () => true,
        }),
      },
      authStore: authStore(),
      executionProbe: {
        probeModel: async input => {
          modelProbes.push(input.selectedModel)
          return input.selectedModel === 'google/gemini-3.1-flash-lite'
            ? executionProbeResult(input.selectedModel, 'unavailable', 'Model is unavailable')
            : executionProbeResult(input.selectedModel)
        },
      },
    })

    const result = await adapter.connectWithApiKey({
      runtimeId: 'opencode',
      providerId: 'google',
      apiKey: 'google-test-key',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(modelProbes).toEqual([
      'google/gemini-3.1-flash-lite',
      'google/gemini-flash-lite-latest',
    ])
    expect(result.value.verifiedModelId).toBe('google/gemini-flash-lite-latest')
  })

  test.each([
    {
      providerId: 'google',
      displayName: 'Google',
      apiKey: 'google-test-key',
      modelId: 'google/gemini-3.1-flash-lite',
    },
    {
      providerId: 'groq',
      displayName: 'Groq',
      apiKey: 'groq-test-key',
      modelId: 'groq/llama-3.1-8b-instant',
    },
  ])(
    'connects $providerId from fresh credential inventory when the current host snapshot stays stale',
    async ({ providerId, displayName, apiKey, modelId }) => {
      const authWrites: Array<{ authPath: string; providerId: string; key: string }> = []
      const modelProbes: Array<{ selectedModel: string; outputTokens?: number }> = []
      let deleteProviderAuthCalled = false
      const adapter = new OpenCodeProviderManagementAdapter({
        inventoryService: {
          probe: async (_projectPath, options) =>
            inventory({
              connectedProviders: options?.bypassCache
                ? [
                    {
                      id: providerId,
                      authHint: 'api',
                      source: 'credentials',
                      credentialScopes: ['managed'],
                    },
                  ]
                : [],
              availableProviders: [providerId],
              models: [modelId],
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
                  id: providerId,
                  name: displayName,
                  models: { [modelId.slice(providerId.length + 1)]: {} },
                },
              ],
              default: { [providerId]: modelId.slice(providerId.length + 1) },
            }),
            getProviders: async () => ({
              all: [{ id: providerId, name: displayName }],
              connected: [],
              default: { [providerId]: modelId.slice(providerId.length + 1) },
            }),
            getProviderAuth: async () => ({ [providerId]: [{ type: 'api' }] }),
            getServerDoc: async () => ({
              paths: { '/auth/{providerID}': { delete: {} } },
            }),
            setProviderAuth: async () => true,
            deleteProviderAuth: async () => {
              deleteProviderAuthCalled = true
              return true
            },
          }),
        },
        authStore: {
          readCredential: async () => null,
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
              outputTokens: input.outputTokens,
            })
            return executionProbeResult(input.selectedModel)
          },
        },
      })

      const result = await adapter.connectWithApiKey({
        runtimeId: 'opencode',
        providerId,
        apiKey,
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(authWrites).toEqual([
        {
          authPath:
            '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
          providerId,
          key: apiKey,
        },
        {
          authPath: '/tmp/profile/data/opencode/auth.json',
          providerId,
          key: apiKey,
        },
      ])
      expect(modelProbes).toEqual([{ selectedModel: modelId, outputTokens: undefined }])
      expect(deleteProviderAuthCalled).toBe(false)
      expect(result.value).toMatchObject({
        providerId,
        state: 'connected',
        ownership: ['managed'],
        connectedAuthHint: 'api',
        verifiedModelId: modelId,
      })
    },
  )

  test.each([
    {
      providerId: 'google',
      displayName: 'Google',
      apiKey: 'invalid-google-test-key',
      modelId: 'google/gemini-3.1-flash-lite',
    },
    {
      providerId: 'groq',
      displayName: 'Groq',
      apiKey: 'invalid-groq-test-key',
      modelId: 'groq/llama-3.1-8b-instant',
    },
  ])(
    'rolls back $providerId when its real model verification rejects the API key',
    async ({ providerId, displayName, apiKey, modelId }) => {
      const removedCredentials: Array<{ authPath: string; providerId: string }> = []
      let deleteProviderAuthCalled = false
      const adapter = new OpenCodeProviderManagementAdapter({
        inventoryService: {
          probe: async (_projectPath, options) =>
            inventory({
              connectedProviders: options?.bypassCache
                ? [
                    {
                      id: providerId,
                      authHint: 'api',
                      source: 'credentials',
                      credentialScopes: ['managed'],
                    },
                  ]
                : [],
              availableProviders: [providerId],
              models: [modelId],
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
                  id: providerId,
                  name: displayName,
                  models: { [modelId.slice(providerId.length + 1)]: {} },
                },
              ],
              default: {},
            }),
            getProviders: async () => ({
              all: [{ id: providerId, name: displayName }],
              connected: [],
              default: {},
            }),
            getProviderAuth: async () => ({ [providerId]: [{ type: 'api' }] }),
            getServerDoc: async () => ({
              paths: { '/auth/{providerID}': { delete: {} } },
            }),
            setProviderAuth: async () => true,
            deleteProviderAuth: async () => {
              deleteProviderAuthCalled = true
              return true
            },
          }),
        },
        authStore: {
          readCredential: async () => null,
          upsertApiAuth: async () => {},
          removeCredential: async input => {
            removedCredentials.push(input)
          },
        },
        executionProbe: {
          probeModel: async input =>
            executionProbeResult(
              input.selectedModel,
              'not_authenticated',
              `Unauthorized ${apiKey}`,
            ),
        },
      })

      const result = await adapter.connectWithApiKey({
        runtimeId: 'opencode',
        providerId,
        apiKey,
      })

      const failure = expectFailure(result)
      expect(failure.code).toBe('auth-failed')
      expect(failure.message).toContain('Unauthorized')
      expect(failure.message).not.toContain(apiKey)
      expect(deleteProviderAuthCalled).toBe(true)
      expect(removedCredentials).toEqual([
        {
          authPath:
            '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
          providerId,
        },
        {
          authPath: '/tmp/profile/data/opencode/auth.json',
          providerId,
        },
      ])
    },
  )

  test('connects Atlas Cloud only after storing the user-provided API key', async () => {
    const authWrites: Array<{
      authPath: string
      providerId: string
      key: string
    }> = []
    const modelProbes: Array<{
      selectedModel: string
      bypassCache: boolean | undefined
    }> = []
    let authApplied = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) =>
          inventory(
            options?.bypassCache
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
                },
          ),
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
    expect(modelProbes).toEqual([
      {
        selectedModel: 'atlascloud/deepseek-ai/deepseek-v3.2',
        bypassCache: true,
      },
    ])
    expect(result.value).toMatchObject({
      providerId: 'atlascloud',
      state: 'connected',
      ownership: ['managed'],
    })
  })

  test('connects Xiaomi MiMo Token Plan through curated OpenCode provider config', async () => {
    const authWrites: Array<{
      authPath: string
      providerId: string
      key: string
    }> = []
    const modelProbes: Array<{
      selectedModel: string
      bypassCache: boolean | undefined
    }> = []
    let authApplied = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) =>
          inventory(
            options?.bypassCache
              ? {
                  connectedProviders: [
                    {
                      id: 'xiaomi-token-plan-ams',
                      authHint: 'api',
                      source: 'credentials',
                      credentialScopes: ['managed'],
                    },
                  ],
                  availableProviders: ['xiaomi-token-plan-ams'],
                  models: [
                    'xiaomi-token-plan-ams/mimo-v2.5-pro',
                    'xiaomi-token-plan-ams/mimo-v2.5-tts-voicedesign',
                  ],
                }
              : {
                  connectedProviders: [],
                  availableProviders: ['xiaomi-token-plan-ams'],
                  models: [
                    'xiaomi-token-plan-ams/mimo-v2.5-pro',
                    'xiaomi-token-plan-ams/mimo-v2.5-tts-voicedesign',
                  ],
                },
          ),
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
                id: 'xiaomi-token-plan-ams',
                name: 'Xiaomi MiMo Token Plan - Europe',
                models: {
                  'mimo-v2.5-pro': {},
                  'mimo-v2.5': {},
                  'mimo-v2.5-tts-voicedesign': {},
                },
              },
            ],
            default: {
              'xiaomi-token-plan-ams': 'mimo-v2.5-tts-voicedesign',
            },
          }),
          getProviders: async () => ({
            all: [
              {
                id: 'xiaomi-token-plan-ams',
                name: 'Xiaomi MiMo Token Plan - Europe',
              },
            ],
            connected: authApplied ? ['xiaomi-token-plan-ams'] : [],
            default: {
              'xiaomi-token-plan-ams': 'mimo-v2.5-tts-voicedesign',
            },
          }),
          getProviderAuth: async () => ({}),
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
      providerId: 'xiaomi-token-plan-ams',
      apiKey: 'tp-user-token',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(authWrites).toEqual([
      {
        authPath: '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
        providerId: 'xiaomi-token-plan-ams',
        key: 'tp-user-token',
      },
      {
        authPath: '/tmp/profile/data/opencode/auth.json',
        providerId: 'xiaomi-token-plan-ams',
        key: 'tp-user-token',
      },
    ])
    expect(modelProbes).toEqual([
      {
        selectedModel: 'xiaomi-token-plan-ams/mimo-v2.5-pro',
        bypassCache: true,
      },
    ])
    expect(result.value).toMatchObject({
      providerId: 'xiaomi-token-plan-ams',
      state: 'connected',
      ownership: ['managed'],
    })
  })

  test.each([
    {
      providerId: 'zai-coding-plan',
      displayName: 'Z.AI Coding Plan',
      apiKey: 'zai-coding-plan-test-key',
      modelId: 'zai-coding-plan/glm-5.2',
      providerDefaultModelId: 'glm-5v-turbo',
    },
    {
      providerId: 'minimax-coding-plan',
      displayName: 'MiniMax Token Plan (minimax.io)',
      apiKey: 'sk-cp-minimax-test-key',
      modelId: 'minimax-coding-plan/MiniMax-M3',
      providerDefaultModelId: 'MiniMax-M2.7-highspeed',
    },
    {
      providerId: 'kimi-for-coding',
      displayName: 'Kimi Code Membership',
      apiKey: 'kimi-membership-test-key',
      modelId: 'kimi-for-coding/kimi-for-coding',
      providerDefaultModelId: 'kimi-k2-thinking',
    },
  ])(
    'connects $providerId only after mirroring auth and proving its subscription model',
    async ({ providerId, displayName, apiKey, modelId, providerDefaultModelId }) => {
      const authWrites: Array<{
        authPath: string
        providerId: string
        key: string
      }> = []
      const modelProbes: Array<{
        selectedModel: string
        bypassCache: boolean | undefined
      }> = []
      let authApplied = false
      const adapter = new OpenCodeProviderManagementAdapter({
        inventoryService: {
          probe: async (_projectPath, options) =>
            inventory({
              connectedProviders: options?.bypassCache
                ? [
                    {
                      id: providerId,
                      authHint: 'api',
                      source: 'credentials',
                      credentialScopes: ['managed'],
                    },
                  ]
                : [],
              availableProviders: [providerId],
              models: [modelId, `${providerId}/${providerDefaultModelId}`],
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
                  id: providerId,
                  name: displayName,
                  models: {
                    [modelId.slice(providerId.length + 1)]: {},
                    [providerDefaultModelId]: {},
                  },
                },
              ],
              default: { [providerId]: providerDefaultModelId },
            }),
            getProviders: async () => ({
              all: [{ id: providerId, name: displayName }],
              connected: authApplied ? [providerId] : [],
              default: { [providerId]: providerDefaultModelId },
            }),
            getProviderAuth: async () => ({}),
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
        providerId,
        apiKey,
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(authWrites).toEqual([
        {
          authPath:
            '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json',
          providerId,
          key: apiKey,
        },
        {
          authPath: '/tmp/profile/data/opencode/auth.json',
          providerId,
          key: apiKey,
        },
      ])
      expect(modelProbes).toEqual([{ selectedModel: modelId, bypassCache: true }])
      expect(result.value).toMatchObject({
        providerId,
        state: 'connected',
        ownership: ['managed'],
        connectedAuthHint: 'api',
        verifiedModelId: modelId,
      })
    },
  )

  test.each([
    {
      providerId: 'zai-coding-plan',
      displayName: 'Z.AI Coding Plan',
      replacementKey: 'replacement-zai-key',
      modelId: 'zai-coding-plan/glm-5.2',
    },
    {
      providerId: 'kimi-for-coding',
      displayName: 'Kimi Code Membership',
      replacementKey: 'replacement-kimi-key',
      modelId: 'kimi-for-coding/kimi-for-coding',
    },
    {
      providerId: 'xiaomi-token-plan-ams',
      displayName: 'Xiaomi MiMo Token Plan - Europe',
      replacementKey: 'tp-replacement-mimo-key',
      modelId: 'xiaomi-token-plan-ams/mimo-v2.5-pro',
    },
  ])(
    'restores the previous $providerId credential when replacement verification fails',
    async ({ providerId, displayName, replacementKey, modelId }) => {
      const globalAuthPath =
        '/Users/test/Library/Application Support/claude-multimodel/opencode/auth.json'
      const managedAuthPath = '/tmp/profile/data/opencode/auth.json'
      const previousCredential = { type: 'api', key: `previous-${providerId}-key` }
      const restoredCredentials: Array<{
        authPath: string
        providerId: string
        credential: Record<string, unknown>
      }> = []
      const removedCredentials: Array<{ authPath: string; providerId: string }> = []
      let authApplied = false
      let deleteProviderAuthCalled = false
      const adapter = new OpenCodeProviderManagementAdapter({
        inventoryService: {
          probe: async (_projectPath, options) =>
            inventory({
              connectedProviders: options?.bypassCache
                ? [
                    {
                      id: providerId,
                      authHint: 'api',
                      source: 'credentials',
                      credentialScopes: ['managed'],
                    },
                  ]
                : [],
              availableProviders: [providerId],
              models: [modelId],
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
                  id: providerId,
                  name: displayName,
                  models: { [modelId.slice(providerId.length + 1)]: {} },
                },
              ],
              default: {},
            }),
            getProviders: async () => ({
              all: [{ id: providerId, name: displayName }],
              connected: authApplied ? [providerId] : [],
              default: {},
            }),
            getProviderAuth: async () => ({ [providerId]: [{ type: 'api' }] }),
            getServerDoc: async () => ({
              paths: { '/auth/{providerID}': { delete: {} } },
            }),
            setProviderAuth: async () => {
              authApplied = true
              return true
            },
            deleteProviderAuth: async () => {
              deleteProviderAuthCalled = true
              authApplied = false
              return true
            },
          }),
        },
        authStore: {
          readCredential: async ({ authPath }) =>
            authPath === globalAuthPath || authPath === managedAuthPath
              ? previousCredential
              : null,
          upsertApiAuth: async () => {},
          upsertCredential: async input => {
            restoredCredentials.push(input)
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
              `Unauthorized ${replacementKey}`,
            ),
        },
      })

      const result = await adapter.connectWithApiKey({
        runtimeId: 'opencode',
        providerId,
        apiKey: replacementKey,
      })

      const failure = expectFailure(result)
      expect(failure.code).toBe('auth-failed')
      expect(failure.message).not.toContain(replacementKey)
      expect(deleteProviderAuthCalled).toBe(true)
      expect(removedCredentials).toEqual([])
      expect(restoredCredentials).toEqual([
        { authPath: globalAuthPath, providerId, credential: previousCredential },
        { authPath: managedAuthPath, providerId, credential: previousCredential },
      ])
    },
  )

  test('rejects Atlas Cloud connect when the user-provided API key fails model execution proof', async () => {
    const authWrites: Array<{
      authPath: string
      providerId: string
      key: string
    }> = []
    const removedCredentials: Array<{ authPath: string; providerId: string }> = []
    let deleteProviderAuthCalled = false
    let authApplied = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) =>
          inventory(
            options?.bypassCache
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
                },
          ),
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
          getServerDoc: async () => ({
            paths: { '/auth/{providerID}': { delete: {} } },
          }),
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
    const authWrites: Array<{
      authPath: string
      providerId: string
      apiKey: string
    }> = []
    const probeCalls: Array<{ bypassCache: boolean | undefined }> = []
    let authApplied = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => {
          probeCalls.push({ bypassCache: options?.bypassCache })
          return inventory(
            options?.bypassCache
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
                },
          )
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
      executionProbe: {
        probeModel: async input => executionProbeResult(input.selectedModel),
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
    expect(probeCalls).toEqual([{ bypassCache: undefined }, { bypassCache: true }])
    expect(result.value).toMatchObject({
      providerId: 'openrouter',
      state: 'connected',
      modelCount: 1,
      ownership: ['managed'],
    })
  })

  test('keeps a successful connect when post-write inventory refresh times out', async () => {
    const authWrites: Array<{
      authPath: string
      providerId: string
      apiKey: string
    }> = []
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
      executionProbe: {
        probeModel: async input => executionProbeResult(input.selectedModel),
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
    const authWrites: Array<{
      authPath: string
      providerId: string
      apiKey: string
    }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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
        probe: async () =>
          inventory({
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
        probe: async () =>
          inventory({
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
    const authWrites: Array<{
      authPath: string
      providerId: string
      apiKey: string
    }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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

  test('rolls back OpenCode auth writes when fresh inventory exposes no credential evidence', async () => {
    let deleteCalled = false
    const authWrites: Array<{
      authPath: string
      providerId: string
      apiKey: string
    }> = []
    const removedCredentials: Array<{ authPath: string; providerId: string }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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
          getServerDoc: async () => ({
            paths: { '/auth/{providerID}': { delete: {} } },
          }),
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

    const failure = expectFailure(result)
    expect(failure.code).toBe('auth-failed')
    expect(failure.message).not.toContain('sk-test-secret')
    expect(deleteCalled).toBe(true)
    expect(authWrites).toHaveLength(2)
    expect(removedCredentials).toHaveLength(2)
  })

  test('does not retain API keys when fresh inventory only reports environment-owned evidence', async () => {
    let deleteCalled = false
    const authWrites: Array<{
      authPath: string
      providerId: string
      apiKey: string
    }> = []
    const removedCredentials: Array<{ authPath: string; providerId: string }> = []
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: [
              {
                id: 'openrouter',
                authHint: 'api',
                source: 'environment',
              },
            ],
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
          getServerDoc: async () => ({
            paths: { '/auth/{providerID}': { delete: {} } },
          }),
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

    const failure = expectFailure(result)
    expect(failure.code).toBe('auth-failed')
    expect(deleteCalled).toBe(true)
    expect(authWrites).toHaveLength(2)
    expect(removedCredentials).toHaveLength(2)
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
          getProviders: async () => ({
            all: [],
            connected: ['openai'],
            default: {},
          }),
          getProviderAuth: async () => ({ openai: [{ type: 'oauth' }] }),
          getServerDoc: async () => ({
            paths: { '/auth/{providerID}': { put: {} } },
          }),
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
        probe: async (_projectPath, options) =>
          inventory(
            options?.bypassCache
              ? {
                  connectedProviders: [],
                  availableProviders: ['openrouter'],
                  models: [],
                }
              : {
                  connectedProviders: [
                    {
                      id: 'openrouter',
                      authHint: 'api',
                      source: 'credentials',
                      credentialScopes: ['managed', 'local'],
                    },
                  ],
                  availableProviders: ['openrouter'],
                  models: ['openrouter/moonshotai/kimi-k2:free'],
                },
          ),
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
          getServerDoc: async () => ({
            paths: { '/auth/{providerID}': { delete: {} } },
          }),
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
          getServerDoc: async () => ({
            paths: { '/auth/{providerID}': { delete: {} } },
          }),
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
            connectedProviders: [
              {
                id: 'openrouter',
                authHint: 'api',
                source: 'credentials',
                credentialScopes: ['managed', 'local'],
              },
            ],
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
          getServerDoc: async () => ({
            paths: { '/auth/{providerID}': { delete: {} } },
          }),
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
          getProviders: async () => ({
            all: [],
            connected: ['openai'],
            default: {},
          }),
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
        probe: async () =>
          inventory({
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
    expect(result.value).toMatchObject({
      totalCount: 1,
      returnedCount: 1,
      limit: 10,
      cursor: null,
      nextCursor: null,
    })
    expect(result.value.models[0]).toMatchObject({
      providerId: 'openrouter',
      sourceLabel: 'OpenRouter',
      free: true,
      availability: 'untested',
    })
  })

  test('paginates the filtered union of inventory, config, and live provider models', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: [
              {
                id: 'openrouter',
                authHint: 'api',
                source: 'credentials',
                credentialScopes: ['managed'],
              },
            ],
            availableProviders: ['openrouter'],
            models: ['openrouter/alpha-one', 'openrouter/alpha-two', 'openrouter/beta-one'],
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
                  'alpha-two': {},
                  'alpha-three': {},
                },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [
              {
                id: 'openrouter',
                name: 'OpenRouter',
                models: {
                  'alpha-three': {},
                  'alpha-four': {},
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
      query: 'alpha',
      limit: 2,
      cursor: '1',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      totalCount: 4,
      returnedCount: 2,
      limit: 2,
      cursor: '1',
      nextCursor: '3',
    })
    expect(result.value.models.map(model => model.modelId)).toEqual([
      'openrouter/alpha-one',
      'openrouter/alpha-three',
    ])

    const viewResult = await adapter.loadView('opencode')
    expect(viewResult.ok).toBe(true)
    if (!viewResult.ok) return
    expect(viewResult.value.providers.find(provider => provider.providerId === 'openrouter'))
      .toMatchObject({ modelCount: 5 })
  })

  test('marks provider-scoped zero-cost OpenRouter models as free', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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

  test('filters deprecated catalog models but keeps a persisted deprecated default visible', async () => {
    let defaultModelId = 'active-model'
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            availableProviders: ['google'],
            models: [
              'google/active-model',
              'google/alpha-model',
              'google/beta-model',
              'google/old-model',
            ],
            modelMetadata: [
              {
                id: 'google/old-model',
                cost: null,
                context: null,
                limits: null,
                free: false,
                catalogStatus: 'deprecated',
                raw: { status: 'deprecated' },
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
            providers: [{ id: 'google', name: 'Google' }],
            default: { google: defaultModelId },
          }),
          getProviders: async () => ({
            all: [
              {
                id: 'google',
                name: 'Google',
                models: {
                  'active-model': {},
                  'alpha-model': { status: 'alpha' },
                  'beta-model': { status: 'beta' },
                  'old-model': { status: 'deprecated' },
                },
              },
            ],
            connected: [],
            default: { google: defaultModelId },
          }),
          getProviderAuth: async () => ({ google: [{ type: 'api' }] }),
        }),
      },
    })

    const activeDefault = await adapter.loadModels({
      runtimeId: 'opencode',
      providerId: 'google',
    })

    expect(activeDefault.ok).toBe(true)
    if (!activeDefault.ok) return
    expect(activeDefault.value.models.map(model => model.modelId)).toEqual([
      'google/active-model',
      'google/alpha-model',
      'google/beta-model',
    ])
    expect(activeDefault.value.models.find(model => model.modelId === 'google/alpha-model'))
      .toMatchObject({ catalogStatus: 'alpha' })
    expect(activeDefault.value.models.find(model => model.modelId === 'google/beta-model'))
      .toMatchObject({ catalogStatus: 'beta' })

    defaultModelId = 'old-model'
    const deprecatedDefault = await adapter.loadModels({
      runtimeId: 'opencode',
      providerId: 'google',
    })

    expect(deprecatedDefault.ok).toBe(true)
    if (!deprecatedDefault.ok) return
    expect(deprecatedDefault.value.models.find(model => model.modelId === 'google/old-model'))
      .toMatchObject({ catalogStatus: 'deprecated', default: true })
  })

  test('loads provider-scoped models reported only by the live provider catalog', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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
    expect(result.value.models.map(model => model.modelId)).toEqual(['openrouter/qwen/qwen3-coder'])
  })

  test('marks configured local OpenCode models as authless routes that need proof', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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
        probe: async () =>
          inventory({
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
    expect(
      viewResult.value.providers.find(provider => provider.providerId === 'ollama'),
    ).toMatchObject({
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
        probe: async () =>
          inventory({
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
        probe: async () =>
          inventory({
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
        probe: async (_projectPath, options) =>
          inventory({
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
        probe: async (_projectPath, options) =>
          inventory({
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
        setAllProjectsDefaultModel: async modelId => {
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
        probe: async (_projectPath, options) =>
          inventory({
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
        setAllProjectsDefaultModel: async modelId => {
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
        probe: async (_projectPath, options) =>
          inventory({
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
        probe: async (_projectPath, options) =>
          inventory({
            connectedProviders: [],
            availableProviders: ['llama.cpp'],
            models: ['llama.cpp/qwen-test:0.5b'],
            profile: {
              ...inventory().profile!,
              allProjectsDefaultModelId: options?.bypassCache ? 'llama.cpp/qwen-test:0.5b' : null,
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
        setAllProjectsDefaultModel: async modelId => {
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
        probe: async () =>
          inventory({
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
        probeModel: async input =>
          executionProbeResult(input.selectedModel, 'unavailable', 'model denied'),
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
    const buildInventory = () =>
      inventory({
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
      secondDirectory.value.entries.find(entry => entry.providerId === 'openrouter')
        ?.defaultModelId,
    ).toBe('openrouter/new-model')
  })

  test('tests models when live OpenCode server reports the provider as connected', async () => {
    let probedModel: string | null = null
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
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
        probe: async () =>
          inventory({
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

  test('saves and verifies app-managed limits only for configured local models', async () => {
    let savedInput: unknown = null
    let probeInput: unknown = null
    let probeOutcome: 'available' | 'unavailable' = 'available'
    let cacheClearThrows = false
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async () =>
          inventory({
            connectedProviders: [],
            availableProviders: ['local'],
            models: ['local/qwen'],
          }),
        clearCache: () => {
          if (cacheClearThrows) throw new Error('cache is temporarily busy')
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
                id: 'local',
                name: 'Local',
                models: { qwen: {} },
              },
            ],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'local', name: 'Local' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({}),
        }),
      },
      executionProbe: {
        probeModel: async input => {
          probeInput = input
          return executionProbeResult(
            input.selectedModel,
            probeOutcome,
            probeOutcome === 'available' ? null : 'Local endpoint unavailable',
          )
        },
      },
      managedPreferences: {
        setDefaultModel: async () => {},
        setModelLimits: async (_profileRootPath, input) => {
          savedInput = input
        },
      },
    })

    const result = await adapter.configureModelLimits({
      runtimeId: 'opencode',
      providerId: 'local',
      modelId: 'local/qwen',
      contextTokens: 128_000,
      outputTokens: 32_000,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(savedInput).toEqual({
      modelId: 'local/qwen',
      contextTokens: 128_000,
      outputTokens: 32_000,
    })
    expect(probeInput).toMatchObject({
      selectedModel: 'local/qwen',
      contextTokens: 128_000,
      outputTokens: 32_000,
      bypassCache: true,
    })
    expect(result.value).toMatchObject({ saved: true, verified: true })

    savedInput = null
    probeOutcome = 'unavailable'
    const failedProbe = await adapter.configureModelLimits({
      runtimeId: 'opencode',
      providerId: 'local',
      modelId: 'local/qwen',
      contextTokens: 128_000,
      outputTokens: 32_000,
    })

    expect(failedProbe.ok).toBe(false)
    expect(savedInput).toBeNull()
    expect(expectFailure(failedProbe)).toMatchObject({
      code: 'model-test-failed',
      recoverable: true,
    })

    probeOutcome = 'available'
    cacheClearThrows = true
    const cacheClearFailure = await adapter.configureModelLimits({
      runtimeId: 'opencode',
      providerId: 'local',
      modelId: 'local/qwen',
      contextTokens: 128_000,
      outputTokens: 32_000,
    })

    expect(cacheClearFailure.ok).toBe(true)
    if (!cacheClearFailure.ok) return
    expect(cacheClearFailure.value).toMatchObject({ saved: true, verified: true })
    expect(cacheClearFailure.value.diagnostics.join('\n')).toContain(
      'Inventory cache refresh failed after limits were saved',
    )
  })

  test('loads catalog and project-managed context limits for the exact model', async () => {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async projectPath =>
          inventory({
            projectPath: projectPath ?? '/tmp/project',
            connectedProviders: [],
            availableProviders: ['local'],
            models: ['local/qwen'],
            modelMetadata: [
              {
                id: 'local/qwen',
                cost: null,
                context: 64_000,
                limits: { context: 64_000, output: 8_000 },
                free: false,
                raw: {},
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
            providers: [{ id: 'local', name: 'Local', models: { qwen: {} } }],
            default: {},
          }),
          getProviders: async () => ({
            all: [{ id: 'local', name: 'Local' }],
            connected: [],
            default: {},
          }),
          getProviderAuth: async () => ({}),
        }),
      },
      managedPreferences: {
        read: async profileRootPath => {
          expect(profileRootPath).toBe('/tmp/profile')
          return {
            schemaVersion: 2,
            defaultModelId: null,
            modelLimitOverrides: {
              'local/qwen': {
                contextTokens: 128_000,
                outputTokens: 16_000,
                updatedAt: '2026-07-12T12:00:00.000Z',
              },
            },
            updatedAt: '2026-07-12T12:00:00.000Z',
          }
        },
        setDefaultModel: async () => {},
      },
    })

    const result = await adapter.loadModels({
      runtimeId: 'opencode',
      providerId: 'local',
      projectPath: '/tmp/project-a',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.models[0]).toMatchObject({
      modelId: 'local/qwen',
      catalogContextTokens: 64_000,
      catalogOutputTokens: 8_000,
      managedContextTokens: 128_000,
      managedOutputTokens: 16_000,
      managedUpdatedAt: '2026-07-12T12:00:00.000Z',
    })
  })
})
