import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { OpenCodeConnectedProvider } from './types.js'
import type { OpenCodeV2NativeIdentity } from './compatibility/OpenCodeNativeIdentity.js'

// Run alone: replace catalog/identity I/O, never an execution authority or proof.
const identityModule = await import('./compatibility/OpenCodeNativeIdentity.js')
const inventoryModule = await import('./catalog/OpenCodeV2InventoryService.js')
const keyModule = await import('./catalog/OpenCodeV2KeyIntegrations.js')
const { emptyOpenCodeV2ReadStatus } = await import('./catalog/OpenCodeV2ReadStatus.js')
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-inventory-cache-')))
const other = path.join(root, 'other')
await mkdir(other)
const original: OpenCodeV2NativeIdentity = { generation: 'v2', version: '2.1.4', engineVersion: '2.1.4',
  dialect: 'v2-2.1.4', executablePath: '/TEST/opencode', executableSha256: 'a'.repeat(64),
  origin: 'npm', packageName: '@opencode/cli-linux-x64' }
let native = { ...original }, catalogReads = 0, failure = false
let receiptRows: OpenCodeConnectedProvider[] = []
let finishRead: (() => void) | undefined
let finishReceiptRead: (() => void) | undefined
let pauseRead: (() => Promise<void>) | undefined
let catalogName = 'OpenCode Go'
mock.module('./compatibility/OpenCodeNativeIdentity.js', () => ({ ...identityModule,
  inspectOpenCodeReadSelection: async () => ({ path: native.executablePath, native: { ...native },
    policy: { generation: 'v2', version: native.version }, fingerprint: native.executableSha256 }),
}))
mock.module('./catalog/OpenCodeV2KeyIntegrations.js', () => ({ ...keyModule,
  readOpenCodeV2ConnectedProviders: async () => { finishReceiptRead?.(); return [...receiptRows] },
}))
mock.module('./catalog/OpenCodeV2InventoryService.js', () => ({ ...inventoryModule,
  probeOpenCodeV2Inventory: async (selected: OpenCodeV2NativeIdentity, directory: string) => {
    catalogReads++
    const read = { ...emptyOpenCodeV2ReadStatus(selected, directory), catalog: failure ? 'unavailable' as const : 'ready' as const,
      integrations: [{ id: 'opencode-go', name: catalogName, plainKey: true }] }
    const snapshot = inventoryModule.openCodeV2InventorySnapshot(selected, directory, read, failure ? 'TEST read failed' : null, receiptRows)
    const pause = pauseRead
    pauseRead = undefined
    finishRead?.()
    await pause?.()
    return snapshot
  },
}))
const { OpenCodeInventoryService } = await import('./OpenCodeInventoryService.js')
beforeEach(() => { native = { ...original }; catalogReads = 0; failure = false; receiptRows = []; finishRead = undefined; finishReceiptRead = undefined;
  pauseRead = undefined; catalogName = 'OpenCode Go' })
afterAll(() => rm(root, { recursive: true, force: true }))

function holdNextRead() {
  let begin!: () => void, resume!: () => void
  const started = new Promise<void>(resolve => { begin = resolve })
  const held = new Promise<void>(resolve => { resume = resolve })
  pauseRead = () => { begin(); return held }
  return { started, resume }
}

test('successful V2 full reads reuse the catalog but reread completed connection receipts', async () => {
  const service = new OpenCodeInventoryService()
  const first = await service.probe(root, { mode: 'full' })
  expect(first.connectedProviders).toEqual([])
  receiptRows = [{ id: 'opencode-go', source: 'credentials', authHint: 'api', credentialScopes: ['managed'] }]
  expect((await service.probe(root, { mode: 'full' })).connectedProviders).toEqual(receiptRows)
  expect(catalogReads).toBe(1)
  receiptRows = []
  expect((await service.probe(root, { mode: 'full' })).connectedProviders).toEqual([])
  expect(catalogReads).toBe(1)
})

test('native selection and canonical project identity partition V2 cache entries', async () => {
  const service = new OpenCodeInventoryService()
  await service.probe(root)
  await service.probe(other)
  native.executableSha256 = 'b'.repeat(64)
  await service.probe(root)
  native = { ...original, version: '2.2.0' }
  await service.probe(root)
  native = { ...original, origin: 'standalone', packageName: null }
  await service.probe(root)
  expect(catalogReads).toBe(5)
})

test('explicit refresh and clearCache force new catalog reads, while summary remains passive', async () => {
  const service = new OpenCodeInventoryService()
  await service.probe(root)
  await service.probe(root, { bypassCache: true })
  await service.probe(root, { refreshModels: true })
  service.clearCache()
  await service.probe(root)
  await service.probe(root, { mode: 'summary' })
  expect(catalogReads).toBe(4)
})

test('failed and aborted catalogs are not cached and a failed refresh evicts a previous success', async () => {
  const service = new OpenCodeInventoryService()
  await service.probe(root)
  failure = true
  await service.probe(root, { bypassCache: true })
  await service.probe(root)
  expect(catalogReads).toBe(3)
  failure = false
  const controller = new AbortController()
  finishRead = () => controller.abort()
  await service.probe(root, { abortSignal: controller.signal })
  finishRead = undefined
  await service.probe(root)
  expect(catalogReads).toBe(5)
})

test('cancellation during a fresh receipt read cannot publish a cached catalog for that request', async () => {
  const service = new OpenCodeInventoryService()
  await service.probe(root)
  const controller = new AbortController()
  finishReceiptRead = () => controller.abort()
  await expect(service.probe(root, { abortSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(catalogReads).toBe(1)
})

test('an older catalog cannot replace a completed explicit refresh', async () => {
  const service = new OpenCodeInventoryService(), held = holdNextRead()
  const older = service.probe(root)
  await held.started
  catalogName = 'TEST refreshed catalog'
  await service.probe(root, { bypassCache: true })
  held.resume(); await older
  expect((await service.probe(root)).readStatus?.integrations[0]?.name).toBe('TEST refreshed catalog')
  expect(catalogReads).toBe(2)
})

for (const outcome of ['failed', 'aborted'] as const) test(`an older ${outcome} catalog cannot evict a completed refresh`, async () => {
  const service = new OpenCodeInventoryService(), held = holdNextRead(), controller = new AbortController()
  failure = outcome === 'failed'
  const older = service.probe(root, { abortSignal: controller.signal })
  await held.started
  failure = false; catalogName = 'TEST refreshed catalog'
  await service.probe(root, { bypassCache: true })
  if (outcome === 'aborted') controller.abort()
  held.resume(); await older
  expect((await service.probe(root)).readStatus?.integrations[0]?.name).toBe('TEST refreshed catalog')
  expect(catalogReads).toBe(2)
})

test('a failed refresh cannot be undone by a late older success', async () => {
  const service = new OpenCodeInventoryService(), held = holdNextRead()
  const older = service.probe(root)
  await held.started
  failure = true
  await service.probe(root, { bypassCache: true })
  held.resume(); await older
  failure = false; catalogName = 'TEST fresh after failure'
  expect((await service.probe(root)).readStatus?.integrations[0]?.name).toBe('TEST fresh after failure')
  expect(catalogReads).toBe(3)
})

test('clearCache prevents a running old read from repopulating the catalog', async () => {
  const service = new OpenCodeInventoryService(), held = holdNextRead()
  const older = service.probe(root)
  await held.started
  service.clearCache()
  held.resume(); await older
  catalogName = 'TEST fresh after clear'
  expect((await service.probe(root)).readStatus?.integrations[0]?.name).toBe('TEST fresh after clear')
  expect(catalogReads).toBe(2)
})

test('overlapping reads for different projects keep their independent cache entries', async () => {
  const service = new OpenCodeInventoryService(), held = holdNextRead()
  const first = service.probe(root)
  await held.started
  catalogName = 'TEST other project'
  await service.probe(other)
  held.resume(); await first
  expect((await service.probe(root)).readStatus?.integrations[0]?.name).toBe('OpenCode Go')
  expect((await service.probe(other)).readStatus?.integrations[0]?.name).toBe('TEST other project')
  expect(catalogReads).toBe(2)
})
