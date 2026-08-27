import { describe, expect, test } from 'bun:test'

import {
  createOpenCodeCatalogRecordId,
  normalizeOpenCodeProviderCatalogSource,
  observeOpenCodeEndpoint,
} from './OpenCodeProviderCatalogContract.js'
import { createOpenCodeCanonicalModelId, createOpenCodeCanonicalProviderId } from './OpenCodeProviderIdentity.js'

describe('OpenCode provider catalog pure contract', () => {
  test('classifies and fingerprints only an HTTP(S) authority', () => {
    const loopback = observeOpenCodeEndpoint('http://user:secret@127.0.0.1:4096/private?token=x#raw')
    const sameAuthority = observeOpenCodeEndpoint('http://127.0.0.1:4096/a-completely-different-path')
    const remote = observeOpenCodeEndpoint('https://api.example.invalid/v1/models?key=secret')

    expect(loopback).toEqual({
      location: 'loopback',
      protocol: 'http',
      authorityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(sameAuthority.authorityFingerprint).toBe(loopback.authorityFingerprint)
    expect(remote).toEqual({
      location: 'remote',
      protocol: 'https',
      authorityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(JSON.stringify([loopback, remote])).not.toMatch(/user|secret|127\.0\.0\.1|4096|example|path|token|key/)
  })

  test.each([null, '', 'not a url', 'file:///tmp/secret', 'ftp://example.invalid/a'])(
    'maps unsafe or absent endpoint %p to none',
    endpoint => {
      expect(observeOpenCodeEndpoint(endpoint)).toEqual({
        location: 'none', protocol: null, authorityFingerprint: null,
      })
    },
  )

  test('maps unrecognized source values to unknown', () => {
    expect(normalizeOpenCodeProviderCatalogSource('live')).toBe('live')
    expect(normalizeOpenCodeProviderCatalogSource('bounded-cache')).toBe('bounded-cache')
    expect(normalizeOpenCodeProviderCatalogSource('provider-error-body')).toBe('unknown')
    expect(normalizeOpenCodeProviderCatalogSource({ secret: true })).toBe('unknown')
  })

  test('record identity is invariant to object key and model input order', () => {
    const model = (id: string) => ({
      id: createOpenCodeCanonicalModelId(id), displayName: null,
      limits: { context: null, input: null, output: null }, status: 'active' as const,
      billing: 'unknown' as const,
      capabilities: { attachment: null, reasoning: null, tools: null },
    })
    const base = {
      providerId: createOpenCodeCanonicalProviderId('xai'), source: 'live' as const,
      endpoint: { location: 'none' as const, protocol: null, authorityFingerprint: null },
      generation: 1,
      freshness: { state: 'fresh' as const, observedAtMs: 0, ageMs: 0, maxStaleMs: 10 },
      connected: null, models: [model('z/Model'), model('A:Model')],
    }
    const reordered = { models: [...base.models].reverse(), connected: null,
      freshness: base.freshness, generation: 1, endpoint: base.endpoint,
      source: 'live' as const, providerId: base.providerId }
    expect(createOpenCodeCatalogRecordId(base)).toBe(createOpenCodeCatalogRecordId(reordered))
    expect(() => createOpenCodeCatalogRecordId({ ...base, models: [base.models[0]!, base.models[0]!] }))
      .toThrow('Duplicate OpenCode catalog model identity')
  })

  test('record identity snapshots and validates the complete inert payload before hashing', () => {
    const model = {
      id: createOpenCodeCanonicalModelId('safe/model'), displayName: 'Safe Model',
      limits: { context: 1, input: null, output: 2 }, status: 'active' as const,
      billing: 'paid' as const,
      capabilities: { attachment: false, reasoning: true, tools: true },
    }
    const base = {
      providerId: createOpenCodeCanonicalProviderId('xai'), source: 'live' as const,
      endpoint: { location: 'none' as const, protocol: null, authorityFingerprint: null },
      generation: 1,
      freshness: { state: 'fresh' as const, observedAtMs: 2, ageMs: 3, maxStaleMs: 10 },
      connected: true, models: [model],
    }
    const invalid: unknown[] = []
    let getterReads = 0
    const accessorModel = { ...model } as Record<string, unknown>
    Object.defineProperty(accessorModel, 'id', {
      enumerable: true,
      get: () => { getterReads += 1; return 'safe/model' },
    })
    invalid.push({ ...base, models: [accessorModel] })
    invalid.push(Object.assign(Object.create({ source: 'live' }), base))
    invalid.push({ ...base, models: Object.assign(Object.create([]), [model]) })
    invalid.push({ ...base, models: [{ ...model, capabilities: Object.create({ tools: true }) }] })
    invalid.push({ ...base, models: [{ ...model, limits: { ...model.limits, context: -1 } }] })
    invalid.push({ ...base, endpoint: { ...base.endpoint, protocol: 'https' } })
    invalid.push({ ...base, freshness: { ...base.freshness, ageMs: 11 } })
    const symbolic = { ...base, [Symbol('secret')]: true }
    invalid.push(symbolic)
    const dangerous = { ...base } as Record<string, unknown>
    Object.defineProperty(dangerous, 'constructor', { enumerable: true, value: 'secret' })
    invalid.push(dangerous)
    let proxyReads = 0
    invalid.push(new Proxy(base, {
      get: () => { proxyReads += 1; throw new Error('attacker-secret') },
      getPrototypeOf: () => { proxyReads += 1; throw new Error('attacker-secret') },
    }))
    invalid.push({ ...base, models: new Proxy([model], {
      get: () => { proxyReads += 1; throw new Error('array-secret') },
    }) })
    const oversizedSparseModels = new Array(2_049)
    invalid.push({ ...base, models: oversizedSparseModels })
    invalid.push({ ...base, models: [{ ...model, capabilities: new Proxy(model.capabilities, {
      get: () => { proxyReads += 1; throw new Error('capability-secret') },
    }) }] })
    for (const candidate of invalid) {
      let caught: unknown
      try { createOpenCodeCatalogRecordId(candidate as never) } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(TypeError)
      expect((caught as Error).message).toBe('Invalid OpenCode catalog record identity payload')
      expect(String(caught)).not.toContain('attacker-secret')
    }
    expect(getterReads).toBe(0)
    expect(proxyReads).toBe(0)
  })

  test('record identity rejects authority-shaped model and display fields without echoing them', () => {
    const model = (id: string, displayName: string | null = null) => ({
      id, displayName,
      limits: { context: null, input: null, output: null }, status: 'active' as const,
      billing: 'unknown' as const,
      capabilities: { attachment: null, reasoning: null, tools: null },
    })
    const base = {
      providerId: createOpenCodeCanonicalProviderId('xai'), source: 'live' as const,
      endpoint: { location: 'none' as const, protocol: null, authorityFingerprint: null },
      generation: 1,
      freshness: { state: 'fresh' as const, observedAtMs: 0, ageMs: 0, maxStaleMs: 10 },
      connected: null,
    }
    for (const rejected of [
      'api.example.invalid:000443', 'api.example.invalid.:443',
      'user:pa@ss@host', 'api.example.invalid:999999',
      ':secret@example.invalid', 'user@host', 'user@api.example.invalid',
      'user@api.example.invalid.', 'user@127.0.0.1', 'user@[2001:db8::1]',
      'user@host:443',
    ]) {
      for (const models of [[model(`${rejected}/trailing`)], [model('safe', rejected)]]) {
        let error: unknown
        try { createOpenCodeCatalogRecordId({ ...base, models } as never) } catch (caught) { error = caught }
        expect(error).toBeInstanceOf(TypeError)
        expect((error as Error).message).toBe('Invalid OpenCode catalog record identity payload')
        expect(String(error)).not.toContain(rejected)
      }
    }
    expect(() => createOpenCodeCatalogRecordId({
      ...base, models: [model('vendor/release:stable/model-v2', 'Release: Stable Model')],
    } as never)).not.toThrow()
  })
})
