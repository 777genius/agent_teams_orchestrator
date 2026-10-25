// TEST driver for OpenCodeV2PlainExecution, run as an ordinary Bun process: bun test parses
// dates in UTC without exporting TZ, which would skew darwin `ps lstart` identities.
// Usage: plainExecutionDriver.ts [normal|foreign-nonce|wrong-pid|silent]
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { launchPlainExecution, planPlainExecution } from '../OpenCodeV2PlainExecution.js'

const mode = process.argv[2] ?? 'normal'
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const bunPath = await realpath(process.execPath)
const bun = { path: bunPath, sha256: createHash('sha256').update(await readFile(bunPath)).digest('hex') }
const entry = path.join(import.meta.dir, 'plainExecutionChild.ts')
const env: Record<string, string> = { PATH: process.env.PATH ?? '', TEST_PLAIN_CHILD_MODE: mode }
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]!
const plan = await planPlainExecution({ bun, entry, cwd: import.meta.dir, env })
const launch = launchPlainExecution(plan, randomUUID(), randomUUID(), bun)
const command = new Promise<number>(resolve => launch.child.on('message', (message: { type?: string; pid?: number }) => {
  if (message?.type === 'command' && message.pid) resolve(message.pid)
}))
try {
  let mapping
  try { mapping = await launch.prepare(Date.now() + (mode === 'normal' ? 20_000 : 3_000)) }
  catch (error) {
    const receipt = await launch.retire()
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error), childAlive: alive(launch.child.pid!), receipt }))
    process.exit(0)
  }
  const commandPid = await command
  const before = alive(commandPid)
  const receipt = await launch.retire()
  // Windows reports a killed process until its last handle closes.
  for (let i = 0; i < 40 && alive(commandPid); i++) await new Promise(resolve => setTimeout(resolve, 50))
  console.log(JSON.stringify({ childPid: launch.child.pid, hostPID: mapping.bun.hostPID, before, after: alive(commandPid), receipt }))
} finally { await launch.retire().catch(() => undefined) }
