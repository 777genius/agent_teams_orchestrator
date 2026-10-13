import { EventEmitter } from 'node:events'
import { expect, mock, test } from 'bun:test'
import type { ExecutionRetirementPort } from './OpenCodeV2ExecutionLifecycle.js'

let identityResponse: Record<string, unknown> = {}
const broker = {
  events: new EventEmitter(),
  request: async () => identityResponse,
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
const { createWindowsCommandRequestReplay, windowsBirth } = await import('./windows/OpenCodeV2WindowsExecution.js')
const { readExecutionBirth } = await import('./OpenCodeV2ExecutionBinding.js')

async function runIsolatedBirthProbe(name: string): Promise<void> {
  const child = Bun.spawn([process.execPath, 'test', import.meta.path, '--test-name-pattern', name], {
    env: { ...process.env, TEST_OPENCODE_WINDOWS_BIRTH_ISOLATED: '1' }, stdout: 'pipe', stderr: 'pipe',
  })
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ exit, output: exit === 0 ? '' : stdout + stderr }).toEqual({ exit: 0, output: '' })
  } finally { if (child.exitCode === null) child.kill(); await child.exited }
}

const birth = { format: 'darwin-pidversion' as const, value: '123:4', bootId: '11111111-1111-1111-1111-111111111111' }
function retirement(work: Promise<unknown>): ExecutionRetirementPort {
  return { pid: 73, birth, exited: () => true, acknowledged: () => true,
    disposeTransport: async () => undefined, sendClose: () => undefined,
    waitExit: Promise.resolve(), readBirth: async () => null, kill: () => undefined,
    retireOwnedDescendants: () => work }
}

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
