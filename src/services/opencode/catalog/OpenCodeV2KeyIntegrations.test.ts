import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { OPENCODE_V2_NATIVE_KEY_OPTION_ID, openCodeV2KeyIntegrations, openCodeV2ProviderConnectionsDirectory,
  readOpenCodeV2ConnectedProviders } from './OpenCodeV2KeyIntegrations.js'
import { openCodeV2InventorySnapshot } from './OpenCodeV2InventoryService.js'
import { buildOpenCodeV2KeySetupForm, connectOpenCodeV2Provider } from '../../../features/runtimeProviderManagement/adapters/opencode/OpenCodeV2ProviderManagement.js'
import type { OpenCodeV2NativeIdentity } from '../compatibility/OpenCodeNativeIdentity.js'

const native: OpenCodeV2NativeIdentity = { generation: 'v2', version: '2.1.4', dialect: 'v2-2.1.4',
  executablePath: '/TEST/native/opencode', executableSha256: 'a'.repeat(64), packageName: '@opencode/cli-darwin-arm64' }

async function withDataHome<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'TEST-v2-key-integrations-'))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
  try {
    const directory = openCodeV2ProviderConnectionsDirectory()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return await run(directory)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
}
const receipt = (state: string, providerId: string, projectPath: string, opencodeVersion = '2.1.4') => JSON.stringify({ state,
  connection: { providerId, state: 'connected' }, proof: { projectPath, opencodeVersion } })

test('only completed owner-private receipts for the exact project and version mark a provider connected', () => withDataHome(async directory => {
  const write = async (name: string, content: string, mode = 0o600) => {
    const file = path.join(directory, name.padEnd(64, '0') + '.json')
    await writeFile(file, content, { mode }); await chmod(file, mode)
  }
  await write('a', receipt('complete', 'kimi-code-plan-cn', '/TEST/project'))
  await write('b', receipt('pending', 'kimi-code-plan-global', '/TEST/project'))
  await write('c', receipt('complete', 'moonshotai', '/TEST/other-project'))
  await write('d', receipt('complete', 'openrouter', '/TEST/project'), 0o644)
  await write('e', '{not json')
  await write('f', receipt('complete', 'kimi-code-plan-global', '/TEST/project', '2.0.32'))
  await writeFile(path.join(directory, 'not-a-receipt.json'), receipt('complete', 'xai', '/TEST/project'), { mode: 0o600 })
  expect(await readOpenCodeV2ConnectedProviders('/TEST/project', '2.1.4')).toEqual([
    { id: 'kimi-code-plan-cn', authHint: 'api', source: 'credentials', credentialScopes: ['managed'] }])
}))

test('the V2 directory lists every registered key integration and only completed connections as connected', () => {
  const connected = [{ id: 'kimi-code-plan-cn', authHint: 'api', source: 'credentials' as const }]
  const snapshot = openCodeV2InventorySnapshot(native, '/TEST/project', undefined, null, connected)
  expect(openCodeV2KeyIntegrations('2.1.4').length).toBeGreaterThan(0)
  for (const { providerId } of openCodeV2KeyIntegrations('2.1.4')) expect(snapshot.availableProviders).toContain(providerId)
  expect(snapshot.connectedProviders).toEqual(connected)
  expect(openCodeV2InventorySnapshot(native, '/TEST/project').connectedProviders).toEqual([])
  // The floor release's native catalog has no such integrations.
  expect(openCodeV2KeyIntegrations('2.0.0')).toEqual([])
})

test('a registered key integration gets the native key form; connect admits only that option', async () => {
  const form = buildOpenCodeV2KeySetupForm('kimi-code-plan-global', '2.1.4')
  expect(form).toMatchObject({ providerId: 'kimi-code-plan-global', displayName: 'Kimi For Coding (kimi.ai)', method: 'api',
    supported: true, defaultAuthOptionId: OPENCODE_V2_NATIVE_KEY_OPTION_ID, secret: { key: 'key', required: true } })
  expect(form?.authOptions.map(option => option.id)).toEqual([OPENCODE_V2_NATIVE_KEY_OPTION_ID])
  expect(buildOpenCodeV2KeySetupForm('openrouter', '2.1.4')).toBeNull()
  expect(buildOpenCodeV2KeySetupForm('kimi-code-plan-global', '2.0.0')).toBeNull()
  // A foreign option id is refused before any selection, profile or credential effect.
  expect(await connectOpenCodeV2Provider({ runtimeId: 'opencode', providerId: 'kimi-code-plan-global', method: 'api',
    apiKey: 'TEST-key', authOptionId: 'api:curated', projectPath: '/TEST/project' })).toMatchObject({
    ok: false, error: { code: 'unsupported-auth-method' } })
  expect(await connectOpenCodeV2Provider({ runtimeId: 'opencode', providerId: 'openrouter', method: 'api',
    apiKey: 'TEST-key', authOptionId: OPENCODE_V2_NATIVE_KEY_OPTION_ID, projectPath: '/TEST/project' })).toMatchObject({
    ok: false, error: { code: 'unsupported-auth-method' } })
})
