import { isDeepStrictEqual } from 'node:util'

import type {
  HostedApprovalAckRequest,
  HostedApprovalAckResult,
  HostedApprovalClaimRequest,
  HostedApprovalIngressRecord,
  HostedApprovalReconciliationRequest,
  HostedApprovalReconciliationResult,
} from './HostedApprovalWire.js'
import { HostedApprovalOwnerWal, type HostedApprovalOwnerState } from './HostedApprovalOwnerWal.js'
import type { HostedApprovalRuntimeAdmission } from './HostedApprovalRuntimeAdmission.js'

export class HostedApprovalOwnerStore {
  constructor(readonly wal: HostedApprovalOwnerWal, private readonly now: () => number = Date.now) {}

  reconcileAdmission(admission: HostedApprovalRuntimeAdmission): Promise<HostedApprovalOwnerState> {
    return this.wal.locked(async state => {
      if (!(await admission.isCurrent())) throw new Error('Hosted approval admission changed during recovery')
      if (state?.admissionDigest === admission.digest &&
        state.admissionGeneration === admission.admissionGeneration &&
        isDeepStrictEqual(state.routes, admission.routes) &&
        isDeepStrictEqual(state.actorMembers, admission.actorMembers)) return state
      const ingress = state?.ingress.filter(record => {
        const oldRoute = state.routes.find(route => isDeepStrictEqual(route.authority, record.authority))
        return !!oldRoute && admission.routes.some(route => isDeepStrictEqual(route, oldRoute))
      }) ?? []
      const activeOutbox = new Set(ingress.map(record => record.outboxId))
      const durableOutbox = new Set((state?.deliveries ?? []).map(delivery => delivery.outboxId))
      const retiredByOutbox = new Map(
        [...(state?.retiredIngress ?? []), ...(state?.ingress ?? [])]
          .filter(record => !activeOutbox.has(record.outboxId) && durableOutbox.has(record.outboxId))
          .map(record => [record.outboxId, record]),
      )
      const retiredIngress = [...retiredByOutbox.values()]
      if (!(await admission.isCurrent())) throw new Error('Hosted approval admission changed during recovery')
      const published = await this.wal.publish(state, {
        schemaVersion: 1, admissionGeneration: admission.admissionGeneration,
        admissionDigest: admission.digest, routes: [...admission.routes],
        actorMembers: { ...admission.actorMembers }, ingress, retiredIngress,
        deliveries: state?.deliveries ?? [],
      })
      if (!(await admission.isCurrent())) throw new Error('Hosted approval admission changed during recovery')
      return published
    })
  }

  admitIngress(admission: HostedApprovalRuntimeAdmission, record: HostedApprovalIngressRecord): Promise<'admitted' | 'replay'> {
    return this.wal.locked(async state => {
      if (!state || state.admissionDigest !== admission.digest || !(await admission.isCurrent())) throw new Error('Hosted approval admission changed')
      const route = admission.routes.find(route => isDeepStrictEqual(route.authority, record.authority))
      if (!route || !state.routes.some(current => isDeepStrictEqual(current, route))) {
        throw new Error('Hosted approval ingress route unavailable')
      }
      const prior = [...state.ingress, ...state.retiredIngress]
        .find(item => item.outboxId === record.outboxId || item.deliveryRef === record.deliveryRef)
      if (prior) {
        if (!isDeepStrictEqual(intent(prior), intent(record))) throw new Error('Hosted approval ingress conflict')
        return 'replay'
      }
      if (!(await admission.isCurrent())) throw new Error('Hosted approval admission changed')
      await this.wal.publish(state, { ...withoutRevision(state), ingress: [...state.ingress, record] })
      return 'admitted'
    })
  }

  claim(request: HostedApprovalClaimRequest, maximumAggregateBytes: number): Promise<readonly HostedApprovalIngressRecord[]> {
    return this.wal.locked(async state => {
      if (!state) return []
      const now = this.now(); if (!Number.isSafeInteger(now) || now < 0) return []
      const records: HostedApprovalIngressRecord[] = []; let bytes = 2; let stopped = false; let changed = false
      const ingress = state.ingress.map(record => {
        if (stopped || records.length >= request.limit || record.acknowledgedAtIso !== null) return record
        const liveLease = record.lease && Date.parse(record.lease.leaseExpiresAtIso) > now
        if (liveLease) {
          if (record.lease!.ownerId !== request.ownerId || record.lease!.leaseToken !== request.leaseToken) {
            // Ordered prefix: a blocked earlier record fences every later record.
            stopped = true; return record
          }
          const size = Buffer.byteLength(JSON.stringify(record)) + (records.length ? 1 : 0)
          if (bytes + size > maximumAggregateBytes) { stopped = true; return record }
          bytes += size; records.push(record); return record
        }
        const lease = {
          generation: (record.lease?.generation ?? 0) + 1,
          ownerId: request.ownerId, leaseToken: request.leaseToken,
          claimedAtIso: new Date(now).toISOString(),
          leaseExpiresAtIso: new Date(now + request.leaseDurationMs).toISOString(),
        }
        const claimed = { ...record, lease }
        const size = Buffer.byteLength(JSON.stringify(claimed)) + (records.length ? 1 : 0)
        if (bytes + size > maximumAggregateBytes) { stopped = true; return record }
        bytes += size; records.push(claimed); changed = true; return claimed
      })
      if (changed) await this.wal.publish(state, { ...withoutRevision(state), ingress })
      return records
    })
  }

  acknowledge(request: HostedApprovalAckRequest): Promise<HostedApprovalAckResult> {
    return this.wal.locked(async state => {
      if (!state) return { status: 'unavailable' }
      const index = state.ingress.findIndex(record => record.outboxId === request.outboxId)
      if (index < 0) return { status: 'unavailable' }
      const record = state.ingress[index]!
      const lease = record.lease
      // Replay remains fenced to the exact lease; another generation/owner/token cannot harvest it.
      if (record.acknowledgedAtIso !== null) {
        return lease?.generation === request.generation && lease.ownerId === request.ownerId && lease.leaseToken === request.leaseToken
          ? { status: 'already_acknowledged' } : { status: 'conflict' }
      }
      const now = this.now()
      if (!lease || lease.generation !== request.generation || lease.ownerId !== request.ownerId ||
        lease.leaseToken !== request.leaseToken || Date.parse(lease.leaseExpiresAtIso) <= now) return { status: 'conflict' }
      const ingress = [...state.ingress]
      ingress[index] = { ...record, acknowledgedAtIso: new Date(now).toISOString() }
      await this.wal.publish(state, { ...withoutRevision(state), ingress })
      return { status: 'acknowledged' }
    })
  }

  reconcileDecision(
    request: HostedApprovalReconciliationRequest,
  ): Promise<HostedApprovalReconciliationResult> {
    return this.wal.locked(async state => {
      if (!state) return { status: 'unavailable' }
      const matching = state.deliveries.filter(delivery =>
        delivery.providerDeliveryId === request.providerDeliveryId &&
        delivery.reconciliationRef === request.reconciliationRef,
      )
      if (matching.length !== 1) return { status: 'unavailable' }
      const delivery = matching[0]!
      const ingress = [...state.ingress, ...state.retiredIngress]
        .find(record => record.outboxId === delivery.outboxId && record.effectRef === delivery.effectRef)
      if (!ingress || ingress.authority.teamId !== request.partition.teamId ||
        ingress.authority.runId !== request.partition.runId) return { status: 'unavailable' }
      if (delivery.phase === 'started') return { status: 'operator_required' }
      if (delivery.phase === 'completed' && delivery.result === 'delivered') {
        return { status: 'delivered' }
      }
      if (delivery.phase === 'rejected') {
        return { status: 'not_delivered' }
      }
      return { status: 'unavailable' }
    })
  }

  read(): Promise<HostedApprovalOwnerState | null> { return this.wal.read() }
}

export function withoutRevision(state: HostedApprovalOwnerState): Omit<HostedApprovalOwnerState, 'revision' | 'writerFence'> {
  const { revision: _revision, writerFence: _writerFence, ...rest } = state; return rest
}
function intent(record: HostedApprovalIngressRecord): unknown {
  const { lease: _lease, acknowledgedAtIso: _ack, observedAtIso: _observed, acceptedAtIso: _accepted, ...rest } = record
  return rest
}
