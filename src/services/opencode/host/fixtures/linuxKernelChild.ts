// Minimal synthetic executable. Never imports an official server/model/Effect.
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectLinuxExecutionChild, linuxBirth } from '../OpenCodeV2ExecutionLauncher.js'

const entry = fileURLToPath(import.meta.url), mode = process.env.R247_FIXTURE_MODE ?? 'normal'
const selectedRoot = process.env.TMPDIR
if (!selectedRoot) throw new Error('fixture_root_missing')
const root: string = selectedRoot
const watchdog = setTimeout(() => process.exit(90), 25_000)
function send(value: unknown): Promise<void> {
  const channel = process.send
  if (!channel || !process.connected) throw new Error('fixture_ipc_missing')
  return new Promise((resolve, reject) => channel.call(process, value, error => error ? reject(error) : resolve()))
}
async function waitFile(file: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('fixture_file_timeout')
}
function subprocess(role: string, detached: boolean) {
  const child = spawn(process.execPath, [entry, role], { detached, env: { TMPDIR: root }, stdio: ['ignore', 'ignore', 'ignore'] })
  const exit = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject) })
  void exit.catch(() => undefined)
  return { child, exit }
}
const role = process.argv[2]
if (role === 'orphan') {
  const stat = await readFile('/proc/self/stat', 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
  await writeFile(path.join(root, 'orphan.json'), JSON.stringify({ pid: process.pid, birth: await linuxBirth(process.pid),
    groupPID: Number(fields[2]), parentPID: Number(fields[1]) }))
} else if (role === 'intermediate') {
  // detached spawn established setsid; this second spawn is the second fork.
  subprocess('orphan', false)
  await waitFile(path.join(root, 'orphan.json')); process.exit(0)
} else if (role === 'workload') {
  const intermediate = subprocess('intermediate', true)
  await intermediate.exit
  await writeFile(path.join(root, 'workload.json'), JSON.stringify({ pid: process.pid, birth: await linuxBirth(process.pid) }))
} else if (mode === 'sentinel') {
  await send({ type: 'sentinel', pid: process.pid, birth: await linuxBirth(process.pid) })
  process.on('message', async value => {
    if (value && typeof value === 'object' && 'type' in value && value.type === 'close') {
      clearTimeout(watchdog); process.disconnect?.(); process.exit(0)
    }
  })
} else {
  let facts: Awaited<ReturnType<typeof inspectLinuxExecutionChild>> | undefined
  let preparation: Promise<void> | undefined, scopeClosed = false
  process.on('message', value => {
    if (!value || typeof value !== 'object' || !('type' in value)) return
    const message = value as Record<string, unknown>
    if (message.type === 'prepare') {
      preparation = (async () => {
        // Fast escaped offspring exist before the parent's first namespace census.
        if (mode === 'normal') {
          const workload = subprocess('workload', true)
          const leader = await waitFile(path.join(root, 'workload.json'))
          const orphan = await waitFile(path.join(root, 'orphan.json'))
          if (typeof leader.pid !== 'number' || typeof orphan.pid !== 'number' || orphan.groupPID === leader.pid) throw new Error('fixture_group_not_escaped')
          if (JSON.stringify(await linuxBirth(leader.pid)) !== JSON.stringify(leader.birth)) throw new Error('fixture_leader_birth_changed')
          process.kill(-leader.pid, 'SIGKILL'); await workload.exit
          // A real process-group cleanup left the orphan alive.
          if (JSON.stringify(await linuxBirth(orphan.pid)) !== JSON.stringify(orphan.birth)) throw new Error('fixture_orphan_did_not_survive_group')
        }
        const real = await inspectLinuxExecutionChild(message)
        facts = real
        const prepared = { ...real }
        if (mode === 'wrong-pid') prepared.pid += 1
        if (mode === 'wrong-namespace') prepared.namespace = 'pid:[1]'
        if (mode === 'wrong-boot') prepared.birth = { ...real.birth, bootId: '00000000-0000-0000-0000-000000000000' }
        if (mode === 'wrong-executable') prepared.executableSha256 = '0'.repeat(64)
        await send(prepared)
      })()
      void preparation.catch(async error => {
        try {
          const diagnostic = { stage: 'prepare', pid: process.pid, mode, ipc: { channelFD: process.env.NODE_CHANNEL_FD, serialization: process.env.NODE_CHANNEL_SERIALIZATION_MODE, send: typeof process.send, connected: process.connected }, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }, status: await readFile('/proc/self/status', 'utf8') };
          await writeFile(path.join(root, 'prepare-error.json'), JSON.stringify(diagnostic, null, 2) + '\n', { flag: 'wx' })
        } finally { process.exit(91) }
      })
    } else if (message.type === 'start') {
      void (async () => {
        await preparation
        if (!facts || message.nonce !== facts.nonce || message.leaseOwnerId !== facts.leaseOwnerId || message.namespace !== facts.namespace) throw new Error('fixture_start_unbound')
        await send({ ...facts, type: 'ready', started: true })
      })().catch(() => process.exit(92))
    } else if (message.type === 'close') {
      void (async () => {
        await preparation
        // Synthetic asynchronous Scope finalizer, not an official/native PASS.
        await Promise.resolve(); scopeClosed = true
        if (facts) await send({ ...facts, type: 'closed', scopeClosed,
          namespace: mode === 'wrong-closed' ? 'pid:[1]' : facts.namespace })
        clearTimeout(watchdog); process.disconnect?.(); process.exit(0)
      })().catch(() => process.exit(93))
    }
  })
}
