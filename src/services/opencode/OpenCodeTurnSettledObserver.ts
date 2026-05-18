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
import type { OpenCodeRuntimeTurnSettledOutcome } from './OpenCodeRuntimeTurnSettledEmitter.js'
import type { OpenCodeMessage, OpenCodeSseEvent } from './types.js'

export { buildOpenCodeRuntimePromptMessageId } from './OpenCodeMessageIds.js'

const DEFAULT_TURN_SETTLED_TIMEOUT_MS = 15_000
const DEFAULT_TURN_SETTLED_IDLE_TIMEOUT_MS = 2_500
const DEFAULT_TURN_SETTLED_TRANSCRIPT_LIMIT = 50
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

type TranscriptResponseProof = {
  promptPersisted: boolean
  assistantMessageId: string | null
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

function isTranscriptAssistantResponsePartType(partType: string | null): boolean {
  return partType === 'text' ||
    partType === 'tool' ||
    partType === 'tool_use' ||
    partType === 'tool_result' ||
    partType === 'reasoning' ||
    partType === 'step-finish' ||
    partType === 'step_finish'
}

function getTranscriptMessageInfo(message: OpenCodeMessage): Record<string, unknown> | null {
  return asRecord(message.info)
}

function getTranscriptMessageId(message: OpenCodeMessage): string | null {
  return asString(getTranscriptMessageInfo(message)?.id)
}

function getTranscriptMessageParentId(message: OpenCodeMessage): string | null {
  const info = getTranscriptMessageInfo(message)
  return (
    asString(info?.parentID) ??
    asString(info?.parentId) ??
    asString(info?.parent)
  )
}

function getTranscriptMessageRole(message: OpenCodeMessage): string | null {
  return asString(getTranscriptMessageInfo(message)?.role)
}

function hasTranscriptAssistantActivity(message: OpenCodeMessage): boolean {
  if (!Array.isArray(message.parts)) {
    return false
  }

  return message.parts.some((part) => {
    const record = asRecord(part)
    const type = asString(record?.type)
    if (isTranscriptAssistantResponsePartType(type)) {
      return true
    }
    return asString(record?.text) !== null
  })
}

function findTranscriptResponseForPrompt(
  messages: OpenCodeMessage[],
  runtimePromptMessageId: string,
): TranscriptResponseProof {
  const promptIndex = messages.findIndex(message =>
    getTranscriptMessageRole(message) === 'user' &&
    getTranscriptMessageId(message) === runtimePromptMessageId
  )
  const parentMatchedAssistant = messages.find(message =>
    getTranscriptMessageRole(message) === 'assistant' &&
    getTranscriptMessageParentId(message) === runtimePromptMessageId &&
    hasTranscriptAssistantActivity(message)
  )

  if (parentMatchedAssistant) {
    return {
      promptPersisted: true,
      assistantMessageId: getTranscriptMessageId(parentMatchedAssistant),
    }
  }

  if (promptIndex < 0) {
    return {
      promptPersisted: false,
      assistantMessageId: null,
    }
  }

  for (const message of messages.slice(promptIndex + 1)) {
    const role = getTranscriptMessageRole(message)
    if (role === 'user') {
      break
    }
    if (role === 'assistant' && hasTranscriptAssistantActivity(message)) {
      return {
        promptPersisted: true,
        assistantMessageId: getTranscriptMessageId(message),
      }
    }
  }

  return {
    promptPersisted: true,
    assistantMessageId: null,
  }
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
      (this.deps.promptMessageIdFactory ?? buildOpenCodeRuntimePromptMessageId)()
    const turnId = runtimePromptMessageId
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
    const idleTimeoutMs = params.idleTimeoutMs ?? DEFAULT_TURN_SETTLED_IDLE_TIMEOUT_MS
    const controller = new AbortController()
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let idleTranscriptProbeInFlight = false
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

    const fetchTranscriptResponseProof = async (): Promise<TranscriptResponseProof | null> => {
      const fetchImpl = this.deps.fetchImpl ?? fetch
      const path =
        `/session/${encodeURIComponent(params.sessionId)}/message?limit=${DEFAULT_TURN_SETTLED_TRANSCRIPT_LIMIT}`
      let response: Response
      try {
        response = await fetchImpl(params.baseUrl + path, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
          },
        })
      } catch (error) {
        if (controller.signal.aborted || state.terminal || state.disposed) {
          return null
        }
        state.diagnostics.push(
          `OpenCode transcript reconcile failed after idle - ${error instanceof Error ? error.message : String(error)}`,
        )
        return null
      }

      if (!response.ok) {
        state.diagnostics.push(
          `OpenCode transcript reconcile returned ${response.status} ${response.statusText}`,
        )
        return null
      }

      let raw: unknown
      try {
        raw = await response.json()
      } catch (error) {
        state.diagnostics.push(
          `OpenCode transcript reconcile returned invalid JSON - ${error instanceof Error ? error.message : String(error)}`,
        )
        return null
      }

      if (!Array.isArray(raw)) {
        state.diagnostics.push('OpenCode transcript reconcile returned a non-array message list')
        return null
      }

      return findTranscriptResponseForPrompt(raw as OpenCodeMessage[], runtimePromptMessageId)
    }

    const reconcileTranscriptAfterIdle = (source: 'session.idle' | 'session.status idle') => {
      if (state.terminal || state.disposed || idleTranscriptProbeInFlight) {
        return
      }

      idleTranscriptProbeInFlight = true
      void (async () => {
        try {
          const proof = await fetchTranscriptResponseProof()
          if (!proof || state.terminal || state.disposed) {
            return
          }
          if (proof.promptPersisted) {
            state.promptPersisted = true
          }
          if (!proof.assistantMessageId) {
            state.diagnostics.push(
              `OpenCode transcript reconcile after ${source} found no assistant response for the current prompt`,
            )
            return
          }

          state.assistantMessageObserved = true
          state.assistantActivityCount = Math.max(state.assistantActivityCount, 1)
          state.latestAssistantMessageId = proof.assistantMessageId
          settle('success', `OpenCode transcript reconcile after ${source} observed assistant activity`)
        } finally {
          idleTranscriptProbeInFlight = false
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
        const diagnostic = `OpenCode observed session.error for ${params.sessionId}`
        if (state.promptState === 'accepted') {
          if (hasCurrentPromptEvidence()) {
            settle('error', diagnostic)
            return
          }
          recordUnattributedSessionError(
            diagnostic,
            'OpenCode ignored session.error without current prompt evidence',
          )
          return
        }
        if (state.promptState === 'submitting') {
          recordUnattributedSessionError(
            diagnostic,
            'OpenCode buffered session.error before prompt_async endpoint acceptance',
          )
        }
        return
      }

      if (event.type === 'session.idle') {
        if (state.promptState !== 'accepted') {
          return
        }
        if (!hasCurrentPromptEvidence()) {
          state.diagnostics.push(
            'OpenCode ignored session.idle without current prompt evidence',
          )
          reconcileTranscriptAfterIdle('session.idle')
          return
        }
        if (state.assistantActivityCount > 0) {
          settle('success', 'OpenCode observed deprecated session.idle after assistant activity')
          return
        }
        state.diagnostics.push(
          'OpenCode observed deprecated session.idle without assistant activity; waiting for full turn timeout',
        )
        reconcileTranscriptAfterIdle('session.idle')
        return
      }

      if (event.type === 'session.status') {
        const status = getOpenCodeSseSessionStatusType(event.properties.status, params.sessionId)
        if (status === 'idle' && state.promptState === 'accepted') {
          if (!hasCurrentPromptEvidence()) {
            state.diagnostics.push(
              'OpenCode ignored session.status idle without current prompt evidence',
            )
            reconcileTranscriptAfterIdle('session.status idle')
            return
          }
          if (state.assistantActivityCount > 0) {
            settle('success', 'OpenCode observed session.status idle after assistant activity')
            return
          }
          state.diagnostics.push(
            'OpenCode observed session.status idle without assistant activity; waiting for full turn timeout',
          )
          reconcileTranscriptAfterIdle('session.status idle')
        }
        return
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
