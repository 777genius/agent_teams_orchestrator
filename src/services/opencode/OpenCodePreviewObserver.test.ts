import { describe, expect, test } from 'bun:test'

import { OpenCodePreviewObserver } from './OpenCodePreviewObserver.js'

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

describe('OpenCodePreviewObserver', () => {
  test('streams assistant preview from /event without claiming durable ownership', async () => {
    const observer = new OpenCodePreviewObserver({
      fetchImpl: async input => {
        expect(String(input)).toBe('http://127.0.0.1:4096/event')
        return buildSseResponse([
          'data: {"type":"server.connected","properties":{}}\n\n',
          'data: {"type":"session.status","properties":{"sessionID":"session-1","status":{"type":"busy"}}}\n\n',
          'data: {"type":"message.updated","properties":{"info":{"id":"msg-assistant-1","role":"assistant","sessionID":"session-1"}}}\n\n',
          'data: {"type":"message.part.updated","properties":{"part":{"id":"part-1","type":"text","sessionID":"session-1","messageID":"msg-assistant-1"},"delta":"Hello"}}\n\n',
          'data: {"type":"message.part.updated","properties":{"part":{"id":"part-1","type":"text","sessionID":"session-1","messageID":"msg-assistant-1"},"delta":" world"}}\n\n',
          'data: {"type":"session.status","properties":{"sessionID":"session-1","status":{"type":"idle"}}}\n\n',
        ])
      },
    })

    const summary = await observer.observeSession({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 500,
      idleTimeoutMs: 100,
    })

    expect(summary.previewOutcome).toBe('observed')
    expect(summary.streamEndpoint).toBe('/event')
    expect(summary.streamConnected).toBe(true)
    expect(summary.runtimeState).toBe('idle')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-1')
    expect(summary.latestAssistantPreview).toBe('Hello world')
    expect(summary.matchedEventCount).toBe(5)
    expect(summary.pendingPermissionRequestIds).toEqual([])
  })

  test('falls back to /global/event and tracks blocked preview state', async () => {
    const requestedUrls: string[] = []
    const observer = new OpenCodePreviewObserver({
      fetchImpl: async input => {
        const url = String(input)
        requestedUrls.push(url)
        if (url.endsWith('/global/event')) {
          return buildSseResponse([
            'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
            'data: {"directory":"/tmp/project","payload":{"type":"permission.asked","properties":{"requestID":"perm-1","sessionID":"session-1","tool":"bash"}}}\n\n',
          ])
        }

        if (url.endsWith('/event')) {
          return buildSseResponse(['not found'], 404, 'text/plain')
        }
        throw new Error(`Unexpected preview URL ${url}`)
      },
    })

    const summary = await observer.observeSession({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 500,
      idleTimeoutMs: 100,
    })

    expect(requestedUrls).toEqual([
      'http://127.0.0.1:4096/event',
      'http://127.0.0.1:4096/global/event',
    ])
    expect(summary.previewOutcome).toBe('observed')
    expect(summary.streamEndpoint).toBe('/global/event')
    expect(summary.runtimeState).toBe('blocked')
    expect(summary.pendingPermissionRequestIds).toEqual(['perm-1'])
  })

  test('keeps buffered assistant text until assistant metadata arrives later', async () => {
    const observer = new OpenCodePreviewObserver({
      fetchImpl: async () =>
        buildSseResponse([
          'data: {"type":"server.connected","properties":{}}\n\n',
          'data: {"type":"message.part.updated","properties":{"part":{"id":"part-1","type":"text","sessionID":"session-1","messageID":"msg-assistant-2"},"delta":"pong"}}\n\n',
          'data: {"type":"message.updated","properties":{"info":{"id":"msg-assistant-2","role":"assistant","sessionID":"session-1"}}}\n\n',
        ]),
    })

    const summary = await observer.observeSession({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 500,
      idleTimeoutMs: 100,
    })

    expect(summary.previewOutcome).toBe('observed')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-2')
    expect(summary.latestAssistantPreview).toBe('pong')
  })

  test('streams assistant preview from message.part.delta events', async () => {
    const observer = new OpenCodePreviewObserver({
      fetchImpl: async () =>
        buildSseResponse([
          'data: {"type":"server.connected","properties":{}}\n\n',
          'data: {"type":"session.status","properties":{"sessionID":"session-1","status":{"type":"busy"}}}\n\n',
          'data: {"type":"message.updated","properties":{"info":{"id":"msg-assistant-3","role":"assistant","sessionID":"session-1"}}}\n\n',
          'data: {"type":"message.part.delta","properties":{"sessionID":"session-1","messageID":"msg-assistant-3","partID":"part-1","field":"text","delta":"Hello"}}\n\n',
          'data: {"type":"message.part.delta","properties":{"sessionID":"session-1","messageID":"msg-assistant-3","partID":"part-1","field":"text","delta":" world"}}\n\n',
          'data: {"type":"message.part.delta","properties":{"sessionID":"session-1","messageID":"msg-assistant-3","partID":"part-1","field":"metadata","delta":" ignored"}}\n\n',
          'data: {"type":"session.status","properties":{"sessionID":"session-1","status":{"type":"idle"}}}\n\n',
        ]),
    })

    const summary = await observer.observeSession({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 500,
      idleTimeoutMs: 100,
    })

    expect(summary.previewOutcome).toBe('observed')
    expect(summary.runtimeState).toBe('idle')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-3')
    expect(summary.latestAssistantPreview).toBe('Hello world')
  })

  test('keeps delta text buffered until assistant metadata arrives later', async () => {
    const observer = new OpenCodePreviewObserver({
      fetchImpl: async () =>
        buildSseResponse([
          'data: {"type":"server.connected","properties":{}}\n\n',
          'data: {"type":"message.part.delta","properties":{"sessionID":"session-1","messageID":"msg-assistant-4","partID":"part-1","delta":"Hello"}}\n\n',
          'data: {"type":"message.part.delta","properties":{"sessionID":"session-1","messageID":"msg-assistant-4","partID":"part-1","delta":" world"}}\n\n',
          'data: {"type":"message.updated","properties":{"info":{"id":"msg-assistant-4","role":"assistant","sessionID":"session-1"}}}\n\n',
        ]),
    })

    const summary = await observer.observeSession({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 500,
      idleTimeoutMs: 100,
    })

    expect(summary.previewOutcome).toBe('observed')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-4')
    expect(summary.latestAssistantPreview).toBe('Hello world')
  })

  test('handles lower-case partId drift for delta and removal events', async () => {
    const observer = new OpenCodePreviewObserver({
      fetchImpl: async () =>
        buildSseResponse([
          'data: {"type":"server.connected","properties":{}}\n\n',
          'data: {"type":"message.updated","properties":{"info":{"id":"msg-assistant-5","role":"assistant","sessionID":"session-1"}}}\n\n',
          'data: {"type":"message.part.delta","properties":{"sessionID":"session-1","messageId":"msg-assistant-5","partId":"part-1","field":"text","delta":"remove me"}}\n\n',
          'data: {"type":"message.part.removed","properties":{"sessionID":"session-1","messageId":"msg-assistant-5","partId":"part-1"}}\n\n',
          'data: {"type":"message.part.delta","properties":{"sessionID":"session-1","messageId":"msg-assistant-5","partId":"part-2","field":"text","delta":"keep me"}}\n\n',
        ]),
    })

    const summary = await observer.observeSession({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 500,
      idleTimeoutMs: 100,
    })

    expect(summary.previewOutcome).toBe('observed')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-5')
    expect(summary.latestAssistantPreview).toBe('keep me')
  })

  test('clears stale preview when the last assistant text part is removed', async () => {
    const observer = new OpenCodePreviewObserver({
      fetchImpl: async () =>
        buildSseResponse([
          'data: {"type":"server.connected","properties":{}}\n\n',
          'data: {"type":"message.updated","properties":{"info":{"id":"msg-assistant-6","role":"assistant","sessionID":"session-1"}}}\n\n',
          'data: {"type":"message.part.delta","properties":{"sessionID":"session-1","messageID":"msg-assistant-6","partID":"part-1","field":"text","delta":"temporary"}}\n\n',
          'data: {"type":"message.part.removed","properties":{"sessionID":"session-1","messageID":"msg-assistant-6","partID":"part-1"}}\n\n',
        ]),
    })

    const summary = await observer.observeSession({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 500,
      idleTimeoutMs: 100,
    })

    expect(summary.previewOutcome).toBe('observed')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-6')
    expect(summary.latestAssistantPreview).toBeNull()
  })
})
