import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'

import { OpenCodeProviderManagementAdapter } from '../../features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.js'
import { buildOpenCodePassiveStatus } from '../runtimeBackends/openCodePassiveStatus.js'
import { deferred, Issue443Harness } from './OpenCodeIssue443FakeE2E.test-support.js'

describe('issue #443 passive status/catalog fake E2E', () => {
  let harness: Issue443Harness

  beforeEach(async () => {
    jest.useFakeTimers()
    harness = new Issue443Harness()
    await harness.open()
  })
  afterEach(async () => {
    jest.clearAllTimers()
    jest.useRealTimers()
    await harness.close()
  })

  function adapter(timeoutMs = 500, hooks: {
    onIdentityRead?: () => void
    onReleaseHost?: () => void
  } = {}) {
    return new OpenCodeProviderManagementAdapter({
      catalogTimeoutMs: timeoutMs,
      inventoryTimeoutMs: 1_000,
      resolveBinaryPath: () => `${harness.sandbox}/fake-opencode`,
      resolveBinaryIdentity: async () => 'fake-binary-443',
      profileManager: {
        listManagedAuthPaths: async () => [],
        readCatalogSelectedAuthIdentity: async ({ profileScope }) => {
          harness.commands.push(['selected-auth-identity', 'deepinfra'])
          hooks.onIdentityRead?.()
          return {
            source: profileScope.selectedAuthIdentity,
            managed: profileScope.selectedAuthIdentity,
            preferences: 'known:preferences-443' as const,
          }
        },
      },
      managedPreferences: { read: async () => ({}) },
      inventoryService: {
        probe: async (_projectPath, options) => {
          expect(options?.mode).toBe('profile')
          return harness.catalogInventory({ mode: options?.mode })
        },
      },
      hostManager: {
        ensureHost: async options => {
          expect(options.prewarmManagedSubscriptionPlugins).toBe(false)
          expect(options.profileOptions?.profileScope?.purpose).toBe('catalog')
          return harness.catalogHost()
        },
        releaseHost: async () => { hooks.onReleaseHost?.() },
      },
      clientFactory: {
        create: baseUrl => {
          expect(baseUrl).toBe('http://fake-host.invalid')
          return harness.catalogClient()
        },
      },
    })
  }

  test('poisoned unrelated providers cannot block passive status or scoped DeepInfra catalog', async () => {
    const poisonedKiro = deferred<never>()
    const poisonedCursor = deferred<never>()
    void poisonedKiro
    void poisonedCursor

    const status = buildOpenCodePassiveStatus({
      readOpenCodePassiveEvidence: () => ({
        state: 'ready', binaryPath: `${harness.sandbox}/fake-opencode`,
        version: 'fake-443', models: [],
      }),
    })
    expect(status.statusCheckOutcome).toBe('model_only')
    expect(await harness.sandboxEntries()).toEqual([])
    expect(harness).toMatchObject({ writes: [], profiles: [], hosts: [], processTrees: [] })

    const result = await adapter().loadModels({
      runtimeId: 'opencode', providerId: 'deepinfra', projectPath: harness.projectPath,
    })
    if (!result.ok) throw new Error(JSON.stringify(result))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.models.map(model => model.modelId)).toEqual([harness.catalogModel])
    expect(harness.commands.every(command => command.includes('deepinfra'))).toBe(true)
    expect(harness.endpoints.map(call => call.endpoint)).toEqual(['/config/providers', '/provider'])
    expect(harness.plugins).toEqual([])
    expect(harness.mcp).toEqual([])
    expect(await harness.sandboxEntries()).toEqual([])
    harness.assertSafe()
  })

  test('timeout serves stale evidence and a late generation cannot replace newer evidence', async () => {
    let identityReads = 0
    let releases = 0
    const timeoutIdentityRead = deferred<void>()
    const latePublishIdentityRead = deferred<void>()
    const catalog = adapter(100, {
      onIdentityRead: () => {
        identityReads += 1
        if (identityReads === 6) timeoutIdentityRead.resolve()
        if (identityReads === 10) latePublishIdentityRead.resolve()
      },
      onReleaseHost: () => {
        releases += 1
      },
    })
    const input = { runtimeId: 'opencode' as const, providerId: 'deepinfra', projectPath: harness.projectPath }
    const initial = await catalog.loadModels(input)
    if (!initial.ok) throw new Error(JSON.stringify(initial))
    expect(initial.ok).toBe(true)
    expect(initial.value.catalogState).toBe('fresh')
    expect(initial.value.models.map(model => model.modelId)).toEqual([harness.catalogModel])

    const lateGate = deferred<void>()
    harness.catalogGate = lateGate
    const staleRequest = catalog.loadModels(input)
    await harness.catalogGateEntered.promise
    expect(jest.getTimerCount()).toBe(1)
    jest.advanceTimersByTime(100)
    await timeoutIdentityRead.promise
    for (let index = 0; index < 10; index += 1) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const stale = await staleRequest
    if (!stale.ok) throw new Error(JSON.stringify(stale))
    expect(stale.ok).toBe(true)
    if (!stale.ok) return
    expect(stale.value.catalogState).toBe('stale')
    expect(stale.value.models.map(model => model.modelId)).toEqual([harness.catalogModel])

    harness.catalogGate = null
    harness.catalogModel = 'deepinfra/Qwen/Qwen3-Next'
    const current = await catalog.loadModels(input)
    expect(current.ok).toBe(true)
    if (!current.ok) return
    expect(current.value.catalogState).toBe('fresh')
    expect(current.value.models.map(model => model.modelId)).toEqual([harness.catalogModel])

    expect(releases).toBe(3)
    lateGate.resolve()
    await latePublishIdentityRead.promise
    for (let index = 0; index < 10; index += 1) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const cache = (catalog as unknown as {
      catalogCache: Map<string, {
        providers: { all: Array<{ models?: Record<string, unknown> }> } | null
      }>
    }).catalogCache
    expect(Array.from(cache.values()).at(-1)?.providers?.all[0]?.models).toEqual({
      'Qwen/Qwen3-Next': {},
    })
    expect(harness.endpoints.every(call => call.baseUrl === 'http://fake-host.invalid')).toBe(true)
    expect(harness.commands.flat()).not.toContain('kiro')
    expect(harness.commands.flat()).not.toContain('cursor-acp')
    harness.assertSafe()
  })
})
