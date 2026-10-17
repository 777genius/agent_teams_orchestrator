import { openCodeBunVersion } from '../../../../constants/openCodeBunVersion.js'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { createConnection, type Socket } from 'node:net'
import path from 'node:path'
import { executionHash } from '../../execution/OpenCodeV2ExecutionContracts.js'
import type { WindowsRealpathInstallation, WindowsRealpathSelection } from './OpenCodeV2WindowsRealpath.js'
import type { ExecutionBirth } from '../OpenCodeV2ExecutionBinding.js'

function assert(value: unknown): asserts value { if (!value) throw new Error('execution_containment_identity_mismatch') }
export type WindowsChildControl = Readonly<{
  events: EventEmitter; connected(): boolean; send(value: Readonly<Record<string, unknown>>, deadline?: number): Promise<void>; disconnect(): void
}>
const CONTROL_PACKET_LIMIT = 16 * 1024 * 1024
let owned: WindowsChildControl | undefined
const authenticatedPrepares = new WeakMap<object, Record<string, unknown>>()
/** One authenticated Windows startup pause after the complete read-only graph.
 * This carries the owner's original absolute initialization deadline. */
export function windowsGraphActivation(expected: Readonly<{ nonce: string; leaseOwnerId: string; namespace: string; pid: number; birth: ExecutionBirth }>, deadline: number) {
  assert(Number.isFinite(deadline) && deadline > Date.now())
  const identity = Object.freeze({ ...expected, birth: Object.freeze({ ...expected.birth }) })
  let ready = false, activated = false
  let resolve!: () => void
  const activation = new Promise<void>(done => { resolve = done })
  return Object.freeze({
    ready() { assert(!ready && !activated && Date.now() < deadline); ready = true },
    activate(input: Record<string, unknown>, signal: AbortSignal) {
      signal.throwIfAborted()
      assert(ready && !activated && Date.now() < deadline && input.type === 'activate' &&
        input.nonce === identity.nonce && input.leaseOwnerId === identity.leaseOwnerId && input.namespace === identity.namespace &&
        input.pid === identity.pid && executionHash(input.birth) === executionHash(identity.birth))
      activated = true; resolve()
    },
    wait: () => activation,
  })
}
/** Explicit child transport. Shared entry composition can select this without
 * overriding process.send, process.on, fetch or the official package source. */
export function windowsExecutionChildControl(): WindowsChildControl {
  if (owned) return owned
  assert(process.platform === 'win32' && process.versions.bun === openCodeBunVersion())
  const pipe = process.env.OPENCODE_V2_WINDOWS_PIPE, nonce = process.env.OPENCODE_V2_WINDOWS_NONCE, lease = process.env.OPENCODE_V2_WINDOWS_LEASE
  assert(typeof nonce === 'string' && /^[a-f0-9-]{36}$/.test(nonce) && typeof lease === 'string' && /^[a-f0-9-]{36}$/.test(lease) && pipe === `\\\\.\\pipe\\agt-v2-${nonce}`)
  const events = new EventEmitter(), socket: Socket = createConnection(pipe)
  let connected = false, buffer = ''
  const decoder = new StringDecoder('utf8')
  const ready = new Promise<void>((resolve, reject) => { socket.once('connect', () => { connected = true; resolve() }); socket.once('error', reject); socket.once('close', () => reject(new Error('execution_containment_pipe_denied'))) })
  void ready.catch(() => undefined)
  socket.on('error', error => { events.emit('error', error) })
  socket.on('close', () => { connected = false; events.emit('disconnect') })
  socket.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    if (Buffer.byteLength(buffer) > CONTROL_PACKET_LIMIT) { socket.destroy(new Error('execution_invalid_response')); return }
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        assert(value && typeof value === 'object' && !Array.isArray(value) && value.nonce === nonce && value.leaseOwnerId === lease)
        if (value.type === 'prepare') authenticatedPrepares.set(value, structuredClone(value))
        events.emit('message', value)
      } catch { socket.destroy(new Error('execution_invalid_response')) }
    }
  })
  owned = Object.freeze({ events, connected: () => connected && !socket.destroyed,
    async send(value: Readonly<Record<string, unknown>>, deadline = Date.now() + 1000) {
      assert(Date.now() < deadline)
      // The execution server can earn closed ACK only after the installed
      // facade has disabled wrappers, drained RP_Close and unloaded known-safe
      // native state. UNKNOWN throws, keeps DLL custody, and emits no ACK.
      let outgoing = value
      if (value.type === 'closed') {
        assert(prepared && value.nonce === prepared.nonce && value.leaseOwnerId === prepared.leaseOwnerId)
        assert(value.pid === prepared.pid && value.namespace === prepared.namespace && value.scopeClosed === true)
        assert(JSON.stringify(value.birth) === JSON.stringify(prepared.birth))
        await closeWindowsRealpath()
        outgoing = { ...value, realpathClosed: realpathReceiptId }
      }
      const bytes = JSON.stringify(outgoing) + '\n'; assert(Buffer.byteLength(bytes) <= CONTROL_PACKET_LIMIT)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([(async () => {
          await ready; assert(connected && !socket.destroyed && Date.now() < deadline)
          await new Promise<void>((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve()))
        })(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('execution_timeout')), Math.max(1, deadline - Date.now()))
        })])
      } catch (error) { socket.destroy(); throw error }
      finally { clearTimeout(timer) }
    },
    disconnect() { socket.end() },
  })
  return owned
}
let realpathInstallation: WindowsRealpathInstallation | undefined
let realpathReceiptId: string | undefined
let preparing = false
let realpathClose: Promise<void> | undefined
function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>
}
function uint64(value: unknown): bigint {
  assert(typeof value === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(value))
  const parsed = BigInt(value); assert(parsed <= 0xffffffffffffffffn); return parsed
}
function childRealpathSelection(input: Record<string, unknown>, nativeBirth: Record<string, unknown>): WindowsRealpathSelection {
  const supervisor = record(input.supervisor), receipt = record(input.realpathAnchors), dll = record(input.realpathDll)
  assert(Number.isSafeInteger(supervisor.nativePID) && Number(supervisor.nativePID) > 0)
  const suffix = `${supervisor.nativePID}:${process.pid}:${nativeBirth.value}`
  assert(receipt.nonce === input.nonce && receipt.receiptId === `windows-anchors:${suffix}` && Array.isArray(receipt.anchors) && receipt.anchors.length > 0 && receipt.anchors.length <= 4096)
  assert(dll.nonce === input.nonce && dll.receiptId === `windows-dll:${suffix}` && dll.held === true && typeof dll.path === 'string' && path.win32.isAbsolute(dll.path) && typeof dll.sha256 === 'string' && /^[a-f0-9]{64}$/.test(dll.sha256) && typeof dll.fileId === 'string' && /^[a-f0-9]{32}$/.test(dll.fileId))
  uint64(dll.volumeSerial)
  const seen = new Set<string>()
  const anchors = receipt.anchors.map(value => {
    const anchor = record(value)
    assert((anchor.kind === 'readOnly' || anchor.kind === 'writable') && typeof anchor.admittedPath === 'string' && typeof anchor.dosPath === 'string' && path.win32.isAbsolute(anchor.dosPath) && path.win32.relative(anchor.admittedPath, anchor.dosPath) === '')
    assert(typeof anchor.ntPath === 'string' && anchor.ntPath.startsWith('\\Device\\') && anchor.ntPath.length <= 32767 && !anchor.ntPath.includes('\0') && anchor.ntPath.slice(1).split('\\').every(segment => segment !== '' && segment !== '.' && segment !== '..'))
    assert(typeof anchor.fileId === 'string' && /^[a-f0-9]{32}$/.test(anchor.fileId))
    const key = `${anchor.kind}:${anchor.admittedPath}`; assert(!seen.has(key)); seen.add(key)
    return Object.freeze({ dosPath: anchor.dosPath, ntPath: anchor.ntPath, volumeSerial: uint64(anchor.volumeSerial), fileId: anchor.fileId })
  })
  realpathReceiptId = dll.receiptId as string
  return Object.freeze({ dllPath: dll.path, expectedPid: process.pid, expectedCreationFiletime: uint64(nativeBirth.value), anchors: Object.freeze(anchors) })
}
function closeWindowsRealpath(): Promise<void> {
  return realpathClose ??= Promise.resolve().then(() => {
    assert(realpathInstallation && realpathReceiptId)
    realpathInstallation.uninstall()
    realpathInstallation = undefined
  })
}
let prepared: Readonly<{ type: 'prepared'; nonce: string; leaseOwnerId: string; pid: number; birth: ExecutionBirth; namespace: string; executableSha256: string; realpathInstalled: string }> | undefined
export async function prepareWindowsExecutionChild(value: unknown) {
  assert(!preparing && !prepared && value && typeof value === 'object' && !Array.isArray(value))
  const captured = authenticatedPrepares.get(value)
  assert(captured)
  authenticatedPrepares.delete(value)
  preparing = true
  const record = captured, nativeBirth = record.birth as Record<string, unknown>
  assert(record.type === 'prepare' && record.nonce === process.env.OPENCODE_V2_WINDOWS_NONCE && record.leaseOwnerId === process.env.OPENCODE_V2_WINDOWS_LEASE && record.namespace === `windows-job:${record.nonce}` && typeof record.executableSha256 === 'string' && /^[a-f0-9]{64}$/.test(record.executableSha256) && nativeBirth && nativeBirth.format === 'windows-filetime' && typeof nativeBirth.value === 'string' && /^[1-9]\d{0,19}$/.test(nativeBirth.value) && nativeBirth.bootId === null)
  // Native broker accepted this pipe only after GetNamedPipeClientProcessId
  // matched its private live process HANDLE and FILETIME. No descendant may
  // substitute a separate connection or serialize a qualifying mapping.
  // Capture and validate the original authenticated prepare message. The
  // private singleton cannot be installed from a replay or public caller DTO.
  const selection = childRealpathSelection(record, nativeBirth)
  const { installWindowsRealpathFallback } = await import('./OpenCodeV2WindowsRealpath.js')
  realpathInstallation = installWindowsRealpathFallback(selection)
  assert(realpathReceiptId)
  prepared = Object.freeze({ type: 'prepared', nonce: String(record.nonce), leaseOwnerId: String(record.leaseOwnerId), pid: process.pid,
    birth: Object.freeze({ format: 'windows-filetime', value: nativeBirth.value, bootId: null }), namespace: String(record.namespace), executableSha256: record.executableSha256, realpathInstalled: realpathReceiptId })
  try { await windowsExecutionChildControl().send(prepared); return prepared }
  catch (error) {
    // Failed transport never earns prepared ACK. Any uncertain native close
    // propagates while retaining the library rather than pretending cleanup.
    await closeWindowsRealpath(); throw error
  }
}
export function windowsExecutionSelfBirth(): ExecutionBirth { assert(prepared); return prepared.birth }
