import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import * as nativeProcess from './windowsNativeProcess.js'

import {
  buildWindowsTaskkillInvocation,
  hasPendingStartupTaskkill,
  drainStartupTaskkills,
  killProcessTreeForStartup,
  isProcessAlive,
  killProcessTreeAndWait,
  parseDarwinProcessStartTime,
  parseLinuxProcessStartTicks,
  readProcessCommandLine,
  readProcessStartTimeMs,
  readWindowsProcessStartTimeMsWithPowerShell,
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
    const native = spyOn(nativeProcess, 'windowsNativeProcess').mockRejectedValue(new Error('Invalid PID must not query native identity'))
    const spawn = spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('Invalid PID must not spawn')
    })
    for (const pid of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
      0x80000000, '123', '123; exit 0', null, undefined]) {
      await expect(readProcessStartTimeMs(pid as number, 'win32')).resolves.toBeNull()
      await expect(readWindowsProcessStartTimeMsWithPowerShell(pid as number)).resolves.toBeNull()
    }
    await expect(readProcessCommandLine(-1, 'win32')).resolves.toBeNull()
    expect(spawn).not.toHaveBeenCalled()
    expect(native).not.toHaveBeenCalled()
  })

  function mockWindowsQuery() {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
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

  it('uses native Windows creation time without spawning or reading the process table', async () => {
    const birth = mock(() => 1_792_513_777_348)
    const table = mock(() => { throw new Error('Identity must not enumerate processes') })
    const native = spyOn(nativeProcess, 'windowsNativeProcess').mockResolvedValue({ birth, table })
    const spawn = spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('Native identity must not spawn') })
    await expect(readProcessStartTimeMs(2104, 'win32')).resolves.toBe(1_792_513_777_348)
    expect(native).toHaveBeenCalledTimes(1)
    expect(birth).toHaveBeenCalledTimes(1)
    expect(birth).toHaveBeenCalledWith(2104)
    expect(table).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not fall back after native Windows denial, exit, or observation error', async () => {
    const birth = mock<() => number | null>(() => null)
    spyOn(nativeProcess, 'windowsNativeProcess').mockResolvedValue({ birth, table: () => [] })
    const spawn = spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('Native result must not fall back') })
    await expect(readProcessStartTimeMs(2104, 'win32')).resolves.toBeNull()
    birth.mockImplementation(() => { throw new Error('Native observation failed') })
    await expect(readProcessStartTimeMs(2104, 'win32')).resolves.toBeNull()
    expect(birth).toHaveBeenCalledTimes(2)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('fails closed if native capability resolution rejects', async () => {
    spyOn(nativeProcess, 'windowsNativeProcess').mockRejectedValue(new Error('Unknown native capability'))
    const spawn = spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('Unknown capability must not fall back') })
    await expect(readProcessStartTimeMs(2104, 'win32')).resolves.toBeNull()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('uses one unchanged bounded PowerShell query only when native capability is unavailable', async () => {
    spyOn(nativeProcess, 'windowsNativeProcess').mockResolvedValue(null)
    const { child, spawn } = mockWindowsQuery()
    const clock = mockQueryClock()
    const result = readProcessStartTimeMs(2104, 'win32')
    await Promise.resolve()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![0]).toBe('powershell.exe')
    expect(clock.timer.mock.calls[0]![1]).toBe(6_000)
    child.stdout.write('2026-09-09T03:26:43.6163024Z\r\n')
    child.emit('close', 0)
    await expect(result).resolves.toBe(Date.parse('2026-09-09T03:26:43.6163024Z'))
    expect(clock.pendingCount()).toBe(0)
  })

  it('queries the same Windows creation time through .NET without cmdlet autoimport', async () => {
    const { child, spawn } = mockWindowsQuery()
    const result = readWindowsProcessStartTimeMsWithPowerShell(2104)
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
    expect(options).toEqual({ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.stderr.end('ignored diagnostic\n2020-01-01T00:00:00.000Z\n')
    child.stdout.write('2026-09-09T03:26:43.')
    child.stdout.write('6163024Z\r\n')
    child.emit('close', 0)
    await expect(result).resolves.toBe(Date.parse('2026-09-09T03:26:43.6163024Z'))
  })

  it('fails closed on missing, denied, malformed, or failed Windows queries', async () => {
    for (const [output, code] of [['', 0], ['not a timestamp', 0],
      ['2026-09-09T03:26:43.6163024Z\n', 1], ['2026-09-09T03:26:43.6163024Z\n', null]] as const) {
      const { child, spawn } = mockWindowsQuery()
      const result = readWindowsProcessStartTimeMsWithPowerShell(2104)
      child.stdout.write(output)
      child.emit('close', code)
      await expect(result).resolves.toBeNull()
      expect(spawn).toHaveBeenCalledTimes(1)
      spawn.mockRestore()
    }
  })

  it('fails closed on Windows query spawn errors without a fallback', async () => {
    const { child, spawn } = mockWindowsQuery()
    const result = readWindowsProcessStartTimeMsWithPowerShell(2104)
    child.emit('error', new Error('ENOENT'))
    await expect(result).resolves.toBeNull()
    expect(spawn).toHaveBeenCalledTimes(1)
    spawn.mockImplementation(() => { throw new Error('EACCES') })
    await expect(readWindowsProcessStartTimeMsWithPowerShell(2104)).resolves.toBeNull()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('retains the 64 KiB Windows identity output bound', async () => {
    const { child } = mockWindowsQuery()
    const result = readWindowsProcessStartTimeMsWithPowerShell(2104)
    child.stdout.write(' '.repeat(64 * 1024))
    child.stdout.write('2026-09-09T03:26:43.6163024Z\n')
    child.emit('close', 0)
    await expect(result).resolves.toBeNull()
  })

  it('accepts the first cold Windows identity after the old budget without a retry', async () => {
    const { child, spawn } = mockWindowsQuery()
    const clock = mockQueryClock()
    const result = readWindowsProcessStartTimeMsWithPowerShell(2104)
    let settled = false
    void result.then(() => { settled = true })
    clock.advanceTo(5_500)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
    child.stdout.write('2026-09-09T03:26:43.6163024Z\r\n')
    clock.advanceTo(5_999)
    child.emit('close', 0)
    await expect(result).resolves.toBe(Date.parse('2026-09-09T03:26:43.6163024Z'))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(clock.pendingCount()).toBe(0)
    clock.advanceTo(6_000)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('kills a hung Windows query at 6 seconds and ignores partial or late success', async () => {
    const { child, spawn } = mockWindowsQuery()
    const clock = mockQueryClock()
    const result = readWindowsProcessStartTimeMsWithPowerShell(2104)
    expect(clock.timer.mock.calls[0]![1]).toBe(6_000)
    child.stdout.write('2026-09-09T03:26:43.6163024Z\n')
    clock.advanceTo(5_999)
    expect(child.kill).not.toHaveBeenCalled()
    clock.advanceTo(6_000)
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
    const result = readWindowsProcessStartTimeMsWithPowerShell(2104)
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

  it('startup accepts four-second Windows identity and legacy reads with a six-second override', async () => {
    for (const query of [
      () => readWindowsProcessStartTimeMsWithPowerShell(2104, 6_000),
      () => readProcessCommandLine(2104, 'win32', 6_000),
    ]) {
      const { child } = mockWindowsQuery()
      const clock = mockQueryClock()
      const result = query()
      expect(clock.timer.mock.calls[0]![1]).toBe(6_000)
      clock.advanceTo(4_000)
      child.stdout.write('2026-09-09T03:26:43.6163024Z')
      child.emit('close', 0)
      expect(await result).not.toBeNull()
      expect(child.kill).not.toHaveBeenCalled()
      mock.restore()
    }
  })

  const startupBudget = { cap: (ms: number) => ms, assertAvailable: () => {} }
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

  it('startup timeout requests stop but waits for actual delayed close', async () => {
    const { child } = mockWindowsQuery()
    const clock = mockQueryClock()
    let done = false
    const result = killProcessTreeForStartup(2104, 1000, startupBudget, {
      readIdentity: async () => 1000, alive: () => false,
    })
    void result.then(() => { done = true })
    await flush()
    clock.advanceTo(2_500)
    await flush()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(done).toBe(false)
    expect(hasPendingStartupTaskkill(2104)).toBe(true)
    child.emit('close', 0)
    expect(await result).toEqual({ helperTerminated: true, rootGone: true, treeKillSucceeded: false })
    expect(hasPendingStartupTaskkill(2104)).toBe(false)
  })

  it('startup live helper yields explicit unknown facts and retry never dispatches another helper', async () => {
    const { child, spawn } = mockWindowsQuery()
    const clock = mockQueryClock()
    const deps = { readIdentity: async () => 1000, alive: () => false }
    const result = killProcessTreeForStartup(2104, 1000, startupBudget, deps)
    await flush()
    clock.advanceTo(3_500)
    let drained = false
    const drain = drainStartupTaskkills().then(() => { drained = true })
    await flush()
    expect(drained).toBe(false)
    expect(await result).toEqual({ helperTerminated: false, rootGone: true, treeKillSucceeded: false })
    expect((await killProcessTreeForStartup(2104, 1000, startupBudget, deps)).helperTerminated).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1)
    child.emit('close', 1)
    await drain
    expect(drained).toBe(true)
    expect(hasPendingStartupTaskkill(2104)).toBe(false)
  })

  it('startup root disappearance does not erase tree failure', async () => {
    const { child } = mockWindowsQuery()
    const result = killProcessTreeForStartup(2104, 1000, startupBudget, {
      readIdentity: async () => 1000, alive: () => false,
    })
    await flush()
    child.emit('close', 1)
    expect(await result).toEqual({ helperTerminated: true, rootGone: true, treeKillSucceeded: false })
  })

  it('startup rechecks PID identity before force fallback', async () => {
    const { child } = mockWindowsQuery()
    const signal = mock(() => {})
    let queries = 0
    const result = killProcessTreeForStartup(2104, 1000, startupBudget, {
      readIdentity: async () => ++queries === 1 ? 1000 : 2000, alive: () => true, signal,
    })
    await flush()
    child.emit('close', 1)
    expect((await result).treeKillSucceeded).toBe(false)
    expect(queries).toBe(2)
    expect(signal).not.toHaveBeenCalled()
  })

  it('startup tracks awaited fallback after helper close until every destructive continuation drains', async () => {
    const { child, spawn } = mockWindowsQuery()
    let resolveIdentity!: (value: number) => void
    let queries = 0
    const signal = mock(() => {})
    const deps = {
      readIdentity: async () => ++queries === 1 ? 1000 : new Promise<number>(resolve => { resolveIdentity = resolve }),
      alive: () => true, signal,
    }
    const result = killProcessTreeForStartup(2104, 1000, startupBudget, deps)
    await flush()
    child.emit('close', 1)
    await flush()
    expect(queries).toBe(2)
    expect(hasPendingStartupTaskkill(2104)).toBe(true)
    let drained = false
    const drain = drainStartupTaskkills().then(() => { drained = true })
    expect((await killProcessTreeForStartup(2104, 1000, startupBudget, deps)).helperTerminated).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(drained).toBe(false)
    resolveIdentity(1000)
    await result
    await drain
    expect(signal).toHaveBeenCalledTimes(1)
    expect(hasPendingStartupTaskkill(2104)).toBe(false)
  })

  it('startup drain also observes operations started while its original snapshot is pending', async () => {
    const { spawn } = mockWindowsQuery()
    let resolveFirst!: (value: number) => void
    let resolveSecond!: (value: number) => void
    const first = killProcessTreeForStartup(2104, 1000, startupBudget, {
      readIdentity: () => new Promise<number>(resolve => { resolveFirst = resolve }), alive: () => true,
    })
    let drained = false
    const drain = drainStartupTaskkills().then(() => { drained = true })
    const second = killProcessTreeForStartup(2105, 1000, startupBudget, {
      readIdentity: () => new Promise<number>(resolve => { resolveSecond = resolve }), alive: () => true,
    })
    resolveFirst(2000)
    await first
    await flush()
    expect(drained).toBe(false)
    expect(hasPendingStartupTaskkill(2105)).toBe(true)
    resolveSecond(2000)
    await second
    await drain
    expect(drained).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('startup reserves a PID before its first awaited identity so concurrent retry cannot double-dispatch', async () => {
    const { spawn } = mockWindowsQuery()
    let resolveIdentity!: (value: number) => void
    const result = killProcessTreeForStartup(2104, 1000, startupBudget, {
      readIdentity: () => new Promise<number>(resolve => { resolveIdentity = resolve }), alive: () => true,
    })
    const retry = await killProcessTreeForStartup(2104, 1000, startupBudget, {
      readIdentity: async () => 1000, alive: () => true,
    })
    expect(retry.helperTerminated).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    resolveIdentity(2000)
    expect((await result).helperTerminated).toBe(true)
    expect(hasPendingStartupTaskkill(2104)).toBe(false)
  })

  it('startup never dispatches when the termination reserve is exhausted between clock reads', async () => {
    const { spawn } = mockWindowsQuery()
    await expect(killProcessTreeForStartup(2104, 1000, {
      assertAvailable: () => {}, cap: ms => ms === 3500 ? 999 : ms,
    }, { readIdentity: async () => 1000, alive: () => true })).rejects.toThrow('reserve exhausted')
    expect(spawn).not.toHaveBeenCalled()
    expect(hasPendingStartupTaskkill(2104)).toBe(false)
  })

  it('startup exhausted after awaited probes cannot taskkill or force fallback', async () => {
    for (const exhaustAt of [1, 2]) {
      const { child, spawn } = mockWindowsQuery()
      let exhausted = false
      let queries = 0
      const signal = mock(() => {})
      const budget = { cap: (ms: number) => ms, assertAvailable: () => {
        if (exhausted) throw new Error('exhausted')
      } }
      const result = killProcessTreeForStartup(2104, 1000, budget, {
        readIdentity: async () => { exhausted = ++queries === exhaustAt; return 1000 },
        alive: () => true, signal,
      })
      if (exhaustAt === 1) {
        await expect(result).rejects.toThrow('exhausted')
        expect(spawn).not.toHaveBeenCalled()
      } else {
        await flush()
        child.emit('close', 1)
        expect((await result).helperTerminated).toBe(true)
      }
      expect(signal).not.toHaveBeenCalled()
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
