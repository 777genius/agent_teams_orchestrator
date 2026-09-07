import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fdatasyncSync, fstatSync, openSync, readFileSync, readSync, writeSync } from 'node:fs'

import type { HostedApprovalIngressRecord, HostedApprovalAckRequest, HostedApprovalDeliveryRequest } from './HostedApprovalWire.js'
import type { HostedApprovalDeliveryState, HostedApprovalOwnerState, HostedApprovalWriterFenceIdentity } from './HostedApprovalOwnerWal.js'
import type { HostedApprovalRuntimeAdmission } from './HostedApprovalRuntimeAdmission.js'
import HOSTED_OWNER_PROVENANCE_CONTRACT_ARTIFACT from './contracts/hosted-producer-provenance-v2.schema.json' with { type: 'text' }

export const HOSTED_OWNER_PROVENANCE_ENV = 'CLAUDE_TEAM_PRODUCER_PROVENANCE_V2'
export const HOSTED_OWNER_PROVENANCE_CONTRACT = 'claude-team/hosted-producer-provenance'
export const HOSTED_OWNER_PROVENANCE_VERSION = 2
export const HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256 = 'ef6aa8ac1f139d2b5e9312da8ff1e6dac21da788d46eefbd6e3d43da27da23ba'
export const HOSTED_OWNER_PROVENANCE_IMPLEMENTATION = 'agent-teams.orchestrator.hosted-approval-owner.v1'
export const HOSTED_OWNER_PROVENANCE_STREAM = 'ownerWalTimeline' as const
export const HOSTED_OWNER_PROVENANCE_FD = 9 as const

const HEX_64 = /^[0-9a-f]{64}$/u
const DECIMAL = /^(?:0|[1-9]\d*)$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const MAX_LINE_BYTES = 64 * 1024

export type OwnerWalMutation =
  | Readonly<{ kind: 'admission-reconciled'; outcome: 'published' }>
  | Readonly<{ kind: 'ingress-admitted'; outcome: 'admitted' }>
  | Readonly<{ kind: 'binding-quarantined'; outcome: 'quarantined' }>
  | Readonly<{ kind: 'ingress-lease-claimed'; outcome: 'claimed'; claims: readonly OwnerLeaseClaim[] }>
  | Readonly<{ kind: 'ingress-acknowledged'; outcome: 'acknowledged' }>
  | Readonly<{ kind: 'delivery-started'; outcome: 'started' }>
  | Readonly<{ kind: 'delivery-settled'; phase: 'completed'; outcome: 'delivered' }>
  | Readonly<{ kind: 'delivery-settled'; phase: 'rejected'; outcome: Exclude<HostedApprovalDeliveryState['result'], 'delivered' | null> }>

export type OwnerLeaseClaim = Readonly<{
  claimedAtIso: string
  generation: number
  leaseExpiresAtIso: string
  leaseToken: string
  outboxId: string
  ownerId: string
}>

export type OwnerWalInitialDeliveryWitness = Readonly<{ request: HostedApprovalDeliveryRequest; payloadFingerprint: string }>
/** A discriminated witness created at the real mutation site, never inferred by WAL. */
export type OwnerWalMutationIntent =
  | Readonly<{ operationNonce: string; mutation: Extract<OwnerWalMutation, { kind: 'admission-reconciled' }>; admission: HostedApprovalRuntimeAdmission }>
  | Readonly<{ operationNonce: string; mutation: Extract<OwnerWalMutation, { kind: 'ingress-admitted' }>; record: HostedApprovalIngressRecord }>
  | Readonly<{ operationNonce: string; mutation: Extract<OwnerWalMutation, { kind: 'binding-quarantined' }>; record: HostedApprovalIngressRecord }>
  | Readonly<{ operationNonce: string; mutation: Extract<OwnerWalMutation, { kind: 'ingress-lease-claimed' }>; records: readonly HostedApprovalIngressRecord[] }>
  | Readonly<{ operationNonce: string; mutation: Extract<OwnerWalMutation, { kind: 'ingress-acknowledged' }>; request: HostedApprovalAckRequest; record: HostedApprovalIngressRecord }>
  | Readonly<{ operationNonce: string; mutation: Extract<OwnerWalMutation, { kind: 'delivery-started' }>; delivery: HostedApprovalDeliveryState; initial: OwnerWalInitialDeliveryWitness }>
  | Readonly<{ operationNonce: string; mutation: Extract<OwnerWalMutation, { kind: 'delivery-settled' }>; delivery: HostedApprovalDeliveryState; initial: OwnerWalInitialDeliveryWitness | null }>

export type OwnerStateField = keyof HostedApprovalOwnerState
export type OwnerWalNative = Readonly<{
  fence: HostedApprovalWriterFenceIdentity
  mutation: OwnerWalMutation
  revision: number
  stateDelta: Readonly<{
    changedFields: readonly OwnerStateField[]
    collectionSizes: Readonly<Record<'actorMembers' | 'bindings' | 'deliveries' | 'ingress' | 'retiredIngress' | 'routes', Readonly<{ previous: number; next: number }>>>
    nextRevision: number
    nextStateSha256: string
    previousRevision: number | null
    previousStateSha256: string | null
  }>
  wal: Readonly<{ byteSize: number; sha256: string }>
}>

export type RetainedWalImage = Readonly<{ byteSize: number; sha256: string; bytes: Uint8Array }>
export type PreviousWalImage = Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'retained'; image: RetainedWalImage }>
export type VerifiedOwnerProducerIdentity = Readonly<{
  role: 'owner'; implementationId: typeof HOSTED_OWNER_PROVENANCE_IMPLEMENTATION
  artifactManifestSha256: string; moduleSha256: string; exeSha256: string
  pid: number; startTicks: string; exeDev: string; exeIno: string
}>
export type VerifiedOwnerActivation = Readonly<{ controllerNonce: string; runId: string; stackManifestSha256: string }>
export type BoundOwnerEmission = Readonly<{
  stream: typeof HOSTED_OWNER_PROVENANCE_STREAM
  producer: VerifiedOwnerProducerIdentity
  activation: VerifiedOwnerActivation
  descriptor: Readonly<{ fd: 9; device: string; inode: string }>
  operationNonce: string; emissionNonce: string; sequence: number; lineSha256: string
}>
export type OwnerWalImageReceipt = Readonly<{ stage: number; bindingSha256: string; emission: BoundOwnerEmission }>
export type BoundWalPublication = Readonly<{
  /** Exact successful custody return; absent for legacy non-disk custodians. */
  receipt?: OwnerWalImageReceipt
  native: OwnerWalNative
  emission: BoundOwnerEmission
  previous: PreviousWalImage
  next: RetainedWalImage
}>

export interface OwnerWalPreparedPublication { emit(): BoundWalPublication }
export interface OwnerWalImageCustodian {
  /** Durably stages immutable P/N before WAL replacement; unbound stages are never publication facts. */
  prepare(previous: PreviousWalImage, next: RetainedWalImage): Readonly<{
    bind(emission: BoundOwnerEmission): Readonly<{ previous: PreviousWalImage; next: RetainedWalImage; receipt?: OwnerWalImageReceipt }>
  }>
}
export interface OwnerWalPublicationProducer {
  /** Process-owned, irreversible health: every WAL sharing this producer must consult it. */
  isHealthy(): boolean
  prepare(input: Readonly<{ intent: OwnerWalMutationIntent; native: OwnerWalNative; previous: PreviousWalImage; next: RetainedWalImage }>): OwnerWalPreparedPublication
  poison(reason: string): never
  close(): void
}

export interface OwnerProvenanceOperations {
  identity(modulePath: string): Readonly<{ pid: number; startTicks: string; exeDev: string; exeIno: string; exeSha256: string; moduleSha256: string }>
  descriptor(fd: number): Readonly<{ device: string; inode: string; regular: boolean; append: boolean; writeOnly: boolean; mode: number; nlink: string; size: string }>
  nonce(): string
  write(fd: number, bytes: Uint8Array, offset: number): number
  sync(fd: number): void
  close(fd: number): void
}

type Capsule = Readonly<{
  activation: VerifiedOwnerActivation
  expectedProducer: Readonly<{ artifactManifestSha256: string; executableSha256: string; implementationId: string; moduleSha256: string }>
  streams: Readonly<{ ownerWalTimeline: Readonly<{ fd: 9; device: string; inode: string }> }>
}>

export function createOwnerOperationNonce(): string { return randomBytes(32).toString('hex') }
export function retainedWalImage(bytes: Uint8Array): RetainedWalImage {
  const owned = Uint8Array.from(bytes)
  if (owned.byteLength < 2 || owned.byteLength > 32 * 1024 * 1024) throw new RangeError('Hosted approval retained WAL image out of bounds')
  // Typed-array elements remain writable under a frozen wrapper. Never expose
  // the private preimage; every reader owns its returned byte copy.
  return Object.freeze({ byteSize: owned.byteLength, sha256: sha256(owned), get bytes() { return Uint8Array.from(owned) } })
}

function copyPreviousImage(previous: PreviousWalImage): PreviousWalImage {
  return previous.kind === 'absent' ? Object.freeze({ kind: 'absent' }) :
    Object.freeze({ kind: 'retained', image: retainedWalImage(previous.image.bytes) })
}

export function createOwnerWalPublicationProducerFromEnvironment(options: Readonly<{
  environment: Readonly<Record<string, string | undefined>>
  modulePath: string
  operations?: OwnerProvenanceOperations
  imageCustodian: OwnerWalImageCustodian
  onPoison?: (error: Error) => void
}>): OwnerWalPublicationProducer | null {
  const source = options.environment[HOSTED_OWNER_PROVENANCE_ENV]
  if (source === undefined) return null
  verifyContractMirror()
  const capsule = parseCapsule(source)
  const operations = options.operations ?? createOwnerProvenanceNodeOperations()
  try {
    const identity = operations.identity(options.modulePath)
    if (identity.pid !== process.pid || !Number.isSafeInteger(identity.pid) || identity.pid < 1 ||
      !DECIMAL.test(identity.startTicks) || !DECIMAL.test(identity.exeDev) || !DECIMAL.test(identity.exeIno) ||
      identity.exeSha256 !== capsule.expectedProducer.executableSha256 || identity.moduleSha256 !== capsule.expectedProducer.moduleSha256) {
      throw new TypeError('owner-provenance-producer-identity')
    }
    const expected = capsule.streams.ownerWalTimeline
    const descriptor = operations.descriptor(expected.fd)
    if (!descriptor.regular || !descriptor.append || !descriptor.writeOnly || descriptor.mode !== 0o600 ||
      descriptor.nlink !== '1' || descriptor.size !== '0' || descriptor.device !== expected.device || descriptor.inode !== expected.inode) {
      throw new TypeError('owner-provenance-descriptor-identity')
    }
    return new NativeOwnerWalPublicationProducer(capsule, identity, operations, options.imageCustodian, options.onPoison)
  } catch (error) {
    try { operations.close(HOSTED_OWNER_PROVENANCE_FD) } catch { /* initialization error remains authoritative */ }
    throw error
  }
}

class NativeOwnerWalPublicationProducer implements OwnerWalPublicationProducer {
  #sequence = 0
  #previous: string | null = null
  #fatal: Error | null = null
  #closed = false
  #closing = false
  readonly #emissionNonces = new Set<string>()
  readonly #producer: VerifiedOwnerProducerIdentity
  isHealthy(): boolean { return this.#fatal === null && !this.#closed && !this.#closing }
  constructor(private readonly capsule: Capsule, identity: ReturnType<OwnerProvenanceOperations['identity']>, private readonly operations: OwnerProvenanceOperations, private readonly imageCustodian: OwnerWalImageCustodian, private readonly onPoison?: (error: Error) => void) {
    this.#producer = Object.freeze({ role: 'owner', implementationId: HOSTED_OWNER_PROVENANCE_IMPLEMENTATION, artifactManifestSha256: capsule.expectedProducer.artifactManifestSha256, moduleSha256: identity.moduleSha256, exeSha256: identity.exeSha256, pid: identity.pid, startTicks: identity.startTicks, exeDev: identity.exeDev, exeIno: identity.exeIno })
    this.#append('producer-open', null, { descriptor: capsule.streams.ownerWalTimeline })
  }
  prepare(input: Readonly<{ intent: OwnerWalMutationIntent; native: OwnerWalNative; previous: PreviousWalImage; next: RetainedWalImage }>): OwnerWalPreparedPublication {
    try { return this.#prepare(input) } catch (error) {
      return this.poison(error instanceof Error ? error.message : 'owner-provenance-prepare')
    }
  }
  #prepare(input: Readonly<{ intent: OwnerWalMutationIntent; native: OwnerWalNative; previous: PreviousWalImage; next: RetainedWalImage }>): OwnerWalPreparedPublication {
    if (this.#fatal) throw this.#fatal
    if (this.#closed || this.#closing) return this.poison('owner-provenance-writer-closed')
    // Own all receipt metadata before nonce/custody/I/O callbacks can mutate
    // the inputs. The serialized line and acknowledgement use these same values.
    const operationNonce = input.intent.operationNonce
    const mutation = structuredClone(input.intent.mutation)
    validateNative(input.native)
    const native = freezeNativeMetadata(JSON.parse(canonicalJson(input.native)) as OwnerWalNative)
    validateIntent({ operationNonce, mutation })
    validateNative(native)
    if (!sameRetainedImage(input.next, input.next) || input.next.sha256 !== native.wal.sha256 ||
      input.next.byteSize !== native.wal.byteSize || input.previous.kind === 'absent' && native.stateDelta.previousStateSha256 !== null ||
      input.previous.kind === 'retained' && (!sameRetainedImage(input.previous.image, input.previous.image) ||
        input.previous.image.sha256 !== native.stateDelta.previousStateSha256)) {
      throw new TypeError('owner-provenance-image-native-mismatch')
    }
    if (canonicalJson(mutation) !== canonicalJson(native.mutation)) {
      throw new TypeError('owner-provenance-mutation-mismatch')
    }
    // Keep receipt ownership separate from both caller and custody ownership.
    const previous = copyPreviousImage(input.previous)
    const next = retainedWalImage(input.next.bytes)
    const sequence = this.#sequence
    const emissionNonce = this.#nextEmissionNonce()
    const line = this.#line('owner-wal-published', operationNonce, native, sequence, emissionNonce)
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new RangeError('owner-provenance-line-bounded')
    const custody = this.imageCustodian.prepare(copyPreviousImage(previous), retainedWalImage(next.bytes))
    let used = false
    return Object.freeze({ emit: () => {
      if (!this.isHealthy()) return this.poison('owner-provenance-writer-unavailable')
      if (used || sequence !== this.#sequence) return this.poison('owner-provenance-prepared-publication-stale')
      used = true
      const lineSha256 = this.#writePrepared(line, sequence)
      const emission = Object.freeze({ stream: HOSTED_OWNER_PROVENANCE_STREAM, producer: this.#producer, activation: this.capsule.activation, descriptor: this.capsule.streams.ownerWalTimeline, operationNonce, emissionNonce, sequence, lineSha256 })
      let bound: ReturnType<ReturnType<OwnerWalImageCustodian['prepare']>['bind']>
      try { bound = custody.bind(emission) } catch (error) { return this.poison(error instanceof Error ? error.message : 'owner-provenance-image-bind') }
      if (!sameRetainedImage(bound.next, next) ||
        bound.previous.kind !== previous.kind || bound.previous.kind === 'retained' && previous.kind === 'retained' &&
          !sameRetainedImage(bound.previous.image, previous.image)) {
        return this.poison('owner-provenance-image-custody-mismatch')
      }
      if (!this.isHealthy()) return this.poison('owner-provenance-health-lost-during-emission')
      return Object.freeze({ native, previous, next, emission,
        ...(bound.receipt === undefined ? {} : { receipt: freezeNativeMetadata(structuredClone(bound.receipt)) }),
      })
    } })
  }
  poison(reason: string): never {
    const error = this.#fatal ?? new Error(reason)
    if (!this.#fatal) { this.#fatal = error; try { this.onPoison?.(error) } catch { /* authoritative error retained */ } }
    throw error
  }
  close(): void {
    if (this.#closed || this.#closing) return
    this.#closing = true
    let closeError: Error | null = null
    try { if (!this.#fatal) this.#append('producer-close', null, {}) } finally {
      try { this.operations.sync(HOSTED_OWNER_PROVENANCE_FD) } catch (error) { closeError ??= error as Error }
      try { this.operations.close(HOSTED_OWNER_PROVENANCE_FD) } catch (error) { closeError ??= error as Error }
      this.#closed = true
    }
    if (this.#fatal) this.poison(this.#fatal.message)
    if (closeError) this.poison(closeError.message)
  }
  #append(recordType: string, operationNonce: string | null, native: Readonly<Record<string, unknown>>): void {
    const emissionNonce = this.#nextEmissionNonce()
    this.#writePrepared(this.#line(recordType, operationNonce, native, this.#sequence, emissionNonce), this.#sequence)
  }
  #line(recordType: string, operationNonce: string | null, native: unknown, sequence: number, emissionNonce: string): string {
    return `${canonicalJson({ activation: this.capsule.activation, contract: HOSTED_OWNER_PROVENANCE_CONTRACT, contractSha256: HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256, emissionNonce, native, operationNonce, previousRecordSha256: this.#previous, producer: this.#producer, recordType, sequence, stream: HOSTED_OWNER_PROVENANCE_STREAM, version: HOSTED_OWNER_PROVENANCE_VERSION })}\n`
  }
  #nextEmissionNonce(): string {
    const nonce = this.operations.nonce()
    if (!HEX_64.test(nonce) || this.#emissionNonces.has(nonce)) return this.poison('owner-provenance-emission-nonce')
    this.#emissionNonces.add(nonce)
    return nonce
  }
  #writePrepared(line: string, sequence: number): string {
    if (this.#fatal) throw this.#fatal
    if (this.#closed) return this.poison('owner-provenance-writer-closed')
    if (sequence !== this.#sequence) return this.poison('owner-provenance-sequence-conflict')
    const bytes = Buffer.from(line)
    if (bytes.byteLength > MAX_LINE_BYTES) return this.poison('owner-provenance-line-bounded')
    try {
      let offset = 0
      while (offset < bytes.byteLength) {
        const written = this.operations.write(HOSTED_OWNER_PROVENANCE_FD, bytes, offset)
        if (!Number.isSafeInteger(written) || written < 1 || offset + written > bytes.byteLength) throw new Error('owner-provenance-short-write')
        offset += written
      }
      this.operations.sync(HOSTED_OWNER_PROVENANCE_FD)
      const digest = sha256(bytes); this.#previous = digest; this.#sequence += 1
      return digest
    } catch (error) { return this.poison(error instanceof Error ? error.message : 'owner-provenance-write') }
  }
}

function parseCapsule(source: string): Capsule {
  if (Buffer.byteLength(source) > 128 * 1024) throw new TypeError('owner-provenance-contract-bounded')
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { throw new TypeError('owner-provenance-contract-json') }
  if (canonicalJson(parsed) !== source) throw new TypeError('owner-provenance-contract-canonical')
  const root = exact(parsed, ['activation', 'contract', 'contractSha256', 'expectedProducer', 'producerRole', 'streams', 'version'])
  if (root.contract !== HOSTED_OWNER_PROVENANCE_CONTRACT || root.contractSha256 !== HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256 || root.producerRole !== 'owner' || root.version !== 2) throw new TypeError('owner-provenance-contract')
  const activation = exact(root.activation, ['controllerNonce', 'runId', 'stackManifestSha256'])
  const expected = exact(root.expectedProducer, ['artifactManifestSha256', 'executableSha256', 'implementationId', 'moduleSha256'])
  const streams = exact(root.streams, [HOSTED_OWNER_PROVENANCE_STREAM])
  const descriptor = exact(streams.ownerWalTimeline, ['device', 'fd', 'inode'])
  if (![activation.controllerNonce, activation.stackManifestSha256, expected.artifactManifestSha256, expected.executableSha256, expected.moduleSha256].every(value => typeof value === 'string' && HEX_64.test(value)) ||
    typeof activation.runId !== 'string' || !SAFE_ID.test(activation.runId) || expected.implementationId !== HOSTED_OWNER_PROVENANCE_IMPLEMENTATION || descriptor.fd !== 9 || typeof descriptor.device !== 'string' || !DECIMAL.test(descriptor.device) || typeof descriptor.inode !== 'string' || !DECIMAL.test(descriptor.inode)) throw new TypeError('owner-provenance-contract')
  return Object.freeze({ activation: Object.freeze(activation) as unknown as VerifiedOwnerActivation, expectedProducer: Object.freeze(expected) as Capsule['expectedProducer'], streams: Object.freeze({ ownerWalTimeline: Object.freeze(descriptor) as Capsule['streams']['ownerWalTimeline'] }) })
}

function verifyContractMirror(): void {
  const bytes = Buffer.from(HOSTED_OWNER_PROVENANCE_CONTRACT_ARTIFACT)
  if (bytes.byteLength !== 56_415 || sha256(bytes) !== HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256) throw new Error('owner-provenance-schema-digest-mismatch')
}

function freezeNativeMetadata<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeNativeMetadata(child)
    Object.freeze(value)
  }
  return value
}

function validateIntent(intent: Pick<OwnerWalMutationIntent, 'operationNonce' | 'mutation'>): void {
  if (!HEX_64.test(intent.operationNonce)) throw new TypeError('owner-provenance-operation-nonce')
  if (intent.mutation.kind === 'ingress-lease-claimed' && intent.mutation.claims.length === 0) throw new TypeError('owner-provenance-empty-claims')
}
function validateNative(native: OwnerWalNative): void {
  exact(native, ['fence', 'mutation', 'revision', 'stateDelta', 'wal'])
  exact(native.fence, ['dev', 'generation', 'ino'])
  exact(native.stateDelta, ['changedFields', 'collectionSizes', 'nextRevision', 'nextStateSha256', 'previousRevision', 'previousStateSha256'])
  exact(native.wal, ['byteSize', 'sha256'])
  const delta = native.stateDelta
  const fields: readonly OwnerStateField[] = ['actorMembers', 'admissionDigest', 'admissionGeneration', 'bindings', 'deliveries', 'ingress', 'retiredIngress', 'revision', 'routes', 'schemaVersion', 'writerFence']
  const collections = ['actorMembers', 'bindings', 'deliveries', 'ingress', 'retiredIngress', 'routes'] as const
  exact(delta.collectionSizes, collections)
  if (!Number.isSafeInteger(native.revision) || native.revision < 1 || delta.nextRevision !== native.revision ||
    !Number.isSafeInteger(native.wal.byteSize) || native.wal.byteSize < 2 || native.wal.byteSize > 32 * 1024 * 1024 ||
    native.wal.sha256 !== delta.nextStateSha256 || !HEX_64.test(native.wal.sha256) ||
    !DECIMAL.test(native.fence.dev) || !DECIMAL.test(native.fence.ino) || !/^approval-writer-fence_[0-9a-f]{32}$/u.test(native.fence.generation) ||
    !Array.isArray(delta.changedFields) || delta.changedFields.length === 0 || !delta.changedFields.includes('revision') ||
    Array.from({ length: delta.changedFields.length }, (_, index) => index).some(index =>
      !Object.prototype.hasOwnProperty.call(delta.changedFields, index)) ||
    delta.changedFields.some((field, index) => !fields.includes(field) ||
      index > 0 && Buffer.from(delta.changedFields[index - 1]!).compare(Buffer.from(field)) >= 0) ||
    (delta.previousRevision === null) !== (delta.previousStateSha256 === null) ||
    delta.previousStateSha256 !== null && !HEX_64.test(delta.previousStateSha256) ||
    delta.previousRevision !== null && (!Number.isSafeInteger(delta.previousRevision) || delta.previousRevision < 1 || delta.nextRevision !== delta.previousRevision + 1) ||
    delta.previousRevision === null && delta.nextRevision !== 1) throw new TypeError('owner-provenance-native')
  for (const collection of collections) {
    const pair = delta.collectionSizes[collection]
    exact(pair, ['next', 'previous'])
    if (!pair || !Number.isSafeInteger(pair.previous) || pair.previous < 0 || Object.is(pair.previous, -0) ||
      !Number.isSafeInteger(pair.next) || pair.next < 0 || Object.is(pair.next, -0) ||
      delta.previousRevision === null && pair.previous !== 0) throw new TypeError('owner-provenance-native')
  }
  if (delta.previousRevision === null && delta.changedFields.length !== fields.length) throw new TypeError('owner-provenance-native')
  const mutation = native.mutation
  exact(mutation, mutation.kind === 'ingress-lease-claimed' ? ['claims', 'kind', 'outcome'] :
    mutation.kind === 'delivery-settled' ? ['kind', 'outcome', 'phase'] : ['kind', 'outcome'])
  const simpleMutation = mutation.kind === 'admission-reconciled' && mutation.outcome === 'published' ||
    mutation.kind === 'ingress-admitted' && mutation.outcome === 'admitted' ||
    mutation.kind === 'binding-quarantined' && mutation.outcome === 'quarantined' ||
    mutation.kind === 'ingress-acknowledged' && mutation.outcome === 'acknowledged' ||
    mutation.kind === 'delivery-started' && mutation.outcome === 'started'
  if (mutation.kind === 'ingress-lease-claimed') {
    if (mutation.outcome !== 'claimed' || mutation.claims.length < 1 || mutation.claims.length > 100 ||
      Array.from({ length: mutation.claims.length }, (_, index) => index).some(index =>
        !Object.prototype.hasOwnProperty.call(mutation.claims, index)) || mutation.claims.some(claim => {
      exact(claim, ['claimedAtIso', 'generation', 'leaseExpiresAtIso', 'leaseToken', 'outboxId', 'ownerId'])
      return !Number.isSafeInteger(claim.generation) || claim.generation < 1 || !SAFE_ID.test(claim.outboxId) ||
      !SAFE_ID.test(claim.ownerId) || !SAFE_ID.test(claim.leaseToken) || !validIso(claim.claimedAtIso) ||
      !validIso(claim.leaseExpiresAtIso)
    })) throw new TypeError('owner-provenance-native')
  }
  const settlement = mutation.kind === 'delivery-settled' && (mutation.phase === 'completed' && mutation.outcome === 'delivered' ||
    mutation.phase === 'rejected' && ['stale_generation', 'expired', 'wrong_lane', 'self_approval', 'unavailable'].includes(mutation.outcome))
  if (!simpleMutation && mutation.kind !== 'ingress-lease-claimed' && !settlement) throw new TypeError('owner-provenance-native')
  if (mutation.kind === 'binding-quarantined' && (!delta.changedFields.includes('bindings') ||
    delta.collectionSizes.bindings.next !== delta.collectionSizes.bindings.previous + 1)) throw new TypeError('owner-provenance-native')
}
function validIso(value: string): boolean { const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === value }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('owner-provenance-object')
  const item = value as Record<string, unknown>
  if (Reflect.ownKeys(item).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(item, key))) throw new TypeError('owner-provenance-object')
  return item
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    const serialized = JSON.stringify(value); if (serialized === undefined) throw new TypeError('owner-provenance-json'); return serialized
  }
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('owner-provenance-json'); const serialized = JSON.stringify(value); if (serialized === undefined) throw new TypeError('owner-provenance-json'); return serialized }
  if (typeof value !== 'object' || value === undefined) throw new TypeError('owner-provenance-json')
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) throw new TypeError('owner-provenance-json')
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b))).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}
function sha256(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function sameRetainedImage(left: RetainedWalImage, right: RetainedWalImage): boolean {
  const leftBytes = left.bytes; const rightBytes = right.bytes
  return left.byteSize === leftBytes.byteLength && left.sha256 === sha256(leftBytes) &&
    left.byteSize === right.byteSize && left.sha256 === right.sha256 && Buffer.from(leftBytes).equals(Buffer.from(rightBytes))
}
function identifyFile(path: string): { dev: string; ino: string; sha256: string } {
  const fd = openSync(path, constants.O_RDONLY)
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile()) throw new TypeError('owner-provenance-identity-not-file')
    const digest = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (count === 0) break; digest.update(buffer.subarray(0, count)) }
    return { dev: stat.dev.toString(), ino: stat.ino.toString(), sha256: digest.digest('hex') }
  } finally { closeSync(fd) }
}
/** Concrete Linux descriptor operations; callers may remap owned descriptors explicitly. */
export function createOwnerProvenanceNodeOperations(): OwnerProvenanceOperations {
  return Object.freeze({
    identity(modulePath: string) {
      const stat = readFileSync('/proc/self/stat', 'utf8'); const end = stat.lastIndexOf(') '); const startTicks = stat.slice(end + 2).trim().split(/\s+/u)[19] ?? ''
      if (end < 0) throw new TypeError('owner-provenance-process-stat')
      const executable = identifyFile('/proc/self/exe'); const module = identifyFile(modulePath)
      return Object.freeze({ pid: process.pid, startTicks, exeDev: executable.dev, exeIno: executable.ino, exeSha256: executable.sha256, moduleSha256: module.sha256 })
    },
    descriptor(fd: number) {
      const identity = fstatSync(fd, { bigint: true }); const match = /^flags:\s+([0-7]+)$/mu.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')); if (!match) throw new TypeError('owner-provenance-descriptor-flags')
      const flags = Number.parseInt(match[1]!, 8)
      return Object.freeze({ device: identity.dev.toString(), inode: identity.ino.toString(), regular: identity.isFile(), append: (flags & constants.O_APPEND) !== 0, writeOnly: (flags & 3) === constants.O_WRONLY, mode: Number(identity.mode & 0o7777n), nlink: identity.nlink.toString(), size: identity.size.toString() })
    }, nonce: createOwnerOperationNonce, write: (fd, bytes, offset) => writeSync(fd, bytes, offset, bytes.byteLength - offset, null), sync: fdatasyncSync, close: closeSync,
  })
}
