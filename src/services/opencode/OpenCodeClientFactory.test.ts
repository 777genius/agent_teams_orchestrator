import { describe, expect, test } from 'bun:test'

import { canonicalHostedApprovalDigest, OpenCodeClientFactory } from './OpenCodeClientFactory.js'

const hostedAuth = { username: 'opencode', password: 'test-password', directory: '/tmp/project' }
const runtimeInstanceId = `runtime_instance_${'1'.repeat(32)}`
const configGeneration = `config_generation_${'2'.repeat(32)}`
const requestIncarnation = `request_incarnation_${'3'.repeat(32)}`
const permissionDigest = 'a'.repeat(64)
const rawPermission = () => ({
  id: 'perm_123',
  sessionID: 'ses_123',
  permission: 'bash',
  patterns: ['ls'],
  metadata: { cwd: '/tmp' },
  always: [],
})
const hostedClient = (factory: OpenCodeClientFactory) =>
  factory.create('http://127.0.0.1:4096', {}, hostedAuth)

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

  test('uses exact authenticated v2 capability and observation contracts', async () => {
    const requests: Array<{ url: string; authorization: string | null; directory: string | null }> = []
    const raw = rawPermission()
    const factory = new OpenCodeClientFactory({ fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        directory: new Headers(init?.headers).get('x-opencode-directory'),
      })
      return new Response(JSON.stringify(String(input).endsWith('/permissions') ? {
        schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2', runtimeInstanceId,
        configGeneration, sessionId: 'ses_123', permissions: [{
          requestId: 'perm_123', sessionId: 'ses_123', requestIncarnation,
          permissionDigest: canonicalHostedApprovalDigest(raw), rawPermission: raw,
        }],
      } : {
        schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2',
        authentication: 'opencode-basic', runtimeInstanceId, configGeneration,
      }))
    } })
    const client = hostedClient(factory)
    await expect(client.getHostedApprovalCapability()).resolves.toMatchObject({ runtimeInstanceId })
    await expect(client.observeHostedApprovalPermissions?.('ses_123')).resolves.toMatchObject({
      permissions: [{ requestIncarnation }],
    })
    expect(requests.map(item => item.authorization)).toEqual([
      `Basic ${Buffer.from('opencode:test-password').toString('base64')}`,
      `Basic ${Buffer.from('opencode:test-password').toString('base64')}`,
    ])
    expect(requests.map(item => item.directory)).toEqual(['/tmp/project', '/tmp/project'])
  })

  test('performs no hosted request without the existing server password', async () => {
    let calls = 0
    const factory = new OpenCodeClientFactory({
      fetchImpl: async () => { calls += 1; return new Response('{}') },
    })
    expect(() => factory.create('http://127.0.0.1:4096').getHostedApprovalCapability())
      .toThrow('Basic Auth unavailable')
    expect(calls).toBe(0)
  })

  test('preserves hosted Basic Auth credentials byte-for-byte', async () => {
    const authorizations: Array<string | null> = []
    const factory = new OpenCodeClientFactory({
      fetchImpl: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get('authorization'))
        return new Response(JSON.stringify({
          schemaVersion: 2,
          protocol: 'agent-teams-hosted-approval-v2',
          authentication: 'opencode-basic',
          runtimeInstanceId,
          configGeneration,
        }))
      },
    })
    await factory.create('http://127.0.0.1:4096', {}, {
      username: ' user ', password: ' pass ', directory: '/tmp/project',
    }).getHostedApprovalCapability?.()
    await factory.create('http://127.0.0.1:4096', {}, {
      username: '', password: 'pass', directory: '/tmp/project',
    }).getHostedApprovalCapability?.()
    expect(authorizations).toEqual([
      `Basic ${Buffer.from(' user : pass ').toString('base64')}`,
      `Basic ${Buffer.from(':pass').toString('base64')}`,
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

  test('sends one exact v2 conditional POST and validates exact success', async () => {
    const requests: Array<{ url: string; body: unknown; redirect: RequestRedirect | undefined }> = []
    const factory = new OpenCodeClientFactory({ fetchImpl: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)), redirect: init?.redirect })
      return new Response(JSON.stringify({
        schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2', status: 'applied',
        runtimeInstanceId, configGeneration, requestId: 'perm_123', sessionId: 'ses_123',
        requestIncarnation, permissionDigest, decision: 'allow_once',
      }))
    } })
    await hostedClient(factory).answerPermission({
      requestId: 'perm_123', sessionId: 'ses_123', decision: 'allow',
      condition: { runtimeInstanceId, configGeneration, requestIncarnation, permissionDigest },
    })
    expect(requests).toEqual([{
      url: 'http://127.0.0.1:4096/experimental/agent-teams/hosted-approval/session/ses_123/permission/perm_123/reply',
      redirect: 'manual',
      body: {
        schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2', runtimeInstanceId,
        expectedConfigGeneration: configGeneration, requestId: 'perm_123', sessionId: 'ses_123',
        requestIncarnation, expectedPermissionDigest: permissionDigest, decision: 'allow_once',
      },
    }])
  })

  test('treats numeric 409/412 as no-effect and redirect/server/malformed as ambiguous without retry', async () => {
    for (const status of [409, 412]) {
      const factory = new OpenCodeClientFactory({ fetchImpl: async () => new Response('', { status }) })
      await expect(hostedClient(factory).answerPermission({
        requestId: 'perm_123', sessionId: 'ses_123', decision: 'reject',
        condition: { runtimeInstanceId, configGeneration, requestIncarnation, permissionDigest },
      })).rejects.toBeInstanceOf(Error)
    }
    for (const response of [
      new Response('', { status: 307, headers: { location: 'http://127.0.0.1:9/reply' } }),
      new Response('mentions (409 conflict)', { status: 500 }),
      new Response('{}'),
    ]) {
      let calls = 0
      const factory = new OpenCodeClientFactory({ fetchImpl: async () => { calls += 1; return response } })
      await expect(hostedClient(factory).answerPermission({
        requestId: 'perm_123', sessionId: 'ses_123', decision: 'reject',
        condition: { runtimeInstanceId, configGeneration, requestIncarnation, permissionDigest },
      })).rejects.toThrow()
      expect(calls).toBe(1)
    }
  })

  test('rejects v1, duplicate keys, invalid UTF-8, oversized observation and wrong digest', async () => {
    const raw = rawPermission()
    const responses = [
      new Response(JSON.stringify({ schemaVersion: 1, protocol: 'agent-teams-hosted-approval-v1', configGeneration })),
      new Response('{"schemaVersion":2,"schemaVersion":2}'),
      new Response(new Uint8Array([0xc3, 0x28])),
    ]
    for (const response of responses) {
      const factory = new OpenCodeClientFactory({ fetchImpl: async () => response })
      await expect(hostedClient(factory).getHostedApprovalCapability()).rejects.toThrow()
    }
    for (const body of [
      ' '.repeat(1024 * 1024 + 1),
      JSON.stringify({ schemaVersion: 2, protocol: 'agent-teams-hosted-approval-v2', runtimeInstanceId,
        configGeneration, sessionId: 'ses_123', permissions: [{ requestId: 'perm_123', sessionId: 'ses_123',
          requestIncarnation, permissionDigest, rawPermission: raw }] }),
    ]) {
      const factory = new OpenCodeClientFactory({ fetchImpl: async () => new Response(body) })
      await expect(hostedClient(factory).observeHostedApprovalPermissions?.('ses_123')).rejects.toThrow()
    }
  })

  test('rejects malformed or cross-bound hosted raw permissions', async () => {
    const valid = rawPermission()
    const malformed = [
      { ...valid, id: 'different' },
      { ...valid, sessionID: 'ses_other' },
      { ...valid, extra: true },
      { ...valid, patterns: ['ls', 1] },
      { ...valid, metadata: [] },
      { ...valid, tool: { messageID: 'msg_1' } },
      { ...valid, tool: { messageID: 'msg_1', callID: 'call_1', extra: true } },
    ]
    for (const raw of malformed) {
      const body = {
        schemaVersion: 2,
        protocol: 'agent-teams-hosted-approval-v2',
        runtimeInstanceId,
        configGeneration,
        sessionId: 'ses_123',
        permissions: [{
          requestId: 'perm_123',
          sessionId: 'ses_123',
          requestIncarnation,
          permissionDigest: canonicalHostedApprovalDigest(raw),
          rawPermission: raw,
        }],
      }
      const factory = new OpenCodeClientFactory({
        fetchImpl: async () => new Response(JSON.stringify(body)),
      })
      await expect(hostedClient(factory).observeHostedApprovalPermissions?.('ses_123'))
        .rejects.toThrow('raw permission was malformed')
    }
  })

  test('preserves canonical raw-permission digest golden', () => {
    expect(canonicalHostedApprovalDigest({
      always: [], id: 'per_1', metadata: { cwd: '/tmp', risk: 1 }, patterns: ['ls', 'pwd'],
      permission: 'bash', sessionID: 'ses_1',
    })).toBe('04c8063915eb1c84563b998516a670e59885c0fc453318e7ca8545a94b8accca')
    expect(canonicalHostedApprovalDigest({ a: 1, omitted: undefined }))
      .toBe(canonicalHostedApprovalDigest({ a: 1 }))
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
