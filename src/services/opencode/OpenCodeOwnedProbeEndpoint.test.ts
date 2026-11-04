import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'

for (const change of ['same', 'peer-lease', 'birth', 'pid', 'endpoint', 'profile', 'fingerprint'] as const) {
  test(`cold probe endpoint re-admission rechecks exact saved identity: ${change}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-cold-probe-'))
    try {
      const registryPath = path.join(root, 'hosts.json')
      const record = { hostKey: 'TEST-owned', profileRootKey: 'TEST-profile', projectPath: root,
        projectBehaviorFingerprint: 'TEST-config', managedConfigFingerprint: 'TEST-config',
        baseUrl: 'http://127.0.0.1:43210', port: 43210, pid: 12345, processStartedAtMs: 100,
        version: 'TEST-fixture', resolvedConfigFingerprint: 'TEST-config', updatedAt: new Date().toISOString(), leases: {} }
      await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, processIdentityFormat: 'platform-native-v2', hosts: { 'TEST-owned': record } }))
      let observations = 0
      const manager = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
        isProcessAlive: () => true,
        readProcessStartTimeMs: async () => {
          observations++
          const registry = JSON.parse(await readFile(registryPath, 'utf8'))
          const current = registry.hosts['TEST-owned']
          if (change === 'birth') current.processStartedAtMs = 101
          if (change === 'pid') current.pid++
          if (change === 'endpoint') { current.port++; current.baseUrl = `http://127.0.0.1:${current.port}` }
          if (change === 'profile') current.profileRootKey += '-changed'
          if (change === 'fingerprint') current.managedConfigFingerprint += '-changed'
          if (change === 'peer-lease') current.leases['TEST-peer::primary::peer'] = {
            leaseKey: 'TEST-peer::primary::peer', teamId: 'TEST-peer', laneId: 'primary', memberName: 'peer',
            createdAt: record.updatedAt, updatedAt: record.updatedAt,
          }
          await writeFile(registryPath, JSON.stringify(registry))
          return 100
        },
        fetchJson: async () => { throw new Error('TEST must not contact any endpoint') },
        spawnHostProcess: () => { throw new Error('TEST must not start any host') },
      })
      const pending = manager.resolveOwnedProbeEndpoint({ ...record, scopeToken: 'TEST-scope' })
      if (change === 'same' || change === 'peer-lease') {
        expect(await pending).toEqual({ baseUrl: record.baseUrl, pid: record.pid })
      } else {
        await expect(pending).rejects.toThrow(/ownership changed|registry changed/)
      }
      expect(observations).toBe(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}
