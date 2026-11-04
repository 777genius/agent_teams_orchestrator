import { expect, test } from 'bun:test'
import { emptyOpenCodeV2ReadStatus } from '../../../../services/opencode/catalog/OpenCodeV2ReadStatus.js'
import { openCodeV2InventorySnapshot } from '../../../../services/opencode/catalog/OpenCodeV2InventoryService.js'
import type { OpenCodeV2NativeIdentity } from '../../../../services/opencode/compatibility/OpenCodeNativeIdentity.js'
import { buildOpenCodeV2ProviderDirectoryEntries } from './OpenCodeV2ProviderDirectory.js'

const native: OpenCodeV2NativeIdentity = { generation: 'v2', version: '2.1.4', dialect: 'v2-2.1.4',
  executablePath: '/TEST/opencode', executableSha256: 'a'.repeat(64), packageName: '@opencode/cli-linux-x64' }
const read = () => ({ ...emptyOpenCodeV2ReadStatus(native, '/TEST/project'), catalog: 'ready' as const,
  integrations: [
    { id: 'opencode-go', name: 'OpenCode Go', plainKey: true },
    { id: 'openai', name: 'OpenAI', plainKey: true },
    { id: 'deepseek', name: 'DeepSeek', plainKey: true },
    { id: 'github-copilot', name: 'GitHub Copilot', plainKey: false },
    { id: 'exa', name: 'Exa', plainKey: true },
    { id: 'tavily', name: 'Tavily', plainKey: true },
  ] })

test('first-time discovery includes native key providers absent from the active provider catalog', () => {
  const snapshot = openCodeV2InventorySnapshot(native, '/TEST/project', read())
  const { entries } = buildOpenCodeV2ProviderDirectoryEntries(snapshot)
  for (const id of ['opencode-go', 'openai', 'deepseek']) {
    expect(entries.find(row => row.providerId === id)).toMatchObject({
      setupKind: 'connect-api-key', state: 'not-connected', ownership: [], modelCount: null,
      actions: [{ id: 'connect', enabled: true, requiresSecret: true }],
      metadata: { supportedInlineAuth: true, configuredAuthless: false },
    })
  }
  expect(entries.some(row => ['exa', 'tavily'].includes(row.providerId))).toBe(false)
  const copilot = entries.find(row => row.providerId === 'github-copilot')!
  expect(copilot.setupKind).toBe('configure-manually')
  expect(copilot.actions).toHaveLength(1)
  expect(copilot.actions).toMatchObject([{ id: 'configure', enabled: false }])
  expect(copilot.authMethods).toEqual([])
})

test('full integration discovery does not expand the legacy compact inventory into unsupported provider controls', () => {
  const status = read()
  status.providers = [{ id: 'opencode', integrationId: 'opencode', activation: 'auto' }]
  const snapshot = openCodeV2InventorySnapshot(native, '/TEST/project', status)
  expect(snapshot.availableProviders).toContain('opencode')
  for (const id of ['opencode-go', 'openai', 'deepseek', 'exa', 'tavily']) {
    expect(snapshot.availableProviders).not.toContain(id)
    expect(snapshot.readStatus?.integrations.some(integration => integration.id === id)).toBe(true)
  }
  const { entries } = buildOpenCodeV2ProviderDirectoryEntries(snapshot)
  for (const id of ['opencode-go', 'openai', 'deepseek']) {
    expect(entries.some(entry => entry.providerId === id)).toBe(true)
  }
})

test('provider aliases use their actual integration and never infer one from a matching provider id', () => {
  const status = read()
  status.providers = [
    { id: 'alias-one', integrationId: 'deepseek', activation: 'enabled' },
    { id: 'alias-two', integrationId: 'deepseek', activation: 'enabled' },
    { id: 'openai', integrationId: null, activation: 'enabled' },
    { id: 'missing-integration', integrationId: 'missing', activation: 'enabled' },
    { id: 'exa', integrationId: 'deepseek', activation: 'enabled' },
  ]
  const { entries } = buildOpenCodeV2ProviderDirectoryEntries(openCodeV2InventorySnapshot(native, '/TEST/project', status))
  for (const providerId of ['alias-one', 'alias-two', 'exa']) {
    expect(entries.find(row => row.providerId === providerId)).toMatchObject({ displayName: 'DeepSeek', setupKind: 'connect-api-key' })
  }
  for (const providerId of ['openai', 'missing-integration']) {
    expect(entries.find(row => row.providerId === providerId)?.metadata.supportedInlineAuth).toBe(false)
  }
})

test('catalog models grant no connected or authless status; only completed receipt inventory marks connected', () => {
  const status = read()
  status.providers = [{ id: 'deepseek', integrationId: 'deepseek', activation: 'enabled' }]
  status.models = [{ providerId: 'deepseek', catalogId: 'reasoner', upstreamModelId: 'upstream', variants: [],
    enabled: true, status: 'active', tools: true, input: ['text'], output: ['text'], context: 8192, outputTokens: 512 }]
  const snapshot = openCodeV2InventorySnapshot(native, '/TEST/project', status, null,
    [{ id: 'opencode-go', authHint: 'api', source: 'credentials', credentialScopes: ['managed'] }])
  const { entries, modelIdsByProviderId } = buildOpenCodeV2ProviderDirectoryEntries(snapshot)
  expect(entries.find(row => row.providerId === 'opencode-go')).toMatchObject({ state: 'connected', ownership: ['managed'], modelCount: null,
    actions: [{ id: 'use', enabled: true }] })
  expect(entries.find(row => row.providerId === 'deepseek')).toMatchObject({ state: 'available', ownership: [],
    metadata: { configuredAuthless: false, hasKnownModels: true } })
  expect(modelIdsByProviderId.deepseek).toEqual(['deepseek/reasoner'])
  expect(entries.flatMap(row => row.actions).some(action => ['set-default', 'disconnect', 'forget'].includes(action.id))).toBe(false)
})

for (const anonymousModelCount of [0, 1]) {
  test(`connected provider remains browseable when passive catalog contains ${anonymousModelCount} anonymous models`, () => {
    const status = read()
    status.integrations = [{ id: 'opencode', name: 'OpenCode', plainKey: true }]
    status.providers = [{ id: 'opencode', integrationId: 'opencode', activation: 'enabled', anonymous: true }]
    status.models = anonymousModelCount === 0 ? [] : [{ providerId: 'opencode', catalogId: 'free', upstreamModelId: 'free', variants: [],
      enabled: true, status: 'active', tools: true, input: ['text'], output: ['text'], context: 8192, outputTokens: 512, free: true }]
    const snapshot = openCodeV2InventorySnapshot(native, '/TEST/project', status, null,
      [{ id: 'opencode', authHint: 'api', source: 'credentials', credentialScopes: ['managed'] }])
    const row = buildOpenCodeV2ProviderDirectoryEntries(snapshot).entries.find(entry => entry.providerId === 'opencode')!
    expect(row).toMatchObject({ state: 'connected', setupKind: 'connected', modelCount: null,
      metadata: { hasKnownModels: false }, actions: [{ id: 'use', enabled: true }] })
  })
}


test('full V2 discovery excludes exact V1-only IDs from every source while preserving native and custom aliases', () => {
  const status = read(), legacy = ['kiro', 'cursor-acp', 'kimi-for-coding']
  status.integrations.push(...legacy.map(id => ({ id, name: id, plainKey: true })))
  status.providers = [...legacy.map(id => ({ id, integrationId: id, activation: 'enabled' as const })),
    { id: 'custom-alias', integrationId: 'deepseek', activation: 'enabled' },
    { id: 'custom-native', integrationId: null, activation: 'enabled' },
    { id: 'kimi-code-plan-global', integrationId: 'kimi-code-plan-global', activation: 'enabled' }]
  status.models = [...legacy, 'custom-alias', 'custom-native', 'kimi-code-plan-global'].map(providerId => ({
    providerId, catalogId: 'TEST-model', upstreamModelId: 'TEST-model', variants: [], enabled: true,
    status: 'active' as const, tools: true, input: ['text' as const], output: ['text' as const], context: 8192, outputTokens: 512 }))
  const snapshot = openCodeV2InventorySnapshot(native, '/TEST/project', status, null,
    legacy.map(id => ({ id, authHint: 'api', source: 'credentials' as const, credentialScopes: ['managed'] })))
  snapshot.availableProviders.push(...legacy)
  const { entries } = buildOpenCodeV2ProviderDirectoryEntries(snapshot)
  for (const id of legacy) expect(entries.some(entry => entry.providerId === id)).toBe(false)
  for (const id of ['custom-alias', 'custom-native', 'kimi-code-plan-global']) {
    expect(entries.find(entry => entry.providerId === id)?.actions.some(action => action.id === 'use')).toBe(true)
  }
  expect(entries.find(entry => entry.providerId === 'custom-alias')?.displayName).toBe('DeepSeek')
})
