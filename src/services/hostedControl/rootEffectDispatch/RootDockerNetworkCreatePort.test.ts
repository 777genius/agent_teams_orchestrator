import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'

import { hostedMemberStartOperationId } from '../../teamLifecycleOwner/HostedMemberStartOperationId.js'
import type { HostedMemberNetworkRequest } from '../containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'
import type { HostedProductCurrentMember, HostedProductMemberBinding } from
  '../productAuthority/HostedProductCurrentMemberDecision.js'
import { HostedRootSingleMemberAuthority } from './HostedRootSingleMemberAuthority.js'
import { RootDockerNetworkCreatePort } from './RootDockerNetworkCreatePort.js'

const ID = 'a'.repeat(64)
const MARKER = 'org.agentteams.hosted-opencode.member-network-claim'
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const binding: HostedProductMemberBinding = {
  runId: `run_${'1'.repeat(32)}`, memberId: `member_${'2'.repeat(32)}`,
  teamId: `team_${'3'.repeat(32)}`, laneId: `lane_${'4'.repeat(32)}`,
  deploymentId: 'deployment_fixture1234', runtimeWorkspaceId: `workspace_${'5'.repeat(32)}`,
  planSha256: '6'.repeat(64), rosterBindingSha256: '7'.repeat(64),
  restoreGeneration: 1, mountGeneration: 1,
}
const request: HostedMemberNetworkRequest = {
  operationId: hostedMemberStartOperationId(binding.runId, binding.memberId, binding.planSha256),
  planTeamId: binding.teamId, planFingerprint: binding.planSha256,
  runId: binding.runId, teamId: binding.teamId, laneId: binding.laneId, memberId: binding.memberId,
}
const name = `hat-member-${'8'.repeat(32)}`
const nonce = '9'.repeat(64)
const directories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'root-network-create-')))
  directories.push(directory)
  const networkState = path.join(directory, 'network-state')
  const effectClaims = path.join(directory, 'effect-claims')
  await mkdir(networkState, { mode: 0o700 })
  await mkdir(effectClaims, { mode: 0o700 })
  await chmod(networkState, 0o700)
  await chmod(effectClaims, 0o700)
  const operation = path.join(networkState, `network-operation-${request.operationId}.json`)
  await writeFile(operation, JSON.stringify({ requestSha256: sha(JSON.stringify([
    request.operationId, request.planTeamId, request.planFingerprint, request.runId,
    request.teamId, request.laneId, request.memberId,
  ])), name, nonce }), { mode: 0o600 })
  await link(operation, path.join(networkState,
    `network-member-${sha(`${request.runId}\0${request.teamId}\0${request.memberId}`)}.json`))

  const socketPath = path.join(directory, 'docker.sock')
  const requests: Buffer[] = []
  const server = createServer(socket => {
    const parts: Buffer[] = []
    socket.on('data', chunk => {
      parts.push(chunk)
      const bytes = Buffer.concat(parts)
      const split = bytes.indexOf('\r\n\r\n')
      if (split < 0) return
      const length = /\r\nContent-Length: (\d+)\r\n/.exec(bytes.subarray(0, split + 4).toString())
      if (!length || bytes.length < split + 4 + Number(length[1])) return
      requests.push(bytes)
      const body = JSON.stringify({ Id: ID, Warning: '' })
      socket.end(`HTTP/1.1 201 Created\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n${body}`)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(socketPath, resolve))

  let admitted = true
  let release: (() => void) | null = null
  let entered: (() => void) | null = null
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const current = { ...binding, admittedWorkspaceRoot: '/sandbox/member-fixture',
    bootId: 'boot_fixture1234' } as HostedProductCurrentMember
  const product = { async withCurrentMemberDecision<T>(_binding: HostedProductMemberBinding,
    _kind: 'prepare' | 'start' | 'observe' | 'stop', callback: (value: HostedProductCurrentMember) => T): Promise<T> {
    entered!()
    await gate
    if (!admitted) throw new Error('product-revoked')
    return callback(current)
  } }
  const authority = new HostedRootSingleMemberAuthority(product, { binding,
    workspaceParent: '/sandbox', sandboxWorkspaceRoot: '/sandbox/member-fixture',
    bootId: 'boot_fixture1234', ownerGeneration: 1,
    ownerSessionId: 'owner-session_fixture1234' }, value => ({ runId: value.runId,
    bootId: value.bootId, ownerGeneration: 1, ownerSessionId: 'owner-session_fixture1234',
    state: 'active' }))
  const port = RootDockerNetworkCreatePort.create({ stateDirectory: networkState,
    effectClaimDirectory: effectClaims, socketPath, authority,
    assertDockerApiCompatible: async () => true, testOnlyAllowNonRoot: true })
  return { port, waiting, release: () => release!(), revoke: () => { admitted = false },
    allow: () => { admitted = true }, requests, effectClaims }
}

test('revocation after async admission but before Product callback burns no Docker claim or bytes', async () => {
  const f = await fixture()
  const pending = f.port.create(name, nonce, request)
  await f.waiting
  f.revoke()
  f.release()
  await expect(pending).rejects.toThrow('hosted-network-root-create-unresolved')
  expect(await readdir(f.effectClaims)).toEqual([])
  expect(f.requests).toHaveLength(0)
})

test('exact root-owned network claim is dispatched once and arbitrary target is rejected', async () => {
  const f = await fixture()
  f.release()
  await expect(f.port.create('hat-member-' + 'f'.repeat(32), nonce, request))
    .rejects.toThrow('target-unbound')
  expect(f.requests).toHaveLength(0)
  expect(await f.port.create(name, nonce, request)).toBe(ID)
  expect(f.requests).toHaveLength(1)
  const wire = f.requests[0].toString()
  expect(wire).toStartWith('POST /v1.47/networks/create HTTP/1.1\r\n')
  const body = JSON.parse(wire.slice(wire.indexOf('\r\n\r\n') + 4)) as Record<string, unknown>
  expect(body).toMatchObject({ Name: name, Driver: 'bridge', Internal: true,
    EnableIPv4: true, EnableIPv6: false, Labels: { [MARKER]: nonce } })
  await expect(f.port.inspect()).rejects.toThrow('inspect-unavailable')
  await expect(f.port.remove()).rejects.toThrow('remove-unavailable')
})
