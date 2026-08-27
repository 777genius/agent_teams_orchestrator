import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { join } from 'node:path'

import {
  buildWindowsTaskkillInvocation,
  isProcessAlive,
  killProcessTreeAndWait,
  readProcessCommandLine,
  readProcessStartTimeMs,
} from './processKill.js'

const originalSystemRoot = process.env.SystemRoot

afterEach(() => {
  if (originalSystemRoot === undefined) {
    delete process.env.SystemRoot
  } else {
    process.env.SystemRoot = originalSystemRoot
  }
})

describe('processKill', () => {
  it('builds taskkill argv without shell concatenation', () => {
    process.env.SystemRoot = 'C:\\Windows'

    expect(buildWindowsTaskkillInvocation(1234)).toEqual({
      command: join('C:\\Windows', 'System32', 'taskkill.exe'),
      args: ['/T', '/F', '/PID', '1234'],
    })
  })

  it('keeps Windows paths with spaces in the command slot and PID in argv', () => {
    process.env.SystemRoot = 'C:\\Windows With Space'

    expect(buildWindowsTaskkillInvocation(5678)).toEqual({
      command: join('C:\\Windows With Space', 'System32', 'taskkill.exe'),
      args: ['/T', '/F', '/PID', '5678'],
    })
  })

  it('treats invalid pids as not alive', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })

  it('treats invalid pids as already stopped when waiting for process-tree cleanup', async () => {
    await expect(killProcessTreeAndWait(0)).resolves.toBe(true)
    await expect(killProcessTreeAndWait(-1)).resolves.toBe(true)
  })

  it('does not spawn an identity query for an invalid pid', async () => {
    await expect(readProcessStartTimeMs(0, 'win32')).resolves.toBeNull()
    await expect(readProcessCommandLine(-1, 'win32')).resolves.toBeNull()
  })

  it('signals an ordinary POSIX child by positive PID', async () => {
    const calls: number[] = []
    const kill = spyOn(process, 'kill').mockImplementation(((pid: number) => {
      calls.push(pid)
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    }) as typeof process.kill)
    try {
      await expect(killProcessTreeAndWait(44_301, 'SIGTERM', { timeoutMs: 10 }))
        .resolves.toBe(true)
      expect(calls).toEqual([44_301, 44_301])
    } finally {
      kill.mockRestore()
    }
  })

  it('signals a detached owned POSIX group only with explicit authority', async () => {
    const calls: number[] = []
    const kill = spyOn(process, 'kill').mockImplementation(((pid: number) => {
      calls.push(pid)
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    }) as typeof process.kill)
    try {
      await expect(killProcessTreeAndWait(44_302, 'SIGKILL', {
        timeoutMs: 10, posixProcessGroupLeader: true,
      })).resolves.toBe(true)
      expect(calls).toEqual([-44_302, -44_302, 44_302])
    } finally {
      kill.mockRestore()
    }
  })

  it('never treats a zero timeout as cleanup proof or sends a signal', async () => {
    const kill = spyOn(process, 'kill')
    try {
      await expect(killProcessTreeAndWait(44_303, 'SIGKILL', {
        timeoutMs: 0, posixProcessGroupLeader: true,
      })).resolves.toBe(false)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })
})
