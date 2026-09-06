import { describe, expect, test } from 'bun:test'
import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { assertTrustedOpenCodeCustody, createOpenCodeSupervisedCustodyAcquirer,
  type TrustedOpenCodeCustody } from './OpenCodeSupervisedHostCustody.js'
import { supervisedFixture, supervisedLease } from './OpenCodeSupervisedCustody.test-fixture.js'

describe('OpenCode supervised admission', () => {
  test('structural custody and missing bundles cannot authorize any consumer', () => {
    for (const custody of [undefined, {}, { alreadyAuthenticated: true }]) {
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const,
        custody: custody as TrustedOpenCodeCustody }
      expect(() => new OpenCodeHostManager({ acquisitionPolicy })).toThrow('custody unavailable')
      expect(() => new OpenCodeClientFactory({ acquisitionPolicy })).toThrow('custody unavailable')
      expect(() => new OpenCodeSessionBridge({ acquisitionPolicy })).toThrow('custody unavailable')
    }
  })

  test.skipIf(process.platform !== 'linux')('admission pins independent expectation and rejects bundle substitution', async () => {
    const fixture = await supervisedFixture({ mutateBundle(bundle) { bundle.expected.process.pid += 1 } })
    try {
      await expect(fixture.acquire()).rejects.toThrow('admission failed')
      expect(fixture.requests).toHaveLength(0)
    } finally { await fixture.close() }
  })

  test.skipIf(process.platform !== 'linux')('wrong namespace, executable, start, auth and profile cannot admit', async () => {
    for (const change of ['namespace', 'inode', 'digest', 'start', 'auth', 'profile']) {
      const fixture = await supervisedFixture({ mutateBundle(bundle) {
        if (change === 'auth') bundle.serverAuth.password = ''
      } })
      try {
        if (change === 'namespace') fixture.expected.process.networkNamespaceInode = '0'
        if (change === 'inode') fixture.expected.executable.inode = '0'
        if (change === 'digest') fixture.expected.executable.sha256 = '0'.repeat(64)
        if (change === 'start') fixture.expected.process.startTicks = '0'
        if (change === 'profile') fixture.expected.profile.managedAuthFingerprint = '0'.repeat(64)
        await expect((async () => createOpenCodeSupervisedCustodyAcquirer(fixture.source)())())
          .rejects.toThrow()
        expect(fixture.requests).toHaveLength(0)
      } finally { await fixture.close() }
    }
  }, 120_000)

  test.skipIf(process.platform !== 'linux')('adopts before desktop work and preserves exact concurrent leases', async () => {
    const fixture = await supervisedFixture()
    const forbidden: string[] = []
    const fail = (name: string): never => { forbidden.push(name); throw new Error(name) }
    try {
      const custody = await fixture.acquire()
      assertTrustedOpenCodeCustody(custody)
      expect(() => assertTrustedOpenCodeCustody({ ...custody })).toThrow()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      const manager = new OpenCodeHostManager({ acquisitionPolicy,
        prepareProfile: async () => fail('prepare'), allocateLoopbackPort: async () => fail('allocate'),
        spawnHostProcess: () => fail('spawn'), killProcess: () => fail('kill'),
        fetchJson: async () => fail('unauthenticated-fetch'), persistentRegistryPath: '/never-open-this-registry',
      })
      const provisional = { ...supervisedLease, sessionId: undefined }
      const [a, b] = await Promise.all([
        manager.ensureHost({ lease: provisional }), manager.ensureHost({ lease: supervisedLease }),
      ])
      expect(a).toBe(b)
      expect(a.custody).toBe('supervisor')
      await manager.releaseHostLease(a.hostKey, provisional)
      await manager.releaseHost(a.hostKey)
      await manager.releaseHost(a.hostKey)
      expect(manager.getHost(a.hostKey)).toBe(a)
      await manager.releaseHostLease(a.hostKey, { ...supervisedLease, sessionId: 'ses_wrong' })
      await manager.releaseHost(a.hostKey)
      expect(manager.getHost(a.hostKey)).toBe(a)
      await manager.releaseHostLease(a.hostKey, supervisedLease)
      await manager.releaseHost(a.hostKey)
      expect(manager.getHost(a.hostKey)).toBeNull()
      await manager.reconcilePersistentHosts({ mode: 'force', reason: 'shutdown' })
      expect(forbidden).toEqual([])
      const auth = `Basic ${Buffer.from('opencode:fixture-secret').toString('base64')}`
      expect(fixture.requests.map(value => value.url)).toEqual(expect.arrayContaining([
        '/global/health', '/config', '/config/providers', '/agent', '/mcp',
      ]))
      for (const request of fixture.requests) {
        expect(request.headers.authorization).toBe(auth)
        expect(request.headers['accept-encoding']).toBe('identity')
        expect(request.headers['x-opencode-directory']).toBe(fixture.expected.profile.projectPath)
      }
    } finally { await fixture.close() }
  }, 120_000)

  test.skipIf(process.platform !== 'linux')('unhealthy and auth failure never remediate or publish a host', async () => {
    for (const status of [200, 401, 503]) {
      const fixture = await supervisedFixture({ handle(_request, response) {
        response.statusCode = status; response.end('{"healthy":false}')
      } })
      try {
        const custody = await fixture.acquire()
        const manager = new OpenCodeHostManager({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody },
          spawnHostProcess() { throw new Error('must never spawn') }, killProcess() { throw new Error('must never kill') } })
        await expect(manager.ensureHost({ lease: supervisedLease })).rejects.toThrow()
        expect(manager.getHost(custody.hostKey)).toBeNull()
        await manager.reconcilePersistentHosts({ mode: 'force' })
      } finally { await fixture.close() }
    }
  }, 120_000)

  test.skipIf(process.platform !== 'linux')('bridge rejects global/default dependencies for an admitted custody', async () => {
    const fixture = await supervisedFixture()
    try {
      const custody = await fixture.acquire()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      expect(() => new OpenCodeSessionBridge({ acquisitionPolicy,
        hostManager: new OpenCodeHostManager(), clientFactory: new OpenCodeClientFactory() })).toThrow()
      expect(() => new OpenCodeClientFactory({ acquisitionPolicy, fetchImpl: fetch })).toThrow()
      const factory = new OpenCodeClientFactory({ acquisitionPolicy })
      expect(() => factory.create('http://127.0.0.1:1')).toThrow('origin mismatch')
      const profile = await custody.readPreparedProfile()
      expect(profile.env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
      fixture.revoke()
      expect(await custody.assertCurrent()).toBe(false)
    } finally { await fixture.close() }
  })
})
