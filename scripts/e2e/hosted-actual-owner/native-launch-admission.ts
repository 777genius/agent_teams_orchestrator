import { createPublicKey, verify } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs'
import { canonicalV2, hashV2, immutableV2, recordV2, requireV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Wire.js'
import { freezeSelectionV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Launch.js'
import type { SelectedLaunchPhase } from '../../../src/services/hostedControl/HostedControlSelectedLaunchPhase.js'
import { createHostedApprovalActivationV2ProductionPins } from '../../../src/services/hostedControl/HostedApprovalActivationV2Pins.js'
import { MATRIX_ROWS, type MatrixRow } from './native-http-contract.js'
import { parseIntegrationDescriptor } from './native-controller-contract.js'
import { parseControllerTrustAnchor } from './native-controller-verification.js'
import { admitSelectedControlDocuments } from './native-selected-control.js'
import { readReadonlyArtifact } from './native-readonly-artifact.js'
import { verifyP3B2Recipe } from './native-owner-recipe.js'
import { retainNativeDeploymentTrust } from './native-deployment-trust.js'

export const NATIVE_LAUNCH_ADMISSION = 'agent-teams.owner-native-launch-admission/v1'
const admissions = new WeakSet<object>()
export type NativeAdmittedLaunch = ReturnType<typeof admitNativeOwnerLaunch>
export function assertNativeAdmittedLaunch(value: NativeAdmittedLaunch): void {
  requireV2(admissions.has(value) && value.isCurrent(), 'native_launch_authority')
}

/** Data verifier only. It cannot mint NativeAdmittedLaunch or select roots. */
export function verifyNativeLaunchAdmissionSignature(phase: SelectedLaunchPhase, launcherPublicKey: string) {
  const envelope = recordV2(phase.nativeAdmission, 'statement,signatureBase64url')
  const s = recordV2(envelope.statement, 'format,launchSha256,sealedSha256,controllerDescriptor,controllerTrustAnchor,activation,scenario')
  const launch = freezeSelectionV2(phase.launch)
  requireV2(s.format === NATIVE_LAUNCH_ADMISSION && s.launchSha256 === hashV2(canonicalV2(launch)) &&
    s.sealedSha256 === hashV2(canonicalV2(phase.sealed)), 'native_launch_statement')
  requireV2(typeof envelope.signatureBase64url === 'string' && /^[A-Za-z0-9_-]{86}$/.test(envelope.signatureBase64url), 'native_launch_signature')
  const signature = Buffer.from(envelope.signatureBase64url, 'base64url')
  requireV2(signature.length === 64 && signature.toString('base64url') === envelope.signatureBase64url, 'native_launch_signature')
  const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: launcherPublicKey } })
  requireV2(verify(null, Buffer.from(`${NATIVE_LAUNCH_ADMISSION}\0${canonicalV2(s)}`), key, signature), 'native_launch_signature')
  return { statement: s, launch }
}

/** Authenticates the actual FD5 selection with the independently installed
 * existing launcher release root, then checks the existing control/recipe chain.
 * The signed statement can select public Product pins, never its own root key. */
export function admitNativeOwnerLaunch(phase: SelectedLaunchPhase) {
  const trust = retainNativeDeploymentTrust()
  const roots: { path: string; fd: number; stat: ReturnType<typeof fstatSync> }[] = []
  let closed = false
  const close = () => {
    if (closed) return
    closed = true; trust.close()
    for (const root of roots.reverse()) { try { closeSync(root.fd) } catch {} }
    roots.length = 0
  }
  try {
    const { statement: s, launch } = verifyNativeLaunchAdmissionSignature(phase, trust.pin.launcherPublicKey)
    const key = createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:trust.pin.launcherPublicKey}})
    requireV2(trust.pin.artifactDigest === launch.expectedHost.activation.ownerArtifactDigest &&
      trust.pin.artifactDigest === `sha256:${launch.ownerExecutable.sha256}`, 'native_launch_release_image')
    const scenario = recordV2(s.scenario, 'row,routeId')
    requireV2(MATRIX_ROWS.includes(scenario.row as MatrixRow) && typeof scenario.routeId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(scenario.routeId), 'native_launch_scenario')
    const activation = recordV2(s.activation, 'publicKeySpkiDerBase64url,contractDigest')
    requireV2(typeof activation.publicKeySpkiDerBase64url === 'string' && typeof activation.contractDigest === 'string', 'native_launch_activation')
    const activationPins = createHostedApprovalActivationV2ProductionPins({
      publicKeySpkiDerBase64url: activation.publicKeySpkiDerBase64url, contractDigest: activation.contractDigest })
    requireV2(!Buffer.from(activationPins.publicKeySpkiDer).equals(Buffer.from(key.export({type:'spki',format:'der'}))), 'native_launch_distinct_keys')
    const descriptor = parseIntegrationDescriptor(Buffer.from(canonicalV2(s.controllerDescriptor)))
    const policy = parseControllerTrustAnchor(s.controllerTrustAnchor)
    const root = (path: string) => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      roots.push({ path, fd, stat: fstatSync(fd) }); return fd
    }
    const documents = root('/admission'), payload = root('/p3b2')
    const verifyPublic = () => {
      const control = admitSelectedControlDocuments(policy, descriptor, documents)
      requireV2(canonicalV2(control) === canonicalV2(launch.selectedControl), 'native_launch_control')
      const recipe = verifyP3B2Recipe(readReadonlyArtifact(payload, descriptor.p3b2.recipe, 16 * 1024 * 1024), descriptor)
      requireV2(recipe?.supervisor && launch.selectedSupervisor && launch.selectedRecipe, 'native_launch_recipe')
      requireV2(recipe.recipeSha256 === launch.recipeSha256 &&
        canonicalV2(recipe.source.module) === canonicalV2(launch.ownerModule) &&
        recipe.executable.sha256 === launch.ownerExecutable.sha256 &&
        recipe.executable.device === launch.ownerExecutable.device && recipe.executable.inode === launch.ownerExecutable.inode &&
        recipe.executable.size === launch.ownerExecutable.size &&
        recipe.supervisor.executable.sha256 === launch.supervisorExecutable.sha256 &&
        recipe.supervisor.executable.device === launch.supervisorExecutable.device &&
        recipe.supervisor.executable.inode === launch.supervisorExecutable.inode &&
        recipe.supervisor.module.sha256 === launch.selectedSupervisor.module.sha256 &&
        recipe.supervisor.loader.sha256 === launch.selectedSupervisor.loader.sha256 &&
        descriptor.p3b2.closure.manifestSha256 === launch.ownerArtifactManifestSha256 &&
        descriptor.openCode.linuxX64Binary.sha256 === launch.expectedHost.executable.sha256 &&
        descriptor.controllerNonce === launch.expectedHost.activation.controllerNonce, 'native_launch_selected_binding')
      readReadonlyArtifact(payload, descriptor.p3b2.entry, 32 * 1024 * 1024)
      readReadonlyArtifact(payload, recipe.supervisor.module, 32 * 1024 * 1024)
    }
    const isCurrent = () => {
      if (closed || !trust.isCurrent()) return false
      try {
        for (const root of roots) {
          const linked = lstatSync(root.path), retained = fstatSync(root.fd)
          requireV2(linked.isDirectory() && !linked.isSymbolicLink() && linked.dev === root.stat.dev &&
            linked.ino === root.stat.ino && retained.dev === root.stat.dev && retained.ino === root.stat.ino,
          'native_launch_root_changed')
        }
        verifyPublic(); return trust.isCurrent()
      } catch { return false }
    }
    requireV2(isCurrent(), 'native_launch_currentness')
    const admitted = Object.freeze({ launch, activationPins,
      scenario: immutableV2({ row: scenario.row as MatrixRow, routeId: scenario.routeId }),
      releasePinDigest: trust.releasePinDigest, launcherKeyId: trust.pin.launcherKeyId,
      proofKeyId: trust.proofKeyId, isCurrent, close })
    admissions.add(admitted)
    return admitted
  } catch { close(); throw new Error('hosted_owner_v2_native_launch_rejected') }
}
