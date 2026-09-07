// Owner port of Product bd91501036637c76ffcfcc5584ecdd26e9a64a98 public controller verification.
// No environment authority or top-level filesystem reads. Deployment roots must be independently provisioned.
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { canonicalJson, exactRecord, sha256 } from './native-http-contract.js';
import { HARNESS_REVIEW_PURPOSE, MAXIMUM_FINAL_RUNS, ONE_RUN_AUTHORIZATION_PURPOSE, OPENCODE_IDENTITIES, P3C1_FREEZE_PURPOSE, P3C_LANE, type IntegrationDescriptor } from './native-controller-contract.js';
function parseCanonicalObject(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`p3c_${label}_json`);
  }
  if (canonicalJson(value) !== bytes.toString('utf8')) throw new Error(`p3c_${label}_noncanonical`);
  return value as Record<string, unknown>;
}

function contentAddress(
  item: Record<string, unknown>,
  identityField: string,
  domain: string,
  omittedFields: readonly string[] = []
): string {
  const unsigned = { ...item };
  delete unsigned[identityField];
  for (const field of omittedFields) delete unsigned[field];
  return sha256(`${domain}\0${canonicalJson(unsigned)}`);
}

function exactIdentityTuple(value: unknown, label: string): Record<string, unknown> {
  return exactRecord(value, ['device', 'inode', 'mountId'], label);
}

function verifyAuthoritySignature(
  publicKeyBytes: Buffer,
  document: Record<string, unknown>,
  signatureField: string,
  label: string
): void {
  const signature = document[signatureField];
  if (
    typeof signature !== 'string' ||
    signature.length !== 88 ||
    Buffer.from(signature, 'base64').length !== 64 ||
    Buffer.from(signature, 'base64').toString('base64') !== signature
  )
    throw new Error(`p3c_${label}_signature_frame`);
  const unsigned = { ...document };
  delete unsigned[signatureField];
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' });
  } catch {
    throw new Error('p3c_controller_public_key');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('p3c_controller_public_key_type');
  if (
    !verifySignature(
      null,
      Buffer.from(canonicalJson(unsigned)),
      key,
      Buffer.from(signature, 'base64')
    )
  )
    throw new Error(`p3c_${label}_signature`);
}

function signerKeyId(publicKeyBytes: Buffer, role: 'harness-reviewer' | 'run-authorizer'): string {
  return sha256(`agent-teams.p3c.${role}-key-id/v1\0${publicKeyBytes.toString('base64')}`);
}

export interface ControllerTrustAnchor {
  readonly schemaVersion: 1;
  readonly purpose: 'agent-teams.p3c.controller-trust-anchor/v1';
  readonly authorityEpoch: number;
  readonly harnessReviewerPublicKeySha256: string;
  readonly runAuthorizationPublicKeySha256: string;
  readonly revokedSignerKeyIds: readonly string[];
}

export function parseControllerTrustAnchor(value: unknown): ControllerTrustAnchor {
  const anchor = exactRecord(
    value,
    [
      'schemaVersion',
      'purpose',
      'authorityEpoch',
      'harnessReviewerPublicKeySha256',
      'runAuthorizationPublicKeySha256',
      'revokedSignerKeyIds',
    ],
    'controller_trust_anchor'
  );
  if (
    anchor.schemaVersion !== 1 ||
    anchor.purpose !== 'agent-teams.p3c.controller-trust-anchor/v1' ||
    !Number.isSafeInteger(anchor.authorityEpoch) ||
    (anchor.authorityEpoch as number) < 1 ||
    typeof anchor.harnessReviewerPublicKeySha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(anchor.harnessReviewerPublicKeySha256) ||
    typeof anchor.runAuthorizationPublicKeySha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(anchor.runAuthorizationPublicKeySha256) ||
    anchor.harnessReviewerPublicKeySha256 === anchor.runAuthorizationPublicKeySha256 ||
    !Array.isArray(anchor.revokedSignerKeyIds) ||
    anchor.revokedSignerKeyIds.some(
      (keyId) => typeof keyId !== 'string' || !/^[0-9a-f]{64}$/u.test(keyId)
    ) ||
    new Set(anchor.revokedSignerKeyIds as string[]).size !== anchor.revokedSignerKeyIds.length
  )
    throw new Error('p3c_controller_trust_anchor');
  return Object.freeze({
    schemaVersion: 1,
    purpose: 'agent-teams.p3c.controller-trust-anchor/v1',
    authorityEpoch: anchor.authorityEpoch as number,
    harnessReviewerPublicKeySha256: anchor.harnessReviewerPublicKeySha256,
    runAuthorizationPublicKeySha256: anchor.runAuthorizationPublicKeySha256,
    revokedSignerKeyIds: Object.freeze([...(anchor.revokedSignerKeyIds as string[])]),
  }) as ControllerTrustAnchor;
}

export function verifyControlDocuments(
  descriptor: IntegrationDescriptor,
  freezeBytes: Buffer,
  reviewBytes: Buffer,
  authorizationBytes: Buffer,
  reviewerPublicKeyBytes: Buffer,
  runAuthorizationPublicKeyBytes: Buffer,
  trustAnchor: ControllerTrustAnchor
): void {
  for (const document of [freezeBytes, reviewBytes, authorizationBytes]) {
    if (document.length < 2 || document.length > 2 * 1024 * 1024) throw new Error('p3c_controller_document_limit');
  }
  for (const key of [reviewerPublicKeyBytes, runAuthorizationPublicKeyBytes]) {
    if (key.length < 1 || key.length > 4096) throw new Error('p3c_controller_key_limit');
  }
  // Copy and validate caller-provisioned policy independently of the freeze.
  trustAnchor = parseControllerTrustAnchor(trustAnchor);
  const freeze = exactRecord(
    parseCanonicalObject(freezeBytes, 'p3c1_freeze'),
    [
      'schemaVersion',
      'purpose',
      'lane',
      'controllerNonce',
      'freezeId',
      'authority',
      'reviewedHarness',
      'p3b2',
      'openCode',
      'productComposition',
      'browser',
      'attemptLedger',
      'maximumFinalRuns',
      'authorityPolicy',
      'harnessReviewerPublicKeySha256',
      'runAuthorizationPublicKeySha256',
      'productionGates',
    ],
    'p3c1_freeze'
  );
  const reviewedHarness = exactRecord(
    freeze.reviewedHarness,
    ['commit', 'closureMerkleRoot'],
    'p3c1_reviewed_harness'
  );
  const p3b2 = exactRecord(
    freeze.p3b2,
    [
      'sourceBaseCommit',
      'resultCommit',
      'entrySha256',
      'supervisorSha256',
      'recipeSha256',
      'closureMerkleRoot',
      'candidateOpenCodeSha256',
      'accepted',
    ],
    'p3c1_p3b2'
  );
  const openCode = exactRecord(
    freeze.openCode,
    [
      'identities',
      'provenanceReceiptSha256',
      'releaseManifestSha256',
      'buildProvenanceBundleSha256',
      'archiveSha256',
      'binarySha256',
      'accepted',
      'productionEligible',
    ],
    'p3c1_opencode'
  );
  const product = exactRecord(
    freeze.productComposition,
    ['entrySha256', 'descriptorSha256', 'runtimeClosureMerkleRoot'],
    'p3c1_product_composition'
  );
  const browser = exactRecord(
    freeze.browser,
    [
      'bundleMerkleRoot',
      'playwrightEntrySha256',
      'playwrightConfigSha256',
      'playwrightSpecSha256',
      'chromiumExecutableSha256',
      'workers',
      'retries',
    ],
    'p3c1_browser'
  );
  const attemptLedger = exactIdentityTuple(freeze.attemptLedger, 'p3c1_attempt_ledger');
  const authorityPolicy = parseControllerTrustAnchor(freeze.authorityPolicy);
  const reviewerKeyId = signerKeyId(reviewerPublicKeyBytes, 'harness-reviewer');
  const authorizerKeyId = signerKeyId(runAuthorizationPublicKeyBytes, 'run-authorizer');
  if (
    freeze.schemaVersion !== 1 ||
    freeze.purpose !== P3C1_FREEZE_PURPOSE ||
    freeze.lane !== P3C_LANE ||
    freeze.controllerNonce !== descriptor.controllerNonce ||
    freeze.maximumFinalRuns !== MAXIMUM_FINAL_RUNS ||
    canonicalJson(authorityPolicy) !== canonicalJson(trustAnchor) ||
    freeze.freezeId !== descriptor.control.freezeId ||
    contentAddress(freeze, 'freezeId', 'agent-teams.p3c.p3c1-freeze-id/v1') !==
      descriptor.control.freezeId ||
    canonicalJson(freeze.authority) !== canonicalJson(descriptor.authority) ||
    reviewedHarness.commit !== descriptor.product.finalHarnessCommit ||
    reviewedHarness.closureMerkleRoot !== descriptor.product.harnessClosure.merkleRoot ||
    p3b2.sourceBaseCommit !== descriptor.p3b2.sourceBaseCommit ||
    p3b2.resultCommit !== descriptor.p3b2.resultCommit ||
    p3b2.entrySha256 !== descriptor.p3b2.entry.sha256 ||
    p3b2.supervisorSha256 !== descriptor.p3b2.supervisor.sha256 ||
    p3b2.recipeSha256 !== descriptor.p3b2.recipeSha256 ||
    p3b2.closureMerkleRoot !== descriptor.p3b2.closure.merkleRoot ||
    p3b2.candidateOpenCodeSha256 !== OPENCODE_IDENTITIES.linuxX64BinarySha256 ||
    p3b2.accepted !== true ||
    canonicalJson(openCode.identities) !== canonicalJson(OPENCODE_IDENTITIES) ||
    openCode.provenanceReceiptSha256 !== descriptor.openCode.acquisitionReceipt.sha256 ||
    openCode.releaseManifestSha256 !== descriptor.openCode.releaseManifest.sha256 ||
    openCode.buildProvenanceBundleSha256 !== descriptor.openCode.buildProvenanceBundle.sha256 ||
    openCode.archiveSha256 !== descriptor.openCode.linuxX64Archive.sha256 ||
    openCode.binarySha256 !== descriptor.openCode.linuxX64Binary.sha256 ||
    openCode.accepted !== true ||
    openCode.productionEligible !== false ||
    product.entrySha256 !== descriptor.product.compositionEntry.sha256 ||
    product.descriptorSha256 !== descriptor.product.compositionDescriptor.sha256 ||
    product.runtimeClosureMerkleRoot !== descriptor.product.runtimeClosure.merkleRoot ||
    browser.bundleMerkleRoot !== descriptor.product.browserBundle.merkleRoot ||
    browser.playwrightEntrySha256 !== descriptor.product.playwrightEntry.sha256 ||
    browser.playwrightConfigSha256 !== descriptor.product.playwrightConfig.sha256 ||
    browser.playwrightSpecSha256 !== descriptor.product.playwrightSpec.sha256 ||
    browser.chromiumExecutableSha256 !== descriptor.product.chromiumExecutable.sha256 ||
    browser.workers !== 1 ||
    browser.retries !== 0 ||
    canonicalJson(attemptLedger) !==
      canonicalJson({
        device: descriptor.roots.sandboxParent.device,
        inode: descriptor.roots.sandboxParent.inode,
        mountId: descriptor.roots.sandboxParent.mountId,
      }) ||
    freeze.harnessReviewerPublicKeySha256 !== descriptor.control.harnessReviewerPublicKey.sha256 ||
    freeze.runAuthorizationPublicKeySha256 !==
      descriptor.control.runAuthorizationPublicKey.sha256 ||
    sha256(reviewerPublicKeyBytes) !== descriptor.control.harnessReviewerPublicKey.sha256 ||
    sha256(runAuthorizationPublicKeyBytes) !==
      descriptor.control.runAuthorizationPublicKey.sha256 ||
    sha256(reviewerPublicKeyBytes) === sha256(runAuthorizationPublicKeyBytes) ||
    sha256(reviewerPublicKeyBytes) !== trustAnchor.harnessReviewerPublicKeySha256 ||
    sha256(runAuthorizationPublicKeyBytes) !== trustAnchor.runAuthorizationPublicKeySha256 ||
    trustAnchor.revokedSignerKeyIds.includes(reviewerKeyId) ||
    trustAnchor.revokedSignerKeyIds.includes(authorizerKeyId) ||
    canonicalJson(freeze.productionGates) !== canonicalJson(descriptor.productionGates)
  )
    throw new Error('p3c_p3c1_freeze_binding');

  const review = exactRecord(
    parseCanonicalObject(reviewBytes, 'harness_review'),
    [
      'schemaVersion',
      'purpose',
      'lane',
      'freezeId',
      'reviewId',
      'reviewedHarnessCommit',
      'harnessClosureMerkleRoot',
      'result',
      'p0',
      'p1',
      'p2',
      'signerKeyId',
      'signatureBase64',
    ],
    'harness_review'
  );
  if (
    review.schemaVersion !== 1 ||
    review.purpose !== HARNESS_REVIEW_PURPOSE ||
    review.lane !== P3C_LANE ||
    review.freezeId !== descriptor.control.freezeId ||
    review.reviewId !== descriptor.control.reviewId ||
    contentAddress(review, 'reviewId', 'agent-teams.p3c.harness-review-id/v1', [
      'signatureBase64',
    ]) !== descriptor.control.reviewId ||
    review.reviewedHarnessCommit !== descriptor.product.finalHarnessCommit ||
    review.harnessClosureMerkleRoot !== descriptor.product.harnessClosure.merkleRoot ||
    review.result !== 'accepted' ||
    review.p0 !== 0 ||
    review.p1 !== 0 ||
    review.p2 !== 0 ||
    review.signerKeyId !== reviewerKeyId
  )
    throw new Error('p3c_harness_review_binding');
  verifyAuthoritySignature(reviewerPublicKeyBytes, review, 'signatureBase64', 'harness_review');

  const authorization = exactRecord(
    parseCanonicalObject(authorizationBytes, 'one_run_authorization'),
    [
      'schemaVersion',
      'purpose',
      'lane',
      'freezeId',
      'reviewId',
      'authorizationId',
      'controllerNonce',
      'attemptLedger',
      'maximumFinalRuns',
      'authorizedAttempts',
      'disposition',
      'signerKeyId',
      'signatureBase64',
    ],
    'one_run_authorization'
  );
  if (
    authorization.schemaVersion !== 1 ||
    authorization.purpose !== ONE_RUN_AUTHORIZATION_PURPOSE ||
    authorization.lane !== P3C_LANE ||
    authorization.freezeId !== descriptor.control.freezeId ||
    authorization.reviewId !== descriptor.control.reviewId ||
    authorization.authorizationId !== descriptor.control.authorizationId ||
    contentAddress(
      authorization,
      'authorizationId',
      'agent-teams.p3c.one-run-authorization-id/v1',
      ['signatureBase64']
    ) !== descriptor.control.authorizationId ||
    authorization.controllerNonce !== descriptor.controllerNonce ||
    authorization.maximumFinalRuns !== MAXIMUM_FINAL_RUNS ||
    canonicalJson(
      exactIdentityTuple(authorization.attemptLedger, 'authorization_attempt_ledger')
    ) !== canonicalJson(attemptLedger) ||
    authorization.authorizedAttempts !== 1 ||
    authorization.disposition !== 'authorize-once' ||
    authorization.signerKeyId !== authorizerKeyId ||
    authorization.signerKeyId === review.signerKeyId
  )
    throw new Error('p3c_one_run_authorization_binding');
  verifyAuthoritySignature(
    runAuthorizationPublicKeyBytes,
    authorization,
    'signatureBase64',
    'one_run_authorization'
  );
}

export function verifyP3B2Recipe(bytes: Buffer, descriptor: IntegrationDescriptor): void {
  if (bytes.length < 2 || bytes.length > 16 * 1024 * 1024) throw new Error('p3c_recipe_limit');
  const recipe = exactRecord(
    parseCanonicalObject(bytes, 'p3b2_recipe'),
    [
      'schemaVersion',
      'purpose',
      'sourceBaseCommit',
      'resultCommit',
      'entry',
      'supervisor',
      'closureMerkleRoot',
      'candidateOpenCodeSha256',
      'argv',
      'sourceTreeRequired',
      'accepted',
    ],
    'p3b2_recipe'
  );
  const entry = exactRecord(recipe.entry, ['relativePath', 'sha256'], 'p3b2_recipe_entry');
  const supervisor = exactRecord(
    recipe.supervisor,
    ['relativePath', 'sha256'],
    'p3b2_recipe_supervisor'
  );
  if (
    recipe.schemaVersion !== 1 ||
    recipe.purpose !== 'agent-teams.p3b2.built-actual-owner-entry/v1' ||
    recipe.sourceBaseCommit !== descriptor.p3b2.sourceBaseCommit ||
    recipe.resultCommit !== descriptor.p3b2.resultCommit ||
    entry.relativePath !== descriptor.p3b2.entry.relativePath ||
    entry.sha256 !== descriptor.p3b2.entry.sha256 ||
    supervisor.relativePath !== descriptor.p3b2.supervisor.relativePath ||
    supervisor.sha256 !== descriptor.p3b2.supervisor.sha256 ||
    recipe.closureMerkleRoot !== descriptor.p3b2.closure.merkleRoot ||
    recipe.candidateOpenCodeSha256 !== OPENCODE_IDENTITIES.linuxX64BinarySha256 ||
    canonicalJson(recipe.argv) !==
      canonicalJson(['--runtime-manifest', '/sandbox/runtime-manifest.json']) ||
    recipe.sourceTreeRequired !== false ||
    recipe.accepted !== true
  )
    throw new Error('p3c_p3b2_recipe_binding');
}
