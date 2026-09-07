import { join } from 'node:path'
import { HostedControlRuntime } from '../../../src/services/hostedControl/HostedControlRuntime.js'
import { createHostedControlProductionPortFactory } from '../../../src/services/hostedControl/HostedControlProductionComposition.js'
import { OpenCodeTeamLifecycleLane } from '../../../src/services/teamLifecycleOwner/OpenCodeTeamLifecycleLane.js'
import { createOwnedOpenCodeLifecycleCommandExecutor } from '../../../src/services/opencode/OpenCodeBridgeCommandHandler.js'
import { createOpenCodeSupervisedProviderBundle } from '../../../src/services/opencode/OpenCodeSupervisedProviderBundle.js'
import type { TrustedOpenCodeCustody } from '../../../src/services/opencode/OpenCodeSupervisedHostCustody.js'
import { requireHostedApprovalActivationV2ProductionPins, type HostedApprovalActivationV2ProductionPinSource } from '../../../src/services/hostedControl/HostedApprovalActivationV2Pins.js'
import { readHostedControlBootstrapV2,
  type OwnerV2LaunchSelection } from '../../../src/services/hostedControl/HostedControlBootstrapV2.js'
import { HostedApprovalActivatablePort } from '../../../src/services/hostedControl/HostedApprovalActivatablePort.js'
import { HostedApprovalDeferredManifestV2 } from '../../../src/services/hostedControl/HostedApprovalDeferredManifestV2.js'
import { HostedApprovalOwnerWal } from '../../../src/services/hostedControl/HostedApprovalOwnerWal.js'
import { HostedApprovalOwnerStore } from '../../../src/services/hostedControl/HostedApprovalOwnerStore.js'
import { HostedApprovalOwnerService } from '../../../src/services/hostedControl/HostedApprovalOwnerService.js'
import type { OpenCodeHostedApprovalRuntimeAdapter } from '../../../src/services/hostedControl/OpenCodeHostedApprovalRuntimeAdapter.js'
import type { OwnerWalPublicationProducer } from '../../../src/services/hostedControl/HostedApprovalOwnerProvenance.js'
import { parseOwnerV2Invocation, readOwnerRuntimeManifestV2 } from './runtime-manifest-v2.js'
import { createNativePublicationV2 } from './native-publication-v2.js'
import { createNativeWalImagesV2 } from './native-wal-images-v2.js'
import { SELECTED_LAUNCH_PHASE, type SelectedLaunchPhase } from '../../../src/services/hostedControl/HostedControlSelectedLaunchPhase.js'

/** Required source/built-entry composition inputs, retained by the selected
 * supervisor launch. Entry constructs W2 image custody; W1 admission retains FD8;
 * this bootstrap slice must not replace those with ambient desktop services. */
export type ActualOwnerV2Composition = Readonly<{
  /** Independently admitted Product activation identity, not the lifecycle launcher signer. */
  activationPins: HostedApprovalActivationV2ProductionPinSource
  /** Verify existing signed artifacts against payload-provisioned public roots.
   * The untrusted phase must never choose those roots. Return its admitted pins. */
  admitLaunch(phase: SelectedLaunchPhase): OwnerV2LaunchSelection | Promise<OwnerV2LaunchSelection>
  /** Branded admission only; entry constructs every provider consumer itself. */
  acquireProviderCustody(): Promise<TrustedOpenCodeCustody>
}>

export async function runActualOwnerV2(args: readonly string[], composition?: ActualOwnerV2Composition): Promise<void> {
  // Even an uncomposed invocation must run the bounded inherited admission and
  // close its one-use descriptors. There is no legacy argv or FD fallback.
  let activationPins: HostedApprovalActivationV2ProductionPinSource | undefined
  const modulePath = process.argv[1]
  const bootstrap = await readHostedControlBootstrapV2({ modulePath, selectionPhase: SELECTED_LAUNCH_PHASE,
    async selectLaunch(phase) {
      const path = parseOwnerV2Invocation(args)
      if (!composition || !phase) throw new Error('hosted_owner_v2_selected_launch_composition_missing')
      activationPins = requireHostedApprovalActivationV2ProductionPins(composition.activationPins)
      const launch = await composition.admitLaunch(phase)
      readOwnerRuntimeManifestV2(path, launch)
      return launch
    },
  })
  let native: OwnerWalPublicationProducer | undefined
  let walImages: Awaited<ReturnType<typeof createNativeWalImagesV2>> | undefined
  const runtime = new HostedControlRuntime(bootstrap, async context => {
    if (!composition || !context.nativeActivationV2) throw new Error('hosted_owner_v2_composition_missing')
    // FD9 and image custody exist before any approval recovery can publish WAL.
    walImages = await createNativeWalImagesV2(bootstrap, context.teamRoot)
    native = createNativePublicationV2(bootstrap, modulePath, walImages)
    let provider: Promise<ReturnType<typeof createOpenCodeSupervisedProviderBundle>> | undefined
    let execute: ReturnType<typeof createOwnedOpenCodeLifecycleCommandExecutor> | undefined
    let providerRevoked = false
    let activeCustody: TrustedOpenCodeCustody | undefined
    let providerDrain: Promise<void> | undefined
    const revokeProvider = () => {
      providerRevoked = true
      // closeOwnerResources revokes dispatch and cancels exchanges in this
      // synchronous stack, then returns their evidence-drain completion.
      if (activeCustody) providerDrain ??= activeCustody.closeOwnerResources()
    }
    const acquireCustody = composition.acquireProviderCustody.bind(composition)
    const getProvider = () => {
      if (providerRevoked) return Promise.reject(new Error('hosted_owner_v2_provider_revoked'))
      return provider ??= acquireCustody().then(async custody => {
      activeCustody = custody
      if (providerRevoked) {
        revokeProvider()
        await providerDrain
        throw new Error('hosted_owner_v2_provider_revoked')
      }
      try {
        const bundle = createOpenCodeSupervisedProviderBundle(custody,
          join(context.teamRoot, 'opencode-session-store.json'))
        execute = createOwnedOpenCodeLifecycleCommandExecutor(bundle.lifecycle)
        return bundle
      } catch (error) { await custody.closeOwnerResources().catch(() => undefined); throw error }
      })
    }
    const lane = new OpenCodeTeamLifecycleLane(async (input, options) => {
      await getProvider()
      return execute!(input, options)
    }, 300_000, () => execute !== undefined)
    const production = await createHostedControlProductionPortFactory(
      () => lane, native, 'after-native-activation',
    )(context)
    const approvals = new HostedApprovalActivatablePort()
    const store = new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(
      join(context.teamRoot, 'hosted-approval-owner.v1.json'), undefined, native,
    ))
    // State-only recovery must never acquire provider custody. The actual
    // provider methods share one memoized, explicitly composed runtime.
    const approvalRuntime: Pick<OpenCodeHostedApprovalRuntimeAdapter, 'observe' | 'deliver'> = {
      observe: async route => (await getProvider()).approvals.observe(route),
      deliver: async input => (await getProvider()).approvals.deliver(input),
    }
    const activation = context.nativeActivationV2
    return {
      ...production,
      async activateProviders() {
        await getProvider()
        await production.activateProviders!()
      },
      approvals,
      activationSessionFactory: connection => HostedApprovalDeferredManifestV2.production({
        proofKey: bootstrap.secret, connection, port: approvals, expectedHost: bootstrap.expectedHost,
        rawAdmissionPath: join(context.teamRoot, 'hosted-approval-runtime-admission.v1.json'),
        authority: {
          snapshot: () => ({ ...activation.expectation, ownerBinding: connection.ownerBinding }),
          assertBootstrapCurrent: activation.assertBootstrapCurrent,
          assertRootCurrent: activation.assertRootCurrent,
        },
        recover: async admission => {
          if (!await activation.assertBootstrapCurrent() || !await activation.assertRootCurrent()) {
            throw new Error('hosted_owner_v2_guard_lost')
          }
          const owner = new HostedApprovalOwnerService({ store, admission, runtime: approvalRuntime,
            isCurrentOuterAuthority: () => context.isCurrentAuthority({
              actorId: 'hosted-approval-owner', ...context.authority,
            }),
          })
          await owner.recoverStateOnly()
          return owner
        },
      }, requireHostedApprovalActivationV2ProductionPins(activationPins!)),
      revoke() {
        revokeProvider()
        // Both revoke calls run before any await; settlement is cleanup only.
        const approvalRevocation = approvals.revoke()
        const productionRevocation = production.revoke?.() ?? Promise.resolve()
        return Promise.all([approvalRevocation, productionRevocation]).then(() => undefined)
      },
      async close() {
        revokeProvider()
        try { await approvals.revoke() } finally {
          try { await production.close() } finally {
            if (provider) await provider.then(bundle => bundle.close(), () => undefined)
            await providerDrain
          }
        }
      },
    }
  })
  let monitor: ReturnType<typeof setInterval> | undefined
  const signal = () => { void runtime.stop().catch(() => { process.exitCode = 1 }) }
  process.once('SIGINT', signal); process.once('SIGTERM', signal)
  try {
    await runtime.start()
    await Promise.race([bootstrap.guard.lost, new Promise<void>(resolve => {
      monitor = setInterval(() => {
        if (!bootstrap.activation.isCurrent()) resolve()
      }, 10)
    })])
  } finally {
    clearInterval(monitor)
    process.off('SIGINT', signal); process.off('SIGTERM', signal)
    try { await runtime.stop() } finally {
      try { native?.close() } finally {
        try { walImages?.close() } finally { await bootstrap.close() }
      }
    }
  }
}
