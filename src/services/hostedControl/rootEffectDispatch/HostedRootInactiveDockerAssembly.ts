import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync,
  realpathSync } from 'node:fs'
import path from 'node:path'

import type { HostedMemberNetworkRequest } from '../containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'
import { HostedRootSandboxMemberComposition } from './HostedRootSandboxMemberComposition.js'
import { RootDockerContainerClaimWriter } from './RootDockerContainerClaimWriter.js'
import { RootDockerContainerPort } from './RootDockerContainerPort.js'
import { RootDockerExactCleanupPort } from './RootDockerExactCleanupPort.js'
import { RootDockerNetworkCreatePort } from './RootDockerNetworkCreatePort.js'
import { RootDockerReadOnlyProofPort } from './RootDockerReadOnlyProofPort.js'

const SHA = /^[a-f0-9]{64}$/
const IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/
const MARKER = 'org.agentteams.hosted-opencode.member-network-claim'
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')

type Config = Readonly<{
  schemaVersion: 1
  productDatabasePath: string
  expectedProductUid: number
  workspaceParent: string
  sandboxWorkspaceRoot: string
  profileParent: string
  configParent: string
  deploymentId: string
  bootId: string
  ownerAuthority: string
  ownerGeneration: number
  ownerSessionId: string
  runId: string
  memberIds: readonly string[]
  managerStateDirectory: string
  networkStateDirectory: string
  effectClaimDirectory: string
  dockerSocketPath: string
  image: string
  imageId: string
  bootstrapSha256: string
  serverPasswordKeyPath: string
}>

type InactiveBundle = Readonly<{
  networkCreate: RootDockerNetworkCreatePort
  imageNetworkProof: RootDockerReadOnlyProofPort
  claimWriter: RootDockerContainerClaimWriter
  containerPort: RootDockerContainerPort
  cleanupPort: RootDockerExactCleanupPort
}>

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hosted-root-assembly-record-invalid')
  }
  return value as Record<string, unknown>
}

function exact(value: unknown, fields: readonly string[]): boolean {
  try { return Object.keys(object(value)).sort().join(',') === [...fields].sort().join(',') }
  catch { return false }
}

function trustedDirectory(name: string, uid: number, test: boolean): void {
  for (let current = name; ; current = path.dirname(current)) {
    const stat = lstatSync(current)
    const leaf = current === name
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current ||
      (leaf ? stat.uid !== uid || (stat.mode & 0o777) !== 0o700 :
        !test && (stat.uid !== 0 || (stat.mode & 0o022) !== 0))) {
      throw new Error('hosted-root-assembly-directory-untrusted')
    }
    if (current === path.dirname(current)) return
  }
}

function trustedFile(name: string, uid: number, test: boolean, maxBytes: number): Buffer {
  const parent = path.dirname(name)
  trustedDirectory(parent, uid, test)
  const before = lstatSync(name)
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o400 || before.size < 1 || before.size > maxBytes ||
    realpathSync(name) !== name) throw new Error('hosted-root-assembly-file-untrusted')
  const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('hosted-root-assembly-file-substituted')
    }
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

function rootRecord(directory: string, name: string, maxBytes: number, uid: number,
  test: boolean, links = 1): unknown {
  trustedDirectory(directory, uid, test)
  const fd = openSync(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== links ||
      (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > maxBytes) {
      throw new Error('hosted-root-assembly-claim-invalid')
    }
    const bytes = readFileSync(fd)
    if (bytes.length !== stat.size) throw new Error('hosted-root-assembly-claim-invalid')
    return JSON.parse(bytes.toString('utf8')) as unknown
  } finally { closeSync(fd) }
}

function requestDigest(request: HostedMemberNetworkRequest): string {
  return sha(JSON.stringify([request.operationId, request.planTeamId, request.planFingerprint,
    request.runId, request.teamId, request.laneId, request.memberId]))
}

function memberKey(request: HostedMemberNetworkRequest): string {
  return sha(`${request.runId}\0${request.teamId}\0${request.memberId}`)
}

function privateSubnet(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value)
  if (!match) return false
  const octets = match.slice(1, 5).map(Number)
  const prefix = Number(match[5])
  if (octets.some(octet => octet > 255) || prefix < 8 || prefix > 30) return false
  const address = octets.reduce((acc, octet) => (acc << 8) | octet, 0) >>> 0
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  if (((address & mask) >>> 0) !== address) return false
  const private10 = prefix >= 8 && octets[0] === 10
  const private172 = prefix >= 12 && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
  const private192 = prefix >= 16 && octets[0] === 192 && octets[1] === 168
  return private10 || private172 || private192
}

function validIpam(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false
  const entry = object(value[0])
  if (!Object.keys(entry).every(key => key === 'Subnet' || key === 'Gateway') ||
    !privateSubnet(entry.Subnet)) return false
  if (entry.Gateway === undefined) return true
  if (typeof entry.Gateway !== 'string') return false
  const subnet = (entry.Subnet as string).split('/')
  const prefix = Number(subnet[1])
  const subnetAddress = subnet[0].split('.').map(Number)
    .reduce((acc, octet) => (acc << 8) | octet, 0) >>> 0
  const parts = entry.Gateway.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false
  const gateway = parts.map(Number).reduce((acc, octet) => (acc << 8) | octet, 0) >>> 0
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return ((gateway & mask) >>> 0) === subnetAddress && gateway !== subnetAddress &&
    gateway !== ((subnetAddress | ~mask) >>> 0)
}

/** Root-owned config and prepared-resource binding. No effect port escapes this inactive adapter. */
export class HostedRootInactiveDockerAssembly {
  readonly #bundles = new Map<string, InactiveBundle>()
  readonly #config: Config
  readonly #product: HostedRootSandboxMemberComposition
  readonly #uid: number
  readonly #test: boolean

  private constructor(config: Config, product: HostedRootSandboxMemberComposition,
    uid: number, test: boolean) {
    this.#config = config
    this.#product = product
    this.#uid = uid
    this.#test = test
  }

  assertRuntimePins(expected: Readonly<{ image: string; bootstrapSha256: string;
    workspaceParent: string; profileParent: string; configParent: string;
    managerStateDirectory: string; networkStateDirectory: string;
    serverPasswordKeyPath: string }>): void {
    const actual = this.#config
    if (!expected || Object.keys(expected).sort().join(',') !== [
      'image', 'bootstrapSha256', 'workspaceParent', 'profileParent', 'configParent',
      'managerStateDirectory', 'networkStateDirectory', 'serverPasswordKeyPath',
    ].sort().join(',') || Object.keys(expected).some(key =>
      expected[key as keyof typeof expected] !== actual[key as keyof Config])) {
      throw new Error('hosted-root-assembly-runtime-pins-conflict')
    }
  }

  async prepareMember(memberId: string): Promise<Readonly<{ memberId: string;
    operationId: string; effectEnabled: false }>> {
    const member = this.#product.member(memberId)
    await this.#product.prepareProof(memberId)
    return Object.freeze({ memberId, operationId: member.request.operationId, effectEnabled: false })
  }

  async observeMember(memberId: string): Promise<Readonly<{ memberId: string;
    operationId: string; effectEnabled: false }>> {
    const member = this.#product.member(memberId)
    await this.#product.observe(memberId)
    return Object.freeze({ memberId, operationId: member.request.operationId, effectEnabled: false })
  }

  async observeConfiguredMembers(): Promise<readonly Readonly<{ memberId: string;
    operationId: string; effectEnabled: false }>[]> {
    const results = []
    for (const memberId of this.#config.memberIds) results.push(await this.observeMember(memberId))
    return Object.freeze(results)
  }

  static async load(configPath: string, options: { testOnlyAllowNonRoot?: boolean; now?: () => number } = {}):
    Promise<HostedRootInactiveDockerAssembly> {
    const test = options.testOnlyAllowNonRoot === true && process.env.NODE_ENV === 'test'
    if (!test && (process.platform !== 'linux' || process.getuid?.() !== 0) ||
      typeof configPath !== 'string' || !path.isAbsolute(configPath) ||
      path.normalize(configPath) !== configPath) throw new Error('hosted-root-assembly-policy-invalid')
    const uid = process.getuid?.() ?? -1
    const config = object(JSON.parse(trustedFile(configPath, uid, test, 8192).toString('utf8')))
    const fields = ['schemaVersion', 'productDatabasePath', 'expectedProductUid', 'workspaceParent',
      'sandboxWorkspaceRoot', 'profileParent', 'configParent', 'deploymentId', 'bootId',
      'ownerAuthority', 'ownerGeneration', 'ownerSessionId', 'runId', 'memberIds',
      'managerStateDirectory', 'networkStateDirectory', 'effectClaimDirectory', 'dockerSocketPath',
      'image', 'imageId', 'bootstrapSha256', 'serverPasswordKeyPath']
    if (!exact(config, fields) || config.schemaVersion !== 1 ||
      typeof config.image !== 'string' || !IMAGE.test(config.image) ||
      typeof config.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(config.imageId) ||
      typeof config.bootstrapSha256 !== 'string' || !SHA.test(config.bootstrapSha256)) {
      throw new Error('hosted-root-assembly-config-invalid')
    }
    for (const field of ['productDatabasePath', 'workspaceParent', 'sandboxWorkspaceRoot',
      'profileParent', 'configParent', 'managerStateDirectory', 'networkStateDirectory',
      'effectClaimDirectory', 'dockerSocketPath', 'serverPasswordKeyPath']) {
      const value = config[field]
      if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
        throw new Error('hosted-root-assembly-config-invalid')
      }
    }
    if (!test && !['/var/run/docker.sock', '/run/docker.sock'].includes(config.dockerSocketPath as string)) {
      throw new Error('hosted-root-assembly-config-invalid')
    }
    for (const field of ['managerStateDirectory', 'networkStateDirectory', 'effectClaimDirectory',
      'workspaceParent', 'profileParent', 'configParent']) {
      if (test && field === 'workspaceParent') continue // The Product v35 fixture pins an inert /sandbox root.
      trustedDirectory(config[field] as string, uid, test)
    }
    const keyHex = trustedFile(config.serverPasswordKeyPath as string, uid, test, 64).toString('ascii').trim()
    if (!SHA.test(keyHex)) throw new Error('hosted-root-assembly-password-key-invalid')
    const product = await HostedRootSandboxMemberComposition.create({
      databasePath: config.productDatabasePath as string,
      expectedProductUid: config.expectedProductUid as number,
      workspaceParent: config.workspaceParent as string,
      sandboxWorkspaceRoot: config.sandboxWorkspaceRoot as string,
      deploymentId: config.deploymentId as string, bootId: config.bootId as string,
      ownerAuthority: config.ownerAuthority as string,
      ownerGeneration: config.ownerGeneration as number,
      ownerSessionId: config.ownerSessionId as string, runId: config.runId as string,
      memberIds: config.memberIds as string[], now: options.now,
      testOnlyAllowNonRoot: test,
    })
    return new HostedRootInactiveDockerAssembly(Object.freeze(config as Config), product, uid, test)
  }

  private preparedNetwork(memberId: string): Readonly<{ networkId: string; marker: string; name: string;
    supervisorDirectory: string }> {
    const member = this.#product.member(memberId)
    const request = member.request
    const operation = rootRecord(this.#config.managerStateDirectory,
      `operation-${request.operationId}.json`, 2048, this.#uid, this.#test)
    const expectedOperation = { request, directoryName: `supervisor-${request.operationId}` }
    if (JSON.stringify(operation) !== JSON.stringify(expectedOperation)) {
      throw new Error('hosted-root-assembly-manager-operation-unbound')
    }
    const managerMember = rootRecord(this.#config.managerStateDirectory,
      `member-${memberKey(request)}.json`, 2048, this.#uid, this.#test)
    if (JSON.stringify(managerMember) !== JSON.stringify(expectedOperation)) {
      throw new Error('hosted-root-assembly-manager-member-unbound')
    }
    const result = rootRecord(this.#config.managerStateDirectory,
      `network-result-${request.operationId}.json`, 2048, this.#uid, this.#test)
    if (!exact(result, ['operationId', 'networkId']) ||
      (result as Record<string, unknown>).operationId !== request.operationId ||
      typeof (result as Record<string, unknown>).networkId !== 'string' ||
      !SHA.test((result as Record<string, string>).networkId)) {
      throw new Error('hosted-root-assembly-network-result-invalid')
    }
    const networkId = (result as { networkId: string }).networkId
    const index = rootRecord(this.#config.managerStateDirectory,
      `network-id-${networkId}.json`, 2048, this.#uid, this.#test)
    if (JSON.stringify(index) !== JSON.stringify(result)) {
      throw new Error('hosted-root-assembly-network-index-unbound')
    }
    const networkOperation = rootRecord(this.#config.networkStateDirectory,
      `network-operation-${request.operationId}.json`, 256, this.#uid, this.#test, 2)
    const networkMember = rootRecord(this.#config.networkStateDirectory,
      `network-member-${memberKey(request)}.json`, 256, this.#uid, this.#test, 2)
    const networkOperationFile = lstatSync(path.join(this.#config.networkStateDirectory,
      `network-operation-${request.operationId}.json`))
    const networkMemberFile = lstatSync(path.join(this.#config.networkStateDirectory,
      `network-member-${memberKey(request)}.json`))
    if (JSON.stringify(networkMember) !== JSON.stringify(networkOperation) ||
      networkOperationFile.dev !== networkMemberFile.dev ||
      networkOperationFile.ino !== networkMemberFile.ino ||
      !exact(networkOperation, ['requestSha256', 'name', 'nonce'])) {
      throw new Error('hosted-root-assembly-network-claim-unbound')
    }
    const claim = networkOperation as Record<string, unknown>
    if (claim.requestSha256 !== requestDigest(request) ||
      typeof claim.name !== 'string' || !/^hat-member-[a-f0-9]{32}$/.test(claim.name) ||
      typeof claim.nonce !== 'string' || !SHA.test(claim.nonce)) {
      throw new Error('hosted-root-assembly-network-claim-unbound')
    }
    const supervisorDirectory = path.join(this.#config.managerStateDirectory,
      `supervisor-${request.operationId}`)
    trustedDirectory(supervisorDirectory, this.#uid, this.#test)
    return { networkId, marker: claim.nonce as string, name: claim.name as string,
      supervisorDirectory }
  }

  /** Read-only proof, then private construction. Returns no effect capability or credential. */
  async provePreparedMember(memberId: string): Promise<Readonly<{ memberId: string;
    operationId: string; networkId: string; imageId: string; effectEnabled: false }>> {
    const member = this.#product.member(memberId)
    await this.#product.prepareProof(memberId)
    const network = this.preparedNetwork(memberId)
    const proof = RootDockerReadOnlyProofPort.create({
      effectClaimDirectory: this.#config.effectClaimDirectory,
      socketPath: this.#config.dockerSocketPath,
      authority: member.authority, binding: member.binding,
      image: this.#config.image, imageId: this.#config.imageId,
      bootstrapSha256: this.#config.bootstrapSha256, networkId: network.networkId,
      testOnlyAllowNonRoot: this.#test,
    })
    await proof.inspectImage()
    const observedNetwork = await proof.inspectNetwork()
    const labels = object(observedNetwork.Labels)
    const options = object(observedNetwork.Options)
    const ipamConfig = object(observedNetwork.IPAM).Config
    if (observedNetwork.Name !== network.name ||
      Object.keys(labels).length !== 1 || labels[MARKER] !== network.marker ||
      Object.keys(object(observedNetwork.Containers)).length !== 0 ||
      observedNetwork.EnableIPv4 !== true || observedNetwork.Ingress === true ||
      observedNetwork.Attachable === true ||
      options['com.docker.network.bridge.enable_ip_masquerade'] !== 'false' ||
      !validIpam(ipamConfig)) {
      throw new Error('hosted-root-assembly-network-ownership-invalid')
    }
    const keyHex = trustedFile(this.#config.serverPasswordKeyPath, this.#uid, this.#test, 64)
      .toString('ascii').trim()
    if (!SHA.test(keyHex)) throw new Error('hosted-root-assembly-password-key-invalid')
    const key = Buffer.from(keyHex, 'hex')
    try {
      const claimWriter = RootDockerContainerClaimWriter.create({
        stateDirectory: network.supervisorDirectory, authority: member.authority,
        binding: member.binding, image: this.#config.image, networkId: network.networkId,
        workspaceParent: this.#config.workspaceParent, profileParent: this.#config.profileParent,
        configParent: this.#config.configParent, testOnlyAllowNonRoot: this.#test,
      })
      const containerPort = RootDockerContainerPort.create({
        stateDirectory: network.supervisorDirectory,
        effectClaimDirectory: this.#config.effectClaimDirectory,
        socketPath: this.#config.dockerSocketPath, authority: member.authority,
        binding: member.binding, image: this.#config.image, networkId: network.networkId,
        serverPasswordKey: key, readOnlyProof: proof, testOnlyAllowNonRoot: this.#test,
      })
      const cleanupPort = RootDockerExactCleanupPort.create({
        stateDirectory: network.supervisorDirectory,
        effectClaimDirectory: this.#config.effectClaimDirectory,
        socketPath: this.#config.dockerSocketPath, binding: member.binding,
        image: this.#config.image, imageId: this.#config.imageId,
        networkId: network.networkId, workspaceParent: this.#config.workspaceParent,
        profileParent: this.#config.profileParent, configParent: this.#config.configParent,
        testOnlyAllowNonRoot: this.#test,
      })
      const networkCreate = RootDockerNetworkCreatePort.create({
        stateDirectory: this.#config.networkStateDirectory,
        effectClaimDirectory: this.#config.effectClaimDirectory,
        socketPath: this.#config.dockerSocketPath, authority: member.authority,
        assertDockerApiCompatible: async () => false, testOnlyAllowNonRoot: this.#test,
      })
      this.#bundles.set(memberId, Object.freeze({ networkCreate, imageNetworkProof: proof,
        claimWriter, containerPort, cleanupPort }))
      return Object.freeze({ memberId, operationId: member.request.operationId,
        networkId: network.networkId, imageId: this.#config.imageId, effectEnabled: false })
    } finally { key.fill(0) }
  }

  close(): void { this.#bundles.clear(); this.#product.close() }
}
