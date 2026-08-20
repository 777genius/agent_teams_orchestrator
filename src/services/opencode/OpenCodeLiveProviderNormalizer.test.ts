import { describe, expect, test } from 'bun:test'

import {
  OpenCodeProviderCatalogContractError,
  normalizeOpenCodeLiveConfigProvidersResponse,
  normalizeOpenCodeLiveModelMetadata,
  normalizeOpenCodeLiveProviderAuth,
  normalizeOpenCodeLiveProviderResponse,
  normalizeOpenCodeScopedProviderCatalogResponse,
} from './OpenCodeLiveProviderNormalizer.js'
import { OPEN_CODE_PROVIDER_ALIAS_ENTRIES } from './OpenCodeProviderIdentity.js'

describe('OpenCode live provider normalization', () => {
  test.each(OPEN_CODE_PROVIDER_ALIAS_ENTRIES)(
    'aligns models, defaults, connections, and auth for alias %s',
    (alias, canonical) => {
      const providers = normalizeOpenCodeLiveProviderResponse({
        all: [{ id: alias, models: { model: { cost: { input: 0, output: 0 } } } }],
        connected: [alias],
        default: { [alias]: 'model' },
      })
      const configProviders = normalizeOpenCodeLiveConfigProvidersResponse({
        providers: [{ id: alias, models: { model: {} } }],
        default: { [alias]: 'model' },
      })
      const auth = normalizeOpenCodeLiveProviderAuth({ [alias]: [{ type: 'api' }] })
      const metadata = normalizeOpenCodeLiveModelMetadata(providers)

      expect(providers.all?.[0]?.id).toBe(canonical)
      expect(providers.connected).toEqual([canonical])
      expect(providers.default).toEqual({ [canonical]: 'model' })
      expect(configProviders.providers?.[0]?.id).toBe(canonical)
      expect(configProviders.default).toEqual({ [canonical]: 'model' })
      expect(auth[canonical]).toEqual([{ type: 'api' }])
      expect(metadata).toContainEqual(expect.objectContaining({
        id: `${canonical}/model`,
        free: true,
      }))
    },
  )
})

describe('normalizeOpenCodeScopedProviderCatalogResponse', () => {
  const unsafeProvider = {
    id: 'kiro',
    source: 'live',
    endpoint: 'https://user:pass@api.example.invalid/v1/models?api_key=secret#fragment',
    headers: { authorization: 'Bearer header-secret', cookie: 'session-secret' },
    env: { OPENAI_API_KEY: 'env-secret' },
    options: {
      token: 'option-secret',
      headers: { authorization: 'nested-secret' },
    },
    auth: { type: 'oauth', clientSecret: 'auth-secret' },
    error: { message: 'provider-error-secret', body: { raw: 'error-body-secret' } },
    models: {
      'anthropic/claude': {
        id: 'anthropic/claude',
        name: 'Claude Safe',
        limit: { context: 200_000, input: 150_000, output: 50_000, raw: 'limit-secret' },
        status: 'active',
        cost: { input: 3, output: 15, raw: 'cost-secret' },
        capabilities: { attachment: true, reasoning: true, tools: false, raw: 'cap-secret' },
        headers: { x: 'model-header-secret' },
        env: { KEY: 'model-env-secret' },
        options: { password: 'model-option-secret' },
        raw: { body: 'model-raw-secret' },
      },
    },
  }

  test('uses the structural Bedrock parser for final version suffixes only', () => {
    const valid = 'us.anthropic.claude-3-7-sonnet-20250219-v1:0'
    expect(normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'amazon-bedrock',
      response: { all: [{ id: 'amazon-bedrock', models: { [valid]: { id: valid } } }] },
    }).models[0].id).toBe(valid)
    const malicious = 'api.example.invalid:443/us.anthropic.claude-v1:0'
    expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'amazon-bedrock',
      response: { all: [{ id: 'amazon-bedrock', models: { [malicious]: { id: malicious } } }] },
    })).toThrow(OpenCodeProviderCatalogContractError)
  })

  test('retains only the exact canonical requested provider and whitelisted model metadata', () => {
    const catalog = normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'Amazon Q Developer / Kiro',
      response: {
        all: [
          { id: 'unrelated-provider-secret', models: { 'unrelated-model-secret': {} } },
          unsafeProvider,
          { id: 'another-unrelated-secret', error: { body: 'unrelated-error-secret' } },
        ],
        connected: ['unrelated-provider-secret', 'kiro'],
        default: { 'unrelated-provider-secret': 'unrelated-model-secret' },
        headers: { authorization: 'response-header-secret' },
        raw: { body: 'response-raw-secret' },
      },
      generation: 7,
      observedAtMs: 1_000,
      nowMs: 2_000,
      source: 'live',
    })

    expect(catalog).toMatchObject({
      schema: 'opencode-scoped-provider-catalog-v1',
      providerId: 'kiro',
      source: 'live',
      generation: 7,
      connected: true,
      freshness: { state: 'fresh', observedAtMs: 1_000, ageMs: 1_000 },
      selectionAllowed: true,
      launchAuthorization: 'forbidden',
      endpoint: {
        location: 'remote',
        protocol: 'https',
      },
      models: [{
        id: 'anthropic/claude',
        displayName: 'Claude Safe',
        limits: { context: 200_000, input: 150_000, output: 50_000 },
        status: 'active',
        billing: 'paid',
        capabilities: { attachment: true, reasoning: true, tools: false },
      }],
    })
    expect(catalog.endpoint.authorityFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(catalog.recordId).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(Object.keys(catalog.models[0]!).sort()).toEqual([
      'billing', 'capabilities', 'displayName', 'id', 'limits', 'status',
    ])

    const serialized = JSON.stringify(catalog)
    for (const forbidden of [
      'user:pass', 'api.example.invalid', '/v1/models', 'api_key', 'secret',
      'header-secret', 'cookie', 'OPENAI_API_KEY', 'options', 'auth-secret', 'cost',
      'raw', 'unrelated', 'default', 'error-body', 'headers', 'env', 'body',
    ]) expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase())
  })

  test('represents absent connected as null rather than false', () => {
    const catalog = normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro',
      response: { all: [{ id: 'kiro', models: {} }] },
    })
    expect(catalog.connected).toBeNull()
    expect(catalog.selectionAllowed).toBe(true)
    expect(catalog.launchAuthorization).toBe('forbidden')
  })

  test('drops a URL or credential-shaped display name instead of retaining it', () => {
    const catalog = normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro',
      response: { all: [{
        id: 'kiro',
        models: { safe: { name: 'https://user:secret@example.invalid/model?token=x' } },
      }] },
    })
    expect(catalog.models[0]?.displayName).toBeNull()
    expect(JSON.stringify(catalog)).not.toMatch(/example|user|secret|token/)
  })

  test.each([
    'api.example.invalid:443', 'localhost:4096', 'internal:443', 'host:80',
    'service:65535', 'host:1', '123:443', '127.0.0.1:443', 'node.local:3000',
    'api.example.invalid:000443', 'api.example.invalid.:443',
    'Model served by internal:443',
  ])(
    'drops endpoint-shaped display name %s for the matching provider', displayName => {
      const catalog = normalizeOpenCodeScopedProviderCatalogResponse({
        requestedProviderId: 'kiro',
        response: { all: [{ id: 'kiro', models: { safe: { displayName } } }] },
      })
      expect(catalog.models[0]?.displayName).toBeNull()
      expect(JSON.stringify(catalog)).not.toContain(displayName)
    },
  )

  test('retains display text with a safe non-authority colon', () => {
    const catalog = normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro',
      response: { all: [{ id: 'kiro', models: { safe: { displayName: 'Release: Stable Model' } } }] },
    })
    expect(catalog.models[0]?.displayName).toBe('Release: Stable Model')
  })

  test('allows bounded stale selection but never launch authorization', () => {
    const catalog = normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro',
      response: { all: [{ id: 'kiro', models: {} }] },
      observedAtMs: 1_000,
      nowMs: 61_000,
      freshForMs: 30_000,
      maxStaleMs: 120_000,
    })
    expect(catalog.freshness.state).toBe('bounded-stale')
    expect(catalog.selectionAllowed).toBe(true)
    expect(catalog.launchAuthorization).toBe('forbidden')
  })

  test.each([
    { all: [] },
    { all: [{ id: 'other', models: {} }] },
    { all: [{ id: 'kiro', models: {} }, { id: 'kiro', source: 'live', models: { different: {} } }] },
    { all: [{ id: 'kiro', models: { '../traversal': {} } }] },
    { all: [{ id: 'kiro', models: { safe: { id: 'different' } } }] },
    { all: [{ id: 'kiro', models: {} }], connected: 'kiro' },
  ])('fails closed for missing, mismatched, conflicting, or malformed scoped response %#', response => {
    try {
      normalizeOpenCodeScopedProviderCatalogResponse({ requestedProviderId: 'kiro', response })
      throw new Error('expected contract violation')
    } catch (error) {
      expect(error).toBeInstanceOf(OpenCodeProviderCatalogContractError)
      const contractError = error as OpenCodeProviderCatalogContractError
      expect(contractError.failure.code).toBe('contract_violation')
      expect(contractError.failure.retryable).toBe(false)
      expect(JSON.stringify(contractError)).not.toMatch(/other|different|traversal/)
    }
  })

  test('accepts identical duplicate rows but rejects freshness outside the bounded window', () => {
    const row = { id: 'kiro', models: { safe: { billing: 'free' } } }
    expect(normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro', response: { all: [row, structuredClone(row)] },
    }).models).toHaveLength(1)
    expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro',
      response: { all: [row] },
      observedAtMs: 0,
      nowMs: 300_001,
      maxStaleMs: 300_000,
    })).toThrow(OpenCodeProviderCatalogContractError)
  })

  test('fails closed for inherited, accessor, proxy, and dangerous scoped records', () => {
    const inherited = Object.create({ models: {} })
    inherited.id = 'kiro'
    const accessor = Object.create(null)
    Object.defineProperty(accessor, 'id', { enumerable: true, get: () => 'kiro' })
    const dangerous = Object.create(null)
    dangerous.id = 'kiro'
    dangerous.models = {}
    dangerous.constructor = 'secret'
    const throwing = new Proxy({}, { getPrototypeOf: () => { throw new Error('raw-secret') } })
    for (const row of [inherited, accessor, dangerous, throwing]) {
      expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
        requestedProviderId: 'kiro', response: { all: [row] },
      })).toThrow(OpenCodeProviderCatalogContractError)
    }
  })

  test('snapshots inert data and rejects stateful getters and capability proxies without reading them', () => {
    let idReads = 0
    const statefulId = Object.create(null)
    Object.defineProperty(statefulId, 'id', {
      enumerable: true,
      get: () => (++idReads === 1 ? 'kiro' : 'other'),
    })
    statefulId.models = {}
    let capabilityReads = 0
    const capabilityProxy = new Proxy({ toolcall: true }, {
      get: (target, key, receiver) => {
        capabilityReads += 1
        return capabilityReads === 1 ? Reflect.get(target, key, receiver) : 'capability-secret'
      },
    })
    for (const response of [
      { all: [statefulId] },
      { all: [{ id: 'kiro', models: { safe: { capabilities: capabilityProxy } } }] },
    ]) {
      expect(() => normalizeOpenCodeScopedProviderCatalogResponse({ requestedProviderId: 'kiro', response }))
        .toThrow(OpenCodeProviderCatalogContractError)
    }
    expect(idReads).toBe(0)
    expect(capabilityReads).toBe(0)
  })

  test('returns a fresh fixed error without inspecting attacker-thrown values or mutable messages', () => {
    const original = new OpenCodeProviderCatalogContractError()
    original.message = 'provider-secret-message'
    let traps = 0
    const thrownProxy = new Proxy({}, {
      getPrototypeOf: () => { traps += 1; throw original },
      get: () => { traps += 1; throw original },
    })
    let caught: unknown
    try {
      normalizeOpenCodeScopedProviderCatalogResponse({
        requestedProviderId: 'kiro', response: thrownProxy,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OpenCodeProviderCatalogContractError)
    expect(caught).not.toBe(original)
    expect((caught as Error).message).toBe('The provider returned an invalid response.')
    expect(JSON.stringify(caught)).not.toContain('provider-secret-message')
    expect(traps).toBe(0)
  })

  test.each([
    { status: 'other' },
    { limit: { context: Number.NaN } },
    { limits: { context: 1 }, limit: { context: 1 } },
    { cost: { input: Number.POSITIVE_INFINITY } },
    { capabilities: { toolcall: 'yes' } },
    { capabilities: { toolcall: true, tools: false } },
    { capabilities: { attachment: true }, attachment: false },
  ])('rejects present-invalid model metadata %#', model => {
    expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro', response: { all: [{ id: 'kiro', models: { safe: model } }] },
    })).toThrow(OpenCodeProviderCatalogContractError)
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 10_000_000_001, '1'])(
    'rejects invalid generation %p', generation => {
      expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
        requestedProviderId: 'kiro', response: { generation, all: [{ id: 'kiro', models: {} }] },
      })).toThrow(OpenCodeProviderCatalogContractError)
    },
  )

  test.each([null, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects explicit invalid freshness value %p instead of defaulting it', invalid => {
      for (const field of ['observedAtMs', 'nowMs', 'freshForMs', 'maxStaleMs'] as const) {
        expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
          requestedProviderId: 'kiro', response: { all: [{ id: 'kiro', models: {} }] },
          [field]: invalid,
        } as never)).toThrow(OpenCodeProviderCatalogContractError)
      }
    },
  )

  test('accepts epoch timestamps above duration bounds but keeps durations bounded', () => {
    const epoch = 1_700_000_000_000
    expect(normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro', response: { all: [{ id: 'kiro', models: {} }] },
      observedAtMs: epoch, nowMs: epoch,
    }).freshness.observedAtMs).toBe(epoch)
    for (const field of ['freshForMs', 'maxStaleMs'] as const) {
      expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
        requestedProviderId: 'kiro', response: { all: [{ id: 'kiro', models: {} }] },
        [field]: 10_000_000_001,
      })).toThrow(OpenCodeProviderCatalogContractError)
    }
  })

  test('requires input and response generations to agree when both are present', () => {
    expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro', generation: 7,
      response: { generation: 8, all: [{ id: 'kiro', models: {} }] },
    })).toThrow(OpenCodeProviderCatalogContractError)
    expect(normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro', generation: 7,
      response: { generation: 7, all: [{ id: 'kiro', models: {} }] },
    }).generation).toBe(7)
  })

  test.each([
    'user:pass@host', 'user:pass@host/model', 'user:pass@host:443/model',
    'api.example.invalid:443', 'api.example.invalid:443/model', 'localhost:4096/model',
    'internal:443/model', '123:443/model', 'org/user:pass@host/model',
    'org/api.example.invalid:443/model',
    'api.example.invalid:000443/model', 'api.example.invalid.:443/model',
    'user:pa@ss@host/model', 'api.example.invalid:999999/model',
    'org/:secret@example.invalid/model', 'org/user@host/model',
    'org/user@api.example.invalid/model', 'org/user@api.example.invalid./model',
    'org/user@127.0.0.1/model', 'org/user@[2001:db8::1]/model',
    'org/user@host:443/model',
  ])(
    'rejects endpoint or userinfo shaped model id %s for a matching provider', modelId => {
      expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
        requestedProviderId: 'kiro', response: { all: [{ id: 'kiro', models: { [modelId]: {} } }] },
      })).toThrow(OpenCodeProviderCatalogContractError)
    },
  )

  test.each(['vendor/release:stable/model-v2', 'vendor/model@revision'])(
    'retains safe colon/slash model id %s', modelId => {
      const catalog = normalizeOpenCodeScopedProviderCatalogResponse({
        requestedProviderId: 'kiro', response: { all: [{ id: 'kiro', models: { [modelId]: {} } }] },
      })
      expect(catalog.models[0]?.id).toBe(modelId)
    },
  )

  test('supports exact OpenCode capabilities.toolcall spelling', () => {
    const result = normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro',
      response: { all: [{ id: 'kiro', models: { safe: { capabilities: { toolcall: true } } } }] },
    })
    expect(result.models[0]?.capabilities.tools).toBe(true)
  })

  test('rejects oversized provider and model collections before normalization', () => {
    expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro',
      response: {
        all: Array.from({ length: 257 }, () => ({ id: 'other', models: {} })),
      },
    })).toThrow(OpenCodeProviderCatalogContractError)
    const models = Object.fromEntries(
      Array.from({ length: 2_049 }, (_value, index) => [`model-${index}`, {}]),
    )
    expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro', response: { all: [{ id: 'kiro', models }] },
    })).toThrow(OpenCodeProviderCatalogContractError)
  })

  test('rejects oversized keys and aggregate model metadata', () => {
    expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro',
      response: { all: [{ id: 'kiro', models: { safe: { ['x'.repeat(257)]: true } } }] },
    })).toThrow(OpenCodeProviderCatalogContractError)
    const metadata = Object.fromEntries(Array.from({ length: 4_096 }, (_value, index) => [
      `${String(index).padStart(4, '0')}-${'x'.repeat(250)}`,
      'value',
    ]))
    expect(() => normalizeOpenCodeScopedProviderCatalogResponse({
      requestedProviderId: 'kiro',
      response: { all: [{ id: 'kiro', models: { safe: metadata } }] },
    })).toThrow(OpenCodeProviderCatalogContractError)
  })
})
