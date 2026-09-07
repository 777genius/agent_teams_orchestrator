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
import { createNativeRawSinkV2 } from './native-raw-sink-v2.js'
import { assertNativeAdmittedLaunch, type NativeAdmittedLaunch } from './native-launch-admission.js'

const scenarios = new WeakSet<object>()
export type NativeAdmittedScenario = ReturnType<typeof retainNativeActivatedScenario>
/** Called only with the real production-verifier result and its exact activated
 * file/epoch admission. Recovery itself remains provider-free. */
export function retainNativeActivatedScenario(launch: NativeAdmittedLaunch,
  admission: HostedApprovalRuntimeAdmission, activation: VerifiedHostedApprovalActivation) {
  assertNativeAdmittedLaunch(launch)
  assertHostedApprovalProductionActivation(activation)
  assertHostedApprovalActivatedAdmission(admission, activation)
  const selected = launch.launch.expectedHost
  requireV2(activation.admissionDocumentDigest === selected.activation.admissionDocumentDigest &&
    activation.binding.ownerArtifactDigest === selected.activation.ownerArtifactDigest &&
    activation.binding.ownerBinding.ownerGeneration === selected.activation.ownerGeneration &&
    activation.binding.ownerBinding.ownerSessionId === selected.activation.ownerSessionId &&
    activation.binding.signedManifest.releasePinDigest === launch.releasePinDigest &&
    activation.binding.signedManifest.launcherKeyId === launch.launcherKeyId, 'native_scenario_activation')
  const routes = admission.routes.filter(route => route.routeId === launch.scenario.routeId)
  requireV2(routes.length === 1 && routes[0]!.authority.runtimeInstanceId === selected.hosted.runtimeInstanceId &&
    routes[0]!.openCodeBinding.openCodeArtifactDigest === `sha256:${selected.executable.sha256}`, 'native_scenario_route')
  const value = Object.freeze({ launch, admission, route: routes[0]!, row: launch.scenario.row })
  scenarios.add(value)
  return value
}

export async function acquireNativeProviderCustody(input: Readonly<{
  bootstrap: HostedControlBootstrapAdmissionV2
  runtimeContext: HostedControlRuntimePortFactoryContext
  admittedLaunch: NativeAdmittedLaunch
  admittedScenario: NativeAdmittedScenario
}>) {
  const { bootstrap, runtimeContext: context, admittedLaunch: launch, admittedScenario: scenario } = input
  assertHostedControlBootstrapAdmissionV2(bootstrap)
  assertHostedControlNativeRuntimeContext(context, bootstrap)
  assertNativeAdmittedLaunch(launch)
  requireV2(scenarios.has(scenario) && scenario.launch === launch && bootstrap.preparedProfile &&
    context.nativeActivationV2 && canonicalV2(context.authority) === canonicalV2(scenario.admission.outerAuthority) &&
    launch.launch.bootstrapV2HeaderSha256 === bootstrap.bootstrapV2HeaderSha256 &&
    canonicalV2(launch.launch.expectedHost) === canonicalV2(bootstrap.expectedHost) &&
    launch.releasePinDigest === bootstrap.approvalActivationV2.signedManifest.releasePinDigest &&
    launch.launcherKeyId === bootstrap.approvalActivationV2.signedManifest.launcherKeyId &&
    launch.proofKeyId === createHash('sha256').update(bootstrap.secret).digest('hex'), 'native_provider_admission')
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
        launch.isCurrent() && profile.isCurrent() && isHostedApprovalActivatedAdmissionCurrent(scenario.admission)) {
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
      const admitted = await scenario.admission.prepareEffectToken()
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
    raw = createOpenCodeRawRetention(await createNativeRawSinkV2(bootstrap,
      { row: scenario.row, routeId: scenario.route.routeId }, performance.now() + 5000))
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
            const route = scenario.route
            const scoped = () => preflights.has(lease) || matchesNativeLifecycleLease(lease, route)
            if (!scoped()) return null
            const token = await prepare()
            return token && Object.freeze({ consume() { const valid = token.consume(); return valid && scoped() } })
          },
          prepareOperationToken: prepare,
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
