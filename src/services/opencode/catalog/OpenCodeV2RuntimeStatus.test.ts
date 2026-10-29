import { expect, test } from 'bun:test'
import { openCodeV2InventorySnapshot } from './OpenCodeV2InventoryService.js'
import { emptyOpenCodeV2ReadStatus, readModel, readProvider } from './OpenCodeV2ReadStatus.js'
import { buildOpenCodeV2RuntimeStatus } from './OpenCodeV2RuntimeStatus.js'
import type { OpenCodeV2NativeIdentity } from '../compatibility/OpenCodeNativeIdentity.js'

const native: OpenCodeV2NativeIdentity = {
  generation: 'v2', version: '2.1.4', engineVersion: '2.1.4', dialect: 'v2-2.1.4',
  executablePath: '/TEST/opencode', executableSha256: 'a'.repeat(64), packageName: null,
}

test.each([
  ['provider/removed', 'native', 'provider/native'],
  ['provider/disabled', 'native', 'provider/disabled'],
  ['provider/removed', null, null],
] as const)('V2 status resolves managed default %s with native default %s to %s', (managed, nativeDefault, expected) => {
  const project = '/TEST/default-models'
  const snapshot = openCodeV2InventorySnapshot(native, project, {
    ...emptyOpenCodeV2ReadStatus(native, project), catalog: 'ready',
    providers: [readProvider({ id: 'provider', activation: 'enabled' })],
    models: ['native', 'disabled'].map(id => readModel({ id, modelID: id, providerID: 'provider',
      enabled: id !== 'disabled', status: 'active', variants: [], capabilities: { tools: true, input: ['text'], output: ['text'] },
      limit: { context: 8192, output: 512 } })),
    defaultModel: nativeDefault ? { providerId: 'provider', catalogId: nativeDefault } : null,
  })
  const status = buildOpenCodeV2RuntimeStatus(snapshot, managed)
  expect(status.modelCatalog?.defaultModelId).toBe(expected)
  expect(status.modelCatalog?.models.filter(model => model.isDefault).map(model => model.id)).toEqual(expected ? [expected] : [])
  expect(status.modelCatalog?.models.find(model => model.id === 'provider/disabled')?.hidden).toBe(true)
  expect(status.modelCatalog?.defaultLaunchModel).toBeNull()
  expect(status.authenticated).toBe(false)
  expect(status.capabilities.teamLaunch).toBe(false)
})
