import { describe, expect, test } from 'bun:test'
import { canonicalHostedApprovalJson } from './OpenCodeClientFactory.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeRuntimeDeadlineError } from './OpenCodeRuntimeDeadline.js'
import { supervisedFixture, supervisedLease, supervisedTestStage, supervisedTestWait } from './OpenCodeSupervisedCustody.test-fixture.js'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

describe.skipIf(process.platform !== 'linux')('OpenCode supervised acquisition bounds', () => {
  test('cancelled queue entries settle independently and cannot let a live successor overtake its predecessor', async () => {
    const entered = gate(), held = gate(), consumed = gate()
    let leaseCalls = 0
    let lateConsumes = 0
    const firstAbort = new AbortController(), queuedAbort = new AbortController(), successorAbort = new AbortController()
    const fixture = await supervisedFixture({ mutateBundle(bundle) {
      const prepare = bundle.prepareLeaseToken
      bundle.prepareLeaseToken = async lease => {
        const ordinal = ++leaseCalls
        const token = await prepare(lease)
        if (ordinal !== 1) return token
        entered.release(); await held.promise
        return { consume() { lateConsumes += 1; consumed.release(); return token?.consume() ?? false } }
      }
    } })
    try {
      const custody = await fixture.acquire()
      const manager = new OpenCodeHostManager({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
      const first = manager.ensureHost({ lease: { ...supervisedLease, sessionId: undefined }, abortSignal: firstAbort.signal })
        .catch(error => error)
      await supervisedTestStage(entered.promise, first, 'initial lease preparation')
      const reason = new Error('cancel exact acquisition')
      const alreadyAborted = new AbortController()
      alreadyAborted.abort(reason)
      expect(await supervisedTestWait(manager.ensureHost({ lease: supervisedLease, abortSignal: alreadyAborted.signal })
        .catch(error => error), 'already aborted queue entry', 1000)).toBe(reason)
      const queued = manager.ensureHost({ lease: supervisedLease, abortSignal: queuedAbort.signal }).catch(error => error)
      queuedAbort.abort(reason)
      expect(await supervisedTestWait(queued, 'queued cancellation', 1000)).toBe(reason)
      const expired = await supervisedTestWait(manager.ensureHost({ lease: supervisedLease, healthTimeoutMs: 25 })
        .catch(error => error), 'queued deadline', 1000)
      expect(expired).toBeInstanceOf(OpenCodeRuntimeDeadlineError)
      const successor = manager.ensureHost({ lease: supervisedLease, abortSignal: successorAbort.signal }).catch(error => error)
      // Give every queued continuation a turn while the first acquisition is live.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(leaseCalls).toBe(1)
      expect(fixture.requests).toHaveLength(0)
      firstAbort.abort(reason)
      expect(await supervisedTestWait(first, 'stalled acquisition cancellation', 1000)).toBe(reason)
      const host = await supervisedTestWait(successor, 'successor with abandoned lease provider', 30_000)
      expect(host).not.toBeInstanceOf(Error)
      expect(host.custody).toBe('supervisor')
      expect(lateConsumes).toBe(0)
      held.release()
      await supervisedTestWait(consumed.promise, 'late lease cleanup')
      expect(lateConsumes).toBe(1)
      expect(manager.getHost(custody.hostKey)).toBe(host)
      await manager.releaseHostLease(host.hostKey, supervisedLease)
      await manager.releaseHost(host.hostKey)
      expect(manager.getHost(custody.hostKey)).toBeNull()
    } finally {
      firstAbort.abort(); queuedAbort.abort(); successorAbort.abort(); held.release()
      await fixture.close()
    }
  }, 120_000)

  for (const outcome of ['token', 'rejection'] as const) {
    test(`synchronous provider cancellation observes a late ${outcome} without publishing`, async () => {
      const held = gate(), settled = gate(), cleaned = gate()
      const abort = new AbortController()
      const reason = new Error('provider cancelled during preparation')
      const lateFailure = new Error('provider failed after cancellation')
      let consumes = 0
      const fixture = await supervisedFixture({ mutateBundle(bundle) {
        const prepare = bundle.prepareLeaseToken
        bundle.prepareLeaseToken = async lease => {
          // Abort before the provider's first await, so the outer wait receives
          // an already-aborted signal and a still-pending provider promise.
          abort.abort(reason)
          try {
            await held.promise
            if (outcome === 'rejection') throw lateFailure
            const token = await prepare(lease)
            return { consume() { consumes += 1; cleaned.release(); return token?.consume() ?? false } }
          } finally { settled.release() }
        }
      } })
      const unhandled: unknown[] = []
      const observeRejection = (error: unknown) => { unhandled.push(error) }
      process.on('unhandledRejection', observeRejection)
      try {
        const custody = await fixture.acquire()
        const manager = new OpenCodeHostManager({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        const pending = manager.ensureHost({ lease: supervisedLease, abortSignal: abort.signal }).catch(error => error)
        expect(await supervisedTestWait(pending, 'synchronous provider cancellation', 1000)).toBe(reason)
        expect(manager.getHost(custody.hostKey)).toBeNull()
        expect(fixture.requests).toHaveLength(0)
        held.release()
        await supervisedTestWait(settled.promise, 'cancelled provider settlement')
        if (outcome === 'token') await supervisedTestWait(cleaned.promise, 'late provider token cleanup')
        // Let the runtime report unhandled rejections after all promise jobs.
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(unhandled).toEqual([])
        expect(consumes).toBe(outcome === 'token' ? 1 : 0)
        expect(manager.getHost(custody.hostKey)).toBeNull()
        expect(fixture.requests).toHaveLength(0)
      } finally {
        abort.abort(); held.release()
        process.off('unhandledRejection', observeRejection)
        await fixture.close()
      }
    }, 120_000)
  }

  for (const stage of ['profile', 'authority', 'final-lease', 'final-authority'] as const) {
    test(`cancellation abandons ${stage} and consumes any late or retained token`, async () => {
      const entered = gate(), held = gate(), cleaned = gate()
      let enabled = false
      let leaseCalls = 0
      let heldConsumes = 0
      const abort = new AbortController()
      const fixture = await supervisedFixture({ mutateBundle(bundle) {
        const profile = bundle.readPreparedProfile
        const lease = bundle.prepareLeaseToken
        const authority = bundle.prepareEffectToken
        bundle.readPreparedProfile = async () => {
          if (enabled && stage === 'profile') { entered.release(); await held.promise; cleaned.release() }
          return profile()
        }
        const hold = async (token: Awaited<ReturnType<typeof authority>>) => {
          entered.release(); await held.promise
          return { consume() { heldConsumes += 1; cleaned.release(); return token?.consume() ?? false } }
        }
        bundle.prepareLeaseToken = async input => {
          leaseCalls += 1
          const token = await lease(input)
          return enabled && stage === 'final-lease' && leaseCalls === 2 ? hold(token) : token
        }
        bundle.prepareEffectToken = async () => {
          const token = await authority()
          return enabled && (stage === 'authority' || (stage === 'final-authority' && leaseCalls === 2))
            ? hold(token) : token
        }
      } })
      try {
        const custody = await fixture.acquire()
        const manager = new OpenCodeHostManager({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        enabled = true
        const pending = manager.ensureHost({ lease: supervisedLease, abortSignal: abort.signal }).catch(error => error)
        await supervisedTestStage(entered.promise, pending, stage)
        const requests = fixture.requests.length
        const reason = new Error(`cancel during ${stage}`)
        abort.abort(reason)
        expect(await supervisedTestWait(pending, `${stage} cancellation`, 1000)).toBe(reason)
        expect(manager.getHost(custody.hostKey)).toBeNull()
        held.release()
        await supervisedTestWait(cleaned.promise, `${stage} late cleanup`)
        expect(heldConsumes).toBe(stage === 'profile' ? 0 : 1)
        expect(manager.getHost(custody.hostKey)).toBeNull()
        expect(fixture.requests).toHaveLength(requests)
      } finally { abort.abort(); held.release(); await fixture.close() }
    }, 120_000)
  }

  test('an acquisition deadline also bounds a stalled profile without an external abort', async () => {
    const entered = gate(), held = gate()
    let enabled = false
    const fixture = await supervisedFixture({ mutateBundle(bundle) {
      const read = bundle.readPreparedProfile
      bundle.readPreparedProfile = async () => {
        if (enabled) { entered.release(); await held.promise }
        return read()
      }
    } })
    try {
      const custody = await fixture.acquire()
      const manager = new OpenCodeHostManager({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
      enabled = true
      const pending = manager.ensureHost({ lease: supervisedLease, healthTimeoutMs: 100 }).catch(error => error)
      await supervisedTestStage(entered.promise, pending, 'profile deadline preparation')
      expect(await supervisedTestWait(pending, 'profile deadline', 1000)).toBeInstanceOf(OpenCodeRuntimeDeadlineError)
      held.release()
      expect(manager.getHost(custody.hostKey)).toBeNull()
      expect(fixture.requests).toHaveLength(0)
    } finally { held.release(); await fixture.close() }
  }, 120_000)

  for (const path of ['/global/health', '/config', '/config/providers', '/agent', '/mcp',
    '/experimental/agent-teams/hosted-approval-capability']) {
    test(`cancellation reaches the actual ${path} probe and closes its socket`, async () => {
      const entered = gate()
      const abort = new AbortController()
      const fixture = await supervisedFixture({ handle(request, response) {
        if (request.url === path) { entered.release(); return }
        const value = request.url === '/global/health' ? { healthy: true } : request.url === '/agent' ? [] :
          request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
        response.end(canonicalHostedApprovalJson(value))
      } })
      try {
        const custody = await fixture.acquire()
        const manager = new OpenCodeHostManager({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        const pending = manager.ensureHost({ lease: supervisedLease, abortSignal: abort.signal }).catch(error => error)
        await supervisedTestStage(entered.promise, pending, path)
        expect(fixture.requests.at(-1)!.url).toBe(path)
        const accepted = fixture.requests.at(-1)!.connection
        expect(fixture.connections).toHaveLength(fixture.requests.length)
        fixture.assertSocketCustody()
        const count = fixture.requests.length
        const reason = new Error(`cancel ${path}`)
        abort.abort(reason)
        expect(await supervisedTestWait(pending, `${path} cancellation`, 1000)).toBe(reason)
        await supervisedTestWait(accepted.closed, `${path} exact authorized socket close`, 1000)
        expect(fixture.requests).toHaveLength(count)
        expect(manager.getHost(custody.hostKey)).toBeNull()
      } finally { abort.abort(); await fixture.close() }
    }, 120_000)
  }

  test('non-200 config observations never admit a host even when their JSON matches', async () => {
    for (const status of [201, 204, 404]) {
      const fixture = await supervisedFixture({ handle(request, response) {
        if (request.url === '/config') response.statusCode = status
        response.end(canonicalHostedApprovalJson(request.url === '/global/health' ? { healthy: true } : {}))
      } })
      try {
        const custody = await fixture.acquire()
        const manager = new OpenCodeHostManager({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        const failure = await manager.ensureHost({ lease: supervisedLease }).catch(error => error)
        expect(failure).toBeInstanceOf(Error)
        expect(fixture.requests.map(request => request.url)).toEqual(['/global/health', '/config'])
        expect(manager.getHost(custody.hostKey)).toBeNull()
      } finally { await fixture.close() }
    }
  }, 120_000)
})
