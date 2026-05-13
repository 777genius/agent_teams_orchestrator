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

function buildControlledSseResponse(): {
  response: Response
  send(data: string): void
  close(): void
} {
  const encoder = new TextEncoder()
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
        },
      },
    ),
    send(data: string) {
      streamController?.enqueue(encoder.encode(data))
    },
    close() {
      streamController?.close()
    },
  }
}

async function waitForTick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
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
          'data: {"type":"session.status","properties":{"sessionID":"session-1","status":{"session-1":{"type":"idle"}}}}\n\n',
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
      assistantActivityCount: 1,
      latestAssistantMessageId: 'msg-assistant-1',
      latestEventType: 'session.status',
      streamConnected: true,
    })
  })

  test('does not treat prompt persistence alone as completed assistant work', async () => {
    const startedAt = Date.now()
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_2',
      fetchImpl: async () => stream.response,
    })

    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 120,
      idleTimeoutMs: 100,
    })
    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg_prompt_2","role":"user","sessionID":"session-1"}}}\n\n')
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')

    const summary = await observation.waitForSettled()

    expect(summary.outcome).toBe('idle_without_assistant_activity')
    expect(summary.promptPersisted).toBe(true)
    expect(summary.assistantActivityCount).toBe(0)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
    expect(summary.diagnostics.join('\n')).toContain('waiting for full turn timeout')
    expect(summary.diagnostics.join('\n')).toContain('before 120ms timeout')
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
            'data: {"directory":"/tmp/project","payload":{"type":"message.updated","properties":{"info":{"id":"msg_prompt_3","role":"user","sessionID":"session-1"}}}}\n\n',
            'data: {"directory":"/tmp/project","payload":{"type":"message.updated","properties":{"info":{"id":"msg-assistant-2","role":"assistant","sessionID":"session-1"}}}}\n\n',
            'data: {"directory":"/tmp/project","payload":{"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"session-1","messageID":"msg-assistant-2"}}}}\n\n',
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

  test('does not settle on stale idle before current prompt evidence', async () => {
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_3b',
      fetchImpl: async () => stream.response,
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 120,
      idleTimeoutMs: 100,
    })
    let settled = false
    const waitPromise = observation.waitForSettled().then(summary => {
      settled = true
      return summary
    })

    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')
    await waitForTick()

    expect(settled).toBe(false)

    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg_prompt_3b","role":"user","sessionID":"session-1"}}}\n\n')
    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg-assistant-3b","role":"assistant","sessionID":"session-1"}}}\n\n')
    stream.send('data: {"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"session-1","messageID":"msg-assistant-3b"}}}\n\n')
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')
    const summary = await waitPromise

    expect(summary.outcome).toBe('success')
    expect(summary.promptPersisted).toBe(true)
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-3b')
    expect(summary.diagnostics.join('\n')).toContain('ignored session.status idle')
  })

  test('waits through early idle and still captures later assistant activity', async () => {
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_3e',
      fetchImpl: async () => stream.response,
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 120,
      idleTimeoutMs: 100,
    })
    let settled = false
    const waitPromise = observation.waitForSettled().then(summary => {
      settled = true
      return summary
    })

    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg_prompt_3e","role":"user","sessionID":"session-1"}}}\n\n')
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')
    await waitForTick()

    expect(settled).toBe(false)

    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg-assistant-3e","role":"assistant","sessionID":"session-1"}}}\n\n')
    stream.send('data: {"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"session-1","messageID":"msg-assistant-3e"}}}\n\n')
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')
    const summary = await waitPromise

    expect(summary.outcome).toBe('success')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-3e')
    expect(summary.diagnostics.join('\n')).toContain('waiting for full turn timeout')
  })

  test('does not treat an empty assistant message shell as completed activity', async () => {
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_3g',
      fetchImpl: async () => stream.response,
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 1_000,
      idleTimeoutMs: 100,
    })
    let settled = false
    const waitPromise = observation.waitForSettled().then(summary => {
      settled = true
      return summary
    })

    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg_prompt_3g","role":"user","sessionID":"session-1"}}}\n\n')
    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg-assistant-3g","role":"assistant","sessionID":"session-1","parentID":"msg_prompt_3g"}}}\n\n')
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(settled).toBe(false)

    stream.send('data: {"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"session-1","messageID":"msg-assistant-3g"}}}\n\n')
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')
    const summary = await waitPromise

    expect(summary.outcome).toBe('success')
    expect(summary.assistantActivityCount).toBe(1)
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-3g')
  })

  test('does not count assistant activity before current prompt evidence', async () => {
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_3c',
      fetchImpl: async () => stream.response,
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 120,
      idleTimeoutMs: 100,
    })

    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg-old-assistant","role":"assistant","sessionID":"session-1"}}}\n\n')
    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg_prompt_3c","role":"user","sessionID":"session-1"}}}\n\n')
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')
    const summary = await observation.waitForSettled()

    expect(summary.outcome).toBe('idle_without_assistant_activity')
    expect(summary.promptPersisted).toBe(true)
    expect(summary.assistantActivityCount).toBe(0)
    expect(summary.diagnostics.join('\n')).toContain('ignored assistant message shell')
  })

  test('tracks assistant shell before prompt persistence but waits for real part activity', async () => {
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_3d',
      fetchImpl: async () => stream.response,
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 120,
      idleTimeoutMs: 100,
    })

    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg-assistant-3d","role":"assistant","sessionID":"session-1","parentID":"msg_prompt_3d"}}}\n\n')
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')
    const summary = await observation.waitForSettled()

    expect(summary.outcome).toBe('idle_without_assistant_activity')
    expect(summary.assistantActivityCount).toBe(0)
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-3d')
  })

  test('counts accepted assistant part activity before prompt persistence', async () => {
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_3f',
      fetchImpl: async () => stream.response,
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 120,
      idleTimeoutMs: 100,
    })

    observation.markPromptSubmitting()
    stream.send('data: {"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"session-1","messageID":"msg-stale-part"}}}\n\n')
    await waitForTick()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"session-1","messageID":"msg-assistant-3f"}}}\n\n')
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')
    const summary = await observation.waitForSettled()

    expect(summary.outcome).toBe('success')
    expect(summary.assistantActivityCount).toBe(1)
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-3f')
    expect(summary.diagnostics.join('\n')).toContain('ignored assistant activity')
  })

  test('does not attribute a pre-acceptance session.error without current prompt evidence', async () => {
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_4',
      fetchImpl: async () => stream.response,
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 120,
      idleTimeoutMs: 100,
    })
    let settled = false
    const waitPromise = observation.waitForSettled().then(summary => {
      settled = true
      return summary
    })

    observation.markPromptSubmitting()
    stream.send('data: {"type":"session.error","properties":{"sessionID":"session-1"}}\n\n')
    await waitForTick()

    expect(settled).toBe(false)

    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg_prompt_4","role":"user","sessionID":"session-1"}}}\n\n')
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')
    const summary = await waitPromise

    expect(summary.outcome).toBe('idle_without_assistant_activity')
    expect(summary.promptPersisted).toBe(true)
    expect(summary.diagnostics.join('\n')).toContain('before prompt_async endpoint acceptance')
    expect(summary.diagnostics.join('\n')).toContain('OpenCode observed session.error for session-1')
  })

  test('does not attribute a post-acceptance session.error before current prompt evidence', async () => {
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_4a',
      fetchImpl: async () => stream.response,
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 120,
      idleTimeoutMs: 100,
    })
    let settled = false
    const waitPromise = observation.waitForSettled().then(summary => {
      settled = true
      return summary
    })

    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"session.error","properties":{"sessionID":"session-1"}}\n\n')
    await waitForTick()

    expect(settled).toBe(false)

    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg_prompt_4a","role":"user","sessionID":"session-1"}}}\n\n')
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')
    const summary = await waitPromise

    expect(summary.outcome).toBe('idle_without_assistant_activity')
    expect(summary.promptPersisted).toBe(true)
    expect(summary.diagnostics.join('\n')).toContain('without current prompt evidence')
  })

  test('attributes a session.error after current prompt evidence', async () => {
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_4c',
      fetchImpl: async () => stream.response,
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 1_000,
      idleTimeoutMs: 100,
    })

    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg_prompt_4c","role":"user","sessionID":"session-1"}}}\n\n')
    stream.send('data: {"type":"session.error","properties":{"sessionID":"session-1"}}\n\n')
    const summary = await observation.waitForSettled()

    expect(summary.outcome).toBe('error')
    expect(summary.promptPersisted).toBe(true)
    expect(summary.diagnostics.join('\n')).toContain('OpenCode observed session.error for session-1')
  })

  test('does not promote a buffered session.error when current assistant activity is already observed', async () => {
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_4b',
      fetchImpl: async () => stream.response,
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 1_000,
      idleTimeoutMs: 100,
    })

    observation.markPromptSubmitting()
    stream.send('data: {"type":"session.error","properties":{"sessionID":"session-1"}}\n\n')
    stream.send('data: {"type":"message.updated","properties":{"info":{"id":"msg-assistant-4b","role":"assistant","sessionID":"session-1","parentID":"msg_prompt_4b"}}}\n\n')
    await waitForTick()

    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"session-1","messageID":"msg-assistant-4b"}}}\n\n')
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')
    const summary = await observation.waitForSettled()

    expect(summary.outcome).toBe('success')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-4b')
    expect(summary.diagnostics.join('\n')).toContain('before prompt_async endpoint acceptance')
  })

  test('reports premature SSE EOF before terminal idle as stream_unavailable', async () => {
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_5',
      fetchImpl: async () =>
        buildSseResponse([
          'data: {"type":"server.connected","properties":{}}\n\n',
          'data: {"type":"message.updated","properties":{"info":{"id":"msg_prompt_5","role":"user","sessionID":"session-1"}}}\n\n',
        ]),
    })

    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 1_000,
      idleTimeoutMs: 100,
    })
    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()

    const summary = await observation.waitForSettled()

    expect(summary.outcome).toBe('stream_unavailable')
    expect(summary.diagnostics.join('\n')).toContain('OpenCode SSE stream closed before terminal event')
  })
})
