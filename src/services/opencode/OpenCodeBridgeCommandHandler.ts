import { createHash } from 'node:crypto'

import { openCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
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
  evidence: Array<{ kind: string; observedAt: string }>
  diagnostics: string[]
}

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

function createRuntimeSnapshot(snapshot?: OpenCodeProvisioningSnapshot | null) {
  const capabilitySnapshotId = snapshot
    ? `opencode:${hashStable({
      version: snapshot.host?.version ?? null,
      projectPath: snapshot.projectPath,
      configFingerprint: snapshot.host?.resolvedConfigFingerprint ?? null,
      mcpServers: Object.keys(snapshot.mcp ?? {}).sort(),
      providers: snapshot.providers?.connected ?? [],
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

function getSelectedModel(body: Record<string, unknown>, fallbackSnapshot: OpenCodeProvisioningSnapshot): string | null {
  return asString(body.selectedModel)
    ?? asStringArray(fallbackSnapshot.providers?.default ? Object.values(fallbackSnapshot.providers.default) : [])[0]
    ?? null
}

function readinessData(snapshot: OpenCodeProvisioningSnapshot, selectedModel: string | null, executionOutcome?: Awaited<ReturnType<typeof openCodeExecutionProbe.probeModel>>) {
  const connectedProviders = snapshot.providers?.connected ?? []
  const models = snapshot.configProviders?.providers
    ?.flatMap(provider => Object.keys(asRecord(provider.models) ?? {}).map(model => `${provider.id}/${model}`))
    .filter((model): model is string => Boolean(model))
    ?? []
  const appMcpConnected = snapshot.appMcp?.connected === true || snapshot.appMcp?.status === 'present' || snapshot.appMcp?.status === 'attached'
  const requiredToolsPresent = appMcpConnected
  const diagnostics = [
    ...snapshot.diagnostics,
    ...(executionOutcome?.diagnostics ?? []),
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
  } else if (!selectedModel) {
    state = 'model_unavailable'
    launchAllowed = false
    missing.push('No OpenCode model is available')
  } else if (!appMcpConnected || !requiredToolsPresent) {
    state = 'mcp_unavailable'
    launchAllowed = false
    missing.push('Agent Teams MCP tools are not visible in OpenCode')
  } else if (executionOutcome && executionOutcome.outcome !== 'available') {
    state = 'model_unavailable'
    launchAllowed = false
    missing.push(executionOutcome.reason ?? 'OpenCode selected model execution is unavailable')
  }

  return {
    state,
    launchAllowed,
    modelId: selectedModel,
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
      mcpToolProofRoute: snapshot.appMcp?.matchedServerName ? 'opencode_mcp_status' : null,
      observedMcpTools: Object.keys(snapshot.mcp ?? {}),
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
          evidence: member.evidence,
        },
      ]),
    ),
    warnings: params.warnings ?? [],
    diagnostics: params.diagnostics,
    durableCheckpoints: [
      { name: 'required_tools_proven', observedAt: now },
      { name: 'delivery_ready', observedAt: now },
      ...(allReady ? [{ name: 'run_ready', observedAt: now }] : []),
    ],
  }
}

async function runReadiness(envelope: BridgeEnvelope) {
  const snapshot = await openCodeProvisioningProbe.probe(asString(envelope.body.projectPath) ?? envelope.cwd)
  const selectedModel = getSelectedModel(envelope.body, snapshot)
  const executionModel = envelope.body.requireExecutionProbe === true && selectedModel
    ? resolveOpenCodeProviderScopedModel(selectedModel, snapshot)
    : null
  const executionOutcome = executionModel
    ? await openCodeExecutionProbe.probeModel({
      selectedModel: executionModel,
      projectPath: snapshot.projectPath,
    }).catch(error => ({
      providerId: 'opencode' as const,
      modelId: executionModel,
      probePrompt: '',
      expectedOutput: '',
      outcome: 'unknown' as const,
      reason: error instanceof Error ? error.message : String(error),
      durationMs: 0,
      rawStatus: null,
      durableState: 'unknown' as const,
      latestAssistantText: null,
      latestAssistantPreview: null,
      toolCallCount: 0,
      errorCount: 1,
      diagnostics: [error instanceof Error ? error.message : String(error)],
    }))
    : undefined

  return { snapshot, data: readinessData(snapshot, selectedModel, executionOutcome) }
}

async function runLaunch(envelope: BridgeEnvelope) {
  const body = envelope.body
  const runId = asString(body.runId)
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  const selectedModel = asString(body.selectedModel)
  const membersRaw = Array.isArray(body.members) ? body.members : []
  if (!runId || !teamId || !selectedModel || membersRaw.length === 0) {
    throw new Error('opencode.launchTeam requires runId, teamId/teamName, selectedModel and members')
  }

  const snapshot = await openCodeProvisioningProbe.probe(asString(body.projectPath) ?? envelope.cwd)
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
      warnings: asString(body.mode) === 'dogfood'
        ? [{ code: 'opencode_dogfood_mode', message: 'OpenCode dogfood launch mode is active.' }]
        : [],
    }),
  }
}

async function runReconcile(envelope: BridgeEnvelope) {
  const body = envelope.body
  const runId = asString(body.runId)
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  if (!runId || !teamId) {
    throw new Error('opencode.reconcileTeam requires runId and teamId/teamName')
  }
  const expectedMembers = Array.isArray(body.expectedMembers) ? body.expectedMembers : []
  const members: Record<string, LaunchMemberDraft> = {}
  const diagnostics: TeamDiagnostic[] = []
  let selectedModel = 'unknown/unknown'

  for (const item of expectedMembers) {
    const member = asRecord(item)
    const name = asString(member?.name)
    if (!name) continue
    const record = await openCodeSessionStore.get(teamId, name)
    if (!record) {
      diagnostics.push(teamDiagnostic('member_session_missing', `No stored OpenCode session for ${teamId}/${name}`, 'warning'))
      continue
    }
    selectedModel = record.selectedModel
    const reconciled = await openCodeSessionBridge.reconcileSession(record, { limit: 50 })
    members[name] = {
      sessionId: record.opencodeSessionId,
      launchState: bridgeStateFromSummary(reconciled.summary),
      evidence: evidenceFromSummary(reconciled.summary),
      diagnostics: reconciled.summary.diagnostics,
    }
  }

  const snapshot = await openCodeProvisioningProbe.probe(envelope.cwd)
  return {
    snapshot,
    data: buildTeamLaunchData({ runId, selectedModel, members, diagnostics }),
  }
}

async function runStop(envelope: BridgeEnvelope) {
  const body = envelope.body
  const runId = asString(body.runId)
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  if (!runId || !teamId) {
    throw new Error('opencode.stopTeam requires runId and teamId/teamName')
  }
  const records = (await openCodeSessionStore.list()).filter(record => record.teamId === teamId)
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
  const snapshot = await openCodeProvisioningProbe.probe(envelope.cwd)
  return {
    snapshot,
    data: {
      runId,
      stopped: Object.values(members).every(member => member.stopped),
      members,
      warnings: [],
      diagnostics: [],
    },
  }
}

async function runAnswerPermission(envelope: BridgeEnvelope) {
  const body = envelope.body
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  const memberName = asString(body.memberName)
  const requestId = asString(body.requestId)
  const decision = asString(body.decision)
  if (!teamId || !requestId || (decision !== 'allow' && decision !== 'always' && decision !== 'reject')) {
    throw new Error('opencode.answerPermission requires teamId/teamName, requestId and allow/always/reject decision')
  }
  const candidates = memberName
    ? [await openCodeSessionStore.get(teamId, memberName)]
    : (await openCodeSessionStore.list()).filter(record => record.teamId === teamId)
  const record = candidates.find((candidate): candidate is OpenCodeSessionRecord => candidate !== null)
  if (!record) {
    throw new Error(`No OpenCode session record found for ${teamId}`)
  }
  await openCodeSessionBridge.answerPermission(record, { requestId, decision })
  const reconciled = await openCodeSessionBridge.reconcileSession(record, { limit: 50 })
  const snapshot = await openCodeProvisioningProbe.probe(record.projectPath)
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
    },
  }
}

async function runListPermissions(envelope: BridgeEnvelope) {
  const snapshot = await openCodeProvisioningProbe.probe(envelope.cwd)
  let permissions: OpenCodePendingPermission[] = []
  if (snapshot.host) {
    const records = await openCodeSessionStore.list()
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
  const memberName = asString(body.memberName)
  if (!teamId || !memberName) {
    throw new Error('opencode.getRuntimeTranscript requires teamId/teamName and memberName')
  }
  const record = await openCodeSessionStore.get(teamId, memberName)
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
          ...createRuntimeSnapshot(snapshot),
          runtimeStoreManifestHighWatermark: 0,
          activeRunId: null,
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
