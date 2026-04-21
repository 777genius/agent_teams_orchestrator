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

type OpenCodeExecutionProbeDeps = {
  hostManager?: Pick<typeof openCodeHostManager, 'ensureHost' | 'releaseHost'>
  clientFactory?: Pick<typeof openCodeClientFactory, 'create'>
  eventTranslator?: Pick<typeof openCodeEventTranslator, 'reconcileSessionMessages'>
  prepareProfile?: (projectPath?: string | null) => Promise<OpenCodePreparedProfile>
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
    lower.includes('model is not supported')
    || lower.includes('model not supported')
    || lower.includes('unsupported model')
    || lower.includes('model not available')
    || lower.includes('model unavailable')
    || lower.includes('model not found')
    || lower.includes('unknown model')
    || lower.includes('invalid model')
    || lower.includes('not available for your account')
    || lower.includes('token refresh failed')
    || lower.includes('unauthorized')
    || lower.includes('forbidden')
    || lower.includes('401')
    || lower.includes('403')
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

  async probeModel(params: {
    selectedModel: string
    projectPath?: string | null
    prompt?: string
    expectedOutput?: string
  }): Promise<OpenCodeExecutionProbeResult> {
    const startedAtMs = nowMs()
    const prompt = params.prompt?.trim() || OPEN_CODE_EXECUTION_PROBE_PROMPT
    const expectedOutput = params.expectedOutput?.trim() || OPEN_CODE_EXECUTION_PROBE_EXPECTED_OUTPUT
    const diagnostics: string[] = []

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
          diagnostics,
        }
      }

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
      diagnostics.push(...summary.diagnostics)

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
          diagnostics,
        }
      }

      const failureMessage =
        getLatestAssistantMessageError(diagnostics, messages)
        ?? summary.latestAssistantPreview
        ?? summary.latestAssistantText
        ?? `Unexpected OpenCode probe state (${summary.durableState})`
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
        diagnostics,
      }
    } finally {
      await this.hostManager.releaseHost(host.hostKey)
    }
  }
}

export const openCodeExecutionProbe = new OpenCodeExecutionProbe()
