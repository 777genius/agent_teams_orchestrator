import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

import {
  buildExactProcessTreeSpawn,
  isProcessAlive,
  terminateExpectedProcessTreeStable,
} from './processKill.js'

describe('Windows Job process containment', () => {
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
    const supervisor = spawn(launch.command, launch.args, launch.options)
    let childPid: number | null = null
    try {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && childPid === null) {
        childPid = await readFile(pidFile, 'utf8')
          .then(value => Number(value.trim()))
          .catch(() => null)
        if (childPid === null) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(supervisor.pid).toBeNumber()
      expect(childPid).toBeNumber()
      expect(isProcessAlive(childPid!)).toBe(true)
      await expect(terminateExpectedProcessTreeStable(
        supervisor.pid!,
        'SIGTERM',
        0,
        launch.osIdentity,
        {
          timeoutMs: 2_000,
          pollMs: 25,
          escalationTimeoutMs: 2_000,
          nowMs: Date.now,
          sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
          platform: 'win32',
        },
      )).resolves.toBe(true)
      const exitDeadline = Date.now() + 2_000
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
  }, 30_000)
})
