import { expect, test } from 'bun:test'
import { isOpenCodeModelFree, isOpenCodeBuiltinFreeModelId } from './OpenCodeInventoryService.js'
import { applyOpenCodeOpenRouterFallback, OPEN_CODE_OPENROUTER_FREE_ROUTE } from './OpenCodeOpenRouterFallback.js'

test('materializes the nested route without replacing user provider config', () => {
  const config = { provider: { openrouter: { options: { apiKey: 'user-key', baseURL: 'https://example.com' }, models: { custom: { name: 'Custom' } } } } }
  const original = structuredClone(config)
  applyOpenCodeOpenRouterFallback(config, 'openrouter', true)
  expect(config.provider.openrouter).toMatchObject(original.provider.openrouter)
  expect(Object.keys(config.provider.openrouter.models)).toEqual(['custom', OPEN_CODE_OPENROUTER_FREE_ROUTE.modelId])
  const once = structuredClone(config)
  applyOpenCodeOpenRouterFallback(config, 'openrouter', true)
  expect(config).toEqual(once)
})

test('preserves a user-defined router model and isolates unrelated profiles', () => {
  const config = { provider: { openrouter: { models: { 'openrouter/free': { name: 'User router', limit: { context: 123 } } } } } }
  const original = structuredClone(config)
  applyOpenCodeOpenRouterFallback(config, 'openrouter', true)
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

for (const selected of [undefined, null, '', 'openai', 'openrouter']) {
  test(`does not inject without selected connection: ${selected}`, () => {
    const config = {}
    applyOpenCodeOpenRouterFallback(config, selected)
    expect(config).toEqual({})
    if (selected !== 'openrouter') {
      applyOpenCodeOpenRouterFallback(config, selected, true)
      expect(config).toEqual({})
    }
  })
}
for (const restrictions of [{ blacklist: ['openrouter/free'] }, { whitelist: [] }, { whitelist: ['other'] }, { whitelist: ['openrouter/openrouter/free'] }]) {
  test(`preserves exclusions ${JSON.stringify(restrictions)}`, () => {
    const config = { provider: { openrouter: restrictions } }
    const before = structuredClone(config)
    applyOpenCodeOpenRouterFallback(config, 'openrouter', true)
    expect(config).toEqual(before)
  })
}

test('connected selected scope honors a whitelist containing the nested route', () => {
  const config = { provider: { openrouter: { whitelist: ['openrouter/free'] } } }
  applyOpenCodeOpenRouterFallback(config, 'openrouter', true)
  expect(config.provider.openrouter).toMatchObject({ whitelist: ['openrouter/free'],
    models: { 'openrouter/free': { name: 'OpenRouter Free Router', cost: { input: 0, output: 0 } } } })
})

test('full catalog IDs in blacklist do not match native relative model keys', () => {
  const config = { provider: { openrouter: { blacklist: ['openrouter/openrouter/free'] } } }
  applyOpenCodeOpenRouterFallback(config, 'openrouter', true)
  expect(config.provider.openrouter).toMatchObject({ models: {
    'openrouter/free': { name: 'OpenRouter Free Router' },
  } })
})
