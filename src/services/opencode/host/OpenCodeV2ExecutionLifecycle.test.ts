import { EventEmitter } from 'node:events'
import { expect, mock, test } from 'bun:test'
import type { ExecutionRetirementPort } from './OpenCodeV2ExecutionLifecycle.js'

let identityResponse: Record<string, unknown> = {}
let identityRequests = 0
const broker = {
  events: new EventEmitter(),
  request: async () => { identityRequests++; return identityResponse },
  close: async () => undefined,
  ended: () => false,
}
const isolatedBirthProbe = process.env.TEST_OPENCODE_WINDOWS_BIRTH_ISOLATED === '1'
if (isolatedBirthProbe) mock.module('./windows/OpenCodeV2WindowsNativeBroker.js', () => ({
  createWindowsNativeBroker: () => broker,
  resolveWindowsNativeArtifact: async () => ({ path: 'C:\\\\TEST\\\\helper.exe', sha256: 'a'.repeat(64), arch: 'x64' }),
  resolveWindowsRealpathArtifact: async () => ({ path: 'C:\\\\TEST\\\\realpath.dll', sha256: 'b'.repeat(64), arch: 'x64' }),
  requireWindowsRealpathArtifact: () => undefined,
}))
const { isExecutionCleanupReceipt, retireExecutionChild } = await import('./OpenCodeV2ExecutionLifecycle.js')
const { createWindowsCommandRequestHandler, createWindowsCommandRequestReplay, observeWindowsHeldMainExit, retireWindowsNativeScope, windowsBirth } = await import('./windows/OpenCodeV2WindowsExecution.js')
const { readExecutionBirth } = await import('./OpenCodeV2ExecutionBinding.js')

async function runIsolatedBirthProbe(name: string): Promise<void> {
  const child = Bun.spawn([process.execPath, 'test', import.meta.path, '--test-name-pattern', name], {
    env: { ...process.env, TEST_OPENCODE_WINDOWS_BIRTH_ISOLATED: '1' }, stdout: 'pipe', stderr: 'pipe',
  })
  const deadline = setTimeout(() => { if (child.exitCode === null) child.kill() }, 4000)
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ exit, output: exit === 0 ? '' : stdout + stderr }).toEqual({ exit: 0, output: '' })
  } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill(); await child.exited }
}

const birth = { format: 'darwin-pidversion' as const, value: '123:4', bootId: '11111111-1111-1111-1111-111111111111' }
function retirement(work: Promise<unknown>): ExecutionRetirementPort {
  return { pid: 73, birth, exited: () => true, acknowledged: () => true,
    disposeTransport: async () => undefined, sendClose: () => undefined,
    waitExit: Promise.resolve(), readBirth: async () => null, kill: () => undefined,
    retireOwnedDescendants: () => work }
}

test('retirement keeps the original identity failure while still attempting kernel cleanup', async () => {
  const failure = new Error('execution_identity_unknown'), calls: string[] = []
  const port = retirement(Promise.resolve(undefined))
  port.readBirth = async () => { calls.push('birth'); throw failure }
  port.retireOwnedDescendants = async () => { calls.push('kernel'); return undefined }
  const error = await retireExecutionChild(port).then(() => undefined, error => error)
  expect(error?.message).toBe('cleanup_unknown')
  expect(error?.cause).toBe(failure)
  expect(calls).toEqual(['birth', 'kernel'])
})

// Previously the outer four-second timeout abandoned native reaping before its
// concrete twelve-second RPC finished. Waiting longer must not confer authority.
test.skipIf(process.platform !== 'darwin')('joins native retirement beyond four seconds while refusing an unowned receipt', async () => {
  const forged = { pid: 73, birth, scopeClosed: true, tasksStarted: '8', tasksExited: '8' }
  let settled = false
  const work = new Promise<unknown>(resolve => setTimeout(() => { settled = true; resolve(forged) }, 4200))
  await expect(retireExecutionChild(retirement(work))).rejects.toThrow('cleanup_unknown')
  expect(settled).toBe(true)
  expect(isExecutionCleanupReceipt(forged)).toBe(false)
}, 6000)

// A wider native budget remains finite. A hung adapter with successful caller
// close fields must still fail without producing a durable release receipt.
test('hung native retirement is bounded and remains unknown', async () => {
  await expect(retireExecutionChild(retirement(new Promise(() => undefined)))).rejects.toThrow('cleanup_unknown')
}, process.platform === 'darwin' ? 18_000 : 6000)

test('Windows birth uses positive native exit evidence and keeps missing PIDs fail-closed', async () => {
  if (!isolatedBirthProbe) return runIsolatedBirthProbe('Windows birth uses positive native exit evidence')
  identityResponse = { absent: true }
  await expect(windowsBirth(73)).rejects.toThrow('execution_identity_unknown')
  identityResponse = { absent: 'true', exited: true, birth: { format: 'windows-filetime', value: '42', bootId: null } }
  await expect(windowsBirth(73)).rejects.toThrow('execution_identity_unknown')

  identityResponse = { exited: true, birth: { format: 'windows-filetime', value: '42', bootId: null } }
  expect(await windowsBirth(73)).toBeNull()

  identityResponse = { exited: true, birth: { format: 'windows-filetime', value: '0', bootId: null } }
  await expect(windowsBirth(73)).rejects.toThrow('execution_identity_mismatch')

  identityResponse = { exited: false, birth: { format: 'windows-filetime', value: '42', bootId: null } }
  expect(await windowsBirth(73)).toEqual({ format: 'windows-filetime', value: '42', bootId: null })

  identityResponse = { exited: false, birth: { format: 'windows-filetime', value: '0', bootId: null } }
  await expect(windowsBirth(73)).rejects.toThrow('execution_identity_mismatch')
})

test('the common birth reader dispatches Windows to the native FILETIME reader', async () => {
  if (!isolatedBirthProbe) return runIsolatedBirthProbe('the common birth reader dispatches Windows')
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  identityResponse = { exited: false, birth: { format: 'windows-filetime', value: '77', bootId: null } }
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    expect(await readExecutionBirth(73)).toEqual({ format: 'windows-filetime', value: '77', bootId: null })
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
})

test('Windows launch birth retains only the authenticated held MAIN exit when its PID cannot reopen', async () => {
  if (!isolatedBirthProbe) return runIsolatedBirthProbe('Windows launch birth retains only')
  const events = new EventEmitter(), child = new EventEmitter()
  const nativeBirth = { format: 'windows-filetime', value: '42', bootId: null } as const
  const mapping = { nonce: 'TEST-nonce', leaseOwnerId: 'TEST-lease',
    bun: { hostPID: 73, nativePID: 73, birth: nativeBirth },
    supervisor: { nativePID: 74 }, namespace: 'windows-job:TEST-nonce' }
  const errors: Error[] = []
  child.on('error', error => errors.push(error))
  const exited = observeWindowsHeldMainExit(events, child, Promise.resolve(mapping))
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  identityResponse = { exited: false, birth: nativeBirth }
  expect(await exited.readBirth()).toEqual(nativeBirth)
  identityResponse = { absent: true }
  await expect(windowsBirth(73)).rejects.toThrow('execution_identity_unknown')
  events.emit('close', 0)
  events.emit('mainExited', { heldProcessExited: true,
    mapping: { ...mapping, nonce: 'TEST-foreign' }, exitCode: 0 })
  await flush()
  expect(exited()).toBe(false)
  await expect(exited.readBirth()).rejects.toThrow('execution_identity_unknown')
  expect(errors).toHaveLength(1)
  events.emit('mainExited', { heldProcessExited: true, mapping, exitCode: 0 })
  await flush()
  const before = identityRequests
  expect(exited()).toBe(true)
  expect(await exited.readBirth()).toBeNull()
  expect(identityRequests).toBe(before)
})

test('command replay retains pending authority, a finite settled window, and lifecycle capacity', () => {
  const replay = createWindowsCommandRequestReplay()
  const held = replay.admit('held', 'commandStart')
  expect(() => replay.admit('held', 'commandStart')).toThrow('execution_native_command_unknown')

  for (let index = 0; index < 63; index++) replay.admit(`normal-${index}`, 'commandStart')
  expect(() => replay.admit('overflow', 'commandStart')).toThrow('execution_native_command_unknown')
  const close = replay.admit('close', 'commandClose')
  const retire = replay.admit('retire', 'commandRetire')
  replay.settle('close', { forged: true })
  replay.settle('close', close)
  replay.settle('retire', retire)
  expect(() => replay.admit('close', 'commandClose')).toThrow('execution_native_command_unknown')

  const windowReplay = createWindowsCommandRequestReplay()
  const windowHeld = windowReplay.admit('window-held', 'commandStart')
  for (let index = 0; index < 4097; index++) {
    const authority = windowReplay.admit(`finished-${index}`, 'commandRead')
    windowReplay.settle(`finished-${index}`, authority)
  }
  // The oldest settled ID is evicted, while an unsettled ID is never displaced.
  expect(() => windowReplay.admit('finished-0', 'commandRead')).not.toThrow()
  expect(() => windowReplay.admit('finished-1', 'commandRead')).toThrow('execution_native_command_unknown')
  expect(() => windowReplay.admit('window-held', 'commandStart')).toThrow('execution_native_command_unknown')
  windowReplay.settle('window-held', windowHeld)
  expect(() => windowReplay.admit('window-held', 'commandStart')).toThrow('execution_native_command_unknown')
})

test('closing Windows command handler drains retained commands and refuses new work without poisoning transport', async () => {
  let closing = false, nativeLive = true, failed = 0
  let liveBarrier: Promise<void> | undefined
  const calls: { operation: string; input: Record<string, unknown> }[] = []
  const nonce = 'TEST-nonce', leaseOwnerId = 'TEST-lease', commandId = 'TEST-owned-command'
  let counter = 0
  const packet = (operation: string, input: Record<string, unknown> = { commandId }) => ({
    type: 'commandRequest', nonce, leaseOwnerId, id: `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`, operation, input,
  })
  const handler = createWindowsCommandRequestHandler({ nonce, leaseOwnerId,
    ready: () => true, closing: () => closing,
    assertLive: async allowClosing => { if (!nativeLive || closing && !allowClosing) throw new Error('TEST native scope unavailable'); await liveBarrier },
    request: async (operation, input = {}) => {
      calls.push({ operation, input })
      if (operation === 'commandStart') return { commandId }
      if (operation === 'commandRetire' || operation === 'commandClose') {
        if (input.commandId !== commandId) throw new Error('TEST unowned command')
        return { empty: true, activeProcesses: 0, heldProcessExited: true }
      }
      return {}
    },
    failed: () => { failed++; throw new Error('TEST consumed error observer') },
  })
  await handler(packet('commandStart', {}))
  let release!: () => void
  liveBarrier = new Promise<void>(resolve => { release = resolve })
  const racing = packet('commandStart', {}), pending = handler(racing)
  closing = true
  release(); await pending; liveBarrier = undefined
  expect(calls.at(-1)?.input.value).toMatchObject({ id: racing.id, ok: false })
  const retire = packet('commandRetire'), close = packet('commandClose')
  await handler(retire); await handler(close)
  expect(calls.filter(call => call.operation !== 'send').map(call => call.operation)).toEqual(['commandStart', 'commandRetire', 'commandClose'])
  for (const request of [retire, close]) expect(calls.find(call => call.operation === 'send' &&
    (call.input.value as Record<string, unknown>).id === request.id)?.input.value).toMatchObject({ id: request.id, nonce, leaseOwnerId, ok: true })
  const before = calls.filter(call => call.operation !== 'send').length
  for (const operation of ['commandStart', 'commandRead', 'commandStatus', 'commandWriteStdin', 'commandEndStdin']) {
    const request = packet(operation)
    await handler(request)
    expect(calls.at(-1)?.input.value).toMatchObject({ id: request.id, nonce, leaseOwnerId, ok: false })
  }
  expect(calls.filter(call => call.operation !== 'send')).toHaveLength(before)
  await handler(packet('commandRetire', { commandId: 'TEST-foreign' }))
  expect(calls.at(-1)?.input.value).toMatchObject({ ok: false })
  nativeLive = false
  await handler(packet('commandClose'))
  expect(calls.at(-1)?.input.value).toMatchObject({ ok: false })
  await expect(handler({ ...packet('commandClose'), nonce: 'TEST-foreign' })).resolves.toBeUndefined()
  await expect(handler(retire)).resolves.toBeUndefined()
  expect(failed).toBe(2)
})

test('native retirement timeout retains only the original nonce and finite cleanup progress', async () => {
  const events = new EventEmitter(), original = new Error('execution_native_timeout')
  const request = async (operation: string) => {
    expect(operation).toBe('retire')
    events.emit('retireProgress', { nonce: 'TEST-original', phase: 'retire_grants' })
    for (const phase of ['retire_grants_dll', 'retire_grants_roots', 'retire_grants_metadata'])
      events.emit('retireProgress', { nonce: 'TEST-original', phase })
    for (const value of [{ nonce: 'TEST-foreign', phase: 'retire_wait' },
      { nonce: 'TEST-original', phase: 'TEST_PRIVATE_PAYLOAD' },
      { nonce: 'TEST-original', phase: 'retire_wait', body: 'TEST_PRIVATE_PAYLOAD' }]) events.emit('retireProgress', value)
    throw original
  }
  const error = await retireWindowsNativeScope({ events, request }, 'TEST-original').then(() => undefined, error => error)
  expect(error?.message).toBe('execution_native_timeout:retire_grants_metadata:0')
  expect(error?.cause).toBe(original)
  expect(events.listenerCount('retireProgress')).toBe(0)
  const failure = new Error('cleanup_unknown:retire_wait:0')
  await expect(retireWindowsNativeScope({ events, request: async () => { throw failure } }, 'TEST-original')).rejects.toBe(failure)
  const receipt = { empty: true }
  expect(await retireWindowsNativeScope({ events, request: async () => receipt }, 'TEST-original')).toBe(receipt)
  expect(events.listenerCount('retireProgress')).toBe(0)
})


test('Windows MAIN closes once only from its authenticated held exit, independently of helper closure', async () => {
  const events = new EventEmitter(), child = new EventEmitter()
  const mapping = { nonce: 'TEST-nonce', leaseOwnerId: 'TEST-lease',
    bun: { nativePID: 73, birth: { format: 'windows-filetime', value: '42', bootId: null } },
    supervisor: { nativePID: 74 }, namespace: 'windows-job:TEST-nonce' }
  const closes: unknown[] = [], errors: Error[] = []
  child.on('close', code => closes.push(code)); child.on('error', error => errors.push(error))
  const exited = observeWindowsHeldMainExit(events, child, Promise.resolve(mapping))
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  events.emit('close', 0); await flush()
  expect(closes).toEqual([]); expect(exited()).toBe(false)
  for (const receipt of [
    { heldProcessExited: false, mapping, exitCode: 0 },
    { heldProcessExited: true, mapping: { ...mapping, nonce: 'foreign' }, exitCode: 0 },
    { heldProcessExited: true, mapping: { ...mapping, bun: { ...mapping.bun, nativePID: 75 } }, exitCode: 0 },
    { heldProcessExited: true, mapping: { ...mapping, bun: { ...mapping.bun, birth: { ...mapping.bun.birth, value: '43' } } }, exitCode: 0 },
    { heldProcessExited: true, mapping, exitCode: -1 },
  ]) { events.emit('mainExited', receipt); await flush() }
  expect(closes).toEqual([]); expect(errors).toHaveLength(5); expect(exited()).toBe(false)
  events.emit('mainExited', { heldProcessExited: true, mapping, exitCode: 7 }); await flush()
  events.emit('mainExited', { heldProcessExited: true, mapping, exitCode: 7 }); await flush()
  expect(closes).toEqual([7]); expect(exited()).toBe(true)
})
