import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import nodePath from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { openCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import {
  buildOpenCodeExecutionProof,
  parseOpenCodeExecutionProof,
  validateOpenCodeExecutionProof,
} from './OpenCodeExecutionProof.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import { readOpenCodeAuthCredential } from './OpenCodeAuthStore.js'
import {
  type OpenCodeBridgeCommandEvidence,
  parseOpenCodeBridgePreconditions,
  requireOpenCodeExpectedBehaviorFingerprint,
  validateOpenCodeBridgeStateChangingPreconditions,
} from './OpenCodeBridgePreconditions.js'
import {
  buildOpenCodeExpectedBehaviorEvidence,
  OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
} from './OpenCodeExpectedBehaviorFingerprint.js'
import {
  hasOpenCodeBuiltinFreeModel,
  openCodeInventoryService,
} from './OpenCodeInventoryService.js'
import {
  buildOpenCodeModelAccessCatalogFromProvisioningSnapshot,
  evaluateOpenCodeModelAccess,
  isKnownAuthlessOpenCodeProviderId,
} from './OpenCodeModelAccessPolicy.js'
import {
  OPEN_CODE_APP_MCP_SERVER_NAME,
  type ResolvedAppMcpLaunchConfig,
  resolveOpenCodeAppMcpLaunchConfig,
} from './OpenCodeMcpManager.js'
import { resolveOpenCodeProviderScopedModel } from './OpenCodeModelResolver.js'
import { parseOpenCodeProviderScopedModelRef } from './OpenCodeModelRef.js'
import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'
import { buildManagedConfigFingerprint, canonicalizeOpenCodeProjectPath } from './OpenCodeProfileManager.js'
import { normalizeOpenCodePermissions } from './OpenCodePermissionNormalizer.js'
import { openCodeProvisioningProbe, type OpenCodeAuthorityRejection } from './OpenCodeProvisioningProbe.js'
import { normalizeOpenCodeProjectIdentity } from './OpenCodeProjectIdentity.js'
import { openCodeHostManager } from './OpenCodeHostManager.js'
import {
  isOpenCodeRuntimeDeadlineError,
  OpenCodeRuntimeDeadline,
  raceOpenCodeAbortSignal,
  type OpenCodePhaseContext,
  throwOpenCodeAbortReason,
} from './OpenCodeRuntimeDeadline.js'
import { normalizeOpenCodeSessionStatus } from './OpenCodeEventTranslator.js'
import { openCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import {
  isOpenCodeStrictSessionCompatible,
  openCodeSessionBridge,
} from './OpenCodeSessionBridge.js'
import type { OpenCodePromptPart } from './OpenCodeSessionBridge.js'
import { isOpenCodeSessionStopped, openCodeSessionStore, type MaterializationOwnerToken } from './OpenCodeSessionStore.js'
import {
  coordinateStrictLaunch,
  type StrictCommittedMember,
  type StrictLaunchPorts,
  type StrictMember,
  type StrictPortResult,
  type StrictResource,
} from './OpenCodeStrictLaunchCoordinator.js'
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
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'

import type { OpenCodeSnapshotBoundary } from './OpenCodeChangeEvidence.js'
import type {
  OpenCodeMessage,
  OpenCodeMcpServerConfig,
  OpenCodeExecutionProof,
  OpenCodeHostHandle,
  OpenCodePendingPermission,
  OpenCodeProvisioningSnapshot,
  OpenCodeNormalizedPermission,
  OpenCodeSessionRecord,
  OpenCodeSessionReconcileSummary,
  OpenCodeToolApprovalMode,
} from './types.js'

const BRIDGE_SCHEMA_VERSION = 1
const RUNTIME_STORE_MANIFEST_HIGH_WATERMARK = 0
// App-managed bootstrap deliberately bypasses the launch-time model tool-call
// requirement for OpenCode only. Bump this when changing the injected context
// or the candidate proof shape so the desktop app can reject stale evidence.
const OPENCODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION = 1
const OPENCODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION = 2
const OPENCODE_FILE_PARTS_CONTRACT_VERSION = 2
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
const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE'
const SUPPORTED_OPENCODE_PROMPT_FILE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
])

function resolveLaunchToolApprovalMode(body: Record<string, unknown>): OpenCodeToolApprovalMode {
  return body.skipPermissions === false ? 'manual' : 'auto'
}
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
  pendingPermissions?: OpenCodeNormalizedPermission[]
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
  const inventory = await openCodeInventoryService.probe(projectPath, {
    mode: 'summary',
    includeAppMcp: false,
  })
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
      'OpenCode command status used read-only summary inventory snapshot; host state was not probed.',
    ],
  }
}

function buildSendMessageStoredSessionSnapshot(
  projectPath: string,
  record: OpenCodeSessionRecord,
): OpenCodeProvisioningSnapshot {
  return {
    detected: true,
    hostHealthy: false,
    projectPath: record.projectPath || projectPath,
    models: record.selectedModel ? [record.selectedModel] : [],
    modelMetadata: [],
    profile: null,
    host: null,
    config: null,
    configProviders: null,
    providers: null,
    providerAuth: null,
    agents: [],
    mcp: null,
    appMcp: null,
    probeError: null,
    diagnostics: [
      'OpenCode sendMessage used stored session state; provisioning preflight was not probed.',
    ],
  }
}

function buildTranscriptStoredSessionSnapshot(
  projectPath: string,
  record: OpenCodeSessionRecord,
): OpenCodeProvisioningSnapshot {
  return {
    ...buildSendMessageStoredSessionSnapshot(projectPath, record),
    diagnostics: [
      'OpenCode transcript used stored session state; provisioning preflight was not probed.',
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
    if (!SUPPORTED_OPENCODE_PROMPT_FILE_MIME_TYPES.has(mime)) {
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

type ConfirmedStopRuntime = NonNullable<OpenCodeSessionRecord['stopAuthority']>['runtime']

function createRuntimeSnapshot(snapshot?: OpenCodeProvisioningSnapshot | null) {
  const capabilitySnapshotId = snapshot
    ? `opencode:${hashStable({
      version: snapshot.host?.version ?? null,
      projectPath: normalizeOpenCodeProjectIdentity(snapshot.projectPath),
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
  overrides: { runtimeStoreManifestHighWatermark?: number | null; confirmedStopRuntime?: ConfirmedStopRuntime } = {},
) {
  return {
    ...(overrides.confirmedStopRuntime ?? createRuntimeSnapshot(snapshot)),
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

function expectedCapabilitySnapshotId(body: Record<string, unknown>): string | null {
  return asString(asRecord(body.preconditions)?.expectedCapabilitySnapshotId)
    ?? asString(body.expectedCapabilitySnapshotId)
}

async function probeStoredLaneAuthority(
  envelope: BridgeEnvelope,
  command: string,
  phaseContext?: OpenCodePhaseContext,
) {
  const body = envelope.body
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  const laneId = asString(body.laneId)
  if (!teamId || !laneId) throw new Error('OpenCode lifecycle authority requires teamId and laneId')
  const preconditions = parseOpenCodeBridgePreconditions(body.preconditions)
  if (preconditions?.laneId && preconditions.laneId !== laneId) {
    throw new Error('OpenCode bridge expected laneId precondition does not match command laneId')
  }
  if (preconditions?.expectedRunId && asString(body.runId)
    && preconditions.expectedRunId !== asString(body.runId)) {
    throw new Error('OpenCode bridge expectedRunId precondition does not match command runId')
  }
  const records = (await openCodeSessionStore.list()).filter(record =>
    record.teamId === teamId && (record.laneId ?? 'primary') === laneId)
  if (body.allowEmptyLaneStop === true) {
    if (command !== 'opencode.stopTeam' || expectedCapabilitySnapshotId(body) || records.length) {
      throw new Error('OpenCode empty-lane stop authority mismatch')
    }
    return { snapshot: null, records, release: async () => {} }
  }
  if (records.length === 0) {
    throw new Error('OpenCode lifecycle selected lane authority is unavailable')
  }
  if (!expectedCapabilitySnapshotId(body)) {
    throw new Error('OpenCode lifecycle existing lane requires a capability snapshot')
  }
  const runId = asString(body.runId) ?? asString(body.expectedRunId)
  if (!runId) throw new Error('OpenCode lifecycle authority requires runId')
  const authorityRecords = command === 'opencode.stopTeam'
    ? records.filter(record => record.runId === runId)
    : records
  if (
    command === 'opencode.stopTeam'
    && records.some(record => record.runId !== runId && !isOpenCodeSessionStopped(record))
  ) {
    throw new Error('OpenCode lifecycle stored run authority mismatch; another run is active')
  }
  if (authorityRecords.length === 0) {
    throw new Error('OpenCode lifecycle selected run authority is unavailable')
  }
  const projectPath = await canonicalizeOpenCodeProjectPath(asString(body.projectPath) ?? envelope.cwd)
  const selectedModel = parseOpenCodeProviderScopedModelRef(authorityRecords[0].selectedModel)
  const mode = authorityRecords[0].toolApprovalMode
  const scope = authorityRecords[0].profileScope
  if (!selectedModel || scope?.purpose !== 'launch_runtime'
    || (mode !== 'auto' && mode !== 'manual')) {
    throw new Error('OpenCode lifecycle selected lane scope is unavailable')
  }
  for (const record of authorityRecords) {
    if (!record.runId || record.runId !== runId) {
      throw new Error('OpenCode lifecycle stored run authority mismatch; relaunch the lane with current runtime')
    }
    if (await canonicalizeOpenCodeProjectPath(record.projectPath) !== projectPath) {
      throw new Error('OpenCode lifecycle lane project authority mismatch')
    }
    if (record.selectedModel !== selectedModel.raw || record.toolApprovalMode !== mode
      || record.profileScope?.purpose !== 'launch_runtime'
      || record.profileScope.providerId !== selectedModel.providerId
      || record.profileScope.scopeToken !== scope.scopeToken) {
      throw new Error('OpenCode lifecycle lane scope is ambiguous')
    }
  }
  if (command === 'opencode.stopTeam' && authorityRecords.every(isOpenCodeSessionStopped)) {
    const authority = authorityRecords[0].stopAuthority
    if (!authority || authority.runtime.providerId !== 'opencode'
      || !/^opencode:[a-f0-9]{32}$/.test(authority.runtime.capabilitySnapshotId)
      || authorityRecords.some(record => !record.stopAuthority
        || !/^[a-f0-9]{64}$/.test(record.expectedBehaviorFingerprint ?? '')
        || record.stopAuthority.expectedBehaviorFingerprint !== record.expectedBehaviorFingerprint
        || hashStable(record.stopAuthority.runtime) !== hashStable(authority.runtime))
      || expectedCapabilitySnapshotId(body) !== authority.runtime.capabilitySnapshotId
      || (preconditions?.expectedBehaviorFingerprint
        && authorityRecords.some(record => record.expectedBehaviorFingerprint !== preconditions.expectedBehaviorFingerprint))) {
      throw new Error('OpenCode confirmed stop authority mismatch')
    }
    return {
      snapshot: null,
      records: authorityRecords,
      confirmedStopRuntime: authority.runtime,
      release: async () => {},
    }
  }
  const retained = await openCodeProvisioningProbe.probeRetainingHost(projectPath, {
    selectedModel: selectedModel.raw, toolApprovalMode: mode, phaseContext,
  })
  return { snapshot: retained.snapshot, records: authorityRecords, release: retained.release }
}

function createBridgeServerIdentity(
  snapshot?: OpenCodeProvisioningSnapshot | null,
  overrides: { runtimeStoreManifestHighWatermark?: number | null; confirmedStopRuntime?: ConfirmedStopRuntime } = {},
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
      opencodeFilePartsContractVersion: OPENCODE_FILE_PARTS_CONTRACT_VERSION,
      expectedBehaviorFingerprintSchemaVersion:
        OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
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
    observation.state === 'empty_assistant_turn'
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
  confirmedStopRuntime?: ConfirmedStopRuntime,
) {
  return {
    ok: true,
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    requestId: envelope.requestId,
    command: envelope.command,
    completedAt: nowIso(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    runtime: confirmedStopRuntime ?? createRuntimeSnapshot(snapshot),
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
  details?: Record<string, unknown>,
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
      ...(details ? { details } : {}),
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
  if (typeof envelope.timeoutMs === 'number' && !Number.isFinite(envelope.timeoutMs)) {
    throw new Error('Bridge envelope timeoutMs must be finite')
  }
  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    requestId,
    command: command as BridgeCommandName,
    cwd,
    startedAt,
    timeoutMs: typeof envelope.timeoutMs === 'number' && envelope.timeoutMs > 0
      ? envelope.timeoutMs
      : 0,
    body,
  }
}

type AppMcpToolProof = {
  ok: boolean
  observedTools: string[]
  missingTools: string[]
  diagnostics: string[]
  route: string | null
  contractConfigIdentity: string | null
}

// Cold workspace/source MCP startup can take longer than a model turn on dev
// machines. Keep this below the outer readiness timeout but avoid false launch
// failures before OpenCode ever gets a chance to attach Agent Teams tools.
const DEFAULT_APP_MCP_PREFLIGHT_TIMEOUT_MS = 45_000
const SOURCE_APP_MCP_PREFLIGHT_TIMEOUT_MS = 90_000
const APP_MCP_PREFLIGHT_TIMEOUT_ENV = 'AGENT_TEAMS_OPENCODE_MCP_PREFLIGHT_TIMEOUT_MS'
const APP_MCP_PREFLIGHT_CLOSE_TIMEOUT_MS = 2_000
const APP_MCP_TOOL_PROOF_CACHE_TTL_MS = 15_000
const APP_MCP_TOOL_PROOF_PERSISTED_CACHE_VERSION = 2
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

function isSourceAppMcpLaunchConfig(launchConfig: ResolvedAppMcpLaunchConfig): boolean {
  if (launchConfig.config.type !== 'local') {
    return false
  }

  const command = launchConfig.config.command ?? []
  return command.some(part => {
    const normalized = part.trim().toLowerCase()
    return normalized.endsWith('/tsx') ||
      normalized.endsWith('\\tsx') ||
      normalized.endsWith('/tsx.cmd') ||
      normalized.endsWith('\\tsx.cmd') ||
      normalized.endsWith('.ts')
  })
}

function appMcpPreflightTimeoutMs(launchConfig: ResolvedAppMcpLaunchConfig): number {
  const configured = Number(process.env[APP_MCP_PREFLIGHT_TIMEOUT_ENV])
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.round(configured), 180_000)
  }
  return isSourceAppMcpLaunchConfig(launchConfig)
    ? SOURCE_APP_MCP_PREFLIGHT_TIMEOUT_MS
    : DEFAULT_APP_MCP_PREFLIGHT_TIMEOUT_MS
}

export function __getAppMcpPreflightTimeoutMsForTests(
  launchConfig: ResolvedAppMcpLaunchConfig,
): number {
  return appMcpPreflightTimeoutMs(launchConfig)
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
  const contractConfigIdentity = asString(value.contractConfigIdentity)
  if (!ok) {
    return null
  }
  return {
    ok,
    observedTools,
    missingTools,
    diagnostics,
    route,
    contractConfigIdentity,
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

  await writeJsonFileAtomic(cachePath, cache)
}

async function proveAppMcpTools(
  snapshot: OpenCodeProvisioningSnapshot,
  phaseContext?: OpenCodePhaseContext,
): Promise<AppMcpToolProof> {
  if (!snapshot.host) {
    return {
      ok: false,
      observedTools: [],
      missingTools: [...REQUIRED_AGENT_TEAMS_DIRECT_MCP_TOOL_IDS],
      diagnostics: ['OpenCode host is unavailable; app MCP tools cannot be proven'],
      route: null,
      contractConfigIdentity: null,
    }
  }

  return proveAppMcpToolsFromLaunchConfig(phaseContext)
}

function getRetainedAppMcpLaunchConfig(host: OpenCodeHostHandle): ResolvedAppMcpLaunchConfig {
  const source = host.profile.appMcpLaunchSource
  const config = asRecord(host.profile.managedConfig.mcp)
    ?.[OPEN_CODE_APP_MCP_SERVER_NAME] as OpenCodeMcpServerConfig | undefined
  if (!source || !config) {
    throw new Error('OpenCode retained App MCP launch source/config is unavailable')
  }
  return { source, config }
}

async function proveAppMcpToolsFromLaunchConfig(
  phaseContext?: OpenCodePhaseContext,
  preparedHost?: OpenCodeHostHandle,
): Promise<AppMcpToolProof> {
  const launchConfig: ResolvedAppMcpLaunchConfig = preparedHost
    ? getRetainedAppMcpLaunchConfig(preparedHost)
    : await resolveOpenCodeAppMcpLaunchConfig()
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
    return raceOpenCodeAbortSignal(inFlight, phaseContext?.signal)
  }

  let proofPromise: Promise<AppMcpToolProof>
  proofPromise = (async () => {
    try {
      const observedTools = await listAppMcpToolsFromResolvedLaunchConfig(
        launchConfig,
        phaseContext,
        preparedHost?.profile.env,
      )
      const proof = matchAppMcpTools(observedTools, 'direct-contract:mcp/tools/list')
      proof.contractConfigIdentity = hashStable(launchConfig.config)
      if (proof.ok) {
        appMcpToolProofCache.set(cacheKey, {
          expiresAt: Date.now() + APP_MCP_TOOL_PROOF_CACHE_TTL_MS,
          proof,
        })
        await writePersistedAppMcpToolProof(cacheKey, proof).catch(() => undefined)
      }
      return proof
    } catch (error) {
      if (phaseContext?.signal.aborted) {
        throwOpenCodeAbortReason(phaseContext.signal)
      }
      return {
        ok: false,
        observedTools: [],
        missingTools: [...REQUIRED_AGENT_TEAMS_DIRECT_MCP_TOOL_IDS],
        diagnostics: [
          `Agent Teams MCP direct contract tools/list preflight failed: ${error instanceof Error ? error.message : String(error)}`,
          'OpenCode 1.14.19 experimental tool endpoints do not expose MCP tools, so they are not accepted as production proof.',
        ],
        route: 'direct-contract:mcp/tools/list',
        contractConfigIdentity: hashStable(launchConfig.config),
      }
    } finally {
      if (appMcpToolProofInFlight.get(cacheKey) === proofPromise) {
        appMcpToolProofInFlight.delete(cacheKey)
      }
    }
  })()

  appMcpToolProofInFlight.set(cacheKey, proofPromise)
  return proofPromise
}

async function listAppMcpToolsFromResolvedLaunchConfig(
  launchConfig: ResolvedAppMcpLaunchConfig,
  phaseContext?: OpenCodePhaseContext,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const preflightTimeoutMs = Math.min(
    appMcpPreflightTimeoutMs(launchConfig),
    phaseContext?.remainingMs() ?? Number.POSITIVE_INFINITY,
  )
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
        await withTimeout(client.connect(transport), preflightTimeoutMs, phaseContext?.signal)
        const result = await withTimeout(client.listTools(), preflightTimeoutMs, phaseContext?.signal)
        return (result.tools ?? [])
          .map(tool => tool.name)
          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      } catch (error) {
        if (phaseContext?.signal.aborted) throwOpenCodeAbortReason(phaseContext.signal)
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
    env: buildMcpPreflightEnv(baseEnv, launchConfig.config.environment),
    stderr: 'pipe',
  })
  let stderr = ''
  const stderrStream = transport.stderr as unknown as NodeJS.ReadableStream | null
  stderrStream?.setEncoding('utf8')
  stderrStream?.on('data', chunk => {
    stderr += String(chunk)
  })

  try {
    await withTimeout(client.connect(transport), preflightTimeoutMs, phaseContext?.signal)
    const result = await withTimeout(client.listTools(), preflightTimeoutMs, phaseContext?.signal)
    return (result.tools ?? [])
      .map(tool => tool.name)
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
  } catch (error) {
    if (phaseContext?.signal.aborted) throwOpenCodeAbortReason(phaseContext.signal)
    const detail = stderr.trim()
    if (detail) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message}\nAgent Teams MCP stderr:\n${detail.slice(0, 4000)}`)
    }
    throw error
  } finally {
    await closeMcpClient(client)
  }
}

function buildMcpPreflightEnv(
  base: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  delete env[ELECTRON_RUN_AS_NODE_ENV]
  return {
    ...env,
    ...(extra ?? {}),
  }
}

async function closeMcpClient(client: Client): Promise<void> {
  await withTimeout(client.close(), APP_MCP_PREFLIGHT_CLOSE_TIMEOUT_MS).catch(() => undefined)
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let removeAbortListener = () => {}
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
        }),
      ...(signal
        ? [new Promise<never>((_, reject) => {
            const rejectForAbort = () => {
              try {
                throwOpenCodeAbortReason(signal)
              } catch (error) {
                reject(error)
              }
            }
            if (signal.aborted) {
              rejectForAbort()
              return
            }
            signal.addEventListener('abort', rejectForAbort, { once: true })
            removeAbortListener = () => signal.removeEventListener('abort', rejectForAbort)
          })]
        : []),
    ])
  } finally {
    removeAbortListener()
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
      : [`Agent Teams MCP direct contract tools missing from ${route}: ${missingTools.join(', ')}`],
    route,
    contractConfigIdentity: null,
  }
}

function readinessData(
  snapshot: OpenCodeProvisioningSnapshot,
  selectedModel: string | null,
  executionOutcome: Awaited<ReturnType<typeof openCodeExecutionProbe.probeModel>> | undefined,
  toolProof: AppMcpToolProof,
  requireSelectedModel: boolean,
  executionProof?: OpenCodeExecutionProof,
  expectedBehaviorEvidence = executionProof?.expectedBehaviorEvidence,
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
  const appMcpUnavailable = !appMcpConnected || !requiredToolsPresent
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
  } else if (
    executionOutcome
    && executionOutcome.outcome !== 'available'
    && appMcpUnavailable
  ) {
    state = 'mcp_unavailable'
    launchAllowed = false
    missing.push(
      toolProof.missingTools.length > 0
        ? `Agent Teams MCP direct server contract is missing required tools: ${toolProof.missingTools.join(', ')}`
        : 'Agent Teams MCP direct server contract is unavailable',
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
  } else if (appMcpUnavailable) {
    state = 'mcp_unavailable'
    launchAllowed = false
    missing.push(
      toolProof.missingTools.length > 0
        ? `Agent Teams MCP direct server contract is missing required tools: ${toolProof.missingTools.join(', ')}`
        : 'Agent Teams MCP direct server contract is unavailable',
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
    ...(expectedBehaviorEvidence
      ? { expectedBehaviorEvidence }
      : {}),
    ...(executionProof ? { executionProof } : {}),
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
    params.record,
  )
  const recreated = await openCodeSessionBridge.ensureSession({
    teamId: params.record.teamId,
    laneId: params.record.laneId,
    memberName: params.record.memberName,
    selectedModel: params.record.selectedModel,
    selectedVariant: params.record.selectedVariant,
    projectPath: params.record.projectPath,
    runId: params.runId,
    toolApprovalMode: params.record.toolApprovalMode,
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
  expectedBehaviorFingerprint?: string
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
    ...(params.expectedBehaviorFingerprint
      ? { expectedBehaviorFingerprint: params.expectedBehaviorFingerprint }
      : {}),
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
          ...(member.pendingPermissions?.length
            ? { pendingPermissions: member.pendingPermissions }
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

function shouldDisposeBridgeProbeHostOnRelease(): boolean {
  // Windows packaged bridge processes can lose stdout if they dispose the
  // just-used OpenCode host before the response is flushed. Release only the
  // short preflight lease there; cleanupHosts handles stale persistent hosts.
  return process.platform !== 'win32'
}

async function assertOpenCodeSelectedModelLaunchAccess(
  selectedModel: string,
  snapshot: OpenCodeProvisioningSnapshot,
  executionProof?: OpenCodeExecutionProof | null,
  runtimeDeadline?: OpenCodeRuntimeDeadline,
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

  if (executionProof) {
    const validateProof = () => validateOpenCodeExecutionProof({
      proof: executionProof,
      selectedModel,
      projectPath: snapshot.projectPath,
      snapshot,
      capabilitySnapshotId: createRuntimeSnapshot(snapshot).capabilitySnapshotId,
    })
    const proofValidation = runtimeDeadline
      ? await runtimeDeadline.runPhase('execution_submit', validateProof)
      : await validateProof()
    if (proofValidation.valid) {
      return
    }
  }

  const executionOutcome = await openCodeExecutionProbe.probeModel({
    selectedModel,
    projectPath: snapshot.projectPath,
    bypassCache: true,
    disposeHostOnRelease: shouldDisposeBridgeProbeHostOnRelease(),
    ...(runtimeDeadline ? { runtimeDeadline } : {}),
  }).catch(error => {
    if (isOpenCodeRuntimeDeadlineError(error)) throw error
    return buildOpenCodeExecutionOutcome(
      selectedModel,
      'unknown',
      error instanceof Error ? error.message : String(error),
    )
  })
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

async function shouldForceFreshOpenCodeExecutionProbe(
  selectedModel: string,
  snapshot: OpenCodeProvisioningSnapshot,
): Promise<boolean> {
  const parsed = parseOpenCodeProviderScopedModelRef(selectedModel)
  const authPath = snapshot.profile?.managedAuthPath
  if (!parsed || !authPath) return false
  const credential = await readOpenCodeAuthCredential({
    authPath,
    providerId: parsed.providerId,
  }).catch(() => null)
  return credential?.type === 'oauth'
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
    contractConfigIdentity: null,
  }
}

function shouldFastFailAuthlessModelWhenAppMcpUnavailable(selectedModel: string | null): boolean {
  const parsed = parseOpenCodeProviderScopedModelRef(selectedModel)
  return parsed ? isKnownAuthlessOpenCodeProviderId(parsed.providerId) : false
}

function mcpUnavailableReadinessData(input: {
  selectedModel: string | null
  toolProof: AppMcpToolProof
  diagnostics?: string[]
}) {
  const missingMessage = input.toolProof.missingTools.length > 0
    ? `Agent Teams MCP direct server contract is missing required tools: ${input.toolProof.missingTools.join(', ')}`
    : 'Agent Teams MCP direct server contract is unavailable'
  const diagnostics = uniqueSortedStrings([
    ...(input.diagnostics ?? []),
    ...input.toolProof.diagnostics,
  ])
  return {
    state: 'mcp_unavailable',
    launchAllowed: false,
    modelId: input.selectedModel,
    availableModels: [],
    opencodeVersion: null,
    installMethod: 'unknown',
    binaryPath: 'opencode',
    hostHealthy: false,
    appMcpConnected: false,
    requiredToolsPresent: false,
    permissionBridgeReady: true,
    runtimeStoresReady: true,
    supportLevel: null,
    missing: [missingMessage],
    diagnostics,
    evidence: {
      capabilitiesReady: true,
      mcpToolProofRoute: input.toolProof.route,
      observedMcpTools: input.toolProof.observedTools,
      runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
    },
  }
}

function preHostCursorFailureReadinessData(input: {
  selectedModel: string
  binaryPath: string
  executionOutcome: Awaited<ReturnType<typeof openCodeExecutionProbe.probeModel>>
  toolProof: AppMcpToolProof
}) {
  const reason = input.executionOutcome.reason
    ?? 'Cursor selected model execution is unavailable'
  const appMcpProven = input.toolProof.route !== null && input.toolProof.ok
  return {
    state: input.executionOutcome.outcome === 'not_authenticated'
      ? 'not_authenticated'
      : 'model_unavailable',
    launchAllowed: false,
    modelId: input.selectedModel,
    availableModels: [],
    opencodeVersion: null,
    installMethod: 'unknown',
    binaryPath: input.binaryPath,
    hostHealthy: false,
    appMcpConnected: appMcpProven,
    requiredToolsPresent: appMcpProven,
    permissionBridgeReady: true,
    runtimeStoresReady: true,
    supportLevel: null,
    missing: [reason],
    diagnostics: uniqueSortedStrings([
      ...input.executionOutcome.diagnostics,
      ...input.toolProof.diagnostics,
      input.executionOutcome.failureCode === 'execution_timeout'
        ? 'Skipped OpenCode host startup and Agent Teams MCP direct preflight because Cursor native preflight timed out.'
        : 'Skipped OpenCode host startup and Agent Teams MCP direct preflight because Cursor native preflight returned a terminal provider failure.',
    ]),
    evidence: {
      capabilitiesReady: true,
      mcpToolProofRoute: input.toolProof.route,
      observedMcpTools: input.toolProof.observedTools,
      runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
    },
  }
}

function unsupportedExtensionBoundReadinessData(selectedModel: string, providerId: string) {
  const reason =
    `OpenCode model ${selectedModel} uses extension-bound provider ${providerId}, `
    + 'which is not supported by the current Agent Teams launch runtime. Choose another OpenCode model.'
  return {
    state: 'model_unavailable',
    launchAllowed: false,
    modelId: selectedModel,
    availableModels: [],
    opencodeVersion: null,
    installMethod: 'unknown',
    binaryPath: 'opencode',
    hostHealthy: false,
    appMcpConnected: false,
    requiredToolsPresent: false,
    permissionBridgeReady: true,
    runtimeStoresReady: true,
    supportLevel: null,
    missing: [reason],
    diagnostics: [reason],
    evidence: {
      capabilitiesReady: true,
      mcpToolProofRoute: null,
      observedMcpTools: [],
      runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
    },
  }
}

async function runReadiness(
  envelope: BridgeEnvelope,
  runtimeDeadline: OpenCodeRuntimeDeadline,
) {
  const disposeReadinessHostOnRelease = shouldDisposeBridgeProbeHostOnRelease()
  const projectPath = asString(envelope.body.projectPath) ?? envelope.cwd
  const hasSelectedModel = envelope.body.selectedModel !== undefined
    && envelope.body.selectedModel !== null
  const selectedModel = asString(envelope.body.selectedModel)
  const requireSelectedModel = envelope.body.requireExecutionProbe === true || selectedModel !== null
  const shouldProbeSelectedModel = envelope.body.requireExecutionProbe === true && selectedModel !== null
  const qualifiedSelectedModel = parseOpenCodeProviderScopedModelRef(selectedModel)
  if (hasSelectedModel && !qualifiedSelectedModel) {
    throw new Error('OpenCode readiness requires a provider-qualified selectedModel')
  }
  if (qualifiedSelectedModel
    && (qualifiedSelectedModel.providerId === 'kiro'
      || qualifiedSelectedModel.providerId === 'cursor-acp')) {
    return {
      snapshot: null,
      data: unsupportedExtensionBoundReadinessData(
        qualifiedSelectedModel.raw,
        qualifiedSelectedModel.providerId,
      ),
    }
  }
  const runProvisioningPhase = async (
    phase: 'host_start' | 'post_probe_refresh',
    options: Parameters<typeof openCodeProvisioningProbe.probe>[1],
  ): Promise<OpenCodeProvisioningSnapshot> => {
    let pending: Promise<OpenCodeProvisioningSnapshot> | null = null
    try {
      return await runtimeDeadline.runPhase(phase, context => {
        pending = openCodeProvisioningProbe.probe(projectPath, {
          ...options,
          phaseContext: context,
        })
        return pending
      })
    } catch (error) {
      if (isOpenCodeRuntimeDeadlineError(error) && pending) {
        await withTimeout(pending.catch(() => undefined), 5_000).catch(() => undefined)
      }
      throw error
    }
  }
  const runDirectToolProof = async (preparedHost?: OpenCodeHostHandle): Promise<AppMcpToolProof> => {
    let pending: Promise<AppMcpToolProof> | null = null
    try {
      return await runtimeDeadline.runPhase('mcp_preflight', context => {
        context.throwIfExpired()
        pending = proveAppMcpToolsFromLaunchConfig(context, preparedHost)
        return pending.then(proof => {
          context.throwIfExpired()
          return proof
        })
      })
    } catch (error) {
      if (isOpenCodeRuntimeDeadlineError(error) && pending) {
        await withTimeout(pending.catch(() => undefined), 5_000).catch(() => undefined)
      }
      throw error
    }
  }
  if (qualifiedSelectedModel) {
    let retained: Awaited<ReturnType<typeof openCodeProvisioningProbe.probeRetainingHost>> | null = null
    try {
      retained = await runtimeDeadline.runPhase('host_start', context =>
        openCodeProvisioningProbe.probeRetainingHost(projectPath, {
          selectedModel: qualifiedSelectedModel.raw,
          toolApprovalMode: resolveLaunchToolApprovalMode(envelope.body),
          phaseContext: context,
        }))
      if (!retained.snapshot.detected || !retained.snapshot.hostHealthy) {
        return {
          snapshot: retained.snapshot,
          data: readinessData(
            retained.snapshot, qualifiedSelectedModel.raw, undefined,
            skippedAppMcpToolProof(), true,
          ),
        }
      }
      assertOpenCodeLaunchRuntimeAvailable(retained.snapshot)
      if (!retained.host) throw new Error('OpenCode readiness retained host is unavailable')
      const selectedAccess = evaluateOpenCodeModelAccess({
        selectedModel: qualifiedSelectedModel.raw,
        catalog: getOpenCodeAccessPolicyCatalog(retained.snapshot),
      })
      const selectedProviderCatalogued = retained.snapshot.configProviders?.providers
        ?.some(provider => canonicalizeOpenCodeProviderId(asString(provider.id) ?? '')
          === qualifiedSelectedModel.providerId) === true
      if (selectedProviderCatalogued && (selectedAccess.kind === 'unknown_model'
        || selectedAccess.kind === 'not_authenticated')) {
        const data = readinessData(
          retained.snapshot, qualifiedSelectedModel.raw, undefined,
          skippedAppMcpToolProof(), true,
        )
        data.state = selectedAccess.kind === 'unknown_model'
          ? 'model_unavailable' : 'not_authenticated'
        data.launchAllowed = false
        data.supportLevel = null
        data.missing = [selectedAccess.reason ?? (selectedAccess.kind === 'unknown_model'
          ? 'OpenCode selected model is unavailable'
          : 'OpenCode selected model provider is not connected')]
        return {
          snapshot: retained.snapshot,
          data,
        }
      }
      if (!shouldProbeSelectedModel) {
        const toolProof = await runDirectToolProof(retained.host)
        const data = readinessData(
          retained.snapshot, qualifiedSelectedModel.raw, undefined, toolProof, true,
        )
        if (data.launchAllowed) {
          data.state = 'model_unavailable'
          data.launchAllowed = false
          data.supportLevel = null
          data.missing.push('OpenCode selected model execution proof was not requested')
        }
        return {
          snapshot: retained.snapshot,
          data,
        }
      }
      const initialEvidence = await buildOpenCodeExpectedBehaviorEvidence({
        profile: retained.host.profile,
        fullModelId: qualifiedSelectedModel.raw,
        effectiveConfigFingerprint: retained.host.profile.managedConfigFingerprint,
      })
      const toolProof = await runDirectToolProof(retained.host)
      if (!toolProof.ok) {
        return {
          snapshot: retained.snapshot,
          data: readinessData(
            retained.snapshot, qualifiedSelectedModel.raw, undefined, toolProof, true,
          ),
        }
      }
      let authorityDiagnostic = ''
      const onRejection = (diagnostic: OpenCodeAuthorityRejection) => {
        authorityDiagnostic = diagnostic.check === 'exception'
          ? ` (${diagnostic.check}:${diagnostic.phase}:${diagnostic.errorClass})`
          : diagnostic.check === 'selected_config_match'
            ? ` (${diagnostic.check}:${diagnostic.fields.join(',')})`
            : ` (${diagnostic.check})`
      }
      const refreshedBefore = await openCodeProvisioningProbe.refreshSelectedProfileAuthority({
        host: retained.host,
        selectedModel: qualifiedSelectedModel.raw,
        expectedBehaviorFingerprint: initialEvidence.expectedBehaviorFingerprint,
        contractConfigIdentity: toolProof.contractConfigIdentity,
        onRejection,
      })
      if (!refreshedBefore) {
        throw new Error(`OpenCode selected readiness host/config/auth/project/MCP authority is unavailable${authorityDiagnostic}`)
      }
      const executionOutcome = await openCodeExecutionProbe.probeModelOnHost({
        host: retained.host,
        selectedModel: qualifiedSelectedModel.raw,
        runtimeDeadline,
        cleanupSuccessfulSession: true,
      })
      const refreshedAfter = await openCodeProvisioningProbe.refreshSelectedProfileAuthority({
        host: retained.host,
        selectedModel: qualifiedSelectedModel.raw,
        expectedBehaviorFingerprint: initialEvidence.expectedBehaviorFingerprint,
        contractConfigIdentity: toolProof.contractConfigIdentity,
        onRejection,
      })
      if (!refreshedAfter) {
        throw new Error(`OpenCode selected readiness authority changed during execution proof${authorityDiagnostic}`)
      }
      const snapshot = {
        ...retained.snapshot,
        profile: refreshedAfter,
        host: retained.snapshot.host ? { ...retained.snapshot.host, profile: refreshedAfter } : null,
      }
      const observedModelMatches =
        executionOutcome.observedProviderId === qualifiedSelectedModel.providerId
        && executionOutcome.observedModelId === qualifiedSelectedModel.modelId
      if (executionOutcome.outcome === 'available' && !observedModelMatches) {
        executionOutcome.outcome = 'unavailable'
        executionOutcome.reason = 'OpenCode selected readiness observed provider/model was unavailable or mismatched'
        executionOutcome.diagnostics.push(executionOutcome.reason)
        delete executionOutcome.verifiedAt
      }
      const executionProof = executionOutcome.outcome === 'available' && executionOutcome.verifiedAt
        ? await buildOpenCodeExecutionProof({
            selectedModel: qualifiedSelectedModel.raw,
            snapshot,
            capabilitySnapshotId: createRuntimeSnapshot(snapshot).capabilitySnapshotId,
            verifiedAt: executionOutcome.verifiedAt,
          }).catch(error => {
            executionOutcome.diagnostics.push(
              `OpenCode execution proof could not be created: ${strictPublicError(error)}`,
            )
            return undefined
          })
        : undefined
      return {
        snapshot,
        data: readinessData(
          snapshot,
          qualifiedSelectedModel.raw,
          executionOutcome,
          toolProof,
          true,
          executionProof,
          initialEvidence,
        ),
      }
    } finally {
      await retained?.release().catch(() => undefined)
    }
  }
  let earlyCursorExecutionOutcome: Awaited<ReturnType<
    typeof openCodeExecutionProbe.probeModel
  >> | undefined
  const parsedSelectedModel = qualifiedSelectedModel
  const openCodeBinaryPath = shouldProbeSelectedModel
    && parsedSelectedModel?.providerId === 'cursor-acp'
    ? resolveOpenCodeBinaryPath()
    : null
  if (
    shouldProbeSelectedModel
    && selectedModel !== null
    && parsedSelectedModel?.providerId === 'cursor-acp'
    && openCodeBinaryPath
  ) {
    earlyCursorExecutionOutcome = await openCodeExecutionProbe.probeModel({
      selectedModel,
      projectPath,
      disposeHostOnRelease: disposeReadinessHostOnRelease,
      runtimeDeadline,
      cursorNativePreflightBeforeHost: true,
      cursorNativePreflightOnly: true,
    }).catch(error => {
      if (isOpenCodeRuntimeDeadlineError(error)) throw error
      return buildOpenCodeExecutionOutcome(
        selectedModel,
        'unknown',
        error instanceof Error ? error.message : String(error),
      )
    })
    if (
      earlyCursorExecutionOutcome.outcome === 'unavailable'
      || earlyCursorExecutionOutcome.outcome === 'not_authenticated'
      || earlyCursorExecutionOutcome.failureCode === 'execution_timeout'
    ) {
      return {
        snapshot: null,
        data: preHostCursorFailureReadinessData({
          selectedModel,
          binaryPath: openCodeBinaryPath,
          executionOutcome: earlyCursorExecutionOutcome,
          toolProof: skippedAppMcpToolProof(),
        }),
      }
    }
    if (earlyCursorExecutionOutcome.outcome !== 'available') {
      earlyCursorExecutionOutcome = undefined
    }
  }

  let directToolProof: AppMcpToolProof | null = shouldProbeSelectedModel
    ? await runDirectToolProof()
    : null
  if (
    shouldProbeSelectedModel
    && shouldFastFailAuthlessModelWhenAppMcpUnavailable(selectedModel)
  ) {
    if (directToolProof && !directToolProof.ok) {
      return {
        snapshot: null,
        data: mcpUnavailableReadinessData({
          selectedModel,
          toolProof: directToolProof,
          diagnostics: [
            'Skipped OpenCode host startup and model verification because Agent Teams MCP direct preflight failed.',
          ],
        }),
      }
    }
  }

  const modelSnapshot = await runProvisioningPhase('host_start', {
    disposeHostOnRelease: disposeReadinessHostOnRelease,
    ensureAppMcp: !shouldProbeSelectedModel,
    bypassCache: shouldProbeSelectedModel,
  })
  let snapshot = modelSnapshot
  let executionModel: string | null = null
  let executionOutcomePromise: Promise<Awaited<ReturnType<typeof openCodeExecutionProbe.probeModel>> | undefined> =
    Promise.resolve(undefined)

  // A failed host/config probe cannot authoritatively say whether a selected
  // model exists. Preserve the provider-level transport failure so callers can
  // retry it instead of misclassifying an empty timeout snapshot as a terminal
  // `model_unavailable` result.
  if (!modelSnapshot.detected || !modelSnapshot.hostHealthy) {
    return {
      snapshot: modelSnapshot,
      data: readinessData(
        modelSnapshot,
        selectedModel,
        undefined,
        skippedAppMcpToolProof(),
        requireSelectedModel,
      ),
    }
  }

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
    directToolProof ??= await runDirectToolProof()
    const selectedModelAccess = evaluateOpenCodeModelAccess({
      selectedModel: executionModel,
      catalog: getOpenCodeAccessPolicyCatalog(snapshot),
    })
    if (
      selectedModelAccess.kind === 'configured_authless'
      && selectedModelAccess.requiresExecutionProof
      && modelSnapshot.host
    ) {
      if (!directToolProof.ok) {
        const executionOutcome = buildOpenCodeExecutionOutcome(
          executionModel,
          'unknown',
          'Skipped model verification because Agent Teams MCP tools are unavailable',
        )
        return {
          snapshot: modelSnapshot,
          data: readinessData(
            modelSnapshot,
            executionModel,
            executionOutcome,
            directToolProof,
            requireSelectedModel,
          ),
        }
      }
    }

    const bypassCache = await shouldForceFreshOpenCodeExecutionProbe(
      executionModel,
      modelSnapshot,
    )
    const executionOutcome = earlyCursorExecutionOutcome
      ?? await openCodeExecutionProbe.probeModel({
        selectedModel: executionModel,
        projectPath: modelSnapshot.projectPath,
        // OAuth credentials can rotate or expire independently, so they always
        // receive a fresh execution request. API-key and authless local models
        // may reuse the exact short-lived execution result.
        bypassCache,
        disposeHostOnRelease: disposeReadinessHostOnRelease,
        runtimeDeadline,
      }).catch(error => {
        if (isOpenCodeRuntimeDeadlineError(error)) throw error
        return buildOpenCodeExecutionOutcome(
          executionModel,
          'unknown',
          error instanceof Error ? error.message : String(error),
        )
      })
    executionOutcomePromise = Promise.resolve(executionOutcome)
    if (executionOutcome.outcome === 'unavailable') {
      const terminalReadiness = readinessData(
        modelSnapshot,
        executionModel,
        executionOutcome,
        directToolProof,
        requireSelectedModel,
      )
      return {
        snapshot: modelSnapshot,
        data: {
          ...terminalReadiness,
          state: 'model_unavailable',
          launchAllowed: false,
          missing: [
            executionOutcome.reason ?? 'OpenCode selected model execution is unavailable',
          ],
        },
      }
    }
    snapshot = await runProvisioningPhase('post_probe_refresh', {
      disposeHostOnRelease: disposeReadinessHostOnRelease,
      ensureAppMcp: true,
      bypassCache: true,
    })
  }
  directToolProof ??= await runDirectToolProof()
  const executionOutcome = await executionOutcomePromise
  let executionProof: OpenCodeExecutionProof | undefined
  if (executionOutcome?.outcome === 'available' && executionOutcome.verifiedAt) {
    executionProof = await buildOpenCodeExecutionProof({
      selectedModel: executionModel ?? selectedModel ?? executionOutcome.modelId,
      snapshot,
      capabilitySnapshotId: createRuntimeSnapshot(snapshot).capabilitySnapshotId,
      verifiedAt: executionOutcome.verifiedAt,
    }).catch(error => {
      executionOutcome.diagnostics.push(
        `OpenCode execution proof could not be created: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    })
  }

  return {
    snapshot,
    data: readinessData(
      snapshot,
      executionModel ?? selectedModel,
      executionOutcome,
      directToolProof,
      requireSelectedModel,
      executionProof,
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
  runtimeDeadline: OpenCodeRuntimeDeadline,
): Promise<void> {
  const toolProof = await runtimeDeadline.runPhase(
    'mcp_preflight',
    context => proveAppMcpTools(snapshot, context),
  )
  if (!isAppMcpConnected(snapshot) || !toolProof.ok) {
    throw new Error(
      toolProof.missingTools.length > 0
        ? `Agent Teams MCP direct server contract is missing required tools: ${toolProof.missingTools.join(', ')}`
        : 'Agent Teams MCP direct server contract is unavailable',
    )
  }
}

/**
 * Stands down a session whose launch bootstrap failed, WITHOUT erasing the fact
 * that it existed.
 *
 * The record used to be deleted here. That made the failure permanent: the
 * session store is the only thing `sendMessage` consults, and its recovery path
 * is keyed on finding a record that is stale - it recreates the session before
 * delivery precisely then. With no record at all there is nothing to recognise,
 * so every later message to that member is refused with "No stored OpenCode
 * session record", forever, and the app has no way back short of relaunching
 * the whole team.
 *
 * Keeping the record stale costs one row and restores the recovery that already
 * exists. The host-side session is still released, so nothing is left running.
 */
async function cleanupFailedLaunchSession(
  record: OpenCodeSessionRecord,
  ownerToken?: MaterializationOwnerToken,
): Promise<TeamDiagnostic[]> {
  const diagnostics: TeamDiagnostic[] = []
  let owned = false
  try {
    owned = Boolean(await openCodeSessionStore.markStaleIfSession(record, 'launch_failed', ownerToken))
  } catch (error) {
    diagnostics.push(teamDiagnostic(
      'opencode_launch_failed_session_mark_stale_failed',
      `${record.memberName}: ${error instanceof Error ? error.message : String(error)}`,
      'warning',
    ))
  }

  if (!owned) return diagnostics
  try {
    await openCodeSessionBridge.releaseSession(record)
  } catch (error) {
    diagnostics.push(teamDiagnostic(
      'opencode_launch_failed_session_release_failed',
      `${record.memberName}: ${error instanceof Error ? error.message : String(error)}`,
      'warning',
    ))
  }

  // Deliberately no delete: the stale record above is what lets the next
  // delivery recreate the session instead of refusing forever.
  return diagnostics
}

async function markStaleAndReleaseSession(
  record: OpenCodeSessionRecord,
  staleReason: string,
  diagnosticPrefix: string,
): Promise<TeamDiagnostic[]> {
  const diagnostics: TeamDiagnostic[] = []
  try {
    const updated = await openCodeSessionStore.markStale(
      record.teamId,
      record.laneId,
      record.memberName,
      staleReason,
      record,
    )
    if (!updated) return diagnostics
  } catch (error) {
    diagnostics.push(teamDiagnostic(
      `${diagnosticPrefix}_mark_stale_failed`,
      `${record.memberName}: ${error instanceof Error ? error.message : String(error)}`,
      'warning',
    ))
    return diagnostics
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

function strictPublicError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(
      /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|passwords?|credentials?|client[_-]?secret|secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[redacted]"',
    )
    .replace(/\bBearer\s+[^\s"',;}\]]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|passwords?|credentials?|client[_-]?secret|secret)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]',
    )
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  return (message || 'OpenCode strict launch failed').slice(0, 512)
}

function strictLaunchProjection(
  record: OpenCodeSessionRecord,
  member: { name: string; fingerprint: string },
  teamId: string,
  runId: string,
  laneId: string,
  fallbackRuntimePid?: number,
): LaunchMemberDraft {
  const bootstrap = record.appManagedBootstrap
  if (!bootstrap) {
    throw new Error('OpenCode strict launch committed projection is missing bootstrap evidence')
  }
  return {
    sessionId: record.opencodeSessionId,
    launchState: 'created',
    bootstrapEvidenceSource: 'app_managed_bootstrap',
    bootstrapMode: 'app_managed_context',
    appManagedBootstrapCandidate: {
      schemaVersion: 1,
      source: 'app_managed_bootstrap',
      teamName: teamId,
      memberName: member.name,
      runId,
      laneId,
      runtimeSessionId: record.opencodeSessionId,
      messageID: bootstrap.messageID,
      contextHash: bootstrap.contextHash,
      briefingHash: member.fingerprint,
      injectionVerifiedAt: bootstrap.injectionVerifiedAt,
      candidateAt: record.updatedAt,
      model: record.selectedModel,
      agent: bootstrap.agent,
    },
    ...((typeof record.runtimePid === 'number' && record.runtimePid > 0)
      || (typeof fallbackRuntimePid === 'number' && fallbackRuntimePid > 0)
      ? { runtimePid: record.runtimePid ?? fallbackRuntimePid }
      : {}),
    evidence: [{
      kind: 'app_managed_bootstrap_context_injected',
      observedAt: bootstrap.injectionVerifiedAt,
    }],
    diagnostics: ['OpenCode app-managed bootstrap context was injected and verified.'],
  }
}

async function runLaunch(
  envelope: BridgeEnvelope,
  runtimeDeadline: OpenCodeRuntimeDeadline,
  externalSignal?: AbortSignal,
) {
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
  const preconditions = parseOpenCodeBridgePreconditions(body.preconditions)
  const expectedBehaviorFingerprint = requireOpenCodeExpectedBehaviorFingerprint(preconditions)
  if (preconditions?.laneId && preconditions.laneId !== laneId) {
    throw new Error('OpenCode bridge expected laneId precondition does not match command laneId')
  }
  if (preconditions?.expectedRunId && preconditions.expectedRunId !== runId) {
    throw new Error('OpenCode bridge expectedRunId precondition does not match command runId')
  }
  if ((preconditions?.expectedManifestHighWatermark ?? 0) > RUNTIME_STORE_MANIFEST_HIGH_WATERMARK) {
    throw new Error('OpenCode bridge runtime manifest high watermark precondition is stale')
  }
  if (!preconditions?.commandLeaseId) {
    throw new Error('OpenCode strict launch requires full preconditions and commandLeaseId')
  }
  const selectedModelRef = parseOpenCodeProviderScopedModelRef(selectedModel)
  if (!selectedModelRef) {
    throw new Error('OpenCode strict launch requires a provider-qualified selectedModel')
  }
  if (selectedModelRef.providerId === 'kiro' || selectedModelRef.providerId === 'cursor-acp') {
    throw new Error(
      `OpenCode launch_runtime does not support extension-bound provider ${selectedModelRef.providerId}`,
    )
  }
  const apiSelectedModel = selectedModelRef.raw
  const toolApprovalMode = resolveLaunchToolApprovalMode(body)
  const deadlineAt = Date.now() + runtimeDeadline.remainingMs()
  const cleanupReserveMs = Math.min(
    5_000,
    Math.max(250, Math.floor(runtimeDeadline.remainingMs() / 10)),
  )
  const workDeadlineAt = deadlineAt - cleanupReserveMs
  const probeStartedAt = Date.now()
  let pendingProbe: ReturnType<typeof openCodeProvisioningProbe.probeRetainingHost> | null = null
  let retainedProbe: Awaited<ReturnType<typeof openCodeProvisioningProbe.probeRetainingHost>>
  const launchSignal = externalSignal
    ? AbortSignal.any([runtimeDeadline.signal, externalSignal])
    : runtimeDeadline.signal
  const provisioningController = new AbortController()
  const provisioningSignal = AbortSignal.any([launchSignal, provisioningController.signal])
  const provisioningTimer = setTimeout(() => provisioningController.abort(
    new Error('OpenCode strict launch provisioning deadline expired'),
  ), Math.max(0, workDeadlineAt - Date.now()))
  provisioningTimer.unref?.()
  try {
    const phaseContext: OpenCodePhaseContext = {
      phase: 'host_start',
      signal: provisioningSignal,
      remainingMs: () => Math.max(0, workDeadlineAt - Date.now()),
      throwIfExpired: () => {
        if (provisioningSignal.aborted) throwOpenCodeAbortReason(provisioningSignal)
        if (Date.now() >= workDeadlineAt) throw new Error(
          'OpenCode strict launch provisioning deadline expired',
        )
      },
    }
    phaseContext.throwIfExpired()
    pendingProbe = openCodeProvisioningProbe.probeRetainingHost(
      asString(body.projectPath) ?? envelope.cwd,
      { toolApprovalMode, phaseContext, selectedModel: apiSelectedModel,
        leaseId: preconditions.commandLeaseId },
    )
    retainedProbe = await raceOpenCodeAbortSignal(pendingProbe, provisioningSignal)
  } catch (error) {
    provisioningController.abort(error)
    if (pendingProbe) {
      const cleanup = pendingProbe.then(async probe => {
        // An abort-ignoring provisioner still transfers this exact caller-owned
        // lease when it eventually resolves. Release it on a fresh bounded
        // cleanup budget even when the command's absolute deadline is exhausted.
        await withTimeout(probe.release(), cleanupReserveMs)
      }).catch(() => undefined)
      void cleanup
    }
    throw error
  } finally {
    clearTimeout(provisioningTimer)
  }
  const provisioningProbeMs = elapsedMs(probeStartedAt)
  const snapshot = retainedProbe.snapshot
  const host = retainedProbe.host
  let attemptOwnsRetainedProbe = true
  const releaseAttemptOwnedProbe = async () => {
    if (!attemptOwnsRetainedProbe) return
    attemptOwnsRetainedProbe = false
    await retainedProbe.release()
  }

  const diagnostics: TeamDiagnostic[] = []
  let commandEvidence: ReturnType<typeof validateOpenCodeBridgeStateChangingPreconditions>
  try {
    assertOpenCodeLaunchRuntimeAvailable(snapshot)
    if (!host || !snapshot.host || snapshot.host.hostKey !== host.hostKey) {
      throw new Error('OpenCode strict launch retained host is unavailable')
    }
    commandEvidence = validateOpenCodeBridgeStateChangingPreconditions({
      body,
      runtime: createRuntimePreconditionSnapshot(snapshot),
      allowCapabilitySnapshotRecovery: true,
    })
    const initialExpectedBehaviorEvidence = await buildOpenCodeExpectedBehaviorEvidence({
      profile: host.profile,
      fullModelId: apiSelectedModel,
      effectiveConfigFingerprint: host.resolvedConfigFingerprint,
    }).catch(() => null)
    if (initialExpectedBehaviorEvidence?.expectedBehaviorFingerprint
      !== expectedBehaviorFingerprint) {
      throw new Error('OpenCode strict launch behavior precondition mismatch')
    }
  } catch (error) {
    await releaseAttemptOwnedProbe().catch(() => undefined)
    throw error
  }
  if (commandEvidence.capabilitySnapshotRecovery) {
    diagnostics.push(teamDiagnostic(
      'opencode_capability_snapshot_recovery',
      'Accepted a fresh OpenCode capability snapshot for the explicit recovery attempt.',
      'warning',
    ))
  }
  const memberInputs = new Map<string, {
    name: string
    prompt: string
    selectedVariant?: string
    fingerprint: string
  }>()
  const strictMembers: StrictMember[] = []
  for (const item of membersRaw) {
    const member = asRecord(item)!
    const name = asString(member.name)!
    const prompt = asString(member.prompt)
      ?? `Join OpenCode team ${teamId} as ${name}. Wait for app MCP task delivery.`
    const selectedVariant = asString(member.effort) ?? asString(body.effort) ?? undefined
    const fingerprint = hashStable({
      purpose: 'opencode-app-managed-bootstrap-briefing-v1',
      teamName: teamId,
      memberName: name,
      runId,
      laneId,
      prompt,
    })
    memberInputs.set(name, { name, prompt, selectedVariant, fingerprint })
    strictMembers.push({ memberId: name, memberFingerprint: fingerprint })
  }

  const resources = new Map<string, { record: OpenCodeSessionRecord; ownerToken: MaterializationOwnerToken }>()
  const pendingAttemptReconciliations = new Set<Promise<unknown>>()
  const trackAttemptReconciliation = <T>(operation: Promise<T>): Promise<T> => {
    pendingAttemptReconciliations.add(operation)
    void operation.then(
      () => pendingAttemptReconciliations.delete(operation),
      () => pendingAttemptReconciliations.delete(operation),
    )
    return operation
  }
  const drainAttemptReconciliations = async (): Promise<void> => {
    while (pendingAttemptReconciliations.size > 0) {
      await Promise.allSettled([...pendingAttemptReconciliations])
    }
  }
  const workContext = { snapshot, host, memberInputs, expectedBehaviorFingerprint }
  const trackAttemptMaterialization = (
    operation: StrictLaunchPorts<typeof workContext, typeof workContext, LaunchMemberDraft>['materialize'],
  ): typeof operation => (...args) => trackAttemptReconciliation(operation(...args))
  const strictSessionCompatibility = (
    sessionId: string,
    input: NonNullable<ReturnType<typeof memberInputs.get>>,
  ) => {
    const contextText = buildOpenCodeAppManagedBootstrapContextText({
      teamName: teamId,
      memberName: input.name,
      runId,
      laneId,
      runtimeSessionId: sessionId,
      prompt: input.prompt,
    })
    const contextHash = hashText(contextText)
    return {
      teamId,
      runId,
      laneId,
      memberName: input.name,
      selectedModel: apiSelectedModel,
      selectedVariant: input.selectedVariant,
      host,
      toolApprovalMode,
      expectedBehaviorFingerprint,
      bootstrap: {
        messageID: buildOpenCodeAppManagedBootstrapMessageID({
          teamName: teamId,
          memberName: input.name,
          runId,
          laneId,
          runtimeSessionId: sessionId,
          contextHash,
        }),
        contextHash,
        briefingHash: input.fingerprint,
        agent: OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT,
      },
    }
  }
  let requiredMcpContractConfigIdentity: string | null = null
  const matchesCurrentExpectedBehavior = async (signal: AbortSignal): Promise<boolean> => {
    return (await openCodeProvisioningProbe.refreshSelectedProfileAuthority({
      host,
      selectedModel: apiSelectedModel,
      expectedBehaviorFingerprint,
      contractConfigIdentity: requiredMcpContractConfigIdentity,
      phaseContext: {
        phase: 'post_probe_refresh',
        signal,
        remainingMs: () => Math.max(0, workDeadlineAt - Date.now()),
        throwIfExpired: () => {
          if (signal.aborted) throwOpenCodeAbortReason(signal)
          if (Date.now() >= workDeadlineAt) {
            throw new Error('OpenCode strict launch authority refresh deadline expired')
          }
        },
      },
    })) !== null
  }
  const ports: StrictLaunchPorts<typeof workContext, typeof workContext, LaunchMemberDraft> = {
    snapshotProjection: projection => structuredClone(projection),
    acquireHost: async (_context, _identity, lease, signal) => {
      // The coordinator has set leaseUsed before invoking this port, so its
      // finally block exclusively owns release from this point forward.
      attemptOwnsRetainedProbe = false
      if (signal.aborted) throwOpenCodeAbortReason(signal)
      if (lease.expectedHostId !== host.hostKey) {
        return { kind: 'failure', error: 'retained host identity mismatch' }
      }
      return { kind: 'ok', value: { hostId: host.hostKey } }
    },
    requestProof: async (_context, strictHost, request, signal) => {
      if (strictHost.hostId !== host.hostKey || signal.aborted) {
        if (signal.aborted) throwOpenCodeAbortReason(signal)
        return { kind: 'failure', error: 'retained host identity mismatch' }
      }
      if (!await matchesCurrentExpectedBehavior(signal)) {
        return { kind: 'failure', error: 'OpenCode strict launch behavior changed before proof' }
      }
      const remainingMs = () => Math.max(0, deadlineAt - Date.now() - cleanupReserveMs)
      const phaseContext = (phase: OpenCodePhaseContext['phase']): OpenCodePhaseContext => ({
        phase,
        signal,
        remainingMs,
        throwIfExpired: () => {
          if (signal.aborted) throwOpenCodeAbortReason(signal)
          if (remainingMs() <= 0) throw new Error('OpenCode strict launch proof deadline expired')
        },
      })
      const launchConfig = getRetainedAppMcpLaunchConfig(host)
      const appMcpProof = await listAppMcpToolsFromResolvedLaunchConfig(
        launchConfig,
        phaseContext('mcp_preflight'),
        host.profile.env,
      ).then(tools => matchAppMcpTools(tools, 'direct-contract:mcp/tools/list'))
      appMcpProof.contractConfigIdentity = hashStable(launchConfig.config)
      requiredMcpContractConfigIdentity = appMcpProof.contractConfigIdentity
      if (!isAppMcpConnected(snapshot)
        || !appMcpProof.ok || !await matchesCurrentExpectedBehavior(signal)) {
        return { kind: 'failure', error: 'Agent Teams MCP retained connection/contract proof is unavailable' }
      }
      const expectedOutput = `STRICT_LAUNCH_${request.nonce}`
      const executionOutcome = await openCodeExecutionProbe.probeModelOnHost({
        host,
        selectedModel: apiSelectedModel,
        prompt: `Output only this exact token: ${expectedOutput}`,
        expectedOutput,
        requireExactOutput: true,
        cleanupSuccessfulSession: true,
        runtimeDeadline: {
          signal,
          remainingMs,
          throwIfExpired: phase => phaseContext(phase).throwIfExpired(),
          runPhase: (phase, operation) => operation(phaseContext(phase)),
        },
      })
      if (executionOutcome.outcome !== 'available') {
        return {
          kind: executionOutcome.outcome === 'unknown' ? 'unknown' : 'failure',
          error: executionOutcome.reason ?? 'OpenCode exact-model execution proof failed',
        }
      }
      if (
        executionOutcome.providerId !== 'opencode'
        || executionOutcome.modelId !== apiSelectedModel
        || executionOutcome.observedProviderId !== selectedModelRef.providerId
        || executionOutcome.observedModelId !== selectedModelRef.modelId
        || executionOutcome.latestAssistantText?.trim() !== expectedOutput
      ) {
        return { kind: 'failure', error: 'OpenCode exact-model execution proof was mismatched' }
      }
      // The exact-model probe can take long enough for config or credentials to
      // rotate. Seal the proof only after a final fresh read on this retained host.
      if (!await matchesCurrentExpectedBehavior(signal)) {
        return { kind: 'failure', error: 'OpenCode strict launch behavior changed during proof' }
      }
      return {
        kind: 'ok',
        value: {
          attemptId: request.attemptId,
          generation: request.generation,
          nonce: request.nonce,
          hostId: host.hostKey,
          providerId: request.providerId,
          modelId: apiSelectedModel,
          behaviorFingerprint: expectedBehaviorFingerprint,
          mcpTools: [...request.mcpTools],
        },
      }
    },
    findCommitted: async (_context, member, signal) => {
      if (signal.aborted) throwOpenCodeAbortReason(signal)
      if (!await matchesCurrentExpectedBehavior(signal)) {
        return { kind: 'failure', error: 'OpenCode strict launch behavior changed before reuse' }
      }
      const input = memberInputs.get(member.memberId)!
      const materializationIdentity = { teamId, laneId, memberName: input.name }
      let observation = await openCodeSessionStore.observeMaterialization(
        materializationIdentity, signal,
      )
      if (!observation) return { kind: 'ok', value: null }
      const record = observation.record
      if (
        !isOpenCodeStrictSessionCompatible(
          record,
          strictSessionCompatibility(record.opencodeSessionId, input),
        )
      ) return { kind: 'ok', value: null }
      if (observation.ownerToken) {
        await openCodeSessionStore.releaseInactiveMaterializationOwner(
          record, observation.ownerToken, signal,
        )
        // Whether the CAS succeeded or lost, re-observe authoritative state.
        observation = await openCodeSessionStore.observeMaterialization(
          materializationIdentity, signal,
        )
        if (observation?.ownerToken) {
          return {
            kind: 'failure',
            error: 'OpenCode compatible committed session is owned by an active launch attempt',
          }
        }
        if (!observation || !isOpenCodeStrictSessionCompatible(
          observation.record,
          strictSessionCompatibility(observation.record.opencodeSessionId, input),
        )) return { kind: 'ok', value: null }
      }
      const committedRecord = observation.record
      return {
        kind: 'ok',
        value: {
          memberId: input.name,
          memberFingerprint: input.fingerprint,
          behaviorFingerprint: expectedBehaviorFingerprint,
          projection: strictLaunchProjection(committedRecord, input, teamId, runId, laneId, host.pid),
        },
      }
    },
    projectCommitted: async () => ({ kind: 'ok', value: undefined }),
    materialize: trackAttemptMaterialization(async (_context, strictHost, member, identity, signal) => {
      const input = memberInputs.get(member.memberId)!
      if (strictHost.hostId !== host.hostKey) {
        return { kind: 'failure', error: 'materialization host identity mismatch' }
      }
      if (!await matchesCurrentExpectedBehavior(signal)) {
        return {
          kind: 'failure',
          error: 'OpenCode strict launch behavior changed before materialization',
        }
      }
      let record: OpenCodeSessionRecord | null = null
      try {
        const materialized = await openCodeSessionBridge.materializeSessionOnHost({
          teamId,
          laneId,
          memberName: input.name,
          selectedModel: apiSelectedModel,
          selectedVariant: input.selectedVariant,
          title: `${teamId} - ${input.name}`,
          runId,
          attemptId: identity.attemptId,
          host,
          signal,
          remainingMs: () => Math.max(0, deadlineAt - Date.now() - cleanupReserveMs),
          toolApprovalMode,
          expectedBehaviorFingerprint,
          expectedBootstrapForSession: sessionId =>
            strictSessionCompatibility(sessionId, input).bootstrap,
        })
        record = materialized.record
        if (!materialized.created && !materialized.resumeBootstrap) {
          return {
            kind: 'unknown',
            error: 'OpenCode compatible committed session appeared during materialization',
          }
        }
        if (!materialized.ownerToken) {
          throw new Error('OpenCode materialization owner token is missing')
        }
        resources.set(record.opencodeSessionId, { record, ownerToken: materialized.ownerToken })
        const ownedUncommittedResources = {
          resources: [{
            ...identity,
            resourceId: record.opencodeSessionId,
            committed: false as const,
          }],
        }
        const sessionMcp = await openCodeSessionBridge.ensureSessionAppMcpReady(record, {
          attachIfMissing: false,
          host,
          signal,
          remainingMs: () => Math.max(0, deadlineAt - Date.now() - cleanupReserveMs),
        })
        if (!sessionMcp.ok) {
          return {
            kind: 'failure',
            error: 'OpenCode app MCP is unavailable on the retained member host',
            ...ownedUncommittedResources,
          }
        }
        if (!await matchesCurrentExpectedBehavior(signal)) {
          return {
            kind: 'failure',
            error: 'OpenCode strict launch behavior changed before bootstrap',
            ...ownedUncommittedResources,
          }
        }
        const contextText = buildOpenCodeAppManagedBootstrapContextText({
          teamName: teamId,
          memberName: input.name,
          runId,
          laneId,
          runtimeSessionId: record.opencodeSessionId,
          prompt: input.prompt,
        })
        const contextHash = hashText(contextText)
        const messageID = buildOpenCodeAppManagedBootstrapMessageID({
          teamName: teamId,
          memberName: input.name,
          runId,
          laneId,
          runtimeSessionId: record.opencodeSessionId,
          contextHash,
        })
        const injected = await openCodeSessionBridge.injectAppManagedBootstrapContext(record, {
          messageID,
          text: contextText,
          agent: OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT,
          contextHash,
          briefingHash: input.fingerprint,
          host,
          signal,
          remainingMs: () => Math.max(0, deadlineAt - Date.now() - cleanupReserveMs),
        })
        const candidateAt = nowIso()
        record = {
          ...record,
          staleReason: null,
          bootstrapMode: 'app_managed_context',
          bootstrapEvidenceSource: 'app_managed_bootstrap',
          appManagedBootstrap: {
            schemaVersion: 1,
            messageID: injected.messageID,
            contextHash: injected.contextHash,
            briefingHash: injected.briefingHash,
            injectionVerifiedAt: injected.injectionVerifiedAt,
            model: apiSelectedModel,
            agent: OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT,
          },
          updatedAt: candidateAt,
        }
        if (!await matchesCurrentExpectedBehavior(signal)) {
          return {
            kind: 'failure',
            error: 'OpenCode strict launch behavior changed during bootstrap',
            ...ownedUncommittedResources,
          }
        }
        await openCodeSessionStore.upsert(record, materialized.ownerToken)
        const resource: StrictResource = {
          ...identity,
          resourceId: record.opencodeSessionId,
          committed: true,
        }
        return {
          kind: 'ok',
          value: {
            ...identity,
            memberId: input.name,
            memberFingerprint: input.fingerprint,
            behaviorFingerprint: expectedBehaviorFingerprint,
            projection: strictLaunchProjection(record, input, teamId, runId, laneId, host.pid),
            resource,
          },
        }
      } catch (error) {
        const owned = record ? resources.get(record.opencodeSessionId) : undefined
        if (signal.aborted) {
          if (owned) await cleanupFailedLaunchSession(owned.record, owned.ownerToken)
          throwOpenCodeAbortReason(signal)
        }
        return {
          kind: 'unknown',
          error: strictPublicError(error),
          ...(owned ? { resources: [{ ...identity, resourceId: owned.record.opencodeSessionId,
            committed: false as const }] } : {}),
        }
      }
    }),
    cleanup: (_context, cleanupResources) =>
      trackAttemptReconciliation((async () => {
        for (const resource of cleanupResources) {
          const owned = resources.get(resource.resourceId)
          if (owned && !resource.committed) {
            await cleanupFailedLaunchSession(owned.record, owned.ownerToken)
          }
        }
      })()),
    releaseHost: async (_context, lease, keepAlive) => {
      if (lease.leaseId === preconditions.commandLeaseId) {
        await retainedProbe.release(keepAlive)
      }
    },
  }

  const result = await coordinateStrictLaunch({
    attemptId: envelope.requestId,
    generation: 1,
    nonce: randomUUID(),
    providerId: selectedModelRef.providerId,
    modelId: apiSelectedModel,
    behaviorFingerprint: expectedBehaviorFingerprint,
    mcpTools: [...REQUIRED_AGENT_TEAMS_DIRECT_MCP_TOOL_IDS],
    members: strictMembers,
    workContext,
    cleanupContext: workContext,
    hostLease: { leaseId: preconditions.commandLeaseId, expectedHostId: host.hostKey },
    deadlineAt,
    cleanupReserveMs,
    signal: launchSignal,
    scheduler: {
      now: () => Date.now(),
      waitUntil: (at, signal) => new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
        const timer = setTimeout(finish, Math.max(0, at - Date.now()))
        const abort = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          reject(signal.reason ?? new Error('OpenCode strict launch wait cancelled'))
        }
        signal.addEventListener('abort', abort, { once: true })
      }),
    },
  }, ports).finally(() => releaseAttemptOwnedProbe().catch(() => undefined))
  const releaseMaterializationOwners = openCodeSessionStore
    .trackPendingMaterializationReconciliation(
      drainAttemptReconciliations().then(() => Promise.all(
        [...resources.values()].map(({ record, ownerToken }) =>
          openCodeSessionStore.releaseMaterializationOwner(record, ownerToken)
            .catch(() => false)),
      )),
    )
  await withTimeout(
    releaseMaterializationOwners,
    Math.max(0, deadlineAt - Date.now()),
  ).catch(() => undefined)
  diagnostics.push(teamDiagnostic(
    `opencode_strict_launch_${result.status.replaceAll('-', '_')}`,
    result.status === 'committed'
      ? 'OpenCode strict launch proof and materialization completed.'
      : strictPublicError(result.reason ?? `OpenCode strict launch ${result.status}`),
    result.status === 'committed' ? 'info' : 'error',
  ))
  for (const memberId of result.committedMemberIds) {
    diagnostics.push(teamDiagnostic(
      'opencode_app_managed_bootstrap_context_verified',
      `${memberId}: OpenCode app-managed bootstrap context was injected and verified.`,
      'info',
    ))
    diagnostics.push(teamDiagnostic(
      'opencode_launch_member_timing',
      `member=${memberId} materialized_under_absolute_deadline=true`,
      'info',
    ))
  }
  diagnostics.push(teamDiagnostic(
    'opencode_launch_total_timing',
    `total=${formatMs(elapsedMs(probeStartedAt))} provisioningProbe=${formatMs(provisioningProbeMs)} members=${result.committedMemberIds.length}`,
    'info',
  ))
  if (result.status !== 'committed' && result.committedMemberIds.length === 0) {
    throw new Error(strictPublicError(result.reason ?? `OpenCode strict launch ${result.status}`))
  }
  const members = Object.fromEntries(result.projections.map(projection => [
    projection.appManagedBootstrapCandidate?.memberName ?? projection.sessionId,
    projection,
  ]))
  return {
    snapshot,
    data: buildTeamLaunchData({
      runId,
      selectedModel: apiSelectedModel,
      members,
      expectedMemberNames: strictMembers.map(member => member.memberId),
      diagnostics,
      commandEvidence,
      expectedBehaviorFingerprint,
      warnings: [],
    }),
  }
}

async function runLaunchWithProvisioningSnapshot(
  envelope: BridgeEnvelope,
  snapshot: OpenCodeProvisioningSnapshot,
  runtimeDeadline: OpenCodeRuntimeDeadline,
  timings: { provisioningProbeMs?: number } = {},
) {
  const launchStartedAt = Date.now()
  const body = envelope.body
  const runId = asString(body.runId)
  const laneId = asString(body.laneId)
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  const selectedModel = asString(body.selectedModel)
  const selectedVariant = asString(body.effort)
  const membersRaw = Array.isArray(body.members) ? body.members : []
  if (!runId || !laneId || !teamId || !selectedModel || membersRaw.length === 0) {
    throw new Error('opencode.launchTeam requires runId, laneId, teamId/teamName, selectedModel and members')
  }
  assertUniqueOpenCodeMemberNames(membersRaw, 'opencode.launchTeam members')
  const toolApprovalMode = resolveLaunchToolApprovalMode(body)
  const diagnostics: TeamDiagnostic[] = []

  const commandEvidence = validateOpenCodeBridgeStateChangingPreconditions({
    body,
    runtime: createRuntimePreconditionSnapshot(snapshot),
    allowCapabilitySnapshotRecovery: true,
  })
  if (commandEvidence.capabilitySnapshotRecovery) {
    const recovery = commandEvidence.capabilitySnapshotRecovery
    diagnostics.push(teamDiagnostic(
      'opencode_capability_snapshot_recovery',
      `Accepted fresh OpenCode capability snapshot after app recovery attempt ${recovery.recoveryAttemptId}: expected ${recovery.expectedCapabilitySnapshotId}, actual ${recovery.actualCapabilitySnapshotId ?? 'null'}.`,
      'warning',
    ))
  }
  assertOpenCodeLaunchRuntimeAvailable(snapshot)
  const apiSelectedModel = resolveOpenCodeProviderScopedModel(selectedModel, snapshot)
  await assertOpenCodeSelectedModelLaunchAccess(
    apiSelectedModel,
    snapshot,
    parseOpenCodeExecutionProof(body.executionProof),
    runtimeDeadline,
  )
  await assertOpenCodeLaunchMcpReady(snapshot, runtimeDeadline)
  runtimeDeadline.throwIfExpired('post_probe_refresh')
  // From this point the command starts creating durable sessions. Keep the
  // pre-launch deadline from turning a completed state change into a timeout.
  runtimeDeadline.dispose()
  const members: Record<string, LaunchMemberDraft> = {}
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
    const memberVariant = asString(member?.effort) ?? selectedVariant ?? undefined
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
        selectedVariant: memberVariant,
        title: `${teamId} - ${name}`,
        projectPath: snapshot.projectPath,
        preparedProfile: snapshot.profile,
        runId,
        fresh: true,
        toolApprovalMode,
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
          record,
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
          selectedVariant: memberVariant,
          title: `${teamId} - ${name}`,
          projectPath: snapshot.projectPath,
          preparedProfile: snapshot.profile,
          runId,
          fresh: true,
          toolApprovalMode,
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
      try {
        record = await openCodeSessionBridge.refreshSessionEnvironment(record)
      } catch (error) {
        diagnostics.push(teamDiagnostic(
          'opencode_launch_session_environment_refresh_failed',
          `${name}: ${error instanceof Error ? error.message : String(error)}`,
          'warning',
        ))
      }
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
  const retained = expectedCapabilitySnapshotId(body) || asRecord(body.preconditions)
    ? await probeStoredLaneAuthority(envelope, 'opencode.reconcileTeam')
    : null
  try {
  const snapshot = retained?.snapshot ?? await openCodeProvisioningProbe.probe(envelope.cwd)
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
        if (retained) {
          const parsed = parseOpenCodeProviderScopedModelRef(expectedModel)
          if (!parsed) throw new Error('OpenCode selected lane reconcile requires a provider-qualified model')
          expectedSelectedModel = parsed.raw
        } else {
          expectedSelectedModel = resolveOpenCodeProviderScopedModel(expectedModel, snapshot)
          assertOpenCodeSelectedModelReconcilable(expectedSelectedModel, snapshot)
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
        ...(reconciled.summary.pendingPermissions?.length
          ? { pendingPermissions: reconciled.summary.pendingPermissions }
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
  } finally {
    await retained?.release()
  }
}

const OPEN_CODE_STOP_CONCURRENCY = 4
const OPEN_CODE_STOP_STATUS_ATTEMPTS = 3
const OPEN_CODE_STOP_STATUS_DELAYS_MS = [100, 250] as const
const OPEN_CODE_STOP_ATOMIC_CLEANUP_RESERVE_MS = 1_000
const OPEN_CODE_STOP_HOST_CLEANUP_RESERVE_MS = 5_000

function isExactStopSession(
  current: OpenCodeSessionRecord | null,
  expected: OpenCodeSessionRecord,
): current is OpenCodeSessionRecord {
  return current !== null
    && current.runId === expected.runId
    && current.opencodeSessionId === expected.opencodeSessionId
    && current.hostKey === expected.hostKey
}

function isExactActiveStopSession(
  current: OpenCodeSessionRecord | null,
  expected: OpenCodeSessionRecord,
): current is OpenCodeSessionRecord {
  return isExactStopSession(current, expected) && !isOpenCodeSessionStopped(current)
}

async function runStop(
  envelope: BridgeEnvelope,
  runtimeDeadline: OpenCodeRuntimeDeadline,
  externalSignal?: AbortSignal,
) {
  const body = envelope.body
  const runId = asString(body.runId)
  const laneId = asString(body.laneId)
  const teamId = asString(body.teamId) ?? asString(body.teamName)
  if (!runId || !laneId || !teamId) {
    throw new Error('opencode.stopTeam requires runId, laneId and teamId/teamName')
  }
  const stopSignal = externalSignal
    ? AbortSignal.any([runtimeDeadline.signal, externalSignal])
    : runtimeDeadline.signal
  const stopPreflightContext: OpenCodePhaseContext = {
    phase: 'stop_abort',
    signal: stopSignal,
    remainingMs: () => runtimeDeadline.remainingMs(),
    throwIfExpired: () => runtimeDeadline.throwIfExpired('stop_abort'),
  }
  const retained = expectedCapabilitySnapshotId(body) || asRecord(body.preconditions)
    || body.allowEmptyLaneStop === true
    ? await probeStoredLaneAuthority(envelope, 'opencode.stopTeam', stopPreflightContext)
    : null
  let authorityReleased = false
  const releaseAuthority = async () => {
    if (authorityReleased) return
    authorityReleased = true
    await retained?.release(true)
  }
  try {
  const laneRecords = retained?.records ?? (await openCodeSessionStore.list()).filter(
    record => record.teamId === teamId && record.laneId === laneId,
  )
  const conflictingActiveRecords = laneRecords.filter(
    record => record.runId !== runId && !isOpenCodeSessionStopped(record),
  )
  if (conflictingActiveRecords.length > 0) {
    const diagnostics = [teamDiagnostic(
      'opencode_stop_identity_changed',
      `OpenCode lane ${teamId}/${laneId} belongs to another active run`,
      'error',
    )]
    return {
      snapshot: retained?.snapshot ?? null,
      confirmedStopRuntime: retained?.confirmedStopRuntime,
      data: {
        runId,
        stopped: false,
        members: {},
        warnings: [],
        diagnostics,
        manifestHighWatermark: RUNTIME_STORE_MANIFEST_HIGH_WATERMARK,
        runtimeStoreManifestHighWatermark: RUNTIME_STORE_MANIFEST_HIGH_WATERMARK,
      },
    }
  }
  const records = laneRecords.filter(record => record.runId === runId)
  const snapshot = retained ? retained.snapshot
    : records.length ? await openCodeProvisioningProbe.probe(envelope.cwd, {
      phaseContext: stopPreflightContext,
    }) : null
  const commandEvidence = validateOpenCodeBridgeStateChangingPreconditions({
    body,
    runtime: createRuntimePreconditionSnapshot(snapshot, { confirmedStopRuntime: retained?.confirmedStopRuntime }),
  })
  const diagnostics: TeamDiagnostic[] = []
  const requestOptions = {
    signal: stopSignal,
    remainingMs: () => runtimeDeadline.remainingMs(),
  }
  const memberResults = await mapWithConcurrency(
    records,
    OPEN_CODE_STOP_CONCURRENCY,
    async record => {
    let stopped = false
    const memberDiagnostics: string[] = []
    try {
      if (isOpenCodeSessionStopped(record)) {
        stopped = true
      } else {
        runtimeDeadline.throwIfExpired('stop_abort')
        const beforeAbort = await raceOpenCodeAbortSignal(
          openCodeSessionStore.get(teamId, laneId, record.memberName),
          stopSignal,
        )
        if (!isExactStopSession(beforeAbort, record)) {
          diagnostics.push(teamDiagnostic(
            'opencode_stop_identity_changed',
            `${record.memberName}: session identity changed before abort`,
            'error',
          ))
          memberDiagnostics.push('identity changed before abort')
          return { record, stopped: false, diagnostics: memberDiagnostics }
        }
        const stopObserver = await runtimeDeadline.runPhase(
          'stop_verify',
          () => openCodeSessionBridge.observeStopIdle(record, requestOptions),
        )
        try {
          runtimeDeadline.throwIfExpired('stop_abort')
          const finalBeforeAbort = await raceOpenCodeAbortSignal(
            openCodeSessionStore.get(teamId, laneId, record.memberName),
            stopSignal,
          )
          if (!isExactStopSession(finalBeforeAbort, record)) {
            diagnostics.push(teamDiagnostic(
              'opencode_stop_identity_changed',
              `${record.memberName}: session identity changed before abort`,
              'error',
            ))
            memberDiagnostics.push('identity changed before abort')
            return { record, stopped: false, diagnostics: memberDiagnostics }
          }
          stopObserver.arm()
          const abortAccepted = await runtimeDeadline.runPhase(
            'stop_abort',
            () => openCodeSessionBridge.abort(record, requestOptions),
          )
        let observedStatus: 'idle' | 'busy' | 'retry' | 'missing' | 'unrecognized' = 'missing'
        for (let attempt = 0; attempt < OPEN_CODE_STOP_STATUS_ATTEMPTS; attempt += 1) {
          runtimeDeadline.throwIfExpired('stop_verify')
          if (await stopObserver.waitForIdle(0)) {
            observedStatus = 'idle'
            break
          }
          const rawStatus = await runtimeDeadline.runPhase(
            'stop_verify',
            () => openCodeSessionBridge.getRawStatus(record, requestOptions),
          )
          const normalized = normalizeOpenCodeSessionStatus(rawStatus)
          observedStatus = rawStatus === null
            ? 'missing'
            : normalized.status ?? 'unrecognized'
          if (observedStatus === 'idle') break
          const delayMs = Math.min(
            OPEN_CODE_STOP_STATUS_DELAYS_MS[attempt] ?? 500,
            runtimeDeadline.remainingMs(),
          )
          if (delayMs <= 0) runtimeDeadline.throwIfExpired('stop_verify')
          if (await stopObserver.waitForIdle(delayMs)) {
            observedStatus = 'idle'
            break
          }
        }
        if (observedStatus !== 'idle') {
          if (!abortAccepted) {
            memberDiagnostics.push('abort rejected')
            diagnostics.push(teamDiagnostic(
              'opencode_stop_abort_rejected',
              `${record.memberName}: OpenCode abort was rejected`,
              'warning',
            ))
          }
          const statusReason = observedStatus === 'busy'
            ? 'still busy'
            : observedStatus === 'retry'
              ? 'retrying'
              : observedStatus === 'missing'
                ? 'status missing'
                : 'status unrecognized'
          memberDiagnostics.push(statusReason)
          diagnostics.push(teamDiagnostic(
            'opencode_stop_status_unconfirmed',
            `${record.memberName}: ${statusReason}`,
            'warning',
          ))
          return { record, stopped: false, diagnostics: memberDiagnostics }
        }
        if (!abortAccepted) memberDiagnostics.push('already idle')
        runtimeDeadline.throwIfExpired('stop_cleanup')
        const beforeConfirmation = await raceOpenCodeAbortSignal(
          openCodeSessionStore.get(teamId, laneId, record.memberName),
          stopSignal,
        )
        if (!isExactStopSession(beforeConfirmation, record)) {
          diagnostics.push(teamDiagnostic(
            'opencode_stop_identity_changed',
            `${record.memberName}: session identity changed before confirmation`,
            'error',
          ))
          memberDiagnostics.push('identity changed before confirmation')
          return { record, stopped: false, diagnostics: memberDiagnostics }
        }
        if (stopObserver.currentStatus() === 'busy' || stopObserver.currentStatus() === 'retry') {
          const reason = stopObserver.currentStatus() === 'busy' ? 'still busy' : 'retrying'
          memberDiagnostics.push(reason)
          diagnostics.push(teamDiagnostic(
            'opencode_stop_status_unconfirmed',
            `${record.memberName}: ${reason} after idle observation`,
            'warning',
          ))
          return { record, stopped: false, diagnostics: memberDiagnostics }
        }
        if (runtimeDeadline.remainingMs() < OPEN_CODE_STOP_ATOMIC_CLEANUP_RESERVE_MS) {
          memberDiagnostics.push('deadline expired')
          diagnostics.push(teamDiagnostic(
            'opencode_stop_deadline',
            `${record.memberName}: insufficient budget for strict lease release; remaining=${runtimeDeadline.remainingMs()}ms`,
            'error',
          ))
          return { record, stopped: false, diagnostics: memberDiagnostics }
        }
        // Once the atomic lease mutation starts, await it to completion. Racing an
        // uncancellable registry write could remove a lease after a timeout response.
        await openCodeSessionBridge.releaseSession(record, { strictLeaseRelease: true })
        const runtime = createRuntimeSnapshot(snapshot)
        let terminal: OpenCodeSessionRecord | null
        try {
          terminal = await openCodeSessionStore.markStoppedIfSession(record,
            runtime.capabilitySnapshotId && record.expectedBehaviorFingerprint
              ? { runtime: { ...runtime, capabilitySnapshotId: runtime.capabilitySnapshotId },
                expectedBehaviorFingerprint: record.expectedBehaviorFingerprint }
              : undefined)
        } catch (casError) {
          try {
            const afterCasFailure = await openCodeSessionStore.get(
              teamId,
              laneId,
              record.memberName,
            )
            if (isExactActiveStopSession(afterCasFailure, record)) {
              await openCodeSessionBridge.restoreSessionLease(record)
              diagnostics.push(teamDiagnostic(
                'opencode_stop_lease_restored',
                `${record.memberName}: restored the exact session lease after terminal CAS failed`,
                'warning',
              ))
            }
          } catch (compensationError) {
            const casMessage = casError instanceof Error ? casError.message : String(casError)
            const compensationMessage = compensationError instanceof Error
              ? compensationError.message
              : String(compensationError)
            diagnostics.push(teamDiagnostic(
              'opencode_stop_compensation_failed',
              `${record.memberName}: terminal CAS failed (${casMessage}) and exact lease restoration failed (${compensationMessage})`,
              'error',
            ))
            throw new Error(
              `OpenCode terminal CAS failed: ${casMessage}; lease restoration failed: ${compensationMessage}`,
              { cause: casError },
            )
          }
          throw casError
        }
        if (!terminal) {
          diagnostics.push(teamDiagnostic(
            'opencode_stop_identity_changed',
            `${record.memberName}: session identity changed before confirmation`,
            'error',
          ))
          memberDiagnostics.push('identity changed before confirmation')
          return { record, stopped: false, diagnostics: memberDiagnostics }
        }
        stopped = true
        if (runtimeDeadline.remainingMs() <= 0) {
          stopped = false
          memberDiagnostics.push('deadline expired')
          diagnostics.push(teamDiagnostic(
            'opencode_stop_deadline',
            `${record.memberName}: deadline expired while completing the atomic lease/CAS transition`,
            'error',
          ))
        }
        } finally {
          await stopObserver.dispose()
        }
      }
    } catch (error) {
      stopped = false
      if (isOpenCodeRuntimeDeadlineError(error)) {
        memberDiagnostics.push('deadline expired')
        diagnostics.push(teamDiagnostic(
          'opencode_stop_deadline',
          `${record.memberName}: ${error.message}; remaining=${error.remainingMs}ms`,
          'error',
        ))
      } else {
        memberDiagnostics.push(error instanceof Error ? error.message : String(error))
      }
    }
    return { record, stopped, diagnostics: memberDiagnostics }
  })
  if (externalSignal?.aborted) {
    throwOpenCodeAbortReason(externalSignal)
  }
  const members: Record<string, { sessionId?: string; stopped: boolean; diagnostics: string[] }> = {}
  for (const result of memberResults) {
    members[result.record.memberName] = {
      sessionId: result.record.opencodeSessionId,
      stopped: result.stopped,
      diagnostics: result.diagnostics,
    }
  }

  // The stop preflight must not keep this host alive during stale-host cleanup.
  // Keep the process alive on release so cleanup can honor other lanes' leases.
  await releaseAuthority()

  const cleanupAllowed = runtimeDeadline.remainingMs() >= OPEN_CODE_STOP_HOST_CLEANUP_RESERVE_MS
    && !stopSignal.aborted
  if (!cleanupAllowed) {
    diagnostics.push(teamDiagnostic(
      'opencode_stop_deadline',
      `OpenCode host cleanup skipped because only ${runtimeDeadline.remainingMs()}ms remained`,
      'warning',
    ))
  }

  const cleanupProjectPaths = new Set(
    records
      .map(record => record.projectPath.trim())
      .filter(projectPath => projectPath.length > 0),
  )
  for (const projectPath of cleanupAllowed ? cleanupProjectPaths : []) {
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
    confirmedStopRuntime: retained?.confirmedStopRuntime,
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
  } finally {
    await releaseAuthority()
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

  const commandEvidence = validateOpenCodeBridgeStateChangingPreconditions({
    body,
    runtime: createRuntimePreconditionSnapshot(null),
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
  let snapshot = buildSendMessageStoredSessionSnapshot(projectPath, deliveryRecord)
  let mcpRuntimePid: number | undefined
  const mcpDiagnostics: TeamDiagnostic[] = []
  const compatibilityStaleReason = getOpenCodeSessionCompatibilityStaleReason(record)
  const staleReason = record.staleReason ?? compatibilityStaleReason
  if (staleReason) {
    if (!record.staleReason) {
      await openCodeSessionStore.markStale(teamId, laneId, memberName, staleReason, record).catch(error => {
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
      selectedVariant: record.selectedVariant,
      projectPath: record.projectPath,
      runId,
      toolApprovalMode: record.toolApprovalMode,
    })
    snapshot = buildSendMessageStoredSessionSnapshot(projectPath, deliveryRecord)
    mcpDiagnostics.push(
      teamDiagnostic(
        'opencode_send_session_recreated_after_stale_record',
        `Recreated OpenCode session before message delivery because the stored session was stale (${staleReason}).`,
        'warning',
      ),
    )
  } else if (forceSessionRefreshReason) {
    await openCodeSessionStore.markStale(teamId, laneId, memberName, forceSessionRefreshReason, record)
    deliveryRecord = await openCodeSessionBridge.ensureSession({
      teamId,
      laneId,
      memberName,
      selectedModel: record.selectedModel,
      selectedVariant: record.selectedVariant,
      projectPath: record.projectPath,
      runId,
      toolApprovalMode: record.toolApprovalMode,
    })
    snapshot = buildSendMessageStoredSessionSnapshot(projectPath, deliveryRecord)
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
  snapshot = buildSendMessageStoredSessionSnapshot(projectPath, deliveryRecord)
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
    await openCodeSessionStore.markStale(teamId, laneId, memberName, 'app_mcp_unavailable', deliveryRecord)
    deliveryRecord = await openCodeSessionBridge.ensureSession({
      teamId,
      laneId,
      memberName,
      selectedModel: record.selectedModel,
      selectedVariant: record.selectedVariant,
      projectPath: record.projectPath,
      runId: asString(body.runId),
      toolApprovalMode: record.toolApprovalMode,
    })
    snapshot = buildSendMessageStoredSessionSnapshot(projectPath, deliveryRecord)
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
      const runtimePid = mcpRuntimePid ?? deliveryRecord.runtimePid ?? undefined
      const finalData: SendMessageCommandData = {
        accepted: true,
        ...(runId ? { runId } : {}),
        sessionId: deliveryRecord.opencodeSessionId,
        memberName,
        ...(runtimePid ? { runtimePid } : {}),
        prePromptCursor,
        diagnostics: [
          ...mcpDiagnostics,
          teamDiagnostic(
            'opencode_send_no_reply_accepted',
            'OpenCode prompt_async accepted with noReply; no assistant turn will be observed.',
            'info',
          ),
        ],
        ...(commandEvidence.idempotencyKey ? { idempotencyKey: commandEvidence.idempotencyKey } : {}),
        manifestHighWatermark: commandEvidence.manifestHighWatermark,
        runtimeStoreManifestHighWatermark: commandEvidence.runtimeStoreManifestHighWatermark,
      }
      await markSendMessageOutcome(outcomeBase, {
        status: 'reconciled',
        sessionId: deliveryRecord.opencodeSessionId,
        runtimePid: mcpRuntimePid ?? deliveryRecord.runtimePid ?? null,
        prePromptCursor,
        acceptedAt: nowIso(),
        completedAt: nowIso(),
        sendMessageData: finalData,
        diagnostics: finalData.diagnostics.map(teamDiagnosticToOutcomeString),
      }).catch(() => undefined)
      return {
        snapshot,
        data: finalData,
      }
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
          'OpenCode prompt_async was accepted without waiting for the assistant turn; response observation remains delegated to durable app-side ledger reconciliation.',
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
    await openCodeTurnSettledEmissionCoordinator.emitDelivery({
      record: deliveryRecord,
      runtimePromptMessageId,
      turnSettled,
      reconcileSummary: null,
    })
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

  const record = await openCodeSessionStore.get(teamId, laneId, memberName)
  if (!record) {
    throw new Error(`No stored OpenCode session record for ${teamId}/${laneId}/${memberName}`)
  }
  const snapshot = await openCodeProvisioningProbe.probe(
    asString(body.projectPath) ?? record.projectPath,
    { toolApprovalMode: record.toolApprovalMode },
  )
  validateOpenCodeBridgeStateChangingPreconditions({
    body,
    runtime: createRuntimePreconditionSnapshot(snapshot),
  })

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
        ...(reconciled.summary.pendingPermissions?.length
          ? { pendingPermissions: reconciled.summary.pendingPermissions }
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
    const memberName = asString(body.memberName)
    const sessionId = asString(body.sessionId)
    let records = await openCodeSessionStore.list()
    if (teamId) {
      records = records.filter(record => record.teamId === teamId)
      if (laneId) {
        records = records.filter(record => record.laneId === laneId)
      }
      if (memberName) {
        records = records.filter(record => record.memberName === memberName)
      }
      if (sessionId) {
        records = records.filter(record => record.opencodeSessionId === sessionId)
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
      const permissionByRequestId = new Map<string, OpenCodePendingPermission>()
      for (const record of records) {
        const reconciled = await openCodeSessionBridge.reconcileSession(record, { limit: 1 })
        for (const permission of reconciled.summary.pendingPermissions ?? []) {
          const requestID = permission.requestId.trim()
          if (requestID) {
            requestIds.add(requestID)
            permissionByRequestId.set(requestID, {
              ...permission.raw,
              sessionID: permission.sessionId ?? record.opencodeSessionId,
            })
          }
        }
        for (const requestID of reconciled.summary.pendingPermissionRequestIds) {
          if (requestID.trim()) {
            const trimmedRequestID = requestID.trim()
            requestIds.add(trimmedRequestID)
            if (!permissionByRequestId.has(trimmedRequestID)) {
              permissionByRequestId.set(trimmedRequestID, {
                requestID: trimmedRequestID,
                sessionID: record.opencodeSessionId,
              })
            }
          }
        }
      }
      permissions = [...requestIds].map(requestID => permissionByRequestId.get(requestID) ?? { requestID })
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
  const snapshot = buildTranscriptStoredSessionSnapshot(envelope.cwd, result.record)
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

async function handleEnvelope(
  envelope: BridgeEnvelope,
  runtimeDeadline?: OpenCodeRuntimeDeadline,
  externalSignal?: AbortSignal,
) {
  switch (envelope.command) {
    case 'opencode.handshake': {
      const lightweightLaunchHandshake = shouldUseLightweightLaunchHandshake(envelope.body)
      let snapshot: OpenCodeProvisioningSnapshot | null = null
      let confirmedStopRuntime: ConfirmedStopRuntime | undefined
      if (!lightweightLaunchHandshake && envelope.body.requiredCommand === 'opencode.launchTeam') {
        const selected = parseOpenCodeProviderScopedModelRef(asString(envelope.body.selectedModel))
        if (!selected) {
          throw new Error('OpenCode launch handshake requires a provider-qualified selectedModel')
        }
        if (selected.providerId === 'kiro' || selected.providerId === 'cursor-acp') {
          throw new Error(`OpenCode launch handshake does not support extension-bound provider ${selected.providerId}`)
        }
        const mode = envelope.body.toolApprovalMode
        if (mode !== undefined && mode !== 'auto' && mode !== 'manual') {
          throw new Error('OpenCode launch handshake toolApprovalMode must be auto or manual')
        }
        // Read the same selected launch scope as readiness. A broad inventory
        // profile has a different config/provider identity and cannot attest it.
        const probeOptions = {
          selectedModel: selected.raw,
          toolApprovalMode: mode === 'manual' ? 'manual' as const : 'auto' as const,
        }
        const retained = runtimeDeadline
          ? await runtimeDeadline.runPhase('host_start', phaseContext =>
              openCodeProvisioningProbe.probeRetainingHost(envelope.cwd, {
                ...probeOptions,
                phaseContext,
              }))
          : await openCodeProvisioningProbe.probeRetainingHost(envelope.cwd, probeOptions)
        try {
          snapshot = retained.snapshot
          assertOpenCodeLaunchRuntimeAvailable(snapshot)
        } finally {
          await retained.release()
        }
      } else if (envelope.body.requiredCommand === 'opencode.reconcileTeam'
        || envelope.body.requiredCommand === 'opencode.stopTeam') {
        const retained = await probeStoredLaneAuthority(envelope, envelope.body.requiredCommand as string)
        try {
          snapshot = retained.snapshot
          confirmedStopRuntime = retained.confirmedStopRuntime
        } finally { await retained.release() }
      } else if (!lightweightLaunchHandshake) {
        snapshot = await openCodeProvisioningProbe.probe(envelope.cwd, {
          disposeHostOnRelease: shouldDisposeBridgeProbeHostOnRelease(),
        })
      }
      const identity = createBridgeServerIdentity(snapshot, {
        confirmedStopRuntime,
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
      return { snapshot, confirmedStopRuntime, data: handshake }
    }
    case 'opencode.readiness':
      if (!runtimeDeadline) {
        throw new Error('OpenCode readiness deadline was not initialized')
      }
      return runReadiness(envelope, runtimeDeadline)
    case 'opencode.cleanupHosts':
      return runCleanupHosts(envelope)
    case 'opencode.launchTeam':
      if (!runtimeDeadline) {
        throw new Error('OpenCode launch preflight deadline was not initialized')
      }
      return runLaunch(envelope, runtimeDeadline, externalSignal)
    case 'opencode.reconcileTeam':
      return runReconcile(envelope)
    case 'opencode.stopTeam':
      if (!runtimeDeadline) {
        throw new Error('OpenCode stop deadline was not initialized')
      }
      return runStop(envelope, runtimeDeadline, externalSignal)
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

export async function executeOpenCodeBridgeCommandEnvelope(
  input: unknown,
  options: { signal?: AbortSignal } = {},
) {
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

  const runtimeDeadline = (
    envelope.command === 'opencode.readiness'
    || envelope.command === 'opencode.launchTeam'
    || envelope.command === 'opencode.stopTeam'
    || (envelope.command === 'opencode.handshake'
      && envelope.body.requiredCommand === 'opencode.launchTeam'
      && !shouldUseLightweightLaunchHandshake(envelope.body))
  )
    ? new OpenCodeRuntimeDeadline(envelope.timeoutMs > 0 ? envelope.timeoutMs : 300_000)
    : undefined
  try {
    const result = await handleEnvelope(envelope, runtimeDeadline, options.signal)
    if (envelope.command === 'opencode.readiness') {
      runtimeDeadline?.throwIfExpired()
    }
    return success(envelope, result.data, startedAtMs, result.snapshot, [],
      'confirmedStopRuntime' in result ? result.confirmedStopRuntime : undefined)
  } catch (error) {
    const deadlineError = isOpenCodeRuntimeDeadlineError(error) ? error : null
    return failure(
      envelope,
      deadlineError ? 'timeout' : 'provider_error',
      error instanceof Error ? error.message : String(error),
      startedAtMs,
      true,
      [diagnostic(error instanceof Error ? error.message : String(error), 'error')],
      deadlineError?.toDetails(),
    )
  } finally {
    runtimeDeadline?.dispose()
  }
}
