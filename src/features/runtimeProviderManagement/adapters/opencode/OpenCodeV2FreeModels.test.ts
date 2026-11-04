import { expect, test } from 'bun:test'
import { isOpenCodeV2AnonymousProvider, isOpenCodeV2ModelFree, isOpenCodeV2ZeroCost } from '../../../../services/opencode/catalog/OpenCodeV2ModelPricing.js'
import { emptyOpenCodeV2ReadStatus, readModel, readProvider } from '../../../../services/opencode/catalog/OpenCodeV2ReadStatus.js'
import { openCodeV2InventorySnapshot } from '../../../../services/opencode/catalog/OpenCodeV2InventoryService.js'
import { buildOpenCodeV2RuntimeStatus } from '../../../../services/opencode/catalog/OpenCodeV2RuntimeStatus.js'
import type { OpenCodeV2NativeIdentity } from '../../../../services/opencode/compatibility/OpenCodeNativeIdentity.js'
import { buildOpenCodeV2RuntimeProviderModel } from './OpenCodeV2ProviderManagement.js'
import { buildOpenCodeV2ProviderDirectoryEntries } from './OpenCodeV2ProviderDirectory.js'

const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } }
const provider = { id: 'opencode', integrationID: 'opencode', activation: 'enabled', settings: { apiKey: 'public' } }
const model = { id: 'catalog-free', modelID: 'upstream', providerID: 'opencode', name: 'Native free model',
  enabled: true, status: 'active', cost: [zero], variants: [],
  capabilities: { tools: true, input: ['text', 'image'], output: ['text'] }, limit: { context: 8192, output: 512 } }
const native: OpenCodeV2NativeIdentity = { generation: 'v2', version: '2.1.4', dialect: 'v2-2.1.4',
  executablePath: '/TEST/opencode', executableSha256: 'a'.repeat(64), packageName: '@opencode/cli-linux-x64' }

test('V2 free price requires every complete native tier to be zero, without name heuristics', () => {
  expect(isOpenCodeV2ZeroCost([zero])).toBe(true)
  expect(isOpenCodeV2ZeroCost([zero, { ...zero, tier: { context: 1000 } }])).toBe(true)
  for (const cost of [undefined, null, {}, [], [null], [zero, { ...zero, input: 1 }],
    [{ ...zero, output: 0.01 }], [{ input: 0, output: 0 }], [{ ...zero, cache: { read: 1, write: 0 } }],
    [{ ...zero, cache: { read: 0, write: 1 } }], [{ ...zero, input: '0' }]]) {
    expect(isOpenCodeV2ZeroCost(cost)).toBe(false)
  }
  expect(isOpenCodeV2ModelFree('opencode-go', [zero])).toBe(false)
  expect(buildOpenCodeV2RuntimeProviderModel({ ...model, id: 'paid-free', cost: [{ ...zero, input: 1 }] }, 'opencode', null, true).free).toBe(false)
})

test('only the native anonymous OpenCode sentinel gives no-key catalog metadata', () => {
  expect(isOpenCodeV2AnonymousProvider(provider)).toBe(true)
  for (const changed of [{ ...provider, id: 'opencode-go' }, { ...provider, activation: 'auto' },
    { ...provider, integrationID: 'other' }, { ...provider, settings: { apiKey: 'TEST-secret' } },
    { ...provider, settings: null }]) expect(isOpenCodeV2AnonymousProvider(changed)).toBe(false)
  const mapped = buildOpenCodeV2RuntimeProviderModel(model, 'opencode', 'opencode/catalog-free', true)
  expect(mapped).toMatchObject({ free: true, default: true, accessKind: 'builtin_free', routeKind: 'builtin_free',
    availability: 'untested', requiresExecutionProof: true, proofState: 'needs_probe' })
  for (const [row, providerId, anonymous] of [[model, 'opencode', false], [model, 'deepseek', true],
    [{ ...model, enabled: false }, 'opencode', true], [{ ...model, status: 'deprecated' }, 'opencode', true]] as const) {
    expect(buildOpenCodeV2RuntimeProviderModel(row, providerId, null, anonymous).accessKind).toBe('credentialed')
  }
  expect(buildOpenCodeV2RuntimeProviderModel({ ...model, status: 'deprecated' }, 'opencode', null, true).catalogStatus).toBe('deprecated')
  expect(buildOpenCodeV2RuntimeProviderModel({ ...model, enabled: false }, 'opencode', null, true).availability).toBe('unavailable')
})

test('native free discovery survives directory and passive-status projection without execution claims or secrets', () => {
  const status = { ...emptyOpenCodeV2ReadStatus(native, '/TEST/project'), catalog: 'ready' as const,
    providers: [readProvider(provider)], integrations: [{ id: 'opencode', name: 'OpenCode', plainKey: true }],
    models: [readModel(model)] }
  const inventory = openCodeV2InventorySnapshot(native, '/TEST/project', status)
  const directory = buildOpenCodeV2ProviderDirectoryEntries(inventory).entries.find(row => row.providerId === 'opencode')!
  expect(directory).toMatchObject({ state: 'available', setupKind: 'available-readonly', ownership: [], modelCount: 1 })
  expect(directory.detail).toContain('without an API key')
  expect(directory.actions.some(action => action.id === 'use' && action.enabled && !action.requiresSecret)).toBe(true)
  const runtime = buildOpenCodeV2RuntimeStatus(inventory)
  expect(runtime).toMatchObject({ authenticated: false, statusCheckOutcome: 'model_only',
    capabilities: { teamLaunch: false, oneShot: false } })
  expect(runtime.modelCatalog?.models[0]).toMatchObject({ badgeLabel: 'Free', metadata: { free: true, opencode: {
    accessKind: 'builtin_free', routeKind: 'builtin_free', proofState: 'needs_probe', requiresExecutionProof: true } } })
  expect(runtime.modelCatalog?.defaultLaunchModel).toBeNull()
  expect(readProvider({ ...provider, settings: { apiKey: 'TEST-secret' } }).anonymous).toBe(false)
  expect(JSON.stringify(readProvider({ ...provider, settings: { apiKey: 'TEST-secret' } }))).not.toContain('TEST-secret')
  expect(JSON.stringify(readModel({ ...model, cost: [{ ...zero, secret: 'TEST-secret' }] }))).not.toContain('TEST-secret')
})
