import { expect, test } from 'bun:test'
import { readWindowsProcessStartTimeMsWithPowerShell } from './processKill.js'
import { windowsNativeProcess } from './windowsNativeProcess.js'

const windows = process.platform === 'win32'

// The shipped Bun 1.3.11 has no bun:ffi dlopen on Windows ARM64; CI Bun matches it.
const kernel32 = windows ? await windowsNativeProcess() : null

test.skipIf(!kernel32)('kernel32 table and birth match the PowerShell StartTime identity', async () => {
  const native = kernel32!
  const self = native.table().find(row => row.pid === process.pid)
  expect(self).toEqual({ pid: process.pid, ppid: process.ppid })
  // Durable registries recorded through processKill must keep comparing equal.
  const birth = native.birth(process.pid)
  expect(birth).not.toBeNull()
  // The PowerShell oracle itself can exceed its budget on a loaded runner,
  // which is the slowness kernel32 replaces. Retry only the oracle.
  let oracle: number | null = null
  for (let attempt = 0; attempt < 3 && oracle === null; attempt++) {
    oracle = await readWindowsProcessStartTimeMsWithPowerShell(process.pid, 20_000)
  }
  expect(birth).toBe(oracle)
}, 90_000)

test.skipIf(!kernel32)('an exited process held open elsewhere has no table row or birth', async () => {
  const { dlopen, FFIType } = await import('bun:ffi')
  const { symbols } = dlopen('kernel32.dll', {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  })
  const native = kernel32!
  // The child stays alive until stdin closes, independent of scheduling delays.
  const child = Bun.spawn([process.execPath, '-e', 'await Bun.stdin.text()'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' })
  // A security product or monitor holding this handle keeps the process object and its PID.
  const holder = symbols.OpenProcess(0x1000 | 0x0010_0000, 0, child.pid)
  expect(holder).not.toBe(0n)
  try {
    expect(native.table().find(row => row.pid === child.pid)).toEqual({ pid: child.pid, ppid: process.pid })
    expect(native.birth(child.pid)).toBeGreaterThan(0)
    await child.stdin.end()
    expect(await child.exited).toBe(0)
    expect(native.table().some(row => row.pid === child.pid)).toBe(false)
    expect(native.birth(child.pid)).toBeNull()
  } finally { symbols.CloseHandle(holder) }
}, 30_000)

test.skipIf(windows)('kernel32 observation is unavailable outside Windows', async () => {
  expect(await windowsNativeProcess()).toBeNull()
})

test.skipIf(!windows || process.arch !== 'x64')('Windows x64 Bun always provides kernel32 observation', () => {
  expect(kernel32).not.toBeNull()
})
