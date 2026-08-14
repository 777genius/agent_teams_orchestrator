import type { HostedApprovalOwnerState } from '../../../src/services/hostedControl/HostedApprovalOwnerWal.js'
import type { ActualOwnerAcceptanceConfig } from './contracts.js'
import { ACTUAL_OWNER_ACCEPTANCE_PURPOSE } from './contracts.js'

export type ActualOwnerAcceptanceStatus = 'starting' | 'ready' | 'stopping' | 'failed'

export type ActualOwnerAcceptanceEvidence = {
  schemaVersion: 1
  purpose: typeof ACTUAL_OWNER_ACCEPTANCE_PURPOSE
  status: ActualOwnerAcceptanceStatus
  runId: string
  markerPath: string
  refs: { orchestrator: string; openCode: string; product: string }
  artifact: { executable: string; sha256: `sha256:${string}` }
  admission: { path: string; digest: string | null; generation: string | null }
  owner: {
    pid: number
    controlSocket: string
    ownerSocket: string | null
    walPath: string
    walRevision: string | null
    ingressCount: number
    deliveryCount: number
    decisionOperations: readonly ['approval_decision_deliver', 'approval_decision_reconcile']
  }
  failure: string | null
}

export function buildAcceptanceEvidence(input: {
  config: ActualOwnerAcceptanceConfig
  status: ActualOwnerAcceptanceStatus
  admission?: { digest: string; admissionGeneration: string } | null
  ownerSocket?: string | null
  state?: HostedApprovalOwnerState | null
  failure?: string | null
}): ActualOwnerAcceptanceEvidence {
  const state = input.state ?? null
  return Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_ACCEPTANCE_PURPOSE,
    status: input.status,
    runId: input.config.runtime.runId,
    markerPath: input.config.markerPath,
    refs: Object.freeze({
      orchestrator: input.config.runtime.refs.orchestrator,
      openCode: input.config.runtime.refs.openCode,
      product: input.config.runtime.refs.product,
    }),
    artifact: Object.freeze({
      executable: input.config.openCodeExecutable,
      sha256: `sha256:${input.config.openCodeSha256}` as const,
    }),
    admission: Object.freeze({
      path: input.config.admissionFile,
      digest: input.admission?.digest ?? null,
      generation: input.admission?.admissionGeneration ?? null,
    }),
    owner: Object.freeze({
      pid: process.pid,
      controlSocket: input.config.controlSocket,
      ownerSocket: input.ownerSocket ?? null,
      walPath: input.config.walFile,
      walRevision: state?.revision ?? null,
      ingressCount: state?.ingress.length ?? 0,
      deliveryCount: state?.deliveries.length ?? 0,
      decisionOperations: Object.freeze([
        'approval_decision_deliver', 'approval_decision_reconcile',
      ] as const),
    }),
    failure: input.failure ?? null,
  })
}

export function validateAcceptanceEvidence(value: unknown): ActualOwnerAcceptanceEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('acceptance_evidence_invalid')
  const input = value as Record<string, unknown>
  const exact = (record: Record<string, unknown>, keys: readonly string[]) => {
    const actual = Object.keys(record).sort(); const expected = [...keys].sort()
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      throw new Error('acceptance_evidence_invalid')
    }
  }
  exact(input, ['schemaVersion', 'purpose', 'status', 'runId', 'markerPath', 'refs', 'artifact', 'admission', 'owner', 'failure'])
  if (input.schemaVersion !== 1 || input.purpose !== ACTUAL_OWNER_ACCEPTANCE_PURPOSE ||
    !['starting', 'ready', 'stopping', 'failed'].includes(String(input.status)) ||
    typeof input.runId !== 'string' || !/^[0-9a-f]{48}$/.test(input.runId)) {
    throw new Error('acceptance_evidence_invalid')
  }
  const artifact = input.artifact as Record<string, unknown>
  const admission = input.admission as Record<string, unknown>
  const owner = input.owner as Record<string, unknown>
  exact(artifact, ['executable', 'sha256'])
  exact(admission, ['path', 'digest', 'generation'])
  exact(owner, ['pid', 'controlSocket', 'ownerSocket', 'walPath', 'walRevision', 'ingressCount', 'deliveryCount', 'decisionOperations'])
  if (typeof artifact.executable !== 'string' || typeof artifact.sha256 !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(owner.pid) ||
    !Array.isArray(owner.decisionOperations) || owner.decisionOperations.join(',') !==
      'approval_decision_deliver,approval_decision_reconcile') {
    throw new Error('acceptance_evidence_invalid')
  }
  return value as ActualOwnerAcceptanceEvidence
}
