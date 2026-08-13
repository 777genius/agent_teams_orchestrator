import { describe, expect, test } from 'bun:test'

import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'

describe('OpenCodeClientFactory permissions API', () => {
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

  test('probes the explicit atomic hosted-approval capability endpoint', async () => {
    const paths: string[] = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async input => {
        paths.push(String(input))
        return new Response(JSON.stringify({
          schemaVersion: 1,
          protocol: 'agent-teams-hosted-approval-v1',
          configGeneration: 'config_generation_1',
        }))
      },
    })

    await expect(factory.create('http://127.0.0.1:4096').getHostedApprovalCapability())
      .resolves.toMatchObject({ configGeneration: 'config_generation_1' })
    expect(paths).toEqual([
      'http://127.0.0.1:4096/experimental/agent-teams/hosted-approval-capability',
    ])
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

  test('preserves ordinary permission endpoint fallback compatibility', async () => {
    const paths: string[] = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async input => {
        paths.push(String(input))
        if (paths.length === 1) return new Response('missing', { status: 404 })
        return new Response('{}')
      },
    })

    await factory.create('http://127.0.0.1:4096').answerPermission({
      requestId: 'perm_legacy', sessionId: 'ses_legacy', decision: 'allow',
    })

    expect(paths).toEqual([
      'http://127.0.0.1:4096/permission/perm_legacy',
      'http://127.0.0.1:4096/permission/perm_legacy/reply',
    ])
  })

  test('sends the atomic config and permission conditions on the single reply POST', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        })
        return new Response(JSON.stringify({
          schemaVersion: 1,
          protocol: 'agent-teams-hosted-approval-v1',
          status: 'applied',
          configGeneration: 'config_generation_1',
          permissionDigest: 'a'.repeat(64),
        }))
      },
    })
    await factory.create('http://127.0.0.1:4096').answerPermission({
      requestId: 'perm_123',
      decision: 'allow',
      condition: {
        configGeneration: 'config_generation_1',
        permissionDigest: 'a'.repeat(64),
      },
    })

    expect(requests).toEqual([{
      url: 'http://127.0.0.1:4096/experimental/agent-teams/permission/perm_123/reply',
      body: expect.objectContaining({
        conditionalReplyVersion: 1,
        expectedConfigGeneration: 'config_generation_1',
        expectedPermissionDigest: 'a'.repeat(64),
      }),
    }])
  })

  test('classifies a conditional 412 as proven not applied', async () => {
    const factory = new OpenCodeClientFactory({
      fetchImpl: async () => new Response('config generation changed', {
        status: 412,
        statusText: 'Precondition Failed',
      }),
    })
    await expect(factory.create('http://127.0.0.1:4096').answerPermission({
      requestId: 'perm_412',
      decision: 'allow',
      condition: {
        configGeneration: 'config_generation_1',
        permissionDigest: 'a'.repeat(64),
      },
    })).rejects.toThrow('conditional permission reply was rejected without effect')
  })

  test('uses numeric status only when proving conditional no-effect', async () => {
    const factory = new OpenCodeClientFactory({
      fetchImpl: async () => new Response('the body mentions (412 Precondition Failed)', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    })
    await expect(factory.create('http://127.0.0.1:4096').answerPermission({
      requestId: 'perm_500_body_412',
      decision: 'allow',
      condition: {
        configGeneration: 'config_generation_1',
        permissionDigest: 'a'.repeat(64),
      },
    })).rejects.toThrow('OpenCode request failed (500 Internal Server Error)')
  })

  test('does not follow conditional mutation redirects and invokes transport once', async () => {
    const requests: RequestInit[] = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async (_input, init) => {
        requests.push(init ?? {})
        return new Response('', {
          status: 307,
          headers: { location: 'http://127.0.0.1:4097/reply' },
        })
      },
    })
    await expect(factory.create('http://127.0.0.1:4096').answerPermission({
      requestId: 'perm_redirect',
      decision: 'allow',
      condition: {
        configGeneration: 'config_generation_1',
        permissionDigest: 'a'.repeat(64),
      },
    })).rejects.toThrow('OpenCode request failed (307')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.redirect).toBe('manual')
  })

  test('performs no redirected POST against a real 307 target', async () => {
    let sourcePosts = 0
    let targetPosts = 0
    const target = Bun.serve({
      port: 0,
      fetch: request => {
        if (request.method === 'POST') targetPosts += 1
        return new Response('{}')
      },
    })
    const source = Bun.serve({
      port: 0,
      fetch: request => {
        if (request.method === 'POST') sourcePosts += 1
        return new Response('', {
          status: 307,
          headers: { location: `http://127.0.0.1:${target.port}/redirected-reply` },
        })
      },
    })
    try {
      const factory = new OpenCodeClientFactory()
      await expect(factory.create(`http://127.0.0.1:${source.port}`).answerPermission({
        requestId: 'perm_real_redirect', decision: 'allow',
        condition: {
          configGeneration: 'config_generation_1',
          permissionDigest: 'a'.repeat(64),
        },
      })).rejects.toThrow('OpenCode request failed (307')
      expect({ sourcePosts, targetPosts }).toEqual({ sourcePosts: 1, targetPosts: 0 })
    } finally {
      source.stop(true)
      target.stop(true)
    }
  })

  test('rejects duplicate keys, invalid UTF-8, and oversized hosted responses', async () => {
    const responses = [
      new Response('{"schemaVersion":1,"schemaVersion":1,"protocol":"agent-teams-hosted-approval-v1","configGeneration":"config_generation_1"}'),
      new Response(new Uint8Array([0xc3, 0x28])),
      new Response(' '.repeat(16 * 1024 + 1)),
    ]
    for (const response of responses) {
      const factory = new OpenCodeClientFactory({ fetchImpl: async () => response })
      await expect(factory.create('http://127.0.0.1:4096').getHostedApprovalCapability())
        .rejects.toThrow()
    }
  })

  test('requires the exact capability schema and config-generation grammar', async () => {
    for (const body of [
      { schemaVersion: 1, protocol: 'agent-teams-hosted-approval-v1', configGeneration: 'bad' },
      { schemaVersion: 1, protocol: 'agent-teams-hosted-approval-v1', configGeneration: 'config_generation_1', extra: true },
    ]) {
      const factory = new OpenCodeClientFactory({
        fetchImpl: async () => new Response(JSON.stringify(body)),
      })
      await expect(factory.create('http://127.0.0.1:4096').getHostedApprovalCapability())
        .rejects.toThrow('capability response was malformed')
    }
  })

  test('treats a malformed conditional success as ambiguous without a retry', async () => {
    let calls = 0
    const factory = new OpenCodeClientFactory({
      fetchImpl: async () => {
        calls += 1
        return new Response('{}')
      },
    })
    await expect(factory.create('http://127.0.0.1:4096').answerPermission({
      requestId: 'perm_malformed',
      decision: 'allow',
      condition: {
        configGeneration: 'config_generation_1',
        permissionDigest: 'a'.repeat(64),
      },
    })).rejects.toThrow('conditional permission reply was malformed')
    expect(calls).toBe(1)
  })

  test('does not retry a hosted conditional permission answer after an ambiguous transport failure', async () => {
    const requests: Array<{ url: string; method: string | undefined }> = []
    const transportError = new Error('socket closed after request write')
    const factory = new OpenCodeClientFactory({
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), method: init?.method })
        throw transportError
      },
    })

    await expect(
      factory.create('http://127.0.0.1:4096').answerPermission({
        requestId: 'perm/ambiguous',
        decision: 'allow',
        condition: {
          configGeneration: 'config_generation_1',
          permissionDigest: 'a'.repeat(64),
        },
      }),
    ).rejects.toBe(transportError)

    expect(requests).toEqual([
      {
        url: 'http://127.0.0.1:4096/experimental/agent-teams/permission/perm%2Fambiguous/reply',
        method: 'POST',
      },
    ])
  })

  test('does not retry a hosted conditional permission answer after a server error', async () => {
    const paths: string[] = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async input => {
        paths.push(String(input))
        return new Response('provider may already have applied the answer', {
          status: 500,
          statusText: 'Internal Server Error',
        })
      },
    })

    await expect(
      factory.create('http://127.0.0.1:4096').answerPermission({
        requestId: 'perm_500',
        decision: 'reject',
        condition: {
          configGeneration: 'config_generation_1',
          permissionDigest: 'a'.repeat(64),
        },
      }),
    ).rejects.toThrow('OpenCode request failed (500 Internal Server Error)')

    expect(paths).toEqual([
      'http://127.0.0.1:4096/experimental/agent-teams/permission/perm_500/reply',
    ])
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
