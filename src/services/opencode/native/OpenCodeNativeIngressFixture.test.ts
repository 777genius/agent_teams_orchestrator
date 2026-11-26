import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveNativeCustodyHelper } from './OpenCodeNativeCustody.js'
import { NativeIngressFixtureCases, type NativeIngressDiagnostic } from './fixtures/OpenCodeNativeIngressFixture.js'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function started(condition: () => boolean) {
  for (let turn = 0; turn < 30 && !condition(); turn++) await Promise.resolve()
  expect(condition()).toBe(true)
}
const resultOf = (promise: Promise<void>) => promise.then(() => null, error => error)

describe('native ingress fixture ownership', () => {
  test.skipIf(process.platform !== 'linux')('a missing helper manifest before admission restores the actual environment and keeps the failed fence', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-ingress-no-launch-')))
    const keys = ['CLAUDE_MULTIMODEL_DATA_HOME', 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH',
      'OPENCODE_BIN_PATH', 'CLAUDE_MULTIMODEL_OPENCODE_CUSTODY_HELPER']
    const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    const cases = new NativeIngressFixtureCases(), owner = cases.begin()
    let admissions = 0, stops = 0, restores = 0
    try {
      for (const key of keys) process.env[key] = path.join(root, `prior-${key}`)
      delete process.env.OPENCODE_BIN_PATH
      const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]))
      const helper = path.join(root, 'custodian')
      await writeFile(helper, 'TEST inert helper; never executed')
      await chmod(helper, 0o600)
      const failure = await resultOf(owner.run(async () => {
        owner.captureScopeRestore(() => {
          expect(cases.owns(owner)).toBe(true)
          restores++
          for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value
          }
        })
        for (const key of keys) process.env[key] = path.join(root, `owned-${key}`)
        process.env.CLAUDE_MULTIMODEL_OPENCODE_CUSTODY_HELPER = helper
        owner.captureCleanup(async () => { stops++; return true })
        // The production resolver reads the missing manifest without starting a helper or vendor.
        await owner.stage('setup', resolveNativeCustodyHelper)
        await owner.stage('host-admission', async () => { admissions++; return owner.adopt({}) })
      }))
      expect(failure.message).toBe('native_custody_asset_unavailable')
      expect([admissions, stops, restores]).toEqual([0, 0, 1])
      expect(keys.every(key => process.env[key] === prior[key])).toBe(true)
      expect(await owner.cleanup()).toBe(false)
      expect(owner.settledSuccessfully).toBe(false)
      expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
      expect(() => cases.begin()).toThrow('TEST_native_ingress_prior_unknown')
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a rejected admission without an adopted host is not proof of no launch', async () => {
    const cases = new NativeIngressFixtureCases(), owner = cases.begin()
    const failure = new Error('TEST admission failed after an unobserved launch')
    let admissions = 0, stops = 0, restores = 0
    expect(await resultOf(owner.run(async () => {
      owner.captureScopeRestore(() => { restores++ })
      owner.captureCleanup(async () => { stops++; return true })
      await owner.stage('host-admission', async () => { admissions++; throw failure })
    }))).toBe(failure)
    expect([admissions, stops, restores]).toEqual([1, 0, 0])
    expect(await owner.cleanup()).toBe(false)
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
  })

  test('closure before the admission factory runs restores scope without admitting or stopping a host', async () => {
    const cases = new NativeIngressFixtureCases(), owner = cases.begin()
    let admissions = 0, stops = 0, restores = 0
    const running = resultOf(owner.run(async () => {
      owner.captureScopeRestore(() => { restores++ })
      owner.captureCleanup(async () => { stops++; return true })
      await owner.stage('host-admission', async () => { admissions++; return owner.adopt({}) })
    }))
    cases.afterEach()
    expect((await running).message).toBe('TEST_native_ingress_closed')
    expect([admissions, stops, restores]).toEqual([0, 0, 1])
    expect(owner.settledSuccessfully).toBe(false)
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
  })

  test('a pending setup still retains scope when no admission started', async () => {
    const cases = new NativeIngressFixtureCases(), owner = cases.begin(), pending = deferred<void>(), waiter = deferred<void>()
    let reading = false, restores = 0
    const running = resultOf(owner.run(async () => {
      owner.captureScopeRestore(() => { restores++ })
      owner.captureCleanup(async () => true)
      const actual = owner.stage('setup', async () => { reading = true; await pending.promise })
      await Promise.race([actual, waiter.promise])
    }))
    await started(() => reading)
    waiter.resolve()
    expect((await running).message).toBe('TEST_native_ingress_cleanup_unconfirmed')
    expect(restores).toBe(0)
    pending.resolve()
    for (let turn = 0; turn < 6; turn++) await Promise.resolve()
    expect(restores).toBe(0)
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
  })

  test('a completed body, one confirmed cleanup and scope restoration admit the next case', async () => {
    const cases = new NativeIngressFixtureCases(), diagnostics: NativeIngressDiagnostic[] = []
    cases.beforeEach()
    const owner = cases.begin(value => diagnostics.push(value))
    let scope = 'owned', stops = 0, restores = 0
    await owner.run(async () => {
      owner.captureScopeRestore(() => { expect(cases.owns(owner)).toBe(true); scope = 'prior'; restores++ })
      owner.captureCleanup(async () => { stops++; return true })
      await owner.stage('host-admission', () => owner.adopt({}))
      expect(await owner.stage('stop', () => owner.cleanup())).toBe(true)
    })
    cases.afterEach()
    expect(owner.settledSuccessfully).toBe(true)
    expect(owner.signal.aborted).toBe(true)
    expect([stops, restores, scope]).toEqual([1, 1, 'prior'])
    expect(diagnostics.some(value => value.phase === 'host-admission' && value.event === 'begin')).toBe(true)
    expect(diagnostics.some(value => value.phase === 'complete' && value.event === 'complete')).toBe(true)
    expect(() => cases.beforeEach()).not.toThrow()
    expect(cases.begin()).not.toBe(owner)
  })

  test('a timed-out pending admission owns a late host only for its one awaited cleanup', async () => {
    const cases = new NativeIngressFixtureCases(), admission = deferred<object>(), retirement = deferred<boolean>()
    cases.beforeEach()
    const owner = cases.begin()
    let launched = false, stops = 0, effects = 0, restores = 0, scope = 'owned'
    const running = resultOf(owner.run(async () => {
      owner.captureScopeRestore(() => { expect(cases.owns(owner)).toBe(true); restores++; scope = 'prior' })
      owner.captureCleanup(async () => { stops++; return retirement.promise })
      await owner.stage('host-admission', async () => { launched = true; return owner.adopt(await admission.promise) })
      await owner.stage('authorized-config', async () => { effects++ })
    }))
    await started(() => launched)
    cases.afterEach() // Models the framework hook after its outer timeout.
    expect(owner.signal.aborted).toBe(true)
    expect(await owner.cleanup()).toBe(false) // Not a terminal or memoized pre-admission result.
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
    cases.afterEach() // A failed subsequent beforeEach must not replace the original owner.
    expect(cases.owns(owner)).toBe(true)
    expect(cases.attempts).toEqual([owner])
    admission.resolve({})
    await started(() => stops === 1)
    const sharedCleanup = owner.cleanup()
    expect(owner.cleanup()).toBe(sharedCleanup)
    expect([effects, restores, scope]).toEqual([0, 0, 'owned'])
    retirement.resolve(true)
    expect((await running).message).toBe('TEST_native_ingress_closed')
    expect(await sharedCleanup).toBe(true)
    expect([stops, effects, restores, scope]).toEqual([1, 0, 1, 'prior'])
    expect(owner.settledSuccessfully).toBe(false)
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
    expect(() => cases.begin()).toThrow('TEST_native_ingress_prior_unknown')
  })

  test('closure before a queued factory runs prevents the first effect', async () => {
    const cases = new NativeIngressFixtureCases(), owner = cases.begin()
    let effects = 0
    const running = resultOf(owner.run(async () => {
      owner.captureCleanup(async () => true)
      await owner.stage('setup', async () => { effects++ })
    }))
    cases.afterEach()
    expect((await running).message).toBe('TEST_native_ingress_closed')
    expect(effects).toBe(0)
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
  })

  test('closure after a stage settles denies its next stage without losing the captured cleanup', async () => {
    const cases = new NativeIngressFixtureCases(), owner = cases.begin(), read = deferred<void>()
    let reading = false, effects = 0, stops = 0
    const running = resultOf(owner.run(async () => {
      owner.captureCleanup(async () => { stops++; return true })
      await owner.adopt({})
      await owner.stage('authorized-config', async () => { reading = true; await read.promise })
      await owner.stage('stop', async () => { effects++; return owner.cleanup() })
    }))
    await started(() => reading)
    cases.afterEach()
    read.resolve()
    expect((await running).message).toBe('TEST_native_ingress_closed')
    expect([effects, stops]).toEqual([0, 1])
    expect(await owner.cleanup()).toBe(true)
    expect(stops).toBe(1)
  })

  test('normal Stop, afterAll and the body finalizer join one pending cleanup', async () => {
    const cases = new NativeIngressFixtureCases(), owner = cases.begin(), retirement = deferred<boolean>()
    let stops = 0, restores = 0, effects = 0
    const running = resultOf(owner.run(async () => {
      owner.captureScopeRestore(() => { restores++ })
      owner.captureCleanup(async () => { stops++; return retirement.promise })
      await owner.adopt({})
      await owner.stage('stop', () => owner.cleanup())
      await owner.stage('dead-receipt', async () => { effects++ })
    }))
    await started(() => stops === 1)
    cases.afterEach()
    const fromAfterAll = owner.cleanup()
    expect(owner.cleanup()).toBe(fromAfterAll)
    expect(restores).toBe(0)
    retirement.resolve(true)
    expect((await running).message).toBe('TEST_native_ingress_closed')
    expect(await fromAfterAll).toBe(true)
    expect([stops, restores, effects]).toEqual([1, 1, 0])
    expect(owner.settledSuccessfully).toBe(false)
  })

  test('a rejected Stop is never retried, retains the scope and preserves the original body error', async () => {
    const cases = new NativeIngressFixtureCases(), owner = cases.begin()
    const bodyError = new Error('TEST original body failure'), cleanupError = new Error('TEST captured cleanup failed')
    let stops = 0, restores = 0
    const failure = await resultOf(owner.run(async () => {
      owner.captureScopeRestore(() => { restores++ })
      owner.captureCleanup(async () => { stops++; throw cleanupError })
      await owner.adopt({})
      throw bodyError
    }))
    expect(failure).toBe(bodyError)
    await expect(owner.cleanup()).rejects.toBe(cleanupError)
    await expect(owner.cleanup()).rejects.toBe(cleanupError)
    expect([stops, restores]).toEqual([1, 0])
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
  })

  test('an unconfirmed cleanup retains scope and the failed owner', async () => {
    const cases = new NativeIngressFixtureCases(), owner = cases.begin()
    let stops = 0, restores = 0
    const failure = await resultOf(owner.run(async () => {
      owner.captureScopeRestore(() => { restores++ })
      owner.captureCleanup(async () => { stops++; return false })
      await owner.adopt({})
    }))
    expect(failure.message).toBe('TEST_native_ingress_cleanup_unconfirmed')
    expect(await owner.cleanup()).toBe(false)
    expect([stops, restores]).toEqual([1, 0])
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
    cases.afterEach()
    expect(cases.owns(owner)).toBe(true)
  })

  test('an unawaited actual stage keeps the fence after its waiter and later stage settlement', async () => {
    const cases = new NativeIngressFixtureCases(), owner = cases.begin(), pending = deferred<void>(), waiter = deferred<void>()
    let reading = false, restores = 0
    const running = resultOf(owner.run(async () => {
      owner.captureScopeRestore(() => { restores++ })
      owner.captureCleanup(async () => true)
      await owner.adopt({})
      const actual = owner.stage('authorized-config', async () => { reading = true; await pending.promise })
      await Promise.race([actual, waiter.promise])
    }))
    await started(() => reading)
    waiter.resolve()
    expect((await running).message).toBe('TEST_native_ingress_pending')
    expect(restores).toBe(0)
    expect(owner.settledSuccessfully).toBe(false)
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
    pending.resolve()
    for (let turn = 0; turn < 6; turn++) await Promise.resolve()
    expect(restores).toBe(0)
    expect(owner.settledSuccessfully).toBe(false)
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
  })

  test('scope restoration failure retains the fence and is never retried', async () => {
    const cases = new NativeIngressFixtureCases(), owner = cases.begin(), failure = new Error('TEST restore failed')
    let restores = 0
    expect(await resultOf(owner.run(async () => {
      owner.captureScopeRestore(() => { restores++; throw failure })
      owner.captureCleanup(async () => true)
      await owner.adopt({})
    }))).toBe(failure)
    cases.afterEach()
    expect(await owner.cleanup()).toBe(true)
    expect(restores).toBe(1)
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
  })

  test('a reentrant diagnostic callback observes the already published cleanup promise', async () => {
    const cases = new NativeIngressFixtureCases()
    let entered = false, joined: Promise<boolean> | undefined, stops = 0
    const owner = cases.begin(diagnostic => {
      if (diagnostic.event === 'cleanup-start' && !entered) {
        entered = true
        joined = owner.cleanup()
      }
    })
    await owner.run(async () => {
      owner.captureCleanup(async () => { stops++; return true })
      await owner.adopt({})
      expect(await owner.stage('stop', () => owner.cleanup())).toBe(true)
    })
    expect(stops).toBe(1)
    expect(joined).toBe(owner.cleanup())
    expect(owner.settledSuccessfully).toBe(true)
  })

  test('diagnostic callbacks cannot change ownership and receive no raw failure fields', async () => {
    const cases = new NativeIngressFixtureCases(), diagnostics: NativeIngressDiagnostic[] = []
    const owner = cases.begin(value => { diagnostics.push(value); throw new Error('TEST reporter failed') })
    const failure = new Error('TEST private body marker')
    expect(await resultOf(owner.run(async () => {
      owner.captureCleanup(async () => true)
      await owner.adopt({})
      throw failure
    }))).toBe(failure)
    expect(diagnostics.length).toBeGreaterThan(0)
    expect(JSON.stringify(diagnostics)).not.toContain(failure.message)
    expect(Object.keys(diagnostics[0]).sort()).toEqual(['cleanup', 'closed', 'event', 'pendingStages', 'phase'])
    expect(() => cases.beforeEach()).toThrow('TEST_native_ingress_prior_unknown')
  })
})

