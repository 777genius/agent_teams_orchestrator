import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'
import { readExecutionBirth, type ExecutionBirth } from './OpenCodeV2ExecutionBinding.js'
import { captureExecutionGroup } from './OpenCodeV2ExecutionContainment.js'
import { launchLinuxExecution, isKernelRetirement, linuxClosedAcknowledgment, type LinuxExecutionMapping } from './OpenCodeV2ExecutionLauncher.js'
import { isExecutionCleanupReceipt, retireExecutionChild } from './OpenCodeV2ExecutionLifecycle.js'

const syntheticBirth: ExecutionBirth = { format: 'linux-start-ticks', value: '42', bootId: 'TEST-boot-domain' }

// Source-authored Linux regression fixture, not a native/OpenCode execution test.
// The intermediate exits immediately after setsid + fork. The final child stays
// alive after leader exit and self-retires, so teardown needs no PID/group kills.
const escapedFixture = `
import json, os, sys, time
report_r, report_w = os.pipe()
started = time.monotonic()
intermediate = os.fork()
if intermediate == 0:
    os.close(report_r)
    os.setsid()
    escaped = os.fork()
    if escaped != 0:
        os._exit(0)
    os.write(report_w, str(os.getpid()).encode())
    os.close(report_w)
    time.sleep(4)
    os._exit(0)
os.close(report_w)
os.waitpid(intermediate, 0)
intermediate_ms = (time.monotonic() - started) * 1000
escaped_pid = int(os.read(report_r, 64))
os.close(report_r)
print(json.dumps({"type": "ready", "pid": os.getpid(), "escaped": escaped_pid, "intermediate": intermediate, "intermediateMs": intermediate_ms}), flush=True)
sys.stdin.readline()
os._exit(0)
`
const sentinelFixture = `
import json, os, sys
print(json.dumps({"type": "ready", "pid": os.getpid()}), flush=True)
sys.stdin.readline()
`

function fixture(script: string, root: string) {
  const child = spawn('/usr/bin/python3', ['-I', '-B', '-c', script], {
    detached: true, cwd: root, stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin',
      HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root,
      XDG_CACHE_HOME: root, XDG_STATE_HOME: root, TMPDIR: root, TMP: root, TEMP: root,
      APPDATA: root, LOCALAPPDATA: root },
  })
  child.stdin.on('error', () => undefined)
  const exit = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject) })
  const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject) })
  const ready = new Promise<Record<string, number>>((resolve, reject) => {
    child.once('error', reject)
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      try {
        const value: unknown = JSON.parse(line)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('fixture_invalid_ready')
        const row = value as Record<string, unknown>
        if (row.type === 'ready') {
          const numbers: Record<string, number> = {}
          for (const [key, item] of Object.entries(row)) {
            if (key === 'type') continue
            if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) throw new Error('fixture_invalid_ready')
            numbers[key] = item
          }
          resolve(numbers)
        }
      } catch (error) { reject(error) }
    })
    lines.once('close', () => reject(new Error('fixture_closed_before_ready')))
  })
  // Attach rejection observers immediately, including partial-start failure.
  void exit.catch(() => undefined); void closed.catch(() => undefined); void ready.catch(() => undefined)
  return { child, exit, closed, ready }
}

describe('execution containment qualification', () => {
  test('unqualified execution is rejected before a caller can start its child', () => {
    let started = false
    expect(() => {
      launchLinuxExecution({ launcher: '/TEST-foreign', launcherSha256: 'a'.repeat(64),
        args: [], cwd: '/', serialization: 'json' }, 'TEST-nonce', 'TEST-lease', { path: '/TEST-bun', sha256: 'b'.repeat(64) })
      started = true
    }).toThrow('execution_containment_unqualified')
    expect(started).toBe(false)
  })

  test('a structurally successful callback port cannot manufacture retirement evidence', async () => {
    const attempts: string[] = []
    await expect(retireExecutionChild({
      pid: 73, birth: syntheticBirth, exited: () => true, acknowledged: () => true,
      disposeTransport: async () => { attempts.push('transport') }, sendClose: () => { attempts.push('scope') },
      waitExit: Promise.resolve(), readBirth: async () => { attempts.push('leader'); return null },
      kill: () => { attempts.push('kill') }, retireOwnedDescendants: async () => { attempts.push('descendants') },
    })).rejects.toThrow('cleanup_unknown')
    expect(attempts).toEqual(['transport', 'leader', 'descendants'])
  })

  test('durable owner release cannot use a caller-forged cleanup receipt', () => {
    const forged = Object.freeze({ scopeClosed: true, processRetired: true, descendantsRetired: true,
      pid: 73, birth: syntheticBirth })
    expect(isKernelRetirement(forged)).toBe(false)
    expect(isExecutionCleanupReceipt(forged)).toBe(false)
    expect(isExecutionCleanupReceipt({ ...forged })).toBe(false)
    expect(isExecutionCleanupReceipt(null)).toBe(false)
  })

  test('namespace close ACK cannot switch lease, boot, executable or native PID', () => {
    const actual = { hostPID: 700, nativePID: 1, parentPID: 699, birth: syntheticBirth,
      namespace: 'pid:[900]', namespacePIDs: [700, 1], netNamespace: 'net:[901]', executablePath: '/TEST-bun', executableSha256: 'b'.repeat(64) }
    const mapping: LinuxExecutionMapping = { supervisor: { ...actual, hostPID: 699, nativePID: 699, namespacePIDs: [699] },
      init: actual, bun: actual, leaseOwnerId: 'TEST-lease', namespace: { name: actual.namespace, inode: '900', device: '4' } }
    const message = { type: 'closed', nonce: 'TEST-challenge', leaseOwnerId: 'TEST-lease', pid: 1,
      namespace: actual.namespace, executableSha256: actual.executableSha256, birth: syntheticBirth, scopeClosed: true }
    expect(linuxClosedAcknowledgment(message, 'TEST-challenge', mapping)).toBe(true)
    for (const changed of [{ ...message, nonce: 'foreign' }, { ...message, leaseOwnerId: 'foreign' },
      { ...message, pid: 700 }, { ...message, namespace: 'pid:[901]' }, { ...message, scopeClosed: false },
      { ...message, executableSha256: 'c'.repeat(64) }, { ...message, birth: { ...syntheticBirth, bootId: 'foreign' } }]) {
      expect(linuxClosedAcknowledgment(changed, 'TEST-challenge', mapping)).toBe(false)
    }
    expect(isKernelRetirement({ mapping, scopeClosed: true, pid: 700, birth: syntheticBirth })).toBe(false)
  })

  const linuxTest = process.platform === 'linux' && existsSync('/usr/bin/python3') ? test : test.skip
  linuxTest('compatibility capture requires the actual leader birth and boot domain', async () => {
    const birth = await readExecutionBirth(process.pid)
    if (!birth) throw new Error('TEST-controller-birth-missing')
    await expect(captureExecutionGroup(process.pid, { ...birth, bootId: 'TEST-foreign-boot' }))
      .rejects.toThrow('execution_containment_unavailable')
  })

  linuxTest('fast setsid double-fork survivor forces UNKNOWN and leaves unrelated sentinel intact', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-r237-containment-')))
    const leader = fixture(escapedFixture, root), sentinel = fixture(sentinelFixture, root)
    try {
      const [ready, sentinelReady] = await Promise.all([
        boundOpenCodeRead(leader.ready, 2500), boundOpenCodeRead(sentinel.ready, 2500),
      ])
      const capturedPID = (value: number | undefined): number => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('fixture_pid_missing')
        return value
      }
      const readyPID = capturedPID(ready.pid), escapedPID = capturedPID(ready.escaped)
      const intermediatePID = capturedPID(ready.intermediate), sentinelPID = capturedPID(sentinelReady.pid)
      expect(readyPID).toBeGreaterThan(0); expect(sentinelPID).toBeGreaterThan(0)
      // Verify the escaped child has already outlived its observed parent.
      // Scheduler latency is diagnostic, not a timing-based correctness gate.
      expect(await readExecutionBirth(intermediatePID)).toBeNull()
      expect(readyPID).toBe(capturedPID(leader.child.pid))
      expect(sentinelPID).toBe(capturedPID(sentinel.child.pid))
      const birth = await readExecutionBirth(readyPID), escapedBirth = await readExecutionBirth(escapedPID)
      const sentinelBirth = await readExecutionBirth(sentinelPID)
      expect(birth).not.toBeNull(); expect(escapedBirth).not.toBeNull(); expect(sentinelBirth).not.toBeNull()
      const stat = await readFile(`/proc/${escapedPID}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
      expect(Number(fields[2])).not.toBe(readyPID)
      expect(Number(fields[3])).not.toBe(readyPID)
      if (!birth || !escapedBirth || !sentinelBirth) throw new Error('fixture_birth_missing')
      const containment = await captureExecutionGroup(readyPID, birth)
      let acknowledged = false
      await expect(retireExecutionChild({
        pid: readyPID, birth, exited: () => leader.child.exitCode !== null,
        // Simulates an authenticated Scope-close ACK; it cannot prove OS cleanup.
        acknowledged: () => acknowledged, disposeTransport: async () => undefined,
        sendClose: () => { acknowledged = true; leader.child.stdin.end('close\n') }, waitExit: leader.exit,
        readBirth: () => readExecutionBirth(readyPID),
        kill: () => { throw new Error('unexpected_leader_signal') }, retireOwnedDescendants: () => containment.retire(),
      })).rejects.toThrow('cleanup_unknown')
      expect(acknowledged).toBe(true)
      expect(await readExecutionBirth(readyPID)).toBeNull()
      expect(await readExecutionBirth(escapedPID)).toEqual(escapedBirth)
      expect(await readExecutionBirth(sentinelPID)).toEqual(sentinelBirth)
      expect(sentinel.child.exitCode).toBeNull()
    } finally {
      if (!leader.child.stdin.writableEnded) leader.child.stdin.end('close\n')
      if (!sentinel.child.stdin.writableEnded) sentinel.child.stdin.end('close\n')
      // Escaped fixture owns a bounded lifetime; the sentinel receives its own
      // close pipe. No scan/name/port/group/PID signalling is used in teardown.
      await Promise.all([boundOpenCodeRead(leader.closed, 6000), boundOpenCodeRead(sentinel.closed, 2500)])
      await rm(root, { recursive: true, force: true })
    }
  }, 12_000)
  linuxTest('callable fd3 IPC boundary retires early escaped offspring and preserves outer sentinel', async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-r247-kernel-parent-')))
    const job = path.join(parent, 'TEST-owned-qualification')
    const child = spawn(process.execPath, [new URL('./fixtures/linuxKernelQualification.ts', import.meta.url).pathname, job],
      { cwd: parent, env: { TMPDIR: parent }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString() })
    child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString() })
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
      const receipt = JSON.parse(await readFile(path.join(job, 'receipt.json'), 'utf8')) as Record<string, unknown>
      expect({ code, stdout, stderr, status: receipt.status }).toMatchObject({ code: 0, status: 'PASS' })
      expect(receipt.cleanupUnknown).toBe(false)
      if (!Array.isArray(receipt.observations)) throw new Error('fixture_observations_missing')
      expect(receipt.observations.some((value: unknown) => value !== null && typeof value === 'object' &&
        'survivedWorkloadProcessGroupCleanup' in value && value.survivedWorkloadProcessGroupCleanup === true)).toBe(true)
    } finally { await rm(parent, { recursive: true, force: true }) }
  }, 30_000)

})
