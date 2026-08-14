import type { ActualOwnerAcceptanceConfig } from './contracts.js'
import { ACTUAL_OWNER_ACCEPTANCE_PURPOSE } from './contracts.js'
import type { SecureFileIdentity } from './secure-files.js'
import type { HostedControlBootstrapAdmission } from '../../../src/services/hostedControl/HostedControlBootstrap.js'

export type ActualOwnerAcceptanceStatus = 'starting' | 'ready' | 'stopping' | 'failed'

type ActualOwnerTimelineBase = {
  schemaVersion: 1
  runId: string
  sequence: number
  at: string
  generation: string
}

export const ACTUAL_OWNER_APPROVAL_TIMELINE_EVENTS = Object.freeze([
  'ingress_durable', 'completed', 'rejected', 'stale_generation', 'expired', 'wrong_lane',
  'self_approval', 'unavailable', 'operator_required',
] as const)
export const ACTUAL_OWNER_RECONCILIATION_TIMELINE_EVENTS = Object.freeze([
  'poll_ingress', 'reconcile_delivered', 'reconcile_not_delivered',
  'reconcile_operator_required', 'reconcile_unavailable',
] as const)

export type ActualOwnerProductTimelineEvent =
  | ActualOwnerTimelineBase & {
    event: (typeof ACTUAL_OWNER_APPROVAL_TIMELINE_EVENTS)[number]
    approvalId: string
  }
  | ActualOwnerTimelineBase & {
    event: (typeof ACTUAL_OWNER_RECONCILIATION_TIMELINE_EVENTS)[number]
    approvalId: null
  }

/** Mirrors the product collector's cross-repository owner-WAL event contract. */
export function validateProductTimelineEvent(value: unknown): ActualOwnerProductTimelineEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('timeline_event_invalid')
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).sort().join(',')
  const approvalEvent = typeof input.event === 'string' &&
    (ACTUAL_OWNER_APPROVAL_TIMELINE_EVENTS as readonly string[]).includes(input.event)
  const reconciliationEvent = typeof input.event === 'string' &&
    (ACTUAL_OWNER_RECONCILIATION_TIMELINE_EVENTS as readonly string[]).includes(input.event)
  if (keys !== 'approvalId,at,event,generation,runId,schemaVersion,sequence' || input.schemaVersion !== 1 ||
    typeof input.runId !== 'string' || !/^[0-9a-f]{48}$/.test(input.runId) ||
    (!approvalEvent && !reconciliationEvent) ||
    (approvalEvent && (typeof input.approvalId !== 'string' ||
      !/^approval_[A-Za-z0-9._:-]{8,191}$/.test(input.approvalId))) ||
    (reconciliationEvent && input.approvalId !== null) ||
    !Number.isSafeInteger(input.sequence) || (input.sequence as number) < 0 ||
    typeof input.at !== 'string' || !Number.isFinite(Date.parse(input.at)) ||
    typeof input.generation !== 'string' || input.generation.length < 1) {
    throw new Error('timeline_event_invalid')
  }
  return value as ActualOwnerProductTimelineEvent
}

export type ActualOwnerAcceptanceEvidence = {
  schemaVersion: 1
  purpose: typeof ACTUAL_OWNER_ACCEPTANCE_PURPOSE
  status: ActualOwnerAcceptanceStatus
  runId: string
  markerPath: string
  refs: { orchestrator: string; openCode: string; product: string }
  artifact: { executable: string; sha256: `sha256:${string}` }
  admission: { path: string; digest: string | null; generation: string | null }
  publication: {
    admission: SecureFileIdentity | null
  }
  bootstrap: {
    bootstrapDigest: string | null
    configSha256: string | null
    ownerArtifactDigest: string | null
  }
  owner: {
    pid: number
    processStartIdentity: string
    controlSocket: string
    controlSocketIdentity: SecureFileIdentity | null
    ownerSocket: string | null
    ownerSocketIdentity: SecureFileIdentity | null
    walPath: string
    walIdentity: SecureFileIdentity | null
    walSha256: string | null
    walRevision: number | null
    stateSha256: string | null
    writerFence: { generation: string; dev: string; ino: string } | null
    ingressCount: number
    deliveryCount: number
    decisionOperations: readonly ['approval_decision_deliver', 'approval_decision_reconcile']
  }
  providers: readonly {
    routeId: string
    sessionId: string
    sessionRecordFingerprint: string
    liveEffectFingerprint: string
    pid: number
    processStartIdentity: string
    processStartedAtMs: number
  }[]
  failure: string | null
}

export function buildAcceptanceEvidence(input: {
  config: ActualOwnerAcceptanceConfig
  status: ActualOwnerAcceptanceStatus
  admission?: { digest: string; admissionGeneration: string } | null
  ownerSocket?: string | null
  ownerProcessStartIdentity?: string
  state?: { revision: number; ingress: readonly unknown[]; deliveries: readonly unknown[];
    writerFence: { generation: string; dev: string; ino: string } } | null
  failure?: string | null
  publication?: {
    admission: SecureFileIdentity
  } | null
  bootstrap?: HostedControlBootstrapAdmission | null
  configSha256?: string | null
  controlSocketIdentity?: SecureFileIdentity | null
  ownerSocketIdentity?: SecureFileIdentity | null
  walIdentity?: SecureFileIdentity | null
  walSha256?: string | null
  stateSha256?: string | null
  providers?: ActualOwnerAcceptanceEvidence['providers']
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
    publication: Object.freeze({
      admission: input.publication?.admission ?? null,
    }),
    bootstrap: Object.freeze({
      bootstrapDigest: input.bootstrap?.bootstrapBinding.bootstrapDigest ?? null,
      configSha256: input.configSha256 ?? null,
      ownerArtifactDigest: input.bootstrap?.bootstrapBinding.ownerArtifactDigest ?? null,
    }),
    owner: Object.freeze({
      pid: process.pid,
      processStartIdentity: input.ownerProcessStartIdentity ?? '0',
      controlSocket: input.config.controlSocket,
      controlSocketIdentity: input.controlSocketIdentity ?? null,
      ownerSocket: input.ownerSocket ?? null,
      ownerSocketIdentity: input.ownerSocketIdentity ?? null,
      walPath: input.config.walFile,
      walIdentity: input.walIdentity ?? null,
      walSha256: input.walSha256 ?? null,
      walRevision: state?.revision ?? null,
      stateSha256: input.stateSha256 ?? null,
      writerFence: state?.writerFence ?? null,
      ingressCount: state?.ingress.length ?? 0,
      deliveryCount: state?.deliveries.length ?? 0,
      decisionOperations: Object.freeze([
        'approval_decision_deliver', 'approval_decision_reconcile',
      ] as const),
    }),
    providers: Object.freeze([...(input.providers ?? [])]),
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
  exact(input, ['schemaVersion', 'purpose', 'status', 'runId', 'markerPath', 'refs', 'artifact', 'admission', 'publication', 'bootstrap', 'owner', 'providers', 'failure'])
  if (input.schemaVersion !== 1 || input.purpose !== ACTUAL_OWNER_ACCEPTANCE_PURPOSE ||
    !['starting', 'ready', 'stopping', 'failed'].includes(String(input.status)) ||
    typeof input.runId !== 'string' || !/^[0-9a-f]{48}$/.test(input.runId)) {
    throw new Error('acceptance_evidence_invalid')
  }
  const artifact = input.artifact as Record<string, unknown>
  const admission = input.admission as Record<string, unknown>
  const owner = input.owner as Record<string, unknown>
  const publication = input.publication as Record<string, unknown>
  const bootstrap = input.bootstrap as Record<string, unknown>
  const refs = input.refs as Record<string, unknown>
  exact(artifact, ['executable', 'sha256'])
  exact(admission, ['path', 'digest', 'generation'])
  exact(owner, ['pid', 'processStartIdentity', 'controlSocket', 'controlSocketIdentity', 'ownerSocket',
    'ownerSocketIdentity', 'walPath', 'walIdentity', 'walSha256', 'walRevision', 'stateSha256',
    'writerFence', 'ingressCount', 'deliveryCount', 'decisionOperations'])
  exact(publication, ['admission'])
  exact(bootstrap, ['bootstrapDigest', 'configSha256', 'ownerArtifactDigest'])
  exact(refs, ['orchestrator', 'openCode', 'product'])
  const identity = (candidate: unknown): boolean => candidate === null || !!candidate &&
    typeof candidate === 'object' && !Array.isArray(candidate) && (() => {
      const value = candidate as Record<string, unknown>
      exact(value, ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink', 'uid'])
      return Object.values(value).every(part => typeof part === 'string' && /^\d+$/.test(part))
    })()
  const writerFence = owner.writerFence as Record<string, unknown> | null
  const ready = input.status === 'ready'
  if (typeof artifact.executable !== 'string' || typeof artifact.sha256 !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(owner.pid) ||
    !Array.isArray(owner.decisionOperations) || owner.decisionOperations.join(',') !==
      'approval_decision_deliver,approval_decision_reconcile' ||
    !/^\d+$/.test(String(owner.processStartIdentity)) ||
    !identity(owner.controlSocketIdentity) || !identity(owner.ownerSocketIdentity) ||
    !identity(owner.walIdentity) || !identity(publication.admission) ||
    !Object.values(refs).every(ref => typeof ref === 'string' && /^[0-9a-f]{40}$/.test(ref)) ||
    (writerFence !== null && (() => {
      exact(writerFence, ['generation', 'dev', 'ino'])
      return !/^approval-writer-fence_[0-9a-f]{32}$/.test(String(writerFence.generation)) ||
        !/^\d+$/.test(String(writerFence.dev)) || !/^\d+$/.test(String(writerFence.ino))
    })()) ||
    (ready && (typeof admission.digest !== 'string' || !/^[0-9a-f]{64}$/.test(admission.digest) ||
      typeof admission.generation !== 'string' || admission.generation.length < 1 ||
      publication.admission === null || !/^[0-9a-f]{64}$/.test(String(bootstrap.bootstrapDigest)) ||
      !/^[0-9a-f]{64}$/.test(String(bootstrap.configSha256)) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(bootstrap.ownerArtifactDigest)) ||
      owner.processStartIdentity === '0' || owner.controlSocketIdentity === null ||
      owner.ownerSocketIdentity === null || owner.walIdentity === null || writerFence === null ||
      !/^[0-9a-f]{64}$/.test(String(owner.walSha256)) ||
      !/^[0-9a-f]{64}$/.test(String(owner.stateSha256)))) ||
    !Array.isArray(input.providers) || (input.providers as unknown[]).some(candidate => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return true
      const provider = candidate as Record<string, unknown>
      exact(provider, ['routeId', 'sessionId', 'sessionRecordFingerprint', 'liveEffectFingerprint',
        'pid', 'processStartIdentity', 'processStartedAtMs'])
      return !Number.isSafeInteger(provider.pid) || !/^\d+$/.test(String(provider.processStartIdentity)) ||
        !Number.isSafeInteger(provider.processStartedAtMs) ||
        !/^[0-9a-f]{64}$/.test(String(provider.sessionRecordFingerprint)) ||
        !/^[0-9a-f]{64}$/.test(String(provider.liveEffectFingerprint))
    })) {
    throw new Error('acceptance_evidence_invalid')
  }
  return value as ActualOwnerAcceptanceEvidence
}
