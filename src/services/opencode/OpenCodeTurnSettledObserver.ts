import { randomUUID } from 'node:crypto'

import {
  readOpenCodeSseEndpoint,
  type OpenCodeSseEndpoint,
  type OpenCodeSseFetch,
} from './OpenCodeSseEventStream.js'
import type { OpenCodeRuntimeTurnSettledOutcome } from './OpenCodeRuntimeTurnSettledEmitter.js'
import type { OpenCodeSseEvent } from './types.js'

const DEFAULT_TURN_SETTLED_TIMEOUT_MS = 15_000
const DEFAULT_TURN_SETTLED_IDLE_TIMEOUT_MS = 2_500
const ENDPOINTS: OpenCodeSseEndpoint[] = ['/event', '/global/event']

type PromptState = 'created' | 'submitting' | 'accepted' | 'rejected'

export type OpenCodeTurnSettledSummary = {
  outcome: OpenCodeRuntimeTurnSettledOutcome
  sessionId: string
  runtimePromptMessageId: string
  turnId: string
  endpoint: OpenCodeSseEndpoint | null
  streamConnected: boolean
  observedEventCount: number
  matchedEventCount: number
  assistantActivityCount: number
  promptPersisted: boolean
  latestEventType: string | null
  latestAssistantMessageId: string | null
  diagnostics: string[]
}

export type OpenCodeTurnSettledObservation = {
  runtimePromptMessageId: string
  turnId: string
  markPromptSubmitting(): void
  markPromptAcceptedByEndpoint(): void
  markPromptRejectedByEndpoint(error: unknown): void
  waitForSettled(): Promise<OpenCodeTurnSettledSummary>
  dispose(): void
}

export interface OpenCodeTurnSettledObserverDeps {
  fetchImpl?: OpenCodeSseFetch
  now?: () => Date
  promptMessageIdFactory?: () => string
}

type ObservationState = {
  promptState: PromptState
  disposed: boolean
  streamConnected: boolean
  endpoint: OpenCodeSseEndpoint | null
  observedEventCount: number
  matchedEventCount: number
  assistantActivityCount: number
  promptPersisted: boolean
  latestEventType: string | null
  latestAssistantMessageId: string | null
  diagnostics: string[]
  terminal: OpenCodeTurnSettledSummary | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function buildPromptMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, '')}`
}

function getSessionId(properties: Record<string, unknown>): string | null {
  return (
    asString(properties.sessionID)
    ?? asString(properties.sessionId)
    ?? asString(asRecord(properties.info)?.sessionID)
    ?? asString(asRecord(properties.info)?.sessionId)
    ?? asString(asRecord(properties.part)?.sessionID)
    ?? asString(asRecord(properties.part)?.sessionId)
  )
}

function getMessageId(properties: Record<string, unknown>): string | null {
  return (
    asString(asRecord(properties.info)?.id)
    ?? asString(asRecord(properties.part)?.messageID)
    ?? asString(asRecord(properties.part)?.messageId)
    ?? asString(properties.messageID)
    ?? asString(properties.messageId)
  )
}

function getStatus(properties: Record<string, unknown>, sessionId: string): string | null {
  const direct = asString(properties.status)
  if (direct) {
    return direct
  }

  const statusRecord = asRecord(properties.status)
  if (!statusRecord) {
    return null
  }
  return asString(statusRecord[sessionId])
}

function roleFromProperties(properties: Record<string, unknown>): string | null {
  return asString(asRecord(properties.info)?.role)
}

function isAssistantActivityPartType(partType: string | null): boolean {
  return partType === 'text' ||
    partType === 'tool' ||
    partType === 'tool_use' ||
    partType === 'tool_result' ||
    partType === 'reasoning' ||
    partType === 'step-start' ||
    partType === 'step-finish' ||
    partType === 'step_start' ||
    partType === 'step_finish'
}

export class OpenCodeTurnSettledObserver {
  constructor(private readonly deps: OpenCodeTurnSettledObserverDeps = {}) {}

  observe(params: {
    baseUrl: string
    sessionId: string
    projectPath?: string | null
    runtimePromptMessageId?: string | null
    timeoutMs?: number
    idleTimeoutMs?: number
  }): OpenCodeTurnSettledObservation {
    const runtimePromptMessageId =
      params.runtimePromptMessageId?.trim() ||
      (this.deps.promptMessageIdFactory ?? buildPromptMessageId)()
    const turnId = runtimePromptMessageId
    const state: ObservationState = {
      promptState: 'created',
      disposed: false,
      streamConnected: false,
      endpoint: null,
      observedEventCount: 0,
      matchedEventCount: 0,
      assistantActivityCount: 0,
      promptPersisted: false,
      latestEventType: null,
      latestAssistantMessageId: null,
      diagnostics: [],
      terminal: null,
    }

    const timeoutMs = params.timeoutMs ?? DEFAULT_TURN_SETTLED_TIMEOUT_MS
    const idleTimeoutMs = params.idleTimeoutMs ?? DEFAULT_TURN_SETTLED_IDLE_TIMEOUT_MS
    const controller = new AbortController()
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let resolveWait: ((summary: OpenCodeTurnSettledSummary) => void) | null = null
    const waitPromise = new Promise<OpenCodeTurnSettledSummary>(resolve => {
      resolveWait = resolve
    })

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }

    const buildSummary = (
      outcome: OpenCodeRuntimeTurnSettledOutcome,
      diagnostic?: string,
    ): OpenCodeTurnSettledSummary => ({
      outcome,
      sessionId: params.sessionId,
      runtimePromptMessageId,
      turnId,
      endpoint: state.endpoint,
      streamConnected: state.streamConnected,
      observedEventCount: state.observedEventCount,
      matchedEventCount: state.matchedEventCount,
      assistantActivityCount: state.assistantActivityCount,
      promptPersisted: state.promptPersisted,
      latestEventType: state.latestEventType,
      latestAssistantMessageId: state.latestAssistantMessageId,
      diagnostics: diagnostic ? [...state.diagnostics, diagnostic] : [...state.diagnostics],
    })

    const settle = (outcome: OpenCodeRuntimeTurnSettledOutcome, diagnostic?: string) => {
      if (state.terminal) {
        return
      }
      state.terminal = buildSummary(outcome, diagnostic)
      clearIdleTimer()
      controller.abort()
      resolveWait?.(state.terminal)
    }

    const resetIdleTimer = () => {
      if (idleTimeoutMs <= 0 || state.terminal) {
        return
      }
      clearIdleTimer()
      idleTimer = setTimeout(() => {
        if (state.promptState === 'accepted' && state.assistantActivityCount > 0) {
          settle('success', `OpenCode turn settled after ${idleTimeoutMs}ms without new events`)
          return
        }
        if (state.promptState === 'accepted' && state.promptPersisted) {
          settle(
            'idle_without_assistant_activity',
            `OpenCode prompt persisted but no assistant activity was observed for ${idleTimeoutMs}ms`,
          )
        }
      }, idleTimeoutMs)
      idleTimer.unref?.()
    }

    const handleEvent = (event: OpenCodeSseEvent) => {
      if (state.terminal || state.disposed) {
        return
      }
      state.streamConnected = true
      state.observedEventCount += 1
      state.latestEventType = event.type

      if (event.type === 'server.connected' || event.type === 'server.heartbeat') {
        return
      }

      if (event.directory && params.projectPath && event.directory !== params.projectPath) {
        return
      }

      const sessionId = getSessionId(event.properties)
      if (sessionId !== params.sessionId) {
        return
      }

      state.matchedEventCount += 1
      resetIdleTimer()

      if (event.type === 'session.error') {
        settle('error', `OpenCode observed session.error for ${params.sessionId}`)
        return
      }

      if (event.type === 'session.idle') {
        if (state.promptState !== 'accepted') {
          return
        }
        settle(
          state.assistantActivityCount > 0 ? 'success' : 'idle_without_assistant_activity',
          state.assistantActivityCount > 0
            ? 'OpenCode observed deprecated session.idle after assistant activity'
            : 'OpenCode observed deprecated session.idle without assistant activity',
        )
        return
      }

      if (event.type === 'session.status') {
        const status = getStatus(event.properties, params.sessionId)
        if (status === 'idle' && state.promptState === 'accepted') {
          settle(
            state.assistantActivityCount > 0 ? 'success' : 'idle_without_assistant_activity',
            state.assistantActivityCount > 0
              ? 'OpenCode observed session.status idle after assistant activity'
              : 'OpenCode observed session.status idle without assistant activity',
          )
        }
        return
      }

      if (state.promptState !== 'submitting' && state.promptState !== 'accepted') {
        return
      }

      if (event.type === 'message.updated') {
        const messageId = getMessageId(event.properties)
        const role = roleFromProperties(event.properties)
        if (messageId === runtimePromptMessageId && role === 'user') {
          state.promptPersisted = true
          return
        }
        if (role === 'assistant') {
          state.assistantActivityCount += 1
          state.latestAssistantMessageId = messageId
        }
        return
      }

      if (event.type === 'message.part.updated') {
        const messageId = getMessageId(event.properties)
        if (messageId === runtimePromptMessageId) {
          return
        }
        const partType = asString(asRecord(event.properties.part)?.type)
        if (isAssistantActivityPartType(partType)) {
          state.assistantActivityCount += 1
          state.latestAssistantMessageId = messageId
        }
      }
    }

    const run = async () => {
      const timeoutTimer = setTimeout(() => {
        if (state.promptState === 'rejected') {
          settle('prompt_rejected')
        } else if (!state.streamConnected) {
          settle('stream_unavailable', `OpenCode turn-settled observer timed out after ${timeoutMs}ms`)
        } else {
          settle('timeout', `OpenCode turn-settled observer timed out after ${timeoutMs}ms`)
        }
      }, timeoutMs)
      timeoutTimer.unref?.()

      try {
        for (const endpoint of ENDPOINTS) {
          if (state.terminal || state.disposed) {
            return
          }
          state.endpoint = endpoint
          const matchedBefore = state.matchedEventCount
          const result = await readOpenCodeSseEndpoint({
            baseUrl: params.baseUrl,
            endpoint,
            fetchImpl: this.deps.fetchImpl,
            signal: controller.signal,
            onEvent: handleEvent,
          })
          state.streamConnected = state.streamConnected || result.connected
          state.diagnostics.push(...result.diagnostics)

          if (state.terminal || state.disposed) {
            return
          }
          if (endpoint === '/event' && state.matchedEventCount === matchedBefore) {
            state.diagnostics.push(
              'OpenCode turn-settled observer saw no session activity on /event, trying /global/event',
            )
            continue
          }
          break
        }
        if (!state.terminal) {
          settle(state.streamConnected ? 'timeout' : 'stream_unavailable')
        }
      } finally {
        clearTimeout(timeoutTimer)
      }
    }

    void run()

    return {
      runtimePromptMessageId,
      turnId,
      markPromptSubmitting: () => {
        if (state.promptState === 'created') {
          state.promptState = 'submitting'
          resetIdleTimer()
        }
      },
      markPromptAcceptedByEndpoint: () => {
        if (state.promptState === 'submitting') {
          state.promptState = 'accepted'
          resetIdleTimer()
        }
      },
      markPromptRejectedByEndpoint: error => {
        state.promptState = 'rejected'
        settle(
          'prompt_rejected',
          `OpenCode prompt_async rejected - ${error instanceof Error ? error.message : String(error)}`,
        )
      },
      waitForSettled: () => waitPromise,
      dispose: () => {
        state.disposed = true
        clearIdleTimer()
        controller.abort()
        if (!state.terminal) {
          settle('unknown', 'OpenCode turn-settled observer disposed')
        }
      },
    }
  }
}

export const openCodeTurnSettledObserver = new OpenCodeTurnSettledObserver()
