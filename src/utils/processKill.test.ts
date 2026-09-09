import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'

import {
  buildWindowsTaskkillInvocation,
  isProcessAlive,
  killProcessTreeAndWait,
  parseDarwinProcessStartTime,
  parseLinuxProcessStartTicks,
  readProcessCommandLine,
  readProcessStartTimeMs,
} from './processKill.js'

const originalSystemRoot = process.env.SystemRoot

afterEach(() => {
  mock.restore()
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

  it('refuses to signal a process whose start identity does not match', async () => {
    const startedAtMs = await readProcessStartTimeMs(process.pid)
    expect(startedAtMs).not.toBeNull()
    await expect(killProcessTreeAndWait(process.pid, 'SIGTERM', {
      expectedStartedAtMs: startedAtMs! + 1,
    })).resolves.toBe(false)
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('does not spawn an identity query for an invalid pid', async () => {
    const spawn = spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('Invalid PID must not spawn')
    })
    for (const pid of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
      0x80000000, '123', '123; exit 0', null, undefined]) {
      await expect(readProcessStartTimeMs(pid as number, 'win32')).resolves.toBeNull()
    }
    await expect(readProcessCommandLine(-1, 'win32')).resolves.toBeNull()
    expect(spawn).not.toHaveBeenCalled()
  })

  function mockWindowsQuery() {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      kill: mock(() => true),
    })
    const spawn = spyOn(childProcess, 'spawn').mockReturnValue(child as unknown as childProcess.ChildProcess)
    return { child, spawn }
  }

  // Drive the query's deadline without sleeping or depending on runner load.
  function mockQueryClock() {
    let now = 0
    const pending = new Map<object, { at: number; fire: () => void }>()
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
      const handle = { unref() {} }
      pending.set(handle, { at: now + ms, fire: callback })
      return handle
    }) as typeof setTimeout)
    spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: object) => {
      pending.delete(handle)
    }) as typeof clearTimeout)
    return {
      timer,
      advanceTo(ms: number) {
        now = ms
        for (const [handle, task] of pending) {
          if (task.at <= now) {
            pending.delete(handle)
            task.fire()
          }
        }
      },
      pendingCount: () => pending.size,
    }
  }

  it('queries the same Windows creation time through .NET without cmdlet autoimport', async () => {
    const { child, spawn } = mockWindowsQuery()
    const result = readProcessStartTimeMs(2104, 'win32')
    expect(spawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawn.mock.calls[0]!
    expect(command).toBe('powershell.exe')
    expect(args!.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'])
    const query = args![5]!
    expect(query).toContain('$ErrorActionPreference = "Stop"')
    expect(query).toContain('$process = $null; try { $process = [System.Diagnostics.Process]::GetProcessById(2104)')
    expect(query).toContain('$process.StartTime.ToUniversalTime().ToString("o")')
    expect(query).toContain('catch { exit 1 } finally { if ($null -ne $process) { $process.Dispose() } }')
    expect(query).toEndWith('[Console]::Out.WriteLine($startedAt)')
    expect(query).not.toMatch(/Get-Process|Get-CimInstance|Import-Module|Write-Output/)
    expect(options).toEqual({ stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    child.stdout.write('2026-09-09T03:26:43.')
    child.stdout.write('6163024Z\r\n')
    child.emit('close', 0)
    await expect(result).resolves.toBe(Date.parse('2026-09-09T03:26:43.6163024Z'))
  })

  it('fails closed on missing, denied, malformed, or failed Windows queries', async () => {
    for (const [output, code] of [['', 0], ['not a timestamp', 0],
      ['2026-09-09T03:26:43.6163024Z\n', 1], ['2026-09-09T03:26:43.6163024Z\n', null]] as const) {
      const { child, spawn } = mockWindowsQuery()
      const result = readProcessStartTimeMs(2104, 'win32')
      child.stdout.write(output)
      child.emit('close', code)
      await expect(result).resolves.toBeNull()
      expect(spawn).toHaveBeenCalledTimes(1)
      spawn.mockRestore()
    }
  })

  it('fails closed on Windows query spawn errors without a fallback', async () => {
    const { child, spawn } = mockWindowsQuery()
    const result = readProcessStartTimeMs(2104, 'win32')
    child.emit('error', new Error('ENOENT'))
    await expect(result).resolves.toBeNull()
    expect(spawn).toHaveBeenCalledTimes(1)
    spawn.mockImplementation(() => { throw new Error('EACCES') })
    await expect(readProcessStartTimeMs(2104, 'win32')).resolves.toBeNull()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('retains the 64 KiB Windows identity output bound', async () => {
    const { child } = mockWindowsQuery()
    const result = readProcessStartTimeMs(2104, 'win32')
    child.stdout.write(' '.repeat(64 * 1024))
    child.stdout.write('2026-09-09T03:26:43.6163024Z\n')
    child.emit('close', 0)
    await expect(result).resolves.toBeNull()
  })

  it('accepts the first cold Windows identity after the old budget without a retry', async () => {
    const { child, spawn } = mockWindowsQuery()
    const clock = mockQueryClock()
    const result = readProcessStartTimeMs(2104, 'win32')
    let settled = false
    void result.then(() => { settled = true })
    clock.advanceTo(3_000)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
    child.stdout.write('2026-09-09T03:26:43.6163024Z\r\n')
    clock.advanceTo(4_999)
    child.emit('close', 0)
    await expect(result).resolves.toBe(Date.parse('2026-09-09T03:26:43.6163024Z'))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(clock.pendingCount()).toBe(0)
    clock.advanceTo(5_000)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('kills a hung Windows query at 5 seconds and ignores partial or late success', async () => {
    const { child, spawn } = mockWindowsQuery()
    const clock = mockQueryClock()
    const result = readProcessStartTimeMs(2104, 'win32')
    expect(clock.timer.mock.calls[0]![1]).toBe(5_000)
    child.stdout.write('2026-09-09T03:26:43.6163024Z\n')
    clock.advanceTo(4_999)
    expect(child.kill).not.toHaveBeenCalled()
    clock.advanceTo(5_000)
    await expect(result).resolves.toBeNull()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(clock.pendingCount()).toBe(0)
    child.stdout.write('2026-09-09T03:26:43.6163024Z\n')
    child.emit('close', 0)
    await expect(result).resolves.toBeNull()
  })

  it('still rejects invalid output after a cold Windows startup', async () => {
    const { child, spawn } = mockWindowsQuery()
    const clock = mockQueryClock()
    const result = readProcessStartTimeMs(2104, 'win32')
    clock.advanceTo(3_000)
    child.stdout.write('not a timestamp\r\n')
    child.emit('close', 0)
    await expect(result).resolves.toBeNull()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(child.kill).not.toHaveBeenCalled()
    expect(clock.pendingCount()).toBe(0)
  })

  it('retains the 2.5 second budget for Darwin identity and command-line queries', async () => {
    for (const query of [
      () => readProcessStartTimeMs(2104, 'darwin'),
      () => readProcessCommandLine(2104, 'darwin'),
      () => readProcessCommandLine(2104, 'win32'),
    ]) {
      const { child, spawn } = mockWindowsQuery()
      const clock = mockQueryClock()
      const result = query()
      expect(clock.timer.mock.calls[0]![1]).toBe(2_500)
      clock.advanceTo(2_499)
      expect(child.kill).not.toHaveBeenCalled()
      clock.advanceTo(2_500)
      await expect(result).resolves.toBeNull()
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(clock.pendingCount()).toBe(0)
      mock.restore()
    }
  })

  it('parses precise Linux start ticks when command names contain delimiters', () => {
    const fields = Array.from({ length: 19 }, (_, index) => String(index + 1))
    fields[18] = '987654321'
    expect(parseLinuxProcessStartTicks(`123 (worker ) name) S ${fields.join(' ')}`))
      .toBe(987654321)
    expect(parseLinuxProcessStartTicks('malformed')).toBeNull()
  })

  it('parses Darwin ps lstart output as an epoch timestamp', () => {
    expect(parseDarwinProcessStartTime('Tue Sep  2 18:12:34 2026\n'))
      .toBe(Date.parse('Tue Sep  2 18:12:34 2026'))
    expect(parseDarwinProcessStartTime('not a process start time')).toBeNull()
  })
})
