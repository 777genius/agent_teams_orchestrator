/** Required future native integrations. These nominal data interfaces are NOT
 * proof. No constructor, caller callback, JSON, environment or default adapter
 * installs authority. Concrete retained custody and atomic permits are later work. */
import type { HostedControlBootstrapAdmissionV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2.js'
import type { HostedHttpOperation, OpenCodeRawRetentionSink } from '../../../src/services/opencode/OpenCodeHostedRawRetention.js'
import type { OpenCodeHostLeaseInput } from '../../../src/services/opencode/OpenCodeHostManager.js'
import type { OneUseFence } from '../../../src/services/opencode/OpenCodeSupervisedHostCustody.js'
import type { NativeAdmissionStatement, NativePredecessorResult } from './native-admission-codec.js'
import type { NativeAllocationSelection, NativeGenerationSelection } from './native-operation-allocation.js'
import { allocationDigest, requireAllocation } from './native-operation-allocation.js'
import { canonicalJson, exactRecord } from './native-http-contract.js'
import type { RetainedProductObservationResults } from './native-operation-results.js'

export type NativeAllocationConsumerSelection = Readonly<{
  allocation: NativeAllocationSelection; allocationSha256: string; generation: NativeGenerationSelection
}>
export abstract class NativeAllocationConsumers {
  protected abstract readonly nativeIntegrationOrigin: 'independent-native-custody'
  abstract readonly retainedResults: RetainedProductObservationResults
  abstract isCurrent(selection: NativeAllocationConsumerSelection): boolean
  /** Must select each record's row/route by its uniquely permitted operation,
   * preserve HTTP v2/private-6510 codecs and retain actual FD8/process custody. */
  abstract openRawRetention(bootstrap: HostedControlBootstrapAdmissionV2,
    selection: NativeAllocationConsumerSelection): Promise<OpenCodeRawRetentionSink>
  abstract prepareLeaseToken(selection: NativeAllocationConsumerSelection, lease: OpenCodeHostLeaseInput): Promise<OneUseFence | null>
  /** No default origin from operation names. Must retain the actual service
   * origin, match uniquely across ALL eligible literal/dependent entries, enforce
   * DAG, maximumUses and replay limits atomically with currentness and dispatch. */
  abstract prepareOperationToken(selection: NativeAllocationConsumerSelection, operation: HostedHttpOperation): Promise<OneUseFence | null>
}
export function requireNativeAllocationConsumers(): NativeAllocationConsumers {
  throw new Error('hosted_owner_v2_native_allocation_consumers_unavailable')
}

export type NativeRetainedPredecessorData = Readonly<{
  allocationSha256: string; generation: 3; ownerSessionId: string;
  ownerProcessStartToken: string; bootstrapV2HeaderSha256: string; result: NativePredecessorResult
}>
export abstract class NativePredecessorObservation {
  protected abstract readonly nativeIntegrationOrigin: 'independent-retained-successful-return'
  /** No selected statement/result is passed to this observer. It must read the
   * previously retained successful gen3 return and executed-process evidence. */
  abstract readRetained(): NativeRetainedPredecessorData
  abstract isCurrent(): boolean
}
export function requireNativePredecessorObservation(): NativePredecessorObservation {
  throw new Error('hosted_owner_v2_native_predecessor_observation_unavailable')
}
/** Data comparison only. Actual admission calls only the required installation
 * above; a synthetic subclass cannot install itself at that boundary. */
export function verifyNativePredecessorObservation(statement: NativeAdmissionStatement,
  observation: NativePredecessorObservation | undefined): void {
  if (statement.generation.generation !== 4) {
    requireAllocation(statement.predecessorResults.length === 0); return
  }
  requireAllocation(observation instanceof NativePredecessorObservation && observation.isCurrent())
  const retained = observation.readRetained()
  exactRecord(retained, ['allocationSha256', 'generation', 'ownerSessionId', 'ownerProcessStartToken', 'bootstrapV2HeaderSha256', 'result'], 'retained_predecessor')
  const previous = statement.allocation.generations.find(g => g.generation === 3)
  requireAllocation(Object.isFrozen(retained) && Object.isFrozen(retained.result) && previous &&
    retained.generation === 3 && retained.ownerSessionId === previous.ownerSessionId &&
    retained.ownerProcessStartToken === retained.result.ownerProcessStartToken &&
    retained.allocationSha256 === statement.allocationSha256 && statement.predecessorResults.length === 1 &&
    canonicalJson([retained.result]) === canonicalJson(statement.predecessorResults))
  allocationDigest(retained.bootstrapV2HeaderSha256)
  requireAllocation(retained.result.ownerProcessStartToken !== statement.ownerProcessStartToken && observation.isCurrent())
}
