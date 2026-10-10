import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import path from 'node:path'
import { canonicalExecutionJSON, executionAssert, executionHash, executionRecord, assertIntentIdentity } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'
import type { ExecutionMention } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import type { RunBinding, RunControlRecord, RunControlRequest, RunControlResult, RunMemberStatus, RunProcessIdentity } from './OpenCodeV2RunTypes.js'
import { OpenCodeV2RunNonces } from './OpenCodeV2RunNonces.js'
export type { RunBinding, RunControlRecord, RunControlRequest, RunControlResult, RunLaunchPlan } from './OpenCodeV2RunTypes.js'

const MAX_FRAME = 512 * 1024
// Graph preparation and native startup share one absolute budget. Individual control operations remain capped at 30s.
export const OPEN_CODE_V2_RUN_INITIALIZATION_MS = 90_000
const MAX_OPERATION_MS = 30_000
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const keys = (row: Record<string, unknown>, names: readonly string[]) => executionAssert(
  Object.keys(row).sort().join(',') === [...names].sort().join(','), 'run_control_invalid')
function string(value: unknown): string {
  executionAssert(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'), 'run_control_invalid')
  return value
}
function integer(value: unknown): number {
  executionAssert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'run_control_invalid')
  return value
}
function optionalKeys(row: Record<string, unknown>, required: readonly string[], optional: readonly string[]): void {
  executionAssert(required.every(key => Object.hasOwn(row, key)) && Object.keys(row).every(key => [...required, ...optional].includes(key)), 'run_control_invalid')
}
function mention(value: unknown, length: number): ExecutionMention {
  const row = executionRecord(value); keys(row, ['start', 'end', 'text'])
  const start = integer(row.start), end = integer(row.end)
  executionAssert(end >= start && end <= length && typeof row.text === 'string', 'run_control_invalid')
  return { start, end, text: row.text }
}
function array(value: unknown): unknown[] {
  executionAssert(Array.isArray(value) && value.length <= 64, 'run_control_invalid'); return value
}
export function parseRunBinding(value: unknown): RunBinding {
  const row = executionRecord(value); keys(row, ['teamId', 'runId', 'controllerInstanceId', 'ownerId'])
  return { teamId: string(row.teamId), runId: string(row.runId), controllerInstanceId: string(row.controllerInstanceId), ownerId: string(row.ownerId) }
}
function parseIdentity(value: unknown): RunProcessIdentity {
  const row = executionRecord(value); keys(row, ['pid', 'startTicks', 'bootId', 'executablePath', 'executableSha256'])
  const result = { pid: integer(row.pid), startTicks: string(row.startTicks), bootId: string(row.bootId), executablePath: string(row.executablePath), executableSha256: string(row.executableSha256) }
  executionAssert(result.pid > 0 && /^[0-9]+$/.test(result.startTicks) && /^[a-f0-9]{64}$/.test(result.executableSha256), 'run_control_invalid')
  return result
}
export async function readRunProcessIdentity(pid = process.pid): Promise<RunProcessIdentity> {
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
function parseRecord(value: unknown): RunControlRecord {
  const row = executionRecord(value)
  keys(row, ['schema', 'protocol', 'binding', 'process', 'directory', 'socketPath', 'socketDevice', 'socketInode', 'deadline', 'uid', 'sourceSha256'])
  executionAssert(row.schema === 1 && row.protocol === 1, 'run_control_invalid')
  return { schema: 1, protocol: 1, binding: parseRunBinding(row.binding), process: parseIdentity(row.process),
    directory: string(row.directory), socketPath: string(row.socketPath), socketDevice: integer(row.socketDevice), socketInode: integer(row.socketInode),
    deadline: integer(row.deadline), uid: integer(row.uid), sourceSha256: string(row.sourceSha256) }
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
/** Linux directory-FD alias reaches the same private inode without a long sockaddr. */
async function openSocketDirectory(directory: string, uid: number) {
  executionAssert(process.platform === 'linux' && process.versions.bun === '1.3.11', 'run_source_linux_bun_required')
  const before = await privatePath(directory, 'directory', uid)
  executionAssert(await realpath(directory) === directory, 'run_control_foreign')
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const assertCurrent = async () => {
      const [opened, current] = await Promise.all([fd.stat(), privatePath(directory, 'directory', uid)])
      executionAssert(opened.dev === before.dev && opened.ino === before.ino &&
        current.dev === before.dev && current.ino === before.ino &&
        await realpath(`/proc/self/fd/${fd.fd}`) === directory, 'run_control_changed')
    }
    await assertCurrent()
    const socketPath = `/proc/self/fd/${fd.fd}/control.sock`
    executionAssert(Buffer.byteLength(socketPath) <= 103, 'run_socket_path_too_long')
    return { fd, socketPath, assertCurrent }
  } catch (error) { await fd.close(); throw error }
}
async function readPrivate(file: string, uid: number): Promise<Buffer> {
  const before = await privatePath(file, 'file', uid)
  executionAssert(before.size <= MAX_FRAME, 'run_control_invalid')
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await fd.stat()
    executionAssert(stat.dev === before.dev && stat.ino === before.ino, 'run_control_changed')
    const bytes = await fd.readFile(); executionAssert(bytes.length <= MAX_FRAME, 'run_control_invalid'); return bytes
  } finally { await fd.close() }
}
export async function writeRunControlFile(directory: string, name: string, value: unknown): Promise<void> {
  executionAssert(/^[a-z-]+\.json$/.test(name), 'run_control_invalid')
  const uid = process.getuid?.(); executionAssert(uid !== undefined, 'run_source_linux_required')
  await privatePath(directory, 'directory', uid)
  const temporary = path.join(directory, `${name}.${randomUUID()}`), target = path.join(directory, name)
  const fd = await open(temporary, 'wx', 0o600)
  try { await fd.writeFile(canonicalExecutionJSON(value) + '\n'); await fd.sync() } finally { await fd.close() }
  await rename(temporary, target)
  const parent = await open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
}
/** Only explicit launch creates this non-expiring fence. Observe/stop never do. */
export async function reserveRunControlDirectory(dataRoot: string, binding: RunBinding, sourceSha256: string): Promise<string> {
  const uid = process.getuid?.(); executionAssert(uid !== undefined && await realpath(dataRoot) === dataRoot, 'run_source_linux_required')
  const directory = runControlDirectory(dataRoot, binding.teamId, binding.runId)
  let parent = dataRoot
  for (const part of ['opencode', 'v2', 'runs']) {
    parent = path.join(parent, part)
    await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => { if (executionRecord(error).code !== 'EEXIST') throw error })
    await privatePath(parent, 'directory', uid)
  }
  await mkdir(directory, { mode: 0o700 })
  await writeRunControlFile(directory, 'start.json', { binding, sourceSha256 })
  const secret = await open(path.join(directory, 'challenge'), 'wx', 0o600)
  try { await secret.writeFile(randomBytes(32)); await secret.sync() } finally { await secret.close() }
  return directory
}
export async function discoverOpenCodeV2Run(dataRoot: string, teamId: string, runId: string): Promise<RunControlRecord | null> {
  const uid = process.getuid?.(); executionAssert(uid !== undefined, 'run_source_linux_required')
  const directory = runControlDirectory(dataRoot, teamId, runId)
  try { await privatePath(directory, 'directory', uid) }
  catch (error) { if (executionRecord(error).code === 'ENOENT') return null; throw error }
  // An existing launch fence with no published endpoint remains UNKNOWN, not
  // permission for V1 fallback or a replacement supervisor.
  const record = parseRecord(JSON.parse((await readPrivate(path.join(directory, 'control.json'), uid)).toString('utf8')))
  executionAssert(record.directory === directory && record.binding.teamId === teamId && record.binding.runId === runId && record.uid === uid, 'run_control_foreign')
  return record
}
async function validateEndpoint(record: RunControlRecord): Promise<void> {
  const uid = process.getuid?.(); executionAssert(uid === record.uid, 'run_control_foreign')
  await privatePath(record.directory, 'directory', record.uid)
  const current = parseRecord(JSON.parse((await readPrivate(path.join(record.directory, 'control.json'), record.uid)).toString('utf8')))
  executionAssert(executionHash(current) === executionHash(record) && record.socketPath === path.join(record.directory, 'control.sock'), 'run_control_changed')
  const socket = await privatePath(record.socketPath, 'socket', record.uid)
  executionAssert(socket.dev === record.socketDevice && socket.ino === record.socketInode, 'run_control_changed')
  executionAssert(executionHash(await readRunProcessIdentity(record.process.pid)) === executionHash(record.process), 'run_owner_stale')
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
async function runOwnerRetired(record: RunControlRecord): Promise<boolean> {
  let live = true
  try { live = executionHash(await readRunProcessIdentity(record.process.pid)) === executionHash(record.process) }
  catch (error) { if (executionRecord(error).code === 'ENOENT' || executionRecord(error).code === 'ESRCH') live = false }
  const endpoint = await lstat(record.socketPath).catch((error: unknown) => {
    if (executionRecord(error).code === 'ENOENT') return null; throw error
  })
  if (endpoint) executionAssert(endpoint.dev === record.socketDevice && endpoint.ino === record.socketInode && endpoint.uid === record.uid, 'run_control_foreign')
  return !live && endpoint === null
}
/** Read-only, exact-run stop retry. An archive never regains execution authority. */
export async function readOpenCodeV2RunStop(record: RunControlRecord): Promise<Extract<RunControlResult, { kind: 'stop' }> | null> {
  await privatePath(record.directory, 'directory', record.uid)
  const current = parseRecord(JSON.parse((await readPrivate(path.join(record.directory, 'control.json'), record.uid)).toString('utf8')))
  executionAssert(executionHash(current) === executionHash(record), 'run_control_changed')
  let archive: Record<string, unknown>
  try { archive = executionRecord(JSON.parse((await readPrivate(path.join(record.directory, 'stop.json'), record.uid)).toString('utf8'))) }
  catch (error) { if (executionRecord(error).code === 'ENOENT') return null; throw error }
  keys(archive, ['binding', 'receipt'])
  const tombstone = executionRecord(JSON.parse((await readPrivate(path.join(record.directory, 'tombstone.json'), record.uid)).toString('utf8')))
  executionAssert(executionHash(archive.binding) === executionHash(record.binding) && executionHash(tombstone.binding) === executionHash(record.binding), 'run_control_foreign')
  const receipt = executionRecord(archive.receipt)
  executionAssert(receipt.kind === 'stop' && (receipt.state === 'stopped' || receipt.state === 'cleanup_unknown') && Array.isArray(receipt.members) && receipt.members.length <= 32, 'run_control_invalid')
  const result = receipt as Extract<RunControlResult, { kind: 'stop' }>
  const retired = await runOwnerRetired(record)
  return { ...result, state: result.state === 'stopped' && retired ? 'stopped' : 'cleanup_unknown', ownerRetired: retired }
}
/** Endpoint publication precedes native initialization. Observe only this authenticated
 * original owner until its original member is ready; this never submits or replaces input. */
export function isTransientOpenCodeV2ControlRead(error: unknown): boolean {
  return error instanceof Error && (error.message === 'run_control_timeout' || error.message === 'run_control_disconnected')
}
export async function awaitOpenCodeV2RunMemberReadiness(record: RunControlRecord,
  target: Pick<RunMemberStatus, 'memberId' | 'originalSessionId' | 'selectedModel' | 'selectedVariant' | 'pin'>,
  timeoutMs = OPEN_CODE_V2_RUN_INITIALIZATION_MS): Promise<RunMemberStatus | null> {
  executionAssert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= OPEN_CODE_V2_RUN_INITIALIZATION_MS, 'run_control_invalid')
  const deadline = Math.min(record.deadline, Date.now() + timeoutMs)
  while (Date.now() < deadline) {
    let status: RunControlResult
    try { status = await requestOpenCodeV2Run(record, { operation: 'status' }, Math.min(5000, deadline - Date.now())) }
    catch (error) {
      // Authentication and framing share this budget. Expiry can close the
      // final read before a reply; expiry never authorizes input submission.
      if (Date.now() >= deadline) return null
      if (!isTransientOpenCodeV2ControlRead(error)) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
      continue
    }
    executionAssert(status.kind === 'status' && status.deadline === record.deadline, 'run_readiness_changed')
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
  if (request.operation === 'stop') {
    const archived = await readOpenCodeV2RunStop(record)
    if (archived?.ownerRetired) return archived
  }
  executionAssert(deadline > Date.now(), 'run_deadline_expired')
  await validateEndpoint(record)
  const secret = await readPrivate(path.join(record.directory, 'challenge'), record.uid)
  executionAssert(secret.length === 32, 'run_control_invalid')
  const payload = { protocol: 1, binding: record.binding, endpoint: executionHash(record), client: await readRunProcessIdentity(), nonce: randomBytes(32).toString('hex'), deadline, request }
  const socketDirectory = await openSocketDirectory(record.directory, record.uid)
  let socket: Socket | undefined
  try {
    await validateEndpoint(record)
    const connected = createConnection(socketDirectory.socketPath)
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
        if (await runOwnerRetired(record)) return { ...stop, ownerRetired: true }
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
      }
      return { ...stop, state: 'cleanup_unknown', ownerRetired: false }
    }
    await validateEndpoint(record)
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
export async function serveOpenCodeV2RunControl(directory: string, binding: RunBinding, deadline: number, sourceSha256: string,
  execute: (request: RunControlRequest, deadline: number) => Promise<RunControlResult>): Promise<{ record: RunControlRecord; close(): Promise<void> }> {
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
        executionHash(await readRunProcessIdentity(client.pid)) === executionHash(client), 'run_control_foreign')
      // Recheck the signed deadline after peer measurement. Expired frames
      // cannot regain authority merely because replay history was pruned.
      usedNonces.claim(nonce, requestDeadline, request.operation, Date.now())
      let result: RunControlResult | undefined, error: string | undefined
      try { result = await execute(request, requestDeadline) }
      catch { error = 'run_operation_unknown' }
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
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketDirectory.socketPath, () => { server.off('error', reject); resolve() }) })
    // Capture ownership immediately after bind, before publication or slow birth hashing.
    const bound = await lstat(socketPath)
    executionAssert(bound.isSocket() && bound.uid === uid, 'run_control_foreign')
    ownedSocket = { dev: bound.dev, ino: bound.ino }
    await socketDirectory.assertCurrent()
    await chmod(socketPath, 0o600)
    const stat = await privatePath(socketPath, 'socket', uid)
    executionAssert(stat.dev === ownedSocket.dev && stat.ino === ownedSocket.ino, 'run_control_changed')
    record = { schema: 1, protocol: 1, binding, process: await readRunProcessIdentity(), directory, socketPath,
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
