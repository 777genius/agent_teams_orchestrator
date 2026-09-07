import { join } from 'node:path'

import { DurableTeamLifecycleExecution } from '../teamLifecycleOwner/DurableTeamLifecycleExecution.js'
import {
  createProductionOpenCodeTeamLifecycleLane,
  type TeamLifecycleLaneEffectPort,
} from '../teamLifecycleOwner/OpenCodeTeamLifecycleLane.js'
import { createTeamLifecycleAuthorityComposition } from '../teamLifecycleOwner/TeamLifecycleAuthorityComposition.js'
import {
  PrivateFileTeamLifecycleLaunchPlanStore,
  type TeamLifecycleLaunchPlanAdmission,
} from '../teamLifecycleOwner/TeamLifecycleLaunchPlan.js'
import { createHostedControlEffectServices } from './HostedControlEffectServices.js'
import type {
  HostedControlRuntimePortFactory,
  HostedControlRuntimePortFactoryContext,
} from './HostedControlRuntime.js'
import { HostedLifecycleAuthorityWal } from './HostedLifecycleAuthorityWal.js'
import { HostedTeamLeadMessageDelivery } from './HostedTeamLeadMessageDelivery.js'
import { HostedApprovalOwnerWal } from './HostedApprovalOwnerWal.js'
import { HostedApprovalOwnerStore } from './HostedApprovalOwnerStore.js'
import { HostedApprovalOwnerService } from './HostedApprovalOwnerService.js'
import type { OwnerWalPublicationProducer } from './HostedApprovalOwnerProvenance.js'
import { OpenCodeHostedApprovalRuntimeAdapter } from './OpenCodeHostedApprovalRuntimeAdapter.js'
import { HostedApprovalActivatablePort } from './HostedApprovalActivatablePort.js'
import {
  HostedApprovalActivationSession,
  type HostedApprovalActivationConnection,
} from './HostedApprovalActivationSession.js'

export const HOSTED_LIFECYCLE_PLAN_FILE = 'hosted-lifecycle-plan.v1.json'
export const HOSTED_LIFECYCLE_EXECUTION_STATE_FILE =
  'hosted-lifecycle-execution-state.v1.json'
export const HOSTED_MESSAGE_DIRECTORY = 'hosted-messages'
export const HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE = 'hosted-approval-runtime-admission.v1.json'
export const HOSTED_APPROVAL_OWNER_WAL_FILE = 'hosted-approval-owner.v1.json'
/** Remains false until the pinned hosted-approval v2 artifact passes the no-fake sandbox E2E. */
export const OPEN_CODE_HOSTED_APPROVAL_ATOMIC_REPLY_SUPPORTED: boolean = false

/**
 * Final local composition for the single hosted-control runtime. All state is
 * rooted below the canonical team directory admitted by HostedControlRuntime.
 * Only OpenCode owns production lifecycle effects; native lanes remain
 * capability-false because no native adapter is installed.
 */
export function createHostedControlProductionPortFactory(
  createOpenCodeLane: () => TeamLifecycleLaneEffectPort = createProductionOpenCodeTeamLifecycleLane,
  /**
   * Explicit W1/C seam for the single process-owned FD9 producer. The caller
   * owns its lifecycle; no environment lookup or ambient writer occurs here.
   */
  ownerWalPublication?: OwnerWalPublicationProducer,
  providerRecovery: 'before-publication' | 'after-native-activation' = 'before-publication',
): HostedControlRuntimePortFactory {
  return async (context: HostedControlRuntimePortFactoryContext) => {
    const execution = new DurableTeamLifecycleExecution(
      join(context.teamRoot, HOSTED_LIFECYCLE_EXECUTION_STATE_FILE),
      [createOpenCodeLane()],
    )
    const planStore = new PrivateFileTeamLifecycleLaunchPlanStore(
      join(context.teamRoot, HOSTED_LIFECYCLE_PLAN_FILE),
    )
    const lifecycleEffectGuard = () => context.isCurrentAuthority({
      actorId: 'hosted-lifecycle-owner', ...context.authority,
    })
    const admission = await loadStartupAdmission(planStore, {
      workspaceId: context.authority.workspaceId,
      teamId: context.authority.teamId,
    })
    const startupGuard = async () => (await lifecycleEffectGuard()) &&
      (admission === null || await admission.isCurrent())

    const lifecycle = createTeamLifecycleAuthorityComposition({
      workspaceId: context.authority.workspaceId,
      teamId: context.authority.teamId,
      deploymentId: context.authority.deploymentId,
      bootId: context.authority.bootId,
      restoreGeneration: context.authority.restoreGeneration,
      wal: new HostedLifecycleAuthorityWal(
        context.teamRoot,
        context.authority.teamId,
      ),
      planStore,
      execution,
      effectGuard: lifecycleEffectGuard,
    })

    const authorityGuard = { isCurrent: context.isCurrentAuthority }
    const messageDelivery = new HostedTeamLeadMessageDelivery({
      canonicalTeamRoot: context.teamRoot,
      legacyKey: context.legacyKey,
      authority: context.authority,
      guard: authorityGuard,
    })
    const services = createHostedControlEffectServices({
      messageDirectory: join(context.teamRoot, HOSTED_MESSAGE_DIRECTORY),
      teamId: context.authority.teamId,
      lifecycleGuard: authorityGuard,
      messageGuard: authorityGuard,
      messageDelivery,
      lifecycleEffects: lifecycle.authority,
    })
    const activation = context.activationV2
    const approvals = activation ? new HostedApprovalActivatablePort() : undefined
    const rawAdmissionPath = join(context.teamRoot, HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE)
    const activationSessionFactory = activation && approvals
      ? (connection: HostedApprovalActivationConnection) =>
        HostedApprovalActivationSession.production({
          proofKey: activation.proofKey,
          authority: {
            snapshot: () => ({
              ...activation.expectation,
              ownerBinding: connection.ownerBinding,
            }),
            assertBootstrapCurrent: activation.assertBootstrapCurrent,
            assertRootCurrent: activation.assertRootCurrent,
          },
          connection,
          rawAdmissionPath,
          port: approvals,
          recover: async approvalAdmission => {
            if (!OPEN_CODE_HOSTED_APPROVAL_ATOMIC_REPLY_SUPPORTED) {
              throw new Error('hosted_approval_runtime_production_gate_closed')
            }
            const owner = new HostedApprovalOwnerService({
              store: new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(
                join(context.teamRoot, HOSTED_APPROVAL_OWNER_WAL_FILE),
                undefined,
                ownerWalPublication,
              )),
              admission: approvalAdmission,
              runtime: new OpenCodeHostedApprovalRuntimeAdapter(),
              isCurrentOuterAuthority: () => context.isCurrentAuthority({
                actorId: 'hosted-approval-owner', ...context.authority,
              }),
            })
            // Recovery is deliberately complete before the session installs
            // the owner behind the stable activatable port.
            await owner.recoverStateOnly()
            return owner
          },
        })
      : undefined
    let providerRecoveryStarted = false
    let revoked = false
    let providerRecoveryPending: Promise<void> | undefined
    const activateProviders = (): Promise<void> => {
      if (revoked) return Promise.reject(new Error('hosted_provider_recovery_revoked'))
      if (providerRecoveryStarted) return providerRecoveryPending!
      providerRecoveryStarted = true
      providerRecoveryPending = execution.recoverAtStartup(admission?.plan ?? null,
        async () => !revoked && await startupGuard())
      return providerRecoveryPending
    }
    let revocation: Promise<void> | null = null
    const revoke = (): Promise<void> => {
      revoked = true
      if (!revocation) revocation = approvals?.revoke() ?? Promise.resolve()
      return revocation
    }
    try {
      // Legacy callers adopt here. Native callers expose only fenced ports and
      // let the serialized runtime invoke adoption after retained activation.
      if (providerRecovery === 'before-publication') await activateProviders()
    } catch (error) {
      await revoke().catch(() => undefined)
      await Promise.all([
        messageDelivery.close().catch(() => undefined),
        execution.shutdown().catch(() => undefined),
      ])
      throw error
    }
    return {
      ...services,
      ...(providerRecovery === 'after-native-activation' ? { activateProviders } : {}),
      ...(approvals ? { approvals } : {}),
      ...(activationSessionFactory ? { activationSessionFactory } : {}),
      revoke,
      close: async () => {
        // Calling revoke fences the delegate synchronously; all awaited work is
        // cleanup and therefore precedes lifecycle/authority resource release.
        await revoke().catch(() => undefined)
        await providerRecoveryPending?.catch(() => undefined)
        await Promise.all([messageDelivery.close(), execution.shutdown()])
      },
    }
  }
}

export const createHostedControlProductionPorts = createHostedControlProductionPortFactory()

async function loadStartupAdmission(
  store: PrivateFileTeamLifecycleLaunchPlanStore,
  scope: { workspaceId: string; teamId: string },
): Promise<TeamLifecycleLaunchPlanAdmission | null> {
  try {
    return await store.load(scope)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
