import { describe, expect, test } from 'bun:test'

import { OpenCodeTurnSettledObserver } from './OpenCodeTurnSettledObserver.js'
import type { OpenCodeMessage } from './types.js'

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
  test('does not settle during silence between completed tool steps and the final assistant response', async () => {
    const stream = buildControlledSseResponse()
    let transcriptReads = 0
    let finalResponse = false
    const observer = new OpenCodeTurnSettledObserver({
      fetchImpl: async input => {
        if (String(input).endsWith('/event')) return stream.response
        if (String(input).endsWith('/permission') || String(input).endsWith('/question')) return Response.json([])
        transcriptReads += 1
        return Response.json([
          { info: { id: 'msg-prompt', role: 'user', sessionID: 'session-1', time: { created: 1 } }, parts: [] },
          {
            info: { id: 'msg-tool', role: 'assistant', parentID: 'msg-prompt', sessionID: 'session-1', finish: 'tool-calls', time: { created: 2, completed: 100 } },
            parts: [
              { id: 'prt-tool-text', sessionID: 'session-1', messageID: 'msg-tool', type: 'text', text: 'Checking the task and writing the result.' },
              { id: 'prt-tool-call', sessionID: 'session-1', messageID: 'msg-tool', type: 'tool', callID: 'call-1', tool: 'agent-teams_task_get', state: { status: 'completed', input: {}, output: 'ok', time: { start: 3, end: 99 } } },
              { id: 'prt-tool-end', sessionID: 'session-1', messageID: 'msg-tool', type: 'step-finish', reason: 'tool-calls' },
            ],
          },
          ...(finalResponse ? [{
            info: { id: 'msg-final', role: 'assistant', parentID: 'msg-prompt', sessionID: 'session-1', finish: 'stop', time: { created: 101, completed: 200 } },
            parts: [{ id: 'prt-final-text', sessionID: 'session-1', messageID: 'msg-final', type: 'text', text: 'Task completed.' }],
          }] : []),
        ])
      },
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096', sessionId: 'session-1', runtimePromptMessageId: 'msg-prompt',
      timeoutMs: 1_000, idleTimeoutMs: 10,
    })
    let settled = false
    const waitPromise = observation.waitForSettled().then(summary => { settled = true; return summary })
    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"message.part.updated","properties":{"part":{"type":"tool","sessionID":"session-1","messageID":"msg-tool"}}}\n\n')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(settled).toBe(false)
    expect(transcriptReads).toBeGreaterThanOrEqual(1)

    finalResponse = true
    stream.send('data: {"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"session-1","messageID":"msg-final"}}}\n\n')
    const summary = await waitPromise
    expect(summary.outcome).toBe('success')
    expect(summary.latestAssistantMessageId).toBe('msg-final')
    expect(summary.diagnostics.join('\n')).toContain('terminal assistant response')
  })

  test.each([
    ['unfinished', { info: { id: 'msg-latest', role: 'assistant' }, parts: [{ type: 'step-start' }] }, 'timeout'],
    ['unknown', { info: { id: 'msg-latest', role: 'assistant', finish: 'unknown', time: { completed: 200 } }, parts: [] }, 'timeout'],
    ['error', { info: { id: 'msg-latest', role: 'assistant', error: { name: 'APIError', message: 'Provider failed' } }, parts: [] }, 'timeout'],
  ] as const)('uses the latest %s response during silence instead of an earlier completed answer', async (_, latest, outcome) => {
    const stream = buildControlledSseResponse()
    const transcript: OpenCodeMessage[] = [
      { info: { id: 'msg-prompt', role: 'user', sessionID: 'session-1', time: { created: 1 } }, parts: [] },
      {
        info: { id: 'msg-earlier', parentID: 'msg-prompt', sessionID: 'session-1', role: 'assistant', finish: 'stop', time: { created: 2, completed: 100 } },
        parts: [{ id: 'prt-earlier', sessionID: 'session-1', messageID: 'msg-earlier', type: 'text', text: 'Earlier answer' }],
      },
      { info: { ...latest.info, sessionID: 'session-1', parentID: 'msg-prompt', time: { created: 101, ...('time' in latest.info ? latest.info.time : {}) } }, parts: latest.parts.map((part, index) => ({ ...part, id: `prt-latest-${index}`, sessionID: 'session-1', messageID: latest.info.id })) },
    ]
    const observer = new OpenCodeTurnSettledObserver({
      fetchImpl: async input => String(input).endsWith('/event') ? stream.response : Response.json(String(input).includes('/message?') ? transcript : []),
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096', sessionId: 'session-1', runtimePromptMessageId: 'msg-prompt',
      timeoutMs: 60, idleTimeoutMs: 10,
    })
    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"session-1","messageID":"msg-latest"}}}\n\n')
    const summary = await observation.waitForSettled()
    expect(summary.outcome).toBe(outcome)
    expect(summary.latestAssistantMessageId).toBe('msg-latest')
  })

  test('rearms silence reconciliation when new activity outlasts an in-flight transcript read', async () => {
    const stream = buildControlledSseResponse()
    let transcriptReads = 0
    let resolveFirstRead!: (response: Response) => void
    let notifyFirstRead!: () => void
    const firstReadStarted = new Promise<void>(resolve => { notifyFirstRead = resolve })
    const finalTranscript = (messageId: string) => Response.json([
      { info: { id: 'msg-prompt', role: 'user', sessionID: 'session-1', time: { created: 1 } }, parts: [] },
      {
        info: { id: messageId, role: 'assistant', parentID: 'msg-prompt', sessionID: 'session-1', finish: 'stop', time: { created: 2, completed: 100 } },
        parts: [{ id: `prt-${messageId}`, sessionID: 'session-1', messageID: messageId, type: 'text', text: 'Done.' }],
      },
    ])
    const observer = new OpenCodeTurnSettledObserver({
      fetchImpl: async input => {
        if (String(input).endsWith('/event')) return stream.response
        if (String(input).endsWith('/permission') || String(input).endsWith('/question')) return Response.json([])
        transcriptReads += 1
        if (transcriptReads === 1) {
          const pending = new Promise<Response>(resolve => { resolveFirstRead = resolve })
          notifyFirstRead()
          return pending
        }
        return finalTranscript('msg-final')
      },
    })
    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096', sessionId: 'session-1', runtimePromptMessageId: 'msg-prompt',
      timeoutMs: 1_000, idleTimeoutMs: 10,
    })
    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"session-1","messageID":"msg-earlier"}}}\n\n')
    await firstReadStarted
    stream.send('data: {"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"session-1","messageID":"msg-final"}}}\n\n')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(transcriptReads).toBeGreaterThanOrEqual(1)
    resolveFirstRead(finalTranscript('msg-earlier'))

    const summary = await observation.waitForSettled()
    expect(summary.outcome).toBe('success')
    expect(summary.latestAssistantMessageId).toBe('msg-final')
    expect(transcriptReads).toBe(4)
  })

  test('rejects idle and activity without persisted native terminal proof', async () => {
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
      outcome: 'stream_unavailable',
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
    expect(summary.terminalProof).toBeUndefined()
    expect(summary.terminalProof).toBeUndefined()
  })

  test('records legacy part deltas without terminal proof', async () => {
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_delta',
      fetchImpl: async input => {
        expect(String(input)).toBe('http://127.0.0.1:4096/event')
        return buildSseResponse([
          'data: {"type":"server.connected","properties":{}}\n\n',
          'data: {"type":"message.part.delta","properties":{"sessionID":"session-1","messageID":"msg-assistant-delta","partID":"part-1","field":"text","delta":"OK"}}\n\n',
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
      outcome: 'stream_unavailable',
      runtimePromptMessageId: 'msg_prompt_delta',
      promptPersisted: false,
      assistantActivityCount: 1,
      latestAssistantMessageId: 'msg-assistant-delta',
      latestEventType: 'session.status',
      streamConnected: true,
    })
  })

  test('uses transcript reconcile after idle when OpenCode omits turn update events', async () => {
    const stream = buildControlledSseResponse()
    const urls: string[] = []
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_reconcile',
      fetchImpl: async input => {
        const url = String(input)
        urls.push(url)
        if (url.endsWith('/event')) {
          return stream.response
        }
        if (url.endsWith('/session/session-1/message?limit=50')) {
          return new Response(JSON.stringify([
            {
              info: { id: 'msg_prompt_reconcile', role: 'user', sessionID: 'session-1' },
              parts: [{ type: 'text', text: 'Reply with exactly OK.' }],
            },
            {
              info: {
                id: 'msg-assistant-reconcile',
                role: 'assistant',
                parentID: 'msg_prompt_reconcile',
                sessionID: 'session-1',
              },
              parts: [
                { type: 'step-start' },
                { type: 'text', text: 'OK' },
                { type: 'step-finish' },
              ],
            },
          ]), {
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`Unexpected URL ${url}`)
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
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')

    const summary = await observation.waitForSettled()

    expect(urls).toContain('http://127.0.0.1:4096/session/session-1/message?limit=50')
    expect(summary).toMatchObject({
      outcome: 'timeout',
      runtimePromptMessageId: 'msg_prompt_reconcile',
      promptPersisted: false,
      assistantActivityCount: 0,
      latestAssistantMessageId: null,
    })
  })

  test('does not use transcript reconcile success for an empty assistant shell', async () => {
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_empty_reconcile',
      fetchImpl: async input => {
        const url = String(input)
        if (url.endsWith('/event')) {
          return stream.response
        }
        if (url.endsWith('/session/session-1/message?limit=50')) {
          return new Response(JSON.stringify([
            {
              info: { id: 'msg_prompt_empty_reconcile', role: 'user', sessionID: 'session-1' },
              parts: [{ type: 'text', text: 'Reply with exactly OK.' }],
            },
            {
              info: {
                id: 'msg-assistant-empty-reconcile',
                role: 'assistant',
                parentID: 'msg_prompt_empty_reconcile',
                sessionID: 'session-1',
              },
              parts: [],
            },
          ]), {
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`Unexpected URL ${url}`)
      },
    })

    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 120,
      idleTimeoutMs: 100,
    })
    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')

    const summary = await observation.waitForSettled()

    expect(summary.outcome).toBe('timeout')
    expect(summary.promptPersisted).toBe(false)
    expect(summary.assistantActivityCount).toBe(0)
    expect(summary.latestAssistantMessageId).toBeNull()
    expect(summary.terminalProof).toBeUndefined()
  })

  test('does not use transcript reconcile success for a step-start-only assistant shell', async () => {
    const stream = buildControlledSseResponse()
    const observer = new OpenCodeTurnSettledObserver({
      promptMessageIdFactory: () => 'msg_prompt_started_reconcile',
      fetchImpl: async input => {
        const url = String(input)
        if (url.endsWith('/event')) {
          return stream.response
        }
        if (url.endsWith('/session/session-1/message?limit=50')) {
          return new Response(JSON.stringify([
            {
              info: { id: 'msg_prompt_started_reconcile', role: 'user', sessionID: 'session-1' },
              parts: [{ type: 'text', text: 'Reply with exactly OK.' }],
            },
            {
              info: {
                id: 'msg-assistant-started-reconcile',
                role: 'assistant',
                parentID: 'msg_prompt_started_reconcile',
                sessionID: 'session-1',
              },
              parts: [{ type: 'step-start' }],
            },
          ]), {
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`Unexpected URL ${url}`)
      },
    })

    const observation = observer.observe({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'session-1',
      timeoutMs: 120,
      idleTimeoutMs: 100,
    })
    observation.markPromptSubmitting()
    observation.markPromptAcceptedByEndpoint()
    stream.send('data: {"type":"session.status","properties":{"sessionID":"session-1","status":"idle"}}\n\n')

    const summary = await observation.waitForSettled()

    expect(summary.outcome).toBe('timeout')
    expect(summary.promptPersisted).toBe(false)
    expect(summary.assistantActivityCount).toBe(0)
    expect(summary.latestAssistantMessageId).toBeNull()
    expect(summary.terminalProof).toBeUndefined()
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

    expect(urls).toEqual(expect.arrayContaining([
      'http://127.0.0.1:4096/event',
      'http://127.0.0.1:4096/global/event',
    ]))
    expect(summary.outcome).toBe('stream_unavailable')
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

    expect(summary.outcome).toBe('timeout')
    expect(summary.promptPersisted).toBe(true)
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-3b')
    expect(summary.terminalProof).toBeUndefined()
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

    expect(summary.outcome).toBe('timeout')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-3e')
    expect(summary.terminalProof).toBeUndefined()
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

    expect(summary.outcome).toBe('timeout')
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
    expect(summary.terminalProof).toBeUndefined()
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

    expect(summary.outcome).toBe('timeout')
    expect(summary.assistantActivityCount).toBe(1)
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-3f')
    expect(summary.terminalProof).toBeUndefined()
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
    expect(summary.terminalProof).toBeUndefined()
    expect(summary.terminalProof).toBeUndefined()
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
    expect(summary.terminalProof).toBeUndefined()
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

    expect(summary.outcome).toBe('idle_without_assistant_activity')
    expect(summary.promptPersisted).toBe(true)
    expect(summary.terminalProof).toBeUndefined()
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

    expect(summary.outcome).toBe('timeout')
    expect(summary.latestAssistantMessageId).toBe('msg-assistant-4b')
    expect(summary.terminalProof).toBeUndefined()
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
    expect(summary.terminalProof).toBeUndefined()
  })
})
