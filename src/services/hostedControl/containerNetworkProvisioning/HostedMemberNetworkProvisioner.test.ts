import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, chmod, mkdir, readFile, readdir, realpath, rename, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { HostedMemberNetworkProvisioner, isExactDockerNetworkNotFound, type HostedMemberNetworkDockerPort,
  type HostedMemberNetworkRequest } from './HostedMemberNetworkProvisioner.js'

const ID = 'a'.repeat(64)
const MARKER = 'org.agentteams.hosted-opencode.member-network-claim'
const REQUEST: HostedMemberNetworkRequest = {
  operationId: 'operation001', planTeamId: 'planteam001', planFingerprint: 'b'.repeat(64),
  runId: 'running001', teamId: 'team00001', laneId: 'lane00001', memberId: 'member001',
}

class FakeDocker implements HostedMemberNetworkDockerPort {
  network: Record<string, unknown> | null = null
  createCalls = 0
  removed: string[] = []
  crashAfterCreate = false
  crashAfterRemove = false
  failInspectAfterRemove = false
  private failNextInspect = false
  compatible = true

  async assertCompatible(): Promise<void> {
    if (!this.compatible) throw new Error('hosted-network-docker-v28-required')
  }

  async create(name: string, marker: string): Promise<string> {
    this.createCalls++
    this.network = {
      Id: ID, Name: name, Driver: 'bridge', Scope: 'local', Internal: true,
      Ingress: false, Attachable: false, EnableIPv4: true, EnableIPv6: false,
      Options: { 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
      Labels: { [MARKER]: marker }, Containers: {},
      IPAM: { Config: [{ Subnet: '172.29.0.0/24', Gateway: '172.29.0.1' }] },
    }
    if (this.crashAfterCreate) throw new Error('simulated-lost-create-response')
    return ID
  }

  async inspect(nameOrId: string): Promise<Record<string, unknown> | null> {
    if (this.failNextInspect) {
      this.failNextInspect = false
      throw new Error('simulated-docker-inspect-outage')
    }
    return this.network && (this.network.Id === nameOrId || this.network.Name === nameOrId)
      ? this.network : null
  }

  async remove(id: string): Promise<void> {
    if (!this.network || this.network.Id !== id) throw new Error('fake-network-missing')
    this.removed.push(id)
    this.network = null
    if (this.failInspectAfterRemove) this.failNextInspect = true
    if (this.crashAfterRemove) throw new Error('simulated-lost-remove-response')
  }
}

const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function fixture(admit = async () => true,
  beforePublish?: (kind: 'result' | 'cleanup-intent' | 'cleanup-terminal') => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hosted-network-test-')))
  directories.push(root)
  const stateDirectory = path.join(root, 'state')
  await mkdir(stateDirectory, { mode: 0o700 })
  await chmod(stateDirectory, 0o700)
  const docker = new FakeDocker()
  const provisioner = await HostedMemberNetworkProvisioner.create({
    stateDirectory, admitMember: admit, testOnlyDocker: docker, testOnlyAllowNonRoot: true,
    testOnlyBeforePublish: beforePublish,
  })
  return { provisioner, docker, stateDirectory }
}

describe('HostedMemberNetworkProvisioner', () => {
  test('Docker 29 exact missing-network stderr is absence only for the inspected ID or name', () => {
    const otherId = 'c'.repeat(64)
    const name = `hat-member-${'d'.repeat(32)}`
    expect(isExactDockerNetworkNotFound(`Error response from daemon: network ${ID} not found\n`, ID)).toBe(true)
    expect(isExactDockerNetworkNotFound(`network ${name} not found`, name)).toBe(true)
    expect(isExactDockerNetworkNotFound(`Error: No such network: ${ID}`, ID)).toBe(true)
    expect(isExactDockerNetworkNotFound(`Error response from daemon: network ${otherId} not found`, ID)).toBe(false)
    expect(isExactDockerNetworkNotFound(`Error response from daemon: network ${ID} not found\npermission denied`, ID))
      .toBe(false)
    expect(isExactDockerNetworkNotFound(`Error response from daemon: network ${ID} has active endpoints`, ID))
      .toBe(false)
  })

  test('issues an exact Docker ID for a fresh internal IPv4 network', async () => {
    const f = await fixture()
    expect(await f.provisioner.provision(REQUEST)).toBe(ID)
    expect(f.docker.createCalls).toBe(1)
    expect(f.docker.network?.Internal).toBe(true)
    expect(f.docker.network?.EnableIPv6).toBe(false)
    const reordered = Object.fromEntries(Object.entries(REQUEST).reverse()) as HostedMemberNetworkRequest
    expect(await f.provisioner.reconcile(reordered)).toBe(ID)
  })

  test('lost create response recovers the marked network without a second create', async () => {
    const f = await fixture()
    f.docker.crashAfterCreate = true
    await expect(f.provisioner.provision(REQUEST)).rejects.toThrow('simulated-lost-create-response')
    expect(await f.provisioner.reconcile(REQUEST)).toBe(ID)
    expect(f.docker.createCalls).toBe(1)
    await expect(f.provisioner.provision(REQUEST)).rejects.toThrow('hosted-network-operation-already-claimed')
  })

  test('a crash before publishing the result leaves no partial final record and can reconcile', async () => {
    let fail = true
    const f = await fixture(async () => true, async kind => {
      if (kind === 'result' && fail) throw new Error('simulated-crash-before-publication')
    })
    await expect(f.provisioner.provision(REQUEST)).rejects.toThrow('simulated-crash-before-publication')
    expect(await readdir(f.stateDirectory)).not.toContain(`network-result-${REQUEST.operationId}.json`)
    expect((await readdir(f.stateDirectory)).some(name => name.startsWith(
      `network-result-${REQUEST.operationId}.json.stage-`))).toBe(true)
    fail = false
    expect(await f.provisioner.reconcile(REQUEST)).toBe(ID)
    expect(await readFile(path.join(f.stateDirectory, `network-result-${REQUEST.operationId}.json`), 'utf8'))
      .toBe(ID)
    expect(f.docker.createCalls).toBe(1)
  })

  test('duplicate member under another operation cannot create a second network', async () => {
    const f = await fixture()
    await f.provisioner.provision(REQUEST)
    await expect(f.provisioner.provision({ ...REQUEST, operationId: 'operation002' }))
      .rejects.toThrow('hosted-network-member-already-claimed')
    expect(f.docker.createCalls).toBe(1)
  })

  test('revoked admission blocks recovery but permits exact claimed cleanup and replay', async () => {
    let admitted = true
    const f = await fixture(async () => admitted)
    await f.provisioner.provision(REQUEST)
    admitted = false
    await expect(f.provisioner.reconcile(REQUEST)).rejects.toThrow('hosted-network-member-not-admitted')
    await f.provisioner.cleanup(REQUEST)
    await f.provisioner.cleanup(REQUEST)
    expect(f.docker.removed).toEqual([ID])
  })

  test('admission withdrawn after claim prevents Docker create', async () => {
    let checks = 0
    const f = await fixture(async () => ++checks === 1)
    await expect(f.provisioner.provision(REQUEST)).rejects.toThrow('hosted-network-member-not-admitted')
    expect(f.docker.createCalls).toBe(0)
  })

  test('foreign endpoint and changed marker both block reconciliation and cleanup', async () => {
    const f = await fixture()
    await f.provisioner.provision(REQUEST)
    f.docker.network!.Containers = { foreign: { Name: 'foreign' } }
    await expect(f.provisioner.cleanup(REQUEST)).rejects.toThrow('hosted-network-unverified')
    f.docker.network!.Containers = {}
    f.docker.network!.Labels = { [MARKER]: 'c'.repeat(64) }
    await expect(f.provisioner.reconcile(REQUEST)).rejects.toThrow('hosted-network-unverified')
    expect(f.docker.removed).toEqual([])
  })

  test('revoked cleanup refuses a foreign endpoint and changed network ID', async () => {
    let admitted = true
    const f = await fixture(async () => admitted)
    await f.provisioner.provision(REQUEST)
    admitted = false
    f.docker.network!.Containers = { foreign: { Name: 'foreign' } }
    await expect(f.provisioner.cleanup(REQUEST)).rejects.toThrow('hosted-network-unverified')
    f.docker.network!.Containers = {}
    f.docker.network!.Id = 'c'.repeat(64)
    await expect(f.provisioner.cleanup(REQUEST)).rejects.toThrow('hosted-network-unresolved')
    expect(f.docker.removed).toEqual([])
    expect(await readdir(f.stateDirectory)).not.toContain(`network-cleanup-intent-${REQUEST.operationId}.json`)
  })

  test('revoked cleanup cannot replay a claim with another member identity', async () => {
    let admitted = true
    const f = await fixture(async () => admitted)
    await f.provisioner.provision(REQUEST)
    admitted = false
    await expect(f.provisioner.cleanup({ ...REQUEST, memberId: 'member002' })).rejects.toThrow()
    await expect(f.provisioner.cleanup({ ...REQUEST, laneId: 'lane00002' }))
      .rejects.toThrow('hosted-network-claim-invalid')
    expect(f.docker.removed).toEqual([])
    await f.provisioner.cleanup(REQUEST)
    expect(f.docker.removed).toEqual([ID])
  })

  test('missing durable result after crash remains residue under revoked admission', async () => {
    let admitted = true
    const f = await fixture(async () => admitted, async kind => {
      if (kind === 'result') throw new Error('simulated-crash-before-result-publication')
    })
    await expect(f.provisioner.provision(REQUEST))
      .rejects.toThrow('simulated-crash-before-result-publication')
    admitted = false
    await expect(f.provisioner.cleanup(REQUEST)).rejects.toThrow('hosted-network-cleanup-id-unresolved')
    expect(f.docker.network?.Id).toBe(ID)
    expect(f.docker.removed).toEqual([])
    expect(await readdir(f.stateDirectory)).not.toContain(`network-cleanup-intent-${REQUEST.operationId}.json`)
  })

  test('an IPv6 or masquerading policy drift cannot be returned as a usable network', async () => {
    const f = await fixture()
    await f.provisioner.provision(REQUEST)
    f.docker.network!.EnableIPv6 = true
    await expect(f.provisioner.reconcile(REQUEST)).rejects.toThrow('hosted-network-unverified')
    f.docker.network!.EnableIPv6 = false
    f.docker.network!.Options = { 'com.docker.network.bridge.enable_ip_masquerade': 'true' }
    await expect(f.provisioner.reconcile(REQUEST)).rejects.toThrow('hosted-network-unverified')
  })

  test('a recreated network with the same name and marker cannot replace the recorded Docker ID', async () => {
    const f = await fixture()
    await f.provisioner.provision(REQUEST)
    f.docker.network!.Id = 'c'.repeat(64)
    await expect(f.provisioner.reconcile(REQUEST)).rejects.toThrow('hosted-network-unverified')
    expect(f.docker.removed).toEqual([])
  })

  test('cleanup removes only the exact marked empty network ID', async () => {
    const f = await fixture()
    await f.provisioner.provision(REQUEST)
    await f.provisioner.cleanup(REQUEST)
    expect(f.docker.removed).toEqual([ID])
    await f.provisioner.cleanup(REQUEST)
    expect(f.docker.removed).toEqual([ID])
  })

  test('lost remove response with temporary inspect outage recovers from durable intent', async () => {
    const f = await fixture()
    await f.provisioner.provision(REQUEST)
    f.docker.crashAfterRemove = true
    f.docker.failInspectAfterRemove = true
    await expect(f.provisioner.cleanup(REQUEST)).rejects.toThrow('simulated-docker-inspect-outage')
    expect(await readFile(path.join(f.stateDirectory,
      `network-cleanup-intent-${REQUEST.operationId}.json`), 'utf8')).toBe(ID)
    expect(await readdir(f.stateDirectory)).not.toContain(`network-cleanup-terminal-${REQUEST.operationId}.json`)
    await f.provisioner.cleanup(REQUEST)
    expect(await readFile(path.join(f.stateDirectory,
      `network-cleanup-terminal-${REQUEST.operationId}.json`), 'utf8')).toBe(ID)
    expect(f.docker.removed).toEqual([ID])
  })

  test('Docker version incompatibility fails before a durable claim', async () => {
    const f = await fixture()
    f.docker.compatible = false
    await expect(f.provisioner.provision(REQUEST)).rejects.toThrow('hosted-network-docker-v28-required')
    expect(await readdir(f.stateDirectory)).toEqual([])
  })

  test('ancestor symlink substitution cannot redirect claims into another directory', async () => {
    const f = await fixture()
    const root = path.dirname(f.stateDirectory)
    const moved = `${root}-moved`
    await rename(root, moved)
    directories.push(moved)
    const foreignRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hosted-network-foreign-')))
    directories.push(foreignRoot)
    await mkdir(path.join(foreignRoot, 'state'), { mode: 0o700 })
    await symlink(foreignRoot, root, 'dir')
    await expect(f.provisioner.provision(REQUEST)).rejects.toThrow('hosted-network-state-directory-invalid')
    expect(await readdir(path.join(foreignRoot, 'state'))).toEqual([])
    expect(f.docker.createCalls).toBe(0)
  })

  test('production cannot inject Docker and admission is mandatory', async () => {
    const f = await fixture()
    await expect(HostedMemberNetworkProvisioner.create({
      stateDirectory: f.stateDirectory, admitMember: async () => true, testOnlyDocker: f.docker,
    })).rejects.toThrow('hosted-network-root-required')
    await expect(HostedMemberNetworkProvisioner.create({
      stateDirectory: f.stateDirectory, admitMember: undefined as never,
      testOnlyDocker: f.docker, testOnlyAllowNonRoot: true,
    })).rejects.toThrow('hosted-network-authority-required')
  })
})
