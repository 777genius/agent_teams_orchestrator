import { createServer } from 'node:http'
import { describe, expect, spyOn, test } from 'bun:test'

import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'

describe('OpenCodeClientFactory permissions API', () => {
  for (const cancellation of ['request', 'caller']) {
  test(`keeps ${cancellation} cancellation active while reading a stalled HTTP response body`, async () => {
    const sockets = new Set<import('node:net').Socket>()
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{')
    })
    server.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server port')
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const caller = new AbortController()
    const callerTimer = cancellation === 'caller'
      ? setTimeout(() => caller.abort(new Error('settings deadline expired')), 30)
      : undefined
    try {
      const result = await Promise.race([
        new OpenCodeClientFactory({ fetchImpl: globalThis.fetch }).create(`http://127.0.0.1:${address.port}`, {
          remainingMs: () => cancellation === 'request' ? 30 : 5_000,
          signal: caller.signal,
        }).getProviders().then(() => 'unexpected success', error => String(error)),
        new Promise<string>(resolve => { watchdog = setTimeout(() => resolve('watchdog expired'), 300) }),
      ])
      expect(result).toContain(cancellation === 'request'
        ? 'OpenCode request timed out after 30ms for /provider'
        : 'settings deadline expired')
    } finally {
      if (watchdog) clearTimeout(watchdog)
      if (callerTimer) clearTimeout(callerTimer)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  }

  test('only explicit instance initialization receives the startup transport budget', async () => {
    const requests: string[] = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async input => {
        requests.push(String(input))
        return new Response('{}')
      },
    })
    const timers = spyOn(globalThis, 'setTimeout')
    try {
      const client = factory.create('http://127.0.0.1:4096')
      await client.getConfigProviders({ initializeInstance: true })
      await client.getProviders()
      await client.getConfigProviders()
      await factory.create('http://127.0.0.1:4096', { remainingMs: () => 5_000 })
        .getConfigProviders({ initializeInstance: true })
      expect(timers.mock.calls.map(call => call[1])).toEqual([180_000, 15_000, 15_000, 5_000])
      expect(requests).toEqual([
        'http://127.0.0.1:4096/config/providers',
        'http://127.0.0.1:4096/provider',
        'http://127.0.0.1:4096/config/providers',
        'http://127.0.0.1:4096/config/providers',
      ])
    } finally { timers.mockRestore() }
  })
  test('delegates generic provider OAuth authorization and callback to OpenCode', async () => {
    const requests: Array<{
      url: string
      method: string | undefined
      body: unknown
    }> = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          body: JSON.parse(String(init?.body ?? '{}')),
        })
        const authorization = String(input).endsWith('/authorize')
        return new Response(
          JSON.stringify(
            authorization
              ? {
                  url: 'https://accounts.x.ai/oauth2/authorize?state=test',
                  method: 'auto',
                  instructions: 'Complete authorization in the browser.',
                }
              : true,
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      },
    })
    const client = factory.create('http://127.0.0.1:4096')

    await expect(client.authorizeProviderOAuth('xai', { method: 0 })).resolves.toMatchObject({
      method: 'auto',
    })
    await expect(client.completeProviderOAuth('xai', { method: 0 })).resolves.toBe(true)

    expect(requests).toEqual([
      {
        url: 'http://127.0.0.1:4096/provider/xai/oauth/authorize',
        method: 'POST',
        body: { method: 0 },
      },
      {
        url: 'http://127.0.0.1:4096/provider/xai/oauth/callback',
        method: 'POST',
        body: { method: 0 },
      },
    ])
  })

  test('sets provider API auth through the OpenCode auth endpoint', async () => {
    const requests: Array<{
      url: string
      method: string | undefined
      body: unknown
    }> = []
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

    await expect(
      factory
        .create('http://127.0.0.1:4096')
        .setProviderAuth('openrouter', { type: 'api', key: 'sk-test' }),
    ).resolves.toBe(true)

    expect(requests).toEqual([
      {
        url: 'http://127.0.0.1:4096/auth/openrouter',
        method: 'PUT',
        body: { type: 'api', key: 'sk-test' },
      },
    ])
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

    await expect(
      factory.create('http://127.0.0.1:4096').deleteProviderAuth('openrouter'),
    ).resolves.toBe(true)

    expect(requests).toEqual([
      {
        url: 'http://127.0.0.1:4096/auth/openrouter',
        method: 'DELETE',
      },
    ])
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

    await expect(
      factory.create('http://127.0.0.1:4096').listExperimentalToolIds(),
    ).resolves.toEqual(['agent-teams_runtime_deliver_message'])
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

    await expect(
      factory.create('http://127.0.0.1:4096').listExperimentalTools({
        directory: '/repo',
        provider: 'opencode',
        model: 'big-pickle',
      }),
    ).resolves.toEqual([{ id: 'agent-teams_runtime_deliver_message' }])
    expect(paths).toEqual([
      'http://127.0.0.1:4096/experimental/tool?directory=%2Frepo&provider=opencode&model=big-pickle',
    ])
  })
})

describe('OpenCodeClientFactory request context', () => {
  for (const cancellation of ['request', 'caller']) {
    for (const body of ['', '{}']) {
      test(`rejects ${cancellation} cancellation when body consumption resolves ${JSON.stringify(body)} after abort`, async () => {
        const caller = new AbortController()
        const callerReason = new Error('settings deadline expired during body consumption')
        let bodyReadStarted = false
        const factory = new OpenCodeClientFactory({
          fetchImpl: async (_input, init) => {
            const signal = init?.signal as AbortSignal
            const response = new Response(body)
            response.text = async () => {
              bodyReadStarted = true
              return await new Promise<string>(resolve => {
                signal.addEventListener('abort', () => resolve(body), { once: true })
                if (cancellation === 'caller') caller.abort(callerReason)
              })
            }
            return response
          },
        })

        const request = factory.create('http://127.0.0.1:4096', {
          signal: caller.signal,
          remainingMs: () => cancellation === 'request' ? 10 : 5_000,
        }).getProviders()

        if (cancellation === 'caller') {
          await expect(request).rejects.toBe(callerReason)
        } else {
          await expect(request).rejects.toThrow('OpenCode request timed out after 10ms for /provider')
        }
        expect(bodyReadStarted).toBe(true)
      })
    }
  }

  test('limits an endpoint request to the remaining runtime budget', async () => {
    const requestSignals: AbortSignal[] = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async (_input, init) => {
        const requestSignal = init?.signal as AbortSignal
        requestSignals.push(requestSignal)
        return await new Promise<Response>((_resolve, reject) => {
          requestSignal.addEventListener('abort', () => reject(requestSignal.reason), {
            once: true,
          })
        })
      },
    })

    await expect(
      factory
        .create('http://127.0.0.1:4096', { remainingMs: () => 10 })
        .promptSessionAsync('ses_123', { parts: [] }),
    ).rejects.toThrow(
      'OpenCode request timed out after 10ms for /session/ses_123/prompt_async',
    )
    expect(requestSignals[0]?.aborted).toBe(true)
  })

  test('propagates the external abort reason to an in-flight request', async () => {
    const abortController = new AbortController()
    const abortReason = new Error('readiness deadline expired during execution_submit')
    const factory = new OpenCodeClientFactory({
      fetchImpl: async (_input, init) => {
        const signal = init?.signal as AbortSignal
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })
    const request = factory
      .create('http://127.0.0.1:4096', {
        signal: abortController.signal,
        remainingMs: () => 30_000,
      })
      .getConfig()

    abortController.abort(abortReason)

    await expect(request).rejects.toBe(abortReason)
  })

  test('does not start fetch when the request context is already aborted', async () => {
    const abortController = new AbortController()
    const abortReason = new Error('readiness deadline already expired')
    abortController.abort(abortReason)
    let fetchCalls = 0
    const factory = new OpenCodeClientFactory({
      fetchImpl: async () => {
        fetchCalls += 1
        return new Response('{}')
      },
    })

    await expect(
      factory
        .create('http://127.0.0.1:4096', { signal: abortController.signal })
        .getConfig(),
    ).rejects.toBe(abortReason)
    expect(fetchCalls).toBe(0)
  })

  test('removes the external abort listener after a completed request', async () => {
    const abortController = new AbortController()
    const requestSignals: AbortSignal[] = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async (_input, init) => {
        requestSignals.push(init?.signal as AbortSignal)
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await factory
      .create('http://127.0.0.1:4096', { signal: abortController.signal })
      .getConfig()
    abortController.abort(new Error('late abort'))

    expect(requestSignals[0]?.aborted).toBe(false)
  })
})
