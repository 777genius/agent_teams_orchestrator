import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { expect, test } from 'bun:test'
import { cleanupGroup, ownedGroupMembers } from './group-cleanup.mjs'
import { scopeMarkedPids, sweepScope } from './scope-sweep.mjs'

async function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)))
  })
}

test('EPERM requires observed disappearance, never an assumed successful kill', async () => {
  for (const disappears of [true, false]) {
    let clock = 0
    const result = await cleanupGroup({
      now: () => clock, delay: async (ms: number) => { clock += ms },
      members: () => disappears && clock >= 1000 ? [] : [{ pid: 123 }],
      signalGroup: () => { throw Object.assign(new Error('fixture'), { code: 'EPERM' }) },
    })
    expect(result.remaining.length).toBe(disappears ? 0 : 1)
    expect(result.signalErrors).toHaveLength(2)
  }
})

test('rejects reused root or detached group identities before selecting signal targets', () => {
  const record = { pid: 123, born: 'original' }
  expect(() => ownedGroupMembers([
    { pid: 123, pgid: 123, born: 'replacement' },
    { pid: 124, pgid: 123, born: 'child' },
  ], record)).toThrow('identity changed')
  expect(ownedGroupMembers([{ pid: 124, pgid: 123, born: 'child' }], record)).toHaveLength(1)
  expect(ownedGroupMembers([{ pid: 123, pgid: 123, born: 'original' }], record, true)).toEqual([])
})

test('scope sweep matches only the request marker and never leaks descendant environments', () => {
  const scopeId = 'a'.repeat(32)
  const snapshot = [
    `  100 /bin/sh -c work CURSOR_OWNER_SCOPE=${scopeId} AWS_SECRET=leak`,
    `  101 /usr/bin/python3 daemon.py CURSOR_OWNER_SCOPE=${'b'.repeat(32)}`,
    '  102 /usr/bin/python3 daemon.py CURSOR_OWNER_SCOPE=',
    `  103 /bin/sleep 9 CURSOR_OWNER_SCOPE=${scopeId}`,
    `  103 /bin/sleep 9 CURSOR_OWNER_SCOPE=${scopeId}`,
    `    1 /sbin/launchd CURSOR_OWNER_SCOPE=${scopeId}`,
    `  777 /bin/ps -Eww CURSOR_OWNER_SCOPE=${scopeId}`,
    '',
  ].join('\n')
  expect(scopeMarkedPids({ scopeId, snapshot, self: 777 })).toEqual([100, 103])
  expect(scopeMarkedPids({ scopeId, snapshot, self: 777, exclude: [100] })).toEqual([103])
  expect(() => scopeMarkedPids({ scopeId: 'short', snapshot })).toThrow('request-unique marker')
})

test('scope sweep escalates for survivors and reports what it could not stop', async () => {
  for (const stubborn of [false, true]) {
    let clock = 0
    const signals: Array<[number, string]> = []
    const result = await sweepScope({
      now: () => clock, delay: async (ms: number) => { clock += ms },
      members: () => stubborn || clock < 900 ? [42] : [],
      signalPid: (pid: number, kind: string) => { signals.push([pid, kind]) },
    })
    expect(result.escalated).toBe(true)
    expect(signals).toEqual([[42, 'SIGTERM'], [42, 'SIGKILL']])
    expect(result.terminated).toEqual([42])
    expect(result.remaining).toEqual(stubborn ? [42] : [])
  }
})

test('scope sweep stays inert when no marked descendant survived', async () => {
  const result = await sweepScope({
    members: () => [], signalPid: () => { throw new Error('must not signal') },
  })
  expect(result).toEqual({ escalated: false, terminated: [], remaining: [], signalErrors: [] })
})

test.skipIf(process.platform !== 'darwin')('pre-exec ownership contains detached commands and preserves process contracts', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cursor owner test-'))
  try {
    await Promise.all(['supervisor.mjs', 'preload.cjs', 'group-cleanup.mjs', 'scope-sweep.mjs'].map(name =>
      copyFile(path.join(import.meta.dir, name), path.join(temp, name))))
    await Promise.all(['fake.mjs', 'proof.mjs'].map(name =>
      copyFile(path.join(import.meta.dir, 'fixtures', name), path.join(temp, name))))
    await run('/usr/bin/clang', ['-O2', '-Wall', '-Wextra', '-Werror', path.join(import.meta.dir, 'gate.c'), '-o', path.join(temp, 'gate')])
    await run('node', [path.join(temp, 'proof.mjs')])
    const report = JSON.parse(await readFile(path.join(temp, 'report.json'), 'utf8'))
    expect(report.passed).toBe(true)
    expect(Object.keys(report.scenarios)).toEqual(['a', 'b', 'normal-orphan', 'pending', 'nested', 'parent-death', 'streaming'])
    expect(report.nestedDetachContained).toBe(true)
    expect(report.ownerCrashNoLateEffects).toBe(true)
    expect(report.failedReportStillCleans).toBe(true)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}, 40000)
