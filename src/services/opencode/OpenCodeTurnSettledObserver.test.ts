import { describe, expect, test } from 'bun:test'

import { OpenCodeTurnSettledObserver } from './OpenCodeTurnSettledObserver.js'

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

describe('OpenCodeTurnSettledObserver', () => {
  test('settles successfully when prompt persists, assistant activity occurs, and session becomes idle', async () => {
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_1',
      fetchImpl: async input => {
        expect(String(input)).toBe('http://127.0.0.1:4096/event')
        return buildSseResponse([
          'data: {"type":"server.connected","properties":{}}\n\n',
          'data: {"type":"message.updated","properties":{"info":{"id":"msg_prompt_1","role":"user","sessionID":"session-1"}}}\n\n',
          'data: {"type":"message.updated","properties":{"info":{"id":"msg-assistant-1","role":"assistant","sessionID":"session-1"}}}\n\n',
          'data: {"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"session-1","messageID":"msg-assistant-1"}}}\n\n',
          'data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n',
        ])
      },
    })

    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 500,
      idleTimeoutMs: 100,
    })
    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()

    const summary = await observation.waitForSettled()

    expect(summary).toMatchObject({
      outcome: 'success',
      runtimePromptMessageId: 'msg_prompt_1',
      promptPersisted: true,
      assistantActivityCount: 2,
      latestAssistantMessageId: 'msg-assistant-1',
      latestEventType: 'session.status',
      streamConnected: true,
    })
  })

  test('does not treat prompt persistence alone as completed assistant work', async () => {
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_2',
      fetchImpl: async () =>
        buildSseResponse([
          'data: {"type":"message.updated","properties":{"info":{"id":"msg_prompt_2","role":"user","sessionID":"session-1"}}}\n\n',
          'data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n',
        ]),
    })

    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 500,
      idleTimeoutMs: 100,
    })
    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()

    const summary = await observation.waitForSettled()

    expect(summary.outcome).toBe('idle_without_assistant_activity')
    expect(summary.promptPersisted).toBe(true)
    expect(summary.assistantActivityCount).toBe(0)
  })

  test('falls back to global event stream when local endpoint is unavailable', async () => {
    const urls: string[] = []
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_3',
      fetchImpl: async input => {
        const url = String(input)
        urls.push(url)
        if (url.endsWith('/global/event')) {
          return buildSseResponse([
            'data: {"directory":"/tmp/project","payload":{"type":"message.updated","properties":{"info":{"id":"msg-assistant-2","role":"assistant","sessionID":"session-1"}}}}\n\n',
            'data: {"directory":"/tmp/project","payload":{"type":"session.idle","properties":{"sessionID":"session-1"}}}\n\n',
          ])
        }
        if (url.endsWith('/event')) {
          return buildSseResponse(['not found'], 404, 'text/plain')
        }
        throw new Error(`Unexpected URL ${url}`)
      },
    })

    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      projectPath: '/tmp/project',
      timeoutMs: 500,
      idleTimeoutMs: 100,
    })
    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()

    const summary = await observation.waitForSettled()

    expect(urls).toEqual([
      'http://127.0.0.1:4096/event',
      'http://127.0.0.1:4096/global/event',
    ])
    expect(summary.outcome).toBe('success')
    expect(summary.endpoint).toBe('/global/event')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-2')
  })
})
