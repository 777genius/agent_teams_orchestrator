import { createHash } from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { openCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import {
  type OpenCodeBridgeCommandEvidence,
  validateOpenCodeBridgeStateChangingPreconditions,
} from './OpenCodeBridgePreconditions.js'
import {
  OPEN_CODE_APP_MCP_SERVER_NAME,
  type ResolvedAppMcpLaunchConfig,
  resolveOpenCodeAppMcpLaunchConfig,
} from './OpenCodeMcpManager.js'
import { resolveOpenCodeProviderScopedModel } from './OpenCodeModelResolver.js'
import { normalizeOpenCodePermissions } from './OpenCodePermissionNormalizer.js'
import { openCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import { openCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'

import type {
  OpenCodePendingPermission,
  OpenCodeProvisioningSnapshot,
  OpenCodeSessionRecord,
  OpenCodeSessionReconcileSummary,
} from './types.js'

const BRIDGE_SCHEMA_VERSION = 1
const RUNTIME_STORE_MANIFEST_HIGH_WATERMARK = 0
const SUPPORTED_COMMANDS = [
  'opencode.handshake',
  'opencode.commandStatus',
  'opencode.readiness',
  'opencode.launchTeam',
  'opencode.reconcileTeam',
  'opencode.stopTeam',
  'opencode.answerPermission',
  'opencode.listRuntimePermissions',
  'opencode.getRuntimeTranscript',
  'opencode.recoverDeliveryJournal',
] as const

type BridgeCommandName = typeof SUPPORTED_COMMANDS[number]

type BridgeEnvelope = {
  schemaVersion: 1
  requestId: string
  command: BridgeCommandName
  cwd: string
  startedAt: string
  timeoutMs: number
  body: Record<string, unknown>
}

type BridgeDiagnosticEvent = {
  type: string
  providerId: 'opencode'
  severity: 'info' | 'warning' | 'error'
  message: string
  data?: Record<string, unknown>
  createdAt: string
}

type TeamDiagnostic = {
  code: string
  severity: 'info' | 'warning' | 'error'
  message: string
}

type TeamWarning = {
  code: string
  message: string
}

type LaunchMemberDraft = {
  sessionId: string
  launchState: 'created' | 'confirmed_alive' | 'permission_blocked' | 'failed'
  runtimePid?: number
  evidence: Array<{ kind: string; observedAt: string }>
  diagnostics: string[]
}

const REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS = [
  'runtime_bootstrap_checkin',
  'runtime_deliver_message',
  'runtime_task_event',
  'runtime_heartbeat',
] as const

const REQUIRED_AGENT_TEAMS_RUNTIME_TOOL_IDS = REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map(tool =>
  `${OPEN_CODE_APP_MCP_SERVER_NAME}_${tool}`,
)

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => asString(item)).filter((item): item is string => item !== null)
    : []
}

function nowIso(): string {
  return new Date().toISOString()
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalizeStable(value))).digest('hex')
}

function normalizeStable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => normalizeStable(item))
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const record = value as Record<string, unknown>
  return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
    const normalized = normalizeStable(record[key])
    if (normalized !== undefined) {
      acc[key] = normalized
    }
    return acc
  }, {})
}

function uniqueSortedStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter(Boolean))).sort()
}

function createRuntimeSnapshot(snapshot?: OpenCodeProvisioningSnapshot | null) {
  const capabilitySnapshotId = snapshot
    ? `opencode:${hashStable({
      version: snapshot.host?.version ?? null,
      projectPath: snapshot.projectPath,
      // Keep the launch-gate snapshot stable across equivalent host restarts.
      // The live resolved fingerprint may include ephemeral host-specific MCP payloads,
      // so use stable project + managed-config identity here instead.
      projectBehaviorFingerprint: snapshot.profile?.projectBehaviorFingerprint ?? null,
      managedConfigFingerprint: snapshot.profile?.managedConfigFingerprint ?? null,
      mcpServers: Object.keys(snapshot.mcp ?? {}).sort(),
      providers: uniqueSortedStrings(snapshot.providers?.connected ?? []),
    }).slice(0, 32)}`
    : null

  return {
    providerId: 'opencode' as const,
    binaryPath: snapshot?.host ? 'opencode' : null,
    binaryFingerprint: snapshot?.host?.version ? `version:${snapshot.host.version}` : null,
    version: snapshot?.host?.version ?? null,
    capabilitySnapshotId,
  }
}

function createRuntimePreconditionSnapshot(snapshot?: OpenCodeProvisioningSnapshot | null) {
  return {
    ...createRuntimeSnapshot(snapshot),
    runtimeStoreManifestHighWatermark: RUNTIME_STORE_MANIFEST_HIGH_WATERMARK,
    activeRunId: null,
  }
}

function diagnostic(
  message: string,
  severity: BridgeDiagnosticEvent['severity'] = 'info',
  type = 'opencode_bridge',
  data?: Record<string, unknown>,
): BridgeDiagnosticEvent {
  return {
    type,
    providerId: 'opencode',
    severity,
    message,
    data,
    createdAt: nowIso(),
  }
}

function teamDiagnostic(
  code: string,
  message: string,
  severity: TeamDiagnostic['severity'] = 'info',
): TeamDiagnostic {
  return { code, message, severity }
}

function success<TData>(
  envelope: BridgeEnvelope,
  data: TData,
  startedAtMs: number,
  snapshot?: OpenCodeProvisioningSnapshot | null,
  diagnostics: BridgeDiagnosticEvent[] = [],
) {
  return {
    ok: true,
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    requestId: envelope.requestId,
    command: envelope.command,
    completedAt: nowIso(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    runtime: createRuntimeSnapshot(snapshot),
    diagnostics,
    data,
  }
}

function failure(
  envelope: BridgeEnvelope,
  kind: 'unsupported_schema' | 'unsupported_command' | 'invalid_input' | 'runtime_not_ready' | 'provider_error' | 'timeout' | 'contract_violation' | 'internal_error',
  message: string,
  startedAtMs: number,
  retryable: boolean,
  diagnostics: BridgeDiagnosticEvent[] = [],
) {
  return {
    ok: false,
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    requestId: envelope.requestId,
    command: envelope.command,
    completedAt: nowIso(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    error: {
      kind,
      message,
      retryable,
    },
    diagnostics,
  }
}

function validateEnvelope(input: unknown): BridgeEnvelope {
  const envelope = asRecord(input)
  if (!envelope) {
    throw new Error('Bridge envelope must be an object')
  }
  if (envelope.schemaVersion !== BRIDGE_SCHEMA_VERSION) {
    throw new Error('Unsupported bridge schemaVersion')
  }
  const command = asString(envelope.command)
  if (!command || !SUPPORTED_COMMANDS.includes(command as BridgeCommandName)) {
    throw new Error(`Unsupported bridge command: ${String(envelope.command)}`)
  }
  const requestId = asString(envelope.requestId)
  const cwd = asString(envelope.cwd)
  const startedAt = asString(envelope.startedAt)
  const body = asRecord(envelope.body)
  if (!requestId || !cwd || !startedAt || !body) {
    throw new Error('Bridge envelope missing requestId, cwd, startedAt or body')
  }
  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    requestId,
    command: command as BridgeCommandName,
    cwd,
    startedAt,
    timeoutMs: typeof envelope.timeoutMs === 'number' ? envelope.timeoutMs : 0,
    body,
  }
}

type AppMcpToolProof = {
  ok: boolean
  observedTools: string[]
  missingTools: string[]
  diagnostics: string[]
  route: string | null
}

const APP_MCP_PREFLIGHT_TIMEOUT_MS = 10_000
const APP_MCP_TOOL_PROOF_CACHE_TTL_MS = 15_000

type AppMcpToolProofCacheEntry = {
  expiresAt: number
  proof: AppMcpToolProof
}

const appMcpToolProofCache = new Map<string, AppMcpToolProofCacheEntry>()
const appMcpToolProofInFlight = new Map<string, Promise<AppMcpToolProof>>()

function createAppMcpToolProofCacheKey(
  launchConfig: ResolvedAppMcpLaunchConfig,
): string {
  return hashStable({
    source: launchConfig.source,
    config: launchConfig.config,
  })
}

export function __resetAppMcpToolProofCacheForTests(): void {
  appMcpToolProofCache.clear()
  appMcpToolProofInFlight.clear()
}

async function proveAppMcpTools(
  snapshot: OpenCodeProvisioningSnapshot,
): Promise<AppMcpToolProof> {
  if (!snapshot.host) {
    return {
      ok: false,
      observedTools: [],
      missingTools: [...REQUIRED_AGENT_TEAMS_RUNTIME_TOOL_IDS],
      diagnostics: ['OpenCode host is unavailable; app MCP tools cannot be proven'],
      route: null,
    }
  }

  const launchConfig = await resolveOpenCodeAppMcpLaunchConfig()
  const cacheKey = createAppMcpToolProofCacheKey(launchConfig)
  const cached = appMcpToolProofCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.proof
  }

  const inFlight = appMcpToolProofInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  const proofPromise = (async () => {
    try {
      const observedTools = await listAppMcpToolsFromResolvedLaunchConfig(launchConfig)
      const proof = matchAppMcpTools(observedTools, 'mcp:tools/list')
      if (proof.ok) {
        appMcpToolProofCache.set(cacheKey, {
          expiresAt: Date.now() + APP_MCP_TOOL_PROOF_CACHE_TTL_MS,
          proof,
        })
      }
      return proof
    } catch (error) {
      return {
        ok: false,
        observedTools: [],
        missingTools: [...REQUIRED_AGENT_TEAMS_RUNTIME_TOOL_IDS],
        diagnostics: [
          `Agent Teams MCP direct tools/list preflight failed: ${error instanceof Error ? error.message : String(error)}`,
          'OpenCode 1.14.19 experimental tool endpoints do not expose MCP tools, so they are not accepted as production proof.',
        ],
        route: 'mcp:tools/list',
      }
    } finally {
      appMcpToolProofInFlight.delete(cacheKey)
    }
  })()

  appMcpToolProofInFlight.set(cacheKey, proofPromise)
  return proofPromise
}

async function listAppMcpToolsFromResolvedLaunchConfig(
  launchConfig: ResolvedAppMcpLaunchConfig,
): Promise<string[]> {
  const command = launchConfig.config.command
  if (!command || command.length === 0) {
    throw new Error('Agent Teams MCP launch config is missing a local command')
  }

  const [binary, ...args] = command
  if (!binary) {
    throw new Error('Agent Teams MCP launch config binary is empty')
  }

  const client = new Client({
    name: 'agent-teams-opencode-readiness',
    version: '1.0.0',
  })
  const transport = new StdioClientTransport({
    command: binary,
    args,
    env: buildMcpPreflightEnv(launchConfig.config.environment),
  })

  try {
    await withTimeout(client.connect(transport), APP_MCP_PREFLIGHT_TIMEOUT_MS)
    const result = await withTimeout(client.listTools(), APP_MCP_PREFLIGHT_TIMEOUT_MS)
    return (result.tools ?? [])
      .map(tool => tool.name)
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      .map(name => `${OPEN_CODE_APP_MCP_SERVER_NAME}_${name}`)
  } finally {
    await client.close().catch(() => undefined)
  }
}

function buildMcpPreflightEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  return {
    ...env,
    ...(extra ?? {}),
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function matchAppMcpTools(observedTools: string[], route: string): AppMcpToolProof {
  const observed = new Set(observedTools)
  const missingTools = REQUIRED_AGENT_TEAMS_RUNTIME_TOOL_IDS.filter(tool => !observed.has(tool))
  return {
    ok: missingTools.length === 0,
    observedTools: Array.from(new Set(observedTools)).sort(),
    missingTools,
    diagnostics: missingTools.length === 0
      ? []
      : [`OpenCode app MCP tools missing from ${route}: ${missingTools.join(', ')}`],
    route,
  }
}

function readinessData(
  snapshot: OpenCodeProvisioningSnapshot,
  selectedModel: string | null,
  executionOutcome: Awaited<ReturnType<typeof openCodeExecutionProbe.probeModel>> | undefined,
  toolProof: AppMcpToolProof,
  requireSelectedModel: boolean,
) {
  const connectedProviders = snapshot.providers?.connected ?? []
  const models = snapshot.configProviders?.providers
    ?.flatMap(provider => Object.keys(asRecord(provider.models) ?? {}).map(model => `${provider.id}/${model}`))
    .filter((model): model is string => Boolean(model))
    ?? []
  const appMcpConnected = snapshot.appMcp?.connected === true || snapshot.appMcp?.status === 'present' || snapshot.appMcp?.status === 'attached'
  const requiredToolsPresent = appMcpConnected && toolProof.ok
  const diagnostics = [
    ...snapshot.diagnostics,
    ...(executionOutcome?.diagnostics ?? []),
    ...toolProof.diagnostics,
  ]
  let state: string = 'ready'
  let launchAllowed = true
  const missing: string[] = []

  if (!snapshot.detected) {
    state = 'not_installed'
    launchAllowed = false
    missing.push('OpenCode CLI not detected')
  } else if (!snapshot.hostHealthy) {
    state = 'unknown_error'
    launchAllowed = false
    missing.push(snapshot.probeError ?? 'OpenCode host is not healthy')
  } else if (connectedProviders.length === 0) {
    state = 'not_authenticated'
    launchAllowed = false
    missing.push('No connected OpenCode providers found')
  } else if (requireSelectedModel && !selectedModel) {
    state = 'model_unavailable'
    launchAllowed = false
    missing.push('No OpenCode model is available')
  } else if (!appMcpConnected || !requiredToolsPresent) {
    state = 'mcp_unavailable'
    launchAllowed = false
    missing.push(
      toolProof.missingTools.length > 0
        ? `Agent Teams MCP tools are not visible in OpenCode: ${toolProof.missingTools.join(', ')}`
        : 'Agent Teams MCP tools are not visible in OpenCode',
    )
  } else if (executionOutcome && executionOutcome.outcome === 'not_authenticated') {
    state = 'not_authenticated'
    launchAllowed = false
    missing.push(
      executionOutcome.reason ?? 'OpenCode provider authentication failed for the selected model',
    )
  } else if (executionOutcome && executionOutcome.outcome !== 'available') {
    state = 'model_unavailable'
    launchAllowed = false
    missing.push(executionOutcome.reason ?? 'OpenCode selected model execution is unavailable')
  }

  return {
    state,
    launchAllowed,
    modelId: selectedModel,
    availableModels: models,
    opencodeVersion: snapshot.host?.version ?? null,
    installMethod: 'unknown',
    binaryPath: 'opencode',
    hostHealthy: snapshot.hostHealthy,
    appMcpConnected,
    requiredToolsPresent,
    permissionBridgeReady: true,
    runtimeStoresReady: true,
    supportLevel: launchAllowed ? 'production_supported' : null,
    missing,
    diagnostics,
    evidence: {
      capabilitiesReady: true,
      mcpToolProofRoute: toolProof.route,
      observedMcpTools: toolProof.observedTools,
      runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
    },
  }
}

function bridgeStateFromSummary(summary: OpenCodeSessionReconcileSummary): 'created' | 'confirmed_alive' | 'permission_blocked' | 'failed' {
  if (summary.staleReason || summary.errorCount > 0) {
    return 'failed'
  }
  if (summary.pendingPermissionRequestIds.length > 0 || summary.durableState === 'blocked') {
    return 'permission_blocked'
  }
  if (summary.latestAssistantMessageId || summary.durableState === 'idle') {
    return 'confirmed_alive'
  }
  return 'created'
}

function evidenceFromSummary(summary: OpenCodeSessionReconcileSummary) {
  const observedAt = nowIso()
  const evidence = [
    { kind: 'member_session_recorded', observedAt },
  ]
  if (summary.pendingPermissionRequestIds.length > 0) {
    evidence.push({ kind: 'permission_blocked', observedAt })
  }
  if (summary.latestAssistantMessageId || summary.durableState === 'idle') {
    evidence.push({ kind: 'bootstrap_confirmed', observedAt })
    evidence.push({ kind: 'member_ready', observedAt })
  }
  return evidence
}

function buildTeamLaunchData(params: {
  runId: string
  selectedModel: string
  members: Record<string, LaunchMemberDraft>
  diagnostics: TeamDiagnostic[]
  warnings?: TeamWarning[]
  commandEvidence?: OpenCodeBridgeCommandEvidence
}) {
  const states = Object.values(params.members).map(member => member.launchState)
  const now = nowIso()
  const anyFailed = states.includes('failed')
  const anyPermissionBlocked = states.includes('permission_blocked')
  const allReady = states.length > 0 && states.every(state => state === 'confirmed_alive')
  const teamLaunchState = anyFailed
    ? 'failed'
    : anyPermissionBlocked
      ? 'permission_blocked'
      : allReady
        ? 'ready'
        : 'launching'
  return {
    runId: params.runId,
    teamLaunchState,
    members: Object.fromEntries(
      Object.entries(params.members).map(([memberName, member]) => [
        memberName,
        {
          sessionId: member.sessionId,
          launchState: member.launchState,
          model: params.selectedModel,
          ...(typeof member.runtimePid === 'number' && member.runtimePid > 0
            ? { runtimePid: member.runtimePid }
            : {}),
          evidence: member.evidence,
        },
      ]),
    ),
    warnings: params.warnings ?? [],
    diagnostics: params.diagnostics,
    ...(params.commandEvidence?.idempotencyKey
      ? { idempotencyKey: params.commandEvidence.idempotencyKey }
      : {}),
    manifestHighWatermark: params.commandEvidence?.manifestHighWatermark ?? null,
    runtimeStoreManifestHighWatermark:
      params.commandEvidence?.runtimeStoreManifestHighWatermark ?? null,
    durableCheckpoints: [
      { name: 'required_tools_proven', observedAt: now },
      { name: 'delivery_ready', observedAt: now },
      ...(allReady ? [{ name: 'run_ready', observedAt: now }] : []),
    ],
  }
}

function buildOpenCodeExecutionOutcome(
  modelId: string,
  outcome: 'available' | 'unavailable' | 'not_authenticated' | 'unknown',
  reason: string | null,
) {
  return {
    providerId: 'opencode' as const,
    modelId,
    probePrompt: '',
    expectedOutput: '',
    outcome,
    reason,
    durationMs: 0,
    rawStatus: null,
    durableState: 'unknown' as const,
    latestAssistantText: null,
    latestAssistantPreview: null,
    toolCallCount: 0,
    errorCount: reason ? 1 : 0,
    diagnostics: reason ? [reason] : [],
  }
}

async function runReadiness(envelope: BridgeEnvelope) {
  const snapshot = await openCodeProvisioningProbe.probe(asString(envelope.body.projectPath) ?? envelope.cwd)
  const selectedModel = asString(envelope.body.selectedModel)
  const requireSelectedModel = envelope.body.requireExecutionProbe === true || selectedModel !== null
  const toolProofPromise = proveAppMcpTools(snapshot)
  let executionModel: string | null = null
  let modelResolutionFailureReason: string | null = null
  let executionOutcomePromise: Promise<Awaited<ReturnType<typeof openCodeExecutionProbe.probeModel>> | undefined> =
    Promise.resolve(undefined)

  if (selectedModel) {
    try {
      executionModel = resolveOpenCodeProviderScopedModel(selectedModel, snapshot)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      modelResolutionFailureReason = reason
      executionOutcomePromise = Promise.resolve(
        buildOpenCodeExecutionOutcome(selectedModel, 'unavailable', reason),
      )
    }
  }

  if (envelope.body.requireExecutionProbe === true && executionModel) {
    executionOutcomePromise = openCodeExecutionProbe.probeModel({
      selectedModel: executionModel,
      projectPath: snapshot.projectPath,
    }).catch(error =>
      buildOpenCodeExecutionOutcome(
        executionModel,
        'unknown',
        error instanceof Error ? error.message : String(error),
      ),
    )
  }
  const [executionOutcome, toolProof] = await Promise.all([
    executionOutcomePromise,
    toolProofPromise,
  ])

  if (modelResolutionFailureReason && selectedModel) {
    const fallbackReadiness = readinessData(
      snapshot,
      selectedModel,
      executionOutcome,
      toolProof,
      requireSelectedModel,
    )
    return {
      snapshot,
      data: {
        ...fallbackReadiness,
        state: 'model_unavailable',
        launchAllowed: false,
        missing: [modelResolutionFailureReason],
        diagnostics: uniqueSortedStrings([
          ...fallbackReadiness.diagnostics,
          modelResolutionFailureReason,
        ]),
      },
    }
  }

  return {
    snapshot,
    data: readinessData(
      snapshot,
      selectedModel,
      executionOutcome,
      toolProof,
      requireSelectedModel,
    ),
  }
}

async function runLaunch(envelope: BridgeEnvelope) {
  const body = envelope.body
  const runId = asString(body.runId)
  const laneId = asString(body.laneId)
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  const selectedModel = asString(body.selectedModel)
  const membersRaw = Array.isArray(body.members) ? body.members : []
  if (!runId || !laneId || !teamId || !selectedModel || membersRaw.length === 0) {
    throw new Error('opencode.launchTeam requires runId, laneId, teamId/teamName, selectedModel and members')
  }

  const snapshot = await openCodeProvisioningProbe.probe(asString(body.projectPath) ?? envelope.cwd)
  const commandEvidence = validateOpenCodeBridgeStateChangingPreconditions({
    body,
    runtime: createRuntimePreconditionSnapshot(snapshot),
  })
  const apiSelectedModel = resolveOpenCodeProviderScopedModel(selectedModel, snapshot)
  const members: Record<string, LaunchMemberDraft> = {}
  const diagnostics: TeamDiagnostic[] = []

  for (const item of membersRaw) {
    const member = asRecord(item)
    const name = asString(member?.name)
    if (!name) continue
    const prompt = asString(member?.prompt)
      ?? `Join OpenCode team ${teamId} as ${name}. Wait for app MCP task delivery.`
    const record = await openCodeSessionBridge.ensureSession({
      teamId,
      laneId,
      memberName: name,
      selectedModel: apiSelectedModel,
      title: `${teamId} - ${name}`,
      projectPath: snapshot.projectPath,
    })
    await openCodeSessionBridge.promptAsync(record, {
      text: prompt,
      agent: 'teammate',
    })
    const reconciled = await openCodeSessionBridge.reconcileSession(record, { limit: 50 })
    const launchState = bridgeStateFromSummary(reconciled.summary)
    members[name] = {
      sessionId: record.opencodeSessionId,
      launchState,
      ...(typeof snapshot.host?.pid === 'number' && snapshot.host.pid > 0
        ? { runtimePid: snapshot.host.pid }
        : {}),
      evidence: evidenceFromSummary(reconciled.summary),
      diagnostics: reconciled.summary.diagnostics,
    }
    diagnostics.push(
      ...reconciled.summary.diagnostics.map(message => teamDiagnostic('member_reconcile', `${name}: ${message}`, 'warning')),
    )
  }

  return {
    snapshot,
    data: buildTeamLaunchData({
      runId,
      selectedModel,
      members,
      diagnostics,
      commandEvidence,
      warnings: asString(body.mode) === 'dogfood'
        ? [{ code: 'opencode_dogfood_mode', message: 'OpenCode dogfood launch mode is active.' }]
        : [],
    }),
  }
}

async function runReconcile(envelope: BridgeEnvelope) {
  const body = envelope.body
  const runId = asString(body.runId)
  const laneId = asString(body.laneId)
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  if (!runId || !laneId || !teamId) {
    throw new Error('opencode.reconcileTeam requires runId, laneId and teamId/teamName')
  }
  const expectedMembers = Array.isArray(body.expectedMembers) ? body.expectedMembers : []
  const snapshot = await openCodeProvisioningProbe.probe(envelope.cwd)
  const commandEvidence = validateOpenCodeBridgeStateChangingPreconditions({
    body,
    runtime: createRuntimePreconditionSnapshot(snapshot),
  })
  const members: Record<string, LaunchMemberDraft> = {}
  const diagnostics: TeamDiagnostic[] = []
  let selectedModel = 'unknown/unknown'

  for (const item of expectedMembers) {
    const member = asRecord(item)
    const name = asString(member?.name)
    if (!name) continue
    const record = await openCodeSessionStore.get(teamId, laneId, name)
    if (!record) {
      diagnostics.push(teamDiagnostic('member_session_missing', `No stored OpenCode session for ${teamId}/${name}`, 'warning'))
      continue
    }
    selectedModel = record.selectedModel
    const reconciled = await openCodeSessionBridge.reconcileSession(record, { limit: 50 })
    members[name] = {
      sessionId: record.opencodeSessionId,
      launchState: bridgeStateFromSummary(reconciled.summary),
      ...(typeof snapshot.host?.pid === 'number' && snapshot.host.pid > 0
        ? { runtimePid: snapshot.host.pid }
        : {}),
      evidence: evidenceFromSummary(reconciled.summary),
      diagnostics: reconciled.summary.diagnostics,
    }
  }

  return {
    snapshot,
    data: buildTeamLaunchData({ runId, selectedModel, members, diagnostics, commandEvidence }),
  }
}

async function runStop(envelope: BridgeEnvelope) {
  const body = envelope.body
  const runId = asString(body.runId)
  const laneId = asString(body.laneId)
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  if (!runId || !laneId || !teamId) {
    throw new Error('opencode.stopTeam requires runId, laneId and teamId/teamName')
  }
  const snapshot = await openCodeProvisioningProbe.probe(envelope.cwd)
  const commandEvidence = validateOpenCodeBridgeStateChangingPreconditions({
    body,
    runtime: createRuntimePreconditionSnapshot(snapshot),
  })
  const records = (await openCodeSessionStore.list()).filter(
    record => record.teamId === teamId && record.laneId === laneId,
  )
  const members: Record<string, { sessionId?: string; stopped: boolean; diagnostics: string[] }> = {}
  for (const record of records) {
    let stopped = false
    const diagnostics: string[] = []
    try {
      stopped = await openCodeSessionBridge.abort(record)
      await openCodeSessionBridge.releaseSession(record)
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error))
    }
    members[record.memberName] = {
      sessionId: record.opencodeSessionId,
      stopped,
      diagnostics,
    }
  }
  return {
    snapshot,
    data: {
      runId,
      stopped: Object.values(members).every(member => member.stopped),
      members,
      warnings: [],
      diagnostics: [],
      ...(commandEvidence.idempotencyKey ? { idempotencyKey: commandEvidence.idempotencyKey } : {}),
      manifestHighWatermark: commandEvidence.manifestHighWatermark,
      runtimeStoreManifestHighWatermark: commandEvidence.runtimeStoreManifestHighWatermark,
    },
  }
}

async function runAnswerPermission(envelope: BridgeEnvelope) {
  const body = envelope.body
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  const laneId = asString(body.laneId)
  const memberName = asString(body.memberName)
  const requestId = asString(body.requestId)
  const decision = asString(body.decision)
  if (!teamId || !requestId || (decision !== 'allow' && decision !== 'always' && decision !== 'reject')) {
    throw new Error('opencode.answerPermission requires teamId/teamName, requestId and allow/always/reject decision')
  }
  const candidates = memberName
    ? (
      laneId
        ? [await openCodeSessionStore.get(teamId, laneId, memberName)]
        : (await openCodeSessionStore.list()).filter(
          record => record.teamId === teamId && record.memberName === memberName,
        )
    )
    : (await openCodeSessionStore.list()).filter(
      record => record.teamId === teamId && (!laneId || record.laneId === laneId),
    )
  if (!laneId && candidates.filter((candidate): candidate is OpenCodeSessionRecord => candidate !== null).length > 1) {
    throw new Error(`Multiple OpenCode lanes exist for ${teamId}; laneId is required`)
  }
  const record = candidates.find((candidate): candidate is OpenCodeSessionRecord => candidate !== null)
  if (!record) {
    throw new Error(`No OpenCode session record found for ${teamId}`)
  }
  const snapshot = await openCodeProvisioningProbe.probe(record.projectPath)
  const commandEvidence = validateOpenCodeBridgeStateChangingPreconditions({
    body,
    runtime: createRuntimePreconditionSnapshot(snapshot),
  })
  await openCodeSessionBridge.answerPermission(record, { requestId, decision })
  const reconciled = await openCodeSessionBridge.reconcileSession(record, { limit: 50 })
  return {
    snapshot,
    data: {
      runId: asString(body.runId) ?? 'unknown',
      teamLaunchState: reconciled.summary.pendingPermissionRequestIds.length > 0
        ? 'permission_blocked'
        : 'launching',
      members: {
        [record.memberName]: {
          sessionId: record.opencodeSessionId,
          launchState: bridgeStateFromSummary(reconciled.summary),
          model: record.selectedModel,
          evidence: evidenceFromSummary(reconciled.summary),
        },
      },
      warnings: [],
      diagnostics: reconciled.summary.diagnostics.map(message => teamDiagnostic('permission_reconcile', message, 'info')),
      ...(commandEvidence.idempotencyKey ? { idempotencyKey: commandEvidence.idempotencyKey } : {}),
      manifestHighWatermark: commandEvidence.manifestHighWatermark,
      runtimeStoreManifestHighWatermark: commandEvidence.runtimeStoreManifestHighWatermark,
    },
  }
}

async function runListPermissions(envelope: BridgeEnvelope) {
  const snapshot = await openCodeProvisioningProbe.probe(envelope.cwd)
  let permissions: OpenCodePendingPermission[] = []
  if (snapshot.host) {
    const body = envelope.body
    const teamId = asString(body.teamId) ?? asString(body.teamName)
    const laneId = asString(body.laneId)
    let records = await openCodeSessionStore.list()
    if (teamId) {
      records = records.filter(record => record.teamId === teamId)
      if (laneId) {
        records = records.filter(record => record.laneId === laneId)
      }
    }
    if (!laneId && teamId) {
      const laneCount = new Set(records.map(record => record.laneId)).size
      if (laneCount > 1) {
        throw new Error(`Multiple OpenCode lanes exist for ${teamId}; laneId is required`)
      }
    }
    const firstRecord = records[0]
    if (firstRecord) {
      const reconciled = await openCodeSessionBridge.reconcileSession(firstRecord, { limit: 1 })
      permissions = reconciled.summary.pendingPermissionRequestIds.map(requestID => ({ requestID }))
    }
  }
  return {
    snapshot,
    data: {
      permissions: normalizeOpenCodePermissions(permissions),
    },
  }
}

async function runTranscript(envelope: BridgeEnvelope) {
  const body = envelope.body
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  const laneId = asString(body.laneId)
  const memberName = asString(body.memberName)
  if (!teamId || !memberName) {
    throw new Error('opencode.getRuntimeTranscript requires teamId/teamName and memberName')
  }
  const record = laneId
    ? await openCodeSessionStore.get(teamId, laneId, memberName)
    : (await openCodeSessionStore.list()).find(
      candidate => candidate.teamId === teamId && candidate.memberName === memberName,
    ) ?? null
  if (!laneId) {
    const candidateCount = (await openCodeSessionStore.list()).filter(
      candidate => candidate.teamId === teamId && candidate.memberName === memberName,
    ).length
    if (candidateCount > 1) {
      throw new Error(`Multiple OpenCode lanes exist for ${teamId}/${memberName}; laneId is required`)
    }
  }
  if (!record) {
    throw new Error(`No stored OpenCode session record for ${teamId}/${memberName}`)
  }
  const result = await openCodeSessionBridge.projectLogMessages(record, { limit: 100 })
  const snapshot = await openCodeProvisioningProbe.probe(record.projectPath)
  return {
    snapshot,
    data: {
      sessionId: result.record.opencodeSessionId,
      durableState: result.summary.durableState,
      messages: result.summary.messages,
      logProjection: result.logProjection,
      diagnostics: result.summary.diagnostics,
    },
  }
}

async function handleEnvelope(envelope: BridgeEnvelope) {
  switch (envelope.command) {
    case 'opencode.handshake': {
      const snapshot = await openCodeProvisioningProbe.probe(envelope.cwd)
      const identity = {
        schemaVersion: BRIDGE_SCHEMA_VERSION,
        peer: 'agent_teams_orchestrator',
        appVersion: '1.0.0',
        gitSha: null,
        buildId: null,
        bridgeProtocol: {
          minVersion: 1,
          currentVersion: 1,
          supportedCommands: SUPPORTED_COMMANDS,
        },
        runtime: {
          ...createRuntimePreconditionSnapshot(snapshot),
        },
        featureFlags: {
          opencodeTeamLaunch: true,
          opencodeStateChangingCommands: true,
        },
      }
      const handshake = {
        schemaVersion: BRIDGE_SCHEMA_VERSION,
        requestId: envelope.requestId,
        client: envelope.body.client ?? identity,
        server: identity,
        agreedProtocolVersion: 1,
        acceptedCommands: SUPPORTED_COMMANDS,
        serverTime: nowIso(),
        identityHash: '',
      }
      handshake.identityHash = hashStable({
        ...handshake,
        identityHash: undefined,
      })
      return { snapshot, data: handshake }
    }
    case 'opencode.readiness':
      return runReadiness(envelope)
    case 'opencode.launchTeam':
      return runLaunch(envelope)
    case 'opencode.reconcileTeam':
      return runReconcile(envelope)
    case 'opencode.stopTeam':
      return runStop(envelope)
    case 'opencode.answerPermission':
      return runAnswerPermission(envelope)
    case 'opencode.listRuntimePermissions':
      return runListPermissions(envelope)
    case 'opencode.getRuntimeTranscript':
      return runTranscript(envelope)
    case 'opencode.commandStatus': {
      const snapshot = await openCodeProvisioningProbe.probe(envelope.cwd)
      return {
        snapshot,
        data: {
          status: 'unknown',
          diagnostics: ['No orchestrator-side command status ledger is persisted yet.'],
        },
      }
    }
    case 'opencode.recoverDeliveryJournal': {
      const snapshot = await openCodeProvisioningProbe.probe(envelope.cwd)
      return {
        snapshot,
        data: {
          recovered: false,
          diagnostics: ['Delivery journal recovery is currently app-owned; no orchestrator repair was required.'],
        },
      }
    }
  }
}

export async function executeOpenCodeBridgeCommandEnvelope(input: unknown) {
  const startedAtMs = Date.now()
  let envelope: BridgeEnvelope
  try {
    envelope = validateEnvelope(input)
  } catch (error) {
    const fallbackEnvelope: BridgeEnvelope = {
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      requestId: asString(asRecord(input)?.requestId) ?? 'invalid-request',
      command: 'opencode.readiness',
      cwd: process.cwd(),
      startedAt: nowIso(),
      timeoutMs: 0,
      body: {},
    }
    return failure(
      fallbackEnvelope,
      'invalid_input',
      error instanceof Error ? error.message : String(error),
      startedAtMs,
      false,
    )
  }

  try {
    const result = await handleEnvelope(envelope)
    return success(envelope, result.data, startedAtMs, result.snapshot)
  } catch (error) {
    return failure(
      envelope,
      'provider_error',
      error instanceof Error ? error.message : String(error),
      startedAtMs,
      true,
      [diagnostic(error instanceof Error ? error.message : String(error), 'error')],
    )
  }
}
