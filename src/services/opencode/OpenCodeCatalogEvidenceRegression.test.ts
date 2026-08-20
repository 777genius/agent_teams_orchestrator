import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { OpenCodeActiveStatusSnapshotPublisher } from './OpenCodeActiveStatusSnapshotPublisher.js'
import { OpenCodeProviderCatalogService, type OpenCodeProviderCatalogServiceDeps } from './OpenCodeProviderCatalogService.js'
import { buildOpenCodePassiveProviderDirectory } from './OpenCodePassiveProviderDirectory.js'
import { OpenCodePassiveStatusProductionReader } from './OpenCodePassiveStatusProductionReader.js'
import { decodeOpenCodeRedactedSnapshotV1, encodeOpenCodeRedactedSnapshotV1, type OpenCodeRedactedSnapshotV1 } from './OpenCodeRedactedStatusSnapshot.js'
import type { OpenCodeCatalogPublicationEvidence } from './OpenCodeProviderCatalogService.js'
import type { OpenCodeInventorySnapshot } from './types.js'

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`
const binaryDigest = (value: string): `sha256:${string}` => `sha256:${createHash('sha256')
  .update(`opencode-catalog-binary-v1\0${value}`).digest('hex')}`
function evidence(providerId: string, generation: number, startedAt: number, marker = 'a'): OpenCodeCatalogPublicationEvidence {
  return {
    providerId, requestGeneration: generation, startedAt,
    attemptIdentity: digest(marker), binaryFingerprint: digest('b'),
    configFingerprint: digest('c'), authFingerprint: digest('d'),
  }
}
function inventory(version = '1.2.3'): OpenCodeInventorySnapshot {
  return {
    detected: true, binaryPath: '/not-persisted', version, projectPath: '/project/private',
    profile: { managedConfig: { provider: { deepinfra: {} } } } as OpenCodeInventorySnapshot['profile'],
    connectedProviders: [{ id: 'deepinfra', authHint: 'api', source: 'credentials', credentialScopes: ['managed'] }],
    availableProviders: ['deepinfra'], models: ['deepinfra/inventory-must-not-certify'],
    modelMetadata: [], agents: [], authStorePath: '/secret', probeError: null, diagnostics: [],
    completeness: {
      profileConfig: { state: 'complete', provenance: 'managed_profile' },
      managedAuth: { state: 'complete', provenance: 'managed_auth_store' },
      environmentAuth: { state: 'complete', provenance: 'provider_environment' },
      providerInventory: { state: 'complete', provenance: 'provider_cli' },
      modelCatalog: { state: 'complete', provenance: 'model_cli' },
    },
  }
}
function harness(clock: { now: number }, seed: { text: string | null } = { text: null }) {
  const publisher = new OpenCodeActiveStatusSnapshotPublisher({
    now: () => clock.now,
    canonicalizePath: async () => '/canonical/project', readSnapshot: async () => seed.text,
    writer: { write: async (snapshot: OpenCodeRedactedSnapshotV1) => {
      const encoded = encodeOpenCodeRedactedSnapshotV1(snapshot)
      if (!encoded.ok || !encoded.bytes) throw new Error('invalid')
      seed.text = new TextDecoder().decode(encoded.bytes)
    } },
  })
  const read = async (providerIds: string[]) => new OpenCodePassiveStatusProductionReader({
    now: () => clock.now, canonicalizePath: async () => '/canonical/project', readBoundedText: async () => seed.text,
  }).reader.read({ projectPath: '/project/private', providerIds, timeoutMs: 50 })
  return { publisher, seed, read }
}

describe('OpenCodeActiveStatusSnapshotPublisher catalog evidence', () => {
  test('config/auth invalidation advances a durable fence against late old evidence', async () => {
    const clock = { now: 1_000 }
    const seed = { text: null as string | null }
    let h = harness(clock, seed)
    const old = evidence('deepinfra', 7, 900, '7')
    await h.publisher.publishCatalogResult({ projectPath: '/project', evidence: old,
      catalogAvailable: true, modelIds: ['deepinfra/old'] })
    await h.publisher.publishProviderUpdate({ projectPath: '/project', providerId: 'deepinfra', connected: false })
    h = harness(clock, seed)
    await h.publisher.publishCatalogResult({ projectPath: '/project', evidence: old,
      catalogAvailable: true, modelIds: ['deepinfra/late-old'] })
    expect((await h.read(['deepinfra'])).providers[0].knownModelIds).toBeUndefined()
    await h.publisher.publishCatalogResult({ projectPath: '/project', evidence: evidence('deepinfra', 8, 1_000, '8'),
      catalogAvailable: true, modelIds: ['deepinfra/new'] })
    expect((await h.read(['deepinfra'])).providers[0].knownModelIds).toEqual(['deepinfra/new'])
  })
  test('mutation fence rejects exact equality after restart while preserving disconnect evidence and allowing a gap', async () => {
    const clock = { now: 1_000 }
    const seed = { text: null as string | null }
    let h = harness(clock, seed)
    const fifth = evidence('deepinfra', 5, 900, '5')
    await h.publisher.publishCatalogResult({ projectPath: '/project', evidence: fifth,
      catalogAvailable: true, modelIds: ['deepinfra/old'] })
    await h.publisher.publishProviderUpdate({
      projectPath: '/project', providerId: 'deepinfra', connected: false,
    })
    h = harness(clock, seed)
    await h.publisher.publishCatalogResult({ projectPath: '/project', evidence: fifth,
      catalogAvailable: true, modelIds: ['deepinfra/equal-late'] })
    const fenced = await h.read(['deepinfra'])
    expect(fenced.providers[0].knownModelIds).toBeUndefined()
    expect(fenced.providers[0].lastConnected.value).toEqual({ state: 'not_connected' })
    await h.publisher.publishCatalogResult({ projectPath: '/project',
      evidence: evidence('deepinfra', 7, 1_000, '7'), catalogAvailable: false, modelIds: [] })
    const afterGap = await h.read(['deepinfra'])
    expect(afterGap.providers[0].catalogAvailable.value).toBe('unavailable')
    expect(afterGap.providers[0].lastConnected.value).toEqual({ state: 'not_connected' })
  })
  test('pre-prepare durable attempt order fences a late old fingerprint across restart publishers', async () => {
    let generation = 0
    let prepareCalls = 0
    let releaseOld!: () => void
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
    const persisted = new Map<string, unknown>()
    const deps: OpenCodeProviderCatalogServiceDeps = {
      now: () => 1_000, ttlMs: 10, maxStaleMs: 1_000, timeoutMs: 1_000,
      canonicalizeProjectPath: async () => '/canonical/project',
      allocateAttempt: () => {
        generation += 1
        return { requestGeneration: generation,
          attemptIdentity: digest(generation === 1 ? '1' : '2') }
      },
      prepareProfile: async plan => {
        prepareCalls += 1
        const old = prepareCalls === 1
        if (old) await oldGate
        return { scopeSchema: 'opencode-scoped-profile-v1', purpose: 'provider-catalog',
          providerId: plan.providerId, projectPath: '/canonical/project', profileRootPath: '/profile',
          binaryFingerprint: old ? 'binary-old' : 'binary-new',
          managedConfigFingerprint: old ? 'config-old' : 'config-new', selectedAuthBaselineFingerprint: 'auth',
          policy: { inventory: 'selected-provider-only', inventoryFallback: 'forbidden', launchAuthorization: 'forbidden' } }
      },
      ensureHost: async ({ preparedProfile }) => ({ hostKey: preparedProfile.binaryFingerprint,
        baseUrl: preparedProfile.binaryFingerprint === 'binary-old' ? 'http://127.0.0.1:48001' : 'http://127.0.0.1:48002' }),
      releaseHost: async () => {},
      fetchProviderCatalog: async ({ baseUrl }) => ({ all: [{ id: 'deepinfra', name: 'DeepInfra',
        models: { [baseUrl.endsWith('48001') ? 'old' : 'new']: { name: 'model' } } }], connected: ['deepinfra'] }),
      readPersisted: async (key: string) => persisted.get(key) ?? null,
      writePersisted: async (key: string, value: unknown) => { persisted.set(key, value) },
      deletePersisted: async (key: string) => { persisted.delete(key) },
    }
    const oldPromise = new OpenCodeProviderCatalogService(deps).loadCatalog({ providerId: 'deepinfra', projectPath: '/project' })
    await Promise.resolve()
    const newer = await new OpenCodeProviderCatalogService(deps).loadCatalog({ providerId: 'deepinfra', projectPath: '/project' })
    releaseOld()
    const older = await oldPromise
    expect([older.catalogEvidence.requestGeneration, newer.catalogEvidence.requestGeneration]).toEqual([1, 2])

    const clock = { now: 1_005 }; const seed = { text: null as string | null }
    await harness(clock, seed).publisher.publishCatalogResult({ projectPath: '/project', evidence: newer.catalogEvidence,
      observedAt: newer.catalogObservedAt, expiresAt: newer.catalogExpiresAt, provenance: newer.catalogProvenance,
      catalogAvailable: true, modelIds: ['deepinfra/new'] })
    await harness(clock, seed).publisher.publishCatalogResult({ projectPath: '/project', evidence: older.catalogEvidence,
      observedAt: older.catalogObservedAt, expiresAt: older.catalogExpiresAt, provenance: older.catalogProvenance,
      catalogAvailable: true, modelIds: ['deepinfra/old'] })
    expect((await harness(clock, seed).read(['deepinfra'])).providers[0].knownModelIds).toEqual(['deepinfra/new'])
  })
  test('Bedrock :0 survives publisher, real encoder, reader and directory', async () => {
    const clock = { now: 1_000 }; const h = harness(clock)
    await h.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: evidence('amazon-bedrock', 1, 900), catalogAvailable: true,
      modelIds: ['amazon-bedrock/us.anthropic.claude-3-7-sonnet-20250219-v1:0',
        'amazon-bedrock/api.example.invalid:443/us.anthropic.claude-v1:0'] })
    const status = await h.read(['amazon-bedrock'])
    expect(status.providers[0].knownModelIds).toEqual(['amazon-bedrock/us.anthropic.claude-3-7-sonnet-20250219-v1:0'])
    expect(buildOpenCodePassiveProviderDirectory(status, { query: '20250219-v1:0' }).entries.map(item => item.providerId)).toEqual(['amazon-bedrock'])
  })

  test('publisher omits cross-provider refs and decoder rejects a forged binding', async () => {
    const clock = { now: 1_000 }; const h = harness(clock)
    await h.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: evidence('deepinfra', 1, 900), catalogAvailable: true,
      modelIds: ['xai/grok-4', 'deepinfra/llama-4'] })
    expect((await h.read(['deepinfra', 'xai'])).providers[0].knownModelIds).toEqual(['deepinfra/llama-4'])
    const raw = JSON.parse(h.seed.text!)
    raw.providers[0].modelIds = ['xai/grok-4']
    expect(decodeOpenCodeRedactedSnapshotV1(JSON.stringify(raw))).toEqual({ ok: false, issueCode: 'snapshot_invalid_field' })
  })

  test('execution probe cannot replace full catalog refs or identity', async () => {
    const clock = { now: 1_000 }; const h = harness(clock)
    const models = ['deepinfra/a', 'deepinfra/b', 'deepinfra/c']
    await h.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: evidence('deepinfra', 1, 900), catalogAvailable: true, modelIds: models })
    const before = decodeOpenCodeRedactedSnapshotV1(h.seed.text!)
    if (!before.ok) throw new Error(before.issueCode)
    await h.publisher.publishExecutionUpdate({ projectPath: '/project/private', providerId: 'deepinfra', executionVerified: true })
    const after = decodeOpenCodeRedactedSnapshotV1(h.seed.text!)
    if (!after.ok) throw new Error(after.issueCode)
    expect(after.value.providers[0].modelIds).toEqual(models)
    expect(after.value.providers[0].catalogIdentity).toBe(before.value.providers[0].catalogIdentity)
  })

  test('fresh, cache-hit and bounded-stale publication preserves producer time bounds', async () => {
    const clock = { now: 1_000 }; const h = harness(clock)
    const producer = evidence('deepinfra', 1, 900)
    await h.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: producer,
      catalogAvailable: true, modelIds: ['deepinfra/a'], observedAt: 900, expiresAt: 1_100,
      provenance: 'fresh-live' })
    clock.now = 1_050
    await h.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: producer,
      catalogAvailable: true, modelIds: ['deepinfra/a'], observedAt: 900, expiresAt: 1_100,
      provenance: 'cache-hit' })
    let decoded = decodeOpenCodeRedactedSnapshotV1(h.seed.text!)
    if (!decoded.ok) throw new Error(decoded.issueCode)
    expect(decoded.value.providers[0].catalogAvailable).toMatchObject({ observedAt: 900, validUntil: 1_100, freshness: 'fresh' })
    clock.now = 1_101
    await h.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: producer,
      catalogAvailable: true, modelIds: ['deepinfra/a'], observedAt: 900, expiresAt: 1_100,
      provenance: 'bounded-stale' })
    decoded = decodeOpenCodeRedactedSnapshotV1(h.seed.text!)
    if (!decoded.ok) throw new Error(decoded.issueCode)
    expect(decoded.value.providers[0].catalogAvailable).toMatchObject({ observedAt: 900, validUntil: 1_100, freshness: 'stale' })
    expect((await h.read(['deepinfra'])).providers[0].knownModelIds).toBeUndefined()
  })

  test('new fingerprint attempt fences an older late completion', async () => {
    const clock = { now: 2_000 }; const h = harness(clock)
    await h.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: evidence('deepinfra', 2, 1_100, 'e'), catalogAvailable: true, modelIds: ['deepinfra/new'] })
    await h.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: evidence('deepinfra', 1, 1_000, 'f'), catalogAvailable: true, modelIds: ['deepinfra/old'] })
    expect((await h.read(['deepinfra'])).providers[0].knownModelIds).toEqual(['deepinfra/new'])
  })

  test('binary rotation hides retained IDs until a matching catalog refresh and survives restart', async () => {
    const clock = { now: 1_000 }; const seed = { text: null as string | null }; let h = harness(clock, seed)
    await h.publisher.publishInventory(inventory('1.2.3'))
    await h.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: evidence('deepinfra', 1, 900), catalogAvailable: true, modelIds: ['deepinfra/a'] })
    expect((await h.read(['deepinfra'])).providers[0].knownModelIds).toEqual(['deepinfra/a'])
    clock.now = 2_000; h = harness(clock, seed)
    await h.publisher.publishInventory(inventory('2.0.0'))
    expect((await h.read(['deepinfra'])).providers[0].knownModelIds).toBeUndefined()
    await h.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: evidence('deepinfra', 2, 1_900, 'e'), catalogAvailable: true, modelIds: ['deepinfra/b'] })
    expect((await h.read(['deepinfra'])).providers[0].knownModelIds).toEqual(['deepinfra/b'])
  })

  test('same version binary fingerprint rotation invalidates IDs until exact refresh', async () => {
    const clock = { now: 1_000 }; const seed = { text: null as string | null }; let h = harness(clock, seed)
    const first = inventory('1.2.3')
    ;(first.profile as any).binaryFingerprint = 'binary-one'
    await h.publisher.publishInventory(first)
    const exact = { ...evidence('deepinfra', 1, 900), binaryFingerprint: binaryDigest('binary-one') }
    await h.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: exact,
      catalogAvailable: true, modelIds: ['deepinfra/a'] })
    const rotated = inventory('1.2.3')
    ;(rotated.profile as any).binaryFingerprint = 'binary-two'
    clock.now = 2_000; h = harness(clock, seed)
    await h.publisher.publishInventory(rotated)
    expect((await h.read(['deepinfra'])).providers[0].knownModelIds).toBeUndefined()
    await h.publisher.publishCatalogResult({ projectPath: '/project/private',
      evidence: { ...evidence('deepinfra', 2, 1_900, 'e'), binaryFingerprint: binaryDigest('binary-two') },
      catalogAvailable: true, modelIds: ['deepinfra/b'] })
    expect((await h.read(['deepinfra'])).providers[0].knownModelIds).toEqual(['deepinfra/b'])
  })

  test('global projection is stable, bounded, project-isolated and identities bind retained refs', async () => {
    const clock = { now: 1_000 }; const one = harness(clock); const two = harness(clock)
    const deepinfra = Array.from({ length: 140 }, (_, i) => `deepinfra/Model-${String(i).padStart(3, '0')}`)
    const kiro = Array.from({ length: 140 }, (_, i) => `kiro/Claude-${String(i).padStart(3, '0')}`)
    await one.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: evidence('kiro', 1, 900, 'e'), catalogAvailable: true, modelIds: [...kiro].reverse() })
    await one.publisher.publishCatalogResult({ projectPath: '/project/private', evidence: evidence('deepinfra', 1, 900), catalogAvailable: true, modelIds: [...deepinfra].reverse() })
    await two.publisher.publishCatalogResult({ projectPath: '/other', evidence: evidence('deepinfra', 1, 900), catalogAvailable: true, modelIds: ['deepinfra/other'] })
    const decoded = decodeOpenCodeRedactedSnapshotV1(one.seed.text!)
    if (!decoded.ok) throw new Error(decoded.issueCode)
    expect(decoded.value.providers.flatMap(item => item.modelIds ?? [])).toHaveLength(256)
    expect(decoded.value.providers[1].modelIds).toEqual(kiro.slice(0, 116))
    expect(decoded.value.providers.every(item => /^sha256:[0-9a-f]{64}$/.test(item.catalogIdentity!))).toBe(true)
    expect((await two.read(['deepinfra'])).providers[0].knownModelIds).toEqual(['deepinfra/other'])
  })
})
