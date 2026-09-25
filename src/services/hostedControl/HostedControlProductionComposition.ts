import { join } from 'node:path'

import { DurableTeamLifecycleExecution } from '../teamLifecycleOwner/DurableTeamLifecycleExecution.js'
import type { TeamLifecycleLaneEffectPort } from '../teamLifecycleOwner/OpenCodeTeamLifecycleLane.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { createTeamLifecycleAuthorityComposition } from '../teamLifecycleOwner/TeamLifecycleAuthorityComposition.js'
import { PrivateFileTeamLifecycleLaunchPlanStore } from '../teamLifecycleOwner/TeamLifecycleLaunchPlan.js'
import { createHostedControlEffectServices } from './HostedControlEffectServices.js'
import type {
  HostedControlRuntimePortFactory,
  HostedControlRuntimePortFactoryContext,
} from './HostedControlRuntime.js'
import { HostedLifecycleAuthorityWal } from './HostedLifecycleAuthorityWal.js'
import { HostedTeamLeadMessageDelivery } from './HostedTeamLeadMessageDelivery.js'
import type {
  HostedTeamLeadInboxPumpOptions,
  InboxPumpDecision,
} from './HostedTeamLeadInboxPump.js'
import type { HostedPersistedMessage } from './HostedTeamMessageService.js'
import type { HostedControlAuthority } from './protocol.js'
import { HostedApprovalOwnerWal } from './HostedApprovalOwnerWal.js'
import { HostedApprovalOwnerStore } from './HostedApprovalOwnerStore.js'
import { HostedApprovalOwnerService } from './HostedApprovalOwnerService.js'
import { OpenCodeHostedApprovalRuntimeAdapter } from './OpenCodeHostedApprovalRuntimeAdapter.js'
import { HostedApprovalActivatablePort } from './HostedApprovalActivatablePort.js'
import {
  HostedApprovalActivationSession,
  type HostedApprovalActivationConnection,
} from './HostedApprovalActivationSession.js'
import { createHostedManagedOpenCodeLane,
  type HostedManagedOpenCodeLaneDependencies } from './isolatedLane/HostedManagedOpenCodeLane.js'

export const HOSTED_LIFECYCLE_PLAN_FILE = 'hosted-lifecycle-plan.v1.json'
export const HOSTED_LIFECYCLE_EXECUTION_STATE_FILE =
  'hosted-lifecycle-execution-state.v1.json'
export const HOSTED_MESSAGE_DIRECTORY = 'hosted-messages'
export const HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE = 'hosted-approval-runtime-admission.v1.json'
export const HOSTED_APPROVAL_OWNER_WAL_FILE = 'hosted-approval-owner.v1.json'
/** Remains false until the pinned hosted-approval v2 artifact passes the no-fake sandbox E2E. */
export const OPEN_CODE_HOSTED_APPROVAL_ATOMIC_REPLY_SUPPORTED: boolean = false

/**
 * The isolated OpenCode runtime is supplied only by a trusted root composition.
 * Its port must own the live supervisor, FD3, session, gateway and effect fences;
 * supports() remains false until those dependencies are actually ready.
 */
export type HostedOpenCodeLaneFactory = (
  context: Readonly<HostedControlRuntimePortFactoryContext>,
) => TeamLifecycleLaneEffectPort | Promise<TeamLifecycleLaneEffectPort>

/** Recipient-addressed so delivery can grow beyond the team lead without a contract change. */
export type HostedTeamInboxPumpPort = Readonly<{
  wake(input: Readonly<{
    recipient: string
    message: HostedPersistedMessage
    authority: HostedControlAuthority
  }>): Promise<InboxPumpDecision>
  recover(): Promise<unknown>
  start(): void
  close(): Promise<void>
}>

/** Lifecycle effect owners of one hosted runtime. The default production composition has none. */
export type HostedLifecycleEffects = Readonly<{
  lanes: readonly TeamLifecycleLaneEffectPort[]
  /** Installed only next to a host-local OpenCode lane, whose sessions it prompts. */
  createInboxPump?(options: HostedTeamLeadInboxPumpOptions): HostedTeamInboxPumpPort
}>

export type HostedLifecycleEffectsFactory = (
  context: Readonly<HostedControlRuntimePortFactoryContext>,
) => HostedLifecycleEffects | Promise<HostedLifecycleEffects>

/**
 * Final local composition for the single hosted-control runtime. All state is
 * rooted below the canonical team directory admitted by HostedControlRuntime.
 * Without an effects factory no lane is installed and launch stays unavailable.
 */
export function createHostedControlPortFactory(
  createEffects?: HostedLifecycleEffectsFactory,
): HostedControlRuntimePortFactory {
  return async (context: HostedControlRuntimePortFactoryContext) => {
    const planStore = new PrivateFileTeamLifecycleLaunchPlanStore(
      join(context.teamRoot, HOSTED_LIFECYCLE_PLAN_FILE),
    )
    const effects: HostedLifecycleEffects = createEffects ? await createEffects(context) : { lanes: [] }
    const execution = new DurableTeamLifecycleExecution(
      join(context.teamRoot, HOSTED_LIFECYCLE_EXECUTION_STATE_FILE),
      [...effects.lanes],
      'team-lifecycle-owner',
      {
        requireRunReservation: true,
        runReservation: async (binding, signal, input) => {
          const receipt = input.runReservation
          if (signal.aborted || !receipt || !input.reservationPlanGeneration ||
            receipt.expectedPlanGeneration !== input.reservationPlanGeneration ||
            receipt.planSha256 !== input.reservationPlanGeneration.slice('plan-generation_'.length) ||
            receipt.runtimeWorkspaceId !== context.authority.workspaceId ||
            receipt.teamId !== context.authority.teamId ||
            receipt.deploymentId !== context.authority.deploymentId ||
            receipt.bootId !== context.authority.bootId ||
            receipt.restoreGeneration !== context.authority.restoreGeneration ||
            receipt.mountGeneration !== context.authority.mountBinding.mountGeneration ||
            receipt.commandId !== binding.commandId || receipt.idempotencyKey !== binding.idempotencyKey ||
            input.reservationDeadlineAtMs === undefined || Date.now() >= input.reservationDeadlineAtMs) {
            return null
          }
          return { ...binding, runId: receipt.runId }
        },
      },
    )
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
      requireRunReservation: true,
      effectGuard: () => context.isCurrentAuthority({ actorId: 'hosted-lifecycle-owner', ...context.authority }),
    })

    const authorityGuard = { isCurrent: context.isCurrentAuthority }
    const messageDelivery = new HostedTeamLeadMessageDelivery({
      canonicalTeamRoot: context.teamRoot,
      legacyKey: context.legacyKey,
      authority: context.authority,
      guard: authorityGuard,
    })
    const inboxPump = effects.createInboxPump
      ? effects.createInboxPump({
        canonicalTeamRoot: context.teamRoot,
        legacyKey: context.legacyKey,
        authority: context.authority,
        guard: authorityGuard,
        planStore,
        execution,
      })
      : undefined
    const services = createHostedControlEffectServices({
      messageDirectory: join(context.teamRoot, HOSTED_MESSAGE_DIRECTORY),
      teamId: context.authority.teamId,
      lifecycleGuard: authorityGuard,
      messageGuard: authorityGuard,
      messageDelivery: inboxPump
        ? {
          deliver: async (message, authority) => {
            const decision = await messageDelivery.deliver(message, authority)
            if (decision.kind === 'delivered') {
              // HostedTeamLeadMessageDelivery only ever delivers to the lead.
              void inboxPump.wake({ recipient: TEAM_LEAD_NAME, message, authority })
                .catch(() => undefined)
            }
            return decision
          },
        }
        : messageDelivery,
      lifecycleEffects: lifecycle.authority,
      planAdmission: {
        admitLaunchPlan: async input => {
          const decision = await lifecycle.owner.admitLaunchPlan(input)
          return { kind: decision.kind }
        },
      },
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
    let revocation: Promise<void> | null = null
    const revoke = (): Promise<void> => {
      if (!revocation) revocation = approvals?.revoke() ?? Promise.resolve()
      return revocation
    }
    return {
      ...services,
      ...(approvals ? { approvals } : {}),
      ...(activationSessionFactory ? { activationSessionFactory } : {}),
      revoke,
      ...(inboxPump
        ? {
          onReadinessLease: () => {
            void inboxPump.recover().catch(() => undefined)
            inboxPump.start()
          },
        }
        : {}),
      close: async () => {
        // Calling revoke fences the delegate synchronously; all awaited work is
        // cleanup and therefore precedes lifecycle/authority resource release.
        await revoke().catch(() => undefined)
        await Promise.all([messageDelivery.close(), inboxPump?.close()])
        await execution.shutdown()
      },
    }
  }
}

/** Explicit single OpenCode lane composition; without one no lifecycle effect exists. */
export function createHostedControlProductionPortFactory(
  createOpenCodeLane?: HostedOpenCodeLaneFactory,
): HostedControlRuntimePortFactory {
  return createHostedControlPortFactory(createOpenCodeLane ? async context => {
    const lane = await createOpenCodeLane(context)
    if (lane.kind !== 'opencode') {
      throw new TypeError('Hosted OpenCode lane factory must provide an OpenCode lane')
    }
    return { lanes: [lane] }
  } : undefined)
}

/** Default for every admission kind except personal-host: no lane, launch unavailable. */
export const createHostedControlProductionPorts = createHostedControlProductionPortFactory()

/** Explicit root/Product composition for the post-v1 isolated profile. */
export function createHostedManagedOpenCodeProductionPortFactory(
  dependencies: HostedManagedOpenCodeLaneDependencies,
): HostedControlRuntimePortFactory {
  return createHostedControlProductionPortFactory(context =>
    createHostedManagedOpenCodeLane(context, dependencies))
}
