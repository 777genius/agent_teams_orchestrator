import { describe, expect, test } from 'bun:test'

import {
  extractOpenCodeSseData,
  normalizeOpenCodeSseEvent,
  parseOpenCodeSseDataBlocks,
  readOpenCodeSseEndpoint,
} from './OpenCodeSseEventStream.js'

function buildSseResponse(chunks: string[], status = 200, contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    }),
    {
      status,
      headers: {
        'content-type': contentType,
      },
    },
  )
}

describe('OpenCodeSseEventStream', () => {
  test('normalizes direct and global wrapped OpenCode event payloads', () => {
    expect(normalizeOpenCodeSseEvent({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: 'idle' },
    })).toMatchObject({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: 'idle' },
      directory: null,
    })

    expect(normalizeOpenCodeSseEvent({
      directory: '/tmp/project',
      payload: {
        type: 'message.updated',
        properties: { info: { id: 'msg-1', role: 'assistant' } },
      },
    })).toMatchObject({
      type: 'message.updated',
      properties: { info: { id: 'msg-1', role: 'assistant' } },
      directory: '/tmp/project',
    })
  })

  test('extracts multi-line SSE data blocks while ignoring comments', () => {
    const blocks = parseOpenCodeSseDataBlocks(': ping\n\ndata: {\"a\":1}\ndata: {\"b\":2}\n\n')

    expect(blocks).toEqual([': ping', 'data: {"a":1}\ndata: {"b":2}', ''])
    expect(extractOpenCodeSseData(blocks[0] ?? '')).toBeNull()
    expect(extractOpenCodeSseData(blocks[1] ?? '')).toBe('{"a":1}\n{"b":2}')
  })

  test('reads OpenCode SSE stream and reports malformed payload diagnostics', async () => {
    const events: unknown[] = []

    const result = await readOpenCodeSseEndpoint({
      baseUrl: 'http://127.0.0.1:4096',
      endpoint: '/event',
      fetchImpl: async input => {
        expect(String(input)).toBe('http://127.0.0.1:4096/event')
        return buildSseResponse([
          'data: {"type":"server.connected","properties":{}}\n\n',
          'data: not-json\n\n',
          'data: {"payload":{"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}}\n\n',
        ])
      },
      onEvent: event => {
        events.push(event)
      },
    })

    expect(result).toMatchObject({
      endpoint: '/event',
      connected: true,
      observedEventCount: 2,
    })
    expect(result.diagnostics[0]).toContain('malformed payload')
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: 'idle' },
    })
  })
})
