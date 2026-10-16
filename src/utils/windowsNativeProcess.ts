// Windows process observation through kernel32. Every PowerShell/WMI helper
// paid a cold process start, seconds on a busy host, and exhausted bounded
// cleanup proofs; these reads take microseconds. Birth is the creation FILETIME
// that .NET Process.StartTime reports, truncated to epoch milliseconds.

export type WindowsProcessRow = Readonly<{ pid: number; ppid: number }>

const TH32CS_SNAPPROCESS = 0x2
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const SYNCHRONIZE = 0x0010_0000
const WAIT_TIMEOUT = 0x102
const ERROR_NO_MORE_FILES = 18
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn
// 64-bit PROCESSENTRY32W: th32ProcessID at 8, th32ParentProcessID at 32.
const PROCESS_ENTRY_SIZE = 568
const FILETIME_TICKS_PER_MS = 10_000n
const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000

export type WindowsNativeProcess = Readonly<{
  table: () => WindowsProcessRow[]
  birth: (pid: number) => number | null
}>

async function loadKernel32(): Promise<WindowsNativeProcess> {
  if (process.platform !== 'win32' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
    throw new Error('windows_native_process_unavailable')
  }
  const { dlopen, FFIType, ptr } = await import('bun:ffi')
  const { symbols } = dlopen('kernel32.dll', {
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
    Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  })

  // Null is gone, exited or access denied, as for .NET Process.GetProcessById.
  // Callers keep liveness separate.
  const birth = (pid: number): number | null => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) return null
    const handle = symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid)
    if (handle === 0n) return null
    try {
      const times = Buffer.alloc(32)
      if (!symbols.GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) return null
      // Another open handle keeps an exited process object readable.
      if (symbols.WaitForSingleObject(handle, 0) !== WAIT_TIMEOUT) return null
      const value = Number(times.readBigUInt64LE(0) / FILETIME_TICKS_PER_MS) - FILETIME_UNIX_EPOCH_MS
      return Number.isSafeInteger(value) && value > 0 ? value : null
    } finally { symbols.CloseHandle(handle) }
  }

  const table = (): WindowsProcessRow[] => {
    const snapshot = symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if (snapshot === INVALID_HANDLE_VALUE || snapshot === 0n) throw new Error('Unreadable process tree')
    try {
      const entry = Buffer.alloc(PROCESS_ENTRY_SIZE)
      entry.writeUInt32LE(PROCESS_ENTRY_SIZE, 0)
      const rows: WindowsProcessRow[] = []
      let more = symbols.Process32FirstW(snapshot, ptr(entry))
      while (more) {
        rows.push({ pid: entry.readUInt32LE(8), ppid: entry.readUInt32LE(32) })
        more = symbols.Process32NextW(snapshot, ptr(entry))
      }
      // Read the error before any other call. A truncated table could omit a
      // protected or live descendant, so only normal completion is accepted.
      if (symbols.GetLastError() !== ERROR_NO_MORE_FILES || !rows.some(row => row.pid === process.pid)) {
        throw new Error('Unreadable process tree')
      }
      return rows
    } finally { symbols.CloseHandle(snapshot) }
  }

  return Object.freeze({ table, birth })
}

let kernel32: Promise<WindowsNativeProcess | null> | undefined

/** Null when this Bun build has no bun:ffi dlopen, as for Windows ARM64 before 1.4.0. */
export function windowsNativeProcess(): Promise<WindowsNativeProcess | null> {
  return kernel32 ??= loadKernel32().catch(() => null)
}
