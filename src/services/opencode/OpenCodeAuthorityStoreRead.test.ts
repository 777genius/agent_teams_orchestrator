import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { readOpenCodeAuthority, isKnownHostRegistry, isKnownSessionStore } from './OpenCodeAuthorityStoreRead.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'

// Previously only parse errors survived session reads; typed missing/unknown
// classification and host read failures did not distinguish absence from veto.
const nonrootAvailable = process.platform !== 'win32' && typeof process.getuid === 'function' && (process.getuid() !== 0 || (process.platform === 'linux'
  && readFileSync('/proc/self/uid_map', 'utf8').trim().split('\n').some(line => {
    const [start, , count] = line.trim().split(/\s+/).map(Number)
    return start <= 65534 && start + count > 65534
  })))

describe('O1a typed authority read', () => {
  test('missing alone initializes; invalid stores remain typed unknown with safe diagnostics', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-O1a-read-'))
    try {
      const file = path.join(root, 'TEST-store.json')
      await writeFile(path.join(root, 'TEST-marker.json'), '{"test":true,"task":"O1a"}')
      expect(await readOpenCodeAuthority(file, isKnownSessionStore)).toEqual({ kind: 'missing' })
      const bytes = '{"schemaVersion":1,"records":{},"opaque":{"operations":["peer"]}}\n'
      await writeFile(file, bytes)
      expect(await readOpenCodeAuthority(file, isKnownSessionStore)).toMatchObject({ kind: 'known', bytes })
      const invalid = '{"schemaVersion":42,"records":{},"credential":"never-print"}'
      await writeFile(file, invalid)
      expect(await readOpenCodeAuthority(file, isKnownSessionStore)).toEqual({ kind: 'preserved_unknown', reason: 'invalid' })
      expect(await readFile(file, 'utf8')).toBe(invalid)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('known host extension bytes survive no-op and lease edits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-O1a-host-extension-'))
    try {
      await writeFile(path.join(root, 'TEST-marker.json'), '{"test":true,"task":"O1a"}')
      const file = path.join(root, 'TEST-registry.json')
      const lease = { leaseKey: 'TEST-team::primary::TEST-member', teamId: 'TEST-team', laneId: 'primary', memberName: 'TEST-member',
        runId: 'TEST-run', sessionId: 'TEST-session', createdAt: '2026-10-01', updatedAt: '2026-10-01', opaque: { pin: 'peer' } }
      const host = { hostKey: 'TEST-host', profileRootKey: 'TEST-profile', projectPath: root, projectBehaviorFingerprint: 'TEST-behavior',
        baseUrl: 'http://127.0.0.1:9911', port: 9911, pid: 99001, processStartedAtMs: 123,
        version: null, resolvedConfigFingerprint: null, updatedAt: '2026-10-01', opaque: { operation: 'peer' },
        leases: { [lease.leaseKey]: lease } }
      const bytes = JSON.stringify({ schemaVersion: 1, processIdentityFormat: 'platform-native-v2', hosts: { 'TEST-host': host }, opaque: { pin: 'peer' } }, null, 3) + '\n'
      await writeFile(file, bytes)
      const manager = new OpenCodeHostManager({ persistentRegistryPath: file, processAttributionDirectory: null,
        fetchJson: async () => { throw new Error('forbidden fetch') }, killProcess: () => { throw new Error('forbidden kill') } })
      expect(await manager.releaseHostLeaseStrict('TEST-host', { teamId: 'other', memberName: 'other' })).toBe(false)
      expect(await readFile(file, 'utf8')).toBe(bytes)
      await manager.retainHostLease('TEST-host', lease)
      const value = JSON.parse(await readFile(file, 'utf8'))
      expect(value.opaque).toEqual({ pin: 'peer' })
      expect(value.hosts['TEST-host'].opaque).toEqual(host.opaque)
      expect(value.hosts['TEST-host'].leases[lease.leaseKey].opaque).toEqual(lease.opaque)
      expect(await readOpenCodeAuthority(file, isKnownHostRegistry)).toMatchObject({ kind: 'known' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test.skipIf(!nonrootAvailable)('actual nonroot EACCES vetoes public stores before probes or writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-O1a-EACCES-'))
    try {
      await writeFile(path.join(root, 'TEST-marker.json'), '{"test":true,"task":"O1a"}')
      await chmod(root, 0o777)
      const file = path.join(root, 'TEST-denied.json')
      const sentinel = path.join(root, 'TEST-peer.json')
      const bytes = '{"schemaVersion":42,"opaque":{"operations":["peer"]}}'
      await writeFile(file, bytes, { mode: 0o000 })
      await writeFile(sentinel, 'shared-peer-authority')
      const sessionModule = new URL('./OpenCodeSessionStore.ts', import.meta.url).pathname
      const hostModule = new URL('./OpenCodeHostManager.ts', import.meta.url).pathname
      const code = `
        import { readFile } from 'node:fs/promises';
        import { OpenCodeSessionStore } from ${JSON.stringify(sessionModule)};
        import { OpenCodeHostManager } from ${JSON.stringify(hostModule)};
        let code; try { await readFile(process.argv[1]); } catch(e) { code = e.code; }
        const calls = []; const forbidden = () => { calls.push('forbidden'); throw Error('tripwire'); };
        const store = new OpenCodeSessionStore(process.argv[1], { isProcessAlive: forbidden, readProcessStartTimeMs: forbidden });
        const manager = new OpenCodeHostManager({ persistentRegistryPath: process.argv[1], prepareProfile: forbidden,
          spawnHostProcess: forbidden, fetchJson: forbidden, killProcess: forbidden, inspectProcessLiveness: forbidden });
        const results = [];
        for (const op of [() => store.list(), () => store.delete('TEST-team','TEST-member'),
          () => store.claimMaterialization({teamId:'TEST-team',memberName:'TEST-member'},'TEST-attempt'),
          () => manager.reconcilePersistentHosts({mode:'force'}),
          () => manager.releaseHostLeaseStrict('TEST-host',{teamId:'TEST-team',memberName:'TEST-member'}),
          () => manager.ensureHost({projectPath:process.argv[2]})]) {
          try { await op(); results.push('authorized'); } catch(e) { results.push(e.name); }
        }
        console.log(JSON.stringify({ uid:process.getuid(), code, results, calls }));
      `
      // Bun 1.3.11 ignores spawn uid. Node's libuv applies the real uid before exec.
      const wrapper = `const {spawnSync}=require('node:child_process');
        const child=spawnSync(process.argv[1],['--no-install','-e',process.argv[2],process.argv[3],process.argv[4]],
          {uid:process.getuid()===0?65534:process.getuid(),encoding:'utf8',env:process.env});
        if(child.error) throw child.error; process.stdout.write(child.stdout); process.stderr.write(child.stderr); process.exit(child.status ?? 1);`
      const child = spawnSync('node', ['-e', wrapper, process.execPath, code, file, root], {
        env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
          BUN_INSTALL_CACHE_DIR: root, TMPDIR: root, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 15000,
      })
      expect(child.error).toBeUndefined()
      expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' })
      const receipt = JSON.parse(child.stdout)
      expect(receipt.uid).not.toBe(0)
      expect(receipt.code).toBe('EACCES')
      expect(receipt.results).toEqual(Array(6).fill('OpenCodeAuthorityVetoError'))
      expect(receipt.calls).toEqual([])
      await chmod(file, 0o600)
      expect(await readFile(file, 'utf8')).toBe(bytes)
      expect(await readFile(sentinel, 'utf8')).toBe('shared-peer-authority')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
