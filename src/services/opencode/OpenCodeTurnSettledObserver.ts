import {
  getOpenCodeSseMessageId,
  getOpenCodeSseMessageParentId,
  getOpenCodeSseMessageRole,
  getOpenCodeSsePartType,
  getOpenCodeSseSessionId,
  getOpenCodeSseSessionStatusType,
  readOpenCodeSseEndpoint,
  type OpenCodeSseEndpoint,
  type OpenCodeSseFetch,
} from './OpenCodeSseEventStream.js'
import { buildOpenCodeRuntimePromptMessageId } from './OpenCodeMessageIds.js'
import { qualifyOpenCodeV1TerminalProof, type OpenCodeV1TerminalProof, type OpenCodeV1TerminalAuthority } from './OpenCodeV1TerminalProof.js'
import { readOpenCodeV1TerminalTranscript } from './OpenCodeV1TerminalTranscriptReader.js'
import type { OpenCodeRuntimeTurnSettledOutcome } from './OpenCodeRuntimeTurnSettledEmitter.js'
import type { OpenCodeSseEvent } from './types.js'

export { buildOpenCodeRuntimePromptMessageId } from './OpenCodeMessageIds.js'

const DEFAULT_TURN_SETTLED_TIMEOUT_MS = 15_000
const DEFAULT_TURN_SETTLED_IDLE_TIMEOUT_MS = 2_500
const ENDPOINTS: OpenCodeSseEndpoint[] = ['/event', '/global/event']

type PromptState = 'created' | 'submitting' | 'accepted' | 'rejected'

export type OpenCodeTurnSettledSummary = {
  terminalProof?: OpenCodeV1TerminalProof
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
  streamClosedBeforeTerminalEvent: boolean
  endpoint: OpenCodeSseEndpoint | null
  observedEventCount: number
  matchedEventCount: number
  assistantActivityCount: number
  promptPersisted: boolean
  assistantMessageObserved: boolean
  pendingSessionErrorDiagnostic: string | null
  latestEventType: string | null
  latestAssistantMessageId: string | null
  diagnostics: string[]
  terminal: OpenCodeTurnSettledSummary | null
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
    authority?: OpenCodeV1TerminalAuthority
    signal?: AbortSignal
    baseUrl: string
    sessionId: string
    projectPath?: string | null
    runtimePromptMessageId?: string | null
    timeoutMs?: number
    idleTimeoutMs?: number
  }): OpenCodeTurnSettledObservation {
    const runtimePromptMessageId =
      params.runtimePromptMessageId?.trim() ||
      (this.deps.promptMessageIdFactory ?? buildOpenCodeRuntimePromptMessageId)()
    const turnId = runtimePromptMessageId
    const authority = params.authority ? {
      hostKey: params.authority.hostKey, runId: params.authority.runId,
      profileRootKey: params.authority.profileRootKey, projectPath: params.authority.projectPath,
    } : undefined
    const state: ObservationState = {
      promptState: 'created',
      disposed: false,
      streamConnected: false,
      streamClosedBeforeTerminalEvent: false,
      endpoint: null,
      observedEventCount: 0,
      matchedEventCount: 0,
      assistantActivityCount: 0,
      promptPersisted: false,
      assistantMessageObserved: false,
      pendingSessionErrorDiagnostic: null,
      latestEventType: null,
      latestAssistantMessageId: null,
      diagnostics: [],
      terminal: null,
    }

    const timeoutMs = params.timeoutMs ?? DEFAULT_TURN_SETTLED_TIMEOUT_MS
    const deadlineAt = performance.now() + timeoutMs
    const idleTimeoutMs = params.idleTimeoutMs ?? DEFAULT_TURN_SETTLED_IDLE_TIMEOUT_MS
    const controller = new AbortController()
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let idleTranscriptProbeInFlight = false
    let reconciliationRequested = false
    let transcriptReadCount = 0
    let finalReadCount = 0
    let finalRequested = false
    let reconciliationTimer: ReturnType<typeof setTimeout> | null = null
    let lastReadAt = -Infinity
    const progressIntervalMs = Math.max(10, Math.min(250, timeoutMs / 48))
    let terminalProof: OpenCodeV1TerminalProof | undefined
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
      ...(terminalProof ? { terminalProof } : {}),
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
      if (reconciliationTimer) clearTimeout(reconciliationTimer)
      reconciliationTimer = null
      controller.abort()
      params.signal?.removeEventListener('abort', abortObservation)
      resolveWait?.(state.terminal)
    }

    const abortObservation = () => settle('unknown', 'OpenCode turn observation operation aborted')
    params.signal?.addEventListener('abort', abortObservation, { once: true })
    if (params.signal?.aborted) abortObservation()

    const resetIdleTimer = () => {
      if (idleTimeoutMs <= 0 || state.terminal) {
        return
      }
      clearIdleTimer()
      idleTimer = setTimeout(() => {
        if (state.promptState === 'accepted') {
          reconcileTranscriptAfterIdle('event silence')
        }
      }, idleTimeoutMs)
    }

    const hasCurrentPromptEvidence = () =>
      state.promptPersisted || state.assistantMessageObserved || state.assistantActivityCount > 0

    const recordUnattributedSessionError = (diagnostic: string, reason: string) => {
      state.pendingSessionErrorDiagnostic = diagnostic
      state.diagnostics.push(reason)
      state.diagnostics.push(diagnostic)
    }

    const recordAssistantActivity = (
      messageId: string | null,
      options: {
        parentId?: string | null
        source: 'message' | 'part'
      },
    ) => {
      if (
        state.promptPersisted ||
        options.parentId === runtimePromptMessageId ||
        (options.source === 'part' && state.promptState === 'accepted')
      ) {
        state.assistantActivityCount += 1
        state.latestAssistantMessageId = messageId
        return
      }
      state.diagnostics.push(
        'OpenCode ignored assistant activity without current prompt evidence',
      )
    }

    const reconcileTranscriptAfterIdle = (source: string, final = false) => {
      if (state.terminal || state.disposed || state.promptState !== 'accepted') return
      finalRequested ||= final
      if (idleTranscriptProbeInFlight) { reconciliationRequested = true; return }
      const reserved = finalRequested
      if ((reserved && finalReadCount >= 8) || (!reserved && transcriptReadCount >= 24)) {
        const diagnostic = `OpenCode ${reserved ? 'final' : 'progress'} reconciliation budget exhausted`
        if (!state.diagnostics.includes(diagnostic)) state.diagnostics.push(diagnostic)
        return
      }
      const delay = reserved ? 0 : Math.max(0, lastReadAt + progressIntervalMs - performance.now())
      if (delay > 0) {
        if (!reconciliationTimer) reconciliationTimer = setTimeout(() => {
          reconciliationTimer = null
          reconcileTranscriptAfterIdle(source)
        }, delay)
        return
      }
      if (reconciliationTimer) clearTimeout(reconciliationTimer)
      reconciliationTimer = null
      finalRequested = false
      reconciliationRequested = false
      if (reserved) finalReadCount++; else transcriptReadCount++
      lastReadAt = performance.now()
      idleTranscriptProbeInFlight = true
      const matchedEventCount = state.matchedEventCount
      void (async () => {
        try {
          const evidence = await readOpenCodeV1TerminalTranscript({
            authority, baseUrl: params.baseUrl, sessionId: params.sessionId, runtimePromptMessageId,
            remainingMs: () => Math.max(0, deadlineAt - performance.now()),
            signal: controller.signal, fetchImpl: this.deps.fetchImpl,
          })
          if (state.terminal || state.disposed) return
          if (performance.now() >= deadlineAt) { settle('timeout', 'OpenCode absolute observation deadline expired'); return }
          if (state.matchedEventCount !== matchedEventCount) { reconciliationRequested = true; return }
          const result = qualifyOpenCodeV1TerminalProof(evidence, params.sessionId, runtimePromptMessageId)
          // Diagnostics are bounded by the finite reconciliation allowance.
          state.diagnostics.push(...evidence.diagnostics, ...result.diagnostics)
          if (!result.proof) return
          terminalProof = result.proof
          state.promptPersisted = true
          state.latestAssistantMessageId = result.proof.assistantMessageId
          settle(result.proof.outcome, `OpenCode qualified terminal assistant response after ${source}`)
        } finally {
          idleTranscriptProbeInFlight = false
          if (!state.terminal && !state.disposed) {
            if (reconciliationRequested || finalRequested) reconcileTranscriptAfterIdle('coalesced event')
            resetIdleTimer()
          }
        }
      })()
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

      const sessionId = getOpenCodeSseSessionId(event.properties)
      if (sessionId !== params.sessionId) {
        return
      }

      state.matchedEventCount += 1
      resetIdleTimer()

      if (event.type === 'session.error') {
        recordUnattributedSessionError(
          `OpenCode observed session.error for ${params.sessionId}`,
          'Session-only error requires persisted per-prompt terminal attribution',
        )
        reconcileTranscriptAfterIdle('session.error', true)
        return
      }
      if (event.type === 'session.idle' ||
        (event.type === 'session.status' && getOpenCodeSseSessionStatusType(event.properties.status, params.sessionId) === 'idle')) {
        reconcileTranscriptAfterIdle(event.type, true)
        return
      }
      if (event.type === 'message.updated' || event.type === 'message.part.updated' || event.type === 'message.part.delta') {
        const info = event.properties.info
        // A completed tool-calls assistant is step progress, even with time.completed.
        // SSE only schedules persisted proof; measured stop/native-abort candidates use reserve.
        const final = event.type === 'message.updated' && info !== null && typeof info === 'object'
          && 'role' in info && info.role === 'assistant'
          && ('finish' in info && info.finish === 'stop'
            || 'error' in info && info.error !== null && typeof info.error === 'object'
              && 'name' in info.error && info.error.name === 'MessageAbortedError')
        reconcileTranscriptAfterIdle(event.type, final)
      }

      if (state.promptState !== 'submitting' && state.promptState !== 'accepted') {
        return
      }

      if (event.type === 'message.updated') {
        const messageId = getOpenCodeSseMessageId(event.properties)
        const role = getOpenCodeSseMessageRole(event.properties)
        if (messageId === runtimePromptMessageId && role === 'user') {
          state.promptPersisted = true
          return
        }
        if (role === 'assistant') {
          if (
            state.promptPersisted ||
            getOpenCodeSseMessageParentId(event.properties) === runtimePromptMessageId
          ) {
            state.assistantMessageObserved = true
            state.latestAssistantMessageId = messageId
            return
          }
          state.diagnostics.push(
            'OpenCode ignored assistant message shell without current prompt evidence',
          )
        }
        return
      }

      if (event.type === 'message.part.delta') {
        const messageId = getOpenCodeSseMessageId(event.properties)
        if (messageId === runtimePromptMessageId) {
          return
        }
        recordAssistantActivity(messageId, { source: 'part' })
        return
      }

      if (event.type === 'message.part.updated') {
        const messageId = getOpenCodeSseMessageId(event.properties)
        if (messageId === runtimePromptMessageId) {
          return
        }
        const partType = getOpenCodeSsePartType(event.properties)
        if (isAssistantActivityPartType(partType)) {
          recordAssistantActivity(messageId, { source: 'part' })
        }
      }
    }

    const run = async () => {
      const timeoutTimer = setTimeout(() => {
        if (state.promptState === 'rejected') {
          settle('prompt_rejected')
        } else if (!state.streamConnected) {
          settle('stream_unavailable', `OpenCode turn-settled observer timed out after ${timeoutMs}ms`)
        } else if (
          state.promptState === 'accepted' &&
          hasCurrentPromptEvidence() &&
          state.assistantActivityCount === 0
        ) {
          settle(
            'idle_without_assistant_activity',
            `OpenCode prompt had no assistant activity before ${timeoutMs}ms timeout`,
          )
        } else {
          settle('timeout', `OpenCode turn-settled observer timed out after ${timeoutMs}ms`)
        }
      }, timeoutMs)

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
          state.streamClosedBeforeTerminalEvent =
            state.streamClosedBeforeTerminalEvent || result.closedBeforeAbort
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
          settle(
            state.streamConnected && !state.streamClosedBeforeTerminalEvent
              ? 'timeout'
              : 'stream_unavailable',
            state.streamClosedBeforeTerminalEvent
              ? 'OpenCode SSE stream closed before terminal event'
              : undefined,
          )
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
          reconcileTranscriptAfterIdle('endpoint acceptance')
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
