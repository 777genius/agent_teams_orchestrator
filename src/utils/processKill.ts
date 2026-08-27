import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
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
          `$process = Get-Process -Id ${normalizedPid} -ErrorAction Stop`,
          '$process.StartTime.ToUniversalTime().ToString("o")',
        ].join('; '),
      ]
    : ['-p', String(normalizedPid), '-o', 'lstart=']

  const output = await readProcessQueryOutput(
    command,
    args,
    PROCESS_START_TIME_OUTPUT_LIMIT_BYTES,
  )
  return output === null ? null : parseProcessStartTime(output)
}

/**
 * Native process-generation identity used for destructive POSIX authority.
 * Linux starttime is measured in boot ticks and is paired with the kernel boot
 * id, so neither same-second PID reuse nor a reboot can alias a receipt.
 */
export function readProcessBirthToken(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  observation: { readFile?: (path: string) => string } = {},
): string | null {
  const normalizedPid = Math.trunc(pid)
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0 || platform !== 'linux') return null
  const read = observation.readFile ?? (target => readFileSync(target, 'utf8'))
  try {
    const bootId = read('/proc/sys/kernel/random/boot_id').trim().toLowerCase()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId)) return null
    const stat = read(`/proc/${normalizedPid}/stat`)
    const commandEnd = stat.lastIndexOf(')')
    if (commandEnd < 0) return null
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/)
    const starttime = fields[19]
    if (!starttime || !/^\d+$/.test(starttime)) return null
    return `linux:${bootId}:${starttime}`
  } catch { return null }
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

  // A PID-only caller has no stable Windows tree authority. Signal only the
  // leader; HostManager's owned launcher/job path performs strict tree cleanup.
  try { process.kill(pid, signal) } catch { /* Best-effort cleanup. */ }
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

function isPosixProcessGroupAlive(groupLeaderPid: number): boolean {
  try {
    process.kill(-groupLeaderPid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Returns whether the owned containment unit is alive, or null when this
 * platform cannot strongly observe descendants after their leader exits.
 */
export function isProcessTreeContainmentAlive(
  groupLeaderPid: number,
  observation: {
    platform?: NodeJS.Platform
    readdir?: (path: string) => string[]
    readFile?: (path: string) => string
  } = {},
): boolean | null {
  if (!Number.isInteger(groupLeaderPid) || groupLeaderPid <= 0) return false
  const platform = observation.platform ?? process.platform
  if (platform === 'win32') return null
  if (platform !== 'linux') return null
  const readdir = observation.readdir ?? (target => readdirSync(target))
  const readStat = observation.readFile ?? (target => readFileSync(target, 'utf8'))
  try {
    const scan = (): { names: string[]; identities: string[] } | null => {
      const names = readdir('/proc').filter(entry => /^\d+$/.test(entry)).sort()
      const identities: string[] = []
      for (const entry of names) {
        let stat: string
        try { stat = readStat(`/proc/${entry}/stat`) }
        catch (error) {
          // ENOENT after enumeration is churn, not negative evidence. Even if
          // the same numeric name appears in the next directory listing, it
          // may be a different process generation. A complete scan is the
          // minimum authority for proving containment empty.
          return null
        }
        const commandEnd = stat.lastIndexOf(')')
        if (commandEnd < 0) return null
        const fields = stat.slice(commandEnd + 2).trim().split(/\s+/)
        // Fields after comm start with state. pgrp is index 2 and starttime
        // (the process birth identity) is index 19.
        if (fields.length < 20 || !/^\d+$/.test(fields[2] ?? '')
          || !/^\d+$/.test(fields[19] ?? '')) return null
        identities.push(`${entry}:${fields[19]}:${fields[2]}`)
      }
      return { names, identities }
    }
    const before = scan()
    const after = scan()
    if (!before || !after
      || JSON.stringify(before.names) !== JSON.stringify(after.names)
      || JSON.stringify(before.identities) !== JSON.stringify(after.identities)) return null
    return after.identities.some(identity => identity.endsWith(`:${groupLeaderPid}`))
  } catch {
    return null
  }
}

async function waitForPosixProcessGroupExit(
  groupLeaderPid: number,
  timeoutMs: number,
  pollMs: number,
  expectedStartedAtMs?: number | null,
  expectedBirthToken?: string | null,
  platform: NodeJS.Platform = process.platform,
  birthTokenReader: (pid: number, platform: NodeJS.Platform) => string | null = readProcessBirthToken,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // A process group id is only an authority while its exact leader is still
    // alive.  Once the leader exits the numeric PGID can immediately be
    // recycled, so even a signal-0 group probe would target unrelated work.
    if (!isProcessAlive(groupLeaderPid)) return false
    if (Number.isFinite(expectedStartedAtMs) && expectedStartedAtMs !== null
      && await readProcessStartTimeMs(groupLeaderPid) !== expectedStartedAtMs) return false
    if (!isProcessAlive(groupLeaderPid)) return false
    if (platform === 'linux' && (!expectedBirthToken
      || birthTokenReader(groupLeaderPid, 'linux') !== expectedBirthToken)) return false
    if (!isPosixProcessGroupAlive(groupLeaderPid)) return true
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  if (!isProcessAlive(groupLeaderPid)) return false
  if (Number.isFinite(expectedStartedAtMs) && expectedStartedAtMs !== null
    && await readProcessStartTimeMs(groupLeaderPid) !== expectedStartedAtMs) return false
  if (!isProcessAlive(groupLeaderPid)) return false
  if (platform === 'linux' && (!expectedBirthToken
    || birthTokenReader(groupLeaderPid, 'linux') !== expectedBirthToken)) return false
  return !isPosixProcessGroupAlive(groupLeaderPid)
}

export async function killProcessTreeAndWait(
  pid: number | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
  options: {
    timeoutMs?: number
    pollMs?: number
    /** @deprecated Kept for call compatibility; PID-only taskkill is disabled. */
    taskkillTimeoutMs?: number
    expectedStartedAtMs?: number | null
    /** Exact native birth authority; required for detached Linux group mutation. */
    expectedBirthToken?: string | null
    /**
     * Explicit authority to signal a detached, manager-owned POSIX process
     * group whose leader is exactly `pid`. Ordinary children must omit this.
     */
    posixProcessGroupLeader?: boolean
    /** Legacy strict-tree request; completes only through windowsOwnedTreeRelease. */
    windowsTaskkillTreeAuthority?: boolean
    /** Exact in-process launcher/job authority. Its completion proves tree exit. */
    windowsOwnedTreeRelease?: (signal: NodeJS.Signals) => Promise<boolean>
    /** Test-only platform selection; production omits it. */
    platform?: NodeJS.Platform
    /** Test-only native birth observation; production omits it. */
    birthTokenReader?: (pid: number, platform: NodeJS.Platform) => string | null
  } = {},
): Promise<boolean> {
  if (!pid || !Number.isFinite(pid) || pid <= 0) {
    return true
  }

  const timeoutMs = options.timeoutMs ?? 2_500
  const pollMs = options.pollMs ?? 50
  if (timeoutMs <= 0) return false

  if ((options.platform ?? process.platform) === 'win32') {
    // A PID and a successful taskkill exit are not stable tree authority: the
    // PID may be reused before taskkill opens it. Strict callers must use their
    // already-owned launcher/job/ChildProcess handle instead.
    if (options.windowsTaskkillTreeAuthority === true) {
      return options.windowsOwnedTreeRelease?.(signal) ?? false
    }
    if (Number.isFinite(options.expectedStartedAtMs)
      && options.expectedStartedAtMs !== null) return false
    try {
      process.kill(pid, signal)
    } catch {
      return !isProcessAlive(pid)
    }
    return waitForProcessExit(pid, timeoutMs, pollMs)
  }

  if (Number.isFinite(options.expectedStartedAtMs) && options.expectedStartedAtMs !== null) {
    const currentStartedAtMs = await readProcessStartTimeMs(pid)
    if (currentStartedAtMs !== options.expectedStartedAtMs) return false
  }

  if (options.posixProcessGroupLeader === true) {
    // Revalidate immediately before every group signal.  Callers may retry,
    // but no successful validation is reusable across an await or retry.
    if (!isProcessAlive(pid)) return false
    if (Number.isFinite(options.expectedStartedAtMs) && options.expectedStartedAtMs !== null
      && await readProcessStartTimeMs(pid) !== options.expectedStartedAtMs) return false
    if (!isProcessAlive(pid)) return false
    // Wall-clock process start timestamps (notably `ps lstart`) are not a
    // generation token. Production group mutation requires Linux boot-id plus
    // /proc starttime and re-reads it synchronously in the final syscall window.
    if ((options.platform ?? process.platform) === 'linux') {
      if (!options.expectedBirthToken
        || (options.birthTokenReader ?? readProcessBirthToken)(pid, 'linux')
          !== options.expectedBirthToken) return false
    } else if (options.expectedBirthToken) return false
    try {
      process.kill(-pid, signal)
    } catch {
      return false
    }
    return waitForPosixProcessGroupExit(pid, timeoutMs, pollMs,
      options.expectedStartedAtMs, options.expectedBirthToken,
      options.platform ?? process.platform, options.birthTokenReader)
  }
  try {
    process.kill(pid, signal)
  } catch {
    return !isProcessAlive(pid)
  }
  return waitForProcessExit(pid, timeoutMs, pollMs)
}
