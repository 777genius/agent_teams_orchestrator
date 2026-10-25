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

test.skipIf(process.platform === 'win32')('retirement claims a closed scope only after the process group is empty', () => {
  const run = spawnSync(process.execPath, [path.join(import.meta.dir, 'fixtures', 'plainExecutionDriver.ts')], { encoding: 'utf8', timeout: 30_000 })
  expect(run.status).toBe(0)
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!)
  expect(result.hostPID).toBe(result.childPid)
  expect(result.before).toBe(true)
  // The child never acknowledged a close, so only the checked group proves the scope closed.
  expect(result.receipt).toMatchObject({ pid: result.childPid, scopeClosed: true, descendants: 'process-group', acknowledged: false })
  expect(result.after).toBe(false)
}, 40_000)

test.skipIf(process.platform === 'win32')('an occupied process group is never reported empty', async () => {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  const exited = new Promise(resolve => sleeper.once('exit', resolve))
  try {
    expect(await processGroupEmpty(sleeper.pid!, Date.now() + 100)).toBe(false)
  } finally { process.kill(-sleeper.pid!, 'SIGKILL') }
  await exited
  expect(await processGroupEmpty(sleeper.pid!, Date.now() + 2000)).toBe(true)
})
