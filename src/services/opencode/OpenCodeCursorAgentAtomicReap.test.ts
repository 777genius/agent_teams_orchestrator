import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { parseCursorAgentReapInput, reapCursorAgents, type CursorAgentReapResult } from './OpenCodeCursorAgentAtomicReap.js'
import type { AttributionRecords } from './OpenCodeProcessAttributionStore.js'

function fixture() {
  const workspace = path.resolve(os.tmpdir(), 'cursor-reap-fake-workspace')
  const id = 'a'.repeat(32)
  const host = { hostKey: 'host', attributionId: id, pid: 100, processStartedAtMs: 10,
    projectPath: workspace, profileRootKey: 'profile', projectBehaviorFingerprint: 'TEST-behavior',
    baseUrl: 'http://127.0.0.1:9911', port: 9911, version: null, resolvedConfigFingerprint: null,
    updatedAt: '2026-10-01T00:00:00.000Z', leases: {}, cursorAgentReapContractVersion: 1 }
  const registry = { schemaVersion: 1, processIdentityFormat: 'platform-native-v2', hosts: { host } }
  const records: AttributionRecords = { corruptPaths: [], hosts: [{ filePath: 'fake-host', record: {
    schemaVersion: 1, attributionId: id, hostPid: 100, hostStartedAtNative: 10,
    hostStartTimeFormat: 'linux-ticks', projectPath: workspace, appInstanceId: null,
    appProfileScope: 'profile', runtimeVersion: null, owners: [], releasedOwners: [], updatedAt: '' } }],
    agents: [{ filePath: 'fake-agent', record: { schemaVersion: 1, attributionId: id,
      pid: 101, parentPid: 100, kind: 'cursor-agent', startedAtMs: 1,
      startTimeToleranceMs: 2000, nativeStartToken: 'proc:20', workspacePath: workspace,
      cwd: workspace, appInstanceId: null, appProfileScope: 'profile', runtimeVersion: null,
      writtenAtMs: 1, exitedAtMs: null } }] }
  const signals: number[] = []
  const input = parseCursorAgentReapInput({ contractVersion: 1, reason: 'team-stop', ownedWorkspaceCwds: [workspace], startedBeforeMs: 2 })
  const options = { deadline: Date.now() + 10000, guard: () => {}, profileScope: 'profile',
    pendingOAuth: async () => false, processLifetime: () => false,
    native: { platform: 'linux' as const, selfPid: 999, birth: async (pid: number) => pid === 100 ? 10 : 20,
      tree: async () => [{ pid: 101, ppid: 100 }], signal: (pid: number) => { signals.push(pid) },
      alive: (pid: number) => signals.includes(pid) ? 'gone' as const : 'alive' as const } }
  const result: CursorAgentReapResult = { contractVersion: 1, status: 'kept', killedPids: [], diagnostics: [] }
  return { registry, host, records, signals, input, options, result }
}
test('supported empty raw leases invoke native termination; owners are metadata', async () => {
  const f = fixture()
  await reapCursorAgents(f.input, f.registry, f.records, f.options, f.result)
  expect(f.result.status).toBe('completed')
  expect(f.signals).toEqual([101])
})
test.each(['foreign', 'same-team', '__opencode_preflight__'])('any lease vetoes: %s', async teamId => {
  const f = fixture(); f.host.leases = { lease: { teamId } }
  await reapCursorAgents(f.input, f.registry, f.records, f.options, f.result)
  expect(f.signals).toEqual([])
  expect(f.result.status).toBe('kept')
})
test('malformed and unsupported registry authority keeps', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { delete (f.host as Partial<typeof f.host>).cursorAgentReapContractVersion },
    (f: ReturnType<typeof fixture>) => { f.host.leases = [] },
    (f: ReturnType<typeof fixture>) => { delete (f.host as Partial<typeof f.host>).leases },
    (f: ReturnType<typeof fixture>) => { f.registry.schemaVersion = 2 },
    (f: ReturnType<typeof fixture>) => { f.host.processStartedAtMs = NaN },
    (f: ReturnType<typeof fixture>) => { f.records.agents[0]!.record.kind = 'readiness-probe' },
    (f: ReturnType<typeof fixture>) => { f.records.agents[0]!.record.workspacePath = path.resolve('/foreign') },
    (f: ReturnType<typeof fixture>) => { f.records.agents[0]!.record.nativeStartToken = 'proc:21' },
    (f: ReturnType<typeof fixture>) => { f.records.agents.push(f.records.agents[0]!) },
  ]) {
    const f = fixture(); change(f)
    await reapCursorAgents(f.input, f.registry, f.records, f.options, f.result)
    expect(f.signals).toEqual([])
  }
})
test('parser rejects authority extensions and future cutoff', () => {
  const f = fixture()
  expect(() => parseCursorAgentReapInput({ ...f.input, pid: 101 })).toThrow()
  expect(() => parseCursorAgentReapInput({ ...f.input, startedBeforeMs: Date.now() + 100000 })).toThrow()
})
test('persistent admission cannot reconstruct missing records or admit without persistence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cursor-reap-admission-'))
  try {
    for (const persistentRegistryPath of [null, path.join(directory, 'registry.json')]) {
      const manager = new OpenCodeHostManager({ persistentRegistryPath })
      await expect(manager.retainHostLease('missing', { teamId: 'team', memberName: 'member' })).rejects.toThrow()
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('same-generation upsert preserves only previously supported markers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cursor-reap-marker-'))
  try {
    const registryPath = path.join(directory, 'registry.json')
    const manager = new OpenCodeHostManager({ persistentRegistryPath: registryPath, processAttributionDirectory: null })
    // Exercise the same internal writer used by create and adoption without spawning.
    const writer = manager as unknown as { upsertPersistentHost: (handle: unknown, fresh?: boolean) => Promise<void> }
    const handle = { hostKey: 'host', pid: 100, processStartedAtMs: 10, attributionId: 'a'.repeat(32),
      profile: {}, projectPath: directory, profileRootKey: 'profile', projectBehaviorFingerprint: 'TEST-behavior',
      baseUrl: 'http://127.0.0.1:9911', port: 9911, version: null, resolvedConfigFingerprint: null }
    await writer.upsertPersistentHost(handle, true)
    await writer.upsertPersistentHost(handle)
    let raw = JSON.parse(await readFile(registryPath, 'utf8'))
    expect(raw.hosts.host.cursorAgentReapContractVersion).toBe(1)
    delete raw.hosts.host.cursorAgentReapContractVersion
    await writeFile(registryPath, JSON.stringify(raw))
    await writer.upsertPersistentHost(handle)
    raw = JSON.parse(await readFile(registryPath, 'utf8'))
    expect(raw.hosts.host.cursorAgentReapContractVersion).toBeUndefined()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('real registry gate serializes durable admission with full termination', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cursor-reap-lock-'))
  const previousScope = process.env.CLAUDE_TEAM_APP_PROFILE_SCOPE
  process.env.CLAUDE_TEAM_APP_PROFILE_SCOPE = 'profile'
  try {
    const f = fixture()
    const registryPath = path.join(directory, 'registry.json')
    const attributionDirectory = path.join(directory, 'attribution')
    const id = f.host.attributionId
    await mkdir(path.join(attributionDirectory, 'v1', 'hosts'), { recursive: true })
    await mkdir(path.join(attributionDirectory, 'v1', 'agents', id), { recursive: true })
    await writeFile(path.join(attributionDirectory, 'v1', 'hosts', id + '.json'), JSON.stringify(f.records.hosts[0]!.record))
    await writeFile(path.join(attributionDirectory, 'v1', 'agents', id, 'agent.json'), JSON.stringify(f.records.agents[0]!.record))
    await writeFile(registryPath, JSON.stringify(f.registry))
    const entered = deferred(), finish = deferred()
    const manager = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
      processAttributionDirectory: attributionDirectory,
      cursorAgentNativePorts: { ...f.options.native,
        tree: async () => { entered.resolve(); await finish.promise; return [{ pid: 101, ppid: 100 }] },
      } })
    // A different manager has no local handle state; serialization is on disk.
    const other = new OpenCodeHostManager({ persistentRegistryPath: registryPath, processAttributionDirectory: null })
    const lease = { teamId: 'team-b', memberName: 'lead', runId: 'new-run', sessionId: 'new-session' }
    const reap = manager.reapUnleasedCursorAgentTrees(f.input)
    await entered.promise
    let admitted = false
    const retain = other.retainHostLease('host', lease).then(() => { admitted = true })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(admitted).toBe(false)
    expect(f.signals).toEqual([])
    finish.resolve()
    expect((await reap).status).toBe('completed')
    await retain
    expect(admitted).toBe(true)
    expect(f.signals).toEqual([101])
    // Reverse order: the durable lease vetoes, even though attribution still says empty owners.
    f.signals.length = 0
    expect((await manager.reapUnleasedCursorAgentTrees(f.input)).status).toBe('kept')
    expect(f.signals).toEqual([])
    // Exact release restores a useful cleanup path under the same gate.
    expect(await other.releaseHostLeaseStrict('host', lease)).toBe(true)
    expect((await manager.reapUnleasedCursorAgentTrees(f.input)).status).toBe('completed')
    expect(f.signals).toEqual([101])
  } finally {
    if (previousScope === undefined) delete process.env.CLAUDE_TEAM_APP_PROFILE_SCOPE
    else process.env.CLAUDE_TEAM_APP_PROFILE_SCOPE = previousScope
    await rm(directory, { recursive: true, force: true })
  }
})

test.each(['darwin', 'win32'] as const)('requires an exact recorded native epoch birth on %s', async platform => {
  for (const token of [null, 'epoch:19', 'epoch:20']) {
    const f = fixture()
    f.options.native.platform = platform as 'linux'
    f.records.hosts[0]!.record.hostStartTimeFormat = 'epoch-ms'
    f.records.agents[0]!.record.nativeStartToken = token
    if (platform === 'win32') {
      Object.assign(f.options.native, { taskkill: async () => { f.signals.push(101) } })
    }
    await reapCursorAgents(f.input, f.registry, f.records, f.options, f.result)
    expect(f.signals).toEqual(token === 'epoch:20' ? [101] : [])
  }
})
