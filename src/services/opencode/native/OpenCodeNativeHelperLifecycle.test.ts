import { describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { observeNativeHelper } from './OpenCodeNativeCustody.js'

// Lifecycle-only synthetic events. These do not count as native custody or cold-recovery proof.
function helper(onKill?: (signal: NodeJS.Signals, child: ChildProcess) => void) {
  const child = new EventEmitter() as ChildProcess
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  const signals: NodeJS.Signals[] = []
  Object.assign(child, { stdin, stdout, stderr, stdio: [stdin, stdout, stderr, null, null, null],
    kill(signal: NodeJS.Signals) { signals.push(signal); onKill?.(signal, child); return true },
  })
  return { child, stdout, signals }
}
function hello(output: PassThrough) {
  const body = Buffer.from(JSON.stringify({ protocol: 1, pid: 1 })), size = Buffer.alloc(4)
  size.writeUInt32BE(body.length); output.write(Buffer.concat([size, body]))
}

describe('captured native helper pre-packet lifecycle', () => {
  test('retains immediate spawn error and close across an awaited receipt closure', async () => {
    const fixture = helper()
    const observed = observeNativeHelper(fixture.child)
    // Models the asynchronous receipt.close interval before HELLO is consumed.
    await Promise.resolve()
    fixture.child.emit('error', new Error('TEST EACCES: private executable unavailable'))
    fixture.child.emit('close', -1, null)
    await expect(observed.stream.next()).rejects.toThrow('native_custody_protocol')
    expect(await observed.closeUnadmitted()).toBe(true)
    expect(fixture.signals).toEqual([])
  })
  test('a queued HELLO cannot mask a later spawn error before it is consumed', async () => {
    const fixture = helper()
    const observed = observeNativeHelper(fixture.child)
    hello(fixture.stdout)
    fixture.child.emit('error', new Error('TEST failed helper'))
    fixture.child.emit('close', -1, null)
    await expect(observed.stream.next()).rejects.toThrow('native_custody_protocol')
    expect(await observed.closeUnadmitted()).toBe(true)
  })
  test('a complete terminal frame drains after ordinary close, but no further packet is admitted', async () => {
    const fixture = helper()
    const observed = observeNativeHelper(fixture.child)
    const terminal = { protocol: 1, closed: true, status: 0 }
    const body = Buffer.from(JSON.stringify(terminal)), size = Buffer.alloc(4)
    size.writeUInt32BE(body.length); fixture.stdout.write(Buffer.concat([size, body]))
    fixture.child.emit('exit', 0, null)
    fixture.child.emit('close', 0, null)
    expect(await observed.stream.next()).toEqual(terminal)
    await expect(observed.stream.next()).rejects.toThrow('native_custody_protocol')
    expect(() => observed.assertLive()).toThrow('native_custody_unavailable')
    expect(await observed.closeUnadmitted()).toBe(true)
    expect(fixture.signals).toEqual([])
  })
  test('post-HELLO pre-packet failure waits for captured child close and never writes a packet', async () => {
    const fixture = helper((_signal, child) => { queueMicrotask(() => { child.emit('exit', 0, null); child.emit('close', 0, null) }) })
    const observed = observeNativeHelper(fixture.child)
    let bytes = 0
    fixture.child.stdin!.on('data', (value: Buffer) => { bytes += value.length })
    hello(fixture.stdout)
    expect(await observed.stream.next()).toMatchObject({ protocol: 1 })
    expect(await observed.closeUnadmitted()).toBe(true)
    expect(bytes).toBe(0)
    expect(fixture.signals).toEqual(['SIGTERM'])
  })
  test('exit without pipe closure remains unconfirmed and never signals a reaped child again', async () => {
    const fixture = helper((_signal, child) => { child.emit('exit', 0, null) })
    const observed = observeNativeHelper(fixture.child)
    hello(fixture.stdout)
    await observed.stream.next()
    try {
      expect(await observed.closeUnadmitted()).toBe(false)
      expect(fixture.signals).toEqual(['SIGTERM'])
    } finally { fixture.child.emit('close', 0, null) }
  }, 5000)
})
