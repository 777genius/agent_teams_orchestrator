import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs'
import { canonicalV2, requireV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Wire.js'
import { freezeSelectionV2, assertCompiledOwnerImageCurrent } from '../../../src/services/hostedControl/HostedControlBootstrapV2Launch.js'
import { selectedLaunchBootstrapDeadline, type SelectedLaunchPhase } from '../../../src/services/hostedControl/HostedControlSelectedLaunchPhase.js'
import { beforeDeadlineV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Descriptors.js'
import { createHostedApprovalActivationV2ProductionPins } from '../../../src/services/hostedControl/HostedApprovalActivationV2Pins.js'
import { verifyNativeLaunchAdmission } from './native-admission-codec.js'
import { requireNativePredecessorObservation, verifyNativePredecessorObservation } from './native-allocation-consumers.js'
import { parseIntegrationDescriptor } from './native-controller-contract.js'
import { parseControllerTrustAnchor } from './native-controller-verification.js'
import { admitSelectedControlDocuments } from './native-selected-control.js'
import { readReadonlyArtifact, retainReadonlyImage } from './native-readonly-artifact.js'
import { verifyP3B2Recipe } from './native-owner-recipe.js'
import { retainNativeDeploymentTrust } from './native-deployment-trust.js'

export { NATIVE_LAUNCH_ADMISSION } from './native-admission-codec.js'
const admissions = new WeakSet<object>()
export type NativeAdmittedLaunch = ReturnType<typeof admitNativeOwnerLaunch>
export function assertNativeAdmittedLaunch(value: NativeAdmittedLaunch): void {
  requireV2(admissions.has(value) && value.isCurrent(), 'native_launch_authority')
}

/** Data verifier only. It cannot mint NativeAdmittedLaunch or select roots. */
export function verifyNativeLaunchAdmissionSignature(phase: SelectedLaunchPhase, launcherPublicKey: string) {
  const launch = freezeSelectionV2(phase.launch)
  const { statement } = verifyNativeLaunchAdmission(phase.nativeAdmission, launcherPublicKey, launch, phase.sealed)
  return { statement, launch }
}

/** Authenticates the actual FD5 selection with the independently installed
 * existing launcher release root, then checks the existing control/recipe chain.
 * The signed statement can select public Product pins, never its own root key. */
export function admitNativeOwnerLaunch(phase: SelectedLaunchPhase) {
  const deadline = selectedLaunchBootstrapDeadline(phase)
  beforeDeadlineV2(deadline)
  const trust = retainNativeDeploymentTrust()
  const roots: { path: string; fd: number; stat: ReturnType<typeof fstatSync> }[] = []
  let image: ReturnType<typeof retainReadonlyImage> | undefined
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try { try { image?.close() } finally { trust.close() } } finally {
      for (const root of roots.reverse()) { try { closeSync(root.fd) } catch {} }
      roots.length = 0
    }
  }
  try {
    const { statement: s, launch } = verifyNativeLaunchAdmissionSignature(phase, trust.pin.launcherPublicKey)
    beforeDeadlineV2(deadline)
    requireV2(trust.pin.artifactDigest === launch.expectedHost.activation.ownerArtifactDigest &&
      trust.pin.artifactDigest === `sha256:${launch.ownerExecutable.sha256}`, 'native_launch_release_image')
    requireV2(s.generation.generation === launch.expectedHost.activation.ownerGeneration &&
      s.generation.ownerSessionId === launch.expectedHost.activation.ownerSessionId &&
      `sha256:${s.generation.admissionDocumentSha256}` === launch.expectedHost.activation.admissionDocumentDigest,
    'native_launch_generation')
    const predecessor = s.generation.generation === 4 ? requireNativePredecessorObservation() : undefined
    verifyNativePredecessorObservation(s, predecessor)
    beforeDeadlineV2(deadline)
    const activation = s.activation
    const activationPins = createHostedApprovalActivationV2ProductionPins({
      publicKeySpkiDerBase64url: activation.publicKeySpkiDerBase64url, contractDigest: `sha256:${activation.contractDigest}` })
    const descriptor = parseIntegrationDescriptor(Buffer.from(s.controllerDescriptor, 'utf8'))
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
        canonicalV2((recipe.compiled ?? recipe.source)!.module) === canonicalV2(launch.ownerModule) &&
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
      if (recipe.compiled) {
        assertCompiledOwnerImageCurrent(launch.ownerExecutable)
        if (image) image.assertCurrent()
        else image = retainReadonlyImage(payload, recipe.executable, deadline)
      } else {
        requireV2(!image, 'native_launch_variant_changed')
        readReadonlyArtifact(payload, descriptor.p3b2.entry, 32 * 1024 * 1024)
      }
      if (recipe.preparationModule) readReadonlyArtifact(payload, recipe.preparationModule, 32 * 1024 * 1024)
      if (recipe.kernelModule) readReadonlyArtifact(payload, recipe.kernelModule, 32 * 1024 * 1024)
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
        verifyPublic(); verifyNativePredecessorObservation(s, predecessor); return trust.isCurrent()
      } catch { return false }
    }
    requireV2(isCurrent(), 'native_launch_currentness')
    beforeDeadlineV2(deadline)
    const admitted = Object.freeze({ launch, activationPins,
      allocation: s.allocation, allocationSha256: s.allocationSha256, generation: s.generation,
      predecessorResults: s.predecessorResults,
      releasePinDigest: trust.releasePinDigest, launcherKeyId: trust.pin.launcherKeyId,
      proofKeyId: trust.proofKeyId, isCurrent, close })
    admissions.add(admitted)
    return admitted
  } catch { close(); throw new Error('hosted_owner_v2_native_launch_rejected') }
}
