import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import { openCodeEventTranslator } from './OpenCodeEventTranslator.js'
import { openCodeHostManager } from './OpenCodeHostManager.js'

import type {
  OpenCodeExecutionProbeResult,
  OpenCodeMessage,
  OpenCodePreparedProfile,
} from './types.js'

const OPEN_CODE_EXECUTION_PROBE_PROMPT = 'Output only the single word PONG.'
const OPEN_CODE_EXECUTION_PROBE_EXPECTED_OUTPUT = 'PONG'
const OPEN_CODE_EXECUTION_PROBE_TIMEOUT_MS = 60_000
const OPEN_CODE_EXECUTION_PROBE_POLL_INTERVAL_MS = 500

type OpenCodeExecutionProbeDeps = {
  hostManager?: Pick<typeof openCodeHostManager, 'ensureHost' | 'releaseHost'>
  clientFactory?: Pick<typeof openCodeClientFactory, 'create'>
  eventTranslator?: Pick<typeof openCodeEventTranslator, 'reconcileSessionMessages'>
  prepareProfile?: (projectPath?: string | null) => Promise<OpenCodePreparedProfile>
  sleep?: (ms: number) => Promise<void>
  probeTimeoutMs?: number
  pollIntervalMs?: number
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

function classifyProbeFailure(params: {
  message: string
}): Pick<OpenCodeExecutionProbeResult, 'outcome' | 'reason'> {
  const reason = normalizeFailureMessage(params.message)
  const lower = reason.toLowerCase()

  if (
    lower.includes('token refresh failed')
    || lower.includes('authentication failed')
    || lower.includes('auth failed')
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
    const message =
      (typeof error?.message === 'string' && error.message.trim())
      || (typeof data?.message === 'string' && data.message.trim())
      || (typeof data?.error === 'string' && data.error.trim())
      || null
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

export class OpenCodeExecutionProbe {
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

  async probeModel(params: {
    selectedModel: string
    projectPath?: string | null
    prompt?: string
    expectedOutput?: string
  }): Promise<OpenCodeExecutionProbeResult> {
    const startedAtMs = nowMs()
    const prompt = params.prompt?.trim() || OPEN_CODE_EXECUTION_PROBE_PROMPT
    const expectedOutput = params.expectedOutput?.trim() || OPEN_CODE_EXECUTION_PROBE_EXPECTED_OUTPUT
    const diagnostics = new Set<string>()
    const probeTimeoutMs = Math.max(1, this.deps.probeTimeoutMs ?? OPEN_CODE_EXECUTION_PROBE_TIMEOUT_MS)
    const pollIntervalMs = Math.max(0, this.deps.pollIntervalMs ?? OPEN_CODE_EXECUTION_PROBE_POLL_INTERVAL_MS)

    const host = await this.hostManager.ensureHost({
      projectPath: params.projectPath,
    })

    try {
      const client = this.clientFactory.create(host.baseUrl)
      const session = await client.createSession({
        title: `probe:${params.selectedModel}`,
      })

      try {
        await client.sendSessionMessage(session.id, {
          agent: 'teammate',
          model: parseProviderScopedModel(params.selectedModel),
          parts: [{ type: 'text', text: prompt }],
        })
      } catch (error) {
        const classified = classifyProbeFailure({
          message: error instanceof Error ? error.message : String(error),
        })
        return {
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
        }
      }

      let latestRawStatus: OpenCodeExecutionProbeResult['rawStatus'] = null
      let latestDurableState: OpenCodeExecutionProbeResult['durableState'] = 'unknown'
      let latestAssistantText: string | null = null
      let latestAssistantPreview: string | null = null
      let latestToolCallCount = 0
      let latestErrorCount = 0
      const deadlineMs = startedAtMs + probeTimeoutMs

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
        latestRawStatus = rawStatus
        latestDurableState = summary.durableState
        latestAssistantText = summary.latestAssistantText
        latestAssistantPreview = summary.latestAssistantPreview
        latestToolCallCount = summary.toolCallCount
        latestErrorCount = summary.errorCount

        if (
          summary.durableState === 'idle'
          && (isProbeSuccessOutput(summary.latestAssistantText) || isProbeSuccessOutput(summary.latestAssistantPreview))
        ) {
          return {
            providerId: 'opencode',
            modelId: params.selectedModel,
            probePrompt: prompt,
            expectedOutput,
            outcome: 'available',
            reason: null,
            durationMs: buildDurationMs(startedAtMs),
            rawStatus,
            durableState: summary.durableState,
            latestAssistantText: summary.latestAssistantText,
            latestAssistantPreview: summary.latestAssistantPreview,
            toolCallCount: summary.toolCallCount,
            errorCount: summary.errorCount,
            diagnostics: Array.from(diagnostics),
          }
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

          return {
            providerId: 'opencode',
            modelId: params.selectedModel,
            probePrompt: prompt,
            expectedOutput,
            outcome: classified.outcome,
            reason: classified.reason,
            durationMs: buildDurationMs(startedAtMs),
            rawStatus,
            durableState: summary.durableState,
            latestAssistantText: summary.latestAssistantText,
            latestAssistantPreview: summary.latestAssistantPreview,
            toolCallCount: summary.toolCallCount,
            errorCount: summary.errorCount,
            diagnostics: Array.from(diagnostics),
          }
        }

        diagnostics.add('Model verification timed out')
        return {
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
        }
      }
    } finally {
      await this.hostManager.releaseHost(host.hostKey)
    }
  }
}

export const openCodeExecutionProbe = new OpenCodeExecutionProbe()
