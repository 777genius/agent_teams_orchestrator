import { describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { nativeHelperFailureDiagnostic, observeNativeHelper } from './OpenCodeNativeCustody.js'

// Lifecycle-only synthetic events. These do not count as native custody or cold-recovery proof.
function helper(onKill?: (signal: NodeJS.Signals, child: ChildProcess) => void) {
  const child = new EventEmitter() as ChildProcess
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  const signals: NodeJS.Signals[] = []
  const stdio = [stdin, stdout, stderr, new PassThrough(), new PassThrough()] as const
  Object.assign(child, { stdin, stdout, stderr, stdio: [...stdio, null],
    kill(signal: NodeJS.Signals) { signals.push(signal); onKill?.(signal, child); return true },
  })
  return { child, stdout, signals, stdio }
}
function hello(output: PassThrough) {
  const body = Buffer.from(JSON.stringify({ protocol: 1, pid: 1 })), size = Buffer.alloc(4)
  size.writeUInt32BE(body.length); output.write(Buffer.concat([size, body]))
}

describe('captured native helper pre-packet lifecycle', () => {

  for (const fd of [2, 3, 4] as const) {
    test(`an asynchronous FD ${fd} error rejects pending HELLO without escaping its owner`, async () => {
      const fixture = helper()
      const operation = fd === 2 ? 'measure' : fd === 3 ? 'launch' : 'control-stop'
      const observed = observeNativeHelper(fixture.child, operation)
      const pending = observed.stream.next('hello').then(() => null, error => error)
      try {
        // Models Bun's net.connect({ fd }) rejection after spawn returned.
        await Promise.resolve()
        expect(() => fixture.stdio[fd].emit('error', Object.assign(new Error('TEST private pipe failure'), { code: 'ECONNRESET' }))).not.toThrow()
        const failure = await pending
        expect(failure).toBeInstanceOf(Error)
        expect(failure.message).toBe('native_custody_protocol')
        expect(nativeHelperFailureDiagnostic(failure)).toMatchObject({ waitPhase: 'hello', trigger: 'stdio-error', operation,
          triggerFd: fd, triggerCode: 'ECONNRESET', exitObservedAtTrigger: false, closeObservedAtTrigger: false })
        expect(JSON.stringify(nativeHelperFailureDiagnostic(failure))).not.toContain('TEST private')
        expect(() => observed.assertLive()).toThrow('native_custody_protocol')
      } finally { fixture.child.emit('close', -1, null) }
      expect(await observed.closeUnadmitted()).toBe(true)
      expect(fixture.signals).toEqual([])
    })

    test(`a queued HELLO cannot admit a packet after an FD ${fd} error`, async () => {
      const fixture = helper()
      const observed = observeNativeHelper(fixture.child)
      let bytes = 0
      fixture.child.stdin!.on('data', (value: Buffer) => { bytes += value.length })
      try {
        hello(fixture.stdout)
        await Promise.resolve()
        expect(() => fixture.stdio[fd].emit('error', new Error('TEST late private pipe failure'))).not.toThrow()
        await expect(observed.stream.next('hello')).rejects.toThrow('native_custody_protocol')
        expect(() => {
          observed.assertLive()
          fixture.child.stdin!.write('TEST packet must stay private')
        }).toThrow('native_custody_protocol')
        expect(bytes).toBe(0)
      } finally { fixture.child.emit('close', -1, null) }
      expect(await observed.closeUnadmitted()).toBe(true)
      expect(fixture.signals).toEqual([])
    })
  }

  test('owns the original refusal before reentrant errno inspection and ignores later projections', async () => {
    const fixture = helper(), observed = observeNativeHelper(fixture.child, 'launch')
    const pending = observed.stream.next('hello').then(() => null, failure => failure)
    let duringProjection: Promise<Error | null> | undefined, laterReads = 0
    let duringLiveCheck: unknown
    const later = new Proxy({}, { getOwnPropertyDescriptor() { laterReads++; throw new Error('TEST later projection must not run') } })
    const first = new Proxy({}, { getOwnPropertyDescriptor() {
      try { observed.assertLive() } catch (error) { duringLiveCheck = error }
      duringProjection = observed.stream.next('hello').then(() => null, failure => failure)
      fixture.stdio[3].emit('error', later)
      fixture.child.emit('exit', 112, null)
      return { configurable: true, enumerable: true, value: 'EIO' }
    } })
    try {
      expect(() => fixture.stdio[4].emit('error', first)).not.toThrow()
      const failure = await pending
      expect(duringLiveCheck).toBe(failure)
      expect(failure.message).toBe('native_custody_protocol')
      expect(await duringProjection).toBe(failure)
      expect(nativeHelperFailureDiagnostic(failure)).toMatchObject({ operation: 'launch', triggerFd: 4, triggerCode: 'EIO',
        exitObservedAtTrigger: false, closeObservedAtTrigger: false, exitObserved: true, closeObserved: false, exitCode: 112 })
      expect(laterReads).toBe(0)
    } finally { fixture.child.emit('close', 112, null) }
    expect(await observed.closeUnadmitted()).toBe(true)
    expect(fixture.signals).toEqual([])
  })
  test('keeps the first pipe error separate from a later cleanup exit 112', async () => {
    const fixture = helper((_signal, child) => { queueMicrotask(() => { child.emit('exit', 112, null); child.emit('close', 112, null) }) })
    const observed = observeNativeHelper(fixture.child, 'control-peer')
    const pending = observed.stream.next('hello').then(() => null, error => error)
    let bytes = 0
    fixture.child.stdin!.on('data', (value: Buffer) => { bytes += value.length })
    fixture.stdio[4].emit('error', Object.assign(new Error('TEST first private error'), { code: 'EIO' }))
    const failure = await pending
    expect(nativeHelperFailureDiagnostic(failure)).toMatchObject({ triggerFd: 4, triggerCode: 'EIO',
      exitObservedAtTrigger: false, closeObservedAtTrigger: false, exitObserved: false, closeObserved: false })
    expect(await observed.closeUnadmitted()).toBe(true)
    fixture.stdio[3].emit('error', Object.assign(new Error('TEST later private error'), { code: 'EPIPE' }))
    expect(nativeHelperFailureDiagnostic(failure)).toMatchObject({ operation: 'control-peer', waitPhase: 'hello',
      trigger: 'stdio-error', triggerFd: 4, triggerCode: 'EIO', exitObservedAtTrigger: false, closeObservedAtTrigger: false,
      exitObserved: true, closeObserved: true, exitCode: 112, signal: null })
    expect(failure.message).toBe('native_custody_protocol')
    expect(() => { observed.assertLive(); fixture.child.stdin!.write('TEST packet must stay private') }).toThrow('native_custody_protocol')
    expect(bytes).toBe(0)
    expect(fixture.signals).toEqual(['SIGTERM'])
  })
  test('pipe diagnostics ignore getters, inherited codes and unrecognized private values', async () => {
    let getterReads = 0
    const getter = Object.defineProperty(new Error('TEST private accessor'), 'code', {
      get() { getterReads++; throw new Error('TEST getter must not run') },
    })
    const errors = [getter, Object.create({ code: 'EACCES', message: 'TEST inherited private data' }),
      Object.assign(new Error('TEST private message'), { code: 'TEST_PRIVATE_CODE' }),
      new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('TEST private descriptor failure') } })]
    for (const error of errors) {
      const fixture = helper(), observed = observeNativeHelper(fixture.child, 'measure')
      const pending = observed.stream.next('hello').then(() => null, failure => failure)
      try {
        expect(() => fixture.stdio[2].emit('error', error)).not.toThrow()
        const failure = await pending
        const diagnostic = nativeHelperFailureDiagnostic(failure)
        expect(diagnostic).toMatchObject({ operation: 'measure', trigger: 'stdio-error', triggerFd: 2, triggerCode: 'unknown' })
        expect(JSON.stringify(diagnostic)).not.toContain('TEST')
        expect(() => observed.assertLive()).toThrow('native_custody_protocol')
      } finally { fixture.child.emit('close', -1, null) }
      expect(await observed.closeUnadmitted()).toBe(true)
      expect(fixture.signals).toEqual([])
    }
    expect(getterReads).toBe(0)
  })
  test('an output error during cleanup cannot substitute for captured child close', async () => {
    const fixture = helper()
    const observed = observeNativeHelper(fixture.child)
    const pending = observed.stream.next('hello').then(() => null, error => error)
    let settled = false
    const closing = observed.closeUnadmitted().then(closed => { settled = true; return closed })
    try {
      await Promise.resolve()
      expect(fixture.signals).toEqual(['SIGTERM'])
      expect(() => fixture.stdio[3].emit('error', new Error('TEST connect failure during cleanup'))).not.toThrow()
      expect((await pending).message).toBe('native_custody_protocol')
      fixture.stdio[3].emit('close')
      await Promise.resolve()
      expect(settled).toBe(false)
      fixture.child.emit('exit', 0, null)
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(() => fixture.stdio[3].emit('error', new Error('TEST second output failure'))).not.toThrow()
    } finally { fixture.child.emit('close', 0, null) }
    expect(await closing).toBe(true)
    expect(fixture.signals).toEqual(['SIGTERM'])
  })
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
