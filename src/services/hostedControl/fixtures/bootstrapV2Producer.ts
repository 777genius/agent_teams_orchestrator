// Source-contract fixture derived from Product supervisor/bootstrap-v2.ts at
// 0c344c62f. These bytes carry no fixture qualification or custody authority.
import { readFileSync } from 'node:fs'
import { BOOTSTRAP_V2, AUTH_V2, LEASE_V2, STATEMENT_V2, OWNER_V2_ROLES,
  canonicalV2, hashV2, macV2, type BootstrapHeaderV2 } from '../HostedControlBootstrapV2Wire.js'

export const activationGolden = JSON.parse(readFileSync(new URL('./hosted-approval-activation-v2-golden.json', import.meta.url), 'utf8'))
export const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
export function fixtureHeaderV2(): any {
  const b = activationGolden.binding, owner = b.ownerBinding
  const { manifestDigest: _, ...signedManifest } = b.signedManifest
  const bootstrapDigest = hashV2('{"product":"bootstrap"}'), hex = '1'.repeat(64)
  const wrapperPid = 300, wrapperStartTicks = '200'
  return {
    format: BOOTSTRAP_V2, restoreGeneration: b.restoreGeneration, teamId: b.teamId,
    declaredRootHash: b.mountBinding.declaredRootHash, ...{ ownerAuthority: owner.ownerAuthority,
      ownerGeneration: owner.ownerGeneration, ownerSessionId: owner.ownerSessionId },
    claudeRoot: '/sandbox/claude', socketPath: '/sandbox/owner.sock', legacyKey: 'test-team',
    approvalActivationV2: { approvalGeneration: b.approvalGeneration, admissionOwnerGeneration: b.admissionOwnerGeneration,
      approvalDigest: b.approvalDigest, admissionDocumentDigest: b.admissionDocumentDigest, ownerArtifactDigest: b.ownerArtifactDigest,
      wireCapabilityDigest: b.wireCapabilityDigest, signedManifest },
    bootstrapBinding: { deploymentId: b.deploymentId, bootId: b.bootId, workspaceId: b.workspaceId,
      mountGeneration: b.mountBinding.mountGeneration, bootstrapDigest, ownerArtifactDigest: b.ownerArtifactDigest,
      proofKeyId: hashV2(Buffer.alloc(32, 42)) },
    leaseEvidence: { device: '1', inode: '3', uid: 1000, gid: 1000, mode: 0o600,
      launcherLeaseId: 'test-lease', launcherArtifactDigest: b.ownerArtifactDigest.slice(7) },
    expectedHost: {
      endpoint: { protocol: 'http:', address: '127.0.0.1', port: 4096, baseUrl: 'http://127.0.0.1:4096' },
      process: { pid: 400, startTicks: '201', startIdentity: `start_${hashV2('400\0proc:201')}`,
        supervisorProcessStartToken: hex, pidNamespaceInode: '100', networkNamespaceInode: '101' },
      executable: { device: '1', inode: '40', size: '123', sha256: '9'.repeat(64), artifactManifestSha256: hex, moduleSha256: hex },
      profile: { projectPath: '/sandbox/project', profileRootKey: 'test-profile', profileRootPath: '/sandbox/profile',
        projectBehaviorFingerprint: hex, managedConfigFingerprint: hex, resolvedConfigFingerprint: hex,
        sourceAuthFingerprint: null, managedAuthFingerprint: null, sourceAuthSources: [{ path: '/sandbox/absent.json', fingerprint: null }], toolApprovalMode: 'manual' },
      hosted: { schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2', authentication: 'opencode-basic',
        runtimeInstanceId: 'runtime_instance_' + 'ab'.repeat(16), configGeneration: 'config_generation_' + 'cd'.repeat(16) },
      activation: { controllerNonce: hex, runId: hex, stackManifestSha256: hex, bootstrapDigest,
        admissionDocumentDigest: b.admissionDocumentDigest, ownerArtifactDigest: b.ownerArtifactDigest,
        ownerGeneration: owner.ownerGeneration, ownerSessionId: owner.ownerSessionId }, serverAuthId: 'server-auth-test',
    },
    supervisorBinding: { supervisorPid: 200, supervisorStartTicks: '199', supervisorStartToken: hex,
      supervisorExecutableSha256: hex, recipeSha256: hex, ownerEntrySha256: hex, ownerPid: 301,
      ownerStartTicks: '202', ownerProcessStartToken: hex, harnessContractSha256: hex, ownerProducerCapsuleSha256: hex },
    descriptorMap: { schemaVersion: 2, contract: 'agent-teams.hosted-owner-child-fd-map/v2', wrapperPid, wrapperStartTicks,
      wrapperStartToken: hashV2(canonicalV2({ contract: 'agent-teams.hosted-owner-wrapper-process-start/v1', pid: wrapperPid, startTime: wrapperStartTicks })),
      spawnNonce: hex, descriptors: Object.entries(OWNER_V2_ROLES).map(([role, childFd]) => ({ role, childFd,
        kind: [3, 8, 9, 11].includes(childFd) ? 'regular-file' : 'socket', device: '1', inode: String(childFd), uid: 1000,
        gid: 1000, mode: childFd === 11 ? 0o500 : 0o600, accessMode: [3, 11].includes(childFd) ? 'read-only' :
          [8, 9].includes(childFd) ? 'write-only' : 'read-write', append: [8, 9].includes(childFd) })) },
    rawRetention: { format: 'agent-teams.hosted-control.opencode-raw-retention/v1', captureId: hex,
      initialByteLength: 0, initialSha256: hashV2(''), nextSequence: 1 },
  }
}
export function assembleFixtureV2(header = fixtureHeaderV2(), options: {
  authText?: (source: string) => string; headerText?: (source: string) => string
  mutateAuth?: (document: any) => void
  bootstrapMacDomain?: string; authMacDomain?: string
} = {}) {
  const key = Buffer.alloc(32, 42)
  const expectedHostSha256 = hashV2(canonicalV2(header.expectedHost))
  const descriptorMapSha256 = hashV2(canonicalV2(header.descriptorMap))
  const authDoc = { format: AUTH_V2, bootstrapDigest: header.bootstrapBinding.bootstrapDigest,
    spawnNonce: header.descriptorMap.spawnNonce, expectedHostSha256, descriptorMapSha256,
    serverAuthId: header.expectedHost.serverAuthId, username: 'test-user', password: 'test-password' }
  options.mutateAuth?.(authDoc)
  const authBytes = Buffer.from(options.authText?.(canonicalV2(authDoc)) ?? canonicalV2(authDoc))
  const authFrame = Buffer.concat([u32(authBytes.length), authBytes]); authBytes.fill(0)
  header.serverAuthBinding = { format: AUTH_V2, serverAuthId: authDoc.serverAuthId,
    expectedHostSha256, descriptorMapSha256, authHmacSha256: macV2(key, options.authMacDomain ?? AUTH_V2, authFrame).toString('hex') }
  delete header.leaseEvidence.leaseArtifactSha256
  const lease = Buffer.from(canonicalV2({ format: LEASE_V2, launcherLeaseId: header.leaseEvidence.launcherLeaseId,
    bootstrapStatementSha256: hashV2(`${STATEMENT_V2}\0${canonicalV2(header)}`) }))
  header.leaseEvidence.leaseArtifactSha256 = hashV2(lease)
  const bytes = Buffer.from(options.headerText?.(canonicalV2(header)) ?? canonicalV2(header))
  const authenticated = Buffer.concat([u32(bytes.length), bytes])
  const bootstrapFrame = Buffer.concat([authenticated, key, macV2(key, options.bootstrapMacDomain ?? BOOTSTRAP_V2, authenticated)])
  key.fill(0)
  return { header: header as BootstrapHeaderV2, lease, bootstrapFrame, authFrame }
}
