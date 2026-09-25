import { describe, expect, test } from 'bun:test'

import { HostedSupervisorEndpointAuthority } from './HostedSupervisorEndpointAuthority.js'

const handle = `opencode_${'a'.repeat(32)}`
const generation = 'b'.repeat(32)
const token = 'c'.repeat(32)
const password = 'd'.repeat(64)
const lease = () => ({ token, handle, generation, endpoint: 'http://127.0.0.1:49152',
  username: 'opencode' as const, password, expiresAt: Date.now() + 30_000 })
type Rpc = ConstructorParameters<typeof HostedSupervisorEndpointAuthority>[0]

function fakeRpc(overrides: Partial<Rpc> = {}) {
  const ends: Array<{ operationId: string; handle: string; generation: string; token: string }> = []
  const rpc: Rpc = {
    beginEndpointUse: async () => lease(),
    endEndpointUse: async request => { ends.push(request); return { released: true } },
    ...overrides,
  }
  return { rpc, ends }
}

describe('inactive hosted supervisor endpoint authority', () => {
  test('production adapter never asks root for a reusable HTTP password', async () => {
    let begins = 0
    const { rpc } = fakeRpc({ beginEndpointUse: async () => { begins++; return lease() } })
    const authority = new HostedSupervisorEndpointAuthority(rpc)
    let called = false
    await expect(authority.withAttestedEndpoint(handle, generation, async () => { called = true }))
      .rejects.toThrow('hosted-opencode-owner-http-credential-disabled')
    expect(begins).toBe(0)
    expect(called).toBe(false)
  })

  test('test credential override cannot reach root in a production process', async () => {
    let begins = 0
    const { rpc } = fakeRpc({ beginEndpointUse: async () => { begins++; return lease() } })
    const authority = new HostedSupervisorEndpointAuthority(rpc, undefined, true)
    const prior = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      await expect(authority.withAttestedEndpoint(handle, generation, async () => 'unexpected'))
        .rejects.toThrow('hosted-opencode-owner-http-credential-disabled')
      expect(begins).toBe(0)
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prior
    }
  })

  test('binds exact handle and generation, passes one finite proof, and releases after callback', async () => {
    const { rpc, ends } = fakeRpc()
    const authority = new HostedSupervisorEndpointAuthority(rpc, undefined, true)
    const value = await authority.withAttestedEndpoint(handle, generation, async proof => {
      expect(proof.handle).toBe(handle)
      expect(proof.generation).toBe(generation)
      expect(proof.endpoint).toBe('http://127.0.0.1:49152')
      expect(proof.password).toBe(password)
      expect(proof.signal.aborted).toBe(false)
      expect(proof.expiresAt).toBeLessThan(Date.now() + 30_000)
      expect(ends).toHaveLength(0)
      return 42
    })
    expect(value).toBe(42)
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ handle, generation, token })
  })

  test.each([
    ['handle', { handle: `opencode_${'e'.repeat(32)}` }],
    ['generation', { generation: 'e'.repeat(32) }],
    ['endpoint', { endpoint: 'http://evil.invalid:49152' }],
    ['username', { username: 'admin' }],
    ['password', { password: 'secret' }],
    ['expiry', { expiresAt: Date.now() + 120_000 }],
  ])('rejects forged %s and releases any valid token', async (_field, replacement) => {
    const { rpc, ends } = fakeRpc({ beginEndpointUse: async () => ({ ...lease(), ...replacement }) as ReturnType<
      Rpc['beginEndpointUse']> extends Promise<infer T> ? T : never })
    const authority = new HostedSupervisorEndpointAuthority(rpc, undefined, true)
    let called = false
    await expect(authority.withAttestedEndpoint(handle, generation, async () => { called = true }))
      .rejects.toThrow('hosted-opencode-endpoint-use-failed')
    expect(called).toBe(false)
    expect(ends).toHaveLength(1)
  })

  test('redacts callback failure and releases in finally', async () => {
    const { rpc, ends } = fakeRpc()
    const authority = new HostedSupervisorEndpointAuthority(rpc, undefined, true)
    await expect(authority.withAttestedEndpoint(handle, generation, async () => {
      throw new Error(`Authorization: Basic ${password}`)
    })).rejects.toThrow('hosted-opencode-endpoint-use-failed')
    expect(ends).toHaveLength(1)
  })

  test('fails closed when end reports revoked or throws', async () => {
    for (const endEndpointUse of [async () => ({ released: false }), async (): Promise<{ released: boolean }> => {
      throw new Error(password)
    }]) {
      const { rpc } = fakeRpc({ endEndpointUse })
      const authority = new HostedSupervisorEndpointAuthority(rpc, undefined, true)
      await expect(authority.withAttestedEndpoint(handle, generation, async () => 'receipt'))
        .rejects.toThrow('hosted-opencode-endpoint-release-unconfirmed')
    }
  })

  test('shutdown aborts active proof, rejects receipt and releases', async () => {
    const shutdown = new AbortController()
    const { rpc, ends } = fakeRpc()
    const authority = new HostedSupervisorEndpointAuthority(rpc, shutdown.signal, true)
    await expect(authority.withAttestedEndpoint(handle, generation, async proof => {
      shutdown.abort()
      expect(proof.signal.aborted).toBe(true)
      return 'receipt'
    })).rejects.toThrow('hosted-opencode-endpoint-use-failed')
    expect(ends).toHaveLength(1)
  })

  test('shutdown during release also suppresses a completed callback receipt', async () => {
    const shutdown = new AbortController()
    const { rpc } = fakeRpc({ endEndpointUse: async () => {
      shutdown.abort()
      return { released: true }
    } })
    const authority = new HostedSupervisorEndpointAuthority(rpc, shutdown.signal, true)
    await expect(authority.withAttestedEndpoint(handle, generation, async () => 'receipt'))
      .rejects.toThrow('hosted-opencode-endpoint-use-failed')
  })

  test('prevents overlapping uses of one handle and releases after the first finishes', async () => {
    const { rpc, ends } = fakeRpc()
    const authority = new HostedSupervisorEndpointAuthority(rpc, undefined, true)
    let finish!: () => void
    const hold = new Promise<void>(resolve => { finish = resolve })
    const first = authority.withAttestedEndpoint(handle, generation, async () => { await hold })
    await expect(authority.withAttestedEndpoint(handle, generation, async () => undefined))
      .rejects.toThrow('hosted-opencode-endpoint-overlapping')
    finish()
    await first
    expect(ends).toHaveLength(1)
  })

  test('a short forged deadline never invokes callback', async () => {
    const { rpc, ends } = fakeRpc({ beginEndpointUse: async () => ({ ...lease(), expiresAt: Date.now() + 100 }) })
    const authority = new HostedSupervisorEndpointAuthority(rpc, undefined, true)
    let called = false
    await expect(authority.withAttestedEndpoint(handle, generation, async () => { called = true }))
      .rejects.toThrow('hosted-opencode-endpoint-use-failed')
    expect(called).toBe(false)
    expect(ends).toHaveLength(1)
  })

  test('deadline aborts an unfinished callback before the supervisor lease expires', async () => {
    const { rpc, ends } = fakeRpc({ beginEndpointUse: async () => ({ ...lease(),
      expiresAt: Date.now() + 1_100 }) })
    const authority = new HostedSupervisorEndpointAuthority(rpc, undefined, true)
    let callbackSignal: AbortSignal | undefined
    await expect(authority.withAttestedEndpoint(handle, generation, async proof => {
      callbackSignal = proof.signal
      await new Promise<void>(resolve => proof.signal.addEventListener('abort', () => resolve(), { once: true }))
      return 'late receipt'
    })).rejects.toThrow('hosted-opencode-endpoint-use-failed')
    expect(callbackSignal?.aborted).toBe(true)
    expect(ends).toHaveLength(1)
  })

  test('supervisor loss during begin never exposes a proof', async () => {
    const { rpc, ends } = fakeRpc({ beginEndpointUse: async () => { throw new Error(password) } })
    const authority = new HostedSupervisorEndpointAuthority(rpc, undefined, true)
    let called = false
    await expect(authority.withAttestedEndpoint(handle, generation, async () => { called = true }))
      .rejects.toThrow('hosted-opencode-endpoint-use-failed')
    expect(called).toBe(false)
    expect(ends).toHaveLength(0)
  })
})
