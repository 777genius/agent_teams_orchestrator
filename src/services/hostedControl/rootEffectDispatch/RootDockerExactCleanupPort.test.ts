import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'

import { hostedMemberStartOperationId } from '../../teamLifecycleOwner/HostedMemberStartOperationId.js'
import type { HostedProductMemberBinding } from '../productAuthority/HostedProductCurrentMemberDecision.js'
import { withRootDockerContainerOperationLock } from './RootDockerContainerOperationLock.js'
import { RootDockerExactCleanupPort } from './RootDockerExactCleanupPort.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const binding: HostedProductMemberBinding = {
  runId: `run_${'1'.repeat(32)}`, memberId: `member_${'2'.repeat(32)}`,
  teamId: `team_${'3'.repeat(32)}`, laneId: `lane_${'4'.repeat(32)}`,
  deploymentId: 'deployment_fixture1234', runtimeWorkspaceId: `workspace_${'5'.repeat(32)}`,
  planSha256: '6'.repeat(64), rosterBindingSha256: '7'.repeat(64),
  restoreGeneration: 1, mountGeneration: 1,
}
const memberOperationId = hostedMemberStartOperationId(binding.runId, binding.memberId, binding.planSha256)
const image = `example.invalid/opencode@sha256:${'a'.repeat(64)}`
const imageId = `sha256:${'b'.repeat(64)}`
const networkId = 'c'.repeat(64)
const containerId = 'd'.repeat(64)
const handle = `opencode_${'e'.repeat(32)}`
const generation = 'f'.repeat(32)
const dirs: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture(mode: 'valid' | 'foreign' | 'reused' | 'drop-stop' = 'valid') {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'root-exact-cleanup-')))
  dirs.push(dir)
  const [stateDirectory, effectClaimDirectory, workspaceParent, profileParent, configParent] =
    ['state', 'effects', 'workspace', 'profile', 'config'].map(name => path.join(dir, name))
  for (const entry of [stateDirectory, effectClaimDirectory, workspaceParent, profileParent, configParent]) {
    await mkdir(entry, { mode: 0o700 })
    await chmod(entry, 0o700)
  }
  const workspace = path.join(workspaceParent, '1'.repeat(32))
  const profile = path.join(profileParent, '2'.repeat(32))
  const config = path.join(configParent, '3'.repeat(32))
  const mounts = [
    { Type: 'bind', Source: workspace, Target: '/sandbox/workspace' },
    { Type: 'bind', Source: profile, Target: '/sandbox/profile' },
    { Type: 'bind', Source: config, Target: '/sandbox/config', ReadOnly: true },
  ]
  const body = JSON.stringify({ Image: image, Labels: {
    'org.agentteams.hosted-opencode.generation': generation,
    'org.agentteams.hosted-opencode.member-operation-id': memberOperationId,
    'org.agentteams.hosted-opencode.run-id': binding.runId,
    'org.agentteams.hosted-opencode.member-id': binding.memberId,
    'org.agentteams.hosted-opencode.runtime-workspace-id': binding.runtimeWorkspaceId },
  HostConfig: { NetworkMode: networkId, Mounts: mounts } })
  await writeFile(path.join(stateDirectory, `container-create-${memberOperationId}.json`),
    JSON.stringify({ memberOperationId, handle, generation, networkId, body }), { mode: 0o600 })
  const targetPath = path.join(stateDirectory, `container-target-${memberOperationId}.json`)
  await writeFile(targetPath, JSON.stringify({ memberOperationId, handle, generation, networkId,
    containerId }), { mode: 0o600 })
  const createId = `container_create_${sha(`${memberOperationId}\0`)}`
  await writeFile(path.join(effectClaimDirectory, `${sha(createId)}.claim`), JSON.stringify({
    operationId: createId, kind: 'create_container', method: 'POST',
    uri: `/v1.47/containers/create?name=${handle}`, bodySha256: sha('root-secret-create-body'),
    bindingSha256: sha(JSON.stringify(binding)),
  }), { mode: 0o600 })
  const socketPath = path.join(dir, 'docker.sock')
  const requests: string[] = []
  let running = true
  let inspections = 0
  const server = createServer(socket => {
    const chunks: Buffer[] = []
    socket.on('data', chunk => {
      chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const split = bytes.indexOf('\r\n\r\n')
      if (split < 0) return
      const line = bytes.toString('utf8', 0, bytes.indexOf('\r\n'))
      requests.push(line)
      if (mode === 'drop-stop' && line.includes('/stop ')) { socket.destroy(); return }
      if (line.startsWith('POST ') && line.includes('/stop ')) running = false
      const remove = line.startsWith('DELETE ')
      const inspect = line.startsWith('GET ')
      if (inspect) inspections++
      const absent = inspect && requests.some(value => value.startsWith('DELETE '))
      const foreign = mode === 'foreign' || mode === 'reused' && inspections > 1
      const response = inspect && !absent ? JSON.stringify({ Id: containerId,
        Name: `/${handle}`, Image: imageId, Config: { Image: image, Labels: {
          'org.agentteams.hosted-opencode.generation': foreign ? '0'.repeat(32) : generation,
          'org.agentteams.hosted-opencode.member-operation-id': memberOperationId,
          'org.agentteams.hosted-opencode.run-id': binding.runId,
          'org.agentteams.hosted-opencode.member-id': binding.memberId,
          'org.agentteams.hosted-opencode.runtime-workspace-id': binding.runtimeWorkspaceId } },
        HostConfig: { NetworkMode: networkId }, NetworkSettings: { Networks: { isolated: {
          NetworkID: networkId } } }, State: { Running: running }, Mounts: [
          { Source: workspace, Destination: '/sandbox/workspace', RW: true },
          { Source: profile, Destination: '/sandbox/profile', RW: true },
          { Source: config, Destination: '/sandbox/config', RW: false },
        ] }) : ''
      const status = absent ? 404 : inspect ? 200 : 204
      socket.end(`HTTP/1.1 ${status} OK\r\nContent-Length: ${Buffer.byteLength(response)}\r\n` +
        `Connection: close\r\n\r\n${response}`)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  const port = RootDockerExactCleanupPort.create({ stateDirectory, effectClaimDirectory, socketPath,
    binding, image, imageId, networkId, workspaceParent, profileParent, configParent,
    testOnlyAllowNonRoot: true })
  return { port, requests, targetPath, effectClaimDirectory, createId }
}

test('historical root ownership removes only the exact inspected container after revoke', async () => {
  const f = await fixture()
  expect(await f.port.cleanup()).toBe('removed')
  expect(f.requests).toEqual([
    `GET /v1.47/containers/${containerId}/json HTTP/1.1`,
    `POST /v1.47/containers/${containerId}/stop HTTP/1.1`,
    `GET /v1.47/containers/${containerId}/json HTTP/1.1`,
    `DELETE /v1.47/containers/${containerId} HTTP/1.1`,
    `GET /v1.47/containers/${containerId}/json HTTP/1.1`,
  ])
  let repeated: unknown
  try { await f.port.cleanup() } catch (error) { repeated = error }
  expect(String(repeated)).toContain('root-container-cleanup-unresolved')
  expect(f.requests.filter(value => value.startsWith('POST ') || value.startsWith('DELETE '))).toHaveLength(2)
})

test('unrelated container and reused ID cannot receive destructive cleanup bytes', async () => {
  const foreign = await fixture('foreign')
  await expect(foreign.port.cleanup()).rejects.toThrow('docker-identity-invalid')
  expect(foreign.requests).toEqual([`GET /v1.47/containers/${containerId}/json HTTP/1.1`])

  const reused = await fixture('reused')
  await expect(reused.port.cleanup()).rejects.toThrow('docker-identity-invalid')
  expect(reused.requests.some(value => value.startsWith('DELETE '))).toBe(false)
  expect(reused.requests.filter(value => value.startsWith('POST '))).toHaveLength(1)
})

test('missing post-create target or create effect claim prevents any Docker request', async () => {
  const f = await fixture()
  await rm(f.targetPath)
  await expect(f.port.cleanup()).rejects.toThrow()
  expect(f.requests).toEqual([])
  const another = await fixture()
  await rm(path.join(another.effectClaimDirectory, `${sha(another.createId)}.claim`))
  await expect(another.port.cleanup()).rejects.toThrow()
  expect(another.requests).toEqual([])
})

test('uncertain Stop never replays or proceeds to Remove', async () => {
  const f = await fixture('drop-stop')
  await expect(f.port.cleanup()).rejects.toThrow('unresolved')
  await expect(f.port.cleanup()).rejects.toThrow('unresolved')
  expect(f.requests.filter(value => value.startsWith('POST '))).toHaveLength(1)
  expect(f.requests.some(value => value.startsWith('DELETE '))).toBe(false)
  expect((await readdir(f.effectClaimDirectory)).filter(value => value.endsWith('.claim'))).toHaveLength(4)
})

test('root container lock excludes a second member while cleanup owns the daemon', async () => {
  let release!: () => void
  const held = withRootDockerContainerOperationLock('first-member', () =>
    new Promise<void>(resolve => { release = resolve }))
  await expect(withRootDockerContainerOperationLock('second-member', async () => undefined))
    .rejects.toThrow('root-container-operation-busy')
  release()
  await held
  await expect(withRootDockerContainerOperationLock('second-member', async () => 'ready'))
    .resolves.toBe('ready')
})
