import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'

import type {
  HostedApprovalAuthorityScope,
  HostedApprovalIngressAuthority,
} from './HostedApprovalWire.js'
import type { HostedApprovalRuntimeRoute } from './HostedApprovalRuntimeAdmission.js'
import type {
  HostedControlOwnerBinding,
  HostedControlStableAuthority,
} from './protocol.js'
import {
  getHostedApprovalActivationV2ProductionPins,
  requireHostedApprovalActivationV2ProductionPins,
  type HostedApprovalActivationV2ProductionPinSource,
  type HostedApprovalActivationV2PinSource,
} from './HostedApprovalActivationV2Pins.js'

export const HOSTED_APPROVAL_ACTIVATION_PURPOSE =
  'agent-teams.hosted-approval-activation/v2' as const
export const HOSTED_APPROVAL_ACTIVATION_CAPABILITY =
  'agent-teams.hosted-approval-activation-v2' as const
export const HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN =
  'agent-teams.hosted-approval-activation-proof/v2' as const
export const HOSTED_APPROVAL_ACTIVATION_AUTHORSHIP_CONTRACT =
  'agent-teams.hosted-approval-activation-product-authorship/v2' as const
export const HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT =
  'agent-teams.hosted-lifecycle-owner-admission/v4' as const
export const HOSTED_APPROVAL_ACTIVATION_AUTHORSHIP_ALGORITHM = 'Ed25519' as const
export const HOSTED_APPROVAL_ACTIVATION_WIRE_CAPABILITY_DIGEST =
  'sha256:40a6c4a131b4e64c04b87337fbce667c91f274fb85b3879c6cdcac49dbbbd639' as const
export type HostedApprovalActivationProofDirection =
  | 'owner-ready-request'
  | 'owner-ready'
  | 'admission'
  | 'ready'
const HOSTED_APPROVAL_ACTIVATION_PROOF_DIRECTIONS = new Set<string>([
  'owner-ready-request', 'owner-ready', 'admission', 'ready',
])

const HEX_32 = /^[0-9a-f]{64}$/
const SHA256 = /^sha256:[0-9a-f]{64}$/
const TEAM_ID = /^team_[0-9a-f]{32}$/
const RUN_ID = /^run_[0-9a-f]{32}$/
const MEMBER_ID = /^member_[0-9a-f]{32}$/
const ACTOR_ID = /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/
const ADMISSION_GENERATION =
  /^approval-admission-generation_([1-9][0-9]*)_owner_([1-9][0-9]*)$/
const OWNER_AUTHORITY = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const OWNER_SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const MAX_PUBLICATION_BYTES = 512 * 1024
const MAX_ADMISSION_BYTES = 256 * 1024

export type HostedApprovalActivationBinding = {
  deploymentId: string
  bootId: string
  workspaceId: string
  teamId: string
  restoreGeneration: number
  mountBinding: { mountGeneration: number; declaredRootHash: string }
  ownerBinding: HostedControlOwnerBinding
  socketPath: string
  approvalGeneration: number
  admissionOwnerGeneration: number
  approvalDigest: `sha256:${string}`
  admissionDocumentDigest: `sha256:${string}`
  ownerArtifactDigest: `sha256:${string}`
  activationCapability: typeof HOSTED_APPROVAL_ACTIVATION_CAPABILITY
  wireCapabilityDigest: `sha256:${string}`
  signedManifest: {
    format: typeof HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT
    manifestDigest: `sha256:${string}`
    releasePinDigest: `sha256:${string}`
    launcherKeyId: string
  }
}

export type HostedApprovalActivationExpectation = {
  authority: HostedControlStableAuthority
  ownerBinding: HostedControlOwnerBinding
  socketPath: string
  approvalGeneration: number
  admissionOwnerGeneration: number
  approvalDigest: `sha256:${string}`
  admissionDocumentDigest: `sha256:${string}`
  ownerArtifactDigest: `sha256:${string}`
  wireCapabilityDigest: `sha256:${string}`
  signedManifest: HostedApprovalActivationBinding['signedManifest']
}

export type HostedApprovalGlobalAdmission = {
  schemaVersion: 1
  admissionGeneration: string
  outerAuthority: {
    deploymentId: string
    bootId: string
    workspaceId: string
    teamId: string
    restoreGeneration: number
    mountBinding: { mountGeneration: number; declaredRootHash: string }
  }
  routes: readonly HostedApprovalRuntimeRoute[]
  actorMembers: Readonly<Record<string, string>>
}

export type VerifiedHostedApprovalActivation = {
  schemaVersion: 2
  binding: HostedApprovalActivationBinding
  /** Exact canonical global admission bytes, including the required final LF. */
  canonicalAdmissionDocument: string
  /** Digest of the complete global document, not of the requested-team projection. */
  admissionDocumentDigest: `sha256:${string}`
  /** Bare SHA-256 of exact canonical publication JSON bytes, excluding transport LF. */
  activationDigest: string
  globalAdmission: HostedApprovalGlobalAdmission
  requestedTeam: {
    teamId: string
    admissionGeneration: string
    approvalDigest: `sha256:${string}`
    globalAdmissionDigest: `sha256:${string}`
    routes: readonly HostedApprovalRuntimeRoute[]
    actorMembers: Readonly<Record<string, string>>
  }
}

/**
 * Pure, fail-closed activation-v2 verifier. It accepts only the product's
 * canonical publication wrapper; authorship is never accepted out of band.
 */
export function unwrapHostedApprovalActivation(
  source: string,
  proofKey: Uint8Array | string,
  expected: HostedApprovalActivationExpectation,
  pins?: HostedApprovalActivationV2ProductionPinSource,
): VerifiedHostedApprovalActivation {
  return unwrapWithPins(
    source,
    proofKey,
    pins === undefined ? getHostedApprovalActivationV2ProductionPins() :
      requireHostedApprovalActivationV2ProductionPins(pins),
    expected,
  )
}

/** Test-only vector seam; never supplies production authority. */
export function unwrapHostedApprovalActivationForTest(
  source: string,
  proofKey: Uint8Array | string,
  pins: HostedApprovalActivationV2PinSource,
  expected: HostedApprovalActivationExpectation,
): VerifiedHostedApprovalActivation {
  return unwrapWithPins(source, proofKey, pins, expected)
}

function unwrapWithPins(
  source: string,
  proofKey: Uint8Array | string,
  verifier: HostedApprovalActivationV2PinSource,
  expected: HostedApprovalActivationExpectation,
): VerifiedHostedApprovalActivation {
  const publication = canonicalObject(source, [
    'schemaVersion', 'envelope', 'authorship',
  ], 'publication')
  if (publication.schemaVersion !== 2) fail('publication_invalid')

  const envelope = record(publication.envelope, 'envelope')
  const serializedEnvelope = JSON.stringify(envelope)
  verifyAuthorship(serializedEnvelope, publication.authorship, verifier)

  ordered(envelope, [
    'schemaVersion', 'purpose', 'binding', 'admission', 'controllerProof',
  ])
  if (
    envelope.schemaVersion !== 2 ||
    envelope.purpose !== HOSTED_APPROVAL_ACTIVATION_PURPOSE
  ) fail('schema_invalid')

  const parsedBinding = decodeBinding(envelope.binding)
  requireExpectedBinding(parsedBinding, expected)
  const proof = envelope.controllerProof
  if (typeof proof !== 'string' || !HEX_32.test(proof)) fail('proof_invalid')
  const proofSuffix = `,"controllerProof":"${proof}"}`
  if (!serializedEnvelope.endsWith(proofSuffix)) fail('proof_not_last')
  const unsignedEnvelope = `${serializedEnvelope.slice(0, -proofSuffix.length)}}`
  requireProof(proofKey, unsignedEnvelope, proof)

  const canonicalAdmissionDocument = `${JSON.stringify(envelope.admission)}\n`
  const globalAdmission = decodeGlobalAdmission(
    canonicalAdmissionDocument,
    parsedBinding,
  )
  const requestedRoutes = globalAdmission.routes.filter(
    route => route.authority.teamId === parsedBinding.teamId,
  )
  if (requestedRoutes.length === 0) fail('requested_team_missing')
  const requestedActors = Object.freeze(Object.fromEntries(
    requestedRoutes.map(route => [
      route.scope.principalId,
      globalAdmission.actorMembers[route.scope.principalId],
    ]),
  ))

  return Object.freeze({
    schemaVersion: 2,
    binding: parsedBinding,
    canonicalAdmissionDocument,
    admissionDocumentDigest: parsedBinding.admissionDocumentDigest,
    activationDigest: createHash('sha256').update(source.slice(0, -1), 'utf8').digest('hex'),
    globalAdmission,
    requestedTeam: Object.freeze({
      teamId: parsedBinding.teamId,
      admissionGeneration: globalAdmission.admissionGeneration,
      approvalDigest: parsedBinding.approvalDigest,
      globalAdmissionDigest: parsedBinding.admissionDocumentDigest,
      routes: Object.freeze(requestedRoutes),
      actorMembers: requestedActors,
    }),
  })
}

function verifyAuthorship(
  envelope: string,
  value: unknown,
  verifier: HostedApprovalActivationV2PinSource,
): void {
  const authorship = record(value, 'authorship')
  ordered(authorship, [
    'algorithm', 'publicKeyDigest', 'contractDigest', 'signature',
  ])
  const spki = Buffer.from(verifier.publicKeySpkiDer)
  let publicKey: ReturnType<typeof createPublicKey>
  try {
    publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  } catch {
    fail('authorship_key_invalid')
  }
  const actualKeyDigest = sha256(spki)
  if (
    publicKey.type !== 'public' ||
    publicKey.asymmetricKeyType !== 'ed25519' ||
    authorship.algorithm !== HOSTED_APPROVAL_ACTIVATION_AUTHORSHIP_ALGORITHM ||
    !SHA256.test(verifier.publicKeyDigest) ||
    !SHA256.test(verifier.contractDigest) ||
    authorship.publicKeyDigest !== verifier.publicKeyDigest ||
    verifier.publicKeyDigest !== actualKeyDigest ||
    authorship.contractDigest !== verifier.contractDigest ||
    typeof authorship.signature !== 'string'
  ) fail('authorship_pin_mismatch')

  const signature = Buffer.from(authorship.signature, 'base64url')
  const statement =
    `{"schemaVersion":2,"algorithm":"Ed25519",` +
    `"publicKeyDigest":"${verifier.publicKeyDigest}",` +
    `"contractDigest":"${verifier.contractDigest}","envelope":${envelope}}`
  if (
    signature.byteLength !== 64 ||
    signature.toString('base64url') !== authorship.signature ||
    !verifySignature(null, Buffer.from(statement, 'utf8'), publicKey, signature)
  ) fail('authorship_invalid')
}

function decodeBinding(value: unknown): HostedApprovalActivationBinding {
  const binding = record(value, 'binding')
  ordered(binding, [
    'deploymentId', 'bootId', 'workspaceId', 'teamId', 'restoreGeneration',
    'mountBinding', 'ownerBinding', 'socketPath', 'approvalGeneration',
    'admissionOwnerGeneration', 'approvalDigest', 'admissionDocumentDigest',
    'ownerArtifactDigest', 'activationCapability', 'wireCapabilityDigest',
    'signedManifest',
  ])
  const mount = record(binding.mountBinding, 'mount_binding')
  ordered(mount, ['mountGeneration', 'declaredRootHash'])
  const owner = record(binding.ownerBinding, 'owner_binding')
  ordered(owner, [
    'ownerAuthority', 'ownerGeneration', 'ownerSessionId', 'socketIdentity',
  ])
  const socket = record(owner.socketIdentity, 'socket_identity')
  ordered(socket, ['device', 'inode', 'uid', 'gid', 'mode'])
  const manifest = record(binding.signedManifest, 'signed_manifest')
  ordered(manifest, [
    'format', 'manifestDigest', 'releasePinDigest', 'launcherKeyId',
  ])
  if (
    typeof binding.deploymentId !== 'string' || !IDENTIFIER.test(binding.deploymentId) ||
    typeof binding.bootId !== 'string' || !IDENTIFIER.test(binding.bootId) ||
    typeof binding.workspaceId !== 'string' || !IDENTIFIER.test(binding.workspaceId) ||
    typeof binding.teamId !== 'string' || !TEAM_ID.test(binding.teamId) ||
    !nonNegative(binding.restoreGeneration) ||
    !positive(mount.mountGeneration) ||
    typeof mount.declaredRootHash !== 'string' || !HEX_32.test(mount.declaredRootHash) ||
    typeof owner.ownerAuthority !== 'string' || !OWNER_AUTHORITY.test(owner.ownerAuthority) ||
    !positive(owner.ownerGeneration) ||
    typeof owner.ownerSessionId !== 'string' || !OWNER_SESSION.test(owner.ownerSessionId) ||
    typeof socket.device !== 'string' || !/^\d{1,32}$/.test(socket.device) ||
    typeof socket.inode !== 'string' || !/^\d{1,32}$/.test(socket.inode) ||
    !nonNegative(socket.uid) || !nonNegative(socket.gid) || !nonNegative(socket.mode) ||
    socket.mode > 0o777 ||
    typeof binding.socketPath !== 'string' || !binding.socketPath.startsWith('/') ||
    binding.socketPath.includes('\0') ||
    !positive(binding.approvalGeneration) ||
    !positive(binding.admissionOwnerGeneration) ||
    typeof binding.approvalDigest !== 'string' || !SHA256.test(binding.approvalDigest) ||
    typeof binding.admissionDocumentDigest !== 'string' ||
      !SHA256.test(binding.admissionDocumentDigest) ||
    typeof binding.ownerArtifactDigest !== 'string' ||
      !SHA256.test(binding.ownerArtifactDigest) ||
    binding.activationCapability !== HOSTED_APPROVAL_ACTIVATION_CAPABILITY ||
    binding.wireCapabilityDigest !== HOSTED_APPROVAL_ACTIVATION_WIRE_CAPABILITY_DIGEST ||
    manifest.format !== HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT ||
    typeof manifest.manifestDigest !== 'string' || !SHA256.test(manifest.manifestDigest) ||
    typeof manifest.releasePinDigest !== 'string' || !SHA256.test(manifest.releasePinDigest) ||
    typeof manifest.launcherKeyId !== 'string' || !HEX_32.test(manifest.launcherKeyId)
  ) fail('binding_invalid')

  return Object.freeze({
    deploymentId: binding.deploymentId,
    bootId: binding.bootId,
    workspaceId: binding.workspaceId,
    teamId: binding.teamId,
    restoreGeneration: binding.restoreGeneration,
    mountBinding: Object.freeze({
      mountGeneration: mount.mountGeneration,
      declaredRootHash: mount.declaredRootHash,
    }),
    ownerBinding: Object.freeze({
      ownerAuthority: owner.ownerAuthority,
      ownerGeneration: owner.ownerGeneration,
      ownerSessionId: owner.ownerSessionId,
      socketIdentity: Object.freeze({
        device: socket.device,
        inode: socket.inode,
        uid: socket.uid,
        gid: socket.gid,
        mode: socket.mode,
      }),
    }),
    socketPath: binding.socketPath,
    approvalGeneration: binding.approvalGeneration,
    admissionOwnerGeneration: binding.admissionOwnerGeneration,
    approvalDigest: binding.approvalDigest,
    admissionDocumentDigest: binding.admissionDocumentDigest,
    ownerArtifactDigest: binding.ownerArtifactDigest,
    activationCapability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
    wireCapabilityDigest: binding.wireCapabilityDigest,
    signedManifest: Object.freeze({
      format: HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT,
      manifestDigest: manifest.manifestDigest,
      releasePinDigest: manifest.releasePinDigest,
      launcherKeyId: manifest.launcherKeyId,
    }),
  }) as HostedApprovalActivationBinding
}

function requireExpectedBinding(
  binding: HostedApprovalActivationBinding,
  expected: HostedApprovalActivationExpectation,
): void {
  const authority = expected.authority
  if (
    binding.deploymentId !== authority.deploymentId ||
    binding.bootId !== authority.bootId ||
    binding.workspaceId !== authority.workspaceId ||
    binding.teamId !== authority.teamId ||
    binding.restoreGeneration !== authority.restoreGeneration ||
    JSON.stringify(binding.mountBinding) !== JSON.stringify(authority.mountBinding) ||
    JSON.stringify(binding.ownerBinding) !== JSON.stringify(expected.ownerBinding) ||
    binding.socketPath !== expected.socketPath ||
    binding.approvalGeneration !== expected.approvalGeneration ||
    binding.admissionOwnerGeneration !== expected.admissionOwnerGeneration ||
    binding.approvalDigest !== expected.approvalDigest ||
    binding.admissionDocumentDigest !== expected.admissionDocumentDigest ||
    binding.ownerArtifactDigest !== expected.ownerArtifactDigest ||
    binding.wireCapabilityDigest !== expected.wireCapabilityDigest ||
    JSON.stringify(binding.signedManifest) !== JSON.stringify(expected.signedManifest)
  ) fail('binding_mismatch')
}

function decodeGlobalAdmission(
  source: string,
  binding: HostedApprovalActivationBinding,
): HostedApprovalGlobalAdmission {
  if (!source.endsWith('\n') || source.includes('\r')) fail('admission_invalid')
  if (Buffer.byteLength(source, 'utf8') > MAX_ADMISSION_BYTES) {
    fail('admission_too_large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    fail('admission_invalid')
  }
  const admission = record(parsed, 'admission')
  ordered(admission, [
    'schemaVersion', 'admissionGeneration', 'outerAuthority', 'routes',
    'actorMembers',
  ])
  if (
    admission.schemaVersion !== 1 ||
    `${JSON.stringify(admission)}\n` !== source ||
    typeof admission.admissionGeneration !== 'string' ||
    !Array.isArray(admission.routes) ||
    admission.routes.length === 0 || admission.routes.length > 256
  ) fail('admission_invalid')
  const generation = ADMISSION_GENERATION.exec(admission.admissionGeneration)
  if (
    generation === null ||
    Number(generation[1]) !== binding.approvalGeneration ||
    Number(generation[2]) !== binding.admissionOwnerGeneration
  ) fail('admission_generation_mismatch')

  const outer = record(admission.outerAuthority, 'outer_authority')
  ordered(outer, [
    'deploymentId', 'bootId', 'workspaceId', 'teamId', 'restoreGeneration',
    'mountBinding',
  ])
  const mount = record(outer.mountBinding, 'outer_mount_binding')
  ordered(mount, ['mountGeneration', 'declaredRootHash'])
  if (
    outer.deploymentId !== binding.deploymentId ||
    outer.bootId !== binding.bootId ||
    outer.workspaceId !== binding.workspaceId ||
    typeof outer.teamId !== 'string' || !TEAM_ID.test(outer.teamId) ||
    outer.restoreGeneration !== binding.restoreGeneration ||
    mount.mountGeneration !== binding.mountBinding.mountGeneration ||
    mount.declaredRootHash !== binding.mountBinding.declaredRootHash
  ) fail('admission_binding_mismatch')

  const actorsInput = record(admission.actorMembers, 'actor_members')
  const actorEntries = Object.entries(actorsInput)
  const actorKeys = Object.keys(actorsInput)
  if (
    actorEntries.length === 0 || actorEntries.length > 256 ||
    actorKeys.some((key, index) => index > 0 && actorKeys[index - 1] > key) ||
    actorEntries.some(([actorId, memberId]) =>
      !ACTOR_ID.test(actorId) || typeof memberId !== 'string' || !MEMBER_ID.test(memberId))
  ) fail('actor_mapping_invalid')
  const actorMembers = Object.freeze({ ...actorsInput }) as Readonly<Record<string, string>>

  const routeIds = new Set<string>()
  const routeIdentities = new Set<string>()
  const routes = admission.routes.map((value, index) => {
    const route = decodeRoute(value, index, binding, actorMembers)
    const identity = [
      route.authority.teamId,
      route.authority.runId,
      route.authority.laneId,
      route.authority.sessionId,
    ].join('\0')
    if (routeIds.has(route.routeId) || routeIdentities.has(identity)) {
      fail('route_duplicate')
    }
    routeIds.add(route.routeId)
    routeIdentities.add(identity)
    return route
  })
  const routedActors = new Set(routes.map(route => route.scope.principalId))
  if (actorKeys.some(actorId => !routedActors.has(actorId))) {
    fail('actor_mapping_unbound')
  }
  const orderedRouteIds = [...routeIds]
  if (orderedRouteIds.some((id, index) => index > 0 && orderedRouteIds[index - 1] > id)) {
    fail('route_order_invalid')
  }
  if (!routes.some(route => route.authority.teamId === binding.teamId)) {
    fail('requested_team_missing')
  }

  const authorities = routes.map(route => route.authority)
  const approvalSnapshot = {
    schemaVersion: 1,
    approvalGeneration: binding.approvalGeneration,
    authorities,
  }
  if (
    sha256(JSON.stringify(approvalSnapshot)) !== binding.approvalDigest ||
    sha256(source) !== binding.admissionDocumentDigest
  ) fail('admission_digest_mismatch')

  return Object.freeze({
    schemaVersion: 1,
    admissionGeneration: admission.admissionGeneration,
    outerAuthority: Object.freeze({
      deploymentId: outer.deploymentId,
      bootId: outer.bootId,
      workspaceId: outer.workspaceId,
      teamId: outer.teamId,
      restoreGeneration: outer.restoreGeneration,
      mountBinding: Object.freeze({
        mountGeneration: mount.mountGeneration,
        declaredRootHash: mount.declaredRootHash,
      }),
    }),
    routes: Object.freeze(routes),
    actorMembers,
  }) as HostedApprovalGlobalAdmission
}

function decodeRoute(
  value: unknown,
  index: number,
  binding: HostedApprovalActivationBinding,
  actors: Readonly<Record<string, string>>,
): HostedApprovalRuntimeRoute {
  const route = record(value, `route_${index}`)
  ordered(route, ['routeId', 'authority', 'scope', 'memberName', 'openCodeBinding'])
  const authority = decodeAuthority(route.authority)
  const scope = decodeScope(route.scope)
  const openCode = decodeOpenCodeBinding(route.openCodeBinding)
  if (
    typeof route.routeId !== 'string' || !IDENTIFIER.test(route.routeId) ||
    typeof route.memberName !== 'string' || !IDENTIFIER.test(route.memberName) ||
    authority.deploymentId !== binding.deploymentId ||
    authority.providerId !== 'opencode' ||
    scope.workspaceId !== binding.workspaceId ||
    scope.teamId !== authority.teamId ||
    scope.restoreGeneration !== binding.restoreGeneration ||
    actors[scope.principalId] !== authority.deliveryOwnerId ||
    openCode.planGeneration !== authority.planGeneration ||
    openCode.credentialGeneration !== authority.credentialGeneration ||
    openCode.credentialId !== authority.credentialId ||
    openCode.runtimeInstanceId !== authority.runtimeInstanceId ||
    openCode.deliveryOwnerId !== authority.deliveryOwnerId
  ) fail('route_binding_invalid')
  return Object.freeze({
    routeId: route.routeId,
    authority,
    scope,
    memberName: route.memberName,
    openCodeBinding: openCode,
  })
}

function decodeAuthority(value: unknown): HostedApprovalIngressAuthority {
  const authority = record(value, 'route_authority')
  ordered(authority, [
    'deploymentId', 'teamId', 'runId', 'planGeneration', 'laneId', 'providerId',
    'credentialGeneration', 'credentialId', 'sessionId', 'runtimeInstanceId',
    'deliveryOwnerId',
  ])
  if (
    typeof authority.deploymentId !== 'string' || !IDENTIFIER.test(authority.deploymentId) ||
    typeof authority.teamId !== 'string' || !TEAM_ID.test(authority.teamId) ||
    typeof authority.runId !== 'string' || !RUN_ID.test(authority.runId) ||
    !positive(authority.planGeneration) ||
    typeof authority.laneId !== 'string' || !IDENTIFIER.test(authority.laneId) ||
    authority.providerId !== 'opencode' ||
    !positive(authority.credentialGeneration) ||
    typeof authority.credentialId !== 'string' || !IDENTIFIER.test(authority.credentialId) ||
    typeof authority.sessionId !== 'string' || !IDENTIFIER.test(authority.sessionId) ||
    typeof authority.runtimeInstanceId !== 'string' ||
      !IDENTIFIER.test(authority.runtimeInstanceId) ||
    typeof authority.deliveryOwnerId !== 'string' || !MEMBER_ID.test(authority.deliveryOwnerId)
  ) fail('authority_invalid')
  return Object.freeze({ ...authority }) as HostedApprovalIngressAuthority
}

function decodeScope(value: unknown): HostedApprovalAuthorityScope {
  const scope = record(value, 'route_scope')
  ordered(scope, [
    'principalId', 'workspaceId', 'teamId', 'authorityGeneration',
    'restoreGeneration',
  ])
  if (
    typeof scope.principalId !== 'string' || !ACTOR_ID.test(scope.principalId) ||
    typeof scope.workspaceId !== 'string' || !IDENTIFIER.test(scope.workspaceId) ||
    typeof scope.teamId !== 'string' || !TEAM_ID.test(scope.teamId) ||
    typeof scope.authorityGeneration !== 'string' ||
      !GENERATION.test(scope.authorityGeneration) ||
    !nonNegative(scope.restoreGeneration)
  ) fail('scope_invalid')
  return Object.freeze({ ...scope }) as HostedApprovalAuthorityScope
}

function decodeOpenCodeBinding(
  value: unknown,
): HostedApprovalRuntimeRoute['openCodeBinding'] {
  const openCode = record(value, 'open_code_binding')
  ordered(openCode, [
    'toolApprovalMode', 'planGeneration', 'credentialGeneration', 'credentialId',
    'runtimeInstanceId', 'deliveryOwnerId', 'openCodeArtifactDigest',
    'sessionRecordFingerprint', 'liveEffectFingerprint',
  ])
  if (
    openCode.toolApprovalMode !== 'manual' ||
    !positive(openCode.planGeneration) || !positive(openCode.credentialGeneration) ||
    typeof openCode.credentialId !== 'string' || !IDENTIFIER.test(openCode.credentialId) ||
    typeof openCode.runtimeInstanceId !== 'string' ||
      !IDENTIFIER.test(openCode.runtimeInstanceId) ||
    typeof openCode.deliveryOwnerId !== 'string' || !MEMBER_ID.test(openCode.deliveryOwnerId) ||
    typeof openCode.openCodeArtifactDigest !== 'string' ||
      !SHA256.test(openCode.openCodeArtifactDigest) ||
    typeof openCode.sessionRecordFingerprint !== 'string' ||
      !HEX_32.test(openCode.sessionRecordFingerprint) ||
    typeof openCode.liveEffectFingerprint !== 'string' ||
      !HEX_32.test(openCode.liveEffectFingerprint)
  ) fail('open_code_binding_invalid')
  return Object.freeze({ ...openCode }) as HostedApprovalRuntimeRoute['openCodeBinding']
}

export function createHostedApprovalActivationV2Proof(
  key: Uint8Array | string,
  direction: HostedApprovalActivationProofDirection,
  serializedUnsigned: string,
): string {
  if (!HOSTED_APPROVAL_ACTIVATION_PROOF_DIRECTIONS.has(direction)) {
    fail('proof_direction_invalid')
  }
  const bytes = typeof key === 'string'
    ? (HEX_32.test(key) ? Buffer.from(key, 'hex') : Buffer.alloc(0))
    : Buffer.from(key)
  if (bytes.byteLength !== 32) fail('proof_key_invalid')
  if (
    serializedUnsigned.length < 2 || serializedUnsigned.includes('\n') ||
    serializedUnsigned.includes('\r')
  ) fail('proof_unsigned_invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(serializedUnsigned)
  } catch {
    fail('proof_unsigned_invalid')
  }
  if (
    !parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    JSON.stringify(parsed) !== serializedUnsigned
  ) fail('proof_unsigned_noncanonical')
  return createHmac('sha256', bytes)
    .update(
      `${HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN}\0${direction}\0${serializedUnsigned}`,
      'utf8',
    )
    .digest('hex')
}

function requireProof(key: Uint8Array | string, unsigned: string, supplied: string): void {
  const expected = Buffer.from(
    createHostedApprovalActivationV2Proof(key, 'admission', unsigned),
    'hex',
  )
  const actual = HEX_32.test(supplied) ? Buffer.from(supplied, 'hex') : Buffer.alloc(0)
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    fail('proof_invalid')
  }
}

function canonicalObject(
  source: string,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (
    source.length < 3 || !source.endsWith('\n') ||
    source.slice(0, -1).includes('\n') || source.includes('\r')
  ) {
    fail(`${field}_invalid`)
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_PUBLICATION_BYTES) {
    fail(`${field}_too_large`)
  }
  const canonicalSource = source.slice(0, -1)
  let parsed: unknown
  try {
    parsed = JSON.parse(canonicalSource)
  } catch {
    fail(`${field}_invalid`)
  }
  const value = record(parsed, field)
  ordered(value, keys)
  if (JSON.stringify(value) !== canonicalSource) fail(`${field}_noncanonical`)
  return value
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field}_object_invalid`)
  }
  return value as Record<string, unknown>
}

function ordered(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    fail('order_invalid')
  }
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function fail(reason: string): never {
  throw new Error(`hosted_approval_activation_${reason}`)
}
