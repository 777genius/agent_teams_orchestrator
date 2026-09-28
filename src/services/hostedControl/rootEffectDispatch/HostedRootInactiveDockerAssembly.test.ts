import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'

import { hostedMemberStartOperationId } from '../../teamLifecycleOwner/HostedMemberStartOperationId.js'
import { HostedRootInactiveDockerAssembly } from './HostedRootInactiveDockerAssembly.js'

const FIXTURES = path.join(import.meta.dir, '../productAuthority/fixtures')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const image = `example.invalid/opencode@sha256:${'a'.repeat(64)}`
const imageId = `sha256:${'b'.repeat(64)}`
const bootstrapSha256 = 'c'.repeat(64)
const networkId = 'd'.repeat(64)
const networkName = `hat-member-${'e'.repeat(32)}`
const marker = 'f'.repeat(64)
const directories: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await realpath(await mkdtemp('/tmp/hosted-root-inactive-assembly-'))
  directories.push(directory)
  await chmod(directory, 0o700)
  const [managerStateDirectory, networkStateDirectory, effectClaimDirectory,
    profileParent, configParent] = ['manager', 'network', 'effects', 'profile', 'config']
    .map(name => path.join(directory, name))
  for (const entry of [managerStateDirectory, networkStateDirectory, effectClaimDirectory,
    profileParent, configParent]) {
    await mkdir(entry, { mode: 0o700 })
    await chmod(entry, 0o700)
  }
  const databasePath = path.join(directory, 'product.sqlite')
  await writeFile(databasePath, gunzipSync(await readFile(path.join(FIXTURES,
    'product-v35-current-member.sqlite.gz'))), { mode: 0o600 })
  const metadata = JSON.parse(await readFile(path.join(FIXTURES,
    'product-v35-current-member.metadata.json'), 'utf8')) as {
      now: number; runId: string; memberId: string; binding: {
        deploymentId: string; bootId: string; ownerAuthority: string;
        ownerGeneration: number; ownerSessionId: string }
    }
  const db = new Database(databasePath, { create: false, readwrite: true })
  const reservation = JSON.parse((db.query('SELECT record_json FROM hosted_lifecycle_run_reservations WHERE run_id = ?')
    .get(metadata.runId) as { record_json: string }).record_json) as {
      teamId: string; planSha256: string; promotionOperationId: string }
  const roster = JSON.parse((db.query('SELECT binding_json FROM hosted_promotion_roster_bindings WHERE operation_id = ?')
    .get(reservation.promotionOperationId) as { binding_json: string }).binding_json) as {
      lanes: Array<{ laneId: string; members: Array<{ memberId: string }> }> }
  const lane = roster.lanes.find(value => value.members.some(member => member.memberId === metadata.memberId))!
  const promotion = JSON.parse((db.query('SELECT record_json FROM hosted_team_configuration_promotions WHERE operation_id = ?')
    .get(reservation.promotionOperationId) as { record_json: string }).record_json) as {
      admittedWorkspaceRoot: string }
  const operationId = hostedMemberStartOperationId(metadata.runId, metadata.memberId,
    reservation.planSha256)
  const request = { operationId, planTeamId: reservation.teamId,
    planFingerprint: reservation.planSha256, runId: metadata.runId, teamId: reservation.teamId,
    laneId: lane.laneId, memberId: metadata.memberId }
  const operation = { request, directoryName: `supervisor-${operationId}` }
  await writeFile(path.join(managerStateDirectory, `operation-${operationId}.json`),
    JSON.stringify(operation), { mode: 0o600 })
  await writeFile(path.join(managerStateDirectory,
    `member-${sha(`${request.runId}\0${request.teamId}\0${request.memberId}`)}.json`),
  JSON.stringify(operation), { mode: 0o600 })
  const result = JSON.stringify({ operationId, networkId })
  const resultPath = path.join(managerStateDirectory, `network-result-${operationId}.json`)
  await writeFile(resultPath, result, { mode: 0o600 })
  await writeFile(path.join(managerStateDirectory, `network-id-${networkId}.json`),
    result, { mode: 0o600 })
  const digest = sha(JSON.stringify([request.operationId, request.planTeamId,
    request.planFingerprint, request.runId, request.teamId, request.laneId, request.memberId]))
  const claimPath = path.join(networkStateDirectory, `network-operation-${operationId}.json`)
  await writeFile(claimPath, JSON.stringify({ requestSha256: digest, name: networkName,
    nonce: marker }), { mode: 0o600 })
  const memberClaimPath = path.join(networkStateDirectory,
    `network-member-${sha(`${request.runId}\0${request.teamId}\0${request.memberId}`)}.json`)
  await link(claimPath, memberClaimPath)
  await mkdir(path.join(managerStateDirectory, `supervisor-${operationId}`), { mode: 0o700 })
  const dockerSocketPath = path.join(directory, 'docker.sock')
  const requests: string[] = []
  let networkMarker = marker
  let masquerade = 'false'
  let subnet = '10.250.0.0/28'
  let gateway: string | undefined
  const server = createServer(socket => {
    const chunks: Buffer[] = []
    socket.on('data', chunk => {
      chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const split = bytes.indexOf('\r\n\r\n')
      if (split < 0) return
      const line = bytes.toString('utf8', 0, bytes.indexOf('\r\n'))
      requests.push(line)
      const response = line.includes('/images/') ? JSON.stringify({ Id: imageId,
        RepoDigests: [image], Config: { Labels: {
          'org.agentteams.hosted-opencode.bootstrap-sha256': bootstrapSha256 } } }) :
        JSON.stringify({ Id: networkId, Name: networkName, Driver: 'bridge', Scope: 'local',
          Internal: true, EnableIPv4: true, EnableIPv6: false, Ingress: false,
          Attachable: false, Containers: {},
          Options: { 'com.docker.network.bridge.enable_ip_masquerade': masquerade },
          IPAM: { Config: [{ Subnet: subnet, ...(gateway === undefined ? {} : { Gateway: gateway }) }] }, Labels: {
            'org.agentteams.hosted-opencode.member-network-claim': networkMarker } })
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(response)}\r\n` +
        `Connection: close\r\n\r\n${response}`)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(dockerSocketPath, resolve))
  const serverPasswordKeyPath = path.join(directory, 'server-password-key')
  await writeFile(serverPasswordKeyPath, '1'.repeat(64), { mode: 0o400 })
  const configPath = path.join(directory, 'root-assembly.json')
  const config = { schemaVersion: 1, productDatabasePath: databasePath,
    expectedProductUid: process.getuid!(), workspaceParent: path.dirname(promotion.admittedWorkspaceRoot),
    sandboxWorkspaceRoot: promotion.admittedWorkspaceRoot, profileParent, configParent,
    deploymentId: metadata.binding.deploymentId, bootId: metadata.binding.bootId,
    ownerAuthority: metadata.binding.ownerAuthority,
    ownerGeneration: metadata.binding.ownerGeneration,
    ownerSessionId: metadata.binding.ownerSessionId, runId: metadata.runId,
    memberIds: [metadata.memberId], managerStateDirectory, networkStateDirectory,
    effectClaimDirectory, dockerSocketPath, image, imageId, bootstrapSha256,
    serverPasswordKeyPath }
  await writeFile(configPath, JSON.stringify(config), { mode: 0o400 })
  return { db, configPath, config, metadata, operationId, requests, resultPath,
    claimPath, memberClaimPath,
    setNetworkMarker: (value: string) => { networkMarker = value },
    setMasquerade: (value: string) => { masquerade = value },
    setSubnet: (value: string) => { subnet = value },
    setGateway: (value: string) => { gateway = value } }
}

test('root config composes only read-only proofs and keeps typed effect ports private', async () => {
  const f = await fixture()
  const assembly = await HostedRootInactiveDockerAssembly.load(f.configPath,
    { testOnlyAllowNonRoot: true, now: () => f.metadata.now })
  try {
    expect(await assembly.provePreparedMember(f.metadata.memberId)).toEqual({
      memberId: f.metadata.memberId, operationId: f.operationId,
      networkId, imageId, effectEnabled: false })
    expect(f.requests).toHaveLength(2)
    expect(f.requests.every(value => value.startsWith('GET '))).toBe(true)
    expect(Object.getOwnPropertyNames(assembly)).toEqual([])
  } finally { assembly.close(); f.db.close() }
})

test('invalid or public Docker IPAM subnet denies read-only ownership proof', async () => {
  for (const subnet of ['999.999.999.999/99', '8.8.8.0/24', '10.250.0.1/28',
    '172.15.0.0/12', '172.16.0.0/11', '192.168.0.0/15']) {
    const f = await fixture()
    const assembly = await HostedRootInactiveDockerAssembly.load(f.configPath,
      { testOnlyAllowNonRoot: true, now: () => f.metadata.now })
    try {
      f.setSubnet(subnet)
      await expect(assembly.provePreparedMember(f.metadata.memberId))
        .rejects.toThrow('network-ownership-invalid')
      expect(f.requests.every(value => value.startsWith('GET '))).toBe(true)
    } finally { assembly.close(); f.db.close() }
  }
})

test('private Docker CIDR and gateway above signed IPv4 boundary pass ownership proof', async () => {
  for (const [subnet, gateway] of [
    ['172.16.0.0/12', '172.16.0.1'],
    ['192.168.0.0/16', '192.168.0.1'],
  ]) {
    const f = await fixture()
    const assembly = await HostedRootInactiveDockerAssembly.load(f.configPath,
      { testOnlyAllowNonRoot: true, now: () => f.metadata.now })
    try {
      f.setSubnet(subnet)
      f.setGateway(gateway)
      expect((await assembly.provePreparedMember(f.metadata.memberId)).effectEnabled).toBe(false)
      expect(f.requests.every(value => value.startsWith('GET '))).toBe(true)
    } finally { assembly.close(); f.db.close() }
  }
})

test('unbound manager result and wrong network marker deny before any destructive route', async () => {
  const f = await fixture()
  const assembly = await HostedRootInactiveDockerAssembly.load(f.configPath,
    { testOnlyAllowNonRoot: true, now: () => f.metadata.now })
  try {
    await writeFile(f.resultPath, JSON.stringify({ operationId: f.operationId,
      networkId: 'a'.repeat(64) }), { mode: 0o600 })
    await expect(assembly.provePreparedMember(f.metadata.memberId)).rejects.toThrow()
    expect(f.requests).toHaveLength(0)
  } finally { assembly.close(); f.db.close() }

  const g = await fixture()
  const other = await HostedRootInactiveDockerAssembly.load(g.configPath,
    { testOnlyAllowNonRoot: true, now: () => g.metadata.now })
  try {
    g.setNetworkMarker('0'.repeat(64))
    await expect(other.provePreparedMember(g.metadata.memberId)).rejects.toThrow('network-ownership-invalid')
    expect(g.requests.every(value => value.startsWith('GET '))).toBe(true)
  } finally { other.close(); g.db.close() }

  const h = await fixture()
  const unsafeNetwork = await HostedRootInactiveDockerAssembly.load(h.configPath,
    { testOnlyAllowNonRoot: true, now: () => h.metadata.now })
  try {
    h.setMasquerade('true')
    await expect(unsafeNetwork.provePreparedMember(h.metadata.memberId))
      .rejects.toThrow('network-ownership-invalid')
    expect(h.requests.every(value => value.startsWith('GET '))).toBe(true)
  } finally { unsafeNetwork.close(); h.db.close() }
})

test('retired Product member and forged root config cannot prepare a resource', async () => {
  const f = await fixture()
  const assembly = await HostedRootInactiveDockerAssembly.load(f.configPath,
    { testOnlyAllowNonRoot: true, now: () => f.metadata.now })
  try {
    f.db.query('INSERT INTO hosted_lifecycle_retired_members (run_id, member_id) VALUES (?, ?)')
      .run(f.metadata.runId, f.metadata.memberId)
    await expect(assembly.provePreparedMember(f.metadata.memberId)).rejects.toThrow('member-not-current')
    expect(f.requests).toHaveLength(0)
  } finally { assembly.close(); f.db.close() }
  const g = await fixture()
  try {
    await chmod(g.configPath, 0o600)
    await expect(HostedRootInactiveDockerAssembly.load(g.configPath,
      { testOnlyAllowNonRoot: true, now: () => g.metadata.now }))
      .rejects.toThrow('file-untrusted')
  } finally { g.db.close() }
})

test('same claim bytes from a different inode cannot bind the member network', async () => {
  const f = await fixture()
  const assembly = await HostedRootInactiveDockerAssembly.load(f.configPath,
    { testOnlyAllowNonRoot: true, now: () => f.metadata.now })
  try {
    const bytes = await readFile(f.memberClaimPath)
    await rm(f.memberClaimPath)
    await link(f.claimPath, `${f.claimPath}.other-link`)
    await writeFile(f.memberClaimPath, bytes, { mode: 0o600 })
    await link(f.memberClaimPath, `${f.memberClaimPath}.other-link`)
    await expect(assembly.provePreparedMember(f.metadata.memberId))
      .rejects.toThrow('network-claim-unbound')
    expect(f.requests).toHaveLength(0)
  } finally { assembly.close(); f.db.close() }
})
