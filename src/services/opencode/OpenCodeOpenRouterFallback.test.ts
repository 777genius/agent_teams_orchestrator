import { expect, test } from 'bun:test'
import { isOpenCodeModelFree, isOpenCodeBuiltinFreeModelId } from './OpenCodeInventoryService.js'
import { applyOpenCodeOpenRouterFallback, OPEN_CODE_OPENROUTER_FREE_ROUTE } from './OpenCodeOpenRouterFallback.js'

test('materializes the nested route without replacing user provider config', () => {
  const config = { provider: { openrouter: { options: { apiKey: 'user-key', baseURL: 'https://example.com' }, models: { custom: { name: 'Custom' } } } } }
  const original = structuredClone(config)
  applyOpenCodeOpenRouterFallback(config, 'openrouter')
  expect(config.provider.openrouter).toMatchObject(original.provider.openrouter)
  expect(Object.keys(config.provider.openrouter.models)).toEqual(['custom', OPEN_CODE_OPENROUTER_FREE_ROUTE.modelId])
  const once = structuredClone(config)
  applyOpenCodeOpenRouterFallback(config, 'openrouter')
  expect(config).toEqual(once)
})

test('preserves a user-defined router model and isolates unrelated profiles', () => {
  const config = { provider: { openrouter: { models: { 'openrouter/free': { name: 'User router', limit: { context: 123 } } } } } }
  const original = structuredClone(config)
  applyOpenCodeOpenRouterFallback(config, 'openrouter')
  expect(config).toEqual(original)
  const unrelated = { provider: { openai: { models: { custom: {} } } } }
  const before = structuredClone(unrelated)
  applyOpenCodeOpenRouterFallback(unrelated, 'openai')
  expect(unrelated).toEqual(before)
})

test('the router is free but never a built-in authless model', () => {
  expect(isOpenCodeModelFree(OPEN_CODE_OPENROUTER_FREE_ROUTE.id, [])).toBe(true)
  expect(isOpenCodeBuiltinFreeModelId(OPEN_CODE_OPENROUTER_FREE_ROUTE.id, [])).toBe(false)
  expect(isOpenCodeModelFree('other/openrouter/free', [])).toBe(false)
})
