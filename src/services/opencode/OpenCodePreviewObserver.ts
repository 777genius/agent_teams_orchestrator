import { createOpenCodeSupervisedEventFetch } from './OpenCodeSupervisedEventStream.js'
import type { OpenCodeHostAcquisitionPolicy } from './OpenCodeSupervisedHostCustody.js'
import {
  extractOpenCodeSseData,
  getOpenCodeSseMessageId,
  getOpenCodeSseMessageRole,
  getOpenCodeSseSessionId,
  getOpenCodeSseSessionStatusType,
  normalizeOpenCodeSseEvent,
  parseOpenCodeSseDataBlocks,
} from './OpenCodeSseEventStream.js'
import type {
  OpenCodePreviewRuntimeState,
  OpenCodeSessionPreviewSummary,
  OpenCodeSseEvent,
} from './types.js'

type OpenCodePreviewFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type OpenCodePreviewObserverDeps = {
  acquisitionPolicy?: OpenCodeHostAcquisitionPolicy
  fetchImpl?: OpenCodePreviewFetch
}

type ObserveSessionParams = {
  baseUrl: string
  sessionId: string
  timeoutMs?: number
  idleTimeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_PREVIEW_TIMEOUT_MS = 5_000
const DEFAULT_PREVIEW_IDLE_TIMEOUT_MS = 1_000
const PREVIEW_EVENT_ENDPOINTS = ['/event', '/global/event'] as const

type PreviewState = {
  streamConnected: boolean
  observedEventCount: number
  matchedEventCount: number
  runtimeState: OpenCodePreviewRuntimeState
  latestEventType: string | null
  latestAssistantMessageId: string | null
  latestAssistantPreview: string | null
  pendingPermissionRequestIds: Set<string>
  diagnostics: string[]
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

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function buildPreviewText(value: string): string | null {
  const compacted = compactText(value)
  if (!compacted) {
    return null
  }
  return compacted.length <= 160 ? compacted : `${compacted.slice(0, 157)}...`
}

function buildEmptySummary(sessionId: string): OpenCodeSessionPreviewSummary {
  return {
    sessionId,
    previewOutcome: 'stream_unavailable',
    staleReason: null,
    profileAuthState: null,
    streamEndpoint: null,
    streamConnected: false,
    observedEventCount: 0,
    matchedEventCount: 0,
    runtimeState: 'unknown',
    latestEventType: null,
    latestAssistantMessageId: null,
    latestAssistantPreview: null,
    pendingPermissionRequestIds: [],
    diagnostics: [],
  }
}

function getOpenCodeSsePartId(properties: Record<string, unknown>): string | null {
  return asString(properties.partID) ?? asString(properties.partId)
}

export class OpenCodePreviewObserver {
  private readonly deps: OpenCodePreviewObserverDeps
  constructor(deps: OpenCodePreviewObserverDeps = {}) {
    const policy = deps.acquisitionPolicy
    if (policy?.mode === 'supervisor-adopt-only') {
      if (deps.fetchImpl || new.target !== OpenCodePreviewObserver) {
        throw new Error('OpenCode supervised preview transport substituted')
      }
      this.deps = Object.freeze({ fetchImpl: createOpenCodeSupervisedEventFetch(policy.custody) })
      Object.defineProperty(this, 'observeSession', { value: this.observeSession.bind(this) })
      Object.defineProperty(this, 'fetchImpl', { value: this.deps.fetchImpl })
      Object.freeze(this)
    } else this.deps = deps
  }

  private get fetchImpl(): OpenCodePreviewFetch {
    return this.deps.fetchImpl ?? fetch
  }

  async observeSession(params: ObserveSessionParams): Promise<OpenCodeSessionPreviewSummary> {
    const timeoutMs = params.timeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS
    const idleTimeoutMs = params.idleTimeoutMs ?? DEFAULT_PREVIEW_IDLE_TIMEOUT_MS
    const summary = buildEmptySummary(params.sessionId)
    const state: PreviewState = {
      streamConnected: false,
      observedEventCount: 0,
      matchedEventCount: 0,
      runtimeState: 'unknown',
      latestEventType: null,
      latestAssistantMessageId: null,
      latestAssistantPreview: null,
      pendingPermissionRequestIds: new Set<string>(),
      diagnostics: summary.diagnostics,
    }

    const controller = new AbortController()
    let timeoutAbort = false
    let idleAbort = false
    let matchedRelevantEvent = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const roleByMessageId = new Map<string, 'assistant' | 'user' | 'system' | 'unknown'>()
    const assistantBuffers = new Map<string, Map<string, string>>()

    const resetIdleTimer = () => {
      if (idleTimeoutMs <= 0) {
        return
      }
      if (idleTimer) {
        clearTimeout(idleTimer)
      }
      idleTimer = setTimeout(() => {
        idleAbort = true
        controller.abort(new Error(`OpenCode preview observer became idle after ${idleTimeoutMs}ms`))
      }, idleTimeoutMs)
    }

    const syncSummary = (endpoint: '/event' | '/global/event' | null, outcome: OpenCodeSessionPreviewSummary['previewOutcome']) => {
      summary.previewOutcome = outcome
      summary.streamEndpoint = endpoint
      summary.streamConnected = state.streamConnected
      summary.observedEventCount = state.observedEventCount
      summary.matchedEventCount = state.matchedEventCount
      summary.runtimeState = state.pendingPermissionRequestIds.size > 0 ? 'blocked' : state.runtimeState
      summary.latestEventType = state.latestEventType
      summary.latestAssistantMessageId = state.latestAssistantMessageId
      summary.latestAssistantPreview = state.latestAssistantPreview
      summary.pendingPermissionRequestIds = [...state.pendingPermissionRequestIds]
      if (summary.runtimeState === 'unknown' && summary.latestAssistantPreview) {
        summary.runtimeState = 'running'
      }
      return summary
    }

    const clearTimers = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }

    const onExternalAbort = () => {
      controller.abort(params.signal?.reason ?? new Error('OpenCode preview observation was aborted'))
    }
    params.signal?.addEventListener('abort', onExternalAbort, { once: true })

    const timeoutHandle = setTimeout(() => {
      timeoutAbort = true
      controller.abort(new Error(`OpenCode preview observer timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const updateAssistantPreview = (messageId: string) => {
      if (roleByMessageId.get(messageId) !== 'assistant') {
        return
      }

      const parts = assistantBuffers.get(messageId)
      if (!parts) {
        if (state.latestAssistantMessageId === messageId) {
          state.latestAssistantPreview = null
        }
        return
      }

      const text = Array.from(parts.values()).join('')
      state.latestAssistantMessageId = messageId
      state.latestAssistantPreview = buildPreviewText(text)
    }

    const storeAssistantPartText = (messageId: string, partId: string, text: string) => {
      const buffer = assistantBuffers.get(messageId) ?? new Map<string, string>()
      buffer.set(partId, text)
      assistantBuffers.set(messageId, buffer)
      updateAssistantPreview(messageId)
      if (roleByMessageId.get(messageId) === 'assistant') {
        state.runtimeState = 'running'
      }
    }

    const handleEvent = (event: OpenCodeSseEvent): void => {
      state.observedEventCount += 1
      state.latestEventType = event.type

      if (event.type === 'server.connected') {
        state.streamConnected = true
        return
      }

      const properties = event.properties
      const sessionId = getOpenCodeSseSessionId(properties)

      if (sessionId !== params.sessionId) {
        return
      }

      matchedRelevantEvent = true
      state.matchedEventCount += 1
      resetIdleTimer()

      switch (event.type) {
        case 'session.status': {
          const status = getOpenCodeSseSessionStatusType(properties.status, params.sessionId)
          if (status === 'active' || status === 'busy') {
            state.runtimeState = 'running'
          } else if (status === 'idle') {
            state.runtimeState = 'idle'
          } else if (status === 'retry') {
            state.runtimeState = 'retrying'
          } else if (status === 'error') {
            state.runtimeState = 'error'
          }
          return
        }

        case 'session.error': {
          state.runtimeState = 'error'
          state.diagnostics.push(
            `OpenCode preview observed session.error for ${params.sessionId}`,
          )
          return
        }

        case 'message.updated': {
          const messageId = getOpenCodeSseMessageId(properties)
          const role = getOpenCodeSseMessageRole(properties)
          if (!messageId) {
            state.diagnostics.push('OpenCode preview observed message.updated without info.id')
            return
          }

          if (role === 'assistant' || role === 'user' || role === 'system') {
            roleByMessageId.set(messageId, role)
          } else {
            roleByMessageId.set(messageId, 'unknown')
          }

          if (role === 'assistant') {
            state.latestAssistantMessageId = messageId
            updateAssistantPreview(messageId)
          }
          return
        }

        case 'message.part.updated': {
          const part = asRecord(properties.part)
          const messageId = getOpenCodeSseMessageId(properties)
          const partId = asString(part?.id) ?? '__default__'
          const partType = asString(part?.type)
          if (!messageId || !partType) {
            return
          }

          if (partType === 'retry') {
            state.runtimeState = 'retrying'
            return
          }

          if (partType !== 'text') {
            return
          }

          const delta = asString(properties.delta)
          const text = asString(part.text)
          const buffer = assistantBuffers.get(messageId) ?? new Map<string, string>()
          storeAssistantPartText(
            messageId,
            partId,
            delta ? `${buffer.get(partId) ?? ''}${delta}` : (text ?? buffer.get(partId) ?? ''),
          )
          return
        }

        case 'message.part.delta': {
          const messageId = getOpenCodeSseMessageId(properties)
          const partId = getOpenCodeSsePartId(properties) ?? '__default__'
          const field = asString(properties.field)
          const delta = asString(properties.delta)
          if (!messageId || !delta) {
            return
          }

          if (field && field !== 'text') {
            return
          }

          const buffer = assistantBuffers.get(messageId) ?? new Map<string, string>()
          storeAssistantPartText(messageId, partId, `${buffer.get(partId) ?? ''}${delta}`)
          return
        }

        case 'message.part.removed': {
          const messageId = getOpenCodeSseMessageId(properties)
          const partId = getOpenCodeSsePartId(properties)
          if (!messageId || !partId) {
            return
          }

          const buffer = assistantBuffers.get(messageId)
          if (!buffer) {
            return
          }
          buffer.delete(partId)
          if (buffer.size === 0) {
            assistantBuffers.delete(messageId)
          }
          updateAssistantPreview(messageId)
          return
        }

        case 'permission.asked': {
          const requestId = asString(properties.requestID)
          if (requestId) {
            state.pendingPermissionRequestIds.add(requestId)
          }
          state.runtimeState = 'blocked'
          return
        }

        case 'permission.replied': {
          const requestId = asString(properties.requestID)
          if (requestId) {
            state.pendingPermissionRequestIds.delete(requestId)
          }
          if (state.pendingPermissionRequestIds.size === 0 && state.runtimeState === 'blocked') {
            state.runtimeState = state.latestAssistantPreview ? 'running' : 'unknown'
          }
          return
        }

        case 'question.asked': {
          state.diagnostics.push(`OpenCode preview observed question.asked for ${params.sessionId}`)
          return
        }

        default:
          return
      }
    }

    try {
      for (const endpoint of PREVIEW_EVENT_ENDPOINTS) {
        const matchedBeforeEndpoint = state.matchedEventCount
        const previewBeforeEndpoint = state.latestAssistantPreview
        let response: Response
        try {
          response = await this.fetchImpl(params.baseUrl + endpoint, {
            method: 'GET',
            signal: controller.signal,
            headers: {
              Accept: 'text/event-stream',
            },
          })
        } catch (error) {
          if (controller.signal.aborted) {
            return syncSummary(
              state.streamConnected ? endpoint : null,
              state.streamConnected ? 'observed' : 'stream_unavailable',
            )
          }
          state.diagnostics.push(
            `OpenCode preview failed to connect to ${endpoint} - ${error instanceof Error ? error.message : String(error)}`,
          )
          continue
        }

        if (!response.ok) {
          state.diagnostics.push(
            `OpenCode preview endpoint ${endpoint} returned ${response.status} ${response.statusText}`,
          )
          continue
        }

        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
          state.diagnostics.push(
            `OpenCode preview endpoint ${endpoint} did not return text/event-stream`,
          )
          continue
        }

        if (!response.body) {
          state.diagnostics.push(`OpenCode preview endpoint ${endpoint} returned no stream body`)
          continue
        }

        let buffer = ''
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        state.streamConnected = true

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              buffer += decoder.decode()
              break
            }
            buffer += decoder.decode(value, { stream: true })
            const blocks = parseOpenCodeSseDataBlocks(buffer)
            buffer = blocks.pop() ?? ''
            for (const block of blocks) {
              const data = extractOpenCodeSseData(block)
              if (!data) {
                continue
              }
              try {
                const event = normalizeOpenCodeSseEvent(JSON.parse(data))
                if (!event) {
                  state.diagnostics.push('OpenCode preview ignored an unrecognized SSE payload shape')
                  continue
                }
                handleEvent(event)
              } catch (error) {
                state.diagnostics.push(
                  `OpenCode preview ignored malformed SSE payload - ${error instanceof Error ? error.message : String(error)}`,
                )
              }
            }
          }

          const finalData = extractOpenCodeSseData(buffer)
          if (finalData) {
            try {
              const event = normalizeOpenCodeSseEvent(JSON.parse(finalData))
              if (event) {
                handleEvent(event)
              }
            } catch (error) {
              state.diagnostics.push(
                `OpenCode preview ignored malformed trailing SSE payload - ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }

          if (!matchedRelevantEvent) {
            state.diagnostics.push(
              `OpenCode preview saw no session-scoped events for ${params.sessionId} before the stream ended`,
            )
          }
          if (
            endpoint !== PREVIEW_EVENT_ENDPOINTS[PREVIEW_EVENT_ENDPOINTS.length - 1]
            && state.matchedEventCount === matchedBeforeEndpoint
            && state.latestAssistantPreview === previewBeforeEndpoint
          ) {
            state.diagnostics.push(
              `OpenCode preview observed no session activity on ${endpoint}, retrying with the fallback event endpoint`,
            )
            continue
          }
          return syncSummary(endpoint, 'observed')
        } catch (error) {
          if (controller.signal.aborted) {
            if (timeoutAbort) {
              state.diagnostics.push(`OpenCode preview timed out after ${timeoutMs}ms`)
            }
            if (idleAbort) {
              state.diagnostics.push(`OpenCode preview stopped after ${idleTimeoutMs}ms of inactivity`)
            }
            if (!timeoutAbort && !idleAbort && params.signal?.aborted) {
              state.diagnostics.push('OpenCode preview was aborted by the caller')
            }
            if (!matchedRelevantEvent) {
              state.diagnostics.push(
                `OpenCode preview saw no session-scoped events for ${params.sessionId} before observation ended`,
              )
            }
            if (
              endpoint !== PREVIEW_EVENT_ENDPOINTS[PREVIEW_EVENT_ENDPOINTS.length - 1]
              && state.matchedEventCount === matchedBeforeEndpoint
              && state.latestAssistantPreview === previewBeforeEndpoint
            ) {
              state.diagnostics.push(
                `OpenCode preview observed no session activity on ${endpoint}, retrying with the fallback event endpoint`,
              )
              continue
            }
            return syncSummary(endpoint, 'observed')
          }

          state.diagnostics.push(
            `OpenCode preview stream ${endpoint} failed - ${error instanceof Error ? error.message : String(error)}`,
          )
        } finally {
          clearTimers()
          reader.releaseLock()
        }
      }

      if (!state.streamConnected) {
        state.diagnostics.push('OpenCode preview could not establish an event stream')
      }
      return syncSummary(null, 'stream_unavailable')
    } finally {
      clearTimeout(timeoutHandle)
      clearTimers()
      params.signal?.removeEventListener('abort', onExternalAbort)
    }
  }
}

export const openCodePreviewObserver = new OpenCodePreviewObserver()
