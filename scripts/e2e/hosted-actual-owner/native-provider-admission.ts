import { createNativeBehaviorNamespaceCheck } from './native-behavior-custody.js'
import { matchesNativeLifecycleLease } from './native-provider-lease.js'
import { combineNativeProviderFences } from './native-provider-fence.js'
import { OpenCodePreflightLeaseRegistry } from '../../../src/services/opencode/OpenCodePreflightLease.js'
import { createHash } from 'node:crypto'
import { assertHostedControlBootstrapAdmissionV2, type HostedControlBootstrapAdmissionV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2.js'
import { assertHostedControlNativeRuntimeContext, type HostedControlRuntimePortFactoryContext } from '../../../src/services/hostedControl/HostedControlRuntime.js'
import { canonicalV2, requireV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Wire.js'
import { assertHostedApprovalProductionActivation, type VerifiedHostedApprovalActivation } from '../../../src/services/hostedControl/HostedApprovalRuntimeActivation.js'
import { assertHostedApprovalActivatedAdmission, isHostedApprovalActivatedAdmissionCurrent } from '../../../src/services/hostedControl/HostedApprovalActivatedAdmission.js'
import type { HostedApprovalRuntimeAdmission } from '../../../src/services/hostedControl/HostedApprovalRuntimeAdmission.js'
import { createOpenCodeSupervisedCustodyAcquirer, type OpenCodeSupervisorAdmissionSource, type OneUseFence, type TrustedOpenCodeCustody } from '../../../src/services/opencode/OpenCodeSupervisedHostCustody.js'
import { createOpenCodeRawRetention } from '../../../src/services/opencode/OpenCodeHostedRawRetention.js'
import { retainOpenCodeProfileCurrentness } from '../../../src/services/opencode/OpenCodeProfileCurrentness.js'
import { canonicalJson, sha256 } from './native-http-contract.js'
import { requireNativeAllocationConsumers } from './native-allocation-consumers.js'
import { RetainedProductObservationResults } from './native-operation-results.js'
import { assertNativeAdmittedLaunch, type NativeAdmittedLaunch } from './native-launch-admission.js'

const allocations = new WeakSet<object>()
export type NativeAdmittedAllocation = ReturnType<typeof retainNativeActivatedAllocation>
/** Called only with the real production-verifier result and its exact activated
 * file/epoch admission. Recovery itself remains provider-free. */
export function retainNativeActivatedAllocation(launch: NativeAdmittedLaunch,
  admission: HostedApprovalRuntimeAdmission, activation: VerifiedHostedApprovalActivation) {
  assertNativeAdmittedLaunch(launch)
  assertHostedApprovalProductionActivation(activation)
  assertHostedApprovalActivatedAdmission(admission, activation)
  const selected = launch.launch.expectedHost
  requireV2(activation.admissionDocumentDigest === selected.activation.admissionDocumentDigest &&
    activation.binding.ownerArtifactDigest === selected.activation.ownerArtifactDigest &&
    activation.binding.ownerBinding.ownerGeneration === selected.activation.ownerGeneration &&
    activation.binding.ownerBinding.ownerSessionId === selected.activation.ownerSessionId &&
    activation.binding.signedManifest.manifestDigest === `sha256:${launch.generation.manifestSha256}` &&
    activation.binding.signedManifest.releasePinDigest === launch.releasePinDigest &&
    activation.binding.signedManifest.launcherKeyId === launch.launcherKeyId, 'native_selection_activation')
  // Existing activation admission is per team. Select that authenticated team,
  // retaining the full generation for later A/B batch custody installation.
  const activatedSlots = launch.generation.slots.filter(slot => slot.teamId === activation.binding.teamId &&
    slot.teamId === admission.outerAuthority.teamId && slot.lifecycleEndpoint === activation.binding.socketPath)
  requireV2(activatedSlots.length === 1 && admission.routes.length === activatedSlots.length, 'native_allocation_routes')
  const routes = Object.freeze(activatedSlots.map(slot => {
    const matches = admission.routes.filter(route => route.routeId === slot.routeId &&
      route.scope.teamId === slot.teamId && sha256(canonicalJson(route)) === slot.routeDigest)
    requireV2(matches.length === 1, 'native_allocation_route')
    const route = matches.find(route => route.routeId === slot.routeId)!
    requireV2(route.authority.runtimeInstanceId === selected.hosted.runtimeInstanceId &&
      route.openCodeBinding.openCodeArtifactDigest === `sha256:${selected.executable.sha256}`, 'native_allocation_route_host')
    return Object.freeze({ slot, route })
  }))
  const value = Object.freeze({ launch, admission, routes,
    allocation: launch.allocation, allocationSha256: launch.allocationSha256, generation: launch.generation })
  allocations.add(value)
  return value
}

export async function acquireNativeProviderCustody(input: Readonly<{
  bootstrap: HostedControlBootstrapAdmissionV2
  runtimeContext: HostedControlRuntimePortFactoryContext
  admittedLaunch: NativeAdmittedLaunch
  admittedAllocation: NativeAdmittedAllocation
}>) {
  const { bootstrap, runtimeContext: context, admittedLaunch: launch, admittedAllocation: selection } = input
  assertHostedControlBootstrapAdmissionV2(bootstrap)
  assertHostedControlNativeRuntimeContext(context, bootstrap)
  assertNativeAdmittedLaunch(launch)
  requireV2(allocations.has(selection) && selection.launch === launch && bootstrap.preparedProfile &&
    context.nativeActivationV2 && canonicalV2(context.authority) === canonicalV2(selection.admission.outerAuthority) &&
    launch.launch.bootstrapV2HeaderSha256 === bootstrap.bootstrapV2HeaderSha256 &&
    canonicalV2(launch.launch.expectedHost) === canonicalV2(bootstrap.expectedHost) &&
    launch.releasePinDigest === bootstrap.approvalActivationV2.signedManifest.releasePinDigest &&
    launch.launcherKeyId === bootstrap.approvalActivationV2.signedManifest.launcherKeyId &&
    launch.proofKeyId === createHash('sha256').update(bootstrap.secret).digest('hex'), 'native_provider_admission')
  requireV2(selection.generation.generation === bootstrap.header.ownerGeneration &&
    selection.generation.ownerSessionId === bootstrap.header.ownerSessionId &&
    selection.routes.filter(({ slot }) => slot.teamId === bootstrap.header.teamId &&
      slot.teamRoot === context.teamRoot && slot.lifecycleEndpoint === bootstrap.header.socketPath).length === 1,
  'native_provider_generation_root')
  // Required installed resource retention AND permit consumers. No selected row,
  // first route, or statement JSON can manufacture either implementation.
  const consumers = requireNativeAllocationConsumers()
  requireV2(consumers.retainedResults instanceof RetainedProductObservationResults &&
    consumers.retainedResults.allocation === selection.allocation, 'native_allocation_retention')
  const profile = retainOpenCodeProfileCurrentness(bootstrap.preparedProfile,
    createNativeBehaviorNamespaceCheck(bootstrap.preparedProfile.projectPath))
  const preflights = new OpenCodePreflightLeaseRegistry()
  let activeCustody: TrustedOpenCodeCustody | undefined
  let revoked = false, lose!: () => void
  const lost = new Promise<void>(resolve => { lose = resolve })
  const revoke = () => { if (!revoked) {
    revoked = true; preflights.clear(); lose()
    // closeOwnerResources cancels/revokes synchronously; only the drain awaits.
    void activeCustody?.closeOwnerResources()
  } }
  const current = () => {
    try {
      if (!revoked && bootstrap.guard.assertCurrentSync() && bootstrap.activation.isCurrent() &&
        launch.isCurrent() && profile.isCurrent() && consumers.isCurrent(selection) &&
        isHostedApprovalActivatedAdmissionCurrent(selection.admission)) {
        const activation = context.nativeActivationV2!.prepareRetainedProviderToken()
        if (activation?.consume()) return true
      }
    } catch {}
    revoke(); return false
  }
  let raw: ReturnType<typeof createOpenCodeRawRetention> | undefined
  let monitor: ReturnType<typeof setInterval> | undefined
  const prepare = async (): Promise<OneUseFence | null> => {
    if (!current()) return null
    const tokens: OneUseFence[] = []
    let transferred = false
    try {
      const admitted = await selection.admission.prepareEffectToken()
      if (!admitted) return null
      tokens.push(admitted)
      if (!current() || !await context.isCurrentAuthority({ actorId: 'hosted-approval-owner', ...context.authority })) return null
      const activation = context.nativeActivationV2!.prepareRetainedProviderToken()
      if (activation) tokens.push(activation)
      if (!activation || !current()) return null
      const fence = combineNativeProviderFences(tokens, current, revoke)
      transferred = true
      return fence
    } catch { return null }
    finally {
      if (!transferred) {
        for (const token of tokens) { try { token.consume() } catch {} }
        revoke()
      }
    }
  }

  try {
    requireV2(current(), 'native_provider_currentness')
    raw = createOpenCodeRawRetention(await consumers.openRawRetention(bootstrap, selection))
    requireV2(current(), 'native_provider_currentness')
    monitor = setInterval(current, 250); monitor.unref?.()
    void bootstrap.guard.lost.then(revoke, revoke)
    const source: OpenCodeSupervisorAdmissionSource = {
      expected: bootstrap.expectedHost,
      async acquire() {
        const credentials = { ...bootstrap.serverAuth }
        return {
          expected: bootstrap.expectedHost, serverAuth: credentials, rawRetention: raw!, lost,
          async readPreparedProfile() {
            requireV2(current(), 'native_provider_profile')
            return profile.readPreparedProfile()
          },
          assertCurrentSync: current,
          prepareEffectToken: prepare,
          registerPreflightLease(lease) {
            requireV2(current(), 'native_preflight_registration')
            preflights.register(lease)
          },
          releasePreflightLease(lease) { preflights.release(lease) },
          async prepareLeaseToken(lease) {
            const scoped = () => preflights.has(lease) ||
              selection.routes.filter(({ route }) => matchesNativeLifecycleLease(lease, route)).length === 1
            if (!scoped()) return null
            const token = await prepare()
            if (!token) return null
            let permit: OneUseFence | null = null
            try { permit = await consumers.prepareLeaseToken(selection, lease) }
            finally { if (!permit) { try { token.consume() } finally { revoke() } } }
            return permit && combineNativeProviderFences([token, permit], () => current() && scoped(), revoke)
          },
          async prepareOperationToken(operation) {
            const token = await prepare()
            if (!token) return null
            let permit: OneUseFence | null = null
            try { permit = await consumers.prepareOperationToken(selection, operation) }
            finally { if (!permit) { try { token.consume() } finally { revoke() } } }
            return permit && combineNativeProviderFences([token, permit], current, revoke)
          },
          async closeOwnerResources() {
            revoke(); clearInterval(monitor); profile.close()
            credentials.username = ''; credentials.password = ''
          },
        }
      },
    }
    const custody = await createOpenCodeSupervisedCustodyAcquirer(source)()
    activeCustody = custody
    if (!current()) { await custody.closeOwnerResources(); throw new Error('native_provider_lost') }
    return custody
  } catch {
    revoke(); clearInterval(monitor)
    try { await raw?.close() } finally { profile.close() }
    throw new Error('hosted_owner_v2_native_provider_rejected')
  }
}
