import { describe, expect, test, spyOn } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { executionHash, openCodeV2RunInitializationMs } from '../execution/OpenCodeV2ExecutionContracts.js'
import { executionNativeRetirementPhases, type ExecutionCleanupObservation, type ExecutionCleanupPhase } from '../execution/OpenCodeV2Diagnostics.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'
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
  test('owner initialization budget is platform-specific without changing other platforms', () => {
    expect(openCodeV2RunInitializationMs('win32')).toBe(300_000)
    expect(openCodeV2RunInitializationMs('darwin')).toBe(180_000)
    expect(openCodeV2RunInitializationMs('linux')).toBe(90_000)
  })
  for (const mode of ['deferred-extended-expiry', 'deferred-expiry', 'deferred-stop', 'deferred-premature', 'deferred-expired', 'deferred-overflow', 'standalone-windows', 'standalone-posix'] as const)
    test(`actual child watchdog retains its original deadline and activation barrier (${mode})`, async () => {
      const source = await readFile(path.resolve(import.meta.dir, '../../../entrypoints/opencodeV2ExecutionServer.ts'), 'utf8')
      const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(source.indexOf('const controller = new AbortController()'))
        .replaceAll('import.meta.url', JSON.stringify('/TEST-entry')))
      const base = 1_000_000, originalDeadline = base + (mode === 'deferred-extended-expiry' ? 250_000 : 150_000)
      let now = base, sequence = 0, completeGraph!: () => void
      const clock = spyOn(Date, 'now').mockImplementation(() => now)
      const timers = new Map<number, { at: number; run: () => void }>()
      const armed: number[] = []
      const events = new EventEmitter(), sent: Readonly<Record<string, unknown>>[] = [], reports: Record<string, any>[] = [], exits: number[] = []
      const nonce = '11111111-1111-4111-8111-111111111111', leaseOwnerId = '22222222-2222-4222-8222-222222222222'
      const childBirth: ExecutionBirth = { format: 'windows-filetime', value: '42', bootId: null }
      const prepared = { nonce, leaseOwnerId, namespace: `windows-job:${nonce}`, pid: 42, birth: childBirth, executableSha256: native.bun.sha256 }
      const profile: SelectedExecutionProfile = { root: '/TEST-profile', epoch: 'TEST-epoch', directory: '/TEST-project', databasePath: '/TEST-profile/data/opencode.db',
        env: {}, envSha256: 'f'.repeat(64), config: { directory: '/TEST-profile/config', content: '{}', sha256: 'f'.repeat(64) },
        selection: { agent: 'worker', model: { providerID: 'TEST', id: 'model' }, permissions: [] } }
      const platform = mode === 'standalone-posix' ? 'darwin' : 'win32'
      const scope = { AbortController, Date, windowsGraphActivation, boundOpenCodeRead, openCodeV2RunInitializationMs,
        process: { platform, pid: 42, env: { PWD: profile.directory }, versions: { bun: 'TEST-bun' },
          execPath: native.bun.path, argv: ['TEST-bun', '/TEST-entry'], cwd: () => profile.directory,
          stderr: { write: (text: string) => { reports.push(JSON.parse(text)) } }, once: () => {}, exit: (code: number) => { exits.push(code) } },
        childControl: { events, connected: () => true, send: async (value: Readonly<Record<string, unknown>>) => { sent.push(value) }, disconnect: () => {} },
        setTimeout: (run: () => void, ms: number) => { const id = ++sequence; armed.push(now + ms); timers.set(id, { at: now + ms, run }); return id },
        clearTimeout: (id: number) => { timers.delete(id) },
        executionAssert: (value: unknown, message = 'execution_contract_invalid') => { if (!value) throw new Error(message) },
        executionRecord: (value: unknown) => value, executionHash, executionProfileGuards: [], readExecutionGraphFailure: () => undefined,
        prepareExecutionPlatformChild: async () => prepared, readExecutionPlatformBirth: async () => childBirth,
        resolveOpenCodeV2ExecutionDelivery: async () => ({ runtimeMode: native.runtimeMode, entrySha256: native.entrySha256 }),
        validateExecutionProfile: async () => {}, assertExecutionProfile: () => {}, openCodeBunVersion: () => 'TEST-bun',
        hashOpenCodeFile: async (file: string) => file === native.bun.path ? native.bun.sha256 : native.entrySha256,
        validateExecutionNative: async () => {},
        validateExecutionGraph: (_pin: unknown, _graph: unknown, progress: (value: unknown) => void, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
          progress({ phase: 'closure', completed: 53237, total: 53237 })
          completeGraph = resolve
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
      }
      try {
        const inspect = new Function('scope', `const {${Object.keys(scope).join(',')}}=scope;${body};return () => ({startupStage, closing, runtimeReady});`)(scope) as () => { startupStage: string; closing: boolean; runtimeReady: boolean }
        const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
        const advance = async (time: number) => {
          now = time
          for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run() }
          await settle()
        }
        expect([...timers.values()].map(timer => timer.at)).toEqual([base + (platform === 'win32' ? 120_000 : 60_000)])
        events.emit('message', { type: 'prepare', nonce, leaseOwnerId }); await settle()
        now = base + 20_000
        const deferred = mode.startsWith('deferred')
        events.emit('message', { type: 'start', nonce, leaseOwnerId, namespace: prepared.namespace, password: 'A'.repeat(43), native, profile,
          ...(deferred ? { deferRuntime: true, activationDeadline: mode === 'deferred-expired' ? now : mode === 'deferred-overflow' ? base + 300_001 : originalDeadline } : {}) })
        await settle()
        if (mode === 'deferred-expired' || mode === 'deferred-overflow') {
          expect(armed).toEqual([base + 120_000])
          expect(inspect()).toMatchObject({ closing: true, runtimeReady: false })
          expect(reports[0]).toMatchObject({ reason: 'failed', cause: 'execution_identity_mismatch' })
          expect(sent.some(value => value.type === 'graph-ready' || value.type === 'ready')).toBe(false)
          expect(exits).toEqual([0])
          return
        }
        expect(inspect().startupStage).toBe('graph-validation')
        expect(sent.some(value => value.type === 'graph-ready')).toBe(false) // Closure-start progress is not a completed validation.
        if (deferred) {
          expect([...timers.values()].map(timer => timer.at)).toEqual([originalDeadline])
          if (mode === 'deferred-premature') events.emit('message', { type: 'activate', ...prepared })
          else {
            now = base + 110_000; completeGraph(); await settle()
            expect(inspect().startupStage).toBe('waiting-for-activation')
            expect(sent.some(value => value.type === 'graph-ready')).toBe(true)
            await advance(base + 120_001)
            expect(inspect().closing).toBe(false)
            expect(reports).toEqual([])
            if (mode === 'deferred-stop') events.emit('message', { type: 'close', nonce, leaseOwnerId })
            else await advance(originalDeadline)
          }
        } else await advance(base + (platform === 'win32' ? 120_000 : 60_000))
        await settle()
        expect(inspect()).toMatchObject({ closing: true, runtimeReady: false })
        expect(sent.some(value => value.type === 'ready')).toBe(false)
        expect(exits).toEqual([0])
        expect(reports).toHaveLength(1)
        if (mode.endsWith('expiry')) expect(reports[0]).toMatchObject({ reason: 'timeout', stage: 'waiting-for-activation', elapsedMs: originalDeadline - base })
        if (!deferred) expect(reports[0]).toMatchObject({ reason: 'timeout', stage: 'graph-validation', elapsedMs: platform === 'win32' ? 120_000 : 60_000 })
        if (mode === 'deferred-extended-expiry') {
          events.emit('message', { type: 'activate', ...prepared }); await settle()
          expect(inspect()).toMatchObject({ closing: true, runtimeReady: false })
          expect(sent.some(value => value.type === 'ready')).toBe(false)
          expect(exits).toEqual([0])
        }
      } finally { clock.mockRestore() }
    })
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
    const reader = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(source.indexOf('export function readExecutionCleanupObservation('),
      source.indexOf('export function requireExecutionEndpoint(')).replace('export ', ''))
    const cleanupObservations = new WeakMap<object, () => ExecutionCleanupObservation | undefined>()
    let heldRetirement: Promise<void> | undefined, heldRelease: Promise<void> | undefined
    let tail = Promise.resolve(), critical = 0, maximum = 0, birthReads = 0, catalogs = 0
    let platform: 'win32' | 'darwin' = 'win32'
    const gate = async <T>(work: () => Promise<T>) => {
      const previous = tail; let release!: () => void
      tail = new Promise<void>(resolve => { release = resolve })
      await previous; critical++; maximum = Math.max(maximum, critical)
      try { return await work() } finally { critical--; release() }
    }
    const launches: Array<{ emitGraph(drift?: Record<string, unknown>): void; emitNative(phase: unknown): void; activate: number; closed: number; release: number;
      readyChecks: number; readyError?: Error; readyGate?: Promise<void> }> = []
    let currentOwner: { release: number } | undefined
    const scope = { executionAssert: (value: unknown, message?: string) => { if (!value) throw new Error(message ?? 'invalid') },
      executionRecord: (value: unknown) => value, executionHash, randomUUID: () => `TEST-${launches.length}`, randomBytes: () => ({ toString: () => 'TEST-password' }),
      prepareOwnedNativeExecutionPlan: async (native: ValidatedExecutionNative, profile: SelectedExecutionProfile) => ({ native, profile, entry: '/TEST-entry', plan: { platform, concrete: {} }, controllerStateRoots: [] }),
      ownerFilesystemForWindowsPlan: () => ({ validateSelectedProfile: async () => {} }), selectWindowsRunMemberPreflightForPlan: async () => null,
      consumeWindowsExecutionLaunchNonce: () => `TEST-${launches.length}`, bindWindowsExecutionSelectedConfig: async () => {},
      closeWindowsExecutionPlan: async () => {}, recordOpenCodeV2ProviderFailure: async () => {},
      acquireExecutionProfileOwner: async () => { const owner = { release: 0 }; currentOwner = owner; return {
        beforeSpawn: async () => {}, bindChild: async () => {}, abandonBeforeSpawn: async () => {}, release: async () => { owner.release++; await heldRelease },
      } },
      launchExecutionPlatform: (_plan: unknown, nonce: string, leaseOwnerId: string) => {
        expect(critical).toBe(1)
        const child = new EventEmitter(), owner = currentOwner!, mapping = { bun: { hostPID: 42, nativePID: 42, birth, executablePath: '/TEST-bun', executableSha256: 'b'.repeat(64) }, namespace: { name: 'TEST-ns' }, leaseOwnerId }
        let payload: Record<string, any>, atReady = false
        const tuple = () => ({ nonce, leaseOwnerId, namespace: mapping.namespace.name, pid: 42, birth,
          pin: native.version, graphSha256: native.graph.sha256, executableSha256: native.bun.sha256,
          profileEpoch: 'TEST-epoch', selectionSha256: executionHash(payload.profile.selection) })
        const observation: typeof launches[number] = { activate: 0, closed: 0, readyChecks: 0, get release() { return owner.release },
          emitNative: phase => { child.emit('retireProgress', phase) },
          emitGraph: (drift = {}) => child.emit('message', { type: 'graph-ready', ...tuple(), ...drift }) }
        launches.push(observation)
        const assertLive = async () => {
          expect(critical).toBe(1)
          if (atReady) { observation.readyChecks++; if (observation.readyError) throw observation.readyError; await observation.readyGate }
        }
        return { child, prepare: async () => mapping, assertLive,
          start: async (value: Record<string, unknown>) => {
            payload = value; expect(value.deferRuntime).toBe(platform === 'win32' ? true : undefined); expect(critical).toBe(1)
            if (platform !== 'win32') { atReady = true; child.emit('message', { type: 'ready', ...tuple(), baseUrl: 'http://127.0.0.1:1' }) }
          },
          activate: async () => { await assertLive(); observation.activate++; atReady = true; child.emit('message', { type: 'ready', ...tuple(), baseUrl: 'http://127.0.0.1:1' }) },
          sendClose: () => { observation.closed++; child.emit('close') }, acknowledged: () => true, retire: async () => {}, kill: async () => {} }
      },
      readExecutionBirth: async () => { birthReads++; expect(critical).toBe(1); return birth }, awaitExecutionHostReady,
      boundOpenCodeRead: async <T>(work: Promise<T>) => work,
      retireExecutionChild: async (input: ExecutionRetirementPort, _deadline: number | undefined, observe?: (phase: ExecutionCleanupPhase) => void) => {
        observe?.('kernel-retirement'); await Promise.resolve(); input.sendClose(); await heldRetirement; return {}
      },
      awaitOpenCodeV2CatalogReadiness: async () => { catalogs++; expect(critical).toBe(1) }, initializeOpenCodeV2ExecutionAuth: async () => { expect(critical).toBe(1) },
      awaitOpenCodeV2ExecutionReadiness: async () => { expect(critical).toBe(1) },
      endpoints: new WeakMap(), graphs: new WeakMap(), disposers: new WeakMap(), catalogAuthorities: new WeakSet(),
      cleanupObservations, executionNativeRetirementPhases,
    }
    const acquire = new Function('scope', `const {${Object.keys(scope).join(',')}}=scope;${body};return acquireOwnedNativeLease;`)(scope) as typeof acquireExecutionLease
    const readObservation = new Function('scope', `const {cleanupObservations}=scope;${reader};return readExecutionCleanupObservation;`)(scope) as
      (lease: import('./OpenCodeV2ExecutionHost.js').ExecutionLease) => ExecutionCleanupObservation | undefined
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
    expect(birthReads).toBe(0); expect(launches.map(value => value.readyChecks)).toEqual([1, 1])
    let releaseNative!: () => void, releaseOwner!: () => void
    heldRetirement = new Promise<void>(resolve => { releaseNative = resolve })
    heldRelease = new Promise<void>(resolve => { releaseOwner = resolve })
    const closing = leases[0]!.close()
    await wait(() => readObservation(leases[0]!)?.phase === 'kernel-retirement')
    launches[0]!.emitNative('retire_grants_roots')
    const snapshot = readObservation(leases[0]!)
    await expect(boundOpenCodeRead(closing, 1)).rejects.toThrow('timeout') // Owner's outer timer wins while original cleanup is pending.
    expect(snapshot).toEqual({ phase: 'kernel-retirement', nativePhase: 'retire_grants_roots' })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(readObservation({ ...leases[0]! })).toBeUndefined() // Same-fields objects cannot borrow the original observation.
    launches[0]!.emitNative('TEST-private-path-secret')
    expect(readObservation(leases[0]!)).toEqual({ phase: 'kernel-retirement' })
    launches[0]!.emitNative(undefined); releaseNative(); heldRetirement = undefined
    await wait(() => readObservation(leases[0]!)?.phase === 'owner-release')
    expect(readObservation(leases[0]!)).toEqual({ phase: 'owner-release' })
    expect(snapshot).toEqual({ phase: 'kernel-retirement', nativePhase: 'retire_grants_roots' })
    releaseOwner(); heldRelease = undefined; await closing
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
    const deadIndex = launches.length, original = new Error('execution_identity_mismatch')
    const dead = acquire(native, selected, { ...context, deadline }, gate)
    await wait(() => launches.length === deadIndex + 1)
    launches[deadIndex]!.readyError = original; launches[deadIndex]!.emitGraph()
    await expect(dead).rejects.toBe(original)
    expect(launches[deadIndex]).toMatchObject({ activate: 1, readyChecks: 1, closed: 1, release: 1 })
    expect(catalogs).toBe(2) // A ready frame cannot publish authority after the held process check fails.
    const blockedSignal = new AbortController(), blockedIndex = launches.length
    let releaseCheck!: () => void
    const blocked = acquire(native, selected, { ...context, deadline, signal: blockedSignal.signal }, gate)
    await wait(() => launches.length === blockedIndex + 1)
    launches[blockedIndex]!.readyGate = new Promise<void>(resolve => { releaseCheck = resolve })
    launches[blockedIndex]!.emitGraph(); await wait(() => launches[blockedIndex]!.readyChecks === 1)
    blockedSignal.abort(original)
    await expect(blocked).rejects.toBe(original)
    expect(launches[blockedIndex]).toMatchObject({ closed: 1, release: 1 })
    expect(critical).toBe(0); expect(catalogs).toBe(2); expect(birthReads).toBe(0)
    releaseCheck(); await Bun.sleep(0); expect(catalogs).toBe(2)
    platform = 'darwin'
    const posix = await acquire(native, selected, { ...context, deadline }, gate)
    expect(birthReads).toBe(1); expect(catalogs).toBe(3)
    await posix.close()
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
