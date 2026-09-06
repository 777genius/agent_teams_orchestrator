import { createHash } from 'node:crypto'
import type { HostedApprovalOwnerService } from '../../../src/services/hostedControl/HostedApprovalOwnerService.js'
import type { HostedApprovalWirePort } from '../../../src/services/hostedControl/HostedApprovalWire.js'
import type { ActualOwnerProductTimelineEvent } from './evidence.js'

export function approvalIdForRecord(record: { authority: { teamId: string; runId: string }; commandId: string }): string {
  return `approval_${createHash('sha256').update(JSON.stringify({
    schemaVersion: 1, teamId: record.authority.teamId,
    runId: record.authority.runId, requestId: record.commandId,
  })).digest('hex').slice(0, 32)}`
}
export class EvidenceApprovalPort implements HostedApprovalWirePort {
  constructor(
    readonly service: HostedApprovalOwnerService,
    private readonly changed: (
      event: ActualOwnerProductTimelineEvent['event'], approvalId: string | null,
      requestId: string | null, effectId: string | null,
      reconciliation?: { reconciliationRef: string; providerDeliveryId: string; runId: string },
    ) => Promise<void>,
  ) {}
  async claimIngress(input: Parameters<HostedApprovalWirePort['claimIngress']>[0]) {
    const result = await this.service.claimIngress(input)
    for (const record of result) {
      await this.changed('ingress_durable', approvalIdForRecord(record), record.commandId, record.effectRef)
    }
    return result
  }
  acknowledgeIngress(request: Parameters<HostedApprovalWirePort['acknowledgeIngress']>[0]) { return this.service.acknowledgeIngress(request) }
  getAdmittedIngressAuthority(authority: Parameters<HostedApprovalWirePort['getAdmittedIngressAuthority']>[0]) { return this.service.getAdmittedIngressAuthority(authority) }
  resolveIngressAuthority(authority: Parameters<HostedApprovalWirePort['resolveIngressAuthority']>[0]) { return this.service.resolveIngressAuthority(authority) }
  authorizeDecision(input: Parameters<HostedApprovalWirePort['authorizeDecision']>[0]) { return this.service.authorizeDecision(input) }
  async deliverDecision(input: Parameters<HostedApprovalWirePort['deliverDecision']>[0]) {
    const result = await this.service.deliverDecision(input)
    const event = result.status === 'delivered' || result.status === 'idempotent_replay'
      ? input.request.decision === 'allow' ? 'completed' : 'rejected'
      : 'decision_committed'
    await this.changed(event, input.request.approvalId, input.request.requestId, null)
    return result
  }
  async reconcileDecision(request: Parameters<HostedApprovalWirePort['reconcileDecision']>[0]) {
    const result = await this.service.reconcileDecision(request)
    await this.changed(`reconcile_${result.status}`, null, null, null, {
      reconciliationRef: request.reconciliationRef, providerDeliveryId: request.providerDeliveryId,
      runId: request.partition.runId,
    })
    return result
  }
}
