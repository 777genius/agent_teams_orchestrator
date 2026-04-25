import { describe, expect, test } from 'bun:test'

import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'

describe('OpenCodeClientFactory permissions API', () => {
  test('sets provider API auth through the OpenCode auth endpoint', async () => {
    const requests: Array<{ url: string; method: string | undefined; body: unknown }> = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          body: JSON.parse(String(init?.body ?? '{}')),
        })
        return new Response('true', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await expect(factory.create('http://127.0.0.1:4096').setProviderAuth(
      'openrouter',
      { type: 'api', key: 'sk-test' },
    )).resolves.toBe(true)

    expect(requests).toEqual([{
      url: 'http://127.0.0.1:4096/auth/openrouter',
      method: 'PUT',
      body: { type: 'api', key: 'sk-test' },
    }])
  })

  test('deletes provider auth through the OpenCode auth endpoint', async () => {
    const requests: Array<{ url: string; method: string | undefined }> = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
        })
        return new Response('true', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await expect(factory.create('http://127.0.0.1:4096').deleteProviderAuth(
      'openrouter',
    )).resolves.toBe(true)

    expect(requests).toEqual([{
      url: 'http://127.0.0.1:4096/auth/openrouter',
      method: 'DELETE',
    }])
  })

  test('lists pending permissions from the SDK v2 endpoint without trailing slash', async () => {
    const paths: string[] = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async input => {
        paths.push(String(input))
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await factory.create('http://127.0.0.1:4096').getPermissions()

    expect(paths).toEqual(['http://127.0.0.1:4096/permission'])
  })

  test('maps allow permission decisions to OpenCode once replies', async () => {
    let body: Record<string, unknown> | null = null
    const factory = new OpenCodeClientFactory({
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await factory.create('http://127.0.0.1:4096').answerPermission({
      requestId: 'perm_123',
      sessionId: 'ses_123',
      decision: 'allow',
    })

    expect(body).toMatchObject({
      requestID: 'perm_123',
      sessionID: 'ses_123',
      reply: 'once',
      allow: true,
      always: false,
    })
  })

  test('lists experimental tool ids from the OpenCode endpoint used by readiness', async () => {
    const paths: string[] = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async input => {
        paths.push(String(input))
        return new Response(JSON.stringify(['agent-teams_runtime_deliver_message']), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await expect(factory.create('http://127.0.0.1:4096').listExperimentalToolIds())
      .resolves.toEqual(['agent-teams_runtime_deliver_message'])
    expect(paths).toEqual(['http://127.0.0.1:4096/experimental/tool/ids'])
  })

  test('passes directory when listing experimental tool ids for project-scoped MCP tools', async () => {
    const paths: string[] = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async input => {
        paths.push(String(input))
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await factory.create('http://127.0.0.1:4096').listExperimentalToolIds({
      directory: '/repo with spaces',
    })

    expect(paths).toEqual([
      'http://127.0.0.1:4096/experimental/tool/ids?directory=%2Frepo+with+spaces',
    ])
  })

  test('lists experimental tools with provider, model and directory query params', async () => {
    const paths: string[] = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async input => {
        paths.push(String(input))
        return new Response(JSON.stringify([{ id: 'agent-teams_runtime_deliver_message' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await expect(factory.create('http://127.0.0.1:4096').listExperimentalTools({
      directory: '/repo',
      provider: 'opencode',
      model: 'big-pickle',
    })).resolves.toEqual([{ id: 'agent-teams_runtime_deliver_message' }])
    expect(paths).toEqual([
      'http://127.0.0.1:4096/experimental/tool?directory=%2Frepo&provider=opencode&model=big-pickle',
    ])
  })
})
