import { spawn } from 'node:child_process'
import { join } from 'node:path'

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
  options: { timeoutMs?: number; pollMs?: number; taskkillTimeoutMs?: number } = {},
): Promise<boolean> {
  if (!pid || !Number.isFinite(pid) || pid <= 0) {
    return true
  }

  const timeoutMs = options.timeoutMs ?? 2_500
  const pollMs = options.pollMs ?? 50

  if (process.platform === 'win32') {
    await runWindowsTaskkill(pid, options.taskkillTimeoutMs ?? timeoutMs)
    return waitForProcessExit(pid, timeoutMs, pollMs)
  }

  try {
    process.kill(pid, signal)
  } catch {
    return !isProcessAlive(pid)
  }

  return waitForProcessExit(pid, timeoutMs, pollMs)
}
