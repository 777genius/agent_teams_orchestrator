import { describe, expect, test, spyOn } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { executionHash, openCodeV2RunInitializationMs } from '../execution/OpenCodeV2ExecutionContracts.js'
import { executionNativeRetirementPhases, readExecutionNativeRootObservation, retainOpenCodeV2CatalogServerFailure,
  type ExecutionCleanupObservation, type ExecutionCleanupPhase } from '../execution/OpenCodeV2Diagnostics.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'
import { assertOpenCodeV2Launchable, isOpenCodeV2Identity, openCodeV2EngineVersion } from '../compatibility/OpenCodeV2Registry.js'
import { openCodeV2ExecutionCloseAckReserveMs, runOpenCodeV2ExecutionCloseSequence } from '../execution/OpenCodeV2ExecutionClose.js'
import { acquireExecutionLease, awaitExecutionHostReady } from './OpenCodeV2ExecutionHost.js'
import { validateExecutionProfile, type ExecutionBirth, type SelectedExecutionProfile, type ValidatedExecutionNative } from './OpenCodeV2ExecutionBinding.js'
import { executionClosedAck, retireExecutionChild, type ExecutionRetirementPort } from './OpenCodeV2ExecutionLifecycle.js'

const birth: ExecutionBirth = { format: 'linux-start-ticks', value: '420', bootId: 'TEST-boot-domain' }
const context = { teamId: 'TEST-team', runId: 'TEST-run', laneId: 'TEST-lane', memberId: 'TEST-member', deadline: Number.MAX_SAFE_INTEGER }
const native: ValidatedExecutionNative = { generation: 'v2', version: '2.0.32', dialect: 'v2-2.0.32',
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
    expect(openCodeV2RunInitializationMs('darwin')).toBe(300_000)
    expect(openCodeV2RunInitializationMs('linux')).toBe(180_000)
  })
  for (const mode of ['standalone-windows', 'standalone-posix', 'owner-deadline-posix', 'transport-error'] as const)
    test(`actual child watchdog retains its original owner deadline (${mode})`, async () => {
      const source = await readFile(path.resolve(import.meta.dir, '../../../entrypoints/opencodeV2ExecutionServer.ts'), 'utf8')
      const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(source.indexOf('const controller = new AbortController()'))
        .replaceAll('import.meta.url', JSON.stringify('/TEST-entry')))
      // This watchdog fixture exercises source startup; packaged delivery refusal is tested separately below.
      const sourceNative: ValidatedExecutionNative = { ...native, runtimeMode: 'source' }
      const base = 1_000_000, originalDeadline = base + 150_000
      let now = base, sequence = 0, completeGraph!: () => void
      const clock = spyOn(Date, 'now').mockImplementation(() => now)
      const timers = new Map<number, { at: number; run: () => void }>()
      const armed: number[] = []
      const events = new EventEmitter(), sent: Readonly<Record<string, unknown>>[] = [], reports: Record<string, any>[] = [], exits: number[] = []
      const nonce = '11111111-1111-4111-8111-111111111111', leaseOwnerId = '22222222-2222-4222-8222-222222222222'
      const childBirth: ExecutionBirth = { format: 'utc-ms', value: '42', bootId: null }
      const prepared = { nonce, leaseOwnerId, namespace: 'process', pid: 42, birth: childBirth, executableSha256: native.bun.sha256 }
      const profile: SelectedExecutionProfile = { root: '/TEST-profile', epoch: 'TEST-epoch', directory: '/TEST-project', databasePath: '/TEST-profile/data/opencode.db',
        env: {}, envSha256: 'f'.repeat(64), config: { directory: '/TEST-profile/config', content: '{}', sha256: 'f'.repeat(64) },
        selection: { agent: 'worker', model: { providerID: 'TEST', id: 'model' }, permissions: [] } }
      const platform = mode === 'standalone-posix' || mode === 'owner-deadline-posix' ? 'darwin' : 'win32'
      const scope = { AbortController, Date, boundOpenCodeRead, runOpenCodeV2ExecutionCloseSequence, openCodeV2ExecutionCloseAckReserveMs, openCodeV2RunInitializationMs,
        process: { platform, pid: 42, env: { PWD: profile.directory }, versions: { bun: 'TEST-bun' },
          execPath: native.bun.path, argv: ['TEST-bun', '/TEST-entry'], cwd: () => profile.directory,
          stderr: { write: (text: string) => { reports.push(JSON.parse(text)) } }, once: () => {}, exit: (code: number) => { exits.push(code) } },
        childControl: { events, connected: () => true, send: async (value: Readonly<Record<string, unknown>>) => { sent.push(value) },
          disconnect: () => {} },
        setTimeout: (run: () => void, ms: number) => { const id = ++sequence; armed.push(now + ms); timers.set(id, { at: now + ms, run }); return id },
        clearTimeout: (id: number) => { timers.delete(id) },
        executionAssert: (value: unknown, message = 'execution_contract_invalid') => { if (!value) throw new Error(message) },
        executionRecord: (value: unknown) => value, executionHash, executionProfileGuards: [], readExecutionGraphFailure: () => undefined,
        assertOpenCodeV2Launchable, isOpenCodeV2Identity, openCodeV2EngineVersion,
        prepareExecutionPlatformChild: async () => prepared, readExecutionPlatformBirth: async () => childBirth,
        resolveOpenCodeV2ExecutionDelivery: async () => ({ runtimeMode: sourceNative.runtimeMode, entrySha256: sourceNative.entrySha256 }),
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
        expect([...timers.values()].map(timer => timer.at)).toEqual([base + (openCodeV2RunInitializationMs(platform))])
        if (mode === 'transport-error') {
          // An unhandled transport 'error' must not become an uncaught emitter
          // throw: the entry reports its controlled failure and closes once.
          events.emit('message', { type: 'prepare', nonce, leaseOwnerId }); await settle()
          expect(() => events.emit('error', new Error('TEST-transport-drop'))).not.toThrow()
          await settle()
          expect(inspect()).toMatchObject({ closing: true, runtimeReady: false })
          expect(reports).toHaveLength(1)
          expect(reports[0]).toMatchObject({ reason: 'failed', stage: 'waiting-for-prepare', errorName: 'Error' })
          expect(sent.some(value => value.type === 'ready' || value.type === 'graph-ready')).toBe(false)
          expect(sent.some(value => value.type === 'closed')).toBe(true)
          expect(exits).toEqual([0])
          return
        }
        events.emit('message', { type: 'prepare', nonce, leaseOwnerId }); await settle()
        now = base + 20_000
        events.emit('message', { type: 'start', nonce, leaseOwnerId, namespace: prepared.namespace, password: 'A'.repeat(43), native: sourceNative, profile,
          ...(mode === 'owner-deadline-posix' ? { activationDeadline: originalDeadline } : {}) })
        await settle()
        expect(inspect().startupStage).toBe('graph-validation')
        if (mode === 'owner-deadline-posix') {
          // The local platform watchdog is replaced by the owner's absolute
          // initialization deadline, not merely pushed behind it.
          expect([...timers.values()].map(timer => timer.at)).toEqual([originalDeadline])
          await advance(base + 60_001)
          expect(inspect().closing).toBe(false)
          expect(reports).toEqual([])
          await advance(originalDeadline)
        } else await advance(base + (openCodeV2RunInitializationMs(platform)))
        await settle()
        expect(inspect()).toMatchObject({ closing: true, runtimeReady: false })
        expect(sent.some(value => value.type === 'ready')).toBe(false)
        expect(exits).toEqual([0])
        expect(reports).toHaveLength(1)
        if (mode === 'owner-deadline-posix') expect(reports[0]).toMatchObject({ reason: 'timeout', stage: 'graph-validation', elapsedMs: originalDeadline - base })
        if (mode !== 'owner-deadline-posix') expect(reports[0]).toMatchObject({ reason: 'timeout', stage: 'graph-validation', elapsedMs: openCodeV2RunInitializationMs(platform) })
      } finally { clock.mockRestore() }
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
  // A cold Windows runner can hold freshly delivered bytes under a transient AV
  // scan: the held MAIN exits 1 with an access-denied stderr class before its
  // module load completes. Only that closed class may retry a full acquisition;
  // a persistent startup failure must surface unchanged after one attempt.
  // The owner fence is a real interprocess directory that outlives its writer.
  // A transient attempt may only be retried when it retired its unbound spawn
  // to a proved-empty scope and freed that fence; a retained fence makes the
  // retry die on owner_directory_create and masks the original failure.
  // The unbound proof races the launch-owned native retirement, whose own
  // kill-and-empty wait may legally run 12s on a cold AV-torn runner. A proof
  // bound shorter than that work abandons a claim still in flight, retains the
  // fence, and converts the transient class into a misleading owner refusal.
})
