import { expect, test } from 'bun:test'
import { pageOpenCodeV2ProviderModels } from './OpenCodeV2ModelPagination.js'
import type { RuntimeProviderModel } from '../../domain/types.js'

const models: RuntimeProviderModel[] = Array.from({ length: 123 }, (_, index) => ({
  modelId: `openai/model-${String(index).padStart(3, '0')}`, providerId: 'openai',
  displayName: `Model ${index}`, sourceLabel: 'OpenCode V2 native catalog', free: false,
  default: false, catalogStatus: 'active', availability: 'untested', accessKind: 'credentialed',
  routeKind: 'catalog_provider', proofState: 'needs_probe', requiresExecutionProof: true,
  accessReason: 'Selected-model execution proof is required.', catalogContextTokens: 128_000,
  catalogOutputTokens: 8192, managedContextTokens: null, managedOutputTokens: null, managedUpdatedAt: null,
}))
const input = { providerId: 'openai', projectPath: '/TEST/project', limit: 50 }

test('settings can read every model in disjoint native pages even if native row order changes', () => {
  const first = pageOpenCodeV2ProviderModels(models.toReversed(), input)
  expect(first.returnedCount).toBe(50)
  expect(first.totalCount).toBe(123)
  expect(first.nextCursor).not.toBeNull()
  const second = pageOpenCodeV2ProviderModels(models, { ...input, cursor: first.nextCursor })
  const third = pageOpenCodeV2ProviderModels(models.toReversed(), { ...input, cursor: second.nextCursor })
  expect([second.returnedCount, third.returnedCount]).toEqual([50, 23])
  expect(second.cursor).toBe(first.nextCursor)
  expect(third.nextCursor).toBeNull()
  expect([...first.models, ...second.models, ...third.models].map(model => model.modelId))
    .toEqual(models.map(model => model.modelId))
})

test('unbounded launch catalog stays complete in one snapshot and searches paginate their matches', () => {
  expect(pageOpenCodeV2ProviderModels(models, { ...input, limit: null }).models).toEqual(models)
  const first = pageOpenCodeV2ProviderModels(models, { ...input, query: 'Model 1', limit: 10 })
  expect(first.totalCount).toBe(34)
  expect(first.returnedCount).toBe(10)
  expect(first.nextCursor).not.toBeNull()
  expect(first.models.every(model => model.displayName.includes('Model 1'))).toBe(true)
  expect(pageOpenCodeV2ProviderModels([], input)).toMatchObject({ totalCount: 0, returnedCount: 0, nextCursor: null })
})

test('a continuation cannot silently mix a changed catalog, provider, project or query', () => {
  const cursor = pageOpenCodeV2ProviderModels(models, input).nextCursor
  for (const changed of [models.slice(1), models.map((row, index) => index === 0 ? { ...row, availability: 'unavailable' as const } : row)]) {
    expect(() => pageOpenCodeV2ProviderModels(changed, { ...input, cursor })).toThrow('provider_catalog_page_changed')
  }
  for (const patch of [{ providerId: 'deepseek' }, { projectPath: '/TEST/another' }, { query: 'Model 1' }]) {
    expect(() => pageOpenCodeV2ProviderModels(models, { ...input, ...patch, cursor })).toThrow('provider_catalog_page_changed')
  }
})

test('malformed, exhausted and unsafe page inputs are rejected', () => {
  for (const cursor of ['50', 'v2:NaN:bad', `v2:0:${'a'.repeat(64)}`, `v2:9007199254740992:${'a'.repeat(64)}`]) {
    expect(() => pageOpenCodeV2ProviderModels(models, { ...input, cursor })).toThrow('provider_catalog_page_changed')
  }
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    expect(() => pageOpenCodeV2ProviderModels(models, { ...input, limit })).toThrow('provider_catalog_page_invalid')
  }
})
