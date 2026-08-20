import { describe, expect, test } from 'bun:test'
import {
  link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'

import {
  allocateOpenCodeProviderCatalogAttempt,
  OpenCodeProviderCatalogService,
  type OpenCodeProviderCatalogServiceDeps,
} from './OpenCodeProviderCatalogService.js'

import type { OpenCodeScopedPreparedProfile } from './types.js'
import type { OpenCodeScopedProfilePlanContract } from './types.js'

function profile(input: {
  providerId: string
  projectPath: string
  config?: string
  auth?: string
  binary?: string
}): OpenCodeScopedPreparedProfile {
  return {
    scopeSchema: 'opencode-scoped-profile-v1',
    purpose: 'provider-catalog',
    providerId: input.providerId,
    projectPath: input.projectPath,
    profileRootPath: `/profiles/${input.projectPath.replaceAll('/', '_')}/${input.providerId}`,
    binaryFingerprint: input.binary ?? 'binary-a',
    managedConfigFingerprint: input.config ?? 'config-a',
    selectedAuthBaselineFingerprint: input.auth ?? 'auth-a',
    policy: {
      inventory: 'selected-provider-only',
      inventoryFallback: 'forbidden',
      launchAuthorization: 'forbidden',
    },
  } as unknown as OpenCodeScopedPreparedProfile
}

function response(providerId: string, model = 'model-a'): unknown {
  return {
    all: [{
      id: providerId,
      name: providerId,
      models: {
        [model]: {
          name: model,
          limits: { context: 10_000, output: 1_000 },
          capabilities: { tools: true },
        },
      },
    }],
    connected: [providerId],
  }
}

function memoryPersistence() {
  const values = new Map<string, unknown>()
  return {
    values,
    readPersisted: async (key: string) => values.get(key) ?? null,
    writePersisted: async (key: string, value: unknown) => { values.set(key, value) },
    deletePersisted: async (key: string) => { values.delete(key) },
  }
}

function fixture(overrides: OpenCodeProviderCatalogServiceDeps = {}) {
  let now = 1_000
  const plans: Array<Record<string, unknown>> = []
  const writes: Array<{ key: string; value: unknown }> = []
  const persisted = new Map<string, unknown>()
  const releases: string[] = []
  let config = 'config-a'
  let auth = 'auth-a'
  let requestGeneration = 0
  const deps: OpenCodeProviderCatalogServiceDeps = {
    now: () => now,
    ttlMs: 10,
    maxStaleMs: 1_000,
    timeoutMs: 500,
    canonicalizeProjectPath: async projectPath => projectPath,
    allocateAttempt: () => {
      requestGeneration += 1
      return { requestGeneration,
        attemptIdentity: `sha256:${requestGeneration.toString(16).padStart(64, '0')}` }
    },
    prepareProfile: async plan => {
      plans.push(plan)
      return profile({
        providerId: plan.providerId,
        projectPath: plan.projectPath ?? '/project',
        config,
        auth,
      })
    },
    ensureHost: async ({ preparedProfile }) => ({
      hostKey: `${preparedProfile.projectPath}:${preparedProfile.providerId}`,
      baseUrl: `http://127.0.0.1:${preparedProfile.providerId === 'kiro' ? 48001 : preparedProfile.providerId === 'cursor-acp' ? 48002 : 48003}`,
    }),
    releaseHost: async key => { releases.push(key) },
    fetchProviderCatalog: async ({ baseUrl }) => response(
      new URL(baseUrl).port === '48001' ? 'kiro'
        : new URL(baseUrl).port === '48002' ? 'cursor-acp' : 'deepinfra',
    ),
    readPersisted: async key => persisted.get(key) ?? null,
    writePersisted: async (key, value) => { writes.push({ key, value }); persisted.set(key, value) },
    ...overrides,
  }
  return {
    service: new OpenCodeProviderCatalogService(deps),
    plans,
    writes,
    releases,
    advance(ms: number) { now += ms },
    rotateConfig(value: string) { config = value },
    rotateAuth(value: string) { auth = value },
  }
}

// These tests deliberately rotate one process-global cache-home boundary.
// Serial execution is part of their isolation contract.
describe.serial('OpenCodeProviderCatalogService', () => {
  test('one absolute deadline aborts a forever-hanging profile in controlled fake time', async () => {
    let fire!: () => void
    let preparedSignal!: AbortSignal
    const f = fixture({
      timeoutMs: 1_000,
      setTimer: ((callback: () => void) => {
        fire = callback
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimer: (() => undefined) as typeof clearTimeout,
      prepareProfile: async ({ abortSignal }) => {
        preparedSignal = abortSignal!
        return new Promise<never>(() => {})
      },
    })
    const pending = f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    while (!preparedSignal) await Promise.resolve()
    fire()
    await expect(pending).rejects.toThrow('temporarily unavailable')
    expect(preparedSignal.aborted).toBe(true)
  })

  test('canonical project identity is allocated and prepared once for symlink aliases', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-project-'))
    const target = path.join(root, 'target')
    const alias = path.join(root, 'alias')
    await mkdir(target)
    await symlink(target, alias, 'dir')
    const scopes: string[] = []
    try {
      const canonical = await realpath(target)
      const f = fixture({
        timeoutMs: 1_000,
        canonicalizeProjectPath: async projectPath => realpath(projectPath),
        allocateAttempt: scope => {
          scopes.push(scope)
          return { requestGeneration: scopes.length,
            attemptIdentity: `sha256:${scopes.length.toString(16).padStart(64, '0')}` }
        },
      })
      const fromAlias = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: alias })
      const fromTarget = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: target })
      expect(scopes[0]).toBe(scopes[1])
      expect(fromAlias.projectPath).toBe(canonical)
      expect(fromTarget.projectPath).toBe(canonical)
      expect(f.plans.every(plan => plan.projectPath === canonical)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('platform-normalized aliases share the durable allocation scope and profile identity', async () => {
    const scopes: string[] = []
    const canonicalizeProjectPath = async () => 'c:\\users\\alice\\project'
    const f = fixture({
      canonicalizeProjectPath,
      allocateAttempt: scope => {
        scopes.push(scope)
        return { requestGeneration: scopes.length,
          attemptIdentity: `sha256:${scopes.length.toString(16).padStart(64, '0')}` }
      },
    })
    await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: 'C:\\Users\\ALICE\\Project' })
    await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: 'c:\\users\\alice\\project\\' })
    expect(scopes[0]).toBe(scopes[1])
    expect(f.plans.every(plan => plan.projectPath === 'c:\\users\\alice\\project')).toBe(true)
  })

  test('durable attempt order wins across instances with inverted completion and backward clocks', async () => {
    const persistence = memoryPersistence()
    let allocation = 0
    let releaseOld!: () => void
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
    const common = {
      ...persistence,
      allocateAttempt: () => {
        allocation += 1
        return { requestGeneration: allocation,
          attemptIdentity: `sha256:${allocation.toString(16).padStart(64, '0')}` }
      },
    }
    const old = fixture({ ...common, now: () => 1_000,
      fetchProviderCatalog: async () => { await oldGate; return response('deepinfra', 'old') } })
    const newer = fixture({ ...common, now: () => 900,
      fetchProviderCatalog: async () => response('deepinfra', 'winner') })
    const late = old.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    while (allocation < 1) await Promise.resolve()
    const winner = await newer.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    releaseOld()
    expect((await late).catalog.models.map(model => model.id)).toEqual(['winner'])
    expect(winner.catalogEvidence.requestGeneration).toBe(2)
    const restarted = fixture({ ...common, now: () => 900,
      fetchProviderCatalog: async () => { throw new Error('winner must hydrate') } })
    const restored = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(restored.catalog.models.map(model => model.id)).toEqual(['winner'])
    expect(JSON.stringify([...persistence.values.values()])).not.toContain('"old"')
  })
  test('an older instance revalidates after staging and cannot publish over a newer winner', async () => {
    const values = new Map<string, unknown>()
    let allocation = 0
    let releaseOldStage!: () => void
    let oldStageStarted!: () => void
    const oldStaged = new Promise<void>(resolve => { oldStageStarted = resolve })
    const allocateAttempt = () => ({ requestGeneration: ++allocation,
      attemptIdentity: `sha256:${allocation.toString(16).padStart(64, '0')}` as const })
    const readPersisted = async (key: string) => values.get(key) ?? null
    const old = fixture({ allocateAttempt, readPersisted, timeoutMs: 5_000,
      writePersisted: async (key, value) => {
        values.set(key, value)
        if (key.includes('.stage.')) {
          oldStageStarted()
          await new Promise<void>(resolve => { releaseOldStage = resolve })
        }
      },
      fetchProviderCatalog: async () => response('deepinfra', 'late-old'),
    })
    const newer = fixture({ allocateAttempt, readPersisted, timeoutMs: 5_000,
      writePersisted: async (key, value) => { values.set(key, value) },
      fetchProviderCatalog: async () => response('deepinfra', 'winner'),
    })
    const late = old.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    await oldStaged
    const winner = await newer.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    releaseOldStage()
    expect((await late).catalog.models.map(model => model.id)).toEqual(['winner'])
    expect(winner.catalog.models.map(model => model.id)).toEqual(['winner'])
    const restarted = fixture({ allocateAttempt, readPersisted, timeoutMs: 5_000,
      writePersisted: async (key, value) => { values.set(key, value) },
      fetchProviderCatalog: async () => { throw new Error('must hydrate winner') },
    })
    expect((await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
      .catalog.models.map(model => model.id)).toEqual(['winner'])
  })
  test('maxEntries retention uses durable order instead of frozen or backward mtimes across restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-retention-order-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    let allocation = 0
    let now = 1_000
    const common: OpenCodeProviderCatalogServiceDeps = {
      readPersisted: undefined, writePersisted: undefined, deletePersisted: undefined,
      allocateAttempt: () => ({ requestGeneration: ++allocation,
        attemptIdentity: `sha256:${allocation.toString(16).padStart(64, '0')}` }),
      now: () => now, timeoutMs: 5_000, maxEntries: 1,
    }
    try {
      await fixture({ ...common,
        fetchProviderCatalog: async () => response('deepinfra', 'old') })
        .service.loadCatalog({ providerId: 'deepinfra', projectPath: '/retention' })
      const catalogRoot = path.join(root, 'opencode', 'provider-catalog-v2')
      for (const file of (await readdir(catalogRoot)).filter(file => file.endsWith('.commit.json'))) {
        await utimes(path.join(catalogRoot, file), new Date(2_000_000_000_000), new Date(2_000_000_000_000))
      }
      now += 11
      await fixture({ ...common,
        fetchProviderCatalog: async () => response('deepinfra', 'winner') })
        .service.loadCatalog({ providerId: 'deepinfra', projectPath: '/retention' })
      const commits = (await readdir(catalogRoot)).filter(file => file.endsWith('.commit.json'))
      expect(commits).toHaveLength(1)
      const restored = await fixture({ ...common,
        fetchProviderCatalog: async () => { throw new Error('must hydrate durable winner') } })
        .service.loadCatalog({ providerId: 'deepinfra', projectPath: '/retention' })
      expect(restored.catalog.models.map(model => model.id)).toEqual(['winner'])
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('durable attempt order is independent of identical frozen clocks', async () => {
    const persistence = memoryPersistence()
    let allocation = 0
    let releaseOld!: () => void
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
    const common = {
      ...persistence,
      now: () => 1_000,
      allocateAttempt: () => {
        allocation += 1
        return { requestGeneration: allocation,
          attemptIdentity: `sha256:${allocation.toString(16).padStart(64, '0')}` }
      },
    }
    const old = fixture({ ...common,
      fetchProviderCatalog: async () => { await oldGate; return response('deepinfra', 'old') } })
    const newer = fixture({ ...common,
      fetchProviderCatalog: async () => response('deepinfra', 'winner') })
    const late = old.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    while (allocation < 1) await Promise.resolve()
    await newer.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    releaseOld()
    expect((await late).catalog.models.map(model => model.id)).toEqual(['winner'])
    const restored = await fixture({ ...common,
      fetchProviderCatalog: async () => { throw new Error('must hydrate winner') } })
      .service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(restored.catalog.models.map(model => model.id)).toEqual(['winner'])
  })

  test('a different-key candidate older than the newest admitted request never stages or succeeds', async () => {
    let generation = 0
    let fetches = 0
    let releaseOld!: () => void
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
    const allocateAttempt = () => ({ requestGeneration: ++generation,
      attemptIdentity: `sha256:${generation.toString(16).padStart(64, '0')}` as const })
    const persistence = memoryPersistence()
    const common: OpenCodeProviderCatalogServiceDeps = {
      ...persistence, allocateAttempt, timeoutMs: 5_000, maxEntries: 64,
      fetchProviderCatalog: async () => {
        fetches += 1
        if (fetches === 1) { await oldGate; return response('deepinfra', 'older') }
        return new Promise<never>(() => {})
      },
    }
    const older = fixture(common).service.loadCatalog({ providerId: 'deepinfra', projectPath: '/older-key' })
    while (fetches < 1) await Promise.resolve()
    const cancelNewer = new AbortController()
    const newer = fixture(common).service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/newer-key', abortSignal: cancelNewer.signal,
    })
    while (generation < 2 || fetches < 2) await Promise.resolve()
    releaseOld()
    await expect(older).rejects.toMatchObject({ outcome: 'superseded' })
    expect([...persistence.values.keys()].some(key => key.includes('.stage.'))).toBe(false)
    cancelNewer.abort()
    await expect(newer).rejects.toThrow('temporarily unavailable')
  })

  test('global admission distinguishes exact auth-rotated keys within one project scope', async () => {
    let generation = 0
    let selectedAuth = 'auth-a'
    let fetches = 0
    let releaseOlder!: () => void
    const olderGate = new Promise<void>(resolve => { releaseOlder = resolve })
    const allocateAttempt = () => ({ requestGeneration: ++generation,
      attemptIdentity: `sha256:${generation.toString(16).padStart(64, '0')}` as const })
    const persistence = memoryPersistence()
    const common: OpenCodeProviderCatalogServiceDeps = {
      ...persistence,
      allocateAttempt,
      timeoutMs: 5_000,
      prepareProfile: async plan => profile({
        providerId: plan.providerId, projectPath: plan.projectPath ?? '/same', auth: selectedAuth,
      }),
      fetchProviderCatalog: async () => {
        fetches += 1
        if (fetches === 1) { await olderGate; return response('deepinfra', 'auth-a-model') }
        return new Promise<never>(() => {})
      },
    }
    const older = fixture(common).service.loadCatalog({ providerId: 'deepinfra', projectPath: '/same' })
    while (fetches < 1) await Promise.resolve()
    selectedAuth = 'auth-b'
    const cancelNewer = new AbortController()
    const newer = fixture(common).service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/same', abortSignal: cancelNewer.signal,
    })
    while (generation < 2 || fetches < 2) await Promise.resolve()
    releaseOlder()
    await expect(older).rejects.toMatchObject({ outcome: 'superseded' })
    expect([...persistence.values.keys()].some(key => key.includes('.stage.'))).toBe(false)
    cancelNewer.abort()
    await expect(newer).rejects.toThrow('temporarily unavailable')
  })
  test('accepts production epoch time and rejects nonfinite or out-of-Date-range clocks', async () => {
    const production = fixture({ now: undefined, timeoutMs: 1_000 })
    const result = await production.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(result.catalogEvidence.startedAt).toBeGreaterThan(1_700_000_000_000)
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001]) {
      await expect(fixture({ now: () => now }).service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
        .rejects.toThrow('temporarily unavailable')
    }
  })

  test('default attempt ledger remains monotonic across service instances', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-attempt-test-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    try {
      const first = fixture({ allocateAttempt: undefined, timeoutMs: 5_000 })
      const one = await first.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/durable' })
      const restarted = fixture({ allocateAttempt: undefined, timeoutMs: 5_000 })
      const two = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/durable' })
      expect(two.catalogEvidence.requestGeneration).toBe(one.catalogEvidence.requestGeneration + 1)
      expect(two.catalogEvidence.attemptIdentity).not.toBe(one.catalogEvidence.attemptIdentity)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })
  test('SQLite contention yields and respects 20ms and 100ms absolute deadlines', async () => {
    for (const timeoutMs of [20, 100]) {
      const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-busy-'))
      const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
      let blocker: Database | null = null
      try {
        await allocateOpenCodeProviderCatalogAttempt('seed', 1)
        blocker = new Database(path.join(root, 'opencode', 'provider-catalog-attempts-v2', 'attempts.sqlite'))
        blocker.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE')
        const started = performance.now()
        await expect(fixture({ allocateAttempt: undefined, timeoutMs }).service.loadCatalog({
          providerId: 'deepinfra', projectPath: '/deadline-contention',
        })).rejects.toThrow('OpenCode provider catalog is temporarily unavailable.')
        expect(performance.now() - started).toBeLessThan(timeoutMs + 75)
      } finally {
        try { blocker?.exec('ROLLBACK') } catch {}
        blocker?.close()
        if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
        else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  test('stalled SQLite open and commit boundaries are preempted and leave no allocation child or transaction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-worker-stall-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    try {
      const first = await allocateOpenCodeProviderCatalogAttempt('seed', 1)
      let durableGeneration = first.requestGeneration
      for (const phase of ['open', 'commit'] as const) {
        const started = performance.now()
        await expect(allocateOpenCodeProviderCatalogAttempt(`stall-${phase}`, 2, {
          deadline: performance.now() + 30,
          testStallPhase: phase,
        })).rejects.toThrow('temporarily unavailable')
        expect(performance.now() - started).toBeLessThan(150)
        const recovered = await allocateOpenCodeProviderCatalogAttempt(`recovered-${phase}`, 3)
        durableGeneration += 1
        expect(recovered.requestGeneration).toBe(durableGeneration)
      }
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('attempt allocator fails closed on version and trigger tampering, then recovers after repair', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-schema-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    try {
      const first = await allocateOpenCodeProviderCatalogAttempt('scope-a', 1)
      const database = new Database(path.join(root, 'opencode', 'provider-catalog-attempts-v2', 'attempts.sqlite'))
      database.exec('PRAGMA user_version = 1')
      await expect(allocateOpenCodeProviderCatalogAttempt('scope-b', 2)).rejects.toThrow('temporarily unavailable')
      database.exec('PRAGMA user_version = 44305')
      const repaired = await allocateOpenCodeProviderCatalogAttempt('scope-b', 2)
      expect(repaired.requestGeneration).toBeGreaterThan(first.requestGeneration)
      database.exec(`CREATE TRIGGER malicious_generation AFTER INSERT ON allocation_ticket
        BEGIN UPDATE allocation_ticket SET started_at = 0 WHERE id = NEW.id; END`)
      await expect(allocateOpenCodeProviderCatalogAttempt('scope-c', 3)).rejects.toThrow('temporarily unavailable')
      database.exec('DROP TRIGGER malicious_generation')
      const afterTriggerRepair = await allocateOpenCodeProviderCatalogAttempt('scope-c', 3)
      expect(afterTriggerRepair.requestGeneration).toBeGreaterThan(repaired.requestGeneration)
      database.exec('CREATE INDEX malicious_scope_index ON allocation_ticket(scope_hash)')
      await expect(allocateOpenCodeProviderCatalogAttempt('scope-d', 4)).rejects.toThrow('temporarily unavailable')
      database.exec('DROP INDEX malicious_scope_index')
      expect((await allocateOpenCodeProviderCatalogAttempt('scope-d', 4)).requestGeneration)
        .toBeGreaterThan(afterTriggerRepair.requestGeneration)
      database.exec('ALTER TABLE allocation_ticket ADD COLUMN attacker TEXT')
      await expect(allocateOpenCodeProviderCatalogAttempt('scope-e', 5)).rejects.toThrow('temporarily unavailable')
      database.exec(`BEGIN IMMEDIATE;
        ALTER TABLE allocation_ticket RENAME TO broken_allocation_ticket;
        CREATE TABLE allocation_ticket (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope_hash TEXT NOT NULL CHECK(length(scope_hash) = 64),
          started_at INTEGER NOT NULL CHECK(started_at >= 0)
        );
        INSERT INTO allocation_ticket(id, scope_hash, started_at)
          SELECT id, scope_hash, started_at FROM broken_allocation_ticket;
        DROP TABLE broken_allocation_ticket;
        COMMIT`)
      database.close()
      expect((await allocateOpenCodeProviderCatalogAttempt('scope-recovered', 6)).requestGeneration)
        .toBeGreaterThan(afterTriggerRepair.requestGeneration)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  test('attempt allocator rejects deleted rows, forged state, and reset sqlite_sequence without generation reuse', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-ledger-rows-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    try {
      await allocateOpenCodeProviderCatalogAttempt('one', 1)
      const second = await allocateOpenCodeProviderCatalogAttempt('two', 2)
      const database = new Database(path.join(root, 'opencode', 'provider-catalog-attempts-v2', 'attempts.sqlite'))
      const row = database.query('SELECT id, scope_hash, started_at FROM allocation_ticket WHERE id = 2').get() as {
        id: number; scope_hash: string; started_at: number
      }
      database.exec('DELETE FROM allocation_ticket WHERE id = 2')
      await expect(allocateOpenCodeProviderCatalogAttempt('deleted-row', 3)).rejects.toThrow('temporarily unavailable')
      database.query('INSERT INTO allocation_ticket(id, scope_hash, started_at) VALUES (?1, ?2, ?3)')
        .run(row.id, row.scope_hash, row.started_at)
      database.exec("UPDATE sqlite_sequence SET seq = 0 WHERE name = 'allocation_ticket'")
      await expect(allocateOpenCodeProviderCatalogAttempt('reset-sequence', 3)).rejects.toThrow('temporarily unavailable')
      database.query("UPDATE sqlite_sequence SET seq = ?1 WHERE name = 'allocation_ticket'").run(2)
      database.exec('UPDATE allocation_state SET generation = 443 WHERE singleton = 1')
      await expect(allocateOpenCodeProviderCatalogAttempt('forged-state', 3)).rejects.toThrow('temporarily unavailable')
      database.exec('UPDATE allocation_state SET generation = 2 WHERE singleton = 1')
      database.close()
      expect((await allocateOpenCodeProviderCatalogAttempt('repaired', 3)).requestGeneration)
        .toBe(second.requestGeneration + 1)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  test('attempt database and WAL children reject external symlinks and a gated identity swap before mutation', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-child-symlink-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    const ledgerRoot = path.join(root, 'opencode', 'provider-catalog-attempts-v2')
    const outsideText = path.join(root, 'outside.txt')
    try {
      await mkdir(ledgerRoot, { recursive: true })
      await writeFile(outsideText, 'untouched')
      await symlink(outsideText, path.join(ledgerRoot, 'attempts.sqlite'))
      await expect(allocateOpenCodeProviderCatalogAttempt('main-link', 1, { cacheHome: root }))
        .rejects.toThrow('temporarily unavailable')
      expect(await readFile(outsideText, 'utf8')).toBe('untouched')
      await unlink(path.join(ledgerRoot, 'attempts.sqlite'))
      await allocateOpenCodeProviderCatalogAttempt('seed', 1, { cacheHome: root })
      await expect(allocateOpenCodeProviderCatalogAttempt('stop-worker', 2, {
        deadline: performance.now() + 30, testStallPhase: 'open', cacheHome: root,
      })).rejects.toThrow('temporarily unavailable')
      await writeFile(outsideText, 'still-untouched')
      await unlink(path.join(ledgerRoot, 'attempts.sqlite-wal')).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
      await symlink(outsideText, path.join(ledgerRoot, 'attempts.sqlite-wal'))
      await expect(allocateOpenCodeProviderCatalogAttempt('wal-link', 2, { cacheHome: root }))
        .rejects.toThrow('temporarily unavailable')
      expect(await readFile(outsideText, 'utf8')).toBe('still-untouched')
      await unlink(path.join(ledgerRoot, 'attempts.sqlite-wal'))
      await expect(allocateOpenCodeProviderCatalogAttempt('deleted-wal', 2, { cacheHome: root }))
        .rejects.toThrow('temporarily unavailable')
      // This authority deliberately remains failed closed: removing its WAL
      // after a committed marker must never reset generation. Use a distinct
      // deterministic authority for the coordinated main-file swap.
      const swapHome = path.join(root, 'swap-cache')
      const swapLedgerRoot = path.join(swapHome, 'opencode', 'provider-catalog-attempts-v2')
      await allocateOpenCodeProviderCatalogAttempt('swap-seed', 1, { cacheHome: swapHome })

      const outsideDatabasePath = path.join(root, 'outside.sqlite')
      const outsideDatabase = new Database(outsideDatabasePath, { create: true })
      outsideDatabase.exec('CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES (\'unchanged\')')
      outsideDatabase.close()
      const gate = path.join(root, 'swap-gate')
      const pending = allocateOpenCodeProviderCatalogAttempt('swap', 2, {
        deadline: performance.now() + 1_000, testGate: { phase: 'open', path: gate }, cacheHome: swapHome,
      })
      while (!await stat(`${gate}.entered`).catch(() => null)) await new Promise<void>(resolve => setImmediate(resolve))
      await rename(path.join(swapLedgerRoot, 'attempts.sqlite'), path.join(swapLedgerRoot, 'attempts.sqlite.saved'))
      await symlink(outsideDatabasePath, path.join(swapLedgerRoot, 'attempts.sqlite'))
      await writeFile(`${gate}.release`, '')
      await expect(pending).rejects.toThrow('temporarily unavailable')
      const verifiedOutside = new Database(outsideDatabasePath)
      expect(verifiedOutside.query('SELECT value FROM marker').get()).toEqual({ value: 'unchanged' })
      verifiedOutside.close()
      await unlink(path.join(swapLedgerRoot, 'attempts.sqlite'))
      await rename(path.join(swapLedgerRoot, 'attempts.sqlite.saved'), path.join(swapLedgerRoot, 'attempts.sqlite'))

      const commitSwapHome = path.join(root, 'commit-swap-cache')
      const commitSwapLedger = path.join(commitSwapHome, 'opencode', 'provider-catalog-attempts-v2')
      await allocateOpenCodeProviderCatalogAttempt('commit-swap-seed', 1, { cacheHome: commitSwapHome })
      const commitGate = path.join(root, 'commit-swap-gate')
      const commitPending = allocateOpenCodeProviderCatalogAttempt('commit-swap', 2, {
        deadline: performance.now() + 1_000,
        testGate: { phase: 'commit', path: commitGate },
        cacheHome: commitSwapHome,
      })
      while (!await stat(`${commitGate}.entered`).catch(() => null)) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      await rename(path.join(commitSwapLedger, 'attempts.sqlite'),
        path.join(commitSwapLedger, 'attempts.sqlite.saved'))
      await symlink(outsideDatabasePath, path.join(commitSwapLedger, 'attempts.sqlite'))
      await writeFile(`${commitGate}.release`, '')
      await expect(commitPending).rejects.toThrow('temporarily unavailable')
      const commitVerifiedOutside = new Database(outsideDatabasePath)
      expect(commitVerifiedOutside.query('SELECT value FROM marker').get()).toEqual({ value: 'unchanged' })
      commitVerifiedOutside.close()
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('global durable maxEntries spans project and identity rotations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-global-retention-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    let allocation = 0
    try {
      for (const projectPath of ['/one', '/two', '/three']) {
        await fixture({ readPersisted: undefined, writePersisted: undefined, deletePersisted: undefined,
          timeoutMs: 1_000, maxEntries: 1,
          allocateAttempt: () => ({ requestGeneration: ++allocation,
            attemptIdentity: `sha256:${allocation.toString(16).padStart(64, '0')}` }) })
          .service.loadCatalog({ providerId: 'deepinfra', projectPath })
      }
      const files = await readdir(path.join(root, 'opencode', 'provider-catalog-v2'))
      expect(files.filter(file => file.endsWith('.commit.json'))).toHaveLength(1)
      expect(files.filter(file => file.endsWith('.stage.json'))).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('repeated crash-stage cleanup failure never replaces the current winner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-cleanup-failure-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    let allocation = 0
    let fetches = 0
    const common: OpenCodeProviderCatalogServiceDeps = {
      readPersisted: undefined, writePersisted: undefined, deletePersisted: undefined,
      maxEntries: 1, maxStaleMs: 10, timeoutMs: 5_000,
      allocateAttempt: () => ({ requestGeneration: ++allocation,
        attemptIdentity: `sha256:${allocation.toString(16).padStart(64, '0')}` }),
    }
    try {
      const service = fixture({ ...common,
        fetchProviderCatalog: async () => response('deepinfra', fetches++ === 0 ? 'winner' : 'candidate'),
      })
      expect((await service.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/cleanup' }))
        .catalog.models.map(model => model.id)).toEqual(['winner'])
      const catalogRoot = path.join(root, 'opencode', 'provider-catalog-v2')
      await mkdir(path.join(catalogRoot, `${'a'.repeat(64)}.crashed.stage.json`))
      service.advance(21)
      await expect(service.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/cleanup' }))
        .rejects.toThrow('temporarily unavailable')
      await expect(service.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/cleanup' }))
        .rejects.toThrow('temporarily unavailable')
      const files = await readdir(catalogRoot)
      expect(files.filter(file => file.endsWith('.commit.json'))).toHaveLength(1)
      const restarted = fixture({ ...common,
        fetchProviderCatalog: async () => { throw new Error('must hydrate the retained winner') },
      })
      expect((await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/cleanup' }))
        .catalog.models.map(model => model.id)).toEqual(['winner'])
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a second service can never hydrate an envelope timed out at the final publication gate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-final-gate-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    let allocation = 0
    let fireDeadline!: () => void
    let enterGate!: () => void
    let releaseGate!: () => void
    const atGate = new Promise<void>(resolve => { enterGate = resolve })
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    const common: OpenCodeProviderCatalogServiceDeps = {
      readPersisted: undefined, writePersisted: undefined, deletePersisted: undefined,
      timeoutMs: 1_000,
      allocateAttempt: () => ({ requestGeneration: ++allocation,
        attemptIdentity: `sha256:${allocation.toString(16).padStart(64, '0')}` }),
    }
    try {
      const old = fixture({ ...common,
        setTimer: ((callback: () => void) => {
          fireDeadline = callback
          return { unref() {} } as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimer: (() => undefined) as typeof clearTimeout,
        beforeFinalPublication: async () => { enterGate(); await gate },
        fetchProviderCatalog: async () => response('deepinfra', 'timed-out'),
      })
      const pendingOld = old.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/race' })
      await atGate
      let readerFetched = false
      const reader = fixture({ ...common,
        fetchProviderCatalog: async () => { readerFetched = true; return response('deepinfra', 'winner') },
      })
      const pendingReader = reader.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/race' })
      while (!readerFetched) await new Promise<void>(resolve => setImmediate(resolve))
      fireDeadline()
      releaseGate()
      await expect(pendingOld).rejects.toThrow('temporarily unavailable')
      expect((await pendingReader).catalog.models.map(model => model.id)).toEqual(['winner'])
      const restarted = fixture({ ...common,
        fetchProviderCatalog: async () => { throw new Error('must hydrate winner') },
      })
      expect((await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/race' }))
        .catalog.models.map(model => model.id)).toEqual(['winner'])
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('deadline stalled immediately before commit sync cannot publish after public rejection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-pre-sync-deadline-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    let fireDeadline!: () => void
    let enterGate!: () => void
    let releaseGate!: () => void
    const entered = new Promise<void>(resolve => { enterGate = resolve })
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    try {
      const f = fixture({
        readPersisted: undefined, writePersisted: undefined, deletePersisted: undefined,
        timeoutMs: 1_000,
        setTimer: ((callback: () => void) => {
          fireDeadline = callback
          return { unref() {} } as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimer: (() => undefined) as typeof clearTimeout,
        beforeVisibilitySync: async () => { enterGate(); await gate },
      })
      const pending = f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/pre-sync' })
      await entered
      fireDeadline()
      await expect(pending).rejects.toThrow('temporarily unavailable')
      const catalogRoot = path.join(root, 'opencode', 'provider-catalog-v2')
      expect((await readdir(catalogRoot)).some(file => file.endsWith('.commit.json'))).toBe(false)
      releaseGate()
      for (let attempt = 0; attempt < 50; attempt += 1) await new Promise<void>(resolve => setImmediate(resolve))
      expect((await readdir(catalogRoot)).some(file => file.endsWith('.commit.json'))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('cross-process publication fencing preserves the global winner and bounded larger-capacity set', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-cross-process-'))
    const helper = fileURLToPath(new URL('./OpenCodeProviderCatalogCrossProcessFixture.ts', import.meta.url))
    const launch = (
      generation: number,
      model: string,
      projectPath: string,
      maxEntries: number,
      gate = '',
      retentionGate = '',
      visibilityGate = '',
    ) => {
      const child = Bun.spawn({
        cmd: [
          process.execPath, helper, root, String(generation), model, projectPath, String(maxEntries),
          gate, retentionGate, visibilityGate,
        ],
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      })
      return {
        child,
        result: (async () => {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          expect(exitCode, stderr).toBe(0)
          return JSON.parse(stdout) as {
            outcome: 'success' | 'rejected'; model?: string; type?: 'superseded' | 'transient'
          }
        })(),
      }
    }
    try {
      const gate = path.join(root, 'old-publication')
      const old = launch(1, 'late-old', '/same', 1, gate)
      while (!await stat(`${gate}.entered`).catch(() => null)) await new Promise<void>(resolve => setImmediate(resolve))
      expect(await launch(2, 'winner', '/same', 1).result).toEqual({ outcome: 'success', model: 'winner' })
      await writeFile(`${gate}.release`, '')
      expect(await old.result).toEqual({ outcome: 'success', model: 'winner' })

      const catalogRoot = path.join(root, 'opencode', 'provider-catalog-v2')
      expect((await readdir(catalogRoot)).filter(file => file.endsWith('.commit.json'))).toHaveLength(1)
      const ordered = []
      for (const [generation, model, project] of [
        [3, 'three', '/three'], [4, 'four', '/four'], [5, 'five', '/five'],
      ] as const) ordered.push(await launch(generation, model, project, 3).result)
      expect(ordered.every(result => result.outcome === 'success')).toBe(true)
      const files = await readdir(catalogRoot)
      const commitFiles = files.filter(file => file.endsWith('.commit.json'))
      expect(commitFiles).toHaveLength(3)
      const pointers = await Promise.all(commitFiles.map(async file => JSON.parse(
        await readFile(path.join(catalogRoot, file), 'utf8'),
      ) as { requestGeneration: number; attemptId: string }))
      expect(pointers.map(pointer => pointer.requestGeneration).sort((a, b) => a - b)).toEqual([3, 4, 5])
      const stages = await Promise.all(pointers.map(async pointer => {
        const file = files.find(name => name.endsWith(`.${pointer.attemptId}.stage.json`))!
        return JSON.parse(await readFile(path.join(catalogRoot, file), 'utf8')) as {
          catalog: { models: Array<{ id: string }> }
        }
      }))
      expect(stages.flatMap(stage => stage.catalog.models.map(modelEntry => modelEntry.id)).sort())
        .toEqual(['five', 'four', 'three'])

      const capacityOneGate = path.join(root, 'capacity-one-old-a')
      const capacityOneVisibility = path.join(root, 'capacity-one-old-a-visibility')
      const capacityOneOld = launch(
        6, 'old-a', '/key-a', 1, capacityOneGate, '', capacityOneVisibility,
      )
      while (!await stat(`${capacityOneGate}.entered`).catch(() => null)) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      expect(await launch(7, 'new-b', '/key-b', 1).result)
        .toEqual({ outcome: 'success', model: 'new-b' })
      await writeFile(`${capacityOneGate}.release`, '')
      expect(await capacityOneOld.result).toEqual({ outcome: 'rejected', type: 'superseded' })
      expect(await stat(`${capacityOneVisibility}.entered`).catch(() => null)).toBeNull()

      const capacityTwoGate = path.join(root, 'capacity-two-old-a')
      const capacityTwoOld = launch(8, 'retained-a', '/key-c', 2, capacityTwoGate)
      while (!await stat(`${capacityTwoGate}.entered`).catch(() => null)) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      expect(await launch(9, 'newer-b', '/key-d', 2).result)
        .toEqual({ outcome: 'success', model: 'newer-b' })
      await writeFile(`${capacityTwoGate}.release`, '')
      expect(await capacityTwoOld.result).toEqual({ outcome: 'rejected', type: 'superseded' })
      const finalPointers = await Promise.all((await readdir(catalogRoot))
        .filter(file => file.endsWith('.commit.json'))
        .map(async file => JSON.parse(await readFile(path.join(catalogRoot, file), 'utf8')) as {
          requestGeneration: number
        }))
      expect(finalPointers.map(pointer => pointer.requestGeneration).sort((a, b) => a - b))
        .toEqual([7, 9])

      expect(await launch(10, 'retention-seed', '/retention-seed', 1).result)
        .toEqual({ outcome: 'success', model: 'retention-seed' })
      const retentionGate = path.join(root, 'retention-authority-removed')
      const crashingPublisher = Bun.spawn({
        cmd: [
          process.execPath, helper, root, '11', 'crashing-successor', '/retention-crash', '1', '',
          retentionGate,
        ],
        stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
      })
      while (!await stat(`${retentionGate}.entered`).catch(() => null)) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      const liveLockPath = path.join(catalogRoot, '.publication.lock')
      const liveOwner = JSON.parse(await readFile(liveLockPath, 'utf8')) as {
        pid: number; token: string; processIdentity: string
      }
      const liveOwnerPath = path.join(
        catalogRoot, `.publication.owner.${liveOwner.pid}.${liveOwner.token}.json`,
      )
      const [liveLockMetadata, liveOwnerMetadata] = await Promise.all([
        lstat(liveLockPath), lstat(liveOwnerPath),
      ])
      expect(liveLockMetadata.isFile()).toBe(true)
      expect(liveLockMetadata.ino).toBe(liveOwnerMetadata.ino)
      expect(liveOwner.processIdentity.length).toBeGreaterThan(0)
      crashingPublisher.kill('SIGKILL')
      await crashingPublisher.exited
      const crashedFiles = await readdir(catalogRoot)
      expect(crashedFiles.some(file => file.endsWith('.reclaim.json'))).toBe(true)
      expect(crashedFiles.some(file => file.endsWith('.stage.json'))).toBe(true)
      expect(await launch(12, 'recovered-retention', '/retention-recovery', 1).result)
        .toEqual({ outcome: 'success', model: 'recovered-retention' })
      const recoveredFiles = await readdir(catalogRoot)
      expect(recoveredFiles.filter(file => file.endsWith('.commit.json'))).toHaveLength(1)
      expect(recoveredFiles.some(file => file.endsWith('.reclaim.json'))).toBe(false)
      expect(recoveredFiles.filter(file => file.endsWith('.stage.json'))).toHaveLength(1)
      expect(recoveredFiles.some(file => file.startsWith('.publication.'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)

  test('publication mutex reaps a reused PID identity without treating it as a live owner', async () => {
    if (process.platform !== 'linux') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-pid-reuse-lock-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    const catalogRoot = path.join(root, 'opencode', 'provider-catalog-v2')
    try {
      await mkdir(catalogRoot, { recursive: true })
      const token = '00000000-0000-4000-8000-000000000443'
      const ownerPath = path.join(catalogRoot, `.publication.owner.${process.pid}.${token}.json`)
      await writeFile(ownerPath, JSON.stringify({
        pid: process.pid,
        token,
        processIdentity: `linux:${process.pid}:reused-birth`,
      }), { mode: 0o600 })
      await link(ownerPath, path.join(catalogRoot, '.publication.lock'))
      const f = fixture({
        readPersisted: undefined, writePersisted: undefined, deletePersisted: undefined,
        allocateAttempt: () => ({ requestGeneration: 1,
          attemptIdentity: `sha256:${'1'.padStart(64, '0')}` }),
      })
      expect((await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/pid-reuse' }))
        .catalog.models).not.toHaveLength(0)
      expect((await readdir(catalogRoot)).some(file => file.startsWith('.publication.'))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('empty, corrupt and invalid publication locks are recovered without wedging later attempts', async () => {
    for (const artifact of ['empty', 'corrupt', 'directory'] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-corrupt-lock-'))
      const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
      try {
        const catalogRoot = path.join(root, 'opencode', 'provider-catalog-v2')
        await mkdir(catalogRoot, { recursive: true })
        const lockPath = path.join(catalogRoot, '.publication.lock')
        if (artifact === 'directory') await mkdir(lockPath)
        else await writeFile(lockPath, artifact === 'empty' ? '' : '{not-json')
        const result = await fixture({
          readPersisted: undefined, writePersisted: undefined, deletePersisted: undefined,
          timeoutMs: 5_000,
        }).service.loadCatalog({ providerId: 'deepinfra', projectPath: '/corrupt-lock' })
        expect(result.catalogProvenance).toBe('fresh-live')
        expect(await stat(path.join(catalogRoot, '.publication.lock')).catch(() => null)).toBeNull()
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
        else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  test('rejects relative and symlinked cache roots without writing through them', async () => {
    if (process.platform === 'win32') return
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-root-'))
    const target = path.join(sandbox, 'outside')
    const alias = path.join(sandbox, 'cache-link')
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    try {
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME = 'project-relative-cache'
      await expect(fixture({ allocateAttempt: undefined }).service.loadCatalog({
        providerId: 'deepinfra', projectPath: sandbox,
      })).rejects.toThrow('temporarily unavailable')
      expect(await stat(path.join(sandbox, 'project-relative-cache')).catch(() => null)).toBeNull()
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME = ''
      await expect(allocateOpenCodeProviderCatalogAttempt('scope-empty', 1))
        .rejects.toThrow('temporarily unavailable')
      const insideProject = path.join(sandbox, 'managed-cache')
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME = insideProject
      await expect(fixture({ allocateAttempt: undefined }).service.loadCatalog({
        providerId: 'deepinfra', projectPath: sandbox,
      })).rejects.toThrow('temporarily unavailable')
      expect(await stat(insideProject).catch(() => null)).toBeNull()
      await mkdir(target)
      await symlink(target, alias, 'dir')
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME = alias
      await expect(allocateOpenCodeProviderCatalogAttempt('scope', 1)).rejects.toThrow('temporarily unavailable')
      expect(await readdir(target)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  test('an intermediate cache-root replacement before commit writes nothing outside', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-root-race-'))
    const outside = path.join(root, 'outside')
    const displaced = path.join(root, 'displaced')
    const catalogRoot = path.join(root, 'cache', 'opencode', 'provider-catalog-v2')
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = path.join(root, 'cache')
    await mkdir(outside)
    try {
      const f = fixture({ readPersisted: undefined, writePersisted: undefined, deletePersisted: undefined,
        timeoutMs: 5_000,
        beforeFinalPublication: async () => {
          await rename(catalogRoot, displaced)
          await symlink(outside, catalogRoot, 'dir')
        },
      })
      await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/root-race' }))
        .rejects.toThrow('temporarily unavailable')
      expect(await readdir(outside)).toEqual([])
      expect((await readdir(displaced)).some(file => file.endsWith('.commit.json'))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })
  test('an armed deadline that expires during durable allocation prevents preparation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-attempt-deadline-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    let prepares = 0
    try {
      const f = fixture({
        allocateAttempt: undefined,
        timeoutMs: 1,
        prepareProfile: async plan => {
          prepares += 1
          return profile({ providerId: plan.providerId, projectPath: '/deadline' })
        },
      })
      await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/deadline' }))
        .rejects.toThrow('temporarily unavailable')
      expect(prepares).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })
  test('production wiring plans and passes the exact expected plan to scoped preparation', async () => {
    const calls: string[] = []
    const expected = Object.freeze({ digest: 'expected' }) as unknown as OpenCodeScopedProfilePlanContract
    const f = fixture({
      prepareProfile: undefined,
      profileManager: {
        captureCurrentScopedProfilePlan: async input => {
          calls.push('capture')
          return { ...input, providerId: input.providerId!, modelId: null,
            projectPath: input.projectPath ?? '/project', evidence: {} as never }
        },
        planScopedProfile: input => {
          calls.push('plan')
          expect(input).toMatchObject({ purpose: 'provider-catalog', providerId: 'deepinfra' })
          return expected
        },
        prepareScopedProfile: async (input, actualExpected) => {
          calls.push('prepare')
          expect(actualExpected).toBe(expected)
          return profile({ providerId: input.providerId, projectPath: input.projectPath ?? '/project' })
        },
      },
    })

    await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
      .resolves.toMatchObject({ catalog: { providerId: 'deepinfra' } })
    expect(calls).toEqual(['capture', 'plan', 'prepare'])
  })

  test('builds a catalog-only selected-provider plan and uses only the host provider API', async () => {
    const calls: string[] = []
    const f = fixture({
      fetchProviderCatalog: async ({ baseUrl }) => {
        calls.push(baseUrl)
        return response('deepinfra')
      },
    })
    const result = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })

    expect(f.plans).toHaveLength(1)
    expect(f.plans[0]).toMatchObject({
      purpose: 'provider-catalog', providerId: 'deepinfra', projectPath: '/p',
    })
    expect(calls).toEqual(['http://127.0.0.1:48003'])
    expect(result.catalog).toMatchObject({
      providerId: 'deepinfra', selectionAllowed: true, launchAuthorization: 'forbidden',
    })
    expect(result.catalog).not.toHaveProperty('launchReadiness')
    expect(result.catalogEvidence).toMatchObject({ providerId: 'deepinfra', requestGeneration: 1, startedAt: 1_000 })
    expect(Object.values(result.catalogEvidence).join('|')).not.toContain('/p')
    expect(Object.values(result.catalogEvidence).join('|')).not.toContain('config-a')
    expect(Object.values(result.catalogEvidence).join('|')).not.toContain('auth-a')
    expect(result.catalogEvidence.attemptIdentity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(f.releases).toEqual(['/p:deepinfra'])
  })

  test('fails an unsupported scoped contract without host, inventory, or legacy fallback', async () => {
    let hostCalls = 0
    const f = fixture({
      prepareProfile: async plan => {
        const prepared = profile({ providerId: plan.providerId, projectPath: '/p' })
        return {
          ...prepared,
          policy: { ...prepared.policy, inventoryFallback: 'legacy-full' },
        }
      },
      ensureHost: async () => { hostCalls += 1; throw new Error('must not run') },
    })

    await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
      .rejects.toThrow('temporarily unavailable')
    expect(hostCalls).toBe(0)
  })

  test('a hanging Kiro request does not delay DeepInfra and provider profiles stay isolated', async () => {
    const f = fixture({
      timeoutMs: 15,
      fetchProviderCatalog: async ({ baseUrl }) => {
        const id = new URL(baseUrl).port === '48001' ? 'kiro' : 'deepinfra'
        if (id === 'kiro') return new Promise<never>(() => {})
        return response(id)
      },
    })
    const kiro = f.service.loadCatalog({ providerId: 'kiro', projectPath: '/p' })
    const deepinfra = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })

    expect(deepinfra.catalog.providerId).toBe('deepinfra')
    expect(f.plans.map(plan => plan.providerId).sort()).toEqual(['deepinfra', 'kiro'])
    await expect(kiro).rejects.toThrow('temporarily unavailable')
  })

  test('Cursor and Kiro, and two projects using one provider, never share cache keys', async () => {
    const f = fixture()
    await f.service.loadCatalog({ providerId: 'cursor-acp', projectPath: '/one' })
    await f.service.loadCatalog({ providerId: 'kiro', projectPath: '/one' })
    await f.service.loadCatalog({ providerId: 'kiro', projectPath: '/two' })

    expect(f.writes.filter(write => write.key.endsWith('.current'))).toHaveLength(3)
  })

  test('enforces the configured in-memory cache size bound while durable cache can hydrate an eviction', async () => {
    let fetches = 0
    const f = fixture({
      maxEntries: 1,
      fetchProviderCatalog: async ({ baseUrl }) => {
        fetches += 1
        return response(new URL(baseUrl).port === '48001' ? 'kiro' : 'deepinfra')
      },
    })
    await f.service.loadCatalog({ providerId: 'kiro', projectPath: '/p' })
    await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    await f.service.loadCatalog({ providerId: 'kiro', projectPath: '/p' })
    expect(fetches).toBe(2)
  })

  test('config and auth rotations miss cache and create distinct cache identities', async () => {
    const f = fixture()
    const first = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    f.advance(11)
    f.rotateConfig('config-b')
    const second = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    f.advance(11)
    f.rotateAuth('auth-b')
    const third = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })

    expect(f.writes.filter(write => write.key.endsWith('.current'))).toHaveLength(3)
    expect([first, second, third].map(result => result.catalogEvidence.requestGeneration)).toEqual([1, 2, 3])
    expect(new Set([first, second, third].map(result => result.catalogEvidence.attemptIdentity)).size).toBe(3)
  })

  test('late completion after cancellation cannot replace a newer generation', async () => {
    let resolveFirst!: (value: unknown) => void
    let call = 0
    const cancellation = new AbortController()
    const f = fixture({
      timeoutMs: 1_000,
      fetchProviderCatalog: async () => {
        call += 1
        if (call === 1) return new Promise(resolve => { resolveFirst = resolve })
        return response('deepinfra', 'new-model')
      },
    })
    const first = f.service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/p', abortSignal: cancellation.signal,
    })
    const firstFailure = expect(first).rejects.toThrow('temporarily unavailable')
    while (!resolveFirst) await Promise.resolve()
    cancellation.abort(new Error('controlled fake cancellation'))
    const secondPending = f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    const second = await secondPending
    resolveFirst(response('deepinfra', 'old-model'))
    await firstFailure

    expect(second.catalog.models.map(model => model.id)).toEqual(['new-model'])
    expect(f.writes).toHaveLength(2)
  })

  test('ignores corrupt persistence and persists only a redacted immutable contract', async () => {
    const persistence = memoryPersistence()
    const f = fixture({
      ...persistence,
      readPersisted: async key => persistence.values.get(key) ?? { schema: 'bad', token: 'secret' },
    })
    const result = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })

    expect(result.catalog.models).toHaveLength(1)
    expect(JSON.stringify([...persistence.values.values()])).not.toContain('secret')
    expect(Object.isFrozen(result.catalog)).toBe(true)
    expect(Object.isFrozen(result.catalog.models[0]!.capabilities)).toBe(true)
  })

  test('accepts only a valid persisted contract and avoids a host/API read on a fresh hit', async () => {
    const persistence = memoryPersistence()
    let fetches = 0
    const shared = {
      ...persistence,
      fetchProviderCatalog: async () => { fetches += 1; return response('deepinfra') },
    }
    const first = fixture(shared)
    const original = await first.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    const second = fixture(shared)
    const restored = await second.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })

    expect(fetches).toBe(1)
    expect(restored.catalog.source).toBe('bounded-cache')
    expect(restored.catalogEvidence).toEqual(original.catalogEvidence)
    expect(restored.catalogObservedAt).toBe(original.catalogObservedAt)
    expect(restored.catalogExpiresAt).toBe(original.catalogExpiresAt)
    expect(restored.catalogProvenance).toBe('cache-hit')
    expect(restored.catalog.launchAuthorization).toBe('forbidden')
    second.advance(11)
    const refreshed = await second.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(fetches).toBe(2)
    expect(refreshed.catalog.generation).toBeGreaterThan(restored.catalog.generation)
  })

  test('restart requires a validated committed pointer and its exactly matching staged envelope', async () => {
    for (const corrupt of ['missing-stage', 'generation-mismatch', 'hash-mismatch'] as const) {
      const persistence = memoryPersistence()
      const seeded = fixture(persistence)
      await seeded.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
      const pointerEntry = [...persistence.values.entries()].find(([key]) => key.endsWith('.current'))!
      const pointer = pointerEntry[1] as Record<string, unknown>
      if (corrupt === 'missing-stage') {
        persistence.values.delete([...persistence.values.keys()].find(key => key.includes('.stage.'))!)
      } else {
        persistence.values.set(pointerEntry[0], {
          ...pointer,
          ...(corrupt === 'generation-mismatch'
            ? { generation: (pointer.generation as number) + 1 }
            : { envelopeHash: `sha256:${'0'.repeat(64)}` }),
        })
      }
      let fetches = 0
      const restarted = fixture({
        ...persistence,
        fetchProviderCatalog: async () => { fetches += 1; return response('deepinfra', `live-${corrupt}`) },
      })
      const result = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
      expect(fetches).toBe(1)
      expect(result.catalog.models[0]!.id).toBe(`live-${corrupt}`)
    }
  })

  test('restart uses one owned validated stage snapshot despite a clock-hook mutation', async () => {
    const persistence = memoryPersistence()
    const seeded = fixture(persistence)
    await seeded.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    const stageKey = [...persistence.values.keys()].find(key => key.includes('.stage.'))!
    const mutableStage = JSON.parse(JSON.stringify(persistence.values.get(stageKey))) as {
      catalog: { models: Array<{ id: string }> }
    }
    persistence.values.set(stageKey, mutableStage)
    let clockReads = 0
    let fetches = 0
    const restarted = fixture({
      ...persistence,
      now: () => {
        clockReads += 1
        if (clockReads === 3) mutableStage.catalog.models[0]!.id = 'mutated-after-validation'
        return 1_000
      },
      fetchProviderCatalog: async () => { fetches += 1; return response('deepinfra', 'must-not-fetch') },
    })
    const restored = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(fetches).toBe(0)
    expect(restored.catalog.models[0]!.id).toBe('model-a')
    expect(restored.catalog.models[0]!.id).not.toBe(mutableStage.catalog.models[0]!.id)
  })

  test('a valid pointer with a proxy or oversized stage triggers exactly one live refresh', async () => {
    for (const attack of ['proxy', 'oversized'] as const) {
      const persistence = memoryPersistence()
      await fixture(persistence).service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
      const stageKey = [...persistence.values.keys()].find(key => key.includes('.stage.'))!
      const seededStage = persistence.values.get(stageKey) as object
      let traps = 0
      persistence.values.set(stageKey, attack === 'proxy'
        ? new Proxy(seededStage, {
          ownKeys() { traps += 1; throw new Error('proxy-stage-secret') },
        })
        : { oversized: 'x'.repeat(2 * 1024 * 1024 + 1) })
      let fetches = 0
      const restarted = fixture({
        ...persistence,
        fetchProviderCatalog: async () => {
          fetches += 1
          return response('deepinfra', `live-after-${attack}`)
        },
      })

      const result = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
      expect(fetches).toBe(1)
      expect(result.catalog.models[0]!.id).toBe(`live-after-${attack}`)
      expect(traps).toBe(0)
    }
  })

  test('a valid pointer with a throwing stage read performs one live refresh and replaces persistence', async () => {
    const persistence = memoryPersistence()
    await fixture(persistence).service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    const oldStageKey = [...persistence.values.keys()].find(key => key.includes('.stage.'))!
    const secret = 'throwing-stage-read-secret'
    let stageReads = 0
    let fetches = 0
    const restarted = fixture({
      ...persistence,
      readPersisted: async key => {
        if (key === oldStageKey) {
          stageReads += 1
          throw new Error(secret)
        }
        return persistence.readPersisted(key)
      },
      fetchProviderCatalog: async () => {
        fetches += 1
        return response('deepinfra', 'live-after-throwing-stage')
      },
    })

    const live = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(stageReads).toBe(1)
    expect(fetches).toBe(1)
    expect(live.catalog.models[0]!.id).toBe('live-after-throwing-stage')
    expect(JSON.stringify(live)).not.toContain(secret)
    expect(JSON.stringify([...persistence.values.entries()])).not.toContain(secret)

    const restored = await fixture({
      ...persistence,
      fetchProviderCatalog: async () => {
        fetches += 1
        return response('deepinfra', 'must-not-fetch')
      },
    }).service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(fetches).toBe(1)
    expect(restored.catalog.models[0]!.id).toBe('live-after-throwing-stage')
    expect(restored.catalog.source).toBe('bounded-cache')
  })

  test('persisted bytes contain no raw project path', async () => {
    const persistence = memoryPersistence()
    const secretProjectPath = '/workspaces/customer-secret-project-9f7d2'
    await fixture(persistence).service.loadCatalog({
      providerId: 'deepinfra', projectPath: secretProjectPath,
    })

    const serialized = JSON.stringify([...persistence.values.entries()])
    expect(serialized).not.toContain(secretProjectPath)
    expect(serialized).not.toContain('customer-secret-project-9f7d2')
    expect(serialized).toContain('sha256:')
  })

  test('never publishes a committed pointer when staging fails', async () => {
    const writes: string[] = []
    const f = fixture({
      readPersisted: async () => null,
      writePersisted: async key => {
        writes.push(key)
        if (key.includes('.stage.')) throw new Error('stage-write-secret')
      },
    })
    await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
      .rejects.toThrow('OpenCode provider catalog is temporarily unavailable.')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('.stage.')
    expect(writes.some(key => key.endsWith('.current'))).toBe(false)
  })

  test('a stage-directory sync failure cannot expose a commit pointer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-stage-sync-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    try {
      const f = fixture({
        readPersisted: undefined, writePersisted: undefined, deletePersisted: undefined,
        beforeStageDirectorySync: () => { throw new Error('injected stage directory sync failure') },
      })
      await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/stage-sync' }))
        .rejects.toThrow('temporarily unavailable')
      const files = await readdir(path.join(root, 'opencode', 'provider-catalog-v2'))
      expect(files.some(file => file.endsWith('.commit.json'))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a post-visibility sync or cleanup error cannot reject an observable commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-visible-success-'))
    const previous = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = root
    try {
      const result = await fixture({
        readPersisted: undefined, writePersisted: undefined, deletePersisted: undefined,
        afterCommitVisibility: () => { throw new Error('injected post-visibility failure') },
      }).service.loadCatalog({ providerId: 'deepinfra', projectPath: '/visible-success' })
      expect(result.catalogProvenance).toBe('fresh-live')
      const files = await readdir(path.join(root, 'opencode', 'provider-catalog-v2'))
      expect(files.filter(file => file.endsWith('.commit.json'))).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
      else process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('catalog rejection waits for auth rollback and never exposes staged authorization', async () => {
    let authVisible = false
    let releaseRollback!: () => void
    let enteredRollback!: () => void
    const rollbackEntered = new Promise<void>(resolve => { enteredRollback = resolve })
    const rollbackGate = new Promise<void>(resolve => { releaseRollback = resolve })
    const f = fixture({
      prepareProfile: async plan => {
        authVisible = true
        return profile({ providerId: plan.providerId, projectPath: plan.projectPath ?? '/p' })
      },
      rollbackPreparedProfile: async () => {
        enteredRollback()
        await rollbackGate
        authVisible = false
      },
      fetchProviderCatalog: async () => { throw new Error('deterministic catalog rejection') },
    })
    let settled = false
    const pending = f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/auth-rollback' })
      .finally(() => { settled = true })
    await rollbackEntered
    expect(authVisible).toBe(true)
    expect(settled).toBe(false)
    releaseRollback()
    await expect(pending).rejects.toThrow('temporarily unavailable')
    expect(authVisible).toBe(false)
  })

  test('a publish is rejected when its durable stage disappears before verification', async () => {
    const persistence = memoryPersistence()
    const writes = persistence.writePersisted
    const f = fixture({
      ...persistence,
      writePersisted: async (key, value) => {
        await writes(key, value)
        if (key.endsWith('.current')) {
          for (const stageKey of [...persistence.values.keys()].filter(candidate => candidate.includes('.stage.'))) {
            persistence.values.delete(stageKey)
          }
        }
      },
    })
    await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
      .rejects.toThrow('temporarily unavailable')
    expect([...persistence.values.keys()].some(key => key.endsWith('.current'))).toBe(false)
    const restarted = fixture({ ...persistence })
    await expect(restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
      .resolves.toMatchObject({ catalogProvenance: 'fresh-live' })
  })

  test('timeout retains a bounded stale catalog without granting launch authorization', async () => {
    let hang = false
    const f = fixture({
      fetchProviderCatalog: async () => hang ? new Promise<never>(() => {}) : response('deepinfra'),
    })
    const fresh = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    f.advance(11)
    hang = true
    const stale = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })

    expect(stale.catalog.freshness.state).toBe('bounded-stale')
    expect(stale.catalog.source).toBe('bounded-cache')
    expect(stale.catalog.launchAuthorization).toBe('forbidden')
    expect(stale.catalogEvidence).toEqual(fresh.catalogEvidence)
    expect(stale.catalogObservedAt).toBe(fresh.catalogObservedAt)
    expect(stale.catalogExpiresAt).toBe(fresh.catalogExpiresAt)
    expect(stale.catalogProvenance).toBe('bounded-stale')
    expect(stale.diagnostics).toEqual([
      'OpenCode provider catalog refresh failed; using bounded stale data.',
    ])
  })

  test('max-stale expiry returns no fallback catalog authority', async () => {
    let hang = false
    const f = fixture({ timeoutMs: 500, maxStaleMs: 20,
      fetchProviderCatalog: async () => hang ? new Promise<never>(() => {}) : response('deepinfra') })
    await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    f.advance(21)
    hang = true
    await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
      .rejects.toThrow('temporarily unavailable')
  })

  test('never serves stale data across an exact config identity rotation', async () => {
    let hang = false
    const f = fixture({
      timeoutMs: 500,
      fetchProviderCatalog: async () => hang ? new Promise<never>(() => {}) : response('deepinfra'),
    })
    await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    f.advance(11)
    f.rotateConfig('config-rotated')
    hang = true
    await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
      .rejects.toThrow('temporarily unavailable')
  })

  test('rejects an already-aborted caller before profile or persistence side effects', async () => {
    let prepares = 0
    let reads = 0
    const controller = new AbortController()
    controller.abort(new Error('attacker secret'))
    const f = fixture({
      prepareProfile: async () => { prepares += 1; throw new Error('must not run') },
      readPersisted: async () => { reads += 1; return null },
    })
    await expect(f.service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/p', abortSignal: controller.signal,
    })).rejects.toThrow('OpenCode provider catalog is temporarily unavailable.')
    expect(prepares).toBe(0)
    expect(reads).toBe(0)
  })

  test('mid-flight cancellation never returns stale and redacts the abort reason', async () => {
    let hang = false
    const f = fixture({
      fetchProviderCatalog: async () => hang ? new Promise<never>(() => {}) : response('deepinfra'),
    })
    await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    f.advance(11)
    hang = true
    const controller = new AbortController()
    const pending = f.service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/p', abortSignal: controller.signal,
    })
    await Promise.resolve()
    controller.abort(new Error('do-not-leak-this-secret'))
    await expect(pending).rejects.toThrow('OpenCode provider catalog is temporarily unavailable.')
  })

  test('releases a host that arrives after the timeout fence', async () => {
    let resolveHost!: (host: { hostKey: string; baseUrl: string }) => void
    const f = fixture({
      timeoutMs: 500,
      ensureHost: async () => new Promise(resolve => { resolveHost = resolve }),
    })
    const pending = f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    await expect(pending).rejects.toThrow('temporarily unavailable')
    resolveHost({ hostKey: 'late-host', baseUrl: 'http://127.0.0.1:48003' })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(f.releases).toContain('late-host')
  })

  test('binds persisted envelopes to project and every exact fingerprint', async () => {
    const persistence = memoryPersistence()
    let fetches = 0
    const ports = {
      ...persistence,
      fetchProviderCatalog: async () => { fetches += 1; return response('deepinfra') },
    }
    const first = fixture(ports)
    await first.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/one' })
    const second = fixture(ports)
    const result = await second.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/two' })
    expect(fetches).toBe(2)
    expect(result.projectPath).toBe('/two')
  })

  test('ignores persisted proxy and toJSON attacks without invoking attacker code', async () => {
    const persistence = memoryPersistence()
    const seed = fixture({
      ...persistence,
    })
    await seed.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    const envelope = [...persistence.values.entries()].find(([key]) => key.includes('.stage.'))?.[1]
    let traps = 0
    let serializations = 0
    const proxy = new Proxy(envelope as object, {
      ownKeys() { traps += 1; throw new Error('proxy-persisted-secret') },
    })
    const withToJSON = {
      ...(envelope as Record<string, unknown>),
      toJSON() { serializations += 1; throw new Error('toJSON-persisted-secret') },
    }
    for (const persisted of [proxy, withToJSON]) {
      let fetches = 0
      const replacement = memoryPersistence()
      const f = fixture({
        ...replacement,
        readPersisted: async key => replacement.values.get(key) ?? persisted,
        fetchProviderCatalog: async () => { fetches += 1; return response('deepinfra') },
      })
      await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
        .resolves.toMatchObject({ catalog: { providerId: 'deepinfra' } })
      expect(fetches).toBe(1)
    }
    expect(traps).toBe(0)
    expect(serializations).toBe(0)
  })

  test('rejects proxy, accessor, toJSON and persistence exceptions with one fixed message', async () => {
    const attacks: Array<() => Promise<unknown>> = []
    const inputProxy = new Proxy({ providerId: 'deepinfra', projectPath: '/p' }, {
      ownKeys() { throw new Error('proxy-secret') },
    })
    attacks.push(() => fixture().service.loadCatalog(inputProxy))
    attacks.push(() => fixture({
      prepareProfile: async plan => Object.defineProperty(
        profile({ providerId: plan.providerId, projectPath: '/p' }),
        'projectPath',
        { enumerable: true, get() { throw new Error('getter-secret') } },
      ) as unknown as OpenCodeScopedPreparedProfile,
    }).service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
    attacks.push(() => fixture({
      prepareProfile: async plan => ({
        ...profile({ providerId: plan.providerId, projectPath: '/p' }),
        toJSON() { throw new Error('toJSON-secret') },
      }) as unknown as OpenCodeScopedPreparedProfile,
    }).service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
    attacks.push(() => fixture({
      readPersisted: async () => { throw new Error('persisted-secret') },
    }).service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
    for (const attack of attacks) {
      await expect(attack()).rejects.toThrow('OpenCode provider catalog is temporarily unavailable.')
    }
  })

  test('validates clocks and options before host or persistence side effects', async () => {
    for (const overrides of [
      { now: () => Number.NaN },
      { ttlMs: -1 },
      { maxStaleMs: Number.MAX_SAFE_INTEGER },
      { timeoutMs: 1.5 },
      { maxEntries: 1_025 },
      { ttlMs: 11, maxStaleMs: 10 },
    ] satisfies OpenCodeProviderCatalogServiceDeps[]) {
      let prepares = 0
      const f = fixture({
        ...overrides,
        prepareProfile: async () => { prepares += 1; throw new Error('must not run') },
      })
      await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
        .rejects.toThrow('temporarily unavailable')
      expect(prepares).toBe(0)
    }
  })

  test('fails closed on clock rollback instead of reusing a cache hit', async () => {
    let now = 100
    let prepares = 0
    const f = fixture({
      now: () => now,
      prepareProfile: async plan => {
        prepares += 1
        return profile({ providerId: plan.providerId, projectPath: '/p' })
      },
    })
    await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    now = 99
    await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
      .rejects.toThrow('temporarily unavailable')
    expect(prepares).toBe(1)
  })

  test('coalesces concurrent exact identities into one host load and generation', async () => {
    let resolveFetch!: (value: unknown) => void
    let hosts = 0
    let fetches = 0
    const f = fixture({
      ensureHost: async () => {
        hosts += 1
        return { hostKey: 'shared-host', baseUrl: 'http://127.0.0.1:48003' }
      },
      fetchProviderCatalog: async () => {
        fetches += 1
        return new Promise(resolve => { resolveFetch = resolve })
      },
    })
    const first = f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    const second = f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    await new Promise(resolve => setTimeout(resolve, 1))
    resolveFetch(response('deepinfra'))
    const [left, right] = await Promise.all([first, second])
    expect(hosts).toBe(1)
    expect(fetches).toBe(1)
    expect(left.catalog.recordId).toBe(right.catalog.recordId)
    expect(left.catalog.generation).toBe(1)
  })

  test('cancelling one coalesced waiter rejects only it while the shared fetch succeeds', async () => {
    let resolveFetch!: (value: unknown) => void
    let fetches = 0
    let sharedAborts = 0
    const firstController = new AbortController()
    const f = fixture({
      fetchProviderCatalog: async ({ abortSignal }) => {
        fetches += 1
        abortSignal.addEventListener('abort', () => { sharedAborts += 1 }, { once: true })
        return new Promise(resolve => { resolveFetch = resolve })
      },
    })
    const first = f.service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/p', abortSignal: firstController.signal,
    })
    const second = f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    while (f.plans.length < 2 || fetches < 1) await Promise.resolve()

    firstController.abort(new Error('first-waiter-secret'))
    await expect(first).rejects.toThrow('OpenCode provider catalog is temporarily unavailable.')
    expect(sharedAborts).toBe(0)
    resolveFetch(response('deepinfra', 'shared-success'))

    const result = await second
    expect(result.catalog.models.map(model => model.id)).toEqual(['shared-success'])
    expect(fetches).toBe(1)
    expect(sharedAborts).toBe(0)
  })

  test('aborts a coalesced fetch exactly once only after every waiter cancels', async () => {
    let fetches = 0
    let sharedAborts = 0
    let sharedSignal!: AbortSignal
    const firstController = new AbortController()
    const secondController = new AbortController()
    const f = fixture({
      fetchProviderCatalog: async ({ abortSignal }) => {
        fetches += 1
        sharedSignal = abortSignal
        return new Promise((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => {
            sharedAborts += 1
            reject(new Error('dependency-abort-secret'))
          }, { once: true })
        })
      },
    })
    const first = f.service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/p', abortSignal: firstController.signal,
    })
    const second = f.service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/p', abortSignal: secondController.signal,
    })
    while (f.plans.length < 2 || fetches < 1) await Promise.resolve()

    firstController.abort(new Error('first-secret'))
    await expect(first).rejects.toThrow('OpenCode provider catalog is temporarily unavailable.')
    expect(sharedSignal.aborted).toBe(false)
    expect(sharedAborts).toBe(0)

    secondController.abort(new Error('second-secret'))
    await expect(second).rejects.toThrow('OpenCode provider catalog is temporarily unavailable.')
    expect(sharedSignal.aborted).toBe(true)
    expect(sharedAborts).toBe(1)
    expect(fetches).toBe(1)
  })

  test('a stage write blocked before the final waiter withdraws can never publish generation 2', async () => {
    const persistence = memoryPersistence()
    let now = 1_000
    let releaseStage!: () => void
    let stageStarted!: () => void
    const started = new Promise<void>(resolve => { stageStarted = resolve })
    const f = fixture({ now: () => now, ...persistence })
    await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    now += 11
    const originalWrite = persistence.writePersisted
    const controller = new AbortController()
    const guarded = fixture({
      now: () => now,
      ...persistence,
      writePersisted: async (key, value) => {
        if (key.includes('.stage.')
          && (value as { catalog?: { generation?: number } }).catalog?.generation === 2) {
          stageStarted()
          await new Promise<void>(resolve => { releaseStage = resolve })
        }
        await originalWrite(key, value)
      },
    })
    const withdrawn = guarded.service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/p', abortSignal: controller.signal,
    })
    await started
    controller.abort(new Error('withdrawn-secret'))
    await expect(withdrawn).rejects.toThrow('OpenCode provider catalog is temporarily unavailable.')
    releaseStage()
    await new Promise(resolve => setTimeout(resolve, 1))

    const restarted = fixture({
      now: () => now,
      ...persistence,
      fetchProviderCatalog: async () => { throw new Error('must restore committed generation 1') },
    })
    const restored = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(restored.catalog.generation).toBe(1)
    expect(JSON.stringify([...persistence.values.values()])).not.toContain('generation-2')
  })

  test('a current write completing after its sole waiter withdraws restores the prior pointer', async () => {
    const persistence = memoryPersistence()
    let now = 1_000
    await fixture({ now: () => now, ...persistence }).service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/p',
    })
    now += 11
    let releaseCurrent!: () => void
    let currentStarted!: () => void
    const started = new Promise<void>(resolve => { currentStarted = resolve })
    const originalWrite = persistence.writePersisted
    const controller = new AbortController()
    const guarded = fixture({
      now: () => now,
      ...persistence,
      fetchProviderCatalog: async () => response('deepinfra', 'withdrawn-generation-2'),
      writePersisted: async (key, value) => {
        if (key.endsWith('.current')
          && (value as { generation?: number } | null)?.generation === 2) {
          currentStarted()
          await new Promise<void>(resolve => { releaseCurrent = resolve })
        }
        await originalWrite(key, value)
      },
    })
    const withdrawn = guarded.service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/p', abortSignal: controller.signal,
    })
    await started
    controller.abort(new Error('withdraw-after-current-start-secret'))
    await expect(withdrawn).rejects.toThrow('OpenCode provider catalog is temporarily unavailable.')
    releaseCurrent()
    await new Promise(resolve => setTimeout(resolve, 1))

    const restarted = fixture({
      now: () => now,
      ...persistence,
      fetchProviderCatalog: async () => { throw new Error('must restore generation 1') },
    })
    const restored = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(restored.catalog.generation).toBe(1)
    expect(restored.catalog.models.map(model => model.id)).toEqual(['model-a'])
    expect(JSON.stringify([...persistence.values.values()])).not.toContain('withdrawn-generation-2')
  })

  test('a timeout while releaseHost is paused cannot publish the fetched generation', async () => {
    const persistence = memoryPersistence()
    let now = 1_000
    await fixture({ now: () => now, ...persistence }).service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/p',
    })
    now += 11
    let releaseHost!: () => void
    let releaseStarted!: () => void
    const started = new Promise<void>(resolve => { releaseStarted = resolve })
    const timed = fixture({
      now: () => now,
      timeoutMs: 500,
      ...persistence,
      fetchProviderCatalog: async () => response('deepinfra', 'release-paused-generation-2'),
      releaseHost: async () => {
        releaseStarted()
        await new Promise<void>(resolve => { releaseHost = resolve })
      },
    })
    const pending = timed.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    await started
    await expect(pending).resolves.toMatchObject({
      catalog: { generation: 1, freshness: { state: 'bounded-stale' } },
    })
    releaseHost()
    await new Promise(resolve => setTimeout(resolve, 1))

    const restarted = fixture({
      now: () => now,
      ...persistence,
      fetchProviderCatalog: async () => { throw new Error('must restore generation 1') },
    })
    const restored = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(restored.catalog.generation).toBe(1)
    expect(restored.catalog.models.map(model => model.id)).toEqual(['model-a'])
    expect(JSON.stringify([...persistence.values.values()])).not.toContain('release-paused-generation-2')
  })

  test('a stage write completing after the flight timeout cannot move the committed pointer', async () => {
    const persistence = memoryPersistence()
    let now = 1_000
    const seeded = fixture({ now: () => now, ...persistence })
    await seeded.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    now += 11
    let releaseStage!: () => void
    let stageStarted!: () => void
    const started = new Promise<void>(resolve => { stageStarted = resolve })
    const originalWrite = persistence.writePersisted
    const timed = fixture({
      now: () => now,
      timeoutMs: 500,
      ...persistence,
      writePersisted: async (key, value) => {
        if (key.includes('.stage.')) {
          stageStarted()
          await new Promise<void>(resolve => { releaseStage = resolve })
        }
        await originalWrite(key, value)
      },
    })
    const pending = timed.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    await started
    await expect(pending).resolves.toMatchObject({ catalog: { generation: 1, freshness: { state: 'bounded-stale' } } })
    releaseStage()
    await new Promise(resolve => setTimeout(resolve, 1))

    const restarted = fixture({
      now: () => now,
      ...persistence,
      fetchProviderCatalog: async () => { throw new Error('must restore committed generation 1') },
    })
    const restored = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(restored.catalog.generation).toBe(1)
  })

  test('finish order 1,3,2 cannot publish a cancelled model to memory or persistence', async () => {
    let call = 0
    let finishSecond!: () => void
    const finishes: number[] = []
    const persistence = memoryPersistence()
    const f = fixture({
      ...persistence,
      fetchProviderCatalog: async () => {
        call += 1
        const current = call
        if (current === 2) {
          return new Promise(resolve => {
            finishSecond = () => {
              finishes.push(2)
              resolve(response('deepinfra', 'cancelled-model'))
            }
          })
        }
        finishes.push(current)
        return response('deepinfra', current === 1 ? 'generation-1' : 'generation-3')
      },
    })

    await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    f.advance(11)
    const cancelledController = new AbortController()
    const cancelled = f.service.loadCatalog({
      providerId: 'deepinfra', projectPath: '/p', abortSignal: cancelledController.signal,
    })
    while (call < 2) await Promise.resolve()
    cancelledController.abort(new Error('cancel-generation-2'))
    await expect(cancelled).rejects.toThrow('OpenCode provider catalog is temporarily unavailable.')

    const generation3 = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(generation3.catalog.generation).toBe(3)
    expect(generation3.catalog.models.map(model => model.id)).toEqual(['generation-3'])
    finishSecond()
    await new Promise(resolve => setTimeout(resolve, 1))
    expect(finishes).toEqual([1, 3, 2])

    const memory = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(memory.catalog.generation).toBe(3)
    expect(JSON.stringify(memory)).not.toContain('cancelled-model')
    expect(JSON.stringify([...persistence.values.values()])).not.toContain('cancelled-model')

    const restarted = fixture({
      now: () => 1_011,
      ...persistence,
      fetchProviderCatalog: async () => { throw new Error('restart must restore persistence') },
    })
    const restored = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(restored.catalog.generation).toBe(3)
    expect(restored.catalog.models.map(model => model.id)).toEqual(['generation-3'])
  })

  test('rejects non-loopback, credentialed, routed and accessor hosts and releases known leases', async () => {
    const invalidHosts: unknown[] = [
      { hostKey: 'remote', baseUrl: 'https://example.invalid:443' },
      { hostKey: 'credentialed', baseUrl: 'http://user:pass@127.0.0.1:48003' },
      { hostKey: 'routed', baseUrl: 'http://127.0.0.1:48003/provider' },
      Object.defineProperty({ hostKey: 'getter-host' }, 'baseUrl', {
        enumerable: true,
        get() { throw new Error('host-secret') },
      }),
    ]
    for (const invalidHost of invalidHosts) {
      const f = fixture({ ensureHost: async () => invalidHost as { hostKey: string; baseUrl: string } })
      await expect(f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' }))
        .rejects.toThrow('OpenCode provider catalog is temporarily unavailable.')
      expect(f.releases).toHaveLength(1)
    }
  })
})
