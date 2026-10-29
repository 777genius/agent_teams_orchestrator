import { expect, spyOn, test } from 'bun:test'
import * as transport from './OpenCodeNativeRequestLease.js'
import { OpenCodeClientFactory } from '../OpenCodeClientFactory.js'
import { readOpenCodeSseEndpoint } from '../OpenCodeSseEventStream.js'
import { readOpenCodeV1TerminalTranscript } from '../OpenCodeV1TerminalTranscriptReader.js'
import { OpenCodePreviewObserver } from '../OpenCodePreviewObserver.js'
import { startOpenCodeStopObserver } from '../OpenCodeStopObserver.js'
import { OpenCodeTurnSettledObserver } from '../OpenCodeTurnSettledObserver.js'

// These check consumer wiring through the production transport seam. Admission,
// physical epoch identity and real socket dispatch have separate controls.
test('factory forwards its captured host owner to every production operation', async () => {
  const owner = {}, received: Array<object | undefined> = []
  const wire = spyOn(transport, 'productionOpenCodeFetch').mockImplementation(async (_input, _init, value) => {
    received.push(value); return Response.json({})
  })
  try {
    const client = new OpenCodeClientFactory().create('http://TEST-loopback', undefined, owner)
    await client.getConfig(); await client.createSession(); await client.answerPermission({ requestId: 'TEST-id', decision: 'allow' })
    expect(received).toEqual([owner, owner, owner])
  } finally { wire.mockRestore() }
})

test('SSE, preview and terminal pages forward the same original request owner', async () => {
  const owner = {}, received: Array<object | undefined> = []
  const wire = spyOn(transport, 'productionOpenCodeFetch').mockImplementation(async (input, _init, value) => {
    received.push(value)
    return String(input).endsWith('/event')
      ? new Response('data: {"type":"server.connected","properties":{}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
      : Response.json([])
  })
  try {
    await readOpenCodeSseEndpoint({ baseUrl: 'http://TEST-loopback', endpoint: '/event', requestOwner: owner, onEvent() {} })
    await new OpenCodePreviewObserver().observeSession({ baseUrl: 'http://TEST-loopback', sessionId: 'ses_TEST', requestOwner: owner })
    const evidence = await readOpenCodeV1TerminalTranscript({ baseUrl: 'http://TEST-loopback', sessionId: 'ses_TEST', requestOwner: owner,
      signal: AbortSignal.timeout(1000) })
    expect(evidence.complete).toBe(true)
    expect(received.length).toBeGreaterThan(5)
    expect(received.every(value => value === owner)).toBe(true)
  } finally { wire.mockRestore() }
})

test('stop and turn observers retain the request owner across stream startup and fallback', async () => {
  const owner = {}, received: Array<object | undefined> = []
  const wire = spyOn(transport, 'productionOpenCodeFetch').mockImplementation(async (_input, _init, value) => {
    received.push(value)
    return new Response('data: {"type":"server.connected","properties":{}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  try {
    const stop = await startOpenCodeStopObserver({ baseUrl: 'http://TEST-loopback', sessionId: 'ses_TEST', requestOwner: owner })
    await stop.dispose()
    const turn = new OpenCodeTurnSettledObserver().observe({ baseUrl: 'http://TEST-loopback', sessionId: 'ses_TEST', requestOwner: owner,
      runtimePromptMessageId: 'msg_TEST', timeoutMs: 50 })
    await turn.waitForSettled(); turn.dispose()
    expect(received.length).toBeGreaterThan(2)
    expect(received.every(value => value === owner)).toBe(true)
  } finally { wire.mockRestore() }
})
