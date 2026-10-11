import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { createConnection, type Socket } from 'node:net'
import type { ExecutionBirth } from '../OpenCodeV2ExecutionBinding.js'

function assert(value: unknown): asserts value { if (!value) throw new Error('execution_containment_identity_mismatch') }
export type WindowsChildControl = Readonly<{
  events: EventEmitter; connected(): boolean; send(value: Readonly<Record<string, unknown>>, deadline?: number): Promise<void>; disconnect(): void
}>
const CONTROL_PACKET_LIMIT = 16 * 1024 * 1024
let owned: WindowsChildControl | undefined
/** Explicit child transport. Shared entry composition can select this without
 * overriding process.send, process.on, fetch or the official package source. */
export function windowsExecutionChildControl(): WindowsChildControl {
  if (owned) return owned
  assert(process.platform === 'win32' && process.versions.bun === '1.3.11')
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
        events.emit('message', value)
      } catch { socket.destroy(new Error('execution_invalid_response')) }
    }
  })
  owned = Object.freeze({ events, connected: () => connected && !socket.destroyed,
    async send(value: Readonly<Record<string, unknown>>, deadline = Date.now() + 1000) {
      assert(Date.now() < deadline)
      const bytes = JSON.stringify(value) + '\n'; assert(Buffer.byteLength(bytes) <= CONTROL_PACKET_LIMIT)
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
let prepared: Readonly<{ type: 'prepared'; nonce: string; leaseOwnerId: string; pid: number; birth: ExecutionBirth; namespace: string; executableSha256: string }> | undefined
export async function prepareWindowsExecutionChild(value: unknown) {
  assert(!prepared && value && typeof value === 'object' && !Array.isArray(value))
  const record = value as Record<string, unknown>, nativeBirth = record.birth as Record<string, unknown>
  assert(record.type === 'prepare' && record.nonce === process.env.OPENCODE_V2_WINDOWS_NONCE && record.leaseOwnerId === process.env.OPENCODE_V2_WINDOWS_LEASE && record.namespace === `windows-job:${record.nonce}` && typeof record.executableSha256 === 'string' && /^[a-f0-9]{64}$/.test(record.executableSha256) && nativeBirth && nativeBirth.format === 'windows-filetime' && typeof nativeBirth.value === 'string' && /^[1-9]\d{0,19}$/.test(nativeBirth.value) && nativeBirth.bootId === null)
  // Native broker accepted this pipe only after GetNamedPipeClientProcessId
  // matched its private live process HANDLE and FILETIME. No descendant may
  // substitute a separate connection or serialize a qualifying mapping.
  prepared = Object.freeze({ type: 'prepared', nonce: String(record.nonce), leaseOwnerId: String(record.leaseOwnerId), pid: process.pid,
    birth: Object.freeze({ format: 'windows-filetime', value: nativeBirth.value, bootId: null }), namespace: String(record.namespace), executableSha256: record.executableSha256 })
  await windowsExecutionChildControl().send(prepared); return prepared
}
export function windowsExecutionSelfBirth(): ExecutionBirth { assert(prepared); return prepared.birth }
