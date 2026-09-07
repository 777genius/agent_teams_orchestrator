import { afterEach, expect, test } from 'bun:test'
import { dlopen, FFIType, ptr, read } from 'bun:ffi'
import { fstatSync, closeSync } from 'node:fs'
import { OwnedDescriptorV2 } from './HostedControlBootstrapV2Descriptors.js'
import { HostedControlInheritedConnectionV2 } from './HostedControlInheritedConnectionV2.js'

// Real AF_UNIX kernel socketpairs and the production adapter, including send
// buffer saturation. Exact admitted FD5 / repeated take remains in all 15
// bootstrap-v2-kernel cases; these tests never overwrite runtime-reserved FDs.
const native = process.platform === 'linux' ? dlopen('libc.so.6', {
  socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  send: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  shutdown: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
} as const) : null
const linuxTest = test.skipIf(process.platform !== 'linux')
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(done: () => boolean, ms = 1500): Promise<void> {
  const deadline = performance.now() + ms
  while (!done()) {
    if (performance.now() >= deadline) throw new Error('Transport observation deadline')
    await delay(2)
  }
}
function pair() {
  const slots = new Int32Array(2)
  if (native!.symbols.socketpair(1, 1 | 0x80000, 0, ptr(slots)) !== 0) throw new Error('socketpair')
  const owner = new OwnedDescriptorV2(slots[0]), peer = new OwnedDescriptorV2(slots[1])
  cleanup.push(() => { owner.close(); peer.close() })
  const small = new Int32Array([1024])
  expect(native!.symbols.setsockopt(owner.fd, 1, 7, ptr(small), 4)).toBe(0)
  const before = fstatSync(owner.fd, { bigint: true }), fd = owner.fd
  const connection = new HostedControlInheritedConnectionV2(owner, current => {
    const after = fstatSync(current, { bigint: true })
    return before.dev === after.dev && before.ino === after.ino
  })
  cleanup.push(() => connection.destroy())
  return { connection, peer, fd, owner }
}
function io(kind: 'send' | 'recv', fd: number, bytes: Buffer): number {
  const n = Number(native!.symbols[kind](fd, ptr(bytes), bytes.length, 0x40 | (kind === 'send' ? 0x4000 : 0)))
  if (n >= 0) return n
  const errno = read.i32(native!.symbols.__errno_location()!)
  if (errno === 11 || errno === 4) return -1
  throw new Error(`${kind}: ${errno}`)
}
linuxTest('partial sends retain copied bytes, EAGAIN backpressure and one asynchronous completion', async () => {
  const { connection, peer, owner } = pair()
  expect(() => owner.take()).toThrow('descriptor_consumed')
  const bytes = Buffer.alloc(65536, 0x51), received: Buffer[] = []
  let calls = 0, drained = 0, failure: Error | null | undefined
  connection.on('drain', () => drained++)
  expect(connection.write(bytes, error => { calls++; failure = error })).toBe(false)
  bytes.fill(0x22)
  expect(calls).toBe(0)
  await delay(20) // Small SO_SNDBUF is full; peer deliberately has not read.
  expect(calls).toBe(0)
  let count = 0
  await until(() => {
    const scratch = Buffer.alloc(997), n = io('recv', peer.fd, scratch)
    if (n > 0) { received.push(scratch.subarray(0, n)); count += n }
    return count === 65536 && calls === 1
  })
  expect(Buffer.concat(received)).toEqual(Buffer.alloc(65536, 0x51))
  expect(failure).toBeUndefined(); expect(drained).toBe(1)
  expect(connection.isCurrent()).toBe(true)
})
linuxTest('partial receives preserve bytes and pause/resume leaves input in the kernel', async () => {
  const { connection, peer } = pair(), chunks: Buffer[] = []
  connection.on('data', bytes => chunks.push(bytes))
  expect(io('send', peer.fd, Buffer.from('ping'))).toBe(4)
  await delay(20); expect(chunks).toHaveLength(0)
  connection.resume()
  const payload = Buffer.alloc(40000, 0x73); let sent = 0
  await until(() => {
    if (sent < payload.length) {
      const n = io('send', peer.fd, payload.subarray(sent, sent + 997))
      if (n > 0) sent += n
    }
    return Buffer.concat(chunks).length === payload.length + 4
  })
  expect(Buffer.concat(chunks)).toEqual(Buffer.concat([Buffer.from('ping'), payload]))
})
linuxTest('EOF is synchronous at the effect fence and end/close each occur once', async () => {
  const { connection, peer } = pair(), events: string[] = []
  connection.on('end', () => events.push('end')); connection.on('close', () => events.push('close'))
  expect(native!.symbols.shutdown(peer.fd, 1)).toBe(0)
  expect(connection.isCurrent()).toBe(false); expect(connection.destroyed).toBe(true)
  connection.destroy(); connection.resume()
  await until(() => events.length === 2)
  expect(events).toEqual(['end', 'close'])
})
linuxTest('peer error cancels writes without SIGPIPE and destroy is idempotent', async () => {
  const { connection, peer } = pair(); let calls = 0, errors = 0, closes = 0
  connection.on('error', () => errors++); connection.on('close', () => closes++)
  peer.close()
  connection.write('cannot send', error => { expect(error).toBeInstanceOf(Error); calls++ })
  expect(calls).toBe(0)
  await until(() => closes === 1)
  connection.destroy(); connection.destroy()
  expect(calls).toBe(1); expect(errors).toBe(1)
})
linuxTest('cancellation drains bounded pending callbacks once and cancels inactivity deadlines', async () => {
  const { connection } = pair(); let calls = 0, timeouts = 0
  connection.on('timeout', () => { timeouts++; connection.destroy(new Error('read deadline')) })
  connection.setTimeout(10); connection.setTimeout(0)
  await delay(20); expect(timeouts).toBe(0)
  for (let i = 0; i < 2; i++) connection.write(Buffer.alloc(65536), error => {
    expect(error?.message).toBe('read deadline'); calls++
  })
  connection.setTimeout(10)
  await until(() => calls === 2)
  expect(timeouts).toBe(1); expect(connection.destroyed).toBe(true)
  await delay(20); expect(calls).toBe(2); expect(timeouts).toBe(1)
})
linuxTest('stalled writes have an absolute deadline even without a socket inactivity timeout', async () => {
  const { connection } = pair(); let error: Error | null | undefined
  connection.write(Buffer.alloc(65536), cause => { error = cause })
  await until(() => !!error, 5500)
  expect(error?.message).toBe('hosted_owner_v2_activation_write_deadline')
  expect(connection.destroyed).toBe(true)
}, 6500)
linuxTest('queue count and frame size reject overflow asynchronously', async () => {
  for (const oversized of [false, true]) {
    const { connection } = pair(); let calls = 0
    const count = oversized ? 1 : 5
    for (let i = 0; i < count; i++) connection.write(Buffer.alloc(oversized ? 65537 : 0), error => {
      expect(error).toBeInstanceOf(Error); calls++
    })
    expect(calls).toBe(0); expect(connection.destroyed).toBe(true)
    await until(() => calls === count)
  }
})
linuxTest('FD substitution cancels pending I/O without reading, writing or closing the replacement', async () => {
  for (const edge of ['fence', 'effect', 'read', 'write', 'destroy']) {
    const original = pair(), replacement = pair(); let calls = 0, data = 0
    original.connection.on('data', () => data++)
    original.connection.write('old bytes', error => { expect(error).toBeInstanceOf(Error); calls++ })
    // dup2 is exclusively an adversarial test action; production never duplicates.
    closeSync(original.fd)
    expect(native!.symbols.dup2(replacement.fd, original.fd)).toBe(original.fd)
    const reused = new OwnedDescriptorV2(original.fd); cleanup.push(() => reused.close())
    expect(io('send', replacement.peer.fd, Buffer.from('new bytes'))).toBe(9)
    if (edge === 'read') original.connection.resume()
    if (edge === 'fence') expect(original.connection.isCurrent()).toBe(false)
    if (edge === 'effect') expect(original.connection.isEffectCurrent(true)).toBe(false)
    if (edge === 'destroy') original.connection.destroy()
    await until(() => calls === 1)
    original.connection.destroy()
    const bytes = Buffer.alloc(20)
    expect(io('recv', original.fd, bytes)).toBe(9); expect(bytes.subarray(0, 9).toString()).toBe('new bytes')
    expect(io('recv', replacement.peer.fd, bytes)).toBe(-1); expect(data).toBe(0)
    expect(fstatSync(original.fd).isSocket()).toBe(true)
  }
})
linuxTest('end flushes accepted bytes before half-close and still observes peer EOF', async () => {
  const { connection, peer } = pair(); let bytes = '', eof = false
  connection.end('final')
  await until(() => {
    const scratch = Buffer.alloc(64), n = io('recv', peer.fd, scratch)
    if (n > 0) bytes += scratch.subarray(0, n).toString()
    if (n === 0) eof = true
    return eof
  })
  expect(bytes).toBe('final'); expect(connection.destroyed).toBe(false)
  peer.close(); connection.resume()
  await until(() => connection.destroyed)
})

linuxTest('effect observation sees buffered SHUT_WR and full close without consuming bytes first', () => {
  for (const halfClose of [true, false]) {
    const { connection, peer } = pair()
    expect(io('send', peer.fd, Buffer.from('x'))).toBe(1)
    if (halfClose) expect(native!.symbols.shutdown(peer.fd, 1)).toBe(0)
    else peer.close()
    // Even non-leased effects must observe shutdown behind buffered input.
    expect(connection.isEffectCurrent(false)).toBe(false)
    expect(connection.destroyed).toBe(true)
  }
})
linuxTest('only the leased effect fence rejects pending input; framed exchange stays readable', async () => {
  const { connection, peer } = pair(), frames: Buffer[] = []
  const frame = Buffer.from('{"prepare":1}\n')
  expect(io('send', peer.fd, frame)).toBe(frame.length)
  expect(connection.isCurrent()).toBe(true)
  expect(connection.isEffectCurrent(false)).toBe(true)
  connection.on('data', bytes => frames.push(bytes)); connection.resume()
  await until(() => Buffer.concat(frames).length === frame.length)
  expect(Buffer.concat(frames)).toEqual(frame)
  connection.pause()
  expect(connection.isEffectCurrent(true)).toBe(true)
  expect(io('send', peer.fd, Buffer.from('x'))).toBe(1)
  expect(connection.isCurrent()).toBe(true)
  expect(connection.isEffectCurrent(true)).toBe(false)
  expect(connection.destroyed).toBe(true)
})
