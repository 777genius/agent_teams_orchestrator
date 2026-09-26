import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { readOpenCodeLegacyStopCapability } from '../opencode/OpenCodeLegacyStopAuthority.js'
import {
  buildHostedAppMcpLaunchConfig,
  verifyHostedAppMcpDescriptor,
  type HostedAppMcpDescriptor,
  type ResolvedAppMcpLaunchConfig,
} from '../opencode/OpenCodeMcpManager.js'
import {
  createProductionOpenCodeTeamLifecycleLane,
  OpenCodeTeamLifecycleLane,
  type TeamLifecycleLaneEffectPort,
  type TeamLifecycleLaneInput,
} from '../teamLifecycleOwner/OpenCodeTeamLifecycleLane.js'
import type { TeamLifecycleLaunchPlan } from '../teamLifecycleOwner/TeamLifecycleLaunchPlan.js'
import { getTeamsDir } from '../../utils/envUtils.js'
import {
  createHostedControlPortFactory,
  type HostedTeamInboxPumpPort,
} from './HostedControlProductionComposition.js'
import type {
  HostedControlRuntimePortFactory,
  HostedControlRuntimePortFactoryContext,
} from './HostedControlRuntime.js'
import {
  createHostLocalNativeLaneFactory,
  type HostedNativeHostLocalConfig,
} from './HostedNativeHostLocalLane.js'
import { HostedOpenCodeLaunchCapabilityStore } from './HostedOpenCodeLaunchCapabilityStore.js'
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
export const createHostLocalOpenCodeLane: HostedHostLocalLaneFactory = (context, host) => {
  const ready = host.appMcp !== null
  return createProductionOpenCodeTeamLifecycleLane(() => ready,
    new HostedOpenCodeLaunchCapabilityStore(context.teamRoot))
}

export type HostedPersonalHostLocalConfig = Readonly<{
  /** From the authenticated personal-host bootstrap; never from env or files. */
  appMcp: HostedAppMcpDescriptor | null
  /** From the same bootstrap; absent means no native lane may be installed. */
  native?: HostedNativeHostLocalConfig | null
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
  const laneFactories = config.lanes ?? [
    createHostLocalOpenCodeLane,
    ...(config.native ? [createHostLocalNativeLaneFactory(config.native)] : []),
  ]
  const createInboxPump = config.createInboxPump ?? createHostedTeamLeadInboxPumpPort
  return createHostedControlPortFactory(async context => {
    // Host-local runtimes resolve team state through the process config root;
    // Main pins it to the signed Claude root. Anything else would write to the
    // operator's desktop `~/.claude` instead of this admission's team root.
    if (join(getTeamsDir(), context.legacyKey) !== context.teamRoot) {
      throw new TypeError('Hosted host-local lanes require the admitted Claude root as config root')
    }
    const appMcp = config.appMcp && await verifyHostedAppMcpDescriptor(config.appMcp)
      ? buildHostedAppMcpLaunchConfig(config.appMcp, context.claudeRoot)
      : null
    const host: HostedHostLocalLaneHost = Object.freeze({ appMcp })
    const lanes: TeamLifecycleLaneEffectPort[] = []
    let openCodeLane: OpenCodeTeamLifecycleLane | null = null
    for (const createLane of laneFactories) {
      const lane = await createLane(context, host)
      if (!lane) continue
      if (!HOSTED_HOST_LOCAL_LANE_KINDS.includes(lane.kind) ||
        lanes.some(existing => existing.kind === lane.kind)) {
        throw new TypeError('Hosted host-local lanes must have distinct supported kinds')
      }
      if (lane instanceof OpenCodeTeamLifecycleLane) openCodeLane = lane
      lanes.push(bindHostLocalLane(lane, context))
    }
    if (!lanes.some(lane => lane.kind === 'opencode')) return { lanes }
    const launched = openCodeLane
    return {
      lanes,
      createInboxPump: launched
        ? options => createInboxPump({ ...options, getCapability: withLaunchedCapability(launched, options) })
        : createInboxPump,
    }
  })
}

/**
 * Hosted runs have no Product-written legacy manifest, so the pump takes the
 * capability this lane or its predecessor committed at launch; the legacy
 * manifest stays the fallback. The lane is keyed by the legacy key, as is the pump.
 */
function withLaunchedCapability(
  lane: OpenCodeTeamLifecycleLane,
  options: HostedTeamLeadInboxPumpOptions,
): NonNullable<HostedTeamLeadInboxPumpOptions['getCapability']> {
  return async input => await lane.launchedCapability(input) ??
    readOpenCodeLegacyStopCapability({ teamsPath: dirname(options.canonicalTeamRoot), ...input })
}

function createHostedTeamLeadInboxPumpPort(
  options: HostedTeamLeadInboxPumpOptions,
): HostedTeamInboxPumpPort {
  const pump = new HostedTeamLeadInboxPump(options)
  return Object.freeze({
    wakeRecipient: (recipient, messageId) => pump.wakeRecipient(recipient, messageId),
    recover: () => pump.recover(),
    start: () => pump.start(),
    close: () => pump.close(),
  })
}

/**
 * Binds a host-local lane to this admission. The plan's team id must be the
 * signed one, and the runtime addresses the team by the signed legacy key, the
 * name of the canonical team directory. Launch and inspect additionally require
 * the plan workspace to be the exact canonical mount the launcher declared.
 * Checks are synchronous: DurableTeamLifecycleExecution forbids any
 * asynchronous boundary between its authority guard and the adapter call.
 */
function bindHostLocalLane(
  lane: TeamLifecycleLaneEffectPort,
  context: Readonly<HostedControlRuntimePortFactoryContext>,
): TeamLifecycleLaneEffectPort {
  const { teamId, mountBinding: { declaredRootHash } } = context.authority
  const runtimeTeam = <T extends TeamLifecycleLaneInput>(input: T): T => {
    if (input.planTeamId !== teamId) throw new Error('Hosted lifecycle plan belongs to another team')
    return { ...input, planTeamId: context.legacyKey }
  }
  const admitWorkspace = (workspaceRoot: string): void => {
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
    // Plan admission (for example native topology limits) must survive the wrapper.
    ...(lane.supportsPlan ? { supportsPlan: (plan: TeamLifecycleLaunchPlan) => lane.supportsPlan!(plan) } : {}),
    inspect: async (input: TeamLifecycleLaneInput & { runId: string | null }) => {
      admitWorkspace(input.workspaceRoot)
      return lane.inspect(runtimeTeam(input))
    },
    launch: async (input: Running) => {
      admitWorkspace(input.workspaceRoot)
      return lane.launch(runtimeTeam(input))
    },
    cancel: async (input: Running) => lane.cancel(runtimeTeam(input)),
    stop: async (input: Running) => lane.stop(runtimeTeam(input)),
    recover: async (input: Running) => lane.recover(runtimeTeam(input)),
  })
}
