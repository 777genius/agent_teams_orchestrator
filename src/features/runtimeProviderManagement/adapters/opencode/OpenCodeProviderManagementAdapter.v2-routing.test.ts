import { expect, mock, test } from 'bun:test'
import type { ConnectProviderInput, LoadProviderModelsInput, TestProviderModelInput } from '../../domain/types.js'

// Run this module alone: replacement is a private transport boundary, never a production capability/proof hook.
let selectedV2 = true
const connectCalls: ConnectProviderInput[] = [], modelCalls: LoadProviderModelsInput[] = [], testCalls: TestProviderModelInput[] = []
const boundaryFailure = { ok: false as const, error: { code: 'runtime-unhealthy' as const, message: 'TEST owned V2 boundary reached', recoverable: true } }
mock.module('./OpenCodeV2ProviderManagement.js', () => ({
  selectedProviderUsesOpenCodeV2: async () => selectedV2,
  connectOpenCodeV2Provider: async (input: ConnectProviderInput) => { connectCalls.push(input); return boundaryFailure },
  loadOpenCodeV2ProviderModels: async (input: LoadProviderModelsInput) => { modelCalls.push(input); return boundaryFailure },
  testOpenCodeV2ProviderModel: async (input: TestProviderModelInput) => { testCalls.push(input); return boundaryFailure },
}))
const { OpenCodeProviderManagementAdapter } = await import('./OpenCodeProviderManagementAdapter.js')
let legacyReads = 0
const adapter = new OpenCodeProviderManagementAdapter({ inventoryService: { probe: async () => { legacyReads++; throw new Error('TEST legacy inventory must not execute for V2') } } })

test('public API-key convenience method and direct connect route reach V2 after existing validation', async () => {
  selectedV2 = true; const before = connectCalls.length
  expect(await adapter.connectWithApiKey({ runtimeId: 'opencode', providerId: ' GROQ ', apiKey: ' TEST-key ', projectPath: '/TEST/project' })).toEqual(boundaryFailure)
  expect(await adapter.connectProvider({ runtimeId: 'opencode', providerId: ' GROQ ', method: 'api', apiKey: ' TEST-key ', projectPath: '/TEST/project' })).toEqual(boundaryFailure)
  expect(connectCalls.slice(before).map(input => [input.method, input.providerId, input.apiKey, input.projectPath])).toEqual([
    ['api', 'groq', 'TEST-key', '/TEST/project'], ['api', 'groq', 'TEST-key', '/TEST/project'],
  ])
  expect(legacyReads).toBe(0)
  const count = connectCalls.length
  const invalid = await adapter.connectWithApiKey({ runtimeId: 'opencode', providerId: '', apiKey: 'TEST-key' })
  const noKey = await adapter.connectWithApiKey({ runtimeId: 'opencode', providerId: 'groq', apiKey: ' ' })
  expect(invalid.ok).toBe(false); if (!invalid.ok) expect(invalid.error.code).toBe('provider-missing')
  expect(noKey.ok).toBe(false); if (!noKey.ok) expect(noKey.error.code).toBe('auth-required')
  expect(connectCalls.length).toBe(count); expect(legacyReads).toBe(0)
})

test('public V2 OAuth routes to typed refusal boundary before legacy OAuth inventory', async () => {
  selectedV2 = true; const before = connectCalls.length
  expect(await adapter.connectProvider({ runtimeId: 'opencode', providerId: 'xai', method: 'oauth' })).toEqual(boundaryFailure)
  expect(connectCalls.length).toBe(before + 1); expect(connectCalls.at(-1)?.method).toBe('oauth'); expect(legacyReads).toBe(0)
})

test('actual public models and model-test routes preserve normalized identity before V2 transport', async () => {
  selectedV2 = true
  expect(await adapter.loadModels({ runtimeId: 'opencode', providerId: ' GROQ ', projectPath: '/TEST/project' })).toEqual(boundaryFailure)
  expect(await adapter.testModel({ runtimeId: 'opencode', providerId: ' GROQ ', modelId: ' c41-upstream ', projectPath: '/TEST/project' })).toEqual(boundaryFailure)
  expect(modelCalls.at(-1)?.providerId).toBe('groq')
  expect(testCalls.at(-1)?.providerId).toBe('groq'); expect(testCalls.at(-1)?.modelId).toBe('groq/c41-upstream'); expect(legacyReads).toBe(0)
})

test('V1 selection still enters existing managed inventory rather than V2 key transport', async () => {
  selectedV2 = false; const before = connectCalls.length
  const result = await adapter.connectWithApiKey({ runtimeId: 'opencode', providerId: 'groq', apiKey: 'TEST-key' })
  expect(result.ok).toBe(false); expect(connectCalls.length).toBe(before); expect(legacyReads).toBe(1)
})
