import { expect, test } from 'bun:test'
import { HostedApprovalDeferredManifestV2 } from './HostedApprovalDeferredManifestV2.js'
import { HostedApprovalActivatablePort } from './HostedApprovalActivatablePort.js'
import { createHostedApprovalActivationV2Proof } from './HostedApprovalRuntimeActivation.js'
import { createHostedApprovalActivationV2PinsForTest } from './HostedApprovalActivationV2Pins.js'
import { activationGolden as golden, fixtureHeaderV2 } from './fixtures/bootstrapV2Producer.js'

// Kernel/socket publication is exercised by bootstrap-v2-kernel.test.ts. These
// small vectors cover every known pre-exec expectation without duplicating it.
test('candidate digest never replaces another known bootstrap or actual-socket binding', async () => {
  const mutations: ((b: any) => void)[] = [
    b => { b.deploymentId += '-wrong' }, b => { b.bootId += '-wrong' }, b => { b.workspaceId += '-wrong' },
    b => { b.teamId = 'team_' + 'f'.repeat(32) }, b => { b.restoreGeneration++ },
    b => { b.mountBinding.mountGeneration++ }, b => { b.mountBinding.declaredRootHash = 'f'.repeat(64) },
    b => { b.ownerBinding.ownerAuthority += '-wrong' }, b => { b.ownerBinding.ownerGeneration++ },
    b => { b.ownerBinding.ownerSessionId += '-wrong' }, b => { b.ownerBinding.socketIdentity.inode = '999' },
    b => { b.socketPath += '-wrong' }, b => { b.approvalGeneration++ }, b => { b.admissionOwnerGeneration++ },
    b => { b.approvalDigest = 'sha256:' + 'f'.repeat(64) }, b => { b.admissionDocumentDigest = 'sha256:' + 'f'.repeat(64) },
    b => { b.ownerArtifactDigest = 'sha256:' + 'f'.repeat(64) }, b => { b.wireCapabilityDigest = 'sha256:' + 'f'.repeat(64) },
    b => { b.signedManifest.format = 'wrong' }, b => { b.signedManifest.releasePinDigest = 'sha256:' + 'f'.repeat(64) },
    b => { b.signedManifest.launcherKeyId = 'f'.repeat(64) },
  ]
  for (const mutate of mutations) {
    const b = golden.binding, { manifestDigest: _, ...pending } = b.signedManifest
    let transitions = 0, recoveries = 0
    const session = HostedApprovalDeferredManifestV2.forTest({
      proofKey: golden.proof.testOnlySecretHex, expectedHost: fixtureHeaderV2().expectedHost,
      port: new HostedApprovalActivatablePort(), rawAdmissionPath: '/unused-before-authentication',
      authority: { snapshot: () => ({ ...b, authority: { deploymentId: b.deploymentId, bootId: b.bootId,
        workspaceId: b.workspaceId, teamId: b.teamId, restoreGeneration: b.restoreGeneration, mountBinding: b.mountBinding },
        signedManifest: pending }), assertBootstrapCurrent: () => true, assertRootCurrent: () => true },
      connection: { ownerBinding: b.ownerBinding, socketPath: b.socketPath, isCurrent: () => true,
        prepareEffectToken: () => ({ consume: () => true }), receivePublicationAfterOwnerReady: async () => {
          transitions++; return golden.publication.transportBytes
        } },
      recover: () => { recoveries++; throw new Error('untrusted candidate reached adoption') },
    }, createHostedApprovalActivationV2PinsForTest({ publicKeySpkiDer: Buffer.from(golden.signing.publicKeySpkiDerBase64url, 'base64url'),
      publicKeyDigest: golden.signing.publicKeyDigest, contractDigest: golden.signing.contractDigest }))
    const request = JSON.parse(golden.prepare.serializedUnsigned); mutate(request.binding)
    const controllerProof = createHostedApprovalActivationV2Proof(golden.proof.testOnlySecretHex, 'owner-ready-request', JSON.stringify(request))
    await expect(session.activate(JSON.stringify({ ...request, controllerProof }) + '\n')).rejects.toThrow()
    expect(transitions).toBe(0); expect(recoveries).toBe(0); expect(session.state.kind).toBe('revoked')
  }
})
