import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path, { join } from 'node:path'
import { spawn } from 'node:child_process'

import {
  __setStableSignalPlatformForTests,
  buildExactProcessTreeSpawn,
  buildWindowsTaskkillInvocation,
  captureProcessTreeIdentity,
  getProcessTreeContainmentCapability,
  parseDarwinProcessStartTimeMicros,
  hasPendingStartupTaskkill,
  drainStartupTaskkills,
  killProcessTreeForStartup,
  isProcessAlive,
  killProcessTreeAndWait,
  parseDarwinProcessStartTime,
  parseLinuxProcessStartTicks,
  readProcessCommandLine,
  readProcessStartTimeMs,
  signalExpectedProcessStable,
  terminateExpectedProcessTreeStable,
  type DarwinProcessTreeMember,
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
  it('creates a detached exact process group on Unix', () => {
    const launch = buildExactProcessTreeSpawn('node', ['child.js'], { cwd: '/tmp' }, 'linux')
    expect(launch.command).toBe('node')
    expect(launch.args).toEqual(['child.js'])
    expect(launch.options.detached).toBe(true)
    expect(launch.osIdentity).toBe('unix-pgid:pending')
    expect(getProcessTreeContainmentCapability('unix-pgid:42', 'linux')).toBe('cooperative')
  })

  it('creates a unique Windows Job supervisor before launching the child tree', () => {
    const first = buildExactProcessTreeSpawn('node.exe', ['child.js'], {}, 'win32')
    const second = buildExactProcessTreeSpawn('node.exe', ['child.js'], {}, 'win32')
    expect(first.command).toBe('powershell.exe')
    expect(first.osIdentity).toStartWith('win32-job:agent-teams-')
    expect(first.osIdentity).not.toBe(second.osIdentity)
    expect(first.args.join(' ')).toContain('AssignProcessToJobObject')
    expect(first.args.join(' ')).toContain('BasicLimitInformation')
    expect(first.args.join(' ')).toContain('IoInfo')
    expect(first.args.join(' ')).toContain('PeakJobMemoryUsed')
    expect(first.args.join(' ')).toContain('0x2000')
    expect(first.args.join(' ')).toContain('Diagnostics.ProcessStartInfo')
    expect(first.args.join(' ')).not.toContain('& $p.command')
    expect(getProcessTreeContainmentCapability(first.osIdentity, 'win32')).toBe('exact')
  })

  it('preserves Windows native argv through ProcessStartInfo command-line quoting', () => {
    const args = [
      '',
      'plain',
      'two words',
      'require("node:fs")',
      'embedded"quote',
      'C:\\Program Files\\agent\\',
    ]
    const launch = buildExactProcessTreeSpawn('C:\\Program Files\\Bun\\bun.exe', args, {}, 'win32')
    const script = launch.args.at(-1)!
    const encodedPayload = script.match(/FromBase64String\('([^']+)'\)/)?.[1]
    expect(encodedPayload).toBeString()
    expect(JSON.parse(Buffer.from(encodedPayload!, 'base64').toString('utf8'))).toEqual({
      command: 'C:\\Program Files\\Bun\\bun.exe',
      arguments:
        '"" "plain" "two words" "require(\\"node:fs\\")" ' +
        '"embedded\\"quote" "C:\\Program Files\\agent\\\\"',
    })
  })

  it('passes the durable OS tree identity through the stable signal boundary', async () => {
    let observed: string | undefined
    await expect(killProcessTreeAndWait(42, 'SIGTERM', {
      expectedStartedAtMs: 100,
      expectedOsIdentity: 'win32-job:exact-a',
      dependencies: {
        isProcessAlive: () => true,
        readProcessStartTimeMs: async () => 100,
        signalExpectedProcess: async (_pid, _signal, _started, identity) => {
          observed = identity
          return true
        },
        nowMs: () => 1,
        sleep: async () => undefined,
      },
      timeoutMs: 0,
    })).resolves.toBe(false)
    expect(observed).toBe('win32-job:exact-a')
  })

  it('delegates cooperative cleanup policy but does not promote it to exact proof', async () => {
    const calls: unknown[][] = []
    await expect(killProcessTreeAndWait(42, 'SIGTERM', {
      expectedStartedAtMs: 100,
      expectedOsIdentity: 'unix-pgid:42',
      timeoutMs: 250,
      pollMs: 10,
      taskkillTimeoutMs: 500,
      dependencies: {
        platform: 'linux',
        isProcessAlive: () => true,
        readProcessStartTimeMs: async () => 100,
        terminateExpectedProcessTree: async (...args) => {
          calls.push(args)
          return true
        },
        nowMs: () => 10,
        sleep: async () => undefined,
      },
    })).resolves.toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(0, 4)).toEqual([42, 'SIGTERM', 100, 'unix-pgid:42'])
    expect(calls[0]?.[4]).toMatchObject({
      timeoutMs: 250,
      pollMs: 10,
      escalationTimeoutMs: 500,
      platform: 'linux',
    })
  })

  it('does not accept root disappearance as whole-tree proof from the boundary', async () => {
    let calls = 0
    await expect(killProcessTreeAndWait(42, 'SIGTERM', {
      expectedStartedAtMs: 100,
      expectedOsIdentity: 'unix-pgid:42',
      dependencies: {
        platform: 'linux',
        isProcessAlive: () => calls === 0,
        readProcessStartTimeMs: async () => 100,
        terminateExpectedProcessTree: async () => {
          calls += 1
          // Simulated child remains inside the native ownership boundary.
          return false
        },
      },
    })).resolves.toBe(false)
    expect(calls).toBe(1)
  })

  it('fails closed when the stable Linux boundary is not the exact root group', async () => {
    await expect(terminateExpectedProcessTreeStable(
      42,
      'SIGTERM',
      100,
      'unix-pgid:41',
      {
        timeoutMs: 0,
        pollMs: 1,
        escalationTimeoutMs: 0,
        nowMs: () => 0,
        sleep: async () => undefined,
        platform: 'linux',
      },
    )).resolves.toBe(false)
  })

  it('never confirms a Unix PGID as a whole tree after a descendant creates a detached session', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(os.tmpdir(), 'process-kill-setsid-'))
    const escapedPidFile = join(root, 'escaped.pid')
    const escapedCode = 'require("node:fs").writeFileSync(process.env.ESCAPED_PID_FILE,String(process.pid));setInterval(()=>{},1000)'
    const leaderCode = 'const c=require("node:child_process").spawn(process.execPath,["-e",process.env.ESCAPED_CODE],{detached:true,stdio:"ignore",env:process.env});c.unref();setInterval(()=>{},1000)'
    const leader = spawn(process.execPath, ['-e', leaderCode], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ESCAPED_CODE: escapedCode, ESCAPED_PID_FILE: escapedPidFile },
    })
    const leaderPid = leader.pid
    let escapedPid: number | null = null
    try {
      expect(leaderPid).toBeNumber()
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && escapedPid === null) {
        escapedPid = await readFile(escapedPidFile, 'utf8')
          .then(value => Number(value.trim()))
          .catch(() => null)
        if (escapedPid === null) await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(escapedPid).toBeNumber()
      const startedAt = await readProcessStartTimeMs(leaderPid!)
      expect(startedAt).toBeNumber()
      const osIdentity = await captureProcessTreeIdentity(leaderPid!)
      expect(osIdentity).toBeString()
      await expect(killProcessTreeAndWait(leaderPid!, 'SIGTERM', {
        expectedStartedAtMs: startedAt,
        expectedOsIdentity: osIdentity,
        timeoutMs: 500,
        taskkillTimeoutMs: 500,
      })).resolves.toBe(false)
      expect(isProcessAlive(escapedPid!)).toBe(true)
    } finally {
      if (escapedPid) {
        try { process.kill(escapedPid, 'SIGKILL') } catch {}
      }
      if (leaderPid) {
        try { process.kill(-leaderPid, 'SIGKILL') } catch {}
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleans a cooperative Darwin group but never treats PGID exhaustion as whole-tree proof', async () => {
    let now = 0
    const signals: Array<[number, NodeJS.Signals]> = []
    const identities = new Map([
      [42, 'darwin-audit:root'],
      [43, 'darwin-audit:child'],
    ])
    const lists = [[42, 43], [42, 43], [43], [43], [43], [43], []]
    await expect(terminateExpectedProcessTreeStable(
      42,
      'SIGTERM',
      100,
      'darwin-audit:root',
      {
        timeoutMs: 2,
        pollMs: 1,
        escalationTimeoutMs: 2,
        nowMs: () => now,
        sleep: async () => { now += 1 },
        platform: 'darwin',
        darwinBoundary: {
          listMembers: async () => lists.shift() ?? [],
          acquireMember: async pid => {
            const auditIdentity = identities.get(pid)
            return auditIdentity ? { pid, auditIdentity } satisfies DarwinProcessTreeMember : null
          },
          signalMember: async (member, signal) => {
            signals.push([member.pid, signal])
            return true
          },
        },
      },
    )).resolves.toBe(false)
    expect(signals).toContainEqual([43, 'SIGTERM'])
    expect(signals).toContainEqual([43, 'SIGKILL'])
    expect(signals).toContainEqual([42, 'SIGKILL'])
    expect(getProcessTreeContainmentCapability('darwin-audit:root', 'darwin')).toBe('cooperative')
  })

  it('fails closed when a discovered Darwin member cannot be audit-token acquired', async () => {
    await expect(terminateExpectedProcessTreeStable(
      42,
      'SIGTERM',
      100,
      'darwin-audit:root',
      {
        timeoutMs: 0,
        pollMs: 1,
        escalationTimeoutMs: 0,
        nowMs: () => 0,
        sleep: async () => undefined,
        platform: 'darwin',
        darwinBoundary: {
          listMembers: async () => [42, 43],
          acquireMember: async pid => pid === 42 ? { pid, auditIdentity: 'darwin-audit:root' } : null,
          signalMember: async () => true,
        },
      },
    )).resolves.toBe(false)
  })

  it('fails closed when Darwin group enumeration cannot classify a member', async () => {
    await expect(terminateExpectedProcessTreeStable(
      42,
      'SIGTERM',
      100,
      'darwin-audit:root',
      {
        timeoutMs: 0,
        pollMs: 1,
        escalationTimeoutMs: 0,
        nowMs: () => 0,
        sleep: async () => undefined,
        platform: 'darwin',
        darwinBoundary: {
          listMembers: async () => null,
          acquireMember: async pid => ({ pid, auditIdentity: 'darwin-audit:root' }),
          signalMember: async () => true,
        },
      },
    )).resolves.toBe(false)
  })
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
    // A cold PowerShell query can exceed the production budget on Windows CI.
    const queryTimeoutMs = process.platform === 'win32' ? 20_000 : undefined
    const startedAtMs = await readProcessStartTimeMs(process.pid, process.platform, queryTimeoutMs)
    expect(startedAtMs).not.toBeNull()
    const signalExpectedProcess = mock(async () => true)
    await expect(killProcessTreeAndWait(process.pid, 'SIGTERM', {
      expectedStartedAtMs: startedAtMs! + 1,
      dependencies: {
        readProcessStartTimeMs: pid => readProcessStartTimeMs(pid, process.platform, queryTimeoutMs),
        signalExpectedProcess,
      },
    })).resolves.toBe(false)
    expect(signalExpectedProcess).not.toHaveBeenCalled()
    expect(isProcessAlive(process.pid)).toBe(true)
  }, process.platform === 'win32' ? 45_000 : 5_000)

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

  it('retains the 2.5 second budget for command-line queries', async () => {
    for (const query of [
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
      () => readProcessStartTimeMs(2104, 'win32', 6_000),
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

  it('parses Darwin kernel start time with microsecond precision', () => {
    const first = Buffer.alloc(136)
    first.writeBigUInt64LE(1_700_000_000n, 120)
    first.writeBigUInt64LE(123_456n, 128)
    const second = Buffer.from(first)
    second.writeBigUInt64LE(123_457n, 128)

    expect(parseDarwinProcessStartTimeMicros(first)).toBe(1_700_000_000_123_456)
    expect(parseDarwinProcessStartTimeMicros(second)).toBe(1_700_000_000_123_457)
  })

  it('reads a verifiable Darwin identity for the current process', async () => {
    if (process.platform !== 'darwin') return
    const first = await readProcessStartTimeMs(process.pid, 'darwin')
    const second = await readProcessStartTimeMs(process.pid, 'darwin')
    expect(first).not.toBeNull()
    expect(second).toBe(first)
  })

  it('refuses a legacy pid-only kill without sending a signal', async () => {
    const signals: string[] = []
    await expect(
      killProcessTreeAndWait(42, 'SIGTERM', {
        dependencies: {
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => 100,
          signalExpectedProcess: async (_pid, signal) => {
            signals.push(signal)
            return true
          },
        },
      }),
    ).resolves.toBe(false)
    expect(signals).toEqual([])
  })

  it('refuses a reused pid before signaling on Unix', async () => {
    const signals: string[] = []
    await expect(
      killProcessTreeAndWait(42, 'SIGTERM', {
        expectedStartedAtMs: 100,
        dependencies: {
          platform: 'linux',
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => 200,
          signalExpectedProcess: async (_pid, signal) => {
            signals.push(signal)
            return true
          },
        },
      }),
    ).resolves.toBe(false)
    expect(signals).toEqual([])
  })

  it('fails closed on Windows without an OS-stable process handle', async () => {
    await expect(
      killProcessTreeAndWait(42, 'SIGTERM', {
        expectedStartedAtMs: 100,
        dependencies: {
          platform: 'win32',
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => 200,
        },
      }),
    ).resolves.toBe(false)
  })

  it('routes Darwin and Windows termination through an incarnation-bound signal implementation', async () => {
    const calls: Array<[NodeJS.Platform, number, NodeJS.Signals, number]> = []
    try {
      for (const platform of ['darwin', 'win32'] as const) {
        __setStableSignalPlatformForTests(platform, async (pid, signal, startedAtMs) => {
          calls.push([platform, pid, signal, startedAtMs])
          return true
        })
        await expect(signalExpectedProcessStable(42, 'SIGTERM', 100)).resolves.toBe(true)
      }
    } finally {
      __setStableSignalPlatformForTests(null)
    }
    expect(calls).toEqual([
      ['darwin', 42, 'SIGTERM', 100],
      ['win32', 42, 'SIGTERM', 100],
    ])
  })

  it('checks the caller full-identity verifier immediately before signaling', async () => {
    const signals: string[] = []
    await expect(
      killProcessTreeAndWait(42, 'SIGTERM', {
        expectedStartedAtMs: 100,
        verifyExpectedIdentity: async () => false,
        dependencies: {
          platform: 'linux',
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => 100,
          signalExpectedProcess: async (_pid, signal) => {
            signals.push(signal)
            return true
          },
        },
      }),
    ).resolves.toBe(false)
    expect(signals).toEqual([])
  })

  it('signals a confirmed cooperative identity but does not treat root replacement as whole-tree proof', async () => {
    const startTimes = [100, 200]
    const signals: Array<[number, NodeJS.Signals]> = []
    await expect(
      killProcessTreeAndWait(42, 'SIGTERM', {
        expectedStartedAtMs: 100,
        timeoutMs: 10,
        dependencies: {
          platform: 'linux',
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => startTimes.shift() ?? 200,
          signalExpectedProcess: async (pid, signal) => {
            signals.push([pid, signal])
            return true
          },
          nowMs: () => 0,
          sleep: async () => undefined,
        },
      }),
    ).resolves.toBe(false)
    expect(signals).toEqual([[42, 'SIGTERM']])
  })

  it('makes repeated stops idempotent once the expected process is gone', async () => {
    let signals = 0
    const options = {
      expectedStartedAtMs: 100,
      dependencies: {
        platform: 'linux' as const,
        isProcessAlive: () => false,
        readProcessStartTimeMs: async () => null,
        signalExpectedProcess: async () => {
          signals += 1
          return true
        },
      },
    }
    await expect(killProcessTreeAndWait(42, 'SIGTERM', options)).resolves.toBe(false)
    await expect(killProcessTreeAndWait(42, 'SIGTERM', options)).resolves.toBe(false)
    expect(signals).toBe(0)
  })

  it('queries the exact Windows Job instead of accepting supervisor disappearance', async () => {
    let jobProofCalls = 0
    await expect(killProcessTreeAndWait(42, 'SIGTERM', {
      expectedStartedAtMs: 100,
      expectedOsIdentity: 'win32-job:exact-a',
      dependencies: {
        platform: 'win32',
        isProcessAlive: () => false,
        readProcessStartTimeMs: async () => null,
        terminateExpectedProcessTree: async (_pid, _signal, _started, identity) => {
          jobProofCalls += 1
          expect(identity).toBe('win32-job:exact-a')
          return true
        },
      },
    })).resolves.toBe(true)
    expect(jobProofCalls).toBe(1)
  })

  it('never signals by pid when the process swaps after validation', async () => {
    let stableHandleSignals = 0
    const startTimes = [100, 100]
    await expect(
      killProcessTreeAndWait(42, 'SIGTERM', {
        expectedStartedAtMs: 100,
        verifyExpectedIdentity: async () => true,
        dependencies: {
          platform: 'linux',
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => startTimes.shift() ?? 100,
        },
      }),
    ).resolves.toBe(false)
    expect(stableHandleSignals).toBe(0)
  })
})
