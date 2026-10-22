import { openCodeBunVersion } from '../../../constants/openCodeBunVersion.js'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import path from 'node:path'
import { canonicalExecutionJSON, executionAssert, executionHash, executionRecord, assertIntentIdentity, openCodeV2RunInitializationMs, type ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'
import type { ExecutionMention } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import type { RunAnyProcessIdentity, RunBinding, RunControlRecord, RunControlRequest, RunControlResult, RunMemberStatus, RunProcessIdentity, RunStopMember, RunUnixControlRecord, RunWindowsControlRecord } from './OpenCodeV2RunTypes.js'
import type { SelectedExecutionProfile } from '../host/OpenCodeV2ExecutionBinding.js'
import { OpenCodeV2RunNonces } from './OpenCodeV2RunNonces.js'
import { CONTROLLER_INBOX_MAX_BYTES, retainedControllerPath, selectedControllerInboxRoot,
  type ControllerInboxBinding, type ControllerToolProof } from './OpenCodeV2ControllerTools.js'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact, type WindowsNativeBroker } from '../host/windows/OpenCodeV2WindowsNativeBroker.js'
import { ensureWindowsPrivateDirectories } from '../profile/OpenCodePrivateDirectories.js'
import type { WindowsLaunchPlan } from '../host/windows/OpenCodeV2WindowsExecution.js'
export type { RunBinding, RunControlRecord, RunControlRequest, RunControlResult, RunLaunchPlan } from './OpenCodeV2RunTypes.js'

const MAX_RECORD = 512 * 1024
// Frames carry full control replies and share the broker packet budget.
const MAX_FRAME = 16 * 1024 * 1024
// Graph preparation and native startup share one absolute budget. Individual control operations remain capped at 30s.
export const OPEN_CODE_V2_RUN_INITIALIZATION_MS = openCodeV2RunInitializationMs(process.platform)
const MAX_OPERATION_MS = 30_000
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
type WindowsServingAdmission = Readonly<{ record: RunWindowsControlRecord; profiles: readonly WindowsProfileAdmission[] }>
type WindowsRunComposition = { readonly broker: WindowsNativeBroker; readonly stateId: string; serving?: WindowsServingAdmission }
const windowsRuns = new Map<string, Promise<WindowsRunComposition>>()
type WindowsProfileAdmission = Readonly<{ projectDirectory?: string; root: string; databasePath: string; sha256: string; directories: readonly string[] }>
const WINDOWS_PROFILE_DIRECTORY_ENV_KEYS = [
  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'TMPDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA',
] as const
type WindowsProfileConfigInspection = Readonly<{
  schema: 1; ok: true; state: 'complete' | 'absent' | 'incomplete'; root: string; databasePath: string
  configPath: string; privateAcl: true; reparse: false; rootIdentity: unknown; configIdentity: unknown
}>
function parseWindowsFileIdentity(value: unknown): Readonly<{ volumeSerial: string; fileId: string; ownerSid: string }> {
  const row = executionRecord(value); keys(row, ["volumeSerial", "fileId", "ownerSid"])
  const decimal = String(row.volumeSerial), hex = String(row.fileId), sid = String(row.ownerSid)
  executionAssert(decimal.length > 0 && decimal.length <= 20 && [...decimal].every(char => char >= "0" && char <= "9") &&
    hex.length === 32 && [...hex].every(char => "0123456789abcdef".includes(char)) &&
    sid.startsWith("S-1-") && !sid.includes("\0"), "run_control_endpoint_changed")
  return Object.freeze({ volumeSerial: decimal, fileId: hex, ownerSid: sid })
}
const isWindowsRecord = (record: RunControlRecord): record is RunWindowsControlRecord =>
  'platform' in record && record.platform === 'win32'
const isUnixRecord = (record: RunControlRecord): record is RunUnixControlRecord => !isWindowsRecord(record)
const windowsRecord = (record: RunControlRecord): RunWindowsControlRecord => {
  if (process.platform !== 'win32' || !isWindowsRecord(record)) throw new Error('run_control_invalid')
  return record
}
const unixRecord = (record: RunControlRecord): RunUnixControlRecord => {
  if (process.platform === 'win32' || !isUnixRecord(record)) throw new Error('run_control_invalid')
  return record
}
function windowsDataRoot(directory: string): string {
  const runs = path.dirname(directory), version = path.dirname(runs), opencode = path.dirname(version), dataRoot = path.dirname(opencode)
  executionAssert(path.basename(runs) === 'runs' && path.basename(version) === 'v2' && path.basename(opencode) === 'opencode' &&
    path.isAbsolute(dataRoot), 'run_control_invalid')
  return dataRoot
}
type WindowsCompositionSelection =
  | Readonly<{ mode: 'reserve' | 'serve' | 'client'; dataRoot: string; binding: RunBinding; profiles: readonly WindowsProfileAdmission[] }>
  | Readonly<{ mode: 'discover'; dataRoot: string; teamId: string; runId: string; profiles: readonly WindowsProfileAdmission[] }>
function windowsProfileAdmission(profile: SelectedExecutionProfile): WindowsProfileAdmission {
  const environmentDirectories = WINDOWS_PROFILE_DIRECTORY_ENV_KEYS.map(key => profile.env[key])
  const directories = Object.freeze([...new Set([
    profile.root, profile.config.directory, path.win32.dirname(profile.databasePath), ...environmentDirectories,
  ])])
  executionAssert(process.platform === 'win32' && path.win32.isAbsolute(profile.root) &&
    path.win32.isAbsolute(profile.databasePath) && /^[a-f0-9]{64}$/.test(profile.config.sha256) &&
    directories.length > 0 && directories.length <= 64 && directories.every(value =>
      typeof value === 'string' && value.length > 0 && !value.includes('\0') && path.win32.isAbsolute(value)), 'run_control_selection_missing')
  return Object.freeze({ projectDirectory: profile.directory, root: profile.root, databasePath: profile.databasePath, sha256: profile.config.sha256, directories })
}
function parseWindowsProfileConfigInspection(value: unknown, root: string, databasePath: string): WindowsProfileConfigInspection {
  const row = executionRecord(value)
  keys(row, ['schema', 'ok', 'state', 'root', 'databasePath', 'configPath', 'privateAcl', 'reparse', 'rootIdentity', 'configIdentity'])
  executionAssert(row.schema === 1 && row.ok === true && ['complete', 'absent', 'incomplete'].includes(String(row.state)) &&
    row.root === root && row.databasePath === databasePath &&
    row.configPath === path.win32.join(root, 'config', 'opencode', 'opencode.json') &&
    row.privateAcl === true && row.reparse === false &&
    (row.configIdentity === null || parseWindowsFileIdentity(row.configIdentity) !== undefined), 'run_control_selection_missing')
  parseWindowsFileIdentity(row.rootIdentity)
  return row as unknown as WindowsProfileConfigInspection
}
async function windowsProfileAdmissionsForDataRoot(dataRoot: string, broker: WindowsNativeBroker,
  deadline: number): Promise<readonly WindowsProfileAdmission[]> {
  const profilesRoot = path.win32.join(dataRoot, 'opencode', 'v2', 'profiles')
  const entries = await readdir(profilesRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (executionRecord(error).code === 'ENOENT') return [] as Dirent[]; throw error
  })
  const profiles: WindowsProfileAdmission[] = []
  executionAssert(entries.every(entry => !entry.isSymbolicLink()), 'run_control_selection_missing')
  const candidates = entries.filter(entry => entry.isDirectory()).slice(0, 32)
  for (const entry of candidates) {
    executionAssert(Date.now() < deadline, 'run_control_selection_missing')
    const root = path.win32.join(profilesRoot, entry.name)
    const configDirectory = path.win32.join(root, 'config', 'opencode')
    const configPath = path.win32.join(configDirectory, 'opencode.json')
    const databasePath = path.win32.join(root, 'data', 'opencode', 'opencode.db')
    const inspected = parseWindowsProfileConfigInspection(await broker.request('ownerInspectProfileConfig',
      { root, databasePath }, deadline), root, databasePath)
    // Native held ownership/DACL/reparse evidence proves only these two
    // incomplete states may be skipped. Malformed and foreign complete files
    // continue to the full selected-profile/config-hash contract and fail it.
    if (inspected.state !== 'complete') continue
    const [rootInfo, configInfo, configBytes] = await Promise.all([lstat(root), lstat(configPath), readFile(configPath)])
    executionAssert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && await realpath(root) === root &&
      configInfo.isFile() && !configInfo.isSymbolicLink() && configInfo.nlink === 1, 'run_control_selection_missing')
    const directories = [...new Set([root, ...['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata']
      .map(name => path.win32.join(root, name)), configDirectory])]
    profiles.push({ root, databasePath, sha256: digest(configBytes), directories })
  }
  return profiles
}
async function windowsAdmitProfiles(broker: WindowsNativeBroker, profiles: readonly WindowsProfileAdmission[],
  deadline: number, teamId: string): Promise<readonly string[]> {
  executionAssert(profiles.length > 0 && profiles.length <= 32, 'run_control_selection_missing')
  executionAssert(new Set(profiles.map(profile => `${profile.root}|${profile.databasePath}|${profile.sha256}`)).size === profiles.length,
    'run_control_selection_missing')
  const ids: string[] = []
  for (const profile of profiles) {
    await broker.request('ownerValidateSelectedProfile', {
      root: profile.root, databasePath: profile.databasePath, directories: profile.directories,
      ...(profile.projectDirectory ? { projectDirectory: profile.projectDirectory } : {}),
    }, deadline)
    const selected = await broker.request('ownerSelectConfig', {
      root: profile.root, databasePath: profile.databasePath, sha256: profile.sha256, teamId,
    }, deadline) as { schema?: unknown; ok?: unknown; selectionId?: unknown; root?: unknown; path?: unknown; sha256?: unknown }
    executionAssert(selected.schema === 1 && selected.ok === true && typeof selected.selectionId === 'string' &&
      /^[1-9]\d{0,19}$/.test(selected.selectionId) && selected.root === profile.root &&
      selected.path === path.win32.join(profile.root, 'config', 'opencode', 'opencode.json') &&
      selected.sha256 === profile.sha256, 'run_control_selection_missing')
    ids.push(selected.selectionId)
  }
  return ids
}
/** Join the sealed cohort on this fresh broker before any native custody
 * re-check. Member launch grants the cohort's package SIDs on the selected
 * profile paths; without the attach, a broker created for discovery or
 * composition would refuse those grants as foreign. Never submits
 * selectionIds — selection state stays the admitted selection's own. */
async function attachWindowsRunCohort(broker: WindowsNativeBroker, directory: string,
  dataRoot: string, teamId: string, runId: string, deadline: number): Promise<void> {
  const value = await broker.request('runStateSelect', {
    mode: 'attach', directory, dataRoot, teamId, runId,
  }, deadline) as { absent?: true; stateId?: string }
  executionAssert(value && (value.absent === true || typeof value.stateId === 'string'),
    'run_control_native_unknown')
}
async function windowsComposition(directory: string, select?: WindowsCompositionSelection,
  deadline = Date.now() + MAX_OPERATION_MS): Promise<WindowsRunComposition> {
  const existing = windowsRuns.get(directory)
  if (existing) return existing
  if (!select) throw new Error('run_control_native_pending')
  const created = (async () => {
    executionAssert(process.platform === 'win32' && process.versions.bun === openCodeBunVersion(), 'run_control_native_pending')
    // Concrete native composition is private to this module. Neither the
    // artifact nor a caller port can qualify a run or mint retained authority.
    const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
    broker.events.on('error', () => {})
    try {
      await attachWindowsRunCohort(broker, directory, select.dataRoot,
        select.mode === 'discover' ? select.teamId : select.binding.teamId,
        select.mode === 'discover' ? select.runId : select.binding.runId, deadline)
      const selectionIds = await windowsAdmitProfiles(broker, select.profiles, deadline,
        select.mode === 'discover' ? select.teamId : select.binding.teamId)
      const input = select.mode === 'reserve'
        ? { directory, dataRoot: select.dataRoot, binding: select.binding, selectionIds, sharedControllerRootCohort: true }
        : select.mode === 'discover'
          ? { directory, dataRoot: select.dataRoot, mode: select.mode, teamId: select.teamId, runId: select.runId, selectionIds }
          : { directory, dataRoot: select.dataRoot, mode: select.mode, binding: select.binding, selectionIds }
      const value = await broker.request(select.mode === 'reserve' ? 'runStateAcquire' : 'runStateSelect',
        input, deadline) as { stateId: string }
      executionAssert(value && typeof value.stateId === 'string', 'run_control_native_unknown')
      return { broker, stateId: value.stateId }
    } catch (error) { await broker.close().catch(() => {}); throw error }
  })()
  windowsRuns.set(directory, created)
  try { return await created } catch (error) { windowsRuns.delete(directory); throw error }
}
async function windowsDiscover(directory: string, dataRoot: string, teamId: string, runId: string): Promise<RunControlRecord | null> {
  executionAssert(process.platform === 'win32' && process.versions.bun === openCodeBunVersion(), 'run_control_native_pending')
  const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
  broker.events.on('error', () => {})
  try {
    const deadline = Date.now() + MAX_OPERATION_MS
    await attachWindowsRunCohort(broker, directory, dataRoot, teamId, runId, deadline)
    const profiles = await windowsProfileAdmissionsForDataRoot(dataRoot, broker, deadline)
    // Only discovery may submit zero selections. Native code must certify a
    // missing namespace without issuing state; a present fence still vetoes it.
    const selectionIds = profiles.length === 0 ? [] : await windowsAdmitProfiles(broker, profiles, deadline, teamId)
    const result = await broker.request('runStateDiscover', {
      directory, dataRoot, teamId, runId, selectionIds,
    }, Date.now() + MAX_OPERATION_MS) as { absent?: true; stateId?: string; record?: unknown }
    if (result.absent === true) { await broker.close(); return null }
    executionAssert(typeof result.stateId === 'string' && result.record !== undefined, 'run_control_native_unknown')
    const record = parseRecord(result.record)
    windowsRuns.set(directory, Promise.resolve({ broker, stateId: result.stateId }))
    return record
  } catch (error) { await broker.close().catch(() => {}); throw error }
}
async function windowsRead(directory: string, name: string): Promise<unknown> {
  const state = await windowsComposition(directory)
  const value = await state.broker.request('runStateReadRecord', {
    stateId: state.stateId, directory, name,
  }, Date.now() + MAX_OPERATION_MS) as { value: unknown }
  return value.value
}
async function windowsWrite(directory: string, name: string, value: unknown): Promise<void> {
  const state = await windowsComposition(directory)
  await state.broker.request('runStateWriteRecord', {
    stateId: state.stateId, directory, name, bytes: canonicalExecutionJSON(value) + '\n',
  }, Date.now() + MAX_OPERATION_MS)
}
async function windowsCompositionFor(record: RunWindowsControlRecord,
  deadline = Date.now() + MAX_OPERATION_MS): Promise<WindowsRunComposition> {
  const existing = windowsRuns.get(record.directory)
  if (existing) return existing
  const discoveryBroker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
  discoveryBroker.events.on('error', () => {})
  let profiles: readonly WindowsProfileAdmission[]
  try {
    await attachWindowsRunCohort(discoveryBroker, record.directory, windowsDataRoot(record.directory),
      record.binding.teamId, record.binding.runId, deadline)
    profiles = await windowsProfileAdmissionsForDataRoot(windowsDataRoot(record.directory), discoveryBroker, deadline)
  } finally { await discoveryBroker.close() }
  return windowsComposition(record.directory, {
    mode: 'client', dataRoot: windowsDataRoot(record.directory), binding: record.binding,
    profiles,
  }, deadline)
}
/** Read through the already serving native owner. Comparison values never select
 * another profile, run state, broker or controller path. */
export async function readWindowsRunControllerInbox(directory: string, profile: SelectedExecutionProfile,
  proof: ControllerToolProof, binding: ControllerInboxBinding, deadline: number, signal?: AbortSignal): Promise<Buffer | null> {
  const check = () => { signal?.throwIfAborted(); executionAssert(Date.now() < deadline, 'run_controller_timeout') }
  check()
  executionAssert(process.platform === 'win32', 'run_controller_inbox_unknown')
  const root = selectedControllerInboxRoot(profile, proof, binding)
  const pending = windowsRuns.get(directory)
  executionAssert(pending, 'run_controller_inbox_unknown')
  const state = await pending, serving = state.serving
  check()
  executionAssert(serving && serving.record.directory === directory &&
    serving.record.binding.teamId === binding.teamId && serving.record.binding.runId === binding.runId,
    'run_state_start_changed')
  const selected = serving.profiles.filter(candidate => candidate.root === profile.root &&
    candidate.databasePath === profile.databasePath && candidate.sha256 === profile.config.sha256)
  executionAssert(selected.length === 1 && digest(profile.config.content) === selected[0]!.sha256,
    'run_state_start_changed')
  const admitted = selected[0]!
  const value = await state.broker.request('runStateReadControllerInbox', {
    stateId: state.stateId, directory, teamId: serving.record.binding.teamId, runId: serving.record.binding.runId,
    root: admitted.root, databasePath: admitted.databasePath, sha256: admitted.sha256,
  }, Math.min(deadline, Date.now() + MAX_OPERATION_MS), signal)
  check()
  executionAssert(value !== null && typeof value === 'object' && !Array.isArray(value), 'run_controller_inbox_unknown')
  const row = executionRecord(value)
  executionAssert(Object.keys(row).sort().join(',') === 'bytesBase64,ok,schema,state' &&
    row.schema === 1 && row.ok === true, 'run_controller_inbox_unknown')
  if (row.state === 'not_applicable') {
    executionAssert(root === null && row.bytesBase64 === null, 'run_controller_inbox_unknown')
    return null
  }
  executionAssert(root !== null, 'run_controller_inbox_unknown')
  if (row.state === 'absent') {
    executionAssert(row.bytesBase64 === null, 'run_controller_inbox_unknown')
    return Buffer.from('[]')
  }
  executionAssert(row.state === 'regular' && typeof row.bytesBase64 === 'string' &&
    row.bytesBase64.length > 0 && row.bytesBase64.length <= 4 * Math.ceil(CONTROLLER_INBOX_MAX_BYTES / 3),
    'run_controller_inbox_unknown')
  const bytes = Buffer.from(row.bytesBase64, 'base64')
  executionAssert(bytes.length > 0 && bytes.length <= CONTROLLER_INBOX_MAX_BYTES &&
    bytes.toString('base64') === row.bytesBase64, 'run_controller_inbox_unknown')
  check()
  return bytes
}
/** Called only after the one Windows execution plan and selected-profile
 * qualification exist. This lookup supplies comparison values; it cannot mint
 * or convey filesystem authority. */
export async function selectWindowsRunMemberPreflightForPlan(plan: WindowsLaunchPlan,
  context: ExecutionContext, profile: SelectedExecutionProfile): Promise<Readonly<{
    selectors: Readonly<{ mode: 'memberPreflight'; directory: string; dataRoot: string
      binding: RunBinding; root: string; databasePath: string; sha256: string }>
  }> | null> {
  executionAssert(process.platform === 'win32' && plan && context.teamId.length > 0 && context.runId.length > 0,
    'run_control_native_unknown')
  const known: WindowsServingAdmission[] = []
  const matches: Array<Readonly<{ serving: WindowsServingAdmission; profile: WindowsProfileAdmission }>> = []
  for (const pending of windowsRuns.values()) {
    const state = await pending, serving = state.serving
    if (!serving || serving.record.binding.teamId !== context.teamId || serving.record.binding.runId !== context.runId) continue
    known.push(serving)
    const profiles = serving.profiles.filter(candidate => candidate.root === profile.root &&
      candidate.databasePath === profile.databasePath && candidate.sha256 === profile.config.sha256)
    executionAssert(profiles.length <= 1, 'run_state_start_changed')
    if (profiles.length === 1) matches.push({ serving, profile: profiles[0]! })
  }
  // A known team/run serving state is never an ordinary no-cohort lookup:
  // missing, changed, or ambiguous profile/record state fails closed.
  executionAssert(known.length === 0 || known.length === 1 && matches.length === 1, 'run_state_start_changed')
  const match = matches[0]
  if (!match) return null
  const directory = match.serving.record.directory
  return Object.freeze({
    selectors: Object.freeze({
      mode: 'memberPreflight', directory, dataRoot: windowsDataRoot(directory),
      binding: match.serving.record.binding, root: match.profile.root, databasePath: match.profile.databasePath, sha256: match.profile.sha256,
    }),
  })
}
const keys = (row: Record<string, unknown>, names: readonly string[]) => executionAssert(
  Object.keys(row).sort().join(',') === [...names].sort().join(','), 'run_control_invalid')
function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) throw new Error('run_control_invalid')
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('run_control_invalid')
  return value
}
function optionalKeys(row: Record<string, unknown>, required: readonly string[], optional: readonly string[]): void {
  executionAssert(required.every(key => Object.hasOwn(row, key)) && Object.keys(row).every(key => [...required, ...optional].includes(key)), 'run_control_invalid')
}
function mention(value: unknown, length: number): ExecutionMention {
  const row = executionRecord(value); keys(row, ['start', 'end', 'text'])
  const start = integer(row.start), end = integer(row.end)
  if (end < start || end > length || typeof row.text !== 'string') throw new Error('run_control_invalid')
  return { start, end, text: row.text }
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('run_control_invalid')
  return value
}
export function parseRunBinding(value: unknown): RunBinding {
  const row = executionRecord(value); keys(row, ['teamId', 'runId', 'controllerInstanceId', 'ownerId'])
  return { teamId: string(row.teamId), runId: string(row.runId), controllerInstanceId: string(row.controllerInstanceId), ownerId: string(row.ownerId) }
}
function parseIdentity(value: unknown): RunProcessIdentity {
  const row = executionRecord(value); keys(row, ['pid', 'startTicks', 'bootId', 'executablePath', 'executableSha256'])
  const result = { pid: integer(row.pid), startTicks: string(row.startTicks), bootId: string(row.bootId), executablePath: string(row.executablePath), executableSha256: string(row.executableSha256) }
  executionAssert(result.pid > 0 && (process.platform === 'darwin' ? /^\d+:[1-9]\d*$/.test(result.startTicks) : /^[0-9]+$/.test(result.startTicks)) && /^[a-f0-9]{64}$/.test(result.executableSha256), 'run_control_invalid')
  return result
}
async function readUnixProcessIdentity(pid = process.pid): Promise<RunProcessIdentity> {
  if (process.platform === 'darwin') {
    executionAssert(Number.isSafeInteger(pid) && pid > 0, 'run_process_unknown')
    const { dlopen, FFIType, ptr, toArrayBuffer } = await import('bun:ffi')
    const native = dlopen('/usr/lib/libSystem.B.dylib', {
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    })
    try {
      const executable = Buffer.alloc(4096), boot = Buffer.alloc(128), length = Buffer.alloc(8)
      length.writeBigUInt64LE(128n)
      for (let attempt = 0; ; attempt += 1) {
        const before = Buffer.alloc(56), after = Buffer.alloc(56)
        if (native.symbols.proc_pidinfo(pid, 17, 0, ptr(before), before.length) !== before.length) {
          const pointer = native.symbols.__error()
          executionAssert(pointer !== null, 'run_process_unknown')
          const errno = new DataView(toArrayBuffer(pointer, 0, 4)).getInt32(0, true)
          // Only the kernel's ESRCH establishes absence; access/query failures
          // remain UNKNOWN and cannot qualify retirement or authorize takeover.
          throw Object.assign(new Error('run_process_unknown'), { code: errno === 3 ? 'ESRCH' : 'EACCES' })
        }
        const uniqueId = before.readBigUInt64LE(0)
        executionAssert(native.symbols.proc_pidpath(pid, ptr(executable), executable.length) > 0 &&
          native.symbols.sysctlbyname(ptr(Buffer.from('kern.bootsessionuuid\0')), ptr(boot), ptr(length), null, 0) === 0, 'run_process_unknown')
        const executablePath = executable.toString('utf8').split('\0')[0]!, bootId = boot.toString('utf8').split('\0')[0]!.toLowerCase()
        executionAssert(await realpath(executablePath) === executablePath && /^[a-f0-9-]{36}$/.test(bootId), 'run_process_unknown')
        const executableSha256 = digest(await readFile(executablePath))
        const afterLength = native.symbols.proc_pidinfo(pid, 17, 0, ptr(after), after.length)
        // The kernel-assigned unique ID is the process instance identity: PID
        // reuse must never authenticate a replacement process.
        executionAssert(afterLength === after.length && after.readBigUInt64LE(0) === uniqueId, 'run_process_changed')
        // Bytes 8-15 are the parent's unique ID: reparenting (launchd adoption
        // when the spawner exits) does not change the instance or its image.
        let stableIgnoringParent = true
        for (let i = 0; i < before.length; i += 1) {
          if (i >= 8 && i < 16) continue
          if (before[i] !== after[i]) { stableIgnoringParent = false; break }
        }
        if (before.equals(after) || stableIgnoringParent) {
          const source = before.equals(after) ? before : after
          // Stable record field; on Darwin this is unique process ID:PID version,
          // not a fabricated Linux clock tick. Every reader uses the same parser.
          return { pid, startTicks: `${source.readBigUInt64LE(16)}:${source.readInt32LE(32)}`, bootId, executablePath, executableSha256 }
        }
        // Remaining drift is a lifecycle event mid-hash (e.g. exec); a fresh
        // bracket over the settled process authenticates one image epoch.
        if (attempt >= 2) executionAssert(false, 'run_process_changed')
      }
    } finally { native.close() }
  }
  executionAssert(process.platform === 'linux' && Number.isSafeInteger(pid) && pid > 0, 'run_source_linux_required')
  const proc = `/proc/${pid}`
  const [stat, bootId, executablePath] = await Promise.all([
    readFile(`${proc}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8'), realpath(`${proc}/exe`),
  ])
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  executionAssert(startTicks && /^[0-9]+$/.test(startTicks), 'run_process_unknown')
  const executableSha256 = digest(await readFile(`${proc}/exe`))
  const result = { pid, startTicks, bootId: bootId.trim(), executablePath, executableSha256 }
  // Bracket the potentially slow executable hash with birth reads; PID reuse
  // must never authenticate a replacement process.
  const after = await readFile(`${proc}/stat`, 'utf8')
  executionAssert(after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/)[19] === startTicks, 'run_process_changed')
  return result
}
export async function readRunProcessIdentity(pid = process.pid): Promise<RunAnyProcessIdentity> {
  if (process.platform === 'win32') {
    executionAssert(Number.isSafeInteger(pid) && pid > 0, 'run_process_unknown')
    const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
    broker.events.on('error', () => {})
    try {
      const identity = parseWindowsIdentity(await broker.request('runStateProcessIdentity', { pid }, Date.now() + 30_000))
      executionAssert(identity.appContainer === false, 'run_process_appcontainer')
      return identity
    } finally { await broker.close() }
  }
  return readUnixProcessIdentity(pid)
}
function parseRecord(value: unknown): RunControlRecord {
  const row = executionRecord(value)
  if (Object.hasOwn(row, 'platform')) {
    keys(row, ['schema', 'protocol', 'binding', 'process', 'directory', 'deadline', 'sourceSha256', 'platform', 'endpoint'])
    executionAssert(row.schema === 1 && row.protocol === 1 && row.platform === 'win32', 'run_control_invalid')
    return parseWindowsRecord(row)
  }
  keys(row, ['schema', 'protocol', 'binding', 'process', 'directory', 'socketPath', 'socketDevice', 'socketInode', 'deadline', 'uid', 'sourceSha256'])
  executionAssert(row.schema === 1 && row.protocol === 1, 'run_control_invalid')
  return { schema: 1, protocol: 1, binding: parseRunBinding(row.binding), process: parseIdentity(row.process),
    directory: string(row.directory), socketPath: string(row.socketPath), socketDevice: integer(row.socketDevice), socketInode: integer(row.socketInode),
    deadline: integer(row.deadline), uid: integer(row.uid), sourceSha256: string(row.sourceSha256) }
}
function parseWindowsIdentity(value: unknown): import('./OpenCodeV2RunTypes.js').RunWindowsProcessIdentity {
  const row = executionRecord(value)
  keys(row, ['pid', 'processCreationTime', 'executablePath', 'executableSha256', 'userSid', 'appContainer'])
  const created = executionRecord(row.processCreationTime)
  keys(created, ['kind', 'value', 'bootId'])
  const result = { pid: integer(row.pid), processCreationTime: { kind: 'windows-filetime' as const, value: string(created.value), bootId: null },
    executablePath: string(row.executablePath), executableSha256: string(row.executableSha256), userSid: string(row.userSid), appContainer: false as const }
  executionAssert(result.pid > 0 && /^[0-9]+$/.test(result.processCreationTime.value) && /^[a-f0-9]{64}$/.test(result.executableSha256) &&
    created.kind === 'windows-filetime' && created.bootId === null && row.appContainer === false, 'run_control_invalid')
  return result
}
function parseWindowsRecord(row: Record<string, unknown>): RunWindowsControlRecord {
  const endpoint = executionRecord(row.endpoint)
  keys(endpoint, ['kind', 'name', 'helper', 'bun'])
  executionAssert(endpoint.kind === 'windows-native-pipe', 'run_control_invalid')
  return { schema: 1, protocol: 1, platform: 'win32', binding: parseRunBinding(row.binding),
    process: parseWindowsIdentity(row.process), directory: string(row.directory), deadline: integer(row.deadline),
    sourceSha256: string(row.sourceSha256), endpoint: { kind: 'windows-native-pipe', name: string(endpoint.name),
      helper: parseWindowsIdentity(endpoint.helper), bun: parseWindowsIdentity(endpoint.bun) } }
}
function parseWindowsEndpointProof(value: unknown, record: RunWindowsControlRecord): void {
  const row = executionRecord(value)
  keys(row, ['schema', 'valid', 'ownerSid', 'endpointHash', 'rootIdentity', 'runIdentity', 'binding', 'helper', 'bun', 'held'])
  const rootIdentity = parseWindowsFileIdentity(row.rootIdentity), runIdentity = parseWindowsFileIdentity(row.runIdentity)
  executionAssert(row.schema === 1 && row.valid === true && row.held === true &&
    row.ownerSid === record.process.userSid && rootIdentity.ownerSid === row.ownerSid &&
    runIdentity.ownerSid === row.ownerSid &&
    row.endpointHash === executionHash(record) && executionHash(row.binding) === executionHash(record.binding) &&
    executionHash(parseWindowsIdentity(row.helper)) === executionHash(record.endpoint.helper) &&
    executionHash(parseWindowsIdentity(row.bun)) === executionHash(record.endpoint.bun), 'run_control_endpoint_changed')
}
function sameStopReceipt(left: Extract<RunControlResult, { kind: 'stop' }>,
  right: Extract<RunControlResult, { kind: 'stop' }>): boolean {
  return executionHash(left.members) === executionHash(right.members) &&
    (left.state === right.state || left.state === 'stopped' && right.state === 'cleanup_unknown' &&
      right.ownerRetired === false)
}
function parseWindowsStopReceipt(value: unknown): Extract<RunControlResult, { kind: 'stop' }> {
  const receipt = executionRecord(value)
  keys(receipt, ['kind', 'state', 'members'])
  executionAssert(receipt.kind === 'stop' && (receipt.state === 'stopped' || receipt.state === 'cleanup_unknown'), 'run_control_invalid')
  const memberValues = array(receipt.members)
  executionAssert(memberValues.length <= 32, 'run_control_invalid')
  const members = memberValues.map(value => {
    const member = executionRecord(value); keys(member, ['memberId', 'cleanup', 'errors'])
    const errors = array(member.errors)
    executionAssert(errors.every(error => typeof error === 'string' && error.length > 0 && error.length <= 256), 'run_control_invalid')
    let cleanup: RunStopMember['cleanup'] = null
    if (member.cleanup !== null) {
      const row = executionRecord(member.cleanup)
      keys(row, ['scopeClosed', 'processRetired', 'descendantsRetired', 'pid', 'birth'])
      const birth = executionRecord(row.birth); keys(birth, ['format', 'value', 'bootId'])
      executionAssert(row.scopeClosed === true && row.processRetired === true && row.descendantsRetired === true &&
        integer(row.pid) > 0 && birth.format === 'windows-filetime' && birth.bootId === null &&
        /^[1-9]\d{0,19}$/.test(string(birth.value)), 'run_control_invalid')
      cleanup = { scopeClosed: true, processRetired: true, descendantsRetired: true, pid: integer(row.pid),
        birth: { format: 'windows-filetime', value: string(birth.value), bootId: null } }
    }
    return { memberId: string(member.memberId), cleanup, errors: errors.map(string) }
  })
  executionAssert(receipt.state !== 'stopped' || members.length > 0 &&
    members.every(member => member.cleanup !== null && member.errors.length === 0), 'run_control_invalid')
  return { kind: 'stop', state: receipt.state, members }
}
function parseIntent(value: unknown): QueueIntent {
  const row = executionRecord(value); keys(row, ['identity', 'input', 'delivery'])
  const identity = executionRecord(row.identity)
  const typedIdentity = { requestId: string(identity.requestId), deliveryAttemptId: string(identity.deliveryAttemptId), localMessageId: string(identity.localMessageId), nativeInputID: string(identity.nativeInputID) }
  keys(identity, ['requestId', 'deliveryAttemptId', 'localMessageId', 'nativeInputID']); assertIntentIdentity(typedIdentity)
  const input = executionRecord(row.input)
  optionalKeys(input, ['nativeInputID', 'text', 'resume'], ['files', 'agents', 'skills'])
  executionAssert(row.delivery === 'queue' && typeof input.resume === 'boolean' && input.nativeInputID === typedIdentity.nativeInputID, 'run_control_invalid')
  executionAssert(typeof input.text === 'string', 'run_control_invalid')
  const text = input.text
  executionAssert(text.trim().length > 0 && Buffer.byteLength(text) <= 256 * 1024, 'run_control_invalid')
  const files = input.files === undefined ? undefined : array(input.files).map(value => {
    const file = executionRecord(value); optionalKeys(file, ['uri'], ['name', 'description', 'mention'])
    executionAssert(typeof file.uri === 'string' && file.uri.length > 0 && Buffer.byteLength(file.uri) <= 256 * 1024, 'run_control_invalid')
    return { uri: file.uri, ...(file.name === undefined ? {} : { name: string(file.name) }),
      ...(file.description === undefined ? {} : { description: string(file.description) }),
      ...(file.mention === undefined ? {} : { mention: mention(file.mention, text.length) }) }
  })
  const agents = input.agents === undefined ? undefined : array(input.agents).map(value => {
    const item = executionRecord(value); optionalKeys(item, ['name'], ['mention'])
    return { name: string(item.name), ...(item.mention === undefined ? {} : { mention: mention(item.mention, text.length) }) }
  })
  const skills = input.skills === undefined ? undefined : array(input.skills).map(value => {
    const item = executionRecord(value); optionalKeys(item, ['id'], ['mention'])
    return { id: string(item.id), ...(item.mention === undefined ? {} : { mention: mention(item.mention, text.length) }) }
  })
  const result: QueueIntent = { identity: typedIdentity, input: { nativeInputID: typedIdentity.nativeInputID, text, resume: input.resume,
    ...(files ? { files } : {}), ...(agents ? { agents } : {}), ...(skills ? { skills } : {}) }, delivery: 'queue' }
  executionAssert(Buffer.byteLength(canonicalExecutionJSON(result.input)) <= 256 * 1024, 'run_control_invalid')
  return result
}
export function parseRunControlRequest(value: unknown): RunControlRequest {
  const row = executionRecord(value), operation = row.operation
  if (operation === 'stop' || operation === 'status') { keys(row, ['operation']); return { operation } }
  const memberId = string(row.memberId), originalSessionId = string(row.originalSessionId)
  executionAssert(/^ses_[a-zA-Z0-9]+$/.test(originalSessionId), 'run_control_invalid')
  if (operation === 'send') {
    optionalKeys(row, ['operation', 'memberId', 'originalSessionId', 'intent'], ['submissionOwner'])
    const submissionOwner = row.submissionOwner === undefined ? undefined : string(row.submissionOwner)
    executionAssert(submissionOwner === undefined || /^[a-zA-Z0-9._-]{1,200}$/.test(submissionOwner), 'run_control_invalid')
    return { operation, memberId, originalSessionId, intent: parseIntent(row.intent), ...(submissionOwner ? { submissionOwner } : {}) }
  }
  if (operation === 'observe') {
    optionalKeys(row, ['operation', 'memberId', 'originalSessionId', 'nativeInputID'], ['intent', 'submissionOwner'])
    const nativeInputID = string(row.nativeInputID)
    executionAssert(/^msg_[a-zA-Z0-9]+$/.test(nativeInputID), 'run_control_invalid')
    const intent = row.intent === undefined ? undefined : parseIntent(row.intent)
    executionAssert(!intent || intent.identity.nativeInputID === nativeInputID, 'run_control_invalid')
    const submissionOwner = row.submissionOwner === undefined ? undefined : string(row.submissionOwner)
    executionAssert(submissionOwner === undefined || intent && /^[a-zA-Z0-9._-]{1,200}$/.test(submissionOwner), 'run_control_invalid')
    return { operation, memberId, originalSessionId, nativeInputID, ...(intent ? { intent } : {}), ...(submissionOwner ? { submissionOwner } : {}) }
  }
  if (operation === 'transcript' || operation === 'permissions' || operation === 'mcp' || operation === 'probeEvidence') {
    keys(row, ['operation', 'memberId', 'originalSessionId']); return { operation, memberId, originalSessionId }
  }
  executionAssert(operation === 'permissionReply' && (row.decision === 'allow' || row.decision === 'deny'), 'run_control_invalid')
  keys(row, ['operation', 'memberId', 'originalSessionId', 'requestId', 'decision'])
  return { operation, memberId, originalSessionId, requestId: string(row.requestId), decision: row.decision }
}
export function runControlDirectory(dataRoot: string, teamId: string, runId: string): string {
  executionAssert(path.isAbsolute(dataRoot) && teamId.length > 0 && runId.length > 0, 'run_control_invalid')
  return path.join(dataRoot, 'opencode', 'v2', 'runs', executionHash({ teamId, runId }).slice(0, 32))
}
async function privatePath(file: string, kind: 'directory' | 'file' | 'socket', uid: number) {
  const stat = await lstat(file)
  executionAssert(!stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o077) === 0 &&
    (kind === 'directory' ? stat.isDirectory() : kind === 'socket' ? stat.isSocket() : stat.isFile() && stat.nlink === 1), 'run_control_foreign')
  return stat
}
/** Both transports address the held directory vnode, even for long durable paths. */
async function openSocketDirectory(directory: string, uid: number) {
  executionAssert((process.platform === 'linux' || process.platform === 'darwin') && process.versions.bun === '1.3.11', 'run_source_unix_bun_required')
  const before = await privatePath(directory, 'directory', uid)
  executionAssert(await realpath(directory) === directory, 'run_control_foreign')
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const assertCurrent = async () => {
      const [opened, current] = await Promise.all([fd.stat(), privatePath(directory, 'directory', uid)])
      executionAssert(opened.dev === before.dev && opened.ino === before.ino &&
        current.dev === before.dev && current.ino === before.ino &&
        await retainedControllerPath(fd) === directory, 'run_control_changed')
    }
    await assertCurrent()
    if (process.platform === 'darwin') {
      const { dlopen, FFIType } = await import('bun:ffi')
      const native = dlopen('/usr/lib/libSystem.B.dylib', {
        pthread_fchdir_np: { args: [FFIType.i32], returns: FFIType.i32 },
      })
      // XNU gives this thread a retained vnode cwd. Bun bind/connect are
      // synchronous here; no await or caller code runs before clearing it.
      const within = <T>(operation: () => T): T => {
        executionAssert(native.symbols.pthread_fchdir_np(fd.fd) === 0, 'run_control_changed')
        try { return operation() }
        finally { executionAssert(native.symbols.pthread_fchdir_np(-1) === 0, 'run_control_changed') }
      }
      return { fd: { close: async () => { try { await fd.close() } finally { native.close() } } }, assertCurrent,
        connect: () => within(() => createConnection('control.sock')),
        listen: (server: ReturnType<typeof createServer>, ready: () => void) => within(() => server.listen('control.sock', ready)) }
    }
    const socketPath = `/proc/self/fd/${fd.fd}/control.sock`
    executionAssert(Buffer.byteLength(socketPath) <= 103, 'run_socket_path_too_long')
    return { fd, assertCurrent, connect: () => createConnection(socketPath),
      listen: (server: ReturnType<typeof createServer>, ready: () => void) => server.listen(socketPath, ready) }
  } catch (error) { await fd.close(); throw error }
}
async function readPrivate(file: string, uid: number): Promise<Buffer> {
  const before = await privatePath(file, 'file', uid)
  executionAssert(before.size <= MAX_RECORD, 'run_control_invalid')
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await fd.stat()
    executionAssert(stat.dev === before.dev && stat.ino === before.ino, 'run_control_changed')
    const bytes = await fd.readFile(); executionAssert(bytes.length <= MAX_RECORD, 'run_control_invalid'); return bytes
  } finally { await fd.close() }
}
export async function writeRunControlFile(directory: string, name: string, value: unknown): Promise<void> {
  executionAssert(/^[a-z-]+\.json$/.test(name), 'run_control_invalid')
  if (process.platform === 'win32') return windowsWrite(directory, name, value)
  const uid = process.getuid?.(); executionAssert(uid !== undefined, 'run_source_linux_required')
  await privatePath(directory, 'directory', uid)
  const temporary = path.join(directory, `${name}.${randomUUID()}`), target = path.join(directory, name)
  const fd = await open(temporary, 'wx', 0o600)
  try { await fd.writeFile(canonicalExecutionJSON(value) + '\n'); await fd.sync() } finally { await fd.close() }
  await rename(temporary, target)
  const parent = await open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
}
/** Only explicit launch creates this non-expiring fence. Observe/stop never do. */
export async function reserveRunControlDirectory(dataRoot: string, binding: RunBinding, sourceSha256: string,
  profiles: readonly SelectedExecutionProfile[] = []): Promise<string> {
  if (process.platform === 'win32') {
    executionAssert(await realpath(dataRoot) === dataRoot, 'run_control_native_unknown')
    const directory = runControlDirectory(dataRoot, binding.teamId, binding.runId)
    executionAssert(profiles.length > 0, 'run_control_selection_missing')
    const admittedProfiles = profiles.map(windowsProfileAdmission)
    // Explicit reservation prepares parents only. Native acquisition below is
    // still the sole exclusive creator of the non-expiring run leaf/fence.
    await ensureWindowsPrivateDirectories([dataRoot, path.join(dataRoot, 'opencode'),
      path.join(dataRoot, 'opencode', 'v2'), path.dirname(directory)])
    const state = await windowsComposition(directory, {
      mode: 'reserve', dataRoot, binding, profiles: admittedProfiles,
    })
    await state.broker.request('runStateReserve', {
      stateId: state.stateId, binding, sourceSha256, directory, dataRoot, sharedControllerRootCohort: true,
    }, Date.now() + MAX_OPERATION_MS)
    return directory
  }
  const uid = process.getuid?.(); executionAssert(uid !== undefined && await realpath(dataRoot) === dataRoot, 'run_source_linux_required')
  const directory = runControlDirectory(dataRoot, binding.teamId, binding.runId)
  let parent = dataRoot
  for (const part of ['opencode', 'v2', 'runs']) {
    parent = path.join(parent, part)
    await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => { if (executionRecord(error).code !== 'EEXIST') throw error })
    if (part === 'opencode') {
      // V1's registry shares this ancestor and may create it as 0755. It holds
      // no V2 secrets; its namespace must remain owned and non-writable to others.
      const shared = await lstat(parent)
      executionAssert(shared.isDirectory() && !shared.isSymbolicLink() && shared.uid === uid &&
        (shared.mode & 0o022) === 0 && await realpath(parent) === parent, 'run_control_foreign')
    } else await privatePath(parent, 'directory', uid)
  }
  await mkdir(directory, { mode: 0o700 })
  await writeRunControlFile(directory, 'start.json', { binding, sourceSha256 })
  const secret = await open(path.join(directory, 'challenge'), 'wx', 0o600)
  try { await secret.writeFile(randomBytes(32)); await secret.sync() } finally { await secret.close() }
  return directory
}
export async function discoverOpenCodeV2Run(dataRoot: string, teamId: string, runId: string): Promise<RunControlRecord | null> {
  const directory = runControlDirectory(dataRoot, teamId, runId)
  if (process.platform === 'win32') {
    const record = await windowsDiscover(directory, dataRoot, teamId, runId)
    if (record === null) return null
    const native = windowsRecord(record)
    executionAssert(native.directory === directory && native.binding.teamId === teamId && native.binding.runId === runId, 'run_control_foreign')
    return record
  }
  const uid = process.getuid?.(); executionAssert(uid !== undefined, 'run_source_linux_required')
  try { await privatePath(directory, 'directory', uid) }
  catch (error) { if (executionRecord(error).code === 'ENOENT') return null; throw error }
  // An existing launch fence with no published endpoint remains UNKNOWN, not
  // permission for V1 fallback or a replacement supervisor.
  const record = parseRecord(JSON.parse((await readPrivate(path.join(directory, 'control.json'), uid)).toString('utf8')))
  const unix = unixRecord(record)
  executionAssert(unix.directory === directory && unix.binding.teamId === teamId && unix.binding.runId === runId && unix.uid === uid, 'run_control_foreign')
  return record
}
async function validateEndpoint(record: RunControlRecord, deadline = Date.now() + MAX_OPERATION_MS,
  composition?: WindowsRunComposition): Promise<void> {
  if (process.platform === 'win32') {
    const native = windowsRecord(record), state = composition ?? await windowsCompositionFor(native, deadline)
    const proof = await state.broker.request('runStateValidateEndpoint', {
      stateId: state.stateId, directory: native.directory, endpointHash: executionHash(record),
    }, deadline)
    parseWindowsEndpointProof(proof, native)
    return
  }
  const unix = unixRecord(record)
  const uid = process.getuid?.(); executionAssert(uid === unix.uid, 'run_control_foreign')
  await privatePath(unix.directory, 'directory', unix.uid)
  const current = parseRecord(JSON.parse((await readPrivate(path.join(unix.directory, 'control.json'), unix.uid)).toString('utf8')))
  executionAssert(isUnixRecord(current) && executionHash(current) === executionHash(unix) &&
    unix.socketPath === path.join(unix.directory, 'control.sock'), 'run_control_changed')
  const socket = await privatePath(unix.socketPath, 'socket', unix.uid)
  executionAssert(socket.dev === unix.socketDevice && socket.ino === unix.socketInode, 'run_control_changed')
  executionAssert(executionHash(await readUnixProcessIdentity(unix.process.pid)) === executionHash(unix.process), 'run_owner_stale')
}
const signature = (secret: Buffer, value: unknown) => createHmac('sha256', secret).update(canonicalExecutionJSON(value)).digest('hex')
function authentic(secret: Buffer, value: unknown, mac: unknown): boolean {
  return typeof mac === 'string' && /^[a-f0-9]{64}$/.test(mac) && timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(signature(secret, value), 'hex'))
}
function readFrame(socket: Socket, timeout: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0)
    const finish = (error?: Error, result?: unknown) => {
      clearTimeout(timer); socket.off('data', data); socket.off('error', failure); socket.off('end', ended)
      if (error) reject(error); else resolve(result)
    }
    const failure = () => finish(new Error('run_control_disconnected'))
    const ended = () => finish(new Error('run_control_disconnected'))
    const data = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length > MAX_FRAME) { finish(new Error('run_control_frame_too_large')); socket.destroy(); return }
      const newline = bytes.indexOf(10)
      if (newline < 0) return
      try {
        executionAssert(newline === bytes.length - 1, 'run_control_invalid')
        finish(undefined, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline))))
      } catch { finish(new Error('run_control_invalid')); socket.destroy() }
    }
    const timer = setTimeout(() => { finish(new Error('run_control_timeout')); socket.destroy() }, timeout)
    socket.on('data', data); socket.once('error', failure); socket.once('end', ended)
  })
}
function writeFrame(socket: Socket, value: unknown): void {
  const bytes = canonicalExecutionJSON(value) + '\n'; executionAssert(Buffer.byteLength(bytes) <= MAX_FRAME, 'run_control_frame_too_large')
  socket.write(bytes)
}
async function runOwnerRetired(record: RunControlRecord, deadline = Date.now() + MAX_OPERATION_MS): Promise<boolean> {
  if (process.platform === 'win32') {
    const native = windowsRecord(record), state = await windowsCompositionFor(native, deadline)
    return (await state.broker.request('runStateOwnerRetired', {
      stateId: state.stateId, directory: native.directory,
    }, deadline) as { retired: boolean }).retired
  }
  const unix = unixRecord(record)
  let live = true
  try { live = executionHash(await readUnixProcessIdentity(unix.process.pid)) === executionHash(unix.process) }
  catch (error) { if (executionRecord(error).code === 'ENOENT' || executionRecord(error).code === 'ESRCH') live = false }
  const endpoint = await lstat(unix.socketPath).catch((error: unknown) => {
    if (executionRecord(error).code === 'ENOENT') return null; throw error
  })
  if (endpoint) executionAssert(endpoint.dev === unix.socketDevice && endpoint.ino === unix.socketInode && endpoint.uid === unix.uid, 'run_control_foreign')
  return !live && endpoint === null
}
async function observeRunOwnerRetired(record: RunControlRecord, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await runOwnerRetired(record, deadline)) return true
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))))
  }
  return false
}
/** Read-only, exact-run stop retry. An archive never regains execution authority. */
export async function readOpenCodeV2RunStop(record: RunControlRecord,
  deadline = Date.now() + MAX_OPERATION_MS): Promise<Extract<RunControlResult, { kind: 'stop' }> | null> {
  if (process.platform === 'win32') {
    const native = windowsRecord(record), state = await windowsCompositionFor(native, deadline)
    const value = await state.broker.request('runStateReadStop', {
      stateId: state.stateId, directory: native.directory, endpointHash: executionHash(record),
    }, deadline) as { absent?: true; receipt?: unknown }
    if (value.absent === true) return null
    const receipt = parseWindowsStopReceipt(value.receipt)
    const retired = await observeRunOwnerRetired(record, deadline)
    executionAssert(receipt.ownerRetired !== true || retired, 'run_control_invalid')
    return { ...receipt, state: receipt.state === 'stopped' && retired ? 'stopped' : 'cleanup_unknown', ownerRetired: retired }
  }
  const unix = unixRecord(record)
  await privatePath(unix.directory, 'directory', unix.uid)
  const current = parseRecord(JSON.parse((await readPrivate(path.join(unix.directory, 'control.json'), unix.uid)).toString('utf8')))
  executionAssert(isUnixRecord(current) && executionHash(current) === executionHash(unix), 'run_control_changed')
  let archive: Record<string, unknown>
  try { archive = executionRecord(JSON.parse((await readPrivate(path.join(unix.directory, 'stop.json'), unix.uid)).toString('utf8'))) }
  catch (error) { if (executionRecord(error).code === 'ENOENT') return null; throw error }
  keys(archive, ['binding', 'receipt'])
  const tombstone = executionRecord(JSON.parse((await readPrivate(path.join(unix.directory, 'tombstone.json'), unix.uid)).toString('utf8')))
  executionAssert(executionHash(archive.binding) === executionHash(unix.binding) && executionHash(tombstone.binding) === executionHash(unix.binding), 'run_control_foreign')
  const receipt = executionRecord(archive.receipt)
  executionAssert(receipt.kind === 'stop' && (receipt.state === 'stopped' || receipt.state === 'cleanup_unknown') && Array.isArray(receipt.members) && receipt.members.length <= 32, 'run_control_invalid')
  const result = receipt as Extract<RunControlResult, { kind: 'stop' }>
  const retired = await runOwnerRetired(record, deadline)
  return { ...result, state: result.state === 'stopped' && retired ? 'stopped' : 'cleanup_unknown', ownerRetired: retired }
}
/** Endpoint publication precedes native initialization. Observe only this authenticated
 * original owner until its original member is ready; this never submits or replaces input. */
export function isTransientOpenCodeV2ControlRead(error: unknown): boolean {
  return error instanceof Error && (error.message === 'run_control_timeout' || error.message === 'run_control_disconnected' ||
    error.message === 'run_control_timeout:read:995' || error.message === 'run_control_disconnected:read:109')
}
export async function awaitOpenCodeV2RunMemberReadiness(record: RunControlRecord,
  target: Pick<RunMemberStatus, 'memberId' | 'originalSessionId' | 'selectedModel' | 'selectedVariant' | 'pin'>,
  timeoutMs = OPEN_CODE_V2_RUN_INITIALIZATION_MS): Promise<RunMemberStatus | null> {
  executionAssert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= OPEN_CODE_V2_RUN_INITIALIZATION_MS, 'run_control_invalid')
  const deadline = Math.min(record.deadline, Date.now() + timeoutMs)
  while (Date.now() < deadline) {
    let status: RunControlResult
    try { status = await requestOpenCodeV2Run(record, { operation: 'status' },
      Math.min(process.platform === 'win32' ? MAX_OPERATION_MS : 5000, deadline - Date.now())) }
    catch (error) {
      // Authentication and framing share this budget. Expiry can close the
      // final read before a reply; expiry never authorizes input submission.
      if (Date.now() >= deadline) return null
      if (!isTransientOpenCodeV2ControlRead(error)) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
      continue
    }
    if (status.kind !== 'status' || status.deadline !== record.deadline) throw new Error('run_readiness_changed')
    const matches = status.members.filter(member => member.memberId === target.memberId)
    const member = matches[0]
    executionAssert(matches.length === 1 && member && member.originalSessionId === target.originalSessionId &&
      member.opencodeSessionId === target.originalSessionId && member.runtimeSessionId === target.originalSessionId &&
      member.selectedModel === target.selectedModel && member.selectedVariant === target.selectedVariant &&
      member.pin === target.pin, 'run_readiness_changed')
    if (status.state === 'active') {
      executionAssert(member.state === 'accepted' && member.bootstrap?.verified === true &&
        member.bootstrap.missingNativeMessageID === true && member.runtimePid !== undefined, 'run_readiness_unknown')
      return Date.now() < deadline ? member : null
    }
    if (status.state !== 'starting') return null
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
  }
  return null
}

export async function requestOpenCodeV2Run(record: RunControlRecord, request: RunControlRequest, timeoutMs = MAX_OPERATION_MS): Promise<RunControlResult> {
  request = parseRunControlRequest(request)
  executionAssert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_OPERATION_MS, 'run_control_invalid')
  const cleanup = request.operation === 'stop' || request.operation === 'status'
  const deadline = Math.min(Date.now() + timeoutMs, record.deadline + (cleanup ? MAX_OPERATION_MS : 0))
  if (process.platform === 'win32') {
    const native = windowsRecord(record)
    if (request.operation === 'stop') {
      const archived = await readOpenCodeV2RunStop(record, deadline)
      if (archived) return archived
    }
    executionAssert(deadline > Date.now(), 'run_deadline_expired')
    const state = await windowsCompositionFor(native, deadline)
    await validateEndpoint(record, deadline, state)
    const client = parseWindowsIdentity(await state.broker.request('runStateProcessIdentity', { pid: process.pid }, deadline))
    executionAssert(client.appContainer === false, 'run_process_appcontainer')
    executionAssert(deadline > Date.now(), 'run_deadline_expired')
    const payload = { protocol: 1, binding: native.binding, endpoint: executionHash(record),
      client, nonce: randomBytes(32).toString('hex'), deadline, request }
    // The fresh caller identity is measured here and independently compared by
    // native pipe peer proofs. It never borrows the published server PID.
    const received = await state.broker.request('runStateRequest', {
      stateId: state.stateId, directory: native.directory, endpointHash: payload.endpoint,
      payload, timeoutMs: Math.max(1, deadline - Date.now()),
    }, deadline) as { response: unknown }
    const response = executionRecord(received.response)
    executionAssert(response.nonce === payload.nonce && response.endpoint === payload.endpoint, 'run_control_foreign')
    if (response.error !== undefined) throw new Error(string(response.error))
    const value = executionRecord(response.result)
    executionAssert(value.kind === request.operation || (value.kind === 'send_refused' &&
      (request.operation === 'send' || request.operation === 'observe' && request.intent !== undefined)), 'run_control_invalid')
    if (value.kind === 'stop') {
      const stop = value as Extract<RunControlResult, { kind: 'stop' }>
      const archived = await readOpenCodeV2RunStop(record, deadline)
      executionAssert(archived !== null && sameStopReceipt(stop, archived), 'run_control_invalid')
      return archived
    }
    await validateEndpoint(record, deadline, state)
    return value as RunControlResult
  }
  const unix = unixRecord(record)
  if (request.operation === 'stop') {
    const archived = await readOpenCodeV2RunStop(unix, deadline)
    if (archived?.ownerRetired) return archived
  }
  executionAssert(deadline > Date.now(), 'run_deadline_expired')
  await validateEndpoint(unix)
  const secret = await readPrivate(path.join(unix.directory, 'challenge'), unix.uid)
  executionAssert(secret.length === 32, 'run_control_invalid')
  const payload = { protocol: 1, binding: unix.binding, endpoint: executionHash(unix),
    client: await readUnixProcessIdentity(), nonce: randomBytes(32).toString('hex'), deadline, request }
  const socketDirectory = await openSocketDirectory(unix.directory, unix.uid)
  let socket: Socket | undefined
  try {
    await validateEndpoint(unix)
    const connected = socketDirectory.connect()
    socket = connected
    const response = readFrame(connected, Math.max(1, deadline - Date.now()))
    connected.once('connect', () => { try { writeFrame(connected, { payload, mac: signature(secret, payload) }) } catch { connected.destroy() } })
    const frame = executionRecord(await response); keys(frame, ['payload', 'mac'])
    executionAssert(authentic(secret, frame.payload, frame.mac), 'run_control_foreign')
    const result = executionRecord(frame.payload)
    executionAssert(result.nonce === payload.nonce && result.endpoint === payload.endpoint, 'run_control_foreign')
    if (result.error !== undefined) throw new Error(string(result.error))
    const value = executionRecord(result.result)
    // The result comes only from the authenticated typed owner; it carries
    // public receipts, never reconstructible ExecutionLease authority.
    executionAssert(value.kind === request.operation || (value.kind === 'send_refused' &&
      (request.operation === 'send' || request.operation === 'observe' && request.intent !== undefined)), 'run_control_invalid')
    if (value.kind === 'stop') {
      const stop = value as Extract<RunControlResult, { kind: 'stop' }>
      // Native cleanup receipts and source supervisor retirement are distinct.
      // Measure the latter from the same birth and socket; never PID-kill.
      while (Date.now() < deadline) {
        if (await runOwnerRetired(unix, deadline)) return { ...stop, ownerRetired: true }
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
      }
      return { ...stop, state: 'cleanup_unknown', ownerRetired: false }
    }
    await validateEndpoint(unix)
    return value as RunControlResult
  } finally {
    try {
      if (socket && !socket.closed) {
        const connected = socket
        const closed = new Promise<void>(resolve => connected.once('close', () => resolve()))
        connected.destroy(); await closed
      }
    } finally { await socketDirectory.fd.close() }
  }
}
async function serveWindowsRunControl(directory: string, binding: RunBinding, deadline: number, sourceSha256: string,
  execute: (request: RunControlRequest, deadline: number) => Promise<RunControlResult>,
  profiles: readonly SelectedExecutionProfile[] = []): Promise<{ record: RunControlRecord; close(): Promise<void> }> {
  executionAssert(profiles.length > 0, 'run_control_selection_missing')
  const admittedProfiles = Object.freeze(profiles.map(windowsProfileAdmission))
  const state = await windowsComposition(directory, {
    mode: 'serve', dataRoot: windowsDataRoot(directory), binding, profiles: admittedProfiles,
  })
  // Capture the first terminal pump failure even when it precedes the listen ACK.
  // This is diagnostic only: no retry, request result, or authority changes.
  let pumpFailureRecorded = false
  const onPumpFailure = (event: unknown) => {
    if (pumpFailureRecorded) return
    if (!event || typeof event !== 'object' || Array.isArray(event)) return
    const value = event as Record<string, unknown>
    const codes: readonly unknown[] = ['cleanup_unknown', 'run_control_accept_timeout', 'run_control_accept_unknown', 'run_control_connect_unknown', 'run_control_connection_limit', 'run_control_disconnected', 'run_control_endpoint_changed', 'run_control_foreign', 'run_control_frame_invalid', 'run_control_frame_oversize', 'run_control_held_identity', 'run_control_held_inputs', 'run_control_hmac_unknown', 'run_control_image_changed', 'run_control_image_hash', 'run_control_listen_unknown', 'run_control_owner_identity', 'run_control_package_peer_identity', 'run_control_parent_birth', 'run_control_parent_join', 'run_control_path_alias', 'run_control_peer_identity', 'run_control_pipe_name', 'run_control_pipe_security', 'run_control_process_identity', 'run_control_pump_unknown', 'run_control_read_unknown', 'run_control_timeout', 'run_control_write_partial', 'run_control_write_unknown', 'run_process_changed', 'run_state_acl_unknown', 'run_state_challenge_changed', 'run_state_challenge_unknown', 'run_state_endpoint_changed', 'run_state_endpoint_missing', 'run_state_held_inputs', 'run_state_identity_changed', 'run_state_record_absent', 'run_state_record_changed', 'run_state_record_collision', 'run_state_record_encoding', 'run_state_record_name', 'run_state_record_read', 'run_state_record_rename', 'run_state_record_size', 'run_state_record_temporary', 'run_state_record_unknown', 'run_state_record_write', 'run_state_start_changed', 'run_state_unknown']
    const phases = ['accept_wait', 'accept_authenticate', 'accept_replenish', 'read_frame',
      'verify_frame', 'validate_payload', 'publish_request']
    if (typeof value.phase !== 'string' || !phases.includes(value.phase) ||
      !codes.includes(value.code) || !Number.isSafeInteger(value.nativeCode) ||
      Number(value.nativeCode) < 0 || Number(value.nativeCode) > 0xffffffff) return
    pumpFailureRecorded = true
    void writeRunControlFile(directory, 'operation-failure.json', {
      schemaVersion: 1, event: 'opencode_v2_run_control_failure', binding,
      category: 'run_control_pump_failed',
      controlPhase: value.phase, controlCode: value.code, nativeCode: value.nativeCode,
      timestamp: new Date().toISOString(),
    }).catch(() => {})
  }
  state.broker.events.on('runControlFailure', onPumpFailure)
  const record = await (async () => {
    try {
      const listened = await state.broker.request('runStateListen', {
        stateId: state.stateId, directory, binding, deadline, sourceSha256,
      }, Date.now() + MAX_OPERATION_MS) as { record: unknown }
      const record = parseRecord(listened.record), native = windowsRecord(record)
      executionAssert(executionHash(native.binding) === executionHash(binding) && native.directory === directory, 'run_control_foreign')
      return record
    } catch (error) {
      state.broker.events.off('runControlFailure', onPumpFailure)
      throw error
    }
  })()
  const native = windowsRecord(record), usedNonces = new OpenCodeV2RunNonces()
  // Native serving ACK plus parseRecord validation publishes the only retained
  // record/profile comparison state used by later member preflight.
  state.serving = Object.freeze({
    record: native,
    profiles: admittedProfiles,
  })
  const active = new Set<Promise<void>>()
  const onRequest = (event: unknown) => {
    const task = (async () => {
      const envelope = executionRecord(event)
      keys(envelope, ['connection', 'payload'])
      const connection = string(envelope.connection), payload = executionRecord(envelope.payload)
      keys(payload, ['protocol', 'binding', 'endpoint', 'client', 'nonce', 'deadline', 'request'])
      const request = parseRunControlRequest(payload.request)
      const requestDeadline = integer(payload.deadline)
      // Native measurement, endpoint/root validation and HMAC verification
      // completed before this event. Replay/deadline policy remains authoritative.
      executionAssert(payload.protocol === 1 && executionHash(payload.binding) === executionHash(binding) &&
        payload.endpoint === executionHash(native) && parseWindowsIdentity(payload.client).appContainer === false &&
        requestDeadline > Date.now() && requestDeadline <= deadline + (request.operation === 'stop' || request.operation === 'status' ? MAX_OPERATION_MS : 0), 'run_deadline_expired')
      usedNonces.claim(string(payload.nonce), requestDeadline, request.operation, Date.now())
      let result: RunControlResult | undefined, error: string | undefined
      try { result = await execute(request, requestDeadline) }
      catch (failure) {
        error = 'run_operation_unknown'
        try {
          const codes = ['mutable_readback', 'run_mutable_cut', 'run_operation_timeout', 'run_not_active', 'session_selection_changed', 'terminal_cut_not_owned',
            'terminal_cut_unknown', 'terminal_assistant_selection_changed', 'terminal_authority_conflict',
            'terminal_payload_conflict', 'payload_conflict', 'probe_terminal_cut_changed',
            'probe_observed_model_variant_changed', 'probe_expected_output_not_observed',
            'probe_selected_auth_changed', 'probe_selected_authority_changed', 'probe_profile_authority_changed',
            'probe_config_readback_unavailable', 'execution_selected_auth_changed', 'execution_profile_changed'] as const
          const category = failure instanceof Error ? codes.find(code => code === failure.message) ?? 'unclassified' : 'unclassified'
          await writeRunControlFile(directory, 'operation-failure.json', {
            schemaVersion: 1, event: 'opencode_v2_run_operation_failure', binding,
            operation: request.operation, category, timestamp: new Date().toISOString(),
          })
        } catch { /* Diagnostic failure cannot change the existing operation result. */ }
      }
      const response = { nonce: payload.nonce, endpoint: payload.endpoint, ...(error ? { error } : { result }) }
      await state.broker.request('runStateRespond', {
        stateId: state.stateId, directory, connection, response,
        timeoutMs: Math.max(1, Math.min(requestDeadline, Date.now() + MAX_OPERATION_MS) - Date.now()),
      }, Math.min(requestDeadline, Date.now() + MAX_OPERATION_MS))
    })().catch(async () => {
      const envelope = executionRecord(event)
      await state.broker.request('runStatePoisonConnection', {
        stateId: state.stateId, directory, connection: string(envelope.connection),
      }, Date.now() + 5000).catch(() => {})
    }).finally(() => { active.delete(task) })
    active.add(task)
  }
  state.broker.events.on('runControlRequest', onRequest)
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    state.broker.events.off('runControlRequest', onRequest)
    state.broker.events.off('runControlFailure', onPumpFailure)
    try { await Promise.allSettled(active) }
    finally {
      let refusal: unknown
      try {
        const closed = await state.broker.request('runStateClose', {
          stateId: state.stateId, directory,
        }, Date.now() + MAX_OPERATION_MS) as { shutdown?: unknown; complete?: unknown; cleanupUnknown?: unknown; success?: unknown }
        executionAssert(closed.shutdown === true && closed.complete === true &&
          closed.cleanupUnknown === false && closed.success === true, 'run_control_cleanup_unknown')
      } catch (error) { refusal = error }
      try { await state.broker.close() } finally { windowsRuns.delete(directory) }
      if (refusal) throw refusal
    }
  })()
  return { record, close }
}
export async function serveOpenCodeV2RunControl(directory: string, binding: RunBinding, deadline: number, sourceSha256: string,
  execute: (request: RunControlRequest, deadline: number) => Promise<RunControlResult>,
  profiles: readonly SelectedExecutionProfile[] = []): Promise<{ record: RunControlRecord; close(): Promise<void> }> {
  if (process.platform === 'win32') return serveWindowsRunControl(directory, binding, deadline, sourceSha256, execute, profiles)
  const uid = process.getuid?.(); executionAssert(uid !== undefined, 'run_source_linux_required')
  await privatePath(directory, 'directory', uid)
  const start = executionRecord(JSON.parse((await readPrivate(path.join(directory, 'start.json'), uid)).toString('utf8')))
  executionAssert(executionHash(start.binding) === executionHash(binding) && start.sourceSha256 === sourceSha256, 'run_control_foreign')
  const secret = await readPrivate(path.join(directory, 'challenge'), uid); executionAssert(secret.length === 32, 'run_control_invalid')
  const socketPath = path.join(directory, 'control.sock')
  const existingSocket = await lstat(socketPath).catch((error: unknown) => {
    if (executionRecord(error).code === 'ENOENT') return null; throw error
  })
  executionAssert(existingSocket === null, 'run_control_foreign')
  const socketDirectory = await openSocketDirectory(directory, uid)
  const sockets = new Set<Socket>(), usedNonces = new OpenCodeV2RunNonces()
  let record: RunControlRecord | undefined
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    void (async () => {
      const frame = executionRecord(await readFrame(socket, Math.min(MAX_OPERATION_MS, Math.max(1, deadline + MAX_OPERATION_MS - Date.now()))))
      keys(frame, ['payload', 'mac']); executionAssert(authentic(secret, frame.payload, frame.mac), 'run_control_foreign')
      const payload = executionRecord(frame.payload)
      keys(payload, ['protocol', 'binding', 'endpoint', 'client', 'nonce', 'deadline', 'request'])
      executionAssert(record && payload.protocol === 1 && executionHash(payload.binding) === executionHash(binding) && payload.endpoint === executionHash(record), 'run_control_foreign')
      const nonce = string(payload.nonce), requestDeadline = integer(payload.deadline)
      const request = parseRunControlRequest(payload.request)
      const cleanup = request.operation === 'stop' || request.operation === 'status'
      executionAssert(requestDeadline > Date.now() && requestDeadline <= deadline + (cleanup ? MAX_OPERATION_MS : 0) && requestDeadline - Date.now() <= MAX_OPERATION_MS, 'run_control_timeout')
      const client = parseIdentity(payload.client)
      executionAssert(client.executablePath === record.process.executablePath && client.executableSha256 === record.process.executableSha256 &&
        executionHash(await readUnixProcessIdentity(client.pid)) === executionHash(client), 'run_control_foreign')
      // Recheck the signed deadline after peer measurement. Expired frames
      // cannot regain authority merely because replay history was pruned.
      usedNonces.claim(nonce, requestDeadline, request.operation, Date.now())
      let result: RunControlResult | undefined, error: string | undefined
      try { result = await execute(request, requestDeadline) }
      catch (failure) {
        error = 'run_operation_unknown'
        // This original-run diagnostic is private; the signed public error stays unknown.
        try {
          const codes = ['mutable_readback', 'run_mutable_cut', 'run_operation_timeout', 'run_not_active', 'session_selection_changed', 'terminal_cut_not_owned',
            'terminal_cut_unknown', 'terminal_assistant_selection_changed', 'terminal_authority_conflict',
            'terminal_payload_conflict', 'payload_conflict', 'probe_terminal_cut_changed',
            'probe_observed_model_variant_changed', 'probe_expected_output_not_observed',
            'probe_selected_auth_changed', 'probe_selected_authority_changed', 'probe_profile_authority_changed',
            'probe_config_readback_unavailable', 'execution_selected_auth_changed', 'execution_profile_changed'] as const
          const category = failure instanceof Error ? codes.find(code => code === failure.message) ?? 'unclassified' : 'unclassified'
          await writeRunControlFile(directory, 'operation-failure.json', {
            schemaVersion: 1, event: 'opencode_v2_run_operation_failure', binding,
            operation: request.operation, category, timestamp: new Date().toISOString(),
          })
        } catch { /* Diagnostic failure cannot change the existing operation result. */ }
      }
      const response = { nonce, endpoint: payload.endpoint, ...(error ? { error } : { result }) }
      writeFrame(socket, { payload: response, mac: signature(secret, response) }); socket.end()
    })().catch(() => socket.destroy())
  })
  let ownedSocket: { dev: number; ino: number } | undefined
  let closing: Promise<void> | undefined
  const closeOnce = async () => {
    let refusal: unknown
    try {
      try {
        await socketDirectory.assertCurrent()
        const before = await lstat(socketPath).catch((error: unknown) => {
          if (executionRecord(error).code === 'ENOENT') return null; throw error
        })
        if (before) executionAssert(ownedSocket && before.isSocket() && before.uid === uid &&
          before.dev === ownedSocket.dev && before.ino === ownedSocket.ino, 'run_control_foreign')
      } catch (error) { refusal = error }
      // The supported Bun listener closes independently of the pathname. Keep
      // its directory FD held until listener and accepted sockets have drained.
      const drained = [...sockets].map(socket => socket.closed ? Promise.resolve() :
        new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.destroy() }))
      try {
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      } catch (error) { refusal ??= error }
      await Promise.all(drained)
      if (!refusal) {
        try {
          await socketDirectory.assertCurrent()
          const current = await lstat(socketPath).catch((error: unknown) => {
            if (executionRecord(error).code === 'ENOENT') return null; throw error
          })
          if (current) {
            executionAssert(ownedSocket && current.isSocket() && current.uid === uid &&
              current.dev === ownedSocket.dev && current.ino === ownedSocket.ino, 'run_control_foreign')
            await unlink(socketPath)
          }
        } catch (error) { refusal = error }
      }
      if (refusal) throw refusal
    } finally { await socketDirectory.fd.close() }
  }
  const close = () => closing ??= closeOnce()
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); socketDirectory.listen(server, () => { server.off('error', reject); resolve() }) })
    // Capture ownership immediately after bind, before publication or slow birth hashing.
    const bound = await lstat(socketPath)
    executionAssert(bound.isSocket() && bound.uid === uid, 'run_control_foreign')
    ownedSocket = { dev: bound.dev, ino: bound.ino }
    await socketDirectory.assertCurrent()
    await chmod(socketPath, 0o600)
    const stat = await privatePath(socketPath, 'socket', uid)
    executionAssert(stat.dev === ownedSocket.dev && stat.ino === ownedSocket.ino, 'run_control_changed')
    record = { schema: 1, protocol: 1, binding, process: await readUnixProcessIdentity(), directory, socketPath,
      socketDevice: stat.dev, socketInode: stat.ino, deadline, uid, sourceSha256 }
    await socketDirectory.assertCurrent()
    await writeRunControlFile(directory, 'control.json', record)
    // control/start/tombstone/outcome remain durable. No stale takeover.
    return { record, close }
  } catch (error) {
    try { await close() } catch { throw new Error('run_control_cleanup_unknown') }
    throw error
  }
}
