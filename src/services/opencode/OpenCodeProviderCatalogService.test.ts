import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
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
  const releases: string[] = []
  let config = 'config-a'
  let auth = 'auth-a'
  let requestGeneration = 0
  const deps: OpenCodeProviderCatalogServiceDeps = {
    now: () => now,
    ttlMs: 10,
    maxStaleMs: 1_000,
    timeoutMs: 20,
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
    readPersisted: async () => null,
    writePersisted: async (key, value) => { writes.push({ key, value }) },
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

describe('OpenCodeProviderCatalogService', () => {
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
    await expect(late).rejects.toThrow('temporarily unavailable')
    expect(winner.catalogEvidence.requestGeneration).toBe(2)
    const restarted = fixture({ ...common, now: () => 900,
      fetchProviderCatalog: async () => { throw new Error('winner must hydrate') } })
    const restored = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(restored.catalog.models.map(model => model.id)).toEqual(['winner'])
    expect(JSON.stringify([...persistence.values.values()])).not.toContain('"old"')
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
    await expect(late).rejects.toThrow('temporarily unavailable')
    const restored = await fixture({ ...common,
      fetchProviderCatalog: async () => { throw new Error('must hydrate winner') } })
      .service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    expect(restored.catalog.models.map(model => model.id)).toEqual(['winner'])
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
      const first = fixture({ allocateAttempt: undefined })
      const one = await first.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/durable' })
      const restarted = fixture({ allocateAttempt: undefined })
      const two = await restarted.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/durable' })
      expect(two.catalogEvidence.requestGeneration).toBe(one.catalogEvidence.requestGeneration + 1)
      expect(two.catalogEvidence.attemptIdentity).not.toBe(one.catalogEvidence.attemptIdentity)
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

  test('enforces the configured in-memory cache size bound', async () => {
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
    expect(fetches).toBe(3)
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
    const f = fixture({
      timeoutMs: 10,
      fetchProviderCatalog: async () => {
        call += 1
        if (call === 1) return new Promise(resolve => { resolveFirst = resolve })
        return response('deepinfra', 'new-model')
      },
    })
    const first = f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    const firstFailure = expect(first).rejects.toThrow('temporarily unavailable')
    await new Promise(resolve => setTimeout(resolve, 15))
    const second = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })
    resolveFirst(response('deepinfra', 'old-model'))
    await firstFailure

    expect(second.catalog.models.map(model => model.id)).toEqual(['new-model'])
    expect(f.writes).toHaveLength(2)
  })

  test('ignores corrupt persistence and persists only a redacted immutable contract', async () => {
    const f = fixture({ readPersisted: async () => ({ schema: 'bad', token: 'secret' }) })
    const result = await f.service.loadCatalog({ providerId: 'deepinfra', projectPath: '/p' })

    expect(result.catalog.models).toHaveLength(1)
    expect(JSON.stringify(f.writes[0]!.value)).not.toContain('secret')
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
    const f = fixture({ timeoutMs: 2, maxStaleMs: 20,
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
      timeoutMs: 5,
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
      timeoutMs: 2,
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
      const f = fixture({
        readPersisted: async () => persisted,
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
      timeoutMs: 2,
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
      timeoutMs: 2,
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
