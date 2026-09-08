import { expect, test } from 'bun:test'
import { SocketBrokerWriteQueue } from './HostedControlSocketBrokerTransport.js'

// Scripted public transport contract only: these counts are NOT syscall
// evidence. Real counts are emitted by the independent pressure fixture.
test('reentrant short-write drain preserves copied bytes and emits one final FIN', async () => {
  const delivered: Buffer[] = []
  const events: string[] = []
  let writes = 0, active = false
  const queue = new SocketBrokerWriteQueue(undefined, () => { events.push('failure'); queue.stop() }, () => {})
  const destination = {
    write(bytes: Buffer) {
      expect(active).toBe(false)
      active = true
      try {
        const accepted = ++writes === 1 ? 2 : bytes.length
        delivered.push(Buffer.from(bytes.subarray(0, accepted)))
        if (writes === 1) queue.drain() // synchronous wake during short write
        return accepted
      } finally { active = false }
    },
    shutdown(read: boolean) { expect(read).toBe(false); events.push('FIN') },
    terminate() { events.push('terminate') },
  } as unknown as Bun.Socket
  queue.install(destination)
  const input = Buffer.from('credential:patterned-request')
  const original = Buffer.from(input)
  queue.push(input)
  input.fill(0x78) // mutate caller memory while the suffix is retained
  queue.end()
  await new Promise<void>(resolve => queueMicrotask(resolve))
  expect(Buffer.concat(delivered).equals(original)).toBe(true)
  expect(input.equals(Buffer.alloc(input.length, 0x78))).toBe(true)
  expect(events).toEqual(['FIN'])
  expect(writes).toBe(2)
  queue.drain(); queue.end(); queue.stop(); queue.drain()
  expect(events).toEqual(['FIN'])
  expect(writes).toBe(2)
}, 1000)

test('zero waits for a real external wake and retains caller-independent bytes', async () => {
  let writable = false, writes = 0, fins = 0, failures = 0
  const delivered: Buffer[] = []
  const queue = new SocketBrokerWriteQueue(undefined, () => { failures++; queue.stop() }, () => {})
  queue.install({ write(bytes: Buffer) {
    writes++
    if (!writable) return 0
    delivered.push(Buffer.from(bytes)); return bytes.length
  }, shutdown() { fins++ }, terminate() {} } as unknown as Bun.Socket)
  const bytes = Buffer.from('one token and request')
  queue.push(bytes); queue.end(); bytes.fill(0)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(writes).toBe(1)
  expect(fins).toBe(0)
  expect(delivered).toEqual([])
  writable = true; queue.drain()
  expect(Buffer.concat(delivered).toString()).toBe('one token and request')
  expect(fins).toBe(1)
  expect(failures).toBe(0)
  queue.stop(); queue.drain()
  expect(writes).toBe(2)
}, 1000)

test('repeated synchronous zero wakes terminate with bounded scheduling and no later output', async () => {
  let writes = 0, failures = 0, fins = 0
  const queue = new SocketBrokerWriteQueue(undefined, () => { failures++; queue.stop() }, () => {})
  queue.install({ write() {
    if (++writes > 4) throw new Error('Contract scheduling budget exceeded')
    queue.drain(); return 0
  },
    shutdown() { fins++ }, terminate() {} } as unknown as Bun.Socket)
  queue.push(Buffer.from('retained')); queue.end()
  // A macrotask must run: an unbounded microtask retry loop cannot pass this.
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(writes).toBeLessThanOrEqual(3)
  expect(failures).toBe(1)
  expect(fins).toBe(0)
  const terminalWrites = writes
  queue.drain(); queue.push(Buffer.from('late')); queue.end(); queue.stop()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(writes).toBe(terminalWrites)
  expect(failures).toBe(1)
  expect(fins).toBe(0)
}, 1000)
