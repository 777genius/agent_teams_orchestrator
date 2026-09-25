import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'

import { hostedMemberStartOperationId } from '../../teamLifecycleOwner/HostedMemberStartOperationId.js'
import type { HostedProductCurrentMember, HostedProductMemberBinding } from
  '../productAuthority/HostedProductCurrentMemberDecision.js'
import { HostedRootSingleMemberAuthority } from './HostedRootSingleMemberAuthority.js'
import { RootDockerContainerPort, type RootContainerTarget } from './RootDockerContainerPort.js'

const binding: HostedProductMemberBinding = {
  runId: `run_${'1'.repeat(32)}`, memberId: `member_${'2'.repeat(32)}`,
  teamId: `team_${'3'.repeat(32)}`, laneId: `lane_${'4'.repeat(32)}`,
  deploymentId: 'deployment_fixture1234', runtimeWorkspaceId: `workspace_${'5'.repeat(32)}`,
  planSha256: '6'.repeat(64), rosterBindingSha256: '7'.repeat(64),
  restoreGeneration: 1, mountGeneration: 1,
}
const image = `example.invalid/opencode@sha256:${'a'.repeat(64)}`
const target: RootContainerTarget = { memberOperationId:
  hostedMemberStartOperationId(binding.runId, binding.memberId, binding.planSha256),
  handle: `opencode_${'b'.repeat(32)}`, generation: 'c'.repeat(32), networkId: 'd'.repeat(64) }
const containerId = 'e'.repeat(64)
const directories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'root-container-port-')))
  directories.push(directory)
  const stateDirectory = path.join(directory, 'state')
  const effectClaimDirectory = path.join(directory, 'effects')
  await mkdir(stateDirectory, { mode: 0o700 })
  await mkdir(effectClaimDirectory, { mode: 0o700 })
  await chmod(stateDirectory, 0o700)
  await chmod(effectClaimDirectory, 0o700)
  const body = JSON.stringify({ Image: image, Env: ['OPENCODE_SERVER_PASSWORD'], Labels: {
    'org.agentteams.hosted-opencode.generation': target.generation,
    'org.agentteams.hosted-opencode.member-operation-id': target.memberOperationId,
    'org.agentteams.hosted-opencode.run-id': binding.runId,
    'org.agentteams.hosted-opencode.member-id': binding.memberId,
    'org.agentteams.hosted-opencode.runtime-workspace-id': binding.runtimeWorkspaceId },
  HostConfig: { NetworkMode: target.networkId, ReadonlyRootfs: true,
    Privileged: false, CapDrop: ['ALL'] } })
  await writeFile(path.join(stateDirectory, `container-create-${target.memberOperationId}.json`),
    JSON.stringify({ ...target, body }), { mode: 0o600 })
  await writeFile(path.join(stateDirectory, `container-target-${target.memberOperationId}.json`),
    JSON.stringify({ ...target, containerId }), { mode: 0o600 })
  const socketPath = path.join(directory, 'docker.sock')
  const requests: Buffer[] = []
  const server = createServer(socket => {
    const parts: Buffer[] = []
    socket.on('data', chunk => {
      parts.push(chunk)
      const bytes = Buffer.concat(parts)
      const split = bytes.indexOf('\r\n\r\n')
      if (split < 0) return
      const match = /\r\nContent-Length: (\d+)\r\n/.exec(bytes.subarray(0, split + 4).toString())
      if (!match || bytes.length < split + 4 + Number(match[1])) return
      requests.push(bytes)
      const line = bytes.toString('utf8', 0, bytes.indexOf('\r\n'))
      const response = line.includes('/containers/create?') ? JSON.stringify({ Id: containerId, Warnings: [] }) :
        line.includes('/json ') ? JSON.stringify({ Id: containerId }) : ''
      const status = line.includes('/containers/create?') ? 201 : line.includes('/json ') ? 200 : 204
      socket.end(`HTTP/1.1 ${status} OK\r\nContent-Length: ${Buffer.byteLength(response)}\r\n` +
        `Connection: close\r\n\r\n${response}`)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  let admitted = true
  let release: (() => void) | null = null
  let entered: (() => void) | null = null
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const product = { async withCurrentMemberDecision<T>(_binding: HostedProductMemberBinding,
    _kind: 'prepare' | 'start' | 'observe' | 'stop', callback: (row: HostedProductCurrentMember) => T): Promise<T> {
    entered!()
    await gate
    if (!admitted) throw new Error('product-revoked')
    return callback({ ...binding, admittedWorkspaceRoot: '/sandbox/member-fixture',
      bootId: 'boot_fixture1234' } as HostedProductCurrentMember)
  } }
  const authority = new HostedRootSingleMemberAuthority(product, { binding,
    workspaceParent: '/sandbox', sandboxWorkspaceRoot: '/sandbox/member-fixture',
    bootId: 'boot_fixture1234', ownerGeneration: 1,
    ownerSessionId: 'owner-session_fixture1234' }, row => ({ runId: row.runId,
    bootId: row.bootId, ownerGeneration: 1, ownerSessionId: 'owner-session_fixture1234', state: 'active' }))
  const port = RootDockerContainerPort.create({ stateDirectory, effectClaimDirectory, socketPath,
    authority, binding, image, networkId: target.networkId,
    serverPasswordKey: Buffer.alloc(32, 7), testOnlyAllowNonRoot: true })
  return { port, waiting, release: () => release!(), revoke: () => { admitted = false },
    requests, target: { ...target, containerId }, stateDirectory, effectClaimDirectory }
}

test('revocation before exact create callback leaves no Docker bytes or effect', async () => {
  const f = await fixture()
  const pending = f.port.createContainer(target)
  await f.waiting
  f.revoke()
  f.release()
  await expect(pending).rejects.toThrow('create-unresolved')
  expect(f.requests).toHaveLength(0)
})

test('typed create/start/inspect/stop use only the exact root-owned target', async () => {
  const f = await fixture()
  f.release()
  await expect(f.port.createContainer({ ...target, handle: `opencode_${'f'.repeat(32)}` }))
    .rejects.toThrow('target-unbound')
  await expect(f.port.startContainer({ ...f.target, containerId: 'f'.repeat(64) }))
    .rejects.toThrow('target-unbound')
  expect(f.requests).toHaveLength(0)
  expect(await f.port.createContainer(target)).toBe(containerId)
  const stored = await readFile(path.join(f.stateDirectory,
    `container-create-${target.memberOperationId}.json`), 'utf8')
  expect(stored).not.toContain('OPENCODE_SERVER_PASSWORD=')
  expect(f.requests[0].toString()).toContain('OPENCODE_SERVER_PASSWORD=')
  await f.port.startContainer(f.target)
  expect(await f.port.inspectContainer(f.target)).toEqual({ Id: containerId })
  await f.port.stopCurrentContainer(f.target)
  expect(f.requests.map(bytes => bytes.toString('utf8', 0, bytes.indexOf('\r\n')))).toEqual([
    `POST /v1.47/containers/create?name=${target.handle} HTTP/1.1`,
    `POST /v1.47/containers/${containerId}/start HTTP/1.1`,
    `GET /v1.47/containers/${containerId}/json HTTP/1.1`,
    `POST /v1.47/containers/${containerId}/stop HTTP/1.1`,
  ])
  await expect(f.port.inspectImage()).rejects.toThrow('unavailable')
  await expect(f.port.inspectNetwork()).rejects.toThrow('unavailable')
  await expect(f.port.removeContainer()).rejects.toThrow('unavailable')
})

test('target substitution while Product admission waits sends no Start bytes', async () => {
  const f = await fixture()
  const pending = f.port.startContainer(f.target)
  await f.waiting
  await writeFile(path.join(f.stateDirectory, `container-target-${target.memberOperationId}.json`),
    JSON.stringify({ ...target, containerId: 'f'.repeat(64) }), { mode: 0o600 })
  f.release()
  await expect(pending).rejects.toThrow('start-unresolved')
  expect(f.requests).toHaveLength(0)
  expect(await readdir(f.effectClaimDirectory)).toEqual([])
})

test('same container ID with changed generation while Product waits sends no Start bytes', async () => {
  const f = await fixture()
  const pending = f.port.startContainer(f.target)
  await f.waiting
  const generation = 'f'.repeat(32)
  const manifestPath = path.join(f.stateDirectory, `container-create-${target.memberOperationId}.json`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const body = JSON.parse(manifest.body as string) as Record<string, unknown>
  ;(body.Labels as Record<string, unknown>)['org.agentteams.hosted-opencode.generation'] = generation
  await writeFile(manifestPath, JSON.stringify({ ...manifest, generation, body: JSON.stringify(body) }), { mode: 0o600 })
  await writeFile(path.join(f.stateDirectory, `container-target-${target.memberOperationId}.json`),
    JSON.stringify({ ...target, generation, containerId }), { mode: 0o600 })
  f.release()
  await expect(pending).rejects.toThrow('start-unresolved')
  expect(f.requests).toHaveLength(0)
  expect(await readdir(f.effectClaimDirectory)).toEqual([])
})
