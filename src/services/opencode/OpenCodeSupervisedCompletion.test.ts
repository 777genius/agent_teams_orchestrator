import { describe, expect, test } from 'bun:test'
import { OpenCodeClientFactory, OpenCodeRequestNotDispatchedError } from './OpenCodeClientFactory.js'
import { supervisedFixture, supervisedTestStage, supervisedTestWait } from './OpenCodeSupervisedCustody.test-fixture.js'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

describe.skipIf(process.platform !== 'linux')('actual supervised client completion', () => {
  test('revoked custody never invokes another lease or operation preparation', async () => {
    let preparations = 0
    const fixture = await supervisedFixture({ mutateBundle(bundle) {
      bundle.prepareLeaseToken = bundle.prepareOperationToken = async () => {
        preparations++
        return { consume: () => true }
      }
    } })
    try {
      const custody = await fixture.acquire()
      await custody.closeOwnerResources()
      expect(await custody.prepareOperationToken({ kind: 'capability' })).toBeNull()
      expect(await custody.prepareLeaseToken({ teamId: 'team_test', memberName: 'worker' })).toBeNull()
      expect(preparations).toBe(0)
    } finally { await fixture.close() }
  }, 120_000)

  test('shutdown waits for an abort-raced authority preparation and consumes its late token', async () => {
    const entered = barrier(), release = barrier()
    let consumed = 0, bundleClosed = false
    const fixture = await supervisedFixture({ mutateBundle(bundle) {
      bundle.prepareOperationToken = async () => {
        entered.release()
        await release.promise
        return { consume() { consumed++; return true } }
      }
      bundle.closeOwnerResources = async () => { bundleClosed = true }
    } })
    let custody: Awaited<ReturnType<typeof fixture.acquire>> | undefined
    try {
      custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      const exchange = client.getHealth().catch(error => error)
      await supervisedTestStage(entered.promise, exchange, 'operation preparation')
      const closing = custody.closeOwnerResources()
      await Promise.resolve(); await Promise.resolve()
      expect(bundleClosed).toBe(false)
      expect(consumed).toBe(0)
      expect(fixture.connections).toHaveLength(0)
      release.release()
      expect(await supervisedTestWait(exchange, 'late preparation cleanup')).toBeInstanceOf(OpenCodeRequestNotDispatchedError)
      await supervisedTestWait(closing, 'bundle release')
      expect(consumed).toBe(1)
      expect(bundleClosed).toBe(true)
      expect(fixture.requests).toHaveLength(0)
    } finally { release.release(); await custody?.closeOwnerResources(); await fixture.close() }
  }, 120_000)

  test('close waits for abandoned request identity and its real before-end failure sync', async () => {
    const requestSync = barrier(), finishRequest = barrier()
    const failureSync = barrier(), finishFailure = barrier()
    let bundleClosed = false
    const fixture = await supervisedFixture({
      async sync(observation) {
        if (observation?.phase === 'request') { requestSync.release(); await finishRequest.promise }
        if (observation?.phase === 'failure') { failureSync.release(); await finishFailure.promise }
      },
      mutateBundle(bundle) { bundle.closeOwnerResources = async () => { bundleClosed = true } },
    })
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      const exchange = client.getHostedApprovalCapability!().catch(error => error)
      await supervisedTestStage(requestSync.promise, exchange, 'request sync')
      let closed = false
      const closing = custody.closeOwnerResources().then(() => { closed = true })
      expect(custody.closeOwnerResources()).toBe(custody.closeOwnerResources())
      expect(closed).toBe(false)
      expect(bundleClosed).toBe(false)
      finishRequest.release()
      await supervisedTestStage(failureSync.promise, exchange, 'failure sync')
      expect(closed).toBe(false)
      expect(bundleClosed).toBe(false)
      expect(fixture.requests).toHaveLength(0)
      const request = fixture.observations.find(record => record.phase === 'request')
      const failure = fixture.observations.find(record => record.phase === 'failure')
      expect(request).toBeDefined()
      expect(failure).toMatchObject({ phase: 'failure', failure: { phase: 'before-end' },
        request: { ownerExchangeNonce: request!.phase === 'request' ? request!.binding.ownerExchangeNonce : '' } })
      expect(fixture.observations.some(record => record.phase === 'response')).toBe(false)
      finishFailure.release()
      expect(await supervisedTestWait(exchange, 'exchange completion')).toBeInstanceOf(OpenCodeRequestNotDispatchedError)
      await supervisedTestWait(closing, 'custody close')
      expect(bundleClosed).toBe(true)
    } finally {
      finishRequest.release(); finishFailure.release()
      await fixture.close()
    }
  }, 120_000)

  test('socket result persistence finishes before raw sealing and bundle release', async () => {
    const responseSync = barrier(), finishResponse = barrier()
    let bundleClosed = false
    const fixture = await supervisedFixture({
      async sync(observation) {
        if (observation?.phase === 'response') { responseSync.release(); await finishResponse.promise }
      },
      mutateBundle(bundle) { bundle.closeOwnerResources = async () => { bundleClosed = true } },
    })
    try {
      const custody = await fixture.acquire()
      const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
        .create(fixture.expected.endpoint.baseUrl)
      const exchange = client.getHostedApprovalCapability!().catch(error => error)
      await supervisedTestStage(responseSync.promise, exchange, 'response persistence')
      const before = fixture.observations.find(record => record.phase === 'response')
      expect(before).toMatchObject({ status: 200, complete: true })
      let closed = false
      const closing = custody.closeOwnerResources().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      expect(bundleClosed).toBe(false)
      finishResponse.release()
      await supervisedTestWait(exchange, 'exchange completion')
      await supervisedTestWait(closing, 'custody close')
      expect(bundleClosed).toBe(true)
      expect(fixture.observations.find(record => record.phase === 'response')).toBe(before)
      expect(fixture.observations.filter(record => record.phase === 'failure').every(record =>
        record.phase === 'failure' && record.failure.phase === 'end-attempted')).toBe(true)
    } finally { finishResponse.release(); await fixture.close() }
  }, 120_000)
})
