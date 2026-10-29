import { openCodeV2EngineVersion } from '../compatibility/OpenCodeV2Registry.js'
import { openCodeBunVersion } from '../../../constants/openCodeBunVersion.js'
import { assertOpenCodeV2Launchable } from '../compatibility/OpenCodeV2Registry.js'
import { resolveOpenCodeV2ExecutionProbe } from './OpenCodeV2ExecutionProbe.js'
import { parseOpenCodeExecutionProof } from '../OpenCodeExecutionProof.js'
import type { OpenCodePreparedProfile } from '../types.js'
import type { ValidatedExecutionNative } from '../host/OpenCodeV2ExecutionHost.js'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveOpenCodeV2ExecutionDelivery } from '../host/OpenCodeV2ExecutionDelivery.js'
import { assertExecutionPlatformAvailable } from '../host/OpenCodeV2ExecutionPlatform.js'
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile, access, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'

import { executionAssert, executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import { hashOpenCodeFile, inspectOpenCodeReadSelection } from '../compatibility/OpenCodeNativeIdentity.js'
import { resolveClaudeMultimodelPaths } from '../OpenCodeManagedPaths.js'
import { collectProjectBehaviorMetadata, canonicalizeOpenCodeProjectPath, materializeOpenCodeSelectedScopeAuth, resolveOpenCodeProfileScope, readOpenCodeSelectedScopeMetadata } from '../OpenCodeProfileManager.js'
import { normalizeOpenCodeProjectIdentity } from '../OpenCodeProjectIdentity.js'
import { resolveOpenCodeAppMcpLaunchConfig } from '../OpenCodeMcpManager.js'
import { createOpenCodeV2ExecutionConfig, OPENCODE_V2_TEAMMATE_PERMISSIONS } from '../profile/OpenCodeV2ExecutionConfig.js'
import { createOpenCodeV2ExecutionReceipt } from '../profile/OpenCodeV2ExecutionReceipt.js'
import { privateOpenCodeReadEnvironment } from '../profile/OpenCodeV2ManagedConfig.js'
import { buildOpenCodeAppManagedBootstrapContextText } from '../OpenCodeBridgeCommandHandler.js'
import { parseOpenCodeBridgePreconditions, requireOpenCodeExpectedBehaviorFingerprint, validateOpenCodeBridgeStateChangingPreconditions } from '../OpenCodeBridgePreconditions.js'
import type { ExecutionMcpConfig } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import type { SelectedExecutionProfile } from '../host/OpenCodeV2ExecutionHost.js'
import type { BridgeEnvelope } from './OpenCodeBridgeProtocol.js'
import type { RunLaunchPlan, RunMemberPlan } from './OpenCodeV2RunTypes.js'

// One command owns this non-serializable, one-use preparation. No process-wide
// receipt cache exists; DTO copies and subsequent commands verify bytes anew.
const preparedPlanReceipt = Symbol('preparedOpenCodeV2PlanReceipt')
type PreparedPlanSelection = Awaited<ReturnType<typeof inspectOpenCodeV2LaunchSelection>> & {
  [preparedPlanReceipt]?: () => ValidatedExecutionNative
}

const text = (value: unknown): string => { executionAssert(typeof value === 'string' && value.trim().length > 0, 'run_launch_input_invalid'); return value }
const SUPERVISOR_ENVIRONMENT_NAMES = new Map([
  ['PATH', 'PATH'], ['HOME', 'HOME'], ['USER', 'USER'], ['LOGNAME', 'LOGNAME'],
  ['TMPDIR', 'TMPDIR'], ['LANG', 'LANG'], ['LC_ALL', 'LC_ALL'],
  ['LOCALAPPDATA', 'LOCALAPPDATA'], ['SYSTEMROOT', 'SystemRoot'], ['WINDIR', 'WINDIR'],
])
const WINDOWS_SUPERVISOR_ENVIRONMENT_NAMES = new Set(['LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR'])
const SUPERVISOR_ENVIRONMENT_INJECTION = /^(?:NODE_OPTIONS|NODE_PATH|BUN_.*|LD_.*|DYLD_.*|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS)$/i
const selectedDeliveries = new WeakMap<object, Awaited<ReturnType<typeof resolveOpenCodeV2ExecutionDelivery>>>()

/** Reject loader-option injection in any plan-like supervisor replacement. */
export function assertOpenCodeV2SupervisorEnvironment(environment: Readonly<Record<string, string>>): void {
  executionAssert(!Object.keys(environment).some(key => SUPERVISOR_ENVIRONMENT_INJECTION.test(key)), 'run_environment_injection')
}

/** Build the explicit supervisor replacement environment. Windows retains only
 * the native broker's three trusted path essentials; no request environment is
 * merged and loader-option names remain excluded. */
export function createOpenCodeV2SupervisorEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const selected = new Map<string, Readonly<{ name: string; value: string }>>(), result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key, name = SUPERVISOR_ENVIRONMENT_NAMES.get(normalized)
    if (!name || typeof value !== 'string' || (WINDOWS_SUPERVISOR_ENVIRONMENT_NAMES.has(normalized) && process.platform !== 'win32')) continue
    executionAssert(!SUPERVISOR_ENVIRONMENT_INJECTION.test(name), 'run_environment_injection')
    if (WINDOWS_SUPERVISOR_ENVIRONMENT_NAMES.has(normalized))
      executionAssert(path.win32.isAbsolute(value) && !value.includes('/') && path.win32.normalize(value) === value &&
        path.win32.parse(value).root !== value, 'run_environment_path_invalid')
    const previous = selected.get(normalized)
    if (previous) {
      executionAssert(previous.name === name && previous.value === value, 'run_environment_alias')
      continue
    }
    selected.set(normalized, Object.freeze({ name, value })); result[name] = value
  }
  assertOpenCodeV2SupervisorEnvironment(result)
  return result
}

export async function inspectOpenCodeV2LaunchSelection(envelope: BridgeEnvelope) {
  assertExecutionPlatformAvailable()
  executionAssert(process.versions.bun === openCodeBunVersion(), 'run_source_bun_required')
  const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'run-owner')
  const selected = await inspectOpenCodeReadSelection()
  executionAssert(selected.native && selected.policy.generation === 'v2', 'run_selected_native_unknown')
  const selectedModel = text(envelope.body.selectedModel)
  const slash = selectedModel.indexOf('/')
  executionAssert(slash > 0 && slash < selectedModel.length - 1, 'run_selected_model_invalid')
  const model = { providerID: selectedModel.slice(0, slash), id: selectedModel.slice(slash + 1) }
  executionAssert(!['kiro', 'cursor-acp'].includes(model.providerID), 'run_extension_provider_unsupported')
  executionAssert(envelope.body.skipPermissions !== false &&
    (envelope.body.toolApprovalMode === undefined || envelope.body.toolApprovalMode === 'auto'), 'run_manual_permission_unsupported')
  const project = await canonicalizeOpenCodeProjectPath(typeof envelope.body.projectPath === 'string' ? envelope.body.projectPath : envelope.cwd)
  const scope = await resolveOpenCodeProfileScope({ projectPath: project, purpose: 'launch_runtime', selectedModel })
  executionAssert(scope.selectedAuthIdentity !== 'error', 'run_selected_auth_unknown')
  const resolved = await resolveOpenCodeAppMcpLaunchConfig()
  executionAssert(resolved.config.enabled !== false, 'run_controller_disabled')
  let controller: ExecutionMcpConfig = resolved.config.type === 'local'
    ? { type: 'local', command: [...(resolved.config.command ?? [])], ...(resolved.config.environment ? { environment: { ...resolved.config.environment } } : {}) }
    : { type: 'remote', url: text(resolved.config.url), oauth: false,
      ...(resolved.config.headers ? { headers: { ...resolved.config.headers } } : {}) }
  if (controller.type === 'local') {
    const command = [...controller.command], runtime = command[0]
    executionAssert(runtime, 'run_controller_runtime_missing')
    let binary: string | undefined
    for (const candidate of path.isAbsolute(runtime) ? [runtime] :
      (resolved.config.environment?.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute).map(directory => path.join(directory, runtime))) {
      try { await access(candidate, constants.X_OK); binary = await realpath(candidate); break } catch { /* Try the next selected PATH entry. */ }
    }
    executionAssert(binary, 'run_controller_runtime_missing'); command[0] = binary
    // Package layouts can reach entry files through store links (for example
    // node_modules/tsx/dist/cli.mjs under pnpm). The execution receipt binds
    // canonical file identities (realpath(entry) === entry), so resolve each
    // non-flag entry to its real file before fingerprinting, spawning and
    // receipt verification all observe the same canonical command.
    for (let index = 1; index < command.length; index += 1) {
      const argument = command[index]!
      if (argument.startsWith('-')) continue
      executionAssert(path.isAbsolute(argument), 'controller_entry_not_absolute')
      const entry = await realpath(argument).catch(() => null)
      executionAssert(entry !== null && (await lstat(entry)).isFile(), 'controller_entry_invalid')
      command[index] = entry
    }
    // The native private profile supplies HOME/PATH/TMP. Only the selected
    // controller's team boundary and owned transport identity are forwarded.
    const environment: Record<string, string> = {}
    for (const key of ['AGENT_TEAMS_MCP_CLAUDE_DIR', 'CLAUDE_TEAM_CONTROL_URL']) {
      const value = controller.environment?.[key]
      if (value) environment[key] = value
    }
    controller = { ...controller, command, environment }
  }
  const behaviorFingerprint = executionHash({ source: 'linux-v2-protocol1', pin: selected.native.version,
    ...(selected.native.origin === 'standalone' ? { nativeOrigin: 'standalone' } : {}),
    ...(openCodeV2EngineVersion(selected.native) === selected.native.version ? {} : { engineVersion: openCodeV2EngineVersion(selected.native) }),
    binary: selected.native.executableSha256, model, scope: { purpose: scope.purpose, providerId: scope.providerId,
      configFingerprint: scope.configFingerprint, selectedAuthIdentity: scope.selectedAuthIdentity }, controller })
  const selection = { native: selected.native, model, project, scope, controller, behaviorFingerprint,
    capabilitySnapshotId: `opencode:${executionHash({ behaviorFingerprint, sourceRoot: delivery.root }).slice(0, 32)}` }
  selectedDeliveries.set(selection, delivery)
  return selection
}

/** Availability precedes any owner/session. This path reads identity and the installed
 * graph only; it never acquires a host or runs a model preflight. */
export async function inspectOpenCodeV2SourceAvailability(envelope: BridgeEnvelope) {
  const selection = await inspectOpenCodeV2LaunchSelection(envelope)
  return (await prepareSelectedOpenCodeV2SourceAvailability(selection)).availability
}

/** Reuse only this command's selection; installed bytes are still verified afresh. */
async function prepareSelectedOpenCodeV2SourceAvailability(selection: Awaited<ReturnType<typeof inspectOpenCodeV2LaunchSelection>>) {
  // Version admission precedes graph resolution, so an unqualified release is refused as such.
  assertOpenCodeV2Launchable(openCodeV2EngineVersion(selection.native))
  const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'execution', selectedDeliveries.get(selection)?.binding)
  const receipt = await createOpenCodeV2ExecutionReceipt(delivery.root, selection.native, selection.controller, delivery.binding)
  const config = selection.controller
  if (config.type === 'local') executionAssert(config.command.length > 0 &&
    config.command.every(value => typeof value === 'string' && value.length > 0 && !value.includes('\0')), 'run_controller_transport_unsupported')
  else {
    const url = new URL(config.url)
    executionAssert(config.oauth === false && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'run_controller_transport_unsupported')
  }
  executionAssert(receipt.graph.files.length > 0 && receipt.graph.sha256.length === 64 &&
    receipt.executableSha256 === selection.native.executableSha256, 'run_source_graph_unknown')
  const availability = { ...selection, installedGraphSHA256: receipt.graph.sha256, installedGraphFiles: receipt.graph.files.length }
  selectedDeliveries.set(availability, delivery)
  const selectionHash = executionHash(availability)
  Object.defineProperty(availability, preparedPlanReceipt, { configurable: true, value: () => {
    executionAssert(executionHash(availability) === selectionHash, 'run_prepared_selection_changed')
    return receipt
  } })
  return { native: receipt, availability }
}

/** Stable protocol1 fields feed an SDK-owned production provisioner. No caller receipt or endpoint authority. */
export async function createOpenCodeV2LaunchPlan(envelope: BridgeEnvelope): Promise<RunLaunchPlan> {
  const selection = await inspectOpenCodeV2LaunchSelection(envelope), body = envelope.body
  const teamId = text(body.teamId ?? body.teamName), runId = text(body.runId), laneId = text(body.laneId)
  executionAssert(body.teamName === undefined || body.teamName === teamId, 'run_controller_team_changed')
  const preconditions = parseOpenCodeBridgePreconditions(body.preconditions)
  const { native, availability } = await prepareSelectedOpenCodeV2SourceAvailability(selection)
  const verified = await resolveOpenCodeV2ExecutionProbe(envelope, availability, false, { unattendedTeam: true })
  const supplied = parseOpenCodeExecutionProof(body.executionProof)
  executionAssert(verified.proof && verified.proof.projectPath === normalizeOpenCodeProjectIdentity(selection.project) &&
    verified.proof.modelId === `${selection.model.providerID}/${selection.model.id}` &&
    verified.proof.capabilitySnapshotId === selection.capabilitySnapshotId && verified.proof.opencodeVersion === selection.native.version &&
    verified.proof.binaryPath === selection.native.executablePath && supplied && executionHash(supplied) === executionHash(verified.proof) &&
    preconditions?.commandLeaseId && requireOpenCodeExpectedBehaviorFingerprint(preconditions) === verified.proof.expectedBehaviorEvidence.expectedBehaviorFingerprint,
    'run_launch_native_execution_proof_required')
  validateOpenCodeBridgeStateChangingPreconditions({ body, runtime: { capabilitySnapshotId: selection.capabilitySnapshotId,
    runtimeStoreManifestHighWatermark: null } })
  const plan = await buildOpenCodeV2InternalRunPlanWithNative(selection, body, preconditions.commandLeaseId, native)
  executionAssert(plan.members.every(member => member.profile.config.sha256 === verified.proof!.managedConfigFingerprint), 'run_launch_config_variant_changed')
  for (const member of plan.members) executionAssert(await hashOpenCodeFile(path.join(member.profile.root, 'data/opencode/auth.json')) === verified.proof.managedAuthFingerprint, 'run_launch_selected_auth_changed')
  executionAssert((await collectProjectBehaviorMetadata(selection.project)).projectBehaviorFingerprint === verified.proof.projectBehaviorFingerprint && Date.parse(verified.proof.expiresAt) > Date.now(), 'run_launch_project_behavior_or_proof_changed')
  return { ...plan, qualification: { capabilitySnapshotId: verified.proof.capabilitySnapshotId,
    expectedBehaviorFingerprint: verified.proof.expectedBehaviorEvidence.expectedBehaviorFingerprint,
    binaryPath: verified.proof.binaryPath, binaryFingerprint: verified.proof.binaryFingerprint, version: verified.proof.opencodeVersion, engineVersion: openCodeV2EngineVersion(native) } }
}

/** Production constructor only: no caller body receipt, endpoint or mount hook. */
export async function buildOpenCodeV2InternalRunPlan(selection: Awaited<ReturnType<typeof inspectOpenCodeV2LaunchSelection>>,
  body: Record<string, unknown>, controllerInstanceId: string, probe?: { intent: import('../execution/OpenCodeV2AdmissionService.js').QueueIntent; expectedText: string; unattendedTeam?: boolean }): Promise<RunLaunchPlan> {
  const prepared = selection as PreparedPlanSelection
  const consume = prepared[preparedPlanReceipt]
  // Remove before any asynchronous preparation so this authority is consumed once.
  if (consume) delete prepared[preparedPlanReceipt]
  let native: ValidatedExecutionNative
  if (consume) native = consume()
  else {
    const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'run-owner', selectedDeliveries.get(selection)?.binding)
    selectedDeliveries.set(selection, delivery)
    native = await createOpenCodeV2ExecutionReceipt(delivery.root, selection.native, selection.controller, delivery.binding)
  }
  return buildOpenCodeV2InternalRunPlanWithNative(selection, body, controllerInstanceId, native, probe)
}

/** Reuse only the receipt constructed in this command's private preparation.
 * Caller DTOs and subsequent commands cannot supply or retain this receipt. */
async function buildOpenCodeV2InternalRunPlanWithNative(selection: Awaited<ReturnType<typeof inspectOpenCodeV2LaunchSelection>>,
  body: Record<string, unknown>, controllerInstanceId: string, native: ValidatedExecutionNative,
  probe?: { intent: import('../execution/OpenCodeV2AdmissionService.js').QueueIntent; expectedText: string; unattendedTeam?: boolean }): Promise<RunLaunchPlan> {
  const teamId = text(body.teamId ?? body.teamName), runId = text(body.runId), laneId = text(body.laneId)
  executionAssert(Array.isArray(body.members) && body.members.length > 0 && body.members.length <= 32, 'run_members_invalid')
  const rawMembers = body.members.map(executionRecord)
  executionAssert(new Set(rawMembers.map(member => text(member.name))).size === rawMembers.length, 'run_member_conflict')
  const paths = resolveClaudeMultimodelPaths()
  await mkdir(paths.data, { recursive: true, mode: 0o700 })
  const dataRoot = await realpath(paths.data)
  const profileParent = path.join(dataRoot, 'opencode', 'v2', 'profiles')
  await mkdir(profileParent, { recursive: true, mode: 0o700 })
  const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'run-owner', native.graph.delivery)
  const members: RunMemberPlan[] = []
  let probePrepared: OpenCodePreparedProfile | undefined
  for (const member of rawMembers) {
    const memberId = text(member.name), sessionID = `ses_${randomUUID().replaceAll('-', '')}`
    const variant = typeof member.effort === 'string' ? member.effort : typeof body.effort === 'string' ? body.effort : undefined
    const { profile, prepared } = await createOpenCodeV2PreparedMember(selection, native, profileParent, { teamId, runId, memberId, variant, unattendedTeam: probe ? probe.unattendedTeam === true : true })
    if (probe) probePrepared = prepared
    const prompt = typeof member.prompt === 'string' ? member.prompt : `Join OpenCode team ${teamId} as ${memberId}. Wait for app MCP task delivery.`
    const value = buildOpenCodeAppManagedBootstrapContextText({ teamName: typeof body.teamName === 'string' ? body.teamName : teamId,
      memberName: memberId, runId, laneId, runtimeSessionId: sessionID, prompt })
    const briefingHash = executionHash({ purpose: 'opencode-app-managed-bootstrap-briefing-v1', teamName: teamId, memberName: memberId, runId, laneId, prompt })
    members.push({ memberId, laneId, originalSessionId: sessionID, native, profile,
      // An untitled native root session generates its title with another model request.
      ...(probe ? { title: 'Agent Teams model verification' } : {}),
      bootstrap: { key: 'agent-teams.context', value, contextHash: await hashText(value), briefingHash },
      controllerMcpName: 'agent-teams', advertisedTools: [] })
  }
  const files: { path: string; sha256: string }[] = []
  const sourceFiles: string[] = []
  async function walk(directory: string): Promise<void> {
    for (const row of await readdir(directory, { withFileTypes: true })) {
      executionAssert(!row.isSymbolicLink(), 'run_source_symlink')
      const file = path.join(directory, row.name)
      if (row.isDirectory()) await walk(file)
      else { executionAssert(row.isFile() && sourceFiles.length < 20_000, 'run_source_budget'); sourceFiles.push(file) }
    }
  }
  if (delivery.runtimeMode === 'source') {
    await walk(path.join(delivery.root, 'src'))
    // Match the installed-graph reader's bounded concurrency. Each source file
    // still receives the same stable-handle byte and identity verification.
    for (let offset = 0; offset < sourceFiles.length; offset += 16)
      files.push(...await Promise.all(sourceFiles.slice(offset, offset + 16)
        .map(async file => ({ path: file, sha256: await hashOpenCodeFile(file) }))))
  }
  else {
    // Bun emits self-contained JS entries. Official packages are independently graph-bound.
    const baseEntry = selectedDeliveries.get(selection)?.baseEntryPath
    executionAssert(baseEntry && await realpath(baseEntry) === baseEntry, 'run_source_incomplete')
    files.push({ path: baseEntry, sha256: await hashOpenCodeFile(baseEntry) })
    for (const name of ['opencodeV2RunOwner.js', 'opencodeV2ExecutionServer.js']) {
      const file = await realpath(path.join(delivery.root, name))
      executionAssert(path.dirname(file) === delivery.root, 'run_source_symlink')
      files.push({ path: file, sha256: await hashOpenCodeFile(file) })
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const entryPath = delivery.entryPath
  const env = createOpenCodeV2SupervisorEnvironment()
  env.CLAUDE_MULTIMODEL_DATA_HOME = dataRoot
  if (selection.controller.type === 'local' && selection.controller.environment?.AGENT_TEAMS_MCP_CLAUDE_DIR)
    env.AGENT_TEAMS_MCP_CLAUDE_DIR = selection.controller.environment.AGENT_TEAMS_MCP_CLAUDE_DIR
  return { dataRoot, binding: { teamId, runId, controllerInstanceId: controllerInstanceId, ownerId: randomUUID() },
    deadline: Date.now() + (probe ? 300_000 : 24 * 60 * 60 * 1000 - 1000), members,
    ...(probe && probePrepared ? { executionProbe: { memberId: 'probe', intent: probe.intent, expectedText: probe.expectedText,
      prepared: probePrepared, capabilitySnapshotId: selection.capabilitySnapshotId } } : {}),
    source: { entryPath, entrySha256: await hashOpenCodeFile(entryPath), bunPath: native.bun.path,
      bunSha256: native.bun.sha256, files, env, ...(native.graph.delivery ? { delivery: native.graph.delivery } : {}) } }
}
async function hashText(value: string): Promise<string> { const { createHash } = await import('node:crypto'); return createHash('sha256').update(value).digest('hex') }

export async function createOpenCodeV2PreparedMember(selection: Awaited<ReturnType<typeof inspectOpenCodeV2LaunchSelection>>,
  native: ValidatedExecutionNative, profileParent: string, input: { teamId: string; runId: string; memberId: string; variant?: string; unattendedTeam?: boolean }) {
  const { teamId, runId, memberId, variant } = input
    const prefix = `${executionHash({ teamId, runId, memberId }).slice(0, 16)}-`
    const root = await realpath(await mkdtemp(path.join(profileParent, prefix)))
    const directories = ['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata'].map(name => path.join(root, name))
    const configDirectory = path.join(root, 'config', 'opencode'), nativeData = path.join(root, 'data', 'opencode')
    for (const directory of directories) await mkdir(directory, { mode: 0o700 })
    await mkdir(configDirectory, { mode: 0o700 }); await mkdir(nativeData, { mode: 0o700 })
    const managedAuthPath = path.join(nativeData, 'auth.json')
    const anonymous = selection.scope.selectedAuthIdentity === 'absent'
    const model = { ...selection.model, variant: variant ?? 'default' }
    const selected = { agent: 'build', model, permissions: OPENCODE_V2_TEAMMATE_PERMISSIONS.map(rule => ({ ...rule })) }
    let config: ReturnType<typeof createOpenCodeV2ExecutionConfig>
    let managedAuthFingerprint: string
    {
      const provider = await materializeOpenCodeSelectedScopeAuth(selection.scope, selection.project, managedAuthPath,
        selection.model.id, undefined, undefined)
      managedAuthFingerprint = await hashOpenCodeFile(managedAuthPath)
      // An empty sealed store binds the normal proof without pretending the native
      // public marker is a credential. The host's read-only catalog guard must still
      // qualify this exact free model before admitting any native session.
      if (anonymous) executionAssert(Object.keys(executionRecord(JSON.parse(await readFile(managedAuthPath, 'utf8')))).length === 0,
        'run_selected_auth_changed')
      config = createOpenCodeV2ExecutionConfig({ pin: openCodeV2EngineVersion(native), selection: selected,
        controller: { server: 'agent-teams', config: selection.controller }, provider, unattendedTeam: input.unattendedTeam })
      await writeFile(path.join(configDirectory, 'opencode.json'), config.content, { flag: 'wx', mode: 0o600 })
    }
    const env = createOpenCodeV2OwnedProfileEnvironment(root)
    if (process.platform === 'darwin' && native.taskNode)
      env.PATH = [path.dirname(native.taskNode.path), env.PATH].join(path.delimiter)
    env.OPENCODE_CONFIG_DIR = configDirectory
    if (selection.controller.type === 'local' && selection.controller.environment?.AGENT_TEAMS_MCP_CLAUDE_DIR)
      env.AGENT_TEAMS_MCP_CLAUDE_DIR = selection.controller.environment.AGENT_TEAMS_MCP_CLAUDE_DIR
    const profile: SelectedExecutionProfile = { epoch: randomUUID(), root, directory: selection.project,
      databasePath: path.join(nativeData, 'opencode.db'), ...(anonymous ? {} : { authSha256: managedAuthFingerprint }), env, envSha256: executionHash(env),
      config: { directory: configDirectory, content: config.content, sha256: config.sha256 }, selection: selected }
  const metadata = await readOpenCodeSelectedScopeMetadata(selection.scope, selection.project)
  executionAssert(metadata.selectedAuthIdentity === selection.scope.selectedAuthIdentity &&
    await hashOpenCodeFile(managedAuthPath) === managedAuthFingerprint, 'run_selected_auth_changed')
  const prepared: OpenCodePreparedProfile = {
    projectPath: selection.project, canonicalProjectPath: selection.project, workingDirectoryPath: selection.project,
    scopeToken: selection.scope.scopeToken, profileRootKey: executionHash({ project: selection.project,
      scope: selection.scope.configFingerprint, selectedAuth: selection.scope.selectedAuthIdentity, config: config.sha256 }),
    profileRootPath: root, profileScope: selection.scope,
    projectBehaviorFingerprint: metadata.projectBehaviorFingerprint, behaviorSources: metadata.behaviorSources,
    managedConfig: executionRecord(JSON.parse(config.content)), managedConfigFingerprint: config.sha256,
    homePath: env.HOME!, tmpPath: env.TMPDIR!, xdgConfigHome: env.XDG_CONFIG_HOME!,
    xdgDataHome: env.XDG_DATA_HOME!, xdgCacheHome: env.XDG_CACHE_HOME!,
    managedAuthPath, sourceAuthPath: null, sourceAuthFingerprint: metadata.selectedAuthIdentity.startsWith('known:')
      ? metadata.selectedAuthIdentity.slice(6) : null, managedAuthFingerprint,
    selectedSourceAuthIdentity: metadata.selectedAuthIdentity, selectedManagedAuthIdentity: metadata.selectedAuthIdentity,
    authoritySourceFingerprint: metadata.authoritySourceFingerprint,
    authState: metadata.selectedAuthIdentity === 'absent' ? 'missing' : 'ok', env,
  }
  return { profile, prepared }
}

/** Native-owned profiles follow the planner's fixed loader environment fence. */
export function createOpenCodeV2OwnedProfileEnvironment(root: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(privateOpenCodeReadEnvironment(root))
    .filter((pair): pair is [string, string] => pair[0] !== 'NODE_ENV' && typeof pair[1] === 'string'))
  // Selected Homebrew Node must not load ambient OpenSSL configuration outside the owned profile.
  if (process.platform === 'darwin') env.OPENSSL_CONF = '/dev/null'
  return env
}
