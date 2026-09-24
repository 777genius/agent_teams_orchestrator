import { afterEach, expect, test } from 'bun:test'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'

import { readLinuxHostedAgentPeerCredentials } from './HostedAgentPeerCredentials.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const linuxTest = process.platform === 'linux' ? test : test.skip
linuxTest('reads kernel SO_PEERCRED from a sandbox UDS without private Socket handles', async () => {
  const root = await realpath(await mkdtemp('/tmp/peer-cred-'))
  roots.push(root)
  const server = createServer()
  const path = join(root, 'peer.sock')
  server.listen(path)
  await once(server, 'listening')
  const connected = once(server, 'connection')
  const client = connect(path)
  const [accepted] = await connected
  try {
    const credentials = await readLinuxHostedAgentPeerCredentials(accepted)
    expect(credentials).toMatchObject({ pid: process.pid, uid: process.getuid?.() })
  } finally {
    client.destroy()
    accepted.destroy()
    server.close()
  }
})
