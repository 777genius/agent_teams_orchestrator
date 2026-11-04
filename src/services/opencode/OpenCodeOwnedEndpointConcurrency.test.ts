import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as lockfile from '../../utils/lockfile.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

for (const change of ['peer-lease', 'lease-refresh', 'birth', 'endpoint', 'owner-lease'] as const) {
  test(`cleanup process inspection releases registry gate and rechecks ${change}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-owned-endpoint-'))
    const entered = deferred(), resume = deferred()
    let lookup: Promise<unknown> | undefined
    try {
      const registryPath = path.join(root, 'hosts.json')
      const now = new Date().toISOString()
      const lease = { teamId: 'TEST-team', laneId: 'primary', memberName: 'alice', runId: 'run', sessionId: 'session' }
      const leaseKey = 'TEST-team::primary::alice'
      const record = { hostKey: 'owned', profileRootKey: 'profile', projectPath: root,
        projectBehaviorFingerprint: 'config', managedConfigFingerprint: 'config',
        baseUrl: 'http://127.0.0.1:43210', port: 43210, pid: 12345, processStartedAtMs: 100,
        version: 'fixture', resolvedConfigFingerprint: 'config', updatedAt: now,
        leases: { [leaseKey]: { ...lease, leaseKey, createdAt: now, updatedAt: now } } }
      await writeFile(registryPath, JSON.stringify({ schemaVersion: 1,
        processIdentityFormat: 'platform-native-v2', hosts: { owned: record } }))
      const manager = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
        isProcessAlive: () => true,
        readProcessStartTimeMs: async () => { entered.resolve(); await resume.promise; return 100 },
        fetchJson: async () => { throw new Error('TEST must not contact provider') },
        spawnHostProcess: () => { throw new Error('TEST must not start host') },
      })
      lookup = manager.resolveOwnedSessionEndpoint('owned', { ...lease, projectPath: root })
      // Install a rejection observer before releasing the held identity probe.
      const outcome = lookup.then(value => ({ value, error: null }), error => ({ value: null, error }))
      await entered.promise
      // Another process can commit a registry update while OS inspection is slow.
      // A zero-retry acquisition is a rejecting regression for the old gate scope.
      const release = await lockfile.lock(`${registryPath}.lock`, { retries: 0 })
      try {
        const registry = JSON.parse(await readFile(registryPath, 'utf8'))
        const host = registry.hosts.owned
        if (change === 'peer-lease') host.leases['TEST-team::primary::bob'] = {
          ...host.leases[leaseKey], leaseKey: 'TEST-team::primary::bob', memberName: 'bob',
        }
        if (change === 'lease-refresh') host.leases[leaseKey].updatedAt = '2026-10-22T23:59:00.000Z'
        if (change === 'birth') host.processStartedAtMs = 101
        if (change === 'endpoint') { host.port = 43211; host.baseUrl = 'http://127.0.0.1:43211' }
        if (change === 'owner-lease') host.leases[leaseKey].createdAt = '2026-01-01T00:00:00.000Z'
        await writeFile(registryPath, JSON.stringify(registry))
      } finally { await release() }
      resume.resolve()
      const result = await outcome
      if (change === 'peer-lease' || change === 'lease-refresh') {
        expect(result.error).toBeNull()
        expect(result.value).toEqual({ baseUrl: record.baseUrl, pid: record.pid })
      } else {
        expect(result.error?.message).toContain('ownership changed')
        expect(result.value).toBeNull()
      }
    } finally {
      resume.resolve()
      await lookup?.catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })
}
