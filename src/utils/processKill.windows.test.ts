import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

import {
  buildExactProcessTreeSpawn,
  confirmNaturalProcessTreeExit,
  isProcessAlive,
  terminateExpectedProcessTreeStable,
} from './processKill.js'

const WINDOWS_JOB_SUPERVISOR_STARTUP_BUDGET_MS = 20_000
const WINDOWS_JOB_TERMINATION_HOST_STARTUP_BUDGET_MS = 20_000
const WINDOWS_JOB_TERMINATION_TIMEOUT_MS = 2_000
const WINDOWS_JOB_TERMINATION_ESCALATION_TIMEOUT_MS = 2_000
const WINDOWS_JOB_CHILD_EXIT_TIMEOUT_MS = 2_000
const WINDOWS_JOB_TEST_HARNESS_OVERHEAD_MS = 5_000
const WINDOWS_JOB_TEST_TIMEOUT_MS =
  WINDOWS_JOB_SUPERVISOR_STARTUP_BUDGET_MS +
  WINDOWS_JOB_TERMINATION_HOST_STARTUP_BUDGET_MS +
  WINDOWS_JOB_TERMINATION_TIMEOUT_MS +
  WINDOWS_JOB_TERMINATION_ESCALATION_TIMEOUT_MS +
  WINDOWS_JOB_CHILD_EXIT_TIMEOUT_MS +
  WINDOWS_JOB_TEST_HARNESS_OVERHEAD_MS
const WINDOWS_JOB_STDERR_LIMIT = 16 * 1024

async function withPhaseTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phase: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${phase} exceeded its ${timeoutMs}ms budget`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

describe('Windows Job process containment', () => {
  it('round-trips hostile native argv without cmd interpolation', async () => {
    if (process.platform !== 'win32') return
    const root = await mkdtemp(join(os.tmpdir(), 'process-kill-argv-'))
    const argvPath = join(root, 'argv.json')
    const expected = ['', 'embedded"quote', 'こんにちは 😀',
      'ampersand&pipe|percent%bang!paren()', 'C:\\path with space\\']
    const launch = buildExactProcessTreeSpawn(process.execPath, [
      '-e', 'require("node:fs").writeFileSync(process.env.JOB_ARGV_FILE,JSON.stringify(process.argv.slice(1)))',
      ...expected,
    ], {
      stdio: 'ignore', env: { ...process.env, JOB_ARGV_FILE: argvPath },
    }, 'win32')
    const supervisor = spawn(launch.command, launch.args, launch.options)
    try {
      await withPhaseTimeout(new Promise<void>((resolve, reject) => {
        supervisor.once('error', reject)
        supervisor.once('close', code => code === 0 ? resolve() : reject(new Error(`supervisor exited ${code}`)))
      }), WINDOWS_JOB_SUPERVISOR_STARTUP_BUDGET_MS, 'Windows argv round-trip')
      expect(JSON.parse(await readFile(argvPath, 'utf8'))).toEqual(expected)
    } finally {
      try { supervisor.kill('SIGKILL') } catch {}
      await rm(root, { recursive: true, force: true })
    }
  }, WINDOWS_JOB_TEST_TIMEOUT_MS)

  it('proves a naturally completed supervisor Job empty after its named handle disappears', async () => {
    if (process.platform !== 'win32') return
    const launch = buildExactProcessTreeSpawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    }, 'win32')
    const supervisor = spawn(launch.command, launch.args, launch.options)
    await withPhaseTimeout(new Promise<void>((resolve, reject) => {
      supervisor.once('error', reject)
      supervisor.once('close', () => resolve())
    }), WINDOWS_JOB_SUPERVISOR_STARTUP_BUDGET_MS, 'natural Windows Job supervisor exit')
    await expect(confirmNaturalProcessTreeExit(
      supervisor.pid!, launch.osIdentity, 'win32',
    )).resolves.toBe(true)
  }, WINDOWS_JOB_TEST_TIMEOUT_MS)

  it('launches inside the Job and proves it empty after exact termination', async () => {
    if (process.platform !== 'win32') return
    // This intentionally exercises the native PowerShell/Win32 path and runs
    // on windows-latest in the process-containment CI job. Cross-platform unit
    // tests only validate generated argv and cannot catch ABI-size mistakes.
    const root = await mkdtemp(join(os.tmpdir(), 'process-kill-job-'))
    const pidFile = join(root, 'child.pid')
    const childCode = 'require("node:fs").writeFileSync(process.env.JOB_CHILD_PID_FILE,String(process.pid));setInterval(()=>{},1000)'
    const launch = buildExactProcessTreeSpawn(process.execPath, ['-e', childCode], {
      stdio: 'ignore',
      env: { ...process.env, JOB_CHILD_PID_FILE: pidFile },
    }, 'win32')
    const supervisor = spawn(launch.command, launch.args, {
      ...launch.options,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let supervisorError: string | null = null
    let supervisorStderr = ''
    let supervisorStderrTruncated = false
    supervisor.once('error', error => {
      supervisorError = error.stack ?? error.message
    })
    supervisor.stderr?.setEncoding('utf8')
    supervisor.stderr?.on('data', (chunk: string) => {
      const remaining = WINDOWS_JOB_STDERR_LIMIT - supervisorStderr.length
      if (remaining <= 0) {
        supervisorStderrTruncated = true
        return
      }
      supervisorStderr += chunk.slice(0, remaining)
      if (chunk.length > remaining) supervisorStderrTruncated = true
    })
    let childPid: number | null = null
    try {
      // The launch supervisor and termination host each perform an independent
      // cold Add-Type compilation on hosted Windows runners. Their startup
      // budgets are therefore separate from the bounded Job termination and
      // child-exit checks.
      const deadline = Date.now() + WINDOWS_JOB_SUPERVISOR_STARTUP_BUDGET_MS
      while (Date.now() < deadline && childPid === null) {
        childPid = await readFile(pidFile, 'utf8')
          .then(value => Number(value.trim()))
          .catch(() => null)
        if (
          childPid === null &&
          supervisorError === null &&
          supervisor.exitCode === null &&
          supervisor.signalCode === null
        ) {
          await new Promise(resolve => setTimeout(resolve, 25))
        } else if (childPid === null) {
          break
        }
      }
      if (childPid === null) {
        const exit = supervisor.exitCode !== null
          ? `exitCode=${supervisor.exitCode}`
          : supervisor.signalCode !== null
            ? `signal=${supervisor.signalCode}`
            : 'still-running'
        const stderr = supervisorStderr.trim() || '<empty>'
        const truncated = supervisorStderrTruncated ? ' [truncated]' : ''
        throw new Error(
          `Windows Job supervisor did not publish the child PID within ` +
          `${WINDOWS_JOB_SUPERVISOR_STARTUP_BUDGET_MS}ms; ${exit}; ` +
          `spawnError=${supervisorError ?? '<none>'}; stderr=${stderr}${truncated}`,
        )
      }
      expect(supervisor.pid).toBeNumber()
      expect(childPid).toBeNumber()
      expect(isProcessAlive(childPid!)).toBe(true)
      await expect(withPhaseTimeout(
        terminateExpectedProcessTreeStable(
          supervisor.pid!,
          'SIGTERM',
          0,
          launch.osIdentity,
          {
            timeoutMs: WINDOWS_JOB_TERMINATION_TIMEOUT_MS,
            pollMs: 25,
            escalationTimeoutMs: WINDOWS_JOB_TERMINATION_ESCALATION_TIMEOUT_MS,
            nowMs: Date.now,
            sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
            platform: 'win32',
          },
        ),
        WINDOWS_JOB_TERMINATION_HOST_STARTUP_BUDGET_MS +
          WINDOWS_JOB_TERMINATION_TIMEOUT_MS +
          WINDOWS_JOB_TERMINATION_ESCALATION_TIMEOUT_MS,
        'Windows Job termination host startup and bounded cleanup',
      )).resolves.toBe(true)
      const exitDeadline = Date.now() + WINDOWS_JOB_CHILD_EXIT_TIMEOUT_MS
      while (Date.now() < exitDeadline && isProcessAlive(childPid!)) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(isProcessAlive(childPid!)).toBe(false)
    } finally {
      try { supervisor.kill('SIGKILL') } catch {}
      if (childPid) {
        try { process.kill(childPid, 'SIGKILL') } catch {}
      }
      await rm(root, { recursive: true, force: true })
    }
  }, WINDOWS_JOB_TEST_TIMEOUT_MS)
})
