import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { nativeAdmissionFixture } from './native-admission.fixture.js'
import { immutableAllocation } from './native-operation-allocation.js'
import { sha256 } from './native-http-contract.js'
import { NativePredecessorObservation, requireNativeAllocationConsumers, requireNativePredecessorObservation,
  verifyNativePredecessorObservation, type NativeRetainedPredecessorData } from './native-allocation-consumers.js'

// Synthetic comparison data; it cannot install itself in either actual boundary.
class FixtureObservation extends NativePredecessorObservation {
  protected readonly nativeIntegrationOrigin = 'independent-retained-successful-return' as const
  constructor(readonly data: NativeRetainedPredecessorData, readonly current = true) { super() }
  readRetained() { return this.data }
  isCurrent() { return this.current }
}
test('retention and permit installation is required and absent actual consumers stay unavailable', () => {
  assert.throws(requireNativeAllocationConsumers, /consumers_unavailable/)
  assert.throws(requireNativePredecessorObservation, /observation_unavailable/)
})
test('generation4 compares independently retained gen3 process/header and successful return, never the new start', () => {
  const statement = nativeAdmissionFixture(4).statement
  const result = statement.predecessorResults.find(r => r.operationId === 'Rretry')!
  const retained = immutableAllocation({ allocationSha256: statement.allocationSha256, generation: 3 as const,
    ownerSessionId: statement.allocation.generations.find(g => g.generation === 3)!.ownerSessionId,
    ownerProcessStartToken: sha256('owner-3'), bootstrapV2HeaderSha256: sha256('header-3'), result })
  verifyNativePredecessorObservation(statement, new FixtureObservation(retained))
  assert.throws(() => verifyNativePredecessorObservation(statement, undefined))
  assert.throws(() => verifyNativePredecessorObservation(statement, { readRetained: () => retained, isCurrent: () => true } as never))
  assert.throws(() => verifyNativePredecessorObservation(statement, new FixtureObservation(retained, false)))
  for (const patch of [{ ownerSessionId: statement.generation.ownerSessionId },
    { ownerProcessStartToken: statement.ownerProcessStartToken }, { allocationSha256: '0'.repeat(64) },
    { bootstrapV2HeaderSha256: '' }, { result: { ...result, returnWitnessSha256: '0'.repeat(64) } },
    { result: { ...result, ownerProcessStartToken: statement.ownerProcessStartToken } }])
    assert.throws(() => verifyNativePredecessorObservation(statement, new FixtureObservation(immutableAllocation({ ...retained, ...patch }))))
  for (const generation of [1, 2, 3] as const) verifyNativePredecessorObservation(nativeAdmissionFixture(generation).statement, undefined)
})
