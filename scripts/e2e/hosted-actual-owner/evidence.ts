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
    !Number.isSafeInteger(input.sequence) || (input.sequence as number) < 1 ||
    typeof input.at !== 'string' || !Number.isFinite(Date.parse(input.at)) ||
    new Date(input.at).toISOString() !== input.at ||
    typeof input.generation !== 'string' || input.generation.length < 1) {
    throw new Error('timeline_event_invalid')
  }
  const base: ActualOwnerTimelineBase = Object.freeze({
    schemaVersion: 1, runId: input.runId, sequence: input.sequence as number,
    at: input.at, generation: input.generation,
  })
  if (approvalEvent) {
    if (typeof input.approvalId !== 'string' ||
      !/^approval_[A-Za-z0-9._:-]{8,191}$/.test(input.approvalId)) {
      throw new Error('timeline_event_invalid')
    }
    return Object.freeze({ ...base,
      event: input.event as (typeof ACTUAL_OWNER_APPROVAL_TIMELINE_EVENTS)[number],
      approvalId: input.approvalId,
    })
  }
  if (!reconciliationEvent || input.approvalId !== null) throw new Error('timeline_event_invalid')
  return Object.freeze({ ...base,
    event: input.event as (typeof ACTUAL_OWNER_RECONCILIATION_TIMELINE_EVENTS)[number],
    approvalId: null,
  })
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
    executable: string
    executableDevice: string
    executableInode: string
    executableSha256: string
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
  const nested = (candidate: unknown): Record<string, unknown> => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('acceptance_evidence_invalid')
    }
    return candidate as Record<string, unknown>
  }
  exact(input, ['schemaVersion', 'purpose', 'status', 'runId', 'markerPath', 'refs', 'artifact', 'admission', 'publication', 'bootstrap', 'owner', 'providers', 'failure'])
  if (input.schemaVersion !== 1 || input.purpose !== ACTUAL_OWNER_ACCEPTANCE_PURPOSE ||
    !['starting', 'ready', 'stopping', 'failed'].includes(String(input.status)) ||
    typeof input.runId !== 'string' || !/^[0-9a-f]{48}$/.test(input.runId)) {
    throw new Error('acceptance_evidence_invalid')
  }
  const artifact = nested(input.artifact)
  const admission = nested(input.admission)
  const owner = nested(input.owner)
  const publication = nested(input.publication)
  const bootstrap = nested(input.bootstrap)
  const refs = nested(input.refs)
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
  if (typeof input.markerPath !== 'string' || !input.markerPath.startsWith('/') ||
    typeof artifact.executable !== 'string' || !artifact.executable.startsWith('/') ||
    typeof artifact.sha256 !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) < 1 || typeof owner.controlSocket !== 'string' ||
    !owner.controlSocket.startsWith('/') || typeof owner.walPath !== 'string' ||
    !owner.walPath.startsWith('/') || typeof admission.path !== 'string' ||
    !admission.path.startsWith('/') ||
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
    (input.status === 'failed' ? typeof input.failure !== 'string' || input.failure.length < 1 :
      input.failure !== null) ||
    !Array.isArray(input.providers) || (ready && input.providers.length === 0) ||
    (input.providers as unknown[]).some(candidate => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return true
      const provider = candidate as Record<string, unknown>
      exact(provider, ['routeId', 'sessionId', 'sessionRecordFingerprint', 'liveEffectFingerprint',
        'executable', 'executableDevice', 'executableInode', 'executableSha256',
        'pid', 'processStartIdentity', 'processStartedAtMs'])
      return !Number.isSafeInteger(provider.pid) || (provider.pid as number) < 1 ||
        !/^[1-9]\d*$/.test(String(provider.processStartIdentity)) ||
        !Number.isSafeInteger(provider.processStartedAtMs) || (provider.processStartedAtMs as number) < 1 ||
        typeof provider.executable !== 'string' || !provider.executable.startsWith('/') ||
        !/^\d+$/.test(String(provider.executableDevice)) ||
        !/^\d+$/.test(String(provider.executableInode)) ||
        !/^[0-9a-f]{64}$/.test(String(provider.executableSha256)) ||
        !/^[0-9a-f]{64}$/.test(String(provider.sessionRecordFingerprint)) ||
        !/^[0-9a-f]{64}$/.test(String(provider.liveEffectFingerprint)) ||
        provider.executable !== artifact.executable ||
        provider.executableSha256 !== (artifact.sha256 as string).slice('sha256:'.length)
    })) {
    throw new Error('acceptance_evidence_invalid')
  }
  return value as ActualOwnerAcceptanceEvidence
}
