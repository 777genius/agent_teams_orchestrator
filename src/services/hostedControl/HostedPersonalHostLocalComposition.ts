import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import {
  buildHostedAppMcpLaunchConfig,
  verifyHostedAppMcpDescriptor,
  type HostedAppMcpDescriptor,
  type ResolvedAppMcpLaunchConfig,
} from '../opencode/OpenCodeMcpManager.js'
import {
  createProductionOpenCodeTeamLifecycleLane,
  type TeamLifecycleLaneEffectPort,
  type TeamLifecycleLaneInput,
} from '../teamLifecycleOwner/OpenCodeTeamLifecycleLane.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import {
  createHostedControlPortFactory,
  type HostedTeamInboxPumpPort,
} from './HostedControlProductionComposition.js'
import type {
  HostedControlRuntimePortFactory,
  HostedControlRuntimePortFactoryContext,
} from './HostedControlRuntime.js'
import {
  HostedTeamLeadInboxPump,
  type HostedTeamLeadInboxPumpOptions,
} from './HostedTeamLeadInboxPump.js'

/** Lane kinds allowed to run as host processes of the owner's OS user. */
export const HOSTED_HOST_LOCAL_LANE_KINDS: readonly TeamLifecycleLaneEffectPort['kind'][] =
  Object.freeze(['opencode', 'native'])

export type HostedHostLocalLaneHost = Readonly<{
  /** Verified agent-teams MCP launch config; null when absent or its digests do not match. */
  appMcp: ResolvedAppMcpLaunchConfig | null
}>

/** Returns undefined when the lane has no trusted configuration in this deployment. */
export type HostedHostLocalLaneFactory = (
  context: Readonly<HostedControlRuntimePortFactoryContext>,
  host: HostedHostLocalLaneHost,
) => TeamLifecycleLaneEffectPort | undefined | Promise<TeamLifecycleLaneEffectPort | undefined>

/** OpenCode stays capability-false until the pinned MCP artifact is verified. */
export const createHostLocalOpenCodeLane: HostedHostLocalLaneFactory = (_context, host) => {
  const ready = host.appMcp !== null
  return createProductionOpenCodeTeamLifecycleLane(() => ready)
}

export type HostedPersonalHostLocalConfig = Readonly<{
  /** From the authenticated personal-host bootstrap; never from env or files. */
  appMcp: HostedAppMcpDescriptor | null
  lanes?: readonly HostedHostLocalLaneFactory[]
  createInboxPump?(options: HostedTeamLeadInboxPumpOptions): HostedTeamInboxPumpPort
}>

/**
 * ADR-30 `trusted_process` composition for the personal self-hosted profile:
 * the single decision point that admits host-local lanes. Only the
 * `core-lifecycle-personal-host-v1` bootstrap may select it.
 */
export function createHostedPersonalHostLocalPortFactory(
  config: HostedPersonalHostLocalConfig,
): HostedControlRuntimePortFactory {
  const laneFactories = config.lanes ?? [createHostLocalOpenCodeLane]
  const createInboxPump = config.createInboxPump ?? createHostedTeamLeadInboxPumpPort
  return createHostedControlPortFactory(async context => {
    const appMcp = config.appMcp && await verifyHostedAppMcpDescriptor(config.appMcp)
      ? buildHostedAppMcpLaunchConfig(config.appMcp, context.claudeRoot)
      : null
    const host: HostedHostLocalLaneHost = Object.freeze({ appMcp })
    const lanes: TeamLifecycleLaneEffectPort[] = []
    for (const createLane of laneFactories) {
      const lane = await createLane(context, host)
      if (!lane) continue
      if (!HOSTED_HOST_LOCAL_LANE_KINDS.includes(lane.kind) ||
        lanes.some(existing => existing.kind === lane.kind)) {
        throw new TypeError('Hosted host-local lanes must have distinct supported kinds')
      }
      lanes.push(withAdmittedWorkspaceRoot(lane, context.authority.mountBinding.declaredRootHash))
    }
    return {
      lanes,
      ...(lanes.some(lane => lane.kind === 'opencode') ? { createInboxPump } : {}),
    }
  })
}

function createHostedTeamLeadInboxPumpPort(
  options: HostedTeamLeadInboxPumpOptions,
): HostedTeamInboxPumpPort {
  const pump = new HostedTeamLeadInboxPump(options)
  return Object.freeze({
    // The current pump prompts only the lead session; other recipients stay pending.
    wake: async ({ recipient, message, authority }) => recipient === TEAM_LEAD_NAME
      ? pump.wake(message, authority)
      : { kind: 'unavailable' as const },
    recover: () => pump.recover(),
    start: () => pump.start(),
    close: () => pump.close(),
  })
}

/**
 * Host-local agents act directly on the host filesystem, so the plan's
 * workspace must be the exact canonical mount the launcher declared. The check
 * is synchronous: DurableTeamLifecycleExecution forbids any asynchronous
 * boundary between its authority guard and the adapter call.
 */
function withAdmittedWorkspaceRoot(
  lane: TeamLifecycleLaneEffectPort,
  declaredRootHash: string,
): TeamLifecycleLaneEffectPort {
  const admit = (workspaceRoot: string): void => {
    let canonical: string | null = null
    try { canonical = realpathSync(workspaceRoot) } catch { /* rejected below */ }
    if (!isAbsolute(workspaceRoot) || canonical !== workspaceRoot ||
      createHash('sha256').update(workspaceRoot).digest('hex') !== declaredRootHash) {
      throw new Error('Hosted lifecycle workspace is not the admitted mount root')
    }
  }
  type Running = TeamLifecycleLaneInput & { runId: string }
  return Object.freeze({
    kind: lane.kind,
    supports: (action: Parameters<TeamLifecycleLaneEffectPort['supports']>[0]) => lane.supports(action),
    inspect: async (input: TeamLifecycleLaneInput & { runId: string | null }) => {
      admit(input.workspaceRoot)
      return lane.inspect(input)
    },
    launch: async (input: Running) => {
      admit(input.workspaceRoot)
      return lane.launch(input)
    },
    cancel: (input: Running) => lane.cancel(input),
    stop: (input: Running) => lane.stop(input),
    recover: (input: Running) => lane.recover(input),
  })
}
