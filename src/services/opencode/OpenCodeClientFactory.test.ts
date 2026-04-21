import { describe, expect, test } from 'bun:test'

import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'

describe('OpenCodeClientFactory permissions API', () => {
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
})
