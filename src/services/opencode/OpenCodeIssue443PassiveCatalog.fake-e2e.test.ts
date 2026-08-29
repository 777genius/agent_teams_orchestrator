import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { OpenCodeProviderManagementAdapter } from '../../features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.js'
import { buildOpenCodePassiveStatus } from '../runtimeBackends/openCodePassiveStatus.js'
import { deferred, Issue443Harness } from './OpenCodeIssue443FakeE2E.test-support.js'

describe('issue #443 passive status/catalog fake E2E', () => {
  let harness: Issue443Harness

  beforeEach(async () => {
    harness = new Issue443Harness()
    await harness.open()
  })
  afterEach(async () => { await harness.close() })

  function adapter(timeoutMs = 500) {
    return new OpenCodeProviderManagementAdapter({
      catalogTimeoutMs: timeoutMs,
      inventoryTimeoutMs: 1_000,
      resolveBinaryPath: () => `${harness.sandbox}/fake-opencode`,
      resolveBinaryIdentity: async () => 'fake-binary-443',
      profileManager: {
        listManagedAuthPaths: async () => [],
        readCatalogSelectedAuthIdentity: async ({ profileScope }) => {
          harness.commands.push(['selected-auth-identity', 'deepinfra'])
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
        releaseHost: async () => {},
      },
      clientFactory: {
        create: (baseUrl, options) => {
          expect(baseUrl).toBe('http://fake-host.invalid')
          if (harness.catalogGate) {
            options?.signal?.addEventListener('abort', () => {
              queueMicrotask(() => harness.catalogGate?.resolve())
            }, { once: true })
          }
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
    const catalog = adapter(100)
    const input = { runtimeId: 'opencode' as const, providerId: 'deepinfra', projectPath: harness.projectPath }
    const initial = await catalog.loadModels(input)
    if (!initial.ok) throw new Error(JSON.stringify(initial))
    expect(initial.ok).toBe(true)

    harness.catalogGate = deferred<void>()
    const stale = await catalog.loadModels(input)
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

    const afterLateCompletion = await catalog.loadModels(input)
    expect(afterLateCompletion.ok).toBe(true)
    if (afterLateCompletion.ok) {
      expect(afterLateCompletion.value.models.map(model => model.modelId)).toEqual([harness.catalogModel])
    }
    expect(harness.endpoints.every(call => call.baseUrl === 'http://fake-host.invalid')).toBe(true)
    expect(harness.commands.flat()).not.toContain('kiro')
    expect(harness.commands.flat()).not.toContain('cursor-acp')
    harness.assertSafe()
  })
})
