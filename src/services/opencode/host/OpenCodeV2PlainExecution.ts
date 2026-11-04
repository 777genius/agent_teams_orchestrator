import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { killProcessTreeAndWait, readProcessStartTimeMs } from '../../../utils/processKill.js'
import { windowsNativeProcess } from '../../../utils/windowsNativeProcess.js'
import { executionAssert, executionHash, executionRecord, type ExecutionBirth } from '../execution/OpenCodeV2ExecutionContracts.js'

// V2 execution runs the shipped Bun as an ordinary child process, like the V1 host:
// no OS sandbox. The owner keeps the exact child identity (PID and start time), the
// private IPC handshake and the closed acknowledgement, and checks the launched image
// itself where the OS exposes it (Linux /proc, darwin proc_pidpath). Retirement claims
// only what it checked: on POSIX the child's whole process group is gone; on Windows the
// child exited and every descendant seen before close was killed, which stays best-effort.

export type PlainExecutionMapping = Readonly<{
  bun: Readonly<{ hostPID: number; nativePID: number; birth: ExecutionBirth; executablePath: string; executableSha256: string }>
  namespace: Readonly<{ name: string }>; leaseOwnerId: string
}>
/** `process-group`: the group was checked empty. `best-effort`: a tree kill ran, but a descendant that
 * left the tree is not tracked. `unknown`: members of the group were still present at the deadline. */
export type PlainExecutionDescendants = 'process-group' | 'best-effort' | 'unknown'
export type PlainExecutionRetirement = Readonly<{
  pid: number; birth: ExecutionBirth; scopeClosed: boolean; descendants: PlainExecutionDescendants; acknowledged: boolean
}>
export type PlainExecutionPlan = Readonly<{
  bun: Readonly<{ path: string; sha256: string }>; entry: string; cwd: string; env: Readonly<Record<string, string>>
}>

const PLAIN_NAMESPACE = 'process'
const plans = new WeakSet<PlainExecutionPlan>()
const mappings = new WeakSet<PlainExecutionMapping>()
const retirements = new WeakSet<PlainExecutionRetirement>()
const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
const same = (left: unknown, right: unknown) => executionHash(left) === executionHash(right)

/** Process start identity: PID reuse cannot alias a retired child. */
export async function readPlainExecutionBirth(pid: number): Promise<ExecutionBirth | null> {
  executionAssert(Number.isSafeInteger(pid) && pid > 0, 'execution_identity_mismatch')
  const started = await readProcessStartTimeMs(pid)
  if (started === null) return null
  if (process.platform === 'linux') {
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    return Object.freeze({ format: 'linux-start-ticks', value: String(started), bootId })
  }
  return Object.freeze({ format: 'utc-ms', value: String(started), bootId: null })
}

export function isPlainExecutionMapping(value: unknown): value is PlainExecutionMapping {
  return value !== null && typeof value === 'object' && mappings.has(value as PlainExecutionMapping)
}
export function isPlainExecutionRetirement(value: unknown): value is PlainExecutionRetirement {
  return value !== null && typeof value === 'object' && retirements.has(value as PlainExecutionRetirement)
}

export async function planPlainExecution(requested: Readonly<{
  bun: Readonly<{ path: string; sha256: string }>; entry: string; cwd: string; env: Readonly<Record<string, string>>
}>): Promise<PlainExecutionPlan> {
  const input = structuredClone(requested)
  executionAssert(await realpath(input.bun.path) === input.bun.path && await sha(input.bun.path) === input.bun.sha256,
    'execution_identity_mismatch')
  for (const [key, value] of Object.entries(input.env)) {
    executionAssert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !value.includes('\0') &&
      !/^(?:NODE_.*|BUN_.*|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELLOPTS|ZDOTDIR)$/i.test(key), 'execution_environment_injection')
  }
  const plan = Object.freeze({ bun: Object.freeze({ ...input.bun }), entry: input.entry, cwd: input.cwd,
    env: Object.freeze({ ...input.env }) })
  plans.add(plan)
  return plan
}

/** POSIX: the child leads its own process group, so the group signal reaches every
 * command it started and never a reused single PID. */
function killGroup(pgid: number): void {
  try { process.kill(-pgid, 'SIGKILL') } catch { /* Group already gone. */ }
}
/** Linux: a killed member stays visible until its parent reaps it. A container whose
 * PID 1 never reaps would keep the group occupied forever, so zombies count as gone. */
async function linuxGroupHasLiveMember(pgid: number): Promise<boolean> {
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => null)
    if (stat === null) continue
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') return true
  }
  return false
}
/** POSIX only: true once no live process is left in the group. */
export async function processGroupEmpty(pgid: number, deadline: number): Promise<boolean> {
  for (;;) {
    try { process.kill(-pgid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true }
    if (process.platform === 'linux' && !await linuxGroupHasLiveMember(pgid)) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
type WindowsDescendant = Readonly<{ pid: number; birth: number }>
/** Windows: descendants of the child with their creation time, read while the child is alive.
 * taskkill /T walks parent links, which a descendant of an exited child no longer has. */
async function windowsDescendants(root: number): Promise<WindowsDescendant[]> {
  const native = await windowsNativeProcess()
  if (!native) return []
  const rows = native.table(), found: WindowsDescendant[] = [], parents = new Set([root])
  for (let grew = true; grew;) {
    grew = false
    for (const row of rows) {
      if (!parents.has(row.ppid) || parents.has(row.pid) || row.pid === row.ppid) continue
      parents.add(row.pid); grew = true
      const birth = native.birth(row.pid)
      if (birth !== null) found.push({ pid: row.pid, birth })
    }
  }
  return found
}
/** The launched image as the host reads it, not as the child reports it. */
async function launchedImageSha256(pid: number): Promise<string | null> {
  if (process.platform === 'linux') return sha(`/proc/${pid}/exe`)
  if (process.platform !== 'darwin') return null
  const { dlopen, FFIType, ptr } = await import('bun:ffi')
  const native = dlopen('/usr/lib/libSystem.B.dylib', { proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } })
  try {
    const buffer = Buffer.alloc(4096)
    const length = native.symbols.proc_pidpath(pid, ptr(buffer), buffer.length)
    return length > 0 ? sha(buffer.toString('utf8', 0, length)) : null
  } finally { native.close() }
}

export function launchPlainExecution(plan: PlainExecutionPlan, nonce: string, leaseOwnerId: string,
  bun: Readonly<{ path: string; sha256: string }>) {
  executionAssert(plans.has(plan) && same(plan.bun, bun), 'execution_identity_mismatch')
  // Its own process group lets cleanup reach the commands it starts. Losing the
  // parent closes the IPC channel, and the child closes itself on disconnect.
  const child = spawn(plan.bun.path, ['--no-install', plan.entry], { cwd: plan.cwd, env: { ...plan.env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json', detached: process.platform !== 'win32', windowsHide: true })
  let ended = false, closed = false, stopping = false, startSent = false
  let snapshot: Promise<WindowsDescendant[]> = Promise.resolve([])
  // Take the Windows tree while the child still parents it; the child exits right after its close ACK.
  const recordDescendants = () => {
    if (process.platform !== 'win32' || !child.pid || ended) return
    const previous = snapshot, pid = child.pid
    snapshot = Promise.all([previous, windowsDescendants(pid).catch(() => [])]).then(([left, right]) =>
      [...new Map([...left, ...right].map(row => [`${row.pid}:${row.birth}`, row])).values()])
  }
  if (process.platform === 'win32') void windowsNativeProcess()
  let mapping: PlainExecutionMapping | undefined
  let prepareWork: Promise<PlainExecutionMapping> | undefined, retireWork: Promise<PlainExecutionRetirement> | undefined
  let stdout = '', stderr = ''
  child.stdout?.on('data', (bytes: Buffer) => { stdout = (stdout + bytes.toString()).slice(-16384) })
  child.stderr?.on('data', (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-16384) })
  let resolveExit: () => void = () => undefined
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  child.once('exit', () => { ended = true; resolveExit() })
  let preparedResolve: (value: Record<string, unknown>) => void = () => undefined
  let preparedReject: (error: Error) => void = () => undefined
  const prepared = new Promise<Record<string, unknown>>((resolve, reject) => { preparedResolve = resolve; preparedReject = reject })
  void prepared.catch(() => undefined)
  child.once('error', () => preparedReject(new Error('execution_spawn_failed')))
  child.once('exit', () => preparedReject(new Error('execution_child_exited')))
  child.on('message', value => {
    try {
      const message = executionRecord(value)
      if (message.type === 'prepared' && message.nonce === nonce && message.leaseOwnerId === leaseOwnerId) preparedResolve(message)
      if (mapping && message.type === 'closed' && message.nonce === nonce && message.leaseOwnerId === leaseOwnerId &&
        message.pid === mapping.bun.nativePID && same(message.birth, mapping.bun.birth) && message.scopeClosed === true) closed = true
    } catch { /* Malformed messages grant no launch or retirement authority. */ }
  })
  async function prepare(deadline = Date.now() + 6000, signal?: AbortSignal): Promise<PlainExecutionMapping> {
    return prepareWork ??= (async () => {
      executionAssert(child.pid && !ended, 'execution_spawn_failed')
      const abort = () => preparedReject(new Error('execution_prepare_aborted'))
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => preparedReject(new Error('execution_prepare_timeout')), Math.max(1, deadline - Date.now()))
      let message: Record<string, unknown>
      try {
        signal?.throwIfAborted(); executionAssert(!stopping && Date.now() < deadline, 'execution_timeout')
        child.send({ type: 'prepare', nonce, leaseOwnerId })
        message = await prepared
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      signal?.throwIfAborted(); executionAssert(!stopping && !ended && Date.now() < deadline, 'execution_timeout')
      const birth = await readPlainExecutionBirth(child.pid)
      executionAssert(birth && message.pid === child.pid && same(message.birth, birth) && message.namespace === PLAIN_NAMESPACE &&
        message.executableSha256 === plan.bun.sha256, 'execution_identity_mismatch')
      const image = await launchedImageSha256(child.pid)
      executionAssert(image === null && process.platform === 'win32' || image === plan.bun.sha256, 'execution_identity_mismatch')
      mapping = Object.freeze({ bun: Object.freeze({ hostPID: child.pid, nativePID: child.pid, birth,
        executablePath: plan.bun.path, executableSha256: plan.bun.sha256 }),
      namespace: Object.freeze({ name: PLAIN_NAMESPACE }), leaseOwnerId })
      mappings.add(mapping)
      return mapping
    })()
  }
  async function retire(): Promise<PlainExecutionRetirement> {
    return retireWork ??= (async () => {
      stopping = true; preparedReject(new Error('execution_retired_before_start'))
      try { if (prepareWork) await prepareWork } catch { /* The spawned process is still retired below. */ }
      executionAssert(child.pid, 'cleanup_unknown')
      const pid = child.pid
      if (process.platform === 'win32') {
        recordDescendants()
        if (!ended) await killProcessTreeAndWait(pid, 'SIGKILL', { timeoutMs: 3000 })
      } else if (!ended) killGroup(pid)
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup_unknown')), 5000) })]) }
      finally { clearTimeout(timer) }
      let scopeClosed: boolean, descendants: PlainExecutionDescendants
      if (process.platform === 'win32') {
        // Kill every recorded descendant that still has its recorded creation time. One started
        // after the last snapshot, or outside the tree, is not seen: best-effort, not proof.
        for (const row of await snapshot) await killProcessTreeAndWait(row.pid, 'SIGKILL', { timeoutMs: 1000, expectedStartedAtMs: row.birth })
        scopeClosed = true; descendants = 'best-effort'
      } else {
        // The leader is gone; its process group may still hold commands it started.
        killGroup(pid)
        scopeClosed = await processGroupEmpty(pid, Date.now() + 2000)
        descendants = scopeClosed ? 'process-group' : 'unknown'
      }
      const birth = mapping?.bun.birth ?? Object.freeze({ format: 'utc-ms' as const, value: '0', bootId: null })
      const result = Object.freeze({ pid: child.pid, birth, scopeClosed, descendants, acknowledged: closed })
      retirements.add(result)
      return result
    })()
  }
  return Object.freeze({ child, exit, prepare, retire,
    exited: () => ended, acknowledged: () => closed, output: () => ({ stdout, stderr }),
    sendClose: () => {
      stopping = true; executionAssert(child.connected, 'cleanup_unknown')
      recordDescendants(); child.send({ type: 'close', nonce, leaseOwnerId })
    },
    async start(payload: Readonly<Record<string, unknown>>, deadline: number, signal?: AbortSignal): Promise<void> {
      executionAssert(mapping && !ended && !stopping && !startSent, 'execution_identity_mismatch')
      executionAssert(same(await readPlainExecutionBirth(mapping.bun.hostPID), mapping.bun.birth), 'execution_identity_mismatch')
      signal?.throwIfAborted(); executionAssert(!stopping && !ended && Number.isFinite(deadline) && deadline > Date.now(), 'execution_timeout')
      startSent = true
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: (() => void) | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('execution_timeout')), Math.max(1, deadline - Date.now()))
          abort = () => reject(new Error('execution_cancelled'))
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) { abort(); return }
          child.send({ ...payload, type: 'start', nonce, leaseOwnerId, namespace: PLAIN_NAMESPACE }, error => error ? reject(error) : resolve())
        })
        signal?.throwIfAborted(); executionAssert(!stopping && !ended && Date.now() < deadline, 'execution_timeout')
      } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
    },
    readBirth: () => readPlainExecutionBirth(child.pid!),
    kill(): void {
      executionAssert(child.pid, 'cleanup_unknown')
      if (process.platform !== 'win32') { killGroup(child.pid); return }
      recordDescendants(); void killProcessTreeAndWait(child.pid, 'SIGKILL', { timeoutMs: 3000 })
    },
    async assertLive(): Promise<void> {
      executionAssert(mapping && !ended, 'execution_identity_mismatch')
      executionAssert(same(await readPlainExecutionBirth(mapping.bun.hostPID), mapping.bun.birth), 'execution_identity_mismatch')
    },
  })
}

/** Child side of the handshake, before the official runtime is imported. */
export async function preparePlainExecutionChild(value: unknown) {
  const message = executionRecord(value)
  executionAssert(message.type === 'prepare' && typeof message.nonce === 'string' && /^[a-f0-9-]{36}$/.test(message.nonce) &&
    typeof message.leaseOwnerId === 'string' && /^[a-f0-9-]{36}$/.test(message.leaseOwnerId) &&
    typeof process.send === 'function' && process.connected === true, 'execution_ipc_unavailable')
  const birth = await readPlainExecutionBirth(process.pid)
  executionAssert(birth, 'execution_identity_mismatch')
  const response = Object.freeze({ type: 'prepared', nonce: message.nonce, leaseOwnerId: message.leaseOwnerId,
    pid: process.pid, birth, namespace: PLAIN_NAMESPACE, executableSha256: await sha(process.execPath) })
  await new Promise<void>((resolve, reject) => process.send!(response, error => error ? reject(error) : resolve()))
  return response
}
