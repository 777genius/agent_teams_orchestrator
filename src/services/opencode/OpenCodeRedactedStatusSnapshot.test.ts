import { describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'

import type { OpenCodePassiveObservation } from './OpenCodePassiveStatusContract.js'
import {
  decodeOpenCodeRedactedSnapshotV1,
  encodeOpenCodeRedactedSnapshotV1,
  OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES,
  OPEN_CODE_REDACTED_SNAPSHOT_MAX_JSON_DEPTH,
  OPEN_CODE_REDACTED_SNAPSHOT_MAX_MODELS,
  OPEN_CODE_REDACTED_SNAPSHOT_MAX_PROVIDERS,
  type OpenCodeRedactedSnapshotV1,
} from './OpenCodeRedactedStatusSnapshot.js'

const scope = `sha256:${'a'.repeat(64)}` as const
const observation = <T>(value: T, authority: OpenCodePassiveObservation<T>['authority']): OpenCodePassiveObservation<T> => ({
  value, authority, freshness: 'fresh', condition: 'normal', observedAt: 100, validUntil: 200, issueCode: 'none',
})
function snapshot(): OpenCodeRedactedSnapshotV1 {
  return {
    schemaVersion: 1,
    projectScope: scope,
    capturedAt: 100,
    binary: observation({ presence: 'present', version: '1.2.3' }, 'binary_metadata'),
    providers: [{
      providerId: 'deepinfra',
      fingerprint: `sha256:${'b'.repeat(64)}`,
      modelIds: ['deepinfra/llama-4'],
      configured: observation('configured', 'config_metadata'),
      lastConnected: observation({ state: 'connected', at: 90 }, 'auth_metadata'),
      catalogAvailable: observation('available', 'catalog_snapshot'),
      executionVerified: observation('verified', 'execution_snapshot'),
    }],
  }
}

describe('OpenCodeRedactedSnapshotV1 codec', () => {
  test('round trips only the strict whitelist and drops extra fields recursively', () => {
    const dirty = snapshot() as OpenCodeRedactedSnapshotV1 & Record<string, unknown>
    dirty.path = '/home/alice/project'
    dirty.endpoint = 'https://127.0.0.1:4444/private'
    ;(dirty.binary as unknown as Record<string, unknown>).headers = { Authorization: 'Bearer token' }
    ;(dirty.binary.value as unknown as Record<string, unknown>).token = 'binary-value-token'
    ;(dirty.providers[0].lastConnected.value as unknown as Record<string, unknown>).rawBody = { prompt: 'nested-secret' }
    ;(dirty.providers[0] as unknown as Record<string, unknown>).plugin = { env: { API_KEY: 'secret' }, rawBody: 'prompt response' }
    const encoded = encodeOpenCodeRedactedSnapshotV1(dirty)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) throw new Error('fixture did not encode')
    expect(Object.isFrozen(encoded.value)).toBe(true)
    expect(Object.isFrozen(encoded.value.providers[0].configured)).toBe(true)
    const text = new TextDecoder().decode(encoded.bytes)
    for (const forbidden of ['/home/alice/project', 'https://127.0.0.1:4444/private', 'Authorization', 'Bearer token', 'API_KEY', 'secret', 'rawBody', 'prompt response', 'plugin', 'headers', 'binary-value-token', 'nested-secret']) {
      expect(text).not.toContain(forbidden)
    }
    expect(Object.keys(JSON.parse(text))).toEqual(['schemaVersion', 'projectScope', 'capturedAt', 'binary', 'providers'])
  })

  test('fails closed for malformed, future-schema and oversized bytes with fixed codes', () => {
    expect(decodeOpenCodeRedactedSnapshotV1('{')).toEqual({ ok: false, issueCode: 'snapshot_invalid_json' })
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify({ schemaVersion: 2 }))).toEqual({ ok: false, issueCode: 'snapshot_invalid_schema' })
    expect(decodeOpenCodeRedactedSnapshotV1(' '.repeat(OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES + 1))).toEqual({ ok: false, issueCode: 'snapshot_oversized' })
    const malformed = snapshot() as unknown as Record<string, unknown>
    malformed.projectScope = '/raw/path'
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(malformed))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    const valid = JSON.stringify(snapshot())
    for (const nonJsonWhitespace of ['\u000b', '\u000c', '\u0085', '\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff']) {
      expect(decodeOpenCodeRedactedSnapshotV1(`${nonJsonWhitespace}${valid}`)).toEqual({ ok: false, issueCode: 'snapshot_invalid_json' })
    }
  })

  test('enforces provider/model counts, uniqueness, identifiers and timestamp ordering', () => {
    const tooManyProviders = snapshot()
    tooManyProviders.providers = Array.from({ length: OPEN_CODE_REDACTED_SNAPSHOT_MAX_PROVIDERS + 1 }, (_, index) => ({ ...snapshot().providers[0], providerId: `p${index}` }))
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(tooManyProviders))).toEqual({ ok: false, issueCode: 'snapshot_count_exceeded' })
    const tooManyModels = snapshot()
    tooManyModels.providers[0].modelIds = Array.from({ length: OPEN_CODE_REDACTED_SNAPSHOT_MAX_MODELS + 1 }, (_, index) => `model-${index}`)
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(tooManyModels))).toEqual({ ok: false, issueCode: 'snapshot_count_exceeded' })
    const invalid = snapshot()
    invalid.providers[0].configured.validUntil = 99
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(invalid))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    const diagnosticVersion = snapshot()
    diagnosticVersion.binary.value.version = 'https://secret.example/token'
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(diagnosticVersion))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    diagnosticVersion.binary.value.version = 'sk-secret-token'
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(diagnosticVersion))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    diagnosticVersion.binary.value.version = '1.0.0-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0'
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(diagnosticVersion))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    const wrongAuthority = snapshot()
    wrongAuthority.providers[0].configured.authority = 'execution_snapshot'
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(wrongAuthority))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
  })

  test('shares the 64-provider request capacity and preserves 33-provider authoritative snapshots', () => {
    const provider = snapshot().providers[0]
    const at33 = snapshot()
    at33.providers = Array.from({ length: 33 }, (_, index) => ({
      ...structuredClone(provider),
      providerId: index === 0 ? 'deepinfra' : `sha256:${index.toString(16).padStart(64, '0')}`,
    }))
    expect(encodeOpenCodeRedactedSnapshotV1(at33).ok).toBe(true)
    const maximum = snapshot()
    maximum.providers = Array.from({ length: OPEN_CODE_REDACTED_SNAPSHOT_MAX_PROVIDERS }, (_, index) => ({
      ...structuredClone(provider),
      providerId: `sha256:${(index + 1).toString(16).padStart(64, '0')}`,
      modelIds: undefined,
    }))
    expect(encodeOpenCodeRedactedSnapshotV1(maximum).ok).toBe(true)
    maximum.providers.push({ ...structuredClone(provider), providerId: `sha256:${'f'.repeat(64)}` })
    expect(encodeOpenCodeRedactedSnapshotV1(maximum)).toEqual({ ok: false, issueCode: 'snapshot_count_exceeded' })
  })

  test('omits oversized catalogs with stable truncation count and fingerprint metadata', () => {
    const candidate = snapshot()
    candidate.providers[0].modelIds = Array.from({ length: 257 }, (_, index) => `deepinfra/model-${index}`)
    const encoded = encodeOpenCodeRedactedSnapshotV1(candidate)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) throw new Error(encoded.issueCode)
    expect(encoded.value.providers[0]).toMatchObject({
      modelIdsTotal: 257,
      modelIdsTruncated: true,
    })
    expect(encoded.value.providers[0].modelIds).toBeUndefined()
    expect(encoded.value.providers[0].modelIdsFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)

    const large = snapshot()
    large.providers[0].modelIds = Array.from({ length: 5_000 }, (_, index) => `deepinfra/large-${index}`)
    const largeEncoded = encodeOpenCodeRedactedSnapshotV1(large)
    expect(largeEncoded.ok).toBe(true)
    if (!largeEncoded.ok) throw new Error(largeEncoded.issueCode)
    expect(largeEncoded.value.providers[0]).toMatchObject({ modelIdsTotal: 5_000, modelIdsTruncated: true })

    const reversed = snapshot()
    reversed.providers[0].modelIds = [...candidate.providers[0].modelIds].reverse()
    const reversedEncoded = encodeOpenCodeRedactedSnapshotV1(reversed)
    expect(reversedEncoded.ok).toBe(true)
    if (!reversedEncoded.ok) throw new Error(reversedEncoded.issueCode)
    expect(reversedEncoded.value.providers[0].modelIdsFingerprint)
      .toBe(encoded.value.providers[0].modelIdsFingerprint)
    expect(new TextDecoder().decode(reversedEncoded.bytes)).toBe(new TextDecoder().decode(encoded.bytes))
  })

  test('rejects duplicate keys, excessive depth and unknown fields before schema decoding', () => {
    expect(decodeOpenCodeRedactedSnapshotV1('{"schemaVersion":1,"schemaVersion":1}')).toEqual({ ok: false, issueCode: 'snapshot_duplicate_key' })
    const deep = `${'['.repeat(OPEN_CODE_REDACTED_SNAPSHOT_MAX_JSON_DEPTH + 1)}0${']'.repeat(OPEN_CODE_REDACTED_SNAPSHOT_MAX_JSON_DEPTH + 1)}`
    expect(decodeOpenCodeRedactedSnapshotV1(deep)).toEqual({ ok: false, issueCode: 'snapshot_depth_exceeded' })
    const extraTop = { ...snapshot(), futureField: true }
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(extraTop))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    const extraNested = snapshot() as unknown as { binary: Record<string, unknown> }
    extraNested.binary.futureField = true
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(extraNested))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    for (const toxic of ['__proto__', 'prototype', 'constructor']) {
      expect(decodeOpenCodeRedactedSnapshotV1(`{"schemaVersion":1,"${toxic}":{}}`)).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    }
  })

  test('enforces value-authority compatibility for every observation', () => {
    const probes: Array<(candidate: OpenCodeRedactedSnapshotV1) => OpenCodePassiveObservation<unknown>> = [
      candidate => candidate.binary,
      candidate => candidate.providers[0].configured,
      candidate => candidate.providers[0].lastConnected,
      candidate => candidate.providers[0].catalogAvailable,
      candidate => candidate.providers[0].executionVerified,
    ]
    for (const select of probes) {
      const candidate = snapshot()
      const selected = select(candidate)
      selected.authority = 'none'
      selected.freshness = 'unknown'
      selected.condition = 'degraded'
      selected.observedAt = null
      selected.validUntil = null
      selected.issueCode = 'unknown'
      expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(candidate))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    }
    const negatives = snapshot()
    negatives.binary.value = { presence: 'absent', version: null }
    negatives.providers[0].configured.value = 'not_configured'
    negatives.providers[0].lastConnected.value = { state: 'not_connected' }
    negatives.providers[0].catalogAvailable.value = 'unavailable'
    negatives.providers[0].executionVerified.value = 'rejected'
    for (const select of probes) {
      const candidate = structuredClone(negatives)
      const selected = select(candidate)
      selected.authority = 'none'
      selected.freshness = 'unknown'
      selected.condition = 'degraded'
      selected.observedAt = null
      selected.validUntil = null
      selected.issueCode = 'unknown'
      expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(candidate))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    }
  })

  test('rejects future observations and windows inconsistent with capturedAt', () => {
    const future = snapshot()
    future.binary.observedAt = future.capturedAt + 1
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(future))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    const falselyFresh = snapshot()
    falselyFresh.providers[0].configured.validUntil = falselyFresh.capturedAt - 1
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(falselyFresh))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    const connectedAfterObservation = snapshot()
    connectedAfterObservation.providers[0].lastConnected.value = { state: 'connected', at: 99 }
    connectedAfterObservation.providers[0].lastConnected.observedAt = 98
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(connectedAfterObservation))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
  })

  test('preflights allocation bounds before encoding, mapping or UTF-8 copies', () => {
    const tooManyProviders = snapshot()
    let providerElementReads = 0
    const providers: unknown[] = []
    Object.defineProperty(providers, '0', { get: () => { providerElementReads += 1; return snapshot().providers[0] } })
    providers.length = OPEN_CODE_REDACTED_SNAPSHOT_MAX_PROVIDERS + 1
    tooManyProviders.providers = providers as never
    expect(encodeOpenCodeRedactedSnapshotV1(tooManyProviders)).toEqual({ ok: false, issueCode: 'snapshot_count_exceeded' })
    expect(providerElementReads).toBe(0)

    const tooManyModels = snapshot()
    let modelElementReads = 0
    const models: unknown[] = []
    Object.defineProperty(models, '0', { get: () => { modelElementReads += 1; return 'model-0' } })
    models.length = 100_000
    tooManyModels.providers[0].modelIds = models as string[]
    expect(encodeOpenCodeRedactedSnapshotV1(tooManyModels)).toEqual({ ok: false, issueCode: 'snapshot_count_exceeded' })
    expect(modelElementReads).toBe(0)

    expect(decodeOpenCodeRedactedSnapshotV1('x'.repeat(100_000))).toEqual({ ok: false, issueCode: 'snapshot_oversized' })
    const hugeVersion = snapshot()
    hugeVersion.binary.value.version = '1'.repeat(100_000)
    expect(encodeOpenCodeRedactedSnapshotV1(hugeVersion)).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
  })

  test('rejects proxies, accessors, active toJSON and non-primitive timestamps in one preflight', () => {
    let arrayTraps = 0
    const proxiedModels = new Proxy(snapshot().providers[0].modelIds!, {
      getOwnPropertyDescriptor: (target, key) => {
        arrayTraps += 1
        if (key === 'length' && arrayTraps > 1) return { value: 100_000, writable: true, configurable: false }
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    const arrayCandidate = snapshot()
    arrayCandidate.providers[0].modelIds = proxiedModels
    expect(encodeOpenCodeRedactedSnapshotV1(arrayCandidate)).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    expect(arrayTraps).toBe(0)

    let providerArrayTraps = 0
    const proxiedProviders = new Proxy(snapshot().providers, {
      getPrototypeOf: target => { providerArrayTraps += 1; return Reflect.getPrototypeOf(target) },
      getOwnPropertyDescriptor: (target, key) => {
        providerArrayTraps += 1
        if (key === 'length' && providerArrayTraps > 1) return { value: 100_000, writable: true, configurable: false }
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    const providerArrayCandidate = snapshot()
    providerArrayCandidate.providers = proxiedProviders
    expect(encodeOpenCodeRedactedSnapshotV1(providerArrayCandidate)).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    expect(providerArrayTraps).toBe(0)

    let prototypeTraps = 0
    const hostile = new Proxy(snapshot(), { getPrototypeOf: () => { prototypeTraps += 1; throw new Error('hostile') } })
    expect(encodeOpenCodeRedactedSnapshotV1(hostile)).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    expect(prototypeTraps).toBe(0)

    const objectTime = snapshot() as any
    objectTime.capturedAt = { valueOf: () => 100, toJSON: () => 100 }
    expect(encodeOpenCodeRedactedSnapshotV1(objectTime)).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    const nestedObjectTime = snapshot() as any
    nestedObjectTime.providers[0].lastConnected.value.at = { toJSON: () => 90 }
    expect(encodeOpenCodeRedactedSnapshotV1(nestedObjectTime)).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })

    const active = snapshot() as any
    active.toJSON = () => ({ schemaVersion: 1 })
    expect(encodeOpenCodeRedactedSnapshotV1(active)).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
  })

  test('checks oversized input byte length before any bounded UTF-8 copy', () => {
    let boundedCopies = 0
    let byteLengthCalls = 0
    const OriginalTextEncoder = globalThis.TextEncoder
    const originalByteLength = Buffer.byteLength
    globalThis.TextEncoder = class extends OriginalTextEncoder {
      encode(input?: string) { boundedCopies += 1; return super.encode(input) }
    }
    Buffer.byteLength = ((...args: Parameters<typeof Buffer.byteLength>) => { byteLengthCalls += 1; return originalByteLength(...args) }) as typeof Buffer.byteLength
    try {
      expect(decodeOpenCodeRedactedSnapshotV1('x'.repeat(1_000_000))).toEqual({ ok: false, issueCode: 'snapshot_oversized' })
      expect(byteLengthCalls).toBe(0)
      expect(boundedCopies).toBe(0)
    } finally {
      Buffer.byteLength = originalByteLength
      globalThis.TextEncoder = OriginalTextEncoder
    }
  })

  test('rejects proxy and non-Uint8Array decode inputs without invoking caller traps', () => {
    let traps = 0
    const forgedBytes = new Proxy(new Uint8Array(), {
      get: () => { traps += 1; throw new Error('get trap') },
      getPrototypeOf: () => { traps += 1; throw new Error('prototype trap') },
    })
    expect(decodeOpenCodeRedactedSnapshotV1(forgedBytes)).toEqual({ ok: false, issueCode: 'snapshot_invalid_json' })
    expect(traps).toBe(0)

    const notBytes = Object.create(null)
    Object.defineProperty(notBytes, 'byteLength', { get: () => { traps += 1; throw new Error('byteLength trap') } })
    Object.defineProperty(notBytes, Symbol.toStringTag, { get: () => { traps += 1; throw new Error('tag trap') } })
    expect(decodeOpenCodeRedactedSnapshotV1(notBytes)).toEqual({ ok: false, issueCode: 'snapshot_invalid_json' })
    const hostilePrototype = new Proxy(Object.create(null), { getPrototypeOf: () => { traps += 1; throw new Error('prototype-chain trap') } })
    expect(decodeOpenCodeRedactedSnapshotV1(Object.create(hostilePrototype))).toEqual({ ok: false, issueCode: 'snapshot_invalid_json' })
    expect(decodeOpenCodeRedactedSnapshotV1(new DataView(new ArrayBuffer(8)))).toEqual({ ok: false, issueCode: 'snapshot_invalid_json' })
    expect(traps).toBe(0)
  })

  test('preflight descriptor work is bounded by the whitelist and required array indices', () => {
    const candidate = snapshot() as OpenCodeRedactedSnapshotV1 & Record<string, unknown>
    for (let index = 0; index < 100_000; index += 1) candidate[`ignored${index}`] = index
    const originalOwnKeys = Reflect.ownKeys
    let ownKeyCalls = 0
    Reflect.ownKeys = ((target: object) => { ownKeyCalls += 1; return originalOwnKeys(target) }) as typeof Reflect.ownKeys
    try {
      const encoded = encodeOpenCodeRedactedSnapshotV1(candidate)
      expect(encoded.ok).toBe(true)
      expect(ownKeyCalls).toBe(0)
      if (!encoded.ok || !encoded.bytes) throw new Error('fixture did not encode')
      expect(new TextDecoder().decode(encoded.bytes)).not.toContain('ignored99999')
    } finally { Reflect.ownKeys = originalOwnKeys }

    const dense = snapshot()
    dense.providers = Array.from({ length: 100_000 }, () => dense.providers[0])
    expect(encodeOpenCodeRedactedSnapshotV1(dense)).toEqual({ ok: false, issueCode: 'snapshot_count_exceeded' })

    const denseModels = snapshot()
    denseModels.providers[0].modelIds = Array.from({ length: 100_000 }, () => 'deepinfra/llama-4')
    expect(encodeOpenCodeRedactedSnapshotV1(denseModels)).toEqual({ ok: false, issueCode: 'snapshot_count_exceeded' })

    for (const reserved of ['toJSON', '__proto__', 'prototype', 'constructor']) {
      const withReservedArray = snapshot()
      Object.defineProperty(withReservedArray.providers, reserved, { value: null, configurable: true })
      expect(encodeOpenCodeRedactedSnapshotV1(withReservedArray)).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
    }
  })

  test('blocks lowercase high-entropy boundary payloads in model, version, encode and decode paths', () => {
    for (const payload of ['qmxncbvlasdkfjwu', 'qmxncbvlasdkfjwuepz', 'abcdefghijklmnopqrst', 'abcdefghijklmnopqrstuvwx']) {
      for (const mutate of [
        (candidate: OpenCodeRedactedSnapshotV1) => { candidate.binary.value.version = `1.2.3+${payload}` },
        (candidate: OpenCodeRedactedSnapshotV1) => { candidate.providers[0].modelIds = [`deepinfra/${payload}`] },
      ]) {
        const candidate = snapshot()
        mutate(candidate)
        const encoded = encodeOpenCodeRedactedSnapshotV1(candidate)
        expect(encoded).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
        expect('bytes' in encoded).toBe(false)
        expect(JSON.stringify(encoded)).not.toContain(payload)
        expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(candidate))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
      }
    }
  })

  test('never emits concatenated sensitive material in persisted fields', () => {
    for (const sensitive of ['BearerAb12', 'bearerab12cd34', 'tokenabcdefghijklmnop', 'token0000000000000000', 'apikeyabcdefghijkl', 'apikey000000000000', 'tokenabcdefg', 'token1234567', 'tokena1', 'a1b2c3d4e-f5g6h7i8j-k9l0m1n2o-p3q4r5s6t']) {
      const mutations: Array<(candidate: OpenCodeRedactedSnapshotV1) => void> = [
        candidate => { candidate.binary.value.version = `1.2.3+${sensitive}` },
        candidate => { candidate.providers[0].providerId = sensitive.toLowerCase() },
        candidate => { candidate.providers[0].modelIds = [sensitive.toLowerCase()] },
        candidate => { candidate.providers[0].modelIds = [`deepinfra/${sensitive.toLowerCase()}`] },
        candidate => { candidate.providers[0].modelIds = [`${sensitive.toLowerCase()}/llama-4`] },
      ]
      for (const mutate of mutations) {
        const candidate = snapshot()
        mutate(candidate)
        expect(encodeOpenCodeRedactedSnapshotV1(candidate)).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
        expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(candidate))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
      }
    }
  })

  test('serializes an inert owned graph without inherited toJSON execution', () => {
    let calls = 0
    ;(Object.prototype as Record<string, unknown>).toJSON = () => { calls += 1; throw new Error('polluted serializer') }
    try {
      const encoded = encodeOpenCodeRedactedSnapshotV1(snapshot())
      expect(encoded.ok).toBe(true)
      expect(calls).toBe(0)
    } finally { delete (Object.prototype as Record<string, unknown>).toJSON }
  })
})
