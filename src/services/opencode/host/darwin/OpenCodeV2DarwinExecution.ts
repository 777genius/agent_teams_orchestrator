import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { fstatSync } from 'node:fs'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { resolveOpenCodeV2ExecutionDelivery } from '../OpenCodeV2ExecutionDelivery.js'
import type { ExecutionBirth } from '../OpenCodeV2ExecutionBinding.js'
import { DARWIN_SCOPE_POLICY } from './OpenCodeV2DarwinPolicy.js'
import { qualifyDarwin } from './OpenCodeV2DarwinQualification.js'

function assert(value: unknown, code = 'execution_containment_unavailable'): asserts value {
  if (!value) throw new Error(code)
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const hash = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
function row(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'execution_invalid_response')
  return value as Record<string, unknown>
}
export type DarwinProcessIdentity = Readonly<{
  hostPID: number; nativePID: number; birth: ExecutionBirth; executablePath: string; executableSha256: string
  coalition: Readonly<{ resource: string; jetsam: string }>
}>
export type DarwinExecutionMapping = Readonly<{
  bun: DarwinProcessIdentity; supervisor: DarwinProcessIdentity; leaseOwnerId: string
  scopeName: string; namespace: Readonly<{ name: string }>; coalition: DarwinProcessIdentity['coalition']
}>
export type DarwinKernelRetirement = Readonly<{
  pid: number; birth: ExecutionBirth; scopeClosed: boolean; mapping: DarwinExecutionMapping
  tasksStarted: string; tasksExited: string
}>
export type DarwinLaunchPlan = Readonly<{
  helper: string; helperSha256: string; app: string; cwd: string; entry: string; profile: string
  env: Readonly<Record<string, string>>; serialization: 'json'
}>
const mappings = new WeakSet<DarwinExecutionMapping>()
const retirements = new WeakSet<DarwinKernelRetirement>()
const plans = new WeakSet<DarwinLaunchPlan>()
const binaries = new WeakMap<DarwinLaunchPlan, Readonly<{ path: string; sha256: string }>>()
const qualifications = new Map<string, ReturnType<typeof qualifyDarwin>>()
export function isDarwinExecutionMapping(value: unknown): value is DarwinExecutionMapping {
  return value !== null && typeof value === 'object' && mappings.has(value as DarwinExecutionMapping)
}
export function isDarwinKernelRetirement(value: unknown): value is DarwinKernelRetirement {
  return value !== null && typeof value === 'object' && retirements.has(value as DarwinKernelRetirement)
}
async function helper(): Promise<Readonly<{ path: string; sha256: string; app: string; nativeRoot: string }>> {
  assert(process.platform === 'darwin', 'execution_containment_platform_pending')
  const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'execution')
  const nativeRoot = path.join(delivery.root, 'native', `darwin-${process.arch}`)
  const appPath = path.join(nativeRoot, 'OpenCodeV2Scope.app')
  const helperPath = path.join(appPath, 'Contents/MacOS/opencode-v2-darwin-scope')
  const manifest = row(JSON.parse(await readFile(path.join(nativeRoot, 'darwin-helper.json'), 'utf8')))
  assert(manifest.format === 1 && typeof manifest.sha256 === 'string' && /^[a-f0-9]{64}$/.test(manifest.sha256),
    'execution_containment_helper_qualification_pending')
  const stat = await lstat(helperPath)
  assert(stat.isFile() && (stat.mode & 0o6022) === 0 && await realpath(helperPath) === helperPath &&
    await hash(helperPath) === manifest.sha256, 'execution_containment_helper_identity')
  return Object.freeze({ path: helperPath, sha256: manifest.sha256, app: appPath, nativeRoot })
}
async function nativeQuery(args: readonly string[]): Promise<unknown> {
  const binary = await helper()
  return new Promise((resolve, reject) => {
    // execFile owns this exact query child. A bounded output or time failure
    // retires it and remains uncertainty, never evidence of process absence.
    execFile(binary.path, [...args], { env: {}, encoding: 'utf8', timeout: 1500,
      killSignal: 'SIGKILL', maxBuffer: 1048576 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`execution_identity_mismatch: ${stderr.slice(-1024)}`, { cause: error })); return }
      try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) }
    })
  })
}
function birth(value: unknown): ExecutionBirth {
  const v = row(value)
  assert(v.format === 'darwin-pidversion' && typeof v.value === 'string' && /^\d+:[1-9]\d*$/.test(v.value) &&
    typeof v.bootId === 'string' && /^[a-f0-9-]{36}$/.test(v.bootId), 'execution_identity_mismatch')
  return Object.freeze(v) as ExecutionBirth
}
export async function darwinBirth(pid: number): Promise<ExecutionBirth | null> {
  assert(Number.isSafeInteger(pid) && pid > 0)
  // Native helper returns an identity only after a uniqueID/version recheck.
  // All query failures remain uncertainty; absence is never inferred from EACCES.
  const value = row(await nativeQuery(['--identity', String(pid)]))
  if (value.absent === true) return null
  assert(value.hostPID === pid)
  return birth(value.birth)
}
async function identity(value: unknown): Promise<DarwinProcessIdentity> {
  const v = row(value), scope = row(v.coalition)
  assert(Number.isSafeInteger(v.hostPID) && Number(v.hostPID) > 0 && v.nativePID === v.hostPID &&
    typeof v.executablePath === 'string' && path.isAbsolute(v.executablePath) &&
    typeof scope.resource === 'string' && /^[1-9]\d*$/.test(scope.resource) &&
    typeof scope.jetsam === 'string' && /^[1-9]\d*$/.test(scope.jetsam), 'execution_identity_mismatch')
  const executablePath = await realpath(v.executablePath)
  return Object.freeze({ hostPID: Number(v.hostPID), nativePID: Number(v.nativePID), birth: birth(v.birth),
    executablePath, executableSha256: await hash(executablePath),
    coalition: Object.freeze({ resource: scope.resource, jetsam: scope.jetsam }) })
}
const quote = (text: string) => JSON.stringify(text)
export async function planDarwinExecution(requested: Readonly<{
  bun: Readonly<{ path: string; sha256: string }>; entry: string; cwd: string
  writableRoots: readonly string[]; readOnlyRoots: readonly string[]; protectedRoots?: readonly string[]
  readOnlyMounts?: readonly Readonly<{ source: string; target: string }>[]; env: Readonly<Record<string, string>>
}>): Promise<DarwinLaunchPlan> {
  const input = structuredClone(requested), binary = await helper()
  assert(process.versions.bun === '1.3.11', 'execution_containment_runtime_pending')
  assert(await realpath(input.bun.path) === input.bun.path && await hash(input.bun.path) === input.bun.sha256,
    'execution_identity_mismatch')
  for (const mount of input.readOnlyMounts ?? []) {
    assert(path.isAbsolute(mount.target) && mount.target !== '/' && await realpath(mount.target) === mount.source,
      'execution_containment_path_alias_pending')
  }
  const roots = [...new Set([...input.writableRoots, ...input.readOnlyRoots])]
  for (const root of roots) assert(path.isAbsolute(root) && root !== '/' && await realpath(root) === root)
  // Owner fences are acquired after planning. Validate absent protected paths
  // against their existing canonical ancestor without creating ownership state.
  for (const root of input.protectedRoots ?? []) {
    assert(path.isAbsolute(root) && root !== '/' && path.normalize(root) === root)
    for (let existing = root;; existing = path.dirname(existing)) {
      try {
        const stat = await lstat(existing)
        assert(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(existing) === existing)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existing === path.dirname(existing)) throw error
      }
    }
  }
  for (const key of Object.keys(input.env)) assert(!key.startsWith('DYLD_') && !['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE'].includes(key))
  // Bun resolves package metadata through ancestor directories when initializing
  // lazy IPC. Grant directory data only at exact ancestors, never their children.
  const ancestorDirectories = new Set<string>()
  for (const root of [...input.readOnlyRoots, ...input.writableRoots, input.cwd, input.bun.path, input.entry]) {
    for (let parent = path.dirname(root);; parent = path.dirname(parent)) {
      ancestorDirectories.add(parent)
      if (parent === path.dirname(parent)) break
    }
  }
  // Keep process creation available. External delegation and cross-sandbox
  // signals cannot confer authority outside the immutable kernel scope.
  const profile = ['(version 1)', '(deny default)', '(import "system.sb")', '(allow file-read-metadata)',
    ...[...ancestorDirectories].map(root => `(allow file-read-data (require-all (literal ${quote(root)}) (vnode-type DIRECTORY)))`),
    '(allow sysctl-read)', DARWIN_SCOPE_POLICY,
    '(allow process-exec)', '(allow signal (target same-sandbox))',
    '(allow network-outbound)', '(allow network-inbound)', '(allow network-bind)',
    '(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library/Apple"))',
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom"))',
    ...[...new Set(input.readOnlyRoots)].map(root => `(allow file-read* (subpath ${quote(root)}))`),
    ...(input.readOnlyMounts ?? []).flatMap(mount => [`(allow file-read* (subpath ${quote(mount.source)}))`, `(allow file-read* (subpath ${quote(mount.target)}))`]),
    ...input.writableRoots.map(root => `(allow file-read* file-write* (subpath ${quote(root)}))`),
    ...(input.protectedRoots ?? []).map(root => `(deny file-read* file-write* (subpath ${quote(root)}))`),
    `(deny file-read* file-write* (subpath ${quote(binary.nativeRoot)}))`,
  ].join('\n')
  // Qualification is specific to the running kernel, helper and dynamic policy.
  // Native startup independently verifies its actual coalition authority.
  const platform = row(await nativeQuery(['--platform']))
  const probeSha256 = await hash(path.join(binary.nativeRoot, 'opencode-v2-darwin-qualification-probe'))
  const policySha256 = createHash('sha256').update(DARWIN_SCOPE_POLICY).digest('hex')
  const qualificationKey = JSON.stringify([binary.nativeRoot, binary.sha256, probeSha256,
    platform.osBuild, platform.kernelRelease, policySha256])
  let work = qualifications.get(qualificationKey)
  if (!work) {
    work = qualifyDarwin(binary.nativeRoot)
    qualifications.set(qualificationKey, work)
    void work.catch(() => { if (qualifications.get(qualificationKey) === work) qualifications.delete(qualificationKey) })
  }
  const qualification = row(await work)
  const probes = row(qualification.probes)
  assert(qualification.format === 1 && qualification.helperSha256 === binary.sha256 && qualification.probeSha256 === probeSha256 &&
    typeof platform.osBuild === 'string' && typeof platform.kernelRelease === 'string' &&
    qualification.osBuild === platform.osBuild && qualification.kernelRelease === platform.kernelRelease &&
    qualification.policySha256 === policySha256 &&
    row(probes.dynamicCallerEntitlementFork).passed === true && row(probes.normalSpawn).passed === true &&
    row(probes.externalDelegation).passed === true,
  'execution_containment_helper_qualification_pending')
  const plan = Object.freeze({ helper: binary.path, helperSha256: binary.sha256, app: binary.app, cwd: input.cwd,
    entry: input.entry, env: Object.freeze(input.env), profile, serialization: 'json' as const })
  plans.add(plan); binaries.set(plan, Object.freeze(input.bun)); return plan
}
export function isDarwinClosedAcknowledgment(value: unknown, nonce: string, mapping: DarwinExecutionMapping): boolean {
  try { const v = row(value); return v.type === 'closed' && v.scopeClosed === true && v.nonce === nonce && v.leaseOwnerId === mapping.leaseOwnerId &&
    v.pid === mapping.bun.nativePID && equal(v.birth, mapping.bun.birth) && v.namespace === mapping.scopeName } catch { return false }
}
export function launchDarwinExecution(plan: DarwinLaunchPlan, nonce: string, leaseOwnerId: string, bun: Readonly<{ path: string; sha256: string }>) {
  assert(plans.has(plan) && equal(binaries.get(plan), bun) && /^[a-f0-9-]{36}$/.test(nonce) && /^[a-f0-9-]{36}$/.test(leaseOwnerId))
  const child = new EventEmitter() as EventEmitter & { pid?: number }
  let helperChild: ReturnType<typeof spawn> | undefined, mapping: DarwinExecutionMapping | undefined
  let stopped = false, ended = false, bunExited = false, closed = false, started = false, stdout = '', stderr = '', sequence = 0
  let resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  let resolveMapping!: (value: Record<string, unknown>) => void, rejectMapping!: (error: Error) => void
  const observed = new Promise<Record<string, unknown>>((resolve, reject) => { resolveMapping = resolve; rejectMapping = reject })
  void observed.catch(() => undefined)
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let socketRoot: string
  function write(value: unknown): void {
    assert(helperChild?.stdin?.writable && !ended, 'cleanup_unknown')
    const bytes = JSON.stringify(value) + '\n'
    assert(Buffer.byteLength(bytes) <= 16 * 1048576, 'execution_invalid_response')
    helperChild.stdin.write(bytes)
  }
  async function rpc(kind: string, values: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++sequence
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); try { write({ kind, id, ...values }) } catch (error) { pending.delete(id); reject(error) } })
  }
  const boot = (async () => {
    assert(await hash(plan.helper) === plan.helperSha256, 'execution_containment_helper_identity')
    // Darwin's Unix socket path is limited to 104 bytes. Project paths can
    // exceed that alone, so acquire a short, private per-launch directory.
    socketRoot = await mkdtemp(`/private/tmp/opencode-v2-${nonce.slice(0, 8)}-`)
    helperChild = spawn(plan.helper, ['--broker', plan.app, path.join(socketRoot, 'ipc'), nonce], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
    child.pid = helperChild.pid
    let buffer = ''
    helperChild.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16384) })
    helperChild.once('error', error => { rejectMapping(error); child.emit('error', error) })
    helperChild.once('close', code => {
      ended = true; resolveExit(); rejectMapping(new Error('execution_containment_launcher_denied'))
      for (const request of pending.values()) request.reject(new Error('cleanup_unknown'))
      pending.clear(); child.emit('close', code)
    })
    helperChild.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      if (buffer.length > 1048576) { rejectMapping(new Error('execution_invalid_response')); helperChild?.stdin?.end(); return }
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), text = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        try {
          const v = row(JSON.parse(text))
          if (v.kind === 'mapping') resolveMapping(v)
          else if (v.kind === 'reply') {
            const request = pending.get(Number(v.id)); pending.delete(Number(v.id))
            if (request) v.error === null ? request.resolve(v.value) : request.reject(new Error(String(v.error)))
          } else if (v.kind === 'exit') {
            bunExited = true; resolveExit(); child.emit('close', v.code)
          } else if (v.kind === 'ipc') {
            if (mapping && isDarwinClosedAcknowledgment(v.value, nonce, mapping)) closed = true
            child.emit('message', v.value)
          } else if ((v.kind === 'stdout' || v.kind === 'stderr') && typeof v.data === 'string') {
            const text = Buffer.from(v.data, 'base64').toString()
            if (v.kind === 'stdout') stdout = (stdout + text).slice(-16384); else stderr = (stderr + text).slice(-16384)
          }
        } catch { rejectMapping(new Error('execution_invalid_response')) }
      }
    })
    write({ bun: bun.path, entry: plan.entry, cwd: plan.cwd, env: plan.env, profile: plan.profile })
  })()
  void boot.catch(error => { rejectMapping(error); child.emit('error', error) })
  async function bounded<T>(work: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
    assert(Number.isFinite(deadline) && Date.now() < deadline, 'execution_timeout'); signal?.throwIfAborted()
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
    try { return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('execution_timeout')), Math.max(1, deadline - Date.now()))
      abort = () => reject(new Error('execution_cancelled')); signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })]) } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
  }
  let preparation: Promise<DarwinExecutionMapping> | undefined, retirement: Promise<DarwinKernelRetirement> | undefined
  async function assertLive(): Promise<void> {
    assert(mapping && !ended && !stopped)
    const actual = await identity(await rpc('identity', { pid: mapping.bun.hostPID }))
    assert(equal(actual, mapping.bun), 'execution_identity_mismatch')
  }
  async function prepare(deadline: number, signal?: AbortSignal): Promise<DarwinExecutionMapping> {
    return preparation ??= bounded((async () => {
      await boot; const event = await observed
      const supervisor = await identity(event.supervisor), actual = await identity(event.bun)
      assert(supervisor.executablePath === plan.helper && supervisor.executableSha256 === plan.helperSha256 &&
        actual.executablePath === bun.path && actual.executableSha256 === bun.sha256 && equal(actual.coalition, supervisor.coalition))
      const scopeName = `darwin-coalition:${actual.coalition.resource}:${actual.coalition.jetsam}`
      const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
        const listener = (value: unknown) => { try { const v = row(value); if (v.type === 'prepared' && v.nonce === nonce && v.leaseOwnerId === leaseOwnerId) { child.removeListener('message', listener); resolve(v) } } catch (error) { reject(error) } }
        child.on('message', listener)
      })
      write({ kind: 'send', value: { type: 'prepare', nonce, leaseOwnerId, namespace: scopeName } })
      const response = await ready
      assert(response.pid === actual.nativePID && equal(response.birth, actual.birth) && response.namespace === scopeName &&
        response.executableSha256 === actual.executableSha256 && response.fd === 3 && response.serialization === 'json')
      signal?.throwIfAborted(); assert(!ended && !stopped && Date.now() < deadline)
      mapping = Object.freeze({ bun: actual, supervisor, leaseOwnerId, scopeName, namespace: Object.freeze({ name: scopeName }), coalition: actual.coalition })
      mappings.add(mapping); await assertLive(); return mapping
    })(), deadline, signal)
  }
  async function retire(): Promise<DarwinKernelRetirement> {
    return retirement ??= (async () => {
      stopped = true; await boot
      const receipt = row(await bounded(rpc('retire'), Date.now() + 12000))
      assert(mapping && receipt.empty === true && typeof receipt.tasksStarted === 'string' && /^\d+$/.test(receipt.tasksStarted) &&
        receipt.tasksStarted === receipt.tasksExited, 'cleanup_unknown')
      await bounded(exit, Date.now() + 3000)
      const result = Object.freeze({ pid: mapping.bun.hostPID, birth: mapping.bun.birth, mapping, scopeClosed: closed,
        tasksStarted: receipt.tasksStarted, tasksExited: receipt.tasksExited as string })
      retirements.add(result); await rm(socketRoot, { recursive: true, force: true }); return result
    })()
  }
  return Object.freeze({ child, exit, prepare, retire, assertLive, exited: () => bunExited || ended, acknowledged: () => closed,
    output: () => ({ stdout, stderr }),
    sendClose: () => { stopped = true; assert(mapping); write({ kind: 'send', value: { type: 'close', nonce, leaseOwnerId } }) },
    async kill(): Promise<void> { await retire() },
    async start(payload: Readonly<Record<string, unknown>>, deadline: number, signal?: AbortSignal): Promise<void> {
      assert(mapping && !started && !stopped); await bounded(assertLive(), deadline, signal)
      signal?.throwIfAborted(); assert(Date.now() < deadline && !ended && !stopped); started = true
      write({ kind: 'send', value: { ...payload, type: 'start', nonce, leaseOwnerId, namespace: mapping.scopeName } })
    },
  })
}
/** Self observation needs no observer executable, including inside Seatbelt's
 * protected native-root denial. It grants no mapping or retirement authority. */
async function readDarwinSelfIdentity(): Promise<Readonly<{ birth: ExecutionBirth; namespace: string }>> {
  assert(process.platform === 'darwin' && process.versions.bun === '1.3.11', 'execution_containment_runtime_pending')
  const { dlopen, FFIType, ptr } = await import('bun:ffi')
  const native = dlopen('/usr/lib/libSystem.B.dylib', {
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  })
  let ownBirth: ExecutionBirth, namespace: string
  try {
    // Match the native observer's Unique ABI: UUID, two uint64 identities,
    // two int32 versions and two reserved uint64 fields (56 bytes).
    const unique = Buffer.alloc(56), again = Buffer.alloc(56), scope = Buffer.alloc(40), boot = Buffer.alloc(128), length = Buffer.alloc(8)
    length.writeBigUInt64LE(128n)
    assert(native.symbols.proc_pidinfo(process.pid, 17, 0, ptr(unique), unique.length) === unique.length &&
      native.symbols.proc_pidinfo(process.pid, 20, 0, ptr(scope), scope.length) === scope.length &&
      native.symbols.proc_pidinfo(process.pid, 17, 0, ptr(again), again.length) === again.length && unique.equals(again) &&
      native.symbols.sysctlbyname(ptr(Buffer.from('kern.bootsessionuuid\0')), ptr(boot), ptr(length), null, 0) === 0)
    ownBirth = birth({ format: 'darwin-pidversion', value: `${unique.readBigUInt64LE(16)}:${unique.readInt32LE(32)}`,
      bootId: boot.toString('utf8').split('\0')[0]?.toLowerCase() })
    namespace = `darwin-coalition:${scope.readBigUInt64LE(0)}:${scope.readBigUInt64LE(8)}`
  } finally { native.close() }
  return Object.freeze({ birth: ownBirth, namespace })
}
export async function darwinSelfBirth(): Promise<ExecutionBirth> {
  return (await readDarwinSelfIdentity()).birth
}
export async function inspectDarwinExecutionChild(value: unknown) {
  const v = row(value)
  assert(v.type === 'prepare' && typeof v.nonce === 'string' && /^[a-f0-9-]{36}$/.test(v.nonce) &&
    typeof v.leaseOwnerId === 'string' && /^[a-f0-9-]{36}$/.test(v.leaseOwnerId) &&
    process.versions.bun === '1.3.11' && typeof process.send === 'function' && process.connected && fstatSync(3).isSocket())
  const { birth: ownBirth, namespace } = await readDarwinSelfIdentity()
  assert(v.namespace === namespace)
  return Object.freeze({ type: 'prepared', nonce: v.nonce, leaseOwnerId: v.leaseOwnerId, pid: process.pid,
    birth: ownBirth, namespace, executableSha256: await hash(process.execPath), fd: 3, serialization: 'json' })
}
export async function prepareDarwinExecutionChild(value: unknown) {
  const response = await inspectDarwinExecutionChild(value)
  await new Promise<void>((resolve, reject) => process.send!(response, error => error ? reject(error) : resolve()))
  return response
}
