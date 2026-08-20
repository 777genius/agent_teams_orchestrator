import { describe, expect, test } from 'bun:test'

import { OpenCodeActiveStatusSnapshotPublisher } from './OpenCodeActiveStatusSnapshotPublisher.js'
import { buildOpenCodePassiveProviderDirectory } from './OpenCodePassiveProviderDirectory.js'
import { OpenCodePassiveStatusProductionReader } from './OpenCodePassiveStatusProductionReader.js'
import {
  decodeOpenCodeRedactedSnapshotV1,
  encodeOpenCodeRedactedSnapshotV1,
  type OpenCodeRedactedSnapshotV1,
} from './OpenCodeRedactedStatusSnapshot.js'
import type { OpenCodeInventorySnapshot } from './types.js'

function completeness(states: Partial<Record<keyof NonNullable<OpenCodeInventorySnapshot['completeness']>, 'complete' | 'partial' | 'skipped' | 'failed'>> = {}): NonNullable<OpenCodeInventorySnapshot['completeness']> {
  return {
    profileConfig: { state: states.profileConfig ?? 'complete', provenance: 'managed_profile' },
    managedAuth: { state: states.managedAuth ?? 'complete', provenance: 'managed_auth_store' },
    environmentAuth: { state: states.environmentAuth ?? 'complete', provenance: 'provider_environment' },
    providerInventory: { state: states.providerInventory ?? 'complete', provenance: 'provider_cli' },
    modelCatalog: { state: states.modelCatalog ?? 'complete', provenance: 'model_cli' },
  }
}

function managedProfile(...providerIds: string[]): NonNullable<OpenCodeInventorySnapshot['profile']> {
  return {
    managedConfig: {
      provider: Object.fromEntries(providerIds.map(providerId => [providerId, {}])),
    },
  } as NonNullable<OpenCodeInventorySnapshot['profile']>
}

function inventory(overrides: Partial<OpenCodeInventorySnapshot> = {}): OpenCodeInventorySnapshot {
  return {
    detected: true,
    binaryPath: '/redacted/by-publisher',
    version: '1.2.3',
    projectPath: '/project/secret-name',
    profile: managedProfile('deepinfra'),
    connectedProviders: [{ id: 'deepinfra', authHint: 'api', source: 'credentials', credentialScopes: ['managed'] }],
    availableProviders: ['deepinfra'],
    models: ['deepinfra/llama-4'],
    modelMetadata: [], agents: [], authStorePath: '/secret/auth.json', probeError: null, diagnostics: [],
    completeness: completeness(),
    ...overrides,
  }
}

function publisherHarness(clock: { now: number }) {
  let stored: string | null = null
  let writes = 0
  const publisher = new OpenCodeActiveStatusSnapshotPublisher({
    now: () => clock.now,
    canonicalizePath: async () => '/canonical/project',
    readSnapshot: async () => stored,
    writer: {
      write: async (snapshot: OpenCodeRedactedSnapshotV1) => {
        const encoded = encodeOpenCodeRedactedSnapshotV1(snapshot)
        if (!encoded.ok || !encoded.bytes) throw new Error('invalid snapshot')
        writes += 1
        stored = new TextDecoder().decode(encoded.bytes)
      },
    },
  })
  return {
    publisher,
    stored: () => stored,
    writes: () => writes,
  }
}

function productionReader(clock: { now: number }, stored: () => string | null) {
  return new OpenCodePassiveStatusProductionReader({
    now: () => clock.now,
    canonicalizePath: async () => '/canonical/project',
    readBoundedText: async () => stored(),
  })
}

describe('OpenCodeActiveStatusSnapshotPublisher production bridge', () => {
  test('publishes redacted active authority, retains it on transient updates, and passive status has zero write/probe effects', async () => {
    const clock = { now: 1_000 }
    const harness = publisherHarness(clock)

    await harness.publisher.publishInventory(inventory())
    await harness.publisher.publishProviderUpdate({
      projectPath: '/project/secret-name', providerId: 'deepinfra', executionVerified: true,
      modelIds: ['deepinfra/llama-4'],
    })
    expect(harness.writes()).toBe(2)
    expect(harness.stored()).not.toContain('/project/secret-name')
    expect(harness.stored()).not.toContain('/secret/auth.json')
    expect(harness.stored()).not.toContain('/redacted/by-publisher')

    await harness.publisher.publishInventory(inventory({
      probeError: 'transient timeout',
      completeness: completeness({ profileConfig: 'failed', managedAuth: 'failed', environmentAuth: 'failed', providerInventory: 'failed', modelCatalog: 'failed' }),
    }))
    expect(harness.writes()).toBe(2)

    clock.now = 2_000
    const reader = productionReader(clock, harness.stored)
    const status = await reader.reader.read({ projectPath: '/project/secret-name', providerIds: ['deepinfra'], timeoutMs: 50 })
    expect(harness.writes()).toBe(2)
    expect(status.providers[0]).toMatchObject({
      configured: { value: 'configured', freshness: 'fresh' },
      lastConnected: { value: { state: 'connected' }, freshness: 'fresh' },
      catalogAvailable: { value: 'available', freshness: 'fresh' },
      executionVerified: { value: 'verified', freshness: 'fresh' },
    })
    expect(status.authorization).toBe('unknown')
    expect(status.launchReadiness).toBe('not_authorized')
  })

  test('ages expired retained execution proof before a later inventory capture and keeps unrelated fresh proof readable', async () => {
    const clock = { now: 1_000 }
    const harness = publisherHarness(clock)
    await harness.publisher.publishInventory(inventory())
    await harness.publisher.publishProviderUpdate({
      projectPath: '/project/secret-name', providerId: 'deepinfra', executionVerified: true,
    })

    clock.now = 120_000
    await harness.publisher.publishProviderUpdate({
      projectPath: '/project/secret-name', providerId: 'ollama', executionVerified: true,
    })
    clock.now = 301_001
    await harness.publisher.publishInventory(inventory())

    const serialized = harness.stored()
    expect(serialized).not.toBeNull()
    const decoded = decodeOpenCodeRedactedSnapshotV1(serialized!)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.issueCode)
    expect(decoded.value.capturedAt).toBe(301_001)
    expect(decoded.value.providers.find(provider => provider.providerId === 'deepinfra')?.executionVerified)
      .toEqual({
        value: 'verified', authority: 'execution_snapshot', freshness: 'stale', condition: 'degraded',
        observedAt: 1_000, validUntil: 301_000, issueCode: 'expired',
      })
    expect(decoded.value.providers.find(provider => provider.providerId === 'ollama')?.executionVerified)
      .toMatchObject({ value: 'verified', freshness: 'fresh', observedAt: 120_000, validUntil: 420_000 })

    const status = await productionReader(clock, harness.stored).reader.read({
      projectPath: '/project/secret-name', providerIds: ['deepinfra', 'ollama'], timeoutMs: 50,
    })
    expect(status.providers[0]).toMatchObject({
      providerId: 'deepinfra',
      configured: { value: 'configured', freshness: 'fresh' },
      lastConnected: { value: { state: 'connected' }, freshness: 'fresh' },
      catalogAvailable: { value: 'available', freshness: 'fresh' },
      executionVerified: {
        value: 'verified', freshness: 'stale', condition: 'degraded', issueCode: 'expired',
        observedAt: 1_000, validUntil: 301_000,
      },
    })
    expect(status.providers[1]?.executionVerified).toMatchObject({ value: 'verified', freshness: 'fresh' })
    expect(harness.writes()).toBe(4)
  })

  test('publishes managed authless configuration independently from connection without authorizing launch', async () => {
    const clock = { now: 10_000 }
    const harness = publisherHarness(clock)
    await harness.publisher.publishInventory(inventory({
      profile: managedProfile('ollama'),
      connectedProviders: [],
      availableProviders: ['ollama'],
      models: ['ollama/qwen2.5-coder'],
    }))

    const status = await productionReader(clock, harness.stored).reader.read({
      projectPath: '/project/secret-name', providerIds: ['ollama'], timeoutMs: 50,
    })
    expect(status.providers[0]).toMatchObject({
      configured: { value: 'configured', authority: 'config_metadata' },
      lastConnected: { value: { state: 'not_connected' }, authority: 'auth_metadata' },
      catalogAvailable: { value: 'available', authority: 'catalog_snapshot' },
    })
    expect(status.authorization).toBe('unknown')
    expect(status.launchReadiness).toBe('not_authorized')
    const configured = buildOpenCodePassiveProviderDirectory(status, { filter: 'configured' })
    expect(configured.entries.map(entry => [entry.providerId, entry.state]))
      .toEqual([['ollama', 'not-connected']])
  })

  test('clears missing connections on complete inventory and retains positive evidence on transient inventory', async () => {
    const clock = { now: 1_000 }
    const harness = publisherHarness(clock)
    await harness.publisher.publishInventory(inventory())

    clock.now = 2_000
    await harness.publisher.publishInventory(inventory({
      profile: managedProfile(), connectedProviders: [], availableProviders: [], models: [],
    }))
    let decoded = decodeOpenCodeRedactedSnapshotV1(harness.stored()!)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.issueCode)
    expect(decoded.value.providers.find(provider => provider.providerId === 'deepinfra')).toMatchObject({
      configured: { value: 'not_configured', observedAt: 2_000 },
      lastConnected: { value: { state: 'not_connected' }, observedAt: 2_000 },
      catalogAvailable: { value: 'unavailable', observedAt: 2_000 },
    })

    clock.now = 3_000
    await harness.publisher.publishInventory(inventory())
    const writesBeforeTransient = harness.writes()
    clock.now = 4_000
    await harness.publisher.publishInventory(inventory({
      connectedProviders: [], availableProviders: [], models: [], probeError: 'temporary provider timeout',
      completeness: completeness({ profileConfig: 'failed', managedAuth: 'partial', environmentAuth: 'partial', providerInventory: 'partial', modelCatalog: 'partial' }),
    }))
    expect(harness.writes()).toBe(writesBeforeTransient)
    decoded = decodeOpenCodeRedactedSnapshotV1(harness.stored()!)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.issueCode)
    expect(decoded.value.providers.find(provider => provider.providerId === 'deepinfra')?.lastConnected)
      .toMatchObject({ value: { state: 'connected', at: 3_000 }, observedAt: 3_000 })
  })

  test('merges profile, provider and catalog authority independently across profile-only and failed probes', async () => {
    const clock = { now: 1_000 }
    const harness = publisherHarness(clock)
    await harness.publisher.publishInventory(inventory())

    clock.now = 2_000
    await harness.publisher.publishInventory(inventory({
      profile: managedProfile(), connectedProviders: [], availableProviders: [], models: [],
      completeness: completeness({ managedAuth: 'complete', environmentAuth: 'skipped', providerInventory: 'skipped', modelCatalog: 'skipped' }),
    }))
    let decoded = decodeOpenCodeRedactedSnapshotV1(harness.stored()!)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.issueCode)
    let deepinfra = decoded.value.providers.find(provider => provider.providerId === 'deepinfra')!
    expect(deepinfra.configured).toMatchObject({ value: 'not_configured', observedAt: 2_000 })
    expect(deepinfra.lastConnected).toMatchObject({ value: { state: 'connected', at: 1_000 }, observedAt: 1_000 })
    expect(deepinfra.catalogAvailable).toMatchObject({ value: 'available', observedAt: 1_000 })
    expect(deepinfra.modelIds).toEqual(['deepinfra/llama-4'])

    clock.now = 3_000
    await harness.publisher.publishInventory(inventory({
      profile: managedProfile('ollama'), connectedProviders: [], availableProviders: [], models: [],
      probeError: 'catalog failed',
      completeness: completeness({ providerInventory: 'partial', environmentAuth: 'partial', modelCatalog: 'failed' }),
    }))
    decoded = decodeOpenCodeRedactedSnapshotV1(harness.stored()!)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.issueCode)
    deepinfra = decoded.value.providers.find(provider => provider.providerId === 'deepinfra')!
    expect(deepinfra.configured).toMatchObject({ value: 'not_configured', observedAt: 3_000 })
    expect(deepinfra.lastConnected).toMatchObject({ value: { state: 'connected' }, observedAt: 1_000 })
    expect(deepinfra.catalogAvailable).toMatchObject({ value: 'available', observedAt: 1_000 })
    expect(decoded.value.providers.find(provider => provider.providerId === 'ollama')?.configured)
      .toMatchObject({ value: 'configured', observedAt: 3_000 })
  })

  test('complete authoritative disconnect forgets stale catalog IDs while partial refresh retains them', async () => {
    const clock = { now: 1_000 }
    const harness = publisherHarness(clock)
    await harness.publisher.publishInventory(inventory())
    clock.now = 2_000
    await harness.publisher.publishInventory(inventory({
      connectedProviders: [], availableProviders: [], models: [],
      completeness: completeness({ providerInventory: 'partial', modelCatalog: 'partial' }),
    }))
    let decoded = decodeOpenCodeRedactedSnapshotV1(harness.stored()!)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.issueCode)
    expect(decoded.value.providers[0]).toMatchObject({
      lastConnected: { value: { state: 'connected' }, observedAt: 1_000 },
      catalogAvailable: { value: 'available', observedAt: 1_000 },
      modelIds: ['deepinfra/llama-4'],
    })
    clock.now = 3_000
    await harness.publisher.publishInventory(inventory({
      profile: managedProfile(), connectedProviders: [], availableProviders: [], models: [],
    }))
    decoded = decodeOpenCodeRedactedSnapshotV1(harness.stored()!)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.issueCode)
    expect(decoded.value.providers[0]).toMatchObject({
      configured: { value: 'not_configured', observedAt: 3_000 },
      lastConnected: { value: { state: 'not_connected' }, observedAt: 3_000 },
      catalogAvailable: { value: 'unavailable', observedAt: 3_000 },
    })
    expect(decoded.value.providers[0].modelIds).toBeUndefined()
  })

  test('cross-instance scope lease keeps independent DeepInfra and Ollama observations', async () => {
    let stored: string | null = null
    let tail = Promise.resolve()
    const withScopeLease = async <T>(_scope: `sha256:${string}`, _signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
      const previous = tail
      let release!: () => void
      tail = new Promise<void>(resolve => { release = resolve })
      await previous
      try { return await operation() } finally { release() }
    }
    const make = () => new OpenCodeActiveStatusSnapshotPublisher({
      now: () => 1_000,
      canonicalizePath: async () => '/canonical/project',
      readSnapshot: async () => { await Promise.resolve(); return stored },
      withScopeLease,
      writer: { write: async snapshot => {
        await Promise.resolve()
        const encoded = encodeOpenCodeRedactedSnapshotV1(snapshot)
        if (!encoded.ok || !encoded.bytes) throw new Error('invalid')
        stored = new TextDecoder().decode(encoded.bytes)
      } },
    })
    await Promise.all([
      make().publishProviderUpdate({ projectPath: '/p', providerId: 'deepinfra', connected: true }),
      make().publishProviderUpdate({ projectPath: '/p', providerId: 'ollama', configured: true }),
    ])
    const decoded = decodeOpenCodeRedactedSnapshotV1(stored!)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.issueCode)
    expect(decoded.value.providers.map(provider => provider.providerId)).toEqual(['deepinfra', 'ollama'])
  })
})
