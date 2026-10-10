import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, fstatSync } from 'node:fs'
import { lstat, open, readFile, readlink, readdir, realpath, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { ExecutionBirth } from './OpenCodeV2ExecutionBinding.js'

// This module deliberately has no official server, Effect or application imports.
function assert(value: unknown, code = 'execution_containment_unavailable'): asserts value {
  if (!value) throw new Error(code)
}
// pidfds avoid the read-birth/kill(PID) reuse race. These descriptors are
// CLOEXEC and held solely by the controller; none enter the executable stdio.
async function loadLinuxPidfds() {
  assert(process.platform === 'linux' && process.versions.bun === '1.3.11', 'execution_containment_pidfd_runtime_pending')
  const { dlopen, FFIType, ptr } = await import('bun:ffi')
  const library = dlopen('libc.so.6', {
    pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
    pidfd_send_signal: { args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  })
  return Object.freeze({
    open(pid: number): number { const fd = library.symbols.pidfd_open(pid, 0); assert(fd >= 0, 'execution_containment_pidfd_unavailable'); return fd },
    kill(fd: number): boolean { return library.symbols.pidfd_send_signal(fd, 9, null, 0) === 0 },
    exited(fd: number): boolean {
      assert(Number.isSafeInteger(fd) && fd >= 0, 'cleanup_unknown')
      const pollfd = Buffer.alloc(8)
      pollfd.writeInt32LE(fd, 0); pollfd.writeInt16LE(1, 4) // POLLIN, timeout zero.
      const ready = library.symbols.poll(ptr(pollfd), 1, 0)
      const events = pollfd.readInt16LE(6)
      assert(ready >= 0 && !(events & (8 | 32)), 'cleanup_unknown') // POLLERR/POLLNVAL.
      return ready === 1 && (events & 1) !== 0
    },
    close(fd: number): void { assert(library.symbols.close(fd) === 0, 'cleanup_unknown') },
  })
}
let pidfdSupport: ReturnType<typeof loadLinuxPidfds> | undefined
const linuxPidfds = () => pidfdSupport ??= loadLinuxPidfds()
/** Read-only kernel observation; this cannot mint a mapping or retirement receipt. */
export async function linuxPidfdHasExited(fd: number): Promise<boolean> {
  return (await linuxPidfds()).exited(fd)
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export async function linuxFileHash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}
function row(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'execution_invalid_response')
  return value as Record<string, unknown>
}
export async function linuxBirth(pid: number): Promise<ExecutionBirth | null> {
  assert(Number.isSafeInteger(pid) && pid > 0)
  let stat: string
  try { stat = await readFile(`/proc/${pid}/stat`, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null
    throw error // EACCES is uncertainty, never disappearance.
  }
  const ticks = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  assert(ticks && /^\d+$/.test(ticks) && /^[a-f0-9-]{36}$/.test(bootId))
  return Object.freeze({ format: 'linux-start-ticks', value: ticks, bootId })
}
export type LinuxProcessIdentity = Readonly<{
  hostPID: number; nativePID: number; parentPID: number; birth: ExecutionBirth
  namespace: string; namespacePIDs: readonly number[]; netNamespace: string; executablePath: string; executableSha256: string
}>
export type LinuxExecutionMapping = Readonly<{
  supervisor: LinuxProcessIdentity; init: LinuxProcessIdentity; bun: LinuxProcessIdentity
  namespace: Readonly<{ name: string; inode: string; device: string }>; leaseOwnerId: string
}>
const mappings = new WeakSet<LinuxExecutionMapping>()
export function isLinuxExecutionMapping(value: unknown): value is LinuxExecutionMapping {
  return value !== null && typeof value === 'object' && mappings.has(value as LinuxExecutionMapping)
}
export async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity> {
  const birth = await linuxBirth(pid); assert(birth)
  const status = await readFile(`/proc/${pid}/status`, 'utf8')
  const pids = /^NSpid:\s+([\d\s]+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number)
  const parentPID = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1])
  assert(pids?.length && pids[0] === pid && Number.isSafeInteger(parentPID))
  const namespace = await readlink(`/proc/${pid}/ns/pid`)
  const netNamespace = await readlink(`/proc/${pid}/ns/net`)
  const executablePath = await realpath(`/proc/${pid}/exe`)
  const executableSha256 = await linuxFileHash(`/proc/${pid}/exe`)
  assert(same(await linuxBirth(pid), birth))
  const nativePID = pids[pids.length - 1]; assert(typeof nativePID === 'number' && nativePID > 0)
  return Object.freeze({ hostPID: pid, nativePID, parentPID, birth, namespace, namespacePIDs: Object.freeze(pids), netNamespace, executablePath, executableSha256 })
}
async function children(pid: number): Promise<number[]> {
  // All tasks are inspected, once, while the trusted executable is paused.
  const tasks = await readdir(`/proc/${pid}/task`), result = new Set<number>()
  for (const task of tasks) {
    const text = await readFile(`/proc/${pid}/task/${task}/children`, 'utf8')
    for (const value of text.trim().split(/\s+/).filter(Boolean)) result.add(Number(value))
  }
  return [...result]
}
async function assertCapabilities(pid: number): Promise<void> {
  const text = await readFile(`/proc/${pid}/status`, 'utf8')
  for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
    assert(new RegExp(`^${name}:\\s+0+$`, 'm').test(text), 'execution_containment_capabilities')
  }
  assert(/^NoNewPrivs:\s+1$/m.test(text), 'execution_containment_no_new_privs')
}
export async function linuxLauncherVersion(launcher: string): Promise<string> {
  const child = spawn(launcher, ['--version'], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = '', errorText = ''
  child.stdout.on('data', (bytes: Buffer) => { text = (text + bytes.toString()).slice(-1024) })
  child.stderr.on('data', (bytes: Buffer) => { errorText = (errorText + bytes.toString()).slice(-1024) })
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(text.trim()) : reject(new Error(`execution_containment_launcher_version: ${errorText}`)) })
  })
}
export type LinuxLaunchPlan = Readonly<{ launcher: string; launcherSha256: string; args: readonly string[]; cwd: string; serialization: 'json' }>
const plans = new WeakSet<LinuxLaunchPlan>()
const planBinaries = new WeakMap<LinuxLaunchPlan, Readonly<{ path: string; sha256: string }>>()

/** No inherited env or authority descriptors. The IPC slot is exactly fd3.
 * bwrap's monitor/reaper FD closing does not close the executable's IPC fd. */
export async function planLinuxExecution(requested: Readonly<{
  bun: Readonly<{ path: string; sha256: string }>; entry: string; cwd: string
  writableRoots: readonly string[]; readOnlyRoots: readonly string[]; protectedRoots?: readonly string[]
  readOnlyMounts?: readonly Readonly<{ source: string; target: string }>[]
  env: Readonly<Record<string, string>>
}>): Promise<LinuxLaunchPlan> {
  const input = structuredClone(requested)
  assert(process.platform === 'linux', 'execution_containment_platform_pending')
  await linuxPidfds()
  const launcher = await realpath('/usr/bin/bwrap')
  const stat = await lstat(launcher)
  assert(stat.isFile() && (stat.mode & 0o6022) === 0, 'execution_containment_launcher_authority')
  assert(await realpath(input.bun.path) === input.bun.path && await linuxFileHash(input.bun.path) === input.bun.sha256,
    'execution_identity_mismatch')
  assert(await linuxLauncherVersion(launcher) === 'bubblewrap 0.13.0', 'execution_containment_launcher_version_pending')
  const mountinfo = await readFile('/proc/self/mountinfo', 'utf8')
  const roots = [...new Set([...input.writableRoots, ...input.readOnlyRoots,
    ...(input.readOnlyMounts ?? []).map(mount => mount.source)])]
  for (const mount of input.readOnlyMounts ?? []) {
    assert(path.isAbsolute(mount.target) && path.normalize(mount.target) === mount.target && mount.target !== '/')
    assert(!['/proc', '/sys', '/dev'].some(authority => mount.target === authority || mount.target.startsWith(authority + '/')))
  }
  for (const root of roots) {
    assert(path.isAbsolute(root) && root !== '/' && await realpath(root) === root)
    assert(!['/proc', '/sys', '/dev'].some(authority => root === authority || root.startsWith(authority + '/')))
    for (const line of mountinfo.trim().split('\n')) {
      const fields = line.split(' '), split = fields.indexOf('-')
      const mount = fields[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
      assert(!mount || !(mount === root || mount.startsWith(root + '/')) ||
        !['proc', 'sysfs', 'cgroup', 'cgroup2', 'nsfs'].includes(fields[split + 1] ?? ''), 'execution_containment_authority_mount')
    }
  }
  const args = ['--unshare-user', '--disable-userns', '--assert-userns-disabled', '--unshare-pid', '--as-pid-1',
    '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv']
  // Start with an empty root, not a recursive bind of the controller's proc/sys.
  for (const directory of ['/usr', '/bin', '/lib', '/lib64', '/etc/ssl/certs']) {
    args.push('--ro-bind-try', directory, directory)
  }
  args.push('--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf')
  const readOnly = [...new Set(input.readOnlyRoots)].map(root => ({ source: root, target: root }))
  readOnly.push(...(input.readOnlyMounts ?? []))
  readOnly.sort((a, b) => a.target.length - b.target.length)
  const identityRoots: string[] = []
  const aliases = readOnly.filter(mount => mount.source !== mount.target)
  const contains = (root: string, target: string) => root === target || target.startsWith(root + '/')
  for (const mount of readOnly) {
    if (mount.source === mount.target) {
      // A later identity mount restores canonical bytes under an alias. Keep it
      // whenever an alias overlaps its subtree, even if that alias comes later.
      const shadowed = aliases.some(alias => contains(alias.target, mount.target) || contains(mount.target, alias.target))
      if (!shadowed && identityRoots.some(root => contains(root, mount.target))) continue
      identityRoots.push(mount.target)
    }
    args.push('--ro-bind', mount.source, mount.target)
  }
  for (const root of [...new Set(input.writableRoots)].sort((a, b) => a.length - b.length)) args.push('--bind', root, root)
  for (const root of input.protectedRoots ?? []) args.push('--ro-bind', root, root)
  args.push('--proc', '/proc', '--remount-ro', '/proc', '--dev', '/dev', '--tmpfs', '/sys', '--chdir', input.cwd)
  for (const [key, value] of Object.entries(input.env)) {
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !value.includes('\0') &&
      !/^(?:NODE_.*|BUN_.*|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELLOPTS|ZDOTDIR)$/i.test(key), 'execution_environment_injection')
    args.push('--setenv', key, value)
  }
  // Matches the explicit parent spawn serialization; never guess a wrapper default.
  args.push('--setenv', 'NODE_CHANNEL_FD', '3', '--setenv', 'NODE_CHANNEL_SERIALIZATION_MODE', 'json',
    '--', input.bun.path, input.entry)
  const plan = Object.freeze({ launcher, launcherSha256: await linuxFileHash(launcher), args: Object.freeze(args), cwd: input.cwd, serialization: 'json' as const })
  plans.add(plan); planBinaries.set(plan, Object.freeze({ ...input.bun })); return plan
}

export type KernelRetirement = Readonly<{ pid: number; birth: ExecutionBirth; scopeClosed: boolean; mapping: LinuxExecutionMapping }>
const retirements = new WeakSet<KernelRetirement>()
export function isKernelRetirement(value: unknown): value is KernelRetirement {
  return value !== null && typeof value === 'object' && retirements.has(value as KernelRetirement)
}
export function linuxClosedAcknowledgment(value: unknown, nonce: string, mapping: LinuxExecutionMapping): boolean {
  try {
    const message = row(value)
    return message.type === 'closed' && message.nonce === nonce && message.leaseOwnerId === mapping.leaseOwnerId &&
      message.pid === mapping.bun.nativePID && message.namespace === mapping.namespace.name &&
      message.executableSha256 === mapping.bun.executableSha256 && same(message.birth, mapping.bun.birth) && message.scopeClosed === true
  } catch { return false }
}
export type LinuxExecutionLaunch = ReturnType<typeof launchLinuxExecution>
export function launchLinuxExecution(plan: LinuxLaunchPlan, nonce: string, leaseOwnerId: string,
  bun: Readonly<{ path: string; sha256: string }>) {
  const selectedBun = planBinaries.get(plan)
  assert(plans.has(plan) && selectedBun && same(selectedBun, bun), 'execution_containment_unqualified')
  const actualBun = selectedBun
  const child = spawn(plan.launcher, [...plan.args], { cwd: plan.cwd, env: {},
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: plan.serialization })
  let ended = false, closed = false, stopping = false, startSent = false, mapping: LinuxExecutionMapping | undefined, namespaceFD: FileHandle | undefined
  let supervisorFD: number | undefined, initFD: number | undefined
  let cleanupInit: LinuxProcessIdentity | undefined, cleanupInitWork: Promise<LinuxProcessIdentity> | undefined
  const supervisorWork = (async () => {
    assert(child.pid, 'execution_containment_spawn_failed')
    const actual = await readLinuxProcessIdentity(child.pid)
    supervisorFD = (await linuxPidfds()).open(actual.hostPID)
    assert(same(await linuxBirth(actual.hostPID), actual.birth))
    return actual
  })()
  void supervisorWork.catch(() => undefined)
  let prepareWork: Promise<LinuxExecutionMapping> | undefined, retireWork: Promise<KernelRetirement> | undefined
  let stderr = '', stdout = ''
  child.stderr?.on('data', (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-16384) })
  child.stdout?.on('data', (bytes: Buffer) => { stdout = (stdout + bytes.toString()).slice(-16384) })
  let resolveExit: () => void = () => undefined
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  child.once('close', () => { ended = true; resolveExit() })
  // Install listeners synchronously before any IPC can arrive.
  let preparedResolve: (value: Record<string, unknown>) => void = () => undefined
  let preparedReject: (error: Error) => void = () => undefined
  const prepared = new Promise<Record<string, unknown>>((resolve, reject) => { preparedResolve = resolve; preparedReject = reject })
  void prepared.catch(() => undefined)
  child.once('error', () => preparedReject(new Error('execution_containment_spawn_failed')))
  child.once('close', () => preparedReject(new Error(`execution_containment_launcher_denied: ${stderr}`)))
  child.on('message', value => {
    try {
      const message = row(value)
      if (message.type === 'prepared' && message.nonce === nonce && message.leaseOwnerId === leaseOwnerId) preparedResolve(message)
      if (mapping && linuxClosedAcknowledgment(message, nonce, mapping)) closed = true
    } catch { /* Malformed messages grant no launch or retirement authority. */ }
  })
  // Host-derived owned PID1 provenance is private cleanup authority only.
  // Acquisition does not await or accept any child challenge fields.
  async function acquireCleanupInit(deadline: number): Promise<LinuxProcessIdentity> {
    return cleanupInitWork ??= (async () => {
      assert(Number.isFinite(deadline))
      const supervisor = await supervisorWork
      assert(supervisor.executablePath === plan.launcher && supervisor.executableSha256 === plan.launcherSha256)
      const acquisitionDeadline = Math.min(deadline, Date.now() + 6000)
      while (!ended && Date.now() < acquisitionDeadline) {
        const candidates: LinuxProcessIdentity[] = [], ancestry: LinuxProcessIdentity[] = [supervisor]
        const queue = [supervisor.hostPID], seen = new Set<number>()
        try {
          while (queue.length) {
            const parent = queue.shift(); assert(typeof parent === 'number' && !seen.has(parent) && seen.size < 8); seen.add(parent)
            for (const pid of await children(parent)) {
              const actual = await readLinuxProcessIdentity(pid); assert(actual.parentPID === parent)
              if (actual.nativePID === 1 && actual.executablePath === actualBun.path && actual.executableSha256 === actualBun.sha256) candidates.push(actual)
              else { ancestry.push(actual); queue.push(pid) }
            }
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ESRCH') throw error
          candidates.length = 0 // Transient launch churn grants no authority.
        }
        if (candidates.length === 0) { await new Promise<void>(resolve => setTimeout(resolve, 10)); continue }
        assert(candidates.length === 1)
        const actual = candidates[0]; assert(actual)
        assert(actual.nativePID === 1 && actual.namespace !== supervisor.namespace &&
          actual.namespacePIDs.length === supervisor.namespacePIDs.length + 1 && actual.netNamespace === supervisor.netNamespace,
          'execution_containment_identity_mismatch')
        await assertCapabilities(actual.hostPID)
        namespaceFD = await open(`/proc/${actual.hostPID}/ns/pid`, constants.O_RDONLY)
        const ns = await namespaceFD.stat({ bigint: true })
        initFD = (await linuxPidfds()).open(actual.hostPID)
        assert(actual.namespace === `pid:[${ns.ino}]` && same(await linuxBirth(actual.hostPID), actual.birth))
        assert(await readlink(`/proc/${actual.hostPID}/ns/pid`) === actual.namespace)
        for (const parent of ancestry) {
          assert(same(await linuxBirth(parent.hostPID), parent.birth))
          const status = await readFile(`/proc/${parent.hostPID}/status`, 'utf8')
          assert(Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]) === parent.parentPID)
        }
        assert(!ended && Date.now() < acquisitionDeadline)
        cleanupInit = actual; return actual
      }
      throw new Error('execution_containment_init_unavailable')
    })()
  }
  async function prepare(deadline = Date.now() + 6000, signal?: AbortSignal): Promise<LinuxExecutionMapping> {
    return prepareWork ??= (async () => {
      assert(child.pid && !ended)
      const supervisor = await supervisorWork
      assert(supervisor.executablePath === plan.launcher && supervisor.executableSha256 === plan.launcherSha256)
      const abort = () => preparedReject(new Error('execution_containment_prepare_aborted'))
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => preparedReject(new Error('execution_containment_prepare_timeout')), Math.max(1, deadline - Date.now()))
      let message: Record<string, unknown>
      try {
        signal?.throwIfAborted(); assert(Date.now() < deadline)
        await acquireCleanupInit(deadline)
        signal?.throwIfAborted(); assert(!stopping && Date.now() < deadline)
        child.send({ type: 'prepare', nonce, leaseOwnerId })
        message = await prepared
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      signal?.throwIfAborted(); assert(Date.now() < deadline)
      const actual = cleanupInit; assert(actual)
      assert(message.pid === actual.nativePID && message.namespace === actual.namespace && same(message.birth, actual.birth) &&
        message.executableSha256 === actual.executableSha256 && message.fd === 3 && message.serialization === plan.serialization,
        'execution_containment_identity_mismatch')
      assert(namespaceFD && initFD !== undefined && cleanupInit === actual, 'cleanup_unknown')
      const ns = await namespaceFD.stat({ bigint: true })
      assert(actual.namespace === `pid:[${ns.ino}]` && same(await linuxBirth(actual.hostPID), actual.birth) &&
        same(await linuxBirth(supervisor.hostPID), supervisor.birth) && !ended)
      assert(await readlink(`/proc/${actual.hostPID}/ns/pid`) === actual.namespace &&
        await realpath(`/proc/${actual.hostPID}/exe`) === actual.executablePath &&
        await linuxFileHash(`/proc/${actual.hostPID}/exe`) === actual.executableSha256)
      await assertCapabilities(actual.hostPID)
      signal?.throwIfAborted(); assert(!stopping && Date.now() < deadline)
      mapping = Object.freeze({ supervisor, init: actual, bun: actual, leaseOwnerId,
        namespace: Object.freeze({ name: actual.namespace, inode: String(ns.ino), device: String(ns.dev) }) })
      mappings.add(mapping); return mapping
    })()
  }
  async function signalOwned(fd: number, pid: number, birth: ExecutionBirth): Promise<void> {
    const current = await linuxBirth(pid)
    if (current && same(current, birth)) {
      // The signal goes to the pinned task even if pid is reused after this check.
      const signalled = (await linuxPidfds()).kill(fd)
      assert(signalled || await linuxBirth(pid) === null, 'cleanup_unknown')
    } else assert(current === null, 'cleanup_unknown')
  }
  async function retire(): Promise<KernelRetirement> {
    return retireWork ??= (async () => {
      stopping = true; preparedReject(new Error('execution_containment_retired_before_start'))
      // Late acquisition is joined. Even failed preparation must reap the wrapper.
      try { if (prepareWork) await prepareWork; else await acquireCleanupInit(Date.now() + 1000) } catch { /* Still join captured cleanup-only boundary below. */ }
      try { if (cleanupInitWork) await cleanupInitWork } catch { /* No accepted or cleanup-only init provenance. */ }
      try {
        if (cleanupInit) { assert(initFD !== undefined, 'cleanup_unknown'); await signalOwned(initFD, cleanupInit.hostPID, cleanupInit.birth) }
        else if (child.pid && !ended) {
          // No verified init was acquired: only the exact held supervisor can be signalled.
          // Missing boundary provenance remains UNKNOWN even if its wrapper exits.
          const supervisor = await supervisorWork
          assert(supervisorFD !== undefined, 'cleanup_unknown')
          await signalOwned(supervisorFD, supervisor.hostPID, supervisor.birth)
        }
        let exitTimer: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([exit, new Promise<never>((_, reject) => { exitTimer = setTimeout(() => reject(new Error('cleanup_unknown')), 3000) })]) }
        finally { clearTimeout(exitTimer) }
        assert(mapping && namespaceFD, 'cleanup_unknown')
        assert(await linuxBirth(mapping.init.hostPID) === null && await linuxBirth(mapping.supervisor.hostPID) === null, 'cleanup_unknown')
        const ns = await namespaceFD.stat({ bigint: true })
        assert(String(ns.ino) === mapping.namespace.inode && String(ns.dev) === mapping.namespace.device, 'cleanup_unknown')
        assert(initFD !== undefined && await linuxPidfdHasExited(initFD), 'cleanup_unknown')
        // The held pidfd identifies the verified namespace PID1, not a reused PID.
        // Linux completes zap_pid_ns_processes before PID1 exit notification;
        // its reaping implies all namespace tasks are gone, including nested ones.
        // A host-wide /proc census instead requires access to unrelated users' tasks.
        // https://github.com/torvalds/linux/blob/v6.8/kernel/pid_namespace.c (zap_pid_ns_processes)
        // https://github.com/torvalds/linux/blob/v6.8/kernel/fork.c (pidfd_poll)
        const result = Object.freeze({ pid: mapping.bun.hostPID, birth: mapping.bun.birth, scopeClosed: closed, mapping })
        retirements.add(result); return result
      } finally {
        const failures: unknown[] = []
        try { await namespaceFD?.close() } catch (error) { failures.push(error) }
        const api = await linuxPidfds()
        for (const fd of [initFD, supervisorFD]) {
          try { if (fd !== undefined) api.close(fd) } catch (error) { failures.push(error) }
        }
        assert(failures.length === 0, 'cleanup_unknown')
      }
    })()
  }
  return Object.freeze({ child, exit, prepare, retire,
    exited: () => ended, acknowledged: () => closed, output: () => ({ stdout, stderr }),
    sendClose: () => { stopping = true; assert(child.connected, 'cleanup_unknown'); child.send({ type: 'close', nonce, leaseOwnerId }) },
    async start(payload: Readonly<Record<string, unknown>>, deadline: number, signal?: AbortSignal): Promise<void> {
      assert(mapping && namespaceFD && !ended && !stopping && !startSent)
      assert(same(await linuxBirth(mapping.bun.hostPID), mapping.bun.birth) &&
        await readlink(`/proc/${mapping.bun.hostPID}/ns/pid`) === mapping.namespace.name)
      await assertCapabilities(mapping.bun.hostPID)
      signal?.throwIfAborted(); assert(!stopping && !ended && Date.now() < deadline, 'execution_timeout')
      assert(Number.isFinite(deadline) && deadline > Date.now(), 'execution_timeout')
      startSent = true
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: (() => void) | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('execution_timeout')), Math.max(1, deadline - Date.now()))
          abort = () => reject(new Error('execution_cancelled'))
          signal?.addEventListener('abort', abort, { once: true })
          // Cancellation may have arrived between the pre-send check and listener installation.
          if (signal?.aborted) { abort(); return }
          child.send({ ...payload, type: 'start', nonce, leaseOwnerId,
            namespace: mapping?.namespace.name }, error => error ? reject(error) : resolve())
        })
        signal?.throwIfAborted(); assert(!stopping && !ended && Date.now() < deadline, 'execution_timeout')
      } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
    },
    async kill(): Promise<void> { assert(mapping && initFD !== undefined, 'cleanup_unknown'); await signalOwned(initFD, mapping.init.hostPID, mapping.init.birth) },
    async assertLive(): Promise<void> {
      assert(mapping && namespaceFD && !ended)
      assert(same(await linuxBirth(mapping.bun.hostPID), mapping.bun.birth) &&
        await readlink(`/proc/${mapping.bun.hostPID}/ns/pid`) === mapping.namespace.name, 'execution_containment_identity_mismatch')
      await assertCapabilities(mapping.bun.hostPID)
    },
  })
}

/** Child-side challenge response. Called before official runtime import/start. */
export async function inspectLinuxExecutionChild(value: unknown) {
  const message = row(value)
  assert(message.type === 'prepare' && typeof message.nonce === 'string' && /^[a-f0-9-]{36}$/.test(message.nonce) &&
    typeof message.leaseOwnerId === 'string' && /^[a-f0-9-]{36}$/.test(message.leaseOwnerId) &&
    process.versions.bun === '1.3.11' && typeof process.send === 'function' && process.connected === true, 'execution_containment_ipc_unavailable')
  // Bun consumes the channel environment during startup. Verify the live fd3
  // socket; the trusted parent sets JSON serialization and joins this challenge.
  let socketDescriptor = false
  try {
    const fd3 = fstatSync(3, { bigint: true })
    socketDescriptor = fd3.isSocket() && await readlink('/proc/self/fd/3') === `socket:[${fd3.ino}]`
  } catch { socketDescriptor = false }
  assert(socketDescriptor, 'execution_containment_ipc_unavailable')
  assert(process.pid === 1, 'execution_containment_namespace_init')
  await assertCapabilities(process.pid)
  const birth = await linuxBirth(process.pid); assert(birth)
  const namespace = await readlink('/proc/self/ns/pid')
  const response = Object.freeze({ type: 'prepared', nonce: message.nonce, leaseOwnerId: message.leaseOwnerId,
    pid: process.pid, birth, namespace, executableSha256: await linuxFileHash(process.execPath), fd: 3, serialization: 'json' })
  return response
}

export async function prepareLinuxExecutionChild(value: unknown) {
  const response = await inspectLinuxExecutionChild(value)
  await new Promise<void>((resolve, reject) => process.send!(response, error => error ? reject(error) : resolve()))
  return response
}
