import { randomUUID } from 'node:crypto'
import { windowsExecutionChildControl, windowsExecutionSelfBirth } from './OpenCodeV2WindowsChildControl.js'

export type WindowsCommandPort = Readonly<{
  start(input: Readonly<{ executable: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; stdin: 'ignore' | 'pipe' }>, signal?: AbortSignal): Promise<Readonly<{ commandId: string; pid: number; birthFiletime: string }>>
  writeStdin(input: Readonly<{ commandId: string; offset: number; bytesBase64: string }>, signal?: AbortSignal): Promise<Readonly<{ writtenBytes: number; nextOffset: number }>>
  endStdin(input: Readonly<{ commandId: string; offset: number }>, signal?: AbortSignal): Promise<Readonly<{ closed: true; nextOffset: number }>>
  read(input: Readonly<{ commandId: string; stream: 'stdout' | 'stderr'; offset: number; maxBytes: number }>, signal?: AbortSignal): Promise<Readonly<{ bytesBase64: string; nextOffset: number; eof: boolean }>>
  status(input: Readonly<{ commandId: string }>, signal?: AbortSignal): Promise<Readonly<{ running: boolean; exitCode: number | null }>>
  retire(input: Readonly<{ commandId: string }>): Promise<Readonly<{ empty: true; activeProcesses: 0; heldProcessExited: true }>>
  close(input: Readonly<{ commandId: string }>): Promise<void>
}>
const ports = new WeakSet<WindowsCommandPort>()
export function isWindowsCommandPort(value: unknown): value is WindowsCommandPort {
  return !!value && typeof value === 'object' && ports.has(value as WindowsCommandPort)
}
function assert(value: unknown): asserts value { if (!value) throw new Error('execution_native_command_unknown') }
function row(value: unknown): Record<string, unknown> { assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown> }
const UUID = /^[a-f0-9-]{36}$/
const STDIN_LIMIT = 64 * 1024 * 1024
/** Only the already-prepared child can obtain this port. It uses the native
 * broker's one main-process pipe; creating this port does not open platform
 * admission or substitute for native command qualification. */
export function windowsExecutionCommandPort(): WindowsCommandPort {
  const self = windowsExecutionSelfBirth(), control = windowsExecutionChildControl()
  assert(self.format === 'windows-filetime' && control.connected())
  const nonce = process.env.OPENCODE_V2_WINDOWS_NONCE!, leaseOwnerId = process.env.OPENCODE_V2_WINDOWS_LEASE!
  async function request(operation: string, input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted()
    const id = randomUUID(), deadline = Date.now() + 15000
    let timer: ReturnType<typeof setTimeout> | undefined
    let listener: ((value: unknown) => void) | undefined, disconnect: (() => void) | undefined
    try {
      const result = new Promise<Record<string, unknown>>((resolve, reject) => {
        listener = value => {
          try {
            const record = row(value)
            if (record.type !== 'commandResult' || record.id !== id) return
            assert(record.nonce === nonce && record.leaseOwnerId === leaseOwnerId)
            if (record.ok !== true) reject(new Error('execution_native_command_failed'))
            else resolve(row(record.value))
          } catch (error) { reject(error) }
        }
        disconnect = () => reject(new Error('execution_native_command_unknown'))
        control.events.on('message', listener); control.events.once('disconnect', disconnect)
        timer = setTimeout(() => { control.disconnect(); reject(new Error('execution_native_command_unknown')) }, deadline - Date.now())
      })
      void result.catch(() => undefined)
      await control.send({ type: 'commandRequest', id, operation, input, nonce, leaseOwnerId }, deadline)
      return await result
    } finally {
      clearTimeout(timer)
      if (listener) control.events.removeListener('message', listener)
      if (disconnect) control.events.removeListener('disconnect', disconnect)
    }
  }
  function commandId(input: Readonly<{ commandId: string }>): void { assert(UUID.test(input.commandId)) }
  const port: WindowsCommandPort = Object.freeze({
    async start(input, signal) {
      assert((input.stdin === 'ignore' || input.stdin === 'pipe') && input.args.length <= 1024)
      const result = await request('commandStart', input, signal)
      assert(typeof result.commandId === 'string' && UUID.test(result.commandId) && Number.isSafeInteger(result.pid) && Number(result.pid) > 0 && typeof result.birthFiletime === 'string' && /^[1-9]\d{0,19}$/.test(result.birthFiletime) && BigInt(result.birthFiletime) <= 0xffffffffffffffffn)
      const identity = Object.freeze({ commandId: result.commandId, pid: Number(result.pid), birthFiletime: result.birthFiletime })
      if (signal?.aborted) {
        await port.retire(identity); await port.close(identity); signal.throwIfAborted()
      }
      return identity
    },
    async writeStdin(input, signal) {
      commandId(input)
      const bytes = Buffer.from(input.bytesBase64, 'base64')
      assert(Number.isSafeInteger(input.offset) && input.offset >= 0 && bytes.length > 0 && bytes.length <= 8192 &&
        bytes.toString('base64') === input.bytesBase64 && input.offset + bytes.length <= STDIN_LIMIT)
      // An unknown write is never retried. Only a definite native partial ACK
      // permits the consumer to send the remaining suffix at its next offset.
      const result = await request('commandWriteStdin', input, signal)
      assert(Number.isSafeInteger(result.writtenBytes) && Number(result.writtenBytes) > 0 &&
        Number(result.writtenBytes) <= bytes.length && result.nextOffset === input.offset + Number(result.writtenBytes))
      signal?.throwIfAborted()
      return Object.freeze({ writtenBytes: Number(result.writtenBytes), nextOffset: Number(result.nextOffset) })
    },
    async endStdin(input, signal) {
      commandId(input); assert(Number.isSafeInteger(input.offset) && input.offset >= 0 && input.offset <= STDIN_LIMIT)
      const result = await request('commandEndStdin', input, signal)
      assert(result.closed === true && result.nextOffset === input.offset)
      signal?.throwIfAborted(); return Object.freeze({ closed: true as const, nextOffset: input.offset })
    },
    async read(input, signal) {
      commandId(input); assert(['stdout', 'stderr'].includes(input.stream) && Number.isSafeInteger(input.offset) && input.offset >= 0 && Number.isSafeInteger(input.maxBytes) && input.maxBytes > 0 && input.maxBytes <= 8192)
      const result = await request('commandRead', input, signal)
      assert(typeof result.bytesBase64 === 'string' && typeof result.eof === 'boolean')
      const bytes = Buffer.from(result.bytesBase64, 'base64')
      assert(bytes.length <= input.maxBytes && bytes.toString('base64') === result.bytesBase64 && result.nextOffset === input.offset + bytes.length)
      signal?.throwIfAborted(); return Object.freeze({ bytesBase64: result.bytesBase64, nextOffset: Number(result.nextOffset), eof: result.eof })
    },
    async status(input, signal) {
      commandId(input); const result = await request('commandStatus', input, signal)
      assert(typeof result.running === 'boolean' && (result.running ? result.exitCode === null : Number.isSafeInteger(result.exitCode) && Number(result.exitCode) >= 0 && Number(result.exitCode) <= 0xffffffff))
      signal?.throwIfAborted(); return Object.freeze({ running: result.running, exitCode: result.exitCode as number | null })
    },
    async retire(input) {
      commandId(input); const result = await request('commandRetire', input)
      assert(result.empty === true && result.activeProcesses === 0 && result.heldProcessExited === true)
      return Object.freeze({ empty: true as const, activeProcesses: 0 as const, heldProcessExited: true as const })
    },
    async close(input) { commandId(input); const result = await request('commandClose', input); assert(result.closed === true) },
  })
  ports.add(port); return port
}
