import {
  HostedLifecycleAuthorityService,
  type HostedLifecycleAuthorityServiceOptions,
} from '../hostedControl/HostedLifecycleAuthorityService.js'
import { HostedLifecycleProviderRegistry } from '../hostedControl/HostedLifecycleProviderRegistry.js'
import type { TeamLifecycleLaunchPlanStore } from './TeamLifecycleLaunchPlan.js'
import {
  TeamLifecycleOwnerService,
  type TeamLifecycleExecutionPort,
} from './TeamLifecycleOwnerService.js'

export type TeamLifecycleAuthorityCompositionOptions =
  Omit<HostedLifecycleAuthorityServiceOptions, 'providers'> & {
    planStore: TeamLifecycleLaunchPlanStore
    execution: TeamLifecycleExecutionPort
    providerId?: string
    effectGuard?: () => boolean | Promise<boolean>
  }

export type TeamLifecycleAuthorityComposition = {
  authority: HostedLifecycleAuthorityService
  owner: TeamLifecycleOwnerService
  providers: HostedLifecycleProviderRegistry
}

/**
 * Installs exactly one admitted team-lifecycle owner behind the hosted durable authority.
 * The caller must supply a narrow execution port owned by the runtime process; this factory
 * deliberately cannot construct one from UI state, ToolUseContext, or browser input.
 */
export function createTeamLifecycleAuthorityComposition(
  options: TeamLifecycleAuthorityCompositionOptions,
): TeamLifecycleAuthorityComposition {
  const owner = new TeamLifecycleOwnerService({
    planStore: options.planStore,
    execution: options.execution,
    providerId: options.providerId,
    effectGuard: options.effectGuard,
  })
  const providers = new HostedLifecycleProviderRegistry([owner])
  const authority = new HostedLifecycleAuthorityService({
    workspaceId: options.workspaceId,
    teamId: options.teamId,
    deploymentId: options.deploymentId,
    bootId: options.bootId,
    restoreGeneration: options.restoreGeneration,
    requiredScope: options.requiredScope,
    wal: options.wal,
    createId: options.createId,
    requireRunReservation: options.requireRunReservation,
    providers,
  })
  return { authority, owner, providers }
}
