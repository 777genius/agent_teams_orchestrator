import { openSync, writeSync, fsyncSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { closeArgument, constrainSockets } from './hostedControlBrokerPressureHelpers.js'
import { SocketBrokerWriteQueue } from '../HostedControlSocketBrokerTransport.js'
import { runHostedControlSocketBroker } from '../HostedControlSocketBroker.js'

// Observe the actual native calls. Never manufacture a count, inject a drain,
// alter queue behavior, or let diagnostics onto the private readiness stdout.
const evidencePath = join(dirname(process.argv[1]!), 'native-writes.jsonl')
const evidenceFD = openSync(evidencePath, 'a')
let sequence = 0
const record = (value: object) => {
  const full = { ...value, sequence: ++sequence, eventTime: performance.now() }
  const bytes = Buffer.from(`${JSON.stringify(full)}\n`)
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(evidenceFD, bytes, offset, bytes.length - offset)
    if (written <= 0) throw new Error('Incomplete durable pressure record')
    offset += written
  }
  fsyncSync(evidenceFD)
  return full.sequence
}
const notified = new Set<string>()
function notifyShort(sequence: number, id: number, direction: string, mapping: string | number,
  requested: number, accepted: number) {
  const key = JSON.stringify([direction, mapping])
  if (!(accepted > 0 && accepted < requested) || notified.has(key)) return
  if (notified.size >= 4) throw new Error('Too many pressure notifications')
  const frame = Buffer.from(`${JSON.stringify({ sequence, id, direction, mapping, requested, accepted })}\n`)
  if (frame.length > 512) throw new Error('Oversized pressure notification')
  // One bounded control write AFTER the complete record is durable. A short
  // control write is a fixture failure, never a successful pressure wakeup.
  if (writeSync(4, frame) !== frame.length) throw new Error('Short pressure notification write')
  notified.add(key)
}
record({ kind: 'runtime', execPath: process.execPath, version: Bun.version })
let next = 0
const ids = new WeakMap<Bun.Socket, number>()
// Opt-in observations only; originals run synchronously with unchanged arguments.
const orderly = process.env.HCB_PRESSURE_ORDERLY === '1'
if (orderly) {
  const once = process.once.bind(process)
  process.once = ((event: string, listener: (...args: any[]) => void) => once(event, event === 'SIGTERM' ? (...args: any[]) => {
    record({ kind: 'global-shutdown-entry' })
    listener(...args)
  } : listener)) as typeof process.once
  const kill = process.kill.bind(process)
  process.kill = ((pid: number, signal?: any) => {
    if (pid === process.pid && signal === 'SIGKILL') record({ kind: 'global-shutdown-terminal' })
    return kill(pid, signal)
  }) as typeof process.kill
  for (const method of ['stop', 'closeSource', 'end'] as const) {
    const original = SocketBrokerWriteQueue.prototype[method]
    SocketBrokerWriteQueue.prototype[method] = function () {
      original.call(this)
      record({ kind: `queue-${method}`, id: ids.get((this as any).source) })
    }
  }
}
function handlers(original: any, direction: 'request' | 'response', mapping: string | number) {
  return {
    ...original,
    open(socket: Bun.Socket) {
      const id = ++next
      ids.set(socket, id)
      record({ kind: 'buffers', id, direction, mapping, sizes: constrainSockets(undefined, 4) })
      if (orderly) {
        const resume = socket.resume.bind(socket)
        socket.resume = (() => {
          record({ kind: 'resume', id, direction, mapping })
          return resume()
        }) as typeof socket.resume
      }
      const write = socket.write.bind(socket)
      socket.write = ((bytes: Uint8Array) => {
        const accepted = write(bytes)
        try {
          const sequence = record({ kind: 'write', id, direction, mapping, requested: bytes.byteLength, accepted })
          notifyShort(sequence, id, direction, mapping, bytes.byteLength, accepted)
        } catch (error) {
          // The broker queue catches write exceptions. Make a broken control
          // channel an explicit fixture failure instead of silently losing it.
          try { record({ kind: 'fixture-error', message: String(error) }) }
          finally { process.kill(process.pid, 'SIGKILL') }
          throw error
        }
        return accepted
      }) as typeof socket.write
      const shutdown = socket.shutdown.bind(socket), end = socket.end.bind(socket), terminate = socket.terminate.bind(socket)
      socket.shutdown = ((read?: boolean) => {
        const result = shutdown(read)
        record({ kind: 'shutdown', id, direction, mapping, read: read ?? false })
        return result
      }) as typeof socket.shutdown
      socket.end = ((...args: any[]) => {
        record({ kind: 'local-end', id, direction, mapping })
        return (end as any)(...args)
      }) as typeof socket.end
      socket.terminate = (() => {
        record({ kind: 'terminate', id, direction, mapping })
        return terminate()
      }) as typeof socket.terminate
      return original.open?.(socket)
    },
    end(socket: Bun.Socket) {
      record({ kind: 'end', id: ids.get(socket), direction, mapping })
      return original.end?.(socket)
    },
    drain(socket: Bun.Socket) {
      record({ kind: 'drain', id: ids.get(socket), direction, mapping })
      return original.drain?.(socket)
    },
    close(socket: Bun.Socket, ...args: unknown[]) {
      record({ kind: 'close', id: ids.get(socket), direction, mapping, closeArgument: closeArgument(args[0]) })
      return original.close?.(socket, ...args)
    },
  }
}
const listen = Bun.listen.bind(Bun), connect = Bun.connect.bind(Bun)
Bun.listen = ((options: any) => listen({ ...options,
  socket: handlers(options.socket, 'response', options.unix),
})) as typeof Bun.listen
Bun.connect = ((options: any) => connect({ ...options,
  socket: handlers(options.socket, 'request', options.port),
})) as typeof Bun.connect
void runHostedControlSocketBroker(process.argv.slice(2)).catch(error => {
  record({ kind: 'error', message: String(error) })
  process.kill(process.pid, 'SIGKILL')
})
