import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  superviseTrustedBuilds,
  type TrustedBuild,
  type TrustedBuildSupervisorOptions,
} from './process-group-supervisor.js'

const cwd = import.meta.dir

function build(name: string, source: string): TrustedBuild {
  return { name, cwd, cmd: ['/usr/bin/python3', '-c', source] }
}

const fastCleanup: Pick<TrustedBuildSupervisorOptions,
  'termGraceMs' | 'killGraceMs' | 'pollMs'> = {
    termGraceMs: 100,
    killGraceMs: 1_000,
    pollMs: 10,
  }

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

function processGroupIsGone(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0)
    return false
  } catch {
    return true
  }
}

describe('trusted build process-group supervisor', () => {
  test('a second spawn exception cleans the first child', async () => {
    let firstPid = 0
    let calls = 0
    const spawn = (spec: TrustedBuild) => {
      calls += 1
      if (calls === 2) throw new Error('injected second spawn failure')
      const child = Bun.spawn({
        cmd: spec.cmd, cwd: spec.cwd, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
        detached: true,
      })
      firstPid = child.pid
      return child
    }
    await expect(superviseTrustedBuilds([
      build('first', 'import time; time.sleep(30)'),
      build('second', 'pass'),
    ], { deadlineMs: 2_000, ...fastCleanup, spawn })).rejects.toThrow(
      'injected second spawn failure',
    )
    expect(calls).toBe(2)
    expect(pidIsGone(firstPid)).toBe(true)
    expect(processGroupIsGone(firstPid)).toBe(true)
  }, 5_000)

  test('ordinary concurrent success has a clean teardown', async () => {
    const results = await superviseTrustedBuilds([
      build('one', 'import time; time.sleep(0.05)'),
      build('two', 'import time; time.sleep(0.05)'),
    ], { deadlineMs: 2_000, ...fastCleanup })
    expect(results.map(result => result.status)).toEqual([0, 0])
    expect(results.every(result => pidIsGone(result.pid))).toBe(true)
    expect(results.every(result => processGroupIsGone(result.pid))).toBe(true)
  }, 5_000)

  test('accepts legitimate processes which exit before /proc identity capture', async () => {
    const child = Bun.spawn({
      cmd: ['/usr/bin/python3', '-c', 'pass'], cwd,
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true,
    })
    expect(await child.exited).toBe(0)
    let signaled = false
    const results = await superviseTrustedBuilds([
      build('already-exited', 'pass'),
    ], {
      deadlineMs: 2_000,
      ...fastCleanup,
      spawn: () => ({
        pid: child.pid,
        exited: child.exited,
        stdout: null,
        kill: signal => {
          signaled = true
          return child.kill(signal)
        },
      }),
    })
    expect(results).toHaveLength(1)
    expect(results.map(result => result.status)).toEqual([0])
    expect(results.every(result => pidIsGone(result.pid))).toBe(true)
    expect(results.every(result => processGroupIsGone(result.pid))).toBe(true)
    expect(signaled).toBe(false)
  }, 5_000)

  test('a sibling nonzero exit cleans the still-running child', async () => {
    let message = ''
    try {
      await superviseTrustedBuilds([
        build('failure', 'import sys; sys.exit(7)'),
        build('sibling', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)'),
      ], { deadlineMs: 2_000, ...fastCleanup })
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('failure exited 7')
    const evidence = JSON.parse(message.slice(message.indexOf('{')))
    expect(evidence.cleanup.gone).toBe(true)
    expect(evidence.cleanup.finalStableLeaders).toEqual([false, false])
    expect(evidence.cleanup.finalGroupsAlive).toEqual([false, false])
  }, 5_000)

  test('a child deadline cleans every timed-out build', async () => {
    let message = ''
    try {
      await superviseTrustedBuilds([
        build('slow-one', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)'),
        build('slow-two', 'import time; time.sleep(30)'),
      ], { deadlineMs: 100, ...fastCleanup })
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('child deadline/output drain exceeded')
    const evidence = JSON.parse(message.slice(message.indexOf('{')))
    expect(evidence.cleanup.gone).toBe(true)
    expect(evidence.cleanup.finalStableLeaders).toEqual([false, false])
    expect(evidence.cleanup.finalGroupsAlive).toEqual([false, false])
  }, 5_000)

  test('TERM leader exit escalates against its live same-PGID descendant', async () => {
    const root = await mkdtemp(join(cwd, '.trusted-build-supervisor-'))
    const pidPath = join(root, 'descendant.pid')
    const startedAt = Date.now()
    try {
      let message = ''
      try {
        await superviseTrustedBuilds([
          build('leader-exit', [
            'import os,signal,time',
            `pid_path=${JSON.stringify(pidPath)}`,
            'descendant=os.fork()',
            'if descendant == 0:',
            ' signal.signal(signal.SIGTERM, signal.SIG_IGN)',
            ' with open(pid_path, "w") as stream: stream.write(f"{os.getpid()} {os.getpgrp()}")',
            ' time.sleep(30)',
            'else:',
            ' signal.signal(signal.SIGTERM, lambda *_: os._exit(0))',
            ' time.sleep(30)',
          ].join('\n')),
        ], { deadlineMs: 250, ...fastCleanup })
      } catch (error) {
        message = String(error)
      }
      const [descendantPid, processGroup] = (await readFile(pidPath, 'utf8'))
        .split(' ').map(Number)
      expect(message).toContain('child deadline/output drain exceeded')
      expect(descendantPid).toBeGreaterThan(0)
      expect(processGroup).toBeGreaterThan(0)
      expect(pidIsGone(descendantPid)).toBe(true)
      expect(processGroupIsGone(processGroup!)).toBe(true)
      expect(Date.now() - startedAt).toBeLessThan(3_000)
      const evidence = JSON.parse(message.slice(message.indexOf('{')))
      expect(evidence.cleanup.goneAfterTerm).toBe(false)
      expect(evidence.cleanup.gone).toBe(true)
      expect(evidence.cleanup.finalStableLeaders).toEqual([false])
      expect(evidence.cleanup.finalGroupsAlive).toEqual([false])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 5_000)
})
