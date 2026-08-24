import { timingSafeEqual } from 'node:crypto'

import {
  type HostedApprovalActivationGuard,
  HostedApprovalActivatablePort,
} from './HostedApprovalActivatablePort.js'
import {
  loadHostedApprovalActivatedAdmission,
  type HostedApprovalRetainedActivationSocket,
} from './HostedApprovalActivatedAdmission.js'
import {
  HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
  createHostedApprovalActivationV2Proof,
  unwrapHostedApprovalActivation,
  unwrapHostedApprovalActivationForTest,
  type HostedApprovalActivationBinding,
  type HostedApprovalActivationExpectation,
  type VerifiedHostedApprovalActivation,
} from './HostedApprovalRuntimeActivation.js'
import type { HostedApprovalActivationV2PinSource } from './HostedApprovalActivationV2Pins.js'
import type { HostedApprovalRuntimeAdmission } from './HostedApprovalRuntimeAdmission.js'
import type { HostedApprovalWirePort } from './HostedApprovalWire.js'
import type { HostedControlOwnerBinding } from './protocol.js'

export const HOSTED_APPROVAL_ACTIVATION_PREPARE_MAX_BYTES = 64 * 1024
export const HOSTED_APPROVAL_ACTIVATION_OWNER_READY_MAX_BYTES = 64 * 1024
export const HOSTED_APPROVAL_ACTIVATION_PUBLICATION_MAX_BYTES = 512 * 1024
export const HOSTED_APPROVAL_ACTIVATION_READY_MAX_BYTES = 64 * 1024

const HEX_32 = /^[0-9a-f]{64}$/

export type HostedApprovalActivationRuntimeAuthority = {
  /** A fresh snapshot, including the bootstrap-admitted owner artifact digest. */
  snapshot(): HostedApprovalActivationExpectation
  assertBootstrapCurrent(): boolean | Promise<boolean>
  assertRootCurrent(): boolean | Promise<boolean>
}

/**
 * O2-D implements this boundary for one retained connection. The method may
 * return only a publication frame read after ownerReady has been completely
 * published on that same connection; prebuffered/pipelined bytes must reject.
 */
export type HostedApprovalActivationPublicationTransition = {
  receivePublicationAfterOwnerReady(
    ownerReady: string,
    maximumBytes: typeof HOSTED_APPROVAL_ACTIVATION_PUBLICATION_MAX_BYTES,
  ): Promise<string>
}

export type HostedApprovalActivationConnection =
  HostedApprovalRetainedActivationSocket &
  HostedApprovalActivationPublicationTransition & {
    readonly ownerBinding: HostedControlOwnerBinding
    readonly socketPath: string
  }

export type HostedApprovalActivationRecovery = (
  admission: HostedApprovalRuntimeAdmission,
  activation: VerifiedHostedApprovalActivation,
) => HostedApprovalWirePort | Promise<HostedApprovalWirePort>

export type HostedApprovalActivationSessionOptions = {
  proofKey: Uint8Array | string
  authority: HostedApprovalActivationRuntimeAuthority
  connection: HostedApprovalActivationConnection
  rawAdmissionPath: string
  port: HostedApprovalActivatablePort
  recover: HostedApprovalActivationRecovery
  cleanup?: (delegate: HostedApprovalWirePort | null) => void | Promise<void>
}

/** The complete O2-D-facing API for one retained activation transport. */
export type HostedApprovalActivationTransportSession = {
  /** Accepts one exact prepare frame, including its terminating LF. */
  activate(prepareFrameWithLf: string): Promise<string>
  /** Permanently fails the session closed and releases recovered resources. */
  revoke(): Promise<void>
}

type Phase =
  | 'awaiting_prepare'
  | 'preparing'
  | 'awaiting_publication'
  | 'recovering'
  | 'ready'
  | 'failed'
  | 'revoked'
type VerifyPublication = (
  source: string,
  proofKey: Uint8Array | string,
  expected: HostedApprovalActivationExpectation,
) => VerifiedHostedApprovalActivation

export class HostedApprovalActivationSession
implements HostedApprovalActivationTransportSession {
  #phase: Phase = 'awaiting_prepare'
  readonly #options: HostedApprovalActivationSessionOptions
  readonly #verifyPublication: VerifyPublication
  #recoveredDelegate: HostedApprovalWirePort | null = null
  #portRevocation: Promise<void> | null = null
  readonly #cleanupTasks = new Map<HostedApprovalWirePort | null, Promise<void>>()

  private constructor(
    options: HostedApprovalActivationSessionOptions,
    verifyPublication: VerifyPublication,
  ) {
    this.#options = options
    this.#verifyPublication = verifyPublication
  }

  get phase(): Phase { return this.#phase }

  static production(
    options: HostedApprovalActivationSessionOptions,
  ): HostedApprovalActivationSession {
    return new HostedApprovalActivationSession(options, unwrapHostedApprovalActivation)
  }

  /** Explicit test-vector seam. It cannot replace production authentication. */
  static forTest(
    options: HostedApprovalActivationSessionOptions,
    pins: HostedApprovalActivationV2PinSource,
  ): HostedApprovalActivationSession {
    return new HostedApprovalActivationSession(
      options,
      (source, proofKey, expected) =>
        unwrapHostedApprovalActivationForTest(source, proofKey, pins, expected),
    )
  }

  async activate(
    prepareFrameWithLf: string,
  ): Promise<string> {
    if (this.#phase !== 'awaiting_prepare') fail('wrong_phase')
    // Claim the one-use session synchronously, before the first await.
    this.#phase = 'preparing'

    let guard: HostedApprovalActivationGuard | null = null
    let recoveredDelegate: HostedApprovalWirePort | null = null
    let installed = false
    try {
      const initial = this.#currentExpectation()
      const prepare = decodePrepare(prepareFrameWithLf, this.#options.proofKey, initial)
      await this.#requireInitialCurrent(initial)
      if (this.#phase !== 'preparing') fail('attempt_stale')
      const ownerReady = responseBytes(
        this.#options.proofKey,
        'owner_ready',
        prepare.challenge,
        initial,
      )
      requireSize(ownerReady, HOSTED_APPROVAL_ACTIVATION_OWNER_READY_MAX_BYTES, 'owner_ready')

      this.#phase = 'awaiting_publication'
      const publicationSource =
        await this.#options.connection.receivePublicationAfterOwnerReady(
        ownerReady,
        HOSTED_APPROVAL_ACTIVATION_PUBLICATION_MAX_BYTES,
      )
      if (this.#phase !== 'awaiting_publication') fail('wrong_phase')
      requireFrame(publicationSource, HOSTED_APPROVAL_ACTIVATION_PUBLICATION_MAX_BYTES, 'publication')
      const activation = this.#verifyPublication(
        publicationSource,
        this.#options.proofKey,
        initial,
      )

      this.#phase = 'recovering'
      guard = this.#options.port.beginRecovery()
      const admission = loadHostedApprovalActivatedAdmission({
        activation,
        rawAdmissionPath: this.#options.rawAdmissionPath,
        activationGuard: guard,
        activationSocket: this.#options.connection,
      })
      const delegate = await this.#options.recover(admission, activation)
      recoveredDelegate = delegate
      this.#recoveredDelegate = delegate
      if (this.#phase !== 'recovering') fail('attempt_stale')

      // Final fence order is deliberate. The last synchronous socket-token
      // consumption and activation-attempt check directly precede install.
      const socketToken = this.#options.connection.prepareEffectToken()
      if (!socketToken) fail('socket_stale')
      if (!await this.#options.authority.assertBootstrapCurrent()) fail('bootstrap_stale')
      if (!await this.#options.authority.assertRootCurrent()) fail('root_stale')
      if (!await admission.isCurrent()) fail('raw_admission_stale')
      if (!guard.isCurrent()) fail('attempt_stale')
      const final = this.#currentExpectation()
      if (!sameExpectation(initial, final)) fail('binding_stale')
      const finalActivation = this.#verifyPublication(
        publicationSource,
        this.#options.proofKey,
        final,
      )
      if (finalActivation.activationDigest !== activation.activationDigest) fail('pins_stale')
      if (!socketToken.consume()) fail('socket_stale')
      if (!guard.isCurrent()) fail('attempt_stale')
      guard.install(delegate)
      installed = true
      // install is a synchronous publication boundary, but a wrapper may
      // revoke at that boundary before control returns to this session.
      if (!guard.isCurrent() || this.#phase !== 'recovering') fail('attempt_stale')

      const ready = responseBytes(
        this.#options.proofKey,
        'ready',
        prepare.challenge,
        final,
        activation.activationDigest,
      )
      requireSize(ready, HOSTED_APPROVAL_ACTIVATION_READY_MAX_BYTES, 'ready')
      this.#phase = 'ready'
      return ready
    } catch (error) {
      if (this.#phase !== 'revoked') this.#phase = 'failed'
      if (guard) {
        await this.#revokePort(installed ? null : recoveredDelegate)
        if (recoveredDelegate) await this.#cleanup(recoveredDelegate)
      }
      throw error
    }
  }

  async revoke(): Promise<void> {
    // Calling the async O2-A primitive runs its synchronous lifecycle
    // replacement before it returns the promise for any awaited cleanup.
    this.#phase = 'revoked'
    await this.#revokePort(this.#recoveredDelegate)
  }

  #revokePort(candidate: HostedApprovalWirePort | null): Promise<void> {
    if (!this.#portRevocation) {
      this.#portRevocation = this.#options.port.revoke(active =>
        this.#cleanup(active ?? candidate))
    }
    if (!candidate) return this.#portRevocation
    return Promise.all([
      this.#portRevocation,
      this.#cleanup(candidate),
    ]).then(() => undefined)
  }

  #cleanup(delegate: HostedApprovalWirePort | null): Promise<void> {
    const existing = this.#cleanupTasks.get(delegate)
    if (existing) return existing
    const cleanup = Promise.resolve().then(() => this.#options.cleanup?.(delegate))
    this.#cleanupTasks.set(delegate, cleanup)
    return cleanup
  }

  #currentExpectation(): HostedApprovalActivationExpectation {
    const expected = this.#options.authority.snapshot()
    if (
      expected.socketPath !== this.#options.connection.socketPath ||
      JSON.stringify(expected.ownerBinding) !==
        JSON.stringify(this.#options.connection.ownerBinding)
    ) fail('connection_binding_mismatch')
    // Building the complete binding also validates that no required runtime
    // or bootstrap field is omitted before any proof is accepted.
    bindingFromExpectation(expected)
    return expected
  }

  async #requireInitialCurrent(expected: HostedApprovalActivationExpectation): Promise<void> {
    if (!this.#options.connection.isCurrent()) fail('socket_stale')
    if (!await this.#options.authority.assertBootstrapCurrent()) fail('bootstrap_stale')
    if (!await this.#options.authority.assertRootCurrent()) fail('root_stale')
    if (!sameExpectation(expected, this.#currentExpectation())) fail('binding_stale')
  }
}

function decodePrepare(
  source: string,
  proofKey: Uint8Array | string,
  expected: HostedApprovalActivationExpectation,
): { challenge: string } {
  requireFrame(source, HOSTED_APPROVAL_ACTIVATION_PREPARE_MAX_BYTES, 'prepare')
  const serialized = source.slice(0, -1)
  const value = canonicalRecord(serialized, 'prepare')
  exactOrder(value, [
    'schemaVersion', 'operation', 'capability', 'challenge', 'binding',
    'controllerProof',
  ])
  if (
    value.schemaVersion !== 2 ||
    value.operation !== 'approval_activation_prepare' ||
    value.capability !== HOSTED_APPROVAL_ACTIVATION_CAPABILITY ||
    typeof value.challenge !== 'string' || !HEX_32.test(value.challenge) ||
    typeof value.controllerProof !== 'string' || !HEX_32.test(value.controllerProof)
  ) fail('prepare_invalid')
  const binding = bindingFromExpectation(expected)
  if (JSON.stringify(value.binding) !== JSON.stringify(binding)) fail('binding_mismatch')
  const suffix = `,"controllerProof":"${value.controllerProof}"}`
  if (!serialized.endsWith(suffix)) fail('proof_not_last')
  const unsigned = `${serialized.slice(0, -suffix.length)}}`
  const wanted = createHostedApprovalActivationV2Proof(
    proofKey,
    'owner-ready-request',
    unsigned,
  )
  if (!safeHexEqual(value.controllerProof, wanted)) fail('proof_invalid')
  return { challenge: value.challenge }
}

function responseBytes(
  proofKey: Uint8Array | string,
  kind: 'owner_ready' | 'ready',
  challenge: string,
  expected: HostedApprovalActivationExpectation,
  activationDigest?: string,
): string {
  const binding = bindingFromExpectation(expected)
  const unsignedValue = kind === 'owner_ready'
    ? { schemaVersion: 2, kind, capability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY, challenge, binding }
    : {
        schemaVersion: 2,
        kind,
        capability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
        challenge,
        activationDigest,
        binding,
      }
  if (kind === 'ready' && (typeof activationDigest !== 'string' || !HEX_32.test(activationDigest))) {
    fail('activation_digest_invalid')
  }
  const unsigned = JSON.stringify(unsignedValue)
  const direction = kind === 'owner_ready' ? 'owner-ready' : 'ready'
  const controllerProof = createHostedApprovalActivationV2Proof(
    proofKey,
    direction,
    unsigned,
  )
  return `${unsigned.slice(0, -1)},"controllerProof":"${controllerProof}"}\n`
}

function bindingFromExpectation(
  expected: HostedApprovalActivationExpectation,
): HostedApprovalActivationBinding {
  const binding = {
    deploymentId: expected.authority.deploymentId,
    bootId: expected.authority.bootId,
    workspaceId: expected.authority.workspaceId,
    teamId: expected.authority.teamId,
    restoreGeneration: expected.authority.restoreGeneration,
    mountBinding: expected.authority.mountBinding,
    ownerBinding: expected.ownerBinding,
    socketPath: expected.socketPath,
    approvalGeneration: expected.approvalGeneration,
    admissionOwnerGeneration: expected.admissionOwnerGeneration,
    approvalDigest: expected.approvalDigest,
    admissionDocumentDigest: expected.admissionDocumentDigest,
    ownerArtifactDigest: expected.ownerArtifactDigest,
    activationCapability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
    wireCapabilityDigest: expected.wireCapabilityDigest,
    signedManifest: expected.signedManifest,
  } as HostedApprovalActivationBinding
  validateBinding(binding)
  // JSON round-tripping rejects symbols, bigint, undefined, and noncanonical
  // object surfaces while retaining the exact C1 field order above.
  const serialized = JSON.stringify(binding)
  if (!serialized || JSON.stringify(JSON.parse(serialized)) !== serialized) fail('binding_invalid')
  return binding
}

function validateBinding(binding: HostedApprovalActivationBinding): void {
  exactOrder(binding as unknown as Record<string, unknown>, [
    'deploymentId', 'bootId', 'workspaceId', 'teamId', 'restoreGeneration',
    'mountBinding', 'ownerBinding', 'socketPath', 'approvalGeneration',
    'admissionOwnerGeneration', 'approvalDigest', 'admissionDocumentDigest',
    'ownerArtifactDigest', 'activationCapability', 'wireCapabilityDigest',
    'signedManifest',
  ])
  exactOrder(binding.mountBinding as unknown as Record<string, unknown>, [
    'mountGeneration', 'declaredRootHash',
  ])
  exactOrder(binding.ownerBinding as unknown as Record<string, unknown>, [
    'ownerAuthority', 'ownerGeneration', 'ownerSessionId', 'socketIdentity',
  ])
  exactOrder(binding.ownerBinding.socketIdentity as unknown as Record<string, unknown>, [
    'device', 'inode', 'uid', 'gid', 'mode',
  ])
  exactOrder(binding.signedManifest as unknown as Record<string, unknown>, [
    'format', 'manifestDigest', 'releasePinDigest', 'launcherKeyId',
  ])
  const { mountBinding: mount, ownerBinding: owner, signedManifest: manifest } = binding
  const socket = owner.socketIdentity
  if (
    !identifier(binding.deploymentId) || !identifier(binding.bootId) ||
    !identifier(binding.workspaceId) || !/^team_[0-9a-f]{32}$/.test(binding.teamId) ||
    !nonNegative(binding.restoreGeneration) || !positive(mount.mountGeneration) ||
    !HEX_32.test(mount.declaredRootHash) ||
    !/^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(owner.ownerAuthority) ||
    !positive(owner.ownerGeneration) ||
    !/^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(owner.ownerSessionId) ||
    !/^\d{1,32}$/.test(socket.device) || !/^\d{1,32}$/.test(socket.inode) ||
    !nonNegative(socket.uid) || !nonNegative(socket.gid) || !nonNegative(socket.mode) ||
    socket.mode > 0o777 || !binding.socketPath.startsWith('/') ||
    binding.socketPath.includes('\0') || !positive(binding.approvalGeneration) ||
    !positive(binding.admissionOwnerGeneration) || !sha256(binding.approvalDigest) ||
    !sha256(binding.admissionDocumentDigest) || !sha256(binding.ownerArtifactDigest) ||
    binding.activationCapability !== HOSTED_APPROVAL_ACTIVATION_CAPABILITY ||
    !sha256(binding.wireCapabilityDigest) ||
    manifest.format !== 'agent-teams.hosted-lifecycle-owner-admission/v4' ||
    !sha256(manifest.manifestDigest) || !sha256(manifest.releasePinDigest) ||
    !HEX_32.test(manifest.launcherKeyId)
  ) fail('binding_invalid')
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)
}

function sha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function sameExpectation(
  left: HostedApprovalActivationExpectation,
  right: HostedApprovalActivationExpectation,
): boolean {
  return JSON.stringify(bindingFromExpectation(left)) ===
    JSON.stringify(bindingFromExpectation(right))
}

function requireFrame(source: string, maximum: number, field: string): void {
  if (
    typeof source !== 'string' || source.length < 3 || !source.endsWith('\n') ||
    source.slice(0, -1).includes('\n') || source.includes('\r')
  ) fail(`${field}_invalid`)
  requireSize(source, maximum, field)
}

function requireSize(source: string, maximum: number, field: string): void {
  if (Buffer.byteLength(source, 'utf8') > maximum) fail(`${field}_too_large`)
}

function canonicalRecord(source: string, field: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(source) } catch { fail(`${field}_invalid`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field}_invalid`)
  if (JSON.stringify(value) !== source) fail(`${field}_noncanonical`)
  return value as Record<string, unknown>
}

function exactOrder(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value)
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail('order_invalid')
  }
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBytes = HEX_32.test(left) ? Buffer.from(left, 'hex') : Buffer.alloc(0)
  const rightBytes = HEX_32.test(right) ? Buffer.from(right, 'hex') : Buffer.alloc(0)
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

function fail(reason: string): never {
  throw new Error(`hosted_approval_activation_session_${reason}`)
}
