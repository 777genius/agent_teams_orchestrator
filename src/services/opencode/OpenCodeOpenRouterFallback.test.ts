import { expect, test } from 'bun:test'
import { isOpenCodeModelFree, isOpenCodeBuiltinFreeModelId } from './OpenCodeInventoryService.js'
import { applyOpenCodeOpenRouterFallback, OPEN_CODE_OPENROUTER_FREE_ROUTE, resolveOpenCodeOpenRouterRestrictions, hasOpenCodeOpenRouterSelectedCredential, isOpenCodeOpenRouterFreeRouteAllowed } from './OpenCodeOpenRouterFallback.js'

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

for (const syntax of ['{env:ROUTE}', '${ROUTE}']) {
  test(`native restriction expansion ${syntax}`, () => {
    const env = Object.freeze({ ROUTE: 'openrouter/free' })
    const allow = resolveOpenCodeOpenRouterRestrictions({ whitelist: [syntax] }, env)
    const deny = resolveOpenCodeOpenRouterRestrictions({ blacklist: [syntax] }, env)
    expect(isOpenCodeOpenRouterFreeRouteAllowed(allow)).toBe(syntax.startsWith('{env:'))
    expect(isOpenCodeOpenRouterFreeRouteAllowed(deny)).toBe(!syntax.startsWith('{env:'))
    expect(resolveOpenCodeOpenRouterRestrictions({ whitelist: ['{env:MISSING}'] }, env))
      .toEqual({ whitelist: [''] })
  })
}
test('restriction environment failures do not expose values', () => {
  const env = Object.defineProperty({}, 'ROUTE', { get() { throw new Error('sensitive-detail') } })
  expect(() => resolveOpenCodeOpenRouterRestrictions({ blacklist: ['{env:ROUTE}'] }, env))
    .toThrow('OpenRouter configuration environment could not be resolved')
  expect(() => resolveOpenCodeOpenRouterRestrictions({ blacklist: ['{env:ROUTE}'] }, { ROUTE: '"' }))
    .toThrow('OpenRouter configuration environment could not be resolved')
})
test('selected OpenRouter credential follows native precedence', () => {
  const auth = { type: 'api', key: 'saved' }
  for (const apiKey of [null, '', '  ', false, 1, [], ['key'], {}, { key: 'key' }, '{env:MISSING}']) {
    for (const saved of [null, auth]) {
      expect(hasOpenCodeOpenRouterSelectedCredential({ options: { apiKey } },
        { OPENROUTER_API_KEY: 'lower-priority' }, saved, saved !== null)).toBe(false)
    }
  }
  for (const options of [null, [], false, 'key']) {
    expect(hasOpenCodeOpenRouterSelectedCredential({ options }, { OPENROUTER_API_KEY: 'env' }, auth, true)).toBe(false)
  }
  expect(hasOpenCodeOpenRouterSelectedCredential({ options: { apiKey: 'option' } }, {}, auth, false)).toBe(true)
  expect(hasOpenCodeOpenRouterSelectedCredential({}, { OPENROUTER_API_KEY: 'env' }, auth, false)).toBe(false)
  expect(hasOpenCodeOpenRouterSelectedCredential({}, { OPENROUTER_API_KEY: ' ' }, auth, true)).toBe(true)
  expect(hasOpenCodeOpenRouterSelectedCredential({}, { OPENROUTER_API_KEY: 'env' }, null, false)).toBe(true)
  expect(hasOpenCodeOpenRouterSelectedCredential({}, { OPENROUTER_API_KEY: ' ' }, null, false)).toBe(false)
  expect(hasOpenCodeOpenRouterSelectedCredential({ options: { apiKey: '{env:KEY}' } }, { KEY: 'expanded' }, null, false)).toBe(true)
})

test('credential expansion keeps shell references literal and accepts native missing-reference suffixes', () => {
  for (const apiKey of ['${MISSING}', 'prefix{env:MISSING}']) {
    expect(hasOpenCodeOpenRouterSelectedCredential({ options: { apiKey } }, {}, null, false)).toBe(true)
  }
  const env = Object.defineProperty({}, 'KEY', { get() { throw new Error('private-detail') } })
  expect(hasOpenCodeOpenRouterSelectedCredential({ options: { apiKey: '{env:KEY}' } }, env, { type: 'api' }, true)).toBe(false)
})

test('fallback evaluates snapshot restrictions once and retains native config for launch', () => {
  const env = Object.freeze({ ROUTE: 'openrouter/free', NESTED: '{env:ROUTE}' })
  for (const key of ['whitelist', 'blacklist']) {
    const config = { provider: { openrouter: { [key]: ['{env:ROUTE}'] } } }
    applyOpenCodeOpenRouterFallback(config, 'openrouter', true, env)
    expect(config.provider.openrouter[key]).toEqual(['{env:ROUTE}'])
    expect(Boolean(config.provider.openrouter.models)).toBe(key === 'whitelist')
  }
  const nested = { provider: { openrouter: { whitelist: ['{env:NESTED}'] } } }
  applyOpenCodeOpenRouterFallback(nested, 'openrouter', true, env)
  expect(nested.provider.openrouter).toEqual({ whitelist: ['{env:NESTED}'] })
})

test('resolved eligibility identity follows captured environment and credential precedence', async () => {
  const { openCodeOpenRouterEligibilityIdentity, hasOpenCodeOpenRouterCatalogCredential } = await import('./OpenCodeOpenRouterFallback.js')
  const provider = { whitelist: ['{env:ROUTE}'], options: { apiKey: '{env:KEY}' } }
  const env = { ROUTE: 'openrouter/free', KEY: 'valid' }
  const identity = openCodeOpenRouterEligibilityIdentity(provider, env, null)
  expect(openCodeOpenRouterEligibilityIdentity(provider, { ...env, ROUTE: 'other' }, null)).not.toBe(identity)
  expect(openCodeOpenRouterEligibilityIdentity(provider, { ...env, KEY: '' }, null)).not.toBe(identity)
  expect(hasOpenCodeOpenRouterCatalogCredential(provider, env, { type: 'api', key: '' })).toBe(true)
  expect(hasOpenCodeOpenRouterCatalogCredential({}, { OPENROUTER_API_KEY: 'env' }, { type: 'api', key: '' })).toBe(false)
  expect(hasOpenCodeOpenRouterCatalogCredential({}, {}, null)).toBe(false)
})

test('file references bound regular bytes and reject oversized and special files without reading them', async () => {
  const { mkdtempSync, writeFileSync, rmSync, symlinkSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const { resolveOpenCodeOpenRouterEnvironment } = await import('./OpenCodeOpenRouterFallback.js')
  const root = mkdtempSync(join(tmpdir(), 'issue446-reference-'))
  const resolve = (name: string) => resolveOpenCodeOpenRouterEnvironment(`{file:${join(root, name)}}`, {})
  try {
    writeFileSync(join(root, 'regular'), '  synthetic-secret\n')
    expect(resolve('regular')).toBe('synthetic-secret')
    writeFileSync(join(root, 'limit'), 'x'.repeat(1024 * 1024))
    expect((resolve('limit') as string).length).toBe(1024 * 1024)
    writeFileSync(join(root, 'oversized'), 'x'.repeat(1024 * 1024 + 1))
    execFileSync('mkfifo', [join(root, 'fifo')])
    symlinkSync('/dev/zero', join(root, 'device'))
    for (const name of ['oversized', 'fifo', 'device', '.']) {
      expect(() => resolve(name)).toThrow('OpenRouter configuration environment could not be resolved')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
