import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'

import { writeOpenCodeCatalogProfileManifest } from './OpenCodeCatalogProfileJanitor.js'
import { normalizeOpenCodeScopedProviderCatalogResponse } from './OpenCodeLiveProviderNormalizer.js'
import { OpenCodeProviderCatalogService, type OpenCodeProviderCatalogServiceDeps } from './OpenCodeProviderCatalogService.js'
import { openCodeHostManager } from './OpenCodeHostManager.js'
import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import { openCodeProfileManager } from './OpenCodeProfileManager.js'

import type { OpenCodeScopedPreparedProfile } from './types.js'

const roots: string[] = []
setDefaultTimeout(20_000)
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

function response(model = 'model-a') {
  return { all: [{ id: 'deepinfra', name: 'DeepInfra', models: {
    [model]: { name: model, limits: { context: 10_000, output: 1_000 },
      capabilities: { tools: true } },
  } }], connected: ['deepinfra'] }
}

async function fixture(overrides: OpenCodeProviderCatalogServiceDeps = {}) {
  const cache = await mkdtemp(path.join(os.tmpdir(), 'catalog-service-cache-')); roots.push(cache)
  const profiles = await mkdtemp(path.join(os.tmpdir(), 'catalog-service-profiles-')); roots.push(profiles)
  let attempt = 0; let fetches = 0; const releases: string[] = []
  const deps: OpenCodeProviderCatalogServiceDeps = {
    timeoutMs: 10_000, ttlMs: 10_000, maxStaleMs: 60_000,
    canonicalizeProjectPath: async value => value,
    prepareProfile: async plan => {
      const profileRootPath = path.join(profiles, `scope-catalog-${++attempt}`); await mkdir(profileRootPath)
      await writeOpenCodeCatalogProfileManifest({ profileRootPath,
        runtimeInstanceId: `catalog-${attempt}`, profileRootKey: path.basename(profileRootPath) })
      return { purpose: 'provider-catalog', providerId: plan.providerId,
        projectPath: plan.projectPath, profileRootPath, binaryFingerprint: 'binary',
        managedConfigFingerprint: 'config', selectedAuthBaselineFingerprint: 'auth',
        plannedHostKey: 'fake-host' } as OpenCodeScopedPreparedProfile
    },
    ensureHost: async () => ({ hostKey: 'fake-host', baseUrl: 'http://127.0.0.1:48003' }),
    releaseHost: async key => { releases.push(key) },
    fetchProviderCatalog: async () => { fetches += 1; return response() },
    ...overrides,
  }
  return { cache, service: new OpenCodeProviderCatalogService(deps), releases,
    fetches: () => fetches }
}

describe.serial('OpenCodeProviderCatalogService native ownership', () => {
  test('arms one deadline before canonicalization and preempts abort-ignoring preparation', async () => {
    let fire!: () => void; let signal!: AbortSignal
    const f = await fixture({ setTimer: ((callback: () => void) => {
      fire = callback; return { unref() {} } as ReturnType<typeof setTimeout>
    }) as typeof setTimeout, clearTimer: (() => undefined) as typeof clearTimeout,
    prepareProfile: async input => { signal = input.abortSignal!; return new Promise<never>(() => {}) } })
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = f.cache
    try {
      const pending = f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/sandbox' })
      while (!signal) await new Promise(resolve => setImmediate(resolve)); fire()
      await expect(pending).rejects.toThrow('temporarily unavailable')
      expect(signal.aborted).toBe(true)
    } finally { if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME; else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous }
  })

  test('uses BEGIN/BIND/FINALIZE natively and hydrates the exact fresh winner after restart', async () => {
    const f = await fixture(); const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = f.cache
    try {
      const first = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/sandbox/project' })
      expect(first.catalogProvenance).toBe('fresh-live'); expect(f.releases).toEqual(['fake-host'])
      const restarted = (await fixture()).service
      // Reuse the same cache and exact identity with a separately constructed service.
      const second = await restarted.loadCatalog({ providerId: 'deepinfra', projectPath: '/sandbox/project' })
      expect(second.catalogProvenance).toBe('cache-hit')
      expect(second.catalogEvidence).toEqual(first.catalogEvidence)
    } finally { if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME; else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous }
  })

  test('post-COMMIT cleanup, mutable input, and timer faults cannot reject the acknowledged catalog', async () => {
    let mutateInput = () => {}
    const f = await fixture({ prepareProfile: async plan => ({ purpose: 'provider-catalog',
      providerId: plan.providerId, projectPath: plan.projectPath, profileRootPath: '/missing/unowned-profile',
      binaryFingerprint: 'binary', managedConfigFingerprint: 'config',
      selectedAuthBaselineFingerprint: 'auth', plannedHostKey: 'fake-host' } as OpenCodeScopedPreparedProfile),
    fetchProviderCatalog: async () => { mutateInput(); return response() },
    clearTimer: (() => { throw new Error('post-commit timer finalizer fault') }) as typeof clearTimeout })
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = f.cache
    try {
      const input: { providerId: unknown; projectPath: string } = {
        providerId: 'deepinfra', projectPath: '/sandbox/project',
      }
      mutateInput = () => { input.providerId = 7 }
      await expect(f.service.loadCatalog(input as { providerId: string; projectPath: string }))
        .resolves.toMatchObject({ catalogProvenance: 'fresh-live' })
    } finally { if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME; else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous }
  })

  test('deadline after FINALIZE dispatch waits for exact commit recovery and never returns bounded stale', async () => {
    let fire!: () => void; let entered!: () => void; let committed = false
    const finalizeEntered = new Promise<void>(resolve => { entered = resolve })
    let finish!: () => void; const recovered = new Promise<void>(resolve => { finish = resolve })
    const f = await fixture({ setTimer: ((callback: () => void) => {
      fire = callback; return { unref() {} } as ReturnType<typeof setTimeout>
    }) as typeof setTimeout, clearTimer: (() => undefined) as typeof clearTimeout,
    authorityFactory: () => ({
      get committed() { return committed },
      beginAttempt: async () => ({ generation: 1, attemptIdentity: `sha256:${'1'.repeat(64)}` as const }),
      bindAndRead: async () => ({ previousEnvelope: null }),
      finalize: async () => { entered(); await recovered; committed = true
        return { committed: true as const, generation: 1 } },
      resolve: async () => ({ resolved: false as const, generation: 1 }),
      close: async () => {}, kill: () => {},
    }) })
    const pending = f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/sandbox/project' })
    await finalizeEntered; fire(); finish()
    await expect(pending).resolves.toMatchObject({ catalogProvenance: 'fresh-live' })
  })

  test('imports the exact eligible previous filesystem catalog without a provider fetch', async () => {
    const f = await fixture(); const observedAt = Date.now(); const project = '/sandbox/project'
    const keyMaterial = JSON.stringify([project, 'deepinfra', 'binary', 'config', 'auth'])
    const key = createHash('sha256').update(keyMaterial).digest('hex')
    const catalog = normalizeOpenCodeScopedProviderCatalogResponse({ requestedProviderId: 'deepinfra',
      response: response('legacy-model'), generation: 29, observedAtMs: observedAt, nowMs: observedAt,
      freshForMs: 10_000, maxStaleMs: 60_000, source: 'live' })
    const fp = (domain: string, value: string) => `sha256:${createHash('sha256').update(`${domain}\0${value}`).digest('hex')}`
    const catalogEvidence = { providerId: 'deepinfra', requestGeneration: 29, startedAt: observedAt,
      attemptIdentity: `sha256:${'1'.repeat(64)}`, binaryFingerprint: fp('opencode-catalog-binary-v1', 'binary'),
      configFingerprint: fp('opencode-catalog-config-v1', 'config'), authFingerprint: fp('opencode-catalog-auth-v1', 'auth') }
    const expiresAt = observedAt + 10_000; const identityHash = `sha256:${key}`
    const envelopeHash = `sha256:${createHash('sha256').update(
      `${identityHash}\0${catalog.recordId}\0${JSON.stringify(catalogEvidence)}\0${observedAt}\0${expiresAt}`,
    ).digest('hex')}`
    const envelope = JSON.stringify({ schema: 'opencode-provider-catalog-cache-v4', identityHash,
      fingerprints: { providerId: 'deepinfra', binaryFingerprint: 'binary',
        managedConfigFingerprint: 'config', selectedAuthBaselineFingerprint: 'auth' },
      catalog, catalogEvidence, catalogObservedAt: observedAt, catalogExpiresAt: expiresAt, envelopeHash })
    const legacyRoot = path.join(f.cache, 'opencode', 'provider-catalog-attempts-v2'); await mkdir(legacyRoot, { recursive: true })
    const db = new Database(path.join(legacyRoot, 'attempts.sqlite'))
    db.exec(`PRAGMA journal_mode=PERSIST; CREATE TABLE allocation_ticket (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope_hash TEXT NOT NULL CHECK(length(scope_hash) = 64),
      started_at INTEGER NOT NULL CHECK(started_at >= 0), cache_key TEXT CHECK(cache_key IS NULL OR length(cache_key) = 64));
      CREATE TABLE allocation_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      generation INTEGER NOT NULL CHECK(generation >= 0)); INSERT INTO allocation_state VALUES(1,30);
      CREATE TABLE catalog_entry (cache_key TEXT PRIMARY KEY CHECK(length(cache_key) = 64),
      request_generation INTEGER NOT NULL CHECK(request_generation > 0),
      attempt_identity TEXT NOT NULL CHECK(length(attempt_identity) = 71), attempt_id TEXT NOT NULL,
      pointer_json TEXT NOT NULL,envelope_json TEXT NOT NULL,
      retained_order INTEGER NOT NULL CHECK(retained_order > 0)); PRAGMA user_version=44306`)
    const insertTicket = db.query('INSERT INTO allocation_ticket(scope_hash,started_at,cache_key) VALUES(?1,?2,?3)')
    for (let generation = 1; generation <= 30; generation += 1) {
      insertTicket.run(createHash('sha256').update(`scope-${generation}`).digest('hex'), generation,
        generation === 30 ? key : null)
    }
    db.query('INSERT INTO catalog_entry VALUES(?1,29,?2,?3,?4,?5,29)')
      .run(key, catalogEvidence.attemptIdentity, 'legacy-attempt', '{}', envelope); db.close()
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = f.cache
    try {
      const imported = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: project })
      expect(imported.catalog.models.map(model => model.id)).toEqual(['legacy-model'])
      expect(imported.catalogProvenance).toBe('cache-hit'); expect(f.fetches()).toBe(0)
    } finally { if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME; else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous }
  })

  test('host release finishes before FINALIZE', async () => {
    let released = false; let publicationSawRelease = false; let generation = 0
    const f = await fixture({ allocateAttempt: () => ({ requestGeneration: ++generation,
      attemptIdentity: `sha256:${generation.toString(16).padStart(64, '0')}` }),
      releaseHost: async () => { released = true }, beforeFinalPublication: () => {
        publicationSawRelease = released
      }, readPersisted: async () => null, writePersisted: async () => {} })
    await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/sandbox' })
    expect(publicationSawRelease).toBe(true)
  })

  test('passes the planned host key and bounds a never-settling error cleanup', async () => {
    let expectedHostKey: string | undefined
    const f = await fixture({ timeoutMs: 500,
      allocateAttempt: () => ({ requestGeneration: 1,
        attemptIdentity: `sha256:${'1'.repeat(64)}` }),
      readPersisted: async () => null,
      writePersisted: async () => {},
      ensureHost: async input => {
        expectedHostKey = input.expectedHostKey
        return { hostKey: 'fake-host', baseUrl: 'http://127.0.0.1:48003' }
      },
      fetchProviderCatalog: async () => { throw new Error('fake catalog failure') },
      releaseHost: async () => new Promise<never>(() => {}),
    })
    const started = performance.now()
    await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/sandbox' }))
      .rejects.toThrow('temporarily unavailable')
    expect(expectedHostKey).toBe('fake-host')
    expect(performance.now() - started).toBeLessThan(1_500)
  })

  test('production singleton cache miss reaches fake scoped startup with the planned key', async () => {
    const profile: OpenCodeScopedPreparedProfile = { purpose: 'provider-catalog', providerId: 'deepinfra',
      projectPath: '/sandbox/project', profileRootPath: '/fake/catalog-profile',
      plannedHostKey: 'opencode-host-v2:planned', binaryFingerprint: 'binary',
      managedConfigFingerprint: 'config', selectedAuthBaselineFingerprint: 'auth' } as never
    const host = openCodeHostManager as unknown as Record<string, unknown>
    const clientFactory = openCodeClientFactory as unknown as Record<string, unknown>
    const profileManager = openCodeProfileManager as unknown as Record<string, unknown>
    const originals = {
      ensureScopedHost: host.ensureScopedHost,
      releaseHost: host.releaseHost,
      create: clientFactory.create,
      capture: profileManager.captureCurrentScopedProfilePlan,
      plan: profileManager.planScopedProfile,
      prepare: profileManager.prepareScopedProfile,
    }
    let expectedHostKey: string | undefined
    try {
      host.ensureScopedHost = async (input: { expectedHostKey: string }) => {
        expectedHostKey = input.expectedHostKey
        return { hostKey: input.expectedHostKey, baseUrl: 'http://127.0.0.1:48003' }
      }
      host.releaseHost = async () => {}
      clientFactory.create = () => ({ getProviderCatalog: async () => response('singleton-model') })
      profileManager.captureCurrentScopedProfilePlan = async () => ({ fake: 'current' })
      profileManager.planScopedProfile = () => ({ fake: 'plan' })
      profileManager.prepareScopedProfile = async () => profile
      const service = new OpenCodeProviderCatalogService({
        timeoutMs: 2_000, ttlMs: 10_000, maxStaleMs: 60_000,
        canonicalizeProjectPath: async value => value,
        allocateAttempt: () => ({ requestGeneration: 1,
          attemptIdentity: `sha256:${'1'.repeat(64)}` }),
        readPersisted: async () => null,
        writePersisted: async () => {},
      })
      const loaded = await service.loadCatalog({ providerId: 'deepinfra',
        projectPath: '/sandbox/project' })
      expect(loaded.catalog.models.map(model => model.id)).toEqual(['singleton-model'])
      expect(expectedHostKey).toBe(profile.plannedHostKey)
    } finally {
      host.ensureScopedHost = originals.ensureScopedHost
      host.releaseHost = originals.releaseHost
      clientFactory.create = originals.create
      profileManager.captureCurrentScopedProfilePlan = originals.capture
      profileManager.planScopedProfile = originals.plan
      profileManager.prepareScopedProfile = originals.prepare
    }
  })
})
