import { createHash, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createHostedDomainProof, createHostedRawDomainProof, parseStrictHostedProofLastJsonFrame } from './ownerProof.js'
import type { HostedControlBootstrapBinding } from './HostedControlBootstrap.js'
import type { HostedControlOwnerBinding, HostedControlStableAuthority } from './protocol.js'
export const HOSTED_LIFECYCLE_PROOF_DOMAIN = 'agent-teams.hosted-lifecycle.owner-proof/v1'
export const HOSTED_READINESS_MAX_LINE_BYTES = 4 * 1024

export type HostedReadinessAdmission =
  | { protocol: 'legacy'; challenge: string }
  | { protocol: 'canonical'; challenge: string; bootstrapDigest: string }

export function decodeHostedReadinessRequest(input: {
  secret: Uint8Array
  authority: HostedControlStableAuthority
  ownerBinding: HostedControlOwnerBinding
  bootstrapBinding?: Readonly<HostedControlBootstrapBinding>
  line: string
  message: Record<string, unknown>
}): HostedReadinessAdmission {
  if (Buffer.byteLength(input.line) > HOSTED_READINESS_MAX_LINE_BYTES) {
    throw new TypeError('Invalid hosted readiness frame size')
  }
  if (isLegacyReadiness(input.message)) {
    if (input.bootstrapBinding || !isDeepStrictEqual(input.message.socketIdentity, input.ownerBinding.socketIdentity) ||
      !verifyLegacyReadiness(input.secret, input.line, input.message)) {
      throw new TypeError('Invalid legacy hosted readiness proof')
    }
    return { protocol: 'legacy', challenge: String(input.message.challenge) }
  }
  const signed = parseStrictHostedProofLastJsonFrame(input.line, 'controllerProof')
  if (!isDeepStrictEqual(signed.value, input.message)) throw new TypeError('Invalid hosted readiness raw frame')
  const expectedKeys = ['schemaVersion', 'operation', 'capability', 'socketIdentity', 'challenge', 'bootstrapBinding', 'expectedOwnerBinding', 'controllerProof'].sort()
  const keys = Object.keys(input.message).sort()
  const identity = input.message.socketIdentity
  const bootstrap = input.message.bootstrapBinding
  const expectedOwner = input.message.expectedOwnerBinding
  const proofKeyId = createHash('sha256').update(input.secret).digest('hex')
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) ||
    input.message.schemaVersion !== 2 || input.message.operation !== 'readiness' ||
    input.message.capability !== 'hosted-lifecycle-command' || typeof input.message.challenge !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.message.challenge) || !identity || typeof identity !== 'object' ||
    Array.isArray(identity) || Object.keys(identity).sort().join(',') !== 'device,gid,inode,mode,uid' ||
    !isDeepStrictEqual(identity, input.ownerBinding.socketIdentity) || !expectedOwner ||
    !isDeepStrictEqual(expectedOwner, input.ownerBinding) || !bootstrap || typeof bootstrap !== 'object' ||
    Array.isArray(bootstrap) || !input.bootstrapBinding ||
    !isDeepStrictEqual(bootstrap, input.bootstrapBinding) ||
    !validBootstrapBinding(bootstrap as Record<string, unknown>, input.authority, proofKeyId) ||
    !verifyRawReadiness(input.secret, signed.serializedUnsignedEnvelope, signed.proof)) {
    throw new TypeError('Invalid canonical hosted readiness proof')
  }
  return {
    protocol: 'canonical',
    challenge: input.message.challenge,
    bootstrapDigest: (bootstrap as Record<string, unknown>).bootstrapDigest as string,
  }
}

export function admitHostedReadiness(input: {
  secret: Uint8Array
  ownerBinding: HostedControlOwnerBinding
  bootstrapBinding?: Readonly<HostedControlBootstrapBinding>
  line: string
  message: Record<string, unknown>
}): boolean {
  const binding = input.bootstrapBinding
  const authority: HostedControlStableAuthority = {
    deploymentId: binding?.deploymentId ?? '',
    bootId: binding?.bootId ?? '',
    restoreGeneration: 0,
    workspaceId: binding?.workspaceId ?? '',
    teamId: `team_${'0'.repeat(32)}`,
    mountBinding: {
      mountGeneration: binding?.mountGeneration ?? 1,
      declaredRootHash: '0'.repeat(64),
    },
  }
  try {
    decodeHostedReadinessRequest({ ...input, authority })
    return true
  } catch {
    return false
  }
}

function isLegacyReadiness(message: Record<string, unknown>): boolean {
  return Object.keys(message).sort().join(',') ===
    'capability,challenge,operation,ownerProof,schemaVersion,socketIdentity' &&
    message.schemaVersion === 2 && message.operation === 'readiness' &&
    message.capability === 'hosted-lifecycle-command' &&
    typeof message.challenge === 'string' && /^[0-9a-f]{64}$/.test(message.challenge)
}

function verifyLegacyReadiness(
  secret: Uint8Array,
  line: string,
  message: Record<string, unknown>,
): boolean {
  const proof = message.ownerProof
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false
  const suffix = `,"ownerProof":${JSON.stringify(proof)}}`
  if (!line.endsWith(suffix)) return false
  const serialized = `${line.slice(0, -suffix.length)}}`
  let unsigned: unknown
  try { unsigned = JSON.parse(serialized) } catch { return false }
  if (!unsigned || typeof unsigned !== 'object' || Array.isArray(unsigned) || JSON.stringify(unsigned) !== serialized) return false
  const expected = createHostedDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', unsigned)
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(proof, 'hex'))
}

function verifyRawReadiness(secret: Uint8Array, serialized: string, proof: string): boolean {
  const expected = createHostedRawDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', serialized)
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(proof, 'hex'))
}

function validBootstrapBinding(
  value: Record<string, unknown>,
  authority: HostedControlStableAuthority,
  proofKeyId: string,
): boolean {
  const keys = Object.keys(value).sort().join(',')
  return keys === 'bootId,bootstrapDigest,deploymentId,mountGeneration,ownerArtifactDigest,proofKeyId,workspaceId' &&
    value.deploymentId === authority.deploymentId && value.bootId === authority.bootId &&
    value.workspaceId === authority.workspaceId && value.mountGeneration === authority.mountBinding.mountGeneration &&
    typeof value.bootstrapDigest === 'string' && /^[0-9a-f]{64}$/.test(value.bootstrapDigest) &&
    typeof value.ownerArtifactDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.ownerArtifactDigest) &&
    value.proofKeyId === proofKeyId
}
