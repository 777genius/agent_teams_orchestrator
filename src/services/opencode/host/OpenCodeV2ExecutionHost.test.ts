import { describe, expect, test, spyOn } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import { acquireExecutionLease, awaitExecutionHostReady } from './OpenCodeV2ExecutionHost.js'
import { validateExecutionProfile, type ExecutionBirth, type SelectedExecutionProfile, type ValidatedExecutionNative } from './OpenCodeV2ExecutionBinding.js'
import { executionClosedAck, retireExecutionChild, type ExecutionRetirementPort } from './OpenCodeV2ExecutionLifecycle.js'
import { windowsGraphActivation } from './windows/OpenCodeV2WindowsChildControl.js'

const birth: ExecutionBirth = { format: 'linux-start-ticks', value: '420', bootId: 'TEST-boot-domain' }
const context = { teamId: 'TEST-team', runId: 'TEST-run', laneId: 'TEST-lane', memberId: 'TEST-member', deadline: Number.MAX_SAFE_INTEGER }
const native: ValidatedExecutionNative = { generation: 'v2', version: '2.0.21', dialect: 'v2-2.0.21',
  runtimeMode: 'packaged', entrySha256: 'd'.repeat(64), executablePath: '/TEST-missing-selection', executableSha256: 'a'.repeat(64), packageName: '@opencode/cli-linux-x64',
  bun: { path: '/TEST-missing-bun', sha256: 'b'.repeat(64) }, graph: { sha256: 'c'.repeat(64), files: [] } }
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-execution-host-')))
  const env = Object.fromEntries(Object.entries({ HOME: 'home', USERPROFILE: 'home', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state', TMPDIR: 'tmp', TMP: 'tmp', TEMP: 'tmp', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata' })
    .map(([key, relative]) => [key, path.join(root, relative)]))
  await Promise.all([...new Set(Object.values(env))].map(directory => mkdir(directory, { mode: 0o700 })))
  const databasePath = path.join(root, 'data', 'execution.sqlite')
  await writeFile(databasePath, 'TEST-retained-journal')
  const profile: SelectedExecutionProfile = { root, epoch: 'TEST-epoch', directory: root, databasePath, env, envSha256: executionHash(env),
    config: { directory: env.XDG_CONFIG_HOME!, content: '{}', sha256: createHash('sha256').update('{}').digest('hex') },
    selection: { agent: 'build', model: { providerID: 'TEST', id: 'model' }, permissions: [] } }
  return { profile, remove: () => rm(root, { recursive: true, force: true }) }
}
function retirement(overrides: Partial<ExecutionRetirementPort> = {}): ExecutionRetirementPort {
  return { pid: 73, birth, exited: () => true, acknowledged: () => true, disposeTransport: async () => undefined,
    sendClose: () => undefined, waitExit: Promise.resolve(), readBirth: async () => null, kill: () => undefined,
    retireOwnedDescendants: async () => undefined, ...overrides }
}

describe('execution host ownership and cleanup', () => {
  test('Windows graph activation is one-shot and binds the original deadline and physical child', async () => {
    const expected = { nonce: 'TEST-nonce', leaseOwnerId: 'TEST-lease', namespace: 'windows-job:TEST-nonce', pid: 42,
      birth: { format: 'windows-filetime' as const, value: '42', bootId: null } }
    const signal = new AbortController(), input = { type: 'activate', ...expected }
    const barrier = windowsGraphActivation(expected, Date.now() + 5000)
    expect(() => barrier.activate(input, signal.signal)).toThrow()
    barrier.ready()
    for (const drift of [{ nonce: 'foreign' }, { leaseOwnerId: 'foreign' }, { namespace: 'foreign' }, { pid: 43 }, { birth: { ...expected.birth, value: '43' } }])
      expect(() => barrier.activate({ ...input, ...drift }, signal.signal)).toThrow()
    barrier.activate(input, signal.signal)
    await barrier.wait()
    expect(() => barrier.activate(input, signal.signal)).toThrow()
    const expired = windowsGraphActivation(expected, Date.now() + 5000)
    expired.ready()
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 6000)
    try { expect(() => expired.activate(input, signal.signal)).toThrow() } finally { clock.mockRestore() }
    const cancelled = windowsGraphActivation(expected, Date.now() + 5000)
    cancelled.ready()
    const original = new Error('run_stopped')
    const waiting = awaitExecutionHostReady(cancelled.wait(), 1000, signal.signal)
    signal.abort(original)
    await expect(waiting).rejects.toBe(original)
    expect(() => cancelled.activate(input, signal.signal)).toThrow('run_stopped')
  })
  test('actual host overlaps only child graph waits and reacquires the same serial ticket before runtime', async () => {
    // Execute the private production function body with physical ports replaced;
    // this checks its actual ticket boundaries without launching a native child.
    const source = await readFile(new URL('./OpenCodeV2ExecutionHost.ts', import.meta.url), 'utf8')
    const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(source.indexOf('async function acquireOwnedNativeLease(')))
    let tail = Promise.resolve(), critical = 0, maximum = 0
    const gate = async <T>(work: () => Promise<T>) => {
      const previous = tail; let release!: () => void
      tail = new Promise<void>(resolve => { release = resolve })
      await previous; critical++; maximum = Math.max(maximum, critical)
      try { return await work() } finally { critical--; release() }
    }
    const launches: Array<{ emitGraph(drift?: Record<string, unknown>): void; activate: number; closed: number; release: number }> = []
    let currentOwner: { release: number } | undefined
    const scope = { executionAssert: (value: unknown, message?: string) => { if (!value) throw new Error(message ?? 'invalid') },
      executionRecord: (value: unknown) => value, executionHash, randomUUID: () => `TEST-${launches.length}`, randomBytes: () => ({ toString: () => 'TEST-password' }),
      prepareOwnedNativeExecutionPlan: async (native: ValidatedExecutionNative, profile: SelectedExecutionProfile) => ({ native, profile, entry: '/TEST-entry', plan: { platform: 'win32', concrete: {} }, controllerStateRoots: [] }),
      ownerFilesystemForWindowsPlan: () => ({ validateSelectedProfile: async () => {} }), selectWindowsRunMemberPreflightForPlan: async () => null,
      consumeWindowsExecutionLaunchNonce: () => `TEST-${launches.length}`, bindWindowsExecutionSelectedConfig: async () => {},
      closeWindowsExecutionPlan: async () => {}, recordOpenCodeV2ProviderFailure: async () => {},
      acquireExecutionProfileOwner: async () => { const owner = { release: 0 }; currentOwner = owner; return {
        beforeSpawn: async () => {}, bindChild: async () => {}, abandonBeforeSpawn: async () => {}, release: async () => { owner.release++ },
      } },
      launchExecutionPlatform: (_plan: unknown, nonce: string, leaseOwnerId: string) => {
        expect(critical).toBe(1)
        const child = new EventEmitter(), owner = currentOwner!, mapping = { bun: { hostPID: 42, nativePID: 42, birth, executablePath: '/TEST-bun', executableSha256: 'b'.repeat(64) }, namespace: { name: 'TEST-ns' }, leaseOwnerId }
        let payload: Record<string, any>
        const tuple = () => ({ nonce, leaseOwnerId, namespace: mapping.namespace.name, pid: 42, birth,
          pin: native.version, graphSha256: native.graph.sha256, executableSha256: native.bun.sha256,
          profileEpoch: 'TEST-epoch', selectionSha256: executionHash(payload.profile.selection) })
        const observation = { activate: 0, closed: 0, get release() { return owner.release },
          emitGraph: (drift = {}) => child.emit('message', { type: 'graph-ready', ...tuple(), ...drift }) }
        launches.push(observation)
        return { child, prepare: async () => mapping, assertLive: async () => {},
          start: async (value: Record<string, unknown>) => { payload = value; expect(value.deferRuntime).toBe(true); expect(critical).toBe(1) },
          activate: async () => { expect(critical).toBe(1); observation.activate++; child.emit('message', { type: 'ready', ...tuple(), baseUrl: 'http://127.0.0.1:1' }) },
          sendClose: () => { observation.closed++; child.emit('close') }, acknowledged: () => true, retire: async () => {}, kill: async () => {} }
      },
      readExecutionBirth: async () => birth, awaitExecutionHostReady,
      boundOpenCodeRead: async <T>(work: Promise<T>) => work,
      retireExecutionChild: async (input: ExecutionRetirementPort) => { await Promise.resolve(); input.sendClose(); return {} },
      awaitOpenCodeV2CatalogReadiness: async () => { expect(critical).toBe(1) }, initializeOpenCodeV2ExecutionAuth: async () => { expect(critical).toBe(1) },
      awaitOpenCodeV2ExecutionReadiness: async () => { expect(critical).toBe(1) },
      endpoints: new WeakMap(), graphs: new WeakMap(), disposers: new WeakMap(), catalogAuthorities: new WeakSet(),
    }
    const acquire = new Function('scope', `const {${Object.keys(scope).join(',')}}=scope;${body};return acquireOwnedNativeLease;`)(scope) as typeof acquireExecutionLease
    const selected: SelectedExecutionProfile = { root: '/TEST-profile', epoch: 'TEST-epoch', directory: '/TEST-project', databasePath: '/TEST-profile/data/opencode.db',
      env: {}, envSha256: 'f'.repeat(64), config: { directory: '/TEST-profile/config', content: '{}', sha256: 'f'.repeat(64) },
      selection: { agent: 'worker', model: { providerID: 'TEST', id: 'model' }, permissions: [] } }
    const controller = new AbortController(), deadline = Date.now() + 5000
    const work = [acquire(native, selected, { ...context, deadline }, gate), acquire(native, selected, { ...context, deadline }, gate)]
    const wait = async (condition: () => boolean) => { for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(1); expect(condition()).toBe(true) }
    await wait(() => launches.length === 2)
    expect(launches.map(value => value.activate)).toEqual([0, 0]); expect(critical).toBe(0)
    launches[1]!.emitGraph(); launches[0]!.emitGraph()
    const leases = await Promise.all(work)
    expect(maximum).toBe(1); expect(launches.map(value => value.activate)).toEqual([1, 1])
    await Promise.all(leases.map(lease => lease.close()))
    expect(launches.map(value => [value.closed, value.release])).toEqual([[1, 1], [1, 1]])
    const cancelled = acquire(native, selected, { ...context, deadline, signal: controller.signal }, gate)
    await wait(() => launches.length === 3)
    controller.abort(new Error('run_stopped'))
    await expect(cancelled).rejects.toThrow('run_stopped')
    expect(launches[2]).toMatchObject({ activate: 0, closed: 1, release: 1 })
    for (const drift of [{ leaseOwnerId: 'foreign' }, { namespace: 'foreign' }, { pid: 43 }, { birth: { ...birth, value: '43' } },
      { pin: '2.0.0' }, { graphSha256: 'foreign' }, { executableSha256: 'foreign' }, { profileEpoch: 'foreign' }, { selectionSha256: 'foreign' }]) {
      const index = launches.length, foreign = acquire(native, selected, { ...context, deadline }, gate)
      await wait(() => launches.length === index + 1)
      launches[index]!.emitGraph(drift)
      await expect(foreign).rejects.toThrow('execution_identity_mismatch')
      expect(launches[index]).toMatchObject({ activate: 0, closed: 1, release: 1 })
    }
    const queuedSignal = new AbortController(), index = launches.length
    const queued = acquire(native, selected, { ...context, deadline, signal: queuedSignal.signal }, gate)
    await wait(() => launches.length === index + 1)
    let unblock!: () => void
    const blocker = gate(() => new Promise<void>(resolve => { unblock = resolve }))
    await wait(() => critical === 1)
    launches[index]!.emitGraph()
    await Bun.sleep(1)
    queuedSignal.abort(new Error('run_stopped'))
    unblock(); await blocker
    await expect(queued).rejects.toThrow('run_stopped')
    expect(launches[index]).toMatchObject({ activate: 0, closed: 1, release: 1 })
  })
  test('startup readiness preserves the exact acquisition cancellation and original rejection before cleanup', async () => {
    const signal = new AbortController(), original = new Error('run_acquisition_timeout')
    const waiting = awaitExecutionHostReady(new Promise<never>(() => {}), 1000, signal.signal)
    signal.abort(original)
    await expect(waiting).rejects.toBe(original)
    const native = new Error('execution_path_alias:alias_predicate:0')
    await expect(awaitExecutionHostReady(Promise.reject(native), 1000)).rejects.toBe(native)
    await expect(awaitExecutionHostReady(Promise.resolve('TEST-ready'), 1000)).resolves.toBe('TEST-ready')
    const unclassified = new AbortController()
    const unknown = awaitExecutionHostReady(new Promise<never>(() => {}), 1000, unclassified.signal)
    unclassified.abort('TEST-private-reason')
    await expect(unknown).rejects.toThrow('cancelled')
  })
  // A packaged source fallback would reach missing binaries or change caller data.
  test('packaged receipt cannot fall back to source execution before identity reads or data changes', async () => {
    const { profile, remove } = await fixture()
    try {
      await expect(acquireExecutionLease(native, profile, context)).rejects.toThrow('v2_execution_delivery_mismatch')
      expect(await readFile(profile.databasePath, 'utf8')).toBe('TEST-retained-journal')
    } finally { await remove() }
  })
  // Binding only the path would accept a mutated environment/config after owner validation.
  test('changed selected profile bytes are refused without altering the execution DB', async () => {
    const { profile, remove } = await fixture()
    try {
      await expect(validateExecutionProfile({ ...profile, env: { ...profile.env, HOME: '/foreign' } })).rejects.toMatchObject({ message: 'execution_profile_changed', profileGuard: 'environment_hash' })
      await expect(validateExecutionProfile({ ...profile, config: { ...profile.config, content: '{"foreign":true}' } })).rejects.toMatchObject({ message: 'execution_profile_changed', profileGuard: 'config_hash' })
      expect(await readFile(profile.databasePath, 'utf8')).toBe('TEST-retained-journal')
    } finally { await remove() }
  })
  // PID-only ACK or scope-only completion could falsely retire a reused process.
  test('close acknowledgment requires nonce, pid, birth, boot domain and actual Scope close', () => {
    const row = { type: 'closed', nonce: 'lease', pid: 73, birth, scopeClosed: true }
    expect(executionClosedAck(row, 'lease', 73, birth)).toBe(true)
    for (const altered of [{ ...row, nonce: 'foreign' }, { ...row, pid: 74 }, { ...row, scopeClosed: false },
      { ...row, birth: { ...birth, bootId: 'other-boot' } }]) expect(executionClosedAck(altered, 'lease', 73, birth)).toBe(false)
  })
  // A failed wire dispose must still send Scope close and check process retirement.
  test('transport failure does not skip independent close or birth checks', async () => {
    const calls: string[] = []
    await expect(retireExecutionChild(retirement({ exited: () => false,
      disposeTransport: async () => { calls.push('wire'); throw new Error('wire') },
      sendClose: () => { calls.push('scope') }, readBirth: async () => { calls.push('birth'); return null } }))).rejects.toThrow('cleanup_unknown')
    expect(calls).toEqual(['wire', 'scope', 'birth'])
  })
  test('leader disappearance without Scope acknowledgment retains unknown cleanup', async () => {
    await expect(retireExecutionChild(retirement({ acknowledged: () => false }))).rejects.toThrow('cleanup_unknown')
    await expect(retireExecutionChild(retirement({ readBirth: async () => birth }))).rejects.toThrow('cleanup_unknown')
  })
  test('descendant retirement failure cannot become a successful lease close', async () => {
    await expect(retireExecutionChild(retirement({ retireOwnedDescendants: async () => { throw new Error('escaped') } }))).rejects.toThrow('cleanup_unknown')
  })
  // A caller can report every successful close field, but only a concrete
  // launch-owned kernel receipt may authorize freeing the durable profile/DB.
  test('caller supplied native retirement fields cannot mint a cleanup receipt', async () => {
    const bun = { hostPID: 73, nativePID: 1, birth, executablePath: '/TEST-bun', executableSha256: 'a'.repeat(64) }
    const mapping = { bun, init: bun, supervisor: bun, leaseOwnerId: 'TEST-lease',
      namespace: { name: 'pid:[73]', inode: '73', device: '1' } }
    const forged = { pid: 73, birth, scopeClosed: true, processRetired: true, descendantsRetired: true, mapping }
    await expect(retireExecutionChild(retirement({ retireOwnedDescendants: async () => forged }))).rejects.toThrow('cleanup_unknown')
  })
  // Even late Scope ACK + leader disappearance cannot certify unqualified descendants.
  test('late close acquisition is joined while unqualified cleanup remains unknown', async () => {
    let exited = false, ack = false, resolveExit: () => void = () => undefined
    const waitExit = new Promise<void>(resolve => { resolveExit = resolve })
    await expect(retireExecutionChild(retirement({ exited: () => exited, acknowledged: () => ack, waitExit,
      sendClose: () => { queueMicrotask(() => { ack = true; exited = true; resolveExit() }) } }))).rejects.toThrow('cleanup_unknown')
    expect(exited).toBe(true)
    expect(ack).toBe(true)
  })
})
