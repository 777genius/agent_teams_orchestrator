import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'

const baseRecord = {
  teamId: 'team-a',
  laneId: 'primary',
  memberName: 'alice',
  providerId: 'opencode' as const,
  selectedModel: 'openai/gpt-5.4',
  projectPath: '/tmp/project',
  profileRootKey: 'profile-root',
  hostKey: 'host-key',
  resolvedBehaviorFingerprint: null,
  opencodeSessionId: 'session-1',
  lastCanonicalCursor: null,
  lastKnownRawStatus: null,
  lastKnownDurableState: null,
  sourceAuthFingerprint: null,
  managedAuthFingerprint: null,
  projectBehaviorFingerprint: 'behavior-v1',
  staleReason: null,
  createdAt: '2026-04-21T00:00:00.000Z',
  updatedAt: '2026-04-21T00:00:00.000Z',
}

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'TEST-O1a-session-'))
  baseRecord.projectPath = tempDir
  await writeFile(path.join(tempDir, 'TEST-marker.json'), JSON.stringify({ task: 'O1a', test: true }))
})
afterEach(async () => { await rm(tempDir, { recursive: true, force: true }) })

// Old readStore returned empty on future schemas and erased invalid owners.
// Every operation below must instead veto before interpreting authority.
describe('O1a session preserve-only public boundary', () => {
  const variants: [string, string][] = [
    ['future', JSON.stringify({ schemaVersion: 42, records: {}, opaque: { operations: [{ secret: 'never-print' }] } })],
    ['truncated', '{"schemaVersion":1,"records":'],
    ['partial record', JSON.stringify({ schemaVersion: 1, records: { broken: { teamId: 'team-a' } } })],
    ['invalid records', JSON.stringify({ schemaVersion: 1, records: [] })],
    ['partial owner', JSON.stringify({ schemaVersion: 1, records: {}, materializationOwners: { broken: { attemptId: 'other' } } })],
    ['invalid owner version', JSON.stringify({ schemaVersion: 1, records: {}, materializationOwners: { broken: { attemptId: 'other', sessionId: '', version: 0 } } })],
    ['partial process', JSON.stringify({ schemaVersion: 1, records: {}, materializationOwnerProcesses: { broken: { pid: 77 } } })],
    ['future envelope', JSON.stringify({ version: 42, schemaVersion: 1, records: {}, data: { opaque: 'authority' } })],
  ]
  for (const [variant, bytes] of variants) {
    test(`${variant}: public reads and mutations preserve bytes and peer`, async () => {
      const file = path.join(tempDir, 'TEST-preserved.json')
      const sentinel = path.join(tempDir, 'TEST-peer.json')
      await writeFile(file, bytes)
      await writeFile(sentinel, 'shared-peer-authority')
      const store = new OpenCodeSessionStore(file, {
        isProcessAlive: () => { throw new Error('forbidden process probe') },
        readProcessStartTimeMs: async () => { throw new Error('forbidden process identity') },
      })
      const owner = { attemptId: 'TEST-attempt', sessionId: 'session-1', version: 1 }
      const runtime = { providerId: 'opencode' as const, binaryPath: null, binaryFingerprint: null, version: null,
        capabilitySnapshotId: `opencode:${'a'.repeat(32)}` }
      const request = { contractVersion: 1 as const, originalRequestId: 'TEST-request', idempotencyKey: 'TEST-key',
        target: { teamId: 'team-a', laneId: 'primary', runId: 'TEST-run', projectPath: tempDir,
          capabilitySnapshotId: runtime.capabilitySnapshotId, expectedBehaviorFingerprint: 'b'.repeat(64),
          members: [{ memberName: 'alice', sessionId: 'session-1' }] } }
      const operations = [
        () => store.lookupStop(request), () => store.beginStop(request, runtime),
        () => store.reconcileStop(request, async () => { throw new Error('forbidden capability') }),
        () => store.releaseMaterializationOwner(baseRecord, owner),
        () => store.releaseInactiveMaterializationOwner(baseRecord, owner),
        () => store.releaseMaterializationClaim(baseRecord, owner),
        () => store.markStoppedIfSession(baseRecord), () => store.markStaleIfSession(baseRecord, 'TEST-stale'),
        () => store.deleteIfSession(baseRecord), () => store.isMaterializationOwnerActive(baseRecord, owner),
        () => store.list(), () => store.get('team-a', 'alice'),
        () => store.upsert(baseRecord), () => store.delete('team-a', 'alice'),
        () => store.claimMaterialization(baseRecord, 'attempt'),
        () => store.observeMaterialization(baseRecord),
        () => store.commitMaterialization(baseRecord, { attemptId: 'attempt', sessionId: '', version: 1 }),
        () => store.acquireMaterializationOwner(baseRecord, 'attempt', undefined, null),
        () => store.markStale('team-a', 'alice', 'stale'),
      ]
      const outcomes = []
      for (const [index, operation] of operations.entries()) {
        await writeFile(file, bytes)
        let veto = false
        try { await operation() } catch (error) {
          veto = error?.name === 'OpenCodeAuthorityVetoError' && error?.kind === 'preserved_unknown'
        }
        const after = await readFile(file, 'utf8')
        const peer = await readFile(sentinel, 'utf8')
        outcomes.push({ veto, preserved: after === bytes, peer: peer === 'shared-peer-authority' })
        console.info('TEST-O1a-receipt', JSON.stringify({ store: 'session', variant, index, veto,
          before: createHash('sha256').update(bytes).digest('hex'), after: createHash('sha256').update(after).digest('hex'),
          peer: createHash('sha256').update(peer).digest('hex') }))
      }
      expect(outcomes).toEqual(operations.map(() => ({ veto: true, preserved: true, peer: true })))
    })
  }
  test('symlink, dangling symlink and directory never initialize a store', async () => {
    const peer = path.join(tempDir, 'TEST-peer.json')
    await writeFile(peer, 'peer-owned-by-another-team')
    const link = path.join(tempDir, 'TEST-link.json')
    const dangling = path.join(tempDir, 'TEST-dangling.json')
    const directory = path.join(tempDir, 'TEST-directory.json')
    await symlink(peer, link)
    await symlink(path.join(tempDir, 'absent'), dangling)
    await mkdir(directory)
    for (const file of [link, dangling, directory]) {
      const store = new OpenCodeSessionStore(file)
      await expect(store.list()).rejects.toMatchObject({ name: 'OpenCodeAuthorityVetoError' })
      await expect(store.upsert(baseRecord)).rejects.toMatchObject({ name: 'OpenCodeAuthorityVetoError' })
    }
    expect(await readFile(peer, 'utf8')).toBe('peer-owned-by-another-team')
  })
  test('known V1 no-op bytes and record extensions survive actual writes', async () => {
    const file = path.join(tempDir, 'TEST-extensions.json')
    const record = { ...baseRecord, opaque: { operations: ['peer-pin'] } }
    const bytes = JSON.stringify({ schemaVersion: 1, records: { 'team-a::primary::alice': record }, outerOpaque: { pin: 'peer' } }, null, 3) + '\n'
    await writeFile(file, bytes)
    const store = new OpenCodeSessionStore(file)
    await store.list()
    expect(await store.upsert(record)).toBe('unchanged')
    expect(await readFile(file, 'utf8')).toBe(bytes)
    expect(await store.upsert(baseRecord)).toBe('unchanged')
    expect(await readFile(file, 'utf8')).toBe(bytes)
    await store.upsert({ ...baseRecord, updatedAt: '2026-04-22T00:00:00.000Z' })
    const updated = JSON.parse(await readFile(file, 'utf8'))
    expect(updated.outerOpaque).toEqual({ pin: 'peer' })
    expect(updated.records['team-a::primary::alice'].opaque).toEqual(record.opaque)
  })
})

// Old registry reads swallowed unknown/partial authority, enabling lease release
// and reconciliation (including pruning) to continue as if the store were empty.
describe('O1a host preserve-only public boundary', () => {
  const variants: [string, string][] = [
    ['future', JSON.stringify({ schemaVersion: 42, hosts: {}, opaque: { operations: ['peer'] } })],
    ['truncated', '{"schemaVersion":1,"hosts":'],
    ['partial host', JSON.stringify({ schemaVersion: 1, hosts: { broken: { pid: 99 } } })],
    ['invalid hosts', JSON.stringify({ schemaVersion: 1, hosts: [] })],
    ['future identity format', JSON.stringify({ schemaVersion: 1, processIdentityFormat: 'future-v42', hosts: {} })],
  ]
  for (const [variant, bytes] of variants) {
    test(`${variant}: public lease/recovery/reconcile/ensure preserve peers`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-O1a-host-'))
      try {
        await writeFile(path.join(root, 'TEST-marker.json'), '{"test":true,"task":"O1a"}')
        const file = path.join(root, 'registry.json')
        const peer = path.join(root, 'TEST-shared-peer.json')
        await writeFile(file, bytes)
        await writeFile(peer, 'shared-authority')
        const calls: string[] = []
        const forbidden = (name: string): never => { calls.push(name); throw new Error(`forbidden ${name}`) }
        const manager = new OpenCodeHostManager({ persistentRegistryPath: file, processAttributionDirectory: root,
          cursorAgentNativePorts: { birth: async () => forbidden('birth'), tree: async () => forbidden('tree'),
            signal: () => forbidden('signal'), alive: () => forbidden('alive'), taskkill: async () => forbidden('taskkill') },
          prepareProfile: async () => forbidden('profile'),
          spawnHostProcess: () => forbidden('spawn'), fetchJson: async () => forbidden('fetch'),
          killProcess: () => forbidden('kill'), isProcessAlive: () => forbidden('probe'),
          inspectProcessLiveness: async () => forbidden('liveness'),
        })
        const lease = { teamId: 'TEST-team', memberName: 'TEST-member', runId: 'TEST-run', sessionId: 'TEST-session' }
        const operations = [
          () => manager.releaseHostLeaseStrict('TEST-host', lease),
          () => manager.retainHostLease('TEST-host', lease),
          () => manager.resolveOwnedSessionEndpoint('TEST-host', { ...lease, projectPath: root }),
          () => manager.reconcilePersistentHosts({ mode: 'force' }),
          () => manager.withConfirmedAbsentHostAuthority({ hostKey: 'TEST-host', runtimePid: 99001 }, async () => forbidden('recovery')),
          () => manager.ensureHost({ projectPath: root }),
          () => manager.disposeUnregisteredOwnedHosts(),
          () => manager.disposeHost('TEST-host'),
          () => manager.releaseHost('TEST-host'),
          () => manager.refreshResolvedConfigFingerprint('TEST-host'),
        ]
        const outcomes = []
        for (const [index, operation] of operations.entries()) {
          await writeFile(file, bytes)
          calls.length = 0
          let veto = false
          try { await operation() } catch (error) {
            veto = error?.name === 'OpenCodeAuthorityVetoError' && error?.kind === 'preserved_unknown'
          }
          const after = await readFile(file, 'utf8')
          const sentinel = await readFile(peer, 'utf8')
          outcomes.push({ veto, preserved: after === bytes, peer: sentinel === 'shared-authority', tripwires: calls.length })
          console.info('TEST-O1a-receipt', JSON.stringify({ store: 'host', variant, index, veto, tripwires: calls,
            before: createHash('sha256').update(bytes).digest('hex'), after: createHash('sha256').update(after).digest('hex'),
            peer: createHash('sha256').update(sentinel).digest('hex') }))
        }
        expect(outcomes).toEqual(operations.map(() => ({ veto: true, preserved: true, peer: true, tripwires: 0 })))
        const reap = await manager.reapUnleasedCursorAgentTrees({ contractVersion: 1, reason: 'team-stop',
          ownedWorkspaceCwds: [root], startedBeforeMs: Date.now() - 100 })
        expect(reap.status).toBe('incomplete')
        expect(reap.killedPids).toEqual([])
        expect(await readFile(file, 'utf8')).toBe(bytes)
        expect(await readFile(peer, 'utf8')).toBe('shared-authority')
        expect(calls).toEqual([])
      } finally { await rm(root, { recursive: true, force: true }) }
    })
  }
  test('nonregular and symlink registry veto pruning and lease writes', async () => {
    const forbidden = (name: string): never => { throw new Error(`forbidden ${name}`) }
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-O1a-host-path-'))
    try {
      await writeFile(path.join(root, 'TEST-marker.json'), '{"test":true,"task":"O1a"}')
      const peer = path.join(root, 'TEST-peer.json')
      await writeFile(peer, 'shared-authority')
      const link = path.join(root, 'link.json')
      const dangling = path.join(root, 'dangling.json')
      const directory = path.join(root, 'directory.json')
      await symlink(peer, link)
      await symlink(path.join(root, 'missing'), dangling)
      await mkdir(directory)
      for (const file of [link, dangling, directory]) {
        const manager = new OpenCodeHostManager({ persistentRegistryPath: file, processAttributionDirectory: root,
          cursorAgentNativePorts: { birth: async () => forbidden('birth'), tree: async () => forbidden('tree'),
            signal: () => forbidden('signal'), alive: () => forbidden('alive'), taskkill: async () => forbidden('taskkill') },
          killProcess: () => { throw new Error('forbidden kill') },
          fetchJson: async () => { throw new Error('forbidden fetch') } })
        await expect(manager.reconcilePersistentHosts({ mode: 'force' })).rejects.toMatchObject({ name: 'OpenCodeAuthorityVetoError' })
        await expect(manager.releaseHostLeaseStrict('TEST-host', { teamId: 'TEST-team', memberName: 'TEST-member' })).rejects.toMatchObject({ name: 'OpenCodeAuthorityVetoError' })
      }
      expect(await readFile(peer, 'utf8')).toBe('shared-authority')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
