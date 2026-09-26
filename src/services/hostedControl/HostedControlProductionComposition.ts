import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { DurableTeamLifecycleExecution } from '../teamLifecycleOwner/DurableTeamLifecycleExecution.js'
import type { TeamLifecycleLaneEffectPort } from '../teamLifecycleOwner/OpenCodeTeamLifecycleLane.js'
import { createTeamLifecycleAuthorityComposition } from '../teamLifecycleOwner/TeamLifecycleAuthorityComposition.js'
import { PrivateFileTeamLifecycleLaunchPlanStore } from '../teamLifecycleOwner/TeamLifecycleLaunchPlan.js'
import { createHostedControlEffectServices } from './HostedControlEffectServices.js'
import type {
  HostedControlRuntimePortFactory,
  HostedControlRuntimePortFactoryContext,
} from './HostedControlRuntime.js'
import { HostedLifecycleAuthorityWal } from './HostedLifecycleAuthorityWal.js'
import type {
  HostedTeamLeadInboxPumpOptions,
  InboxPumpDecision,
} from './HostedTeamLeadInboxPump.js'
import { HostedTeamRecipientRoster } from './HostedTeamRecipientRoster.js'
import type { HostedApprovalActivationConnection } from './HostedApprovalActivationSession.js'
import type { HostedManagedOpenCodeLaneDependencies } from './isolatedLane/HostedManagedOpenCodeLane.js'

export const HOSTED_LIFECYCLE_PLAN_FILE = 'hosted-lifecycle-plan.v1.json'
export const HOSTED_LIFECYCLE_EXECUTION_STATE_FILE =
  'hosted-lifecycle-execution-state.v1.json'
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

/** Prompts OpenCode recipients' inbox rows; a wake drains one recipient's queue now. */
export type HostedTeamInboxPumpPort = Readonly<{
  wakeRecipient(recipient: string, messageId: string): Promise<InboxPumpDecision>
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
        loadAdmittedPlan: async () => (await planStore.load({
          workspaceId: context.authority.workspaceId,
          teamId: context.authority.teamId,
        }))?.plan ?? null,
        // One redacted JSON line per lane failure; the launcher captures owner stderr.
        reportLaneFailure: report => {
          process.stderr.write(`${JSON.stringify({
            kind: 'hosted-lifecycle-lane-failure', teamId: context.authority.teamId, ...report,
          })}\n`)
        },
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
      // One redacted JSON line per lifecycle query that answered unavailable.
      reportQueryUnavailable: report => {
        process.stderr.write(`${JSON.stringify({
          kind: 'hosted-lifecycle-query-unavailable', teamId: context.authority.teamId, ...report,
        })}\n`)
      },
    })

    const authorityGuard = { isCurrent: context.isCurrentAuthority }
    const messageRecipients = new HostedTeamRecipientRoster(context.teamRoot)
    void reportLegacyMessageState(context.teamRoot, context.authority.teamId)
    const inboxPump = effects.createInboxPump
      ? effects.createInboxPump({
        canonicalTeamRoot: context.teamRoot,
        legacyKey: context.legacyKey,
        authority: context.authority,
        guard: authorityGuard,
        planStore,
        execution,
        // One redacted JSON line per change of a message's pump decision.
        reportDecision: report => {
          process.stderr.write(`${JSON.stringify({
            kind: 'hosted-inbox-pump-decision', teamId: context.authority.teamId, ...report,
          })}\n`)
        },
      })
      : undefined
    const services = createHostedControlEffectServices({
      canonicalTeamRoot: context.teamRoot,
      lifecycleGuard: authorityGuard,
      messageGuard: authorityGuard,
      messageRecipients,
      // With a pump, `delivered` means the recipient's session accepted the prompt.
      ...(inboxPump ? { messagePump: inboxPump } : {}),
      lifecycleEffects: lifecycle.authority,
      planAdmission: {
        admitLaunchPlan: async input => {
          const decision = await lifecycle.owner.admitLaunchPlan(input)
          return { kind: decision.kind }
        },
      },
    })
    const activation = context.activationV2
    // Approval modules load only for a signed activation; no other profile composes them.
    const approvalModules = activation ? await loadHostedApprovalModules() : undefined
    const approvals = approvalModules ? new approvalModules.HostedApprovalActivatablePort() : undefined
    const rawAdmissionPath = join(context.teamRoot, HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE)
    const activationSessionFactory = activation && approvalModules && approvals
      ? (connection: HostedApprovalActivationConnection) =>
        approvalModules.HostedApprovalActivationSession.production({
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
            const owner = new approvalModules.HostedApprovalOwnerService({
              store: new approvalModules.HostedApprovalOwnerStore(new approvalModules.HostedApprovalOwnerWal(
                join(context.teamRoot, HOSTED_APPROVAL_OWNER_WAL_FILE),
              )),
              admission: approvalAdmission,
              runtime: new approvalModules.OpenCodeHostedApprovalRuntimeAdapter(),
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
        await inboxPump?.close()
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
  return createHostedControlProductionPortFactory(async context => {
    const { createHostedManagedOpenCodeLane } = await import('./isolatedLane/HostedManagedOpenCodeLane.js')
    return createHostedManagedOpenCodeLane(context, dependencies)
  })
}

async function loadHostedApprovalModules() {
  const [wal, store, service, adapter, port, session] = await Promise.all([
    import('./HostedApprovalOwnerWal.js'),
    import('./HostedApprovalOwnerStore.js'),
    import('./HostedApprovalOwnerService.js'),
    import('./OpenCodeHostedApprovalRuntimeAdapter.js'),
    import('./HostedApprovalActivatablePort.js'),
    import('./HostedApprovalActivationSession.js'),
  ])
  return {
    HostedApprovalOwnerWal: wal.HostedApprovalOwnerWal,
    HostedApprovalOwnerStore: store.HostedApprovalOwnerStore,
    HostedApprovalOwnerService: service.HostedApprovalOwnerService,
    OpenCodeHostedApprovalRuntimeAdapter: adapter.OpenCodeHostedApprovalRuntimeAdapter,
    HostedApprovalActivatablePort: port.HostedApprovalActivatablePort,
    HostedApprovalActivationSession: session.HostedApprovalActivationSession,
  }
}

/**
 * State the single message_send no longer reads: the two-phase message records and their
 * delivery markers. It is left in place; one redacted line with the file counts makes it
 * visible on a host that ran the older owner. Counts only, never paths or contents.
 */
async function reportLegacyMessageState(teamRoot: string, teamId: string): Promise<void> {
  const count = async (name: string): Promise<number> =>
    readdir(join(teamRoot, name)).then(entries => entries.length, () => 0)
  try {
    const [hostedMessages, deliveryOperations] = await Promise.all([
      count('hosted-messages'),
      count('hosted-message-delivery-operations'),
    ])
    if (hostedMessages === 0 && deliveryOperations === 0) return
    process.stderr.write(`${JSON.stringify({
      kind: 'hosted-message-legacy-state', teamId, hostedMessages, deliveryOperations,
    })}\n`)
  } catch { /* Diagnostics never affect startup. */ }
}
