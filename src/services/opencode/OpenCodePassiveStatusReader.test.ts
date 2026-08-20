import { describe, expect, test } from 'bun:test'

import type { OpenCodePassiveObservation } from './OpenCodePassiveStatusContract.js'
import { createOpenCodePassiveReadSuccess, OpenCodePassiveStatusReader, openCodePassiveInputPathIdentity } from './OpenCodePassiveStatusReader.js'
import { encodeOpenCodeRedactedSnapshotV1, type OpenCodeRedactedSnapshotV1 } from './OpenCodeRedactedStatusSnapshot.js'
import { FakePassiveClock, deferred, failure, fakePorts, flushMicrotasks, success } from './OpenCodePassiveStatusReader.test-support.js'

const unknown = (value: unknown) => expect.objectContaining({ value, authority: 'none', freshness: 'unknown', condition: 'degraded' })
const observation = <T>(value: T, authority: OpenCodePassiveObservation<T>['authority'], validUntil = 2_000): OpenCodePassiveObservation<T> => ({
  value, authority, freshness: 'fresh', condition: 'normal', observedAt: 800, validUntil, issueCode: 'none',
})

describe('OpenCodePassiveStatusReader', () => {
  test('reports independent empty, config-only, and auth-only observations', async () => {
    const clock = new FakePassiveClock()
    const empty = await new OpenCodePassiveStatusReader(fakePorts(clock, {
      binaryMetadata: { read: () => failure() }, configMetadata: { read: () => failure() }, authMetadata: { read: () => failure() }, catalogMetadata: { read: () => failure() }, executionMetadata: { read: () => failure() },
    })).read({ projectPath: '/ignored', providerIds: ['kiro'], timeoutMs: 100 })
    expect(empty.binary).toEqual(unknown({ presence: 'unknown', version: null }))
    expect(empty.providers[0].configured).toEqual(unknown('unknown'))
    expect(empty.providers[0].lastConnected).toEqual(unknown({ state: 'unknown' }))

    const configOnly = await new OpenCodePassiveStatusReader(fakePorts(clock, {
      authMetadata: { read: () => failure() }, catalogMetadata: { read: () => failure() }, executionMetadata: { read: () => failure() },
    })).read({ projectPath: '/ignored', providerIds: ['kiro'], timeoutMs: 100 })
    expect(configOnly.providers[0].configured).toMatchObject({ value: 'not_configured', authority: 'config_metadata', freshness: 'fresh' })
    expect(configOnly.providers[0].lastConnected.value).toEqual({ state: 'unknown' })

    const authOnly = await new OpenCodePassiveStatusReader(fakePorts(clock, {
      configMetadata: { read: () => failure() }, catalogMetadata: { read: () => failure() }, executionMetadata: { read: () => failure() },
      authMetadata: { read: async () => success({ lastConnectedAt: 700 }) },
    })).read({ projectPath: '/ignored', providerIds: ['kiro'], timeoutMs: 100 })
    expect(authOnly.providers[0].configured.value).toBe('unknown')
    expect(authOnly.providers[0].lastConnected).toMatchObject({ value: { state: 'connected', at: 700 }, authority: 'auth_metadata' })
  })

  test('converts synchronous read-port faults to fixed degraded observations', async () => {
    const status = await new OpenCodePassiveStatusReader(fakePorts(new FakePassiveClock(), {
      configMetadata: { read: () => { throw new Error('/secret/path from adapter') } },
    })).read({ projectPath: '/x', providerIds: ['kiro'], timeoutMs: 100 })
    expect(status.providers[0].configured).toMatchObject({ value: 'unknown', condition: 'degraded', issueCode: 'read_failed' })
    expect(JSON.stringify(status)).not.toContain('/secret/path')
  })

  test('keeps fresh execution passive and never authorizes launch', async () => {
    const status = await new OpenCodePassiveStatusReader(fakePorts(new FakePassiveClock(), {
      executionMetadata: { read: async () => success({ verified: true }) },
    })).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
    expect(status.providers[0].executionVerified).toMatchObject({ value: 'verified', freshness: 'fresh', condition: 'normal' })
    expect(status.authorization).toBe('unknown')
    expect(status.launchReadiness).toBe('not_authorized')
  })

  test('emits negative facts only from successful authoritative producers', async () => {
    const status = await new OpenCodePassiveStatusReader(fakePorts(new FakePassiveClock(), {
      binaryMetadata: { read: async () => success({ present: false, version: 'ignored-when-absent' }) },
    })).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
    expect(status.binary).toMatchObject({ value: { presence: 'absent', version: null }, authority: 'binary_metadata', issueCode: 'none' })
    expect(status.providers[0].configured).toMatchObject({ value: 'not_configured', authority: 'config_metadata' })
    expect(status.providers[0].lastConnected).toMatchObject({ value: { state: 'not_connected' }, authority: 'auth_metadata' })
    expect(status.providers[0].catalogAvailable).toMatchObject({ value: 'unavailable', authority: 'catalog_snapshot' })
    expect(status.providers[0].executionVerified).toMatchObject({ value: 'rejected', authority: 'execution_snapshot' })
  })

  test('marks expired successful evidence stale and degraded', async () => {
    const status = await new OpenCodePassiveStatusReader(fakePorts(new FakePassiveClock(), {
      catalogMetadata: { read: async () => success({ available: true }, 800, 999) },
    })).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
    expect(status.providers[0].catalogAvailable).toMatchObject({ value: 'available', freshness: 'stale', condition: 'degraded', issueCode: 'expired' })
  })

  test('preserves authoritative history on transient reads without synthesizing negative facts', async () => {
    const clock = new FakePassiveClock()
    const encoded = encodeOpenCodeRedactedSnapshotV1(historySnapshot(1_500))
    if (!encoded.ok || !encoded.bytes) throw new Error('fixture did not encode')
    const ports = fakePorts(clock, {
      snapshots: { read: async () => success(new TextDecoder().decode(encoded.bytes)) },
      configMetadata: { read: () => failure() }, authMetadata: { read: () => failure('timeout') }, catalogMetadata: { read: () => failure() }, executionMetadata: { read: () => failure() },
    })
    const status = await new OpenCodePassiveStatusReader(ports).read({ projectPath: '/canonical/project', providerIds: ['deepinfra'], timeoutMs: 100 })
    const provider = status.providers[0]
    expect(provider.configured).toMatchObject({ value: 'configured', authority: 'config_metadata', freshness: 'stale', condition: 'degraded', issueCode: 'read_failed' })
    expect(provider.lastConnected).toMatchObject({ value: { state: 'connected', at: 700 }, freshness: 'stale', issueCode: 'read_timeout' })
    expect(provider.catalogAvailable.value).toBe('available')
    expect(provider.executionVerified.value).toBe('verified')
  })

  test('bounds never-resolving reads, supports cancellation, and fences late completions without sleeps', async () => {
    const clock = new FakePassiveClock()
    const late = deferred<ReturnType<typeof success<{ present: boolean; version: string | null }>>>()
    const never = new Promise<never>(() => {})
    const reader = new OpenCodePassiveStatusReader(fakePorts(clock, {
      binaryMetadata: { read: () => late.promise },
      configMetadata: { read: () => never }, authMetadata: { read: () => never }, catalogMetadata: { read: () => never }, executionMetadata: { read: () => never }, snapshots: { read: () => never },
    }))
    const pending = reader.read({ projectPath: '/x', providerIds: ['kiro'], timeoutMs: 25 })
    await flushMicrotasks()
    clock.advance(25)
    const timedOut = await pending
    expect(timedOut.binary).toMatchObject({ value: { presence: 'unknown', version: null }, issueCode: 'read_timeout' })
    late.resolve(success({ present: false, version: null }))
    await flushMicrotasks()
    expect(timedOut.binary.value.presence).toBe('unknown')
    expect(clock.pendingTimers()).toBe(0)

    const cancelledClock = new FakePassiveClock()
    const controller = new AbortController()
    const cancelledPending = new OpenCodePassiveStatusReader(fakePorts(cancelledClock, { binaryMetadata: { read: () => never }, projectScope: { canonicalize: () => never } })).read({ projectPath: '/x', providerIds: [], timeoutMs: 100, signal: controller.signal })
    controller.abort()
    const cancelled = await cancelledPending
    expect(cancelled.binary.issueCode).toBe('read_cancelled')
    expect(cancelled.projectScope).toBeNull()
  })

  test('retains completed providers when Kiro and Cursor hang until the shared absolute deadline', async () => {
    const clock = new FakePassiveClock()
    const never = new Promise<never>(() => {})
    const ports = fakePorts(clock, {
      configMetadata: { read: (provider: string) => provider === 'kiro' ? never : Promise.resolve(success({ configured: true })) },
      authMetadata: { read: (provider: string) => provider === 'cursor' ? never : Promise.resolve(success({ lastConnectedAt: 700 })) },
    })
    const opaqueCustom = `sha256:${'c'.repeat(64)}`
    const pending = new OpenCodePassiveStatusReader(ports).read({ projectPath: '/x', providerIds: ['kiro', 'cursor', 'deepinfra', opaqueCustom], timeoutMs: 40 })
    await flushMicrotasks(32)
    clock.advance(40)
    const status = await pending
    const deepinfra = status.providers.find(provider => provider.providerId === 'deepinfra')!
    const custom = status.providers.find(provider => provider.providerId === opaqueCustom)!
    expect(deepinfra.configured.value).toBe('configured')
    expect(deepinfra.lastConnected.value).toEqual({ state: 'connected', at: 700 })
    expect(custom.configured.value).toBe('configured')
    expect(status.providers.find(provider => provider.providerId === 'kiro')!.configured).toMatchObject({ value: 'unknown', issueCode: 'read_timeout' })
    expect(status.providers.find(provider => provider.providerId === 'cursor')!.lastConnected).toMatchObject({ value: { state: 'unknown' }, issueCode: 'read_timeout' })
  })

  test('hashes canonical-equivalent paths identically, distinct paths differently, and cannot select snapshots without scope', async () => {
    const readScope = async (canonical: string | null, raw: string) => new OpenCodePassiveStatusReader(fakePorts(new FakePassiveClock(), {
      projectScope: { canonicalize: async (projectPath: string) => success(canonical === null ? null : { canonicalPath: canonical, inputPathIdentity: openCodePassiveInputPathIdentity(projectPath) }) },
    })).read({ projectPath: raw, providerIds: [], timeoutMs: 100 })
    const first = await readScope('/workspace/project', '/workspace/./project')
    const equivalent = await readScope('/workspace/project', '/workspace/link')
    const distinct = await readScope('/workspace/other', '/workspace/other')
    expect(first.projectScope).toBe(equivalent.projectScope)
    expect(first.projectScope).toBe('sha256:3d7b8e159f5b9a42ab402bb6fe74dece53173cb741977712c2b1518d78496ab1')
    expect(first.projectScope).not.toBe(distinct.projectScope)
    expect(JSON.stringify(first)).not.toContain('/workspace')

    let snapshotReads = 0
    const unavailable = await new OpenCodePassiveStatusReader(fakePorts(new FakePassiveClock(), {
      projectScope: { canonicalize: async () => success(null) }, snapshots: { read: async () => { snapshotReads += 1; return success(null) } },
    })).read({ projectPath: '/secret/path', providerIds: [], timeoutMs: 100 })
    expect(unavailable.projectScope).toBeNull()
    expect(snapshotReads).toBe(0)
  })

  test('fails closed when canonicalization proof belongs to another input path', async () => {
    let snapshotReads = 0
    const raw = '/workspace/project-a'
    const status = await new OpenCodePassiveStatusReader(fakePorts(new FakePassiveClock(), {
      projectScope: { canonicalize: async () => success({ canonicalPath: '/workspace/project-b', inputPathIdentity: openCodePassiveInputPathIdentity('/workspace/project-b') }) },
      snapshots: { read: async () => { snapshotReads += 1; return success(null) } },
    })).read({ projectPath: raw, providerIds: ['deepinfra'], timeoutMs: 100 })
    expect(status.projectScope).toBeNull()
    expect(snapshotReads).toBe(0)
    expect(status.providers[0].configured).toMatchObject({ value: 'unknown', authority: 'none', issueCode: 'scope_unavailable' })
  })

  test('uses immutable copies of port functions captured at read start', async () => {
    const clock = new FakePassiveClock()
    const scope = deferred<ReturnType<typeof success<{ canonicalPath: string; inputPathIdentity: `sha256:${string}` }>>>()
    let originalCalls = 0
    let replacementCalls = 0
    const ports = fakePorts(clock, {
      projectScope: { canonicalize: () => scope.promise },
      configMetadata: { read: async () => { originalCalls += 1; return success({ configured: true }) } },
    })
    const pending = new OpenCodePassiveStatusReader(ports).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
    ports.configMetadata.read = (_provider, _scope, _signal, handoff) => { replacementCalls += 1; handoff(success({ configured: false })) }
    scope.resolve(success({ canonicalPath: '/canonical/project', inputPathIdentity: openCodePassiveInputPathIdentity('/x') }))
    const status = await pending
    expect(originalCalls).toBe(1)
    expect(replacementCalls).toBe(0)
    expect(status.providers[0].configured.value).toBe('configured')
  })

  test('snapshots canonicalization into one scope identity and discards all project evidence if it expires', async () => {
    const clock = new FakePassiveClock()
    const scopeDeferred = deferred<ReturnType<typeof success<{ canonicalPath: string; inputPathIdentity: `sha256:${string}` }>>>()
    const never = new Promise<never>(() => {})
    let selectedScope: string | null = null
    const pending = new OpenCodePassiveStatusReader(fakePorts(clock, {
      projectScope: { canonicalize: () => scopeDeferred.promise },
      snapshots: { read: (scope: string) => { selectedScope = scope; return never } },
    })).read({ projectPath: '/input', providerIds: [], timeoutMs: 20 })
    const canonical = { canonicalPath: '/canonical/a', inputPathIdentity: openCodePassiveInputPathIdentity('/input') }
    scopeDeferred.resolve(success(canonical))
    await flushMicrotasks(16)
    canonical.canonicalPath = '/canonical/b'
    clock.advance(20)
    const status = await pending
    expect(status.projectScope).toBe(selectedScope)
    expect(status.projectScope).not.toBeNull()

    const expiringClock = new FakePassiveClock()
    const expiring = new OpenCodePassiveStatusReader(fakePorts(expiringClock, {
      projectScope: { canonicalize: async (projectPath: string) => success({ canonicalPath: '/canonical/a', inputPathIdentity: openCodePassiveInputPathIdentity(projectPath) }, 900, 1_005) },
      authMetadata: { read: () => never },
      configMetadata: { read: async () => success({ configured: true }) },
    })).read({ projectPath: '/input', providerIds: ['deepinfra'], timeoutMs: 10 })
    await flushMicrotasks(16)
    expiringClock.advance(10)
    const expired = await expiring
    expect(expired.projectScope).toBeNull()
    expect(expired.providers[0].configured).toMatchObject({ value: 'unknown', authority: 'none', issueCode: 'scope_unavailable' })
  })

  test('owns producer values synchronously at handoff and rejects future-at-handoff time', async () => {
    const resolvedClock = new FakePassiveClock()
    const resolved = deferred<ReturnType<typeof success<{ configured: boolean }>>>()
    const resolvedValue = { configured: true }
    const resolvedPending = new OpenCodePassiveStatusReader(fakePorts(resolvedClock, {
      configMetadata: { read: () => resolved.promise },
    })).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
    await flushMicrotasks(8)
    resolved.resolve(createOpenCodePassiveReadSuccess(resolvedValue, 900, 2_000))
    resolvedValue.configured = false // Deliberately no microtask flush after resolve.
    const resolvedStatus = await resolvedPending
    expect(resolvedStatus.providers[0].configured.value).toBe('configured')

    const clock = new FakePassiveClock()
    const never = new Promise<never>(() => {})
    const ports = fakePorts(clock, { authMetadata: { read: () => never } })
    const producerValue = { configured: true }
    let mutationRejected = false
    ports.configMetadata.read = (_provider, _scope, _signal, handoff) => {
      const produced = createOpenCodePassiveReadSuccess(producerValue, 900, 2_000)
      handoff(produced)
      producerValue.configured = false
      try { (produced as any).value.configured = false } catch { mutationRejected = true }
    }
    const pending = new OpenCodePassiveStatusReader(ports).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 10 })
    await flushMicrotasks(16)
    clock.advance(10)
    const status = await pending
    expect(status.providers[0].configured.value).toBe('configured')
    expect(mutationRejected).toBe(true)
    expect(Object.isFrozen(status)).toBe(true)
    expect(Object.isFrozen(status.providers[0].configured)).toBe(true)

    const futureClock = new FakePassiveClock()
    const futurePorts = fakePorts(futureClock, { authMetadata: { read: () => never } })
    futurePorts.configMetadata.read = (_provider, _scope, _signal, handoff) => {
      handoff(createOpenCodePassiveReadSuccess({ configured: true }, 1_001, 2_000))
    }
    const futurePending = new OpenCodePassiveStatusReader(futurePorts).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 10 })
    await flushMicrotasks(16)
    futureClock.advance(10)
    const future = await futurePending
    expect(future.providers[0].configured).toMatchObject({ value: 'unknown', issueCode: 'invalid_payload' })

    const snapshotClock = new FakePassiveClock()
    const encoded = encodeOpenCodeRedactedSnapshotV1(historySnapshot(2_000))
    if (!encoded.ok || !encoded.bytes) throw new Error('fixture did not encode')
    let snapshotText = new TextDecoder().decode(encoded.bytes)
    const snapshotPorts = fakePorts(snapshotClock, { configMetadata: { read: () => never } })
    snapshotPorts.snapshots.read = (_scope, _signal, handoff) => {
      handoff(createOpenCodePassiveReadSuccess(snapshotText, 900, 2_000))
      snapshotText = '{"mutated":true}'
    }
    const snapshotPending = new OpenCodePassiveStatusReader(snapshotPorts).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 10 })
    await flushMicrotasks(16)
    snapshotClock.advance(10)
    const fromSnapshot = await snapshotPending
    expect(fromSnapshot.providers[0].configured).toMatchObject({ value: 'configured', freshness: 'stale' })
  })

  test('captures request getters once and rejects inherited or accessor producer fields', async () => {
    const reads = { projectPath: 0, providerIds: 0, timeoutMs: 0, signal: 0 }
    const request = Object.create(null)
    Object.defineProperties(request, {
      projectPath: { enumerable: true, get: () => (++reads.projectPath === 1 ? '/x' : '/bad\0path') },
      providerIds: { enumerable: true, get: () => (++reads.providerIds === 1 ? ['deepinfra'] : ['sk-secret']) },
      timeoutMs: { enumerable: true, get: () => (++reads.timeoutMs === 1 ? 100 : 0) },
      signal: { enumerable: true, get: () => { reads.signal += 1; return undefined } },
    })
    await new OpenCodePassiveStatusReader(fakePorts(new FakePassiveClock())).read(request)
    expect(reads).toEqual({ projectPath: 1, providerIds: 1, timeoutMs: 1, signal: 1 })

    const inheritedValue = Object.create({ configured: true })
    const accessorValue = Object.create(null)
    Object.defineProperty(accessorValue, 'available', { enumerable: true, get: () => true })
    const status = await new OpenCodePassiveStatusReader(fakePorts(new FakePassiveClock(), {
      configMetadata: { read: async () => success(inheritedValue) as never },
      catalogMetadata: { read: async () => success(accessorValue) as never },
      binaryMetadata: { read: async () => success({ present: true, version: '1'.repeat(100_000) }) },
    })).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
    expect(status.binary.issueCode).toBe('invalid_payload')
    expect(status.providers[0].configured.issueCode).toBe('invalid_payload')
    expect(status.providers[0].catalogAvailable.issueCode).toBe('invalid_payload')
  })

  test('rejects proxy, accessor and over-wide provider arrays before active reads', async () => {
    for (const providerIds of [
      new Proxy(['deepinfra'], {
        getPrototypeOf: () => { throw new Error('must not reflect proxy') },
        ownKeys: () => { throw new Error('must not enumerate proxy') },
      }),
      (() => { const value = ['deepinfra']; Object.defineProperty(value, '0', { get: () => { throw new Error('must not call getter') } }); return value })(),
      Array.from({ length: 33 }, () => 'deepinfra'),
    ]) {
      let activeReads = 0
      const ports = fakePorts(new FakePassiveClock())
      for (const key of ['binaryMetadata', 'configMetadata', 'authMetadata', 'catalogMetadata', 'executionMetadata', 'snapshots'] as const) {
        ports[key].read = (() => { activeReads += 1 }) as never
      }
      await expect(new OpenCodePassiveStatusReader(ports).read({ projectPath: '/x', providerIds, timeoutMs: 100 })).rejects.toBeInstanceOf(TypeError)
      expect(activeReads).toBe(0)
    }
  })

  test('does not consult a changing provider-array proxy or fan out any reads', async () => {
    let traps = 0
    let activeReads = 0
    const providerIds = new Proxy(['deepinfra'], {
      getPrototypeOf: target => { traps += 1; return Reflect.getPrototypeOf(target) },
      getOwnPropertyDescriptor: (target, key) => {
        traps += 1
        if (key === 'length' && traps > 1) return { value: 100_000, configurable: false, writable: true }
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    const ports = fakePorts(new FakePassiveClock())
    for (const key of ['binaryMetadata', 'configMetadata', 'authMetadata', 'catalogMetadata', 'executionMetadata', 'snapshots'] as const) {
      ports[key].read = (() => { activeReads += 1 }) as never
    }
    await expect(new OpenCodePassiveStatusReader(ports).read({ projectPath: '/x', providerIds, timeoutMs: 100 })).rejects.toBeInstanceOf(TypeError)
    expect(traps).toBe(0)
    expect(activeReads).toBe(0)
  })

  test('fails closed for every invalid clock primitive without coercing objects', async () => {
    let coercions = 0
    const objectClock = { valueOf: () => { coercions += 1; return 1_000 }, toString: () => { coercions += 1; return '1000' } }
    for (const invalidNow of [objectClock, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const ports = fakePorts(new FakePassiveClock())
      ports.clock.now = (() => invalidNow) as never
      const status = await new OpenCodePassiveStatusReader(ports).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
      expect(status.projectScope).toBeNull()
      expect(status.binary.authority).toBe('none')
      expect(status.authorization).toBe('unknown')
      expect(status.launchReadiness).toBe('not_authorized')
      expect(typeof status.completedAt).toBe('number')
      expect(Number.isSafeInteger(status.completedAt)).toBe(true)
      expect(Object.isFrozen(status)).toBe(true)
    }
    expect(coercions).toBe(0)

    const throwingPorts = fakePorts(new FakePassiveClock())
    throwingPorts.clock.now = () => { throw new Error('invalid clock') }
    const thrown = await new OpenCodePassiveStatusReader(throwingPorts).read({ projectPath: '/x', providerIds: [], timeoutMs: 100 })
    expect(thrown.binary.authority).toBe('none')
    expect(thrown.completedAt).toBe(0)
  })

  test('never grants config authority to a plain-prototype-emulating proxy', async () => {
    const clock = new FakePassiveClock()
    let reflectionTraps = 0
    const forged = new Proxy({}, {
      getPrototypeOf: () => Object.prototype,
      ownKeys: () => { reflectionTraps += 1; return ['ok', 'value', 'observedAt', 'validUntil'] },
      getOwnPropertyDescriptor: (_target, key) => ({
        value: key === 'ok' ? true : key === 'value' ? { configured: true } : key === 'observedAt' ? 900 : 2_000,
        enumerable: true,
        configurable: true,
      }),
    })
    const ports = fakePorts(clock)
    ports.configMetadata.read = (_provider, _scope, _signal, handoff) => handoff(forged as never)
    const status = await new OpenCodePassiveStatusReader(ports).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
    expect(status.providers[0].configured).toMatchObject({ value: 'unknown', authority: 'none', issueCode: 'invalid_payload' })
    expect(reflectionTraps).toBe(0)
  })

  test('detaches late rejection after return without timer or returned-state mutation', async () => {
    const clock = new FakePassiveClock()
    const late = deferred<ReturnType<typeof success<{ configured: boolean }>>>()
    const pending = new OpenCodePassiveStatusReader(fakePorts(clock, {
      configMetadata: { read: () => late.promise },
    })).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 5 })
    await flushMicrotasks()
    clock.advance(5)
    const status = await pending
    const serialized = JSON.stringify(status)
    late.reject(new Error('late secret failure'))
    await flushMicrotasks()
    expect(JSON.stringify(status)).toBe(serialized)
    expect(clock.pendingTimers()).toBe(0)
  })

  test('consumes a native Promise rejection returned after callback-first settlement', async () => {
    const clock = new FakePassiveClock()
    const late = deferred<never>()
    let unhandled = 0
    const onUnhandled = () => { unhandled += 1 }
    process.on('unhandledRejection', onUnhandled)
    try {
      const ports = fakePorts(clock)
      ports.configMetadata.read = (_provider, _scope, _signal, handoff) => {
        handoff(createOpenCodePassiveReadSuccess({ configured: true }, 900, 2_000))
        return late.promise as never
      }
      const status = await new OpenCodePassiveStatusReader(ports).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
      expect(status.providers[0].configured.value).toBe('configured')
      late.reject(new Error('late adapter rejection'))
      await flushMicrotasks(16)
      expect(unhandled).toBe(0)
    } finally { process.off('unhandledRejection', onUnhandled) }
  })

  test('keeps a monotonic clock high-water and never revives expired authority after regression', async () => {
    const clock = new FakePassiveClock(1_000)
    const ports = fakePorts(clock)
    ports.configMetadata.read = (_provider, _scope, _signal, handoff) => {
      clock.setNow(900)
      handoff(createOpenCodePassiveReadSuccess({ configured: true }, 800, 950))
    }
    const status = await new OpenCodePassiveStatusReader(ports).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
    expect(status.completedAt).toBe(1_000)
    expect(status.projectScope).toBeNull()
    expect(status.providers[0].configured).toMatchObject({ value: 'unknown', authority: 'none' })
  })

  test('rejects future producer and snapshot timestamps conservatively', async () => {
    const clock = new FakePassiveClock()
    const future = historySnapshot(2_000)
    future.capturedAt = 1_001
    const encoded = encodeOpenCodeRedactedSnapshotV1(future)
    if (!encoded.ok || !encoded.bytes) throw new Error('fixture did not encode')
    const status = await new OpenCodePassiveStatusReader(fakePorts(clock, {
      binaryMetadata: { read: async () => success({ present: false, version: null }, 1_001, 2_000) },
      snapshots: { read: async () => success(new TextDecoder().decode(encoded.bytes)) }, configMetadata: { read: () => failure() },
    })).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
    expect(status.binary.value.presence).toBe('unknown')
    expect(status.binary.issueCode).toBe('invalid_payload')
    expect(status.providers[0].configured.value).toBe('unknown')
  })

  test('fails closed on malformed successful producer payloads instead of synthesizing negatives', async () => {
    const malformed = success({}) as never
    const status = await new OpenCodePassiveStatusReader(fakePorts(new FakePassiveClock(), {
      binaryMetadata: { read: async () => malformed },
      configMetadata: { read: async () => malformed },
      authMetadata: { read: async () => malformed },
      catalogMetadata: { read: async () => malformed },
      executionMetadata: { read: async () => malformed },
    })).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
    expect(status.binary).toMatchObject({ value: { presence: 'unknown', version: null }, authority: 'none', issueCode: 'invalid_payload' })
    expect(status.providers[0].configured).toMatchObject({ value: 'unknown', authority: 'none', issueCode: 'invalid_payload' })
    expect(status.providers[0].lastConnected).toMatchObject({ value: { state: 'unknown' }, authority: 'none', issueCode: 'invalid_payload' })
    expect(status.providers[0].catalogAvailable.value).toBe('unknown')
    expect(status.providers[0].executionVerified.value).toBe('unknown')
  })

  test('has no active side-effect call surface even when sentinels are present', async () => {
    const calls = new Map<string, number>()
    const forbidden = ['mkdir', 'write', 'rename', 'unlink', 'lock', 'spawn', 'fetch', 'host', 'session', 'model', 'agent', 'plugin', 'oauth']
    const sentinels = Object.fromEntries(forbidden.map(name => [name, () => calls.set(name, (calls.get(name) ?? 0) + 1)]))
    const ports = Object.assign(fakePorts(new FakePassiveClock()), sentinels)
    await new OpenCodePassiveStatusReader(ports).read({ projectPath: '/x', providerIds: ['deepinfra'], timeoutMs: 100 })
    expect([...calls.entries()]).toEqual([])
    expect(Object.keys(ports).filter(key => forbidden.includes(key))).toEqual(forbidden)
  })

  test('bounds producer copying for 100k arrays and records without key enumeration', () => {
    const hugeArray: unknown[] = []
    hugeArray.length = 100_000
    const hugeRecord: Record<string, unknown> = { configured: true }
    for (let index = 0; index < 100_000; index += 1) hugeRecord[`ignored${index}`] = index

    const originalOwnKeys = Reflect.ownKeys
    const originalObjectKeys = Object.keys
    const originalDescriptor = Object.getOwnPropertyDescriptor
    let enumerations = 0
    let descriptors = 0
    Reflect.ownKeys = ((target: object) => { enumerations += 1; return originalOwnKeys(target) }) as typeof Reflect.ownKeys
    Object.keys = ((target: object) => { enumerations += 1; return originalObjectKeys(target) }) as typeof Object.keys
    Object.getOwnPropertyDescriptor = ((target: object, key: PropertyKey) => {
      descriptors += 1
      return originalDescriptor(target, key)
    }) as typeof Object.getOwnPropertyDescriptor
    try {
      expect(createOpenCodePassiveReadSuccess(hugeArray, 900, 2_000)).toEqual({ ok: false, kind: 'invalid' })
      const copied = createOpenCodePassiveReadSuccess(hugeRecord, 900, 2_000)
      expect(copied).toMatchObject({ ok: true, value: { configured: true } })
      expect(enumerations).toBe(0)
      expect(descriptors).toBe(8)
    } finally {
      Reflect.ownKeys = originalOwnKeys
      Object.keys = originalObjectKeys
      Object.getOwnPropertyDescriptor = originalDescriptor
    }
  })
})

function historySnapshot(validUntil: number): OpenCodeRedactedSnapshotV1 {
  const scope = 'sha256:aa71052672766bc3382c0e9c52a39ba3ba84307efa74cf522cfed8f1256490f0' as const
  return {
    schemaVersion: 1, projectScope: scope, capturedAt: 900,
    binary: observation({ presence: 'present', version: '1.0.0' }, 'binary_metadata', validUntil),
    providers: [{
      providerId: 'deepinfra',
      configured: observation('configured', 'config_metadata', validUntil),
      lastConnected: observation({ state: 'connected', at: 700 }, 'auth_metadata', validUntil),
      catalogAvailable: observation('available', 'catalog_snapshot', validUntil),
      executionVerified: observation('verified', 'execution_snapshot', validUntil),
    }],
  }
}
