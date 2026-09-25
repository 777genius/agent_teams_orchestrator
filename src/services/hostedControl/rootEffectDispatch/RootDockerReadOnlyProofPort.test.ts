import { chmod, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'

import type { HostedProductCurrentMember, HostedProductMemberBinding } from
  '../productAuthority/HostedProductCurrentMemberDecision.js'
import { HostedRootSingleMemberAuthority } from './HostedRootSingleMemberAuthority.js'
import { RootDockerReadOnlyProofPort } from './RootDockerReadOnlyProofPort.js'

const binding: HostedProductMemberBinding = {
  runId: `run_${'1'.repeat(32)}`, memberId: `member_${'2'.repeat(32)}`,
  teamId: `team_${'3'.repeat(32)}`, laneId: `lane_${'4'.repeat(32)}`,
  deploymentId: 'deployment_fixture1234', runtimeWorkspaceId: `workspace_${'5'.repeat(32)}`,
  planSha256: '6'.repeat(64), rosterBindingSha256: '7'.repeat(64),
  restoreGeneration: 1, mountGeneration: 1,
}
const image = `example.invalid/opencode@sha256:${'a'.repeat(64)}`
const imageId = `sha256:${'b'.repeat(64)}`
const networkId = 'c'.repeat(64)
const bootstrapSha256 = 'd'.repeat(64)
const directories: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'root-docker-proof-')))
  directories.push(directory)
  const effects = path.join(directory, 'effects')
  await mkdir(effects, { mode: 0o700 })
  await chmod(effects, 0o700)
  const socketPath = path.join(directory, 'docker.sock')
  const requests: string[] = []
  const server = createServer(socket => {
    const parts: Buffer[] = []
    socket.on('data', chunk => {
      parts.push(chunk)
      const bytes = Buffer.concat(parts)
      const split = bytes.indexOf('\r\n\r\n')
      if (split < 0 || bytes.length < split + 4) return
      const line = bytes.toString('utf8', 0, bytes.indexOf('\r\n'))
      requests.push(line)
      const body = line.includes('/images/') ? JSON.stringify({ Id: imageId, RepoDigests: [image],
        Config: { Labels: { 'org.agentteams.hosted-opencode.bootstrap-sha256': bootstrapSha256 } } }) :
        JSON.stringify({ Id: networkId, Driver: 'bridge', Scope: 'local', Internal: true,
          EnableIPv6: false, Containers: {} })
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n${body}`)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  let current = true
  let release: (() => void) | null = null
  let entered: (() => void) | null = null
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const product = { async withCurrentMemberDecision<T>(_binding: HostedProductMemberBinding,
    _kind: 'prepare' | 'start' | 'observe' | 'stop', callback: (row: HostedProductCurrentMember) => T): Promise<T> {
    entered!()
    await gate
    if (!current) throw new Error('product-revoked')
    return callback({ ...binding, admittedWorkspaceRoot: '/sandbox/member-fixture',
      bootId: 'boot_fixture1234' } as HostedProductCurrentMember)
  } }
  const authority = new HostedRootSingleMemberAuthority(product, { binding,
    workspaceParent: '/sandbox', sandboxWorkspaceRoot: '/sandbox/member-fixture',
    bootId: 'boot_fixture1234', ownerGeneration: 1,
    ownerSessionId: 'owner-session_fixture1234' }, row => ({ runId: row.runId,
    bootId: row.bootId, ownerGeneration: 1, ownerSessionId: 'owner-session_fixture1234', state: 'active' }))
  const port = RootDockerReadOnlyProofPort.create({ effectClaimDirectory: effects, socketPath,
    authority, binding, image, imageId, bootstrapSha256, networkId, testOnlyAllowNonRoot: true })
  return { port, requests, effects, waiting, release: () => release!(), revoke: () => { current = false } }
}

test('fixed image and network GETs return only pinned Docker evidence', async () => {
  const f = await fixture()
  f.release()
  expect((await f.port.inspectImage()).Id).toBe(imageId)
  expect((await f.port.inspectNetwork()).Id).toBe(networkId)
  expect(f.requests).toEqual([
    `GET /v1.47/images/${encodeURIComponent(image)}/json HTTP/1.1`,
    `GET /v1.47/networks/${networkId} HTTP/1.1`,
  ])
})

test('Product revocation before the read decision sends no Docker bytes or claim', async () => {
  const f = await fixture()
  const pending = f.port.inspectNetwork()
  await f.waiting
  f.revoke()
  f.release()
  await expect(pending).rejects.toThrow('proof-unresolved')
  expect(f.requests).toEqual([])
  expect(await readdir(f.effects)).toEqual([])
})
