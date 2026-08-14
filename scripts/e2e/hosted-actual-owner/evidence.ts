import type { ActualOwnerAcceptanceConfig } from './contracts.js'
import { ACTUAL_OWNER_ACCEPTANCE_PURPOSE } from './contracts.js'
import type { SecureFileIdentity } from './secure-files.js'
import type { HostedControlBootstrapAdmission } from '../../../src/services/hostedControl/HostedControlBootstrap.js'

export type ActualOwnerAcceptanceStatus = 'starting' | 'ready' | 'stopping' | 'failed'

type ActualOwnerTimelineBase = {
  schemaVersion: 1
  at: string
  routeId: string
  sessionId: string
  runId: string
  generation: string
  requestId: string | null
  effectId: string | null
  sequence: number
}

export const ACTUAL_OWNER_APPROVAL_TIMELINE_EVENTS = Object.freeze([
  'completed', 'decision_committed', 'ingress_durable', 'pending_durable',
  'pending_durable_after_restart', 'permission_settled', 'reconciled_terminal', 'rejected',
] as const)
export const ACTUAL_OWNER_RECONCILIATION_TIMELINE_EVENTS = Object.freeze([
  'poll_ingress', 'reconcile_delivered', 'reconcile_not_delivered',
  'reconcile_operator_required', 'reconcile_unavailable',
] as const)
const PRODUCT_RESTART_CHECKPOINTS = Object.freeze([
  'after_owner_ingress_before_product_ack', 'after_product_pending_before_decision',
  'after_product_decision_before_owner_delivery',
  'after_owner_completion_before_product_reconciliation',
] as const)
const PRODUCT_NEGATIVE_OUTCOMES = Object.freeze({
  stale_identity: 'stale', artifact_rotation: 'stale', process_rotation: 'stale',
  session_rotation: 'stale', http_401: 'unavailable', http_404: 'unavailable',
  redirect: 'unavailable', http_5xx: 'unavailable', timeout: 'unavailable',
  reset: 'unavailable', malformed_response: 'unavailable',
} as const)

type ProductRestartEvent = `restart_checkpoint:${(typeof PRODUCT_RESTART_CHECKPOINTS)[number]}`
type ProductNegativeCase = keyof typeof PRODUCT_NEGATIVE_OUTCOMES
type ProductNegativeEvent = `negative_observed:${ProductNegativeCase}:${
  (typeof PRODUCT_NEGATIVE_OUTCOMES)[ProductNegativeCase]}`
type ProductApprovalEvent = (typeof ACTUAL_OWNER_APPROVAL_TIMELINE_EVENTS)[number] |
  ProductRestartEvent | ProductNegativeEvent

export type ActualOwnerProductTimelineEvent =
  | ActualOwnerTimelineBase & {
    event: ProductApprovalEvent
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
  const restart = typeof input.event === 'string' ? /^restart_checkpoint:(.+)$/.exec(input.event) : null
  const negative = typeof input.event === 'string'
    ? /^negative_observed:([^:]+):([^:]+)$/.exec(input.event) : null
  const approvalEvent = typeof input.event === 'string' && (
    (ACTUAL_OWNER_APPROVAL_TIMELINE_EVENTS as readonly string[]).includes(input.event) ||
    !!restart && (PRODUCT_RESTART_CHECKPOINTS as readonly string[]).includes(restart[1]!) ||
    !!negative && PRODUCT_NEGATIVE_OUTCOMES[negative[1] as ProductNegativeCase] === negative[2])
  const reconciliationEvent = typeof input.event === 'string' &&
    (ACTUAL_OWNER_RECONCILIATION_TIMELINE_EVENTS as readonly string[]).includes(input.event)
  if (keys !== 'approvalId,at,effectId,event,generation,requestId,routeId,runId,schemaVersion,sequence,sessionId' ||
    input.schemaVersion !== 1 ||
    typeof input.runId !== 'string' || !/^[0-9a-f]{48}$/.test(input.runId) ||
    (!approvalEvent && !reconciliationEvent) ||
    !Number.isSafeInteger(input.sequence) || (input.sequence as number) < 0 ||
    typeof input.at !== 'string' || !Number.isFinite(Date.parse(input.at)) ||
    new Date(input.at).toISOString() !== input.at ||
    typeof input.generation !== 'string' ||
    !/^generation_[A-Za-z0-9._-]{1,128}$/.test(input.generation) ||
    typeof input.routeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.routeId) ||
    typeof input.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.sessionId)) {
    throw new Error('timeline_event_invalid')
  }
  if (approvalEvent) {
    if (typeof input.approvalId !== 'string' ||
      !/^approval_[A-Za-z0-9._:-]{8,191}$/.test(input.approvalId) ||
      typeof input.requestId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.requestId) ||
      input.effectId !== null && (typeof input.effectId !== 'string' || input.effectId.length < 1)) {
      throw new Error('timeline_event_invalid')
    }
    return Object.freeze({
      schemaVersion: 1, at: input.at, routeId: input.routeId, sessionId: input.sessionId,
      runId: input.runId, generation: input.generation, approvalId: input.approvalId,
      requestId: input.requestId, effectId: input.effectId,
      event: input.event as ProductApprovalEvent, sequence: input.sequence as number,
    })
  }
  if (!reconciliationEvent || input.approvalId !== null || input.requestId !== null ||
    input.effectId !== null) throw new Error('timeline_event_invalid')
  return Object.freeze({
    schemaVersion: 1, at: input.at, routeId: input.routeId, sessionId: input.sessionId,
    runId: input.runId, generation: input.generation, approvalId: null, requestId: null,
    effectId: null, event: input.event as (typeof ACTUAL_OWNER_RECONCILIATION_TIMELINE_EVENTS)[number],
    sequence: input.sequence as number,
  })
}

/** Exact product-owned field order used for the shared raw NDJSON bytes. */
export function productTimelineLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(validateProductTimelineEvent(value))}\n`)
}

export type ActualOwnerAcceptanceEvidence = {
  schemaVersion: 1
  purpose: typeof ACTUAL_OWNER_ACCEPTANCE_PURPOSE
  status: ActualOwnerAcceptanceStatus
  runId: string
  markerPath: string
  refs: { orchestrator: string; openCode: string; product: string }
  artifact: { executable: string; sha256: `sha256:${string}` }
  contract: {
    path: string
    sha256: string
    byteCount: number
    identity: SecureFileIdentity
    sourceCommit: string
    repositoryPath: string
  }
  admission: { path: string; digest: string | null; generation: string | null }
  publication: {
    admission: SecureFileIdentity | null
  }
  bootstrap: {
    bootstrapDigest: string | null
    configSha256: string | null
    ownerArtifactDigest: string | null
  }
  timeline: {
    path: string
    identity: SecureFileIdentity | null
    sha256: string | null
    bytes: number
    eventCount: number
    lastSequence: number | null
    authority: {
      productRef: string
      productContractSha256: string
      productContractByteCount: number
      productContractIdentity: SecureFileIdentity
      runtimeManifestSha256: string
      runtimeManifestIdentity: SecureFileIdentity
    }
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
  timeline?: Omit<ActualOwnerAcceptanceEvidence['timeline'], 'path' | 'authority'>
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
    contract: Object.freeze({
      path: input.config.runtime.contract.path,
      sha256: input.config.productContract.sha256,
      byteCount: input.config.productContract.byteCount,
      identity: input.config.productContract.identity,
      sourceCommit: input.config.runtime.contract.sourceCommit,
      repositoryPath: input.config.runtime.contract.repositoryPath,
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
    timeline: Object.freeze({
      path: input.config.runtime.capture.ownerWalTimelinePath,
      identity: input.timeline?.identity ?? null,
      sha256: input.timeline?.sha256 ?? null,
      bytes: input.timeline?.bytes ?? 0,
      eventCount: input.timeline?.eventCount ?? 0,
      lastSequence: input.timeline?.lastSequence ?? null,
      authority: Object.freeze({
        productRef: input.config.runtime.refs.product,
        productContractSha256: input.config.productContract.sha256,
        productContractByteCount: input.config.productContract.byteCount,
        productContractIdentity: input.config.productContract.identity,
        runtimeManifestSha256: input.config.runtimeManifestSha256,
        runtimeManifestIdentity: input.config.runtimeManifestIdentity,
      }),
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
  exact(input, ['schemaVersion', 'purpose', 'status', 'runId', 'markerPath', 'refs', 'artifact', 'contract',
    'admission', 'publication', 'bootstrap', 'timeline', 'owner', 'providers', 'failure'])
  if (input.schemaVersion !== 1 || input.purpose !== ACTUAL_OWNER_ACCEPTANCE_PURPOSE ||
    !['starting', 'ready', 'stopping', 'failed'].includes(String(input.status)) ||
    typeof input.runId !== 'string' || !/^[0-9a-f]{48}$/.test(input.runId)) {
    throw new Error('acceptance_evidence_invalid')
  }
  const artifact = nested(input.artifact)
  const contract = nested(input.contract)
  const admission = nested(input.admission)
  const owner = nested(input.owner)
  const publication = nested(input.publication)
  const bootstrap = nested(input.bootstrap)
  const refs = nested(input.refs)
  const timeline = nested(input.timeline)
  const timelineAuthority = nested(timeline.authority)
  exact(artifact, ['executable', 'sha256'])
  exact(contract, ['path', 'sha256', 'byteCount', 'identity', 'sourceCommit', 'repositoryPath'])
  exact(admission, ['path', 'digest', 'generation'])
  exact(owner, ['pid', 'processStartIdentity', 'controlSocket', 'controlSocketIdentity', 'ownerSocket',
    'ownerSocketIdentity', 'walPath', 'walIdentity', 'walSha256', 'walRevision', 'stateSha256',
    'writerFence', 'ingressCount', 'deliveryCount', 'decisionOperations'])
  exact(publication, ['admission'])
  exact(bootstrap, ['bootstrapDigest', 'configSha256', 'ownerArtifactDigest'])
  exact(refs, ['orchestrator', 'openCode', 'product'])
  exact(timeline, ['path', 'identity', 'sha256', 'bytes', 'eventCount', 'lastSequence', 'authority'])
  exact(timelineAuthority, ['productRef', 'productContractSha256', 'productContractByteCount',
    'productContractIdentity', 'runtimeManifestSha256', 'runtimeManifestIdentity'])
  const identity = (candidate: unknown): boolean => candidate === null || !!candidate &&
    typeof candidate === 'object' && !Array.isArray(candidate) && (() => {
      const value = candidate as Record<string, unknown>
      exact(value, ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink', 'uid'])
      return Object.values(value).every(part => typeof part === 'string' && /^\d+$/.test(part))
    })()
  const writerFence = owner.writerFence as Record<string, unknown> | null
  const ready = input.status === 'ready'
  const providerKeys = Array.isArray(input.providers) ? (input.providers as Record<string, unknown>[])
    .map(provider => `${String(provider.routeId)}\0${String(provider.sessionId)}`) : []
  if (typeof input.markerPath !== 'string' || !input.markerPath.startsWith('/') ||
    typeof artifact.executable !== 'string' || !artifact.executable.startsWith('/') ||
    typeof artifact.sha256 !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(owner.pid) ||
    typeof contract.path !== 'string' || !contract.path.startsWith('/') ||
    !/^[0-9a-f]{64}$/.test(String(contract.sha256)) ||
    !Number.isSafeInteger(contract.byteCount) || (contract.byteCount as number) < 2 ||
    !identity(contract.identity) || contract.sourceCommit !== refs.product ||
    contract.repositoryPath !== 'scripts/e2e/hosted-actual-owner/actual-owner-contract.v1.json' ||
    (owner.pid as number) < 1 || typeof owner.controlSocket !== 'string' ||
    !owner.controlSocket.startsWith('/') || typeof owner.walPath !== 'string' ||
    !owner.walPath.startsWith('/') || typeof admission.path !== 'string' ||
    !admission.path.startsWith('/') ||
    !Array.isArray(owner.decisionOperations) || owner.decisionOperations.join(',') !==
      'approval_decision_deliver,approval_decision_reconcile' ||
    !/^\d+$/.test(String(owner.processStartIdentity)) ||
    !identity(owner.controlSocketIdentity) || !identity(owner.ownerSocketIdentity) ||
    !identity(owner.walIdentity) || !identity(publication.admission) || !identity(timeline.identity) ||
    !identity(timelineAuthority.runtimeManifestIdentity) || !identity(timelineAuthority.productContractIdentity) ||
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
      !/^[0-9a-f]{64}$/.test(String(owner.stateSha256)) ||
      timeline.identity === null || !/^[0-9a-f]{64}$/.test(String(timeline.sha256)) ||
      !Number.isSafeInteger(timeline.bytes) || (timeline.bytes as number) < 1 ||
      !Number.isSafeInteger(timeline.eventCount) || (timeline.eventCount as number) < 1 ||
      !Number.isSafeInteger(timeline.lastSequence) || (timeline.lastSequence as number) < 0 ||
      !Number.isSafeInteger(owner.walRevision) || (owner.walRevision as number) < 0)) ||
    typeof timeline.path !== 'string' || !timeline.path.startsWith('/') ||
    timelineAuthority.productRef !== refs.product ||
    timelineAuthority.productContractSha256 !== contract.sha256 ||
    timelineAuthority.productContractByteCount !== contract.byteCount ||
    !/^[0-9a-f]{64}$/.test(String(timelineAuthority.runtimeManifestSha256)) ||
    !Number.isSafeInteger(owner.ingressCount) || (owner.ingressCount as number) < 0 ||
    !Number.isSafeInteger(owner.deliveryCount) || (owner.deliveryCount as number) < 0 ||
    (input.status === 'failed' ? typeof input.failure !== 'string' || input.failure.length < 1 :
      input.failure !== null) ||
    !Array.isArray(input.providers) || (ready && input.providers.length === 0) ||
    new Set(providerKeys).size !== providerKeys.length ||
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
        typeof provider.routeId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(provider.routeId) ||
        typeof provider.sessionId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(provider.sessionId) ||
        provider.executable !== artifact.executable ||
        provider.executableSha256 !== (artifact.sha256 as string).slice('sha256:'.length)
    })) {
    throw new Error('acceptance_evidence_invalid')
  }
  return value as ActualOwnerAcceptanceEvidence
}
