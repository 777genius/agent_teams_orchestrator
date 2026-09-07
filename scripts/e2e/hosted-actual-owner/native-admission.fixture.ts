/** Public RFC8032 section 7.1 vectors ONLY. Signatures are constructed only when
 * root later executes test source. No generated, read or deployment keys. */
import { createPrivateKey, sign } from 'node:crypto'
import { allocationFixture } from './native-allocation.fixture.js'
import { canonicalJson, sha256 } from './native-http-contract.js'
import { decodeNativeAdmissionStatement, NATIVE_LAUNCH_ADMISSION, nativeLaunchAdmissionSigningBytes,
  type NativeAdmissionStatement } from './native-admission-codec.js'
import { SELECTED_LAUNCH_PHASE, type SelectedLaunchPhase } from '../../../src/services/hostedControl/HostedControlSelectedLaunchPhase.js'

export const RFC8032_LAUNCHER_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
export const RFC8032_ACTIVATION_HEX = '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'
export function fixtureSign(bytes: Uint8Array): string {
  const seed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
  const key = createPrivateKey({ format: 'der', type: 'pkcs8',
    key: Buffer.from('302e020100300506032b657004220420' + seed, 'hex') })
  return sign(null, bytes, key).toString('base64url')
}
export function nativeAdmissionFixture(generation: 1 | 2 | 3 | 4 = 1) {
  const allocation = allocationFixture()
  const selected = allocation.generations.find(g => g.generation === generation)!
  // Full outer shape; intentionally not actual kernel/descriptor evidence.
  const launch = { expectedHost: { activation: { ownerGeneration: generation, ownerSessionId: selected.ownerSessionId,
      admissionDocumentDigest: `sha256:${selected.admissionDocumentSha256}` } },
    bootstrapV2HeaderSha256: sha256(`header-${generation}`), rawRetention: null,
    supervisorProcessStartToken: sha256('supervisor'), ownerProcessStartToken: sha256(`owner-${generation}`),
    recipeSha256: sha256('recipe'), harnessContractSha256: sha256('harness'), ownerModule: null,
    ownerArtifactManifestSha256: sha256('artifact'), ownerExecutable: null, supervisorExecutable: null,
    refs: [], serializedProductBootstrap: null, producerCapsule: null, runtimeManifestSha256: sha256('runtime'),
    harnessContractPath: '/fixture/contract', held: null, executed: null }
  const sealed = { observedMonotonicNs: '3', constructionClosedMonotonicNs: '2', construction: {
    sourceFd: 20, childFd: 3, kind: 'regular-file', accessMode: 'read-write', append: false,
    mode: 384, uid: 0, gid: 0, seals: 15, device: '1', inode: '2', size: '3', nlink: '0',
    mtimeNs: '1', ctimeNs: '1', closedMonotonicNs: '2' } }
  const statement = decodeNativeAdmissionStatement({ format: NATIVE_LAUNCH_ADMISSION,
    launchSha256: sha256(canonicalJson(launch)), sealedSha256: sha256(canonicalJson(sealed)),
    ownerProcessStartToken: launch.ownerProcessStartToken,
    controllerDescriptor: '{"fixture":"descriptor-parser-is-an-independent-gate","signedInteger":-1,"é":"UTF8"}',
    controllerTrustAnchor: { schemaVersion: 1, purpose: 'agent-teams.p3c.controller-trust-anchor/v1', authorityEpoch: 1,
      harnessReviewerPublicKeySha256: 'a'.repeat(64), runAuthorizationPublicKeySha256: 'b'.repeat(64), revokedSignerKeyIds: [] },
    activation: { publicKeySpkiDerBase64url: Buffer.from('302a300506032b6570032100' + RFC8032_ACTIVATION_HEX, 'hex').toString('base64url'),
      contractDigest: 'c'.repeat(64) }, allocationSha256: sha256(canonicalJson(allocation)), allocation, generation: selected,
    predecessorResults: generation === 4 ? [{ operationId: 'Rretry', generation: 3, ownerProcessStartToken: sha256('owner-3'),
      requestRecordSha256: sha256('request-3'), responseRecordSha256: sha256('response-3'), bodySha256: sha256('body-3'),
      peerBindingSha256: sha256('peer-3'), returnWitnessSha256: sha256('successful-return-3') }] : [] })
  const admission = signFixtureStatement(statement)
  const phase = { contract: SELECTED_LAUNCH_PHASE, launch, sealed, nativeAdmission: admission } as unknown as SelectedLaunchPhase
  return { allocation, statement, admission, phase, launcherPublicKey: Buffer.from(RFC8032_LAUNCHER_HEX, 'hex').toString('base64url') }
}
export function signFixtureStatement(statement: NativeAdmissionStatement) {
  return { statement, signatureBase64url: fixtureSign(nativeLaunchAdmissionSigningBytes(statement)) }
}
/** Exact vectors for root's paired decoders; no filesystem side effects. */
export function pairedNativeCodecVectors() {
  return ([1, 2, 3, 4] as const).map(generation => {
    const f = nativeAdmissionFixture(generation), payload = Buffer.from(canonicalJson(f.phase))
    const frame = Buffer.alloc(payload.length + 8)
    frame.writeUInt32BE(0x48534c31, 0); frame.writeUInt32BE(payload.length, 4); payload.copy(frame, 8)
    return { generation, launcherPublicKey: f.launcherPublicKey, allocationSha256: f.statement.allocationSha256,
      phase: f.phase, statement: f.statement, admission: f.admission,
      signingBytesHex: nativeLaunchAdmissionSigningBytes(f.statement).toString('hex'), frameHex: frame.toString('hex') }
  })
}
