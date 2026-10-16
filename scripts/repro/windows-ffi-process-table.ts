// Spike: kernel32 process table and creation time through bun:ffi, compared
// with the current PowerShell StartTime projection. Windows only.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

if (process.platform !== 'win32') throw new Error('Windows only')
const { dlopen, FFIType, ptr } = await import('bun:ffi')
const kernel32 = dlopen('kernel32.dll', {
  CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
  Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
  GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
})
const INVALID = 0xffffffffffffffffn, ENTRY = 568
function table(): Array<{ pid: number; ppid: number }> {
  const snapshot = kernel32.symbols.CreateToolhelp32Snapshot(2, 0)
  if (snapshot === INVALID || snapshot === 0n) throw new Error('snapshot failed')
  try {
    const entry = Buffer.alloc(ENTRY)
    entry.writeUInt32LE(ENTRY, 0)
    const rows = []
    for (let ok = kernel32.symbols.Process32FirstW(snapshot, ptr(entry)); ok; ok = kernel32.symbols.Process32NextW(snapshot, ptr(entry))) {
      rows.push({ pid: entry.readUInt32LE(8), ppid: entry.readUInt32LE(32) })
    }
    return rows
  } finally { kernel32.symbols.CloseHandle(snapshot) }
}
function birth(pid: number): number | null {
  const handle = kernel32.symbols.OpenProcess(0x1000, 0, pid)
  if (handle === 0n) return null
  try {
    const times = Buffer.alloc(32)
    if (!kernel32.symbols.GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) return null
    if (times.readBigUInt64LE(8) !== 0n) return null
    return Number(times.readBigUInt64LE(0) / 10_000n) - 11_644_473_600_000
  } finally { kernel32.symbols.CloseHandle(handle) }
}
const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
function powershellBirth(pid: number): number | null {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$p = [System.Diagnostics.Process]::GetProcessById(${pid}); $p.StartTime.ToUniversalTime().ToString("o"); $p.Dispose()`], { encoding: 'utf8', windowsHide: true })
  const value = Date.parse(result.stdout.trim())
  return Number.isFinite(value) ? value : null
}

let started = performance.now()
const rows = table()
const tableMs = performance.now() - started
started = performance.now()
const births = rows.slice(0, 200).map(row => birth(row.pid))
const birthMs = (performance.now() - started) / Math.min(200, rows.length)
const self = rows.find(row => row.pid === process.pid)
const samples = [process.pid, process.ppid, ...rows.filter(row => row.ppid === process.ppid).map(row => row.pid)].slice(0, 4)
const comparisons = samples.map(pid => ({ pid, ffi: birth(pid), powershell: powershellBirth(pid) }))
const child = Bun.spawn([process.execPath, '-e', 'setTimeout(()=>{}, 300)'], { stdio: ['ignore', 'ignore', 'ignore'] })
const childBirth = birth(child.pid)
await child.exited
const afterExit = birth(child.pid)
const report = {
  bun: Bun.version, arch: process.arch, compiled: !process.execPath.toLowerCase().endsWith('bun.exe'),
  rows: rows.length, tableMs: Math.round(tableMs * 100) / 100, perBirthMs: Math.round(birthMs * 1000) / 1000,
  readableBirths: births.filter(value => value !== null).length,
  selfRow: self, selfParentMatches: self?.ppid === process.ppid,
  comparisons, equal: comparisons.every(item => item.ffi === item.powershell),
  childBirth, afterExit,
}
console.log(JSON.stringify(report, null, 2))
if (!report.equal || report.afterExit !== null || report.childBirth === null || !report.selfParentMatches) process.exit(1)
