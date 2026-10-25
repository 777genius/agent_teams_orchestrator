import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { windowsNativeProcess } from './windowsNativeProcess.js'

const PROCESS_START_TIME_QUERY_TIMEOUT_MS = 2_500
// Cold PowerShell identity queries have reached the 5s cutoff while a repeat
// completes in ~4.6s. Match the existing startup identity cap without retrying.
// This budget is separate from command-line queries and process termination.
const WINDOWS_PROCESS_START_TIME_QUERY_TIMEOUT_MS = 6_000
const PROCESS_START_TIME_OUTPUT_LIMIT_BYTES = 64 * 1024
const PROCESS_COMMAND_OUTPUT_LIMIT_BYTES = 256 * 1024

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
  if (!Number.isFinite(pid) || pid <= 0) {
    return false
  }
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

export function parseDarwinProcessStartTime(value: string): number | null {
  return parseProcessStartTime(value)
}

export function parseLinuxProcessStartTicks(value: string): number | null {
  const close = value.lastIndexOf(')')
  if (close < 0) return null
  const fieldsAfterComm = value.slice(close + 1).trim().split(/\s+/)
  const ticks = Number(fieldsAfterComm[19])
  return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null
}

function readProcessQueryOutput(
  command: string,
  args: string[],
  outputLimitBytes: number,
  timeoutMs = PROCESS_START_TIME_QUERY_TIMEOUT_MS,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false
    let output = ''
    let child: ReturnType<typeof spawn> | null = null
    const finish = (value: string | null): void => {
      if (settled) {
        return
      }
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
    }, timeoutMs)
    timeout.unref?.()

    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', command === 'powershell.exe' ? 'pipe' : 'ignore'],
        windowsHide: true,
        ...(env ? { env } : {}),
      })
      child.stderr?.resume()
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled || output.length >= outputLimitBytes) {
          return
        }
        output = `${output}${chunk.toString()}`.slice(0, outputLimitBytes)
      })
      child.once('error', () => finish(null))
      child.once('close', code => finish(code === 0 ? output : null))
    } catch {
      finish(null)
    }
  })
}

/**
 * Read the operating-system process creation time using a bounded query.
 * A PID alone is not an ownership token: after a process exits the OS may reuse
 * it for an unrelated process, so persistent registries must compare both.
 */
export async function readProcessStartTimeMs(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  timeoutMs?: number,
): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || (platform === 'win32' && pid > 0x7fffffff)) {
    return null
  }
  const normalizedPid = pid

  if (platform === 'linux') {
    // Linux exposes starttime in clock ticks, avoiding the one-second
    // truncation of ps lstart. The value is an opaque identity here.
    const stat = await readFile(`/proc/${normalizedPid}/stat`, 'utf8').catch(() => null)
    return stat === null ? null : parseLinuxProcessStartTicks(stat)
  }

  if (platform === 'darwin') {
    // lstart follows LC_TIME; only the C locale prints a date Date.parse reads
    // (ru_RU and de_DE give NaN). The time zone stays the caller's own.
    const output = await readProcessQueryOutput(
      'ps',
      ['-p', String(normalizedPid), '-o', 'lstart='],
      PROCESS_START_TIME_OUTPUT_LIMIT_BYTES,
      undefined,
      { ...process.env, LC_ALL: 'C', LC_TIME: 'C', LANG: 'C' },
    )
    return output === null ? null : parseDarwinProcessStartTime(output)
  }

  if (platform !== 'win32') return null

  // Use the same creation FILETIME identity without a cold helper process.
  // An observed native denial/exit is definitive; only an unavailable native
  // capability (for example Node or older Windows ARM64 Bun) uses PowerShell.
  try {
    const native = await windowsNativeProcess()
    return native === null
      ? readWindowsProcessStartTimeMsWithPowerShell(normalizedPid, timeoutMs)
      : native.birth(normalizedPid)
  } catch {
    return null
  }
}

/** Bounded compatibility fallback and independent .NET oracle for native identity. */
export async function readWindowsProcessStartTimeMsWithPowerShell(
  pid: number,
  timeoutMs?: number,
): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null

  const command = 'powershell.exe'
  // Get-Process can hang during module autoimport in an isolated Windows home.
  // Read the same .NET StartTime directly and release the process handle even
  // when the process exits or access is denied. Emit only after cleanup succeeds.
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    [
      '$ErrorActionPreference = "Stop"',
      '$process = $null',
      `try { $process = [System.Diagnostics.Process]::GetProcessById(${pid}); $startedAt = $process.StartTime.ToUniversalTime().ToString("o") } catch { exit 1 } finally { if ($null -ne $process) { $process.Dispose() } }`,
      '[Console]::Out.WriteLine($startedAt)',
    ].join('; '),
  ]

  const output = await readProcessQueryOutput(
    command,
    args,
    PROCESS_START_TIME_OUTPUT_LIMIT_BYTES,
    timeoutMs ?? WINDOWS_PROCESS_START_TIME_QUERY_TIMEOUT_MS,
  )
  return output === null ? null : parseProcessStartTime(output)
}

export async function readProcessCommandLine(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  timeoutMs?: number,
): Promise<string | null> {
  const normalizedPid = Math.trunc(pid)
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) {
    return null
  }

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
  const output = await readProcessQueryOutput(command, args, PROCESS_COMMAND_OUTPUT_LIMIT_BYTES, timeoutMs)
  const normalized = output?.trim()
  return normalized ? normalized : null
}

export function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (!pid || !Number.isFinite(pid) || pid <= 0) {
    return
  }

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

function runWindowsTaskkill(pid: number, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    let done = false
    let child: ReturnType<typeof spawn> | null = null
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timeout)
      resolve()
    }
    const timeout = setTimeout(() => {
      try {
        child?.kill('SIGKILL')
      } catch {
        // Best-effort cleanup.
      }
      finish()
    }, timeoutMs)

    try {
      const { command, args } = buildWindowsTaskkillInvocation(pid)
      child = spawn(command, args, {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      })
      child.once('error', finish)
      child.once('close', finish)
    } catch {
      finish()
    }
  })
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  return !isProcessAlive(pid)
}

export async function killProcessTreeAndWait(
  pid: number | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
  options: {
    timeoutMs?: number
    pollMs?: number
    taskkillTimeoutMs?: number
    expectedStartedAtMs?: number | null
  } = {},
): Promise<boolean> {
  if (!pid || !Number.isFinite(pid) || pid <= 0) {
    return true
  }

  const timeoutMs = options.timeoutMs ?? 2_500
  const pollMs = options.pollMs ?? 50

  if (Number.isFinite(options.expectedStartedAtMs) && options.expectedStartedAtMs !== null) {
    const currentStartedAtMs = await readProcessStartTimeMs(pid)
    if (currentStartedAtMs !== options.expectedStartedAtMs) {
      return false
    }
  }

  if (process.platform === 'win32') {
    await runWindowsTaskkill(pid, options.taskkillTimeoutMs ?? timeoutMs)
    if (!isProcessAlive(pid)) {
      return true
    }
    if (Number.isFinite(options.expectedStartedAtMs) && options.expectedStartedAtMs !== null) {
      const currentStartedAtMs = await readProcessStartTimeMs(pid)
      if (currentStartedAtMs !== options.expectedStartedAtMs) {
        return false
      }
    }
    try {
      process.kill(pid, signal)
    } catch {
      return !isProcessAlive(pid)
    }
    return waitForProcessExit(pid, timeoutMs, pollMs)
  }

  try {
    process.kill(pid, signal)
  } catch {
    return !isProcessAlive(pid)
  }

  return waitForProcessExit(pid, timeoutMs, pollMs)
}


export type StartupProcessTermination = {
  helperTerminated: boolean
  rootGone: boolean
  treeKillSucceeded: boolean
}

// Retain the entire destructive operation, including awaited identity checks
// before dispatch and fallback. Helper close alone does not drain a fallback.
const startupTaskkills = new Map<number, Promise<void>>()
export function pendingStartupTaskkill(pid: number): Promise<void> | undefined {
  return startupTaskkills.get(pid)
}

export async function drainStartupTaskkills(): Promise<void> {
  while (startupTaskkills.size > 0) {
    await Promise.all(startupTaskkills.values())
  }
}

export function pendingStartupTaskkillPids(): number[] {
  return [...startupTaskkills.keys()]
}

export function hasPendingStartupTaskkill(pid: number): boolean {
  return startupTaskkills.has(pid)
}

export async function killProcessTreeForStartup(
  pid: number,
  expectedStartedAtMs: number,
  budget: { cap(ms: number): number; assertAvailable(reserveMs?: number): void },
  deps: {
    readIdentity?: (pid: number, timeoutMs: number) => Promise<number | null>
    alive?: (pid: number) => boolean
    signal?: (pid: number) => void
  } = {},
): Promise<StartupProcessTermination> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff
    || typeof expectedStartedAtMs !== 'number' || !Number.isFinite(expectedStartedAtMs)) {
    throw new Error('Startup termination requires a valid PID and process birth identity')
  }
  const alive = deps.alive ?? isProcessAlive
  const failed = (helperTerminated = true): StartupProcessTermination => ({
    helperTerminated, rootGone: !alive(pid), treeKillSucceeded: false,
  })
  if (startupTaskkills.has(pid)) return failed(false)
  let release!: () => void
  const drained = new Promise<void>(resolve => { release = resolve })
  startupTaskkills.set(pid, drained)
  const finishOperation = () => { startupTaskkills.delete(pid); release() }
  let observingLiveHelper = false
  try {
    const identity = deps.readIdentity ?? ((target, timeout) => readProcessStartTimeMs(target, 'win32', timeout))
    budget.assertAvailable(1_000)
    if (await identity(pid, budget.cap(6_000)) !== expectedStartedAtMs) return failed()
    budget.assertAvailable(1_000)
    const timeoutMs = Math.min(2_500, budget.cap(3_500) - 1_000)
    // A clock tick between the reserve check and cap must not become a zero or
    // negative timer, which Node would normalize to a fresh one-millisecond job.
    if (timeoutMs <= 0) throw new Error('Startup cleanup termination reserve exhausted')
    let child: ReturnType<typeof spawn> | undefined
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const operation = new Promise<StartupProcessTermination>(resolve => {
      const finish = (success: boolean) => {
        if (timer) clearTimeout(timer)
        resolve({ helperTerminated: true, rootGone: !alive(pid), treeKillSucceeded: success && !timedOut })
      }
      try {
        const { command, args } = buildWindowsTaskkillInvocation(pid)
        child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
        // Failed spawn has no helper. Errors from a running child do not prove exit.
        child.once('error', () => { if (!child?.pid) finish(false) })
        child.once('close', code => finish(code === 0))
        timer = setTimeout(() => {
          timedOut = true
          try { child?.kill('SIGKILL') } catch { /* Keep observing the captured helper. */ }
        }, timeoutMs)
      } catch { finish(false) }
    })
    let observationTimer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      operation,
      new Promise<StartupProcessTermination>(resolve => {
        observationTimer = setTimeout(() => resolve(failed(false)), timeoutMs + 1_000)
      }),
    ])
    if (observationTimer) clearTimeout(observationTimer)
    if (!outcome.helperTerminated) {
      observingLiveHelper = true
      void operation.then(finishOperation)
      return outcome
    }
    if (outcome.rootGone) return outcome
    // Direct fallback is fresh-identity checked, even after taskkill failed. A
    // successful root signal cannot erase a failed tree operation.
    try {
      budget.assertAvailable()
      if (await identity(pid, budget.cap(6_000)) !== expectedStartedAtMs) return outcome
      budget.assertAvailable()
      const signal = deps.signal ?? (target => process.kill(target, 'SIGKILL'))
      signal(pid)
    } catch { /* Explicit partial result; no further destructive continuation. */ }
    return { ...outcome, rootGone: !alive(pid) }
  } finally {
    if (!observingLiveHelper) finishOperation()
  }
}
