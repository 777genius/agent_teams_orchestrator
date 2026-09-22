import { createHash } from 'node:crypto'

import {
  HOSTED_ACTUAL_OWNER_CORPUS_PURPOSE,
  HOSTED_ACTUAL_OWNER_MAX_RECORD_BYTES,
  hostedActualOwnerStartToken,
  type HostedActualOwnerNativePublication,
} from '../services/hostedControl/HostedActualOwnerNativeWriter.js'
import {
  HOSTED_OWNER_PROVENANCE_CONTRACT,
  HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
  HOSTED_OWNER_PROVENANCE_VERSION,
} from '../services/hostedControl/HostedApprovalOwnerProvenance.js'

const HEX_64 = /^[0-9a-f]{64}$/u
const DECIMAL = /^(?:0|[1-9]\d*)$/u
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

export type HostedActualOwnerProductPublication = Readonly<{
  schemaVersion: 1
  ownerGeneration: string
  ownerStartToken: string
  predecessorOwnerStartToken: string | null
  operationNonce: string
  revision: number
  writerFence: Readonly<{ generation: string; dev: string; ino: string }>
  predecessor: Readonly<{ kind: 'absent' | 'retained'; sha256: string | null; byteSize: number | null }>
  final: Readonly<{ sha256: string; byteSize: number }>
  receipt: Readonly<{ status: 'published'; emissionNonce: string; sequence: number; lineSha256: string }>
  lifecycle: Readonly<{ durable: true; sealed: true; revoked: boolean; revocationReason: string | null }>
}>

/** Strictly decodes one canonical corpus line. Unknown, missing, or reordered data fails closed. */
export function parseHostedActualOwnerNativePublication(
  bytes: Uint8Array,
): HostedActualOwnerNativePublication {
  const source = Buffer.from(bytes)
  if (source.byteLength < 3 || source.byteLength > HOSTED_ACTUAL_OWNER_MAX_RECORD_BYTES ||
    source[source.length - 1] !== 0x0a || source.subarray(0, -1).includes(0x0a)) {
    throw new TypeError('hosted_actual_owner_record_framing_invalid')
  }
  let value: unknown
  try { value = JSON.parse(source.subarray(0, -1).toString('utf8')) } catch (error) {
    throw new TypeError('hosted_actual_owner_record_json_invalid', { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    `${JSON.stringify(value)}\n` !== source.toString('utf8')) {
    throw new TypeError('hosted_actual_owner_record_not_canonical')
  }
  validateRecord(value as Record<string, unknown>)
  return deepFreeze(structuredClone(value)) as HostedActualOwnerNativePublication
}

/** Product receives only a complete, revalidated projection; there is no partial mapping. */
export function mapHostedActualOwnerPublicationToProduct(
  value: HostedActualOwnerNativePublication,
): HostedActualOwnerProductPublication {
  const checked = parseHostedActualOwnerNativePublication(Buffer.from(`${JSON.stringify(value)}\n`))
  const p = checked.publication
  return deepFreeze({
    schemaVersion: 1 as const,
    ownerGeneration: checked.owner.ownerGeneration,
    ownerStartToken: checked.owner.ownerStartToken,
    predecessorOwnerStartToken: checked.owner.predecessorOwnerStartToken,
    operationNonce: checked.operation.request.operationNonce,
    revision: p.receipt.revision,
    writerFence: structuredClone(p.receipt.writerFence),
    predecessor: p.predecessor.kind === 'absent'
      ? { kind: 'absent' as const, sha256: null, byteSize: null }
      : { kind: 'retained' as const, sha256: p.predecessor.image.sha256,
        byteSize: p.predecessor.image.byteSize },
    final: { sha256: p.final.sha256, byteSize: p.final.byteSize },
    receipt: { status: 'published' as const, emissionNonce: p.receipt.emissionNonce,
      sequence: p.receipt.sequence, lineSha256: p.receipt.lineSha256 },
    lifecycle: { durable: true as const, sealed: true as const,
      revoked: checked.lifecycle.revocation.status === 'revoked',
      revocationReason: checked.lifecycle.revocation.reason },
  })
}

function validateRecord(v: Record<string, unknown>): void {
  exact(v, ['schemaVersion', 'purpose', 'owner', 'operation', 'pins', 'publication', 'lifecycle'])
  if (v.schemaVersion !== 1 || v.purpose !== HOSTED_ACTUAL_OWNER_CORPUS_PURPOSE) fail()
  const owner = object(v.owner); exact(owner, ['ownerStartToken', 'ownerGeneration',
    'predecessorOwnerStartToken', 'predecessorOwnerGeneration', 'replacementReason'])
  if (typeof owner.ownerStartToken !== 'string' ||
    !/^owner-start_[0-9a-f]{64}$/u.test(owner.ownerStartToken) ||
    typeof owner.ownerGeneration !== 'string' || !TOKEN.test(owner.ownerGeneration)) fail()
  const operation = object(v.operation); exact(operation, ['request', 'result'])
  const request = object(operation.request); const result = object(operation.result)
  exact(request, ['type', 'operationNonce', 'mutation', 'clock'])
  exact(result, ['type', 'operationNonce', 'status', 'cleanup', 'publicationStatus',
    'revision', 'nextStateSha256', 'clock'])
  if (request.type !== 'owner-wal-publish' || result.type !== 'owner-wal-operation-completed' ||
    result.status !== 'succeeded' || result.cleanup !== 'completed' ||
    result.publicationStatus !== 'published' || request.operationNonce !== result.operationNonce ||
    typeof request.operationNonce !== 'string' || !HEX_64.test(request.operationNonce)) fail()
  const requestNs = clock(request.clock); const resultNs = clock(result.clock)
  const pins = object(v.pins); exact(pins, ['provenanceContract', 'provenanceVersion',
    'provenanceContractSha256', 'activationRunId', 'activationControllerNonce',
    'activationStackManifestSha256', 'producerArtifactManifestSha256', 'producerModuleSha256',
    'producerExecutableSha256', 'producerPid', 'producerStartTicks', 'producerExecutableDevice',
    'producerExecutableInode', 'streamDevice', 'streamInode'])
  if (pins.provenanceContract !== HOSTED_OWNER_PROVENANCE_CONTRACT ||
    pins.provenanceVersion !== HOSTED_OWNER_PROVENANCE_VERSION ||
    pins.provenanceContractSha256 !== HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256 ||
    typeof pins.activationRunId !== 'string' || !TOKEN.test(pins.activationRunId) ||
    typeof pins.producerPid !== 'number' ||
    !Number.isSafeInteger(pins.producerPid) || pins.producerPid < 1 ||
    typeof pins.activationControllerNonce !== 'string' || !TOKEN.test(pins.activationControllerNonce)) fail()
  for (const key of ['activationStackManifestSha256', 'producerArtifactManifestSha256',
    'producerModuleSha256', 'producerExecutableSha256'] as const) {
    if (typeof pins[key] !== 'string' || !HEX_64.test(pins[key] as string)) fail()
  }
  for (const key of ['producerStartTicks', 'producerExecutableDevice', 'producerExecutableInode',
    'streamDevice', 'streamInode'] as const) {
    if (typeof pins[key] !== 'string' || !DECIMAL.test(pins[key] as string)) fail()
  }
  if (owner.ownerStartToken !== hostedActualOwnerStartToken({ pid: pins.producerPid as number,
    startTicks: pins.producerStartTicks as string, exeDev: pins.producerExecutableDevice as string,
    exeIno: pins.producerExecutableInode as string, exeSha256: pins.producerExecutableSha256 as string })) fail()
  const publication = object(v.publication); exact(publication, ['predecessor', 'final', 'receipt'])
  const predecessor = object(publication.predecessor)
  const final = image(publication.final)
  const receipt = object(publication.receipt); exact(receipt, ['status', 'operationNonce', 'emissionNonce',
    'sequence', 'lineSha256', 'revision', 'writerFence', 'native'])
  const fence = writerFence(receipt.writerFence)
  if (receipt.status !== 'published' || receipt.operationNonce !== request.operationNonce ||
    typeof receipt.emissionNonce !== 'string' || !HEX_64.test(receipt.emissionNonce) ||
    typeof receipt.lineSha256 !== 'string' || !HEX_64.test(receipt.lineSha256) ||
    !Number.isSafeInteger(receipt.sequence) || (receipt.sequence as number) < 0 ||
    !Number.isSafeInteger(receipt.revision) || (receipt.revision as number) < 1 ||
    result.revision !== receipt.revision || typeof result.nextStateSha256 !== 'string' ||
    !HEX_64.test(result.nextStateSha256)) fail()
  let predecessorSha256: string | null = null
  if (predecessor.kind === 'retained') {
    exact(predecessor, ['kind', 'image']); predecessorSha256 = image(predecessor.image).sha256
  } else if (predecessor.kind === 'absent') {
    exact(predecessor, ['kind', 'proof']); const proof = object(predecessor.proof)
    exact(proof, ['operationNonce', 'ownerGeneration', 'writerFence'])
    if (proof.operationNonce !== request.operationNonce || proof.ownerGeneration !== owner.ownerGeneration ||
      JSON.stringify(writerFence(proof.writerFence)) !== JSON.stringify(fence)) fail()
  } else fail()
  validateNative(receipt.native, request.mutation, fence, receipt.revision as number,
    result.nextStateSha256 as string, final, predecessor.kind, predecessorSha256)
  if (final.sha256.length !== 64) fail()
  const lifecycle = object(v.lifecycle); exact(lifecycle, ['sync', 'seal', 'revocation'])
  const sync = object(lifecycle.sync); const seal = object(lifecycle.seal); const revocation = object(lifecycle.revocation)
  exact(sync, ['status', 'clock']); exact(seal, ['status', 'clock']); exact(revocation, ['status', 'clock', 'reason'])
  const syncNs = clock(sync.clock); const sealNs = clock(seal.clock); const revokeNs = clock(revocation.clock)
  if (sync.status !== 'durable' || seal.status !== 'sealed' ||
    revocation.status !== 'not-revoked' && revocation.status !== 'revoked' ||
    (revocation.status === 'not-revoked') !== (revocation.reason === null) ||
    revocation.status === 'revoked' &&
      (typeof revocation.reason !== 'string' || !TOKEN.test(revocation.reason)) ||
    requestNs > resultNs || resultNs > syncNs || syncNs > sealNs || sealNs > revokeNs) fail()
  if (owner.replacementReason === 'initial') {
    if (owner.predecessorOwnerStartToken !== null || owner.predecessorOwnerGeneration !== null) fail()
  } else if (owner.replacementReason === 'process-replacement') {
    if (typeof owner.predecessorOwnerStartToken !== 'string' ||
      !/^owner-start_[0-9a-f]{64}$/u.test(owner.predecessorOwnerStartToken) ||
      typeof owner.predecessorOwnerGeneration !== 'string' || !TOKEN.test(owner.predecessorOwnerGeneration) ||
      owner.predecessorOwnerStartToken === owner.ownerStartToken) fail()
  } else fail()
}

function image(value: unknown): { byteSize: number; sha256: string } {
  const v = object(value); exact(v, ['byteSize', 'sha256', 'base64'])
  if (!Number.isSafeInteger(v.byteSize) || (v.byteSize as number) < 2 ||
    typeof v.sha256 !== 'string' || !HEX_64.test(v.sha256) || typeof v.base64 !== 'string') fail()
  const bytes = Buffer.from(v.base64 as string, 'base64')
  if (bytes.toString('base64') !== v.base64 || bytes.byteLength !== v.byteSize ||
    createHash('sha256').update(bytes).digest('hex') !== v.sha256) fail()
  return { byteSize: v.byteSize as number, sha256: v.sha256 }
}

function validateNative(value: unknown, requestedMutation: unknown,
  fence: { generation: string; dev: string; ino: string }, revision: number,
  nextStateSha256: string, final: { byteSize: number; sha256: string },
  predecessorKind: unknown, predecessorSha256: string | null): void {
  const native = object(value); exact(native, ['fence', 'mutation', 'revision', 'stateDelta', 'wal'])
  if (JSON.stringify(writerFence(native.fence)) !== JSON.stringify(fence) || native.revision !== revision) fail()
  const mutation = object(native.mutation)
  if (JSON.stringify(mutation) !== JSON.stringify(requestedMutation)) fail()
  const mutationKeys: Record<string, readonly string[]> = {
    'admission-reconciled': ['kind', 'outcome'], 'ingress-admitted': ['kind', 'outcome'],
    'binding-quarantined': ['kind', 'outcome'], 'ingress-lease-claimed': ['kind', 'outcome', 'claims'],
    'ingress-acknowledged': ['kind', 'outcome'], 'delivery-started': ['kind', 'outcome'],
    'delivery-settled': ['kind', 'phase', 'outcome'],
  }
  if (typeof mutation.kind !== 'string' || !mutationKeys[mutation.kind]) fail()
  exact(mutation, mutationKeys[mutation.kind]!)
  const expectedOutcomes: Record<string, readonly string[]> = {
    'admission-reconciled': ['published'], 'ingress-admitted': ['admitted'],
    'binding-quarantined': ['quarantined'], 'ingress-lease-claimed': ['claimed'],
    'ingress-acknowledged': ['acknowledged'], 'delivery-started': ['started'],
    'delivery-settled': ['delivered', 'stale_generation', 'expired', 'wrong_lane',
      'self_approval', 'unavailable'],
  }
  if (!expectedOutcomes[mutation.kind]!.includes(String(mutation.outcome)) ||
    mutation.kind === 'delivery-settled' &&
      mutation.phase !== (mutation.outcome === 'delivered' ? 'completed' : 'rejected')) fail()
  if (mutation.kind === 'ingress-lease-claimed') {
    if (!Array.isArray(mutation.claims)) fail()
    for (const claimValue of mutation.claims as unknown[]) {
      const claim = object(claimValue); exact(claim, ['claimedAtIso', 'generation', 'leaseExpiresAtIso',
        'leaseToken', 'outboxId', 'ownerId'])
      if (!Number.isSafeInteger(claim.generation) || (claim.generation as number) < 1) fail()
    }
  }
  const delta = object(native.stateDelta); exact(delta, ['changedFields', 'collectionSizes',
    'nextRevision', 'nextStateSha256', 'previousRevision', 'previousStateSha256'])
  const collections = ['actorMembers', 'bindings', 'deliveries', 'ingress', 'retiredIngress', 'routes']
  const fields = ['schemaVersion', 'revision', 'admissionGeneration', 'admissionDigest', ...collections,
    'writerFence']
  if (!Array.isArray(delta.changedFields) || delta.changedFields.some(field => !fields.includes(String(field))) ||
    new Set(delta.changedFields as unknown[]).size !== delta.changedFields.length ||
    delta.nextRevision !== revision || delta.nextStateSha256 !== nextStateSha256 ||
    typeof delta.nextStateSha256 !== 'string' || !HEX_64.test(delta.nextStateSha256)) fail()
  const sizes = object(delta.collectionSizes); exact(sizes, collections)
  for (const field of collections) {
    const size = object(sizes[field]); exact(size, ['next', 'previous'])
    if (!Number.isSafeInteger(size.previous) || (size.previous as number) < 0 ||
      !Number.isSafeInteger(size.next) || (size.next as number) < 0) fail()
  }
  if (predecessorKind === 'absent') {
    if (delta.previousRevision !== null || delta.previousStateSha256 !== null || revision !== 1) fail()
  } else if (!Number.isSafeInteger(delta.previousRevision) || (delta.previousRevision as number) < 1 ||
    typeof delta.previousStateSha256 !== 'string' || !HEX_64.test(delta.previousStateSha256) ||
    delta.previousStateSha256 !== predecessorSha256 || delta.previousRevision !== revision - 1) fail()
  const wal = object(native.wal); exact(wal, ['byteSize', 'sha256'])
  if (wal.byteSize !== final.byteSize || wal.sha256 !== final.sha256 ||
    nextStateSha256 !== final.sha256) fail()
}

function writerFence(value: unknown): { generation: string; dev: string; ino: string } {
  const v = object(value); exact(v, ['dev', 'generation', 'ino'])
  if (typeof v.generation !== 'string' || !TOKEN.test(v.generation) ||
    typeof v.dev !== 'string' || !DECIMAL.test(v.dev) ||
    typeof v.ino !== 'string' || !DECIMAL.test(v.ino)) fail()
  return v as { generation: string; dev: string; ino: string }
}

function clock(value: unknown): bigint {
  const v = object(value); exact(v, ['wallTimeIso', 'monotonicNs'])
  if (typeof v.wallTimeIso !== 'string' || !Number.isFinite(Date.parse(v.wallTimeIso)) ||
    new Date(v.wallTimeIso).toISOString() !== v.wallTimeIso ||
    typeof v.monotonicNs !== 'string' || !DECIMAL.test(v.monotonicNs)) fail()
  return BigInt(v.monotonicNs)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail()
}
function fail(): never { throw new TypeError('hosted_actual_owner_publication_invalid') }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
