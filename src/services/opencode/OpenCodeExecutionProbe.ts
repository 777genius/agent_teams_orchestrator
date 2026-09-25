import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { withTimeout } from '../../utils/sleep.js'
import { OpenCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { readProcessStartTimeMs } from '../../utils/processKill.js'
import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import {
  classifyOpenCodeProviderFailure,
  isOpenCodeUsageLimitFailureMessage,
} from './OpenCodeProviderFailureClassification.js'
import {
  openCodeCursorNativeFailureProbe,
  type OpenCodeCursorNativeProbeResult,
} from './OpenCodeCursorNativeFailureProbe.js'
import {
  hasCompletedOpenCodeAssistantTurn,
  openCodeEventTranslator,
} from './OpenCodeEventTranslator.js'
import {
  createOpenCodePreflightHostLeaseInput,
  openCodeHostManager,
} from './OpenCodeHostManager.js'
import { readOpenCodeAuthCredential, withOpenCodeOAuthRefreshLock, type OpenCodeOAuthNativeProbeOwner } from './OpenCodeAuthStore.js'
import { buildOpenCodeRuntimePromptMessageId } from './OpenCodeMessageIds.js'
import { normalizeOpenCodePermissions } from './OpenCodePermissionNormalizer.js'
import {
  OPEN_CODE_FREE_TIER_RESTRICTED_FAILURE_CODE,
  OPEN_CODE_FREE_TIER_RESTRICTED_REASON,
  isOpenCodeFreeTierRestrictedError,
} from './OpenCodeFreeTierFailure.js'
import {
  ensureOpenCodeNativeCliCredentialBridge,
  OPEN_CODE_MODEL_PROBE_AGENT_NAME,
  openCodeProfileManager,
  resolveOpenCodeProfileScope,
} from './OpenCodeProfileManager.js'
import {
  type OpenCodePhaseContext,
  type OpenCodeRuntimeDeadline,
  isOpenCodeRuntimeDeadlineError,
  throwOpenCodeAbortReason,
} from './OpenCodeRuntimeDeadline.js'

import type {
  OpenCodeClient,
} from './OpenCodeClientFactory.js'
import type {
  OpenCodeExecutionProbeResult,
  OpenCodeHostHandle,
  OpenCodeMessage,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
  OpenCodeSessionReconcileSummary,
  OpenCodeSessionStatusInput,
} from './types.js'

const OPEN_CODE_EXECUTION_PROBE_PROMPT = 'Output only the single word PONG.'
const OPEN_CODE_EXECUTION_PROBE_EXPECTED_OUTPUT = 'PONG'
const OPEN_CODE_EXECUTION_PROBE_TIMEOUT_MS = 120_000
const OPEN_CODE_EXECUTION_PROBE_POLL_INTERVAL_MS = 500
const OPEN_CODE_EXECUTION_PROMPT_START_TIMEOUT_MS = 5_000
const OPEN_CODE_EXECUTION_CLEANUP_TIMEOUT_MS = 5_000
const OPEN_CODE_EXECUTION_CLEANUP_SETTLE_MS = 150
const OPEN_CODE_EXECUTION_PROBE_OUTPUT_TOKEN_LIMIT = 512
const OPEN_CODE_EXECUTION_PROBE_CONTEXT_TOKEN_LIMIT = 32_000
const OPEN_CODE_NATIVE_SUBSCRIPTION_PROBE_CONTEXT_TOKEN_LIMIT = 262_144
// Status and transcript endpoints can settle a poll apart. Three matching idle
// snapshots keep the normal 500ms poll fast while avoiding a one-snapshot race.
const OPEN_CODE_EXECUTION_PROBE_IDLE_MISSING_ASSISTANT_CONFIRMATIONS = 3
const OPEN_CODE_CURSOR_NATIVE_FAILURE_PROBE_DISABLED_ENV =
  'AGENT_TEAMS_OPENCODE_CURSOR_NATIVE_FAILURE_PROBE_DISABLED'
const OPEN_CODE_CURSOR_NATIVE_FAILURE_PROBE_MAX_ATTEMPTS = 2
const OPEN_CODE_CURSOR_NATIVE_RECOVERY_CHECK_TIMEOUT_MS = 250

type OpenCodeExecutionProbeDeps = {
  hostManager?: Pick<typeof openCodeHostManager, 'ensureHost' | 'releaseHost'>
    & Partial<Pick<typeof openCodeHostManager, 'withHostOperation' | 'retainHostLease' | 'releaseHostLease'>>
  clientFactory?: Pick<typeof openCodeClientFactory, 'create'>
  eventTranslator?: Pick<typeof openCodeEventTranslator, 'reconcileSessionMessages'>
  prepareProfile?: (
    projectPath?: string | null,
    options?: OpenCodePrepareProfileOptions,
  ) => Promise<OpenCodePreparedProfile>
  sleep?: (ms: number) => Promise<void>
  probeTimeoutMs?: number
  pollIntervalMs?: number
  promptStartTimeoutMs?: number
  hostStartupCleanupTimeoutMs?: number
  sessionCleanupTimeoutMs?: number
  persistentCache?: boolean
  persistentCacheRoot?: string
  fanOutOAuthCredential?: (input: {
    providerId: string
    sourceAuthPath: string
  }) => Promise<void>
  withOAuthRefreshLock?: typeof withOpenCodeOAuthRefreshLock
  cursorNativeFailureProbe?: Pick<typeof openCodeCursorNativeFailureProbe, 'probe'>
}

type ProbeModelParams = {
  // Private readiness handoff after settled, successful owned native execution.
  onOwnedOAuthProbeSuccess?: (owner: OpenCodeOAuthNativeProbeOwner) => void
  selectedModel: string
  projectPath?: string | null
  scopeEnvironment?: NodeJS.ProcessEnv
  prompt?: string
  expectedOutput?: string
  contextTokens?: number
  outputTokens?: number
  bypassCache?: boolean
  disposeHostOnRelease?: boolean
  runtimeDeadline?: Pick<
    OpenCodeRuntimeDeadline,
    'signal' | 'remainingMs' | 'throwIfExpired' | 'runPhase'
  >
  requireExactOutput?: boolean
  cleanupSuccessfulSession?: boolean
  cursorNativePreflightBeforeHost?: boolean
  cursorNativePreflightOnly?: boolean
}

type CursorNativeProbeContext = {
  projectPath: string
  env: NodeJS.ProcessEnv
  cleanup?: () => Promise<void>
}

function messageMatchesPrompt(message: OpenCodeMessage | null, messageID: string): boolean {
  return Boolean(
    message
    && message.info
    && message.info.id === messageID
    && message.info.role === 'user',
  )
}

function hasCompletedAssistantResponseWithoutText(
  summary: OpenCodeSessionReconcileSummary,
): boolean {
  if (
    summary.durableState !== 'idle'
    || !summary.latestAssistantMessageId
    || summary.replyPendingSinceMessageId
  ) {
    return false
  }

  const latestAssistant = [...summary.messages]
    .reverse()
    .find(message => message.id === summary.latestAssistantMessageId)
  if (!latestAssistant || latestAssistant.role !== 'assistant' || latestAssistant.hasError) {
    return false
  }

  return (
    hasCompletedOpenCodeAssistantTurn(latestAssistant)
    && latestAssistant.text.trim().length === 0
  )
}

function getIdleMissingAssistantMessageId(
  summary: OpenCodeSessionReconcileSummary,
): string | null {
  // OpenCode 1.18.4 omits idle *and* in-flight entries from /session/status.
  // Treat only an explicit idle as "generation finished". Omitted status plus
  // reply_pending is still a live generate and must keep polling.
  if (
    summary.rawStatus !== 'idle'
    || summary.durableState !== 'reply_pending'
    || !summary.replyPendingSinceMessageId
  ) {
    return null
  }
  return summary.replyPendingSinceMessageId
}

function isSettledProbeAssistantTurn(summary: OpenCodeSessionReconcileSummary): boolean {
  if (summary.rawStatus === 'idle') return true
  const latestAssistant = summary.messages.find(message =>
    message.id === summary.latestAssistantMessageId && message.role === 'assistant',
  )
  return Boolean(latestAssistant && hasCompletedOpenCodeAssistantTurn(latestAssistant))
}

function statusIsRunning(value: unknown): boolean {
  if (value === 'busy' || value === 'retry') return true
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.type === 'busy'
    || record.type === 'retry'
    || record.status === 'busy'
    || record.status === 'retry'
}

function getRetryStatusMessage(value: OpenCodeSessionStatusInput | null): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.type !== 'retry' && record.status !== 'retry') return null
  return extractNestedKnownFailureMessage(record) ?? extractNestedErrorMessage(record)
}

function statusIsRetrying(value: OpenCodeSessionStatusInput | null): boolean {
  if (value === 'retry') return true
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.type === 'retry' || record.status === 'retry'
}

function classifyRetryStatusFailure(
  value: OpenCodeSessionStatusInput | null,
): ReturnType<typeof classifyProbeFailure> | null {
  const message = getRetryStatusMessage(value)
  if (!message) return null
  const classified = classifyProbeFailure({ message })
  return classified.outcome === 'unknown' ? null : classified
}

function parseProviderScopedModel(selectedModel: string): {
  providerID: string
  modelID: string
} {
  const trimmed = selectedModel.trim()
  const separatorIndex = trimmed.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    throw new Error(`OpenCode model must be provider-scoped, received "${selectedModel}"`)
  }

  return {
    providerID: trimmed.slice(0, separatorIndex),
    modelID: trimmed.slice(separatorIndex + 1),
  }
}

function getObservedAssistantModel(
  summary: OpenCodeSessionReconcileSummary,
): { providerId: string; modelId: string } | null {
  const assistant = [...summary.messages]
    .reverse()
    .find(message => message.id === summary.latestAssistantMessageId && message.role === 'assistant')
  if (!assistant?.providerId || !assistant.modelId) return null
  return { providerId: assistant.providerId, modelId: assistant.modelId }
}

export function resolveOpenCodeExecutionProbeContextTokens(selectedModel: string): number {
  return selectedModel.startsWith('cursor-acp/') || selectedModel.startsWith('kiro/')
    ? OPEN_CODE_NATIVE_SUBSCRIPTION_PROBE_CONTEXT_TOKEN_LIMIT
    : OPEN_CODE_EXECUTION_PROBE_CONTEXT_TOKEN_LIMIT
}

function nowMs(): number {
  return Date.now()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildDurationMs(startedAtMs: number): number {
  return Math.max(0, nowMs() - startedAtMs)
}

function isProbeSuccessOutput(value: string | null | undefined): boolean {
  return /\bPONG\b/i.test(value?.trim() ?? '')
}

export function canonicalizeProbeOutput(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9]/g, '')
}

export function probeOutputMatchesExpected(
  value: string | null | undefined,
  expectedOutput: string,
  requireExactOutput: boolean,
): boolean {
  const normalized = value?.trim() ?? ''
  return requireExactOutput
    ? canonicalizeProbeOutput(normalized) === canonicalizeProbeOutput(expectedOutput)
    : isProbeSuccessOutput(normalized)
}

function isExpectedProbeOutput(
  value: string | null | undefined,
  expectedOutput: string,
  requireExactOutput: boolean,
): boolean {
  return probeOutputMatchesExpected(value, expectedOutput, requireExactOutput)
}

function normalizeFailureMessage(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return 'OpenCode model execution probe failed'
  }
  return trimmed
}

function extractJsonMessage(value: string): string | null {
  try {
    return extractNestedErrorMessage(JSON.parse(value))
  } catch {
    return null
  }
}

function extractNestedErrorMessage(value: unknown, depth = 0): string | null {
  if (depth > 5) {
    return null
  }
  if (typeof value === 'string') {
    const parsedMessage = extractJsonMessage(value)
    return parsedMessage ?? (value.trim() || null)
  }
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  for (const key of ['message', 'reason', 'detail', 'title']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }
  for (const key of ['error', 'cause', 'data', 'responseBody', 'body', 'response']) {
    const candidate = extractNestedErrorMessage(record[key], depth + 1)
    if (candidate) {
      return candidate
    }
  }

  return null
}

export function classifyProbeFailure(params: {
  message: string
}): Pick<OpenCodeExecutionProbeResult, 'outcome' | 'reason'> {
  const reason = normalizeFailureMessage(params.message)
  const kind = classifyOpenCodeProviderFailure(reason)
  if (kind === 'not_authenticated') {
    return {
      outcome: 'not_authenticated',
      reason,
    }
  }
  if (kind === 'unavailable') {
    return {
      outcome: 'unavailable',
      reason,
    }
  }
  return {
    outcome: 'unknown',
    reason,
  }
}

function buildCursorNativeExecutionOutcome(input: {
  nativeResult: OpenCodeCursorNativeProbeResult | null
  selectedModel: string
  prompt: string
  expectedOutput: string
  startedAtMs: number
  diagnostics: Set<string>
}): OpenCodeExecutionProbeResult | null {
  const { nativeResult, diagnostics } = input
  if (nativeResult?.outcome === 'available') {
    diagnostics.add(
      `Cursor native execution probe completed in ${nativeResult.durationMs}ms without canonical assistant provider/model evidence`,
    )
    return null
  }

  if (nativeResult?.outcome !== 'failure') return null
  const classified = classifyProbeFailure({ message: nativeResult.message ?? '' })
  if (classified.outcome === 'unknown') return null
  diagnostics.add(classified.reason)
  diagnostics.add(
    `Cursor native failure probe confirmed a terminal provider error in ${nativeResult.durationMs}ms`,
  )
  return {
    providerId: 'opencode',
    modelId: input.selectedModel,
    probePrompt: input.prompt,
    expectedOutput: input.expectedOutput,
    outcome: classified.outcome,
    reason: classified.reason,
    durationMs: buildDurationMs(input.startedAtMs),
    rawStatus: null,
    durableState: 'unknown',
    latestAssistantText: null,
    latestAssistantPreview: null,
    toolCallCount: 0,
    errorCount: 1,
    diagnostics: Array.from(diagnostics),
  }
}

function knownFailureMessagePriority(message: string | null): number {
  if (!message) return 0
  if (isOpenCodeUsageLimitFailureMessage(message.toLowerCase())) return 3
  const classified = classifyProbeFailure({ message })
  if (classified.outcome === 'not_authenticated') return 2
  if (classified.outcome === 'unavailable') return 1
  return 0
}

function extractNestedKnownFailureMessage(value: unknown, depth = 0): string | null {
  if (depth > 10) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    let nested: string | null = null
    try {
      nested = extractNestedKnownFailureMessage(JSON.parse(trimmed), depth + 1)
    } catch {
      // Plain provider error text.
    }
    const direct = classifyProbeFailure({ message: trimmed }).outcome === 'unknown'
      ? null
      : trimmed
    return knownFailureMessagePriority(nested) >= knownFailureMessagePriority(direct)
      ? nested
      : direct
  }
  if (!value || typeof value !== 'object') return null
  let bestMessage: string | null = null
  let bestPriority = 0
  const consider = (candidate: string | null) => {
    const priority = knownFailureMessagePriority(candidate)
    if (priority > bestPriority) {
      bestMessage = candidate
      bestPriority = priority
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      consider(extractNestedKnownFailureMessage(item, depth + 1))
    }
    return bestMessage
  }

  const record = value as Record<string, unknown>
  for (const key of [
    'message',
    'reason',
    'detail',
    'title',
    'name',
    'type',
    'code',
    'errorCode',
    'error_code',
  ]) {
    consider(extractNestedKnownFailureMessage(record[key], depth + 1))
  }
  for (const key of [
    'error',
    'errors',
    'cause',
    'data',
    'details',
    'innerError',
    'inner_error',
    'metadata',
    'responseBody',
    'body',
    'response',
  ]) {
    consider(extractNestedKnownFailureMessage(record[key], depth + 1))
  }
  for (const key of ['grpcCode', 'grpc_code']) {
    const candidate = record[key]
    if (candidate === 8 || candidate === '8') {
      consider('grpc_code=8')
    } else {
      consider(extractNestedKnownFailureMessage(candidate, depth + 1))
    }
  }
  for (const key of ['statusCode', 'status_code', 'httpStatus', 'http_status']) {
    const candidate = record[key]
    if (candidate === 401 || candidate === '401' || candidate === 403 || candidate === '403') {
      const providerMessage = extractNestedErrorMessage(record)
      consider(`HTTP ${candidate}${providerMessage ? `: ${providerMessage}` : ''}`)
    } else if (candidate === 429 || candidate === '429') {
      consider('HTTP 429')
    } else {
      consider(extractNestedKnownFailureMessage(candidate, depth + 1))
    }
  }
  return bestMessage
}

function failureMessageFromUnknown(value: unknown): string {
  return extractNestedKnownFailureMessage(value)
    ?? (value instanceof Error ? value.message : String(value))
}

function getLatestAssistantMessageError(messages: OpenCodeExecutionProbeResult['diagnostics'], rawMessages: OpenCodeMessage[]): string | null {
  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const candidate = rawMessages[index]
    const info = candidate.info
    if (!info || info.role !== 'assistant' || typeof info !== 'object') {
      continue
    }
    const error = info.error ?? null
    const errorRecord = error && typeof error === 'object' && !Array.isArray(error)
      ? error as Record<string, unknown>
      : null
    const data = errorRecord?.data ?? null
    const message = extractNestedKnownFailureMessage(error)
      ?? extractNestedKnownFailureMessage(data)
      ?? extractNestedErrorMessage(error)
      ?? extractNestedErrorMessage(data)
    if (message) {
      return message
    }
  }

  for (const diagnostic of messages) {
    if (diagnostic.includes('failed with')) {
      return diagnostic
    }
  }

  return null
}

export const OPEN_CODE_PROBE_PERMISSION_REJECT_MESSAGE =
  'Tools are disabled in this check. Reply with text only.'

// The Zen probe agent keeps the teammate tool set behind "ask", so any tool call surfaces as a
// permission request. Rejecting it with a message keeps the probe from running anything, and
// the message makes OpenCode hand the refusal back to the model as feedback instead of
// blocking the turn, so the model can still answer in text. Returns how many were rejected.
export async function rejectProbeSessionPermissions(
  client: Pick<OpenCodeClient, 'getPermissions' | 'answerPermission'>,
  sessionId: string,
  diagnostics: Set<string>,
): Promise<number> {
  let rejected = 0
  for (const permission of normalizeOpenCodePermissions(await client.getPermissions())) {
    if (permission.sessionId !== sessionId) continue
    await client.answerPermission({
      requestId: permission.requestId,
      sessionId,
      decision: 'reject',
      message: OPEN_CODE_PROBE_PERMISSION_REJECT_MESSAGE,
    })
    rejected += 1
    diagnostics.add(`OpenCode probe rejected a ${permission.tool ?? 'tool'} permission request`)
  }
  return rejected
}

type ProbeFailureClassification = Pick<OpenCodeExecutionProbeResult, 'outcome' | 'reason' | 'failureCode'>

// Checked before the message classifier, which would read the 403 as not_authenticated.
function classifyFreeTierRestrictedAssistantError(
  rawMessages: OpenCodeMessage[],
): ProbeFailureClassification | null {
  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const info = rawMessages[index]?.info
    if (!info || typeof info !== 'object' || info.role !== 'assistant' || !info.error) continue
    return isOpenCodeFreeTierRestrictedError(info.error)
      ? {
          outcome: 'unavailable',
          reason: OPEN_CODE_FREE_TIER_RESTRICTED_REASON,
          failureCode: OPEN_CODE_FREE_TIER_RESTRICTED_FAILURE_CODE,
        }
      : null
  }
  return null
}

function cloneProbeResult(result: OpenCodeExecutionProbeResult): OpenCodeExecutionProbeResult {
  return {
    ...result,
    diagnostics: [...result.diagnostics],
  }
}

export class OpenCodeExecutionProbe {
  constructor(private readonly deps: OpenCodeExecutionProbeDeps = {}) {}

  private async prepareProbeProfile(
    params: ProbeModelParams,
    context?: OpenCodePhaseContext,
  ): Promise<OpenCodePreparedProfile> {
    const options: OpenCodePrepareProfileOptions = {
      includeAppMcp: false,
      modelOutputLimitOverrides: [
        {
          modelId: params.selectedModel,
          outputTokens: params.outputTokens ?? OPEN_CODE_EXECUTION_PROBE_OUTPUT_TOKEN_LIMIT,
          contextTokens:
            params.contextTokens
            ?? resolveOpenCodeExecutionProbeContextTokens(params.selectedModel),
        },
      ],
      ...(context ? { abortSignal: context.signal } : {}),
      profileScope: await resolveOpenCodeProfileScope({
        projectPath: params.projectPath,
        purpose: 'execution_probe',
        selectedModel: params.selectedModel,
        env: params.scopeEnvironment,
      }),
    }
    return this.deps.prepareProfile
      ? this.deps.prepareProfile(params.projectPath, options)
      : openCodeProfileManager.prepareProfile(params.projectPath, options)
  }

  private async prepareInitialCursorNativeProbeContext(
    params: ProbeModelParams,
    context?: OpenCodePhaseContext,
  ): Promise<CursorNativeProbeContext> {
    if (this.deps.prepareProfile) {
      const profile = await this.prepareProbeProfile(params, context)
      return {
        projectPath: profile.tmpPath,
        env: profile.env,
      }
    }

    const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-cursor-native-'))
    try {
      const projectPath = path.join(probeRoot, 'workspace')
      await mkdir(projectPath, { recursive: true })
      const bridge = await ensureOpenCodeNativeCliCredentialBridge(probeRoot)
      context?.throwIfExpired()
      return {
        projectPath,
        env: {
          ...process.env,
          PATH: [bridge.binPath, process.env.PATH]
            .filter((value): value is string => Boolean(value))
            .join(path.delimiter),
          CURSOR_ACP_HOME_DIR:
            process.env.CURSOR_ACP_HOME_DIR?.trim() || bridge.hostHomePath,
          CURSOR_AGENT_EXECUTABLE:
            bridge.cursorAgentExecutablePath,
        },
        cleanup: () => rm(probeRoot, { recursive: true, force: true }),
      }
    } catch (error) {
      await rm(probeRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async runInitialCursorNativeProbe(input: {
    params: ProbeModelParams
    context: CursorNativeProbeContext
    diagnostics: Set<string>
  }): Promise<OpenCodeCursorNativeProbeResult | null> {
    const nativeFailureProbe = this.cursorNativeFailureProbe
    if (!nativeFailureProbe) return null
    try {
      return await this.runPhase(
        input.params.runtimeDeadline,
        'execution_poll',
        context => nativeFailureProbe.probe({
          selectedModel: input.params.selectedModel,
          projectPath: input.context.projectPath,
          env: input.context.env,
          signal: context?.signal,
          delayMs: 0,
        }),
      )
    } catch (error) {
      if (isOpenCodeRuntimeDeadlineError(error)) throw error
      input.diagnostics.add(
        `Cursor native failure probe failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
  }

  private get hostManager() {
    return this.deps.hostManager ?? openCodeHostManager
  }

  private get clientFactory() {
    return this.deps.clientFactory ?? openCodeClientFactory
  }

  private get eventTranslator() {
    return this.deps.eventTranslator ?? openCodeEventTranslator
  }

  private get cursorNativeFailureProbe() {
    // Custom clients are hermetic unit/fixture probes. The production singleton
    // gets the native Cursor fallback unless a test explicitly injects one.
    if (this.deps.cursorNativeFailureProbe) return this.deps.cursorNativeFailureProbe
    if (process.env[OPEN_CODE_CURSOR_NATIVE_FAILURE_PROBE_DISABLED_ENV] === '1') return null
    return this.deps.clientFactory == null ? openCodeCursorNativeFailureProbe : null
  }

  private get sleep() {
    return this.deps.sleep ?? sleep
  }

  private runPhase<T>(
    deadline: ProbeModelParams['runtimeDeadline'],
    phase: OpenCodePhaseContext['phase'],
    operation: (context?: OpenCodePhaseContext) => Promise<T>,
    host?: OpenCodeHostHandle,
  ): Promise<T> {
    const invoke = (context?: OpenCodePhaseContext) => host && this.hostManager.withHostOperation
      ? this.hostManager.withHostOperation(host, null, () => operation(context))
      : operation(context)
    // Admission belongs inside the deadline race: a timeout cannot release the
    // pin while the underlying callback is still capable of dispatching.
    return deadline
      ? deadline.runPhase(phase, context => invoke(context))
      : invoke(undefined)
  }

  private createClient(host: OpenCodeHostHandle, context?: OpenCodePhaseContext): OpenCodeClient {
    return this.clientFactory.create(
      host.baseUrl,
      context
        ? {
            signal: context.signal,
            remainingMs: context.remainingMs,
          }
        : undefined,
    )
  }

  private async verifyPromptStarted(input: {
    client: OpenCodeClient
    sessionId: string
    messageID: string
    context?: OpenCodePhaseContext
  }): Promise<{
    started: boolean
    classified: ReturnType<typeof classifyProbeFailure> | null
    retrying: boolean
  }> {
    const startedAt = nowMs()
    const promptStartTimeoutMs = Math.max(
      1,
      this.deps.promptStartTimeoutMs ?? OPEN_CODE_EXECUTION_PROMPT_START_TIMEOUT_MS,
    )
    const supportsExactMessageLookup = Boolean(input.client.getSessionMessage)
    for (;;) {
      input.context?.throwIfExpired()
      const statusMap = await input.client.getSessionStatus()
      const rawStatus = statusMap[input.sessionId] ?? null
      const classified = classifyRetryStatusFailure(rawStatus)
      if (classified) {
        return { started: true, classified, retrying: true }
      }
      if (statusIsRunning(rawStatus)) {
        return {
          started: true,
          classified: null,
          retrying: statusIsRetrying(rawStatus),
        }
      }

      const message = input.client.getSessionMessage
        ? await input.client.getSessionMessage(input.sessionId, input.messageID).catch(error => {
            if (input.context?.signal.aborted) throwOpenCodeAbortReason(input.context.signal)
            const classified = classifyProbeFailure({
              message: failureMessageFromUnknown(error),
            })
            if (classified.outcome !== 'unknown') throw error
            return null
          })
        : (await input.client.getSessionMessages(input.sessionId))[0] ?? null
      if (messageMatchesPrompt(message, input.messageID)
        || (!supportsExactMessageLookup && message !== null)) {
        return { started: true, classified: null, retrying: false }
      }

      const localRemaining = promptStartTimeoutMs - (nowMs() - startedAt)
      const remainingMs = Math.min(localRemaining, input.context?.remainingMs() ?? localRemaining)
      if (remainingMs <= 0) {
        return { started: false, classified: null, retrying: false }
      }
      await this.sleep(Math.min(OPEN_CODE_EXECUTION_PROBE_POLL_INTERVAL_MS, remainingMs))
    }
  }

  private async cleanupProbeSession(host: OpenCodeHostHandle, sessionId: string): Promise<void> {
    const controller = new AbortController()
    const cleanupStartedAt = nowMs()
    const cleanupTimeoutMs = Math.max(
      1,
      this.deps.sessionCleanupTimeoutMs ?? OPEN_CODE_EXECUTION_CLEANUP_TIMEOUT_MS,
    )
    const remainingMs = () => Math.max(
      1,
      cleanupTimeoutMs - (nowMs() - cleanupStartedAt),
    )
    const timer = setTimeout(() => {
      controller.abort(new Error('OpenCode execution probe cleanup timed out'))
    }, cleanupTimeoutMs)
    timer.unref?.()
    const client = this.clientFactory.create(host.baseUrl, {
      signal: controller.signal,
      remainingMs,
    })

    try {
      await withTimeout(
        (async () => {
          await client.abortSession(sessionId).catch(() => false)
          if (controller.signal.aborted) return
          await this.sleep(Math.min(OPEN_CODE_EXECUTION_CLEANUP_SETTLE_MS, remainingMs()))
          if (controller.signal.aborted) return
          const status: Record<string, OpenCodeSessionStatusInput> = await client
            .getSessionStatus()
            .catch(() => ({}))
          if (statusIsRunning(status[sessionId])) {
            await client.abortSession(sessionId).catch(() => false)
          }
        })(),
        cleanupTimeoutMs,
        'OpenCode execution probe session cleanup timed out',
      )
    } finally {
      clearTimeout(timer)
      if (!controller.signal.aborted) {
        controller.abort(new Error('OpenCode execution probe cleanup finished'))
      }
    }
  }

  private async fanOutOAuthCredential(input: {
    providerId: string
    sourceAuthPath: string
  }): Promise<void> {
    if (this.deps.fanOutOAuthCredential) {
      await this.deps.fanOutOAuthCredential(input)
      return
    }
    await openCodeProfileManager.fanOutOAuthCredential(input.providerId, input.sourceAuthPath)
  }

  async probeModel(params: ProbeModelParams): Promise<OpenCodeExecutionProbeResult> {
    // A generic probe key cannot prove the exact prepared host identity. Until
    // that identity is available here, every proof is deliberately fresh.
    return cloneProbeResult(await this.runProbeModel({ ...params, bypassCache: true }))
  }

  async probeModelOnHost(
    params: ProbeModelParams & { host: OpenCodeHostHandle },
  ): Promise<OpenCodeExecutionProbeResult> {
    const startedAtMs = nowMs()
    const prompt = params.prompt?.trim() || OPEN_CODE_EXECUTION_PROBE_PROMPT
    const expectedOutput = params.expectedOutput?.trim() || OPEN_CODE_EXECUTION_PROBE_EXPECTED_OUTPUT
    parseProviderScopedModel(params.selectedModel)
    return cloneProbeResult(await this.runProbeModelWithHost({
      params: { ...params, bypassCache: true },
      host: params.host,
      startedAtMs,
      prompt,
      expectedOutput,
      probeTimeoutMs: Math.max(1, this.deps.probeTimeoutMs ?? OPEN_CODE_EXECUTION_PROBE_TIMEOUT_MS),
      pollIntervalMs: Math.max(0, this.deps.pollIntervalMs ?? OPEN_CODE_EXECUTION_PROBE_POLL_INTERVAL_MS),
      diagnostics: new Set<string>(),
    }))
  }

  private async runProbeModel(params: ProbeModelParams): Promise<OpenCodeExecutionProbeResult> {
    const startedAtMs = nowMs()
    const prompt = params.prompt?.trim() || OPEN_CODE_EXECUTION_PROBE_PROMPT
    const expectedOutput = params.expectedOutput?.trim() || OPEN_CODE_EXECUTION_PROBE_EXPECTED_OUTPUT
    parseProviderScopedModel(params.selectedModel)
    const diagnostics = new Set<string>()
    const probeTimeoutMs = Math.max(
      1,
      this.deps.probeTimeoutMs ?? OPEN_CODE_EXECUTION_PROBE_TIMEOUT_MS,
    )
    const pollIntervalMs = Math.max(
      0,
      this.deps.pollIntervalMs ?? OPEN_CODE_EXECUTION_PROBE_POLL_INTERVAL_MS,
    )

    if (
      params.cursorNativePreflightBeforeHost === true
      && parseProviderScopedModel(params.selectedModel).providerID === 'cursor-acp'
      && this.cursorNativeFailureProbe
    ) {
      const nativeContext = await this.runPhase(
        params.runtimeDeadline,
        'host_start',
        context => this.prepareInitialCursorNativeProbeContext(params, context),
      )
      let nativeResult: OpenCodeCursorNativeProbeResult | null
      try {
        nativeResult = await this.runInitialCursorNativeProbe({
          params,
          context: nativeContext,
          diagnostics,
        })
      } finally {
        await nativeContext.cleanup?.().catch(() => undefined)
      }
      const nativeOutcome = buildCursorNativeExecutionOutcome({
        nativeResult,
        selectedModel: params.selectedModel,
        prompt,
        expectedOutput,
        startedAtMs,
        diagnostics,
      })
      if (nativeOutcome) return nativeOutcome
      const inconclusiveDiagnostic = nativeResult?.outcome === 'retryable'
        ? 'Cursor native execution preflight hit a transient failure before OpenCode startup'
        : 'Cursor native execution preflight was inconclusive before OpenCode startup'
      diagnostics.add(
        params.cursorNativePreflightOnly === true
          ? inconclusiveDiagnostic
          : `${inconclusiveDiagnostic}; falling back to the OpenCode execution probe`,
      )
      if (params.cursorNativePreflightOnly === true) {
        return {
          providerId: 'opencode',
          modelId: params.selectedModel,
          probePrompt: prompt,
          expectedOutput,
          outcome: 'unknown',
          reason: nativeResult?.message ?? inconclusiveDiagnostic,
          durationMs: buildDurationMs(startedAtMs),
          rawStatus: null,
          durableState: 'unknown',
          latestAssistantText: null,
          latestAssistantPreview: null,
          toolCallCount: 0,
          errorCount: nativeResult?.message ? 1 : 0,
          diagnostics: Array.from(diagnostics),
          ...(nativeResult?.outcome === 'timeout'
            ? { failureCode: 'execution_timeout' as const }
            : {}),
        }
      }
    }

    const hostStartupState: { promise: Promise<OpenCodeHostHandle> | null } = {
      promise: null,
    }
    let host: OpenCodeHostHandle
    try {
      host = await this.runPhase(params.runtimeDeadline, 'host_start', async context => {
        hostStartupState.promise = (async () => {
          const ensuredHost = await this.hostManager.ensureHost({
            projectPath: params.projectPath,
            profileOptions: {
              includeAppMcp: false,
              modelOutputLimitOverrides: [
                {
                  modelId: params.selectedModel,
                  outputTokens: params.outputTokens ?? OPEN_CODE_EXECUTION_PROBE_OUTPUT_TOKEN_LIMIT,
                  contextTokens:
                    params.contextTokens ??
                    resolveOpenCodeExecutionProbeContextTokens(params.selectedModel),
                },
              ],
              profileScope: await resolveOpenCodeProfileScope({
                projectPath: params.projectPath,
                purpose: 'execution_probe',
                selectedModel: params.selectedModel,
                env: params.scopeEnvironment,
              }),
            },
            ...(context ? { healthTimeoutMs: context.remainingMs() } : {}),
            ...(context ? { abortSignal: context.signal } : {}),
            hostLifetime: params.disposeHostOnRelease === false ? 'persistent' : 'process',
          })
          if (context?.signal.aborted) {
            await this.hostManager.releaseHost(ensuredHost.hostKey).catch(() => undefined)
            throwOpenCodeAbortReason(context.signal)
          }
          return ensuredHost
        })()
        return hostStartupState.promise
      })
    } catch (error) {
      const hostStartup = hostStartupState.promise
      if (isOpenCodeRuntimeDeadlineError(error) && hostStartup) {
        const startupCleanup = hostStartup.then(
          lateHost => this.hostManager.releaseHost(lateHost.hostKey).catch(() => undefined),
          () => undefined,
        )
        void startupCleanup
        await withTimeout(
          startupCleanup,
          Math.max(
            1,
            this.deps.hostStartupCleanupTimeoutMs ?? OPEN_CODE_EXECUTION_CLEANUP_TIMEOUT_MS,
          ),
          'OpenCode execution probe host startup cleanup timed out',
        ).catch(() => undefined)
      }
      throw error
    }
    const preflightLease = createOpenCodePreflightHostLeaseInput(
      `model-probe-${params.selectedModel}`,
    )
    try {
      await this.hostManager.retainHostLease?.(host.hostKey, preflightLease)
      return await this.runProbeModelWithHost({
        params,
        host,
        startedAtMs,
        prompt,
        expectedOutput,
        probeTimeoutMs,
        pollIntervalMs,
        diagnostics,
      })
    } finally {
      await this.hostManager.releaseHostLease?.(host.hostKey, preflightLease).catch(() => undefined)
      if (params.disposeHostOnRelease !== false) {
        await this.hostManager.releaseHost(host.hostKey)
      }
    }
  }

  private async runProbeModelWithHost(input: {
    params: ProbeModelParams
    host: OpenCodeHostHandle
    startedAtMs: number
    prompt: string
    expectedOutput: string
    probeTimeoutMs: number
    pollIntervalMs: number
    diagnostics: Set<string>
  }): Promise<OpenCodeExecutionProbeResult> {
    return this.hostManager.withHostOperation
      ? this.hostManager.withHostOperation(input.host, null, () => this.runProtectedProbeModelWithHost(input))
      : this.runProtectedProbeModelWithHost(input)
  }

  private async runProtectedProbeModelWithHost(input: {
    params: ProbeModelParams
    host: OpenCodeHostHandle
    startedAtMs: number
    prompt: string
    expectedOutput: string
    probeTimeoutMs: number
    pollIntervalMs: number
    diagnostics: Set<string>
  }): Promise<OpenCodeExecutionProbeResult> {
    const providerId = parseProviderScopedModel(input.params.selectedModel).providerID
    if (providerId !== 'xai') {
      return this.runProbeModelWithHostUnlocked(input)
    }

    const withOAuthRefreshLock = this.deps.withOAuthRefreshLock
      ?? withOpenCodeOAuthRefreshLock
    input.params.runtimeDeadline?.throwIfExpired('execution_submit')
    return withOAuthRefreshLock({
      authPath: input.host.profile.managedAuthPath,
      providerId,
      abortSignal: input.params.runtimeDeadline?.signal,
      operation: async () => {
        if (!input.host.profile.profileScope
          || (await readOpenCodeAuthCredential({ authPath: input.host.profile.managedAuthPath, providerId }))?.type !== 'oauth') {
          return this.runProbeModelWithHostUnlocked(input)
        }
        const hostIdentity = () => ({
          hostKey: input.host.hostKey, baseUrl: input.host.baseUrl,
          pid: input.host.pid, processStartedAtMs: input.host.processStartedAtMs,
          profileRootKey: input.host.profileRootKey,
        })
        const expectedHost = hostIdentity()
        let nativeOwner: OpenCodeOAuthNativeProbeOwner | undefined
        let settled = false
        const completion = await openCodeProfileManager.withOwnedOAuthRefresh({
          profile: input.host.profile,
          abortSignal: input.params.runtimeDeadline?.signal,
          assertHostOwnership: async () => {
            if (!isDeepStrictEqual(hostIdentity(), expectedHost)
              || !expectedHost.processStartedAtMs
              || await readProcessStartTimeMs(expectedHost.pid) !== expectedHost.processStartedAtMs) {
              throw new Error('OpenCode OAuth execution host changed or process ownership is unavailable')
            }
          },
          operation: async (_armSession, armProbe) => {
            let result: OpenCodeExecutionProbeResult | undefined
            let error: unknown
            try {
              result = await this.runProbeModelWithHostUnlocked({ ...input,
                armOAuthNativeProbe: async (sessionId, messageId) => {
                  nativeOwner = { ...expectedHost, processStartedAtMs: expectedHost.processStartedAtMs!,
                    projectPath: input.host.profile.projectPath, scopeToken: input.host.profile.scopeToken!,
                    profileRootKey: input.host.profile.profileRootKey, sessionId, messageId,
                    selectedModel: input.params.selectedModel }
                  await armProbe(nativeOwner)
                },
              })
            } catch (caught) { error = caught }
            if (!nativeOwner && error !== undefined) throw error
            settled = !!nativeOwner && await this.isOwnedOAuthNativeProbeSettled(nativeOwner)
            return { result, error }
          },
          isNativeSettled: () => settled,
        })
        if (completion.error !== undefined) throw completion.error
        if (!completion.result) throw new Error('OpenCode OAuth execution probe produced no result')
        const selected = parseProviderScopedModel(input.params.selectedModel)
        if (settled && nativeOwner && completion.result.outcome === 'available'
          && completion.result.observedProviderId === selected.providerID
          && completion.result.observedModelId === selected.modelID) {
          input.params.onOwnedOAuthProbeSuccess?.({ ...nativeOwner })
        }
        return completion.result
      },
    })
  }

  /** Exact canonical terminal prompt under live or confirmed absent ownership. */
  async isOwnedOAuthNativeProbeSettled(owner: OpenCodeOAuthNativeProbeOwner, recoveryDataRoot?: string, unsubmitted = false): Promise<boolean> {
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !Number.isFinite(owner.processStartedAtMs) || owner.processStartedAtMs <= 0
      || !/^[a-f0-9]{64}$/.test(owner.scopeToken) || !owner.hostKey.includes(owner.scopeToken)
      || !owner.sessionId || !owner.messageId || !owner.profileRootKey.startsWith('scope-')) return false
    const url = new URL(owner.baseUrl)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false
    const sameProcess = async () => await readProcessStartTimeMs(owner.pid) === owner.processStartedAtMs
    const absent = () => {
      try { process.kill(owner.pid, 0); return false }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
    }
    const completedPrompt = (messages: OpenCodeMessage[]) => {
      const model = parseProviderScopedModel(owner.selectedModel)
      if (model.providerID !== 'xai') return false
      const userPresent = messages.some(message => message.info?.id === owner.messageId && message.info?.role === 'user')
      return userPresent && messages.some(message => {
        const info = message.info
        const completed = info.time && typeof info.time === 'object' && 'completed' in info.time
          ? info.time.completed : undefined
        return info.role === 'assistant' && info.parentID === owner.messageId
          && info.providerID === model.providerID && info.modelID === model.modelID
          && (typeof completed === 'number' && Number.isFinite(completed)
            || !!info.error && typeof info.error === 'object')
      })
    }
    if (!await sameProcess()) {
      if (!recoveryDataRoot || !absent()) return false
      const offline = await new OpenCodeOfflineSessionReader(recoveryDataRoot).readSession({
        profileRootKey: owner.profileRootKey, projectPath: owner.projectPath, opencodeSessionId: owner.sessionId,
      })
      return offline?.historyShape === 'supported'
        && offline.sessionIdentity?.sessionId === owner.sessionId
        && offline.sessionIdentity.directory === owner.projectPath
        && (unsubmitted
          ? offline.historyComplete === true && !offline.messages.some(message => message.info?.id === owner.messageId || message.info?.parentID === owner.messageId)
          : completedPrompt(offline.messages))
        && absent()
    }
    if (unsubmitted) return false // Idle does not exclude an in-flight submission.
    const client = this.clientFactory.create(owner.baseUrl)
    const idle = async () => {
      const statuses = await client.getSessionStatus()
      if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return false
      // Native /session/status is sparse: v1.18.4 removes idle entries. Omission
      // proves only idle; exact terminal history and process ownership below
      // are still required. A failed read or malformed entry is not idle.
      if (!Object.prototype.hasOwnProperty.call(statuses, owner.sessionId)) return true
      const status = statuses[owner.sessionId]
      return status === 'idle' || (typeof status === 'object' && status?.type === 'idle')
    }
    if (!await idle()) return false
    const messages = await client.getSessionMessages(owner.sessionId)
    return completedPrompt(messages) && await idle() && await sameProcess()
  }

  private async runProbeModelWithHostUnlocked(input: {
    params: ProbeModelParams
    host: OpenCodeHostHandle
    startedAtMs: number
    prompt: string
    expectedOutput: string
    probeTimeoutMs: number
    pollIntervalMs: number
    diagnostics: Set<string>
    armOAuthNativeProbe?: (sessionId: string, messageId: string) => Promise<void>
  }): Promise<OpenCodeExecutionProbeResult> {
    const {
      params,
      host,
      startedAtMs,
      prompt,
      expectedOutput,
      probeTimeoutMs,
      pollIntervalMs,
      diagnostics,
    } = input
    const finish = async (
      result: OpenCodeExecutionProbeResult,
    ): Promise<OpenCodeExecutionProbeResult> => {
      // Scoped operations publish only their own native successor through the
      // predecessor-bound owner surrounding the entire settled operation.
      if (parseProviderScopedModel(params.selectedModel).providerID === 'xai'
        && !host.profile.profileScope) {
        await this.fanOutOAuthCredential({
          providerId: 'xai',
          sourceAuthPath: host.profile.managedAuthPath,
        }).catch(error => {
          result.diagnostics.push(
            `OpenCode xAI OAuth credential sync failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
      }
      return result
    }
    const finishObservedAssistantResult = (
      result: OpenCodeExecutionProbeResult,
      summary: OpenCodeSessionReconcileSummary,
    ): Promise<OpenCodeExecutionProbeResult> => {
      const observed = getObservedAssistantModel(summary)
      const selected = parseProviderScopedModel(params.selectedModel)
      if (observed) {
        result.observedProviderId = observed.providerId
        result.observedModelId = observed.modelId
      }
      if (
        !observed
        || observed.providerId !== selected.providerID
        || observed.modelId !== selected.modelID
      ) {
        const actual = observed
          ? `"${observed.providerId}/${observed.modelId}"`
          : 'unavailable'
        result.outcome = 'unavailable'
        result.reason = `OpenCode canonical assistant provider/model was ${actual}; expected "${params.selectedModel}"`
        delete result.verifiedAt
        result.diagnostics.push(result.reason)
      }
      return finish(result)
    }

    const nativeFailureProbe = this.cursorNativeFailureProbe
    if (
      params.cursorNativePreflightBeforeHost !== true
      &&
      parseProviderScopedModel(params.selectedModel).providerID === 'cursor-acp'
      && nativeFailureProbe
    ) {
      const nativeResult = await this.runInitialCursorNativeProbe({
        params,
        context: {
          projectPath: host.profile.tmpPath,
          env: host.profile.env,
        },
        diagnostics,
      })
      const nativeOutcome = buildCursorNativeExecutionOutcome({
        nativeResult,
        selectedModel: params.selectedModel,
        prompt,
        expectedOutput,
        startedAtMs,
        diagnostics,
      })
      if (nativeOutcome) return finish(nativeOutcome)

      diagnostics.add(
        nativeResult?.outcome === 'retryable'
          ? 'Cursor native execution preflight hit a transient failure; falling back to the OpenCode execution probe'
          : 'Cursor native execution preflight was inconclusive; falling back to the OpenCode execution probe',
      )
    }

    let sessionId: string | null = null
    let sessionRequiresCleanup = false
    try {
      const executionSubmitStartedAtMs = nowMs()
      const submitted = await this.runPhase(
        params.runtimeDeadline,
        'execution_submit',
        async context => {
          const client = this.createClient(host, context)
          const session = await client.createSession({
            title: `probe:${params.selectedModel}`,
          })
          sessionId = session.id
          sessionRequiresCleanup = true
          const messageID = buildOpenCodeRuntimePromptMessageId()
          const probeMessage = {
            messageID,
            agent: OPEN_CODE_MODEL_PROBE_AGENT_NAME,
            model: parseProviderScopedModel(params.selectedModel),
            parts: [{ type: 'text', text: prompt }],
          }

          await input.armOAuthNativeProbe?.(session.id, messageID)
          try {
            await client.promptSessionAsync(session.id, probeMessage)
          } catch (error) {
            if (context?.signal.aborted) throwOpenCodeAbortReason(context.signal)
            return {
              started: false as const,
              classified: classifyProbeFailure({
                message: failureMessageFromUnknown(error),
              }),
              retrying: false,
            }
          }

          try {
            return await this.verifyPromptStarted({
              client,
              sessionId: session.id,
              messageID,
              context,
            })
          } catch (error) {
            if (context?.signal.aborted) throwOpenCodeAbortReason(context.signal)
            const classified = classifyProbeFailure({
              message: failureMessageFromUnknown(error),
            })
            if (classified.outcome === 'unknown') throw error
            return {
              started: false as const,
              classified,
              retrying: false,
            }
          }
        },
        host,
      )

      if (!submitted.started) {
        const hasTerminalClassification = submitted.classified != null
          && submitted.classified.outcome !== 'unknown'
        const reason = submitted.classified?.reason
          ?? 'OpenCode accepted prompt_async but did not create a user message or enter a running state'
        diagnostics.add(reason)
        if (hasTerminalClassification) {
          diagnostics.add(
            `OpenCode prompt start exposed a terminal provider error in ${Math.max(0, nowMs() - executionSubmitStartedAtMs)}ms`,
          )
        }
        return finish({
          providerId: 'opencode',
          modelId: params.selectedModel,
          probePrompt: prompt,
          expectedOutput,
          outcome: submitted.classified?.outcome ?? 'unknown',
          reason,
          durationMs: buildDurationMs(startedAtMs),
          rawStatus: null,
          durableState: 'unknown',
          latestAssistantText: null,
          latestAssistantPreview: null,
          toolCallCount: 0,
          errorCount: 1,
          diagnostics: Array.from(diagnostics),
          failureCode: hasTerminalClassification ? undefined : 'prompt_start_failed',
        })
      }

      if (submitted.classified) {
        diagnostics.add(
          `OpenCode retry status exposed a terminal provider error during prompt start in ${Math.max(0, nowMs() - executionSubmitStartedAtMs)}ms`,
        )
        return finish({
          providerId: 'opencode',
          modelId: params.selectedModel,
          probePrompt: prompt,
          expectedOutput,
          outcome: submitted.classified.outcome,
          reason: submitted.classified.reason,
          durationMs: buildDurationMs(startedAtMs),
          rawStatus: 'retry',
          durableState: 'retrying',
          latestAssistantText: null,
          latestAssistantPreview: null,
          toolCallCount: 0,
          errorCount: 1,
          diagnostics: Array.from(diagnostics),
        })
      }

      const nativeFailureController =
        parseProviderScopedModel(params.selectedModel).providerID === 'cursor-acp'
        && nativeFailureProbe
          ? new AbortController()
          : null
      let nativeTerminalFailure: {
        classified: ReturnType<typeof classifyProbeFailure>
        durationMs: number
      } | null = null
      let nativeFailureAttempts = 0
      let nativeProbeConclusive = false
      let nativeFailurePending: Promise<void> | null = null
      const startNativeFailureProbe = () => {
        if (
          nativeProbeConclusive
          || nativeFailurePending
          || nativeFailureAttempts >= OPEN_CODE_CURSOR_NATIVE_FAILURE_PROBE_MAX_ATTEMPTS
          || !nativeFailureController
          || !nativeFailureProbe
        ) return
        nativeFailureAttempts += 1
        const dispatch = () => nativeFailureProbe.probe({
          selectedModel: params.selectedModel,
          // Quota/auth is account-scoped. Keep this auxiliary request out of
          // the user project so project rules and tools cannot affect it.
          projectPath: host.profile.tmpPath,
          env: host.profile.env,
          signal: nativeFailureController.signal,
        })
        nativeFailurePending = (this.hostManager.withHostOperation
          ? this.hostManager.withHostOperation(host, null, dispatch)
          : dispatch()).then(result => {
          if (!result) return
          if (result.outcome === 'available') {
            nativeProbeConclusive = true
            return
          }
          if (result.outcome === 'retryable') {
            diagnostics.add(
              `Cursor native failure probe will retry after a transient failure in ${result.durationMs}ms`,
            )
            return
          }
          const classified = classifyProbeFailure({ message: result.message ?? '' })
          if (classified.outcome !== 'unknown') {
            nativeProbeConclusive = true
            nativeTerminalFailure = {
              classified,
              durationMs: result.durationMs,
            }
          }
        }).catch(error => {
          diagnostics.add(
            `Cursor native failure probe failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }).finally(() => {
          nativeFailurePending = null
        })
      }
      if (submitted.retrying) {
        startNativeFailureProbe()
      }

      const executionPollStartedAtMs = nowMs()
      return await this.runPhase(params.runtimeDeadline, 'execution_poll', async context => {
        const localDeadlineMs = nowMs() + (
          context?.remainingMs() ?? probeTimeoutMs
        )
        let latestRawStatus: OpenCodeExecutionProbeResult['rawStatus'] =
          submitted.retrying ? 'retry' : null
        let latestDurableState: OpenCodeExecutionProbeResult['durableState'] =
          submitted.retrying ? 'retrying' : 'unknown'
        let latestAssistantText: string | null = null
        let latestAssistantPreview: string | null = null
        let latestToolCallCount = 0
        let latestErrorCount = 0
        let idleMissingAssistantMessageId: string | null = null
        let idleMissingAssistantConfirmations = 0
        let permissionSweep: Promise<void> | null = null
        let rejectedProbePermissions = 0
        let idleAfterRejectedPermissionConfirmations = 0
        const sweepProbePermissions = (client: OpenCodeClient) => {
          if (permissionSweep || !sessionId) return
          permissionSweep = rejectProbeSessionPermissions(client, sessionId, diagnostics)
            .then(count => { rejectedProbePermissions += count })
            .catch(() => undefined)
            .finally(() => { permissionSweep = null })
        }
        const finishPollRequestFailure = (
          error: unknown,
          source: 'status' | 'messages',
        ): Promise<OpenCodeExecutionProbeResult> | null => {
          const classified = classifyProbeFailure({
            message: failureMessageFromUnknown(error),
          })
          if (classified.outcome === 'unknown') return null
          diagnostics.add(
            `OpenCode session ${source} request exposed a terminal provider error in ${Math.max(0, nowMs() - executionPollStartedAtMs)}ms`,
          )
          return finish({
            providerId: 'opencode',
            modelId: params.selectedModel,
            probePrompt: prompt,
            expectedOutput,
            outcome: classified.outcome,
            reason: classified.reason,
            durationMs: buildDurationMs(startedAtMs),
            rawStatus: latestRawStatus,
            durableState: latestDurableState,
            latestAssistantText,
            latestAssistantPreview,
            toolCallCount: latestToolCallCount,
            errorCount: Math.max(1, latestErrorCount),
            diagnostics: Array.from(diagnostics),
          })
        }
        const checkOriginalProbeRecovered = async () => {
          const remainingMs = context?.remainingMs() ?? Number.POSITIVE_INFINITY
          if (remainingMs <= OPEN_CODE_CURSOR_NATIVE_RECOVERY_CHECK_TIMEOUT_MS) {
            return null
          }

          const controller = new AbortController()
          const abortFromContext = () => {
            if (!controller.signal.aborted && context) {
              controller.abort(context.signal.reason)
            }
          }
          context?.signal.addEventListener('abort', abortFromContext, { once: true })
          const recoveryStartedAtMs = nowMs()
          const recoveryClient = this.clientFactory.create(host.baseUrl, {
            signal: controller.signal,
            remainingMs: () => Math.max(
              1,
              Math.min(
                context?.remainingMs() ?? OPEN_CODE_CURSOR_NATIVE_RECOVERY_CHECK_TIMEOUT_MS,
                OPEN_CODE_CURSOR_NATIVE_RECOVERY_CHECK_TIMEOUT_MS
                  - (nowMs() - recoveryStartedAtMs),
              ),
            ),
          })

          let timeout: ReturnType<typeof setTimeout> | null = null
          try {
            const observation = Promise.resolve()
              .then(() => Promise.all([
                recoveryClient.getSessionStatus(),
                recoveryClient.getSessionMessages(sessionId!),
              ]))
              .then(([statusMap, messages]) => {
                const summary = this.eventTranslator.reconcileSessionMessages({
                  sessionId: sessionId!,
                  rawStatus: statusMap[sessionId!] ?? null,
                  messages,
                })
                if (summary.durableState !== 'idle') return null
                const responseText = summary.latestAssistantText?.trim()
                  || summary.latestAssistantPreview?.trim()
                  || null
                if (!responseText) return null
                return classifyProbeFailure({ message: responseText }).outcome === 'unknown'
                  ? summary
                  : null
              })
              .catch(() => null)
            const timedOut = new Promise<null>(resolve => {
              timeout = setTimeout(() => {
                if (!controller.signal.aborted) {
                  controller.abort(
                    new Error('OpenCode native failure recovery check timed out'),
                  )
                }
                resolve(null)
              }, OPEN_CODE_CURSOR_NATIVE_RECOVERY_CHECK_TIMEOUT_MS)
            })
            return await Promise.race([observation, timedOut])
          } finally {
            if (timeout) clearTimeout(timeout)
            context?.signal.removeEventListener('abort', abortFromContext)
            if (!controller.signal.aborted) {
              controller.abort(new Error('OpenCode native failure recovery check finished'))
            }
          }
        }

        pollLoop: for (;;) {
          context?.throwIfExpired()
          if (nativeTerminalFailure) {
            const recovered = await checkOriginalProbeRecovered()
            if (recovered) {
              sessionRequiresCleanup = false
              diagnostics.add(
                'OpenCode original probe recovered before the auxiliary Cursor failure was applied',
              )
              return finishObservedAssistantResult({
                providerId: 'opencode',
                modelId: params.selectedModel,
                probePrompt: prompt,
                expectedOutput,
                outcome: 'available',
                reason: null,
                durationMs: buildDurationMs(startedAtMs),
                rawStatus: recovered.rawStatus,
                durableState: recovered.durableState,
                latestAssistantText: recovered.latestAssistantText,
                latestAssistantPreview: recovered.latestAssistantPreview,
                toolCallCount: recovered.toolCallCount,
                errorCount: recovered.errorCount,
                diagnostics: Array.from(diagnostics),
                verifiedAt: new Date().toISOString(),
              }, recovered)
            }
            diagnostics.add(
              `Cursor native failure probe confirmed a terminal provider error in ${nativeTerminalFailure.durationMs}ms`,
            )
            return finish({
              providerId: 'opencode',
              modelId: params.selectedModel,
              probePrompt: prompt,
              expectedOutput,
              outcome: nativeTerminalFailure.classified.outcome,
              reason: nativeTerminalFailure.classified.reason,
              durationMs: buildDurationMs(startedAtMs),
              rawStatus: latestRawStatus,
              durableState: latestDurableState,
              latestAssistantText,
              latestAssistantPreview,
              toolCallCount: latestToolCallCount,
              errorCount: Math.max(1, latestErrorCount),
              diagnostics: Array.from(diagnostics),
            })
          }
          const pollRequestsController = new AbortController()
          const abortPollRequestsFromContext = () => {
            if (!pollRequestsController.signal.aborted && context) {
              pollRequestsController.abort(context.signal.reason)
            }
          }
          context?.signal.addEventListener('abort', abortPollRequestsFromContext, { once: true })
          const pollClient = this.clientFactory.create(host.baseUrl, {
            signal: pollRequestsController.signal,
            ...(context ? { remainingMs: context.remainingMs } : {}),
          })
          let messagesRequest: Promise<
            | { kind: 'messages'; messages: OpenCodeMessage[] }
            | { kind: 'error'; error: unknown }
          > | null = null
          let rawStatus: OpenCodeSessionStatusInput | null = null
          let messages: OpenCodeMessage[]

          try {
            for (;;) {
              if (nativeTerminalFailure) {
                continue pollLoop
              }
              context?.throwIfExpired()
              sweepProbePermissions(pollClient)
              const statusRequest = pollClient.getSessionStatus().then(
                statusMap => ({ kind: 'status' as const, statusMap }),
                error => ({ kind: 'error' as const, error }),
              )
              const nativeAtStatusRead = nativeFailurePending
              let statusResult = await Promise.race([
                statusRequest,
                ...(nativeAtStatusRead
                  ? [nativeAtStatusRead.then(() => ({ kind: 'native' as const }))]
                  : []),
              ])
              if (statusResult.kind === 'native') {
                if (nativeTerminalFailure) {
                  continue pollLoop
                }
                statusResult = await statusRequest
              }
              if (statusResult.kind === 'error') {
                const terminalFailure = finishPollRequestFailure(
                  statusResult.error,
                  'status',
                )
                if (terminalFailure) return terminalFailure
                throw statusResult.error
              }
              const statusMap = statusResult.statusMap
              rawStatus = statusMap[sessionId!] ?? null
              const retryFailure = classifyRetryStatusFailure(rawStatus)
              if (retryFailure) {
                diagnostics.add(
                  `OpenCode retry status exposed a terminal provider error in ${Math.max(0, nowMs() - executionPollStartedAtMs)}ms`,
                )
                return finish({
                  providerId: 'opencode',
                  modelId: params.selectedModel,
                  probePrompt: prompt,
                  expectedOutput,
                  outcome: retryFailure.outcome,
                  reason: retryFailure.reason,
                  durationMs: buildDurationMs(startedAtMs),
                  rawStatus: 'retry',
                  durableState: 'retrying',
                  latestAssistantText,
                  latestAssistantPreview,
                  toolCallCount: latestToolCallCount,
                  errorCount: Math.max(1, latestErrorCount),
                  diagnostics: Array.from(diagnostics),
                })
              }

              // A retry means the original OpenCode request already failed. Starting
              // the native probe here cannot duplicate a healthy in-flight request.
              if (statusIsRetrying(rawStatus)) {
                latestRawStatus = 'retry'
                latestDurableState = 'retrying'
                startNativeFailureProbe()
              }

              if (nativeTerminalFailure) {
                continue pollLoop
              }

              messagesRequest ??= pollClient.getSessionMessages(sessionId!).then(
                messages => ({ kind: 'messages' as const, messages }),
                error => ({ kind: 'error' as const, error }),
              )

              const statusRefreshDelay = nowMs() < localDeadlineMs
                ? this.sleep(
                    Math.min(pollIntervalMs, Math.max(0, localDeadlineMs - nowMs())),
                  ).then(() => ({ kind: 'status_refresh' as const }))
                : null
              const nativePending = nativeFailurePending
              const next = await Promise.race([
                messagesRequest,
                ...(statusRefreshDelay ? [statusRefreshDelay] : []),
                ...(nativePending
                  ? [nativePending.then(() => ({ kind: 'native' as const }))]
                  : []),
              ])

              if (next.kind === 'status_refresh') {
                continue
              }
              if (next.kind === 'native') {
                if (nativeTerminalFailure) {
                  continue pollLoop
                }
                continue
              }
              if (next.kind === 'error') {
                const terminalFailure = finishPollRequestFailure(
                  next.error,
                  'messages',
                )
                if (terminalFailure) return terminalFailure
                throw next.error
              }
              messages = next.messages
              break
            }
          } finally {
            context?.signal.removeEventListener('abort', abortPollRequestsFromContext)
            if (!pollRequestsController.signal.aborted) {
              pollRequestsController.abort(
                new Error('OpenCode execution probe poll requests finished'),
              )
            }
          }

          const summary = this.eventTranslator.reconcileSessionMessages({
            sessionId: sessionId!,
            rawStatus,
            messages,
          })
          for (const diagnostic of summary.diagnostics) diagnostics.add(diagnostic)
          latestRawStatus = summary.rawStatus
          latestDurableState = summary.durableState
          latestAssistantText = summary.latestAssistantText
          latestAssistantPreview = summary.latestAssistantPreview
          latestToolCallCount = summary.toolCallCount
          latestErrorCount = summary.errorCount
          const nextIdleMissingAssistantMessageId =
            getIdleMissingAssistantMessageId(summary)
          if (nextIdleMissingAssistantMessageId) {
            idleMissingAssistantConfirmations =
              idleMissingAssistantMessageId === nextIdleMissingAssistantMessageId
                ? idleMissingAssistantConfirmations + 1
                : 1
            idleMissingAssistantMessageId = nextIdleMissingAssistantMessageId
          } else {
            idleMissingAssistantMessageId = null
            idleMissingAssistantConfirmations = 0
          }

          // Message reconciliation can infer retrying from provider payloads even
          // when the status endpoint returns a legacy or incomplete value.
          if (summary.durableState === 'retrying') {
            startNativeFailureProbe()
          }

          if (
            summary.durableState === 'idle'
            && isSettledProbeAssistantTurn(summary)
            && (
              isExpectedProbeOutput(
                summary.latestAssistantText,
                expectedOutput,
                params.requireExactOutput === true,
              )
              || isExpectedProbeOutput(
                summary.latestAssistantPreview,
                expectedOutput,
                params.requireExactOutput === true,
              )
            )
          ) {
            sessionRequiresCleanup = false
            return finishObservedAssistantResult({
              providerId: 'opencode',
              modelId: params.selectedModel,
              probePrompt: prompt,
              expectedOutput,
              outcome: 'available',
              reason: null,
              durationMs: buildDurationMs(startedAtMs),
              rawStatus: summary.rawStatus,
              durableState: summary.durableState,
              latestAssistantText: summary.latestAssistantText,
              latestAssistantPreview: summary.latestAssistantPreview,
              toolCallCount: summary.toolCallCount,
              errorCount: summary.errorCount,
              diagnostics: Array.from(diagnostics),
              verifiedAt: new Date().toISOString(),
            }, summary)
          }

          const latestAssistantError = getLatestAssistantMessageError(
            Array.from(diagnostics),
            messages,
          )
          const failureMessage =
            latestAssistantError
            ?? summary.latestAssistantPreview
            ?? summary.latestAssistantText
            ?? null
          const freeTierFailure = classifyFreeTierRestrictedAssistantError(messages)
          const eagerFailure: ProbeFailureClassification | null = freeTierFailure
            ?? (failureMessage
              && (latestAssistantError || summary.durableState === 'retrying')
              ? classifyProbeFailure({ message: failureMessage })
              : null)
          if (eagerFailure && eagerFailure.outcome !== 'unknown') {
            if (summary.durableState === 'idle') sessionRequiresCleanup = false
            diagnostics.add(
              `OpenCode retry/error payload exposed a terminal provider failure before polling completed in ${Math.max(0, nowMs() - executionPollStartedAtMs)}ms`,
            )
            return finish({
              providerId: 'opencode',
              modelId: params.selectedModel,
              probePrompt: prompt,
              expectedOutput,
              outcome: eagerFailure.outcome,
              reason: eagerFailure.reason,
              ...(eagerFailure.failureCode ? { failureCode: eagerFailure.failureCode } : {}),
              durationMs: buildDurationMs(startedAtMs),
              rawStatus: summary.rawStatus,
              durableState: summary.durableState,
              latestAssistantText: summary.latestAssistantText,
              latestAssistantPreview: summary.latestAssistantPreview,
              toolCallCount: summary.toolCallCount,
              errorCount: Math.max(1, summary.errorCount),
              diagnostics: Array.from(diagnostics),
            })
          }
          // A rejected tool call can still end the turn without text when OpenCode blocks
          // parallel pending calls; then nothing more will arrive, so do not wait for the deadline.
          idleAfterRejectedPermissionConfirmations =
            rejectedProbePermissions > 0 && summary.durableState === 'idle' && !failureMessage
              ? idleAfterRejectedPermissionConfirmations + 1
              : 0
          if (
            rejectedProbePermissions > 0
            && !failureMessage
            && (hasCompletedAssistantResponseWithoutText(summary)
              || idleAfterRejectedPermissionConfirmations
                >= OPEN_CODE_EXECUTION_PROBE_IDLE_MISSING_ASSISTANT_CONFIRMATIONS)
          ) {
            sessionRequiresCleanup = false
            const reason =
              'OpenCode model verification ended after the model tried to use a tool instead of answering'
            diagnostics.add(
              `${reason}; ${rejectedProbePermissions} tool permission request(s) were rejected`,
            )
            return finish({
              providerId: 'opencode',
              modelId: params.selectedModel,
              probePrompt: prompt,
              expectedOutput,
              outcome: 'unknown',
              reason,
              durationMs: buildDurationMs(startedAtMs),
              rawStatus: summary.rawStatus,
              durableState: summary.durableState,
              latestAssistantText: summary.latestAssistantText,
              latestAssistantPreview: summary.latestAssistantPreview,
              toolCallCount: summary.toolCallCount,
              errorCount: summary.errorCount,
              diagnostics: Array.from(diagnostics),
            })
          }
          if (!failureMessage && hasCompletedAssistantResponseWithoutText(summary)) {
            sessionRequiresCleanup = false
            const reason = 'OpenCode model verification completed without assistant output'
            diagnostics.add(reason)
            return finish({
              providerId: 'opencode',
              modelId: params.selectedModel,
              probePrompt: prompt,
              expectedOutput,
              outcome: 'unknown',
              reason,
              durationMs: buildDurationMs(startedAtMs),
              rawStatus: summary.rawStatus,
              durableState: summary.durableState,
              latestAssistantText: summary.latestAssistantText,
              latestAssistantPreview: summary.latestAssistantPreview,
              toolCallCount: summary.toolCallCount,
              errorCount: summary.errorCount,
              diagnostics: Array.from(diagnostics),
            })
          }
          if (
            !failureMessage
            && idleMissingAssistantConfirmations
              >= OPEN_CODE_EXECUTION_PROBE_IDLE_MISSING_ASSISTANT_CONFIRMATIONS
          ) {
            sessionRequiresCleanup = false
            const reason =
              'OpenCode model verification became idle without producing an assistant response'
            diagnostics.add(
              `${reason} after ${idleMissingAssistantConfirmations} consecutive observations`,
            )
            return finish({
              providerId: 'opencode',
              modelId: params.selectedModel,
              probePrompt: prompt,
              expectedOutput,
              outcome: 'unknown',
              reason,
              durationMs: buildDurationMs(startedAtMs),
              rawStatus: summary.rawStatus,
              durableState: summary.durableState,
              latestAssistantText: summary.latestAssistantText,
              latestAssistantPreview: summary.latestAssistantPreview,
              toolCallCount: summary.toolCallCount,
              errorCount: summary.errorCount,
              diagnostics: Array.from(diagnostics),
            })
          }
          const shouldContinuePolling =
            (!isSettledProbeAssistantTurn(summary)
              || summary.durableState === 'running'
              || summary.durableState === 'retrying'
              || summary.durableState === 'reply_pending'
              || (summary.durableState === 'idle' && !failureMessage)
              || (summary.durableState === 'unknown' && !failureMessage))
            && nowMs() < localDeadlineMs

          if (shouldContinuePolling) {
            const pollDelay = this.sleep(
              Math.min(pollIntervalMs, Math.max(0, localDeadlineMs - nowMs())),
            )
            await (nativeFailurePending
              ? Promise.race([pollDelay, nativeFailurePending])
              : pollDelay)
            continue
          }

          if (failureMessage && isSettledProbeAssistantTurn(summary)) {
            const classified: ProbeFailureClassification = freeTierFailure
              ?? classifyProbeFailure({ message: failureMessage })
            if (classified.outcome !== 'unknown') {
              diagnostics.add(
                `OpenCode assistant payload exposed a terminal provider failure after polling completed in ${Math.max(0, nowMs() - executionPollStartedAtMs)}ms`,
              )
            }

            if (summary.durableState === 'idle') sessionRequiresCleanup = false
            return finish({
              providerId: 'opencode',
              modelId: params.selectedModel,
              probePrompt: prompt,
              expectedOutput,
              outcome: classified.outcome,
              reason:
                classified.outcome === 'unknown' && summary.durableState === 'idle'
                  ? params.requireExactOutput === true
                    ? 'OpenCode exact-model execution proof was mismatched'
                    : 'OpenCode local-model execution proof was mismatched'
                  : classified.reason,
              ...(classified.failureCode ? { failureCode: classified.failureCode } : {}),
              durationMs: buildDurationMs(startedAtMs),
              rawStatus: summary.rawStatus,
              durableState: summary.durableState,
              latestAssistantText: summary.latestAssistantText,
              latestAssistantPreview: summary.latestAssistantPreview,
              toolCallCount: summary.toolCallCount,
              errorCount: summary.errorCount,
              diagnostics: Array.from(diagnostics),
            })
          }

          diagnostics.add('Model verification timed out')
          return finish({
            providerId: 'opencode',
            modelId: params.selectedModel,
            probePrompt: prompt,
            expectedOutput,
            outcome: 'unknown',
            reason: 'Model verification timed out',
            durationMs: buildDurationMs(startedAtMs),
            rawStatus: latestRawStatus,
            durableState: latestDurableState,
            latestAssistantText,
            latestAssistantPreview,
            toolCallCount: latestToolCallCount,
            errorCount: latestErrorCount,
            diagnostics: Array.from(diagnostics),
            failureCode: 'execution_timeout',
          })
        }
      }).finally(() => {
        nativeFailureController?.abort()
      })
    } finally {
      if (sessionId && (sessionRequiresCleanup || params.cleanupSuccessfulSession === true)) {
        await this.cleanupProbeSession(host, sessionId).catch(() => undefined)
      }
    }
  }
}

export const openCodeExecutionProbe = new OpenCodeExecutionProbe()
