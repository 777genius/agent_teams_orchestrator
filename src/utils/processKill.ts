import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const PROCESS_START_TIME_QUERY_TIMEOUT_MS = 2_500
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
    }, PROCESS_START_TIME_QUERY_TIMEOUT_MS)
    timeout.unref?.()

    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
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
 * Read the operating-system process creation time without invoking a shell.
 * A PID alone is not an ownership token: after a process exits the OS may reuse
 * it for an unrelated process, so persistent registries must compare both.
 */
export async function readProcessStartTimeMs(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<number | null> {
  const normalizedPid = Math.trunc(pid)
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) {
    return null
  }

  if (platform === 'linux') {
    // Linux exposes starttime in clock ticks, avoiding the one-second
    // truncation of ps lstart. The value is an opaque identity here.
    const stat = await readFile(`/proc/${normalizedPid}/stat`, 'utf8').catch(() => null)
    return stat === null ? null : parseLinuxProcessStartTicks(stat)
  }

  if (platform === 'darwin') {
    const output = await readProcessQueryOutput(
      'ps',
      ['-p', String(normalizedPid), '-o', 'lstart='],
      PROCESS_START_TIME_OUTPUT_LIMIT_BYTES,
    )
    return output === null ? null : parseDarwinProcessStartTime(output)
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
          `$process = Get-Process -Id ${normalizedPid} -ErrorAction Stop`,
          '$process.StartTime.ToUniversalTime().ToString("o")',
        ].join('; '),
      ]

  const output = await readProcessQueryOutput(
    command,
    args,
    PROCESS_START_TIME_OUTPUT_LIMIT_BYTES,
  )
  return output === null ? null : parseProcessStartTime(output)
}

export async function readProcessCommandLine(
  pid: number,
  platform: NodeJS.Platform = process.platform,
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
  const output = await readProcessQueryOutput(command, args, PROCESS_COMMAND_OUTPUT_LIMIT_BYTES)
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
