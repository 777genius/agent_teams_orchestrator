import { describe, expect, test } from 'bun:test'
import { isDeepStrictEqual } from 'node:util'
import { buildOpenCodeLaunchProviderContract as build } from './OpenCodeLaunchProviderContract'
import { OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS } from './OpenCodeCuratedSubscriptionCatalog'

const fixture = () => ({ provider: { custom: {
  api: 'https://fixture.invalid/api', npm: '@ai-sdk/openai-compatible', id: 'custom',
  env: ['KEY', 'ROUTE'], whitelist: ['org/model/nested'], blacklist: [],
  options: { baseURL: 'https://fixture.invalid/v1?a=1&a=2#route', apiKey: 'fixture-key', environment: { REGION: 'a' }, route: '{env:ROUTE}' },
  models: {
    'org/model/nested': { id: 'api-alias', provider: { api: 'https://fixture.invalid/model', npm: 'sdk' },
      options: { route: 'a', environment: { REGION: 'b' }, extension: { enabled: true } },
      headers: { authorization: 'fixture-key', routing: ['a', 'b'] },
      variants: { custom: { effort: 'high', unknown: [null, {}, [], ''] } },
      limit: { context: 100, input: 70, output: 30 }, family: 'family', release_date: '2026-01-01', status: 'active',
      attachment: true, reasoning: true, temperature: false, tool_call: true,
      interleaved: { field: 'reasoning_content' }, modalities: { input: ['text', 'image'], output: ['text'] },
      cost: { input: 1, output: 2, cache_read: 0, extension: { tier: 3 } },
      structured_output: true, annotation: 'ignored',
    },
    auxiliary: { family: 'small', release_date: '2025-01-01', status: 'active', cost: { input: 0, output: 0 }, options: { route: 'small' } },
  },
} } })
const different = (mutate: (value: any) => void) => {
  const expected = fixture()
  const live = structuredClone(expected)
  mutate(live.provider.custom)
  expect(isDeepStrictEqual(build(expected, 'custom'), build(live, 'custom'))).toBe(false)
}

describe('selected provider launch contract', () => {
  test('P01/P02 imported metadata may normalize away', () => {
    const expected = fixture()
    const live: any = structuredClone(expected)
    delete live.provider.custom.models['org/model/nested'].structured_output
    delete live.provider.custom.models['org/model/nested'].annotation
    live.provider.custom.unknown = { annotation: 'new' }
    expect(build(live, 'custom')).toEqual(build(expected, 'custom'))
  })
  for (const field of ['api', 'npm', 'env', 'id', 'whitelist', 'blacklist', 'options']) {
    test(`P03 provider ${field} presence`, () => different(p => { delete p[field] }))
  }
  for (const field of Object.keys(fixture().provider.custom.models['org/model/nested']).filter(key => !['structured_output', 'annotation'].includes(key))) {
    test(`P03 model ${field} presence`, () => different(p => { delete p.models['org/model/nested'][field] }))
  }
  test('P03 protected additions differ', () => different(p => { p.models.auxiliary.tool_call = true }))
  test('P04 opaque unknown keys retained', () => {
    for (const bag of ['options', 'headers', 'variants']) different(p => { p.models['org/model/nested'][bag].customNew = { nested: [null, 1] } })
  })
  test('P05 routes, SDK, alias, secrets and environment remain exact', () => {
    different(p => { p.options.baseURL = 'https://fixture.invalid/v1?a=2&a=1#route' })
    different(p => { p.options.apiKey = 'other-fixture-key' })
    different(p => { p.options.environment.REGION = 'other' })
    different(p => { p.options.route = 'expanded' })
    different(p => { p.models['org/model/nested'].headers.authorization = 'other' })
    different(p => { p.models['org/model/nested'].provider.npm = 'another-sdk' })
    different(p => { p.models['org/model/nested'].id = 'other-alias' })
    different(p => { p.models['org/model/nested'].options.environment.REGION = 'other' })
  })
  test('P06 all configured model IDs exact', () => {
    different(p => { p.models.extra = {} })
    different(p => { delete p.models.auxiliary })
  })
  test('P07 unrelated inventory and providers do not enter projection', () => {
    const live: any = fixture()
    live.providers = { custom: { models: { extra: {} } } }
    live.provider.other = null
    expect(build(live, 'custom')).toEqual(build(fixture(), 'custom'))
  })
  test('P08 auxiliary model runtime descriptors matter without small_model', () => {
    for (const key of ['family', 'release_date']) different(p => { p.models.auxiliary[key] = 'changed' })
    different(p => { p.models.auxiliary.status = 'deprecated' })
    different(p => { p.models.auxiliary.cost.input = 1 })
    different(p => { p.models.auxiliary.options.route = 'changed' })
  })
  test('P09 effective override limit retained without reconstructing input', () => {
    const config: any = fixture()
    config.provider.custom.models['org/model/nested'].limit = { context: 200, output: 50 }
    expect(build(config, 'custom')).toEqual(build(structuredClone(config), 'custom'))
    for (const key of ['context', 'input', 'output']) different(p => { p.models['org/model/nested'].limit[key]++ })
    different(p => { delete p.models['org/model/nested'].limit.input })
  })
  test('P10 builtin absence and nested model IDs', () => {
    expect(build({}, 'builtin')).toEqual(build({ provider: {} }, 'builtin'))
    expect(build(fixture(), 'custom')).not.toEqual(build(fixture(), 'org'))
    expect(build({}, 'builtin')).not.toEqual(build({ provider: { builtin: {} } }, 'builtin'))
  })
  test('P11 malformed protected shapes fail closed', () => {
    for (const value of [null, [], '', 1, true, undefined]) {
      expect(() => build(value, 'custom')).toThrow(TypeError)
      expect(() => build({ provider: value }, 'custom')).toThrow(TypeError)
      expect(() => build({ provider: { custom: value } }, 'custom')).toThrow(TypeError)
      for (const key of ['options', 'models']) expect(() => build({ provider: { custom: { [key]: value } } }, 'custom')).toThrow(TypeError)
      for (const key of ['options', 'headers', 'variants', 'limit', 'cost', 'modalities', 'provider']) {
        expect(() => build({ provider: { custom: { models: { m: { [key]: value } } } } }, 'custom')).toThrow(TypeError)
      }
    }
    for (const value of [NaN, Infinity, undefined, () => 1, 1n]) {
      expect(() => build({ provider: { custom: { options: { x: value } } } }, 'custom')).toThrow(TypeError)
    }
    for (const value of [null, {}, [], '']) different(p => { p.options.distinct = value })
    const shapes = [null, {}, [], ''].map(value => build({ provider: { custom: { options: { value } } } }, 'custom'))
    expect(new Set(shapes.map(value => JSON.stringify(value))).size).toBe(4)
  })
  test('P11 descriptor leaves validate their supported JSON types', () => {
    for (const descriptor of [{ limit: { input: '100' } }, { cost: { input: null } }, { modalities: { input: {} } }, { interleaved: { field: 1 } }, { reasoning: null }]) {
      expect(() => build({ provider: { custom: { models: { m: descriptor } } } }, 'custom')).toThrow(TypeError)
    }
  })
  test('pinned interleaved union preserves strings, booleans and required field objects', () => {
    const supported = [true, false, 'reasoning_content', 'custom', { field: 'reasoning_details' }, { field: 'custom', extension: [1] }]
    const snapshots = supported.map(interleaved => build({ provider: { custom: { models: { m: { interleaved } } } } }, 'custom'))
    expect(new Set(snapshots.map(value => JSON.stringify(value))).size).toBe(supported.length)
    for (const interleaved of [{}, { field: null }, { field: [] }, [], null, 1]) {
      expect(() => build({ provider: { custom: { models: { m: { interleaved } } } } }, 'custom')).toThrow(TypeError)
    }
  })
  test('pinned descriptor required fields and nested cost shape fail closed', () => {
    const malformed = [
      { limit: {} }, { limit: { context: 100 } }, { limit: { output: 10 } },
      { cost: {} }, { cost: { input: 0 } }, { cost: { output: 0 } },
      ...[[], null, {}, { input: 0 }, { input: 0, output: 0, cache_read: '0' }].map(context_over_200k => ({ cost: { input: 0, output: 0, context_over_200k } })),
      { status: 'unknown' }, { modalities: { input: ['unknown'] } },
    ]
    for (const model of malformed) {
      expect(() => build({ provider: { custom: { models: { m: model } } } }, 'custom')).toThrow(TypeError)
    }
    const config = { provider: { custom: { models: { m: {
      limit: { context: 100, output: 10, extension: [1, 2] },
      cost: { input: -1, output: 0, context_over_200k: { input: 1, output: 2, cache_read: 0, extension: { value: 3 } } },
    } } } } }
    const before = build(config, 'custom')
    expect(before).toEqual(build(structuredClone(config), 'custom'))
    config.provider.custom.models.m.cost.context_over_200k.extension.value = 4
    expect(before).not.toEqual(build(config, 'custom'))
  })
  test('P12 object order ignored and array order protected', () => {
    const expected = fixture()
    const live: any = structuredClone(expected)
    live.provider.custom = Object.fromEntries(Object.entries(live.provider.custom).reverse())
    live.provider.custom.models = Object.fromEntries(Object.entries(live.provider.custom.models).reverse())
    expect(isDeepStrictEqual(build(expected, 'custom'), build(live, 'custom'))).toBe(true)
    different(p => { p.env.reverse() })
    different(p => { p.models['org/model/nested'].modalities.input.reverse() })
  })
  test('snapshots detach from source and special own keys remain data', () => {
    const source = JSON.parse('{"provider":{"__proto__":{"models":{"__proto__":{"options":{"__proto__":{"secret":"fixture"}}}}}}}')
    const snapshot = build(source, '__proto__')
    expect(JSON.stringify(snapshot)).toContain('"__proto__"')
    source.provider.__proto__.models.__proto__.options.__proto__.secret = 'changed'
    expect(build(source, '__proto__')).not.toEqual(snapshot)
    expect(({} as any).secret).toBeUndefined()
  })
  test('hostile accessors, cycles and proxies yield safe generic errors', () => {
    const cyclic: any = {}; cyclic.self = cyclic
    for (const options of [cyclic, { get secret() { throw new Error('private-value') } }, new Proxy({}, { ownKeys() { throw new Error('private-value') } })]) {
      expect(() => build({ provider: { custom: { options } } }, 'custom')).toThrow('Invalid OpenCode launch provider contract')
    }
  })
  for (const definition of OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS) {
    test(`curated data fixture ${definition.id} (no launch)`, () => {
      const config = definition.config ? { provider: { [definition.id]: definition.config } } : {}
      expect(build(config, definition.id)).toEqual(build(JSON.parse(JSON.stringify(config)), definition.id))
    })
  }
  test('Atlas curated descriptor with nested route model ID', () => {
    const config = { provider: { atlascloud: {
      npm: '@ai-sdk/openai-compatible', name: 'Atlas Cloud',
      options: { baseURL: 'https://api.atlascloud.ai/v1' },
      models: { 'zai-org/glm-5.1': { name: 'GLM 5.1', reasoning: true, tool_call: true, limit: { context: 202_752, output: 202_752 } } },
    } } }
    expect(build(config, 'atlascloud')).toEqual(build(structuredClone(config), 'atlascloud'))
  })
  test('Copilot fallback descriptor permits metadata normalization', () => {
    const config = { provider: { 'github-copilot': {
      name: 'GitHub Copilot', npm: '@ai-sdk/github-copilot', api: 'https://api.githubcopilot.com',
      models: { 'gpt-5-mini': { name: 'GPT-5 Mini', family: 'gpt-mini', attachment: true,
        reasoning: true, tool_call: true, structured_output: true, temperature: false,
        limit: { context: 264_000, input: 128_000, output: 64_000 },
        modalities: { input: ['text', 'image'], output: ['text'] },
      } },
    } } }
    const live: any = structuredClone(config)
    delete live.provider['github-copilot'].models['gpt-5-mini'].structured_output
    expect(build(config, 'github-copilot')).toEqual(build(live, 'github-copilot'))
  })
  test('imported DeepInfra descriptor permits metadata normalization', () => {
    const config = { provider: { deepinfra: { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'https://api.deepinfra.com/v1/openai', apiKey: 'fixture-key' },
      models: { 'deepseek-ai/DeepSeek-V3.1': { structured_output: true, limit: { context: 163_840, output: 65_536 } } },
    } } }
    const live: any = structuredClone(config)
    delete live.provider.deepinfra.models['deepseek-ai/DeepSeek-V3.1'].structured_output
    expect(build(config, 'deepinfra')).toEqual(build(live, 'deepinfra'))
  })
})
