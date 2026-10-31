import { parseOpenCodeV2GroupDelivery } from './OpenCodeV2GroupChat.js'
import { openCodeBunVersion } from '../../../constants/openCodeBunVersion.js'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import path from 'node:path'
import { canonicalExecutionJSON, executionAssert, executionHash, executionRecord, assertIntentIdentity, openCodeV2RunInitializationMs, type ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'
import type { ExecutionMention } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import type { RunAnyProcessIdentity, RunBinding, RunControlRecord, RunControlRequest, RunControlResult, RunMemberStatus, RunOwnerFailure, RunOwnerRetirement, RunProcessIdentity, RunStopMember, RunUnixControlRecord } from './OpenCodeV2RunTypes.js'
import type { ExecutionBirth, SelectedExecutionProfile } from '../host/OpenCodeV2ExecutionBinding.js'
import { readProcessStartTimeMs } from '../../../utils/processKill.js'
import { OpenCodeV2RunNonces } from './OpenCodeV2RunNonces.js'
import { retainedControllerPath } from './OpenCodeV2ControllerTools.js'
export type { RunBinding, RunControlRecord, RunControlRequest, RunControlResult, RunLaunchPlan } from './OpenCodeV2RunTypes.js'

const MAX_RECORD = 512 * 1024
// Frames carry full control replies and share the broker packet budget.
const MAX_FRAME = 16 * 1024 * 1024
// Graph preparation and native startup share one absolute budget. Individual
// control operations remain capped at 30s; cleanup stop/status extend to 45s.
export const OPEN_CODE_V2_RUN_INITIALIZATION_MS = openCodeV2RunInitializationMs(process.platform)
const MAX_OPERATION_MS = 30_000
const MAX_STOP_OPERATION_MS = 45_000
// A lost stop reply is confirmed once from the durable archive within this window.
const STOP_RECONCILE_MS = 10_000
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const WINDOWS = process.platform === 'win32'
/** Windows has no uid, mode bits or pathname sockets: the run control files live in
 * the user's own profile and the endpoint is loopback TCP. Every request is still
 * authenticated with the private challenge secret. */
const currentUid = (): number => {
  if (WINDOWS) return 0
  const uid = process.getuid?.(); executionAssert(uid !== undefined, 'run_source_unix_required'); return uid
}
const unixRecord = (record: RunControlRecord): RunUnixControlRecord => record
const tcpEndpoint = (port: number) => `tcp://127.0.0.1:${port}`
function endpointPort(socketPath: string): number {
  const match = /^tcp:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(socketPath)
  executionAssert(match && Number(match[1]) <= 65535, 'run_control_invalid')
  return Number(match[1])
}
/** Windows reads only PID and start time of another process; the HMAC secret authenticates it. */
function sameRunProcess(left: RunProcessIdentity, right: RunProcessIdentity): boolean {
  return WINDOWS ? left.pid === right.pid && left.startTicks === right.startTicks : executionHash(left) === executionHash(right)
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
  if (WINDOWS) {
    executionAssert(Number.isSafeInteger(pid) && pid > 0, 'run_process_unknown')
    const started = await readProcessStartTimeMs(pid)
    if (started === null) throw Object.assign(new Error('run_process_unknown'), { code: 'ESRCH' })
    const self = pid === process.pid, executablePath = self ? await realpath(process.execPath) : 'windows-process'
    return { pid, startTicks: String(started), bootId: 'windows', executablePath,
      executableSha256: self ? digest(await readFile(executablePath)) : '0'.repeat(64) }
  }
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
  return readUnixProcessIdentity(pid)
}
function parseRecord(value: unknown): RunControlRecord {
  const row = executionRecord(value)
  keys(row, ['schema', 'protocol', 'binding', 'process', 'directory', 'socketPath', 'socketDevice', 'socketInode', 'deadline', 'uid', 'sourceSha256'])
  executionAssert(row.schema === 1 && row.protocol === 1, 'run_control_invalid')
  return { schema: 1, protocol: 1, binding: parseRunBinding(row.binding), process: parseIdentity(row.process),
    directory: string(row.directory), socketPath: string(row.socketPath), socketDevice: integer(row.socketDevice), socketInode: integer(row.socketInode),
    deadline: integer(row.deadline), uid: integer(row.uid), sourceSha256: string(row.sourceSha256) }
}
// Either side may carry the late public downgrade; a proven archive keeps the proof.
export function sameStopReceipt(left: Extract<RunControlResult, { kind: 'stop' }>,
  right: Extract<RunControlResult, { kind: 'stop' }>): boolean {
  return executionHash(left.members) === executionHash(right.members) &&
    (left.state === right.state || left.state === 'stopped' && right.state === 'cleanup_unknown' &&
      right.ownerRetired === false || left.state === 'cleanup_unknown' && right.state === 'stopped')
}
function parseUnixStopReceipt(value: unknown): Extract<RunControlResult, { kind: 'stop' }> {
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
      executionAssert(row.scopeClosed === true && row.processRetired === true && typeof row.descendantsRetired === 'boolean' &&
        integer(row.pid) > 0 && ['linux-start-ticks', 'darwin-pidversion', 'windows-filetime', 'utc-ms'].includes(String(birth.format)) &&
        (birth.bootId === null || typeof birth.bootId === 'string'), 'run_control_invalid')
      cleanup = { scopeClosed: true, processRetired: true, descendantsRetired: row.descendantsRetired, pid: integer(row.pid),
        birth: { format: String(birth.format) as ExecutionBirth['format'], value: string(birth.value),
          bootId: birth.bootId === null ? null : string(birth.bootId) } }
    }
    return { memberId: string(member.memberId), cleanup, errors: errors.map(string) }
  })
  executionAssert(receipt.state !== 'stopped' || members.length > 0 &&
    members.every(member => member.cleanup !== null && member.errors.length === 0), 'run_control_invalid')
  return { kind: 'stop', state: receipt.state, members }
}
function parseIntent(value: unknown): QueueIntent {
  const row = executionRecord(value); optionalKeys(row, ['identity', 'input', 'delivery'], ['group'])
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
  if (row.group !== undefined) {
    const group = parseOpenCodeV2GroupDelivery(executionRecord(row.group), typedIdentity.localMessageId)
    executionAssert(group && executionHash(group) === executionHash(row.group), 'GROUP_INVALID_ENVELOPE'); result.group = group
  }
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
  if (operation === 'transcript' || operation === 'permissions' || operation === 'mcp' || operation === 'probeEvidence' || operation === 'groupProof') {
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
  executionAssert(!stat.isSymbolicLink() && (WINDOWS || stat.uid === uid && (stat.mode & 0o077) === 0) &&
    (kind === 'directory' ? stat.isDirectory() : kind === 'socket' ? stat.isSocket() : stat.isFile() && stat.nlink === 1), 'run_control_foreign')
  return stat
}
/** POSIX transports address the held directory vnode, even for long durable paths.
 * Windows listens on loopback TCP; `port` selects the published endpoint for a client. */
async function openSocketDirectory(directory: string, uid: number, port?: number) {
  executionAssert(process.versions.bun === openCodeBunVersion(), 'run_source_bun_required')
  if (WINDOWS) {
    await privatePath(directory, 'directory', uid)
    return { fd: { close: async () => {} }, assertCurrent: async () => {},
      connect: () => { executionAssert(port !== undefined, 'run_control_invalid'); return createConnection({ host: '127.0.0.1', port }) },
      listen: (server: ReturnType<typeof createServer>, ready: () => void) => server.listen(0, '127.0.0.1', ready) }
  }
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
  const uid = currentUid()
  await privatePath(directory, 'directory', uid)
  const temporary = path.join(directory, `${name}.${randomUUID()}`), target = path.join(directory, name)
  const fd = await open(temporary, 'wx', 0o600)
  try { await fd.writeFile(canonicalExecutionJSON(value) + '\n'); await fd.sync() } finally { await fd.close() }
  await rename(temporary, target)
  if (!WINDOWS) { const parent = await open(directory, 'r'); try { await parent.sync() } finally { await parent.close() } }
}
/** Only explicit launch creates this non-expiring fence. Observe/stop never do. */
export async function reserveRunControlDirectory(dataRoot: string, binding: RunBinding, sourceSha256: string,
  profiles: readonly SelectedExecutionProfile[] = []): Promise<string> {
  const uid = currentUid(); executionAssert(await realpath(dataRoot) === dataRoot, 'run_control_foreign')
  const directory = runControlDirectory(dataRoot, binding.teamId, binding.runId)
  let parent = dataRoot
  for (const part of ['opencode', 'v2', 'runs']) {
    parent = path.join(parent, part)
    await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => { if (executionRecord(error).code !== 'EEXIST') throw error })
    if (part === 'opencode') {
      // V1's registry shares this ancestor and may create it as 0755. It holds
      // no V2 secrets; its namespace must remain owned and non-writable to others.
      const shared = await lstat(parent)
      executionAssert(shared.isDirectory() && !shared.isSymbolicLink() && (WINDOWS || shared.uid === uid &&
        (shared.mode & 0o022) === 0) && await realpath(parent) === parent, 'run_control_foreign')
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
  const uid = currentUid()
  try { await privatePath(directory, 'directory', uid) }
  catch (error) { if (executionRecord(error).code === 'ENOENT') return null; throw error }
  // An existing launch fence with no published endpoint remains UNKNOWN, not
  // permission for V1 fallback or a replacement supervisor.
  const record = parseRecord(JSON.parse((await readPrivate(path.join(directory, 'control.json'), uid)).toString('utf8')))
  const unix = unixRecord(record)
  executionAssert(unix.directory === directory && unix.binding.teamId === teamId && unix.binding.runId === runId && unix.uid === uid, 'run_control_foreign')
  return record
}
async function validateEndpoint(record: RunControlRecord): Promise<void> {
  const unix = unixRecord(record)
  const uid = currentUid(); executionAssert(uid === unix.uid, 'run_control_foreign')
  await privatePath(unix.directory, 'directory', unix.uid)
  const current = parseRecord(JSON.parse((await readPrivate(path.join(unix.directory, 'control.json'), unix.uid)).toString('utf8')))
  executionAssert(executionHash(current) === executionHash(unix) &&
    (WINDOWS ? tcpEndpoint(endpointPort(unix.socketPath)) === unix.socketPath : unix.socketPath === path.join(unix.directory, 'control.sock')), 'run_control_changed')
  if (!WINDOWS) {
    const socket = await privatePath(unix.socketPath, 'socket', unix.uid)
    executionAssert(socket.dev === unix.socketDevice && socket.ino === unix.socketInode, 'run_control_changed')
  }
  executionAssert(sameRunProcess(await readUnixProcessIdentity(unix.process.pid), unix.process), 'run_owner_stale')
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
async function runOwnerRetired(record: RunControlRecord, _deadline = Date.now() + MAX_OPERATION_MS): Promise<boolean> {
  const unix = unixRecord(record)
  let live = true
  try { live = sameRunProcess(await readUnixProcessIdentity(unix.process.pid), unix.process) }
  catch (error) { if (executionRecord(error).code === 'ENOENT' || executionRecord(error).code === 'ESRCH') live = false }
  // The TCP endpoint closes with its process; only POSIX leaves a pathname to check.
  if (WINDOWS) return !live
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
  const unix = unixRecord(record)
  await privatePath(unix.directory, 'directory', unix.uid)
  const current = parseRecord(JSON.parse((await readPrivate(path.join(unix.directory, 'control.json'), unix.uid)).toString('utf8')))
  executionAssert(executionHash(current) === executionHash(unix), 'run_control_changed')
  let archive: Record<string, unknown>
  try { archive = executionRecord(JSON.parse((await readPrivate(path.join(unix.directory, 'stop.json'), unix.uid)).toString('utf8'))) }
  catch (error) { if (executionRecord(error).code === 'ENOENT') return null; throw error }
  keys(archive, ['binding', 'receipt'])
  const tombstone = executionRecord(JSON.parse((await readPrivate(path.join(unix.directory, 'tombstone.json'), unix.uid)).toString('utf8')))
  executionAssert(executionHash(archive.binding) === executionHash(unix.binding) && executionHash(tombstone.binding) === executionHash(unix.binding), 'run_control_foreign')
  const receipt = parseUnixStopReceipt(archive.receipt)
  const retired = await runOwnerRetired(record, deadline)
  return { ...receipt, state: receipt.state === 'stopped' && retired ? 'stopped' : 'cleanup_unknown', ownerRetired: retired }
}
/** Kernel presence of the exact published process instance, without hashing its image.
 * 'absent' only when the kernel has no process for the PID; 'replaced' when another
 * instance or boot holds it. Access and query failures throw and stay UNKNOWN. */
async function readRunProcessPresence(identity: RunProcessIdentity): Promise<'same' | 'replaced' | 'absent'> {
  const pid = identity.pid
  executionAssert(Number.isSafeInteger(pid) && pid > 0, 'run_process_unknown')
  // Same rule as the identity read: Windows only reads the start time of another process.
  if (WINDOWS) {
    const started = await readProcessStartTimeMs(pid)
    return started === null ? 'absent' : String(started) === identity.startTicks ? 'same' : 'replaced'
  }
  if (process.platform === 'darwin') {
    const { dlopen, FFIType, ptr, toArrayBuffer } = await import('bun:ffi')
    const native = dlopen('/usr/lib/libSystem.B.dylib', {
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    })
    try {
      const info = Buffer.alloc(56), boot = Buffer.alloc(128), length = Buffer.alloc(8)
      length.writeBigUInt64LE(128n)
      if (native.symbols.proc_pidinfo(pid, 17, 0, ptr(info), info.length) !== info.length) {
        const pointer = native.symbols.__error()
        executionAssert(pointer !== null, 'run_process_unknown')
        if (new DataView(toArrayBuffer(pointer, 0, 4)).getInt32(0, true) === 3) return 'absent'
        throw Object.assign(new Error('run_process_unknown'), { code: 'EACCES' })
      }
      executionAssert(native.symbols.sysctlbyname(ptr(Buffer.from('kern.bootsessionuuid\0')), ptr(boot), ptr(length), null, 0) === 0, 'run_process_unknown')
      const bootId = boot.toString('utf8').split('\0')[0]!.toLowerCase()
      // The same unique process ID:PID version fields the identity read publishes.
      return bootId === identity.bootId && `${info.readBigUInt64LE(16)}:${info.readInt32LE(32)}` === identity.startTicks ? 'same' : 'replaced'
    } finally { native.close() }
  }
  executionAssert(process.platform === 'linux', 'run_source_linux_required')
  let stat: string
  try { stat = await readFile(`/proc/${pid}/stat`, 'utf8') }
  catch (error) {
    const code = executionRecord(error).code
    if (code !== 'ENOENT' && code !== 'ESRCH') throw error
    // A missing entry proves absence only while procfs itself answers.
    await readFile('/proc/self/stat', 'utf8'); return 'absent'
  }
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  executionAssert(startTicks && /^[0-9]+$/.test(startTicks), 'run_process_unknown')
  return bootId === identity.bootId && startTicks === identity.startTicks ? 'same' : 'replaced'
}
const providerStages = ['request', 'response', 'body', 'decode'] as const
export function parseOpenCodeV2RunOwnerFailure(value: unknown): RunOwnerFailure {
  const row = executionRecord(value); optionalKeys(row, ['category'], ['operation'])
  const category = row.category
  executionAssert(typeof category === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(category), 'run_control_invalid')
  if (row.operation === undefined) return { category }
  const operation = executionRecord(row.operation); keys(operation, ['operation', 'stage', 'status'])
  const name = operation.operation, stage = providerStages.find(value => value === operation.stage)
  const status = operation.status === null ? null : typeof operation.status === 'number' ? operation.status : Number.NaN
  executionAssert(typeof name === 'string' && /^[a-z][a-z-]{0,31}$/.test(name) && stage &&
    (status === null || Number.isSafeInteger(status) && status >= 100 && status <= 599), 'run_control_invalid')
  return { category, operation: { operation: name, stage, status } }
}
/** The owner's own closed initialization cause, written before its stop archive. */
async function readRunOwnerFailure(unix: RunUnixControlRecord): Promise<RunOwnerFailure | null> {
  let bytes: Buffer
  try { bytes = await readPrivate(path.join(unix.directory, 'owner-failure.json'), unix.uid) }
  catch (error) { if (executionRecord(error).code === 'ENOENT') return null; throw error }
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('run_control_invalid') }
  const row = executionRecord(value); keys(row, ['binding', 'failure'])
  executionAssert(executionHash(row.binding) === executionHash(unix.binding), 'run_control_foreign')
  return parseOpenCodeV2RunOwnerFailure(row.failure)
}
/** 'stopping': the same process is alive after publishing its tombstone. 'unproven': a
 * live owner without a tombstone, or a PID held by another process without the owner's
 * own retirement archive. */
async function inspectRunOwnerExit(record: RunControlRecord): Promise<RunOwnerRetirement | 'stopping' | 'unproven'> {
  const unix = unixRecord(record)
  await privatePath(unix.directory, 'directory', unix.uid)
  const current = parseRecord(JSON.parse((await readPrivate(path.join(unix.directory, 'control.json'), unix.uid)).toString('utf8')))
  executionAssert(executionHash(current) === executionHash(unix), 'run_control_changed')
  const presence = await readRunProcessPresence(unix.process)
  if (presence === 'same') {
    return await privatePath(path.join(unix.directory, 'tombstone.json'), 'file', unix.uid).then(() => 'stopping' as const,
      (error: unknown) => { if (executionRecord(error).code === 'ENOENT') return 'unproven' as const; throw error })
  }
  if (presence === 'replaced' && (await readOpenCodeV2RunStop(record))?.ownerRetired !== true) return 'unproven'
  // The cause is observational: an unreadable record never blocks a proven retirement.
  return { failure: await readRunOwnerFailure(unix).catch(() => null) }
}
/** Read-only proof that the exact original owner process is gone: the kernel has no
 * process for its PID, or its own stop archive proves retirement after the PID changed
 * hands. A live owner or a tombstone alone stays unretired; this never authenticates,
 * signals or replaces any process. */
export async function readOpenCodeV2RunOwnerRetirement(record: RunControlRecord): Promise<RunOwnerRetirement | null> {
  const inspected = await inspectRunOwnerExit(record)
  return typeof inspected === 'string' ? null : inspected
}
const ownerRetirements = new WeakMap<Error, RunOwnerRetirement>()
function ownerRetiredError(retirement: RunOwnerRetirement): Error {
  const error = new Error('run_owner_retired'); ownerRetirements.set(error, retirement); return error
}
/** Only an error minted here from a proven retirement carries the owner's closed cause. */
export function readOpenCodeV2RunOwnerRetiredError(error: unknown): RunOwnerRetirement | undefined {
  return error instanceof Error ? ownerRetirements.get(error) : undefined
}
/** Follow an owner that is leaving until its exit is proven, within the stop reconcile
 * window. `stopping` is the owner's own authenticated state. An unproven owner or an
 * unreadable proof returns null at once, so callers keep their previous result. */
async function awaitRunOwnerExit(record: RunControlRecord, deadline: number, stopping: boolean): Promise<RunOwnerRetirement | null> {
  const until = Math.min(deadline, Date.now() + STOP_RECONCILE_MS)
  while (Date.now() < until) {
    let inspected: Awaited<ReturnType<typeof inspectRunOwnerExit>>
    try { inspected = await inspectRunOwnerExit(record) } catch { return null }
    if (typeof inspected !== 'string') return inspected
    if (inspected === 'unproven' && !stopping) return null
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, until - Date.now()))))
  }
  return null
}
// Failures an exiting owner produces: a removed endpoint or file, an absent process,
// or an identity read that changed or failed between its two kernel reads.
const ownerExitMessages = new Set(['run_process_changed', 'run_process_unknown', 'run_owner_stale'])
async function classifyRunOwnerExit(record: RunControlRecord, failure: unknown, deadline: number): Promise<unknown> {
  const code = failure !== null && typeof failure === 'object' ? (failure as { code?: unknown }).code : undefined
  if (!(code === 'ENOENT' || code === 'ESRCH' || failure instanceof Error && ownerExitMessages.has(failure.message))) return failure
  // Only a proven exit replaces the original error; a PID held by another process
  // without the owner's own retirement archive stays a process change.
  const retirement = await awaitRunOwnerExit(record, deadline, false)
  return retirement ? ownerRetiredError(retirement) : failure
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
      Math.min(5000, deadline - Date.now())) }
    catch (error) {
      // Authentication and framing share this budget. Expiry can close the
      // final read before a reply; expiry never authorizes input submission.
      if (Date.now() >= deadline) return null
      if (!isTransientOpenCodeV2ControlRead(error)) throw await classifyRunOwnerExit(record, error, deadline)
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
    if (status.state !== 'starting') {
      // A stopping or stopped original never becomes ready; report its proven exit.
      const retirement = await awaitRunOwnerExit(record, deadline, true)
      if (retirement) throw ownerRetiredError(retirement)
      return null
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
  }
  return null
}

export async function requestOpenCodeV2Run(record: RunControlRecord, request: RunControlRequest, timeoutMs = MAX_OPERATION_MS): Promise<RunControlResult> {
  request = parseRunControlRequest(request)
  const cleanup = request.operation === 'stop' || request.operation === 'status'
  executionAssert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= (cleanup ? MAX_STOP_OPERATION_MS : MAX_OPERATION_MS), 'run_control_invalid')
  const deadline = Math.min(Date.now() + timeoutMs, record.deadline + (cleanup ? MAX_STOP_OPERATION_MS : 0))
  try {
    return await exchangeOpenCodeV2Run(record, request, deadline)
  } catch (failure) {
    // A stop whose reply was lost is confirmed once from the durable archive of
    // the same run; only a proven stopped archive replaces the failure and every
    // custody/validity refusal keeps its exact closed code.
    if (request.operation === 'stop' && isTransientOpenCodeV2ControlRead(failure))
      return confirmOpenCodeV2RunStop(record, failure, Date.now() + STOP_RECONCILE_MS)
    throw failure
  }
}
async function exchangeOpenCodeV2Run(record: RunControlRecord, request: RunControlRequest, deadline: number): Promise<RunControlResult> {
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
  const socketDirectory = await openSocketDirectory(unix.directory, unix.uid, WINDOWS ? endpointPort(unix.socketPath) : undefined)
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
// Custody and validity refusals met while confirming keep their exact closed code;
// native run-state refusals may carry a closed ':stage:code' suffix.
const STOP_CONFIRM_REFUSALS = new Set(['run_control_foreign', 'run_control_changed', 'run_control_invalid',
  'run_control_endpoint_changed', 'run_control_selection_missing'])
async function confirmOpenCodeV2RunStop(record: RunControlRecord, failure: unknown,
  deadline: number): Promise<Extract<RunControlResult, { kind: 'stop' }>> {
  // The attempt bound keeps the window finite even when the wall clock stalls.
  for (let attempt = 0; attempt <= STOP_RECONCILE_MS / 100; attempt += 1) {
    let archived: Extract<RunControlResult, { kind: 'stop' }> | null
    try { archived = await readOpenCodeV2RunStop(record, deadline) }
    catch (error) {
      const code = error instanceof Error ? error.message.split(':')[0]! : ''
      if (STOP_CONFIRM_REFUSALS.has(code) || code.startsWith('run_state_')) throw error
      break
    }
    if (archived?.state === 'stopped') return archived
    // A retired owner with a non-stopped receipt is terminal; an absent archive
    // or an unretired owner can still confirm within the window.
    if (archived?.ownerRetired === true || Date.now() >= deadline) break
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
  }
  throw failure
}
export async function serveOpenCodeV2RunControl(directory: string, binding: RunBinding, deadline: number, sourceSha256: string,
  execute: (request: RunControlRequest, deadline: number) => Promise<RunControlResult>,
  profiles: readonly SelectedExecutionProfile[] = []): Promise<{ record: RunControlRecord; close(): Promise<void> }> {
  void profiles
  const uid = currentUid()
  await privatePath(directory, 'directory', uid)
  const start = executionRecord(JSON.parse((await readPrivate(path.join(directory, 'start.json'), uid)).toString('utf8')))
  executionAssert(executionHash(start.binding) === executionHash(binding) && start.sourceSha256 === sourceSha256, 'run_control_foreign')
  const secret = await readPrivate(path.join(directory, 'challenge'), uid); executionAssert(secret.length === 32, 'run_control_invalid')
  const socketPath = path.join(directory, 'control.sock')
  const existingSocket = WINDOWS ? null : await lstat(socketPath).catch((error: unknown) => {
    if (executionRecord(error).code === 'ENOENT') return null; throw error
  })
  executionAssert(existingSocket === null, 'run_control_foreign')
  const socketDirectory = await openSocketDirectory(directory, uid)
  const sockets = new Set<Socket>(), usedNonces = new OpenCodeV2RunNonces()
  let record: RunControlRecord | undefined
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    void (async () => {
      // Frames stay readable through the extended cleanup window; the signed
      // deadline check below still refuses every other post-deadline operation.
      const frame = executionRecord(await readFrame(socket, Math.min(MAX_OPERATION_MS, Math.max(1, deadline + MAX_STOP_OPERATION_MS - Date.now()))))
      keys(frame, ['payload', 'mac']); executionAssert(authentic(secret, frame.payload, frame.mac), 'run_control_foreign')
      const payload = executionRecord(frame.payload)
      keys(payload, ['protocol', 'binding', 'endpoint', 'client', 'nonce', 'deadline', 'request'])
      executionAssert(record && payload.protocol === 1 && executionHash(payload.binding) === executionHash(binding) && payload.endpoint === executionHash(record), 'run_control_foreign')
      const nonce = string(payload.nonce), requestDeadline = integer(payload.deadline)
      const request = parseRunControlRequest(payload.request)
      const cleanup = request.operation === 'stop' || request.operation === 'status'
      executionAssert(requestDeadline > Date.now() && requestDeadline <= deadline + (cleanup ? MAX_STOP_OPERATION_MS : 0) && requestDeadline - Date.now() <= (cleanup ? MAX_STOP_OPERATION_MS : MAX_OPERATION_MS), 'run_control_timeout')
      const client = parseIdentity(payload.client)
      executionAssert(client.executablePath === record.process.executablePath && client.executableSha256 === record.process.executableSha256 &&
        sameRunProcess(await readUnixProcessIdentity(client.pid), client), 'run_control_foreign')
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
      if (!WINDOWS) try {
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
      if (!refusal && !WINDOWS) {
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
    if (WINDOWS) {
      const address = server.address()
      executionAssert(address !== null && typeof address === 'object' && address.address === '127.0.0.1', 'run_control_foreign')
      record = { schema: 1, protocol: 1, binding, process: await readUnixProcessIdentity(), directory, socketPath: tcpEndpoint(address.port),
        socketDevice: 0, socketInode: 0, deadline, uid, sourceSha256 }
      await writeRunControlFile(directory, 'control.json', record)
      return { record, close }
    }
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
