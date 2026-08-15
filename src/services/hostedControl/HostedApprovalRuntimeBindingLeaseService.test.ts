import { describe, expect, test } from 'bun:test'

import fixture from './HostedApprovalTransitionWire.contract.json'
import {
  HostedApprovalRuntimeBindingLeaseService,
  InMemoryHostedApprovalTransitionLedger,
  type HostedApprovalTransitionBindingResolver,
} from './HostedApprovalRuntimeBindingLeaseService.js'
import {
  admitHostedApprovalTransitionDeadline,
  digestHostedApprovalTransitionUnsigned,
  digestHostedApprovalTransitionValue,
  parseHostedApprovalTransitionResponseFrame,
  type HostedApprovalTransitionBinding,
  type HostedApprovalTransitionOperation,
  type HostedApprovalTransitionProductProjection,
  type HostedApprovalTransitionRequest,
} from './HostedApprovalTransitionWire.js'

const secret = Buffer.from(fixture.testOnlyKeyHex, 'hex')
const acquireGolden = JSON.parse(fixture.vectors.find(vector => vector.id === 'P01-acquire-request')!.canonicalUnsigned)
const responseGolden = JSON.parse(fixture.vectors.find(vector => vector.id === 'P02-acquire-response')!.canonicalUnsigned)
const projection = acquireGolden.payload.productProjection as HostedApprovalTransitionProductProjection
const binding = responseGolden.payload.binding as HostedApprovalTransitionBinding

function request<O extends HostedApprovalTransitionOperation>(operation: O, sequence: number, payload: HostedApprovalTransitionRequest<O>['payload'], deadlineAtMs: number): HostedApprovalTransitionRequest<O> {
  return { schemaVersion: 1, transitionId: acquireGolden.transitionId, operation, sequence, deadlineAtMs, payload, ownerProof: '0'.repeat(64) }
}
function input<O extends HostedApprovalTransitionOperation>(value: HostedApprovalTransitionRequest<O>, wall: number) {
  const unsigned = JSON.stringify({ schemaVersion: value.schemaVersion, transitionId: value.transitionId, operation: value.operation, sequence: value.sequence, deadlineAtMs: value.deadlineAtMs, payload: value.payload })
  return { request: value, requestDigest: digestHostedApprovalTransitionUnsigned(unsigned), deadline: admitHostedApprovalTransitionDeadline(value.operation, value.deadlineAtMs, wall, wall) }
}
function decoded(frame: Buffer) { return parseHostedApprovalTransitionResponseFrame(frame, secret).value }

describe('HostedApprovalRuntimeBindingLeaseService', () => {
  test('serializes acquire/consume/assert/release, exact replay and stable release tombstones without provider effects', async () => {
    let now = 1_700_000_000_000; let releases = 0; let reads = 0
    const ledger = new InMemoryHostedApprovalTransitionLedger()
    const resolver: HostedApprovalTransitionBindingResolver = {
      read: async () => { reads += 1; return structuredClone(binding) },
      acquireTeamPin: async () => ({ release: async () => { releases += 1 } }),
      assertCurrent: async () => null,
    }
    const service = new HostedApprovalRuntimeBindingLeaseService({ secret, ledger, bindingResolver: resolver, now: () => now, monotonicNow: () => now, randomBytes: () => Buffer.alloc(16, 0xbb) })
    const acquire = request('acquire', 1, { productProjection: projection, projectionDigest: fixture.projectionDigest }, now + 5_000)
    const acquireInput = input(acquire, now)
    const acquiredFrame = await service.dispatch(acquireInput); const acquired = decoded(acquiredFrame)
    expect('payload' in acquired && acquired.payload.status).toBe('acquired')
    expect((acquired as any).payload).toMatchObject({ leaseId: 'approval-transition-lease_' + 'bb'.repeat(16), generation: 1, expiresAtMs: now + 10_000, bindingDigest: fixture.bindingDigest })
    now += 6_000
    expect(await service.dispatch(acquireInput)).toEqual(acquiredFrame)
    expect(reads).toBe(1)

    const lease = (acquired as any).payload
    const consume = request('consume', 2, { leaseId: lease.leaseId, generation: lease.generation, projectionDigest: fixture.projectionDigest, bindingDigest: fixture.bindingDigest }, now + 5_000)
    const consumed = decoded(await service.dispatch(input(consume, now))) as any
    expect(consumed.payload).toMatchObject({ status: 'consumed', pinnedExpiresAtMs: now + 30_000 })
    const assertion = request('assert', 3, { leaseId: lease.leaseId, generation: lease.generation, bindingDigest: fixture.bindingDigest }, now + 2_000)
    expect((decoded(await service.dispatch(input(assertion, now))) as any).payload).toMatchObject({ current: true, reason: null })
    const release = request('release', 4, { leaseId: lease.leaseId, generation: lease.generation, bindingDigest: fixture.bindingDigest }, now + 5_000)
    const releaseInput = input(release, now)
    const releasedFrame = await service.dispatch(releaseInput)
    const released = decoded(releasedFrame) as any
    expect(released.payload).toMatchObject({ status: 'released', releasedAtMs: now })
    now += 1_000
    expect(await service.dispatch(releaseInput)).toEqual(releasedFrame)
    expect(releases).toBe(1)
  })

  test('fences restart and generation changes and caches retryable errors', async () => {
    let now = 50_000; let currentBinding = structuredClone(binding); let pinAvailable = false
    const ledger = new InMemoryHostedApprovalTransitionLedger()
    const resolver: HostedApprovalTransitionBindingResolver = {
      read: async () => structuredClone(currentBinding),
      acquireTeamPin: async () => pinAvailable ? { release: async () => undefined } : null,
      assertCurrent: async () => null,
    }
    const service = new HostedApprovalRuntimeBindingLeaseService({ secret, ledger, bindingResolver: resolver, now: () => now, monotonicNow: () => now, randomBytes: () => Buffer.alloc(16, 1) })
    const acquire = request('acquire', 1, { productProjection: projection, projectionDigest: digestHostedApprovalTransitionValue(projection) }, now + 5_000)
    const lease = (decoded(await service.dispatch(input(acquire, now))) as any).payload
    const consume = request('consume', 2, { leaseId: lease.leaseId, generation: lease.generation, projectionDigest: lease.projectionDigest, bindingDigest: lease.bindingDigest }, now + 5_000)
    const busyFrame = await service.dispatch(input(consume, now)); expect((decoded(busyFrame) as any).error.code).toBe('PIN_BUSY')
    expect(await service.dispatch(input(consume, now))).toEqual(busyFrame)
    pinAvailable = true
    const consumeNext = request('consume', 3, consume.payload, now + 5_000)
    expect((decoded(await service.dispatch(input(consumeNext, now))) as any).payload.status).toBe('consumed')
    await service.recoverTeam(projection.stableAuthority.teamId)
    const assertion = request('assert', 4, { leaseId: lease.leaseId, generation: lease.generation, bindingDigest: lease.bindingDigest }, now + 2_000)
    expect((decoded(await service.dispatch(input(assertion, now))) as any).payload).toMatchObject({ current: false, reason: 'owner_restarted' })

    currentBinding = structuredClone(binding); currentBinding.routes[0]!.openCodeBinding.liveEffectFingerprint = '9'.repeat(64)
    const second = { ...acquire, transitionId: `approval-transition_${'2'.repeat(32)}` as string, payload: { productProjection: projection, projectionDigest: digestHostedApprovalTransitionValue(projection) } }
    const secondLease = (decoded(await service.dispatch(input(second, now))) as any).payload
    expect(secondLease.generation).toBeGreaterThan(lease.generation)
  })

  test('fences lease expiry and returns authenticated terminal assert observations for drift', async () => {
    let now = 90_000; let reason: 'process_changed' | null = null; let nonce = 3
    const ledger = new InMemoryHostedApprovalTransitionLedger()
    const resolver: HostedApprovalTransitionBindingResolver = {
      read: async () => structuredClone(binding),
      acquireTeamPin: async () => ({ release: async () => undefined }),
      assertCurrent: async () => reason,
    }
    const service = new HostedApprovalRuntimeBindingLeaseService({ secret, ledger, bindingResolver: resolver, now: () => now, monotonicNow: () => now, randomBytes: () => Buffer.alloc(16, nonce++) })
    const firstId = `approval-transition_${'3'.repeat(32)}`
    const acquire = request('acquire', 1, { productProjection: projection, projectionDigest: fixture.projectionDigest }, now + 5_000)
    acquire.transitionId = firstId
    const lease = (decoded(await service.dispatch(input(acquire, now))) as any).payload
    now += 10_001
    const expiredConsume = request('consume', 2, { leaseId: lease.leaseId, generation: lease.generation, projectionDigest: lease.projectionDigest, bindingDigest: lease.bindingDigest }, now + 5_000)
    expiredConsume.transitionId = firstId
    expect((decoded(await service.dispatch(input(expiredConsume, now))) as any).error.code).toBe('LEASE_EXPIRED')

    const secondId = `approval-transition_${'4'.repeat(32)}`
    const secondAcquire = request('acquire', 1, { productProjection: projection, projectionDigest: fixture.projectionDigest }, now + 5_000)
    secondAcquire.transitionId = secondId
    const secondLease = (decoded(await service.dispatch(input(secondAcquire, now))) as any).payload
    const consume = request('consume', 2, { leaseId: secondLease.leaseId, generation: secondLease.generation, projectionDigest: secondLease.projectionDigest, bindingDigest: secondLease.bindingDigest }, now + 5_000)
    consume.transitionId = secondId
    expect((decoded(await service.dispatch(input(consume, now))) as any).payload.status).toBe('consumed')
    reason = 'process_changed'
    const assertion = request('assert', 3, { leaseId: secondLease.leaseId, generation: secondLease.generation, bindingDigest: secondLease.bindingDigest }, now + 2_000)
    assertion.transitionId = secondId
    expect((decoded(await service.dispatch(input(assertion, now))) as any).payload).toMatchObject({ current: false, reason: 'process_changed' })
  })
})
