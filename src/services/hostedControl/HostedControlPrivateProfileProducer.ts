import { canonicalPreparedProfile, PRIVATE_PROFILE_AUTH, PRIVATE_PROFILE_DOCUMENT_MAXIMUM, type retainPreparedProfile } from '../opencode/OpenCodePreparedProfileContract.js'
import { canonicalV2, hashV2, macV2, type OwnerDescriptorMapV2, type ServerCredentialsV2 } from './HostedControlBootstrapV2Wire.js'
import type { ExpectedSupervisedOpenCode } from '../opencode/OpenCodeSupervisedHostCustody.js'

/** Product calls this after the held Owner start and descriptor map are known.
 * bootstrapDigest is the serialized Product bootstrap digest, NOT the eventual FD4 header digest.
 * Caller owns returned private frame and must wipe it after delivery (including failure).
 */
export function encodePrivatePreparedProfile(input: {
  publication: ReturnType<typeof retainPreparedProfile>
  proofKey: Uint8Array
  expectedHost: ExpectedSupervisedOpenCode
  descriptorMap: OwnerDescriptorMapV2
  ownerProcessStartToken: string
  bootstrapDigest: string
  credentials: ServerCredentialsV2
}) {
  let bytes: Buffer | undefined
  let frame: Buffer | undefined
  try {
    const expectedHostSha256 = hashV2(canonicalV2(input.expectedHost))
    const descriptorMapSha256 = hashV2(canonicalV2(input.descriptorMap))
    const transfer = input.publication.transfer(input.proofKey, { expectedHostSha256, ownerProcessStartToken: input.ownerProcessStartToken, bootstrapDigest: input.bootstrapDigest })
    const { binding, ...privateProfile } = transfer
    if (input.credentials.id !== input.expectedHost.serverAuthId || input.bootstrapDigest !== input.expectedHost.activation.bootstrapDigest ||
      !/^[^:\r\n\0]+$/.test(input.credentials.username) || !/^[^\r\n\0]+$/.test(input.credentials.password) ||
      Buffer.byteLength(input.credentials.username) > 128 || Buffer.byteLength(input.credentials.password) > 4096) throw new Error()
    for (const field of ['projectPath','profileRootKey','profileRootPath','projectBehaviorFingerprint','managedConfigFingerprint','sourceAuthFingerprint','managedAuthFingerprint','sourceAuthSources'] as const)
      if (canonicalPreparedProfile(privateProfile.preparedProfile[field]) !== canonicalPreparedProfile(input.expectedHost.profile[field])) throw new Error()
    bytes = Buffer.from(canonicalPreparedProfile({ format: PRIVATE_PROFILE_AUTH,
      bootstrapDigest: input.bootstrapDigest, spawnNonce: input.descriptorMap.spawnNonce,
      expectedHostSha256, descriptorMapSha256, serverAuthId: input.credentials.id,
      username: input.credentials.username, password: input.credentials.password, ...privateProfile }))
    if (bytes.length > PRIVATE_PROFILE_DOCUMENT_MAXIMUM) throw new Error()
    frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32BE(bytes.length); bytes.copy(frame,4)
    const mac = macV2(input.proofKey, PRIVATE_PROFILE_AUTH, frame)
    try { return { frame, preparedProfileBinding: binding, serverAuthBinding: {
      format: PRIVATE_PROFILE_AUTH, serverAuthId: input.credentials.id, expectedHostSha256, descriptorMapSha256, authHmacSha256: mac.toString('hex'),
    } } } finally { mac.fill(0) }
  } catch { frame?.fill(0); throw new Error('opencode_private_profile_rejected') }
  finally { bytes?.fill(0) }
}
