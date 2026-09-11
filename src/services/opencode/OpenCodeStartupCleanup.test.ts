import { hasPendingStartupTaskkill, killProcessTreeForStartup } from '../../utils/processKill.js'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as childProcess from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeStartupCleanupBudget } from './OpenCodeStartupCleanupBudget.js'
import { OpenCodeHostManager, openCodeHostManager } from './OpenCodeHostManager.js'
import { runtimeOpenCodeCommand } from '../../cli/handlers/runtimeOpenCodeCommand.js'
import { openCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { mock.restore(); Object.defineProperty(process, 'platform', platform) })

function record(pid: number, extra = {}) {
  return { hostKey: `host-${pid}`, profileRootKey: 'test-profile', projectPath: '/synthetic',
    projectBehaviorFingerprint: 'behavior', baseUrl: `http://127.0.0.1:${pid}`, port: pid, pid,
    processStartedAtMs: 1000, version: null, resolvedConfigFingerprint: null,
    updatedAt: '2020-01-01T00:00:00.000Z', leases: {}, ...extra }
}
async function fixture(run: (path: string) => Promise<void>, records = [record(41001), record(41002)]) {
  const root = await mkdtemp(join(tmpdir(), 'startup-cleanup-test-'))
  const path = join(root, 'registry.json')
  try {
    await writeFile(path, JSON.stringify({ schemaVersion: 1, processIdentityFormat: 'platform-native-v2',
      hosts: Object.fromEntries(records.map(r => [r.hostKey, r])) }))
    await run(path)
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('startup exhausted after awaited identity cannot mutate; every unprocessed PID is excluded', async () => {
  await fixture(async path => {
    const original = await readFile(path, 'utf8')
    let now = 0
    const budget = new OpenCodeStartupCleanupBudget(Date.now() + 10_000, () => now)
    const kill = mock(() => { throw new Error('must not kill') })
    const manager = new OpenCodeHostManager({ persistentRegistryPath: path, isProcessAlive: () => true,
      readProcessStartTimeMs: async (_pid, timeout) => { expect(timeout).toBe(6_000); now = 10_001; return 1000 },
      killProcess: kill, fetchJson: async () => { throw new Error('must not HTTP dispose') } })
    const result = await manager.reconcilePersistentHosts({ startupBudget: budget, reason: 'startup' })
    expect(result.cleaned).toBe(0)
    expect(result.hosts.map(h => h.action)).toEqual(['failed', 'failed'])
    expect(result.startupCleanup).toEqual({ completion: 'drained', coverage: 'partial', survivingPids: [41001, 41002] })
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(kill).not.toHaveBeenCalled()
  })
})

test('startup multiple candidates share repeated four-second identity budget and never POST or spawn a host', async () => {
  await fixture(async path => {
    let now = 0
    const alive = new Set([41001, 41002])
    const budget = new OpenCodeStartupCleanupBudget(Date.now() + 18_000, () => now)
    const queryCaps: number[] = []
    const fetchJson = mock(async () => { throw new Error('unexpected HTTP') })
    const spawn = spyOn(childProcess, 'spawn').mockImplementation((_cmd, args) => {
      const pid = Number(args![3])
      const child = Object.assign(new EventEmitter(), { pid: 90001, kill: mock(() => true) })
      queueMicrotask(() => { alive.delete(pid); child.emit('close', 0) })
      return child as unknown as childProcess.ChildProcess
    })
    const manager = new OpenCodeHostManager({ persistentRegistryPath: path, isProcessAlive: pid => alive.has(pid),
      readProcessStartTimeMs: async (_pid, timeout) => { queryCaps.push(timeout!); now += 4_000; return 1000 },
      fetchJson,
      spawnHostProcess: () => { throw new Error('unexpected host') } })
    const result = await manager.reconcilePersistentHosts({ startupBudget: budget, reason: 'startup' })
    expect(result.cleaned).toBe(1)
    expect(result.startupCleanup).toEqual({ completion: 'drained', coverage: 'partial', survivingPids: [41002] })
    expect(fetchJson).not.toHaveBeenCalled()
    expect(queryCaps).toEqual([6000, 6000, 6000, 6000, 2000])
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

test('startup retains leases and the original age fence for bounded manual retry', async () => {
  const updatedAt = new Date().toISOString()
  await fixture(async path => {
    const spawn = spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('no termination expected') })
    const manager = new OpenCodeHostManager({ persistentRegistryPath: path, isProcessAlive: () => true,
      readProcessStartTimeMs: async () => 1000 })
    const result = await manager.reconcilePersistentHosts({
      startupBudget: new OpenCodeStartupCleanupBudget(Date.now() + 30_000), staleAgeMs: 60_000 })
    expect(result.hosts.map(h => h.action)).toEqual(['kept_leased', 'kept_recent'])
    expect(result.startupCleanup?.survivingPids).toEqual([41001, 41002])
    expect(spawn).not.toHaveBeenCalled()
  }, [record(41001, { leases: { lease: { leaseKey: 'lease', teamId: 'test', laneId: 'l', memberName: 'm',
    runId: null, sessionId: null, createdAt: updatedAt, updatedAt } } }), record(41002, { updatedAt })])
})

test('actual CLI startup dispatch rejects invalid deadlines before manager work and omits disposal finalizer', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const reconcile = spyOn(openCodeHostManager, 'reconcilePersistentHosts').mockImplementation(async () => {
    throw new Error('invalid deadline must not reconcile')
  })
  const drainCleanup = mock(async () => { throw new Error('startup must not dispose in finalizer') })
  for (const deadlineUnixMs of [null, Date.now() - 1, Date.now() + 130_000]) {
    let result: any
    await runtimeOpenCodeCommand({ input: '/synthetic-envelope' }, {
      readInput: async () => JSON.stringify({ schemaVersion: 1, requestId: 'test',
        command: 'opencode.cleanupStartupHosts', cwd: '/synthetic', startedAt: new Date().toISOString(),
        timeoutMs: 30_000, body: { deadlineUnixMs } }),
      writePayload: async (_opts, payload) => { result = JSON.parse(payload) }, drainCleanup,
      exit: () => {}, onSignal: () => {}, offSignal: () => {},
    })
    expect(result.ok).toBe(false)
  }
  expect(reconcile).not.toHaveBeenCalled()
  expect(drainCleanup).not.toHaveBeenCalled()
})

test('actual CLI startup command dispatch has no readiness, host creation or disposal path', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const reconcile = spyOn(openCodeHostManager, 'reconcilePersistentHosts').mockImplementation(async opts => {
    expect(opts?.startupBudget).toBeInstanceOf(OpenCodeStartupCleanupBudget)
    expect(opts?.staleAgeMs).toBe(1000)
    return { cleaned: 0, remaining: 0, hosts: [], diagnostics: [],
      startupCleanup: { completion: 'drained', coverage: 'complete', survivingPids: [] } }
  })
  const ensure = spyOn(openCodeHostManager, 'ensureHost').mockImplementation(async () => { throw new Error('no host') })
  const probe = spyOn(openCodeProvisioningProbe, 'probe').mockImplementation(async () => { throw new Error('no probe') })
  const dispose = spyOn(openCodeHostManager, 'disposeUnregisteredOwnedHosts').mockImplementation(async () => { throw new Error('no dispose') })
  let result: any
  await runtimeOpenCodeCommand({ input: '/synthetic-envelope' }, {
    readInput: async () => JSON.stringify({ schemaVersion: 1, requestId: 'test',
      command: 'opencode.cleanupStartupHosts', cwd: '/synthetic', startedAt: new Date().toISOString(),
      timeoutMs: 30_000, body: { deadlineUnixMs: Date.now() + 30_000, staleAgeMs: 1000 } }),
    writePayload: async (_opts, payload) => { result = JSON.parse(payload) },
    exit: () => {}, onSignal: () => {}, offSignal: () => {},
  })
  expect(result.ok).toBe(true)
  expect(result.data.startupCleanup.completion).toBe('drained')
  expect(reconcile).toHaveBeenCalledTimes(1)
  expect(ensure).not.toHaveBeenCalled()
  expect(probe).not.toHaveBeenCalled()
  expect(dispose).not.toHaveBeenCalled()
})

test('CLI publishes drained partial evidence only after original late helper close, without redispatch', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  await fixture(async path => {
    const events: string[] = []
    const child = Object.assign(new EventEmitter(), { pid: 90001, kill: mock(() => true) })
    const spawn = spyOn(childProcess, 'spawn').mockReturnValue(child as unknown as childProcess.ChildProcess)
    const signal = spyOn(process, 'kill').mockReturnValue(true)
    const nativeTimeout = globalThis.setTimeout
    let cutoff!: () => void
    let helperTimeout!: () => void
    spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number, ...args: unknown[]) => {
      if (ms === 2500 || ms === 3500) {
        if (ms === 2500) helperTimeout = fn
        else cutoff = fn
        return nativeTimeout(() => {}, 60_000)
      }
      return nativeTimeout(fn, ms, ...args)
    }) as typeof setTimeout)
    const manager = new OpenCodeHostManager({ persistentRegistryPath: path,
      isProcessAlive: () => true, readProcessStartTimeMs: async () => 1000, killProcess: signal })
    const reconcile = spyOn(openCodeHostManager, 'reconcilePersistentHosts')
      .mockImplementation(opts => manager.reconcilePersistentHosts(opts))
    spyOn(openCodeHostManager, 'drainStartupCleanupLockReleases').mockImplementation(async () => {
      await manager.drainStartupCleanupLockReleases()
      events.push('locks-drained')
    })
    let payload: any
    const command = runtimeOpenCodeCommand({ input: '/synthetic-envelope' }, {
      readInput: async () => JSON.stringify({ schemaVersion: 1, requestId: 'late-close',
        command: 'opencode.cleanupStartupHosts', cwd: '/synthetic', startedAt: new Date().toISOString(),
        timeoutMs: 30_000, body: { deadlineUnixMs: Date.now() + 30_000 } }),
      writePayload: async (_opts, value) => { events.push('write'); payload = JSON.parse(value) },
      exit: () => { events.push('exit') }, onSignal: () => {}, offSignal: () => {},
    })
    // Yield to fixture I/O without advancing the captured observation timers.
    for (let attempts = 0; !cutoff && attempts < 1000; attempts++) {
      await new Promise(resolve => nativeTimeout(resolve, 1))
    }
    expect(cutoff).toBeDefined()
    helperTimeout()
    cutoff()
    await new Promise(resolve => nativeTimeout(resolve, 20))
    expect(events).toEqual([])
    expect(hasPendingStartupTaskkill(41001)).toBe(true)
    const retry = await killProcessTreeForStartup(41001, 1000,
      new OpenCodeStartupCleanupBudget(Date.now() + 30_000),
      { readIdentity: async () => 1000, alive: () => true, signal })
    expect(retry.helperTerminated).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(signal).not.toHaveBeenCalled()
    events.push('close')
    child.emit('close', 0)
    await command
    expect(events).toEqual(['close', 'locks-drained', 'write', 'exit'])
    expect(payload.requestId).toBe('late-close')
    expect(payload.data.cleaned).toBe(0)
    expect(payload.data.startupCleanup).toEqual({ completion: 'drained', coverage: 'partial', survivingPids: [41001] })
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(signal).not.toHaveBeenCalled()
  }, [record(41001)])
})
