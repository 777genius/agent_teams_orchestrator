import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import type {
  HostedChildEnvironmentPolicy,
  NodeAnchorLaunchAuthorityCatalog,
  NodeAnchorProviderStdio,
  ResolvedEnvironmentAuthorityRef,
  ResolvedExecutableAuthorityRef,
  ResolvedRuntimeBinaryPolicy,
  ResolvedWorkdirAuthorityRef,
  RuntimeBinaryId,
  SupervisedProcessRef,
  WorkspaceExecutionGrant,
  WorkspaceExecutionGrantId,
} from '@agent-teams/owner-anchor-library'
import { computeHostedNativeEnvelopeDigest, type HostedNativeLaunchEnvelope, type HostedNativeReadyAcknowledgement } from 'src/services/teamBootstrap/hostedNativeLaunch.js'
import { buildResolvedNativeProcessEnv, buildResolvedNativeProcessFlags } from 'src/utils/swarm/spawnUtils.js'
import * as canonicalTeamHelpers from 'src/utils/swarm/teamHelpers.js'
import { computeNativeLaunchCatalogDigest, computeNativeProductPlanRefDigest, createNativeProcessAcquisition,
  NativeProcessAcquisitionFailure, prepareNativeProcessAcquisition, type NativeAcquisitionRecorder,
  type NativeAttemptEffectAuthorization } from './NativeProcessAcquisition.js'
import { resolveNativeProcessLaunchMaterial } from './NativeProcessLaunchMaterial.js'

const roots: string[] = []
afterEach(async () => {
  failNextCanonicalMutation = false
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const tagged = (bytes: Uint8Array | string): `sha256:${string}` => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const plain = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
// Independent copy of the accepted pre-bigint preimage rules, used only to
// prove that preparation still emits legacy recipe bytes for JSON-domain data.
const legacyStable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(legacyStable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${legacyStable(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
const legacyDigest = (value: unknown): `sha256:${string}` => tagged(legacyStable(value))
const cancellation = { cancellationId: 'cancel:fixture-000000000000', isCancellationRequested: () => false }
const ANCHOR_CAPABILITY_HASH = 'sha256:8ef0fab620172bdb761af87fc471cb3a1abb46710f148037762cee5d403720b5' as const

type ProductControl = { starts: unknown[]; stops: unknown[]; observations: unknown[]; startResult: unknown; stopResult: unknown;
  observeResult: unknown; provideStdio: boolean; onStart?: () => void | Promise<void>; onObserve?: () => void | Promise<void> }

function recorder(fail?: 'acquired' | 'ready' | 'drained' | 'uncertain' | 'drained-and-uncertain') {
  const phases: string[] = []
  const uncertainAttempts: Parameters<NativeAcquisitionRecorder['recordUncertain']>[0]['attempt'][] = []
  const value: NativeAcquisitionRecorder = {
    async armAttempt() { phases.push('arm') },
    async recordAcquired() { phases.push('acquired'); if (fail === 'acquired') throw new Error('acquired recorder failed') },
    async recordReady() { phases.push('ready'); if (fail === 'ready') throw new Error('ready recorder failed') },
    async recordUncertain(input) {
      phases.push(`uncertain:${input.phase}`)
      if (fail === 'drained-and-uncertain') throw new Error('uncertain recorder failed')
      uncertainAttempts.push(input.attempt)
      if (fail === 'uncertain') throw new Error('uncertain recorder failed')
    },
    async recordDrained() { phases.push('drained'); if (fail === 'drained' || fail === 'drained-and-uncertain') throw new Error('drained recorder failed') },
    async recordNoEffect() { phases.push('no-effect') },
  }
  return { phases, uncertainAttempts, value }
}

async function captureFailure(operation: Promise<unknown>): Promise<NativeProcessAcquisitionFailure> {
  return operation.then(
    () => { throw new Error('fixture expected acquisition failure') },
    error => {
      expect(error).toBeInstanceOf(NativeProcessAcquisitionFailure)
      return error as NativeProcessAcquisitionFailure
    },
  )
}

const observeSettlement = <T>(operation: Promise<T>) => operation.then(
  value => ({ status: 'fulfilled' as const, value }),
  error => ({ status: 'rejected' as const, error }),
)

async function fixture(options: { worker?: boolean; launchTimeoutMs?: number } = {}) {
  const data = await mkdtemp(join(tmpdir(), 'native-acquisition-')); roots.push(data); await chmod(data, 0o700)
  const legacyKey = 'exact-team'; const team = join(data, 'teams', legacyKey); const tasks = join(data, 'tasks', legacyKey); const cwd = join(data, 'cwd')
  await Promise.all([team, tasks, cwd].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const settingsPath = join(data, 'settings.json'); const mcpPath = join(data, 'mcp.json')
  await writeFile(settingsPath, '{}', { mode: 0o600 }); await writeFile(mcpPath, '{}', { mode: 0o600 })
  // Admission rereads executable bytes during every preflight. Keep this unit
  // fixture tiny and deterministic; Product never executes this file.
  const executablePath = join(data, 'fixture-cli'); const executableBytes = '#!/bin/sh\nexit 127\n'
  await writeFile(executablePath, executableBytes, { mode: 0o700 })
  const planRef = { teamId: 'team_00000000000000000000000000000000', runId: 'run_00000000000000000000000000000000', generation: 7,
    planHash: `sha256:${'a'.repeat(64)}` }
  const material = await resolveNativeProcessLaunchMaterial({
    publicTeamId: 'public-team', legacyKey, canonicalDataRoot: data, canonicalTeamRoot: team, canonicalTasksRoot: tasks, canonicalCwd: cwd,
    runId: 'run-1', attemptSetId: 'attempt-set-1', ownerBootId: 'boot-1', ownerControllerInstanceId: 'controller-1-long',
    ownerPlanGeneration: `owner-generation:${'c'.repeat(32)}`, productPlanGeneration: 7,
    productPlanRef: computeNativeProductPlanRefDigest(planRef), workdirRef: 'workdir:admitted', primaryOrdinal: 0,
    members: [{ ordinal: 0, laneId: 'lane-a', displayName: 'alpha', agentId: 'member-alpha', provider: 'anthropic', model: 'claude', prompt: 'lead' },
      ...(options.worker ? [{ ordinal: 1, laneId: 'lane-b', displayName: 'beta', agentId: 'member-beta', provider: 'codex' as const,
        model: 'gpt-worker', effort: 'medium', prompt: 'ordinary worker briefing', agentType: 'implementer' }] : [])],
    cli: { executable: { canonicalPath: executablePath, sha256: tagged(executableBytes), executableRef: 'executable:cli', binaryId: 'binary:cli',
      binaryRevision: 3, binaryHash: tagged(executableBytes) }, argv: [], argvKind: 'executable-only' },
    settings: { canonicalPath: settingsPath, sha256: tagged('{}') }, mcpConfig: { canonicalPath: mcpPath, sha256: tagged('{}') },
    permissionMode: 'bypassPermissions', disallowedTools: ['TeamCreate'], strictMcpConfig: true,
    profiles: [{ provider: 'anthropic', selectedBackendId: 'selected', resolvedBackendId: 'resolved', resolvedLaunchModel: 'claude',
      endpointIdentity: 'endpoint:anthropic', configurationIdentity: 'configuration:alpha', authHandleRevision: 'auth:1',
      accessAdmissionId: 'access:alpha', environmentRef: 'environment:alpha', frozenEnv: { PATH: '/admitted/bin' } },
      ...(options.worker ? [{ provider: 'codex' as const, selectedBackendId: 'selected-worker', resolvedBackendId: 'resolved-worker',
        resolvedLaunchModel: 'gpt-worker', endpointIdentity: 'endpoint:codex', configurationIdentity: 'configuration:beta',
        authHandleRevision: 'auth:2', accessAdmissionId: 'access:beta', environmentRef: 'environment:beta', frozenEnv: { PATH: '/worker/bin' } }] : [])],
    anchorCapability: { admissionId: 'admission:owner-anchor', version: 1,
      hash: ANCHOR_CAPABILITY_HASH },
  })
  const attemptToken = 'attempt:lead:0000000001'; const attemptDir = join(data, 'attempts', attemptToken)
  await mkdir(attemptDir, { recursive: true, mode: 0o700 })
  const envelopePath = join(attemptDir, 'launch.json'); const readyAckPath = join(attemptDir, 'ready.json')
  const bootstrapSpecPath = join(attemptDir, 'bootstrap.json'); const userPromptFilePath = join(attemptDir, 'prompt.txt')
  await writeFile(bootstrapSpecPath, '{"members":[]}', { mode: 0o600 }); await writeFile(userPromptFilePath, 'lead', { mode: 0o600 })
  const authority = { version: 1 as const, registrationId: 'registration-1', storageGeneration: 'storage-1', admittedWriterImage: 'writer-1',
    registryRoot: data, anchorName: 'anchor', bindingRecordName: 'binding' }
  const unsigned = { version: 1 as const, role: 'native-lead' as const, publicTeamId: material.publicTeamId, legacyKey, canonicalDataRoot: data,
    canonicalTeamRoot: team, canonicalTasksRoot: tasks, canonicalCwd: cwd, dataRootIdentity: 'data-id', teamRootIdentity: 'team-id', tasksRootIdentity: 'tasks-id',
    runId: material.runId, primary: { displayName: 'alpha', agentId: 'member-alpha', provider: 'anthropic' as const, model: 'claude' },
    primaryAlias: 'team-lead' as const, launchIdentityToken: attemptToken, materialDigest: material.materialDigest,
    profileDigest: material.members[0]!.profileDigest, settingsDigest: plain('{}'), mcpDigest: plain('{}'), settingsPath, mcpConfigPath: mcpPath,
    bootstrapSpecPath, bootstrapSpecDigest: plain('{"members":[]}'), userPromptFilePath, userPromptDigest: plain('lead'),
    permissionMode: 'bypassPermissions' as const, readyAckPath, canonicalAuthority: authority }
  const envelope: HostedNativeLaunchEnvelope = { ...unsigned, envelopeDigest: computeHostedNativeEnvelopeDigest(unsigned) }
  await writeFile(envelopePath, JSON.stringify(envelope), { mode: 0o600 })
  const flags = buildResolvedNativeProcessFlags({ model: 'claude', settingsPath, mcpConfigPath: mcpPath, disallowedTools: ['TeamCreate'], strictMcpConfig: true })
  const argv = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--team-bootstrap-spec', bootstrapSpecPath,
    '--team-bootstrap-user-prompt-file', userPromptFilePath, '--hosted-native-launch', envelopePath, '--hosted-native-launch-identity', attemptToken,
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', ...flags]
  const env = buildResolvedNativeProcessEnv({ provider: 'anthropic', canonicalDataRoot: data, frozenEnv: { PATH: '/admitted/bin' } })
  const binaryPolicy: ResolvedRuntimeBinaryPolicy = { policy: 'registered_exact_binary', binaryId: 'binary:cli' as RuntimeBinaryId,
    binaryRevision: 3, binaryHash: tagged(executableBytes) }
  const environmentPolicy: HostedChildEnvironmentPolicy = { policy: 'explicit_allowlist',
    variables: Object.keys(env).sort().map(name => ({ name, provenance: name === 'PATH' ? 'provider_static' : 'runtime_metadata' })) }
  const resourcePolicy = { maxRuntimeMs: 60_000, gracefulStopMs: 1_000, maxOutputBytes: 4_096, maxProcessCount: 16 }
  const workdirGrant: WorkspaceExecutionGrant = { grantId: 'grant:0000000000000000' as WorkspaceExecutionGrantId,
    workspaceId: 'workspace_00000000000000000000000000000000' as WorkspaceExecutionGrant['workspaceId'],
    registrationRevision: 1, bindingGeneration: 2, mountGeneration: 3, permission: 'execute_process' as const }
  const executionUnit = { executionUnitId: 'unit:lead', backendBinding: { backend: 'provisioning_cli' as const, bindingId: 'binding:native', bindingRevision: 2 },
    laneId: 'lane-a', memberIds: ['member-alpha'], binaryPolicy, environmentPolicy, credentialExposureSet: { secretRefs: [] },
    credentialIsolation: 'dedicated_execution_unit' as const, resourcePolicy }
  const binding = { ownerPlanGeneration: material.ownerPlanGeneration, ownerUnitBindingId: 'owner-unit:lead', orderedMembers: [{ ordinal: 0, memberId: 'member-alpha' }],
    executionUnit, launchSpec: { planRef, executionUnitId: 'unit:lead', backend: 'provisioning_cli' as const,
      argvAuthority: { executableRef: 'executable:cli', binaryPolicy, argv, argvHash: tagged(JSON.stringify(argv)) },
      workdirAuthority: { workdirRef: 'workdir:admitted', grant: workdirGrant },
      environmentAuthority: { environmentRef: 'environment:alpha', policy: environmentPolicy }, resourcePolicy } }
  const workerToken = 'attempt:worker:00000001'; const workerDir = join(team, workerToken)
  const runtimeEventsPath = join(workerDir, 'runtime.jsonl'); const bootstrapProofToken = 'proof:worker:0000000001'
  if (options.worker) await mkdir(workerDir, { recursive: true, mode: 0o700 })
  const workerFlags = buildResolvedNativeProcessFlags({ model: 'gpt-worker', effort: 'medium', settingsPath, mcpConfigPath: mcpPath,
    disallowedTools: ['TeamCreate'], strictMcpConfig: true })
  const workerArgv = ['--teammate-runtime', 'headless', '--agent-id', 'member-beta', '--agent-name', 'beta', '--team-name', legacyKey,
    '--parent-session-id', material.runId, '--process-owner-token', workerToken, '--agent-type', 'implementer',
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', ...workerFlags]
  const workerEnv = buildResolvedNativeProcessEnv({ provider: 'codex', canonicalDataRoot: data, frozenEnv: { PATH: '/worker/bin' },
    runtimeEnv: { CLAUDE_CODE_TEAMMATE_RUNTIME: 'headless', CLAUDE_CODE_TEAMMATE_RUNTIME_EVENTS_PATH: runtimeEventsPath,
      CLAUDE_CODE_BOOTSTRAP_PROOF_TOKEN: bootstrapProofToken, CLAUDE_CODE_BOOTSTRAP_RUN_ID: material.runId } })
  const workerEnvironmentPolicy: HostedChildEnvironmentPolicy = { policy: 'explicit_allowlist',
    variables: Object.keys(workerEnv).sort().map(name => ({ name, provenance: name === 'PATH' ? 'provider_static' : 'runtime_metadata' })) }
  const workerExecutionUnit = { executionUnitId: 'unit:worker', backendBinding: { backend: 'provisioning_cli' as const,
    bindingId: 'binding:native-worker', bindingRevision: 2 }, laneId: 'lane-b', memberIds: ['member-beta'], binaryPolicy,
    environmentPolicy: workerEnvironmentPolicy, credentialExposureSet: { secretRefs: [] }, credentialIsolation: 'dedicated_execution_unit' as const,
    resourcePolicy }
  const workerBinding = { ownerPlanGeneration: material.ownerPlanGeneration, ownerUnitBindingId: 'owner-unit:worker',
    orderedMembers: [{ ordinal: 1, memberId: 'member-beta' }], executionUnit: workerExecutionUnit,
    launchSpec: { planRef, executionUnitId: 'unit:worker', backend: 'provisioning_cli' as const,
      argvAuthority: { executableRef: 'executable:cli', binaryPolicy, argv: workerArgv, argvHash: tagged(JSON.stringify(workerArgv)) },
      workdirAuthority: { workdirRef: 'workdir:admitted', grant: workdirGrant },
      environmentAuthority: { environmentRef: 'environment:beta', policy: workerEnvironmentPolicy }, resourcePolicy } }
  const catalog: NodeAnchorLaunchAuthorityCatalog = { executables: [{ executableRef: 'executable:cli' as ResolvedExecutableAuthorityRef,
    executablePath, binaryPolicy }], workdirs: [{ workdirRef: 'workdir:admitted' as ResolvedWorkdirAuthorityRef,
      workdirPath: cwd, grant: workdirGrant, registeredRootEvidence: { device: 0n, inode: 9_007_199_254_740_993n, mountId: 1n } }],
    environments: [{ environmentRef: 'environment:alpha' as ResolvedEnvironmentAuthorityRef, policy: environmentPolicy, values: env },
      ...(options.worker ? [{ environmentRef: 'environment:beta' as ResolvedEnvironmentAuthorityRef,
        policy: workerEnvironmentPolicy, values: workerEnv }] : [])] }
  const processRef = 'process:fixture:0000000001' as SupervisedProcessRef
  const stdio: NodeAnchorProviderStdio & { processRef: SupervisedProcessRef } = { processRef, capabilityVersion: 1,
    capabilityHash: ANCHOR_CAPABILITY_HASH, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), maxOutputBytes: 4096,
    close() {} }
  const stdioByRef = new Map<SupervisedProcessRef, NodeAnchorProviderStdio & { processRef: SupervisedProcessRef }>([[processRef, stdio]])
  const stdioFor = (ref: SupervisedProcessRef) => {
    const current = stdioByRef.get(ref)
    if (current) return current
    const created: NodeAnchorProviderStdio & { processRef: SupervisedProcessRef } = { processRef: ref, capabilityVersion: 1,
      capabilityHash: ANCHOR_CAPABILITY_HASH, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), maxOutputBytes: 4096,
      close() {} }
    stdioByRef.set(ref, created)
    return created
  }
  const stdinBytes: Buffer[] = []
  const capturedStdin = stdio.stdin as PassThrough
  capturedStdin.on('data', bytes => stdinBytes.push(Buffer.from(bytes)))
  const control: ProductControl = { starts: [], stops: [], observations: [], startResult: { status: 'started', processRef },
    stopResult: { status: 'drained' }, observeResult: { status: 'ready' }, provideStdio: true }
  class Materializer { constructor(readonly catalog: unknown) {} }
  class Spawner {
    constructor(readonly options: unknown) {}
    providerStdioFor(ref: SupervisedProcessRef) { return control.provideStdio ? stdioFor(ref) : undefined }
    closeProviderStdio() {}
  }
  class Supervisor {
    constructor(readonly options: unknown) {}
    async start(request: unknown) { control.starts.push(request); await control.onStart?.(); return control.startResult }
    async stop(request: unknown) { control.stops.push(request); const result = await control.stopResult; if ((result as { status?: string }).status === 'drained') {
      const stoppedStdio = stdioFor((request as { processRef: SupervisedProcessRef }).processRef)
      ;(stoppedStdio.stdout as PassThrough).end(); (stoppedStdio.stderr as PassThrough).end()
    } return result }
    async observe(request: unknown) { control.observations.push(request); await control.onObserve?.(); return control.observeResult }
  }
  const library = { NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_VERSION: 1, NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH: ANCHOR_CAPABILITY_HASH,
    NodeAnchorLaunchMaterializer: Materializer, NodeAnchorSpawner: Spawner, AnchorProcessSupervisorAdapter: Supervisor,
    computeCanonicalArgvDigest: (value: readonly string[]) => tagged(JSON.stringify(value)), parseProcessOwnerBinding: (value: unknown) => value,
    parseProcessControllerInstanceId: (value: unknown) => value, parseOwnedProcessRef: (value: unknown) => value, parseSpawnNonce: (value: unknown) => value }
  const admittedLibrary = { library, anchorExecutablePath: '/fixture/owner-anchor', admission: { admissionId: material.anchorCapability.admissionId } } as never
  const nativeAttempt = { memberOrdinal: 0, role: 'native-lead' as const, attemptToken, binding: binding as never,
    lead: { envelopePath, readyAckPath, envelope, protectedRegistration: { registration: authority,
      launch: (({ canonicalAuthority: _authority, ...launch }) => launch)(envelope) } as never } }
  const workerAttempt = { memberOrdinal: 1, role: 'native-worker' as const, attemptToken: workerToken, binding: workerBinding as never,
    runtimeEventsPath, bootstrapProofToken, bootstrapRunId: material.runId }
  const prepared = await prepareNativeProcessAcquisition({ material, admittedLibrary, launchCatalog: catalog,
    nativeAttempts: [nativeAttempt, ...(options.worker ? [workerAttempt] : [])], openCodeMembers: [] })
  const acquisition = (lifetimeCatalog: NodeAnchorLaunchAuthorityCatalog = catalog) => createNativeProcessAcquisition({
    admittedLibrary, store: {} as never, ownerBinding: {} as never,
    controllerInstanceId: material.ownerControllerInstanceId as never, launchCatalog: lifetimeCatalog,
    launchCatalogDigest: computeNativeLaunchCatalogDigest(lifetimeCatalog), neutralWorkingDirectory: cwd,
    launchTimeoutMs: options.launchTimeoutMs ?? 40, stopTimeoutMs: 100, recoveryTimeoutMs: 100, readinessPollMs: 2, prepared })
  const authorization = (overrides: Partial<NativeAttemptEffectAuthorization> = {}): NativeAttemptEffectAuthorization => ({ authorizationId: 'authorization-1',
    ownerBootId: material.ownerBootId, ownerControllerInstanceId: material.ownerControllerInstanceId,
    attemptToken: options.worker ? workerToken : attemptToken, deadlineMs: Date.now() + 5_000,
    assertCurrent() {}, ...overrides })
  const acknowledgement = (overrides: Partial<HostedNativeReadyAcknowledgement> = {}): HostedNativeReadyAcknowledgement => ({ version: 1, state: 'ready',
    role: 'native-lead', publicTeamId: material.publicTeamId, legacyKey, runId: material.runId, primaryAgentId: 'member-alpha', primaryDisplayName: 'alpha',
    primaryAlias: 'team-lead', sessionId: 'session-real', pid: 4242, processStartedAtMs: 1234, processOsIdentity: 'os:actual-child', launchIdentityToken: attemptToken,
    envelopeDigest: envelope.envelopeDigest, materialDigest: material.materialDigest, profileDigest: material.members[0]!.profileDigest,
    settingsDigest: envelope.settingsDigest, mcpDigest: envelope.mcpDigest, permissionMode: 'bypassPermissions', canonicalDataRoot: data, canonicalTeamRoot: team,
    canonicalTasksRoot: tasks, canonicalCwd: cwd, mailboxCustody: 'hosted-lead-pump', acknowledgedAt: new Date().toISOString(), ...overrides })
  return { acquisition, authorization, acknowledgement, readyAckPath, prepared, catalog, admittedLibrary, nativeAttempt, workerAttempt, material, control,
    processRef, executablePath, stdinBytes, team, runtimeEventsPath, bootstrapProofToken }
}

let canonicalMutationFixtureInstalled = false
let failNextCanonicalMutation = false
function installCanonicalMutationFixture(): void {
  if (canonicalMutationFixtureInstalled) return
  canonicalMutationFixtureInstalled = true
  // Retained-authority descriptor admission is already covered by the accepted
  // hostedCanonicalAuthorityStartup/canonical-lock tests. This unit-only seam
  // leaves the real member mutation helper intact while supplying the admitted
  // serialized config operation that those fixtures own outside this file.
  mock.module('src/utils/swarm/teamHelpers.js', () => ({
    ...canonicalTeamHelpers,
    updateTeamFileAtCanonicalRoot: async (canonicalTeamRoot: string, legacyKey: string,
      mutator: (teamFile: canonicalTeamHelpers.TeamFile) => unknown | Promise<unknown>) => {
      if (failNextCanonicalMutation) { failNextCanonicalMutation = false; throw new Error('fixture canonical mutation failed') }
      const configPath = join(canonicalTeamRoot, 'config.json')
      let current: canonicalTeamHelpers.TeamFile
      try { current = JSON.parse(await readFile(configPath, 'utf8')) as canonicalTeamHelpers.TeamFile } catch { return { status: 'missing', teamFile: null } }
      if (current.name !== legacyKey) throw new Error('fixture canonical team identity mismatch')
      const callback = await mutator(current) as { changed: boolean; teamFile: canonicalTeamHelpers.TeamFile | { changed: boolean; teamFile: canonicalTeamHelpers.TeamFile } }
      const next = callback.changed && 'changed' in callback.teamFile ? callback.teamFile : callback
      if (!next.changed) return { status: 'unchanged', teamFile: current }
      await writeFile(configPath, JSON.stringify(next.teamFile), { mode: 0o600 })
      return { status: 'updated', teamFile: next.teamFile }
    },
  }))
}

async function writeWorkerEvents(value: Awaited<ReturnType<typeof fixture>>, overrides: {
  runtimeRunId?: string; inboxRunId?: string; bootstrapRunId?: string; proofToken?: string; mirrorId?: string
} = {}): Promise<void> {
  const timestamp = new Date().toISOString(); const pid = 5151
  const base = { version: 1, timestamp, pid, teamName: value.material.legacyKey, agentName: 'beta', agentId: 'member-beta',
    bootstrapRunId: overrides.bootstrapRunId ?? value.material.runId }
  await writeFile(value.runtimeEventsPath, [
    { ...base, type: 'runtime_ready', runId: overrides.runtimeRunId ?? 'worker-session' },
    { ...base, type: 'inbox_poller_ready', runId: overrides.inboxRunId ?? overrides.runtimeRunId ?? 'worker-session' },
  ].map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 })
  let submitted = false
  value.control.onObserve = async () => {
    if (submitted) return
    let rows: Array<{ messageId?: string }> = []
    try { rows = JSON.parse(await readFile(join(value.team, 'inboxes', 'beta.json'), 'utf8')) as Array<{ messageId?: string }> } catch { return }
    const messageId = rows[0]?.messageId
    if (!messageId) return
    submitted = true
    const event = { ...base, type: 'bootstrap_submitted', timestamp: new Date().toISOString(),
      runId: overrides.inboxRunId ?? overrides.runtimeRunId ?? 'worker-session',
      bootstrapMirrorId: overrides.mirrorId ?? messageId, bootstrapProofToken: overrides.proofToken ?? value.bootstrapProofToken }
    const prior = await readFile(value.runtimeEventsPath, 'utf8')
    await writeFile(value.runtimeEventsPath, `${prior}${JSON.stringify(event)}\n`, { mode: 0o600 })
  }
}

async function seedReadyPrimary(value: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const lead = value.prepared.recipes.find(recipe => recipe.expected.role === 'native-lead')!.lead!
  const primary = value.material.members[0]!
  await writeFile(join(value.team, 'config.json'), JSON.stringify({ name: value.material.legacyKey, createdAt: 1,
    leadAgentId: primary.agentId, leadSessionId: 'lead-session', members: [{ agentId: primary.agentId, name: primary.displayName,
      joinedAt: 1, tmuxPaneId: 'hosted-anchor:lead', cwd: value.material.roots.cwd.canonicalPath, subscriptions: [], sessionId: 'lead-session' }],
    hostedNative: { version: 1, publicTeamId: value.material.publicTeamId, legacyKey: value.material.legacyKey,
      primaryDisplayName: primary.displayName, primaryAgentId: primary.agentId, primaryAlias: 'team-lead',
      launchIdentityToken: lead.envelope.launchIdentityToken, envelopeDigest: lead.envelope.envelopeDigest,
      materialDigest: value.material.materialDigest, profileDigest: primary.profileDigest, permissionMode: 'bypassPermissions',
      canonicalDataRoot: value.material.roots.data.canonicalPath, canonicalTeamRoot: value.material.roots.team.canonicalPath,
      canonicalTasksRoot: value.material.roots.tasks.canonicalPath, runId: value.material.runId, role: 'native-lead',
      readyAckPath: lead.readyAckPath, mailboxCustody: 'hosted-lead-pump' } }), { mode: 0o600 })
}

describe('native acquisition public lifecycle fixtures', () => {
  test('keeps pinned legacy public vectors while separating exact bigint primitive domains', () => {
    expect(computeNativeProductPlanRefDigest(null))
      .toBe('sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b')
    expect(computeNativeProductPlanRefDigest({ nested: { x: true }, b: 'two', a: 1 }))
      .toBe('sha256:c17e35c189b5d1c56a335acb6c4dd7590d5ddc05bc8d5f4d326c2160639a66f0')

    const scalarEncodings = [1n, 1, '1', 'bigint:1', { $bigint: '1' },
      { kind: 'bigint', value: '1' }, [1n], ['bigint:1']]
      .map(value => computeNativeProductPlanRefDigest(value))
    expect(new Set(scalarEncodings).size).toBe(scalarEncodings.length)

    const escaped = 'quoted:" slash:\\ delimiters:[]{},:'
    const nestedEncodings = [
      { outer: [{ evidence: 1n, escaped }] },
      { outer: [{ evidence: 1, escaped }] },
      { outer: [{ evidence: '1', escaped }] },
      { outer: [{ evidence: 'bigint:1', escaped }] },
      { outer: [{ evidence: { $bigint: '1' }, escaped }] },
      { outer: [{ evidence: { kind: 'bigint', value: '1' }, escaped }] },
    ].map(value => computeNativeProductPlanRefDigest(value))
    expect(new Set(nestedEncodings).size).toBe(nestedEncodings.length)
    expect(computeNativeProductPlanRefDigest({ z: [1n, escaped], a: { b: true } }))
      .toBe(computeNativeProductPlanRefDigest({ a: { b: true }, z: [1n, escaped] }))
    expect(computeNativeProductPlanRefDigest([1n, escaped]))
      .not.toBe(computeNativeProductPlanRefDigest([escaped, 1n]))
    expect(computeNativeProductPlanRefDigest({ repeated: 9_007_199_254_740_993n }))
      .toBe(computeNativeProductPlanRefDigest({ repeated: 9_007_199_254_740_993n }))
  })

  test('prepares Product-typed lead and worker catalogs without changing legacy recipe bytes', async () => {
    const value = await fixture({ worker: true })
    expect(value.prepared.catalogDigest).toBe(computeNativeLaunchCatalogDigest(value.catalog))
    expect(value.prepared.recipes.map(recipe => recipe.expected.role)).toEqual(['native-lead', 'native-worker'])
    expect(value.prepared.launchCatalog.workdirs[0]?.registeredRootEvidence)
      .toEqual({ device: 0n, inode: 9_007_199_254_740_993n, mountId: 1n })
    expect(value.acquisition()).toBeDefined()
    const { materialDigest, ...materialBase } = value.material
    expect(materialDigest).toBe(plain(legacyStable(materialBase)))
    for (const recipe of value.prepared.recipes) {
      const { recipeDigest, ...logical } = recipe.expected
      const expectedDigest = legacyDigest({ logical, command: recipe.command, argv: recipe.argv, cwd: recipe.cwd,
        env: recipe.env, lead: recipe.lead, runtimeEventsPath: recipe.runtimeEventsPath,
        bootstrapProofToken: recipe.bootstrapProofToken, bootstrapRunId: recipe.bootstrapRunId })
      expect(recipeDigest).toBe(expectedDigest.slice('sha256:'.length))
      expect(recipe.expected.materialDigest).toBe(value.material.materialDigest)
    }
    expect(value.control.starts).toHaveLength(0)
  })

  test('hashes adjacent large inode evidence exactly and rejects every lifetime evidence substitution', async () => {
    const value = await fixture()
    const evidence = value.catalog.workdirs[0]!.registeredRootEvidence
    const withEvidence = (registeredRootEvidence: typeof evidence): NodeAnchorLaunchAuthorityCatalog => ({
      ...value.catalog,
      workdirs: [{ ...value.catalog.workdirs[0]!, registeredRootEvidence }],
    })
    const adjacentLow = withEvidence({ ...evidence, inode: 9_007_199_254_740_992n })
    const adjacentHigh = withEvidence({ ...evidence, inode: 9_007_199_254_740_993n })
    expect(computeNativeLaunchCatalogDigest(adjacentLow)).not.toBe(computeNativeLaunchCatalogDigest(adjacentHigh))

    for (const substituted of [
      withEvidence({ ...evidence, device: evidence.device + 1n }),
      withEvidence({ ...evidence, inode: evidence.inode + 1n }),
      withEvidence({ ...evidence, mountId: evidence.mountId + 1n }),
    ]) {
      expect(computeNativeLaunchCatalogDigest(substituted)).not.toBe(value.prepared.catalogDigest)
      expect(() => value.acquisition(substituted)).toThrow('frozen catalog')
    }

    const mutableInputEvidence = evidence as { device: bigint; inode: bigint; mountId: bigint }
    mutableInputEvidence.inode += 2n
    expect(value.prepared.launchCatalog.workdirs[0]?.registeredRootEvidence.inode).toBe(9_007_199_254_740_993n)
    expect(() => value.acquisition()).toThrow('frozen catalog')
    expect(value.control.starts).toHaveLength(0)
  })

  test('prepares the concrete recipe and rejects catalog mismatch before Product start', async () => {
    const value = await fixture()
    expect(value.prepared.recipes[0]).toMatchObject({ command: value.executablePath, expected: { role: 'native-lead', memberOrdinal: 0 } })
    const mismatchedCatalog = { ...value.catalog, environments: value.catalog.environments.map(environment => ({ ...environment,
      values: { ...environment.values, PATH: '/substituted/bin' } })) }
    await expect(prepareNativeProcessAcquisition({ material: value.material, admittedLibrary: value.admittedLibrary,
      launchCatalog: mismatchedCatalog, nativeAttempts: [value.nativeAttempt], openCodeMembers: [] }))
      .rejects.toThrow('does not exactly join')
    const { lead: _issuedAssociation, ...withoutIssuedAssociation } = value.nativeAttempt
    await expect(prepareNativeProcessAcquisition({ material: value.material, admittedLibrary: value.admittedLibrary,
      launchCatalog: value.catalog, nativeAttempts: [withoutIssuedAssociation], openCodeMembers: [] }))
      .rejects.toThrow('exact finalized issued envelope')
    expect(() => createNativeProcessAcquisition({ admittedLibrary: value.admittedLibrary, store: {} as never, ownerBinding: {} as never,
      controllerInstanceId: 'controller-1-long' as never, launchCatalog: value.catalog, launchCatalogDigest: 'substituted', neutralWorkingDirectory: '/',
      launchTimeoutMs: 10, stopTimeoutMs: 10, recoveryTimeoutMs: 10, readinessPollMs: 1, prepared: value.prepared })).toThrow('frozen catalog')
    expect(value.control.starts).toHaveLength(0)
  })

  test('fixes worker bypass permission argv independently of empty admitted settings', async () => {
    const value = await fixture({ worker: true })
    const argv = value.prepared.recipes.find(recipe => recipe.expected.role === 'native-worker')!.expected.binding.launchSpec.argvAuthority.argv
    const skip = argv.indexOf('--dangerously-skip-permissions')
    const mode = argv.indexOf('--permission-mode')
    expect(skip).toBeGreaterThan(-1)
    expect(mode).toBe(skip + 1)
    expect(argv[mode + 1]).toBe('bypassPermissions')
    expect(JSON.parse(await readFile(value.material.settings.canonicalPath, 'utf8'))).toEqual({})
    expect(value.control.starts).toHaveLength(0)
  })

  test('rejects foreign effect authorization and records a proven no-effect without starting', async () => {
    const value = await fixture(); const log = recorder()
    await expect(value.acquisition().launchOwnedNativeLead({ memberOrdinal: 0, recorder: log.value, cancellation: cancellation as never,
      effectAuthorization: value.authorization({ attemptToken: 'attempt:foreign:0000001' }) })).rejects.toThrow('authorization')
    expect(value.control.starts).toHaveLength(0); expect(log.phases).toEqual(['no-effect'])
  })

  test('retains unknown starts with and without an anchor ref for reconciliation', async () => {
    const noRef = await fixture(); noRef.control.startResult = { status: 'rejected', reason: 'unavailable' }; const first = recorder(); const firstAcquisition = noRef.acquisition()
    const noRefError = await captureFailure(firstAcquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: first.value, cancellation: cancellation as never,
      effectAuthorization: noRef.authorization() }))
    expect(noRefError.attempt.kind).toBe('uncertain-start-without-ref')
    expect(first.phases).toEqual(['arm', 'uncertain:start'])
    expect(await firstAcquisition.reconcileFailedAttempt({ attempt: noRefError.attempt, mode: 'immediate', cancellation: cancellation as never, recorder: first.value }))
      .toEqual({ status: 'unresolved_without_anchor_ref' })

    const known = await fixture(); known.control.provideStdio = false; const second = recorder(); const acquisition = known.acquisition()
    const knownError = await captureFailure(acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: second.value, cancellation: cancellation as never,
      effectAuthorization: known.authorization() }))
    expect(knownError.attempt.kind).toBe('known-anchor-ref'); expect(second.phases).not.toContain('no-effect')
    known.control.stopResult = { status: 'unclassified_residual' }
    expect(await acquisition.reconcileFailedAttempt({ attempt: knownError.attempt, mode: 'immediate', cancellation: cancellation as never, recorder: second.value }))
      .toMatchObject({ status: 'uncertain' })
    expect(second.phases).toContain('uncertain:stop')
  })

  test('accepts exact readiness, inspects it, and keeps repeated terminal stop idempotent', async () => {
    const value = await fixture(); const log = recorder(); value.control.onStart = async () => writeFile(value.readyAckPath,
      JSON.stringify(value.acknowledgement()), { mode: 0o600 })
    const acquisition = value.acquisition(); const identity = await acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: log.value,
      cancellation: cancellation as never, effectAuthorization: value.authorization() })
    expect(identity).toMatchObject({ kind: 'hosted-anchor', processRef: value.processRef, runtimeSessionId: 'session-real', diagnostics: { pid: 4242, osIdentity: 'os:actual-child' } })
    expect(await acquisition.inspectOwnedNativeProcess(identity)).toMatchObject({ runtimeReadiness: 'ready', ownership: { status: 'ready' } })
    const observed = value.control.observations.length
    await expect(acquisition.inspectOwnedNativeProcess({ ...identity, ownerControllerInstanceId: 'controller:foreign' }))
      .rejects.toThrow('foreign')
    expect(value.control.observations).toHaveLength(observed)
    expect(() => acquisition.adoptOwnedNativeLead(identity)).toThrow('adoption')
    await acquisition.writeOwnedNativeInput({ identity, bytes: '{"type":"user"}\n' })
    expect(Buffer.concat(value.stdinBytes).toString('utf8')).toBe('{"type":"user"}\n')
    expect(await acquisition.stopOwnedNativeProcess({ identity, mode: 'graceful', cancellation: cancellation as never, recorder: log.value })).toEqual({ status: 'drained' })
    expect(await acquisition.stopOwnedNativeProcess({ identity, mode: 'graceful', cancellation: cancellation as never, recorder: log.value })).toEqual({ status: 'drained' })
    expect(value.control.stops).toHaveLength(1); expect(log.phases).toEqual(['arm', 'acquired', 'ready', 'drained', 'drained'])
  })

  test('compensates acquired and ready recorder failures and publishes exact drain obligations', async () => {
    for (const phase of ['acquired', 'ready'] as const) {
      const value = await fixture(); const log = recorder(phase); value.control.onStart = async () => writeFile(value.readyAckPath,
        JSON.stringify(value.acknowledgement()), { mode: 0o600 })
      await expect(value.acquisition().launchOwnedNativeLead({ memberOrdinal: 0, recorder: log.value, cancellation: cancellation as never,
        effectAuthorization: value.authorization() })).rejects.toThrow(`${phase} recorder failed`)
      expect(value.control.stops).toHaveLength(1); expect(log.phases).toContain('drained')
    }
  })

  test('settles acquired and readiness compensation with overlapping public stop exactly once', async () => {
    for (const phase of ['acquired', 'ready'] as const) {
      for (const publication of ['success', 'failure'] as const) {
        const value = await fixture(); const acquisition = value.acquisition(); const launchLog = recorder(); const directLog = recorder()
        value.control.onStart = async () => writeFile(value.readyAckPath, JSON.stringify(value.acknowledgement()), { mode: 0o600 })
        let exposedIdentity!: Parameters<NativeAcquisitionRecorder['recordAcquired']>[0]
        let signalDrained!: () => void; let releaseDrained!: () => void; let rejectDrained!: (error: Error) => void
        const drainedEntered = new Promise<void>(resolve => { signalDrained = resolve })
        const drainedGate = new Promise<void>((resolve, reject) => { releaseDrained = resolve; rejectDrained = reject })
        const initiatingRecorder: NativeAcquisitionRecorder = {
          ...launchLog.value,
          async recordAcquired(identity) {
            launchLog.phases.push('acquired'); exposedIdentity = identity
            if (phase === 'acquired') throw new Error('acquired recorder failed')
          },
          async recordReady(input) {
            launchLog.phases.push('ready'); exposedIdentity = input.identity
            if (phase === 'ready') throw new Error('ready recorder failed')
          },
          async recordDrained() { launchLog.phases.push('drained'); signalDrained(); await drainedGate },
        }
        const launched = acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: initiatingRecorder,
          cancellation: cancellation as never, effectAuthorization: value.authorization() })
        await drainedEntered
        const direct = acquisition.stopOwnedNativeProcess({ identity: exposedIdentity, mode: 'immediate',
          cancellation: cancellation as never, recorder: directLog.value })
        if (publication === 'success') {
          releaseDrained()
          expect(await direct).toEqual({ status: 'drained' })
          await expect(launched).rejects.toThrow(`${phase} recorder failed`)
        } else {
          rejectDrained(new Error(`${phase} compensation publication failed`))
          const [launchFailure, directFailure] = await Promise.all([launched.catch(error => error), direct.catch(error => error)])
          expect(launchFailure).toBeInstanceOf(NativeProcessAcquisitionFailure)
          expect(directFailure).toBe(launchFailure)
          expect((launchFailure as NativeProcessAcquisitionFailure).attempt).toMatchObject({ processRef: value.processRef,
            startResult: { status: 'started', processRef: value.processRef } })
          const healthy = recorder()
          expect(await acquisition.reconcileFailedAttempt({ attempt: (launchFailure as NativeProcessAcquisitionFailure).attempt,
            mode: 'immediate', cancellation: cancellation as never, recorder: healthy.value })).toEqual({ status: 'drained' })
          expect(healthy.phases).toEqual(['drained'])
        }
        expect(value.control.stops).toHaveLength(1)
        expect(directLog.phases).toEqual([])
        expect(launchLog.phases.filter(item => item === 'drained')).toHaveLength(1)
      }
    }
  })

  test('retains direct-stop-first terminal custody when acquired publication fails', async () => {
    for (const publication of ['success', 'failure'] as const) {
      const value = await fixture(); const acquisition = value.acquisition(); const launchLog = recorder(); const directLog = recorder()
      let exposedIdentity!: Parameters<NativeAcquisitionRecorder['recordAcquired']>[0]
      let signalAcquired!: () => void; let releaseAcquired!: () => void
      const acquiredEntered = new Promise<void>(resolve => { signalAcquired = resolve })
      const acquiredGate = new Promise<void>(resolve => { releaseAcquired = resolve })
      const acquiredRecorderFailure = new Error('acquired recorder failed')
      let signalDrained!: () => void; let releaseDrained!: () => void; let rejectDrained!: (error: Error) => void
      const drainedEntered = new Promise<void>(resolve => { signalDrained = resolve })
      const drainedGate = new Promise<void>((resolve, reject) => { releaseDrained = resolve; rejectDrained = reject })
      const launchRecorder: NativeAcquisitionRecorder = {
        ...launchLog.value,
        async recordAcquired(identity) {
          launchLog.phases.push('acquired'); exposedIdentity = identity; signalAcquired(); await acquiredGate
          throw acquiredRecorderFailure
        },
      }
      const directRecorder: NativeAcquisitionRecorder = {
        ...directLog.value,
        async recordDrained() { directLog.phases.push('drained'); signalDrained(); await drainedGate },
      }
      const launched = acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: launchRecorder,
        cancellation: cancellation as never, effectAuthorization: value.authorization() })
      const launchSettlement = observeSettlement(launched)
      await acquiredEntered
      const direct = acquisition.stopOwnedNativeProcess({ identity: exposedIdentity, mode: 'immediate',
        cancellation: cancellation as never, recorder: directRecorder })
      const directSettlement = observeSettlement(direct)
      await drainedEntered
      releaseAcquired()
      // Let acquired-publication compensation join the already-owned settlement before
      // its terminal publication is released. This is the reverse of the earlier race.
      await new Promise<void>(resolve => setImmediate(resolve))
      if (publication === 'success') {
        releaseDrained()
      } else {
        rejectDrained(new Error('direct terminal publication failed'))
      }
      const [settledLaunch, settledDirect] = await Promise.all([launchSettlement, directSettlement])
      expect(settledLaunch.status).toBe('rejected')
      if (settledLaunch.status !== 'rejected') throw new Error('fixture expected acquired launch failure')
      if (publication === 'success') {
        expect(settledLaunch.error).toBe(acquiredRecorderFailure)
        expect((settledLaunch.error as Error).message).toBe('acquired recorder failed')
        expect(settledDirect).toEqual({ status: 'fulfilled', value: { status: 'drained' } })
      } else {
        expect(settledDirect.status).toBe('rejected')
        if (settledDirect.status !== 'rejected') throw new Error('fixture expected direct stop failure')
        const directFailure = settledDirect.error
        expect(directFailure).toBeInstanceOf(NativeProcessAcquisitionFailure)
        expect(settledLaunch.error).toBe(directFailure)
        expect((directFailure as NativeProcessAcquisitionFailure).message).toBe('direct terminal publication failed')
        const attempt = (directFailure as NativeProcessAcquisitionFailure).attempt
        expect(attempt).toBe(directLog.uncertainAttempts[0])
        expect(attempt).toMatchObject({ processRef: value.processRef,
          startResult: { status: 'started', processRef: value.processRef } })
        const healthy = recorder()
        expect(await acquisition.reconcileFailedAttempt({ attempt, mode: 'immediate', cancellation: cancellation as never,
          recorder: healthy.value })).toEqual({ status: 'drained' })
        expect(healthy.phases).toEqual(['drained'])
      }
      expect(value.control.stops).toHaveLength(1)
      expect(launchLog.phases).toEqual(['arm', 'acquired'])
      expect(directLog.phases.filter(item => item === 'drained')).toHaveLength(1)
    }
  })

  test('does not publish worker no-effect after acquired failure successfully compensates a real start', async () => {
    installCanonicalMutationFixture()
    const value = await fixture({ worker: true }); await seedReadyPrimary(value)
    const acquisition = value.acquisition(); const log = recorder()
    const acquiredRecorderFailure = new Error('acquired recorder failed')
    const failingRecorder: NativeAcquisitionRecorder = { ...log.value, async recordAcquired() {
      log.phases.push('acquired'); throw acquiredRecorderFailure
    } }
    const originalError = await acquisition.launchOwnedNativeWorker({ memberOrdinal: 1, recorder: failingRecorder,
      cancellation: cancellation as never, effectAuthorization: value.authorization() }).catch(error => error)
    expect(originalError).toBe(acquiredRecorderFailure)
    const current = JSON.parse(await readFile(join(value.team, 'config.json'), 'utf8')) as canonicalTeamHelpers.TeamFile
    expect(current.members.map(member => member.agentId)).toEqual(['member-alpha'])
    expect(value.control.starts).toHaveLength(1)
    expect(value.control.stops).toHaveLength(1)
    expect(log.phases).toEqual(['arm', 'acquired', 'drained'])
  })

  test('retains exact worker custody when direct stop wins an acquired-publication failure', async () => {
    installCanonicalMutationFixture()
    for (const publication of ['success', 'failure'] as const) {
      const value = await fixture({ worker: true }); await seedReadyPrimary(value)
      const acquisition = value.acquisition(); const launchLog = recorder(); const directLog = recorder()
      let exposedIdentity!: Parameters<NativeAcquisitionRecorder['recordAcquired']>[0]
      let signalAcquired!: () => void; let releaseAcquired!: () => void
      const acquiredEntered = new Promise<void>(resolve => { signalAcquired = resolve })
      const acquiredGate = new Promise<void>(resolve => { releaseAcquired = resolve })
      const acquiredRecorderFailure = new Error('worker acquired recorder failed')
      let signalDrained!: () => void; let releaseDrained!: () => void; let rejectDrained!: (error: Error) => void
      const drainedEntered = new Promise<void>(resolve => { signalDrained = resolve })
      const drainedGate = new Promise<void>((resolve, reject) => { releaseDrained = resolve; rejectDrained = reject })
      const launchRecorder: NativeAcquisitionRecorder = {
        ...launchLog.value,
        async recordAcquired(identity) {
          launchLog.phases.push('acquired'); exposedIdentity = identity; signalAcquired(); await acquiredGate
          throw acquiredRecorderFailure
        },
      }
      const directRecorder: NativeAcquisitionRecorder = {
        ...directLog.value,
        async recordDrained() { directLog.phases.push('drained'); signalDrained(); await drainedGate },
      }
      const launched = acquisition.launchOwnedNativeWorker({ memberOrdinal: 1, recorder: launchRecorder,
        cancellation: cancellation as never, effectAuthorization: value.authorization() })
      const launchSettlement = observeSettlement(launched)
      await acquiredEntered
      const direct = acquisition.stopOwnedNativeProcess({ identity: exposedIdentity, mode: 'immediate',
        cancellation: cancellation as never, recorder: directRecorder })
      const directSettlement = observeSettlement(direct)
      await drainedEntered
      releaseAcquired()
      await new Promise<void>(resolve => setImmediate(resolve))
      if (publication === 'success') releaseDrained()
      else rejectDrained(new Error('worker direct terminal publication failed'))
      const [settledLaunch, settledDirect] = await Promise.all([launchSettlement, directSettlement])
      expect(settledLaunch.status).toBe('rejected')
      if (settledLaunch.status !== 'rejected') throw new Error('fixture expected worker acquired launch failure')
      if (publication === 'success') {
        expect(settledLaunch.error).toBe(acquiredRecorderFailure)
        expect(settledDirect).toEqual({ status: 'fulfilled', value: { status: 'drained' } })
      } else {
        expect(settledDirect.status).toBe('rejected')
        if (settledDirect.status !== 'rejected') throw new Error('fixture expected worker direct stop failure')
        expect(settledLaunch.error).toBe(settledDirect.error)
        expect(settledDirect.error).toBeInstanceOf(NativeProcessAcquisitionFailure)
        const failure = settledDirect.error as NativeProcessAcquisitionFailure
        expect(failure.message).toBe('worker direct terminal publication failed')
        expect(failure.attempt).toBe(directLog.uncertainAttempts[0])
        expect(failure.attempt).toMatchObject({ processRef: value.processRef,
          startResult: { status: 'started', processRef: value.processRef } })
        const healthy = recorder()
        expect(await acquisition.reconcileFailedAttempt({ attempt: failure.attempt, mode: 'immediate',
          cancellation: cancellation as never, recorder: healthy.value })).toEqual({ status: 'drained' })
        expect(healthy.phases).toEqual(['drained'])
      }
      const current = JSON.parse(await readFile(join(value.team, 'config.json'), 'utf8')) as canonicalTeamHelpers.TeamFile
      expect(current.members.map(member => member.agentId)).toEqual(['member-alpha'])
      expect(value.control.starts).toHaveLength(1)
      expect(value.control.stops).toHaveLength(1)
      expect(launchLog.phases).toEqual(['arm', 'acquired'])
      expect(launchLog.phases).not.toContain('no-effect')
      expect(directLog.phases.filter(item => item === 'drained')).toHaveLength(1)
    }
  })

  test('keeps direct-stop-first readiness settlement and worker claim retry exact', async () => {
    installCanonicalMutationFixture()
    for (const publication of ['success', 'failure'] as const) {
      const value = await fixture({ worker: true, launchTimeoutMs: 500 }); await seedReadyPrimary(value)
      value.control.onStart = async () => writeWorkerEvents(value)
      const acquisition = value.acquisition(); const launchLog = recorder(); const directLog = recorder()
      let exposedIdentity!: Parameters<NativeAcquisitionRecorder['recordReady']>[0]['identity']
      let signalReady!: () => void; let releaseReady!: () => void
      const readyEntered = new Promise<void>(resolve => { signalReady = resolve })
      const readyGate = new Promise<void>(resolve => { releaseReady = resolve })
      const readyRecorderFailure = new Error('ready recorder failed')
      let signalDrained!: () => void; let releaseDrained!: () => void; let rejectDrained!: (error: Error) => void
      const drainedEntered = new Promise<void>(resolve => { signalDrained = resolve })
      const drainedGate = new Promise<void>((resolve, reject) => { releaseDrained = resolve; rejectDrained = reject })
      const launchRecorder: NativeAcquisitionRecorder = {
        ...launchLog.value,
        async recordReady(input) {
          launchLog.phases.push('ready'); exposedIdentity = input.identity; signalReady(); await readyGate
          throw readyRecorderFailure
        },
      }
      const directRecorder: NativeAcquisitionRecorder = {
        ...directLog.value,
        async recordDrained() { directLog.phases.push('drained'); signalDrained(); await drainedGate },
      }
      const launched = acquisition.launchOwnedNativeWorker({ memberOrdinal: 1, recorder: launchRecorder,
        cancellation: cancellation as never, effectAuthorization: value.authorization() })
      const launchSettlement = observeSettlement(launched)
      await readyEntered
      const direct = acquisition.stopOwnedNativeProcess({ identity: exposedIdentity, mode: 'immediate',
        cancellation: cancellation as never, recorder: directRecorder })
      const directSettlement = observeSettlement(direct)
      await drainedEntered
      releaseReady()
      await new Promise<void>(resolve => setImmediate(resolve))
      if (publication === 'success') {
        releaseDrained()
      } else {
        rejectDrained(new Error('direct readiness terminal publication failed'))
      }
      const [settledLaunch, settledDirect] = await Promise.all([launchSettlement, directSettlement])
      expect(settledLaunch.status).toBe('rejected')
      if (settledLaunch.status !== 'rejected') throw new Error('fixture expected readiness launch failure')
      expect(settledLaunch.error).toBe(readyRecorderFailure)
      expect((settledLaunch.error as Error).message).toBe('ready recorder failed')
      if (publication === 'success') {
        expect(settledDirect).toEqual({ status: 'fulfilled', value: { status: 'drained' } })
      } else {
        expect(settledDirect.status).toBe('rejected')
        if (settledDirect.status !== 'rejected') throw new Error('fixture expected direct stop failure')
        expect(settledDirect.error).toBeInstanceOf(NativeProcessAcquisitionFailure)
        const directFailure = settledDirect.error as NativeProcessAcquisitionFailure
        expect(directFailure.message).toBe('direct readiness terminal publication failed')
        expect(directFailure.attempt).toBe(directLog.uncertainAttempts[0])
        const retained = JSON.parse(await readFile(join(value.team, 'config.json'), 'utf8')) as canonicalTeamHelpers.TeamFile
        expect(retained.members.map(member => member.agentId)).toEqual(['member-alpha', 'member-beta'])
        const healthy = recorder()
        expect(await acquisition.reconcileFailedAttempt({ attempt: directFailure.attempt, mode: 'immediate', cancellation: cancellation as never,
          recorder: healthy.value })).toEqual({ status: 'drained' })
        expect(healthy.phases).toEqual(['drained'])
      }
      const settled = JSON.parse(await readFile(join(value.team, 'config.json'), 'utf8')) as canonicalTeamHelpers.TeamFile
      expect(settled.members.map(member => member.agentId)).toEqual(['member-alpha'])
      expect(value.control.stops).toHaveLength(1)
      expect(launchLog.phases).toEqual(['arm', 'acquired', 'ready'])
      expect(directLog.phases.filter(item => item === 'drained')).toHaveLength(1)
    }
  })

  test('retains an uncertain public stop with its exact acquired start for reconciliation', async () => {
    const value = await fixture(); const log = recorder(); value.control.onStart = async () => writeFile(value.readyAckPath,
      JSON.stringify(value.acknowledgement()), { mode: 0o600 })
    const acquisition = value.acquisition(); const identity = await acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: log.value,
      cancellation: cancellation as never, effectAuthorization: value.authorization() })
    value.control.stopResult = { status: 'unclassified_residual' }
    expect(await acquisition.stopOwnedNativeProcess({ identity, mode: 'immediate', cancellation: cancellation as never, recorder: log.value }))
      .toMatchObject({ status: 'uncertain' })
    const attempt = log.uncertainAttempts.at(-1)!
    expect(attempt.startResult).toMatchObject({ status: 'started', processRef: value.processRef })
    value.control.stopResult = { status: 'drained' }
    expect(await acquisition.reconcileFailedAttempt({ attempt, mode: 'immediate', cancellation: cancellation as never, recorder: log.value }))
      .toEqual({ status: 'drained' })
  })

  test('retains an uncertain stop when its durable uncertainty publication fails', async () => {
    const value = await fixture(); const launchLog = recorder(); value.control.onStart = async () => writeFile(value.readyAckPath,
      JSON.stringify(value.acknowledgement()), { mode: 0o600 })
    const acquisition = value.acquisition(); const identity = await acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: launchLog.value,
      cancellation: cancellation as never, effectAuthorization: value.authorization() })
    value.control.stopResult = { status: 'unclassified_residual' }
    const failing = recorder('uncertain')
    const publicationFailure = await captureFailure(acquisition.stopOwnedNativeProcess({ identity, mode: 'immediate',
      cancellation: cancellation as never, recorder: failing.value }))
    expect(publicationFailure.message).toBe('uncertain recorder failed')
    const attempt = failing.uncertainAttempts[0]!
    expect(publicationFailure.attempt).toBe(attempt)
    expect(attempt.startResult).toMatchObject({ status: 'started', processRef: value.processRef })
    value.control.stopResult = { status: 'drained' }
    const healthy = recorder()
    expect(await acquisition.reconcileFailedAttempt({ attempt, mode: 'immediate', cancellation: cancellation as never, recorder: healthy.value }))
      .toEqual({ status: 'drained' })
    expect(healthy.phases).toEqual(['drained'])
  })

  test('retains a failed ready compensation until exact reconciliation drains it', async () => {
    const value = await fixture(); const log = recorder('ready'); value.control.stopResult = { status: 'unclassified_residual' }
    value.control.onStart = async () => writeFile(value.readyAckPath, JSON.stringify(value.acknowledgement()), { mode: 0o600 })
    const acquisition = value.acquisition(); const failure = await captureFailure(acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: log.value,
      cancellation: cancellation as never, effectAuthorization: value.authorization() }))
    expect(failure.attempt).toMatchObject({ kind: 'known-anchor-ref', startResult: { status: 'started', processRef: value.processRef } })
    expect(log.phases).toContain('uncertain:compensation')
    let releaseStop: (result: unknown) => void = () => undefined
    value.control.stopResult = new Promise(resolve => { releaseStop = resolve })
    const first = acquisition.reconcileFailedAttempt({ attempt: failure.attempt, mode: 'immediate', cancellation: cancellation as never, recorder: log.value })
    const joined = acquisition.reconcileFailedAttempt({ attempt: failure.attempt, mode: 'immediate', cancellation: cancellation as never, recorder: log.value })
    expect(joined).toBe(first)
    releaseStop({ status: 'drained' })
    expect(await Promise.all([first, joined])).toEqual([{ status: 'drained' }, { status: 'drained' }])
    expect(await acquisition.reconcileFailedAttempt({ attempt: failure.attempt, mode: 'immediate', cancellation: cancellation as never, recorder: log.value }))
      .toEqual({ status: 'attempt_not_retained' })
  })

  test('rejects substituted acknowledgement runtime, session, and proof fields and compensates', async () => {
    for (const substituted of [{ sessionId: '' }, { pid: 0 }, { processOsIdentity: '' }, { envelopeDigest: '0'.repeat(64) },
      { launchIdentityToken: 'attempt:substitute:0001' }, { materialDigest: '1'.repeat(64) }]) {
      const value = await fixture(); const log = recorder(); value.control.onStart = async () => writeFile(value.readyAckPath,
        JSON.stringify(value.acknowledgement(substituted)), { mode: 0o600 })
      await expect(value.acquisition().launchOwnedNativeLead({ memberOrdinal: 0, recorder: log.value, cancellation: cancellation as never,
        effectAuthorization: value.authorization() })).rejects.toThrow('timed out')
      expect(value.control.stops).toHaveLength(1); expect(log.phases).toEqual(['arm', 'acquired', 'drained'])
    }
  })

  test('retains a terminal compensation whose durable drain publication fails', async () => {
    const value = await fixture(); const failing = recorder('drained')
    value.control.onStart = async () => writeFile(value.readyAckPath, JSON.stringify(value.acknowledgement({ sessionId: '' })), { mode: 0o600 })
    const acquisition = value.acquisition()
    const failure = await captureFailure(acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: failing.value,
      cancellation: cancellation as never, effectAuthorization: value.authorization() }))
    expect(failure.attempt.startResult).toMatchObject({ status: 'started', processRef: value.processRef })
    expect(failing.phases).toEqual(['arm', 'acquired', 'drained', 'uncertain:compensation-publication'])
    const healthy = recorder()
    expect(await acquisition.reconcileFailedAttempt({ attempt: failure.attempt, mode: 'immediate', cancellation: cancellation as never, recorder: healthy.value }))
      .toEqual({ status: 'drained' })
    expect(healthy.phases).toEqual(['drained'])
  })

  test('retains a public stop whose durable drain publication fails', async () => {
    const value = await fixture(); const launchLog = recorder()
    value.control.onStart = async () => writeFile(value.readyAckPath, JSON.stringify(value.acknowledgement()), { mode: 0o600 })
    const acquisition = value.acquisition(); const identity = await acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: launchLog.value,
      cancellation: cancellation as never, effectAuthorization: value.authorization() })
    const failing = recorder('drained-and-uncertain')
    const publicationFailure = await captureFailure(acquisition.stopOwnedNativeProcess({ identity, mode: 'immediate',
      cancellation: cancellation as never, recorder: failing.value }))
    expect(publicationFailure.message).toBe('drained recorder failed')
    const attempt = publicationFailure.attempt
    expect(failing.uncertainAttempts).toEqual([])
    expect(attempt).toMatchObject({ kind: 'known-anchor-ref', processRef: value.processRef,
      startResult: { status: 'started', processRef: value.processRef } })
    const healthy = recorder()
    expect(await acquisition.reconcileFailedAttempt({ attempt, mode: 'immediate', cancellation: cancellation as never, recorder: healthy.value }))
      .toEqual({ status: 'drained' })
    expect(value.control.stops).toHaveLength(1); expect(healthy.phases).toEqual(['drained'])
  })

  test('lets public stop win over gated late ready publication for both lead and worker', async () => {
    installCanonicalMutationFixture()
    for (const role of ['lead', 'worker'] as const) {
      const value = await fixture({ worker: role === 'worker', launchTimeoutMs: 500 })
      if (role === 'worker') {
        await seedReadyPrimary(value)
        value.control.onStart = async () => writeWorkerEvents(value)
      } else {
        value.control.onStart = async () => writeFile(value.readyAckPath, JSON.stringify(value.acknowledgement()), { mode: 0o600 })
      }
      const acquisition = value.acquisition(); const launchLog = recorder(); const stopLog = recorder()
      type ReadyIdentity = Parameters<NativeAcquisitionRecorder['recordReady']>[0]['identity']
      let readyIdentity!: ReadyIdentity
      let signalReady!: () => void; let releaseReady!: () => void
      const readyEntered = new Promise<void>(resolve => { signalReady = resolve })
      const readyGate = new Promise<void>(resolve => { releaseReady = resolve })
      const gatedRecorder: NativeAcquisitionRecorder = { ...launchLog.value, async recordReady(input) {
        launchLog.phases.push('ready'); readyIdentity = input.identity; signalReady(); await readyGate
      } }
      const launched = role === 'lead'
        ? acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: gatedRecorder, cancellation: cancellation as never,
            effectAuthorization: value.authorization() })
        : acquisition.launchOwnedNativeWorker({ memberOrdinal: 1, recorder: gatedRecorder, cancellation: cancellation as never,
            effectAuthorization: value.authorization() })
      await readyEntered
      expect(await acquisition.stopOwnedNativeProcess({ identity: readyIdentity, mode: 'immediate', cancellation: cancellation as never,
        recorder: stopLog.value })).toEqual({ status: 'drained' })
      releaseReady()
      await expect(launched).rejects.toThrow('stop won')
      await expect(acquisition.inspectOwnedNativeProcess(readyIdentity)).rejects.toThrow('not retained')
      expect(value.control.stops).toHaveLength(1)
      expect(launchLog.phases).toEqual(['arm', 'acquired', 'ready'])
      expect(stopLog.phases).toEqual(['drained'])
    }
  })

  test('rejects foreign refs and cross-attempt tokens before joining an exact stop operation', async () => {
    installCanonicalMutationFixture()
    const value = await fixture({ worker: true, launchTimeoutMs: 500 }); const acquisition = value.acquisition()
    value.control.onStart = async () => writeFile(value.readyAckPath, JSON.stringify(value.acknowledgement()), { mode: 0o600 })
    const lead = await acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: recorder().value,
      cancellation: cancellation as never, effectAuthorization: value.authorization({ attemptToken: value.nativeAttempt.attemptToken }) })
    await seedReadyPrimary(value)
    const workerRef = 'process:fixture:0000000002' as SupervisedProcessRef
    value.control.startResult = { status: 'started', processRef: workerRef }
    value.control.onStart = async () => writeWorkerEvents(value)
    const worker = await acquisition.launchOwnedNativeWorker({ memberOrdinal: 1, recorder: recorder().value,
      cancellation: cancellation as never, effectAuthorization: value.authorization() })
    let releaseStop!: (result: unknown) => void
    value.control.stopResult = new Promise(resolve => { releaseStop = resolve })
    const stopped = acquisition.stopOwnedNativeProcess({ identity: worker, mode: 'immediate', cancellation: cancellation as never,
      recorder: recorder().value })
    await Promise.resolve()
    expect(() => acquisition.stopOwnedNativeProcess({ identity: { ...worker, processRef: lead.processRef }, mode: 'immediate',
      cancellation: cancellation as never, recorder: recorder().value })).toThrow('ref is not retained')
    expect(() => acquisition.stopOwnedNativeProcess({ identity: { ...lead, attemptToken: worker.attemptToken }, mode: 'immediate',
      cancellation: cancellation as never, recorder: recorder().value })).toThrow('foreign')
    expect(value.control.stops).toHaveLength(1)
    releaseStop({ status: 'drained' })
    expect(await stopped).toEqual({ status: 'drained' })
  })

  test('joins concurrent direct stop publication failure and preserves its exact attempt for healthy reconciliation', async () => {
    const value = await fixture(); const launchLog = recorder(); const alternate = recorder()
    value.control.onStart = async () => writeFile(value.readyAckPath, JSON.stringify(value.acknowledgement()), { mode: 0o600 })
    const acquisition = value.acquisition(); const identity = await acquisition.launchOwnedNativeLead({ memberOrdinal: 0,
      recorder: launchLog.value, cancellation: cancellation as never, effectAuthorization: value.authorization() })
    const failing = recorder('drained-and-uncertain')
    let signalDrained!: () => void; let rejectDrained!: (error: Error) => void
    const drainedEntered = new Promise<void>(resolve => { signalDrained = resolve })
    const drainedGate = new Promise<void>((_resolve, reject) => { rejectDrained = reject })
    const gatedFailing: NativeAcquisitionRecorder = { ...failing.value, async recordDrained() {
      failing.phases.push('drained'); signalDrained(); await drainedGate
    } }
    const first = acquisition.stopOwnedNativeProcess({ identity, mode: 'immediate', cancellation: cancellation as never, recorder: gatedFailing })
    await drainedEntered
    const joined = acquisition.stopOwnedNativeProcess({ identity, mode: 'immediate', cancellation: cancellation as never, recorder: alternate.value })
    expect(joined).toBe(first)
    rejectDrained(new Error('drained recorder failed'))
    const [firstFailure, joinedFailure] = await Promise.all([first.catch(error => error), joined.catch(error => error)])
    expect(firstFailure).toBeInstanceOf(NativeProcessAcquisitionFailure)
    expect(joinedFailure).toBe(firstFailure)
    const attempt = (firstFailure as NativeProcessAcquisitionFailure).attempt
    expect(attempt).toMatchObject({ kind: 'known-anchor-ref', processRef: value.processRef,
      startResult: { status: 'started', processRef: value.processRef } })
    expect(alternate.phases).toEqual([])
    const healthy = recorder()
    expect(await acquisition.reconcileFailedAttempt({ attempt, mode: 'immediate', cancellation: cancellation as never, recorder: healthy.value }))
      .toEqual({ status: 'drained' })
    expect(value.control.stops).toHaveLength(1)
    expect(healthy.phases).toEqual(['drained'])
  })

  test('rejects recursive completion without terminal success while outer settlement can complete', async () => {
    const value = await fixture(); const launchLog = recorder(); const firstLog = recorder(); const alternate = recorder()
    value.control.onStart = async () => writeFile(value.readyAckPath, JSON.stringify(value.acknowledgement()), { mode: 0o600 })
    const acquisition = value.acquisition(); const identity = await acquisition.launchOwnedNativeLead({ memberOrdinal: 0,
      recorder: launchLog.value, cancellation: cancellation as never, effectAuthorization: value.authorization() })
    let signalDrained!: () => void; let releaseDrained!: () => void
    const drainedEntered = new Promise<void>(resolve => { signalDrained = resolve })
    const drainedGate = new Promise<void>(resolve => { releaseDrained = resolve })
    const recursiveErrors: unknown[] = []
    const gatedRecorder: NativeAcquisitionRecorder = { ...firstLog.value, async recordDrained() {
      firstLog.phases.push('drained')
      recursiveErrors.push(await acquisition.stopOwnedNativeProcess({ identity, mode: 'immediate', cancellation: cancellation as never,
        recorder: alternate.value }).catch(error => error))
      signalDrained(); await drainedGate
    } }
    const first = acquisition.stopOwnedNativeProcess({ identity, mode: 'immediate', cancellation: cancellation as never, recorder: gatedRecorder })
    await drainedEntered
    const joined = acquisition.stopOwnedNativeProcess({ identity, mode: 'immediate', cancellation: cancellation as never, recorder: alternate.value })
    expect(joined).toBe(first)
    releaseDrained()
    expect(await Promise.all([first, joined])).toEqual([{ status: 'drained' }, { status: 'drained' }])
    expect(value.control.stops).toHaveLength(1)
    expect(recursiveErrors).toHaveLength(1)
    expect((recursiveErrors[0] as Error).message).toContain('Recursive native stop completion is forbidden')
    expect(firstLog.phases).toEqual(['drained'])
    expect(alternate.phases).toEqual([])
    await expect(acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: alternate.value,
      cancellation: cancellation as never, effectAuthorization: value.authorization() })).rejects.toThrow('terminal')
    expect(alternate.phases).toEqual([])
  })

  test('does not let inherited stop context bypass a healthy retry after outer publication failure', async () => {
    const value = await fixture(); const launchLog = recorder(); const failing = recorder(); const healthy = recorder()
    value.control.onStart = async () => writeFile(value.readyAckPath, JSON.stringify(value.acknowledgement()), { mode: 0o600 })
    const acquisition = value.acquisition(); const identity = await acquisition.launchOwnedNativeLead({ memberOrdinal: 0,
      recorder: launchLog.value, cancellation: cancellation as never, effectAuthorization: value.authorization() })
    let releaseDelayed!: () => void
    const delayedGate = new Promise<void>(resolve => { releaseDelayed = resolve })
    let failedAttempt!: NativeProcessAcquisitionFailure['attempt']
    let delayedRetry!: Promise<unknown>
    const inheritedRecorder: NativeAcquisitionRecorder = { ...failing.value, async recordDrained() {
      failing.phases.push('drained')
      delayedRetry = delayedGate.then(() => acquisition.reconcileFailedAttempt({ attempt: failedAttempt, mode: 'immediate',
        cancellation: cancellation as never, recorder: healthy.value }))
      throw new Error('outer publication failed')
    } }
    const failure = await captureFailure(acquisition.stopOwnedNativeProcess({ identity, mode: 'immediate',
      cancellation: cancellation as never, recorder: inheritedRecorder }))
    failedAttempt = failure.attempt
    releaseDelayed()
    expect(await delayedRetry).toEqual({ status: 'drained' })
    expect(value.control.stops).toHaveLength(1)
    expect(healthy.phases).toEqual(['drained'])
  })

  test('joins concurrent and repeated lead acquisition with exact ready session and no alternate publication', async () => {
    const value = await fixture(); const firstLog = recorder(); const alternate = recorder(); const acquisition = value.acquisition()
    let releaseStart!: () => void
    let signalStarted!: () => void
    const startEntered = new Promise<void>(resolve => { signalStarted = resolve })
    const startGate = new Promise<void>(resolve => { releaseStart = resolve })
    value.control.onStart = async () => {
      signalStarted()
      await startGate
      await writeFile(value.readyAckPath, JSON.stringify(value.acknowledgement()), { mode: 0o600 })
    }
    const first = acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: firstLog.value, cancellation: cancellation as never,
      effectAuthorization: value.authorization() })
    await startEntered
    const joined = acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: alternate.value, cancellation: cancellation as never,
      effectAuthorization: value.authorization() })
    releaseStart()
    const [identity, joinedIdentity] = await Promise.all([first, joined])
    expect(joinedIdentity).toBe(identity)
    expect(identity.runtimeSessionId).toBe('session-real')
    expect(await acquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: alternate.value, cancellation: cancellation as never,
      effectAuthorization: value.authorization() })).toBe(identity)
    expect(value.control.starts).toHaveLength(1)
    expect(value.control.stops).toHaveLength(0)
    expect(firstLog.phases).toEqual(['arm', 'acquired', 'ready'])
    expect(alternate.phases).toEqual([])
  })

  test('preserves a pre-existing worker on reservation conflict without start or rollback', async () => {
    installCanonicalMutationFixture()
    const value = await fixture({ worker: true }); await seedReadyPrimary(value)
    const configPath = join(value.team, 'config.json')
    const before = JSON.parse(await readFile(configPath, 'utf8')) as canonicalTeamHelpers.TeamFile
    const existing = { agentId: 'member-beta', name: 'beta', joinedAt: 2, tmuxPaneId: 'hosted-anchor:pre-existing',
      cwd: value.material.roots.cwd.canonicalPath, subscriptions: [], sessionId: 'pre-existing-session' }
    await writeFile(configPath, JSON.stringify({ ...before, members: [...before.members, existing] }), { mode: 0o600 })
    const log = recorder()
    await expect(value.acquisition().launchOwnedNativeWorker({ memberOrdinal: 1, recorder: log.value,
      cancellation: cancellation as never, effectAuthorization: value.authorization() })).rejects.toThrow('reservation was not acquired')
    const after = JSON.parse(await readFile(configPath, 'utf8')) as canonicalTeamHelpers.TeamFile
    expect(after.members.find(member => member.agentId === 'member-beta')).toEqual(existing)
    expect(value.control.starts).toHaveLength(0)
    expect(value.control.stops).toHaveLength(0)
    expect(log.phases).toEqual(['arm', 'no-effect'])
  })

  test('joins concurrent and repeated worker acquisition without deleting its live claim', async () => {
    installCanonicalMutationFixture()
    const value = await fixture({ worker: true, launchTimeoutMs: 500 }); await seedReadyPrimary(value)
    const firstLog = recorder(); const alternate = recorder(); const acquisition = value.acquisition()
    let releaseStart!: () => void
    let signalStarted!: () => void
    const startEntered = new Promise<void>(resolve => { signalStarted = resolve })
    const startGate = new Promise<void>(resolve => { releaseStart = resolve })
    value.control.onStart = async () => { signalStarted(); await startGate; await writeWorkerEvents(value) }
    const first = acquisition.launchOwnedNativeWorker({ memberOrdinal: 1, recorder: firstLog.value, cancellation: cancellation as never,
      effectAuthorization: value.authorization() })
    await startEntered
    const joined = acquisition.launchOwnedNativeWorker({ memberOrdinal: 1, recorder: alternate.value, cancellation: cancellation as never,
      effectAuthorization: value.authorization() })
    releaseStart()
    const [identity, joinedIdentity] = await Promise.all([first, joined])
    expect(joinedIdentity).toBe(identity)
    expect(await acquisition.launchOwnedNativeWorker({ memberOrdinal: 1, recorder: alternate.value, cancellation: cancellation as never,
      effectAuthorization: value.authorization() })).toBe(identity)
    const current = JSON.parse(await readFile(join(value.team, 'config.json'), 'utf8')) as canonicalTeamHelpers.TeamFile
    expect(current.members.find(member => member.agentId === 'member-beta')).toMatchObject({ sessionId: 'worker-session',
      processOwnerToken: value.workerAttempt.attemptToken })
    expect(value.control.starts).toHaveLength(1)
    expect(value.control.stops).toHaveLength(0)
    expect(firstLog.phases).toEqual(['arm', 'acquired', 'ready'])
    expect(alternate.phases).toEqual([])
  })

  test('rejects stopped and failed exact-attempt replay without new effects', async () => {
    const stopped = await fixture(); const stoppedLog = recorder(); const stoppedAlternate = recorder()
    stopped.control.onStart = async () => writeFile(stopped.readyAckPath, JSON.stringify(stopped.acknowledgement()), { mode: 0o600 })
    const stoppedAcquisition = stopped.acquisition()
    const identity = await stoppedAcquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: stoppedLog.value,
      cancellation: cancellation as never, effectAuthorization: stopped.authorization() })
    await stoppedAcquisition.stopOwnedNativeProcess({ identity, mode: 'immediate', cancellation: cancellation as never, recorder: stoppedLog.value })
    await expect(stoppedAcquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: stoppedAlternate.value,
      cancellation: cancellation as never, effectAuthorization: stopped.authorization() })).rejects.toThrow('terminal')
    expect(stopped.control.starts).toHaveLength(1); expect(stopped.control.stops).toHaveLength(1); expect(stoppedAlternate.phases).toEqual([])

    const failed = await fixture(); failed.control.startResult = { status: 'rejected', reason: 'unavailable' }
    const failedLog = recorder(); const failedAlternate = recorder(); const failedAcquisition = failed.acquisition()
    const original = await captureFailure(failedAcquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: failedLog.value,
      cancellation: cancellation as never, effectAuthorization: failed.authorization() }))
    const replay = await captureFailure(failedAcquisition.launchOwnedNativeLead({ memberOrdinal: 0, recorder: failedAlternate.value,
      cancellation: cancellation as never, effectAuthorization: failed.authorization() }))
    expect(replay).toBe(original)
    expect(failed.control.starts).toHaveLength(1); expect(failed.control.stops).toHaveLength(0); expect(failedAlternate.phases).toEqual([])
  })

  test('gates async current-authority deadline and cancellation before worker Product start', async () => {
    installCanonicalMutationFixture()
    for (const boundary of ['deadline', 'cancellation'] as const) {
      const value = await fixture({ worker: true }); await seedReadyPrimary(value)
      const log = recorder(); const acquisition = value.acquisition(); let calls = 0; let cancelled = false
      let release!: () => void
      let signalEntered!: () => void
      const entered = new Promise<void>(resolve => { signalEntered = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      const realNow = Date.now
      let now = realNow()
      if (boundary === 'deadline') Date.now = () => now
      try {
        const authorization = value.authorization({ deadlineMs: now + 100, async assertCurrent() {
          calls += 1
          const gatedCall = boundary === 'deadline' ? 2 : 3
          if (calls === gatedCall) { signalEntered(); await gate }
        } })
        const launched = acquisition.launchOwnedNativeWorker({ memberOrdinal: 1, recorder: log.value,
          cancellation: { ...cancellation, isCancellationRequested: () => cancelled } as never, effectAuthorization: authorization })
        await entered
        if (boundary === 'deadline') now += 101
        else cancelled = true
        release()
        await expect(launched).rejects.toThrow(boundary === 'deadline' ? 'expired' : 'effect boundary')
      } finally { Date.now = realNow }
      const current = JSON.parse(await readFile(join(value.team, 'config.json'), 'utf8')) as canonicalTeamHelpers.TeamFile
      expect(current.members.map(member => member.agentId)).toEqual(['member-alpha'])
      expect(value.control.starts).toHaveLength(0); expect(value.control.stops).toHaveLength(0); expect(log.phases).toEqual(['arm', 'no-effect'])
    }
  })

  test('reconciles worker terminal publication and claim failures without a second Product stop', async () => {
    installCanonicalMutationFixture()
    const value = await fixture({ worker: true, launchTimeoutMs: 500 }); await seedReadyPrimary(value)
    value.control.onStart = async () => writeWorkerEvents(value)
    const acquisition = value.acquisition(); const launchLog = recorder()
    const identity = await acquisition.launchOwnedNativeWorker({ memberOrdinal: 1, recorder: launchLog.value,
      cancellation: cancellation as never, effectAuthorization: value.authorization() })
    const publicationFailure = recorder('drained')
    const firstFailure = await captureFailure(acquisition.stopOwnedNativeProcess({ identity, mode: 'immediate',
      cancellation: cancellation as never, recorder: publicationFailure.value }))
    expect(publicationFailure.uncertainAttempts.at(-1)).toBe(firstFailure.attempt)
    expect(value.control.stops).toHaveLength(1)

    failNextCanonicalMutation = true
    const claimFailure = recorder()
    const secondFailure = await captureFailure(acquisition.reconcileFailedAttempt({ attempt: firstFailure.attempt, mode: 'immediate',
      cancellation: cancellation as never, recorder: claimFailure.value }))
    expect(secondFailure.attempt).toBe(firstFailure.attempt)
    expect(claimFailure.phases).toEqual(['drained', 'uncertain:stop-terminal-publication'])

    const healthy = recorder()
    expect(await acquisition.reconcileFailedAttempt({ attempt: firstFailure.attempt, mode: 'immediate',
      cancellation: cancellation as never, recorder: healthy.value })).toEqual({ status: 'drained' })
    const current = JSON.parse(await readFile(join(value.team, 'config.json'), 'utf8')) as canonicalTeamHelpers.TeamFile
    expect(current.members.map(member => member.agentId)).toEqual(['member-alpha'])
    expect(value.control.stops).toHaveLength(1)
    expect(healthy.phases).toEqual([])
  })

  test('runs the worker public lifecycle through ordinary mailbox proof and exact durable claim removal', async () => {
    installCanonicalMutationFixture()
    const value = await fixture({ worker: true, launchTimeoutMs: 500 }); await seedReadyPrimary(value)
    let reservedAtStart: canonicalTeamHelpers.TeamFile | undefined
    value.control.onStart = async () => {
      reservedAtStart = JSON.parse(await readFile(join(value.team, 'config.json'), 'utf8')) as canonicalTeamHelpers.TeamFile
      await writeWorkerEvents(value)
    }
    const log = recorder(); const acquisition = value.acquisition()
    const identity = await acquisition.launchOwnedNativeWorker({ memberOrdinal: 1, recorder: log.value,
      cancellation: cancellation as never, effectAuthorization: value.authorization() })
    expect(identity).toMatchObject({ kind: 'hosted-anchor', role: 'native-worker', memberOrdinal: 1, runtimeSessionId: 'worker-session',
      diagnostics: { pid: 5151 }, readiness: { kind: 'hosted-worker-runtime', runtimeSessionId: 'worker-session' } })
    const mailbox = JSON.parse(await readFile(join(value.team, 'inboxes', 'beta.json'), 'utf8')) as Array<{ messageId: string; text: string }>
    expect(mailbox).toHaveLength(1); expect(mailbox[0]).toMatchObject({ text: 'ordinary worker briefing' })
    expect(identity.readiness).toMatchObject({ mailboxMessageId: mailbox[0]!.messageId,
      bootstrapAccepted: { bootstrapMirrorId: mailbox[0]!.messageId, bootstrapProofToken: value.bootstrapProofToken } })
    expect(reservedAtStart?.members.find(member => member.agentId === 'member-beta')).toMatchObject({
      processOwnerToken: value.workerAttempt.attemptToken, processRunId: value.material.runId,
      spawnClaimToken: value.workerAttempt.attemptToken, spawnClaimRunId: value.material.runId, spawnClaimRuntimeMayExist: false,
      tmuxPaneId: `hosted-anchor:${value.workerAttempt.attemptToken}`,
    })
    expect(reservedAtStart?.members.find(member => member.agentId === 'member-beta')).not.toHaveProperty('sessionId')
    const published = JSON.parse(await readFile(join(value.team, 'config.json'), 'utf8')) as canonicalTeamHelpers.TeamFile
    expect(published.members.find(member => member.agentId === 'member-beta')).toMatchObject({ sessionId: 'worker-session',
      processOwnerToken: value.workerAttempt.attemptToken, processRunId: value.material.runId,
      tmuxPaneId: `hosted-anchor:${value.workerAttempt.attemptToken}` })
    expect(published.members.find(member => member.agentId === 'member-beta')).not.toHaveProperty('spawnClaimToken')
    expect(await acquisition.stopOwnedNativeProcess({ identity, mode: 'graceful', cancellation: cancellation as never, recorder: log.value }))
      .toEqual({ status: 'drained' })
    const drained = JSON.parse(await readFile(join(value.team, 'config.json'), 'utf8')) as canonicalTeamHelpers.TeamFile
    expect(drained.members.map(member => member.agentId)).toEqual(['member-alpha'])
    expect(value.control.starts).toHaveLength(1); expect(value.control.stops).toHaveLength(1)
    expect(log.phases).toEqual(['arm', 'acquired', 'ready', 'drained'])
  })

  test('rejects wrong worker run, session, and token proof and compensates each exact claim', async () => {
    installCanonicalMutationFixture()
    for (const substituted of [
      { bootstrapRunId: 'run-substituted' },
      { runtimeRunId: 'worker-session', inboxRunId: 'session-substituted' },
      { proofToken: 'proof:substituted:0001', mirrorId: 'message:substituted:0001' },
    ]) {
      const value = await fixture({ worker: true, launchTimeoutMs: 80 }); await seedReadyPrimary(value)
      value.control.onStart = async () => writeWorkerEvents(value, substituted)
      const log = recorder(); await expect(value.acquisition().launchOwnedNativeWorker({ memberOrdinal: 1, recorder: log.value,
        cancellation: cancellation as never, effectAuthorization: value.authorization() })).rejects.toThrow()
      const current = JSON.parse(await readFile(join(value.team, 'config.json'), 'utf8')) as canonicalTeamHelpers.TeamFile
      expect(current.members.map(member => member.agentId)).toEqual(['member-alpha'])
      expect(value.control.starts).toHaveLength(1); expect(value.control.stops).toHaveLength(1)
      expect(log.phases).toEqual(['arm', 'acquired', 'drained'])
    }
  })

  test('compensates worker recorder failure after public readiness and removes the reserved claim', async () => {
    installCanonicalMutationFixture()
    const value = await fixture({ worker: true, launchTimeoutMs: 500 }); await seedReadyPrimary(value)
    value.control.onStart = async () => writeWorkerEvents(value)
    const log = recorder('ready')
    await expect(value.acquisition().launchOwnedNativeWorker({ memberOrdinal: 1, recorder: log.value,
      cancellation: cancellation as never, effectAuthorization: value.authorization() })).rejects.toThrow('ready recorder failed')
    const current = JSON.parse(await readFile(join(value.team, 'config.json'), 'utf8')) as canonicalTeamHelpers.TeamFile
    expect(current.members.map(member => member.agentId)).toEqual(['member-alpha'])
    expect(value.control.starts).toHaveLength(1); expect(value.control.stops).toHaveLength(1)
    expect(log.phases).toEqual(['arm', 'acquired', 'ready', 'drained'])
  })
})
