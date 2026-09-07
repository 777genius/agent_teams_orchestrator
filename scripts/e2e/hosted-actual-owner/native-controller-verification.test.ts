import { expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { canonicalJson, sha256 } from './native-http-contract.js'
import { OPENCODE_IDENTITIES, P3C_LANE } from './native-controller-contract.js'
import type { IntegrationDescriptor } from './native-controller-contract.js'
import { verifyControlDocuments } from './native-controller-verification.js'

// Test-only authorities. Production accepts provisioned public pins; it never
// generates keys or selects the verifier from a submitted document.
function fixture() {
  const reviewer = generateKeyPairSync('ed25519'), authorizer = generateKeyPairSync('ed25519')
  const publicBytes = (key: typeof reviewer) => key.publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const reviewerBytes = publicBytes(reviewer), authorizerBytes = publicBytes(authorizer)
  const hex = 'a'.repeat(64), commit = 'b'.repeat(40)
  const pin = { sha256: hex }, closure = { merkleRoot: hex }
  const anchor = { schemaVersion: 1 as const, purpose: 'agent-teams.p3c.controller-trust-anchor/v1' as const,
    authorityEpoch: 1, harnessReviewerPublicKeySha256: sha256(reviewerBytes),
    runAuthorizationPublicKeySha256: sha256(authorizerBytes), revokedSignerKeyIds: [] as string[] }
  const descriptor: any = { controllerNonce: hex, authority: { fixture: 'controller' },
    control: { freezeId: '', reviewId: '', authorizationId: '',
      harnessReviewerPublicKey: { sha256: sha256(reviewerBytes) },
      runAuthorizationPublicKey: { sha256: sha256(authorizerBytes) } },
    roots: { sandboxParent: { device: '1', inode: '2', mountId: '3' } },
    product: { finalHarnessCommit: commit, harnessClosure: closure, compositionEntry: pin,
      compositionDescriptor: pin, runtimeClosure: closure, browserBundle: closure,
      playwrightEntry: pin, playwrightConfig: pin, playwrightSpec: pin, chromiumExecutable: pin },
    p3b2: { sourceBaseCommit: commit, resultCommit: commit, entry: pin, supervisor: pin,
      recipeSha256: hex, closure },
    openCode: { acquisitionReceipt: pin, releaseManifest: pin, buildProvenanceBundle: pin,
      linuxX64Archive: pin, linuxX64Binary: pin }, productionGates: { fixture: false } }
  const identify = (value: Record<string, unknown>, field: string, domain: string) => {
    const unsigned = { ...value }; delete unsigned[field]; delete unsigned.signatureBase64
    value[field] = sha256(`${domain}\0${canonicalJson(unsigned)}`)
    return value[field] as string
  }
  const freeze: any = { schemaVersion: 1, purpose: 'agent-teams.p3c.p3c1-freeze/v1', lane: P3C_LANE,
    controllerNonce: hex, freezeId: '', authority: descriptor.authority,
    reviewedHarness: { commit, closureMerkleRoot: hex },
    p3b2: { sourceBaseCommit: commit, resultCommit: commit, entrySha256: hex, supervisorSha256: hex,
      recipeSha256: hex, closureMerkleRoot: hex, candidateOpenCodeSha256: OPENCODE_IDENTITIES.linuxX64BinarySha256, accepted: true },
    openCode: { identities: OPENCODE_IDENTITIES, provenanceReceiptSha256: hex, releaseManifestSha256: hex,
      buildProvenanceBundleSha256: hex, archiveSha256: hex, binarySha256: hex, accepted: true, productionEligible: false },
    productComposition: { entrySha256: hex, descriptorSha256: hex, runtimeClosureMerkleRoot: hex },
    browser: { bundleMerkleRoot: hex, playwrightEntrySha256: hex, playwrightConfigSha256: hex,
      playwrightSpecSha256: hex, chromiumExecutableSha256: hex, workers: 1, retries: 0 },
    attemptLedger: descriptor.roots.sandboxParent, maximumFinalRuns: 1, authorityPolicy: anchor,
    harnessReviewerPublicKeySha256: sha256(reviewerBytes), runAuthorizationPublicKeySha256: sha256(authorizerBytes),
    productionGates: descriptor.productionGates }
  descriptor.control.freezeId = identify(freeze, 'freezeId', 'agent-teams.p3c.p3c1-freeze-id/v1')
  const review: any = { schemaVersion: 1, purpose: 'agent-teams.p3c.harness-review/v1', lane: P3C_LANE,
    freezeId: freeze.freezeId, reviewId: '', reviewedHarnessCommit: commit, harnessClosureMerkleRoot: hex,
    result: 'accepted', p0: 0, p1: 0, p2: 0,
    signerKeyId: sha256(`agent-teams.p3c.harness-reviewer-key-id/v1\0${reviewerBytes.toString('base64')}`) }
  descriptor.control.reviewId = identify(review, 'reviewId', 'agent-teams.p3c.harness-review-id/v1')
  review.signatureBase64 = sign(null, Buffer.from(canonicalJson(review)), reviewer.privateKey).toString('base64')
  const authorization: any = { schemaVersion: 1, purpose: 'agent-teams.p3c.controller-one-run-authorization/v1',
    lane: P3C_LANE, freezeId: freeze.freezeId, reviewId: review.reviewId, authorizationId: '', controllerNonce: hex,
    attemptLedger: freeze.attemptLedger, maximumFinalRuns: 1, authorizedAttempts: 1, disposition: 'authorize-once',
    signerKeyId: sha256(`agent-teams.p3c.run-authorizer-key-id/v1\0${authorizerBytes.toString('base64')}`) }
  descriptor.control.authorizationId = identify(authorization, 'authorizationId', 'agent-teams.p3c.one-run-authorization-id/v1')
  authorization.signatureBase64 = sign(null, Buffer.from(canonicalJson(authorization)), authorizer.privateKey).toString('base64')
  return { descriptor: descriptor as IntegrationDescriptor, anchor, reviewerBytes, authorizerBytes, review, authorization, freeze }
}

function verify(f: ReturnType<typeof fixture>, anchor = f.anchor) {
  verifyControlDocuments(f.descriptor, Buffer.from(canonicalJson(f.freeze)), Buffer.from(canonicalJson(f.review)),
    Buffer.from(canonicalJson(f.authorization)), f.reviewerBytes, f.authorizerBytes, anchor)
}

test('controller documents verify only against independent matching authorities', () => {
  const f = fixture()
  expect(() => verify(f)).not.toThrow()
  expect(() => verify(f, fixture().anchor)).toThrow('freeze_binding')
  expect(() => verify(f, { ...f.anchor, authorityEpoch: 2 })).toThrow('freeze_binding')
  expect(() => verify(f, { ...f.anchor, revokedSignerKeyIds: [f.review.signerKeyId] })).toThrow('freeze_binding')
})

test('valid content IDs cannot substitute for signatures', () => {
  const f = fixture()
  f.review.signatureBase64 = Buffer.alloc(64).toString('base64')
  expect(() => verify(f)).toThrow('harness_review_signature')
  const other = fixture()
  other.authorization.signatureBase64 = other.review.signatureBase64
  expect(() => verify(other)).toThrow('one_run_authorization_signature')
})
