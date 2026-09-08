import { access, writeFile } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { runHostedControlSocketBroker } from '../HostedControlSocketBroker.js'

// Only deterministic scheduling around the actual helper, never a fake broker.
const delayedInput = process.argv[2] === 'read'
if (delayedInput) process.stdout.write('reading\n')
void runHostedControlSocketBroker([], delayedInput ? {} : {
  afterFirstStatForTest: async (index, path) => {
    if (index === 0 && existsSync(`${path}.swap`)) await phase(path, 'first-stat')
  },
  afterPeerAttemptForTest: async (index, path, proved) => {
    if (index === 0 && existsSync(`${path}.swap`)) await phase(path, 'peer-complete', String(proved))
  },
  afterBindForTest: async (index, path) => {
    if (index !== 0) return
    if (existsSync(`${path}.preconnect`)) {
      // Freeze accept dispatch, not the kernel listen backlog: the parent can
      // complete connect before unlink while the actual accept callback stays
      // queued until the ownership proof is armed. This reproduces the
      // preconnected relay even against the old post-hook proof arming order.
      writeFileSync(`${path}.bound`, '')
      const deadline = Date.now() + 4_000
      const pause = new Int32Array(new SharedArrayBuffer(4))
      while (!existsSync(`${path}.continue`)) {
        if (Date.now() >= deadline) throw new Error('Paused broker deadline')
        Atomics.wait(pause, 0, 0, 2)
      }
      return
    }
    await writeFile(`${path}.bound`, '')
    const deadline = Date.now() + 4_000
    while (true) {
      try { await access(`${path}.continue`); return } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw error
      }
      await new Promise(resolve => setTimeout(resolve, 2))
    }
  },
}).catch(() => { process.kill(process.pid, 'SIGKILL') })

async function phase(path: string, name: string, contents = ''): Promise<void> {
  await writeFile(`${path}.${name}`, contents)
  const deadline = Date.now() + 4_000
  while (!existsSync(`${path}.${name}.continue`)) {
    if (Date.now() >= deadline) throw new Error('Swap phase deadline')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
