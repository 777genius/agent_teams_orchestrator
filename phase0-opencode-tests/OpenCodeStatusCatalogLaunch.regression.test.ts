import { expect, mock, test } from 'bun:test'
import path from 'node:path'

import { FakeOpenCodeRegressionHarness } from './FakeOpenCodeRegressionHarness.js'

import type {
  OpenCodeHostHandle,
  OpenCodeInventorySnapshot,
  OpenCodePreparedProfile,
} from '../src/services/opencode/types.js'

mock.module('env-paths', () => ({
  default: (name: string) => ({
    data: `/tmp/${name}/data`,
    config: `/tmp/${name}/config`,
    cache: `/tmp/${name}/cache`,
    log: `/tmp/${name}/log`,
    temp: `/tmp/${name}/temp`,
  }),
}))
mock.module('strip-ansi', () => ({ default: (value: string) => value }))
mock.module('../src/utils/cwd.js', () => ({
  getCwd: () => process.cwd(),
  pwd: () => process.cwd(),
  runWithCwdOverride: <T>(_cwd: string, callback: () => T) => callback(),
}))
mock.module('../src/utils/json.js', () => ({
  safeParseJSON: (value: string) => JSON.parse(value),
  safeParseJSONC: (value: string) => JSON.parse(value),
}))
mock.module('../src/utils/lockfile.js', () => ({
  lock: async () => async () => {},
  lockSync: () => () => {},
  unlock: async () => {},
  check: async () => false,
}))

function profile(harness: FakeOpenCodeRegressionHarness): OpenCodePreparedProfile {
  const profileRootPath = path.join(harness.sandboxPath, 'profile')
  return {
    projectPath: harness.projectPath,
    profileRootKey: 'phase-0-profile',
    profileRootPath,
    projectDefaultModelId: null,
    allProjectsDefaultModelId: null,
    effectiveManagedDefaultModelId: null,
    effectiveManagedDefaultSource: null,
    projectBehaviorFingerprint: 'behavior-v1',
    behaviorSources: [],
    managedConfig: {
      default_agent: 'teammate',
      plugin: ['opencode-kiro@0.4.0'],
    },
    managedConfigFingerprint: 'config-v1',
    homePath: path.join(profileRootPath, 'home'),
    tmpPath: path.join(profileRootPath, 'tmp'),
    xdgConfigHome: path.join(profileRootPath, 'config'),
    xdgDataHome: path.join(profileRootPath, 'data'),
    xdgCacheHome: path.join(profileRootPath, 'cache'),
    globalAuthPath: path.join(profileRootPath, 'global-auth.json'),
    managedAuthPath: path.join(profileRootPath, 'data/opencode/auth.json'),
    sourceAuthPath: null,
    sourceAuthFingerprint: 'none',
    managedAuthFingerprint: 'managed-v1',
    authState: 'ok',
    env: {},
  }
}

function inventory(
  harness: FakeOpenCodeRegressionHarness,
  preparedProfile = profile(harness),
): OpenCodeInventorySnapshot {
  return {
    detected: true,
    binaryPath: '/fake/opencode',
    version: '1.17.18',
    projectPath: harness.projectPath,
    profile: preparedProfile,
    connectedProviders: [{
      id: 'openrouter',
      authHint: 'api',
      source: 'credentials',
      credentialScopes: ['managed'],
    }],
    availableProviders: ['openrouter'],
    models: ['openrouter/openai/gpt-5.4'],
    modelMetadata: [],
    agents: [],
    authStorePath: preparedProfile.managedAuthPath,
    probeError: null,
    diagnostics: [],
  }
}

function host(
  harness: FakeOpenCodeRegressionHarness,
  pid: number,
  preparedProfile = profile(harness),
): OpenCodeHostHandle {
  return {
    hostKey: 'fake-host',
    profileRootKey: preparedProfile.profileRootKey,
    projectPath: harness.projectPath,
    projectBehaviorFingerprint: preparedProfile.projectBehaviorFingerprint,
    baseUrl: 'http://fake-opencode.test',
    port: 43100,
    pid,
    version: '1.17.18',
    state: 'healthy',
    profile: preparedProfile,
    resolvedConfigFingerprint: 'config-v1',
    diagnostics: [],
  }
}

function configureLiveApi(harness: FakeOpenCodeRegressionHarness, target: 'catalog' | 'launch') {
  const api = harness.fakeHostHttpApi(target)
  api.setResponse('GET', '/config', { default_agent: 'teammate' })
  api.setResponse('GET', '/config/providers', {
    providers: [{ id: 'openrouter', models: { 'openai/gpt-5.4': {} } }],
    default: {},
  })
  api.setResponse('GET', '/provider', {
    all: [{ id: 'openrouter', models: { 'openai/gpt-5.4': {} } }],
    connected: ['openrouter'],
    default: {},
  })
  api.setResponse('GET', '/auth', { openrouter: [{ type: 'api' }] })
  api.setResponse('GET', '/agent', [{ name: 'teammate', mode: 'primary' }])
  api.setResponse('GET', '/doc', null)
  return api
}

test('RED/Moth: passive command status completes without prepareProfile, writes, or processes', async () => {
  const { OpenCodeInventoryService } = await import('../src/services/opencode/OpenCodeInventoryService.js')
  const { openCodeProfileManager } = await import('../src/services/opencode/OpenCodeProfileManager.js')
  const harness = await FakeOpenCodeRegressionHarness.create()
  const originalPrepareProfile = openCodeProfileManager.prepareProfile
  const originalBinaryPath = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
  const abortController = new AbortController()
  let hangingPrepare: ReturnType<typeof harness.deferred<OpenCodePreparedProfile>> | null = null
  let child: ReturnType<typeof harness.spawnChild> | null = null
  let commandPromise: Promise<OpenCodeInventorySnapshot> | null = null

  try {
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = '/bin/true'
    openCodeProfileManager.prepareProfile = (async () => {
      hangingPrepare = harness.deferred('status', 'prepareProfile')
      child = harness.spawnChild('status')
      harness.writeSandboxFileSync('status', 'profile/mutated-by-prepare', 'mutation')
      return hangingPrepare.promise
    }) as typeof openCodeProfileManager.prepareProfile

    commandPromise = new OpenCodeInventoryService().probe(harness.projectPath, {
      mode: 'summary',
      includeAppMcp: false,
      abortSignal: abortController.signal,
    })
    const observed = await harness.observePromise(commandPromise, 20)

    expect({
      settlement: observed.state,
      commands: harness.journal.commands,
      filesystemWrites: harness.journal.filesystemWrites,
      managedPlugins: harness.journal.managedPlugins,
      childProcesses: harness.journal.childProcesses,
      operations: harness.journal.operations,
    }).toEqual({
      settlement: 'fulfilled',
      commands: [],
      filesystemWrites: [],
      managedPlugins: [],
      childProcesses: [],
      operations: [],
    })
  } finally {
    hangingPrepare?.cancel()
    abortController.abort(new Error('Phase 0 deterministic cancellation'))
    hangingPrepare?.resolve(profile(harness))
    child?.cleanup()
    if (commandPromise) await commandPromise.catch(() => undefined)
    openCodeProfileManager.prepareProfile = originalPrepareProfile
    if (originalBinaryPath === undefined) delete process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    else process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = originalBinaryPath
    await harness.cleanup()
  }
})

test('#443 containment: passive catalog uses profile plus live API without verbose/full prewarm', async () => {
  const { OpenCodeProviderManagementAdapter } = await import('../src/features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.js')
  const harness = await FakeOpenCodeRegressionHarness.create()
  const preparedProfile = profile(harness)
  const api = configureLiveApi(harness, 'catalog')
  const inventoryModes: unknown[] = []
  let child: ReturnType<typeof harness.spawnChild> | null = null

  try {
    const adapter = new OpenCodeProviderManagementAdapter({
      inventoryService: {
        probe: async (_projectPath, options) => {
          const mode = (options as { mode?: unknown } | undefined)?.mode
          inventoryModes.push(mode)
          if (mode === 'full') {
            const cli = harness.fakeCli('catalog')
            await cli.exec(['--version'])
            await cli.exec(['providers', 'list'])
            await cli.exec(['models', '--verbose'])
            await cli.exec(['agent', 'list'])
          }
          return inventory(harness, preparedProfile)
        },
      },
      hostManager: {
        ensureHost: async options => {
          const policy = (options as { managedPluginStartupPolicy?: string } | undefined)
            ?.managedPluginStartupPolicy ?? 'catalog-prewarm'
          harness.recordManagedPlugin('catalog', policy as 'catalog-prewarm' | 'serve-startup')
          if (policy === 'catalog-prewarm') {
            await harness.fakeCli('catalog').exec(['models', '--verbose'])
          }
          child = harness.spawnChild('catalog')
          return host(harness, child.pid, preparedProfile)
        },
        releaseHost: async () => { child?.cleanup() },
      },
      clientFactory: {
        create: () => ({
          getConfigProviders: () => api.request('GET', '/config/providers'),
          getProviders: () => api.request('GET', '/provider'),
          getProviderAuth: () => api.request('GET', '/auth'),
          getServerDoc: () => api.request('GET', '/doc'),
        } as never),
      },
    })

    const result = await adapter.loadDirectory({
      runtimeId: 'opencode',
      projectPath: harness.projectPath,
      query: null,
      filter: 'all',
      limit: 50,
      cursor: null,
      refresh: false,
    })

    expect(result.ok).toBe(true)
    expect({
      inventoryModes,
      commands: harness.journal.commands,
      managedPlugins: harness.journal.managedPlugins,
      httpRequests: harness.journal.httpRequests,
      childProcesses: harness.journal.childProcesses,
    }).toEqual({
      inventoryModes: ['profile'],
      commands: [],
      managedPlugins: [{
        target: 'catalog',
        packageName: 'opencode-kiro@0.4.0',
        action: 'serve-startup',
      }],
      httpRequests: [
        { target: 'catalog', method: 'GET', pathname: '/doc' },
        { target: 'catalog', method: 'GET', pathname: '/config/providers' },
        { target: 'catalog', method: 'GET', pathname: '/provider' },
        { target: 'catalog', method: 'GET', pathname: '/auth' },
      ],
      childProcesses: [
        { target: 'catalog', pid: 41_000, event: 'spawn' },
        { target: 'catalog', pid: 41_000, event: 'cleanup' },
      ],
    })
  } finally {
    child?.cleanup()
    await harness.cleanup()
  }
})

test('RED/#436/#443: production exposes a public parameterized purpose-composition adapter', async () => {
  const production = await import('../src/services/opencode/OpenCodeProvisioningProbe.js') as Record<string, unknown>
  type PublicPurposeAdapterFactory = (options: {
    selected: { projectPath: string; provider: string; model: string }
    ports: {
      cli(args: readonly string[]): Promise<void>
      plugin(provider: string): Promise<void>
      host(operation: string): Promise<void>
    }
  }) => {
    status(): Promise<unknown>
    catalog(): Promise<unknown>
    launch(): Promise<unknown>
  }
  const factory = production.createOpenCodePurposeCompositionAdapter as PublicPurposeAdapterFactory | undefined

  expect(
    typeof factory,
    'Phase 1 seam missing: export createOpenCodePurposeCompositionAdapter(selected provider/model + observable callable ports)',
  ).toBe('function')

  // Once Phase 1 adds the public seam, this unchanged assertion binds the same selected target
  // to callable CLI/plugin/host ports without reaching a private method by cast.
  const calls: string[] = []
  const adapter = factory!({
    selected: { projectPath: '/test-sandbox/project', provider: 'deepinfra', model: 'deepinfra/model' },
    ports: {
      cli: async args => { calls.push(`cli:${args.join(' ')}`) },
      plugin: async provider => { calls.push(`plugin:${provider}`) },
      host: async operation => { calls.push(`host:${operation}`) },
    },
  })
  await adapter.launch()
  expect(calls.some(call => call.includes('models --verbose') || call.includes('full'))).toBe(false)
  expect(calls.some(call => /plugin:(kiro|cursor)/.test(call))).toBe(false)
})
