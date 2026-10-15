import { openCodeBunVersion } from '../../../../constants/openCodeBunVersion.js'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { validateExecutionProfile, type OwnedNativeProfile, type ExecutionBirth } from '../OpenCodeV2ExecutionBinding.js'
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
export type WindowsSelectedAuthMetadata = Readonly<{
  read(deadline: number, signal?: AbortSignal): Promise<Readonly<{ sha256: string; bytes: number }>>
}>
const plans = new WeakSet<WindowsLaunchPlan>(), mappings = new WeakSet<WindowsExecutionMapping>(), retirements = new WeakSet<WindowsKernelRetirement>()
const selectedConfigs = new WeakMap<WindowsLaunchPlan, string>(), selectingConfigs = new WeakSet<WindowsLaunchPlan>()
const brokers = new WeakMap<WindowsLaunchPlan, WindowsNativeBroker>(), binaries = new WeakMap<WindowsLaunchPlan, Readonly<{ path: string; sha256: string }>>()
type WindowsMemberPreflightSelection = Readonly<{
  selectors: Readonly<{
    mode: 'memberPreflight'; directory: string; dataRoot: string
    binding: Readonly<{ teamId: string; runId: string; controllerInstanceId: string; ownerId: string }>
    root: string; databasePath: string; sha256: string
  }>
}>
type WindowsMemberPreflightResult = Readonly<{ stateId: string; launchNonce: string }>
type WindowsMemberPreflightAttempt = {
  broker: WindowsNativeBroker; selectors: WindowsMemberPreflightSelection['selectors']
  state: 'consumed' | 'ready' | 'poisoned'; result?: WindowsMemberPreflightResult; nonceConsumed?: true
}
const memberPreflights = new WeakMap<WindowsLaunchPlan, WindowsMemberPreflightAttempt>()
export type WindowsCommandRequestReplay = Readonly<{
  admit(id: string, operation: string): object
  settle(id: string, authority: object): void
}>
/** Bounded request identity: live work is never displaced by replay retention. */
export function createWindowsCommandRequestReplay(): WindowsCommandRequestReplay {
  const pending = new Map<string, object>(), finished = new Map<string, object>()
  const lifecycle = new Set(['commandRetire', 'commandClose'])
  return Object.freeze({
    admit(id: string, operation: string) {
      if (pending.has(id) || finished.has(id)) throw new Error('execution_native_command_unknown')
      // Reserve two lifecycle slots so close/retire remain available after the
      // ordinary sixty-four request slots are full.
      if (!(lifecycle.has(operation) ? pending.size < 66 : pending.size < 64)) throw new Error('execution_native_command_unknown')
      const authority = Object.freeze({}); pending.set(id, authority); return authority
    },
    settle(id: string, authority: object) {
      // A late completion can only release the authority it was admitted with.
      if (pending.get(id) !== authority) return
      pending.delete(id); finished.set(id, authority)
      if (finished.size > 4096) finished.delete(finished.keys().next().value!)
    },
  })
}
/** The child keeps using the original command channel while its Scope closes.
 * Only native retained command IDs may retire/close; no new work is admitted. */
export function createWindowsCommandRequestHandler(options: Readonly<{
  nonce: string; leaseOwnerId: string; ready(): boolean; closing(): boolean
  assertLive(allowClosing: boolean): Promise<void>; request: WindowsNativeBroker['request']; failed(): void
}>) {
  const replay = createWindowsCommandRequestReplay()
  const operations = new Set(['commandStart', 'commandRead', 'commandStatus', 'commandWriteStdin', 'commandEndStdin', 'commandRetire', 'commandClose'])
  const lifecycle = new Set(['commandRetire', 'commandClose'])
  const failed = () => { try { options.failed() } catch { /* Error observers cannot poison the native frame parser. */ } }
  return async (value: unknown): Promise<void> => {
    let id: string | undefined, authority: object | undefined
    const reply = (ok: boolean, result?: unknown) => options.request('send', {
      value: { type: 'commandResult', id, nonce: options.nonce, leaseOwnerId: options.leaseOwnerId, ok,
        ...(ok ? { value: result } : {}) },
    })
    try {
      const record = row(value)
      assert(options.ready() && record.type === 'commandRequest' &&
        record.nonce === options.nonce && record.leaseOwnerId === options.leaseOwnerId &&
        typeof record.id === 'string' && /^[a-f0-9-]{36}$/.test(record.id) &&
        typeof record.operation === 'string' && operations.has(record.operation), 'execution_native_command_unknown')
      const input = row(record.input), operation = record.operation as string
      id = record.id as string; authority = replay.admit(id, operation)
      if (options.closing() && !lifecycle.has(operation)) { await reply(false); return }
      await options.assertLive(lifecycle.has(operation))
      if (options.closing() && !lifecycle.has(operation)) { await reply(false); return }
      const result = await options.request(operation, operation === 'commandStart' ? { ...input, commandId: randomUUID() } : input)
      await reply(true, result)
    } catch {
      if (id && authority) { try { await reply(false) } catch { failed() } }
      else failed()
    } finally { if (id && authority) replay.settle(id, authority) }
  }
}
/** Progress is diagnostic only and belongs to the original launch nonce. It
 * cannot qualify a receipt or extend the existing native request deadline. */
export async function retireWindowsNativeScope(broker: Pick<WindowsNativeBroker, 'events' | 'request'>,
  nonce: string): Promise<unknown> {
  const phases = new Set(['retire_job', 'retire_wait', 'retire_io_join', 'retire_main_exit',
    'retire_owned_pair', 'retire_commands', 'retire_receipt', 'retire_grants',
    'retire_grants_dll', 'retire_grants_roots', 'retire_grants_metadata'])
  let phase: string | undefined
  const progress = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',') === 'nonce,phase' && record.nonce === nonce &&
      typeof record.phase === 'string' && phases.has(record.phase)) phase = record.phase
  }
  broker.events.on('retireProgress', progress)
  try { return await broker.request('retire') }
  catch (error) {
    if (error instanceof Error && error.message === 'execution_native_timeout' && phase)
      throw new Error(`execution_native_timeout:${phase}:0`, { cause: error })
    throw error
  } finally { broker.events.off('retireProgress', progress) }
}
/** Only the launch's native held-process event can close MAIN. Helper failure
 * remains an error and never supplies a MAIN exit code. */
const mainStderrKinds = ['empty', 'entry_resolution', 'module_resolution', 'child_identity', 'child_pipe', 'access_denied', 'pipe_refused', 'pipe_missing', 'bun_error', 'unclassified', 'unavailable']
export function observeWindowsHeldMainExit(events: EventEmitter, child: EventEmitter, launch: Promise<unknown>, onExit?: (code: number, stderrKind: string | undefined) => void) {
  let exited = false
  events.on('mainExited', value => { void (async () => {
    const receipt = row(value), mapping = row(await launch)
    assert(receipt.heldProcessExited === true && equal(receipt.mapping, mapping) &&
      Number.isSafeInteger(receipt.exitCode) && Number(receipt.exitCode) >= 0 && Number(receipt.exitCode) <= 0xffffffff, 'execution_identity_mismatch')
    if (!exited) {
      exited = true
      onExit?.(Number(receipt.exitCode), typeof receipt.stderrKind === 'string' && mainStderrKinds.includes(receipt.stderrKind) ? receipt.stderrKind : undefined)
      child.emit('close', receipt.exitCode)
    }
  })().catch(() => child.emit('error', new Error('execution_identity_mismatch'))) })
  // Preserve the authenticated held-process observation for retirement. A new
  // OpenProcess lookup may no longer resolve this PID after the held MAIN exits.
  return Object.freeze(Object.assign(() => exited, {
    async readBirth(): Promise<ExecutionBirth | null> {
      const native = row(row(await launch).bun)
      if (exited) return null
      assert(Number.isSafeInteger(native.hostPID) && Number(native.hostPID) > 0 &&
        native.hostPID === native.nativePID, 'execution_identity_mismatch')
      return windowsBirth(Number(native.hostPID))
    },
  }))
}
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
  const tmp = plan.env.TMP
  assert(typeof tmp === 'string' && path.win32.isAbsolute(tmp), 'execution_identity_mismatch')
  assert(input.held === true && input.nonce === nonce && input.receiptId === `windows-dll:${supervisor.nativePID}:${actual.nativePID}:${actual.birth.value}` &&
    input.sourcePath === plan.realpathDll.path &&
    input.path === path.win32.join(tmp, `native-realpath-${nonce}`, 'opencode-v2-windows-realpath.dll') &&
    input.sha256 === plan.realpathDll.sha256, 'execution_identity_mismatch')
  assert(typeof input.volumeSerial === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(input.volumeSerial) && BigInt(input.volumeSerial) <= 0xffffffffffffffffn &&
    typeof input.fileId === 'string' && /^[a-f0-9]{32}$/.test(input.fileId) && typeof input.ownerSid === 'string' && /^S-1-5-/.test(input.ownerSid), 'execution_identity_mismatch')
  return Object.freeze({ receiptId: String(input.receiptId), nonce, path: input.path as string, sha256: input.sha256 as string,
    volumeSerial: input.volumeSerial, fileId: input.fileId, ownerSid: input.ownerSid, held: true })
}
export async function windowsBirth(pid: number): Promise<ExecutionBirth | null> {
  assert(Number.isSafeInteger(pid) && pid > 0, 'execution_identity_mismatch')
  const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
  broker.events.on('error', () => {})
  try {
    const value = row(await broker.request('identity', { pid }, Date.now() + 3000))
    // OpenProcess can prove a process is gone only when the native API reports
    // a positively observed exit. A missing PID is an unknown identity, never
    // a liveness bypass or a cleanup receipt.
    assert(value.absent === undefined || value.absent === false, 'execution_identity_unknown')
    assert(value.exited === true || value.exited === false, 'execution_identity_unknown')
    const observed = birth(value.birth)
    return value.exited === true ? null : observed
  }
  finally { await broker.close() }
}
// Every raw root is canonicalized before this step. Select only already
// admitted ancestors: descendant grants add no access to the existing union.
// win32.relative handles case/separators; drive/UNC ambiguity is rejected above.
function compactReadOnlyGrantUnion(roots: readonly string[]): readonly string[] {
  const selected: string[] = []
  const inside = (parent: string, child: string) => {
    const relative = path.win32.relative(parent, child)
    return relative === '' || (relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative))
  }
  for (const root of roots) {
    if (selected.some(parent => inside(parent, root))) continue
    for (let index = selected.length - 1; index >= 0; index--) if (inside(root, selected[index]!)) selected.splice(index, 1)
    selected.push(root)
  }
  return Object.freeze(selected)
}
/** Exact production config/environment joins select controller candidates.
 * Keep them in the complete plan, but defer their filesystem qualification
 * until the same broker has attached the sealed cohort and preflighted the
 * member. Every other writable/profile/read-only root remains eagerly checked. */
function deferredWindowsControllerRoots(requested: Readonly<{ writableRoots: readonly string[]; env: Readonly<Record<string, string>> }>): ReadonlySet<string> {
  const base = requested.env.AGENT_TEAMS_MCP_CLAUDE_DIR
  if (typeof base !== 'string' || !path.win32.isAbsolute(base)) return new Set()
  return new Set(requested.writableRoots.filter(root => {
    const relative = path.win32.relative(base, root), parts = relative.split('\\')
    return parts.length === 2 && (parts[0] === 'teams' || parts[0] === 'tasks') &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(parts[1]!)
  }))
}
export async function planWindowsExecution(requested: Readonly<{
  bun: Readonly<{ path: string; sha256: string }>; entry: string; cwd: string; writableRoots: readonly string[]; readOnlyRoots: readonly string[]; protectedRoots?: readonly string[]; profileDirectories?: readonly string[]; readOnlyMounts?: readonly Readonly<{ source: string; target: string }>[]; env: Readonly<Record<string, string>>
}>): Promise<WindowsLaunchPlan> {
  assert(process.platform === 'win32' && process.arch === 'x64' && process.versions.bun === openCodeBunVersion(),
    'execution_containment_runtime_pending')
  const input = structuredClone(requested)
  assert(await realpath(input.bun.path) === input.bun.path && await hash(input.bun.path) === input.bun.sha256, 'execution_identity_mismatch')
  assert(input.profileDirectories && input.profileDirectories.length > 0, 'execution_profile_changed')
  assert((input.readOnlyMounts ?? []).every(mount => mount.source === mount.target), 'execution_containment_path_alias_pending')
  // Source and canonical graph-file directories supply content grants. Identity
  // resolver mounts still require canonical validation; promoting an ancestor
  // node_modules here would recursively grant every unselected sibling package.
  // Native graph anchors provide target-only metadata access to their ancestors.
  const readOnlyRoots = [...new Set(input.readOnlyRoots)]
  const resolutionRoots = new Set((input.readOnlyMounts ?? []).map(mount => mount.source))
  const rawRoots = [...new Set([...input.writableRoots, ...readOnlyRoots, ...resolutionRoots, ...input.profileDirectories, input.cwd])]
  for (const root of rawRoots) assert(path.isAbsolute(root) && /^[A-Za-z]:\\/.test(root) && !root.includes('/') && path.parse(root).root !== root, 'execution_path_alias')
  const deferredControllers = deferredWindowsControllerRoots(input)
  for (const root of rawRoots) {
    if (!deferredControllers.has(root) || readOnlyRoots.includes(root) || resolutionRoots.has(root) ||
      input.profileDirectories.includes(root) || root === input.cwd)
      assert(await realpath(root) === root, 'execution_path_alias')
  }
  for (const key of Object.keys(input.env)) assert(!/^(?:NODE_CHANNEL_|OPENCODE_V2_WINDOWS_|DYLD_|LD_)/.test(key), 'execution_profile_changed')
  const helper = await resolveWindowsNativeArtifact(), realpathDll = await resolveWindowsRealpathArtifact()
  assert(helper.arch === 'x64' && realpathDll.arch === 'x64' &&
    await hash(realpathDll.path) === realpathDll.sha256, 'execution_containment_helper_identity')
  for (const root of [...input.writableRoots, ...(input.protectedRoots ?? [])]) {
    const relative = path.win32.relative(root, realpathDll.path)
    assert(relative !== '' && (relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)), 'execution_containment_dll_identity')
  }
  const plan: WindowsLaunchPlan = Object.freeze({ helper, realpathDll, executable: input.bun.path, entry: input.entry, cwd: input.cwd,
    writableRoots: Object.freeze([...new Set(input.writableRoots)]), readOnlyRoots: compactReadOnlyGrantUnion(readOnlyRoots), protectedRoots: Object.freeze([...new Set(input.protectedRoots ?? [])]), profileDirectories: Object.freeze([...new Set(input.profileDirectories)]), env: Object.freeze(input.env) })
  assert(plan.readOnlyRoots.length + plan.writableRoots.length <= 4096, 'execution_containment_anchor_budget')
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
  const filesystem = createWindowsOwnerFilesystem((request, deadline, signal) =>
    broker.request(request.op, request, deadline, signal), plan.profileDirectories)
  const { readSelectedAuthMetadata: readSelected, ...owned } = filesystem
  return Object.freeze({
    ...owned,
    selectedAuthMetadata(): WindowsSelectedAuthMetadata {
      const selectionId = selectedConfigs.get(plan)
      assert(selectionId && brokers.get(plan) === broker && !broker.ended(), 'execution_owner_unknown')
      return Object.freeze({ read: (deadline, signal) => {
        assert(selectedConfigs.get(plan) === selectionId && brokers.get(plan) === broker && !broker.ended(), 'execution_owner_unknown')
        return readSelected(selectionId, deadline, signal).then(({ sha256, bytes }) => Object.freeze({ sha256, bytes }))
      } })
    },
  })
}
/** Member membership came only from the retained serving-record/profile tuple.
 * The attempt is consumed before native preflight; uncertainty poisons it. */
export async function preflightWindowsMemberExecution(plan: WindowsLaunchPlan,
  selection: WindowsMemberPreflightSelection, deadline: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  assert(Number.isFinite(deadline) && deadline > Date.now(), 'execution_timeout')
  assert(plans.has(plan) && !memberPreflights.has(plan), 'execution_owner_unknown')
  const broker = brokers.get(plan); assert(broker && !broker.ended(), 'execution_owner_unknown')
  const selectors = selection.selectors
  assert(selectors.mode === 'memberPreflight' &&
    typeof selectors.directory === 'string' && typeof selectors.dataRoot === 'string' &&
    typeof selectors.root === 'string' && typeof selectors.databasePath === 'string' &&
    /^[a-f0-9]{64}$/.test(selectors.sha256) &&
    Object.keys(selectors.binding).sort().join(',') === 'controllerInstanceId,ownerId,runId,teamId' &&
    Object.values(selectors.binding).every(value => typeof value === 'string' && value.length > 0 && !value.includes('\0')),
    'run_state_start_changed')
  const attempt: WindowsMemberPreflightAttempt = { broker, selectors, state: 'consumed' }
  memberPreflights.set(plan, attempt) // Once requested, native consumption cannot be replayed.
  try {
    const response = row(await broker.request('runStateSelect', {
      ...selectors,
    }, deadline, signal))
    signal?.throwIfAborted()
    assert(Object.keys(response).sort().join(',') === 'launchNonce,stateId' &&
      typeof response.stateId === 'string' && /^run-state-[a-f0-9]{32}$/.test(response.stateId) &&
      typeof response.launchNonce === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(response.launchNonce),
      'run_state_start_changed')
    attempt.result = Object.freeze({ stateId: response.stateId as string, launchNonce: response.launchNonce as string })
    attempt.state = 'ready'
  } catch (error) {
    attempt.state = 'poisoned'; attempt.result = undefined; throw error
  }
}
/** Native member nonce is consumed before ownerIdentity and physical fences.
 * A nonmember plan retains the existing private random launch nonce policy. */
export function consumeWindowsExecutionLaunchNonce(plan: WindowsLaunchPlan): string {
  assert(plans.has(plan), 'execution_owner_unknown')
  const attempt = memberPreflights.get(plan)
  if (!attempt) return randomUUID()
  const broker = brokers.get(plan)
  assert(attempt.state === 'ready' && attempt.result && !attempt.nonceConsumed &&
    attempt.broker === broker && broker && !broker.ended(), 'run_state_start_changed')
  attempt.nonceConsumed = true
  return attempt.result.launchNonce
}
/** Root composition calls this after native selected-profile validation and
 * fence acquisition, before launch. The private plan/cache admits the exact
 * managed config; scalar caller process/FileID/binding DTOs are never accepted. */
export async function bindWindowsExecutionSelectedConfig(plan: WindowsLaunchPlan, profile: OwnedNativeProfile, teamId: string, deadline: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  assert(Number.isFinite(deadline) && deadline > Date.now(), 'execution_timeout')
  assert(plans.has(plan) && !selectingConfigs.has(plan), 'execution_owner_unknown')
  selectingConfigs.add(plan) // A mutation with unknown completion cannot replay.
  const broker = brokers.get(plan); assert(broker && !broker.ended(), 'execution_owner_unknown')
  const member = memberPreflights.get(plan)
  if (member) assert(member.state === 'ready' && member.result && member.nonceConsumed === true && member.broker === broker &&
    member.selectors.root === profile.root && member.selectors.databasePath === profile.databasePath &&
    member.selectors.sha256 === profile.config.sha256 && member.selectors.binding.teamId === teamId,
    'run_state_start_changed')
  await validateExecutionProfile(profile)
  signal?.throwIfAborted(); assert(deadline > Date.now(), 'execution_timeout')
  assert(plan.writableRoots.includes(profile.root) && plan.profileDirectories.includes(profile.root) &&
    plan.profileDirectories.includes(profile.config.directory) && profile.config.directory === path.win32.join(profile.root, 'config', 'opencode'), 'execution_profile_changed')
  const selected = row(await broker.request('ownerSelectConfig', { root: profile.root, databasePath: profile.databasePath, sha256: profile.config.sha256, teamId }, deadline, signal))
  assert(selected.schema === 1 && selected.ok === true && typeof selected.selectionId === 'string' && /^[1-9]\d{0,19}$/.test(selected.selectionId) && selected.root === profile.root &&
    selected.path === path.win32.join(profile.config.directory, 'opencode.json') && selected.sha256 === profile.config.sha256, 'execution_profile_changed')
  selectedConfigs.set(plan, selected.selectionId)
}
export function launchWindowsExecution(plan: WindowsLaunchPlan, nonce: string, leaseOwnerId: string,
  bun: Readonly<{ path: string; sha256: string }>, deadline: number) {
  assert(Number.isFinite(deadline) && deadline > Date.now(), 'execution_timeout')
  assert(plans.has(plan) && selectedConfigs.has(plan) && equal(binaries.get(plan), bun) && /^[a-f0-9-]{36}$/.test(nonce) && /^[a-f0-9-]{36}$/.test(leaseOwnerId))
  const member = memberPreflights.get(plan)
  if (member) assert(member.state === 'ready' && member.result && member.nonceConsumed === true &&
    nonce === member.result.launchNonce && brokers.get(plan) === member.broker, 'run_state_start_changed')
  const broker = brokers.get(plan); assert(broker && !broker.ended())
  const child = new EventEmitter() as EventEmitter & { pid?: number }
  const http = createWindowsExecutionHttpClient(
    value => broker.request('send', { value: { ...value, nonce, leaseOwnerId } }).then(() => undefined),
    error => { child.emit('error', error); void broker.request('retire').catch(() => child.emit('error', new Error('cleanup_unknown'))) },
  )
  // Command request IDs are replayed only while their operation is pending or
  // retained in a small settled window.
  let mapping: WindowsExecutionMapping | undefined, nativeMapping: unknown, stopped = false, started = false, closed = false
  const commandRequest = createWindowsCommandRequestHandler({ nonce, leaseOwnerId,
    ready: () => !!mapping && started, closing: () => stopped,
    assertLive: allowClosing => assertLive(allowClosing), request: (operation, input) => broker!.request(operation, input),
    failed: () => child.emit('error', new Error('execution_native_command_unknown')),
  })
  let mainExit: ReturnType<typeof observeWindowsHeldMainExit> | undefined
  let connectedResolve!: (value: unknown) => void, connectedReject!: (error: Error) => void
  const connected = new Promise<unknown>((resolve, reject) => { connectedResolve = resolve; connectedReject = reject }); void connected.catch(() => undefined)
  broker.events.on('connected', connectedResolve)
  broker.events.on('failed', () => { const error = new Error('execution_containment_launcher_denied'); connectedReject(error); http.fail(error); child.emit('error', error) })
  broker.events.on('error', error => { connectedReject(error); http.fail(error); child.emit('error', error) })
  broker.events.on('close', () => { const error = new Error('execution_containment_helper_closed'); connectedReject(error); http.fail(error); if (!mainExit?.()) child.emit('error', error) })
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
        void commandRequest(record)
        return
      }
      if (mapping && record.type === 'closed' && record.nonce === nonce && record.leaseOwnerId === leaseOwnerId && record.namespace === mapping.namespace.name && record.pid === mapping.bun.nativePID && equal(record.birth, mapping.bun.birth) && record.scopeClosed === true && record.realpathClosed === mapping.realpathDll.receiptId) closed = true
      child.emit('message', value)
    } catch { child.emit('error', new Error('execution_invalid_response')) }
  })
  let heldMainExitCode: number | undefined, heldMainStderrKind: string | undefined
  const launchStarted = Date.now()
  const launchHistory: { stage: string; elapsedMs: number }[] = []
  const launchStages = ['windows-cohort', 'windows-profile', 'windows-roots', 'windows-dll',
    'windows-process', 'windows-owned-pair', 'windows-published', 'windows-connected',
    'windows-prepare', 'windows-assert']
  const markLaunch = (stage: string) => {
    if (!launchStages.includes(stage) || launchHistory.some(value => value.stage === stage)) return
    launchHistory.push({ stage, elapsedMs: Math.max(launchHistory.at(-1)?.elapsedMs ?? 0, Date.now() - launchStarted) })
  }
  broker.events.on('launchProgress', value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const entry = value as Record<string, unknown>
    if (entry.nonce === nonce && typeof entry.stage === 'string') markLaunch(entry.stage)
  })
  const launch = broker.request('launch', { executable: plan.executable, entry: plan.entry, cwd: plan.cwd, env: plan.env,
    writableRoots: plan.writableRoots, readOnlyRoots: plan.readOnlyRoots, protectedRoots: plan.protectedRoots, realpathDll: plan.realpathDll, selectedConfigId: selectedConfigs.get(plan), nonce, leaseOwnerId }, deadline)
  mainExit = observeWindowsHeldMainExit(broker.events, child, launch, (code, stderrKind) => {
    heldMainExitCode = code; heldMainStderrKind = stderrKind
  })
  void launch.catch(connectedReject)
  async function bounded<T>(work: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted(); assert(deadline > Date.now(), 'execution_timeout')
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
    try { return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('execution_timeout')), deadline - Date.now()); abort = () => reject(new Error('execution_cancelled')); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    })]) } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
  }
  async function assertLive(allowClosing = false) {
    assert(mapping, 'execution_containment_unqualified:assert_mapping:0')
    assert(!stopped || allowClosing, 'execution_containment_unqualified:assert_stopped:0')
    assert(!broker!.ended(), 'execution_containment_unqualified:assert_broker:0')
    assert(equal(await broker!.request('assertLive'), nativeMapping), 'execution_identity_mismatch')
  }
  let preparation: Promise<WindowsExecutionMapping> | undefined, retirement: Promise<WindowsKernelRetirement> | undefined
  return Object.freeze({ child, fetch: http.fetch,
    output: () => ({ stdout: '', stderr: launchHistory.length === 0 ? '' : JSON.stringify({
      event: 'opencode-v2-startup', reason: 'failed', stage: launchHistory.at(-1)!.stage,
      elapsedMs: Math.max(launchHistory.at(-1)!.elapsedMs, Date.now() - launchStarted), history: launchHistory,
      ...(heldMainExitCode === undefined ? {} : { nativeExitCode: heldMainExitCode }),
      ...(heldMainStderrKind === undefined ? {} : { nativeStderrKind: heldMainStderrKind }),
    }) }),
    prepare(deadline: number, signal?: AbortSignal): Promise<WindowsExecutionMapping> {
      return preparation ??= (async () => {
        signal?.throwIfAborted(); assert(Date.now() < deadline, 'execution_timeout')
        const observed = row(await bounded(launch, deadline, signal)), peer = row(await bounded(connected, deadline, signal))
        markLaunch('windows-connected')
        const actual = await identity(observed.bun), supervisor = await identity(observed.supervisor)
        assert(peer.clientPID === actual.hostPID && equal(peer, { ...observed, clientPID: actual.hostPID }) && actual.executablePath === bun.path && actual.executableSha256 === bun.sha256 && supervisor.executablePath === plan.helper.path && supervisor.executableSha256 === plan.helper.sha256 && observed.namespace === `windows-job:${nonce}` && observed.leaseOwnerId === leaseOwnerId && typeof observed.containerSid === 'string' && /^S-1-15-2-/.test(observed.containerSid), 'execution_identity_mismatch')
        const { clientPID: _clientPID, ...peerMapping } = peer
        assert(equal(peerMapping, observed) && observed.nonce === nonce, 'execution_identity_mismatch')
        const realpathAnchors = realpathAnchorReceipt(observed.realpathAnchors, plan, nonce, actual, supervisor)
        const realpathDll = realpathDllReceipt(observed.realpathDll, plan, nonce, actual, supervisor)
        const prepared = new Promise<Record<string, unknown>>((resolve, reject) => {
          const listener = (value: unknown) => { try { const record = row(value); if (record.type === 'prepared') { child.removeListener('message', listener); resolve(record) } } catch (error) { reject(error) } }; child.on('message', listener)
        })
        markLaunch('windows-prepare')
        await broker!.request('send', { value: { type: 'prepare', nonce, leaseOwnerId, namespace: observed.namespace, birth: actual.birth, executableSha256: actual.executableSha256, supervisor, containerSid: observed.containerSid, realpathAnchors, realpathDll } }, deadline, signal)
        const response = await bounded(prepared, deadline, signal)
        assert(response.nonce === nonce && response.leaseOwnerId === leaseOwnerId && response.pid === actual.nativePID && equal(response.birth, actual.birth) && response.namespace === observed.namespace && response.executableSha256 === actual.executableSha256 && response.realpathInstalled === realpathDll.receiptId, 'execution_identity_mismatch')
        nativeMapping = observed; child.pid = actual.hostPID
        mapping = Object.freeze({ bun: actual, supervisor, namespace: Object.freeze({ name: String(observed.namespace) }), containerSid: observed.containerSid, leaseOwnerId, realpathAnchors, realpathDll })
        mappings.add(mapping); markLaunch('windows-assert'); await assertLive(); signal?.throwIfAborted(); assert(Date.now() < deadline, 'execution_timeout'); return mapping
      })()
    },
    assertLive,
    async start(payload: Readonly<Record<string, unknown>>, deadline: number, signal?: AbortSignal) { assert(mapping && !started && !stopped); await assertLive(); started = true; await broker!.request('send', { value: { ...payload, type: 'start', nonce, leaseOwnerId, namespace: mapping.namespace.name } }, deadline, signal) },
    sendClose() { assert(mapping); stopped = true; void http.close().then(() => broker!.request('send', { value: { type: 'close', nonce, leaseOwnerId } })).catch(() => child.emit('error', new Error('cleanup_unknown'))) },
    acknowledged: () => closed,
    readBirth() { assert(mapping && mainExit, 'execution_identity_mismatch'); return mainExit.readBirth() },
    async kill() { stopped = true; await broker!.request('retire') },
    retire(): Promise<WindowsKernelRetirement> {
      return retirement ??= (async () => {
        stopped = true; const observed = row(await launch), receipt = row(await retireWindowsNativeScope(broker!, nonce))
        assert(mapping && equal(receipt.mapping, observed) && receipt.empty === true && receipt.activeProcesses === 0 && receipt.heldProcessExited === true && receipt.ownedPairClosed === true && receipt.ownAcesRemoved === true, 'cleanup_unknown')
        const value = Object.freeze({ pid: mapping.bun.hostPID, birth: mapping.bun.birth, mapping, scopeClosed: closed, activeProcesses: 0 as const, heldProcessExited: true as const, ownAcesRemoved: true as const })
        retirements.add(value); return value
      })()
    },
  })
}
