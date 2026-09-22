import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import {
  __setStableSignalPlatformForTests,
  buildExactProcessTreeSpawn,
  buildWindowsTaskkillInvocation,
  captureProcessTreeIdentity,
  confirmNaturalProcessTreeExit,
  DARWIN_SIGNAL_NUMBER,
  getProcessTreeContainmentCapability,
  isProcessAlive,
  killProcessTreeAndWait,
  parseDarwinProcessStartTimeMicros,
  readProcessCommandLine,
  readProcessStartTimeMs,
  signalExpectedProcessStable,
  terminateExpectedProcessTreeStable,
  type DarwinProcessTreeMember,
} from './processKill.js'

const originalSystemRoot = process.env.SystemRoot

function decodeWindowsSupervisorScript(launch: ReturnType<typeof buildExactProcessTreeSpawn>): string {
  const encodedIndex = launch.args.indexOf('-EncodedCommand')
  expect(encodedIndex).toBeGreaterThanOrEqual(0)
  const encoded = launch.args[encodedIndex + 1]
  expect(encoded).toBeString()
  return Buffer.from(encoded!, 'base64').toString('utf16le')
}

afterEach(() => {
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
    expect(first.args).toContain('-EncodedCommand')
    const script = decodeWindowsSupervisorScript(first)
    expect(script).toContain('AssignProcessToJobObject')
    expect(script).toContain('BasicLimitInformation')
    expect(script).toContain('IoInfo')
    expect(script).toContain('PeakJobMemoryUsed')
    expect(script).toContain('0x2000')
    expect(script).toContain('Diagnostics.ProcessStartInfo')
    expect(script).not.toContain('ArgumentList')
    expect(script).not.toContain('& $p.command')
    expect(script).not.toContain('%*')
    expect(getProcessTreeContainmentCapability(first.osIdentity, 'win32')).toBe('exact')
  })

  it('distinguishes completed Windows Job supervisor exit from unverifiable containment', async () => {
    const query = async (state: 'absent' | 'empty' | 'active' | 'unverifiable') =>
      confirmNaturalProcessTreeExit(42, 'win32-job:exact-a', 'win32', {
        isProcessAlive: () => false,
        queryWindowsJobAfterSupervisorExit: async () => state,
      })
    await expect(query('absent')).resolves.toBe(true)
    await expect(query('empty')).resolves.toBe(true)
    await expect(query('active')).resolves.toBe(false)
    await expect(query('unverifiable')).resolves.toBe(false)
    await expect(confirmNaturalProcessTreeExit(42, 'win32-job:exact-a', 'win32', {
      isProcessAlive: () => true,
      queryWindowsJobAfterSupervisorExit: async () => 'absent',
    })).resolves.toBe(false)
  })

  it('transports exact Windows argv through encoded PowerShell and .NET Framework Arguments', () => {
    const args = [
      '',
      'plain',
      'two words',
      'require("node:fs")',
      'embedded"quote',
      'C:\\Program Files\\agent\\',
      'unicode-こんにちは-😀',
      'ampersand&pipe|percent%bang!paren()',
    ]
    const launch = buildExactProcessTreeSpawn('C:\\Program Files\\Bun\\bun.exe', args, {}, 'win32')
    const script = decodeWindowsSupervisorScript(launch)
    const encodedPayload = script.match(/FromBase64String\('([^']+)'\)/)?.[1]
    expect(encodedPayload).toBeString()
    expect(JSON.parse(Buffer.from(encodedPayload!, 'base64').toString('utf8'))).toEqual({
      command: 'C:\\Program Files\\Bun\\bun.exe',
      arguments:
        '"" "plain" "two words" "require(\\"node:fs\\")" ' +
        '"embedded\\"quote" "C:\\Program Files\\agent\\\\" ' +
        '"unicode-こんにちは-😀" "ampersand&pipe|percent%bang!paren()"',
    })
    expect(script).toContain('$s.Arguments=[string]$p.arguments')
    expect(script).not.toContain('cmd.exe')
    expect(script).not.toContain('%*')
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

  it('stops before signaling when the live deadline expires during identity verification', async () => {
    let remaining = 50
    let signals = 0
    await expect(killProcessTreeAndWait(42, 'SIGTERM', {
      expectedStartedAtMs: 100,
      expectedOsIdentity: 'win32-job:exact-a',
      remainingMs: () => remaining,
      dependencies: {
        platform: 'win32',
        isProcessAlive: () => true,
        readProcessStartTimeMs: async () => {
          remaining = 0
          return 100
        },
        signalExpectedProcess: async () => {
          signals += 1
          return true
        },
      },
    })).resolves.toBe(false)
    expect(signals).toBe(0)
  })

  it('accepts an exact owned-tree receipt but rejects a reused PID before signaling', async () => {
    let treeCalls = 0
    await expect(killProcessTreeAndWait(42, 'SIGTERM', {
      expectedStartedAtMs: 100,
      expectedOsIdentity: 'win32-job:owned-tree',
      dependencies: {
        platform: 'win32',
        isProcessAlive: () => true,
        readProcessStartTimeMs: async () => 100,
        terminateExpectedProcessTree: async () => { treeCalls += 1; return true },
      },
    })).resolves.toBe(true)
    await expect(killProcessTreeAndWait(42, 'SIGTERM', {
      expectedStartedAtMs: 100,
      expectedOsIdentity: 'win32-job:owned-tree',
      dependencies: {
        platform: 'win32',
        isProcessAlive: () => true,
        readProcessStartTimeMs: async () => 101,
        terminateExpectedProcessTree: async () => { treeCalls += 1; return true },
      },
    })).resolves.toBe(false)
    expect(treeCalls).toBe(1)
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

  it('uses Darwin STOP/CONT constants and leaves an explicit stop frozen', async () => {
    expect(DARWIN_SIGNAL_NUMBER.SIGSTOP).toBe(17)
    expect(DARWIN_SIGNAL_NUMBER.SIGCONT).toBe(19)
    const signals: NodeJS.Signals[] = []
    await expect(terminateExpectedProcessTreeStable(
      42,
      'SIGSTOP',
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
          listMembers: async () => [],
          acquireMember: async pid => ({ pid, auditIdentity: 'darwin-audit:root' }),
          signalMember: async (_member, memberSignal) => {
            signals.push(memberSignal)
            return true
          },
        },
      },
    )).resolves.toBe(false)
    expect(signals).toEqual(['SIGSTOP'])
    expect(signals).not.toContain('SIGCONT')
  })

  it('contains every discovered Darwin member with one STOP and no follow-up signal', async () => {
    const signals: Array<[number, NodeJS.Signals]> = []
    await expect(terminateExpectedProcessTreeStable(
      42,
      'SIGSTOP',
      100,
      'darwin-audit:root',
      {
        timeoutMs: 1,
        pollMs: 1,
        escalationTimeoutMs: 1,
        nowMs: () => 0,
        sleep: async () => undefined,
        platform: 'darwin',
        darwinBoundary: {
          // A stable second pass proves discovery completed before STOP returns.
          listMembers: async () => [42, 43],
          acquireMember: async pid => ({ pid, auditIdentity: pid === 42 ? 'darwin-audit:root' : 'darwin-audit:child' }),
          signalMember: async (member, memberSignal) => {
            signals.push([member.pid, memberSignal])
            return true
          },
        },
      },
    )).resolves.toBe(false)
    expect(signals).toEqual([[42, 'SIGSTOP'], [43, 'SIGSTOP']])
  })

  it('does not escalate to KILL when cancellation occurs immediately after the graceful signal', async () => {
    let remaining = 10
    const signals: NodeJS.Signals[] = []
    await expect(terminateExpectedProcessTreeStable(
      42,
      'SIGTERM',
      100,
      'darwin-audit:root',
      {
        timeoutMs: 1,
        pollMs: 1,
        escalationTimeoutMs: 1,
        nowMs: () => 0,
        sleep: async () => undefined,
        remainingMs: () => remaining,
        platform: 'darwin',
        darwinBoundary: {
          listMembers: async () => [42],
          acquireMember: async pid => ({ pid, auditIdentity: 'darwin-audit:root' }),
          signalMember: async (_member, memberSignal) => {
            signals.push(memberSignal)
            if (memberSignal === 'SIGTERM') remaining = 0
            return true
          },
        },
      },
    )).resolves.toBe(false)
    // Cancellation revokes destructive authority but not exact-handle cleanup:
    // the launch-captured audit token can only resume the stopped incarnation.
    expect(signals).toEqual(['SIGSTOP', 'SIGTERM', 'SIGCONT'])
  })

  it('resumes every audit-bound temporary freeze after post-freeze discovery fails', async () => {
    const signals: Array<[number, NodeJS.Signals]> = []
    let scans = 0
    await expect(terminateExpectedProcessTreeStable(
      42,
      'SIGKILL',
      100,
      'darwin-audit:root',
      {
        timeoutMs: 1,
        pollMs: 1,
        escalationTimeoutMs: 1,
        nowMs: () => 0,
        sleep: async () => undefined,
        platform: 'darwin',
        darwinBoundary: {
          listMembers: async () => ++scans === 1 ? [42, 43] : null,
          acquireMember: async pid => ({ pid, auditIdentity: pid === 42 ? 'darwin-audit:root' : 'darwin-audit:child' }),
          signalMember: async (member, memberSignal) => {
            signals.push([member.pid, memberSignal])
            return true
          },
        },
      },
    )).resolves.toBe(false)
    expect([...new Set(signals.filter(([, signal]) => signal === 'SIGSTOP').map(([pid]) => pid))].sort()).toEqual([42, 43])
    expect([...new Set(signals.filter(([, signal]) => signal === 'SIGCONT').map(([pid]) => pid))].sort()).toEqual([42, 43])
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

  it('does not spawn an identity query for an invalid pid', async () => {
    await expect(readProcessStartTimeMs(0, 'win32')).resolves.toBeNull()
    await expect(readProcessCommandLine(-1, 'win32')).resolves.toBeNull()
  })

  it('rejects fractional and unsafe PIDs before they can be normalized into another query', async () => {
    // This would have read /proc/<current pid> after Math.trunc before the
    // validation moved ahead of normalization.
    await expect(readProcessStartTimeMs(process.pid + 0.9, 'linux')).resolves.toBeNull()
    await expect(readProcessStartTimeMs(42.9, 'linux')).resolves.toBeNull()
    for (const pid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(readProcessStartTimeMs(pid, 'linux')).resolves.toBeNull()
    }
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

  it('fails a pre-aborted per-agent Job before any native setup or destructive call', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled before Job acquisition'))
    await expect(terminateExpectedProcessTreeStable(
      42,
      'SIGKILL',
      100,
      'win32-agent-job:agent-only',
      {
        timeoutMs: 1_000,
        escalationTimeoutMs: 0,
        pollMs: 25,
        nowMs: Date.now,
        sleep: async () => undefined,
        platform: 'win32',
        signal: controller.signal,
        remainingMs: () => 1_000,
      },
    )).resolves.toBe(false)
  })
})
