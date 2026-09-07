import { assertTrustedOpenCodeCustody, type OpenCodeHostAcquisitionPolicy, type TrustedOpenCodeCustody } from './OpenCodeSupervisedHostCustody.js'
import { isOpenCodeHostManagerBoundToCustody } from './OpenCodeHostManager.js'
import { isOpenCodeClientFactoryBoundToCustody } from './OpenCodeClientFactory.js'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import { withTimeout } from '../../utils/sleep.js'
import { openCodeClientFactory } from './OpenCodeClientFactory.js'
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
import { withOpenCodeOAuthRefreshLock } from './OpenCodeAuthStore.js'
import { buildOpenCodeRuntimePromptMessageId } from './OpenCodeMessageIds.js'
import {
  ensureOpenCodeNativeCliCredentialBridge,
  OPEN_CODE_MODEL_PROBE_AGENT_NAME,
  openCodeProfileManager,
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
const OPEN_CODE_EXECUTION_PROBE_SUCCESS_CACHE_TTL_MS = 40_000
const OPEN_CODE_EXECUTION_PROBE_RATE_LIMIT_CACHE_TTL_MS = 60_000
const OPEN_CODE_EXECUTION_PROBE_LOCK_STALE_GRACE_MS = 15_000
const OPEN_CODE_EXECUTION_PROBE_MAX_SHARED_WORK_MS = 300_000
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
  acquisitionPolicy?: OpenCodeHostAcquisitionPolicy
  hostManager?: Pick<
    typeof openCodeHostManager,
    'ensureHost' | 'releaseHost' | 'releaseHostLease'
  >
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

type ProbeCacheFile = {
  version: 1
  expiresAtMs: number
  result: OpenCodeExecutionProbeResult
}

type PersistentProbeCachePaths = {
  cacheFilePath: string
  lockDirPath: string
}

type ProbeModelParams = {
  selectedModel: string
  projectPath?: string | null
  prompt?: string
  expectedOutput?: string
  contextTokens?: number
  outputTokens?: number
  bypassCache?: boolean
  disposeHostOnRelease?: boolean
  runtimeDeadline?: OpenCodeRuntimeDeadline
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
  if (
    summary.rawStatus !== 'idle'
    || summary.durableState !== 'reply_pending'
    || !summary.replyPendingSinceMessageId
  ) {
    return null
  }
  return summary.replyPendingSinceMessageId
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

function normalizeFailureMessage(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return 'OpenCode model execution probe failed'
  }
  return trimmed
}

function isUsageLimitFailureMessage(lower: string): boolean {
  return lower.includes('too many requests')
    || /\b(?:rate|usage)[\s_-]*limit(?:error)?\b/.test(lower)
    || /\bresource[\s_-]*exhausted(?:error)?\b/.test(lower)
    || /\bfree[\s_-]*usage[\s_-]*(?:limit|exceeded)(?:error)?\b/.test(lower)
    || /\bquota[\s_-]*exceeded(?:error)?\b/.test(lower)
    || /\bgrpc[\s_-]*code["']?\s*[:=]\s*["']?8\b/.test(lower)
    || /^\s*(?:error\s*[:=-]?\s*)?429\b/m.test(lower)
    || /\b(?:http(?:[\s_-]*status)?|status(?:[\s_-]*code)?|error(?:[\s_-]*code)?|code)["']?\s*(?::|=|is|of)?\s*["']?429\b/.test(lower)
    || /\b429\s+(?:too many requests|rate limit(?:ed)?|resource exhausted)\b/.test(lower)
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
  const lower = reason.toLowerCase()

  // Provider quota markers are more specific than an accompanying HTTP 401/403.
  // Some gateways wrap RESOURCE_EXHAUSTED in a generic forbidden response.
  if (isUsageLimitFailureMessage(lower)) {
    return {
      outcome: 'unavailable',
      reason,
    }
  }

  if (
    lower.includes('token refresh failed')
    || lower.includes('authentication failed')
    || lower.includes('authentication required')
    || lower.includes('auth failed')
    || lower.includes('not logged in')
    || lower.includes('please run \'agent login\'')
    || lower.includes('please run `kiro-cli login`')
    || lower.includes('cursor_api_key')
    || /\binvalid[\s_-]+api[\s_-]*key\b/.test(lower)
    || /\bapi[\s_-]*key\s+(?:is\s+)?(?:invalid|not\s+valid|expired|revoked)\b/.test(lower)
    || lower.includes('unauthorized')
    || lower.includes('forbidden')
    || /\b401\b/.test(lower)
    || /\b403\b/.test(lower)
  ) {
    return {
      outcome: 'not_authenticated',
      reason,
    }
  }

  if (
    lower.includes('model is not supported')
    || lower.includes('model not supported')
    || lower.includes('unsupported model')
    || lower.includes('model not available')
    || lower.includes('model unavailable')
    || lower.includes('model is no longer available')
    || (lower.includes('model') && lower.includes('no longer available to new users'))
    || lower.includes('model not found')
    || lower.includes('unknown model')
    || lower.includes('invalid model')
    || lower.includes('not available for your account')
  ) {
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
      `Cursor native execution probe confirmed model availability in ${nativeResult.durationMs}ms`,
    )
    return {
      providerId: 'opencode',
      modelId: input.selectedModel,
      probePrompt: input.prompt,
      expectedOutput: input.expectedOutput,
      outcome: 'available',
      reason: null,
      durationMs: buildDurationMs(input.startedAtMs),
      rawStatus: null,
      durableState: 'idle',
      latestAssistantText: null,
      latestAssistantPreview: null,
      toolCallCount: 0,
      errorCount: 0,
      diagnostics: Array.from(diagnostics),
      verifiedAt: new Date().toISOString(),
    }
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
  if (isUsageLimitFailureMessage(message.toLowerCase())) return 3
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
    if (candidate === 429 || candidate === '429') {
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

function buildProbeCacheKey(params: ProbeModelParams): string {
  return [
    params.projectPath?.trim() || '<default-project>',
    params.selectedModel.trim(),
    params.prompt?.trim() || OPEN_CODE_EXECUTION_PROBE_PROMPT,
    params.expectedOutput?.trim() || OPEN_CODE_EXECUTION_PROBE_EXPECTED_OUTPUT,
    String(params.contextTokens ?? ''),
    String(params.outputTokens ?? ''),
    params.cursorNativePreflightBeforeHost === true ? 'native-before-host' : 'host-first',
    params.cursorNativePreflightOnly === true ? 'native-only' : 'opencode-fallback',
  ].join('\u0000')
}

function cloneProbeResult(result: OpenCodeExecutionProbeResult): OpenCodeExecutionProbeResult {
  return {
    ...result,
    diagnostics: [...result.diagnostics],
  }
}

function getProbeResultCacheTtlMs(result: OpenCodeExecutionProbeResult): number {
  if (result.outcome === 'available') {
    return OPEN_CODE_EXECUTION_PROBE_SUCCESS_CACHE_TTL_MS
  }
  const lower = `${result.reason ?? ''} ${result.diagnostics.join(' ')}`.toLowerCase()
  if (result.outcome === 'unavailable' && isUsageLimitFailureMessage(lower)) {
    return OPEN_CODE_EXECUTION_PROBE_RATE_LIMIT_CACHE_TTL_MS
  }
  return 0
}

function hashProbeCacheKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function buildPersistentProbeCacheKey(cacheKey: string, host: OpenCodeHostHandle): string {
  // The resolved host config contains runtime-only values that can change when
  // the app MCP attachment or a local provider proxy is refreshed. The managed
  // config/auth fingerprints already cover durable launch inputs, so including
  // the resolved fingerprint made a successful wizard probe invisible to the
  // later teammate launch process.
  return [
    cacheKey,
    host.profile.profileRootKey,
    host.profile.projectBehaviorFingerprint,
    host.profile.managedAuthFingerprint ?? 'no-auth',
    host.profile.managedConfigFingerprint,
    host.version ?? 'unknown-version',
  ].join('\u0000')
}

function getPersistentProbeCachePaths(
  params: {
    cacheKey: string
    host: OpenCodeHostHandle
    rootDir?: string
  },
): PersistentProbeCachePaths {
  const rootDir = params.rootDir?.trim()
    || path.join(params.host.profile.profileRootPath, '.agent-teams-cache')
  const cacheDir = path.join(rootDir, 'execution-probes')
  const keyHash = hashProbeCacheKey(buildPersistentProbeCacheKey(params.cacheKey, params.host))
  return {
    cacheFilePath: path.join(cacheDir, `${keyHash}.json`),
    lockDirPath: path.join(cacheDir, `${keyHash}.lock`),
  }
}

function isProbeCacheFile(value: unknown): value is ProbeCacheFile {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  const result = record.result as Partial<OpenCodeExecutionProbeResult> | undefined
  if (!result || typeof result !== 'object') {
    return false
  }
  return (
    record.version === 1
    && typeof record.expiresAtMs === 'number'
    && Number.isFinite(record.expiresAtMs)
    && result.providerId === 'opencode'
    && typeof result.modelId === 'string'
    && (result.outcome === 'available'
      || result.outcome === 'unavailable'
      || result.outcome === 'not_authenticated'
      || result.outcome === 'unknown')
    && Array.isArray(result.diagnostics)
  )
}

async function readPersistentProbeCache(
  cacheFilePath: string,
): Promise<OpenCodeExecutionProbeResult | null> {
  try {
    const parsed = JSON.parse(await readFile(cacheFilePath, 'utf8')) as unknown
    if (!isProbeCacheFile(parsed)) {
      return null
    }
    if (parsed.expiresAtMs <= nowMs()) {
      await rm(cacheFilePath, { force: true }).catch(() => undefined)
      return null
    }
    return cloneProbeResult(parsed.result)
  } catch {
    return null
  }
}

async function writePersistentProbeCache(
  cacheFilePath: string,
  result: OpenCodeExecutionProbeResult,
  ttlMs: number,
): Promise<void> {
  if (ttlMs <= 0) {
    return
  }
  const cacheFile: ProbeCacheFile = {
    version: 1,
    expiresAtMs: nowMs() + ttlMs,
    result: cloneProbeResult(result),
  }
  await writeFileAtomic(cacheFilePath, `${JSON.stringify(cacheFile)}\n`)
}

export class OpenCodeExecutionProbe {
  private readonly inFlightProbes = new Map<string, {
    promise: Promise<OpenCodeExecutionProbeResult>
    deadlineAtMs: number | null
  }>()
  private readonly probeCache = new Map<
    string,
    { expiresAtMs: number, result: OpenCodeExecutionProbeResult }
  >()

  private readonly deps: OpenCodeExecutionProbeDeps
  private readonly custody?: TrustedOpenCodeCustody
  constructor(deps: OpenCodeExecutionProbeDeps = {}) {
    const policy = deps.acquisitionPolicy
    if (policy?.mode === 'supervisor-adopt-only') {
      const custody = policy.custody
      assertTrustedOpenCodeCustody(custody)
      if (new.target !== OpenCodeExecutionProbe) throw new Error('OpenCode supervised probe implementation substituted')
      if (!deps.hostManager || !isOpenCodeHostManagerBoundToCustody(deps.hostManager, custody) ||
        !deps.clientFactory || !isOpenCodeClientFactoryBoundToCustody(deps.clientFactory, custody) ||
        deps.prepareProfile || deps.fanOutOAuthCredential || deps.withOAuthRefreshLock ||
        deps.cursorNativeFailureProbe || deps.persistentCache || deps.persistentCacheRoot) {
        throw new Error('OpenCode supervised execution requires custody-bound consumers')
      }
      this.custody = custody
      const hosts = deps.hostManager, clients = deps.clientFactory
      const translator = deps.eventTranslator ?? openCodeEventTranslator
      this.deps = Object.freeze({ ...deps,
        acquisitionPolicy: Object.freeze({ mode: 'supervisor-adopt-only', custody }),
        hostManager: Object.freeze({ ensureHost: hosts.ensureHost.bind(hosts),
          releaseHost: hosts.releaseHost.bind(hosts), releaseHostLease: hosts.releaseHostLease.bind(hosts) }),
        clientFactory: Object.freeze({ create: clients.create.bind(clients) }),
        eventTranslator: Object.freeze({ reconcileSessionMessages: translator.reconcileSessionMessages.bind(translator) }),
        persistentCache: false,
      })
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(OpenCodeExecutionProbe.prototype))) {
        if (name === 'constructor') continue
        if (typeof descriptor.value === 'function') {
          Object.defineProperty(this, name, { value: descriptor.value.bind(this) })
        } else if (descriptor.get) {
          Object.defineProperty(this, name, { get: descriptor.get.bind(this) })
        }
      }
      Object.freeze(this)
    } else this.deps = deps
  }

  private async prepareProbeProfile(
    params: ProbeModelParams,
    context?: OpenCodePhaseContext,
  ): Promise<OpenCodePreparedProfile> {
    if (this.custody) {
      context?.throwIfExpired()
      if (params.projectPath && params.projectPath !== this.custody.expected.profile.projectPath) {
        throw new Error('OpenCode supervised execution project mismatch')
      }
      // The supervisor owns profile construction and credentials. The probe
      // uses the same retained profile as sessions and approval effects.
      return this.custody.readPreparedProfile()
    }
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
    if (this.custody) return null
    // Custom clients are hermetic unit/fixture probes. The production singleton
    // gets the native Cursor fallback unless a test explicitly injects one.
    if (this.deps.cursorNativeFailureProbe) return this.deps.cursorNativeFailureProbe
    if (process.env[OPEN_CODE_CURSOR_NATIVE_FAILURE_PROBE_DISABLED_ENV] === '1') return null
    return this.deps.clientFactory == null ? openCodeCursorNativeFailureProbe : null
  }

  private get sleep() {
    return this.deps.sleep ?? sleep
  }

  private get persistentCacheEnabled() {
    return this.deps.persistentCache ?? (this.deps.clientFactory == null)
  }

  private runPhase<T>(
    deadline: OpenCodeRuntimeDeadline | undefined,
    phase: OpenCodePhaseContext['phase'],
    operation: (context?: OpenCodePhaseContext) => Promise<T>,
  ): Promise<T> {
    return deadline
      ? deadline.runPhase(phase, context => operation(context))
      : operation(undefined)
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
    const cacheKey = buildProbeCacheKey(params)
    let shouldRegisterInFlight = !params.bypassCache
    if (!params.bypassCache) {
      const cached = this.probeCache.get(cacheKey)
      if (cached && cached.expiresAtMs > nowMs()) {
        return cloneProbeResult(cached.result)
      }
      if (cached) {
        this.probeCache.delete(cacheKey)
      }

      const inFlight = this.inFlightProbes.get(cacheKey)
      if (inFlight) {
        const callerDeadlineAtMs = params.runtimeDeadline
          ? performance.now() + params.runtimeDeadline.remainingMs()
          : null
        const ownerDeadlineCoversCaller = inFlight.deadlineAtMs === null
          || (
            callerDeadlineAtMs !== null
            && inFlight.deadlineAtMs + 5 >= callerDeadlineAtMs
          )
        if (ownerDeadlineCoversCaller) {
          const joined = params.runtimeDeadline
            ? this.runPhase(params.runtimeDeadline, 'execution_poll', () => inFlight.promise)
            : inFlight.promise
          return cloneProbeResult(await joined)
        }
        // A shorter owner deadline must not abort a caller with a longer (or
        // unbounded) budget. Run independently without replacing the owner.
        shouldRegisterInFlight = false
      }
    }

    const request = this.runProbeModel({ ...params, cacheKey })
      .then(result => {
        if (!params.bypassCache) {
          const ttlMs = getProbeResultCacheTtlMs(result)
          if (ttlMs > 0) {
            this.probeCache.set(cacheKey, {
              expiresAtMs: nowMs() + ttlMs,
              result: cloneProbeResult(result),
            })
          }
        }
        return result
      })
      .finally(() => {
        if (
          shouldRegisterInFlight
          && this.inFlightProbes.get(cacheKey)?.promise === request
        ) {
          this.inFlightProbes.delete(cacheKey)
        }
      })

    if (shouldRegisterInFlight) {
      this.inFlightProbes.set(cacheKey, {
        promise: request,
        deadlineAtMs: params.runtimeDeadline
          ? performance.now() + params.runtimeDeadline.remainingMs()
          : null,
      })
    }
    return cloneProbeResult(await request)
  }

  private async runProbeModel(params: ProbeModelParams & {
    cacheKey?: string
  }): Promise<OpenCodeExecutionProbeResult> {
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
    const preflightLease = this.custody?.createPreflightLease('execution') ?? createOpenCodePreflightHostLeaseInput(
      `model-probe-${params.selectedModel}`,
    )
    let host: OpenCodeHostHandle
    try {
      host = await this.runPhase(params.runtimeDeadline, 'host_start', async context => {
        hostStartupState.promise = (async () => {
          const ensuredHost = await this.hostManager.ensureHost({
            projectPath: params.projectPath,
            profileOptions: this.custody ? { toolApprovalMode: 'manual' } : {
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
            },
            ...(context ? { healthTimeoutMs: context.remainingMs() } : {}),
            ...(context ? { abortSignal: context.signal } : {}),
            hostLifetime: params.disposeHostOnRelease === false ? 'persistent' : 'process',
            lease: preflightLease,
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
      this.custody?.releasePreflightLease(preflightLease)
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
    try {
      const cachePaths = this.persistentCacheEnabled && !params.bypassCache
        ? getPersistentProbeCachePaths({
          cacheKey: params.cacheKey ?? buildProbeCacheKey(params),
          host,
          rootDir: this.deps.persistentCacheRoot,
        })
        : null
      if (cachePaths) {
        params.runtimeDeadline?.throwIfExpired('execution_submit')
        const cached = await readPersistentProbeCache(cachePaths.cacheFilePath)
        if (cached) {
          return cached
        }

        const lockStaleMs = Math.max(
          probeTimeoutMs,
          OPEN_CODE_EXECUTION_PROBE_MAX_SHARED_WORK_MS,
          params.runtimeDeadline?.commandBudgetMs ?? 0,
        ) + OPEN_CODE_EXECUTION_PROBE_LOCK_STALE_GRACE_MS
        const lockWaitMs = Math.min(
          lockStaleMs,
          params.runtimeDeadline?.remainingMs()
            ?? probeTimeoutMs + OPEN_CODE_EXECUTION_PROBE_LOCK_STALE_GRACE_MS,
        )
        const acquiredLock = await this.tryAcquirePersistentProbeLock(cachePaths, lockStaleMs)
        if (!acquiredLock) {
          const sharedResult = await this.waitForPersistentProbeResult(
            cachePaths,
            lockWaitMs,
            params.runtimeDeadline,
          )
          if (sharedResult) {
            return sharedResult
          }

          const retryLock = await this.tryAcquirePersistentProbeLock(cachePaths, lockStaleMs)
          if (retryLock) {
            try {
              return await this.runProbeModelWithHost({
                params,
                host,
                startedAtMs,
                prompt,
                expectedOutput,
                probeTimeoutMs,
                pollIntervalMs,
                diagnostics,
                cacheFilePath: cachePaths.cacheFilePath,
              })
            } finally {
              await rm(cachePaths.lockDirPath, { recursive: true, force: true }).catch(() =>
                undefined
              )
            }
          }

          return {
            providerId: 'opencode',
            modelId: params.selectedModel,
            probePrompt: prompt,
            expectedOutput,
            outcome: 'unknown',
            reason: 'OpenCode selected model verification is already in progress',
            durationMs: buildDurationMs(startedAtMs),
            rawStatus: null,
            durableState: 'unknown',
            latestAssistantText: null,
            latestAssistantPreview: null,
            toolCallCount: 0,
            errorCount: 0,
            diagnostics: [
              'OpenCode selected model verification is already in progress; retry shortly',
            ],
          }
        } else {
          try {
            return await this.runProbeModelWithHost({
              params,
              host,
              startedAtMs,
              prompt,
              expectedOutput,
              probeTimeoutMs,
              pollIntervalMs,
              diagnostics,
              cacheFilePath: cachePaths.cacheFilePath,
            })
          } finally {
            await rm(cachePaths.lockDirPath, { recursive: true, force: true }).catch(() =>
              undefined
            )
          }
        }
      }

      return await this.runProbeModelWithHost({
        params,
        host,
        startedAtMs,
        prompt,
        expectedOutput,
        probeTimeoutMs,
        pollIntervalMs,
        diagnostics,
        cacheFilePath: null,
      })
    } finally {
      this.custody?.releasePreflightLease(preflightLease)
      await this.hostManager.releaseHostLease?.(host.hostKey, preflightLease).catch(() => undefined)
      if (params.disposeHostOnRelease !== false) {
        await this.hostManager.releaseHost(host.hostKey)
      }
    }
  }

  private async tryAcquirePersistentProbeLock(
    cachePaths: PersistentProbeCachePaths,
    staleMs: number,
  ): Promise<boolean> {
    try {
      await mkdir(path.dirname(cachePaths.lockDirPath), { recursive: true })
      await mkdir(cachePaths.lockDirPath)
      return true
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code !== 'EEXIST') {
        return false
      }
    }

    try {
      const lockStat = await stat(cachePaths.lockDirPath)
      if (nowMs() - lockStat.mtimeMs > staleMs) {
        await rm(cachePaths.lockDirPath, { recursive: true, force: true })
        await mkdir(cachePaths.lockDirPath)
        return true
      }
    } catch {
      return false
    }

    return false
  }

  private async waitForPersistentProbeResult(
    cachePaths: PersistentProbeCachePaths,
    timeoutMs: number,
    runtimeDeadline?: OpenCodeRuntimeDeadline,
  ): Promise<OpenCodeExecutionProbeResult | null> {
    runtimeDeadline?.throwIfExpired('execution_submit')
    const deadlineMs = nowMs() + Math.min(
      timeoutMs,
      runtimeDeadline?.remainingMs() ?? timeoutMs,
    )
    while (nowMs() < deadlineMs) {
      runtimeDeadline?.throwIfExpired('execution_submit')
      const cached = await readPersistentProbeCache(cachePaths.cacheFilePath)
      if (cached) {
        return cached
      }
      try {
        await stat(cachePaths.lockDirPath)
      } catch {
        return null
      }
      await this.sleep(
        Math.min(OPEN_CODE_EXECUTION_PROBE_POLL_INTERVAL_MS, Math.max(0, deadlineMs - nowMs())),
      )
    }
    runtimeDeadline?.throwIfExpired('execution_submit')
    return readPersistentProbeCache(cachePaths.cacheFilePath)
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
    cacheFilePath: string | null
  }): Promise<OpenCodeExecutionProbeResult> {
    const providerId = parseProviderScopedModel(input.params.selectedModel).providerID
    if (this.custody || providerId !== 'xai') {
      return this.runProbeModelWithHostUnlocked(input)
    }

    const withOAuthRefreshLock = this.deps.withOAuthRefreshLock
      ?? withOpenCodeOAuthRefreshLock
    input.params.runtimeDeadline?.throwIfExpired('execution_submit')
    return withOAuthRefreshLock({
      authPath: input.host.profile.managedAuthPath,
      providerId,
      abortSignal: input.params.runtimeDeadline?.signal,
      operation: () => this.runProbeModelWithHostUnlocked(input),
    })
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
    cacheFilePath: string | null
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
      cacheFilePath,
    } = input
    const finish = async (
      result: OpenCodeExecutionProbeResult,
    ): Promise<OpenCodeExecutionProbeResult> => {
      if (!this.custody && parseProviderScopedModel(params.selectedModel).providerID === 'xai') {
        await this.fanOutOAuthCredential({
          providerId: 'xai',
          sourceAuthPath: host.profile.managedAuthPath,
        }).catch(error => {
          result.diagnostics.push(
            `OpenCode xAI OAuth credential sync failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
      }
      if (cacheFilePath) {
        await writePersistentProbeCache(
          cacheFilePath,
          result,
          getProbeResultCacheTtlMs(result),
        ).catch(() => undefined)
      }
      return result
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
        nativeFailurePending = nativeFailureProbe.probe({
          selectedModel: params.selectedModel,
          // Quota/auth is account-scoped. Keep this auxiliary request out of
          // the user project so project rules and tools cannot affect it.
          projectPath: host.profile.tmpPath,
          env: host.profile.env,
          signal: nativeFailureController.signal,
        }).then(result => {
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
              return finish({
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
              })
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
            && (
              isProbeSuccessOutput(summary.latestAssistantText)
              || isProbeSuccessOutput(summary.latestAssistantPreview)
            )
          ) {
            sessionRequiresCleanup = false
            return finish({
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
            })
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
          const eagerFailure = failureMessage
            && (latestAssistantError || summary.durableState === 'retrying')
            ? classifyProbeFailure({ message: failureMessage })
            : null
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
            (summary.durableState === 'running'
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

          if (failureMessage) {
            const classified = classifyProbeFailure({ message: failureMessage })
            if (classified.outcome !== 'unknown') {
              diagnostics.add(
                `OpenCode assistant payload exposed a terminal provider failure after polling completed in ${Math.max(0, nowMs() - executionPollStartedAtMs)}ms`,
              )
            }
            if (
              summary.durableState === 'idle'
              && classified.outcome === 'unknown'
              && (summary.latestAssistantText?.trim() || summary.latestAssistantPreview?.trim())
            ) {
              sessionRequiresCleanup = false
              diagnostics.add(
                'Model verification completed with non-matching assistant output; treating non-empty response as execution proof',
              )
              return finish({
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
              })
            }

            if (summary.durableState === 'idle') sessionRequiresCleanup = false
            return finish({
              providerId: 'opencode',
              modelId: params.selectedModel,
              probePrompt: prompt,
              expectedOutput,
              outcome: classified.outcome,
              reason: classified.reason,
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
      if (sessionId && sessionRequiresCleanup) {
        await this.cleanupProbeSession(host, sessionId).catch(() => undefined)
      }
    }
  }
}

export const openCodeExecutionProbe = new OpenCodeExecutionProbe()
