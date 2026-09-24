import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import { hostedMemberAttempt, type HostedMemberDelivery } from '../hostedLaneSession/HostedMemberSessionBridge.js'
import { OpenCodeHostedMemberSessionTransport, type OpenCodeEndpointAuthority,
  type OpenCodeEndpointProof } from './OpenCodeHostedMemberSessionTransport.js'

const prompt = 'Inspect the test workspace.'
const proof: OpenCodeEndpointProof = {
  handle: `opencode_${'a'.repeat(32)}`, generation: 'b'.repeat(32),
  endpoint: 'http://127.0.0.1:49152', username: 'opencode', password: 'p'.repeat(48),
  expiresAt: Number.MAX_SAFE_INTEGER, signal: new AbortController().signal,
}
const attempt = hostedMemberAttempt({
  teamId: 'team_1', runId: 'run_1', laneId: 'lane_1', memberId: `member_${'c'.repeat(32)}`,
  memberName: 'tester', model: 'openai/gpt-test',
  promptSha256: createHash('sha256').update(prompt).digest('hex'),
  planFingerprint: 'd'.repeat(64), containerHandle: proof.handle,
  containerGeneration: proof.generation,
})
const sessionId = `ses_${'s'.repeat(32)}`
const delivery: HostedMemberDelivery = {
  attempt, deliveryId: 'delivery_1234', kind: 'message', text: 'Next test message.',
  taskId: null, taskRevision: null,
}

class FakeOpenCode {
  sessions: Array<{ id: string; title: string }> = []
  messages = new Map<string, { info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>()
  calls: Array<{ method: string; path: string; authorization: string | null }> = []
  promptPosts = 0
  acceptPrompt = true
  replyParent: string | null = null
  assistantTurns: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    this.calls.push({ method, path: `${url.pathname}${url.search}`, authorization: headers.get('authorization') })
    if (headers.get('authorization') !== `Basic ${Buffer.from(`opencode:${proof.password}`).toString('base64')}` ||
      url.origin !== proof.endpoint || init?.redirect !== 'error') return new Response('', { status: 401 })
    if (method === 'GET' && url.pathname === '/session') {
      const search = url.searchParams.get('search') ?? ''
      return Response.json(this.sessions.filter(s => s.title.includes(search)))
    }
    if (method === 'POST' && url.pathname === '/session') {
      const body = JSON.parse(String(init?.body)) as { title: string }
      const session = { id: sessionId, title: body.title }
      this.sessions.push(session)
      return Response.json(session)
    }
    const message = /^\/session\/(ses[^/]+)\/message\/(msg[^/]+)$/.exec(url.pathname)
    if (method === 'GET' && message) {
      const value = this.messages.get(message[2]!)
      return value ? Response.json(value) : new Response('', { status: 404 })
    }
    if (method === 'POST' && url.pathname === `/session/${sessionId}/prompt_async`) {
      this.promptPosts++
      if (this.acceptPrompt) {
        const body = JSON.parse(String(init?.body)) as { messageID: string; parts: Array<{ text: string }> }
        this.messages.set(body.messageID, { info: { id: body.messageID, role: 'user', sessionID: sessionId },
          parts: [{ type: 'text', text: body.parts[0]!.text }] })
      }
      return new Response(null, { status: 204 })
    }
    if (method === 'GET' && url.pathname === `/session/${sessionId}/message`) {
      const rows = [...this.messages.values(), ...this.assistantTurns]
      if (this.replyParent) rows.push({ info: { id: 'msg_assistant1234', role: 'assistant',
        sessionID: sessionId, parentID: this.replyParent, finish: 'stop', time: { completed: 42 } },
        parts: [{ type: 'text', text: 'Observed answer.' }] })
      return Response.json(rows)
    }
    return new Response('', { status: 404 })
  }
}

function transport(fake: FakeOpenCode, endpointProof = proof) {
  const authority: OpenCodeEndpointAuthority = {
    withAttestedEndpoint: async (_handle, _generation, operation) => operation(endpointProof),
  }
  return new OpenCodeHostedMemberSessionTransport(authority, fake.fetch as typeof fetch)
}

describe('official OpenCode hosted session transport', () => {
  test('observes the exact initial user prompt and later delivery before issuing receipts', async () => {
    const fake = new FakeOpenCode()
    const port = transport(fake)
    const started = await port.start(attempt, prompt)
    expect(started.state).toBe('ready')
    expect(started.sessionId).toBe(sessionId)
    expect(started.initialMessageId).toBe(started.observedInitialMessageId)
    expect(await port.observe(attempt)).toEqual(started)
    const posted = await port.post(delivery, sessionId)
    expect(posted.observedUserMessageId).toStartWith('msg_')
    expect(await port.observeDelivery(delivery, sessionId)).toEqual(posted)
    expect(fake.promptPosts).toBe(2)
    expect(fake.calls.every(call => call.authorization?.startsWith('Basic '))).toBe(true)
  })

  test('a 204 without an observed user message remains unresolved and is never retried', async () => {
    const fake = new FakeOpenCode()
    fake.acceptPrompt = false
    const port = transport(fake)
    await expect(port.start(attempt, prompt)).rejects.toThrow('unobserved')
    await expect(port.start(attempt, prompt)).rejects.toThrow('already-issued')
    expect(fake.promptPosts).toBe(1)
    expect((await port.observe(attempt)).state).toBe('failed')
  })

  test('reply must be a completed assistant message parented to the exact delivered user prompt', async () => {
    const fake = new FakeOpenCode()
    const port = transport(fake)
    await port.start(attempt, prompt)
    const posted = await port.post(delivery, sessionId)
    fake.replyParent = 'msg_unrelated1234'
    expect(await port.observeReply(delivery, sessionId, posted.observedUserMessageId)).toBeNull()
    fake.replyParent = posted.observedUserMessageId
    const reply = await port.observeReply(delivery, sessionId, posted.observedUserMessageId)
    expect(reply?.assistantMessageId).toBe('msg_assistant1234')
    expect(reply?.parentUserMessageId).toBe(posted.observedUserMessageId)
    expect(reply?.text).toBe('Observed answer.')
    expect(await port.observeReply(delivery, sessionId, 'msg_wrong1234')).toBeNull()
  })

  test('tool-call turns are not terminal replies, including provider stop with a pending tool', async () => {
    const fake = new FakeOpenCode()
    const port = transport(fake)
    await port.start(attempt, prompt)
    const posted = await port.post(delivery, sessionId)
    const parentID = posted.observedUserMessageId
    fake.assistantTurns.push({ info: { id: 'msg_toolcalls1234', role: 'assistant',
      sessionID: sessionId, parentID, finish: 'tool-calls' },
    parts: [{ type: 'text', text: 'I will inspect this.' }] })
    expect(await port.observeReply(delivery, sessionId, parentID)).toBeNull()
    fake.assistantTurns.push({ info: { id: 'msg_toolstop1234', role: 'assistant',
      sessionID: sessionId, parentID, finish: 'stop' },
    parts: [{ type: 'text', text: 'Still working.' },
      { type: 'tool', state: { status: 'running' } }] })
    expect(await port.observeReply(delivery, sessionId, parentID)).toBeNull()
    fake.assistantTurns.push({ info: { id: 'msg_final1234', role: 'assistant',
      sessionID: sessionId, parentID, finish: 'stop', time: { completed: 42 } },
    parts: [{ type: 'text', text: 'Final answer.' }] })
    const reply = await port.observeReply(delivery, sessionId, parentID)
    expect(reply?.assistantMessageId).toBe('msg_final1234')
    expect(reply?.text).toBe('Final answer.')
  })

  test('finish persisted before time.completed is not a reply receipt', async () => {
    const fake = new FakeOpenCode()
    const port = transport(fake)
    await port.start(attempt, prompt)
    const posted = await port.post(delivery, sessionId)
    const parentID = posted.observedUserMessageId
    const early = { info: { id: 'msg_early1234', role: 'assistant',
      sessionID: sessionId, parentID, finish: 'stop' } as Record<string, unknown>,
    parts: [{ type: 'text', text: 'Response before cleanup.' }] }
    fake.assistantTurns.push(early)
    expect(await port.observeReply(delivery, sessionId, parentID)).toBeNull()
    early.info.time = { completed: 43 }
    expect((await port.observeReply(delivery, sessionId, parentID))?.text).toBe('Response before cleanup.')
  })

  test('rejects endpoint substitution before any HTTP call', async () => {
    const fake = new FakeOpenCode()
    await expect(transport(fake, { ...proof, endpoint: 'http://example.com:49152' }).start(attempt, prompt))
      .rejects.toThrow('endpoint-proof-invalid')
    expect(fake.calls).toHaveLength(0)
  })

  test('lease revocation between official requests blocks the next write and receipt', async () => {
    const fake = new FakeOpenCode()
    const controller = new AbortController()
    const http = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fake.fetch(input, init)
      if (init?.method === 'POST' && new URL(String(input)).pathname === '/session') controller.abort()
      return response
    }
    const authority: OpenCodeEndpointAuthority = {
      withAttestedEndpoint: async (_handle, _generation, operation) => operation({ ...proof,
        expiresAt: Date.now() + 30_000, signal: controller.signal }),
    }
    const port = new OpenCodeHostedMemberSessionTransport(authority, http as typeof fetch)
    await expect(port.start(attempt, prompt)).rejects.toThrow('endpoint-lease-expired')
    expect(fake.sessions).toHaveLength(1)
    expect(fake.promptPosts).toBe(0)
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[0]?.path.startsWith('/session?search=')).toBe(true)
    expect(fake.calls[1]?.path).toBe('/session')
  })
})
