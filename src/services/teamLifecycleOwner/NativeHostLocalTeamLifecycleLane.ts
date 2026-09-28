import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'

import { isInBundledMode } from '../../utils/bundledMode.js'
import { isHostedTeamDraftPlaceholder } from '../../utils/swarm/hostedTeamDraftPlaceholder.js'
import {
  enforceNativeLaneLogLimit,
  ensureClaudeWorkspaceTrust,
  ensureNativeLanePrivateRoot,
  readClaudeOAuthToken,
  readNativeBootstrapPhase,
  readNativeLaneRecord,
  removeNativeLaneRecord,
  verifyCodexConfiguration,
  writeNativeLanePrivateFile,
  writeNativeLaneRecord,
  type NativeLaneRuntimeRecord,
} from './NativeHostLocalLaneHostFiles.js'
import {
  buildNativeBootstrapSpec,
  buildNativeLeadArgs,
  buildNativeLeadEnv,
  buildNativeMcpConfig,
  classifyNativeHostLocalLanes,
  classifyNativeHostLocalPlan,
  isNativeHostLocalPlatform,
  nativeBootstrapTimeoutMs,
  NativeHostLocalLaneError,
  type NativeHostLocalCredentials,
  type NativeHostLocalLaunchShape,
  type NativeHostLocalProvider,
} from './NativeHostLocalLanePlan.js'
import {
  createProductionNativeProcessPort,
  sweepNativeTeamProcesses,
  type NativeHostLocalProcessPort,
} from './NativeHostLocalLaneProcesses.js'
import { runNativeProviderPreflight, type NativeProviderPreflight } from './NativeHostLocalLanePreflight.js'
import { withAgentLanguageInstruction } from '../teamBootstrap/agentLanguageInstruction.js'
import type {
  TeamLifecycleLaneEffectPort,
  TeamLifecycleLaneInput,
  TeamLifecycleLaneObservation,
} from './OpenCodeTeamLifecycleLane.js'
import type { TeamLifecycleLaunchMember, TeamLifecycleLaunchPlan } from './TeamLifecycleLaunchPlan.js'

export const NATIVE_LANE_RUNTIME_RECORD_FILE = 'hosted-native-lane-runtime.v1.json'
const BOOTSTRAP_DEADLINE_GRACE_MS = 60_000
const DEFAULT_LOG_LIMIT_BYTES = 8 * 1024 * 1024
const LOG_LIMIT_INTERVAL_MS = 15_000

export type NativeHostLocalLaneMcpServer = Readonly<{
  command: string
  args: readonly string[]
  env?: Readonly<Record<string, string>>
}>

/** Strict resolution of the admitted agent-teams MCP artifact (command, entry, digest). */
export type NativeHostLocalLaneMcpResolver = (input: Readonly<{
  teamName: string
  claudeRoot: string
  workspaceRoot: string
}>) => Promise<NativeHostLocalLaneMcpServer>

/** Trusted operator configuration. Nothing here may come from Product or CLAUDE_DIR. */
export type NativeHostLocalLaneConfig = Readonly<{
  /** Pinned owner CLI for the lead; defaults to this process image. */
  ownerCommand?: Readonly<{ command: string; args: readonly string[] }>
  anthropic?: Readonly<{ oauthTokenFile: string }>
  codex?: Readonly<{ codexHome: string; codexCliPath: string }>
  /** Null keeps the lane capability-false, like OpenCode without a verified MCP artifact. */
  resolveMcpServer: NativeHostLocalLaneMcpResolver | null
  logLimitBytes?: number
  /** Host directory outside CLAUDE_DIR for launch material; defaults to the OS temp dir. */
  privateRuntimeParent?: string
}>

export type NativeHostLocalLaneContext = Readonly<{ claudeRoot: string; teamRoot: string; legacyKey: string }>

export type NativeHostLocalLaneDependencies = Readonly<{
  processes?: NativeHostLocalProcessPort
  preflight?: NativeProviderPreflight
  spawnLead?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  ensureWorkspaceTrust?: (claudeRoot: string, workspaceRoot: string) => Promise<void>
  hostEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  now?: () => number
}>

type RunInput = TeamLifecycleLaneInput & { runId: string }
type OwnedLead = { runId: string; child: ChildProcess; exited: boolean; logTimer: NodeJS.Timeout }

/**
 * Host-local lane for native Claude Code / Codex teams under the ADR-30
 * `trusted_process` profile. The lead is the pinned owner CLI in headless
 * deterministic-bootstrap mode; its teammates are detached process teammates.
 *
 * Known limit: the lead reads stdin, and only this hosted-control incarnation
 * holds that pipe. A hosted-control restart closes it, the lead runs its
 * shutdown prompt and the team stops; the durable execution then reports the
 * run as failed+recoverable and recover() sweeps whatever is left.
 */
export class NativeHostLocalTeamLifecycleLane implements TeamLifecycleLaneEffectPort {
  readonly kind = 'native' as const
  readonly #ownerToken = randomBytes(16).toString('hex')
  readonly #owned = new Map<string, OwnedLead>()
  readonly #queues = new Map<string, Promise<void>>()
  readonly #teamName: string
  readonly #teamRoot: string
  readonly #claudeRoot: string
  readonly #recordPath: string
  #runtimeRoot: Promise<string> | null = null
  readonly #command: string
  readonly #commandArgs: readonly string[]
  readonly #processes: NativeHostLocalProcessPort
  readonly #preflight: NativeProviderPreflight
  readonly #spawnLead: NonNullable<NativeHostLocalLaneDependencies['spawnLead']>
  readonly #ensureWorkspaceTrust: NonNullable<NativeHostLocalLaneDependencies['ensureWorkspaceTrust']>
  readonly #hostEnv: NodeJS.ProcessEnv
  readonly #platform: NodeJS.Platform
  readonly #now: () => number

  constructor(
    context: NativeHostLocalLaneContext,
    private readonly config: NativeHostLocalLaneConfig,
    dependencies: NativeHostLocalLaneDependencies = {},
  ) {
    // CLAUDE_CONFIG_DIR of the lead must resolve teams/<name> to exactly this root.
    if (!isAbsolute(context.claudeRoot) || context.teamRoot !== join(context.claudeRoot, 'teams', context.legacyKey)) {
      throw new TypeError('Native host-local lane requires the canonical <claudeRoot>/teams/<legacyKey> root')
    }
    const ownerCommand = config.ownerCommand ?? defaultOwnerCommand()
    if (!isAbsolute(ownerCommand.command)) throw new TypeError('Native host-local lane owner command must be absolute')
    this.#teamName = context.legacyKey
    this.#teamRoot = context.teamRoot
    this.#claudeRoot = context.claudeRoot
    this.#recordPath = join(context.teamRoot, NATIVE_LANE_RUNTIME_RECORD_FILE)
    this.#command = ownerCommand.command
    this.#commandArgs = [...ownerCommand.args]
    this.#platform = dependencies.platform ?? process.platform
    this.#processes = dependencies.processes ?? createProductionNativeProcessPort(this.#platform)
    this.#preflight = dependencies.preflight ?? runNativeProviderPreflight
    this.#spawnLead = dependencies.spawnLead ?? ((command, args, options) => spawn(command, [...args], options))
    this.#ensureWorkspaceTrust = dependencies.ensureWorkspaceTrust ?? ensureClaudeWorkspaceTrust
    this.#hostEnv = dependencies.hostEnv ?? process.env
    this.#now = dependencies.now ?? Date.now
  }

  supports(): boolean {
    return isNativeHostLocalPlatform(this.#platform) && this.#configuredProviders().size > 0 &&
      this.config.resolveMcpServer !== null
  }

  supportsPlan(plan: TeamLifecycleLaunchPlan): boolean {
    return typeof classifyNativeHostLocalPlan(plan, this.#classifyOptions()) !== 'string'
  }

  inspect(input: TeamLifecycleLaneInput & { runId: string | null }): Promise<TeamLifecycleLaneObservation> {
    const runId = input.runId
    if (input.lane.kind !== 'native' || !runId) return Promise.resolve(idle())
    return this.#serialized(input, () => this.#inspect(runId))
  }

  launch(input: RunInput): Promise<TeamLifecycleLaneObservation> {
    return this.#serialized(input, () => this.#launch(input))
  }

  cancel(input: RunInput): Promise<TeamLifecycleLaneObservation> {
    return this.#serialized(input, () => this.#teardown())
  }

  stop(input: RunInput): Promise<TeamLifecycleLaneObservation> {
    return this.#serialized(input, () => this.#teardown())
  }

  /** Recovery is a confirmed cleanup to idle; a new launch needs a fresh command. */
  recover(input: RunInput): Promise<TeamLifecycleLaneObservation> {
    return this.#serialized(input, () => this.#teardown())
  }

  async #inspect(runId: string): Promise<TeamLifecycleLaneObservation> {
    let record: NativeLaneRuntimeRecord | null
    try {
      record = await readNativeLaneRecord(this.#recordPath)
    } catch {
      return failed()
    }
    if (!record || record.runId !== runId) return idle()
    const owned = this.#owned.get(runId)
    // A lead started by another hosted-control incarnation has lost its stdin owner.
    if (!owned || owned.exited || record.ownerToken !== this.#ownerToken ||
      record.pid === null || record.startedAt === null) return failed()
    if (await this.#processes.readStartedAt(record.pid) !== record.startedAt) return failed()
    const phase = await readNativeBootstrapPhase(this.#teamRoot, runId)
    if (phase === 'completed') return { phase: 'running', recoverable: false }
    if (phase === 'failed' || this.#now() > record.deadlineAtMs) return failed()
    return { phase: 'launching', recoverable: false }
  }

  async #launch(input: RunInput): Promise<TeamLifecycleLaneObservation> {
    const shape = classifyNativeHostLocalLanes(
      input.planLanes ?? [input.lane], input.toolApprovalMode, this.#classifyOptions())
    if (typeof shape === 'string') throw new NativeHostLocalLaneError(shape)
    if (input.lane.laneId !== shape.leadLane.laneId) {
      // A members-only native lane is started by the lead's bootstrap and
      // reports the lead's state; before the lead lane ran it is launching.
      const observed = await this.#inspect(input.runId)
      return observed.phase === 'idle' ? { phase: 'launching', recoverable: false } : observed
    }
    if (this.#owned.has(input.runId)) return this.#inspect(input.runId)
    const previous = await readNativeLaneRecord(this.#recordPath)
    if (previous?.runId === input.runId) {
      // A crashed or foreign launch of this exact run is never adopted.
      throw new NativeHostLocalLaneError('native_lane_run_not_owned')
    }
    await this.#sweepOrThrow('native_lane_orphan_sweep_unconfirmed')
    await removeNativeLaneRecord(this.#recordPath)
    const runtimeRoot = await this.#privateRuntimeRoot()
    await rm(runtimeRoot, { recursive: true, force: true })

    const credentials = await Promise.all([...shape.providers].map(provider => this.#credentials(provider)))
    const env = buildNativeLeadEnv({
      hostEnv: this.#hostEnv, claudeRoot: this.#claudeRoot, leadProvider: shape.leadProvider, credentials,
    })
    for (const provider of shape.providers) {
      await this.#preflight({
        provider,
        command: this.#command,
        commandArgs: this.#commandArgs,
        cwd: input.workspaceRoot,
        env,
      })
    }
    // Headless Claude teammates, and a Claude lead, need the workspace trusted.
    if (shape.providers.has('anthropic')) await this.#ensureWorkspaceTrust(this.#claudeRoot, input.workspaceRoot)

    const runtimeDir = join(runtimeRoot, input.runId)
    const files = await this.#materialize(input, shape, runtimeDir)
    const launchedAtMs = this.#now()
    const record: NativeLaneRuntimeRecord = {
      schemaVersion: 1,
      runId: input.runId,
      laneId: input.lane.laneId,
      ownerToken: this.#ownerToken,
      runtimeDir,
      specPath: files.specPath,
      launchedAtMs,
      deadlineAtMs: launchedAtMs + nativeBootstrapTimeoutMs(shape.teammates.length) + BOOTSTRAP_DEADLINE_GRACE_MS,
      pid: null,
      startedAt: null,
      osIdentity: null,
    }
    // Intent first: a crash after spawn still leaves the spec path the sweep keys on.
    await writeNativeLaneRecord(this.#recordPath, record)
    const owned = this.#spawn(input, shape.lead, env, files, runtimeDir)
    const pid = owned.child.pid!
    const startedAt = await this.#processes.readStartedAt(pid)
    const osIdentity = startedAt === null ? null : await this.#processes.captureIdentity(pid)
    if (startedAt === null || !osIdentity) {
      owned.child.kill('SIGKILL')
      await this.#teardown().catch(() => undefined)
      throw new Error('Native lead process identity could not be captured')
    }
    await writeNativeLaneRecord(this.#recordPath, { ...record, pid, startedAt, osIdentity })
    return { phase: 'launching', recoverable: false }
  }

  async #materialize(
    input: RunInput,
    shape: NativeHostLocalLaunchShape,
    runtimeDir: string,
  ): Promise<{ specPath: string; userPromptPath: string; mcpConfigPath: string }> {
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
    if (!this.config.resolveMcpServer) throw new Error('Native lane has no admitted agent-teams MCP artifact')
    const mcpServer = await this.config.resolveMcpServer({
      teamName: this.#teamName,
      claudeRoot: this.#claudeRoot,
      workspaceRoot: input.workspaceRoot,
    })
    const teamExists = await hasMaterializedTeam(this.#teamRoot, this.#teamName)
    const files = {
      specPath: join(runtimeDir, 'bootstrap-spec.json'),
      userPromptPath: join(runtimeDir, 'lead-prompt.txt'),
      mcpConfigPath: join(runtimeDir, 'mcp-config.json'),
    }
    await writeNativeLanePrivateFile(files.specPath, JSON.stringify(buildNativeBootstrapSpec({
      runId: input.runId,
      teamName: this.#teamName,
      workspaceRoot: input.workspaceRoot,
      mode: teamExists ? 'launch' : 'create',
      shape,
      ...(input.agentLanguage === undefined ? {} : { agentLanguage: input.agentLanguage }),
    })))
    await writeNativeLanePrivateFile(files.userPromptPath,
      withAgentLanguageInstruction(input.agentLanguage, shape.lead.prompt))
    await writeNativeLanePrivateFile(files.mcpConfigPath, JSON.stringify(buildNativeMcpConfig(mcpServer, this.#claudeRoot)))
    return files
  }

  #spawn(
    input: RunInput,
    lead: TeamLifecycleLaunchMember,
    env: Record<string, string>,
    files: { specPath: string; userPromptPath: string; mcpConfigPath: string },
    runtimeDir: string,
  ): OwnedLead {
    const stdoutPath = join(runtimeDir, 'lead.stdout.log')
    const stderrPath = join(runtimeDir, 'lead.stderr.log')
    // Logs are files the lead appends to directly: a pipe would stall or SIGPIPE
    // the lead whenever this process is slow or gone.
    const stdoutFd = openSync(stdoutPath, 'a', 0o600)
    let stderrFd: number | null = null
    let child: ChildProcess
    try {
      stderrFd = openSync(stderrPath, 'a', 0o600)
      child = this.#spawnLead(this.#command, buildNativeLeadArgs({
        commandArgs: this.#commandArgs,
        mcpConfigPath: files.mcpConfigPath,
        specPath: files.specPath,
        userPromptPath: files.userPromptPath,
        lead,
      }), {
        cwd: input.workspaceRoot,
        env,
        // stdin stays an open pipe for the lead's lifetime; nothing is written to it.
        stdio: ['pipe', stdoutFd, stderrFd],
        detached: true,
        windowsHide: true,
      })
    } finally {
      closeSync(stdoutFd)
      if (stderrFd !== null) closeSync(stderrFd)
    }
    if (!child.pid) {
      child.kill('SIGKILL')
      throw new Error('Native lead process did not start')
    }
    const limit = this.config.logLimitBytes ?? DEFAULT_LOG_LIMIT_BYTES
    const logTimer = setInterval(() => {
      void enforceNativeLaneLogLimit(stdoutPath, limit)
      void enforceNativeLaneLogLimit(stderrPath, limit)
    }, LOG_LIMIT_INTERVAL_MS)
    logTimer.unref?.()
    const owned: OwnedLead = { runId: input.runId, child, exited: false, logTimer }
    const markExited = () => {
      owned.exited = true
      clearInterval(logTimer)
    }
    child.once('exit', markExited)
    child.once('error', markExited)
    child.stdin?.on('error', () => undefined)
    this.#owned.set(input.runId, owned)
    return owned
  }

  async #teardown(): Promise<TeamLifecycleLaneObservation> {
    await this.#sweepOrThrow('native_lane_stop_unconfirmed')
    for (const owned of this.#owned.values()) {
      clearInterval(owned.logTimer)
      owned.child.stdin?.destroy()
    }
    this.#owned.clear()
    await removeNativeLaneRecord(this.#recordPath)
    await rm(await this.#privateRuntimeRoot(), { recursive: true, force: true })
    return idle()
  }

  async #sweepOrThrow(code: 'native_lane_orphan_sweep_unconfirmed' | 'native_lane_stop_unconfirmed'): Promise<void> {
    const confirmed = await sweepNativeTeamProcesses({
      port: this.#processes,
      teamRoot: this.#teamRoot,
      teamName: this.#teamName,
      leadSpecPrefix: `${await this.#privateRuntimeRoot()}${sep}`,
    })
    if (!confirmed) throw new NativeHostLocalLaneError(code)
  }

  /** Per-team launch material root; its path is also the orphan-sweep argv key. */
  #privateRuntimeRoot(): Promise<string> {
    if (!this.#runtimeRoot) {
      const pending = ensureNativeLanePrivateRoot(this.config.privateRuntimeParent ?? tmpdir())
        .then(root => join(root, nativeLaneTeamRuntimeKey(this.#teamRoot)))
      // A failed probe is retried on the next call instead of being cached.
      pending.catch(() => {
        if (this.#runtimeRoot === pending) this.#runtimeRoot = null
      })
      this.#runtimeRoot = pending
    }
    return this.#runtimeRoot
  }

  async #credentials(provider: NativeHostLocalProvider): Promise<NativeHostLocalCredentials> {
    if (provider === 'anthropic') {
      const tokenFile = this.config.anthropic?.oauthTokenFile
      if (!tokenFile) throw new NativeHostLocalLaneError('native_lane_provider_not_configured')
      return { provider, oauthToken: await readClaudeOAuthToken(tokenFile, this.#claudeRoot) }
    }
    const codex = this.config.codex
    if (!codex) throw new NativeHostLocalLaneError('native_lane_provider_not_configured')
    await verifyCodexConfiguration(codex, this.#claudeRoot)
    return { provider, codexHome: codex.codexHome, codexCliPath: codex.codexCliPath }
  }

  #configuredProviders(): ReadonlySet<NativeHostLocalProvider> {
    const providers = new Set<NativeHostLocalProvider>()
    if (this.config.anthropic) providers.add('anthropic')
    if (this.config.codex) providers.add('codex')
    return providers
  }

  #classifyOptions() {
    return { teamName: this.#teamName, configuredProviders: this.#configuredProviders(), platform: this.#platform }
  }

  async #serialized<T>(
    input: { planTeamId: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    // One queue per team: every native lane of a team shares one lead process.
    const key = input.planTeamId
    const prior = this.#queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = prior.then(() => current)
    this.#queues.set(key, tail)
    await prior
    try {
      return await operation()
    } finally {
      release()
      if (this.#queues.get(key) === tail) this.#queues.delete(key)
    }
  }
}

export function createNativeHostLocalTeamLifecycleLane(
  context: NativeHostLocalLaneContext,
  config: NativeHostLocalLaneConfig,
  dependencies?: NativeHostLocalLaneDependencies,
): NativeHostLocalTeamLifecycleLane {
  return new NativeHostLocalTeamLifecycleLane(context, config, dependencies)
}

/**
 * A bootstrap `launch` needs a real team file. The hosted draft placeholder is
 * not one, so it takes the `create` path, which replaces it in place.
 */
async function hasMaterializedTeam(teamRoot: string, teamName: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(join(teamRoot, 'config.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return true }
  return !isHostedTeamDraftPlaceholder(parsed, teamName)
}

/** Stable per-team directory name below the host-private root. */
export function nativeLaneTeamRuntimeKey(teamRoot: string): string {
  return createHash('sha256').update(teamRoot).digest('hex').slice(0, 32)
}

/** Same self-invocation rule as process teammates: the compiled image, or bun + CLI entry in dev. */
function defaultOwnerCommand(): { command: string; args: readonly string[] } {
  if (isInBundledMode()) return { command: process.execPath, args: [] }
  const entry = process.argv[1]
  if (!entry || !isAbsolute(entry)) throw new TypeError('Native host-local lane cannot resolve the owner CLI entry')
  return { command: process.execPath, args: [entry] }
}

function idle(): TeamLifecycleLaneObservation {
  return { phase: 'idle', recoverable: false }
}

function failed(): TeamLifecycleLaneObservation {
  return { phase: 'failed', recoverable: true }
}
