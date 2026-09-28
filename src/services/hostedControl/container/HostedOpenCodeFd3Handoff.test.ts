import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect, createServer, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from 'bun:test'

test('Linux Bun transfers a connected Unix stream as child FD3 without payload replay', async () => {
  if (process.platform !== 'linux') return
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hosted-fd3-inert-'))
  const socketPath = path.join(directory, 'peer.sock')
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    })
    const accepted = new Promise<Socket>(resolve => server.once('connection', resolve))
    const rootSide = connect(socketPath)
    const ownerSide = await accepted
    const bytes = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('inert-fd3-timeout')), 3_000)
      ownerSide.once('data', value => { clearTimeout(timer); resolve(value.toString('utf8')) })
      ownerSide.once('error', reject)
    })
    const child = spawn('/usr/bin/python3', ['-I', '-c', 'import os; os.write(3, b"fd3-test")'], {
      stdio: ['ignore', 'ignore', 'ignore', rootSide],
      env: { PATH: '/usr/bin:/bin' },
      timeout: 3_000,
    })
    rootSide.destroy()
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(exit).toBe(0)
    expect(await bytes).toBe('fd3-test')
    ownerSide.destroy()
  } finally {
    server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
