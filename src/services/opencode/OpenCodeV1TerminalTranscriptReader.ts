import { readOpenCodeBoundedHttpResponse } from './OpenCodeBoundedHttpResponse.js'
import { openCodeTranscriptProjector } from './OpenCodeTranscriptProjector.js'
import type { OpenCodeSseFetch } from './OpenCodeSseEventStream.js'
import type { OpenCodeMessage } from './types.js'
import type { OpenCodeV1TerminalEvidence, OpenCodeV1TerminalAuthority } from './OpenCodeV1TerminalProof.js'

const LIMIT = 50
const MAX_PAGES = 4
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function identity(value: unknown, prefix?: string): value is string { return typeof value === 'string' && value.trim().length > 0 && (!prefix || value.startsWith(prefix)) }

/** Read-only V1 reconciliation; all pages and confirmation share the operation deadline. */
export async function readOpenCodeV1TerminalTranscript(params: {
  authority?: OpenCodeV1TerminalAuthority
  runtimePromptMessageId?: string | null
  remainingMs?: () => number
  baseUrl: string; sessionId: string; signal: AbortSignal; fetchImpl?: OpenCodeSseFetch
}): Promise<OpenCodeV1TerminalEvidence> {
  const diagnostics: string[] = []
  const empty: OpenCodeV1TerminalEvidence = { sessionId: params.sessionId, messages: [], messageSessionIds: [], complete: false, interactionsSettled: false, diagnostics }
  const read = async (path: string, maxItems: number, remainingMs?: () => number): Promise<unknown> => {
    params.signal.throwIfAborted()
    if (params.remainingMs && params.remainingMs() <= 0) throw new Error('V1 terminal operation deadline expired')
    const response = await (params.fetchImpl ?? fetch)(params.baseUrl + path, { method: 'GET', signal: params.signal, headers: { Accept: 'application/json' } })
    return readOpenCodeBoundedHttpResponse(response, params.signal, maxItems, params.remainingMs)
  }
  try {
    // Native floor/current /doc: limit + before, latest page in chronological order.
    // Stop at the saved user, not the beginning of the session; long prior history is irrelevant.
    const capture = async (): Promise<OpenCodeMessage[]> => {
      let messages: OpenCodeMessage[] = []
      const messageIds = new Set<string>(), partIds = new Set<string>(), calls = new Set<string>()
      let before: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const path = `/session/${encodeURIComponent(params.sessionId)}/message?limit=${LIMIT}${before ? `&before=${encodeURIComponent(before)}` : ''}`
        const raw = await read(path, LIMIT)
        if (!Array.isArray(raw)) throw new Error('Missing native transcript')
        for (const message of raw) {
          const info = record(record(message)?.info), parts = record(message)?.parts
          if (!info || !identity(info.id, 'msg') || !identity(info.sessionID, 'ses') || info.sessionID !== params.sessionId || messageIds.has(info.id) || !Array.isArray(parts)) throw new Error('Invalid/duplicate native message identity or session')
          messageIds.add(info.id)
          if (info.role === 'assistant' && !identity(info.parentID, 'msg')) throw new Error('Missing/invalid required native assistant parent')
          if (info.parentID !== undefined && info.parentID !== null && !identity(info.parentID, 'msg')) throw new Error('Invalid native parent attribution')
          if (['parentId', 'parent'].some(key => info[key] !== undefined && info[key] !== info.parentID)) throw new Error('Conflicting native parent attribution')
          if (info.error !== undefined && info.error !== null && (!record(info.error) || typeof record(info.error)?.name !== 'string')) throw new Error('Unknown native error shape')
          for (const value of parts) {
            const part = record(value)
            if (!part || !identity(part.id, 'prt') || partIds.has(part.id) || part.sessionID !== info.sessionID || part.messageID !== info.id || !identity(part.type)) throw new Error('Invalid/duplicate/foreign native part identity or binding')
            partIds.add(part.id)
            if (part.type === 'tool') {
              if (!identity(part.callID) || calls.has(part.callID)) throw new Error('Invalid/duplicate native tool call ID')
              calls.add(part.callID)
            }
          }
        }
        messages = [...raw as OpenCodeMessage[], ...messages]
        if (params.runtimePromptMessageId && messages.some(message => message.info.id === params.runtimePromptMessageId && message.info.role === 'user')) return messages
        if (raw.length < LIMIT) return messages
        before = String(record(record(raw[0])?.info)?.id)
      }
      throw new Error('Native anchor/window pagination budget exhausted; completeness unknown')
    }
    const raw = await capture()
    const permissions = await read('/permission', 256), questions = await read('/question', 256)
    if (!Array.isArray(permissions) || !Array.isArray(questions)) throw new Error('Incomplete native interaction lists')
    const confirmed = await capture()
    if (JSON.stringify(confirmed) !== JSON.stringify(raw)) throw new Error('Native user window changed during reconciliation')
    params.signal.throwIfAborted()
    if (params.remainingMs && params.remainingMs() <= 0) throw new Error('V1 terminal operation deadline expired')
    const rawById = new Map(raw.map(message => [String(message.info.id), message]))
    const messages = openCodeTranscriptProjector.projectSessionMessages({ sessionId: params.sessionId, messages: raw }).messages.map(message => {
      const info = rawById.get(message.id ?? '')?.info
      if (!info) throw new Error('Canonical/native identity join failed')
      // Step-finish is progress. Filtering bootstrap must never shift persisted finish.
      return { ...message, finishReason: typeof info.finish === 'string' ? info.finish : null }
    })
    const relevant = raw.slice(params.runtimePromptMessageId ? Math.max(0, raw.findIndex(message => message.info.id === params.runtimePromptMessageId)) : 0)
    for (const message of relevant) for (const part of message.parts) {
      if (part.type === 'tool' && !['completed', 'error'].includes(String(record(part.state)?.status))) diagnostics.push('Unsettled native tool')
      if (['permission', 'question'].includes(String(part.type))) diagnostics.push('Pending native interaction part')
    }
    const pending = [...permissions, ...questions].some(item => {
      const id = record(item)?.sessionID
      return !identity(id) || id === params.sessionId
    })
    return {
      authority: params.authority ? {
        hostKey: params.authority.hostKey, runId: params.authority.runId,
        profileRootKey: params.authority.profileRootKey, projectPath: params.authority.projectPath,
      } : undefined,
      sessionId: params.sessionId, messages,
      messageSessionIds: messages.map(message => String(rawById.get(message.id ?? '')?.info.sessionID)),
      complete: true, interactionsSettled: !pending && diagnostics.length === 0, diagnostics,
    }
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error))
    return empty
  }
}
