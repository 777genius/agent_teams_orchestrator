import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const PROCESS_QUERY_TIMEOUT_MS = 2_500
// Cold PowerShell/.NET activation on Windows regularly exceeds the generic
// process-query budget. Process identity has its own bounded budget and never
// extends an explicit caller-provided deadline.
const WINDOWS_PROCESS_START_TIME_QUERY_TIMEOUT_MS = 5_000
const PROCESS_START_TIME_OUTPUT_LIMIT_BYTES = 64 * 1024
const PROCESS_COMMAND_OUTPUT_LIMIT_BYTES = 256 * 1024

export type ExactProcessTreeSpawn = {
  command: string
  args: string[]
  options: SpawnOptions
  osIdentity: string
}

/** Serialize argv using the quoting rules consumed by Win32 native runtimes. */
function buildWindowsProcessArguments(args: string[]): string {
  return args.map(argument => {
    let quoted = '"'
    let backslashes = 0
    for (const character of argument) {
      if (character === '\\') {
        backslashes += 1
        continue
      }
      if (character === '"') {
        quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
      } else {
        quoted += '\\'.repeat(backslashes) + character
      }
      backslashes = 0
    }
    return quoted + '\\'.repeat(backslashes * 2) + '"'
  }).join(' ')
}

/** Windows PowerShell 5.1-compatible transport for supervisor source. */
function toWindowsPowerShellEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Build a launch with the strongest ownership boundary available here.
 * Windows uses a named Job owned by a supervisor which joins itself before
 * starting application code. Unix detached process groups are only a
 * cooperative cleanup boundary: descendants can escape with setpgid/setsid,
 * so they are never reported as exact whole-tree containment.
 */
export function buildExactProcessTreeSpawn(
  command: string,
  args: string[],
  options: SpawnOptions,
  platform: NodeJS.Platform = process.platform,
): ExactProcessTreeSpawn {
  if (platform !== 'win32') {
    return { command, args, options: { ...options, detached: true }, osIdentity: 'unix-pgid:pending' }
  }
  const name = `agent-teams-${randomUUID()}`
  const payload = Buffer.from(JSON.stringify({
    command,
    arguments: buildWindowsProcessArguments(args),
  }), 'utf8').toString('base64')
  const script = [
    '$ErrorActionPreference="Stop"',
    'Add-Type -TypeDefinition @"\nusing System; using System.Runtime.InteropServices; public static class J { [StructLayout(LayoutKind.Sequential)] public struct B { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; } [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; } [StructLayout(LayoutKind.Sequential)] public struct E { public B BasicLimitInformation; public IO IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; } [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a,string n); [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr h,int c,ref E i,uint l); [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr h,IntPtr p); [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess(); }\n"@',
    `$h=[J]::CreateJobObject([IntPtr]::Zero,'${name}')`,
    'if($h -eq [IntPtr]::Zero){exit 50}',
    '$b=New-Object J+B; $b.LimitFlags=0x2000',
    '$i=New-Object J+E; $i.BasicLimitInformation=$b',
    'if(-not [J]::SetInformationJobObject($h,9,[ref]$i,[Runtime.InteropServices.Marshal]::SizeOf($i))){exit 51}',
    'if(-not [J]::AssignProcessToJobObject($h,[J]::GetCurrentProcess())){exit 52}',
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json`,
    '$s=New-Object Diagnostics.ProcessStartInfo',
    // ProcessStartInfo bypasses the PowerShell invocation operator which
    // rewrites embedded quotes before launching native Windows executables.
    '$s.FileName=[string]$p.command; $s.Arguments=[string]$p.arguments; $s.UseShellExecute=$false',
    '$c=[Diagnostics.Process]::Start($s); if($null -eq $c){exit 53}',
    '$c.WaitForExit(); exit $c.ExitCode',
  ].join(';')
  return {
    command: 'powershell.exe',
    // Do not use cmd.exe or the PowerShell invocation operator here.
    // `arguments` is a single Win32 command line built with the documented
    // backslash/quote rules; ProcessStartInfo.Arguments exists in .NET Framework.
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      toWindowsPowerShellEncodedCommand(script)],
    options: { ...options, detached: false, windowsHide: true },
    osIdentity: `win32-job:${name}`,
  }
}

export type ProcessKillAndWaitDependencies = {
  platform?: NodeJS.Platform
  isProcessAlive?: (pid: number) => boolean
  /** The timeout is derived from the caller's still-live operation budget. */
  readProcessStartTimeMs?: (pid: number, timeoutMs?: number) => Promise<number | null>
  /**
   * Signals through an OS-stable handle bound to the expected incarnation
   * (for example Linux pidfd_send_signal). Never implement this as a fresh PID
   * lookup or ChildProcess.kill(): both are ordinary PID signaling in Node/Bun.
   */
  signalExpectedProcess?: (
    pid: number,
    signal: NodeJS.Signals,
    expectedStartedAtMs: number,
    expectedOsIdentity?: string,
  ) => Promise<boolean>
  terminateExpectedProcessTree?: typeof terminateExpectedProcessTreeStable
  nowMs?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type ExactProcessTreeTerminationOptions = {
  timeoutMs: number
  pollMs: number
  escalationTimeoutMs: number
  nowMs: () => number
  sleep: (ms: number) => Promise<void>
  platform?: NodeJS.Platform
  darwinBoundary?: DarwinProcessTreeBoundary
  /**
   * These are deliberately callbacks rather than a timeout snapshot.  A
   * caller can cancel or exhaust its one operation budget while a tree is
   * being enumerated, signalled, or verified.
   */
  signal?: AbortSignal
  remainingMs?: () => number
}

function processKillMayContinue(options: Pick<ExactProcessTreeTerminationOptions, 'signal' | 'remainingMs'>): boolean {
  return !options.signal?.aborted && (options.remainingMs?.() ?? 1) > 0
}

function processKillPollMs(options: ExactProcessTreeTerminationOptions): number {
  const remaining = options.remainingMs?.()
  return Math.max(1, Math.min(options.pollMs, remaining === undefined ? options.pollMs : Math.floor(remaining)))
}

export type ProcessTreeContainmentCapability = 'exact' | 'cooperative' | 'unsupported'

/**
 * Classify whether an identity can prove exhaustion of every descendant.
 *
 * A Linux cgroup v2 boundary could be exact, but this runtime has no deployment
 * contract guaranteeing a delegated writable cgroup subtree. Creating or
 * mutating host cgroups opportunistically would be unsafe. Plain Unix process
 * groups therefore remain cooperative and must fail closed after cleanup.
 */
export function getProcessTreeContainmentCapability(
  expectedOsIdentity: string | undefined,
  platform: NodeJS.Platform = process.platform,
): ProcessTreeContainmentCapability {
  if (platform === 'win32' && (expectedOsIdentity?.startsWith('win32-job:') || expectedOsIdentity?.startsWith('win32-agent-job:'))) return 'exact'
  if (platform === 'linux' && expectedOsIdentity?.startsWith('unix-pgid:')) return 'cooperative'
  if (platform === 'darwin' && expectedOsIdentity?.startsWith('darwin-audit:')) return 'cooperative'
  return 'unsupported'
}

export type DarwinProcessTreeMember = {
  pid: number
  auditIdentity: string
  nativeToken?: Buffer
}

export type DarwinProcessTreeBoundary = {
  listMembers: (pgid: number) => Promise<number[] | null>
  acquireMember: (pid: number, pgid: number) => Promise<DarwinProcessTreeMember | null>
  /** Re-read the kernel audit token immediately before a signal. */
  revalidateMember?: (member: DarwinProcessTreeMember, pgid: number, requireAncestry: boolean) => Promise<boolean>
  signalMember: (member: DarwinProcessTreeMember, signal: NodeJS.Signals) => Promise<boolean>
  close?: () => void
}

type StableSignalPlatform = Extract<NodeJS.Platform, 'linux' | 'darwin' | 'win32'>
let stableSignalPlatformForTests: StableSignalPlatform | null = null
let stableSignalPlatformImplForTests:
  | ((pid: number, signal: NodeJS.Signals, expectedStartedAtMs: number, expectedOsIdentity?: string) => Promise<boolean>)
  | null = null

export function __setStableSignalPlatformForTests(
  platform: StableSignalPlatform | null,
  impl: typeof stableSignalPlatformImplForTests = null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setStableSignalPlatformForTests is only available in tests')
  }
  stableSignalPlatformForTests = platform
  stableSignalPlatformImplForTests = impl
}

const LINUX_PIDFD_SEND_SIGNAL_SYSCALL = 424
const LINUX_SIGNAL_NUMBER: Partial<Record<NodeJS.Signals, number>> = {
  SIGTERM: 15,
  SIGKILL: 9,
  SIGINT: 2,
  SIGHUP: 1,
  SIGSTOP: 19,
  SIGCONT: 18,
}

// Darwin deliberately does not share Linux's stop/continue numbers. Keep this
// table separate so a macOS path can never accidentally inherit a Linux ABI
// constant (Darwin: STOP=17, CONT=19; Linux: STOP=19, CONT=18).
export const DARWIN_SIGNAL_NUMBER: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGKILL: 9,
  SIGTERM: 15,
  SIGSTOP: 17,
  SIGCONT: 19,
}

function temporarilyFrozenForSignal(signal: NodeJS.Signals): boolean {
  // An explicit stop is the requested terminal state, not an implementation
  // detail to undo. TERM/INT/HUP need a continuation so their handler can run.
  return signal !== 'SIGKILL' && signal !== 'SIGSTOP'
}

/** Signal a concrete Linux process incarnation through a pidfd. */
export async function signalExpectedProcessStable(
  pid: number,
  signal: NodeJS.Signals,
  expectedStartedAtMs: number,
  expectedOsIdentity?: string,
): Promise<boolean> {
  const platform = stableSignalPlatformForTests ?? process.platform
  if (stableSignalPlatformImplForTests) {
    return stableSignalPlatformImplForTests(pid, signal, expectedStartedAtMs, expectedOsIdentity)
  }
  if (platform === 'darwin') {
    const signalNumber = DARWIN_SIGNAL_NUMBER[signal]
    // A task token acquired now identifies only the process that owns this
    // numeric PID now. It is not ownership evidence for an earlier process.
    // Require the launch-captured exact token and compare it before signal.
    if (!signalNumber || !expectedOsIdentity?.startsWith('darwin-audit:')) return false
    try {
      const { dlopen, FFIType, ptr } = await import('bun:ffi')
      const libproc = dlopen('/usr/lib/libproc.dylib', {
        proc_signal_with_audittoken: {
          args: [FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
      })
      const libc = dlopen('/usr/lib/libSystem.B.dylib', {
        task_name_for_pid: {
          args: [FFIType.u32, FFIType.i32, FFIType.ptr],
          returns: FFIType.i32,
        },
        task_info: {
          args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
        mach_port_deallocate: {
          args: [FFIType.u32, FFIType.u32],
          returns: FFIType.i32,
        },
        mach_task_self: { args: [], returns: FFIType.u32 },
      })
      try {
        const selfTask = Number(libc.symbols.mach_task_self())
        const taskPortBuffer = Buffer.alloc(4)
        if (libc.symbols.task_name_for_pid(selfTask, pid, ptr(taskPortBuffer)) !== 0) return false
        const taskPort = taskPortBuffer.readUInt32LE(0)
        try {
          const auditToken = Buffer.alloc(32)
          const count = Buffer.alloc(4)
          count.writeUInt32LE(8, 0)
          if (libc.symbols.task_info(taskPort, 15, ptr(auditToken), ptr(count)) !== 0) return false
          // Compare the kernel token acquired for this task port with the token
          // captured at spawn. A recycled PID has a different pidversion even
          // if a timestamp observer is stale or collides.
          if (`darwin-audit:${auditToken.toString('hex')}` !== expectedOsIdentity) return false
          // Freeze this exact incarnation before the destructive signal. Each
          // tree member is enumerated and signalled through its own audit
          // token; do not use killpg because Cursor agents need not lead a
          // private process group.
          if (libproc.symbols.proc_signal_with_audittoken(ptr(auditToken), DARWIN_SIGNAL_NUMBER.SIGSTOP!) !== 0) return false
          try {
            if (libproc.symbols.proc_signal_with_audittoken(ptr(auditToken), signalNumber) !== 0) return false
            // A stopped process does not act on SIGTERM until continued.
            if (temporarilyFrozenForSignal(signal)) {
              if (libproc.symbols.proc_signal_with_audittoken(ptr(auditToken), DARWIN_SIGNAL_NUMBER.SIGCONT!) !== 0) return false
            }
            return true
          } catch {
            return false
          }
        } finally {
          libc.symbols.mach_port_deallocate(selfTask, taskPort)
        }
      } finally {
        libproc.close()
        libc.close()
      }
    } catch {
      return false
    }
  }
  const signalNumber = LINUX_SIGNAL_NUMBER[signal]
  if (!signalNumber) return false
  if (platform === 'win32') {
    if (!expectedOsIdentity?.startsWith('win32-job:')) return false
    const jobName = expectedOsIdentity.slice('win32-job:'.length)
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(jobName)) return false
    const command = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -TypeDefinition @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class ExactProcessHandle {',
      '  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }',
      '  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr OpenJobObject(uint access, bool inherit, string name);',
      '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr h, uint code);',
      '  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);',
      '}',
      '"@',
      `$h = [ExactProcessHandle]::OpenJobObject(0x0008, $false, '${jobName}')`,
      'if ($h -eq [IntPtr]::Zero) { exit 41 }',
      'try {',
      '  if (-not [ExactProcessHandle]::TerminateJobObject($h, 1)) { exit 44 }',
      '} finally { [void][ExactProcessHandle]::CloseHandle($h) }',
    ].join('; ')
    return await new Promise(resolve => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
      ], { stdio: 'ignore', windowsHide: true })
      child.once('error', () => resolve(false))
      child.once('close', code => resolve(code === 0))
    })
  }
  if (platform !== 'linux') return false
  if (expectedOsIdentity !== `unix-pgid:${pid}`) return false
  try {
    const { dlopen, FFIType } = await import('bun:ffi')
    const libc = dlopen('libc.so.6', {
      pidfd_open: {
        args: [FFIType.i32, FFIType.u32],
        returns: FFIType.i32,
      },
      syscall: {
        args: [FFIType.i64, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i64,
      },
      close: {
        args: [FFIType.i32],
        returns: FFIType.i32,
      },
    })
    const pidfd = libc.symbols.pidfd_open(pid, 0)
    if (pidfd < 0) {
      libc.close()
      return false
    }
    try {
      // pidfd_open is the ownership boundary. Re-read the PID identity only
      // after acquiring it; any exit/reuse on either side fails closed while
      // the signal remains bound to the opened incarnation.
      const observedStartedAtMs = await readProcessStartTimeMs(pid, 'linux')
      if (
        observedStartedAtMs === null ||
        Math.abs(observedStartedAtMs - expectedStartedAtMs) > 1
      ) {
        return false
      }
      // This lower-level primitive is root-only. Whole-tree termination must
      // use terminateExpectedProcessTreeStable, which acquires every member by
      // pidfd. Never fall back to numeric killpg on Linux.
      return Number(libc.symbols.syscall(
        LINUX_PIDFD_SEND_SIGNAL_SYSCALL,
        pidfd,
        signalNumber,
        null,
        0,
      )) === 0
    } finally {
      libc.symbols.close(pidfd)
      libc.close()
    }
  } catch {
    return false
  }
}

type LinuxProcessStat = { state: string; pgid: number; startedAt: number }

async function readLinuxProcessStat(pid: number): Promise<LinuxProcessStat | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = stat.lastIndexOf(')')
    if (commandEnd < 0) return null
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/)
    const state = fields[0] ?? ''
    const pgid = Number(fields[2])
    const startedAt = Number(fields[19])
    return Number.isSafeInteger(pgid) && Number.isSafeInteger(startedAt)
      ? { state, pgid, startedAt }
      : null
  } catch {
    return null
  }
}

async function listLinuxProcessGroupMembers(pgid: number): Promise<number[] | null> {
  try {
    const entries = await readdir('/proc', { withFileTypes: true })
    const members: number[] = []
    await Promise.all(entries.map(async entry => {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return
      const pid = Number(entry.name)
      const stat = await readLinuxProcessStat(pid)
      // Zombies have completed execution and cannot retain descendants. They
      // remain in /proc only until their parent reaps the exit status.
      if (stat?.pgid === pgid && stat.state !== 'Z') members.push(pid)
    }))
    return members.sort((a, b) => a - b)
  } catch {
    return null
  }
}

/**
 * Proves exhaustion after the exact ChildProcess object reports natural exit.
 * This is deliberately narrower than generic PID cleanup: an empty captured
 * Linux PGID means no descendant can later reappear, while any member or
 * unreadable process table remains ambiguous and fails closed.
 */
export async function confirmNaturalProcessTreeExit(
  pid: number,
  expectedOsIdentity: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
  dependencies: {
    isProcessAlive?: (pid: number) => boolean
    listLinuxProcessGroupMembers?: (pgid: number) => Promise<number[] | null>
    queryWindowsJobAfterSupervisorExit?: (
      expectedOsIdentity: string,
    ) => Promise<'absent' | 'empty' | 'active' | 'unverifiable'>
  } = {},
): Promise<boolean> {
  const processAlive = dependencies.isProcessAlive ?? isProcessAlive
  if (platform === 'win32') {
    if (!expectedOsIdentity?.startsWith('win32-job:') || processAlive(pid)) return false
    const query = dependencies.queryWindowsJobAfterSupervisorExit ?? queryWindowsJobAfterSupervisorExit
    const state = await query(expectedOsIdentity)
    // This helper is only called after the exact supervisor ChildProcess has
    // emitted close. A missing KILL_ON_JOB_CLOSE Job then proves its final
    // handle closed and every contained child was terminated; an extant Job
    // is safe only when the kernel reports zero active processes.
    return state === 'absent' || state === 'empty'
  }
  if (platform !== 'linux' || expectedOsIdentity !== `unix-pgid:${pid}` || processAlive(pid)) return false
  const listMembers = dependencies.listLinuxProcessGroupMembers ?? listLinuxProcessGroupMembers
  const first = await listMembers(pid)
  if (!first || first.length > 0) return false
  await new Promise<void>(resolve => setImmediate(resolve))
  const second = await listMembers(pid)
  return second !== null && second.length === 0 && !processAlive(pid)
}

async function queryWindowsJobAfterSupervisorExit(
  expectedOsIdentity: string,
): Promise<'absent' | 'empty' | 'active' | 'unverifiable'> {
  const jobName = expectedOsIdentity.slice('win32-job:'.length)
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(jobName)) return 'unverifiable'
  const script = [
    '$ErrorActionPreference="Stop"',
    'Add-Type -TypeDefinition @"\nusing System; using System.Runtime.InteropServices; public static class JN { [StructLayout(LayoutKind.Sequential)] public struct A { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; } [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr OpenJobObject(uint a,bool i,string n); [DllImport("kernel32.dll",SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr h,int c,ref A i,uint l,IntPtr r); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h); }\n"@',
    `$h=[JN]::OpenJobObject(0x0004,$false,'${jobName}')`,
    'if($h -eq [IntPtr]::Zero){if([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 2){exit 10};exit 13}',
    'try {$a=New-Object JN+A;if(-not [JN]::QueryInformationJobObject($h,1,[ref]$a,[Runtime.InteropServices.Marshal]::SizeOf($a),[IntPtr]::Zero)){exit 13};if($a.ActiveProcesses -eq 0){exit 11};exit 12} finally {[void][JN]::CloseHandle($h)}',
  ].join(';')
  return new Promise(resolve => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { stdio: 'ignore', windowsHide: true })
    child.once('error', () => resolve('unverifiable'))
    child.once('close', code => resolve(
      code === 10 ? 'absent' : code === 11 ? 'empty' : code === 12 ? 'active' : 'unverifiable',
    ))
  })
}

async function terminateWindowsJobStable(
  expectedOsIdentity: string | undefined,
  options: ExactProcessTreeTerminationOptions,
): Promise<boolean> {
  const prefix = expectedOsIdentity?.startsWith('win32-agent-job:')
    ? 'win32-agent-job:' : expectedOsIdentity?.startsWith('win32-job:') ? 'win32-job:' : null
  if (!prefix || !processKillMayContinue(options)) return false
  const jobName = expectedOsIdentity.slice(prefix.length)
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(jobName)) return false
  /*
   * TerminateJobObject is executed by this parent through its own native
   * handle.  Do not introduce an authorization file for a helper: a cached
   * permission can be read after revocation and race the destructive call.
   */
  try {
    if (!processKillMayContinue(options)) return false
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    if (!processKillMayContinue(options)) return false
    const kernel32 = dlopen('kernel32.dll', {
      OpenJobObjectW: { args: [FFIType.u32, FFIType.bool, FFIType.ptr], returns: FFIType.ptr },
      TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
      QueryInformationJobObject: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.bool,
      },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    })
    const name = Buffer.from(`${jobName}\0`, 'utf16le')
    const handle = kernel32.symbols.OpenJobObjectW(0x000c, false, ptr(name))
    if (!handle) { kernel32.close(); return false }
    try {
      if (!processKillMayContinue(options) || !kernel32.symbols.TerminateJobObject(handle, 1)) return false
      // TerminateJobObject returning success proves only that the request was
      // accepted. Query the still-open launch-bound Job until the kernel says
      // it contains no active processes; a root PID disappearing is not a
      // whole-tree receipt.
      const deadline = options.nowMs() + options.timeoutMs
      while (options.nowMs() < deadline) {
        const accounting = Buffer.alloc(48)
        if (!kernel32.symbols.QueryInformationJobObject(handle, 1, ptr(accounting), accounting.length, null)) return false
        if (accounting.readUInt32LE(40) === 0) return true
        await options.sleep(processKillPollMs(options))
      }
      const accounting = Buffer.alloc(48)
      return kernel32.symbols.QueryInformationJobObject(handle, 1, ptr(accounting), accounting.length, null)
        && accounting.readUInt32LE(40) === 0
    } finally { kernel32.symbols.CloseHandle(handle); kernel32.close() }
  } catch { return false }
}

/**
 * Terminate a Linux detached process group without ever addressing it through
 * a numeric killpg. Every member is opened and revalidated through a pidfd,
 * frozen through that handle, and only then signalled through the same handle.
 */
async function terminateLinuxProcessTreeStable(
  pid: number,
  signal: NodeJS.Signals,
  expectedStartedAtMs: number,
  expectedOsIdentity: string | undefined,
  options: ExactProcessTreeTerminationOptions,
): Promise<boolean> {
  if (expectedOsIdentity !== `unix-pgid:${pid}`) return false
  const signalNumber = LINUX_SIGNAL_NUMBER[signal]
  if (!signalNumber) return false
  if (!processKillMayContinue(options)) return false
  try {
    const { dlopen, FFIType } = await import('bun:ffi')
    const libc = dlopen('libc.so.6', {
      pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
      syscall: {
        args: [FFIType.i64, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i64,
      },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    })
    const handles = new Map<number, number>()
    // These are pidfds for members for which our temporary SIGSTOP was
    // acknowledged. Keep them separate from `handles`: an acquired member is
    // not necessarily stopped, and cleanup must never manufacture a PID
    // signal after cancellation or a deadline has expired.
    const frozen = new Map<number, number>()
    let terminationCompleted = false
    // Do not let a cancellation/deadline race an already-acquired pidfd.  The
    // fd binds the process incarnation, but the caller's authority still has
    // to be live at the instant a destructive syscall is made.
    const pidfdSignal = (fd: number, number: number): boolean => {
      if (!processKillMayContinue(options)) return false
      return Number(libc.symbols.syscall(LINUX_PIDFD_SEND_SIGNAL_SYSCALL, fd, number, null, 0)) === 0
    }
    const acquire = async (memberPid: number): Promise<boolean> => {
      if (!processKillMayContinue(options)) return false
      if (handles.has(memberPid)) return true
      const fd = libc.symbols.pidfd_open(memberPid, 0)
      if (fd < 0) return false
      const stat = await readLinuxProcessStat(memberPid)
      if (!stat || stat.pgid !== pid || (memberPid === pid && stat.startedAt !== expectedStartedAtMs)) {
        libc.symbols.close(fd)
        return false
      }
      handles.set(memberPid, fd)
      return true
    }
    const freeze = (memberPid: number): boolean => {
      if (frozen.has(memberPid)) return true
      const fd = handles.get(memberPid)
      if (fd === undefined || !pidfdSignal(fd, 19)) return false
      frozen.set(memberPid, fd)
      return true
    }
    const resumeFrozen = (): void => {
      // Cleanup has a different authority model from termination. A pidfd is
      // already bound to the exact incarnation we froze, so SIGCONT cannot
      // reach a reused PID and must run even after cancellation/deadline.
      if (signal === 'SIGSTOP') return
      for (const fd of frozen.values()) {
        try { libc.symbols.syscall(LINUX_PIDFD_SEND_SIGNAL_SYSCALL, fd, 18, null, 0) } catch {}
      }
      frozen.clear()
    }
    const continueFrozen = (): boolean => {
      let continued = true
      for (const [memberPid, fd] of frozen) {
        if (!pidfdSignal(fd, 18)) { continued = false; continue }
        frozen.delete(memberPid)
      }
      return continued
    }
    try {
      if (!(await acquire(pid))) return false
      // Pin and freeze the exact root before any group discovery. Holding its
      // pidfd keeps the ownership anchor alive while descendants are acquired.
      if (!freeze(pid)) return false

      let previous = ''
      for (let pass = 0; pass < 64; pass += 1) {
        if (!processKillMayContinue(options)) return false
        const members = await listLinuxProcessGroupMembers(pid)
        if (!members) return false
        for (const memberPid of members) {
          if (!(await acquire(memberPid))) return false
          if (!freeze(memberPid)) return false
        }
        const fingerprint = [...handles.keys()].sort((a, b) => a - b).join(',')
        if (fingerprint === previous && members.every(memberPid => handles.has(memberPid))) break
        previous = fingerprint
        if (pass === 63) return false
      }

      // The discovery freeze itself is the complete explicit STOP operation.
      // Do not duplicate STOP or convert the request into CONT/KILL cleanup.
      if (signal === 'SIGSTOP') return false
      const sendAll = (number: number): boolean => {
        let sent = true
        // Root last: descendants cannot outlive an early root signal without
        // first being captured and frozen.
        const ordered = [...handles.entries()].sort(([a], [b]) => (a === pid ? 1 : b === pid ? -1 : a - b))
        for (const [, fd] of ordered) {
          // Recheck for each member, not just once before the batch. A large
          // tree can cross the operation deadline in the middle of a pass.
          if (!processKillMayContinue(options)) return false
          sent = pidfdSignal(fd, number) && sent
        }
        return sent
      }
      if (!sendAll(signalNumber)) return false
      if (signal !== 'SIGKILL' && !continueFrozen()) return false

      const waitUntilEmpty = async (deadline: number, escalation: boolean): Promise<boolean> => {
        while (processKillMayContinue(options) && options.nowMs() < deadline) {
          const members = await listLinuxProcessGroupMembers(pid)
          if (!members) return false
          if (members.length === 0) return true
          for (const memberPid of members) {
            const alreadyCaptured = handles.has(memberPid)
            if (!(await acquire(memberPid))) return false
            if (escalation) {
              if (!processKillMayContinue(options) || !pidfdSignal(handles.get(memberPid)!, 9)) return false
            } else if (!alreadyCaptured) {
              // A TERM handler may fork before exiting. Newly observed members
              // are still in the pinned PGID and receive the same graceful
              // signal through their own validated pidfd.
              if (!freeze(memberPid)) return false
              if (!pidfdSignal(handles.get(memberPid)!, signalNumber)) return false
              if (signal !== 'SIGKILL' && !continueFrozen()) return false
            }
          }
          await options.sleep(processKillPollMs(options))
        }
        if (!processKillMayContinue(options)) return false
        const members = await listLinuxProcessGroupMembers(pid)
        return members !== null && members.length === 0
      }
      if (await waitUntilEmpty(options.nowMs() + options.timeoutMs, false)) {
        terminationCompleted = true
        return true
      }
      if (!processKillMayContinue(options) || !sendAll(9)) return false
      const empty = await waitUntilEmpty(options.nowMs() + options.escalationTimeoutMs, true)
      terminationCompleted = empty
      return empty
    } finally {
      if (!terminationCompleted) resumeFrozen()
      for (const fd of handles.values()) libc.symbols.close(fd)
      libc.close()
    }
  } catch {
    return false
  }
}

async function createNativeDarwinProcessTreeBoundary(): Promise<DarwinProcessTreeBoundary | null> {
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const libproc = dlopen('/usr/lib/libproc.dylib', {
      proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
      proc_signal_with_audittoken: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    })
    const libc = dlopen('/usr/lib/libSystem.B.dylib', {
      task_name_for_pid: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      task_info: { args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      mach_port_deallocate: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
      mach_task_self: { args: [], returns: FFIType.u32 },
      getpgid: { args: [FFIType.i32], returns: FFIType.i32 },
    })
    const selfTask = Number(libc.symbols.mach_task_self())
    let closed = false
    const listMembers = async (pgid: number): Promise<number[] | null> => {
      if (closed) return null
      const capacity = libproc.symbols.proc_listallpids(null, 0)
      if (capacity <= 0) return null
      const buffer = Buffer.alloc((capacity + 32) * 4)
      const count = libproc.symbols.proc_listallpids(ptr(buffer), buffer.length)
      if (count < 0 || count > buffer.length / 4) return null
      const members: number[] = []
      for (let index = 0; index < count; index += 1) {
        const memberPid = buffer.readInt32LE(index * 4)
        if (memberPid <= 0 || libc.symbols.getpgid(memberPid) !== pgid) continue
        const info = Buffer.alloc(DARWIN_PROC_BSDINFO_SIZE)
        const bytes = libproc.symbols.proc_pidinfo(
          memberPid, DARWIN_PROC_PIDTBSDINFO, 0, ptr(info), info.length,
        )
        // pbi_status is the uint32 at offset 4; SZOMB is 5.
        // Once getpgid observed this member inside the owned group, failure to
        // classify it is not proof of exit. Fail closed instead of silently
        // treating an unreadable live descendant as an empty boundary.
        if (bytes !== info.length) return null
        if (info.readUInt32LE(4) !== 5) members.push(memberPid)
      }
      return members.sort((a, b) => a - b)
    }
    const acquireMember = async (memberPid: number, pgid: number): Promise<DarwinProcessTreeMember | null> => {
      if (closed) return null
      const portBuffer = Buffer.alloc(4)
      if (libc.symbols.task_name_for_pid(selfTask, memberPid, ptr(portBuffer)) !== 0) return null
      const taskPort = portBuffer.readUInt32LE(0)
      try {
        const token = Buffer.alloc(32)
        const count = Buffer.alloc(4)
        count.writeUInt32LE(8, 0)
        if (libc.symbols.task_info(taskPort, 15, ptr(token), ptr(count)) !== 0) return null
        // Revalidate group membership only after the kernel supplied the exact
        // audit token. Signals below address this incarnation, never this PID.
        if (libc.symbols.getpgid(memberPid) !== pgid) return null
        return {
          pid: memberPid,
          auditIdentity: `darwin-audit:${token.toString('hex')}`,
          nativeToken: token,
        }
      } finally {
        libc.symbols.mach_port_deallocate(selfTask, taskPort)
      }
    }
    return {
      listMembers,
      acquireMember,
      revalidateMember: async (member, pgid, requireAncestry) => {
        if (closed) return false
        const portBuffer = Buffer.alloc(4)
        if (libc.symbols.task_name_for_pid(selfTask, member.pid, ptr(portBuffer)) !== 0) return false
        const taskPort = portBuffer.readUInt32LE(0)
        try {
          const token = Buffer.alloc(32)
          const count = Buffer.alloc(4)
          count.writeUInt32LE(8, 0)
          if (libc.symbols.task_info(taskPort, 15, ptr(token), ptr(count)) !== 0) return false
          // This comparison binds the following audit-token signal to the
          // same incarnation whose ancestry was admitted.  A PID reuse in
          // either gap cannot pass it.
          if (`darwin-audit:${token.toString('hex')}` !== member.auditIdentity) return false
          return !requireAncestry || libc.symbols.getpgid(member.pid) === pgid
        } finally {
          libc.symbols.mach_port_deallocate(selfTask, taskPort)
        }
      },
      signalMember: async (member, memberSignal) => {
        const number = DARWIN_SIGNAL_NUMBER[memberSignal]
        return Boolean(number && member.nativeToken &&
          libproc.symbols.proc_signal_with_audittoken(ptr(member.nativeToken), number) === 0)
      },
      close: () => {
        if (closed) return
        closed = true
        libproc.close()
        libc.close()
      },
    }
  } catch {
    return null
  }
}

async function terminateDarwinProcessTreeStable(
  pid: number,
  signal: NodeJS.Signals,
  expectedOsIdentity: string | undefined,
  options: ExactProcessTreeTerminationOptions,
): Promise<boolean> {
  if (!expectedOsIdentity?.startsWith('darwin-audit:')) return false
  if (!processKillMayContinue(options)) return false
  const boundary = options.darwinBoundary ?? await createNativeDarwinProcessTreeBoundary()
  if (!boundary) return false
  const members = new Map<number, DarwinProcessTreeMember>()
  const frozen = new Map<number, DarwinProcessTreeMember>()
  let terminationCompleted = false
  const resumeTemporaryFreezes = async (): Promise<void> => {
    // A Mach audit token is an exact process capability. Cleanup intentionally
    // bypasses the now-expired destructive-operation authorization, while the
    // token guarantees that a recycled numeric PID is never continued.
    if (signal === 'SIGSTOP') return
    for (const member of frozen.values()) {
      // Rollback is exact-capability cleanup, not a new destructive action.
      // It deliberately bypasses a cancelled work guard, but refreshes the
      // audit identity immediately before CONT so a recycled PID is never hit.
      const valid = await boundary.revalidateMember?.(member, pid, false) ?? true
      if (valid) await boundary.signalMember(member, 'SIGCONT').catch(() => false)
    }
    frozen.clear()
  }
  const acquire = async (memberPid: number): Promise<boolean> => {
    if (!processKillMayContinue(options)) return false
    if (members.has(memberPid)) return true
    const member = await boundary.acquireMember(memberPid, pid)
    if (!member || (memberPid === pid && member.auditIdentity !== expectedOsIdentity)) return false
    members.set(memberPid, member)
    return true
  }
  const send = async (member: DarwinProcessTreeMember, memberSignal: NodeJS.Signals): Promise<boolean> => {
    // The audit token prevents PID reuse, while this guard prevents signaling
    // after the owner has cancelled or exhausted its deadline.
    if (!processKillMayContinue(options)) return false
    if (!(await boundary.revalidateMember?.(member, pid, true) ?? true)) return false
    return boundary.signalMember(member, memberSignal)
  }
  const freeze = async (member: DarwinProcessTreeMember): Promise<boolean> => {
    if (frozen.has(member.pid)) return true
    if (!(await send(member, 'SIGSTOP'))) return false
    frozen.set(member.pid, member)
    return true
  }
  const continueFrozen = async (): Promise<boolean> => {
    let continued = true
    for (const [memberPid, member] of frozen) {
      if (!(await send(member, 'SIGCONT'))) { continued = false; continue }
      frozen.delete(memberPid)
    }
    return continued
  }
  try {
    if (!(await acquire(pid))) return false
    if (!(await freeze(members.get(pid)!))) return false
    let previous = ''
    for (let pass = 0; pass < 64; pass += 1) {
      if (!processKillMayContinue(options)) return false
      const discovered = await boundary.listMembers(pid)
      if (!discovered) return false
      for (const memberPid of discovered) {
        if (!(await acquire(memberPid))) return false
        if (!(await freeze(members.get(memberPid)!))) return false
      }
      const fingerprint = [...members.keys()].sort((a, b) => a - b).join(',')
      if (fingerprint === previous && discovered.every(memberPid => members.has(memberPid))) break
      previous = fingerprint
      if (pass === 63) return false
    }
    // Every discovered member has already received exactly one STOP in freeze.
    // A frozen tree is not a termination receipt.
    if (signal === 'SIGSTOP') return false
    const sendAll = async (memberSignal: NodeJS.Signals): Promise<boolean> => {
      for (const member of [...members.values()].sort((a, b) => (a.pid === pid ? 1 : b.pid === pid ? -1 : a.pid - b.pid))) {
        if (!processKillMayContinue(options)) return false
        if (!(await send(member, memberSignal))) return false
      }
      return true
    }
    if (!(await sendAll(signal))) return false
    if (temporarilyFrozenForSignal(signal)) {
      if (!(await continueFrozen())) return false
    }

    const waitUntilEmpty = async (deadline: number, escalation: boolean): Promise<boolean> => {
      while (processKillMayContinue(options) && options.nowMs() < deadline) {
        const discovered = await boundary.listMembers(pid)
        if (!discovered) return false
        if (discovered.length === 0) return true
        for (const memberPid of discovered) {
          const alreadyCaptured = members.has(memberPid)
          if (!(await acquire(memberPid))) return false
          const member = members.get(memberPid)!
          if (escalation) {
            if (!(await send(member, 'SIGKILL'))) return false
          } else if (!alreadyCaptured) {
            if (!(await freeze(member)) || !(await send(member, signal))) return false
            if (temporarilyFrozenForSignal(signal)) {
              if (!(await continueFrozen())) return false
            }
          }
        }
        await options.sleep(processKillPollMs(options))
      }
      if (!processKillMayContinue(options)) return false
      const discovered = await boundary.listMembers(pid)
      return discovered !== null && discovered.length === 0
    }
    if (await waitUntilEmpty(options.nowMs() + options.timeoutMs, false)) {
      terminationCompleted = true
      return true
    }
    if (!processKillMayContinue(options) || !(await sendAll('SIGKILL'))) return false
    const empty = await waitUntilEmpty(options.nowMs() + options.escalationTimeoutMs, true)
    terminationCompleted = empty
    return empty
  } finally {
    // Do not leave a tree stopped if capture/rescan failed during a temporary
    // freeze. Explicit SIGSTOP is intentionally excluded by the helper.
    if (!terminationCompleted) await resumeTemporaryFreezes()
    boundary.close?.()
  }
}

/**
 * Stable platform termination. Only an exact containment capability may return
 * true. Unix PGID cleanup is still attempted through incarnation-bound handles,
 * but must return false because an earlier descendant may have escaped.
 */
export async function terminateExpectedProcessTreeStable(
  pid: number,
  signal: NodeJS.Signals,
  expectedStartedAtMs: number,
  expectedOsIdentity: string | undefined,
  options: ExactProcessTreeTerminationOptions,
): Promise<boolean> {
  const platform = options.platform ?? process.platform
  if (platform === 'linux') {
    await terminateLinuxProcessTreeStable(pid, signal, expectedStartedAtMs, expectedOsIdentity, options)
    return false
  }
  if (platform === 'win32') {
    // QueryInformationJobObject.ActiveProcesses is the completion proof; root
    // PID disappearance alone is deliberately insufficient.
    return terminateWindowsJobStable(expectedOsIdentity, options)
  }
  if (platform === 'darwin') {
    await terminateDarwinProcessTreeStable(pid, signal, expectedOsIdentity, options)
    return false
  }
  return false
}

const DARWIN_PROC_PIDTBSDINFO = 3
const DARWIN_PROC_BSDINFO_SIZE = 136
const DARWIN_START_TVSEC_OFFSET = 120
const DARWIN_START_TVUSEC_OFFSET = 128

async function readDarwinProcessStartTimeMicros(pid: number): Promise<number | null> {
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const libproc = dlopen('/usr/lib/libproc.dylib', {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    })
    try {
      const info = Buffer.alloc(DARWIN_PROC_BSDINFO_SIZE)
      const bytes = libproc.symbols.proc_pidinfo(
        pid,
        DARWIN_PROC_PIDTBSDINFO,
        0,
        ptr(info),
        info.length,
      )
      if (bytes !== info.length) return null
      return parseDarwinProcessStartTimeMicros(info)
    } finally {
      libproc.close()
    }
  } catch {
    return null
  }
}

export function parseDarwinProcessStartTimeMicros(info: Buffer): number | null {
  if (info.length < DARWIN_PROC_BSDINFO_SIZE) return null
  const seconds = info.readBigUInt64LE(DARWIN_START_TVSEC_OFFSET)
  const micros = info.readBigUInt64LE(DARWIN_START_TVUSEC_OFFSET)
  if (micros >= 1_000_000n) return null
  const identity = seconds * 1_000_000n + micros
  return identity <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(identity) : null
}

/** Capture a durable OS identity while the newly spawned root is still owned. */
/** Acquire a Darwin audit identity for an arbitrary process. Unlike the tree
 * root capture this deliberately does not require it to lead a process group:
 * Cursor descendants must each carry their own native identity. */
export async function captureDarwinAuditIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const libc = dlopen('/usr/lib/libSystem.B.dylib', {
      task_name_for_pid: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      task_info: { args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      mach_port_deallocate: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
      mach_task_self: { args: [], returns: FFIType.u32 },
    })
    try {
      const selfTask = Number(libc.symbols.mach_task_self())
      const taskPortBuffer = Buffer.alloc(4)
      if (libc.symbols.task_name_for_pid(selfTask, pid, ptr(taskPortBuffer)) !== 0) return null
      const taskPort = taskPortBuffer.readUInt32LE(0)
      try {
        const token = Buffer.alloc(32)
        const count = Buffer.alloc(4)
        count.writeUInt32LE(8, 0)
        if (libc.symbols.task_info(taskPort, 15, ptr(token), ptr(count)) !== 0) return null
        return `darwin-audit:${token.toString('hex')}`
      } finally {
        libc.symbols.mach_port_deallocate(selfTask, taskPort)
      }
    } finally {
      libc.close()
    }
  } catch {
    return null
  }
}

export async function captureProcessTreeIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform === 'linux') {
    try {
      const { dlopen, FFIType } = await import('bun:ffi')
      const libc = dlopen('libc.so.6', {
        getpgid: { args: [FFIType.i32], returns: FFIType.i32 },
      })
      try {
        return libc.symbols.getpgid(pid) === pid ? `unix-pgid:${pid}` : null
      } finally {
        libc.close()
      }
    } catch {
      return null
    }
  }
  if (platform === 'darwin') {
    try {
      const { dlopen, FFIType } = await import('bun:ffi')
      const libc = dlopen('/usr/lib/libSystem.B.dylib', {
        task_name_for_pid: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
        task_info: { args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        mach_port_deallocate: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
        mach_task_self: { args: [], returns: FFIType.u32 },
        getpgid: { args: [FFIType.i32], returns: FFIType.i32 },
      })
      try {
        if (libc.symbols.getpgid(pid) !== pid) return null
        return captureDarwinAuditIdentity(pid)
      } finally {
        libc.close()
      }
    } catch {
      return null
    }
  }
  return null
}

function taskkillPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
}

export function buildWindowsTaskkillInvocation(pid: number): {
  command: string
  args: string[]
} {
  return {
    command: taskkillPath(),
    args: ['/T', '/F', '/PID', String(pid)],
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function parseProcessStartTime(value: string): number | null {
  const parsed = Date.parse(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

function readProcessQueryOutput(
  command: string,
  args: string[],
  outputLimitBytes: number,
  timeoutMs = PROCESS_QUERY_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false
    let output = ''
    let child: ReturnType<typeof spawn> | null = null
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }
    const timeout = setTimeout(() => {
      try {
        child?.kill('SIGKILL')
      } catch {
        // Best-effort query cleanup.
      }
      finish(null)
    }, Math.max(1, timeoutMs))
    timeout.unref?.()

    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled || output.length >= outputLimitBytes) return
        output = `${output}${chunk.toString()}`.slice(0, outputLimitBytes)
      })
      child.once('error', () => finish(null))
      child.once('close', code => finish(code === 0 ? output : null))
    } catch {
      finish(null)
    }
  })
}

/** Read the OS creation time. PID-only ownership is unsafe because PIDs are reused. */
export async function readProcessStartTimeMs(
  pid: number,
  platformOrTimeout: NodeJS.Platform | number = process.platform,
  timeoutMs?: number,
): Promise<number | null> {
  const platform = typeof platformOrTimeout === 'number' ? process.platform : platformOrTimeout
  const queryTimeoutMs = typeof platformOrTimeout === 'number' ? platformOrTimeout : timeoutMs
  // Never normalize an untrusted PID: truncating 42.9 would query PID 42,
  // which may be a different process incarnation altogether.
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null
  const normalizedPid = Math.trunc(pid)

  if (platform === 'linux') {
    try {
      // /proc stat field 22 is the kernel start-time tick count. Unlike ps
      // lstart it does not collapse same-second process incarnations.
      const stat = await readFile(`/proc/${normalizedPid}/stat`, 'utf8')
      const commandEnd = stat.lastIndexOf(')')
      if (commandEnd < 0) return null
      const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/)
      const startTicks = Number(fieldsAfterCommand[19])
      return Number.isSafeInteger(startTicks) && startTicks >= 0 ? startTicks : null
    } catch {
      return null
    }
  }

  // proc_bsdinfo carries the kernel-recorded start timeval at microsecond
  // resolution. Unlike `ps lstart`, this distinguishes same-second reuse.
  if (platform === 'darwin') {
    return readDarwinProcessStartTimeMicros(normalizedPid)
  }

  if (platform !== 'win32') return null

  const command = 'powershell.exe'
  const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        [
          '$ErrorActionPreference = "Stop"',
          '$process = $null',
          // Get-Process can auto-import modules and hang in an isolated
          // profile. Direct .NET lookup has an explicit disposable handle.
          `try { $process = [System.Diagnostics.Process]::GetProcessById(${normalizedPid}); $startedAt = $process.StartTime.ToUniversalTime().ToString("o") } catch { exit 1 } finally { if ($null -ne $process) { $process.Dispose() } }`,
          '[Console]::Out.WriteLine($startedAt)',
        ].join('; '),
      ]

  const output = await readProcessQueryOutput(
    command,
    args,
    PROCESS_START_TIME_OUTPUT_LIMIT_BYTES,
    queryTimeoutMs ?? WINDOWS_PROCESS_START_TIME_QUERY_TIMEOUT_MS,
  )
  return output === null ? null : parseProcessStartTime(output)
}

export async function readProcessCommandLine(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  queryTimeoutMs?: number,
): Promise<string | null> {
  const normalizedPid = Math.trunc(pid)
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) return null

  const command = platform === 'win32' ? 'powershell.exe' : 'ps'
  const args = platform === 'win32'
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        [
          '$ErrorActionPreference = "Stop"',
          `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${normalizedPid}"`,
          '$process.CommandLine',
        ].join('; '),
      ]
    : ['-p', String(normalizedPid), '-o', 'command=']
  const output = await readProcessQueryOutput(
    command,
    args,
    PROCESS_COMMAND_OUTPUT_LIMIT_BYTES,
    queryTimeoutMs,
  )
  const normalized = output?.trim()
  return normalized ? normalized : null
}

export function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return

  if (process.platform !== 'win32') {
    try {
      process.kill(pid, signal)
    } catch {
      // Best-effort cleanup.
    }
    return
  }

  try {
    const { command, args } = buildWindowsTaskkillInvocation(pid)
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    })
    child.on('error', () => {
      try {
        process.kill(pid, signal)
      } catch {
        // Best-effort cleanup.
      }
    })
    child.unref()
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Best-effort cleanup.
    }
  }
}

type ExpectedProcessIdentityState = 'same' | 'gone' | 'changed' | 'unverified'

async function inspectExpectedProcessIdentity(
  pid: number,
  expectedStartedAtMs: number,
  deps: Required<Pick<ProcessKillAndWaitDependencies, 'isProcessAlive' | 'readProcessStartTimeMs'>>,
  options: Pick<ExactProcessTreeTerminationOptions, 'signal' | 'remainingMs'>,
): Promise<ExpectedProcessIdentityState> {
  if (!processKillMayContinue(options)) return 'unverified'
  const remaining = options.remainingMs?.()
  const actualStartedAtMs = await deps.readProcessStartTimeMs(
    pid,
    remaining === undefined ? undefined : Math.max(1, Math.floor(remaining)),
  ).catch(() => null)
  if (!processKillMayContinue(options)) return 'unverified'
  if (actualStartedAtMs === expectedStartedAtMs) return 'same'
  if (actualStartedAtMs !== null) return 'changed'
  return deps.isProcessAlive(pid) ? 'unverified' : 'gone'
}

export async function killProcessTreeAndWait(
  pid: number | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
  options: {
    timeoutMs?: number
    pollMs?: number
    taskkillTimeoutMs?: number
    expectedStartedAtMs?: number | null
    expectedOsIdentity?: string | null
    verifyExpectedIdentity?: (pid: number) => Promise<boolean>
    dependencies?: ProcessKillAndWaitDependencies
    /** A live caller-owned cancellation/deadline context. */
    signal?: AbortSignal
    remainingMs?: () => number
  } = {},
): Promise<boolean> {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return true
  if (!processKillMayContinue(options)) return false

  const expectedStartedAtMs = options.expectedStartedAtMs
  // A live PID without an immutable creation-time baseline is observable but
  // never safe to terminate. This deliberately makes legacy PID-only callers
  // fail closed.
  if (!Number.isFinite(expectedStartedAtMs) || expectedStartedAtMs === null) return false
  const expectedStartTime = expectedStartedAtMs as number

  const injected = options.dependencies ?? {}
  const platform = injected.platform ?? process.platform
  const deps = {
    isProcessAlive: injected.isProcessAlive ?? isProcessAlive,
    readProcessStartTimeMs:
      injected.readProcessStartTimeMs ?? ((targetPid: number, timeoutMs?: number) =>
        readProcessStartTimeMs(targetPid, platform, timeoutMs)),
  }
  const initialIdentity = await inspectExpectedProcessIdentity(pid, expectedStartTime, deps, options)
  if (initialIdentity === 'gone') {
    // Even for Windows, supervisor disappearance is not itself the completion
    // proof. A named Job that remains open because a child is alive must still
    // be opened, terminated, and queried below. A vanished Job fails closed.
    if (getProcessTreeContainmentCapability(options.expectedOsIdentity ?? undefined, platform) !== 'exact') {
      return false
    }
    const timeoutMs = options.timeoutMs ?? 2_500
    const pollMs = options.pollMs ?? 50
    const terminateExpectedProcessTree = injected.terminateExpectedProcessTree ?? terminateExpectedProcessTreeStable
    if (!processKillMayContinue(options)) return false
    return terminateExpectedProcessTree(
      pid,
      signal,
      expectedStartTime,
      options.expectedOsIdentity ?? undefined,
      {
        timeoutMs,
        pollMs,
        escalationTimeoutMs: options.taskkillTimeoutMs ?? timeoutMs,
        nowMs: injected.nowMs ?? Date.now,
        sleep: injected.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
        platform,
        signal: options.signal,
        remainingMs: options.remainingMs,
      },
    )
  }
  if (initialIdentity !== 'same') return false
  if (
    options.verifyExpectedIdentity &&
    !(await options.verifyExpectedIdentity(pid).catch(() => false))
  ) {
    return false
  }
  if (!processKillMayContinue(options)) return false

  const timeoutMs = options.timeoutMs ?? 2_500
  const pollMs = options.pollMs ?? 50
  const exactContainment = getProcessTreeContainmentCapability(
    options.expectedOsIdentity ?? undefined,
    platform,
  ) === 'exact'
  // Validation followed by PID signaling is inherently racy. Production must
  // fail closed until the caller supplies an OS-stable handle that binds the
  // checked process incarnation through the signal operation. Node/Bun
  // ChildProcess.kill() does not satisfy that contract.
  const terminateExpectedProcessTree = injected.terminateExpectedProcessTree
  if (terminateExpectedProcessTree) {
    if (!processKillMayContinue(options)) return false
    const terminated = await terminateExpectedProcessTree(
      pid,
      signal,
      expectedStartTime,
      options.expectedOsIdentity ?? undefined,
      {
        timeoutMs,
        pollMs,
        escalationTimeoutMs: options.taskkillTimeoutMs ?? timeoutMs,
        nowMs: injected.nowMs ?? Date.now,
        sleep: injected.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
        platform,
        signal: options.signal,
        remainingMs: options.remainingMs,
      },
    )
    return exactContainment && terminated
  }
  const signalExpectedProcess = injected.signalExpectedProcess
  if (!signalExpectedProcess) {
    return terminateExpectedProcessTreeStable(
      pid,
      signal,
      expectedStartTime,
      options.expectedOsIdentity ?? undefined,
      {
        timeoutMs,
        pollMs,
        escalationTimeoutMs: options.taskkillTimeoutMs ?? timeoutMs,
        nowMs: injected.nowMs ?? Date.now,
        sleep: injected.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
        platform,
        signal: options.signal,
        remainingMs: options.remainingMs,
      },
    )
  }
  try {
    // This is deliberately adjacent to the OS-stable signal call.  Identity
    // inspection above may have awaited a process query and the caller may
    // cancel in that gap.
    if (!processKillMayContinue(options)) return false
    if (!(await signalExpectedProcess(pid, signal, expectedStartTime, options.expectedOsIdentity ?? undefined))) {
      return false
    }
  } catch {
    if (!processKillMayContinue(options)) return false
    const identity = await inspectExpectedProcessIdentity(pid, expectedStartTime, deps, options)
    return exactContainment && (identity === 'gone' || identity === 'changed')
  }

  const nowMs = injected.nowMs ?? Date.now
  const sleep = injected.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const deadline = nowMs() + timeoutMs
  while (processKillMayContinue(options) && nowMs() < deadline) {
    const identity = await inspectExpectedProcessIdentity(pid, expectedStartTime, deps, options)
    if (identity === 'gone' || identity === 'changed') return exactContainment
    if (identity === 'unverified') return false
    await sleep(Math.max(1, Math.min(pollMs, options.remainingMs?.() ?? pollMs)))
  }
  if (!processKillMayContinue(options)) return false
  const finalIdentity = await inspectExpectedProcessIdentity(pid, expectedStartTime, deps, options)
  return exactContainment && (finalIdentity === 'gone' || finalIdentity === 'changed')
}

export type StartupProcessTermination = {
  helperTerminated: boolean
  rootGone: boolean
  treeKillSucceeded: boolean
}

const startupTaskkills = new Map<number, Promise<void>>()
export function pendingStartupTaskkill(pid: number): Promise<void> | undefined { return startupTaskkills.get(pid) }
export async function drainStartupTaskkills(options: {
  signal?: AbortSignal
  remainingMs?: () => number
} = {}): Promise<boolean> {
  // A taskkill helper can outlive its observation window (for example when a
  // Windows child never emits close). Startup publication must retain that
  // uncertainty, not wait indefinitely for an unobservable helper.
  for (;;) {
    if (startupTaskkills.size === 0) return true
    if (options.signal?.aborted || (options.remainingMs?.() ?? 1) <= 0) return false
    const remaining = options.remainingMs?.()
    const waitMs = Math.max(1, Math.min(100, remaining ?? 100))
    let removeAbortListener: (() => void) | undefined
    const aborted = options.signal
      ? new Promise<false>(resolve => {
          const onAbort = () => resolve(false)
          options.signal!.addEventListener('abort', onAbort, { once: true })
          removeAbortListener = () => options.signal!.removeEventListener('abort', onAbort)
        })
      : undefined
    const settled = await Promise.race([
      Promise.allSettled([...startupTaskkills.values()]).then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), waitMs)),
      ...(aborted ? [aborted] : []),
    ])
    removeAbortListener?.()
    if (!settled && (options.signal?.aborted || (options.remainingMs?.() ?? 1) <= 0)) return false
  }
}
export function pendingStartupTaskkillPids(): number[] { return [...startupTaskkills.keys()] }
export function hasPendingStartupTaskkill(pid: number): boolean { return startupTaskkills.has(pid) }

export async function killProcessTreeForStartup(
  pid: number,
  expectedStartedAtMs: number,
  budget: { cap(ms: number): number; assertAvailable(reserveMs?: number): void },
  deps: {
    readIdentity?: (pid: number, timeoutMs: number) => Promise<number | null>
    alive?: (pid: number) => boolean
    expectedOsIdentity?: string
    signal?: AbortSignal
    remainingMs?: () => number
    terminateExpectedProcessTree?: typeof terminateExpectedProcessTreeStable
  } = {},
): Promise<StartupProcessTermination> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff || !Number.isFinite(expectedStartedAtMs)) throw new Error('Startup termination requires a valid PID and process birth identity')
  const alive = deps.alive ?? isProcessAlive
  // No helper-close receipt is exposed by this compatibility API; never
  // manufacture `helperTerminated: true` from a failed or cancelled request.
  const failed = (helperTerminated = false): StartupProcessTermination => ({ helperTerminated, rootGone: !alive(pid), treeKillSucceeded: false })
  // The old taskkill /PID path checked a birth timestamp and then performed a
  // numeric tree kill (and, on failure, numeric SIGKILL).  That leaves a PID
  // reuse window and cannot prove containment. Startup cleanup now accepts
  // only the launch-bound Windows Job receipt and delegates to the same
  // identity-bound primitive used by normal persistent-host termination.
  if (!deps.expectedOsIdentity?.startsWith('win32-job:')) return failed()
  const mayContinue = () => !deps.signal?.aborted && (deps.remainingMs?.() ?? 1) > 0
  if (!mayContinue()) return failed()
  const identity = deps.readIdentity ?? ((target, timeout) => readProcessStartTimeMs(target, 'win32', timeout))
  budget.assertAvailable(1_000)
  if (await identity(pid, budget.cap(6_000)) !== expectedStartedAtMs || !mayContinue()) return failed()
  budget.assertAvailable(1_000)
  const timeoutMs = Math.min(2_500, budget.cap(3_500) - 1_000)
  if (timeoutMs <= 0 || !mayContinue()) return failed()
  const terminated = await (deps.terminateExpectedProcessTree ?? terminateExpectedProcessTreeStable)(
    pid,
    'SIGKILL',
    expectedStartedAtMs,
    deps.expectedOsIdentity,
    {
      timeoutMs,
      pollMs: 50,
      escalationTimeoutMs: timeoutMs,
      nowMs: Date.now,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      platform: 'win32',
      signal: deps.signal,
      remainingMs: deps.remainingMs,
    },
  )
  return { helperTerminated: false, rootGone: !alive(pid), treeKillSucceeded: terminated && mayContinue() }
}
