import { expect, test } from 'bun:test'
import { readProcessStartTimeMs } from './processKill.js'
import { windowsNativeProcess } from './windowsNativeProcess.js'

const windows = process.platform === 'win32'

test.skipIf(!windows)('kernel32 table and birth match the PowerShell StartTime identity', async () => {
  const native = await windowsNativeProcess()
  const self = native.table().find(row => row.pid === process.pid)
  expect(self).toEqual({ pid: process.pid, ppid: process.ppid })
  // Durable registries recorded through processKill must keep comparing equal.
  const birth = native.birth(process.pid)
  expect(birth).not.toBeNull()
  expect(birth).toBe(await readProcessStartTimeMs(process.pid, 'win32', 15_000))
}, 30_000)

test.skipIf(!windows)('an exited process held open elsewhere has no table row or birth', async () => {
  const { dlopen, FFIType } = await import('bun:ffi')
  const { symbols } = dlopen('kernel32.dll', {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  })
  const native = await windowsNativeProcess()
  const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 300)'], { stdio: ['ignore', 'ignore', 'ignore'] })
  // A security product or monitor holding this handle keeps the process object and its PID.
  const holder = symbols.OpenProcess(0x1000 | 0x0010_0000, 0, child.pid)
  expect(holder).not.toBe(0n)
  try {
    expect(native.table().find(row => row.pid === child.pid)).toEqual({ pid: child.pid, ppid: process.pid })
    expect(native.birth(child.pid)).toBeGreaterThan(0)
    await child.exited
    expect(native.table().some(row => row.pid === child.pid)).toBe(false)
    expect(native.birth(child.pid)).toBeNull()
  } finally { symbols.CloseHandle(holder) }
}, 30_000)

test.skipIf(windows)('kernel32 observation is unavailable outside Windows', async () => {
  await expect(windowsNativeProcess()).rejects.toThrow('windows_native_process_unavailable')
})
