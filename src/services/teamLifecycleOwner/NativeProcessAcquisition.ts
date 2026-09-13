import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, resolve, sep } from 'node:path'
import type { Writable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'

import type {
  NodeAnchorLaunchAuthorityCatalog,
  ProcessControllerInstanceId,
  ProcessOwnerBinding,
  ProcessOwnershipStorePort,
  RuntimeCancellation,
  SupervisedProcessRef,
} from '@agent-teams/owner-anchor-library'
import {
  computeHostedNativeEnvelopeDigest,
  readHostedNativeReadyAcknowledgement,
  type HostedNativeLaunchEnvelope,
  type HostedNativeReadyAcknowledgement,
} from 'src/services/teamBootstrap/hostedNativeLaunch.js'
import type { HostedCanonicalAuthorityProtectedRecord } from 'src/services/teamBootstrap/hostedCanonicalAuthorityStartup.js'
import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js'
import { buildResolvedNativeProcessEnv, buildResolvedNativeProcessFlags } from 'src/utils/swarm/spawnUtils.js'
import { readRecentTeammateRuntimeEvents, waitForBootstrapSubmissionOutcome, type TeammateRuntimeEvent } from 'src/utils/swarm/teammateRuntimeEvents.js'
import { updateTeamFileAtCanonicalRoot, upsertTeamMember, type TeamFile } from 'src/utils/swarm/teamHelpers.js'
import { writeToMailboxAtCanonicalTeamRootVerified } from 'src/utils/teammateMailbox.js'
import {
  HostedNativeAnchorAdapter,
  type HostedNativeAnchorAdapterOptions,
  type HostedNativeAnchorObserveResult,
  type HostedNativeAnchorStartResult,
  type HostedNativeAnchorStopResult,
  type HostedNativeAnchorUnitBinding,
} from './HostedNativeAnchorAdapter.js'
import type { LoadedHostedOwnerAnchorLibrary } from './HostedOwnerAnchorLibrary.js'
import { preflightNativeProcessLaunch, type NativeProcessLaunchMaterial, type NativeResolvedMemberMaterial } from './NativeProcessLaunchMaterial.js'

export type NativeAcquisitionRole = 'native-lead' | 'native-worker'

export type NativeAttemptEffectAuthorization = Readonly<{
  authorizationId: string
  ownerBootId: string
  ownerControllerInstanceId: string
  attemptToken: string
  deadlineMs: number
  assertCurrent(): void | Promise<void>
}>

export type NativeProcessReadinessProof =
  | Readonly<{ kind: 'hosted-native-ready-ack'; acknowledgement: HostedNativeReadyAcknowledgement }>
  | Readonly<{
      kind: 'hosted-worker-runtime'
      runtimeReady: TeammateRuntimeEvent
      inboxPollerReady: TeammateRuntimeEvent
      bootstrapAccepted: TeammateRuntimeEvent
      mailboxMessageId: string
      runtimeSessionId: string
      diagnosticPid: number
    }>

export type NativeAcquisitionPreparedExpectation = Readonly<{
  version: 1
  role: NativeAcquisitionRole
  publicTeamId: string
  legacyKey: string
  runId: string
  attemptSetId: string
  attemptToken: string
  memberOrdinal: number
  laneId: string
  displayName: string
  agentId: string
  provider: 'anthropic' | 'codex' | 'gemini'
  model: string
  effort?: string
  ownerBootId: string
  ownerControllerInstanceId: string
  ownerPlanGeneration: string
  productPlanGeneration: number
  productPlanRef: string
  materialDigest: string
  recipeDigest: string
  profileDigest: string
  binding: HostedNativeAnchorUnitBinding
}>

export type OwnedNativeProcessIdentity = NativeAcquisitionPreparedExpectation & Readonly<{
  kind: 'hosted-anchor'
  processRef: SupervisedProcessRef
  runtimeSessionId?: string
  readiness?: NativeProcessReadinessProof
  diagnostics?: Readonly<{ pid: number; startedAtMs?: number; osIdentity?: string }>
}>

export type NativeAcquisitionFailedAttempt = Readonly<{
  version: 1
  kind: 'known-anchor-ref' | 'uncertain-start-without-ref'
  expected: NativeAcquisitionPreparedExpectation
  processRef?: SupervisedProcessRef
  startResult: HostedNativeAnchorStartResult
}>

export type NativeAcquisitionNoEffectProof = Readonly<{
  kind: 'pre-start-failure'
  expected: NativeAcquisitionPreparedExpectation
  startWasNeverCalled: true
  claimSettled: true
  observedAt: string
  reason: string
}>

export type NativeAcquisitionDrainProof = Readonly<{
  kind: 'exact-anchor-terminal'
  identity: OwnedNativeProcessIdentity
  adapterResult: Extract<HostedNativeAnchorStopResult, { status: 'drained' | 'already_drained' }>
  observedAt: string
}>

export type NativeAcquisitionRecorder = Readonly<{
  armAttempt(expected: NativeAcquisitionPreparedExpectation): Promise<void>
  recordAcquired(identity: OwnedNativeProcessIdentity): Promise<void>
  recordReady(input: Readonly<{ identity: OwnedNativeProcessIdentity; readinessProof: NativeProcessReadinessProof }>): Promise<void>
  recordUncertain(input: Readonly<{ attempt: NativeAcquisitionFailedAttempt; phase: string; adapterResult: HostedNativeAnchorStartResult | HostedNativeAnchorStopResult | HostedNativeAnchorObserveResult }>): Promise<void>
  recordDrained(proof: NativeAcquisitionDrainProof): Promise<void>
  recordNoEffect(proof: NativeAcquisitionNoEffectProof): Promise<void>
}>

export type NativeLeadIssuedAssociation = Readonly<{
  envelopePath: string
  readyAckPath: string
  envelope: HostedNativeLaunchEnvelope
  protectedRegistration: HostedCanonicalAuthorityProtectedRecord
}>

export type NativePreparedAttemptInput = Readonly<{
  memberOrdinal: number
  role: NativeAcquisitionRole
  attemptToken: string
  binding: HostedNativeAnchorUnitBinding
  runtimeEventsPath?: string
  bootstrapProofToken?: string
  bootstrapRunId?: string
  lead?: NativeLeadIssuedAssociation
}>

export type PreparedNativeProcessRecipe = Readonly<{
  expected: NativeAcquisitionPreparedExpectation
  command: string
  argv: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  lead?: NativeLeadIssuedAssociation
  runtimeEventsPath?: string
  bootstrapProofToken?: string
  bootstrapRunId?: string
}>

export type PreparedOpenCodeMember = Readonly<{
  kind: 'opencode-session'
  memberOrdinal: number
  sessionBarrierId: string
  sessionId: string
  metadataBarrier: Readonly<{
    publicTeamId: string
    legacyKey: string
    runId: string
    materialDigest: string
    agentId: string
    displayName: string
    mailboxCustody: 'external-session'
  }>
  externalLeadRegistration?: Readonly<{
    publicTeamId: string
    legacyKey: string
    canonicalDataRoot: string
    canonicalTeamRoot: string
    canonicalTasksRoot: string
    canonicalCwd: string
    runId: string
    primaryDisplayName: string
    primaryAgentId: string
    sessionId: string
    externalIdentityToken: string
    materialDigest: string
    profileDigest: string
  }>
}>

export type PreparedNativeProcessAcquisition = Readonly<{
  version: 1
  material: NativeProcessLaunchMaterial
  anchorAdmissionId: string
  launchCatalog: NodeAnchorLaunchAuthorityCatalog
  catalogDigest: string
  recipes: readonly PreparedNativeProcessRecipe[]
  openCodeMembers: readonly PreparedOpenCodeMember[]
}>

export type PrepareNativeProcessAcquisitionInput = Readonly<{
  material: NativeProcessLaunchMaterial
  admittedLibrary: LoadedHostedOwnerAnchorLibrary
  launchCatalog: NodeAnchorLaunchAuthorityCatalog
  nativeAttempts: readonly NativePreparedAttemptInput[]
  openCodeMembers: readonly PreparedOpenCodeMember[]
}>

function stable(value: unknown): string {
  // This is a deterministic hash preimage, not a JSON document or persistence
  // codec. Bigint has its own unquoted primitive domain so its exact decimal
  // value cannot collide with a number, string, array, or tag-shaped object.
  if (typeof value === 'bigint') return `bigint:${value.toString(10)}`
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export function computeNativeLaunchCatalogDigest(catalog: NodeAnchorLaunchAuthorityCatalog): string {
  return hash(catalog)
}

export function computeNativeProductPlanRefDigest(planRef: unknown): `sha256:${string}` {
  return `sha256:${hash(planRef)}`
}

function exactProtectedLaunch(envelope: HostedNativeLaunchEnvelope): HostedCanonicalAuthorityProtectedRecord['launch'] {
  const { canonicalAuthority: _authority, ...launch } = envelope
  return launch
}

function memberAt(material: NativeProcessLaunchMaterial, ordinal: number): NativeResolvedMemberMaterial {
  const member = material.members.find(candidate => candidate.ordinal === ordinal)
  if (!member) throw new Error(`Native acquisition member ordinal is not admitted: ${ordinal}`)
  return member
}

function requireAttemptPath(pathValue: string, root: string, token: string, label: string): void {
  if (!isAbsolute(pathValue) || resolve(pathValue) !== pathValue || !pathValue.startsWith(`${root}${sep}`) || !pathValue.includes(`${sep}${token}${sep}`)) {
    throw new Error(`Native acquisition ${label} is not attempt-private and canonical`)
  }
}

function requireBinding(material: NativeProcessLaunchMaterial, member: NativeResolvedMemberMaterial, binding: HostedNativeAnchorUnitBinding, argv: readonly string[], argvHash: string): void {
  if (binding.ownerPlanGeneration !== material.ownerPlanGeneration || binding.orderedMembers.length !== 1 ||
    binding.orderedMembers[0]?.ordinal !== member.ordinal || binding.orderedMembers[0]?.memberId !== member.agentId ||
    binding.executionUnit.memberIds.length !== 1 || binding.executionUnit.memberIds[0] !== member.agentId ||
    binding.executionUnit.laneId !== member.laneId || binding.launchSpec.executionUnitId !== binding.executionUnit.executionUnitId ||
    binding.launchSpec.planRef.generation !== material.productPlanGeneration || computeNativeProductPlanRefDigest(binding.launchSpec.planRef) !== material.productPlanRef ||
    !isDeepStrictEqual(binding.launchSpec.argvAuthority.argv, argv) ||
    binding.launchSpec.argvAuthority.argvHash !== argvHash ||
    binding.launchSpec.argvAuthority.executableRef !== material.cli.executable.executableRef ||
    binding.launchSpec.argvAuthority.binaryPolicy.policy !== 'registered_exact_binary' ||
    binding.launchSpec.argvAuthority.binaryPolicy.binaryId !== material.cli.executable.binaryId ||
    binding.launchSpec.argvAuthority.binaryPolicy.binaryRevision !== material.cli.executable.binaryRevision ||
    binding.launchSpec.argvAuthority.binaryPolicy.binaryHash !== material.cli.executable.binaryHash ||
    !isDeepStrictEqual(binding.executionUnit.binaryPolicy, binding.launchSpec.argvAuthority.binaryPolicy) ||
    binding.launchSpec.workdirAuthority.workdirRef !== material.workdirRef ||
    binding.launchSpec.environmentAuthority.environmentRef !== member.profile.environmentRef ||
    !isDeepStrictEqual(binding.executionUnit.environmentPolicy, binding.launchSpec.environmentAuthority.policy) ||
    !isDeepStrictEqual(binding.executionUnit.resourcePolicy, binding.launchSpec.resourcePolicy)) {
    throw new Error('Native acquisition binding does not exactly match its prepared recipe')
  }
}

function requireCatalogRecipe(catalog: NodeAnchorLaunchAuthorityCatalog, material: NativeProcessLaunchMaterial, member: NativeResolvedMemberMaterial,
  binding: HostedNativeAnchorUnitBinding, env: Readonly<Record<string, string>>): void {
  const executable = catalog.executables.find(candidate => candidate.executableRef === material.cli.executable.executableRef)
  const workdir = catalog.workdirs.find(candidate => candidate.workdirRef === material.workdirRef)
  const environment = catalog.environments.find(candidate => candidate.environmentRef === member.profile.environmentRef)
  if (!executable || executable.executablePath !== material.cli.executable.canonicalPath ||
    !isDeepStrictEqual(executable.binaryPolicy, binding.launchSpec.argvAuthority.binaryPolicy) || !workdir ||
    workdir.workdirPath !== material.roots.cwd.canonicalPath || !isDeepStrictEqual(workdir.grant, binding.launchSpec.workdirAuthority.grant) ||
    !environment || !isDeepStrictEqual(environment.policy, binding.launchSpec.environmentAuthority.policy) || !isDeepStrictEqual(environment.values, env)) {
    throw new Error('Native acquisition recipe does not exactly join the admitted launch catalog')
  }
}

function leadAssociation(material: NativeProcessLaunchMaterial, member: NativeResolvedMemberMaterial, attempt: NativePreparedAttemptInput): NativeLeadIssuedAssociation {
  const association = attempt.lead
  const computedEnvelopeDigest = association ? (() => {
    const { envelopeDigest: _digest, ...unsigned } = association.envelope
    return computeHostedNativeEnvelopeDigest(unsigned)
  })() : undefined
  if (!association || attempt.attemptToken !== association.envelope.launchIdentityToken || association.readyAckPath !== association.envelope.readyAckPath ||
    association.envelope.canonicalAuthority == null || association.envelope.envelopeDigest !== computedEnvelopeDigest ||
    association.envelope.materialDigest !== material.materialDigest || association.envelope.profileDigest !== member.profileDigest ||
    association.envelope.settingsDigest !== material.settings.sha256.slice('sha256:'.length) ||
    association.envelope.mcpDigest !== material.mcpConfig.sha256.slice('sha256:'.length) ||
    association.envelope.publicTeamId !== material.publicTeamId || association.envelope.legacyKey !== material.legacyKey ||
    association.envelope.runId !== material.runId || association.envelope.primary.agentId !== member.agentId ||
    association.envelope.primary.displayName !== member.displayName || association.envelope.primary.provider !== member.provider ||
    !isDeepStrictEqual(association.protectedRegistration.registration, association.envelope.canonicalAuthority) ||
    !isDeepStrictEqual(association.protectedRegistration.launch, exactProtectedLaunch(association.envelope))) {
    throw new Error('Native lead requires its exact finalized issued envelope and protected authority association')
  }
  return deepFreeze(structuredClone(association))
}

export async function prepareNativeProcessAcquisition(input: PrepareNativeProcessAcquisitionInput): Promise<PreparedNativeProcessAcquisition> {
  await preflightNativeProcessLaunch(input.material)
  if (input.admittedLibrary.admission.admissionId !== input.material.anchorCapability.admissionId ||
    input.admittedLibrary.library.NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_VERSION !== input.material.anchorCapability.version ||
    input.admittedLibrary.library.NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH !== input.material.anchorCapability.hash) {
    throw new Error('Native acquisition admitted anchor library does not match material capability')
  }
  const launchCatalog = deepFreeze(structuredClone(input.launchCatalog))
  const catalogDigest = computeNativeLaunchCatalogDigest(launchCatalog)
  const byOrdinal = new Map(input.nativeAttempts.map(attempt => [attempt.memberOrdinal, attempt]))
  if (byOrdinal.size !== input.nativeAttempts.length) throw new Error('Native acquisition has duplicate prepared native attempts')
  const openCode = new Map(input.openCodeMembers.map(member => [member.memberOrdinal, member]))
  if (openCode.size !== input.openCodeMembers.length) throw new Error('Native acquisition has duplicate OpenCode admission')
  const recipes: PreparedNativeProcessRecipe[] = []
  const attemptTokens = new Set<string>()
  for (const member of input.material.members) {
    if (member.provider === 'opencode') {
      const admitted = openCode.get(member.ordinal)
      const barrier = admitted?.metadataBarrier
      if (!admitted?.sessionBarrierId || !admitted.sessionId || !barrier || barrier.publicTeamId !== input.material.publicTeamId ||
        barrier.legacyKey !== input.material.legacyKey || barrier.runId !== input.material.runId || barrier.materialDigest !== input.material.materialDigest ||
        barrier.agentId !== member.agentId || barrier.displayName !== member.displayName || barrier.mailboxCustody !== 'external-session' ||
        (member.ordinal === input.material.primaryOrdinal && !admitted.externalLeadRegistration)) {
        throw new Error('OpenCode member lacks its admitted session barrier or external lead registration')
      }
      if (member.ordinal === input.material.primaryOrdinal) {
        const registration = admitted.externalLeadRegistration!
        if (registration.publicTeamId !== input.material.publicTeamId || registration.legacyKey !== input.material.legacyKey ||
          registration.canonicalDataRoot !== input.material.roots.data.canonicalPath || registration.canonicalTeamRoot !== input.material.roots.team.canonicalPath ||
          registration.canonicalTasksRoot !== input.material.roots.tasks.canonicalPath || registration.canonicalCwd !== input.material.roots.cwd.canonicalPath ||
          registration.runId !== input.material.runId || registration.primaryDisplayName !== member.displayName || registration.primaryAgentId !== member.agentId ||
          registration.sessionId !== admitted.sessionId || registration.materialDigest !== input.material.materialDigest || registration.profileDigest !== member.profileDigest ||
          !registration.externalIdentityToken) throw new Error('OpenCode primary external-lead registration is not exact')
      }
      if (byOrdinal.has(member.ordinal)) throw new Error('OpenCode member cannot have a native attempt')
      continue
    }
    const attempt = byOrdinal.get(member.ordinal)
    if (!attempt || !/^[A-Za-z0-9:_-]{16,256}$/.test(attempt.attemptToken) || attemptTokens.has(attempt.attemptToken) ||
      attempt.role !== (member.ordinal === input.material.primaryOrdinal ? 'native-lead' : 'native-worker')) {
      throw new Error('Whole native roster lacks an exact prepared attempt')
    }
    attemptTokens.add(attempt.attemptToken)
    const flags = buildResolvedNativeProcessFlags({ model: member.model, effort: member.effort, settingsPath: input.material.settings.canonicalPath,
      mcpConfigPath: input.material.mcpConfig.canonicalPath, disallowedTools: input.material.disallowedTools, strictMcpConfig: true })
    let argv: readonly string[]; let env: Readonly<Record<string, string>>; let lead: NativeLeadIssuedAssociation | undefined
    if (attempt.role === 'native-lead') {
      lead = leadAssociation(input.material, member, attempt)
      for (const [label, pathValue] of Object.entries({ envelope: lead.envelopePath, readyAck: lead.readyAckPath,
        bootstrapSpec: lead.envelope.bootstrapSpecPath, userPrompt: lead.envelope.userPromptFilePath })) {
        requireAttemptPath(pathValue, input.material.roots.data.canonicalPath, attempt.attemptToken, label)
      }
      argv = Object.freeze([...input.material.cli.argv,
        '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--team-bootstrap-spec', lead.envelope.bootstrapSpecPath, '--team-bootstrap-user-prompt-file', lead.envelope.userPromptFilePath,
        '--hosted-native-launch', lead.envelopePath, '--hosted-native-launch-identity', attempt.attemptToken,
        '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', ...flags])
      env = Object.freeze(buildResolvedNativeProcessEnv({ provider: member.provider, canonicalDataRoot: input.material.roots.data.canonicalPath, frozenEnv: member.profile.frozenEnv }))
    } else {
      if (!attempt.runtimeEventsPath || !attempt.bootstrapProofToken || !attempt.bootstrapRunId || attempt.bootstrapRunId !== input.material.runId) {
        throw new Error('Native worker lacks frozen attempt-specific readiness inputs')
      }
      requireAttemptPath(attempt.runtimeEventsPath, input.material.roots.team.canonicalPath, attempt.attemptToken, 'runtime events')
      argv = Object.freeze([...input.material.cli.argv, '--teammate-runtime', 'headless', '--agent-id', member.agentId, '--agent-name', member.displayName,
        '--team-name', input.material.legacyKey, '--parent-session-id', input.material.runId, '--process-owner-token', attempt.attemptToken,
        ...(member.agentType ? ['--agent-type', member.agentType] : []),
        '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', ...flags])
      env = Object.freeze(buildResolvedNativeProcessEnv({ provider: member.provider, canonicalDataRoot: input.material.roots.data.canonicalPath,
        frozenEnv: member.profile.frozenEnv, runtimeEnv: { CLAUDE_CODE_TEAMMATE_RUNTIME: 'headless',
          CLAUDE_CODE_TEAMMATE_RUNTIME_EVENTS_PATH: attempt.runtimeEventsPath, CLAUDE_CODE_BOOTSTRAP_PROOF_TOKEN: attempt.bootstrapProofToken,
          CLAUDE_CODE_BOOTSTRAP_RUN_ID: attempt.bootstrapRunId } }))
    }
    const binding = deepFreeze(structuredClone(attempt.binding))
    requireBinding(input.material, member, binding, argv, input.admittedLibrary.library.computeCanonicalArgvDigest(argv))
    requireCatalogRecipe(launchCatalog, input.material, member, binding, env)
    const logical = { version: 1 as const, role: attempt.role, publicTeamId: input.material.publicTeamId, legacyKey: input.material.legacyKey,
      runId: input.material.runId, attemptSetId: input.material.attemptSetId, attemptToken: attempt.attemptToken, memberOrdinal: member.ordinal,
      laneId: member.laneId, displayName: member.displayName, agentId: member.agentId, provider: member.provider, model: member.model,
      ...(member.effort ? { effort: member.effort } : {}), ownerBootId: input.material.ownerBootId,
      ownerControllerInstanceId: input.material.ownerControllerInstanceId, ownerPlanGeneration: input.material.ownerPlanGeneration,
      productPlanGeneration: input.material.productPlanGeneration, productPlanRef: input.material.productPlanRef,
      materialDigest: input.material.materialDigest, profileDigest: member.profileDigest, binding }
    const recipeDigest = hash({ logical, command: input.material.cli.executable.canonicalPath, argv, cwd: input.material.roots.cwd.canonicalPath, env, lead,
      runtimeEventsPath: attempt.runtimeEventsPath, bootstrapProofToken: attempt.bootstrapProofToken, bootstrapRunId: attempt.bootstrapRunId })
    recipes.push(Object.freeze({ expected: Object.freeze({ ...logical, recipeDigest }), command: input.material.cli.executable.canonicalPath,
      argv, cwd: input.material.roots.cwd.canonicalPath, env, ...(lead ? { lead } : {}), ...(attempt.runtimeEventsPath ? { runtimeEventsPath: attempt.runtimeEventsPath } : {}),
      ...(attempt.bootstrapProofToken ? { bootstrapProofToken: attempt.bootstrapProofToken } : {}), ...(attempt.bootstrapRunId ? { bootstrapRunId: attempt.bootstrapRunId } : {}) }))
  }
  if (recipes.length !== input.nativeAttempts.length || openCode.size !== input.openCodeMembers.length || recipes.length + openCode.size !== input.material.members.length) {
    throw new Error('Prepared acquisition does not cover the exact whole roster')
  }
  return Object.freeze({ version: 1, material: input.material, anchorAdmissionId: input.admittedLibrary.admission.admissionId,
    launchCatalog, catalogDigest, recipes: Object.freeze(recipes), openCodeMembers: deepFreeze(structuredClone(input.openCodeMembers)) })
}

export type NativeProcessAcquisitionOptions = Readonly<{
  admittedLibrary: LoadedHostedOwnerAnchorLibrary
  store: ProcessOwnershipStorePort
  ownerBinding: ProcessOwnerBinding
  controllerInstanceId: ProcessControllerInstanceId
  launchCatalog: NodeAnchorLaunchAuthorityCatalog
  launchCatalogDigest: string
  neutralWorkingDirectory: string
  launchTimeoutMs: number
  stopTimeoutMs: number
  recoveryTimeoutMs: number
  readinessPollMs: number
  prepared: PreparedNativeProcessAcquisition
}>

export type NativeLaunchInput = Readonly<{
  memberOrdinal: number
  recorder: NativeAcquisitionRecorder
  cancellation: RuntimeCancellation
  effectAuthorization: NativeAttemptEffectAuthorization
}>

export type NativeProcessInspection = Readonly<{
  ownership: HostedNativeAnchorObserveResult
  runtimeReadiness: 'not-recorded' | 'ready'
  identity: OwnedNativeProcessIdentity
}>

export type NativeProcessAcquisition = Readonly<{
  launchOwnedNativeLead(input: NativeLaunchInput): Promise<OwnedNativeProcessIdentity>
  launchOwnedNativeWorker(input: NativeLaunchInput): Promise<OwnedNativeProcessIdentity>
  inspectOwnedNativeProcess(identity: OwnedNativeProcessIdentity): Promise<NativeProcessInspection>
  writeOwnedNativeInput(input: Readonly<{ identity: OwnedNativeProcessIdentity; bytes: string | Uint8Array }>): Promise<void>
  stopOwnedNativeProcess(input: Readonly<{ identity: OwnedNativeProcessIdentity; mode: 'graceful' | 'immediate'; cancellation: RuntimeCancellation; recorder: NativeAcquisitionRecorder }>): Promise<HostedNativeAnchorStopResult>
  reconcileFailedAttempt(input: Readonly<{ attempt: NativeAcquisitionFailedAttempt; mode: 'graceful' | 'immediate'; cancellation: RuntimeCancellation; recorder: NativeAcquisitionRecorder }>): Promise<HostedNativeAnchorStopResult | { status: 'unresolved_without_anchor_ref' | 'attempt_not_retained' }>
  adoptOwnedNativeLead(identity: OwnedNativeProcessIdentity): never
}>

function createStdioCustodian(timeoutMs: number): Readonly<{
  claim: HostedNativeAnchorAdapterOptions['claimProviderStdio']
  write(processRef: SupervisedProcessRef, bytes: string | Uint8Array): Promise<void>
}> {
  const inputs = new Map<SupervisedProcessRef, { stdin: Writable; queue: Promise<void>; failed?: Error; releasing: boolean }>()
  const claim: HostedNativeAnchorAdapterOptions['claimProviderStdio'] = ({ processRef, stdio }) => {
    const consume = (stream: NodeJS.ReadableStream): Promise<Error | null> => new Promise(resolve => {
      stream.on('data', () => undefined)
      stream.once('end', () => resolve(null)); stream.once('close', () => resolve(null)); stream.once('error', error => resolve(error))
      stream.resume()
    })
    const stdout = consume(stdio.stdout); const stderr = consume(stdio.stderr)
    const input = { stdin: stdio.stdin as Writable, queue: Promise.resolve(), releasing: false } as {
      stdin: Writable; queue: Promise<void>; failed?: Error; releasing: boolean
    }
    stdio.stdin.on('error', error => { input.failed = error })
    inputs.set(processRef, input)
    let releaseInFlight: Promise<void> | undefined
    let released = false
    return { processRef, stdoutConsumption: 'attached', stderrConsumption: 'attached', release: () => {
      input.releasing = true
      if (released) return Promise.resolve()
      if (releaseInFlight) return releaseInFlight
      const settlement = Promise.all([stdout, stderr, input.queue.then(() => null, error => error instanceof Error ? error : new Error(String(error)))]).then(errors => {
          const error = errors.find(candidate => candidate !== null)
          if (error) throw error
        })
      const attempt = new Promise<void>((resolveAttempt, rejectAttempt) => {
        const timer = setTimeout(() => rejectAttempt(new Error('hosted-native-stdio-consumer-settlement-timeout')), timeoutMs)
        settlement.then(value => { clearTimeout(timer); resolveAttempt(value) }, error => { clearTimeout(timer); rejectAttempt(error) })
      })
      const published = attempt.then(() => {
        released = true
        inputs.delete(processRef)
      }).finally(() => {
        if (releaseInFlight === published) releaseInFlight = undefined
      })
      releaseInFlight = published
      return releaseInFlight
    } }
  }
  return Object.freeze({ claim, write: async (processRef, bytes) => {
    const input = inputs.get(processRef)
    const length = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength
    if (!input || input.failed || input.releasing || length < 1 || length > 1024 * 1024) throw input?.failed ?? new Error('Hosted native provider input is unavailable or invalid')
    const write = input.queue.then(() => new Promise<void>((resolveWrite, rejectWrite) => {
      if (input.failed || input.stdin.destroyed || !input.stdin.writable) return rejectWrite(input.failed ?? new Error('Hosted native provider input is closed'))
      input.stdin.write(bytes, error => error ? rejectWrite(error) : resolveWrite())
    }))
    input.queue = write.catch(error => { input.failed = error instanceof Error ? error : new Error(String(error)) })
    return write
  } })
}

function authorizationFieldsAreCurrent(recipe: PreparedNativeProcessRecipe, authorization: NativeAttemptEffectAuthorization,
  snapshot?: Readonly<{ authorizationId: string; ownerBootId: string; ownerControllerInstanceId: string; attemptToken: string; deadlineMs: number }>): boolean {
  return !!authorization && authorization.attemptToken === recipe.expected.attemptToken && authorization.ownerBootId === recipe.expected.ownerBootId &&
    authorization.ownerControllerInstanceId === recipe.expected.ownerControllerInstanceId && !!authorization.authorizationId &&
    Number.isFinite(authorization.deadlineMs) && Date.now() < authorization.deadlineMs && (!snapshot ||
      (authorization.authorizationId === snapshot.authorizationId && authorization.ownerBootId === snapshot.ownerBootId &&
        authorization.ownerControllerInstanceId === snapshot.ownerControllerInstanceId && authorization.attemptToken === snapshot.attemptToken &&
        authorization.deadlineMs === snapshot.deadlineMs))
}

async function validateAuthorization(recipe: PreparedNativeProcessRecipe, authorization: NativeAttemptEffectAuthorization): Promise<void> {
  if (!authorization || authorization.attemptToken !== recipe.expected.attemptToken || authorization.ownerBootId !== recipe.expected.ownerBootId ||
    authorization.ownerControllerInstanceId !== recipe.expected.ownerControllerInstanceId || !authorization.authorizationId ||
    !Number.isFinite(authorization.deadlineMs) || Date.now() >= authorization.deadlineMs) throw new Error('Native acquisition effect authorization is absent, stale, or mismatched')
  const snapshot = Object.freeze({ authorizationId: authorization.authorizationId, ownerBootId: authorization.ownerBootId,
    ownerControllerInstanceId: authorization.ownerControllerInstanceId, attemptToken: authorization.attemptToken, deadlineMs: authorization.deadlineMs })
  await authorization.assertCurrent()
  if (!authorizationFieldsAreCurrent(recipe, authorization, snapshot)) throw new Error('Native acquisition effect authorization expired or changed during validation')
}

function requireStartEffectBoundary(recipe: PreparedNativeProcessRecipe, authorization: NativeAttemptEffectAuthorization,
  cancellation: RuntimeCancellation): void {
  if (!authorizationFieldsAreCurrent(recipe, authorization) || cancellation.isCancellationRequested()) {
    throw new Error('Native acquisition start authorization was cancelled, expired, or changed at the effect boundary')
  }
}

function exactRecipe(prepared: PreparedNativeProcessAcquisition, ordinal: number, role: NativeAcquisitionRole): PreparedNativeProcessRecipe {
  const recipe = prepared.recipes.find(candidate => candidate.expected.memberOrdinal === ordinal)
  if (!recipe || recipe.expected.role !== role) throw new Error('Requested native acquisition recipe is not admitted')
  return recipe
}

function exactIdentity(identity: OwnedNativeProcessIdentity, recipe: PreparedNativeProcessRecipe, controller: string): void {
  const { kind, processRef: _processRef, runtimeSessionId: _runtimeSessionId, readiness: _readiness, diagnostics: _diagnostics, ...expected } = identity
  if (kind !== 'hosted-anchor' || identity.ownerControllerInstanceId !== controller || !isDeepStrictEqual(expected, recipe.expected)) {
    throw new Error('Hosted anchor identity is foreign to this live controller')
  }
}

function ackMatches(ack: HostedNativeReadyAcknowledgement, recipe: PreparedNativeProcessRecipe, sinceMs: number): boolean {
  const envelope = recipe.lead!.envelope
  const acknowledgedAt = Date.parse(ack.acknowledgedAt)
  return ack.version === 1 && ack.state === 'ready' && ack.role === 'native-lead' && ack.runId === recipe.expected.runId && ack.publicTeamId === recipe.expected.publicTeamId &&
    ack.legacyKey === recipe.expected.legacyKey && ack.primaryAgentId === recipe.expected.agentId && ack.primaryDisplayName === recipe.expected.displayName &&
    ack.primaryAlias === TEAM_LEAD_NAME && ack.launchIdentityToken === recipe.expected.attemptToken && ack.envelopeDigest === envelope.envelopeDigest &&
    ack.materialDigest === recipe.expected.materialDigest && ack.profileDigest === recipe.expected.profileDigest && ack.settingsDigest === recipe.lead!.envelope.settingsDigest &&
    ack.mcpDigest === recipe.lead!.envelope.mcpDigest && ack.permissionMode === 'bypassPermissions' && ack.canonicalDataRoot === recipe.lead!.envelope.canonicalDataRoot &&
    ack.canonicalTeamRoot === recipe.lead!.envelope.canonicalTeamRoot && ack.canonicalTasksRoot === recipe.lead!.envelope.canonicalTasksRoot &&
    ack.canonicalCwd === recipe.lead!.envelope.canonicalCwd && ack.mailboxCustody === 'hosted-lead-pump' && !!ack.sessionId && Number.isSafeInteger(ack.pid) && ack.pid > 0 &&
    Number.isFinite(ack.processStartedAtMs) && ack.processStartedAtMs > 0 && typeof ack.processOsIdentity === 'string' && ack.processOsIdentity.length > 0 &&
    Number.isFinite(acknowledgedAt) && acknowledgedAt >= sinceMs && acknowledgedAt <= Date.now()
}

function strictEvent(event: TeammateRuntimeEvent, recipe: PreparedNativeProcessRecipe, type: TeammateRuntimeEvent['type'], sinceMs: number, pid?: number, session?: string): boolean {
  const timestamp = Date.parse(event.timestamp)
  return event.type === type && Number.isSafeInteger(event.pid) && event.pid > 0 && (pid === undefined || event.pid === pid) &&
    event.teamName === recipe.expected.legacyKey && event.agentName === recipe.expected.displayName && event.agentId === recipe.expected.agentId &&
    event.bootstrapRunId === recipe.bootstrapRunId && typeof event.runId === 'string' && event.runId.length > 0 && (session === undefined || event.runId === session) &&
    Number.isFinite(timestamp) && timestamp >= sinceMs && timestamp <= Date.now()
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function requireActive(cancellation: RuntimeCancellation, deadlineMs: number): void {
  if (Date.now() >= deadlineMs || cancellation.isCancellationRequested()) throw new Error('Native acquisition readiness was cancelled or expired')
}

function unavailableKnownStart(processRef: SupervisedProcessRef): HostedNativeAnchorStartResult {
  return Object.freeze({
    status: 'uncertain',
    productResult: Object.freeze({ status: 'rejected', reason: 'unavailable' }),
    processRef,
    disposition: Object.freeze({ required: true, reason: 'start_result_uncertain' }),
  })
}

export function createNativeProcessAcquisition(options: NativeProcessAcquisitionOptions): NativeProcessAcquisition {
  if (!options.store || options.prepared.catalogDigest !== options.launchCatalogDigest || hash(options.launchCatalog) !== options.launchCatalogDigest ||
    !isDeepStrictEqual(options.prepared.launchCatalog, options.launchCatalog) ||
    options.prepared.anchorAdmissionId !== options.admittedLibrary.admission.admissionId ||
    options.prepared.material.ownerControllerInstanceId !== String(options.controllerInstanceId) || !Number.isFinite(options.readinessPollMs) || options.readinessPollMs <= 0) {
    throw new Error('Native acquisition Owner lifetime inputs or frozen catalog do not match')
  }
  const stdioCustodian = createStdioCustodian(options.stopTimeoutMs)
  const adapter = new HostedNativeAnchorAdapter({ admittedLibrary: options.admittedLibrary, store: options.store, ownerBinding: options.ownerBinding,
    controllerInstanceId: options.controllerInstanceId, launchCatalog: options.launchCatalog, neutralWorkingDirectory: options.neutralWorkingDirectory,
    launchTimeoutMs: options.launchTimeoutMs, stopTimeoutMs: options.stopTimeoutMs, recoveryTimeoutMs: options.recoveryTimeoutMs,
    claimProviderStdio: stdioCustodian.claim })
  const retained = new Map<string, OwnedNativeProcessIdentity>()
  const acquiredStarts = new Map<string, Extract<HostedNativeAnchorStartResult, { status: 'started' | 'already_started' }>>()
  const failed = new Map<string, NativeAcquisitionFailedAttempt>()
  type ExactTerminalCustody = {
    identity: OwnedNativeProcessIdentity
    attempt: NativeAcquisitionFailedAttempt
    result: Extract<HostedNativeAnchorStopResult, { status: 'drained' | 'already_drained' }>
    drainedPublished: boolean
    claimSettled: boolean
  }
  const exactTerminalCustody = new Map<string, ExactTerminalCustody>()
  const terminalIdentities = new Map<string, Readonly<{ identity: OwnedNativeProcessIdentity; attempt: NativeAcquisitionFailedAttempt }>>()
  const reconcileInFlight = new Map<string, Promise<HostedNativeAnchorStopResult | { status: 'unresolved_without_anchor_ref' | 'attempt_not_retained' }>>()
  type StopOperation = { identity: OwnedNativeProcessIdentity; active: boolean; promise: Promise<HostedNativeAnchorStopResult> }
  type StopContext = { operation: StopOperation }
  const stopContext = new AsyncLocalStorage<StopContext>()
  const stopInFlight = new Map<string, StopOperation>()
  const stopRequested = new Set<string>()
  type AttemptLifecycle =
    | Readonly<{ status: 'in-flight'; promise: Promise<OwnedNativeProcessIdentity> }>
    | Readonly<{ status: 'ready'; identity: OwnedNativeProcessIdentity }>
    | Readonly<{ status: 'failed'; error: unknown }>
    | Readonly<{ status: 'terminal' }>
  const attemptLifecycles = new Map<string, AttemptLifecycle>()

  let compensateAcquiredFailure!: (recipe: PreparedNativeProcessRecipe, identity: OwnedNativeProcessIdentity, input: NativeLaunchInput,
    cause: unknown, worker: boolean) => Promise<never>
  let settleExactStop!: (input: Parameters<NativeProcessAcquisition['stopOwnedNativeProcess']>[0],
    phases: Readonly<{ uncertain: string; publication: string }>) => Promise<HostedNativeAnchorStopResult>

  const primaryMetadataIsReady = (team: Readonly<TeamFile>): boolean => {
    const material = options.prepared.material
    const primary = memberAt(material, material.primaryOrdinal)
    const registered = team.members.find(member => member.agentId === primary.agentId && member.name === primary.displayName)
    const hosted = team.hostedNative
    if (!registered?.sessionId || !hosted || team.leadAgentId !== primary.agentId || team.leadSessionId !== registered.sessionId ||
      hosted.publicTeamId !== material.publicTeamId || hosted.legacyKey !== material.legacyKey || hosted.runId !== material.runId ||
      hosted.materialDigest !== material.materialDigest || hosted.profileDigest !== primary.profileDigest || hosted.primaryAgentId !== primary.agentId ||
      hosted.primaryDisplayName !== primary.displayName || hosted.primaryAlias !== TEAM_LEAD_NAME || hosted.permissionMode !== 'bypassPermissions') return false
    if (primary.provider === 'opencode') {
      const admitted = options.prepared.openCodeMembers.find(member => member.memberOrdinal === primary.ordinal)?.externalLeadRegistration
      return !!admitted && hosted.role === 'external-lead' && hosted.mailboxCustody === 'external-session' &&
        hosted.launchIdentityToken === admitted.externalIdentityToken && hosted.envelopeDigest === material.materialDigest && registered.sessionId === admitted.sessionId
    }
    const lead = options.prepared.recipes.find(recipe => recipe.expected.memberOrdinal === primary.ordinal)?.lead
    return !!lead && hosted.role === 'native-lead' && hosted.mailboxCustody === 'hosted-lead-pump' && hosted.launchIdentityToken === lead.envelope.launchIdentityToken &&
      hosted.envelopeDigest === lead.envelope.envelopeDigest && hosted.readyAckPath === lead.readyAckPath
  }

  const live = async (recipe: PreparedNativeProcessRecipe, processRef: SupervisedProcessRef): Promise<void> => {
    const observed = await adapter.observe({ binding: recipe.expected.binding, processRef })
    if (observed.status !== 'ready' && observed.status !== 'starting') throw new Error(`Hosted anchor is not live: ${observed.status}`)
  }

  const anchorReady = async (recipe: PreparedNativeProcessRecipe, processRef: SupervisedProcessRef): Promise<void> => {
    const observed = await adapter.observe({ binding: recipe.expected.binding, processRef })
    if (observed.status !== 'ready') throw new Error(`Hosted anchor handshake is not ready: ${observed.status}`)
  }

  const start = async (recipe: PreparedNativeProcessRecipe, input: NativeLaunchInput, claimAcquired = false,
    executionStage?: { adapterStartWasCalled: boolean }): Promise<OwnedNativeProcessIdentity> => {
    if (!claimAcquired) {
      try {
        await preflightNativeProcessLaunch(options.prepared.material)
        await validateAuthorization(recipe, input.effectAuthorization)
        await input.recorder.armAttempt(recipe.expected)
        await validateAuthorization(recipe, input.effectAuthorization)
        requireStartEffectBoundary(recipe, input.effectAuthorization, input.cancellation)
      } catch (error) {
        await input.recorder.recordNoEffect({ kind: 'pre-start-failure', expected: recipe.expected, startWasNeverCalled: true, claimSettled: true,
          observedAt: new Date().toISOString(), reason: error instanceof Error ? error.message : String(error) }).catch(() => undefined)
        throw error
      }
    } else {
      await validateAuthorization(recipe, input.effectAuthorization)
      requireStartEffectBoundary(recipe, input.effectAuthorization, input.cancellation)
    }
    let result: HostedNativeAnchorStartResult
    if (executionStage) executionStage.adapterStartWasCalled = true
    try { result = await adapter.start(recipe.expected.binding, input.cancellation) } catch {
      result = { status: 'uncertain', productResult: { status: 'rejected', reason: 'unavailable' },
        disposition: { required: true, reason: 'start_result_uncertain' } }
    }
    if (result.status === 'uncertain') {
      const attempt: NativeAcquisitionFailedAttempt = Object.freeze({ version: 1, kind: result.processRef ? 'known-anchor-ref' : 'uncertain-start-without-ref',
        expected: recipe.expected, ...(result.processRef ? { processRef: result.processRef } : {}), startResult: result })
      failed.set(recipe.expected.attemptToken, attempt)
      try { await input.recorder.recordUncertain({ attempt, phase: 'start', adapterResult: result }) } catch (error) {
        throw new NativeProcessAcquisitionFailure(error instanceof Error ? error.message : String(error), attempt)
      }
      throw new NativeProcessAcquisitionFailure('Native anchor start is uncertain', attempt)
    }
    acquiredStarts.set(recipe.expected.attemptToken, result)
    const identity: OwnedNativeProcessIdentity = Object.freeze({ ...recipe.expected, kind: 'hosted-anchor', processRef: result.processRef })
    retained.set(recipe.expected.attemptToken, identity)
    try {
      await input.recorder.recordAcquired(identity)
    } catch (error) {
      return compensateAcquiredFailure(recipe, identity, input, error, claimAcquired)
    }
    return identity
  }

  const waitLead = async (recipe: PreparedNativeProcessRecipe, identity: OwnedNativeProcessIdentity, sinceMs: number, deadlineMs: number,
    cancellation: RuntimeCancellation, authorization: NativeAttemptEffectAuthorization): Promise<Extract<NativeProcessReadinessProof, { kind: 'hosted-native-ready-ack' }>> => {
    let last: unknown
    while (Date.now() < deadlineMs) {
      requireActive(cancellation, deadlineMs)
      await validateAuthorization(recipe, authorization)
      await live(recipe, identity.processRef)
      try {
        await anchorReady(recipe, identity.processRef)
        const acknowledgement = await readHostedNativeReadyAcknowledgement(recipe.lead!.readyAckPath)
        if (!ackMatches(acknowledgement, recipe, sinceMs)) throw new Error('Hosted native ready acknowledgement substitution')
        await anchorReady(recipe, identity.processRef)
        return Object.freeze({ kind: 'hosted-native-ready-ack', acknowledgement })
      } catch (error) { last = error }
      await delay(Math.min(options.readinessPollMs, Math.max(1, deadlineMs - Date.now())))
    }
    throw new Error(`Hosted native ready acknowledgement timed out: ${last instanceof Error ? last.message : 'missing'}`)
  }

  const waitStrictEvent = async (recipe: PreparedNativeProcessRecipe, identity: OwnedNativeProcessIdentity, type: TeammateRuntimeEvent['type'],
    sinceMs: number, deadlineMs: number, cancellation: RuntimeCancellation, authorization: NativeAttemptEffectAuthorization,
    pid?: number, session?: string): Promise<TeammateRuntimeEvent> => {
    while (Date.now() < deadlineMs) {
      requireActive(cancellation, deadlineMs)
      await validateAuthorization(recipe, authorization)
      await live(recipe, identity.processRef)
      const events = await readRecentTeammateRuntimeEvents(recipe.runtimeEventsPath!, { maxBytes: 4 * 1024 * 1024, maxLines: 4096 })
      const match = events.find(event => strictEvent(event, recipe, type, sinceMs, pid, session))
      if (match) { await anchorReady(recipe, identity.processRef); return match }
      await delay(Math.min(options.readinessPollMs, Math.max(1, deadlineMs - Date.now())))
    }
    throw new Error(`Native worker did not produce exact ${type}`)
  }

  const waitSubmission = async (recipe: PreparedNativeProcessRecipe, identity: OwnedNativeProcessIdentity, runtimeReady: TeammateRuntimeEvent,
    mailboxMessageId: string, sinceMs: number, deadlineMs: number, cancellation: RuntimeCancellation,
    authorization: NativeAttemptEffectAuthorization) => {
    while (Date.now() < deadlineMs) {
      requireActive(cancellation, deadlineMs)
      await validateAuthorization(recipe, authorization)
      await anchorReady(recipe, identity.processRef)
      const outcome = await waitForBootstrapSubmissionOutcome({ eventsPath: recipe.runtimeEventsPath!,
        timeoutMs: Math.min(Math.max(25, options.readinessPollMs * 2), Math.max(1, deadlineMs - Date.now())), pid: runtimeReady.pid,
        teamName: recipe.expected.legacyKey, agentName: recipe.expected.displayName, agentId: recipe.expected.agentId,
        bootstrapRunId: recipe.bootstrapRunId, bootstrapMirrorId: mailboxMessageId, bootstrapProofToken: recipe.bootstrapProofToken, sinceMs })
      if (outcome.type === 'submitted' || outcome.type === 'terminal_failure') return outcome
    }
    return { type: 'timeout', reason: 'strict hosted bootstrap submission deadline expired' } as const
  }

  const reserveWorker = async (recipe: PreparedNativeProcessRecipe): Promise<boolean> => {
    const material = options.prepared.material
    const member = memberAt(material, recipe.expected.memberOrdinal)
    const result = await updateTeamFileAtCanonicalRoot(material.roots.team.canonicalPath, material.legacyKey, current => {
      if (!primaryMetadataIsReady(current)) return { changed: false, teamFile: current as never }
      if (current.members.some(existing => existing.agentId === member.agentId || existing.name === member.displayName)) return { changed: false, teamFile: current as never }
      return { changed: true, teamFile: upsertTeamMember(current, { agentId: member.agentId, name: member.displayName, agentType: member.agentType,
        model: member.model, provider: recipe.expected.provider, effort: member.effort as never, prompt: member.prompt, joinedAt: Date.now(),
        tmuxPaneId: `hosted-anchor:${recipe.expected.attemptToken}`, cwd: material.roots.cwd.canonicalPath, processOwnerToken: recipe.expected.attemptToken,
        processRunId: material.runId, spawnClaimToken: recipe.expected.attemptToken, spawnClaimRunId: material.runId, spawnClaimRuntimeMayExist: false,
        subscriptions: [], backendType: 'process' }) }
    })
    return result.status === 'updated'
  }

  const settleWorkerClaim = async (recipe: PreparedNativeProcessRecipe, remove: boolean, runtimeSessionId?: string): Promise<void> => {
    const material = options.prepared.material
    const result = await updateTeamFileAtCanonicalRoot(material.roots.team.canonicalPath, material.legacyKey, current => {
      const member = current.members.find(candidate => candidate.agentId === recipe.expected.agentId && candidate.processOwnerToken === recipe.expected.attemptToken &&
        candidate.processRunId === recipe.expected.runId && candidate.tmuxPaneId === `hosted-anchor:${recipe.expected.attemptToken}`)
      if (!member) return { changed: false, teamFile: current as never }
      if (remove) return { changed: true, teamFile: { ...current, members: current.members.filter(candidate => candidate !== member) } }
      return { changed: true, teamFile: upsertTeamMember(current, { ...member, sessionId: runtimeSessionId, bootstrapProofToken: recipe.bootstrapProofToken,
        bootstrapRunId: recipe.bootstrapRunId, bootstrapRuntimeEventsPath: recipe.runtimeEventsPath, spawnClaimToken: undefined,
        spawnClaimRunId: undefined, spawnClaimRuntimeMayExist: undefined }) }
    })
    if (result.status === 'missing' || (!remove && result.status !== 'updated')) throw new Error('Native worker exact claim settlement failed')
  }

  const markWorkerMayExist = async (recipe: PreparedNativeProcessRecipe): Promise<void> => {
    const material = options.prepared.material
    const result = await updateTeamFileAtCanonicalRoot(material.roots.team.canonicalPath, material.legacyKey, current => {
      const member = current.members.find(candidate => candidate.agentId === recipe.expected.agentId && candidate.processOwnerToken === recipe.expected.attemptToken &&
        candidate.spawnClaimToken === recipe.expected.attemptToken && candidate.spawnClaimRunId === recipe.expected.runId)
      return member ? { changed: true, teamFile: upsertTeamMember(current, { ...member, spawnClaimRuntimeMayExist: true }) } : { changed: false, teamFile: current as never }
    })
    if (result.status !== 'updated') throw new Error('Native worker effect custody could not be published')
  }

  compensateAcquiredFailure = async (recipe: PreparedNativeProcessRecipe, identity: OwnedNativeProcessIdentity, input: NativeLaunchInput,
    cause: unknown, worker: boolean): Promise<never> => {
    const attempt: NativeAcquisitionFailedAttempt = exactTerminalCustody.get(identity.attemptToken)?.attempt ?? failed.get(identity.attemptToken) ??
      Object.freeze({ version: 1, kind: 'known-anchor-ref', expected: recipe.expected,
        processRef: identity.processRef, startResult: acquiredStarts.get(identity.attemptToken) ?? unavailableKnownStart(identity.processRef) })
    // Publish retry custody before any compensation await, while preserving an attempt
    // already installed by a direct stop that owns the live settlement.
    failed.set(identity.attemptToken, attempt)
    let result: HostedNativeAnchorStopResult
    try {
      result = await settleExactStop({ identity, mode: 'immediate', cancellation: input.cancellation, recorder: input.recorder },
        { uncertain: 'compensation', publication: 'compensation-publication' })
    } catch (error) {
      if (error instanceof NativeProcessAcquisitionFailure) throw error
      throw new NativeProcessAcquisitionFailure(error instanceof Error ? error.message : String(error), attempt)
    }
    if (result.status === 'drained' || result.status === 'already_drained') throw cause
    if (worker) await markWorkerMayExist(recipe).catch(() => undefined)
    throw new NativeProcessAcquisitionFailure(cause instanceof Error ? cause.message : String(cause), attempt)
  }

  const publishReady = async (recipe: PreparedNativeProcessRecipe, identity: OwnedNativeProcessIdentity,
    ready: OwnedNativeProcessIdentity, proof: NativeProcessReadinessProof, input: NativeLaunchInput): Promise<OwnedNativeProcessIdentity> => {
    await input.recorder.recordReady({ identity: ready, readinessProof: proof })
    const lifecycle = attemptLifecycles.get(recipe.expected.attemptToken)
    const current = retained.get(recipe.expected.attemptToken)
    if (stopRequested.has(recipe.expected.attemptToken) || lifecycle?.status !== 'in-flight' ||
      !current || current.processRef !== identity.processRef) {
      throw new Error('Native acquisition stop won over late readiness publication')
    }
    retained.set(recipe.expected.attemptToken, ready)
    return ready
  }

  const launchOwnedNativeLeadOnce = async (input: NativeLaunchInput): Promise<OwnedNativeProcessIdentity> => {
    const recipe = exactRecipe(options.prepared, input.memberOrdinal, 'native-lead')
    const sinceMs = Date.now()
    const identity = await start(recipe, input)
    try {
      const proof = await waitLead(recipe, identity, sinceMs, Math.min(input.effectAuthorization.deadlineMs, Date.now() + options.launchTimeoutMs),
        input.cancellation, input.effectAuthorization)
      const ready: OwnedNativeProcessIdentity = Object.freeze({ ...identity, runtimeSessionId: proof.acknowledgement.sessionId,
        readiness: proof, diagnostics: Object.freeze({ pid: proof.acknowledgement.pid, startedAtMs: proof.acknowledgement.processStartedAtMs, osIdentity: proof.acknowledgement.processOsIdentity }) })
      return await publishReady(recipe, identity, ready, proof, input)
    } catch (error) {
      if (stopRequested.has(recipe.expected.attemptToken)) throw error
      return compensateAcquiredFailure(recipe, identity, input, error, false)
    }
  }

  const launchOwnedNativeWorkerOnce = async (input: NativeLaunchInput): Promise<OwnedNativeProcessIdentity> => {
    const recipe = exactRecipe(options.prepared, input.memberOrdinal, 'native-worker')
    try {
      await preflightNativeProcessLaunch(options.prepared.material)
      await validateAuthorization(recipe, input.effectAuthorization)
      await input.recorder.armAttempt(recipe.expected)
    } catch (error) {
      await input.recorder.recordNoEffect({ kind: 'pre-start-failure', expected: recipe.expected, startWasNeverCalled: true, claimSettled: true,
        observedAt: new Date().toISOString(), reason: error instanceof Error ? error.message : String(error) }).catch(() => undefined)
      throw error
    }
    let reservationAcquired: boolean
    try { reservationAcquired = await reserveWorker(recipe) } catch (error) {
      // A thrown canonical update has no sufficiently strong result with which to claim that
      // metadata custody was settled. In particular, never delete a matching pre-existing member.
      throw error
    }
    if (!reservationAcquired) {
      const error = new Error('Native worker whole-roster reservation was not acquired')
      await input.recorder.recordNoEffect({ kind: 'pre-start-failure', expected: recipe.expected, startWasNeverCalled: true, claimSettled: true,
        observedAt: new Date().toISOString(), reason: error.message }).catch(() => undefined)
      throw error
    }
    try { await validateAuthorization(recipe, input.effectAuthorization) } catch (error) {
      let claimSettled = false
      try { await settleWorkerClaim(recipe, true); claimSettled = true } catch { /* retained for B reconciliation */ }
      if (claimSettled) await input.recorder.recordNoEffect({ kind: 'pre-start-failure', expected: recipe.expected, startWasNeverCalled: true, claimSettled: true,
        observedAt: new Date().toISOString(), reason: error instanceof Error ? error.message : String(error) }).catch(() => undefined)
      throw error
    }
    const sinceMs = Date.now()
    let identity: OwnedNativeProcessIdentity
    const executionStage = { adapterStartWasCalled: false }
    try { identity = await start(recipe, input, true, executionStage) } catch (error) {
      if (executionStage.adapterStartWasCalled) {
        if (error instanceof NativeProcessAcquisitionFailure) await markWorkerMayExist(recipe).catch(() => undefined)
      } else {
        let claimSettled = false
        try { await settleWorkerClaim(recipe, true); claimSettled = true } catch { /* retained for B reconciliation */ }
        if (claimSettled) await input.recorder.recordNoEffect({ kind: 'pre-start-failure', expected: recipe.expected, startWasNeverCalled: true,
          claimSettled: true, observedAt: new Date().toISOString(), reason: error instanceof Error ? error.message : String(error) }).catch(() => undefined)
      }
      throw error
    }
    try { await markWorkerMayExist(recipe) } catch (error) { return compensateAcquiredFailure(recipe, identity, input, error, true) }
    try {
      const deadlineMs = Math.min(input.effectAuthorization.deadlineMs, Date.now() + options.launchTimeoutMs)
      const runtimeReady = await waitStrictEvent(recipe, identity, 'runtime_ready', sinceMs, deadlineMs, input.cancellation, input.effectAuthorization)
      const runtimeSessionId = runtimeReady.runId!
      await settleWorkerClaim(recipe, false, runtimeSessionId)
      await validateAuthorization(recipe, input.effectAuthorization)
      const mailbox = await writeToMailboxAtCanonicalTeamRootVerified({ canonicalTeamRoot: options.prepared.material.roots.team.canonicalPath,
        recipientName: recipe.expected.displayName, message: { from: TEAM_LEAD_NAME, text: memberAt(options.prepared.material, recipe.expected.memberOrdinal).prompt, timestamp: new Date().toISOString() } })
      if (mailbox.kind === 'conflict') throw new Error('Native worker bootstrap mailbox message conflicted')
      const inboxPollerReady = await waitStrictEvent(recipe, identity, 'inbox_poller_ready', sinceMs, deadlineMs, input.cancellation,
        input.effectAuthorization, runtimeReady.pid, runtimeSessionId)
      await live(recipe, identity.processRef)
      const submission = await waitSubmission(recipe, identity, runtimeReady, mailbox.messageId, sinceMs, deadlineMs, input.cancellation,
        input.effectAuthorization)
      if (submission.type !== 'submitted' || !strictEvent(submission.event, recipe, submission.event.type, sinceMs, runtimeReady.pid, runtimeSessionId) ||
        (submission.acceptedVia === 'mirror' && submission.event.bootstrapMirrorId !== mailbox.messageId) ||
        (submission.acceptedVia !== 'mirror' && submission.event.bootstrapProofToken !== recipe.bootstrapProofToken)) {
        throw new Error('Native worker bootstrap submission proof is absent or substituted')
      }
      await anchorReady(recipe, identity.processRef)
      const proof: NativeProcessReadinessProof = Object.freeze({ kind: 'hosted-worker-runtime', runtimeReady, inboxPollerReady,
        bootstrapAccepted: submission.event, mailboxMessageId: mailbox.messageId, runtimeSessionId, diagnosticPid: runtimeReady.pid })
      const ready: OwnedNativeProcessIdentity = Object.freeze({ ...identity, runtimeSessionId, readiness: proof, diagnostics: Object.freeze({ pid: runtimeReady.pid }) })
      return await publishReady(recipe, identity, ready, proof, input)
    } catch (error) {
      if (stopRequested.has(recipe.expected.attemptToken)) throw error
      return compensateAcquiredFailure(recipe, identity, input, error, true)
    }
  }

  const replayAttempt = async (recipe: PreparedNativeProcessRecipe, input: NativeLaunchInput,
    lifecycle: AttemptLifecycle): Promise<OwnedNativeProcessIdentity> => {
    // Every caller proves its own current authority, but only the first caller's recorder and
    // cancellation participate in the one exact attempt. Replays never arm or publish it again.
    await validateAuthorization(recipe, input.effectAuthorization)
    requireActive(input.cancellation, input.effectAuthorization.deadlineMs)
    if (lifecycle.status === 'failed') throw lifecycle.error
    if (lifecycle.status === 'terminal') throw new Error('Native acquisition attempt is terminal and cannot be relaunched')
    const identity = lifecycle.status === 'ready' ? lifecycle.identity : await lifecycle.promise
    await validateAuthorization(recipe, input.effectAuthorization)
    requireActive(input.cancellation, input.effectAuthorization.deadlineMs)
    const currentLifecycle = attemptLifecycles.get(recipe.expected.attemptToken)
    const current = retained.get(recipe.expected.attemptToken)
    if (currentLifecycle?.status !== 'ready' || !current || current.processRef !== identity.processRef || !current.readiness) {
      throw new Error('Native acquisition attempt is not retained ready by this live controller')
    }
    await anchorReady(recipe, current.processRef)
    return current
  }

  const launchExactAttempt = (input: NativeLaunchInput, role: NativeAcquisitionRole,
    launchOnce: (input: NativeLaunchInput) => Promise<OwnedNativeProcessIdentity>): Promise<OwnedNativeProcessIdentity> => {
    const recipe = exactRecipe(options.prepared, input.memberOrdinal, role)
    const existing = attemptLifecycles.get(recipe.expected.attemptToken)
    if (existing) return replayAttempt(recipe, input, existing)
    let tracked!: Promise<OwnedNativeProcessIdentity>
    tracked = launchOnce(input).then(identity => {
      const lifecycle = attemptLifecycles.get(recipe.expected.attemptToken)
      const current = retained.get(recipe.expected.attemptToken)
      if (stopRequested.has(recipe.expected.attemptToken) || lifecycle?.status !== 'in-flight' ||
        !current || current !== identity || !identity.readiness) throw new Error('Native acquisition stop won before ready completion')
      attemptLifecycles.set(recipe.expected.attemptToken, Object.freeze({ status: 'ready', identity }))
      return identity
    }, error => {
      if (attemptLifecycles.get(recipe.expected.attemptToken)?.status === 'in-flight') {
        attemptLifecycles.set(recipe.expected.attemptToken, Object.freeze({ status: 'failed', error }))
      }
      throw error
    })
    attemptLifecycles.set(recipe.expected.attemptToken, Object.freeze({ status: 'in-flight', promise: tracked }))
    return tracked
  }

  const launchOwnedNativeLead = (input: NativeLaunchInput): Promise<OwnedNativeProcessIdentity> =>
    launchExactAttempt(input, 'native-lead', launchOwnedNativeLeadOnce)

  const launchOwnedNativeWorker = (input: NativeLaunchInput): Promise<OwnedNativeProcessIdentity> =>
    launchExactAttempt(input, 'native-worker', launchOwnedNativeWorkerOnce)

  const inspectOwnedNativeProcess = async (identity: OwnedNativeProcessIdentity): Promise<NativeProcessInspection> => {
    const recipe = exactRecipe(options.prepared, identity.memberOrdinal, identity.role); exactIdentity(identity, recipe, String(options.controllerInstanceId))
    const current = retained.get(identity.attemptToken)
    if (!current || current.processRef !== identity.processRef) throw new Error('Hosted anchor identity is not retained by this live controller')
    return Object.freeze({ ownership: await adapter.observe({ binding: current.binding, processRef: current.processRef }),
      runtimeReadiness: current.readiness ? 'ready' : 'not-recorded', identity: current })
  }

  const writeOwnedNativeInput: NativeProcessAcquisition['writeOwnedNativeInput'] = async input => {
    const recipe = exactRecipe(options.prepared, input.identity.memberOrdinal, input.identity.role)
    exactIdentity(input.identity, recipe, String(options.controllerInstanceId))
    const current = retained.get(input.identity.attemptToken)
    if (!current || current.processRef !== input.identity.processRef) throw new Error('Hosted anchor input identity is not retained by this live controller')
    await live(recipe, current.processRef)
    await stdioCustodian.write(current.processRef, input.bytes)
  }

  const validateStopIdentity = (identity: OwnedNativeProcessIdentity): PreparedNativeProcessRecipe => {
    const recipe = exactRecipe(options.prepared, identity.memberOrdinal, identity.role)
    exactIdentity(identity, recipe, String(options.controllerInstanceId))
    const token = recipe.expected.attemptToken
    const retainedIdentity = retained.get(token)
    const failedAttempt = failed.get(token)
    const terminalIdentity = exactTerminalCustody.get(token)?.identity ?? terminalIdentities.get(token)?.identity
    if (retainedIdentity?.processRef !== identity.processRef && failedAttempt?.processRef !== identity.processRef &&
      terminalIdentity?.processRef !== identity.processRef) {
      throw new Error('Hosted anchor stop identity ref is not retained for this exact attempt')
    }
    return recipe
  }

  const stopOwnedNativeProcessOnce = async (input: Parameters<NativeProcessAcquisition['stopOwnedNativeProcess']>[0],
    phases: Readonly<{ uncertain: string; publication: string }>): Promise<HostedNativeAnchorStopResult> => {
    const recipe = validateStopIdentity(input.identity)
    const pendingTerminal = exactTerminalCustody.get(input.identity.attemptToken)
    if (pendingTerminal) {
      // Re-enter the accepted adapter so its retained terminal tombstone remains the
      // authority for retry. The adapter settles this from custody without invoking
      // Product stop a second time.
      const retryResult = await adapter.stop({ binding: input.identity.binding, processRef: input.identity.processRef,
        mode: input.mode, cancellation: input.cancellation })
      if (retryResult.status !== 'drained' && retryResult.status !== 'already_drained') {
        await input.recorder.recordUncertain({ attempt: pendingTerminal.attempt, phase: `${phases.uncertain}-terminal-retry`,
          adapterResult: retryResult }).catch(() => undefined)
        const failure = new NativeProcessAcquisitionFailure('Native anchor terminal tombstone retry is uncertain', pendingTerminal.attempt)
        attemptLifecycles.set(input.identity.attemptToken, Object.freeze({ status: 'failed', error: failure }))
        throw failure
      }
      try {
        await publishExactTerminalCustody(recipe, pendingTerminal, input.recorder)
      } catch (error) {
        await input.recorder.recordUncertain({ attempt: pendingTerminal.attempt, phase: phases.publication,
          adapterResult: pendingTerminal.result }).catch(() => undefined)
        const failure = new NativeProcessAcquisitionFailure(error instanceof Error ? error.message : String(error), pendingTerminal.attempt)
        attemptLifecycles.set(input.identity.attemptToken, Object.freeze({ status: 'failed', error: failure }))
        throw failure
      }
      return retryResult
    }
    const result = await adapter.stop({ binding: input.identity.binding, processRef: input.identity.processRef, mode: input.mode, cancellation: input.cancellation })
    if (result.status === 'drained' || result.status === 'already_drained') {
      const attempt: NativeAcquisitionFailedAttempt = failed.get(input.identity.attemptToken) ?? terminalIdentities.get(input.identity.attemptToken)?.attempt ??
        Object.freeze({ version: 1, kind: 'known-anchor-ref',
        expected: recipe.expected, processRef: input.identity.processRef,
        startResult: acquiredStarts.get(input.identity.attemptToken) ?? unavailableKnownStart(input.identity.processRef) })
      const custody: ExactTerminalCustody = { identity: input.identity, attempt, result, drainedPublished: false,
        claimSettled: input.identity.role !== 'native-worker' }
      // Product has proved the exact ref terminal. Retain that fact and the original acquired
      // start before either durable publication can fail; reconciliation must never need to
      // infer custody from a later adapter result.
      exactTerminalCustody.set(input.identity.attemptToken, custody)
      failed.set(input.identity.attemptToken, attempt)
      attemptLifecycles.set(input.identity.attemptToken, Object.freeze({ status: 'failed',
        error: new NativeProcessAcquisitionFailure('Native anchor terminal publication is incomplete', attempt) }))
      try {
        await publishExactTerminalCustody(recipe, custody, input.recorder)
      } catch (error) {
        await input.recorder.recordUncertain({ attempt, phase: phases.publication, adapterResult: result }).catch(() => undefined)
        const failure = new NativeProcessAcquisitionFailure(error instanceof Error ? error.message : String(error), attempt)
        attemptLifecycles.set(input.identity.attemptToken, Object.freeze({ status: 'failed', error: failure }))
        throw failure
      }
    } else {
      const attempt: NativeAcquisitionFailedAttempt = failed.get(input.identity.attemptToken) ?? Object.freeze({ version: 1, kind: 'known-anchor-ref',
        expected: recipe.expected, processRef: input.identity.processRef,
        startResult: acquiredStarts.get(input.identity.attemptToken) ?? unavailableKnownStart(input.identity.processRef) })
      failed.set(input.identity.attemptToken, attempt)
      attemptLifecycles.set(input.identity.attemptToken, Object.freeze({ status: 'failed',
        error: new NativeProcessAcquisitionFailure('Native anchor stop is uncertain', attempt) }))
      try {
        await input.recorder.recordUncertain({ attempt, phase: phases.uncertain, adapterResult: result })
      } catch (error) {
        const failure = new NativeProcessAcquisitionFailure(error instanceof Error ? error.message : String(error), attempt)
        attemptLifecycles.set(input.identity.attemptToken, Object.freeze({ status: 'failed', error: failure }))
        throw failure
      }
    }
    return result
  }

  settleExactStop = (input, phases) => {
    const recipe = validateStopIdentity(input.identity)
    const token = recipe.expected.attemptToken
    const existing = stopInFlight.get(token)
    if (existing) {
      if (existing.identity.processRef !== input.identity.processRef) {
        throw new Error('Hosted anchor stop operation belongs to a different exact identity')
      }
      const context = stopContext.getStore()
      if (context?.operation === existing && existing.active) {
        return Promise.reject(new Error('Recursive native stop completion is forbidden while exact settlement is active'))
      }
      return existing.promise
    }
    stopRequested.add(token)
    const operation = { identity: input.identity, active: true } as StopOperation
    const work = stopContext.run({ operation }, () => stopOwnedNativeProcessOnce(input, phases)).finally(() => {
      operation.active = false
      if (stopInFlight.get(token) === operation) stopInFlight.delete(token)
    })
    operation.promise = work
    stopInFlight.set(token, operation)
    return work
  }

  const stopOwnedNativeProcess: NativeProcessAcquisition['stopOwnedNativeProcess'] = input =>
    settleExactStop(input, { uncertain: 'stop', publication: 'stop-terminal-publication' })

  const publishExactTerminalCustody = async (recipe: PreparedNativeProcessRecipe, custody: ExactTerminalCustody,
    recorder: NativeAcquisitionRecorder): Promise<void> => {
    if (!custody.drainedPublished) {
      await recorder.recordDrained({ kind: 'exact-anchor-terminal', identity: custody.identity, adapterResult: custody.result,
        observedAt: new Date().toISOString() })
      custody.drainedPublished = true
    }
    if (!custody.claimSettled) {
      await settleWorkerClaim(recipe, true)
      custody.claimSettled = true
    }
    const token = custody.identity.attemptToken
    terminalIdentities.set(token, Object.freeze({ identity: custody.identity, attempt: custody.attempt }))
    exactTerminalCustody.delete(token)
    retained.delete(token)
    acquiredStarts.delete(token)
    failed.delete(token)
    attemptLifecycles.set(token, Object.freeze({ status: 'terminal' }))
  }

  const reconcileFailedAttempt: NativeProcessAcquisition['reconcileFailedAttempt'] = input => {
    if (failed.get(input.attempt.expected.attemptToken) !== input.attempt) return Promise.resolve({ status: 'attempt_not_retained' })
    const context = stopContext.getStore()
    if (context?.operation.active && context.operation.identity.attemptToken === input.attempt.expected.attemptToken &&
      context.operation.identity.processRef === input.attempt.processRef) {
      return Promise.reject(new Error('Recursive native stop completion is forbidden while exact settlement is active'))
    }
    const existing = reconcileInFlight.get(input.attempt.expected.attemptToken)
    if (existing) return existing
    const work = (async () => {
      if (!input.attempt.processRef) return { status: 'unresolved_without_anchor_ref' } as const
      const terminal = exactTerminalCustody.get(input.attempt.expected.attemptToken)
      if (terminal) {
        return stopOwnedNativeProcess({ identity: terminal.identity, mode: input.mode, cancellation: input.cancellation, recorder: input.recorder })
      }
      const identity: OwnedNativeProcessIdentity = Object.freeze({ ...input.attempt.expected, kind: 'hosted-anchor', processRef: input.attempt.processRef })
      return stopOwnedNativeProcess({ identity, mode: input.mode, cancellation: input.cancellation, recorder: input.recorder })
    })().finally(() => reconcileInFlight.delete(input.attempt.expected.attemptToken))
    reconcileInFlight.set(input.attempt.expected.attemptToken, work)
    return work
  }

  return Object.freeze({ launchOwnedNativeLead, launchOwnedNativeWorker, inspectOwnedNativeProcess, writeOwnedNativeInput, stopOwnedNativeProcess, reconcileFailedAttempt,
    adoptOwnedNativeLead: () => { throw new Error('Hosted native anchor adoption by a new controller is forbidden') } })
}

export class NativeProcessAcquisitionFailure extends Error {
  constructor(message: string, readonly attempt: NativeAcquisitionFailedAttempt) { super(message); this.name = 'NativeProcessAcquisitionFailure' }
}
