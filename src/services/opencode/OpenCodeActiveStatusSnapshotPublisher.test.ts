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
    projectPath: '/project/secret-name',
    profileRootKey: 'test-profile',
    profileRootPath: '/redacted/profile',
    projectBehaviorFingerprint: 'test-project-behavior',
    behaviorSources: [],
    managedConfig: {
      provider: Object.fromEntries(providerIds.map(providerId => [providerId, {}])),
    },
    managedConfigFingerprint: 'test-managed-config',
    homePath: '/redacted/home',
    tmpPath: '/redacted/tmp',
    xdgConfigHome: '/redacted/config',
    xdgDataHome: '/redacted/data',
    xdgCacheHome: '/redacted/cache',
    managedAuthPath: '/redacted/auth.json',
    sourceAuthPath: null,
    sourceAuthFingerprint: null,
    managedAuthFingerprint: null,
    authState: 'ok',
    env: {},
  }
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
  const scopedPublisher = new OpenCodeActiveStatusSnapshotPublisher({
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
  let generation = 0
  const knownProviders = new Set<string>()
  const catalogEvidence = (providerId: string) => ({
    providerId, requestGeneration: ++generation, startedAt: clock.now,
    attemptIdentity: `sha256:${generation.toString(16).padStart(64, '0')}` as const,
    binaryFingerprint: `sha256:${'b'.repeat(64)}` as const,
    configFingerprint: `sha256:${'c'.repeat(64)}` as const,
    authFingerprint: `sha256:${'d'.repeat(64)}` as const,
  })
  // Compatibility facade for the pre-existing bridge tests: inventory and
  // catalog are still invoked as two purpose-specific publications.
  const publisher = {
    publishInventory: async (value: OpenCodeInventorySnapshot, signal?: AbortSignal) => {
      await scopedPublisher.publishInventory(value, signal)
      const complete = (value.completeness?.modelCatalog.state ?? (value.probeError ? 'failed' : 'complete')) === 'complete'
      if (!complete) return
      for (const providerId of value.availableProviders) knownProviders.add(providerId)
      const byProvider = new Map<string, string[]>()
      for (const model of value.models) {
        const providerId = model.slice(0, model.indexOf('/'))
        if (!providerId) continue
        knownProviders.add(providerId)
        const models = byProvider.get(providerId) ?? []
        models.push(model)
        byProvider.set(providerId, models)
      }
      for (const providerId of knownProviders) await scopedPublisher.publishCatalogResult({
        projectPath: value.projectPath, evidence: catalogEvidence(providerId),
        catalogAvailable: byProvider.has(providerId), modelIds: byProvider.get(providerId) ?? [],
      }, signal)
    },
    publishProviderUpdate: async (value: any, signal?: AbortSignal) => {
      if (value.executionVerified !== undefined) await scopedPublisher.publishExecutionUpdate(value, signal)
      else await scopedPublisher.publishProviderUpdate(value, signal)
      if (value.catalogAvailable !== undefined || value.modelIds !== undefined) {
        await scopedPublisher.publishCatalogResult({
          projectPath: value.projectPath, evidence: catalogEvidence(value.providerId),
          catalogAvailable: value.catalogAvailable ?? true, modelIds: value.modelIds ?? [],
        }, signal)
      }
    },
  }
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

const describeSupportedPersistence = process.platform === 'win32' ? describe.skip : describe

describeSupportedPersistence('OpenCodeActiveStatusSnapshotPublisher production bridge', () => {
  test('publishes case-preserving multi-segment exact refs while omitting malformed catalog entries', async () => {
    const clock = { now: 1_000 }
    const harness = publisherHarness(clock)
    await harness.publisher.publishInventory(inventory({
      profile: managedProfile('kiro', 'xai'),
      connectedProviders: [],
      availableProviders: ['kiro', 'xai'],
      models: [
        'kiro/anthropic/claude',
        'xai/org/Team:Model-v2',
        'xai/org/Team:Model-v2',
        'xai/org/token/secret',
        'xai/https://user:password@example.invalid/model',
        'xai/org/Mödel',
      ],
    }))

    const status = await productionReader(clock, harness.stored).reader.read({
      projectPath: '/project/secret-name', providerIds: ['kiro', 'xai'], timeoutMs: 50,
    })
    expect(status.providers.map(provider => [provider.providerId, provider.knownModelIds])).toEqual([
      ['kiro', ['kiro/anthropic/claude']],
      ['xai', ['xai/org/Team:Model-v2']],
    ])
    expect(harness.stored()).not.toContain('password')
    expect(harness.stored()).not.toContain('token/secret')
    expect(harness.stored()).not.toContain('Mödel')
    expect(status.authorization).toBe('unknown')
    expect(status.launchReadiness).toBe('not_authorized')
  })

  test('real encoder and production directory retain a deterministic cross-provider 256-ref projection', async () => {
    const clock = { now: 1_000 }
    const harness = publisherHarness(clock)
    const deepinfraModels = Array.from({ length: 140 }, (_, index) => `deepinfra/org/Model-${String(index).padStart(3, '0')}`)
    const kiroModels = Array.from({ length: 140 }, (_, index) => `kiro/anthropic/Claude-${String(index).padStart(3, '0')}`)
    await harness.publisher.publishInventory(inventory({
      profile: managedProfile('deepinfra', 'kiro', 'xai'),
      connectedProviders: [],
      availableProviders: ['deepinfra', 'kiro', 'xai'],
      models: [...kiroModels].reverse().concat(['xai/org/Team:Model-v2'], [...deepinfraModels].reverse()),
    }))

    clock.now = 301_000
    await harness.publisher.publishProviderUpdate({
      projectPath: '/project/secret-name', providerId: 'xai', executionVerified: true,
    })
    const status = await productionReader(clock, harness.stored).reader.read({
      projectPath: '/project/secret-name', providerIds: ['deepinfra', 'kiro', 'xai'], timeoutMs: 50,
    })
    expect(status.providers.flatMap(provider => provider.knownModelIds ?? [])).toHaveLength(256)
    expect(status.providers.find(provider => provider.providerId === 'deepinfra')?.knownModelIds).toEqual(deepinfraModels)
    expect(status.providers.find(provider => provider.providerId === 'kiro')).toMatchObject({
      knownModelIds: kiroModels.slice(0, 116), knownModelIdsTotal: 140, knownModelIdsTruncated: true,
      catalogAvailable: { freshness: 'fresh', authority: 'catalog_snapshot' },
    })
    expect(status.providers.find(provider => provider.providerId === 'xai')).toMatchObject({
      knownModelIdsTotal: 1, knownModelIdsTruncated: true,
    })

    const retained = buildOpenCodePassiveProviderDirectory(status, { query: 'Claude-115' })
    const omitted = buildOpenCodePassiveProviderDirectory(status, { query: 'Claude-116' })
    expect(retained.entries.map(entry => entry.providerId)).toEqual(['kiro'])
    expect(omitted.entries).toEqual([])
    expect(retained.entries[0]?.actions.every(action => !action.enabled)).toBe(true)
    expect(status.authorization).toBe('unknown')
    expect(status.launchReadiness).toBe('not_authorized')
  })

  test('publishes redacted active authority, retains it on transient updates, and passive status has zero write/probe effects', async () => {
    const clock = { now: 1_000 }
    const harness = publisherHarness(clock)

    await harness.publisher.publishInventory(inventory())
    await harness.publisher.publishProviderUpdate({
      projectPath: '/project/secret-name', providerId: 'deepinfra', executionVerified: true,
      catalogAvailable: true, modelIds: ['deepinfra/llama-4'],
    })
    expect(harness.writes()).toBe(4)
    expect(harness.stored()).not.toContain('/project/secret-name')
    expect(harness.stored()).not.toContain('/secret/auth.json')
    expect(harness.stored()).not.toContain('/redacted/by-publisher')

    await harness.publisher.publishInventory(inventory({
      probeError: 'transient timeout',
      completeness: completeness({ profileConfig: 'failed', managedAuth: 'failed', environmentAuth: 'failed', providerInventory: 'failed', modelCatalog: 'failed' }),
    }))
    expect(harness.writes()).toBe(4)

    clock.now = 2_000
    const reader = productionReader(clock, harness.stored)
    const status = await reader.reader.read({ projectPath: '/project/secret-name', providerIds: ['deepinfra'], timeoutMs: 50 })
    expect(harness.writes()).toBe(4)
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
    if (decoded.ok === false) throw new Error(decoded.issueCode)
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
    expect(harness.writes()).toBe(6)
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
    if (decoded.ok === false) throw new Error(decoded.issueCode)
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
    if (decoded.ok === false) throw new Error(decoded.issueCode)
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
    if (decoded.ok === false) throw new Error(decoded.issueCode)
    let deepinfra = decoded.value.providers.find(provider => provider.providerId === 'deepinfra')!
    expect(deepinfra.configured).toMatchObject({ value: 'not_configured', observedAt: 2_000 })
    expect(deepinfra.lastConnected).toMatchObject({ value: { state: 'connected', at: 1_000 }, observedAt: 1_000 })
    expect(deepinfra.catalogAvailable).toMatchObject({ value: 'available', observedAt: 1_000 })
    expect(deepinfra.modelIds).toBeUndefined()

    clock.now = 3_000
    await harness.publisher.publishInventory(inventory({
      profile: managedProfile('ollama'), connectedProviders: [], availableProviders: [], models: [],
      probeError: 'catalog failed',
      completeness: completeness({ providerInventory: 'partial', environmentAuth: 'partial', modelCatalog: 'failed' }),
    }))
    decoded = decodeOpenCodeRedactedSnapshotV1(harness.stored()!)
    expect(decoded.ok).toBe(true)
    if (decoded.ok === false) throw new Error(decoded.issueCode)
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
    if (decoded.ok === false) throw new Error(decoded.issueCode)
    expect(decoded.value.providers[0]).toMatchObject({
      lastConnected: { value: { state: 'connected' }, observedAt: 1_000 },
      catalogAvailable: { value: 'available', observedAt: 1_000 },
    })
    expect(decoded.value.providers[0].modelIds).toBeUndefined()
    clock.now = 3_000
    await harness.publisher.publishInventory(inventory({
      profile: managedProfile(), connectedProviders: [], availableProviders: [], models: [],
    }))
    decoded = decodeOpenCodeRedactedSnapshotV1(harness.stored()!)
    expect(decoded.ok).toBe(true)
    if (decoded.ok === false) throw new Error(decoded.issueCode)
    expect(decoded.value.providers[0]).toMatchObject({
      configured: { value: 'not_configured', observedAt: 3_000 },
      lastConnected: { value: { state: 'not_connected' }, observedAt: 3_000 },
      catalogAvailable: { value: 'unavailable', observedAt: 3_000 },
    })
    expect(decoded.value.providers[0].modelIds).toEqual([])
  })

  test('invalidates catalog identity on config/auth changes until a same-generation catalog is published', async () => {
    const clock = { now: 1_000 }
    const harness = publisherHarness(clock)
    await harness.publisher.publishInventory(inventory())
    let decoded = decodeOpenCodeRedactedSnapshotV1(harness.stored()!)
    expect(decoded.ok).toBe(true)
    if (decoded.ok === false) throw new Error(decoded.issueCode)
    expect(decoded.value.providers[0].catalogIdentity).toMatch(/^sha256:[0-9a-f]{64}$/)

    clock.now = 2_000
    await harness.publisher.publishProviderUpdate({
      projectPath: '/project/secret-name', providerId: 'deepinfra', connected: false,
    })
    decoded = decodeOpenCodeRedactedSnapshotV1(harness.stored()!)
    expect(decoded.ok).toBe(true)
    if (decoded.ok === false) throw new Error(decoded.issueCode)
    expect(decoded.value.providers[0].catalogIdentity).toBeUndefined()
    expect(decoded.value.providers[0].modelIds).toBeUndefined()

    const passive = await productionReader(clock, harness.stored).reader.read({
      projectPath: '/project/secret-name', providerIds: ['deepinfra'], timeoutMs: 50,
    })
    expect(passive.providers[0].catalogAvailable.value).toBe('available')
    expect(passive.providers[0].knownModelIds).toBeUndefined()

    clock.now = 3_000
    await harness.publisher.publishProviderUpdate({
      projectPath: '/project/secret-name', providerId: 'deepinfra', catalogAvailable: true,
      modelIds: ['deepinfra/llama-4'],
    })
    decoded = decodeOpenCodeRedactedSnapshotV1(harness.stored()!)
    expect(decoded.ok).toBe(true)
    if (decoded.ok === false) throw new Error(decoded.issueCode)
    expect(decoded.value.providers[0].catalogIdentity).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test('invalidates retained IDs when prepared profile evidence fingerprints change', async () => {
    for (const field of [
      'managedConfigFingerprint',
      'managedAuthFingerprint',
      'providerEnvironmentFingerprint',
      'binaryFingerprint',
    ] as const) {
      const clock = { now: 1_000 }
      const harness = publisherHarness(clock)
      await harness.publisher.publishInventory(inventory())
      const changedProfile = managedProfile('deepinfra')
      changedProfile[field] = `fake-${field}-generation-2`
      clock.now = 2_000
      await harness.publisher.publishInventory(inventory({
        profile: changedProfile,
        completeness: completeness({ modelCatalog: 'skipped' }),
      }))
      const decoded = decodeOpenCodeRedactedSnapshotV1(harness.stored()!)
      expect(decoded.ok).toBe(true)
      if (decoded.ok === false) throw new Error(decoded.issueCode)
      expect(decoded.value.providers[0].catalogAvailable.value).toBe('available')
      expect(decoded.value.providers[0].catalogIdentity).toBeUndefined()
      const passive = await productionReader(clock, harness.stored).reader.read({
        projectPath: '/project/secret-name', providerIds: ['deepinfra'], timeoutMs: 50,
      })
      expect(passive.providers[0].knownModelIds).toBeUndefined()
    }
  })

  test('an injected in-memory scope coordinator keeps independent DeepInfra and Ollama observations', async () => {
    let stored: string | null = null
    let tail = Promise.resolve()
    const withScopeUpdate = async <T>(_scope: `sha256:${string}`, _signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
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
      withScopeUpdate,
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
    if (decoded.ok === false) throw new Error(decoded.issueCode)
    expect(decoded.value.providers.map(provider => provider.providerId)).toEqual(['deepinfra', 'ollama'])
  })
})
