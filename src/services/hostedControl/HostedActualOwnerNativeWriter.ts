import { createHash } from 'node:crypto'

import {
  HOSTED_OWNER_PROVENANCE_CONTRACT,
  HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
  HOSTED_OWNER_PROVENANCE_VERSION,
  type OwnerWalMutation,
  type OwnerWalNative,
  type RetainedWalImage,
} from './HostedApprovalOwnerProvenance.js'
import {
  HostedApprovalOwnerWal,
  type HostedApprovalOwnerWalPublishResult,
  type HostedApprovalWriterFenceIdentity,
} from './HostedApprovalOwnerWal.js'

export const HOSTED_ACTUAL_OWNER_CORPUS_PURPOSE =
  'agent-teams.hosted-actual-owner.native-publication/v1' as const
export const HOSTED_ACTUAL_OWNER_MAX_RECORD_BYTES = 40 * 1024 * 1024

const HEX_64 = /^[0-9a-f]{64}$/u
const DECIMAL = /^(?:0|[1-9]\d*)$/u
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

export type HostedActualOwnerClock = Readonly<{
  wallTimeIso: string
  monotonicNs: string
}>

export type HostedActualOwnerLifecycleEvidence = Readonly<{
  sync: Readonly<{ status: 'durable'; clock: HostedActualOwnerClock }>
  seal: Readonly<{ status: 'sealed'; clock: HostedActualOwnerClock }>
  revocation: Readonly<{
    status: 'not-revoked' | 'revoked'
    clock: HostedActualOwnerClock
    reason: string | null
  }>
}>

export type HostedActualOwnerReplacementLineage = Readonly<{
  ownerStartToken: string
  ownerGeneration: string
  predecessorOwnerStartToken: string | null
  predecessorOwnerGeneration: string | null
  replacementReason: 'initial' | 'process-replacement'
}>

type ExactImage = Readonly<{ byteSize: number; sha256: string; base64: string }>

export type HostedActualOwnerNativePublication = Readonly<{
  schemaVersion: 1
  purpose: typeof HOSTED_ACTUAL_OWNER_CORPUS_PURPOSE
  owner: HostedActualOwnerReplacementLineage
  operation: Readonly<{
    request: Readonly<{
      type: 'owner-wal-publish'
      operationNonce: string
      mutation: OwnerWalMutation
      clock: HostedActualOwnerClock
    }>
    result: Readonly<{
      type: 'owner-wal-operation-completed'
      operationNonce: string
      status: 'succeeded'
      cleanup: 'completed'
      publicationStatus: 'published'
      revision: number
      nextStateSha256: string
      clock: HostedActualOwnerClock
    }>
  }>
  pins: Readonly<{
    provenanceContract: typeof HOSTED_OWNER_PROVENANCE_CONTRACT
    provenanceVersion: typeof HOSTED_OWNER_PROVENANCE_VERSION
    provenanceContractSha256: string
    activationRunId: string
    activationControllerNonce: string
    activationStackManifestSha256: string
    producerArtifactManifestSha256: string
    producerModuleSha256: string
    producerExecutableSha256: string
    producerPid: number
    producerStartTicks: string
    producerExecutableDevice: string
    producerExecutableInode: string
    streamDevice: string
    streamInode: string
  }>
  publication: Readonly<{
    predecessor:
      | Readonly<{ kind: 'retained'; image: ExactImage }>
      | Readonly<{
        kind: 'absent'
        proof: Readonly<{
          operationNonce: string
          ownerGeneration: string
          writerFence: HostedApprovalWriterFenceIdentity
        }>
      }>
    final: ExactImage
    receipt: Readonly<{
      status: 'published'
      operationNonce: string
      emissionNonce: string
      sequence: number
      lineSha256: string
      revision: number
      writerFence: HostedApprovalWriterFenceIdentity
      native: OwnerWalNative
    }>
  }>
  lifecycle: HostedActualOwnerLifecycleEvidence
}>

export type HostedActualOwnerNativeWriteRequest = Readonly<{
  operationCompletion: HostedActualOwnerWalOperationCompletion
  owner: HostedActualOwnerReplacementLineage
  requestClock: HostedActualOwnerClock
  resultClock: HostedActualOwnerClock
  lifecycle: HostedActualOwnerLifecycleEvidence
}>

type BoundWalOperationResult = Extract<HostedApprovalOwnerWalPublishResult, { capture: 'bound' }>
declare const hostedActualOwnerWalOperationCompletion: unique symbol
export type HostedActualOwnerWalOperationCompletion = Readonly<{
  type: 'owner-wal-operation-completed'
  status: 'succeeded'
  cleanup: 'completed'
  result: BoundWalOperationResult
  readonly [hostedActualOwnerWalOperationCompletion]: true
}>

const completedWalOperations = new WeakSet<object>()

/**
 * Runs the typed publication inside the outer `HostedApprovalOwnerWal.locked`
 * operation and converts only its successful resolution into corpus evidence.
 * The outer promise resolves after every fallible effect-token and writer-
 * resource cleanup; an inner native receipt is not a substitute for it.
 */
export async function attestHostedActualOwnerWalOperationCompletion(
  wal: HostedApprovalOwnerWal,
  next: Parameters<HostedApprovalOwnerWal['publishMutation']>[1],
  intent: Parameters<HostedApprovalOwnerWal['publishMutation']>[2],
): Promise<HostedActualOwnerWalOperationCompletion> {
  const result = await wal.locked(state => wal.publishMutation(state, next, intent))
  if (result.capture !== 'bound') throw new TypeError('hosted_actual_owner_bound_completion_required')
  const evidence = Object.freeze({
    type: 'owner-wal-operation-completed' as const,
    status: 'succeeded' as const,
    cleanup: 'completed' as const,
    result,
  })
  completedWalOperations.add(evidence)
  return evidence as HostedActualOwnerWalOperationCompletion
}

export interface HostedActualOwnerNativeSink {
  /** The sink must either durably accept all bytes or throw. */
  append(bytes: Uint8Array): void
}

/**
 * Projects the native Owner receipt without weakening it. In particular, P and
 * N remain exact byte images; absence is evidence bound to this operation and
 * writer-fence incarnation rather than an inferred empty predecessor.
 */
export class HostedActualOwnerNativeWriter {
  #sealed = false

  constructor(private readonly sink: HostedActualOwnerNativeSink) {}

  write(request: HostedActualOwnerNativeWriteRequest): HostedActualOwnerNativePublication {
    if (this.#sealed) throw new Error('hosted_actual_owner_writer_sealed')
    const record = buildHostedActualOwnerNativePublication(request)
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
    if (bytes.byteLength > HOSTED_ACTUAL_OWNER_MAX_RECORD_BYTES) {
      throw new RangeError('hosted_actual_owner_publication_record_too_large')
    }
    this.sink.append(bytes)
    return record
  }

  seal(): void { this.#sealed = true }
}

export function buildHostedActualOwnerNativePublication(
  request: HostedActualOwnerNativeWriteRequest,
): HostedActualOwnerNativePublication {
  const completion = request.operationCompletion
  if (!completedWalOperations.has(completion) ||
    completion.type !== 'owner-wal-operation-completed' || completion.status !== 'succeeded' ||
    completion.cleanup !== 'completed' || completion.result.capture !== 'bound') {
    throw new TypeError('hosted_actual_owner_operation_completion_invalid')
  }
  const { publication, state: completedState } = completion.result
  validateClock(request.requestClock, 'request')
  validateClock(request.resultClock, 'result')
  validateLifecycle(request.lifecycle)
  validateLineage(request.owner)
  if (compareClocks(request.requestClock, request.resultClock) > 0 ||
    compareClocks(request.resultClock, request.lifecycle.sync.clock) > 0 ||
    compareClocks(request.lifecycle.sync.clock, request.lifecycle.seal.clock) > 0 ||
    compareClocks(request.lifecycle.seal.clock, request.lifecycle.revocation.clock) > 0) {
    throw new TypeError('hosted_actual_owner_clock_order_invalid')
  }
  const operationNonce = publication.emission.operationNonce
  if (!HEX_64.test(operationNonce) || !HEX_64.test(publication.emission.emissionNonce) ||
    !HEX_64.test(publication.emission.lineSha256)) {
    throw new TypeError('hosted_actual_owner_receipt_invalid')
  }
  const fence = cloneFence(publication.native.fence)
  if (publication.native.revision < 1 || !Number.isSafeInteger(publication.native.revision) ||
    completedState.revision !== publication.native.revision ||
    JSON.stringify(cloneFence(completedState.writerFence)) !== JSON.stringify(fence) ||
    publication.native.stateDelta.nextRevision !== publication.native.revision ||
    publication.native.stateDelta.nextStateSha256 !== publication.next.sha256 ||
    publication.native.wal.sha256 !== publication.next.sha256 ||
    publication.native.wal.byteSize !== publication.next.byteSize ||
    publication.previous.kind === 'absent' &&
      (publication.native.stateDelta.previousRevision !== null ||
        publication.native.stateDelta.previousStateSha256 !== null || publication.native.revision !== 1) ||
    publication.previous.kind === 'retained' &&
      (publication.native.stateDelta.previousStateSha256 !== publication.previous.image.sha256 ||
        publication.native.stateDelta.previousRevision !== publication.native.revision - 1)) {
    throw new TypeError('hosted_actual_owner_native_receipt_mismatch')
  }
  const final = exactImage(publication.next)
  const predecessor = publication.previous.kind === 'retained'
    ? Object.freeze({ kind: 'retained' as const, image: exactImage(publication.previous.image) })
    : Object.freeze({ kind: 'absent' as const, proof: Object.freeze({
      operationNonce,
      ownerGeneration: request.owner.ownerGeneration,
      writerFence: fence,
    }) })
  const producer = publication.emission.producer
  const activation = publication.emission.activation
  const descriptor = publication.emission.descriptor
  if (!TOKEN.test(activation.runId) || !TOKEN.test(activation.controllerNonce) ||
    !HEX_64.test(activation.stackManifestSha256) ||
    !HEX_64.test(producer.artifactManifestSha256) || !HEX_64.test(producer.moduleSha256) ||
    !DECIMAL.test(descriptor.device) || !DECIMAL.test(descriptor.inode) ||
    !Number.isSafeInteger(publication.emission.sequence) || publication.emission.sequence < 0) {
    throw new TypeError('hosted_actual_owner_pins_invalid')
  }
  const expectedStartToken = hostedActualOwnerStartToken({
    pid: producer.pid, startTicks: producer.startTicks, exeDev: producer.exeDev,
    exeIno: producer.exeIno, exeSha256: producer.exeSha256,
  })
  if (request.owner.ownerStartToken !== expectedStartToken) {
    throw new TypeError('hosted_actual_owner_identity_binding_invalid')
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    purpose: HOSTED_ACTUAL_OWNER_CORPUS_PURPOSE,
    owner: structuredClone(request.owner),
    operation: {
      request: { type: 'owner-wal-publish' as const, operationNonce,
        mutation: structuredClone(publication.native.mutation), clock: structuredClone(request.requestClock) },
      result: { type: 'owner-wal-operation-completed' as const, operationNonce,
        status: 'succeeded' as const, cleanup: 'completed' as const,
        publicationStatus: 'published' as const,
        revision: publication.native.revision,
        nextStateSha256: publication.native.stateDelta.nextStateSha256,
        clock: structuredClone(request.resultClock) },
    },
    pins: {
      provenanceContract: HOSTED_OWNER_PROVENANCE_CONTRACT,
      provenanceVersion: HOSTED_OWNER_PROVENANCE_VERSION,
      provenanceContractSha256: HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
      activationRunId: activation.runId,
      activationControllerNonce: activation.controllerNonce,
      activationStackManifestSha256: activation.stackManifestSha256,
      producerArtifactManifestSha256: producer.artifactManifestSha256,
      producerModuleSha256: producer.moduleSha256,
      producerExecutableSha256: producer.exeSha256,
      producerPid: producer.pid,
      producerStartTicks: producer.startTicks,
      producerExecutableDevice: producer.exeDev,
      producerExecutableInode: producer.exeIno,
      streamDevice: descriptor.device,
      streamInode: descriptor.inode,
    },
    publication: {
      predecessor,
      final,
      receipt: {
        status: 'published' as const, operationNonce, emissionNonce: publication.emission.emissionNonce,
        sequence: publication.emission.sequence, lineSha256: publication.emission.lineSha256,
        revision: publication.native.revision, writerFence: fence,
        native: structuredClone(publication.native),
      },
    },
    lifecycle: {
      sync: { status: 'durable' as const, clock: structuredClone(request.lifecycle.sync.clock) },
      seal: { status: 'sealed' as const, clock: structuredClone(request.lifecycle.seal.clock) },
      revocation: { status: request.lifecycle.revocation.status,
        clock: structuredClone(request.lifecycle.revocation.clock),
        reason: request.lifecycle.revocation.reason },
    },
  })
}

export function hostedActualOwnerStartToken(identity: Readonly<{
  pid: number; startTicks: string; exeDev: string; exeIno: string; exeSha256: string
}>): string {
  if (!Number.isSafeInteger(identity.pid) || identity.pid < 1 || !DECIMAL.test(identity.startTicks) ||
    !DECIMAL.test(identity.exeDev) || !DECIMAL.test(identity.exeIno) || !HEX_64.test(identity.exeSha256)) {
    throw new TypeError('hosted_actual_owner_start_identity_invalid')
  }
  return `owner-start_${createHash('sha256').update(JSON.stringify({
    pid: identity.pid, startTicks: identity.startTicks, exeDev: identity.exeDev,
    exeIno: identity.exeIno, exeSha256: identity.exeSha256,
  })).digest('hex')}`
}

function exactImage(image: RetainedWalImage): ExactImage {
  const bytes = Buffer.from(image.bytes)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== image.byteSize || digest !== image.sha256 || !HEX_64.test(image.sha256)) {
    throw new TypeError('hosted_actual_owner_image_invalid')
  }
  return Object.freeze({ byteSize: bytes.byteLength, sha256: digest, base64: bytes.toString('base64') })
}

function cloneFence(value: HostedApprovalWriterFenceIdentity): HostedApprovalWriterFenceIdentity {
  if (!TOKEN.test(value.generation) || !DECIMAL.test(value.dev) || !DECIMAL.test(value.ino)) {
    throw new TypeError('hosted_actual_owner_writer_fence_invalid')
  }
  // Native provenance canonicalizes object keys by byte order.
  return Object.freeze({ dev: value.dev, generation: value.generation, ino: value.ino })
}

function validateLineage(value: HostedActualOwnerReplacementLineage): void {
  if (!TOKEN.test(value.ownerGeneration) ||
    !/^owner-start_[0-9a-f]{64}$/u.test(value.ownerStartToken)) {
    throw new TypeError('hosted_actual_owner_lineage_invalid')
  }
  const initial = value.replacementReason === 'initial'
  if (initial !== (value.predecessorOwnerStartToken === null) ||
    initial !== (value.predecessorOwnerGeneration === null) ||
    !initial && (!/^owner-start_[0-9a-f]{64}$/u.test(value.predecessorOwnerStartToken!) ||
      !TOKEN.test(value.predecessorOwnerGeneration!) ||
      value.predecessorOwnerStartToken === value.ownerStartToken)) {
    throw new TypeError('hosted_actual_owner_lineage_invalid')
  }
}

function validateClock(value: HostedActualOwnerClock, label: string): void {
  if (!DECIMAL.test(value.monotonicNs) || !Number.isFinite(Date.parse(value.wallTimeIso)) ||
    new Date(value.wallTimeIso).toISOString() !== value.wallTimeIso) {
    throw new TypeError(`hosted_actual_owner_${label}_clock_invalid`)
  }
}

function compareClocks(left: HostedActualOwnerClock, right: HostedActualOwnerClock): number {
  const l = BigInt(left.monotonicNs); const r = BigInt(right.monotonicNs)
  return l < r ? -1 : l > r ? 1 : 0
}

function validateLifecycle(value: HostedActualOwnerLifecycleEvidence): void {
  if (value.sync.status !== 'durable' || value.seal.status !== 'sealed' ||
    !['not-revoked', 'revoked'].includes(value.revocation.status) ||
    (value.revocation.status === 'not-revoked') !== (value.revocation.reason === null) ||
    value.revocation.status === 'revoked' &&
      (typeof value.revocation.reason !== 'string' || !TOKEN.test(value.revocation.reason))) {
    throw new TypeError('hosted_actual_owner_lifecycle_invalid')
  }
  validateClock(value.sync.clock, 'sync')
  validateClock(value.seal.clock, 'seal')
  validateClock(value.revocation.clock, 'revocation')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
