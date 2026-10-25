// TEST driver for OpenCodeV2PlainExecution, run as an ordinary Bun process: bun test parses
// dates in UTC without exporting TZ, which would skew darwin `ps lstart` identities.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { launchPlainExecution, planPlainExecution } from '../OpenCodeV2PlainExecution.js'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const bunPath = await realpath(process.execPath)
const bun = { path: bunPath, sha256: createHash('sha256').update(await readFile(bunPath)).digest('hex') }
const entry = path.join(import.meta.dir, 'plainExecutionChild.ts')
const plan = await planPlainExecution({ bun, entry, cwd: import.meta.dir, env: { PATH: process.env.PATH ?? '' } })
const launch = launchPlainExecution(plan, randomUUID(), randomUUID(), bun)
const command = new Promise<number>(resolve => launch.child.on('message', (message: { type?: string; pid?: number }) => {
  if (message?.type === 'command' && message.pid) resolve(message.pid)
}))
try {
  const mapping = await launch.prepare(Date.now() + 20_000)
  const commandPid = await command
  const before = alive(commandPid)
  const receipt = await launch.retire()
  console.log(JSON.stringify({ childPid: launch.child.pid, hostPID: mapping.bun.hostPID, before, after: alive(commandPid), receipt }))
} finally { await launch.retire().catch(() => undefined) }
