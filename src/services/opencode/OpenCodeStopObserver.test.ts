import { describe, expect, test } from 'bun:test'

import { startOpenCodeStopObserver } from './OpenCodeStopObserver.js'

function sseEvent(value: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
}

describe('OpenCodeStopObserver', () => {
  test('waits for server.connected and accepts idle only for the exact session', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const fetchImpl = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controller.enqueue(sseEvent({ type: 'server.connected', properties: {} }))
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })

    const observer = await startOpenCodeStopObserver({
      baseUrl: 'http://127.0.0.1:1',
      sessionId: 'target-session',
      fetchImpl,
    })
    streamController.enqueue(sseEvent({
      type: 'session.status',
      properties: { sessionID: 'target-session', status: { type: 'idle' } },
    }))
    expect(await observer.waitForIdle(0)).toBe(false)
    observer.arm()
    streamController.enqueue(sseEvent({
      type: 'session.status',
      properties: { sessionID: 'other-session', status: { type: 'idle' } },
    }))
    expect(await observer.waitForIdle(0)).toBe(false)
    streamController.enqueue(sseEvent({
      type: 'session.status',
      properties: { sessionID: 'target-session', status: { type: 'idle' } },
    }))
    expect(await observer.waitForIdle(50)).toBe(true)
    await observer.dispose()
  })

  test('fails closed when the stream ends before server.connected', async () => {
    const fetchImpl = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.close() },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })

    await expect(startOpenCodeStopObserver({
      baseUrl: 'http://127.0.0.1:1',
      sessionId: 'target-session',
      fetchImpl,
    })).rejects.toThrow('closed before server.connected')
  })

  test('accepts the exact deprecated session.idle event and settles the reader on dispose', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const fetchImpl = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controller.enqueue(sseEvent({ type: 'server.connected', properties: {} }))
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const observer = await startOpenCodeStopObserver({
      baseUrl: 'http://127.0.0.1:1', sessionId: 'target-session', fetchImpl,
    })
    observer.arm()
    streamController.enqueue(sseEvent({
      type: 'session.idle', properties: { sessionID: 'target-session' },
    }))
    expect(await observer.waitForIdle(50)).toBe(true)
    await observer.dispose()
  })

  test('propagates cancellation while waiting for server.connected', async () => {
    const controller = new AbortController()
    const reason = new Error('stop deadline expired')
    const fetchImpl = async () => new Response(new ReadableStream<Uint8Array>({}), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
    const pending = startOpenCodeStopObserver({
      baseUrl: 'http://127.0.0.1:1', sessionId: 'target-session',
      signal: controller.signal, fetchImpl,
    })
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })
})
