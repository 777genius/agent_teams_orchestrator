import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ExecutionBirth } from '../OpenCodeV2ExecutionBinding.js'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact, resolveWindowsRealpathArtifact, requireWindowsRealpathArtifact, type WindowsRealpathArtifact, type WindowsNativeArtifact, type WindowsNativeBroker } from './OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem } from './OpenCodeV2WindowsOwnerFilesystem.js'
import { createWindowsExecutionHttpClient } from './OpenCodeV2WindowsHTTP.js'

function assert(value: unknown, code = 'execution_containment_unqualified'): asserts value { if (!value) throw new Error(code) }
function row(value: unknown): Record<string, unknown> { assert(value && typeof value === 'object' && !Array.isArray(value), 'execution_invalid_response'); return value as Record<string, unknown> }
const hash = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
function birth(value: unknown): ExecutionBirth {
  const record = row(value)
  assert(record.format === 'windows-filetime' && typeof record.value === 'string' && /^[1-9]\d{0,19}$/.test(record.value) && BigInt(record.value) <= 0xffffffffffffffffn && record.bootId === null, 'execution_identity_mismatch')
  return Object.freeze({ format: 'windows-filetime', value: record.value, bootId: null })
}
export type WindowsExecutionIdentity = Readonly<{ hostPID: number; nativePID: number; birth: ExecutionBirth; executablePath: string; executableSha256: string }>
export type WindowsRealpathAnchorReceipt = Readonly<{ receiptId: string; nonce: string; anchors: readonly Readonly<{ kind: 'readOnly' | 'writable'; admittedPath: string; dosPath: string; ntPath: string; volumeSerial: string; fileId: string }>[] }>
export type WindowsRealpathDllReceipt = Readonly<{ receiptId: string; nonce: string; path: string; sha256: string; volumeSerial: string; fileId: string; ownerSid: string; held: true }>
export type WindowsExecutionMapping = Readonly<{ bun: WindowsExecutionIdentity; supervisor: WindowsExecutionIdentity; namespace: Readonly<{ name: string }>; containerSid: string; leaseOwnerId: string; realpathAnchors: WindowsRealpathAnchorReceipt; realpathDll: WindowsRealpathDllReceipt }>
export type WindowsKernelRetirement = Readonly<{ pid: number; birth: ExecutionBirth; scopeClosed: boolean; mapping: WindowsExecutionMapping; activeProcesses: 0; heldProcessExited: true; ownAcesRemoved: true }>
export type WindowsLaunchPlan = Readonly<{ helper: WindowsNativeArtifact; realpathDll: WindowsRealpathArtifact; executable: string; entry: string; cwd: string; writableRoots: readonly string[]; readOnlyRoots: readonly string[]; protectedRoots: readonly string[]; profileDirectories: readonly string[]; env: Readonly<Record<string, string>> }>
const plans = new WeakSet<WindowsLaunchPlan>(), mappings = new WeakSet<WindowsExecutionMapping>(), retirements = new WeakSet<WindowsKernelRetirement>()
const brokers = new WeakMap<WindowsLaunchPlan, WindowsNativeBroker>(), binaries = new WeakMap<WindowsLaunchPlan, Readonly<{ path: string; sha256: string }>>()
export function isWindowsExecutionMapping(value: unknown): value is WindowsExecutionMapping { return !!value && typeof value === 'object' && mappings.has(value as WindowsExecutionMapping) }
export function isWindowsKernelRetirement(value: unknown): value is WindowsKernelRetirement { return !!value && typeof value === 'object' && retirements.has(value as WindowsKernelRetirement) }
async function identity(value: unknown): Promise<WindowsExecutionIdentity> {
  const record = row(value)
  assert(Number.isSafeInteger(record.hostPID) && Number(record.hostPID) > 0 && record.nativePID === record.hostPID && typeof record.executablePath === 'string' && path.isAbsolute(record.executablePath), 'execution_identity_mismatch')
  const executablePath = await realpath(record.executablePath)
  return Object.freeze({ hostPID: Number(record.hostPID), nativePID: Number(record.nativePID), birth: birth(record.birth), executablePath, executableSha256: await hash(executablePath) })
}
// Parsing is private to native launch/connected custody. It never brands a
// caller DTO or supplies an independent resolver capability.
function realpathAnchorReceipt(value: unknown, plan: WindowsLaunchPlan, nonce: string, actual: WindowsExecutionIdentity, supervisor: WindowsExecutionIdentity): WindowsRealpathAnchorReceipt {
  const input = row(value)
  assert(input.nonce === nonce && input.receiptId === `windows-anchors:${supervisor.nativePID}:${actual.nativePID}:${actual.birth.value}` && Array.isArray(input.anchors), 'execution_identity_mismatch')
  const expected = new Set([...plan.readOnlyRoots.map(root => `readOnly:${root}`), ...plan.writableRoots.map(root => `writable:${root}`)])
  assert(input.anchors.length === expected.size && input.anchors.length <= 4096, 'execution_path_alias')
  const anchors = input.anchors.map(item => {
    const anchor = row(item)
    assert((anchor.kind === 'readOnly' || anchor.kind === 'writable') && typeof anchor.admittedPath === 'string' && expected.delete(`${anchor.kind}:${anchor.admittedPath}`) && typeof anchor.dosPath === 'string' && path.win32.relative(anchor.admittedPath, anchor.dosPath) === '', 'execution_path_alias')
    assert(typeof anchor.ntPath === 'string' && anchor.ntPath.length <= 32767 && anchor.ntPath.startsWith('\\Device\\') && !anchor.ntPath.includes('\0'), 'execution_path_alias')
    assert(anchor.ntPath.slice(1).split('\\').every(segment => segment.length > 0 && segment !== '.' && segment !== '..'), 'execution_path_alias')
    assert(typeof anchor.volumeSerial === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(anchor.volumeSerial) && BigInt(anchor.volumeSerial) <= 0xffffffffffffffffn && typeof anchor.fileId === 'string' && /^[a-f0-9]{32}$/.test(anchor.fileId), 'execution_path_alias')
    assert(!plan.protectedRoots.some(root => { const relative = path.win32.relative(root, anchor.dosPath as string); return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative)) }), 'execution_path_alias')
    return Object.freeze({ kind: anchor.kind, admittedPath: anchor.admittedPath, dosPath: anchor.dosPath, ntPath: anchor.ntPath, volumeSerial: anchor.volumeSerial, fileId: anchor.fileId })
  })
  assert(expected.size === 0, 'execution_path_alias')
  return Object.freeze({ receiptId: input.receiptId as string, nonce, anchors: Object.freeze(anchors) })
}
function realpathDllReceipt(value: unknown, plan: WindowsLaunchPlan, nonce: string, actual: WindowsExecutionIdentity, supervisor: WindowsExecutionIdentity): WindowsRealpathDllReceipt {
  const input = row(value)
  requireWindowsRealpathArtifact(plan.realpathDll)
  assert(input.held === true && input.nonce === nonce && input.receiptId === `windows-dll:${supervisor.nativePID}:${actual.nativePID}:${actual.birth.value}` &&
    input.path === plan.realpathDll.path && input.sha256 === plan.realpathDll.sha256, 'execution_identity_mismatch')
  assert(typeof input.volumeSerial === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(input.volumeSerial) && BigInt(input.volumeSerial) <= 0xffffffffffffffffn &&
    typeof input.fileId === 'string' && /^[a-f0-9]{32}$/.test(input.fileId) && typeof input.ownerSid === 'string' && /^S-1-5-/.test(input.ownerSid), 'execution_identity_mismatch')
  return Object.freeze({ receiptId: String(input.receiptId), nonce, path: input.path as string, sha256: input.sha256 as string,
    volumeSerial: input.volumeSerial, fileId: input.fileId, ownerSid: input.ownerSid, held: true })
}
export async function windowsBirth(pid: number): Promise<ExecutionBirth | null> {
  assert(Number.isSafeInteger(pid) && pid > 0, 'execution_identity_mismatch')
  const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
  broker.events.on('error', () => {})
  try { const value = row(await broker.request('identity', { pid }, Date.now() + 3000)); return value.absent === true ? null : birth(value.birth) }
  finally { await broker.close() }
}
export async function planWindowsExecution(requested: Readonly<{
  bun: Readonly<{ path: string; sha256: string }>; entry: string; cwd: string; writableRoots: readonly string[]; readOnlyRoots: readonly string[]; protectedRoots?: readonly string[]; profileDirectories?: readonly string[]; readOnlyMounts?: readonly Readonly<{ source: string; target: string }>[]; env: Readonly<Record<string, string>>
}>): Promise<WindowsLaunchPlan> {
  assert(process.platform === 'win32' && process.versions.bun === '1.3.11', 'execution_containment_runtime_pending')
  const input = structuredClone(requested)
  assert(await realpath(input.bun.path) === input.bun.path && await hash(input.bun.path) === input.bun.sha256, 'execution_identity_mismatch')
  assert(input.profileDirectories && input.profileDirectories.length > 0, 'execution_profile_changed')
  assert(!input.readOnlyMounts?.length, 'execution_containment_path_alias_pending')
  for (const root of [...input.writableRoots, ...input.readOnlyRoots, ...input.profileDirectories, input.cwd]) assert(path.isAbsolute(root) && path.parse(root).root !== root && await realpath(root) === root, 'execution_path_alias')
  for (const key of Object.keys(input.env)) assert(!/^(?:NODE_CHANNEL_|OPENCODE_V2_WINDOWS_|DYLD_|LD_)/.test(key), 'execution_profile_changed')
  const helper = await resolveWindowsNativeArtifact(), realpathDll = await resolveWindowsRealpathArtifact()
  for (const root of [...input.writableRoots, ...(input.protectedRoots ?? [])]) {
    const relative = path.win32.relative(root, realpathDll.path)
    assert(relative !== '' && (relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)), 'execution_containment_dll_identity')
  }
  const plan: WindowsLaunchPlan = Object.freeze({ helper, realpathDll, executable: input.bun.path, entry: input.entry, cwd: input.cwd,
    writableRoots: Object.freeze([...new Set(input.writableRoots)]), readOnlyRoots: Object.freeze([...new Set(input.readOnlyRoots)]), protectedRoots: Object.freeze([...new Set(input.protectedRoots ?? [])]), profileDirectories: Object.freeze([...new Set(input.profileDirectories)]), env: Object.freeze(input.env) })
  const broker = createWindowsNativeBroker(helper); broker.events.on('error', () => {})
  plans.add(plan); brokers.set(plan, broker); binaries.set(plan, Object.freeze(input.bun)); return plan
}
/** Closed composition obtains native filesystem authority only from its own
 * private plan. Caller-supplied ports and scalar callbacks cannot qualify it. */
export async function closeWindowsExecutionPlan(plan: WindowsLaunchPlan): Promise<void> {
  assert(plans.has(plan)); const broker = brokers.get(plan); assert(broker, 'execution_owner_unknown'); await broker.close()
}
export function ownerFilesystemForWindowsPlan(plan: WindowsLaunchPlan) {
  assert(plans.has(plan)); const broker = brokers.get(plan); assert(broker && !broker.ended(), 'execution_owner_unknown')
  return createWindowsOwnerFilesystem(request => broker.request(request.op, request), plan.profileDirectories)
}
export function launchWindowsExecution(plan: WindowsLaunchPlan, nonce: string, leaseOwnerId: string, bun: Readonly<{ path: string; sha256: string }>) {
  assert(plans.has(plan) && equal(binaries.get(plan), bun) && /^[a-f0-9-]{36}$/.test(nonce) && /^[a-f0-9-]{36}$/.test(leaseOwnerId))
  const broker = brokers.get(plan); assert(broker && !broker.ended())
  const child = new EventEmitter() as EventEmitter & { pid?: number }
  const http = createWindowsExecutionHttpClient(
    value => broker.request('send', { value: { ...value, nonce, leaseOwnerId } }).then(() => undefined),
    error => { child.emit('error', error); void broker.request('retire').catch(() => child.emit('error', new Error('cleanup_unknown'))) },
  )
  const commandRequests = new Set<string>(), commandOperations = new Set(['commandStart', 'commandRead', 'commandStatus', 'commandWriteStdin', 'commandEndStdin', 'commandRetire', 'commandClose'])
  let commandPending = 0
  let mapping: WindowsExecutionMapping | undefined, nativeMapping: unknown, stopped = false, started = false, closed = false
  let connectedResolve!: (value: unknown) => void, connectedReject!: (error: Error) => void
  const connected = new Promise<unknown>((resolve, reject) => { connectedResolve = resolve; connectedReject = reject }); void connected.catch(() => undefined)
  broker.events.on('connected', connectedResolve)
  broker.events.on('failed', () => { const error = new Error('execution_containment_launcher_denied'); connectedReject(error); http.fail(error); child.emit('error', error) })
  broker.events.on('error', error => { connectedReject(error); http.fail(error); child.emit('error', error) })
  broker.events.on('close', code => { const error = new Error('execution_containment_helper_closed'); connectedReject(error); http.fail(error); child.emit('close', code) })
  broker.events.on('message', value => {
    try {
      const record = row(value)
      if (record.type === 'windowsHTTP') {
        assert(mapping && started && record.nonce === nonce && record.leaseOwnerId === leaseOwnerId, 'execution_identity_mismatch')
        http.accept(record); return
      }
      if (record.type === 'ready') {
        assert(mapping && started && !stopped && record.nonce === nonce && record.leaseOwnerId === leaseOwnerId && record.namespace === mapping.namespace.name && record.pid === mapping.bun.nativePID && equal(record.birth, mapping.bun.birth) && record.executableSha256 === mapping.bun.executableSha256 && typeof record.baseUrl === 'string', 'execution_identity_mismatch')
        http.bindOrigin(record.baseUrl)
      }
      if (record.type === 'commandRequest') {
        assert(mapping && started && !stopped && record.nonce === nonce && record.leaseOwnerId === leaseOwnerId && typeof record.id === 'string' && /^[a-f0-9-]{36}$/.test(record.id) && !commandRequests.has(record.id) && commandRequests.size < 65536 && commandPending < 64 && typeof record.operation === 'string' && commandOperations.has(record.operation), 'execution_native_command_unknown')
        const input = row(record.input), operation = record.operation, id = record.id
        commandRequests.add(id); commandPending++
        void (async () => {
          try {
            await assertLive()
            const result = await broker!.request(operation, operation === 'commandStart' ? { ...input, commandId: randomUUID() } : input)
            await broker!.request('send', { value: { type: 'commandResult', id, nonce, leaseOwnerId, ok: true, value: result } })
          } catch {
            if (!stopped && !broker!.ended()) await broker!.request('send', { value: { type: 'commandResult', id, nonce, leaseOwnerId, ok: false } }).catch(() => child.emit('error', new Error('execution_native_command_unknown')))
          } finally { commandPending-- }
        })()
        return
      }
      if (mapping && record.type === 'closed' && record.nonce === nonce && record.leaseOwnerId === leaseOwnerId && record.namespace === mapping.namespace.name && record.pid === mapping.bun.nativePID && equal(record.birth, mapping.bun.birth) && record.scopeClosed === true && record.realpathClosed === mapping.realpathDll.receiptId) closed = true
      child.emit('message', value)
    } catch { child.emit('error', new Error('execution_invalid_response')) }
  })
  const launch = broker.request('launch', { executable: plan.executable, entry: plan.entry, cwd: plan.cwd, env: plan.env,
    writableRoots: plan.writableRoots, readOnlyRoots: plan.readOnlyRoots, protectedRoots: plan.protectedRoots, realpathDll: plan.realpathDll, nonce, leaseOwnerId })
  void launch.catch(connectedReject)
  async function bounded<T>(work: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted(); assert(deadline > Date.now(), 'execution_timeout')
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
    try { return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('execution_timeout')), deadline - Date.now()); abort = () => reject(new Error('execution_cancelled')); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    })]) } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
  }
  async function assertLive() { assert(mapping && !stopped && !broker!.ended()); assert(equal(await broker!.request('assertLive'), nativeMapping), 'execution_identity_mismatch') }
  let preparation: Promise<WindowsExecutionMapping> | undefined, retirement: Promise<WindowsKernelRetirement> | undefined
  return Object.freeze({ child, fetch: http.fetch,
    prepare(deadline: number, signal?: AbortSignal): Promise<WindowsExecutionMapping> {
      return preparation ??= (async () => {
        signal?.throwIfAborted(); assert(Date.now() < deadline, 'execution_timeout')
        const observed = row(await bounded(launch, deadline, signal)), peer = row(await bounded(connected, deadline, signal))
        const actual = await identity(observed.bun), supervisor = await identity(observed.supervisor)
        assert(peer.clientPID === actual.hostPID && equal(peer, { ...observed, clientPID: actual.hostPID }) && actual.executablePath === bun.path && actual.executableSha256 === bun.sha256 && supervisor.executablePath === plan.helper.path && supervisor.executableSha256 === plan.helper.sha256 && observed.namespace === `windows-job:${nonce}` && observed.leaseOwnerId === leaseOwnerId && typeof observed.containerSid === 'string' && /^S-1-15-2-/.test(observed.containerSid), 'execution_identity_mismatch')
        const { clientPID: _clientPID, ...peerMapping } = peer
        assert(equal(peerMapping, observed) && observed.nonce === nonce, 'execution_identity_mismatch')
        const realpathAnchors = realpathAnchorReceipt(observed.realpathAnchors, plan, nonce, actual, supervisor)
        const realpathDll = realpathDllReceipt(observed.realpathDll, plan, nonce, actual, supervisor)
        const prepared = new Promise<Record<string, unknown>>((resolve, reject) => {
          const listener = (value: unknown) => { try { const record = row(value); if (record.type === 'prepared') { child.removeListener('message', listener); resolve(record) } } catch (error) { reject(error) } }; child.on('message', listener)
        })
        await broker!.request('send', { value: { type: 'prepare', nonce, leaseOwnerId, namespace: observed.namespace, birth: actual.birth, executableSha256: actual.executableSha256, supervisor, containerSid: observed.containerSid, realpathAnchors, realpathDll } }, deadline, signal)
        const response = await bounded(prepared, deadline, signal)
        assert(response.nonce === nonce && response.leaseOwnerId === leaseOwnerId && response.pid === actual.nativePID && equal(response.birth, actual.birth) && response.namespace === observed.namespace && response.executableSha256 === actual.executableSha256 && response.realpathInstalled === realpathDll.receiptId, 'execution_identity_mismatch')
        nativeMapping = observed; child.pid = actual.hostPID
        mapping = Object.freeze({ bun: actual, supervisor, namespace: Object.freeze({ name: String(observed.namespace) }), containerSid: observed.containerSid, leaseOwnerId, realpathAnchors, realpathDll })
        mappings.add(mapping); await assertLive(); signal?.throwIfAborted(); assert(Date.now() < deadline, 'execution_timeout'); return mapping
      })()
    },
    assertLive,
    async start(payload: Readonly<Record<string, unknown>>, deadline: number, signal?: AbortSignal) { assert(mapping && !started && !stopped); await assertLive(); started = true; await broker!.request('send', { value: { ...payload, type: 'start', nonce, leaseOwnerId, namespace: mapping.namespace.name } }, deadline, signal) },
    sendClose() { assert(mapping); stopped = true; void http.close().then(() => broker!.request('send', { value: { type: 'close', nonce, leaseOwnerId } })).catch(() => child.emit('error', new Error('cleanup_unknown'))) },
    acknowledged: () => closed,
    async kill() { stopped = true; await broker!.request('retire') },
    retire(): Promise<WindowsKernelRetirement> {
      return retirement ??= (async () => {
        stopped = true; const observed = row(await launch), receipt = row(await broker!.request('retire'))
        assert(mapping && equal(receipt.mapping, observed) && receipt.empty === true && receipt.activeProcesses === 0 && receipt.heldProcessExited === true && receipt.ownAcesRemoved === true, 'cleanup_unknown')
        const value = Object.freeze({ pid: mapping.bun.hostPID, birth: mapping.bun.birth, mapping, scopeClosed: closed, activeProcesses: 0 as const, heldProcessExited: true as const, ownAcesRemoved: true as const })
        retirements.add(value); return value
      })()
    },
  })
}
