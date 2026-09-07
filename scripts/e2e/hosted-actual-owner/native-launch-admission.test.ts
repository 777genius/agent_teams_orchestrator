import { expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { canonicalV2, hashV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Wire.js'
import { verifyNativeLaunchAdmissionSignature, NATIVE_LAUNCH_ADMISSION } from './native-launch-admission.js'
import { SELECTED_LAUNCH_PHASE, type SelectedLaunchPhase } from '../../../src/services/hostedControl/HostedControlSelectedLaunchPhase.js'

// These are ephemeral test signatures, not installed deployment/root authority.
test('launcher signature authenticates exact actual selection, scenario and independent Product key pins', () => {
  const {privateKey,publicKey} = generateKeyPairSync('ed25519')
  const launcher = publicKey.export({format:'jwk'}).x!
  // The signature verifier is a data verifier; full launch/process/recipe
  // admission remains the real namespace reader's responsibility.
  const launch = {ownerProcessStartToken:'a'.repeat(64),bootstrapV2HeaderSha256:'b'.repeat(64)}
  const statement = {format:NATIVE_LAUNCH_ADMISSION,launchSha256:hashV2(canonicalV2(launch)),sealedSha256:hashV2(canonicalV2({})),
    controllerDescriptor:{selected:'descriptor'},controllerTrustAnchor:{selected:'root'},
    activation:{publicKeySpkiDerBase64url:'public-pin',contractDigest:'sha256:'+'c'.repeat(64)},
    scenario:{row:'01_pending_before_http',routeId:'route_1'}}
  const signatureBase64url = sign(null,Buffer.from(NATIVE_LAUNCH_ADMISSION+'\0'+canonicalV2(statement)),privateKey).toString('base64url')
  const phase = {contract:SELECTED_LAUNCH_PHASE,launch,sealed:{},nativeAdmission:{statement,signatureBase64url}} as unknown as SelectedLaunchPhase
  expect(verifyNativeLaunchAdmissionSignature(phase,launcher).statement).toEqual(statement)
  const changed = structuredClone(phase) as any
  changed.launch.ownerProcessStartToken = 'd'.repeat(64)
  expect(() => verifyNativeLaunchAdmissionSignature(changed,launcher)).toThrow()
  const changedSealing = {...phase,sealed:{observedMonotonicNs:'999'}} as SelectedLaunchPhase
  expect(() => verifyNativeLaunchAdmissionSignature(changedSealing,launcher)).toThrow()
  for (const mutate of [
    (s: any) => {s.scenario.routeId='route_2'},
    (s: any) => {s.activation.publicKeySpkiDerBase64url='substituted'},
    (s: any) => {s.controllerTrustAnchor.selected='attacker'},
  ]) {
    const copy = structuredClone(phase) as any; mutate(copy.nativeAdmission.statement)
    expect(() => verifyNativeLaunchAdmissionSignature(copy,launcher)).toThrow()
  }
  const wrong = generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x!
  expect(() => verifyNativeLaunchAdmissionSignature(phase,wrong)).toThrow()
  expect(() => verifyNativeLaunchAdmissionSignature({...phase,nativeAdmission:undefined},launcher)).toThrow()
})
