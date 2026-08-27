import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { join } from 'node:path'

import {
  buildWindowsTaskkillInvocation,
  isProcessTreeContainmentAlive,
  isProcessAlive,
  killProcessTreeAndWait,
  readProcessCommandLine,
  readProcessBirthToken,
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
    const pid = process.pid
    let groupAlive = true
    const now = spyOn(Date, 'now').mockReturnValue(0)
    const kill = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      calls.push(pid)
      if (pid > 0) return true
      if (signal !== 0) { groupAlive = false; return true }
      if (groupAlive) return true
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    }) as typeof process.kill)
    try {
      await expect(killProcessTreeAndWait(pid, 'SIGKILL', {
        timeoutMs: 10, posixProcessGroupLeader: true, platform: 'linux',
        expectedBirthToken: 'linux:boot:42', birthTokenReader: () => 'linux:boot:42',
      })).resolves.toBe(true)
      expect(calls).toEqual([pid, pid, -pid, pid, pid, -pid])
    } finally {
      kill.mockRestore()
      now.mockRestore()
    }
  })

  it('never touches a recycled process group after TERM removes the exact leader', async () => {
    const calls: Array<[number, NodeJS.Signals | number | undefined]> = []
    const pid = process.pid
    let leaderAlive = true
    const now = spyOn(Date, 'now').mockReturnValue(0)
    const kill = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      calls.push([pid, signal])
      if (pid === -process.pid && signal === 'SIGTERM') {
        leaderAlive = false
        return true
      }
      if (pid === process.pid && signal === 0 && !leaderAlive) {
        const error = new Error('gone') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      }
      return true
    }) as typeof process.kill)
    try {
      await expect(killProcessTreeAndWait(pid, 'SIGTERM', {
        timeoutMs: 10, pollMs: 1, posixProcessGroupLeader: true, platform: 'linux',
        expectedBirthToken: 'linux:boot:42', birthTokenReader: () => 'linux:boot:42',
      })).resolves.toBe(false)
      const negativeCalls = calls.filter(([pid]) => pid < 0)
      expect(negativeCalls).toEqual([[-pid, 'SIGTERM']])
    } finally {
      kill.mockRestore()
      now.mockRestore()
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

  it.each(['darwin', 'freebsd'] as const)(
    'fails closed on %s detached groups without any negative signal or probe',
    async platform => {
      const kill = spyOn(process, 'kill')
      try {
        await expect(killProcessTreeAndWait(44_305, 'SIGTERM', {
          platform, timeoutMs: 10, posixProcessGroupLeader: true,
          expectedStartedAtMs: 1_000,
        })).resolves.toBe(false)
        expect(kill).not.toHaveBeenCalled()
      } finally { kill.mockRestore() }
    },
  )

  it.each(['EACCES', 'EIO'] as const)('treats Linux proc %s as unknown, never empty', code => {
    expect(isProcessTreeContainmentAlive(443, {
      platform: 'linux', readdir: () => ['10'], readFile: () => {
        const error = new Error(code) as NodeJS.ErrnoException
        error.code = code
        throw error
      },
    })).toBeNull()
  })

  it('requires well-formed and stable Linux proc observations before proving empty', () => {
    const stat = (name: string, pgrp: number, birth = 99, state = 'S') =>
      `10 (${name}) ${state} 1 ${pgrp} ${Array(16).fill('0').join(' ')} ${birth}`
    expect(isProcessTreeContainmentAlive(443, {
      platform: 'linux', readdir: () => ['10'], readFile: () => 'malformed',
    })).toBeNull()
    let reads = 0
    expect(isProcessTreeContainmentAlive(443, {
      platform: 'linux', readdir: () => ++reads === 1 ? ['10'] : [],
      readFile: () => stat('gone', 10),
    })).toBe(false)
    expect(isProcessTreeContainmentAlive(443, {
      platform: 'linux', readdir: () => ['10'],
      readFile: () => stat('stable', 10),
    })).toBe(false)
    let unrelatedScan = 0
    expect(isProcessTreeContainmentAlive(443, {
      platform: 'linux',
      readdir: () => ++unrelatedScan === 1 ? ['10'] : ['10', '11'],
      readFile: target => stat(target.endsWith('/10/stat') ? 'stable' : 'new', 10),
    })).toBe(false)
    expect(isProcessTreeContainmentAlive(443, {
      platform: 'linux', readdir: () => ['10'],
      readFile: () => stat('live', 443),
    })).toBe(true)
    for (const state of ['Z', 'X']) {
      expect(isProcessTreeContainmentAlive(443, {
        platform: 'linux', readdir: () => ['10'],
        readFile: () => stat('dead', 443, 99, state),
      })).toBe(false)
    }
    let identityRead = 0
    expect(isProcessTreeContainmentAlive(443, {
      platform: 'linux', readdir: () => ['10'],
      readFile: () => stat('churn', identityRead++ === 0 ? 10 : 443, identityRead),
    })).toBeNull()
  })

  it('accepts a vanished proc entry while retaining stable empty containment proof', () => {
    const gone = new Error('gone') as NodeJS.ErrnoException
    gone.code = 'ENOENT'
    expect(isProcessTreeContainmentAlive(443, {
      platform: 'linux', readdir: () => ['10'], readFile: () => { throw gone },
    })).toBe(false)
  })

  it('binds Linux birth to boot id and native start ticks', () => {
    const boot = '11111111-2222-3333-4444-555555555555'
    const stat = `44 (same-second) S 1 44 ${Array(16).fill('0').join(' ')} 987654`
    expect(readProcessBirthToken(44, 'linux', { readFile: target =>
      target.endsWith('boot_id') ? boot : stat })).toBe(`linux:${boot}:987654`)
  })

  it('never signals a same-second recycled group when its native birth changes', async () => {
    const calls: number[] = []
    const kill = spyOn(process, 'kill').mockImplementation(((pid: number) => {
      calls.push(pid); return true
    }) as typeof process.kill)
    try {
      await expect(killProcessTreeAndWait(44_307, 'SIGTERM', {
        timeoutMs: 10, posixProcessGroupLeader: true,
        expectedStartedAtMs: 1_000, expectedBirthToken: 'linux:boot:old',
        birthTokenReader: () => 'linux:boot:new',
      })).resolves.toBe(false)
      expect(calls.every(pid => pid >= 0)).toBe(true)
    } finally { kill.mockRestore() }
  })

  it('fails closed for strict Windows PID-only cleanup and accepts owned job completion', async () => {
    await expect(killProcessTreeAndWait(44_305, 'SIGTERM', {
      platform: 'win32', timeoutMs: 10, windowsTaskkillTreeAuthority: true,
    })).resolves.toBe(false)
    await expect(killProcessTreeAndWait(44_305, 'SIGTERM', {
      platform: 'win32', timeoutMs: 10, expectedStartedAtMs: 12_345,
    })).resolves.toBe(false)
    const releases: NodeJS.Signals[] = []
    await expect(killProcessTreeAndWait(44_305, 'SIGKILL', {
      platform: 'win32', timeoutMs: 10, windowsTaskkillTreeAuthority: true,
      windowsOwnedTreeRelease: async signal => { releases.push(signal); return true },
    })).resolves.toBe(true)
    expect(releases).toEqual(['SIGKILL'])
    await expect(killProcessTreeAndWait(44_305, 'SIGKILL', {
      platform: 'win32', timeoutMs: 10, windowsTaskkillTreeAuthority: true,
      windowsOwnedTreeRelease: async () => false,
    })).resolves.toBe(false)
  })

  it('never invokes a PID-only Windows tree mutation', async () => {
    const calls: Array<[number, NodeJS.Signals | number | undefined]> = []
    const kill = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      calls.push([pid, signal])
      if (signal === 0) {
        const error = new Error('gone') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      }
      return true
    }) as typeof process.kill)
    try {
      await expect(killProcessTreeAndWait(44_306, 'SIGTERM', {
        platform: 'win32', timeoutMs: 10,
      })).resolves.toBe(true)
      expect(calls).toEqual([[44_306, 'SIGTERM'], [44_306, 0]])
    } finally { kill.mockRestore() }
  })
})
