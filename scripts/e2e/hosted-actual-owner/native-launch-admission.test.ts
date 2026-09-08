import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { canonicalJson, sha256 } from './native-http-contract.js'
import { decodeNativeLaunchAdmission, decodeNativeAdmissionStatement, nativeLaunchAdmissionSigningBytes,
  verifyNativeLaunchAdmission, NATIVE_ADMISSION_MAXIMUM } from './native-admission-codec.js'
import { verifyNativeLaunchAdmissionSignature, assertNativeAdmittedLaunch } from './native-launch-admission.js'
import { nativeAdmissionFixture, fixtureSign, RFC8032_ACTIVATION_HEX, RFC8032_LAUNCHER_HEX,
  pairedNativeCodecVectors, signFixtureStatement } from './native-admission.fixture.js'
import { decodeSelectedLaunchPhase } from '../../../src/services/hostedControl/HostedControlSelectedLaunchPhase.js'
import { parseIntegrationDescriptor } from './native-controller-contract.js'

test('four full Product allocation vectors sign with exact v2 NUL/canonical UTF8 bytes', () => {
  for (const vector of pairedNativeCodecVectors()) {
    const decoded = decodeSelectedLaunchPhase(Buffer.from(vector.frameHex, 'hex'))
    const verified = verifyNativeLaunchAdmissionSignature(decoded, vector.launcherPublicKey)
    assert.deepEqual(verified.statement, vector.statement)
    assert(Object.isFrozen(verified.statement.allocation.entries))
    assert.equal(verified.statement.generation.generation, vector.generation)
    assert.deepEqual(Buffer.from(vector.signingBytesHex, 'hex'), Buffer.concat([
      Buffer.from('agent-teams.owner-native-launch-admission/v2'), Buffer.from([0]), Buffer.from(canonicalJson(vector.statement))]))
    assert.throws(() => assertNativeAdmittedLaunch(verified as never))
  }
})
test('wrong domains, keys, signatures and changed actual launch/sealed/start/header fail', () => {
  const f = nativeAdmissionFixture(), bytes = nativeLaunchAdmissionSigningBytes(f.statement)
  const verify = (admission: unknown, launch = f.phase.launch, sealed = f.phase.sealed, key = f.launcherPublicKey) =>
    verifyNativeLaunchAdmission(admission, key, launch, sealed)
  for (const wrong of [Buffer.from(canonicalJson(f.statement)), Buffer.concat([bytes, Buffer.from('\n')]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
    Buffer.from(`agent-teams.owner-native-launch-admission/v1\0${canonicalJson(f.statement)}`)]) {
    assert.throws(() => verify({ ...f.admission, signatureBase64url: fixtureSign(wrong) }))
  }
  assert.throws(() => verify(f.admission, f.phase.launch, f.phase.sealed, Buffer.from(RFC8032_ACTIVATION_HEX, 'hex').toString('base64url')))
  for (const signatureBase64url of ['', f.admission.signatureBase64url + '=', 'A'.repeat(86), 'A'.repeat(85) + 'B'])
    assert.throws(() => verify({ ...f.admission, signatureBase64url }))
  for (const patch of [{ ownerProcessStartToken: '0'.repeat(64) }, { bootstrapV2HeaderSha256: '0'.repeat(64) },
    { ownerModule: { ...f.phase.launch.ownerModule, path: '/p3b2/bin/hosted-owner' } },
    { ownerExecutable: { ...f.phase.launch.ownerExecutable, inode: '999999' } }])
    assert.throws(() => verify(f.admission, { ...f.phase.launch, ...patch }))
  assert.throws(() => verify(f.admission, f.phase.launch, { ...f.phase.sealed, observedMonotonicNs: '999' }))
  const equalKeys = { ...f.statement, activation: { ...f.statement.activation,
    publicKeySpkiDerBase64url: Buffer.from('302a300506032b6570032100' + RFC8032_LAUNCHER_HEX, 'hex').toString('base64url') } }
  assert.throws(() => verify(signFixtureStatement(equalKeys)))
  const changedAllocation = { ...f.allocation, generations: f.allocation.generations.map(g => g.generation === 1
    ? { ...g, ownerSessionId: 'owner-session_changed' } : g) }
  const changedStatement = decodeNativeAdmissionStatement({ ...f.statement, allocation: changedAllocation,
    allocationSha256: sha256(canonicalJson(changedAllocation)),
    generation: changedAllocation.generations.find(g => g.generation === 1) })
  assert.throws(() => verify({ ...f.admission, statement: changedStatement }))
})
test('strict envelope, bounds, descriptor JSON string, allocation and predecessor vocabulary', () => {
  const f = nativeAdmissionFixture()
  for (const admission of [undefined, null, { ...f.admission, extra: true }, { statement: f.statement }])
    assert.throws(() => decodeNativeLaunchAdmission(admission))
  for (const patch of [{ format: 'agent-teams.owner-native-launch-admission/v1' }, { scenario: { row: '01', routeId: 'route-A' } },
    { controllerDescriptor: { fixture: 'object' } }, { controllerDescriptor: JSON.stringify(f.statement.controllerDescriptor) },
    { controllerDescriptor: f.statement.controllerDescriptor + '\n' }, { controllerDescriptor: '\ufeff{}' },
    { controllerDescriptor: canonicalJson({ huge: 'x'.repeat(48 * 1024) }) },
    { launchSha256: 'A'.repeat(64) }, { allocationSha256: 'sha256:' + 'a'.repeat(64) },
    { ownerProcessStartToken: 'short' }, { generation: { ...f.statement.generation, ownerSessionId: 'other' } },
    { predecessorResults: nativeAdmissionFixture(4).statement.predecessorResults },
    { unknown: 'x'.repeat(NATIVE_ADMISSION_MAXIMUM) }])
    assert.throws(() => decodeNativeAdmissionStatement({ ...f.statement, ...patch }))
  // Envelope canonicality is not descriptor admission. Actual boundary invokes
  // the strict parser on contents, never JSON.stringify(contents).
  assert.throws(() => parseIntegrationDescriptor(Buffer.from(f.statement.controllerDescriptor, 'utf8')))
  const g4 = nativeAdmissionFixture(4).statement
  for (const predecessorResults of [[], [...g4.predecessorResults, ...g4.predecessorResults],
    g4.predecessorResults.map(r => ({ ...r, generation: 4 })),
    g4.predecessorResults.map(r => ({ ...r, operationId: 'Nallow' })),
    g4.predecessorResults.map(r => ({ ...r, ownerProcessStartToken: g4.ownerProcessStartToken })),
    g4.predecessorResults.map(r => ({ ...r, returnWitnessSha256: undefined }))])
    assert.throws(() => decodeNativeAdmissionStatement({ ...g4, predecessorResults }))
})
