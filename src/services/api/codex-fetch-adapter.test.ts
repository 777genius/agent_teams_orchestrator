import { afterEach, describe, expect, test } from 'bun:test'

import { createCodexFetch } from './codex-fetch-adapter.js'

function createJwtWithAccount(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64',
  )
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
      },
    }),
  ).toString('base64')
  return `${header}.${payload}.signature`
}

describe('createCodexFetch', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('routes API-key traffic to the public OpenAI Responses API', async () => {
    let capturedRequest: RequestInit | undefined
    let capturedUrl = ''

    globalThis.fetch = (async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : String(input)
      capturedRequest = init
      return new Response('backend unavailable', { status: 500 })
    }) as typeof globalThis.fetch

    const codexFetch = createCodexFetch({
      type: 'api_key',
      apiKey: 'sk-test-openai',
    })

    const response = await codexFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(capturedUrl).toBe('https://api.openai.com/v1/responses')
    expect(capturedRequest?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: 'Bearer sk-test-openai',
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      type: 'error',
      error: {
        type: 'api_error',
      },
    })
  })

  test('routes OAuth traffic to the ChatGPT Codex adapter endpoint', async () => {
    let capturedRequest: RequestInit | undefined
    let capturedUrl = ''

    globalThis.fetch = (async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : String(input)
      capturedRequest = init
      return new Response('backend unavailable', { status: 500 })
    }) as typeof globalThis.fetch

    const codexFetch = createCodexFetch({
      type: 'oauth_token',
      accessToken: createJwtWithAccount('acct_123'),
    })

    const response = await codexFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(capturedUrl).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(capturedRequest?.headers).toMatchObject({
      'chatgpt-account-id': 'acct_123',
      originator: 'pi',
      'OpenAI-Beta': 'responses=experimental',
    })
    expect((capturedRequest?.headers as Record<string, string>).Authorization).toMatch(
      /^Bearer\s.+$/,
    )
    expect(response.status).toBe(500)
  })

  test('translates OpenAI stream error events into Anthropic SSE error events', async () => {
    globalThis.fetch = (async () => new Response(
      [
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_123","status":"in_progress"}}',
        '',
        'event: error',
        'data: {"type":"error","error":{"type":"insufficient_quota","code":"insufficient_quota","message":"Quota exceeded","param":null}}',
        '',
      ].join('\n'),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'x-request-id': 'req_codex_123',
        },
      },
    )) as typeof globalThis.fetch

    const codexFetch = createCodexFetch({
      type: 'api_key',
      apiKey: 'sk-test-openai',
    })

    const response = await codexFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('event: error')
    expect(body).toContain('"type":"billing_error"')
    expect(body).toContain('Codex API error (insufficient_quota): Quota exceeded')
    expect(body).toContain('"request_id":"req_codex_123"')
    expect(body).not.toContain('event: message_stop')
  })

  test('translates response.failed into an Anthropic SSE error when no explicit error event was emitted', async () => {
    globalThis.fetch = (async () => new Response(
      [
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_123","status":"in_progress"}}',
        '',
        'event: response.failed',
        'data: {"type":"response.failed","response":{"id":"resp_123","status":"failed","error":{"code":"rate_limit_exceeded","message":"Slow down"}}}',
        '',
      ].join('\n'),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
      },
    )) as typeof globalThis.fetch

    const codexFetch = createCodexFetch({
      type: 'api_key',
      apiKey: 'sk-test-openai',
    })

    const response = await codexFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('event: error')
    expect(body).toContain('"type":"rate_limit_error"')
    expect(body).toContain('Codex API error (rate_limit_exceeded): Slow down')
    expect(body).not.toContain('event: message_stop')
  })
})
