import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import nodePath from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { openCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import {
  type OpenCodeBridgeCommandEvidence,
  validateOpenCodeBridgeStateChangingPreconditions,
} from './OpenCodeBridgePreconditions.js'
import {
  hasOpenCodeBuiltinFreeModel,
  openCodeInventoryService,
} from './OpenCodeInventoryService.js'
import {
  buildOpenCodeModelAccessCatalogFromProvisioningSnapshot,
  evaluateOpenCodeModelAccess,
} from './OpenCodeModelAccessPolicy.js'
import {
  OPEN_CODE_APP_MCP_SERVER_NAME,
  type ResolvedAppMcpLaunchConfig,
  resolveOpenCodeAppMcpLaunchConfig,
} from './OpenCodeMcpManager.js'
import { resolveOpenCodeProviderScopedModel } from './OpenCodeModelResolver.js'
import { normalizeOpenCodePermissions } from './OpenCodePermissionNormalizer.js'
import { openCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import { openCodeHostManager } from './OpenCodeHostManager.js'
import { openCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { openCodeSessionBridge } from './OpenCodeSessionBridge.js'
import type { OpenCodePromptPart } from './OpenCodeSessionBridge.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'
import {
  observeOpenCodeDeliveryResponse,
  type OpenCodeDeliveryResponseObservation,
} from './OpenCodeDeliveryResponseObserver.js'
import {
  summarizeOpenCodeBootstrapMcpFailure,
  summarizeOpenCodeBootstrapMcpReadiness,
} from './OpenCodeBootstrapMcpFailure.js'
import { openCodeTurnSettledEmissionCoordinator } from './OpenCodeTurnSettledEmissionCoordinator.js'
import type { OpenCodeTurnSettledSummary } from './OpenCodeTurnSettledObserver.js'
import {
  OPENCODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION,
  openCodeLedgerBridgeService,
} from './OpenCodeLedgerBridgeService.js'
import {
  openCodeCommandOutcomeStore,
  type OpenCodeCommandOutcomePatch,
  type OpenCodeCommandOutcomeRecord,
  type OpenCodeCommandOutcomeSendMessageData,
  type OpenCodeCommandOutcomeStatus,
} from './OpenCodeCommandOutcomeStore.js'
import {
  getClaudeConfigHomeDir,
  isEnvDefinedFalsy,
} from '../../utils/envUtils.js'

import type { OpenCodeSnapshotBoundary } from './OpenCodeChangeEvidence.js'
import type {
  OpenCodeMessage,
  OpenCodePendingPermission,
  OpenCodeProvisioningSnapshot,
  OpenCodeSessionRecord,
  OpenCodeSessionReconcileSummary,
} from './types.js'

const BRIDGE_SCHEMA_VERSION = 1
const RUNTIME_STORE_MANIFEST_HIGH_WATERMARK = 0
// App-managed bootstrap deliberately bypasses the launch-time model tool-call
// requirement for OpenCode only. Bump this when changing the injected context
// or the candidate proof shape so the desktop app can reject stale evidence.
const OPENCODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION = 1
const OPENCODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION = 2
const OPENCODE_SEND_RECONCILE_TIMEOUT_MS = 5_000
const OPENCODE_OBSERVE_MESSAGE_TIMEOUT_MS = 8_000
// This is intentionally longer than the UI wait budget: the app can return
// acceptanceUnknown early while this bridge keeps observing the real turn.
const OPENCODE_SEND_TURN_SETTLED_TIMEOUT_MS = 25_000
const OPENCODE_SEND_TURN_SETTLED_IDLE_TIMEOUT_MS = 2_500
const OPENCODE_MESSAGE_SEND_TOOL_ERROR_FALLBACK_GRACE_MS = 6_000
const OPENCODE_MESSAGE_SEND_TOOL_ERROR_FALLBACK_GRACE_ENV =
  'AGENT_TEAMS_OPENCODE_MESSAGE_SEND_TOOL_ERROR_FALLBACK_GRACE_MS'
const OPEN_CODE_TEAMMATE_AGENT = 'teammate'
const OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT = 'teammate-bootstrap'
const SUPPORTED_COMMANDS = [
  'opencode.handshake',
  'opencode.commandStatus',
  'opencode.readiness',
  'opencode.cleanupHosts',
  'opencode.launchTeam',
  'opencode.reconcileTeam',
  'opencode.stopTeam',
  'opencode.sendMessage',
  'opencode.observeMessageDelivery',
  'opencode.answerPermission',
  'opencode.listRuntimePermissions',
  'opencode.getRuntimeTranscript',
  'opencode.backfillTaskLedger',
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
  pendingPermissionRequestIds?: string[]
  runtimePid?: number
  bootstrapEvidenceSource?: 'runtime_bootstrap_checkin' | 'app_managed_bootstrap'
  bootstrapMode?: 'model_tool_checkin' | 'app_managed_context'
  appManagedBootstrapCandidate?: OpenCodeAppManagedBootstrapCandidate
  evidence: Array<{ kind: string; observedAt: string }>
  diagnostics: string[]
}

type OpenCodeAppManagedBootstrapCandidate = {
  schemaVersion: 1
  source: 'app_managed_bootstrap'
  teamName: string
  memberName: string
  runId: string
  laneId: string
  runtimeSessionId: string
  messageID: string
  contextHash: string
  briefingHash: string
  injectionVerifiedAt: string
  candidateAt: string
  model?: string
  agent?: string
}

type SendMessageCommandData = {
  accepted: boolean
  runId?: string
  sessionId?: string
  memberName: string
  runtimePid?: number
  prePromptCursor?: string | null
  runtimePromptMessageId?: string
  snapshotBoundary?: OpenCodeSnapshotBoundary
  responseObservation?: OpenCodeDeliveryResponseObservation
  diagnostics: TeamDiagnostic[]
  idempotencyKey?: string
  manifestHighWatermark?: number | null
  runtimeStoreManifestHighWatermark?: number | null
}

type CommandStatusCommandData = {
  status:
    | 'unknown'
    | 'received'
    | 'prompt_submitting'
    | 'prompt_accepted'
    | 'turn_observed'
    | 'reconciled'
    | 'failed_before_accept'
    | 'failed_after_accept'
    | 'precondition_mismatch'
  safeToRetry: boolean
  accepted: boolean
  originalRequestId?: string
  deliveryAttemptId?: string
  sessionId?: string
  runtimePid?: number
  runtimePromptMessageId?: string
  prePromptCursor?: string | null
  sendMessageData?: SendMessageCommandData
  diagnostics: string[]
}

type ObserveMessageDeliveryCommandData = {
  observed: boolean
  sessionId?: string
  memberName: string
  runtimePid?: number
  runtimePromptMessageId?: string
  snapshotBoundary?: OpenCodeSnapshotBoundary
  responseObservation: OpenCodeDeliveryResponseObservation
  diagnostics: TeamDiagnostic[]
}

type SendMessageOutcomeBase = {
  requestId: string
  body: Record<string, unknown>
  teamId: string
  teamName: string
  laneId: string
  memberName: string
  projectPath: string
  runId: string | null
}

function teamDiagnosticToOutcomeString(diagnostic: TeamDiagnostic): string {
  return `${diagnostic.code}: ${diagnostic.message}`
}

function toOutcomeSendMessageData(data: SendMessageCommandData): OpenCodeCommandOutcomeSendMessageData | undefined {
  if (data.accepted !== true) {
    return undefined
  }
  return {
    accepted: true,
    ...(data.sessionId ? { sessionId: data.sessionId } : {}),
    memberName: data.memberName,
    ...(typeof data.runtimePid === 'number' && data.runtimePid > 0
      ? { runtimePid: data.runtimePid }
      : {}),
    ...(data.prePromptCursor !== undefined ? { prePromptCursor: data.prePromptCursor } : {}),
    ...(data.runtimePromptMessageId ? { runtimePromptMessageId: data.runtimePromptMessageId } : {}),
    ...(data.responseObservation ? { responseObservation: data.responseObservation } : {}),
    diagnostics: data.diagnostics,
  }
}

async function markSendMessageOutcome(
  base: SendMessageOutcomeBase,
  input: {
    status: OpenCodeCommandOutcomeStatus
    sessionId?: string | null
    runtimePid?: number | null
    prePromptCursor?: string | null
    runtimePromptMessageId?: string | null
    acceptedAt?: string | null
    turnObservedAt?: string | null
    completedAt?: string | null
    error?: string | null
    diagnostics?: string[]
    sendMessageData?: SendMessageCommandData
  },
): Promise<void> {
  const patch: OpenCodeCommandOutcomePatch = {
    requestId: base.requestId,
    status: input.status,
    teamId: base.teamId,
    teamName: base.teamName,
    laneId: base.laneId,
    memberName: base.memberName,
    projectPath: base.projectPath,
    runId: base.runId,
    deliveryAttemptId: asString(base.body.deliveryAttemptId) ?? undefined,
    messageId: asString(base.body.messageId),
    payloadHash: asString(base.body.payloadHash),
    sessionId: input.sessionId ?? undefined,
    runtimePid: input.runtimePid ?? undefined,
    prePromptCursor: input.prePromptCursor ?? undefined,
    runtimePromptMessageId: input.runtimePromptMessageId ?? undefined,
    acceptedAt: input.acceptedAt ?? undefined,
    turnObservedAt: input.turnObservedAt ?? undefined,
    completedAt: input.completedAt ?? undefined,
    error: input.error ?? undefined,
    diagnostics: input.diagnostics,
    sendMessageData: input.sendMessageData ? toOutcomeSendMessageData(input.sendMessageData) : undefined,
  }
  await openCodeCommandOutcomeStore.upsert(patch)
}

function commandStatusFromOutcomeStatus(
  status: OpenCodeCommandOutcomeStatus,
): CommandStatusCommandData['status'] {
  if (
    status === 'received' ||
    status === 'preconditions_checked' ||
    status === 'session_resolved' ||
    status === 'mcp_ready'
  ) {
    return 'received'
  }
  return status
}

function isAcceptedOutcomeStatus(status: CommandStatusCommandData['status']): boolean {
  return (
    status === 'prompt_accepted' ||
    status === 'turn_observed' ||
    status === 'reconciled' ||
    status === 'failed_after_accept'
  )
}

function outcomeSendMessageDataToCommandData(
  data: OpenCodeCommandOutcomeSendMessageData | undefined,
): SendMessageCommandData | undefined {
  if (!data) {
    return undefined
  }
  return {
    accepted: true,
    ...(data.sessionId ? { sessionId: data.sessionId } : {}),
    memberName: data.memberName,
    ...(typeof data.runtimePid === 'number' && data.runtimePid > 0
      ? { runtimePid: data.runtimePid }
      : {}),
    ...(data.prePromptCursor !== undefined ? { prePromptCursor: data.prePromptCursor } : {}),
    ...(data.runtimePromptMessageId ? { runtimePromptMessageId: data.runtimePromptMessageId } : {}),
    ...(data.responseObservation ? { responseObservation: data.responseObservation } : {}),
    diagnostics: data.diagnostics,
  }
}

function messageMatchesRuntimePromptId(message: OpenCodeMessage, runtimePromptMessageId: string): boolean {
  const info = asRecord(message.info)
  return asString(info?.id) === runtimePromptMessageId && asString(info?.role) === 'user'
}

function commandStatusMismatchReason(
  record: OpenCodeCommandOutcomeRecord,
  body: Record<string, unknown>,
): string | null {
  const expectedCommand = asString(body.originalCommand)
  if (expectedCommand && expectedCommand !== 'opencode.sendMessage') {
    return 'originalCommand mismatch'
  }
  const teamId = asString(body.teamId)
  if (teamId && teamId !== record.teamId) {
    return 'teamId mismatch'
  }
  const teamName = asString(body.teamName)
  if (teamName && teamName !== record.teamName) {
    return 'teamName mismatch'
  }
  const laneId = asString(body.laneId)
  if (laneId && laneId !== record.laneId) {
    return 'laneId mismatch'
  }
  const memberName = asString(body.memberName)
  if (memberName && memberName !== record.memberName) {
    return 'memberName mismatch'
  }
  const messageId = asString(body.messageId)
  if (messageId && messageId !== record.messageId) {
    return 'messageId mismatch'
  }
  const payloadHash = asString(body.payloadHash)
  if (payloadHash && payloadHash !== record.payloadHash) {
    return 'payloadHash mismatch'
  }
  const projectPath = asString(body.projectPath)
  if (projectPath && projectPath !== record.projectPath) {
    return 'projectPath mismatch'
  }
  const runId = asString(body.runId)
  if (runId && runId !== record.runId) {
    return 'runId mismatch'
  }
  return null
}

async function findPromptAcceptedEvidenceReadOnly(input: {
  record: OpenCodeCommandOutcomeRecord
  runtimePromptMessageId: string
}): Promise<{
  accepted: boolean
  source: 'offline_sqlite' | 'active_host' | null
  diagnostics: string[]
}> {
  const diagnostics: string[] = []
  const sessionRecord = await openCodeSessionStore.get(
    input.record.teamId,
    input.record.laneId,
    input.record.memberName,
  )
  if (!sessionRecord) {
    return {
      accepted: false,
      source: null,
      diagnostics: ['OpenCode command status could not find the stored session record.'],
    }
  }
  if (input.record.sessionId && sessionRecord.opencodeSessionId !== input.record.sessionId) {
    return {
      accepted: false,
      source: null,
      diagnostics: [
        `OpenCode command status session mismatch: outcome=${input.record.sessionId}, store=${sessionRecord.opencodeSessionId}.`,
      ],
    }
  }

  const offline = await openCodeOfflineSessionReader.readSession(sessionRecord)
  if (offline) {
    diagnostics.push(...offline.diagnostics)
    if (offline.messages.some(message => messageMatchesRuntimePromptId(message, input.runtimePromptMessageId))) {
      return {
        accepted: true,
        source: 'offline_sqlite',
        diagnostics,
      }
    }
  }

  const activeHost = openCodeHostManager.getHost(sessionRecord.hostKey)
  if (!activeHost) {
    return {
      accepted: false,
      source: null,
      diagnostics: [...diagnostics, 'OpenCode command status found no already-active host for live transcript proof.'],
    }
  }

  try {
    const client = openCodeClientFactory.create(activeHost.baseUrl)
    const message = client.getSessionMessage
      ? await client.getSessionMessage(sessionRecord.opencodeSessionId, input.runtimePromptMessageId)
      : null
    if (message && messageMatchesRuntimePromptId(message, input.runtimePromptMessageId)) {
      return {
        accepted: true,
        source: 'active_host',
        diagnostics,
      }
    }
    if (!client.getSessionMessage) {
      const messages = await client.getSessionMessages(sessionRecord.opencodeSessionId, 100)
      if (messages.some(candidate => messageMatchesRuntimePromptId(candidate, input.runtimePromptMessageId))) {
        return {
          accepted: true,
          source: 'active_host',
          diagnostics,
        }
      }
    }
  } catch (error) {
    diagnostics.push(
      `OpenCode command status live transcript proof failed - ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return {
    accepted: false,
    source: null,
    diagnostics,
  }
}

async function buildCommandStatusReadOnlySnapshot(projectPath: string): Promise<OpenCodeProvisioningSnapshot> {
  const inventory = await openCodeInventoryService.probe(projectPath)
  return {
    detected: inventory.detected,
    hostHealthy: false,
    projectPath: inventory.projectPath,
    models: [...inventory.models],
    modelMetadata: [...(inventory.modelMetadata ?? [])],
    profile: inventory.profile,
    host: null,
    config: null,
    configProviders: null,
    providers: null,
    providerAuth: null,
    agents: [],
    mcp: null,
    appMcp: null,
    probeError: inventory.probeError,
    diagnostics: [
      ...inventory.diagnostics,
      'OpenCode command status used read-only inventory snapshot; host state was not probed.',
    ],
  }
}

const REQUIRED_AGENT_TEAMS_DIRECT_MCP_TOOL_NAMES = [
  'cross_team_get_outbox',
  'cross_team_list_targets',
  'cross_team_send',
  'message_send',
  'process_list',
  'process_register',
  'process_stop',
  'process_unregister',
  'review_approve',
  'review_request',
  'review_request_changes',
  'review_start',
  'runtime_deliver_message',
  'runtime_task_event',
  'runtime_heartbeat',
  'task_add_comment',
  'task_attach_comment_file',
  'task_attach_file',
  'task_briefing',
  'task_complete',
  'task_create',
  'task_create_from_message',
  'task_get',
  'task_get_comment',
  'task_link',
  'task_list',
  'task_set_clarification',
  'task_set_owner',
  'task_set_status',
  'task_start',
  'task_unlink',
] as const

const REQUIRED_AGENT_TEAMS_DIRECT_MCP_TOOL_IDS = REQUIRED_AGENT_TEAMS_DIRECT_MCP_TOOL_NAMES.map(tool =>
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

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseOpenCodePromptFileParts(value: unknown): OpenCodePromptPart[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new Error('OpenCode attachment parts must be an array.')
  }

  return value.map((item, index): OpenCodePromptPart => {
    const record = asRecord(item)
    if (!record || record.type !== 'file') {
      throw new Error(`OpenCode attachment part at index ${index} must be a file part.`)
    }
    const mime = asString(record.mime)
    const url = asString(record.url)
    const filename = asString(record.filename)
    if (!mime || !url || !filename) {
      throw new Error(`OpenCode file part at index ${index} is missing mime, url, or filename.`)
    }
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') {
      throw new Error(`OpenCode file part at index ${index} has unsupported MIME: ${mime}`)
    }
    if (!url.startsWith(`data:${mime};base64,`)) {
      throw new Error(`OpenCode file part at index ${index} must use a matching data URL.`)
    }
    return {
      type: 'file',
      mime,
      url,
      filename,
    }
  })
}

function assertUniqueOpenCodeMemberNames(items: unknown[], context: string): void {
  const seen = new Set<string>()
  for (const [index, item] of items.entries()) {
    const name = asString(asRecord(item)?.name)
    if (!name) {
      throw new Error(`${context} contains member without a valid name at index ${index}`)
    }
    const key = name.toLowerCase()
    if (seen.has(key)) {
      throw new Error(`${context} contains duplicate member name "${name}"`)
    }
    seen.add(key)
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalizeStable(value))).digest('hex')
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function buildOpenCodeAppManagedBootstrapMessageID(input: {
  teamName: string
  memberName: string
  runId: string
  laneId: string
  runtimeSessionId: string
  contextHash: string
}): string {
  const digest = hashStable({
    purpose: 'opencode-app-managed-bootstrap-message-id-v2',
    teamName: input.teamName,
    memberName: input.memberName,
    runId: input.runId,
    laneId: input.laneId,
    runtimeSessionId: input.runtimeSessionId,
    contextHash: input.contextHash,
  })
  return `msg_000000000000${digest.slice(0, 14)}`
}

function getOpenCodeSessionCompatibilityStaleReason(record: OpenCodeSessionRecord): string | null {
  const bootstrapMessageId = record.appManagedBootstrap?.messageID
  if (!bootstrapMessageId) return null
  return bootstrapMessageId.startsWith('msg_')
    ? null
    : 'app_managed_bootstrap_message_id_not_opencode_sortable'
}

function buildOpenCodeAppManagedBootstrapContextText(input: {
  teamName: string
  memberName: string
  runId: string
  laneId: string
  runtimeSessionId: string
  prompt: string
}): string {
  const runtimeIdentity = {
    teamName: input.teamName,
    memberName: input.memberName,
    runtimeProvider: 'opencode',
    runtimeSessionId: input.runtimeSessionId,
    runId: input.runId,
    laneId: input.laneId,
  }
  return [
    '<agent_teams_app_managed_bootstrap>',
    'AGENT_TEAMS_APP_MANAGED_BOOTSTRAP_V1',
    'This OpenCode teammate session was created, attached to Agent Teams MCP, and bootstrapped by the desktop app.',
    'The app has already injected your team/member context and will verify runtime availability outside of the model turn.',
    'Do not call runtime_bootstrap_checkin or member_briefing just to prove launch readiness.',
    'When a real user, lead, teammate, task, or runtime-delivery message arrives, answer or act on that message normally.',
    'For visible replies, use the exposed Agent Teams message_send tool when available. Do not use SendMessage.',
    `Runtime identity: ${xmlEscape(JSON.stringify(runtimeIdentity))}`,
    '<member_briefing_context>',
    xmlEscape(input.prompt),
    '</member_briefing_context>',
    '</agent_teams_app_managed_bootstrap>',
  ].join('\n')
}

function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// OpenCode can report a session before the app MCP attach is visible inside
// that session. Use a small bounded wait here, but keep launch availability
// gated by committed desktop-side evidence, not by this readiness check alone.
async function waitForLaunchSessionAppMcpReady(
  record: OpenCodeSessionRecord,
  options: { attachIfMissing?: boolean } = {},
): Promise<Awaited<ReturnType<typeof openCodeSessionBridge.ensureSessionAppMcpReady>>> {
  const delays = [0, 250, 750, 1_500]
  const attachIfMissing = options.attachIfMissing ?? true
  let latest: Awaited<ReturnType<typeof openCodeSessionBridge.ensureSessionAppMcpReady>> | null = null
  for (const [index, delay] of delays.entries()) {
    if (delay > 0) {
      await delayMs(delay)
    }
    latest = await openCodeSessionBridge.ensureSessionAppMcpReady(record, {
      attachIfMissing: attachIfMissing && (index === 0 || latest?.connected !== true),
    })
    if (latest.ok) {
      return latest
    }
  }
  return latest ?? openCodeSessionBridge.ensureSessionAppMcpReady(record, { attachIfMissing })
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

function canonicalizeAppMcpToolId(rawName: string): string {
  const prefixes = [
    `mcp__${OPEN_CODE_APP_MCP_SERVER_NAME}__`,
    'mcp__agent_teams__',
    `${OPEN_CODE_APP_MCP_SERVER_NAME}_`,
    'agent_teams_',
  ]
  const rawTrimmed = rawName.trim()
  const proxyStripped = rawTrimmed.startsWith('proxy_') ? rawTrimmed.slice('proxy_'.length) : rawTrimmed
  const trimmed =
    rawTrimmed.startsWith('proxy_') && prefixes.some(prefix => proxyStripped.startsWith(prefix))
      ? proxyStripped
      : rawTrimmed
  let toolName = trimmed
  for (const prefix of prefixes) {
    if (toolName.startsWith(prefix)) {
      toolName = toolName.slice(prefix.length)
      break
    }
  }
  return `${OPEN_CODE_APP_MCP_SERVER_NAME}_${toolName}`
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index]!, index)
    }
  }))
  return results
}

function buildOpenCodeRuntimeIdentityBlock(input: {
  teamName: string
  memberName: string
  runId: string
  runtimeSessionId: string
  purpose?: 'launch' | 'reminder'
}): string {
  const purpose = input.purpose ?? 'reminder'
  const checkinPayload = {
    teamName: input.teamName,
    runId: input.runId,
    memberName: input.memberName,
    runtimeSessionId: input.runtimeSessionId,
  }
  const briefingPayload = {
    teamName: input.teamName,
    memberName: input.memberName,
    runtimeProvider: 'opencode',
  }

  return [
    '<opencode_runtime_identity>',
    'You are an OpenCode teammate managed by the desktop app.',
    purpose === 'launch'
      ? 'Launch bootstrap is app-managed. This context is an identity attachment, not a request to prove readiness with bootstrap tools.'
      : 'Runtime identity reminder for this delivered app message. This session is already attached by the app; do not call runtime_bootstrap_checkin just to answer this delivered message unless the app explicitly asks you to re-check in.',
    `Attached runtime context: ${JSON.stringify(checkinPayload)}`,
    purpose === 'launch'
      ? 'Do not call member_briefing just to prove launch readiness. Wait for app-delivered messages or actionable task assignments.'
      : 'Do not call member_briefing just to answer this delivered message unless the app explicitly asks you to refresh teammate rules.',
    `Attached teammate context: ${JSON.stringify(briefingPayload)}`,
    ...(purpose === 'launch'
      ? [
          'Launch bootstrap is a silent attach, not a user/team conversation turn.',
          'Do not call task_briefing, message_send, or cross_team_send just to announce readiness, say understood, report no tasks, or ask for work.',
          'If the briefing says there are no actionable tasks, stay idle silently.',
        ]
      : [
          'For this delivered app message, prioritize the requested visible reply through message_send.',
          'Only send a visible message when you are replying to this delivered app message or reporting real task/blocker/result context.',
          'Do not send unrelated readiness, understood, idle, or no-task acknowledgements.',
        ]),
    'For visible team/app messages, use the exposed Agent Teams message_send tool, usually agent-teams_message_send or mcp__agent-teams__message_send. Do not use SendMessage.',
    'Do not use runtime_deliver_message for ordinary visible replies unless a runtime-delivery prompt explicitly provides runId/runtimeSessionId/idempotencyKey.',
    '</opencode_runtime_identity>',
  ].join('\n')
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

function createRuntimePreconditionSnapshot(
  snapshot?: OpenCodeProvisioningSnapshot | null,
  overrides: { runtimeStoreManifestHighWatermark?: number | null } = {},
) {
  return {
    ...createRuntimeSnapshot(snapshot),
    runtimeStoreManifestHighWatermark:
      overrides.runtimeStoreManifestHighWatermark ?? RUNTIME_STORE_MANIFEST_HIGH_WATERMARK,
    activeRunId: null,
  }
}

function shouldUseLightweightLaunchHandshake(body: Record<string, unknown>): boolean {
  if (body.requiredCommand !== 'opencode.launchTeam') {
    return false
  }
  if (asString(body.expectedCapabilitySnapshotId)) {
    return false
  }
  const preconditions = asRecord(body.preconditions)
  if (asString(preconditions?.expectedCapabilitySnapshotId)) {
    return false
  }
  return true
}

function createBridgeServerIdentity(
  snapshot?: OpenCodeProvisioningSnapshot | null,
  overrides: { runtimeStoreManifestHighWatermark?: number | null } = {},
) {
  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    peer: 'agent_teams_orchestrator',
    appVersion: '1.0.0',
    gitSha: null,
    buildId: null,
    bridgeProtocol: {
      minVersion: 1,
      currentVersion: 1,
      supportedCommands: SUPPORTED_COMMANDS,
      opencodeTaskLedgerEvidenceContractVersion: OPENCODE_TASK_LEDGER_EVIDENCE_CONTRACT_VERSION,
      opencodeAppManagedBootstrapContractVersion: OPENCODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
      opencodeDeliveryAcceptanceContractVersion: OPENCODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION,
    },
    runtime: {
      ...createRuntimePreconditionSnapshot(snapshot, overrides),
    },
    featureFlags: {
      opencodeTeamLaunch: true,
      opencodeStateChangingCommands: true,
    },
  }
}

function isTerminalForSnapshotBoundary(observation: OpenCodeDeliveryResponseObservation): boolean {
  return observation.state === 'responded_visible_message' ||
    observation.state === 'responded_plain_text' ||
    observation.state === 'responded_tool_call' ||
    observation.state === 'responded_non_visible_tool' ||
    observation.state === 'tool_error'
}

function buildSnapshotBoundaryStatus(input: {
  snapshot: OpenCodeProvisioningSnapshot
  responseObservation: OpenCodeDeliveryResponseObservation
}): OpenCodeSnapshotBoundary {
  const snapshotEnabled = input.snapshot.config?.snapshot === true ||
    input.snapshot.profile?.managedConfig?.snapshot === true
  if (!snapshotEnabled) {
    return {
      schemaVersion: 1,
      captureStatus: 'snapshot-disabled',
      ...(input.snapshot.host?.version ? { opencodeVersion: input.snapshot.host.version } : {}),
    }
  }
  if (!isTerminalForSnapshotBoundary(input.responseObservation)) {
    return {
      schemaVersion: 1,
      captureStatus: 'not-terminal',
      ...(input.snapshot.host?.version ? { opencodeVersion: input.snapshot.host.version } : {}),
    }
  }
  return {
    schemaVersion: 1,
    captureStatus: 'not-configured',
    ...(input.snapshot.host?.version ? { opencodeVersion: input.snapshot.host.version } : {}),
    diagnostics: ['OpenCode snapshot boundary capture provider is not configured for production use.'],
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

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(Date.now() - startedAt))
}

function formatMs(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}ms` : 'n/a'
}

function reconcileFailedObservation(message: string): OpenCodeDeliveryResponseObservation {
  return {
    state: 'reconcile_failed',
    deliveredUserMessageId: null,
    assistantMessageId: null,
    toolCallNames: [],
    visibleMessageToolCallId: null,
    visibleReplyMessageId: null,
    visibleReplyCorrelation: null,
    latestAssistantPreview: null,
    reason: message,
  }
}

function isMessageSendToolErrorObservation(
  observation: OpenCodeDeliveryResponseObservation | undefined,
): boolean {
  return observation?.state === 'tool_error' &&
    observation.toolCallNames.includes('message_send')
}

function shouldContinueMessageSendToolErrorFallbackGrace(
  observation: OpenCodeDeliveryResponseObservation | undefined,
): boolean {
  if (!observation) return false
  if (isMessageSendToolErrorObservation(observation)) return true
  return observation.state === 'pending' ||
    observation.state === 'empty_assistant_turn' ||
    observation.state === 'prompt_delivered_no_assistant_message'
}

function messageSendToolErrorFallbackGraceMs(): number {
  const configured = Number(process.env[OPENCODE_MESSAGE_SEND_TOOL_ERROR_FALLBACK_GRACE_ENV])
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.min(Math.round(configured), 10_000)
  }
  return OPENCODE_MESSAGE_SEND_TOOL_ERROR_FALLBACK_GRACE_MS
}

async function reobserveAfterMessageSendToolErrorFallbackGrace(input: {
  record: OpenCodeSessionRecord
  inboundMessageId: string | null
  prePromptCursor: string | null
  runtimePromptMessageId?: string | null
  sessionId?: string | null
  timeoutMs: number
  limit?: number
  diagnosticCode: string
}): Promise<{
  record: OpenCodeSessionRecord
  summary: OpenCodeSessionReconcileSummary
  responseObservation: OpenCodeDeliveryResponseObservation
  diagnostics: TeamDiagnostic[]
}> {
  const fallbackGraceMs = messageSendToolErrorFallbackGraceMs()
  const startedAt = Date.now()
  const pollIntervalMs = Math.min(1_000, Math.max(1, Math.floor(fallbackGraceMs / 4)))
  let attemptCount = 0
  let reconciled: Awaited<ReturnType<typeof openCodeSessionBridge.reconcileSession>> | null = null
  let responseObservation: OpenCodeDeliveryResponseObservation | null = null

  do {
    const elapsedMs = Math.max(0, Date.now() - startedAt)
    const waitMs = Math.min(pollIntervalMs, Math.max(0, fallbackGraceMs - elapsedMs))
    if (waitMs > 0) {
      await delayMs(waitMs)
    }
    attemptCount += 1
    reconciled = await withTimeout(
      openCodeSessionBridge.reconcileSession(
        input.record,
        typeof input.limit === 'number' || input.sessionId
          ? { limit: input.limit, sessionId: input.sessionId }
          : undefined,
      ),
      input.timeoutMs,
    )
    responseObservation = observeOpenCodeDeliveryResponse({
      inboundMessageId: input.inboundMessageId,
      prePromptCursor: input.prePromptCursor,
      runtimePromptMessageId: input.runtimePromptMessageId,
      summary: reconciled.summary,
    })
  } while (
    shouldContinueMessageSendToolErrorFallbackGrace(responseObservation) &&
    Date.now() - startedAt < fallbackGraceMs
  )

  if (!reconciled || !responseObservation) {
    throw new Error('OpenCode message_send tool_error fallback reobserve did not run')
  }

  return {
    record: reconciled.record,
    summary: reconciled.summary,
    responseObservation,
    diagnostics: [
      teamDiagnostic(
        `${input.diagnosticCode}_message_send_tool_error_fallback_grace`,
        `Reconciled OpenCode session during ${fallbackGraceMs}ms message_send tool_error fallback grace (${attemptCount} attempt${attemptCount === 1 ? '' : 's'}).`,
        'info',
      ),
      ...reconciled.summary.diagnostics.map(message =>
        teamDiagnostic(input.diagnosticCode, message, 'info'),
      ),
    ],
  }
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

// Cold workspace/source MCP startup can take longer than a model turn on dev
// machines. Keep this below the outer readiness timeout but avoid false launch
// failures before OpenCode ever gets a chance to attach Agent Teams tools.
const APP_MCP_PREFLIGHT_TIMEOUT_MS = 45_000
const APP_MCP_PREFLIGHT_CLOSE_TIMEOUT_MS = 2_000
const APP_MCP_TOOL_PROOF_CACHE_TTL_MS = 15_000
const APP_MCP_TOOL_PROOF_PERSISTED_CACHE_VERSION = 1
const APP_MCP_TOOL_PROOF_PERSISTED_CACHE_TTL_MS = 10 * 60_000
const APP_MCP_TOOL_PROOF_PERSISTED_CACHE_PATH_ENV =
  'AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_PATH'
const APP_MCP_TOOL_PROOF_PERSISTED_CACHE_DISABLED_ENV =
  'AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED'

type AppMcpToolProofCacheEntry = {
  expiresAt: number
  proof: AppMcpToolProof
}

type AppMcpToolProofPersistedCacheEntry = {
  expiresAt: number
  proof: AppMcpToolProof
}

type AppMcpToolProofPersistedCacheFile = {
  version: typeof APP_MCP_TOOL_PROOF_PERSISTED_CACHE_VERSION
  entries: Record<string, AppMcpToolProofPersistedCacheEntry>
}

const appMcpToolProofCache = new Map<string, AppMcpToolProofCacheEntry>()
const appMcpToolProofInFlight = new Map<string, Promise<AppMcpToolProof>>()

async function createAppMcpToolProofCacheKey(
  launchConfig: ResolvedAppMcpLaunchConfig,
): Promise<string> {
  return hashStable({
    source: launchConfig.source,
    config: launchConfig.config,
    commandFiles: await fingerprintAppMcpLaunchCommandFiles(launchConfig.config.command),
  })
}

export function __resetAppMcpToolProofCacheForTests(): void {
  appMcpToolProofCache.clear()
  appMcpToolProofInFlight.clear()
}

async function fingerprintAppMcpLaunchCommandFiles(
  command: string[] | undefined,
): Promise<Array<{ path: string; size: number; mtimeMs: number } | { path: string; missing: true }>> {
  if (!command || command.length === 0) {
    return []
  }

  const absolutePaths = uniqueSortedStrings(
    command.filter(item => typeof item === 'string' && nodePath.isAbsolute(item)),
  )

  return Promise.all(absolutePaths.map(async item => {
    try {
      const stats = await stat(item)
      return {
        path: item,
        size: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs),
      }
    } catch {
      return {
        path: item,
        missing: true as const,
      }
    }
  }))
}

function appMcpToolProofPersistentCacheEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env[APP_MCP_TOOL_PROOF_PERSISTED_CACHE_DISABLED_ENV])
}

function getAppMcpToolProofPersistedCachePath(): string {
  const override = process.env[APP_MCP_TOOL_PROOF_PERSISTED_CACHE_PATH_ENV]?.trim()
  if (override) {
    return override
  }
  return nodePath.join(
    getClaudeConfigHomeDir(),
    'opencode',
    'app-mcp-tool-proof-cache.json',
  )
}

async function readAppMcpToolProofPersistedCache(): Promise<AppMcpToolProofPersistedCacheFile> {
  if (!appMcpToolProofPersistentCacheEnabled()) {
    return {
      version: APP_MCP_TOOL_PROOF_PERSISTED_CACHE_VERSION,
      entries: {},
    }
  }

  try {
    const raw = await readFile(getAppMcpToolProofPersistedCachePath(), 'utf8')
    const parsed = asRecord(JSON.parse(raw))
    if (parsed?.version !== APP_MCP_TOOL_PROOF_PERSISTED_CACHE_VERSION) {
      return {
        version: APP_MCP_TOOL_PROOF_PERSISTED_CACHE_VERSION,
        entries: {},
      }
    }
    const entriesRecord = asRecord(parsed.entries) ?? {}
    const entries: Record<string, AppMcpToolProofPersistedCacheEntry> = {}
    const now = Date.now()
    for (const [key, value] of Object.entries(entriesRecord)) {
      const entry = asRecord(value)
      const proof = asRecord(entry?.proof)
      const expiresAt = typeof entry?.expiresAt === 'number' ? entry.expiresAt : 0
      if (expiresAt <= now || !proof) {
        continue
      }
      const normalizedProof = normalizeAppMcpToolProof(proof)
      if (!normalizedProof?.ok) {
        continue
      }
      entries[key] = {
        expiresAt,
        proof: normalizedProof,
      }
    }
    return {
      version: APP_MCP_TOOL_PROOF_PERSISTED_CACHE_VERSION,
      entries,
    }
  } catch {
    return {
      version: APP_MCP_TOOL_PROOF_PERSISTED_CACHE_VERSION,
      entries: {},
    }
  }
}

function normalizeAppMcpToolProof(value: Record<string, unknown>): AppMcpToolProof | null {
  const ok = value.ok === true
  const observedTools = asStringArray(value.observedTools).sort()
  const missingTools = asStringArray(value.missingTools).sort()
  const diagnostics = asStringArray(value.diagnostics)
  const route = asString(value.route)
  if (!ok) {
    return null
  }
  return {
    ok,
    observedTools,
    missingTools,
    diagnostics,
    route,
  }
}

async function readPersistedAppMcpToolProof(
  cacheKey: string,
): Promise<AppMcpToolProof | null> {
  const cache = await readAppMcpToolProofPersistedCache()
  const entry = cache.entries[cacheKey]
  if (!entry || entry.expiresAt <= Date.now()) {
    return null
  }
  return {
    ...entry.proof,
    diagnostics: [
      ...entry.proof.diagnostics,
      'opencode_app_mcp_tool_proof_persisted_cache_hit',
    ],
  }
}

async function writePersistedAppMcpToolProof(
  cacheKey: string,
  proof: AppMcpToolProof,
): Promise<void> {
  if (!appMcpToolProofPersistentCacheEnabled() || !proof.ok) {
    return
  }

  const cachePath = getAppMcpToolProofPersistedCachePath()
  const cache = await readAppMcpToolProofPersistedCache()
  cache.entries[cacheKey] = {
    expiresAt: Date.now() + APP_MCP_TOOL_PROOF_PERSISTED_CACHE_TTL_MS,
    proof,
  }

  await mkdir(nodePath.dirname(cachePath), { recursive: true })
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(cache)}\n`, 'utf8')
  await rename(tmpPath, cachePath)
}

async function proveAppMcpTools(
  snapshot: OpenCodeProvisioningSnapshot,
): Promise<AppMcpToolProof> {
  if (!snapshot.host) {
    return {
      ok: false,
      observedTools: [],
      missingTools: [...REQUIRED_AGENT_TEAMS_DIRECT_MCP_TOOL_IDS],
      diagnostics: ['OpenCode host is unavailable; app MCP tools cannot be proven'],
      route: null,
    }
  }

  const launchConfig = await resolveOpenCodeAppMcpLaunchConfig()
  const cacheKey = await createAppMcpToolProofCacheKey(launchConfig)
  const cached = appMcpToolProofCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.proof
  }

  const persisted = await readPersistedAppMcpToolProof(cacheKey)
  if (persisted) {
    appMcpToolProofCache.set(cacheKey, {
      expiresAt: Date.now() + APP_MCP_TOOL_PROOF_CACHE_TTL_MS,
      proof: persisted,
    })
    return persisted
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
        await writePersistedAppMcpToolProof(cacheKey, proof).catch(() => undefined)
      }
      return proof
    } catch (error) {
      return {
        ok: false,
        observedTools: [],
        missingTools: [...REQUIRED_AGENT_TEAMS_DIRECT_MCP_TOOL_IDS],
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
  const remoteUrl = launchConfig.config.url
  if (launchConfig.config.type === 'remote' || remoteUrl) {
    if (!remoteUrl) {
      throw new Error('Agent Teams MCP launch config is missing a remote URL')
    }

    const url = new URL(remoteUrl)
    const transportOptions = launchConfig.config.headers
      ? {
          requestInit: {
            headers: launchConfig.config.headers,
          },
        }
      : undefined
    const transports = [
      () => new StreamableHTTPClientTransport(url, transportOptions),
      () => new SSEClientTransport(url, transportOptions),
    ]
    let lastError: unknown = null

    for (const createTransport of transports) {
      const client = new Client({
        name: 'agent-teams-opencode-readiness',
        version: '1.0.0',
      })
      const transport = createTransport()
      try {
        await withTimeout(client.connect(transport), APP_MCP_PREFLIGHT_TIMEOUT_MS)
        const result = await withTimeout(client.listTools(), APP_MCP_PREFLIGHT_TIMEOUT_MS)
        return (result.tools ?? [])
          .map(tool => tool.name)
          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      } catch (error) {
        lastError = error
      } finally {
        await closeMcpClient(client)
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? 'Agent Teams MCP remote tools/list preflight failed'))
  }

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
  } finally {
    await closeMcpClient(client)
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

async function closeMcpClient(client: Client): Promise<void> {
  await withTimeout(client.close(), APP_MCP_PREFLIGHT_CLOSE_TIMEOUT_MS).catch(() => undefined)
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
  const observed = new Set(observedTools.map(canonicalizeAppMcpToolId))
  const missingTools = REQUIRED_AGENT_TEAMS_DIRECT_MCP_TOOL_IDS.filter(tool => !observed.has(tool))
  return {
    ok: missingTools.length === 0,
    observedTools: Array.from(observed).sort(),
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
  const models = getOpenCodeAccessPolicyModels(snapshot)
  const appMcpConnected = snapshot.appMcp?.connected === true || snapshot.appMcp?.status === 'present' || snapshot.appMcp?.status === 'attached'
  const requiredToolsPresent = appMcpConnected && toolProof.ok
  const hasAuthFreeOpenCodeProvider = hasOpenCodeBuiltinFreeModel(models, snapshot.modelMetadata)
  const selectedModelAccess = evaluateOpenCodeModelAccess({
    selectedModel,
    catalog: getOpenCodeAccessPolicyCatalog(snapshot),
    executionOutcome,
  })
  const hasLaunchProvider =
    connectedProviders.length > 0
    || hasAuthFreeOpenCodeProvider
    || selectedModelAccess.launchAllowed
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
  } else if (!hasLaunchProvider) {
    state = 'not_authenticated'
    launchAllowed = false
    missing.push(selectedModelAccess.reason ?? 'No connected OpenCode providers found')
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
  } else if (
    selectedModelAccess.kind === 'configured_authless'
    && selectedModelAccess.requiresExecutionProof
  ) {
    state = 'not_authenticated'
    launchAllowed = false
    missing.push(selectedModelAccess.reason ?? 'OpenCode selected model requires execution verification')
  } else if (selectedModelAccess.kind === 'unknown_model') {
    state = 'model_unavailable'
    launchAllowed = false
    missing.push(selectedModelAccess.reason ?? 'OpenCode selected model is unavailable')
  } else if (selectedModelAccess.kind === 'not_authenticated') {
    state = 'not_authenticated'
    launchAllowed = false
    missing.push(selectedModelAccess.reason ?? 'OpenCode selected model provider is not connected')
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

function getOpenCodeAccessPolicyModels(snapshot: OpenCodeProvisioningSnapshot): string[] {
  return Array.from(new Set([
    ...(snapshot.configProviders?.providers
      ?.flatMap(provider => {
        const providerId = asString(provider.id)
        return providerId
          ? Object.keys(asRecord(provider.models) ?? {}).map(model => `${providerId}/${model}`)
          : []
      })
      ?? []),
    ...(snapshot.models ?? []),
  ])).sort()
}

function getOpenCodeAccessPolicyCatalog(snapshot: OpenCodeProvisioningSnapshot) {
  return buildOpenCodeModelAccessCatalogFromProvisioningSnapshot({
    ...snapshot,
    models: getOpenCodeAccessPolicyModels(snapshot),
  })
}

function isAppManagedOpenCodeBootstrap(
  record: Pick<OpenCodeSessionRecord, 'bootstrapMode'>,
): boolean {
  // TODO(opencode-bootstrap): Legacy proof cleanup plan lives in
  // docs/opencode-app-managed-bootstrap-legacy-cleanup-todo.md.
  return record.bootstrapMode !== 'model_tool_checkin'
}

function resolvedOpenCodeBootstrapMode(
  record: Pick<OpenCodeSessionRecord, 'bootstrapMode'>,
): 'model_tool_checkin' | 'app_managed_context' {
  return record.bootstrapMode === 'model_tool_checkin' ? 'model_tool_checkin' : 'app_managed_context'
}

function resolvedOpenCodeBootstrapEvidenceSource(
  record: Pick<OpenCodeSessionRecord, 'bootstrapMode'>,
): 'runtime_bootstrap_checkin' | 'app_managed_bootstrap' {
  return record.bootstrapMode === 'model_tool_checkin'
    ? 'runtime_bootstrap_checkin'
    : 'app_managed_bootstrap'
}

function hasAppManagedOpenCodeBootstrapReadinessEvidence(
  record: Pick<OpenCodeSessionRecord, 'appManagedBootstrap' | 'bootstrapEvidenceSource'>,
  summary: Pick<OpenCodeSessionReconcileSummary, 'latestAssistantMessageId' | 'latestAssistantText' | 'latestAssistantPreview'>,
): boolean {
  return Boolean(
    record.appManagedBootstrap ||
    record.bootstrapEvidenceSource === 'app_managed_bootstrap' ||
    summary.latestAssistantMessageId ||
    summary.latestAssistantText ||
    summary.latestAssistantPreview
  )
}

function bridgeStateFromSummary(
  record: OpenCodeSessionRecord,
  summary: OpenCodeSessionReconcileSummary,
): 'created' | 'confirmed_alive' | 'permission_blocked' | 'failed' {
  if (summary.staleReason || summary.errorCount > 0) {
    return 'failed'
  }
  if (summary.pendingPermissionRequestIds.length > 0 || summary.durableState === 'blocked') {
    return 'permission_blocked'
  }
  if (isAppManagedOpenCodeBootstrap(record)) {
    return hasAppManagedOpenCodeBootstrapReadinessEvidence(record, summary)
      ? 'confirmed_alive'
      : 'created'
  }
  const bootstrapMcpReadiness = summarizeOpenCodeBootstrapMcpReadiness(summary)
  if (bootstrapMcpReadiness.failure) {
    return 'failed'
  }
  if (bootstrapMcpReadiness.ready) {
    return 'confirmed_alive'
  }
  return 'created'
}

function evidenceFromSummary(record: OpenCodeSessionRecord, summary: OpenCodeSessionReconcileSummary) {
  const observedAt = nowIso()
  const evidence = [
    { kind: 'member_session_recorded', observedAt },
  ]
  const permissionBlocked = summary.pendingPermissionRequestIds.length > 0 || summary.durableState === 'blocked'
  const appManagedReady = isAppManagedOpenCodeBootstrap(record) &&
    hasAppManagedOpenCodeBootstrapReadinessEvidence(record, summary)
  const bootstrapMcpReadiness = isAppManagedOpenCodeBootstrap(record)
    ? null
    : summarizeOpenCodeBootstrapMcpReadiness(summary)
  const failed = Boolean(summary.staleReason) ||
    summary.errorCount > 0 ||
    Boolean(bootstrapMcpReadiness?.failure)
  if (permissionBlocked) {
    evidence.push({ kind: 'permission_blocked', observedAt })
  }
  if (!failed && !permissionBlocked && appManagedReady) {
    if (record.appManagedBootstrap || record.bootstrapEvidenceSource === 'app_managed_bootstrap') {
      evidence.push({ kind: 'app_managed_bootstrap_context_injected', observedAt })
    }
    evidence.push({ kind: 'bootstrap_confirmed', observedAt })
    evidence.push({ kind: 'member_ready', observedAt })
  } else if (!failed && bootstrapMcpReadiness?.ready) {
    evidence.push({ kind: 'bootstrap_confirmed', observedAt })
    evidence.push({ kind: 'member_ready', observedAt })
  }
  return evidence
}

function summarizeBootstrapMcpFailure(
  record: OpenCodeSessionRecord,
  summary: OpenCodeSessionReconcileSummary,
): TeamDiagnostic | null {
  if (isAppManagedOpenCodeBootstrap(record)) {
    return null
  }
  const failure = summarizeOpenCodeBootstrapMcpFailure(summary)
  if (!failure) {
    return null
  }

  return teamDiagnostic(
    'opencode_bootstrap_mcp_failed',
    failure.message,
    'error',
  )
}

async function recreateSessionAfterBootstrapMcpFailure(params: {
  record: OpenCodeSessionRecord
  runId?: string | null
  diagnostics: TeamDiagnostic[]
}): Promise<OpenCodeSessionRecord> {
  if (isAppManagedOpenCodeBootstrap(params.record)) {
    return params.record
  }
  const bootstrapFailure = await withTimeout(
    openCodeSessionBridge.reconcileSession(params.record, { limit: 80 }),
    OPENCODE_SEND_RECONCILE_TIMEOUT_MS,
  ).then(reconciled => summarizeBootstrapMcpFailure(params.record, reconciled.summary))
    .catch(error => {
      params.diagnostics.push(
        teamDiagnostic(
          'opencode_send_bootstrap_reconcile_failed',
          error instanceof Error ? error.message : String(error),
          'warning',
        ),
      )
      return null
    })

  if (!bootstrapFailure) {
    return params.record
  }

  params.diagnostics.push(bootstrapFailure)
  await openCodeSessionStore.markStale(
    params.record.teamId,
    params.record.laneId ?? 'primary',
    params.record.memberName,
    'bootstrap_app_mcp_unavailable',
  )
  const recreated = await openCodeSessionBridge.ensureSession({
    teamId: params.record.teamId,
    laneId: params.record.laneId,
    memberName: params.record.memberName,
    selectedModel: params.record.selectedModel,
    projectPath: params.record.projectPath,
    runId: params.runId,
  })
  params.diagnostics.push(
    teamDiagnostic(
      'opencode_send_session_recreated_after_bootstrap_mcp_failure',
      'Recreated OpenCode session before message delivery because bootstrap MCP failed in the stored session.',
      'warning',
    ),
  )
  return recreated
}

function buildTeamLaunchData(params: {
  runId: string
  selectedModel: string
  members: Record<string, LaunchMemberDraft>
  expectedMemberNames?: string[]
  diagnostics: TeamDiagnostic[]
  warnings?: TeamWarning[]
  commandEvidence?: OpenCodeBridgeCommandEvidence
}) {
  const states = Object.values(params.members).map(member => member.launchState)
  const now = nowIso()
  const materializedMemberNames = new Set(Object.keys(params.members))
  const missingExpectedMemberCount = (params.expectedMemberNames ?? []).filter(
    memberName => !materializedMemberNames.has(memberName),
  ).length
  const anyFailed = states.includes('failed')
  const anyPermissionBlocked = states.includes('permission_blocked')
  const allReady =
    states.length > 0 &&
    missingExpectedMemberCount === 0 &&
    states.every(state => state === 'confirmed_alive')
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
          ...(member.bootstrapEvidenceSource
            ? { bootstrapEvidenceSource: member.bootstrapEvidenceSource }
            : {}),
          ...(member.bootstrapMode ? { bootstrapMode: member.bootstrapMode } : {}),
          ...(member.appManagedBootstrapCandidate
            ? { appManagedBootstrapCandidate: member.appManagedBootstrapCandidate }
            : {}),
          ...(member.pendingPermissionRequestIds?.length
            ? { pendingPermissionRequestIds: [...new Set(member.pendingPermissionRequestIds)] }
            : {}),
          ...(member.diagnostics.length ? { diagnostics: [...member.diagnostics] } : {}),
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

async function assertOpenCodeSelectedModelLaunchAccess(
  selectedModel: string,
  snapshot: OpenCodeProvisioningSnapshot,
): Promise<void> {
  const catalog = getOpenCodeAccessPolicyCatalog(snapshot)
  const access = evaluateOpenCodeModelAccess({
    selectedModel,
    catalog,
  })

  if (access.launchAllowed) {
    return
  }

  if (access.kind !== 'configured_authless' || !access.requiresExecutionProof) {
    throw new Error(access.reason ?? 'OpenCode selected model provider is not connected')
  }

  const executionOutcome = await openCodeExecutionProbe.probeModel({
    selectedModel,
    projectPath: snapshot.projectPath,
    disposeHostOnRelease: true,
  }).catch(error =>
    buildOpenCodeExecutionOutcome(
      selectedModel,
      'unknown',
      error instanceof Error ? error.message : String(error),
    ),
  )
  const verifiedAccess = evaluateOpenCodeModelAccess({
    selectedModel,
    catalog,
    executionOutcome,
  })
  if (verifiedAccess.launchAllowed) {
    return
  }

  throw new Error(
    verifiedAccess.reason
      ?? executionOutcome.reason
      ?? 'OpenCode selected model execution is unavailable',
  )
}

function assertOpenCodeSelectedModelReconcilable(
  selectedModel: string,
  snapshot: OpenCodeProvisioningSnapshot,
): void {
  const access = evaluateOpenCodeModelAccess({
    selectedModel,
    catalog: getOpenCodeAccessPolicyCatalog(snapshot),
  })
  if (
    access.launchAllowed
    || (access.kind === 'configured_authless' && access.requiresExecutionProof)
  ) {
    return
  }

  throw new Error(access.reason ?? 'OpenCode selected model provider is not connected')
}

function skippedAppMcpToolProof(): AppMcpToolProof {
  return {
    ok: true,
    observedTools: [],
    missingTools: [],
    diagnostics: [],
    route: null,
  }
}

async function runReadiness(envelope: BridgeEnvelope) {
  // Windows packaged bridge processes can lose stdout if they dispose the
  // just-used OpenCode host before the response is flushed. Release only the
  // short preflight lease there; cleanupHosts handles stale persistent hosts.
  const disposeReadinessHostOnRelease = process.platform !== 'win32'
  const projectPath = asString(envelope.body.projectPath) ?? envelope.cwd
  const selectedModel = asString(envelope.body.selectedModel)
  const requireSelectedModel = envelope.body.requireExecutionProbe === true || selectedModel !== null
  const shouldProbeSelectedModel = envelope.body.requireExecutionProbe === true && selectedModel !== null
  const modelSnapshot = await openCodeProvisioningProbe.probe(
    projectPath,
    {
      disposeHostOnRelease: shouldProbeSelectedModel ? true : disposeReadinessHostOnRelease,
      ensureAppMcp: !shouldProbeSelectedModel,
      bypassCache: shouldProbeSelectedModel,
    },
  )
  let snapshot = modelSnapshot
  let executionModel: string | null = null
  let executionOutcomePromise: Promise<Awaited<ReturnType<typeof openCodeExecutionProbe.probeModel>> | undefined> =
    Promise.resolve(undefined)

  if (selectedModel) {
    try {
      executionModel = resolveOpenCodeProviderScopedModel(selectedModel, snapshot)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const executionOutcome = buildOpenCodeExecutionOutcome(selectedModel, 'unavailable', reason)
      const fallbackReadiness = readinessData(
        modelSnapshot,
        selectedModel,
        executionOutcome,
        skippedAppMcpToolProof(),
        requireSelectedModel,
      )
      return {
        snapshot,
        data: {
          ...fallbackReadiness,
          state: 'model_unavailable',
          launchAllowed: false,
          missing: [reason],
          diagnostics: uniqueSortedStrings([
            ...modelSnapshot.diagnostics,
            ...executionOutcome.diagnostics,
            reason,
          ]),
        },
      }
    }
  }

  if (executionModel && envelope.body.requireExecutionProbe !== true) {
    const selectedModelAccess = evaluateOpenCodeModelAccess({
      selectedModel: executionModel,
      catalog: getOpenCodeAccessPolicyCatalog(snapshot),
    })
    if (
      !selectedModelAccess.launchAllowed &&
      (
        selectedModelAccess.kind === 'not_authenticated' ||
        selectedModelAccess.kind === 'configured_authless'
      )
    ) {
      return {
        snapshot,
        data: readinessData(
          snapshot,
          executionModel,
          undefined,
          skippedAppMcpToolProof(),
          requireSelectedModel,
        ),
      }
    }
  }

  if (envelope.body.requireExecutionProbe === true && executionModel) {
    const executionOutcome = await openCodeExecutionProbe.probeModel({
      selectedModel: executionModel,
      projectPath: modelSnapshot.projectPath,
      disposeHostOnRelease: true,
    }).catch(error =>
      buildOpenCodeExecutionOutcome(
        executionModel,
        'unknown',
        error instanceof Error ? error.message : String(error),
      ),
    )
    executionOutcomePromise = Promise.resolve(executionOutcome)
    snapshot = await openCodeProvisioningProbe.probe(projectPath, {
      disposeHostOnRelease: disposeReadinessHostOnRelease,
      ensureAppMcp: true,
      bypassCache: true,
    })
  }
  const toolProofPromise = proveAppMcpTools(snapshot)
  const [executionOutcome, toolProof] = await Promise.all([
    executionOutcomePromise,
    toolProofPromise,
  ])

  return {
    snapshot,
    data: readinessData(
      snapshot,
      executionModel ?? selectedModel,
      executionOutcome,
      toolProof,
      requireSelectedModel,
    ),
  }
}

async function runCleanupHosts(envelope: BridgeEnvelope) {
  const mode = asString(envelope.body.mode) === 'force' ? 'force' : 'stale'
  const staleAgeMs = typeof envelope.body.staleAgeMs === 'number'
    ? envelope.body.staleAgeMs
    : null
  const leaseStaleAgeMs = typeof envelope.body.leaseStaleAgeMs === 'number'
    ? envelope.body.leaseStaleAgeMs
    : null
  const preflightLeaseStaleAgeMs = typeof envelope.body.preflightLeaseStaleAgeMs === 'number'
    ? envelope.body.preflightLeaseStaleAgeMs
    : null
  const result = await openCodeHostManager.reconcilePersistentHosts({
    mode,
    reason: asString(envelope.body.reason) ?? 'manual',
    projectPath: asString(envelope.body.projectPath),
    staleAgeMs,
    leaseStaleAgeMs,
    preflightLeaseStaleAgeMs,
  })
  return {
    snapshot: null,
    data: result,
  }
}

function isAppMcpConnected(snapshot: OpenCodeProvisioningSnapshot): boolean {
  return snapshot.appMcp?.connected === true ||
    snapshot.appMcp?.status === 'present' ||
    snapshot.appMcp?.status === 'attached'
}

function assertOpenCodeLaunchRuntimeAvailable(
  snapshot: OpenCodeProvisioningSnapshot,
): void {
  if (!snapshot.detected) {
    throw new Error('OpenCode CLI not detected')
  }
  if (!snapshot.hostHealthy) {
    throw new Error(snapshot.probeError ?? 'OpenCode host is not healthy')
  }
}

async function assertOpenCodeLaunchMcpReady(
  snapshot: OpenCodeProvisioningSnapshot,
): Promise<void> {
  const toolProof = await proveAppMcpTools(snapshot)
  if (!isAppMcpConnected(snapshot) || !toolProof.ok) {
    throw new Error(
      toolProof.missingTools.length > 0
        ? `Agent Teams MCP tools are not visible in OpenCode: ${toolProof.missingTools.join(', ')}`
        : 'Agent Teams MCP tools are not visible in OpenCode',
    )
  }
}

async function cleanupFailedLaunchSession(
  record: OpenCodeSessionRecord,
): Promise<TeamDiagnostic[]> {
  const diagnostics: TeamDiagnostic[] = []
  try {
    await openCodeSessionStore.markStale(
      record.teamId,
      record.laneId,
      record.memberName,
      'launch_failed',
    )
  } catch (error) {
    diagnostics.push(teamDiagnostic(
      'opencode_launch_failed_session_mark_stale_failed',
      `${record.memberName}: ${error instanceof Error ? error.message : String(error)}`,
      'warning',
    ))
  }

  try {
    await openCodeSessionBridge.releaseSession(record)
  } catch (error) {
    diagnostics.push(teamDiagnostic(
      'opencode_launch_failed_session_release_failed',
      `${record.memberName}: ${error instanceof Error ? error.message : String(error)}`,
      'warning',
    ))
  }

  try {
    await openCodeSessionStore.delete(record.teamId, record.laneId, record.memberName)
  } catch (error) {
    diagnostics.push(teamDiagnostic(
      'opencode_launch_failed_session_delete_failed',
      `${record.memberName}: ${error instanceof Error ? error.message : String(error)}`,
      'warning',
    ))
  }
  return diagnostics
}

async function markStaleAndReleaseSession(
  record: OpenCodeSessionRecord,
  staleReason: string,
  diagnosticPrefix: string,
): Promise<TeamDiagnostic[]> {
  const diagnostics: TeamDiagnostic[] = []
  try {
    await openCodeSessionStore.markStale(
      record.teamId,
      record.laneId,
      record.memberName,
      staleReason,
    )
  } catch (error) {
    diagnostics.push(teamDiagnostic(
      `${diagnosticPrefix}_mark_stale_failed`,
      `${record.memberName}: ${error instanceof Error ? error.message : String(error)}`,
      'warning',
    ))
  }

  try {
    await openCodeSessionBridge.releaseSession(record)
  } catch (error) {
    diagnostics.push(teamDiagnostic(
      `${diagnosticPrefix}_release_failed`,
      `${record.memberName}: ${error instanceof Error ? error.message : String(error)}`,
      'warning',
    ))
  }
  return diagnostics
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
  assertUniqueOpenCodeMemberNames(membersRaw, 'opencode.launchTeam members')

  const probeStartedAt = Date.now()
  const retainedProbe = await openCodeProvisioningProbe.probeRetainingHost(
    asString(body.projectPath) ?? envelope.cwd,
  )
  const provisioningProbeMs = elapsedMs(probeStartedAt)
  try {
    return await runLaunchWithProvisioningSnapshot(envelope, retainedProbe.snapshot, {
      provisioningProbeMs,
    })
  } finally {
    await retainedProbe.release().catch(() => undefined)
  }
}

async function runLaunchWithProvisioningSnapshot(
  envelope: BridgeEnvelope,
  snapshot: OpenCodeProvisioningSnapshot,
  timings: { provisioningProbeMs?: number } = {},
) {
  const launchStartedAt = Date.now()
  const body = envelope.body
  const runId = asString(body.runId)
  const laneId = asString(body.laneId)
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  const selectedModel = asString(body.selectedModel)
  const membersRaw = Array.isArray(body.members) ? body.members : []
  if (!runId || !laneId || !teamId || !selectedModel || membersRaw.length === 0) {
    throw new Error('opencode.launchTeam requires runId, laneId, teamId/teamName, selectedModel and members')
  }
  assertUniqueOpenCodeMemberNames(membersRaw, 'opencode.launchTeam members')

  const commandEvidence = validateOpenCodeBridgeStateChangingPreconditions({
    body,
    runtime: createRuntimePreconditionSnapshot(snapshot),
  })
  assertOpenCodeLaunchRuntimeAvailable(snapshot)
  const apiSelectedModel = resolveOpenCodeProviderScopedModel(selectedModel, snapshot)
  await assertOpenCodeSelectedModelLaunchAccess(apiSelectedModel, snapshot)
  await assertOpenCodeLaunchMcpReady(snapshot)
  const members: Record<string, LaunchMemberDraft> = {}
  const diagnostics: TeamDiagnostic[] = []
  const memberTimings = new Map<string, {
    ensureSessionMs?: number
    injectionMs?: number
  }>()

  for (const item of membersRaw) {
    const member = asRecord(item)
    const name = asString(member?.name)
    if (!name) continue
    const prompt = asString(member?.prompt)
      ?? `Join OpenCode team ${teamId} as ${name}. Wait for app MCP task delivery.`
    let record: OpenCodeSessionRecord | null = null
    const memberTiming = memberTimings.get(name) ?? {}
    memberTimings.set(name, memberTiming)
    try {
      const ensureStartedAt = Date.now()
      record = await openCodeSessionBridge.ensureSession({
        teamId,
        laneId,
        memberName: name,
        selectedModel: apiSelectedModel,
        title: `${teamId} - ${name}`,
        projectPath: snapshot.projectPath,
        preparedProfile: snapshot.profile,
        runId,
        fresh: true,
      })
      memberTiming.ensureSessionMs = elapsedMs(ensureStartedAt)
      let mcpReady = await waitForLaunchSessionAppMcpReady(record)
      if (mcpReady.runtimePid && mcpReady.runtimePid > 0 && record.runtimePid !== mcpReady.runtimePid) {
        record = { ...record, runtimePid: mcpReady.runtimePid }
      }
      for (const diagnostic of mcpReady.diagnostics) {
        diagnostics.push(teamDiagnostic('opencode_launch_mcp_ready_detail', `${name}: ${diagnostic}`, 'info'))
      }
      if (mcpReady.status === 'attached') {
        diagnostics.push(teamDiagnostic(
          'opencode_launch_mcp_attached',
          `Attached Agent Teams MCP before launch bootstrap for ${name}.`,
          'info',
        ))
        // If MCP was attached after the session was created, the existing
        // OpenCode session may not see the new tools. Recreate once before
        // injecting app-managed bootstrap context to avoid a hidden bad session.
        await openCodeSessionStore.markStale(
          teamId,
          laneId,
          name,
          'app_mcp_attached_after_session_create',
        ).catch(error => {
          diagnostics.push(teamDiagnostic(
            'opencode_launch_mcp_recreate_mark_stale_failed',
            `${name}: ${error instanceof Error ? error.message : String(error)}`,
            'warning',
          ))
        })
        record = await openCodeSessionBridge.ensureSession({
          teamId,
          laneId,
          memberName: name,
          selectedModel: apiSelectedModel,
          title: `${teamId} - ${name}`,
          projectPath: snapshot.projectPath,
          preparedProfile: snapshot.profile,
          runId,
          fresh: true,
        })
        diagnostics.push(teamDiagnostic(
          'opencode_launch_session_recreated_after_mcp_attach',
          `Recreated OpenCode session for ${name} after Agent Teams MCP attach so launch bootstrap sees the newly attached tools.`,
          'info',
        ))
        mcpReady = await waitForLaunchSessionAppMcpReady(record, { attachIfMissing: false })
        if (mcpReady.runtimePid && mcpReady.runtimePid > 0 && record.runtimePid !== mcpReady.runtimePid) {
          record = { ...record, runtimePid: mcpReady.runtimePid }
        }
        for (const diagnostic of mcpReady.diagnostics) {
          diagnostics.push(teamDiagnostic('opencode_launch_mcp_ready_detail', `${name}: ${diagnostic}`, 'info'))
        }
      }
      if (!mcpReady.ok) {
        throw new Error([
          `OpenCode app MCP was not ready for ${name} before launch bootstrap`,
          `(status=${mcpReady.status}, connected=${String(mcpReady.connected)}).`,
          ...mcpReady.diagnostics,
        ].join(' '))
      }
      const contextText = buildOpenCodeAppManagedBootstrapContextText({
        teamName: teamId,
        memberName: name,
        runId,
        laneId,
        runtimeSessionId: record.opencodeSessionId,
        prompt,
      })
      const contextHash = hashText(contextText)
      const briefingHash = hashStable({
        purpose: 'opencode-app-managed-bootstrap-briefing-v1',
        teamName: teamId,
        memberName: name,
        runId,
        laneId,
        prompt,
      })
      const messageID = buildOpenCodeAppManagedBootstrapMessageID({
        teamName: teamId,
        memberName: name,
        runId,
        laneId,
        runtimeSessionId: record.opencodeSessionId,
        contextHash,
      })
      const injectionStartedAt = Date.now()
      const injected = await openCodeSessionBridge.injectAppManagedBootstrapContext(record, {
        messageID,
        text: contextText,
        agent: OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT,
        contextHash,
        briefingHash,
      })
      memberTiming.injectionMs = elapsedMs(injectionStartedAt)
      const candidateAt = nowIso()
      const appManagedBootstrap = {
        schemaVersion: 1 as const,
        messageID: injected.messageID,
        contextHash: injected.contextHash,
        briefingHash: injected.briefingHash,
        injectionVerifiedAt: injected.injectionVerifiedAt,
        model: apiSelectedModel,
        agent: OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT,
      }
      record = {
        ...record,
        bootstrapMode: 'app_managed_context',
        bootstrapEvidenceSource: 'app_managed_bootstrap',
        appManagedBootstrap,
        updatedAt: candidateAt,
      }
      await openCodeSessionStore.upsert(record)
      const candidate: OpenCodeAppManagedBootstrapCandidate = {
        schemaVersion: 1,
        source: 'app_managed_bootstrap',
        teamName: teamId,
        memberName: name,
        runId,
        laneId,
        runtimeSessionId: injected.runtimeSessionId,
        messageID: injected.messageID,
        contextHash: injected.contextHash,
        briefingHash: injected.briefingHash,
        injectionVerifiedAt: injected.injectionVerifiedAt,
        candidateAt,
        model: apiSelectedModel,
        agent: OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT,
      }
      const memberDiagnostics = [
        injected.alreadyPresent
          ? 'OpenCode app-managed bootstrap context was already present and verified.'
          : 'OpenCode app-managed bootstrap context was injected and verified.',
      ]
      members[name] = {
        sessionId: record.opencodeSessionId,
        launchState: 'created',
        bootstrapEvidenceSource: 'app_managed_bootstrap',
        bootstrapMode: 'app_managed_context',
        appManagedBootstrapCandidate: candidate,
        ...(typeof record.runtimePid === 'number' && record.runtimePid > 0
          ? { runtimePid: record.runtimePid }
          : typeof snapshot.host?.pid === 'number' && snapshot.host.pid > 0
            ? { runtimePid: snapshot.host.pid }
            : {}),
        evidence: [{ kind: 'app_managed_bootstrap_context_injected', observedAt: candidateAt }],
        diagnostics: memberDiagnostics,
      }
      diagnostics.push(teamDiagnostic(
        'opencode_app_managed_bootstrap_context_verified',
        `${name}: ${memberDiagnostics[0]}`,
        'info',
      ))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const cleanupDiagnostics = record
        ? await cleanupFailedLaunchSession(record)
        : []
      members[name] = {
        sessionId: record?.opencodeSessionId ?? `failed:${teamId}:${laneId}:${name}`,
        launchState: 'failed',
        ...(typeof record?.runtimePid === 'number' && record.runtimePid > 0
          ? { runtimePid: record.runtimePid }
          : typeof snapshot.host?.pid === 'number' && snapshot.host.pid > 0
            ? { runtimePid: snapshot.host.pid }
            : {}),
        evidence: [{ kind: 'member_launch_failed', observedAt: nowIso() }],
        diagnostics: [reason],
      }
      diagnostics.push(teamDiagnostic('member_launch_failed', `${name}: ${reason}`, 'error'))
      diagnostics.push(...cleanupDiagnostics)
    }
  }

  for (const [name, memberTiming] of memberTimings) {
    diagnostics.push(teamDiagnostic(
      'opencode_launch_member_timing',
      `member=${name} ensureSession=${formatMs(memberTiming.ensureSessionMs)} injection=${formatMs(memberTiming.injectionMs)}`,
      'info',
    ))
  }
  diagnostics.push(teamDiagnostic(
    'opencode_launch_total_timing',
    `total=${formatMs(elapsedMs(launchStartedAt))} provisioningProbe=${formatMs(timings.provisioningProbeMs)} members=${memberTimings.size}`,
    'info',
  ))

  return {
    snapshot,
    data: buildTeamLaunchData({
      runId,
      selectedModel,
      members,
      diagnostics,
      commandEvidence,
      warnings: [],
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
  assertUniqueOpenCodeMemberNames(expectedMembers, 'opencode.reconcileTeam expectedMembers')
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
    const expectedModel = asString(member?.model)
    if (expectedModel) {
      let expectedSelectedModel: string
      try {
        expectedSelectedModel = resolveOpenCodeProviderScopedModel(expectedModel, snapshot)
        assertOpenCodeSelectedModelReconcilable(expectedSelectedModel, snapshot)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        members[name] = {
          sessionId: record.opencodeSessionId,
          launchState: 'failed',
          ...(typeof record.runtimePid === 'number' && record.runtimePid > 0
            ? { runtimePid: record.runtimePid }
            : typeof snapshot.host?.pid === 'number' && snapshot.host.pid > 0
              ? { runtimePid: snapshot.host.pid }
              : {}),
          evidence: [{ kind: 'member_reconcile_failed', observedAt: nowIso() }],
          diagnostics: [reason],
        }
        diagnostics.push(teamDiagnostic('member_model_unavailable', `${name}: ${reason}`, 'error'))
        continue
      }
      if (expectedSelectedModel !== record.selectedModel) {
        const reason = `Stored OpenCode session model "${record.selectedModel}" does not match expected model "${expectedSelectedModel}".`
        members[name] = {
          sessionId: record.opencodeSessionId,
          launchState: 'failed',
          ...(typeof record.runtimePid === 'number' && record.runtimePid > 0
            ? { runtimePid: record.runtimePid }
            : typeof snapshot.host?.pid === 'number' && snapshot.host.pid > 0
              ? { runtimePid: snapshot.host.pid }
              : {}),
          evidence: [{ kind: 'member_reconcile_failed', observedAt: nowIso() }],
          diagnostics: [reason],
        }
        diagnostics.push(teamDiagnostic('member_model_mismatch', `${name}: ${reason}`, 'error'))
        continue
      }
    }
    try {
      const reconciled = await openCodeSessionBridge.reconcileSession(record, { limit: 50 })
      const bootstrapFailure = summarizeBootstrapMcpFailure(record, reconciled.summary)
      const memberDiagnostics = [
        ...reconciled.summary.diagnostics,
        ...(bootstrapFailure ? [bootstrapFailure.message] : []),
      ]
      members[name] = {
        sessionId: record.opencodeSessionId,
        launchState: bridgeStateFromSummary(record, reconciled.summary),
        bootstrapEvidenceSource: resolvedOpenCodeBootstrapEvidenceSource(record),
        bootstrapMode: resolvedOpenCodeBootstrapMode(record),
        ...(reconciled.summary.pendingPermissionRequestIds.length > 0
          ? { pendingPermissionRequestIds: [...new Set(reconciled.summary.pendingPermissionRequestIds)] }
          : {}),
        ...(typeof reconciled.record?.runtimePid === 'number' && reconciled.record.runtimePid > 0
          ? { runtimePid: reconciled.record.runtimePid }
          : typeof record.runtimePid === 'number' && record.runtimePid > 0
            ? { runtimePid: record.runtimePid }
            : typeof snapshot.host?.pid === 'number' && snapshot.host.pid > 0
              ? { runtimePid: snapshot.host.pid }
              : {}),
        evidence: evidenceFromSummary(record, reconciled.summary),
        diagnostics: memberDiagnostics,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      members[name] = {
        sessionId: record.opencodeSessionId,
        launchState: 'failed',
        ...(typeof record.runtimePid === 'number' && record.runtimePid > 0
          ? { runtimePid: record.runtimePid }
          : typeof snapshot.host?.pid === 'number' && snapshot.host.pid > 0
            ? { runtimePid: snapshot.host.pid }
            : {}),
        evidence: [{ kind: 'member_reconcile_failed', observedAt: nowIso() }],
        diagnostics: [reason],
      }
      diagnostics.push(teamDiagnostic('member_reconcile_failed', `${name}: ${reason}`, 'error'))
    }
  }

  return {
    snapshot,
    data: buildTeamLaunchData({
      runId,
      selectedModel,
      members,
      expectedMemberNames: expectedMembers
        .map(item => asString(asRecord(item)?.name))
        .filter((name): name is string => name !== null),
      diagnostics,
      commandEvidence,
    }),
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
  const diagnostics: TeamDiagnostic[] = []
  for (const record of records) {
    let stopped = false
    const memberDiagnostics: string[] = []
    try {
      stopped = await openCodeSessionBridge.abort(record)
      await openCodeSessionBridge.releaseSession(record)
    } catch (error) {
      memberDiagnostics.push(error instanceof Error ? error.message : String(error))
    }
    members[record.memberName] = {
      sessionId: record.opencodeSessionId,
      stopped,
      diagnostics: memberDiagnostics,
    }
  }

  const cleanupProjectPaths = new Set(
    records
      .map(record => record.projectPath.trim())
      .filter(projectPath => projectPath.length > 0),
  )
  for (const projectPath of cleanupProjectPaths) {
    try {
      const cleanup = await openCodeHostManager.reconcilePersistentHosts({
        mode: 'stale',
        reason: 'stopTeam',
        projectPath,
        staleAgeMs: 0,
        leaseStaleAgeMs: null,
        preflightLeaseStaleAgeMs: null,
      })
      if (cleanup.cleaned > 0) {
        diagnostics.push({
          code: 'opencode_host_cleanup',
          severity: 'info',
          message: `Disposed ${cleanup.cleaned} OpenCode host${cleanup.cleaned === 1 ? '' : 's'} without active leases for ${projectPath}`,
        })
      }
      for (const message of cleanup.diagnostics) {
        diagnostics.push({
          code: 'opencode_host_cleanup_warning',
          severity: 'warning',
          message,
        })
      }
    } catch (error) {
      diagnostics.push({
        code: 'opencode_host_cleanup_failed',
        severity: 'warning',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    snapshot,
    data: {
      runId,
      stopped: Object.values(members).every(member => member.stopped),
      members,
      warnings: [],
      diagnostics,
      ...(commandEvidence.idempotencyKey ? { idempotencyKey: commandEvidence.idempotencyKey } : {}),
      manifestHighWatermark: commandEvidence.manifestHighWatermark,
      runtimeStoreManifestHighWatermark: commandEvidence.runtimeStoreManifestHighWatermark,
    },
  }
}

async function runSendMessage(envelope: BridgeEnvelope): Promise<{
  snapshot: OpenCodeProvisioningSnapshot
  data: SendMessageCommandData
}> {
  const body = envelope.body
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  const laneId = asString(body.laneId)
  const memberName = asString(body.memberName)
  const text = asString(body.text)
  const fileParts = parseOpenCodePromptFileParts(body.fileParts ?? body.parts)
  if (!teamId || !laneId || !memberName || !text) {
    throw new Error('opencode.sendMessage requires teamId/teamName, laneId, memberName and text')
  }
  const projectPath = asString(body.projectPath) ?? envelope.cwd
  const runId = asString(body.runId)
  const forceSessionRefreshReason = asString(body.forceSessionRefreshReason)?.trim()
  const outcomeBase: SendMessageOutcomeBase = {
    requestId: envelope.requestId,
    body,
    teamId,
    teamName: asString(body.teamName) ?? teamId,
    laneId,
    memberName,
    projectPath,
    runId,
  }
  await markSendMessageOutcome(outcomeBase, {
    status: 'received',
  })

  const snapshot = await openCodeProvisioningProbe.probe(projectPath)
  const commandEvidence = validateOpenCodeBridgeStateChangingPreconditions({
    body,
    runtime: createRuntimePreconditionSnapshot(snapshot),
  })
  await markSendMessageOutcome(outcomeBase, {
    status: 'preconditions_checked',
  })
  const record = await openCodeSessionStore.get(teamId, laneId, memberName)
  if (!record) {
    await markSendMessageOutcome(outcomeBase, {
      status: 'failed_before_accept',
      completedAt: nowIso(),
      error: `No stored OpenCode session record for ${teamId}/${laneId}/${memberName}`,
    })
    throw new Error(`No stored OpenCode session record for ${teamId}/${laneId}/${memberName}`)
  }
  let deliveryRecord = record
  let mcpRuntimePid: number | undefined
  const mcpDiagnostics: TeamDiagnostic[] = []
  const compatibilityStaleReason = getOpenCodeSessionCompatibilityStaleReason(record)
  const staleReason = record.staleReason ?? compatibilityStaleReason
  if (staleReason) {
    if (!record.staleReason) {
      await openCodeSessionStore.markStale(teamId, laneId, memberName, staleReason).catch(error => {
        mcpDiagnostics.push(
          teamDiagnostic(
            'opencode_send_session_compatibility_mark_stale_failed',
            error instanceof Error ? error.message : String(error),
            'warning',
          ),
        )
      })
    }
    deliveryRecord = await openCodeSessionBridge.ensureSession({
      teamId,
      laneId,
      memberName,
      selectedModel: record.selectedModel,
      projectPath: record.projectPath,
      runId,
    })
    mcpDiagnostics.push(
      teamDiagnostic(
        'opencode_send_session_recreated_after_stale_record',
        `Recreated OpenCode session before message delivery because the stored session was stale (${staleReason}).`,
        'warning',
      ),
    )
  } else if (forceSessionRefreshReason) {
    await openCodeSessionStore.markStale(teamId, laneId, memberName, forceSessionRefreshReason)
    deliveryRecord = await openCodeSessionBridge.ensureSession({
      teamId,
      laneId,
      memberName,
      selectedModel: record.selectedModel,
      projectPath: record.projectPath,
      runId,
    })
    mcpDiagnostics.push(
      teamDiagnostic(
        'opencode_send_session_recreated_after_forced_refresh',
        `Recreated OpenCode session before message delivery because the app requested a session refresh (${forceSessionRefreshReason}).`,
        'info',
      ),
    )
  }
  deliveryRecord = await recreateSessionAfterBootstrapMcpFailure({
    record: deliveryRecord,
    runId,
    diagnostics: mcpDiagnostics,
  })
  await markSendMessageOutcome(outcomeBase, {
    status: 'session_resolved',
    sessionId: deliveryRecord.opencodeSessionId,
    runtimePid: deliveryRecord.runtimePid ?? null,
    prePromptCursor: deliveryRecord.lastCanonicalCursor ?? null,
    diagnostics: mcpDiagnostics.map(teamDiagnosticToOutcomeString),
  })
  const initialMcpReady = await openCodeSessionBridge.ensureSessionAppMcpReady(deliveryRecord, {
    attachIfMissing: true,
  })
  if (initialMcpReady.ok) {
    mcpRuntimePid = initialMcpReady.runtimePid
    mcpDiagnostics.push(
      teamDiagnostic(
        initialMcpReady.status === 'attached'
          ? 'opencode_send_mcp_reattached'
          : 'opencode_send_mcp_ready',
        initialMcpReady.status === 'attached'
          ? 'OpenCode app MCP was reattached before message delivery.'
          : 'OpenCode app MCP is connected for message delivery.',
        'info',
      ),
    )
    mcpDiagnostics.push(
      ...initialMcpReady.diagnostics.map(message =>
        teamDiagnostic('opencode_send_mcp_ready_detail', message, 'info'),
      ),
    )
    await markSendMessageOutcome(outcomeBase, {
      status: 'mcp_ready',
      sessionId: deliveryRecord.opencodeSessionId,
      runtimePid: mcpRuntimePid ?? deliveryRecord.runtimePid ?? null,
      prePromptCursor: deliveryRecord.lastCanonicalCursor ?? null,
      diagnostics: mcpDiagnostics.map(teamDiagnosticToOutcomeString),
    })
  } else {
    mcpDiagnostics.push(
      teamDiagnostic(
        'opencode_send_mcp_unavailable',
        [
          `OpenCode app MCP was not connected before message delivery (status=${initialMcpReady.status}, connected=${String(initialMcpReady.connected)}).`,
          ...initialMcpReady.diagnostics,
        ].join(' '),
        'warning',
      ),
    )
    await openCodeSessionStore.markStale(teamId, laneId, memberName, 'app_mcp_unavailable')
    deliveryRecord = await openCodeSessionBridge.ensureSession({
      teamId,
      laneId,
      memberName,
      selectedModel: record.selectedModel,
      projectPath: record.projectPath,
      runId: asString(body.runId),
    })
    mcpDiagnostics.push(
      teamDiagnostic(
        'opencode_send_session_recreated_after_mcp_failure',
        'Recreated OpenCode session after app MCP was unavailable on the stored session.',
        'warning',
      ),
    )
    const recreatedMcpReady = await openCodeSessionBridge.ensureSessionAppMcpReady(deliveryRecord, {
      attachIfMissing: true,
    })
    if (!recreatedMcpReady.ok) {
      const mcpUnavailableDiagnostic = teamDiagnostic(
        'opencode_send_mcp_unavailable',
        [
          `OpenCode app MCP unavailable for ${teamId}/${laneId}/${memberName} after session recreate`,
          `(status=${recreatedMcpReady.status}, connected=${String(recreatedMcpReady.connected)}).`,
          ...recreatedMcpReady.diagnostics,
        ].join(' '),
        'error',
      )
      const cleanupDiagnostics = await markStaleAndReleaseSession(
        deliveryRecord,
        'app_mcp_unavailable_after_recreate',
        'opencode_send_unavailable_session_cleanup',
      )
      const diagnostics = [
        ...mcpDiagnostics,
        mcpUnavailableDiagnostic,
        ...cleanupDiagnostics,
      ]
      const responseObservation = reconcileFailedObservation(mcpUnavailableDiagnostic.message)
      await markSendMessageOutcome(outcomeBase, {
        status: 'failed_before_accept',
        sessionId: deliveryRecord.opencodeSessionId,
        runtimePid: deliveryRecord.runtimePid ?? null,
        prePromptCursor: deliveryRecord.lastCanonicalCursor ?? null,
        completedAt: nowIso(),
        error: responseObservation.reason ?? 'OpenCode app MCP unavailable',
        diagnostics: diagnostics.map(teamDiagnosticToOutcomeString),
      })
      return {
        snapshot,
        data: {
          accepted: false,
          sessionId: deliveryRecord.opencodeSessionId,
          memberName,
          ...(typeof deliveryRecord.runtimePid === 'number' && deliveryRecord.runtimePid > 0
            ? { runtimePid: deliveryRecord.runtimePid }
            : {}),
          prePromptCursor: deliveryRecord.lastCanonicalCursor ?? null,
          snapshotBoundary: buildSnapshotBoundaryStatus({ snapshot, responseObservation }),
          responseObservation,
          diagnostics,
        },
      }
    }
    mcpRuntimePid = recreatedMcpReady.runtimePid
    mcpDiagnostics.push(
      teamDiagnostic(
        recreatedMcpReady.status === 'attached'
          ? 'opencode_send_mcp_reattached'
          : 'opencode_send_mcp_ready',
        recreatedMcpReady.status === 'attached'
          ? 'OpenCode app MCP was reattached on the recreated session before message delivery.'
          : 'OpenCode app MCP is connected on the recreated session for message delivery.',
        'info',
      ),
    )
    mcpDiagnostics.push(
      ...recreatedMcpReady.diagnostics.map(message =>
        teamDiagnostic('opencode_send_mcp_ready_detail', message, 'info'),
      ),
    )
    await markSendMessageOutcome(outcomeBase, {
      status: 'mcp_ready',
      sessionId: deliveryRecord.opencodeSessionId,
      runtimePid: mcpRuntimePid ?? deliveryRecord.runtimePid ?? null,
      prePromptCursor: deliveryRecord.lastCanonicalCursor ?? null,
      diagnostics: mcpDiagnostics.map(teamDiagnosticToOutcomeString),
    })
  }
  const prePromptCursor = deliveryRecord.lastCanonicalCursor ?? null

  const identityReminder = runId
    ? buildOpenCodeRuntimeIdentityBlock({
      teamName: teamId,
      memberName,
      runId,
      runtimeSessionId: deliveryRecord.opencodeSessionId,
      purpose: 'reminder',
    })
    : null

  const deliveryText = identityReminder ? `${identityReminder}\n\n${text}` : text
  const deliveryAgent = asString(body.agent) ?? OPEN_CODE_TEAMMATE_AGENT
  const noReply = body.noReply === true
  const settlementMode = body.settlementMode === 'acceptance' ? 'acceptance' : 'observed'
  let runtimePromptMessageId: string | null = null
  let turnSettled: OpenCodeTurnSettledSummary | null = null
  let promptEndpointAccepted = false
  try {
    if (noReply) {
      await openCodeSessionBridge.promptAsync(deliveryRecord, {
        text: deliveryText,
        parts: fileParts,
        agent: deliveryAgent,
        noReply: true,
      })
      promptEndpointAccepted = true
    } else if (settlementMode === 'acceptance') {
      const prompted = await openCodeSessionBridge.promptAsyncUntilAccepted(deliveryRecord, {
        text: deliveryText,
        parts: fileParts,
        agent: deliveryAgent,
        noReply: false,
        onPromptSubmitting: async ({ sessionId, runtimePromptMessageId }) => {
          await markSendMessageOutcome(outcomeBase, {
            status: 'prompt_submitting',
            sessionId,
            runtimePid: mcpRuntimePid ?? deliveryRecord.runtimePid ?? null,
            prePromptCursor,
            runtimePromptMessageId,
            diagnostics: mcpDiagnostics.map(teamDiagnosticToOutcomeString),
          })
        },
        onPromptAccepted: async ({ sessionId, runtimePromptMessageId }) => {
          promptEndpointAccepted = true
          await markSendMessageOutcome(outcomeBase, {
            status: 'prompt_accepted',
            sessionId,
            runtimePid: mcpRuntimePid ?? deliveryRecord.runtimePid ?? null,
            prePromptCursor,
            runtimePromptMessageId,
            acceptedAt: nowIso(),
            diagnostics: [
              ...mcpDiagnostics.map(teamDiagnosticToOutcomeString),
              'opencode_send_settlement_acceptance',
            ],
          })
        },
      })
      runtimePromptMessageId = prompted.runtimePromptMessageId
      if (prompted.hookDiagnostics.length > 0) {
        mcpDiagnostics.push(
          ...prompted.hookDiagnostics.map(message =>
            teamDiagnostic('opencode_send_outcome_hook_failed', message, 'warning'),
          ),
        )
      }
    } else {
      const prompted = await openCodeSessionBridge.promptAsyncWithTurnSettled(deliveryRecord, {
        text: deliveryText,
        parts: fileParts,
        agent: deliveryAgent,
        noReply: false,
        timeoutMs: OPENCODE_SEND_TURN_SETTLED_TIMEOUT_MS,
        idleTimeoutMs: OPENCODE_SEND_TURN_SETTLED_IDLE_TIMEOUT_MS,
        onPromptSubmitting: async ({ sessionId, runtimePromptMessageId }) => {
          await markSendMessageOutcome(outcomeBase, {
            status: 'prompt_submitting',
            sessionId,
            runtimePid: mcpRuntimePid ?? deliveryRecord.runtimePid ?? null,
            prePromptCursor,
            runtimePromptMessageId,
            diagnostics: mcpDiagnostics.map(teamDiagnosticToOutcomeString),
          })
        },
        onPromptAccepted: async ({ sessionId, runtimePromptMessageId }) => {
          promptEndpointAccepted = true
          await markSendMessageOutcome(outcomeBase, {
            status: 'prompt_accepted',
            sessionId,
            runtimePid: mcpRuntimePid ?? deliveryRecord.runtimePid ?? null,
            prePromptCursor,
            runtimePromptMessageId,
            acceptedAt: nowIso(),
          })
        },
        onTurnObserved: async ({ sessionId, runtimePromptMessageId }) => {
          await markSendMessageOutcome(outcomeBase, {
            status: 'turn_observed',
            sessionId,
            runtimePid: mcpRuntimePid ?? deliveryRecord.runtimePid ?? null,
            prePromptCursor,
            runtimePromptMessageId,
            turnObservedAt: nowIso(),
          })
        },
      })
      runtimePromptMessageId = prompted.runtimePromptMessageId
      turnSettled = prompted.turnSettled
      if (prompted.hookDiagnostics.length > 0) {
        mcpDiagnostics.push(
          ...prompted.hookDiagnostics.map(message =>
            teamDiagnostic('opencode_send_outcome_hook_failed', message, 'warning'),
          ),
        )
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markSendMessageOutcome(outcomeBase, {
      status: promptEndpointAccepted ? 'failed_after_accept' : 'failed_before_accept',
      sessionId: deliveryRecord.opencodeSessionId,
      runtimePid: mcpRuntimePid ?? deliveryRecord.runtimePid ?? null,
      prePromptCursor,
      runtimePromptMessageId,
      completedAt: nowIso(),
      error: message,
      diagnostics: [...mcpDiagnostics.map(teamDiagnosticToOutcomeString), message],
    }).catch(() => undefined)
    throw error
  }

  if (!noReply && settlementMode === 'acceptance') {
    const acceptedRuntimePid = mcpRuntimePid ?? deliveryRecord.runtimePid ?? undefined
    const finalData: SendMessageCommandData = {
      accepted: true,
      ...(runId ? { runId } : {}),
      sessionId: deliveryRecord.opencodeSessionId,
      memberName,
      ...(acceptedRuntimePid ? { runtimePid: acceptedRuntimePid } : {}),
      prePromptCursor,
      ...(runtimePromptMessageId ? { runtimePromptMessageId } : {}),
      diagnostics: [
        ...mcpDiagnostics,
        teamDiagnostic(
          'opencode_send_settlement_acceptance',
          'OpenCode prompt_async accepted; response observation will continue through durable app-side ledger reconciliation.',
          'info',
        ),
      ],
      ...(commandEvidence.idempotencyKey ? { idempotencyKey: commandEvidence.idempotencyKey } : {}),
      manifestHighWatermark: commandEvidence.manifestHighWatermark,
      runtimeStoreManifestHighWatermark: commandEvidence.runtimeStoreManifestHighWatermark,
    }
    await markSendMessageOutcome(outcomeBase, {
      status: 'prompt_accepted',
      sessionId: deliveryRecord.opencodeSessionId,
      runtimePid: mcpRuntimePid ?? deliveryRecord.runtimePid ?? null,
      prePromptCursor,
      runtimePromptMessageId,
      acceptedAt: nowIso(),
      sendMessageData: finalData,
      diagnostics: finalData.diagnostics.map(teamDiagnosticToOutcomeString),
    }).catch(() => undefined)
    return {
      snapshot,
      data: finalData,
    }
  }

  let runtimePid =
    typeof deliveryRecord.runtimePid === 'number' && deliveryRecord.runtimePid > 0
      ? deliveryRecord.runtimePid
      : mcpRuntimePid
  let reconcileDiagnostics: TeamDiagnostic[] = mcpDiagnostics
  let responseObservation: OpenCodeDeliveryResponseObservation | undefined
  let reconcileSummary: OpenCodeSessionReconcileSummary | null = null
  let emitRecord = deliveryRecord
  try {
    const reconciled = await withTimeout(
      openCodeSessionBridge.reconcileSession(deliveryRecord, { limit: 50 }),
      OPENCODE_SEND_RECONCILE_TIMEOUT_MS,
    )
    emitRecord = reconciled.record
    reconcileSummary = reconciled.summary
    runtimePid =
      typeof reconciled.record.runtimePid === 'number' && reconciled.record.runtimePid > 0
        ? reconciled.record.runtimePid
        : runtimePid
    reconcileDiagnostics = [
      ...mcpDiagnostics,
      ...reconciled.summary.diagnostics.map(message =>
        teamDiagnostic('opencode_send_reconcile', message, 'info'),
      ),
    ]
    responseObservation = observeOpenCodeDeliveryResponse({
      inboundMessageId: asString(body.messageId),
      prePromptCursor,
      runtimePromptMessageId,
      summary: reconciled.summary,
    })
    if (isMessageSendToolErrorObservation(responseObservation)) {
      try {
        const reobserved = await reobserveAfterMessageSendToolErrorFallbackGrace({
          record: reconciled.record,
          inboundMessageId: asString(body.messageId),
          prePromptCursor,
          runtimePromptMessageId,
          timeoutMs: OPENCODE_SEND_RECONCILE_TIMEOUT_MS,
          limit: 50,
          diagnosticCode: 'opencode_send_reconcile',
        })
        emitRecord = reobserved.record
        reconcileSummary = reobserved.summary
        responseObservation = reobserved.responseObservation
        runtimePid =
          typeof reobserved.record.runtimePid === 'number' && reobserved.record.runtimePid > 0
            ? reobserved.record.runtimePid
            : runtimePid
        reconcileDiagnostics = [
          ...reconcileDiagnostics,
          ...reobserved.diagnostics,
        ]
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError)
        reconcileDiagnostics = [
          ...reconcileDiagnostics,
          teamDiagnostic(
            'opencode_send_reconcile_message_send_tool_error_fallback_failed',
            fallbackMessage,
            'warning',
          ),
        ]
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    reconcileDiagnostics = [
      ...mcpDiagnostics,
      teamDiagnostic(
        'opencode_send_reconcile_failed_after_prompt_accept',
        message,
        'warning',
      ),
    ]
    responseObservation = reconcileFailedObservation(message)
  }
  if (!noReply) {
    await openCodeTurnSettledEmissionCoordinator.emitDelivery({
      record: emitRecord,
      runtimePromptMessageId,
      turnSettled,
      reconcileSummary,
      responseObservation,
    })
  }

  const finalData: SendMessageCommandData = {
    accepted: true,
    ...(runId ? { runId } : {}),
    sessionId: deliveryRecord.opencodeSessionId,
    memberName,
    ...(runtimePid ? { runtimePid } : {}),
    prePromptCursor,
    ...(runtimePromptMessageId ? { runtimePromptMessageId } : {}),
    ...(responseObservation
      ? {
          snapshotBoundary: buildSnapshotBoundaryStatus({ snapshot, responseObservation }),
          responseObservation,
        }
        : {}),
    diagnostics: reconcileDiagnostics,
    ...(commandEvidence.idempotencyKey ? { idempotencyKey: commandEvidence.idempotencyKey } : {}),
    manifestHighWatermark: commandEvidence.manifestHighWatermark,
    runtimeStoreManifestHighWatermark: commandEvidence.runtimeStoreManifestHighWatermark,
  }
  try {
    await markSendMessageOutcome(outcomeBase, {
      status: 'reconciled',
      sessionId: deliveryRecord.opencodeSessionId,
      runtimePid: runtimePid ?? null,
      prePromptCursor,
      runtimePromptMessageId,
      completedAt: nowIso(),
      sendMessageData: finalData,
      diagnostics: reconcileDiagnostics.map(teamDiagnosticToOutcomeString),
    })
  } catch (error) {
    finalData.diagnostics.push(
      teamDiagnostic(
        'opencode_send_outcome_reconciled_store_failed',
        error instanceof Error ? error.message : String(error),
        'warning',
      ),
    )
  }

  return {
    snapshot,
    data: finalData,
  }
}

async function runObserveMessageDelivery(envelope: BridgeEnvelope): Promise<{
  snapshot: OpenCodeProvisioningSnapshot
  data: ObserveMessageDeliveryCommandData
}> {
  const body = envelope.body
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  const laneId = asString(body.laneId)
  const memberName = asString(body.memberName)
  const messageId = asString(body.messageId)
  const requestedSessionId = asString(body.sessionId)
  const runtimePromptMessageId = asString(body.runtimePromptMessageId)
  if (!teamId || !laneId || !memberName || !messageId) {
    throw new Error(
      'opencode.observeMessageDelivery requires teamId/teamName, laneId, memberName and messageId',
    )
  }

  const snapshot = await openCodeProvisioningProbe.probe(
    asString(body.projectPath) ?? envelope.cwd,
  )
  validateOpenCodeBridgeStateChangingPreconditions({
    body,
    runtime: createRuntimePreconditionSnapshot(snapshot),
  })
  const record = await openCodeSessionStore.get(teamId, laneId, memberName)
  if (!record) {
    throw new Error(`No stored OpenCode session record for ${teamId}/${laneId}/${memberName}`)
  }

  let runtimePid =
    typeof record.runtimePid === 'number' && record.runtimePid > 0 ? record.runtimePid : undefined
  const diagnostics: TeamDiagnostic[] = []
  let responseObservation: OpenCodeDeliveryResponseObservation
  try {
    const limited = await withTimeout(
      openCodeSessionBridge.reconcileSession(record, {
        limit: 80,
        sessionId: requestedSessionId,
      }),
      OPENCODE_OBSERVE_MESSAGE_TIMEOUT_MS,
    )
    let observeRecord = limited.record
    runtimePid =
      typeof limited.record.runtimePid === 'number' && limited.record.runtimePid > 0
        ? limited.record.runtimePid
        : runtimePid
    diagnostics.push(
      ...limited.summary.diagnostics.map(message =>
        teamDiagnostic('opencode_observe_reconcile', message, 'info'),
      ),
    )
    responseObservation = observeOpenCodeDeliveryResponse({
      inboundMessageId: messageId,
      prePromptCursor: asString(body.prePromptCursor),
      runtimePromptMessageId,
      summary: limited.summary,
    })

    if (responseObservation.needsFullHistory === true) {
      const full = await withTimeout(
        openCodeSessionBridge.reconcileSession(limited.record, {
          sessionId: requestedSessionId,
        }),
        OPENCODE_OBSERVE_MESSAGE_TIMEOUT_MS,
      )
      observeRecord = full.record
      runtimePid =
        typeof full.record.runtimePid === 'number' && full.record.runtimePid > 0
          ? full.record.runtimePid
          : runtimePid
      diagnostics.push(
        ...full.summary.diagnostics.map(message =>
          teamDiagnostic('opencode_observe_full_reconcile', message, 'info'),
        ),
      )
      responseObservation = observeOpenCodeDeliveryResponse({
        inboundMessageId: messageId,
        prePromptCursor: asString(body.prePromptCursor),
        runtimePromptMessageId,
        summary: full.summary,
      })
    }
    if (isMessageSendToolErrorObservation(responseObservation)) {
      try {
        const reobserved = await reobserveAfterMessageSendToolErrorFallbackGrace({
          record: observeRecord,
          inboundMessageId: messageId,
          prePromptCursor: asString(body.prePromptCursor),
          runtimePromptMessageId,
          sessionId: requestedSessionId,
          timeoutMs: OPENCODE_OBSERVE_MESSAGE_TIMEOUT_MS,
          limit: 80,
          diagnosticCode: 'opencode_observe_reconcile',
        })
        runtimePid =
          typeof reobserved.record.runtimePid === 'number' && reobserved.record.runtimePid > 0
            ? reobserved.record.runtimePid
            : runtimePid
        responseObservation = reobserved.responseObservation
        diagnostics.push(...reobserved.diagnostics)
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError)
        diagnostics.push(
          teamDiagnostic(
            'opencode_observe_reconcile_message_send_tool_error_fallback_failed',
            fallbackMessage,
            'warning',
          ),
        )
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    diagnostics.push(teamDiagnostic('opencode_observe_reconcile_failed', message, 'warning'))
    responseObservation = reconcileFailedObservation(message)
  }

  return {
    snapshot,
    data: {
      observed: true,
      sessionId: requestedSessionId ?? record.opencodeSessionId,
      memberName,
      ...(runtimePid ? { runtimePid } : {}),
      ...(runtimePromptMessageId ? { runtimePromptMessageId } : {}),
      snapshotBoundary: buildSnapshotBoundaryStatus({ snapshot, responseObservation }),
      responseObservation,
      diagnostics,
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
  const snapshot = await openCodeProvisioningProbe.probe(
    asString(body.projectPath) ?? envelope.cwd,
  )
  const commandEvidence = validateOpenCodeBridgeStateChangingPreconditions({
    body,
    runtime: createRuntimePreconditionSnapshot(snapshot),
  })
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
  await openCodeSessionBridge.answerPermission(record, { requestId, decision })
  const laneRecords = (await openCodeSessionStore.list()).filter(
    candidate => candidate.teamId === record.teamId && candidate.laneId === record.laneId,
  )
  const selectedModel = record.selectedModel
  const members: Record<string, LaunchMemberDraft> = {}
  const diagnostics: TeamDiagnostic[] = []
  for (const laneRecord of laneRecords) {
    try {
      const reconciled = await openCodeSessionBridge.reconcileSession(laneRecord, { limit: 50 })
      members[laneRecord.memberName] = {
        sessionId: laneRecord.opencodeSessionId,
        launchState: bridgeStateFromSummary(laneRecord, reconciled.summary),
        bootstrapEvidenceSource: resolvedOpenCodeBootstrapEvidenceSource(laneRecord),
        bootstrapMode: resolvedOpenCodeBootstrapMode(laneRecord),
        ...(reconciled.summary.pendingPermissionRequestIds.length > 0
          ? { pendingPermissionRequestIds: [...new Set(reconciled.summary.pendingPermissionRequestIds)] }
          : {}),
        ...(typeof reconciled.record?.runtimePid === 'number' && reconciled.record.runtimePid > 0
          ? { runtimePid: reconciled.record.runtimePid }
          : typeof laneRecord.runtimePid === 'number' && laneRecord.runtimePid > 0
            ? { runtimePid: laneRecord.runtimePid }
            : typeof snapshot.host?.pid === 'number' && snapshot.host.pid > 0
              ? { runtimePid: snapshot.host.pid }
              : {}),
        evidence: evidenceFromSummary(laneRecord, reconciled.summary),
        diagnostics: reconciled.summary.diagnostics,
      }
      diagnostics.push(
        ...reconciled.summary.diagnostics.map(message =>
          teamDiagnostic('permission_reconcile', `${laneRecord.memberName}: ${message}`, 'info'),
        ),
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      members[laneRecord.memberName] = {
        sessionId: laneRecord.opencodeSessionId,
        launchState: 'failed',
        ...(typeof laneRecord.runtimePid === 'number' && laneRecord.runtimePid > 0
          ? { runtimePid: laneRecord.runtimePid }
          : typeof snapshot.host?.pid === 'number' && snapshot.host.pid > 0
            ? { runtimePid: snapshot.host.pid }
            : {}),
        evidence: [{ kind: 'member_reconcile_failed', observedAt: nowIso() }],
        diagnostics: [reason],
      }
      diagnostics.push(teamDiagnostic('permission_reconcile_failed', `${laneRecord.memberName}: ${reason}`, 'error'))
    }
  }
  return {
    snapshot,
    data: buildTeamLaunchData({
      runId: asString(body.runId) ?? 'unknown',
      selectedModel,
      members,
      diagnostics,
      commandEvidence,
    }),
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
    if (records.length > 0) {
      const requestIds = new Set<string>()
      for (const record of records) {
        const reconciled = await openCodeSessionBridge.reconcileSession(record, { limit: 1 })
        for (const requestID of reconciled.summary.pendingPermissionRequestIds) {
          if (requestID.trim()) {
            requestIds.add(requestID.trim())
          }
        }
      }
      permissions = [...requestIds].map(requestID => ({ requestID }))
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
  const sessionId = asString(body.sessionId)
  if (!teamId || !memberName) {
    throw new Error('opencode.getRuntimeTranscript requires teamId/teamName and memberName')
  }
  const matchesSession = (candidate: OpenCodeSessionRecord): boolean =>
    !sessionId || candidate.opencodeSessionId === sessionId
  const record = laneId
    ? await openCodeSessionStore.get(teamId, laneId, memberName)
    : (await openCodeSessionStore.list()).find(
      candidate => candidate.teamId === teamId && candidate.memberName === memberName && matchesSession(candidate),
    ) ?? null
  if (laneId && record && !matchesSession(record)) {
    throw new Error(
      `Stored OpenCode session record for ${teamId}/${laneId}/${memberName} does not match sessionId ${sessionId}`,
    )
  }
  if (!laneId) {
    const candidateCount = (await openCodeSessionStore.list()).filter(
      candidate => candidate.teamId === teamId && candidate.memberName === memberName && matchesSession(candidate),
    ).length
    if (sessionId && candidateCount === 0) {
      throw new Error(`No stored OpenCode session record for ${teamId}/${memberName} with session ${sessionId}`)
    }
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

async function runCommandStatus(envelope: BridgeEnvelope): Promise<{
  snapshot: OpenCodeProvisioningSnapshot
  data: CommandStatusCommandData
}> {
  const body = envelope.body
  const snapshot = await buildCommandStatusReadOnlySnapshot(asString(body.projectPath) ?? envelope.cwd)
  const originalRequestId = asString(body.originalRequestId) ?? asString(body.requestId)
  const deliveryAttemptId = asString(body.deliveryAttemptId)
  if (!originalRequestId && !deliveryAttemptId) {
    return {
      snapshot,
      data: {
        status: 'unknown',
        safeToRetry: false,
        accepted: false,
        diagnostics: ['opencode.commandStatus requires originalRequestId or deliveryAttemptId.'],
      },
    }
  }

  const query = await openCodeCommandOutcomeStore.query({
    requestId: originalRequestId,
    deliveryAttemptId,
  })
  if (!query.record) {
    const preconditionMismatch = query.diagnostics.some(diagnostic =>
      diagnostic.includes('matched different requestId and deliveryAttemptId'),
    )
    return {
      snapshot,
      data: {
        status: preconditionMismatch ? 'precondition_mismatch' : 'unknown',
        safeToRetry: false,
        accepted: false,
        ...(originalRequestId ? { originalRequestId } : {}),
        ...(deliveryAttemptId ? { deliveryAttemptId } : {}),
        diagnostics: query.diagnostics.length
          ? query.diagnostics
          : ['No orchestrator-side command outcome record matched the requested OpenCode command.'],
      },
    }
  }

  const mismatchReason = commandStatusMismatchReason(query.record, body)
  if (mismatchReason) {
    return {
      snapshot,
      data: {
        status: 'precondition_mismatch',
        safeToRetry: false,
        accepted: false,
        originalRequestId: query.record.requestId,
        ...(query.record.deliveryAttemptId ? { deliveryAttemptId: query.record.deliveryAttemptId } : {}),
        diagnostics: [...query.diagnostics, `OpenCode command status ${mismatchReason}.`],
      },
    }
  }

  let status = commandStatusFromOutcomeStatus(query.record.status)
  let accepted = isAcceptedOutcomeStatus(status)
  const diagnostics = [...query.diagnostics, ...query.record.diagnostics]

  if (status === 'prompt_submitting' && query.record.runtimePromptMessageId) {
    const proof = await findPromptAcceptedEvidenceReadOnly({
      record: query.record,
      runtimePromptMessageId: query.record.runtimePromptMessageId,
    })
    diagnostics.push(...proof.diagnostics)
    if (proof.accepted) {
      status = 'prompt_accepted'
      accepted = true
      diagnostics.push(`OpenCode prompt acceptance recovered from ${proof.source}.`)
    }
  }

  const safeToRetry = accepted
    ? false
    : status === 'prompt_submitting'
      ? false
      : status === 'failed_before_accept'
        ? true
        : query.record.safeToRetry

  return {
    snapshot,
    data: {
      status,
      safeToRetry,
      accepted,
      originalRequestId: query.record.requestId,
      ...(query.record.deliveryAttemptId ? { deliveryAttemptId: query.record.deliveryAttemptId } : {}),
      ...(query.record.sessionId ? { sessionId: query.record.sessionId } : {}),
      ...(typeof query.record.runtimePid === 'number' && query.record.runtimePid > 0
        ? { runtimePid: query.record.runtimePid }
        : {}),
      ...(query.record.runtimePromptMessageId
        ? { runtimePromptMessageId: query.record.runtimePromptMessageId }
        : {}),
      ...(query.record.prePromptCursor !== null
        ? { prePromptCursor: query.record.prePromptCursor }
        : {}),
      ...(query.record.sendMessageData
        ? { sendMessageData: outcomeSendMessageDataToCommandData(query.record.sendMessageData) }
        : {}),
      diagnostics,
    },
  }
}

async function handleEnvelope(envelope: BridgeEnvelope) {
  switch (envelope.command) {
    case 'opencode.handshake': {
      const lightweightLaunchHandshake = shouldUseLightweightLaunchHandshake(envelope.body)
      const snapshot = lightweightLaunchHandshake
        ? null
        : await openCodeProvisioningProbe.probe(envelope.cwd)
      const identity = createBridgeServerIdentity(snapshot, {
        runtimeStoreManifestHighWatermark: lightweightLaunchHandshake
          ? asNullableNumber(envelope.body.expectedManifestHighWatermark)
          : undefined,
      })
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
    case 'opencode.cleanupHosts':
      return runCleanupHosts(envelope)
    case 'opencode.launchTeam':
      return runLaunch(envelope)
    case 'opencode.reconcileTeam':
      return runReconcile(envelope)
    case 'opencode.stopTeam':
      return runStop(envelope)
    case 'opencode.sendMessage':
      return runSendMessage(envelope)
    case 'opencode.observeMessageDelivery':
      return runObserveMessageDelivery(envelope)
    case 'opencode.answerPermission':
      return runAnswerPermission(envelope)
    case 'opencode.listRuntimePermissions':
      return runListPermissions(envelope)
    case 'opencode.getRuntimeTranscript':
      return runTranscript(envelope)
    case 'opencode.backfillTaskLedger': {
      const snapshot = await openCodeProvisioningProbe.probe(envelope.cwd)
      const result = await openCodeLedgerBridgeService.backfill({
        teamId: asString(envelope.body.teamId) ?? undefined,
        teamName: asString(envelope.body.teamName) ?? asString(envelope.body.teamId) ?? '',
        taskId: asString(envelope.body.taskId) ?? undefined,
        taskDisplayId: asString(envelope.body.taskDisplayId) ?? undefined,
        memberName: asString(envelope.body.memberName) ?? undefined,
        laneId: asString(envelope.body.laneId) ?? undefined,
        projectDir: asString(envelope.body.projectDir) ?? undefined,
        workspaceRoot: asString(envelope.body.workspaceRoot) ?? undefined,
        deliveryContextPath: asString(envelope.body.deliveryContextPath) ?? undefined,
        deliveryContextHash: asString(envelope.body.deliveryContextHash) ?? undefined,
        attributionMode: asString(envelope.body.attributionMode) === 'strict-delivery' ? 'strict-delivery' : 'compatible',
        dryRun: envelope.body.dryRun === true,
      })
      return { snapshot, data: result }
    }
    case 'opencode.commandStatus':
      return runCommandStatus(envelope)
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
