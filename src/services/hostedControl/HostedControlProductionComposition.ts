import { join } from 'node:path'

import { DurableTeamLifecycleExecution } from '../teamLifecycleOwner/DurableTeamLifecycleExecution.js'
import {
  createProductionOpenCodeTeamLifecycleLane,
  type TeamLifecycleLaneEffectPort,
} from '../teamLifecycleOwner/OpenCodeTeamLifecycleLane.js'
import { createTeamLifecycleAuthorityComposition } from '../teamLifecycleOwner/TeamLifecycleAuthorityComposition.js'
import { PrivateFileTeamLifecycleLaunchPlanStore } from '../teamLifecycleOwner/TeamLifecycleLaunchPlan.js'
import { createHostedControlEffectServices } from './HostedControlEffectServices.js'
import type {
  HostedControlRuntimePortFactory,
  HostedControlRuntimePortFactoryContext,
} from './HostedControlRuntime.js'
import { HostedLifecycleAuthorityWal } from './HostedLifecycleAuthorityWal.js'
import { HostedTeamLeadMessageDelivery } from './HostedTeamLeadMessageDelivery.js'

export const HOSTED_LIFECYCLE_PLAN_FILE = 'hosted-lifecycle-plan.v1.json'
export const HOSTED_LIFECYCLE_EXECUTION_STATE_FILE =
  'hosted-lifecycle-execution-state.v1.json'
export const HOSTED_MESSAGE_DIRECTORY = 'hosted-messages'

/**
 * Final local composition for the single hosted-control runtime. All state is
 * rooted below the canonical team directory admitted by HostedControlRuntime.
 * Only OpenCode owns production lifecycle effects; native lanes remain
 * capability-false because no native adapter is installed.
 */
export function createHostedControlProductionPortFactory(
  createOpenCodeLane: () => TeamLifecycleLaneEffectPort = createProductionOpenCodeTeamLifecycleLane,
): HostedControlRuntimePortFactory {
  return (context: HostedControlRuntimePortFactoryContext) => {
    const execution = new DurableTeamLifecycleExecution(
      join(context.teamRoot, HOSTED_LIFECYCLE_EXECUTION_STATE_FILE),
      [createOpenCodeLane()],
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
      planStore: new PrivateFileTeamLifecycleLaunchPlanStore(
        join(context.teamRoot, HOSTED_LIFECYCLE_PLAN_FILE),
      ),
      execution,
      effectGuard: () => context.isCurrentAuthority({ actorId: 'hosted-lifecycle-owner', ...context.authority }),
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
    return {
      ...services,
      close: async () => {
        await Promise.all([messageDelivery.close(), execution.close()])
      },
    }
  }
}

export const createHostedControlProductionPorts = createHostedControlProductionPortFactory()
