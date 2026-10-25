import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { planPlainExecution, processGroupEmpty } from './OpenCodeV2PlainExecution.js'

const bunPath = await realpath(process.execPath)
const bun = { path: bunPath, sha256: createHash('sha256').update(await readFile(bunPath)).digest('hex') }
const entry = path.join(import.meta.dir, 'fixtures', 'plainExecutionChild.ts')

test('a plan refuses loader and shell startup variables', async () => {
  for (const key of ['NODE_OPTIONS', 'BUN_INSTALL', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ZDOTDIR']) {
    await expect(planPlainExecution({ bun, entry, cwd: import.meta.dir, env: { [key]: 'TEST' } }))
      .rejects.toThrow('execution_environment_injection')
  }
  await expect(planPlainExecution({ bun: { ...bun, sha256: '0'.repeat(64) }, entry, cwd: import.meta.dir, env: {} }))
    .rejects.toThrow('execution_identity_mismatch')
})

const driver = (mode: string) => {
  const run = spawnSync(process.execPath, [path.join(import.meta.dir, 'fixtures', 'plainExecutionDriver.ts'), mode], { encoding: 'utf8', timeout: 40_000 })
  expect(run.status).toBe(0)
  return JSON.parse(run.stdout.trim().split('\n').at(-1)!)
}

test('retirement kills the command the child started and claims only what it checked', () => {
  const result = driver('normal')
  expect(result.hostPID).toBe(result.childPid)
  expect(result.before).toBe(true)
  // The child never acknowledged a close. POSIX proves the scope by an empty process group;
  // Windows kills the recorded tree and stays best-effort.
  expect(result.receipt).toMatchObject({ pid: result.childPid, scopeClosed: true, acknowledged: false,
    descendants: process.platform === 'win32' ? 'best-effort' : 'process-group' })
  expect(result.after).toBe(false)
}, 60_000)

test('a broken handshake grants no mapping and the child is still retired', () => {
  for (const [mode, error] of [['foreign-nonce', 'execution_prepare_timeout'], ['silent', 'execution_prepare_timeout'],
    ['wrong-pid', 'execution_identity_mismatch']] as const) {
    const result = driver(mode)
    expect(result.error).toBe(error)
    expect(result.childAlive).toBe(false)
    expect(result.receipt.scopeClosed).toBe(true)
  }
}, 120_000)

test.skipIf(process.platform === 'win32')('an occupied process group is never reported empty', async () => {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  const exited = new Promise(resolve => sleeper.once('exit', resolve))
  try {
    expect(await processGroupEmpty(sleeper.pid!, Date.now() + 100)).toBe(false)
  } finally { process.kill(-sleeper.pid!, 'SIGKILL') }
  await exited
  expect(await processGroupEmpty(sleeper.pid!, Date.now() + 2000)).toBe(true)
})
