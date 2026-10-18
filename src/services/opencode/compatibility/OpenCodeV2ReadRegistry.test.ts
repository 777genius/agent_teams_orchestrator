import { expect, test } from 'bun:test'
import { getUnifiedRuntimeStatusPayload } from '../../runtimeBackends/registry.js'
import { emptyOpenCodeV2ReadStatus } from '../catalog/OpenCodeV2ReadStatus.js'
import { openCodeV2InventorySnapshot } from '../catalog/OpenCodeV2InventoryService.js'
import type { OpenCodeV2NativeIdentity } from './OpenCodeNativeIdentity.js'

const native: OpenCodeV2NativeIdentity = { generation: 'v2', version: '2.0.32', dialect: 'v2-2.0.32',
  executablePath: '/TEST/native/opencode', executableSha256: 'a'.repeat(64), packageName: '@opencode/cli-linux-x64' }

test('full status never derives V2 authentication or team launch from catalog or stale V1 auth', async () => {
  const read = { ...emptyOpenCodeV2ReadStatus(native, '/TEST'), catalog: 'ready' as const,
    configuration: { documents: 1, directories: 0 }, models: [{ providerId: 'TEST', catalogId: 'catalog', upstreamModelId: 'upstream',
      variants: ['variant'], enabled: true, status: 'active' as const, tools: true, input: ['text'], output: ['text'], context: 8192, outputTokens: 512 }] }
  const snapshot = openCodeV2InventorySnapshot(native, '/TEST', read)
  snapshot.connectedProviders = [{ id: 'TEST', source: 'credentials', authHint: 'oauth' }]
  const payload = await getUnifiedRuntimeStatusPayload('opencode', { getOpenCodeInventorySnapshot: async () => snapshot })
  expect(payload.providers.opencode).toMatchObject({ authenticated: false, verificationState: 'unknown',
    capabilities: { teamLaunch: false, oneShot: false }, statusCheckOutcome: 'model_only',
    openCodeReadStatus: { supportState: 'capabilities_pending', authentication: 'unknown', catalog: 'ready' } })
  expect(payload.providers.opencode?.models).toEqual(['TEST/catalog'])
  expect(payload.providers.opencode?.modelCatalog?.defaultLaunchModel).toBeNull()
})

test('summary status calls no active V2 producer', async () => {
  let effects = 0
  const payload = await getUnifiedRuntimeStatusPayload('opencode', {
    getOpenCodeInventorySnapshot: async () => { effects++; throw new Error('must stay passive') },
    readOpenCodePassiveEvidence: () => ({ state: 'ready', binaryPath: native.executablePath, version: native.version }),
  }, { detailLevel: 'summary' })
  expect(effects).toBe(0)
  expect(payload.providers.opencode?.capabilities.teamLaunch).toBe(false)
  expect(payload.providers.opencode?.authenticated).toBe(false)
  expect(payload.providers.opencode?.openCodeReadStatus).toBeUndefined()
})
