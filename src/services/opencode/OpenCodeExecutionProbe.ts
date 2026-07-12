import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import { openCodeEventTranslator } from './OpenCodeEventTranslator.js'
import {
  createOpenCodePreflightHostLeaseInput,
  openCodeHostManager,
} from './OpenCodeHostManager.js'
import { withOpenCodeOAuthRefreshLock } from './OpenCodeAuthStore.js'
import {
  OPEN_CODE_MODEL_PROBE_AGENT_NAME,
  openCodeProfileManager,
} from './OpenCodeProfileManager.js'

import type {
  OpenCodeExecutionProbeResult,
  OpenCodeHostHandle,
  OpenCodeMessage,
  OpenCodePreparedProfile,
} from './types.js'

const OPEN_CODE_EXECUTION_PROBE_PROMPT = 'Output only the single word PONG.'
const OPEN_CODE_EXECUTION_PROBE_EXPECTED_OUTPUT = 'PONG'
const OPEN_CODE_EXECUTION_PROBE_TIMEOUT_MS = 120_000
const OPEN_CODE_EXECUTION_PROBE_POLL_INTERVAL_MS = 500
const OPEN_CODE_EXECUTION_PROBE_SUCCESS_CACHE_TTL_MS = 10 * 60_000
const OPEN_CODE_EXECUTION_PROBE_RATE_LIMIT_CACHE_TTL_MS = 60_000
const OPEN_CODE_EXECUTION_PROBE_LOCK_STALE_GRACE_MS = 15_000
const OPEN_CODE_EXECUTION_PROBE_OUTPUT_TOKEN_LIMIT = 512
const OPEN_CODE_EXECUTION_PROBE_CONTEXT_TOKEN_LIMIT = 32_000
const OPEN_CODE_NATIVE_SUBSCRIPTION_PROBE_CONTEXT_TOKEN_LIMIT = 262_144

type OpenCodeExecutionProbeDeps = {
  hostManager?: Pick<typeof openCodeHostManager, 'ensureHost' | 'releaseHost'>
    & Partial<Pick<typeof openCodeHostManager, 'retainHostLease' | 'releaseHostLease'>>
  clientFactory?: Pick<typeof openCodeClientFactory, 'create'>
  eventTranslator?: Pick<typeof openCodeEventTranslator, 'reconcileSessionMessages'>
  prepareProfile?: (projectPath?: string | null) => Promise<OpenCodePreparedProfile>
  sleep?: (ms: number) => Promise<void>
  probeTimeoutMs?: number
  pollIntervalMs?: number
  persistentCache?: boolean
  persistentCacheRoot?: string
  fanOutOAuthCredential?: (input: {
    providerId: string
    sourceAuthPath: string
  }) => Promise<void>
  withOAuthRefreshLock?: typeof withOpenCodeOAuthRefreshLock
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
  bypassCache?: boolean
  disposeHostOnRelease?: boolean
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
  for (const key of ['error', 'data', 'responseBody', 'body']) {
    const candidate = extractNestedErrorMessage(record[key], depth + 1)
    if (candidate) {
      return candidate
    }
  }

  return null
}

function classifyProbeFailure(params: {
  message: string
}): Pick<OpenCodeExecutionProbeResult, 'outcome' | 'reason'> {
  const reason = normalizeFailureMessage(params.message)
  const lower = reason.toLowerCase()

  if (
    lower.includes('token refresh failed')
    || lower.includes('authentication failed')
    || lower.includes('authentication required')
    || lower.includes('auth failed')
    || lower.includes('not logged in')
    || lower.includes('please run \'agent login\'')
    || lower.includes('please run `kiro-cli login`')
    || lower.includes('cursor_api_key')
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
    || lower.includes('model not found')
    || lower.includes('unknown model')
    || lower.includes('invalid model')
    || lower.includes('not available for your account')
    || lower.includes('rate limit')
    || lower.includes('usage limit')
    || lower.includes('too many requests')
    || lower.includes('freeusagelimit')
    || /\b429\b/.test(lower)
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

function getLatestAssistantMessageError(messages: OpenCodeExecutionProbeResult['diagnostics'], rawMessages: OpenCodeMessage[]): string | null {
  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const candidate = rawMessages[index]
    const info = candidate.info
    if (!info || info.role !== 'assistant' || typeof info !== 'object') {
      continue
    }
    const error = typeof info.error === 'object' && info.error !== null
      ? info.error as Record<string, unknown>
      : null
    const data = error && typeof error.data === 'object' && error.data !== null
      ? error.data as Record<string, unknown>
      : null
    const message = extractNestedErrorMessage(error) ?? extractNestedErrorMessage(data)
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
  if (
    lower.includes('rate limit')
    || lower.includes('usage limit')
    || lower.includes('too many requests')
    || lower.includes('freeusagelimit')
    || /\b429\b/.test(lower)
  ) {
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
  private readonly inFlightProbes = new Map<string, Promise<OpenCodeExecutionProbeResult>>()
  private readonly probeCache = new Map<
    string,
    { expiresAtMs: number, result: OpenCodeExecutionProbeResult }
  >()

  constructor(private readonly deps: OpenCodeExecutionProbeDeps = {}) {}

  private get hostManager() {
    return this.deps.hostManager ?? openCodeHostManager
  }

  private get clientFactory() {
    return this.deps.clientFactory ?? openCodeClientFactory
  }

  private get eventTranslator() {
    return this.deps.eventTranslator ?? openCodeEventTranslator
  }

  private get sleep() {
    return this.deps.sleep ?? sleep
  }

  private get persistentCacheEnabled() {
    return this.deps.persistentCache ?? (this.deps.clientFactory == null)
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
        return cloneProbeResult(await inFlight)
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
        if (!params.bypassCache && this.inFlightProbes.get(cacheKey) === request) {
          this.inFlightProbes.delete(cacheKey)
        }
      })

    if (!params.bypassCache) {
      this.inFlightProbes.set(cacheKey, request)
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

    const host = await this.hostManager.ensureHost({
      projectPath: params.projectPath,
      profileOptions: {
        includeAppMcp: false,
        modelOutputLimitOverrides: [
          {
            modelId: params.selectedModel,
            outputTokens: OPEN_CODE_EXECUTION_PROBE_OUTPUT_TOKEN_LIMIT,
            contextTokens: resolveOpenCodeExecutionProbeContextTokens(params.selectedModel),
          },
        ],
      },
      hostLifetime: params.disposeHostOnRelease === false ? 'persistent' : 'process',
    })
    const preflightLease = createOpenCodePreflightHostLeaseInput(
      `model-probe-${params.selectedModel}`,
    )
    await this.hostManager.retainHostLease?.(host.hostKey, preflightLease).catch(() => undefined)

    try {
      const cachePaths = this.persistentCacheEnabled && !params.bypassCache
        ? getPersistentProbeCachePaths({
          cacheKey: params.cacheKey ?? buildProbeCacheKey(params),
          host,
          rootDir: this.deps.persistentCacheRoot,
        })
        : null
      if (cachePaths) {
        const cached = await readPersistentProbeCache(cachePaths.cacheFilePath)
        if (cached) {
          return cached
        }

        const lockStaleMs = probeTimeoutMs + OPEN_CODE_EXECUTION_PROBE_LOCK_STALE_GRACE_MS
        const acquiredLock = await this.tryAcquirePersistentProbeLock(cachePaths, lockStaleMs)
        if (!acquiredLock) {
          const sharedResult = await this.waitForPersistentProbeResult(cachePaths, lockStaleMs)
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
  ): Promise<OpenCodeExecutionProbeResult | null> {
    const deadlineMs = nowMs() + timeoutMs
    while (nowMs() < deadlineMs) {
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
    return readPersistentProbeCache(cachePaths.cacheFilePath)
  }

  private async runProbeModelWithHost(input: {
    params: {
      selectedModel: string
      projectPath?: string | null
      prompt?: string
      expectedOutput?: string
    }
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
    if (providerId !== 'xai') {
      return this.runProbeModelWithHostUnlocked(input)
    }

    const withOAuthRefreshLock = this.deps.withOAuthRefreshLock
      ?? withOpenCodeOAuthRefreshLock
    return withOAuthRefreshLock({
      authPath: input.host.profile.managedAuthPath,
      providerId,
      operation: () => this.runProbeModelWithHostUnlocked(input),
    })
  }

  private async runProbeModelWithHostUnlocked(input: {
    params: {
      selectedModel: string
      projectPath?: string | null
      prompt?: string
      expectedOutput?: string
    }
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
      if (parseProviderScopedModel(params.selectedModel).providerID === 'xai') {
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

    {
      const client = this.clientFactory.create(host.baseUrl)
      const session = await client.createSession({
        title: `probe:${params.selectedModel}`,
      })
      const probeMessage = {
        agent: OPEN_CODE_MODEL_PROBE_AGENT_NAME,
        model: parseProviderScopedModel(params.selectedModel),
        parts: [{ type: 'text', text: prompt }],
      }

      try {
        await client.promptSessionAsync(session.id, probeMessage)
      } catch (error) {
        const classified = classifyProbeFailure({
          message: error instanceof Error ? error.message : String(error),
        })
        return finish({
          providerId: 'opencode',
          modelId: params.selectedModel,
          probePrompt: prompt,
          expectedOutput,
          outcome: classified.outcome,
          reason: classified.reason,
          durationMs: buildDurationMs(startedAtMs),
          rawStatus: null,
          durableState: 'unknown',
          latestAssistantText: null,
          latestAssistantPreview: null,
          toolCallCount: 0,
          errorCount: 0,
          diagnostics: Array.from(diagnostics),
        })
      }

      const deadlineMs = nowMs() + probeTimeoutMs
      let latestRawStatus: OpenCodeExecutionProbeResult['rawStatus'] = null
      let latestDurableState: OpenCodeExecutionProbeResult['durableState'] = 'unknown'
      let latestAssistantText: string | null = null
      let latestAssistantPreview: string | null = null
      let latestToolCallCount = 0
      let latestErrorCount = 0

      for (;;) {
        const [statusMap, messages] = await Promise.all([
          client.getSessionStatus(),
          client.getSessionMessages(session.id),
        ])

        const rawStatus = statusMap[session.id] ?? null
        const summary = this.eventTranslator.reconcileSessionMessages({
          sessionId: session.id,
          rawStatus,
          messages,
        })
        for (const diagnostic of summary.diagnostics) {
          diagnostics.add(diagnostic)
        }
        latestRawStatus = summary.rawStatus
        latestDurableState = summary.durableState
        latestAssistantText = summary.latestAssistantText
        latestAssistantPreview = summary.latestAssistantPreview
        latestToolCallCount = summary.toolCallCount
        latestErrorCount = summary.errorCount

        if (
          summary.durableState === 'idle'
          && (isProbeSuccessOutput(summary.latestAssistantText) || isProbeSuccessOutput(summary.latestAssistantPreview))
        ) {
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
          })
        }

        const failureMessage =
          getLatestAssistantMessageError(Array.from(diagnostics), messages)
          ?? summary.latestAssistantPreview
          ?? summary.latestAssistantText
          ?? null
        const shouldContinuePolling =
          (summary.durableState === 'running'
            || summary.durableState === 'retrying'
            || summary.durableState === 'reply_pending'
            || (summary.durableState === 'idle' && !failureMessage)
            || (summary.durableState === 'unknown' && !failureMessage))
          && nowMs() < deadlineMs

        if (shouldContinuePolling) {
          await this.sleep(Math.min(pollIntervalMs, Math.max(0, deadlineMs - nowMs())))
          continue
        }

        if (!shouldContinuePolling && failureMessage) {
          const classified = classifyProbeFailure({
            message: failureMessage,
          })

          if (
            summary.durableState === 'idle'
            && classified.outcome === 'unknown'
            && (summary.latestAssistantText?.trim() || summary.latestAssistantPreview?.trim())
          ) {
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
            })
          }

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
        })
      }
    }
  }
}

export const openCodeExecutionProbe = new OpenCodeExecutionProbe()
