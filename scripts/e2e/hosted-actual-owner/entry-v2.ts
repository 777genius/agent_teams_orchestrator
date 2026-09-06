import { join } from 'node:path'
import { readHostedControlBootstrapV2, type HostedControlBootstrapAdmissionV2,
  type OwnerV2LaunchSelection } from '../../../src/services/hostedControl/HostedControlBootstrapV2.js'
import { HostedControlServer } from '../../../src/services/hostedControl/HostedControlServer.js'
import { HostedApprovalActivatablePort } from '../../../src/services/hostedControl/HostedApprovalActivatablePort.js'
import { HostedApprovalWireDispatcher, isHostedApprovalOperation } from '../../../src/services/hostedControl/HostedApprovalWire.js'
import { HostedApprovalDeferredManifestV2 } from '../../../src/services/hostedControl/HostedApprovalDeferredManifestV2.js'
import { hostedControlAuthorityFromConfig, hostedControlOwnerIdentityFromConfig,
  validateHostedControlRuntimePaths } from '../../../src/services/hostedControl/HostedControlRuntimeConfig.js'
import { resolveHostedControlOwnerBinding, validateHostedControlOwnerBinding } from '../../../src/services/hostedControl/ownerProof.js'
import type { HostedApprovalActivationRecovery } from '../../../src/services/hostedControl/HostedApprovalActivationSession.js'
import type { OwnerWalImageCustodian, OwnerWalPublicationProducer } from '../../../src/services/hostedControl/HostedApprovalOwnerProvenance.js'
import { parseOwnerV2Invocation, readOwnerRuntimeManifestV2 } from './runtime-manifest-v2.js'
import { createNativePublicationV2 } from './native-publication-v2.js'

/** Required source/built-entry composition inputs, retained by the selected
 * supervisor launch. Recovery owns W1 custody + FD8 sink + W2 image custodian;
 * this bootstrap slice must not replace those with ambient desktop services. */
export type ActualOwnerV2Composition = Readonly<{
  launch: OwnerV2LaunchSelection
  walImages: OwnerWalImageCustodian
  recover(bootstrap: HostedControlBootstrapAdmissionV2, native: OwnerWalPublicationProducer,
    ...activation: Parameters<HostedApprovalActivationRecovery>): ReturnType<HostedApprovalActivationRecovery>
}>

export async function runActualOwnerV2(args: readonly string[], composition?: ActualOwnerV2Composition): Promise<void> {
  // Even an uncomposed invocation must run the bounded inherited admission and
  // close its one-use descriptors. There is no legacy argv or FD fallback.
  const modulePath = process.argv[1]
  const bootstrap = await readHostedControlBootstrapV2({ modulePath,
    selectLaunch() {
      const path = parseOwnerV2Invocation(args)
      if (!composition) throw new Error('hosted_owner_v2_selected_launch_composition_missing')
      readOwnerRuntimeManifestV2(path, composition.launch)
      return composition.launch
    },
  })
  const approvals = new HostedApprovalActivatablePort()
  let server: HostedControlServer | undefined
  let native: OwnerWalPublicationProducer | undefined
  let stopped = false
  let closing: Promise<void> | undefined
  let monitor: ReturnType<typeof setInterval> | undefined
  const stop = (): Promise<void> => {
    if (closing) return closing
    stopped = true
    clearInterval(monitor)
    const revoking = approvals.revoke()
    closing = (async () => {
      try { await server?.stop() } finally {
        try { await revoking } finally {
          try { native?.close() } finally { await bootstrap.close() }
        }
      }
    })()
    return closing
  }
  const signal = () => { void stop().catch(() => { process.exitCode = 1 }) }
  process.once('SIGINT', signal); process.once('SIGTERM', signal)
  try {
    await validateHostedControlRuntimePaths(bootstrap.config)
    const scope = await resolveHostedControlOwnerBinding({ claudeRoot: bootstrap.config.claudeRoot, legacyKey: bootstrap.config.legacyKey })
    const authority = hostedControlAuthorityFromConfig(bootstrap.config)
    const assertRootCurrent = () => !stopped && validateHostedControlOwnerBinding({ claudeRoot: bootstrap.config.claudeRoot,
      legacyKey: bootstrap.config.legacyKey, expectedRootIdentity: scope.rootIdentity })
    if (!await bootstrap.guard.assertCurrent()) throw new Error('hosted_owner_v2_guard_lost')
    const dispatcher = new HostedApprovalWireDispatcher({ secret: bootstrap.secret, authority,
      getOwnerBinding: () => server?.ownerBinding ?? null, approvals })
    server = new HostedControlServer({ socketPath: bootstrap.config.socketPath, secret: bootstrap.secret, authority,
      ownerIdentity: hostedControlOwnerIdentityFromConfig(bootstrap.config), bootstrapBinding: bootstrap.bootstrapBinding,
      activationTransport: 'inherited-v2',
      // Task/lifecycle effects belong to the composed runtime. Approval wire
      // dispatch uses the existing port, fenced until signed activation recovers it.
      service: { async mutate() { throw new Error('hosted_owner_v2_effect_runtime_not_installed') } },
      dispatchCoexistingOperation: async (message, line) => {
        if (!isHostedApprovalOperation(message.operation)) return null
        if (!await bootstrap.guard.assertCurrent() || !await assertRootCurrent()) throw new Error('hosted_owner_v2_guard_lost')
        return dispatcher.dispatch(message, line)
      },
      activationSessionFactory: connection => HostedApprovalDeferredManifestV2.production({
        proofKey: bootstrap.secret, connection, port: approvals, expectedHost: bootstrap.expectedHost,
        rawAdmissionPath: join(scope.canonicalTeamRoot, 'hosted-approval-runtime-admission.v1.json'),
        authority: {
          snapshot: () => ({ authority, socketPath: bootstrap.config.socketPath, ownerBinding: connection.ownerBinding,
            ...bootstrap.approvalActivationV2 }),
          assertBootstrapCurrent: () => !stopped && bootstrap.guard.assertCurrent(), assertRootCurrent,
        },
        recover: async (admission, activation) => {
          if (!await bootstrap.guard.assertCurrent() || !await assertRootCurrent()) throw new Error('hosted_owner_v2_guard_lost')
          native = createNativePublicationV2(bootstrap, modulePath, composition!.walImages)
          return composition!.recover(bootstrap, native, admission, activation)
        },
      }),
    })
    await server.start()
    if (!await bootstrap.guard.assertCurrent() || stopped) throw new Error('hosted_owner_v2_guard_lost')
    server.attachInheritedActivationV2(bootstrap.activation)
    await Promise.race([bootstrap.guard.lost, new Promise<void>(resolve => {
      monitor = setInterval(() => {
        if (stopped || !bootstrap.activation.isCurrent()) { clearInterval(monitor); resolve() }
      }, 10)
    })])
  } finally {
    process.off('SIGINT', signal); process.off('SIGTERM', signal)
    await stop()
  }
}
