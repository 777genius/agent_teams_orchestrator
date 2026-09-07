import { parseIntegrationDescriptor, type FilePin } from './native-controller-contract.js'
import { assertFileCurrent, assertRootCurrent, closeAnchors, openFileAnchor, openRootAnchor,
  type FileAnchor, type RootAnchor } from './native-controller-anchors.js'
import { assertNativeReadonlyRoot } from './native-readonly-mount.js'
import { readStable, verifyClosure, type ClosureEvidence } from './native-controller-files.js'
import { parseControllerTrustAnchor, verifyControlDocuments, type ControllerTrustAnchor } from './native-controller-verification.js'
import { verifyP3B2Recipe } from './native-owner-recipe.js'
import { beforeDeadlineV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Descriptors.js'

/** Retains actual public controller documents using Product's exact anchored
 * file contract and verifies all five signed artifact closures on actual
 * readonly mounts. This does not admit the dynamic launch or grant provider custody.
 * The caller must supply payload-provisioned policy, independently of FD5. */
export async function retainNativeControllerDocuments(descriptorBytes: Uint8Array,
  provisionedPolicy: ControllerTrustAnchor, deadline: number) {
  beforeDeadlineV2(deadline)
  const descriptor = parseIntegrationDescriptor(Buffer.from(descriptorBytes))
  const policy = parseControllerTrustAnchor(provisionedPolicy)
  const roots = new Map<FilePin['root'], RootAnchor>()
  const files: FileAnchor[] = []
  const closureRoots = new Set<RootAnchor>()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await closeAnchors([...files, ...roots.values()])
  }
  try {
    const read = async (pin: FilePin, maximum: number) => {
      beforeDeadlineV2(deadline)
      let root = roots.get(pin.root)
      if (!root) {
        root = await openRootAnchor(pin.root, descriptor.roots[pin.root])
        roots.set(pin.root, root)
      }
      beforeDeadlineV2(deadline)
      const file = await openFileAnchor(root, pin)
      files.push(file)
      beforeDeadlineV2(deadline)
      const bytes = await readStable(file, maximum, deadline)
      beforeDeadlineV2(deadline)
      return bytes
    }
    // Sequential acquisition keeps every opened resource accounted for before
    // a later failure; no abandoned racing file acquisition can leak a handle.
    const freeze = await read(descriptor.control.freeze, 2 * 1024 * 1024)
    const review = await read(descriptor.control.harnessReview, 2 * 1024 * 1024)
    const authorization = await read(descriptor.control.oneRunAuthorization, 2 * 1024 * 1024)
    const reviewer = await read(descriptor.control.harnessReviewerPublicKey, 4096)
    const authorizer = await read(descriptor.control.runAuthorizationPublicKey, 4096)
    verifyControlDocuments(descriptor, freeze, review, authorization, reviewer, authorizer, policy)
    beforeDeadlineV2(deadline)
    const closures: Record<string, ClosureEvidence> = {}
    for (const [name, pin] of [
      ['harness', descriptor.product.harnessClosure],
      ['toolchain', descriptor.toolchain.closure],
      ['productRuntime', descriptor.product.runtimeClosure],
      ['browserBundle', descriptor.product.browserBundle],
      ['p3b2', descriptor.p3b2.closure],
    ] as const) {
      beforeDeadlineV2(deadline)
      if (pin.manifest.root !== name) throw new Error('hosted_owner_v2_closure_root')
      let root = roots.get(name)
      if (!root) {
        root = await openRootAnchor(name, descriptor.roots[name])
        roots.set(name, root)
      }
      closureRoots.add(root)
      await assertNativeReadonlyRoot(root)
      closures[name] = await verifyClosure(root, pin, deadline)
      await assertNativeReadonlyRoot(root)
      beforeDeadlineV2(deadline)
    }
    // Verify the actual recipe bytes selected by the signed freeze, retaining
    // their file anchor. Source runtime/module selection follows exact recipe v2/v3.
    const recipe = await read(descriptor.p3b2.recipe, 16 * 1024 * 1024)
    const selectedRecipe = verifyP3B2Recipe(recipe, descriptor)
    beforeDeadlineV2(deadline)
    const assertCurrent = async () => {
      if (closed) throw new Error('hosted_owner_v2_controller_closed')
      for (const root of roots.values()) await assertRootCurrent(root)
      for (const file of files) await assertFileCurrent(file)
      for (const root of closureRoots) await assertNativeReadonlyRoot(root)
      if (closed) throw new Error('hosted_owner_v2_controller_closed')
    }
    await assertCurrent()
    beforeDeadlineV2(deadline)
    return Object.freeze({ descriptor, policy, selectedRecipe, closures: Object.freeze(closures), assertCurrent, close })
  } catch (error) { await close(); throw error }
}
