import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { HOSTED_LEAD_INBOX_POLL_ENV } from '../../utils/swarm/hostedLeadInboxPoll.js'
import { sanitizeName } from '../../utils/swarm/teamNameSanitizer.js'
import type {
  NativeTeamLifecycleProvider,
  TeamLifecycleLaunchLane,
  TeamLifecycleLaunchMember,
  TeamLifecycleLaunchPlan,
} from './TeamLifecycleLaunchPlan.js'

/** Providers the host-local native lane can run in the MVP slice. Gemini is out of scope. */
export type NativeHostLocalProvider = Extract<NativeTeamLifecycleProvider, 'anthropic' | 'codex'>
type NativeLane = Extract<TeamLifecycleLaunchLane, { kind: 'native' }>

export type NativeHostLocalLaneErrorCode =
  | 'native_lane_opencode_lead_unsupported'
  | 'native_lane_lead_missing'
  | 'native_lane_member_name_invalid'
  | 'native_lane_too_many_members'
  | 'native_lane_provider_unsupported'
  | 'native_lane_provider_not_configured'
  | 'native_lane_manual_approval_unsupported'
  | 'native_lane_team_name_not_canonical'
  | 'native_lane_platform_unsupported'
  | 'native_lane_provider_preflight_failed'
  | 'native_lane_provider_not_authenticated'
  | 'native_lane_credentials_unavailable'
  | 'native_lane_orphan_sweep_unconfirmed'
  | 'native_lane_run_not_owned'
  | 'native_lane_stop_unconfirmed'

export class NativeHostLocalLaneError extends Error {
  constructor(readonly code: NativeHostLocalLaneErrorCode, message: string = code) {
    super(message)
    this.name = 'NativeHostLocalLaneError'
  }
}

/** Mirrors the Product desktop launch; these tools belong to the app, not the lead. */
export const NATIVE_LANE_DISALLOWED_TOOLS =
  'TeamDelete,TodoWrite,TaskCreate,TaskUpdate,mcp__agent-teams__team_launch,mcp__agent-teams__team_stop'
export const NATIVE_LANE_MCP_SERVER_NAME = 'agent-teams'
const MAX_BOOTSTRAP_TEAMMATES = 20
const BOOTSTRAP_MIN_TIMEOUT_MS = 120_000
const BOOTSTRAP_TIMEOUT_PER_MEMBER_MS = 110_000
const BOOTSTRAP_MAX_TIMEOUT_MS = 900_000

/**
 * Host env the lead may inherit. Everything else, including provider keys and
 * CLAUDE_* routing from the hosted-control process, is dropped on purpose.
 */
export const NATIVE_LANE_BASE_ENV_ALLOWLIST = [
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
] as const

export type NativeHostLocalCredentials =
  | Readonly<{ provider: 'anthropic'; oauthToken: string }>
  | Readonly<{ provider: 'codex'; codexHome: string; codexCliPath: string }>

export type NativeHostLocalTeammate = TeamLifecycleLaunchMember & Readonly<{ provider: NativeHostLocalProvider }>

/**
 * One native team, possibly spread over one lane per provider. The lane with
 * team-lead launches the lead; every other native lane only contributes members.
 */
export type NativeHostLocalLaunchShape = Readonly<{
  leadLane: NativeLane
  leadProvider: NativeHostLocalProvider
  providers: ReadonlySet<NativeHostLocalProvider>
  lead: TeamLifecycleLaunchMember
  teammates: readonly NativeHostLocalTeammate[]
}>

type NativeLaneClassifyOptions = {
  teamName: string
  configuredProviders: ReadonlySet<NativeHostLocalProvider>
  platform?: NodeJS.Platform
}

export function classifyNativeHostLocalPlan(
  plan: TeamLifecycleLaunchPlan,
  options: NativeLaneClassifyOptions,
): NativeHostLocalLaunchShape | NativeHostLocalLaneErrorCode {
  return classifyNativeHostLocalLanes(plan.lanes, plan.toolApprovalMode, options)
}

/**
 * Desktop parity for native teams: a Claude or Codex lead with members of
 * either provider, spawned by the lead from one bootstrap (desktop
 * `primary_only`). OpenCode lanes may join a native-led team as side lanes
 * (desktop `mixed_opencode_side_lanes`); their members are not in the lead's
 * bootstrap. Like desktop, an OpenCode lead with native members is rejected.
 */
export function classifyNativeHostLocalLanes(
  lanes: readonly TeamLifecycleLaunchLane[],
  toolApprovalMode: TeamLifecycleLaunchPlan['toolApprovalMode'],
  options: NativeLaneClassifyOptions,
): NativeHostLocalLaunchShape | NativeHostLocalLaneErrorCode {
  if (!isNativeHostLocalPlatform(options.platform)) return 'native_lane_platform_unsupported'
  const native = lanes.filter((lane): lane is NativeLane => lane.kind === 'native')
  if (native.length === 0) return 'native_lane_lead_missing'
  const sideLanes = lanes.filter(lane => lane.kind !== 'native')
  if (sideLanes.some(lane => lane.members.some(member => member.name === TEAM_LEAD_NAME))) {
    return 'native_lane_opencode_lead_unsupported'
  }
  const providers = new Set<NativeHostLocalProvider>()
  for (const lane of native) {
    if (lane.provider !== 'anthropic' && lane.provider !== 'codex') return 'native_lane_provider_unsupported'
    if (!options.configuredProviders.has(lane.provider)) return 'native_lane_provider_not_configured'
    providers.add(lane.provider)
  }
  if (toolApprovalMode !== 'auto') return 'native_lane_manual_approval_unsupported'
  if (sanitizeName(options.teamName) !== options.teamName) return 'native_lane_team_name_not_canonical'
  const leadLanes = native.filter(lane => lane.members.some(member => member.name === TEAM_LEAD_NAME))
  if (leadLanes.length === 0) return 'native_lane_lead_missing'
  if (leadLanes.length !== 1) return 'native_lane_member_name_invalid'
  const leadLane = leadLanes[0]!
  const lead = leadLane.members.find(member => member.name === TEAM_LEAD_NAME)!
  const teammates = native.flatMap(lane => lane.members
    .filter(member => member !== lead)
    .map(member => ({ ...member, provider: lane.provider as NativeHostLocalProvider })))
  if (teammates.length > MAX_BOOTSTRAP_TEAMMATES) return 'native_lane_too_many_members'
  const normalized = new Set<string>()
  // Names are one namespace across every lane: inboxes and the roster key by name.
  const everyTeammate = [...teammates, ...sideLanes.flatMap(lane => lane.members)]
  for (const member of everyTeammate) {
    const lowered = member.name.toLowerCase()
    const key = sanitizeName(member.name)
    if (lowered === TEAM_LEAD_NAME || lowered === 'user' || !key || normalized.has(key)) {
      return 'native_lane_member_name_invalid'
    }
    normalized.add(key)
  }
  return { leadLane, leadProvider: leadLane.provider as NativeHostLocalProvider, providers, lead, teammates }
}

/** Process-group ownership primitives exist only on Linux and macOS. */
export function isNativeHostLocalPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' || platform === 'darwin'
}

/** Same budget formula as the Product desktop launch. */
export function nativeBootstrapTimeoutMs(teammateCount: number): number {
  return Math.min(
    BOOTSTRAP_MAX_TIMEOUT_MS,
    Math.max(BOOTSTRAP_MIN_TIMEOUT_MS, teammateCount * BOOTSTRAP_TIMEOUT_PER_MEMBER_MS),
  )
}

/**
 * Deterministic bootstrap spec. The hosted member prompt is operator/user
 * instruction text, so it travels as `workflow`: the runtime still builds the
 * standard teammate briefing (member_briefing, review flow) around it.
 */
export function buildNativeBootstrapSpec(input: {
  runId: string
  teamName: string
  workspaceRoot: string
  mode: 'create' | 'launch'
  shape: NativeHostLocalLaunchShape
  agentLanguage?: string
}): Record<string, unknown> {
  return {
    version: 1,
    runId: input.runId,
    mode: input.mode,
    initiator: { kind: 'app', source: 'claude_team_agent_teams_orchestrator' },
    team: { name: input.teamName, cwd: input.workspaceRoot },
    // The runtime adds the language line to every teammate prompt, as for the desktop launch.
    lead: input.agentLanguage ? { agentLanguage: input.agentLanguage } : {},
    members: input.shape.teammates.map(member => ({
      name: member.name,
      workflow: member.prompt,
      cwd: input.workspaceRoot,
      provider: member.provider,
      ...(member.model ? { model: member.model } : {}),
      ...(member.effort ? { effort: member.effort } : {}),
    })),
    launch: {
      bootstrapTimeoutMs: nativeBootstrapTimeoutMs(input.shape.teammates.length),
      continueOnPartialFailure: true,
    },
    ui: { emitStructuredEvents: true },
  }
}

export function buildNativeMcpConfig(server: Readonly<{
  command: string
  args: readonly string[]
  env?: Readonly<Record<string, string>>
}>, claudeRoot: string): Record<string, unknown> {
  // stdio is the only transport the Codex MCP bridge translates.
  return {
    mcpServers: {
      [NATIVE_LANE_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: server.command,
        args: [...server.args],
        env: { ...(server.env ?? {}), AGENT_TEAMS_MCP_CLAUDE_DIR: claudeRoot },
      },
    },
  }
}

export function buildNativeLeadArgs(input: {
  commandArgs: readonly string[]
  mcpConfigPath: string
  specPath: string
  userPromptPath: string
  lead: TeamLifecycleLaunchMember
}): string[] {
  return [
    ...input.commandArgs,
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--setting-sources', 'user,project,local',
    '--mcp-config', input.mcpConfigPath,
    '--team-bootstrap-spec', input.specPath,
    '--team-bootstrap-user-prompt-file', input.userPromptPath,
    '--disallowedTools', NATIVE_LANE_DISALLOWED_TOOLS,
    '--dangerously-skip-permissions',
    '--permission-mode', 'bypassPermissions',
    ...(input.lead.model ? ['--model', input.lead.model] : []),
    ...(input.lead.effort ? ['--effort', input.lead.effort] : []),
  ]
}

/**
 * Builds the complete lead env from an empty base. Process teammates inherit
 * this env, so every provider credential of the team reaches the teammate that
 * needs it without touching CLAUDE_DIR, which is shared with the Product
 * container. Like desktop, a non-Anthropic lead still carries the Anthropic
 * connection mode as inert metadata for Claude teammates it spawns.
 */
export function buildNativeLeadEnv(input: {
  hostEnv: NodeJS.ProcessEnv
  claudeRoot: string
  leadProvider: NativeHostLocalProvider
  credentials: readonly NativeHostLocalCredentials[]
}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of NATIVE_LANE_BASE_ENV_ALLOWLIST) {
    const value = input.hostEnv[key]
    if (typeof value === 'string' && value.length > 0 && !value.includes('\0')) env[key] = value
  }
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: input.claudeRoot,
    CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP: '1',
    CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES: '1',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    CLAUDE_CODE_ENTRY_PROVIDER: input.leadProvider,
    [HOSTED_LEAD_INBOX_POLL_ENV]: '1',
  })
  for (const credentials of input.credentials) {
    if (credentials.provider === 'anthropic') {
      env.CLAUDE_CODE_OAUTH_TOKEN = credentials.oauthToken
      env.AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE = 'subscription'
    } else {
      env.CODEX_HOME = credentials.codexHome
      env.CODEX_CLI_PATH = credentials.codexCliPath
      env.CLAUDE_CODE_CODEX_BACKEND = 'codex-native'
      env.CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD = 'chatgpt'
    }
  }
  return env
}
