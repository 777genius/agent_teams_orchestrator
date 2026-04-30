import type { OpenCodeSseEvent } from './types.js'

export type OpenCodeSseFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type OpenCodeSseEndpoint = '/event' | '/global/event'

export type OpenCodeSseEndpointReadResult = {
  endpoint: OpenCodeSseEndpoint
  connected: boolean
  closedBeforeAbort: boolean
  observedEventCount: number
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

export function getOpenCodeSseSessionId(properties: Record<string, unknown>): string | null {
  return (
    asString(properties.sessionID)
    ?? asString(properties.sessionId)
    ?? asString(asRecord(properties.info)?.sessionID)
    ?? asString(asRecord(properties.info)?.sessionId)
    ?? asString(asRecord(properties.part)?.sessionID)
    ?? asString(asRecord(properties.part)?.sessionId)
  )
}

export function getOpenCodeSseMessageId(properties: Record<string, unknown>): string | null {
  return (
    asString(asRecord(properties.info)?.id)
    ?? asString(asRecord(properties.part)?.messageID)
    ?? asString(asRecord(properties.part)?.messageId)
    ?? asString(properties.messageID)
    ?? asString(properties.messageId)
  )
}

export function getOpenCodeSseMessageRole(properties: Record<string, unknown>): string | null {
  return asString(asRecord(properties.info)?.role)
}

export function getOpenCodeSseMessageParentId(properties: Record<string, unknown>): string | null {
  const info = asRecord(properties.info)
  return (
    asString(info?.parentID)
    ?? asString(info?.parentId)
    ?? asString(info?.parent)
  )
}

export function getOpenCodeSsePartType(properties: Record<string, unknown>): string | null {
  return asString(asRecord(properties.part)?.type)
}

export function getOpenCodeSseSessionStatusType(
  status: unknown,
  sessionId?: string | null,
): string | null {
  const direct = asString(status)
  if (direct) {
    return direct
  }

  const record = asRecord(status)
  if (!record) {
    return null
  }

  const typed = asString(record.type)
  if (typed) {
    return typed
  }

  if (!sessionId) {
    return null
  }

  const scoped = record[sessionId]
  return asString(scoped) ?? asString(asRecord(scoped)?.type)
}

export function normalizeOpenCodeSseEvent(raw: unknown): OpenCodeSseEvent | null {
  const record = asRecord(raw)
  if (!record) {
    return null
  }

  const directType = asString(record.type)
  const payload = asRecord(record.payload)
  const eventRecord = directType ? record : payload
  if (!eventRecord) {
    return null
  }

  const type = asString(eventRecord.type)
  if (!type) {
    return null
  }

  return {
    type,
    properties: asRecord(eventRecord.properties) ?? {},
    directory: asString(record.directory),
    raw,
  }
}

export function parseOpenCodeSseDataBlocks(input: string): string[] {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n\n')
}

export function extractOpenCodeSseData(block: string): string | null {
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) {
      continue
    }
    if (!line.startsWith('data:')) {
      continue
    }

    let data = line.slice(5)
    if (data.startsWith(' ')) {
      data = data.slice(1)
    }
    dataLines.push(data)
  }

  return dataLines.length > 0 ? dataLines.join('\n') : null
}

export async function readOpenCodeSseEndpoint(params: {
  baseUrl: string
  endpoint: OpenCodeSseEndpoint
  fetchImpl?: OpenCodeSseFetch
  signal?: AbortSignal
  onEvent(event: OpenCodeSseEvent): void
}): Promise<OpenCodeSseEndpointReadResult> {
  const diagnostics: string[] = []
  const fetchImpl = params.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(params.baseUrl + params.endpoint, {
      method: 'GET',
      signal: params.signal,
      headers: {
        Accept: 'text/event-stream',
      },
    })
  } catch (error) {
    if (params.signal?.aborted) {
      return {
        endpoint: params.endpoint,
        connected: false,
        closedBeforeAbort: false,
        observedEventCount: 0,
        diagnostics,
      }
    }
    diagnostics.push(
      `OpenCode SSE failed to connect to ${params.endpoint} - ${error instanceof Error ? error.message : String(error)}`,
    )
    return {
      endpoint: params.endpoint,
      connected: false,
      closedBeforeAbort: false,
      observedEventCount: 0,
      diagnostics,
    }
  }

  if (!response.ok) {
    diagnostics.push(
      `OpenCode SSE endpoint ${params.endpoint} returned ${response.status} ${response.statusText}`,
    )
    return {
      endpoint: params.endpoint,
      connected: false,
      closedBeforeAbort: false,
      observedEventCount: 0,
      diagnostics,
    }
  }

  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    diagnostics.push(`OpenCode SSE endpoint ${params.endpoint} did not return text/event-stream`)
    return {
      endpoint: params.endpoint,
      connected: false,
      closedBeforeAbort: false,
      observedEventCount: 0,
      diagnostics,
    }
  }

  if (!response.body) {
    diagnostics.push(`OpenCode SSE endpoint ${params.endpoint} returned no stream body`)
    return {
      endpoint: params.endpoint,
      connected: false,
      closedBeforeAbort: false,
      observedEventCount: 0,
      diagnostics,
    }
  }

  let observedEventCount = 0
  let buffer = ''
  let reachedEof = false
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        reachedEof = true
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
            diagnostics.push('OpenCode SSE ignored an unrecognized payload shape')
            continue
          }
          observedEventCount += 1
          params.onEvent(event)
        } catch (error) {
          diagnostics.push(
            `OpenCode SSE ignored malformed payload - ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }

    const finalData = extractOpenCodeSseData(buffer)
    if (finalData) {
      try {
        const event = normalizeOpenCodeSseEvent(JSON.parse(finalData))
        if (event) {
          observedEventCount += 1
          params.onEvent(event)
        }
      } catch (error) {
        diagnostics.push(
          `OpenCode SSE ignored malformed trailing payload - ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  } catch (error) {
    if (!params.signal?.aborted) {
      diagnostics.push(
        `OpenCode SSE stream ${params.endpoint} failed - ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } finally {
    reader.releaseLock()
  }

  return {
    endpoint: params.endpoint,
    connected: true,
    closedBeforeAbort: reachedEof && !params.signal?.aborted,
    observedEventCount,
    diagnostics,
  }
}
