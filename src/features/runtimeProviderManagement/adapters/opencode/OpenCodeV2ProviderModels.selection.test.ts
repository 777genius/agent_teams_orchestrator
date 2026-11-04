import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as nativeIdentity from '../../../../services/opencode/compatibility/OpenCodeNativeIdentity.js'
import { createOpenCodeV2ExecutionReceipt } from '../../../../services/opencode/profile/OpenCodeV2ExecutionReceipt.js'
import { loadOpenCodeV2ProviderModels } from './OpenCodeV2ProviderManagement.js'

afterEach(() => { inspect?.mockRestore(); inspect = undefined })
let inspect: ReturnType<typeof spyOn<typeof nativeIdentity, 'inspectOpenCodeReadSelection'>> | undefined
const unavailable = { path: null, policy: { generation: 'unsupported', version: null }, native: null, fingerprint: null } as const
const input = { runtimeId: 'opencode' as const, providerId: 'kimi-for-coding', projectPath: '/TEST/catalog-selection' }

test('a request carries its selected snapshot into the catalog without a second inspection', async () => {
  inspect = spyOn(nativeIdentity, 'inspectOpenCodeReadSelection').mockResolvedValue(unavailable)
  const selected = await nativeIdentity.inspectOpenCodeReadSelection()
  expect((await loadOpenCodeV2ProviderModels(input, selected)).ok).toBe(false)
  expect(inspect).toHaveBeenCalledTimes(1)
})

test('a direct V2 catalog caller still performs its own identity inspection', async () => {
  inspect = spyOn(nativeIdentity, 'inspectOpenCodeReadSelection').mockResolvedValue(unavailable)
  expect((await loadOpenCodeV2ProviderModels(input)).ok).toBe(false)
  expect(inspect).toHaveBeenCalledTimes(1)
})

test('receipt still rejects changed native bytes retained by a request snapshot', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-catalog-retained-native-')))
  const executablePath = path.join(root, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
  const before = Buffer.from('TEST-original-native-bytes')
  const selected: nativeIdentity.OpenCodeV2NativeIdentity = {
    generation: 'v2', version: '2.1.4', engineVersion: '2.1.4', dialect: 'v2-2.1.4',
    executablePath, executableSha256: createHash('sha256').update(before).digest('hex'),
    packageName: null, origin: 'standalone',
  }
  try {
    await writeFile(executablePath, before)
    await writeFile(executablePath, 'TEST-replaced-native-bytes')
    await expect(createOpenCodeV2ExecutionReceipt('/TEST-unused-source-root', selected)).rejects.toThrow('native_selection_changed')
  } finally { await rm(root, { recursive: true, force: true }) }
})
