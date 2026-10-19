import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function assert(value: unknown, code: string): asserts value { if (!value) throw new Error(code) }
export type WindowsNativeArtifact = Readonly<{ path: string; sha256: string; arch: 'x64' | 'arm64' }>
const artifacts = new WeakSet<WindowsNativeArtifact>()
export type WindowsNativeAliasFailure = Readonly<{ operation: string; sourceLine: number; predicate: number; passed: false }>
const nativeAliasFailures = new WeakMap<Error, WindowsNativeAliasFailure>()
const aliasOperations = ["assertLive", "identity", "launch", "ownerArchive", "ownerAssertDirectory", "ownerCloseDirectory", "ownerCreatePreparedDatabase", "ownerInspectProfileConfig", "ownerOpenDirectory", "ownerPreparePrivateDirectory", "ownerReadMetadata", "ownerReadRecord", "ownerSelectConfig", "ownerValidateSelectedProfile", "ownerWriteExclusive", "ownerWriteMetadata", "ownerWritePreparedAuth", "ownerWritePreparedConfig", "retire", "runStateAcquire", "runStateClose", "runStateDiscover", "runStateListen", "runStateOwnerRetired", "runStatePoisonConnection", "runStateProcessIdentity", "runStateReadControllerInbox", "runStateReadRecord", "runStateReadStop", "runStateRequest", "runStateReserve", "runStateRespond", "runStateSelect", "runStateValidateEndpoint", "runStateWriteRecord", "selfImageCustody", "send"] as const
export function projectWindowsNativeAliasFailure(value: unknown): WindowsNativeAliasFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'operation,predicates,sourceLine' ||
      !aliasOperations.some(operation => operation === row.operation) || !Number.isSafeInteger(row.sourceLine) ||
      Number(row.sourceLine) < 1 || Number(row.sourceLine) > 100000 || !Number.isSafeInteger(row.predicates) ||
      Number(row.predicates) < 0 || Number(row.predicates) > 4) return undefined
  return Object.freeze({ operation: String(row.operation), sourceLine: Number(row.sourceLine), predicate: Number(row.predicates), passed: false })
}
export function readWindowsNativeAliasFailure(error: unknown): WindowsNativeAliasFailure | undefined {
  return error instanceof Error ? nativeAliasFailures.get(error) : undefined
}
/** The normal reply decoder keeps the original finite failure as an Error. */
export function decodeWindowsNativeFailure(value: Readonly<Record<string, unknown>>, operation: string): Error {
  const code = typeof value.error === 'string' && /^[a-z_]{1,96}$/.test(value.error) ? value.error : 'execution_native_unknown'
  const context = typeof value.stage === 'string' && /^[a-z_][a-z_0-9]{0,63}$/.test(value.stage) && Number.isSafeInteger(value.nativeCode) && Number(value.nativeCode) >= 0 && Number(value.nativeCode) <= 0xffffffff ? `:${value.stage}:${value.nativeCode}` : ''
  const error = Object.assign(new Error(code + context), {
    nativeOperation: aliasOperations.find(candidate => candidate === operation) ?? 'unknown',
    ...(Number.isSafeInteger(value.nativeStatus) && Number(value.nativeStatus) >= 0 && Number(value.nativeStatus) <= 0xffffffff
      ? { nativeStatus: Number(value.nativeStatus) } : {}),
  })
  if (code === 'execution_path_alias') {
    const alias = projectWindowsNativeAliasFailure(value.alias)
    if (alias && alias.operation === operation) nativeAliasFailures.set(error, alias)
  }
  return error
}
const CONTROL_PACKET_LIMIT = 16 * 1024 * 1024
/** Resolve only producer-selected assets from the installed architecture directory. */
async function resolveWindowsProducerAsset(name: string, manifestName: string, dll: boolean): Promise<WindowsNativeArtifact> {
  assert(process.platform === 'win32' && ['x64', 'arm64'].includes(process.arch), 'execution_containment_platform_pending')
  const location = fileURLToPath(import.meta.url)
  assert(!location.includes('$bunfs') && !location.includes('~BUN'), 'v2_compiled_runtime_unsupported')
  const marker = `${path.sep}src${path.sep}`
  const root = location.includes(marker) ? location.slice(0, location.lastIndexOf(marker)) : path.dirname(location)
  const directory = path.join(await realpath(root), 'native', `win32-${process.arch}`)
  assert(await realpath(directory) === directory, 'execution_containment_helper_identity')
  const executable = path.join(directory, name)
  const manifest: unknown = JSON.parse(await readFile(path.join(directory, manifestName), 'utf8'))
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'execution_containment_helper_identity')
  const value = manifest as Record<string, unknown>
  assert(value.format === 1 && value.platform === 'win32' && value.arch === process.arch && value.name === name && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'execution_containment_helper_identity')
  const info = await lstat(executable)
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && await realpath(executable) === executable, 'execution_containment_helper_identity')
  const bytes = await readFile(executable)
  assert(createHash('sha256').update(bytes).digest('hex') === value.sha256 && bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d, 'execution_containment_helper_identity')
  const pe = bytes.readUInt32LE(0x3c)
  assert(pe >= 64 && pe <= bytes.length - 24 && bytes.readUInt32LE(pe) === 0x00004550 &&
    bytes.readUInt16LE(pe + 4) === (process.arch === 'x64' ? 0x8664 : 0xaa64) &&
    ((bytes.readUInt16LE(pe + 22) & 0x2000) !== 0) === dll, 'execution_containment_helper_identity')
  return Object.freeze({ path: executable, sha256: value.sha256, arch: process.arch as 'x64' | 'arm64' })
}
/** Helper-only owner and spike paths never require the realpath DLL. */
export async function resolveWindowsNativeArtifact(deadline?: number): Promise<WindowsNativeArtifact> {
  const source = await resolveWindowsProducerAsset('opencode-v2-windows-helper.exe', 'windows-helper.json', false)
  // Only the producer-selected helper can place its own held image in custody.
  // Every fresh CLI selects the same SHA-addressed file, including FileID.
  const bootstrap = launchWindowsNativeBroker(source, true)
  bootstrap.events.on('error', () => {})
  let receipt: unknown
  let primary: unknown, failed = false
  try { receipt = await bootstrap.request('selfImageCustody', {}, deadline) }
  catch (error) {
    try {
      if (error instanceof Error && !Object.hasOwn(error, 'nativeOperation'))
        Object.assign(error, { nativeOperation: 'selfImageCustody' })
    } catch { /* Diagnostic context cannot replace the original failure. */ }
    primary = error; failed = true; throw error
  }
  finally {
    try { await bootstrap.close() }
    catch (error) { throw Object.assign(new AggregateError([...(failed ? [primary] : []), error], 'cleanup_unknown',
      { cause: failed ? primary : error }), { cleanupBoundary: 'native_artifact_close', primaryFailure: failed }) }
  }
  assert(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'execution_containment_helper_identity')
  const value = receipt as Record<string, unknown>
  const selected = path.win32.join(process.env.LOCALAPPDATA!, 'AgentTeams.OpenCodeV2.Native', source.sha256, 'opencode-v2-windows-helper.exe')
  assert(value.sourcePath === source.path && value.path === selected && value.sha256 === source.sha256 && value.privateAcl === true && value.protectedDacl === true, 'execution_containment_helper_identity')
  const artifact = Object.freeze({ ...source, path: selected })
  artifacts.add(artifact); return artifact
}
export type WindowsRealpathArtifact = WindowsNativeArtifact
const realpathArtifacts = new WeakSet<WindowsRealpathArtifact>()
/** Production composition must additionally bind this selection to its native held DLL identity. */
export async function resolveWindowsRealpathArtifact(): Promise<WindowsRealpathArtifact> {
  const artifact = await resolveWindowsProducerAsset('opencode-v2-windows-realpath.dll', 'windows-realpath.json', true)
  realpathArtifacts.add(artifact); return artifact
}
export function requireWindowsRealpathArtifact(artifact: WindowsRealpathArtifact): void {
  assert(realpathArtifacts.has(artifact), 'execution_containment_helper_identity')
}
export type WindowsNativeBroker = Readonly<{
  events: EventEmitter; request(operation: string, input?: Readonly<Record<string, unknown>>, deadline?: number, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>; ended(): boolean
}>
/** The native process owns every HANDLE. EOF/crash closes the only outer Job
 * reference; no HANDLE values are serialized or inherited by user commands. */
export function createWindowsNativeBroker(artifact: WindowsNativeArtifact): WindowsNativeBroker {
  assert(artifacts.has(artifact), 'execution_containment_helper_identity')
  return launchWindowsNativeBroker(artifact, false)
}
function launchWindowsNativeBroker(artifact: WindowsNativeArtifact, custodyOnly: boolean): WindowsNativeBroker {
  assert(typeof process.env.LOCALAPPDATA === 'string' && path.win32.isAbsolute(process.env.LOCALAPPDATA), 'execution_containment_profile_denied')
  const events = new EventEmitter(), pending = new Map<number, { operation: string; resolve(value: unknown): void; reject(error: Error): void; dispose(): void }>()
  const child = spawn(artifact.path, [custodyOnly ? '--self-image-custody' : '--broker', artifact.sha256], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, LOCALAPPDATA: process.env.LOCALAPPDATA } })
  let ended = false, sequence = 0, buffer = '', stderr = ''
  const decoder = new StringDecoder('utf8')
  let resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  const fail = (error: Error) => { for (const waiter of pending.values()) { waiter.dispose(); waiter.reject(error) }; pending.clear() }
  child.on('error', error => { ended = true; fail(new Error('execution_containment_helper_failed', { cause: error })); events.emit('error', error) })
  child.once('close', code => { ended = true; fail(new Error('execution_containment_helper_closed')); resolveExit(); events.emit('close', code) })
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16384) })
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    if (Buffer.byteLength(buffer) > CONTROL_PACKET_LIMIT) { fail(new Error('execution_invalid_response')); child.stdin.end(); return }
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        assert(value && typeof value === 'object' && !Array.isArray(value) && value.schema === 1, 'execution_invalid_response')
        if (value.kind === 'reply') {
          const waiter = pending.get(Number(value.id)); assert(waiter, 'execution_invalid_response'); pending.delete(Number(value.id)); waiter.dispose()
          if (value.ok === true) waiter.resolve(value.value)
          else {
            waiter.reject(decodeWindowsNativeFailure(value, waiter.operation))
          }
        } else if (value.kind === 'event' && typeof value.event === 'string') events.emit(value.event, value.value)
        else throw new Error('execution_invalid_response')
      } catch (error) { fail(new Error('execution_invalid_response', { cause: error })); child.stdin.end() }
    }
  })
  return Object.freeze({ events, ended: () => ended,
    request(operation: string, input: Readonly<Record<string, unknown>> = {}, deadline = Date.now() + 15000, signal?: AbortSignal) {
      assert(!ended && /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(operation) && deadline > Date.now(),
        operation === 'retire' ? 'execution_native_unknown:retire_broker_state:0' : 'execution_native_unknown')
      signal?.throwIfAborted()
      const id = ++sequence, bytes = JSON.stringify({ schema: 1, id, operation, input }) + '\n'
      assert(Buffer.byteLength(bytes) <= CONTROL_PACKET_LIMIT, 'execution_invalid_response')
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); dispose(); reject(new Error('execution_native_timeout')); child.stdin.end() }, deadline - Date.now())
        const abort = () => { pending.delete(id); dispose(); reject(new Error('execution_cancelled')); child.stdin.end() }
        const dispose = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
        pending.set(id, { operation, resolve, reject, dispose }); signal?.addEventListener('abort', abort, { once: true })
        child.stdin.write(bytes, error => { if (error) { pending.delete(id); dispose(); reject(new Error(
          operation === 'retire' ? 'execution_native_unknown:retire_broker_write:0' : 'execution_native_unknown')); child.stdin.end() } })
        if (signal?.aborted) abort()
      })
    },
    async close() {
      child.stdin.end()
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup_unknown')), 15000) })]) }
      finally { clearTimeout(timer) }
      assert(ended, 'cleanup_unknown'); void stderr
    },
  })
}
