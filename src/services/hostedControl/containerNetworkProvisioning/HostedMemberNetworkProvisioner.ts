import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'

const ID = /^[a-z0-9][a-z0-9_-]{7,95}$/
const SHA = /^[0-9a-f]{64}$/
const NETWORK_ID = /^[0-9a-f]{64}$/
const MARKER = 'org.agentteams.hosted-opencode.member-network-claim'

export type HostedMemberNetworkRequest = Readonly<{
  operationId: string
  planTeamId: string
  planFingerprint: string
  runId: string
  teamId: string
  laneId: string
  memberId: string
}>

type Claim = Readonly<{ requestSha256: string; name: string; nonce: string }>
type Network = Record<string, unknown>

export interface HostedMemberNetworkDockerPort {
  assertCompatible(): Promise<void>
  create(name: string, marker: string): Promise<string>
  inspect(nameOrId: string): Promise<Network | null>
  remove(id: string): Promise<void>
}

/** Docker 29 reports an absent network differently from earlier Docker CLI versions. */
export function isExactDockerNetworkNotFound(stderr: string, reference: string): boolean {
  if (!NETWORK_ID.test(reference) && !/^hat-member-[0-9a-f]{32}$/.test(reference)) return false
  const message = stderr.trim()
  return message === `Error: No such network: ${reference}` ||
    message === `Error response from daemon: network ${reference} not found` ||
    message === `Error: network ${reference} not found` ||
    message === `network ${reference} not found`
}

/** Root-only Docker surface. Owner supplies no Docker arguments, names, or labels. */
class DockerCliNetworkPort implements HostedMemberNetworkDockerPort {
  private run(...args: string[]): Promise<string | null> {
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/docker', args, {
        timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
        env: { PATH: '/usr/bin:/bin', HOME: '/root', DOCKER_HOST: 'unix:///var/run/docker.sock' },
      }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim())
        if (args[0] === 'network' && args[1] === 'inspect' && error.code === 1 && !error.killed &&
          isExactDockerNetworkNotFound(String(stderr), args[4] ?? '')) return resolve(null)
        reject(new Error('hosted-network-docker-command-failed'))
      })
    })
  }

  async assertCompatible(): Promise<void> {
    const versions = await this.run('version', '--format', '{{.Client.Version}} {{.Server.Version}}')
    const parts = versions?.split(/\s+/)
    if (!parts || parts.length !== 2 || parts.some(version => {
      const major = /^(\d+)\./.exec(version)?.[1]
      return !major || Number(major) < 28
    })) throw new Error('hosted-network-docker-v28-required')
  }

  async create(name: string, marker: string): Promise<string> {
    const id = await this.run('network', 'create', '--driver', 'bridge', '--internal',
      '--ipv4=true', '--ipv6=false', '--opt', 'com.docker.network.bridge.enable_ip_masquerade=false',
      '--label', `${MARKER}=${marker}`, name)
    if (!id || !NETWORK_ID.test(id)) throw new Error('hosted-network-create-result-invalid')
    return id
  }

  async inspect(nameOrId: string): Promise<Network | null> {
    const result = await this.run('network', 'inspect', '--format', '{{json .}}', nameOrId)
    if (result === null) return null
    try { return object(JSON.parse(result)) }
    catch { throw new Error('hosted-network-inspect-invalid') }
  }

  async remove(id: string): Promise<void> {
    await this.run('network', 'rm', id)
  }
}

function object(value: unknown): Network {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hosted-network-inspect-invalid')
  }
  return value as Network
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }

function requestDigest(request: HostedMemberNetworkRequest): string {
  return sha(JSON.stringify([request.operationId, request.planTeamId, request.planFingerprint,
    request.runId, request.teamId, request.laneId, request.memberId]))
}

function validRequest(request: HostedMemberNetworkRequest): void {
  if (!request || Object.keys(request).sort().join(',') !==
    ['operationId', 'planTeamId', 'planFingerprint', 'runId', 'teamId', 'laneId', 'memberId'].sort().join(',') ||
    ![request.operationId, request.planTeamId, request.runId, request.teamId, request.laneId,
      request.memberId].every(value => typeof value === 'string' && ID.test(value)) ||
    !SHA.test(request.planFingerprint)) throw new Error('hosted-network-request-invalid')
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function assertTrustedAncestors(directory: string): Promise<void> {
  for (let current = path.dirname(directory); ; current = path.dirname(current)) {
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 || await realpath(current) !== current) {
      throw new Error('hosted-network-state-ancestor-untrusted')
    }
    if (current === path.dirname(current)) return
  }
}

export type HostedMemberNetworkProvisionerOptions = Readonly<{
  stateDirectory: string
  /** Independent trusted plan authority, checked again on provision and reconcile. */
  admitMember(request: HostedMemberNetworkRequest): Promise<boolean>
  /** Inert fixture only; production always uses root-owned Docker CLI. */
  testOnlyDocker?: HostedMemberNetworkDockerPort
  testOnlyAllowNonRoot?: boolean
  /** Simulates a crash between a durable staging write and atomic publication. */
  testOnlyBeforePublish?: (kind: 'result' | 'cleanup-intent' | 'cleanup-terminal') => Promise<void>
}>

/** A claim is a single attempt; recovery never issues a second Docker create. */
export class HostedMemberNetworkProvisioner {
  private readonly docker: HostedMemberNetworkDockerPort
  private readonly uid: number

  private constructor(private readonly options: HostedMemberNetworkProvisionerOptions,
    private readonly stateIdentity: Readonly<{ dev: number; ino: number }>) {
    this.docker = options.testOnlyDocker ?? new DockerCliNetworkPort()
    this.uid = process.getuid!()
  }

  static async create(options: HostedMemberNetworkProvisionerOptions): Promise<HostedMemberNetworkProvisioner> {
    if (options.testOnlyAllowNonRoot) {
      if (process.env.NODE_ENV !== 'test' || !options.testOnlyDocker) {
        throw new Error('hosted-network-test-mode-forbidden')
      }
    } else if (process.platform !== 'linux' || process.getuid?.() !== 0 || options.testOnlyDocker ||
      options.testOnlyBeforePublish) {
      throw new Error('hosted-network-root-required')
    }
    if (typeof options.admitMember !== 'function') throw new Error('hosted-network-authority-required')
    const directory = options.stateDirectory
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || /[,=]/.test(directory)) {
      throw new Error('hosted-network-state-path-invalid')
    }
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) {
      throw new Error('hosted-network-state-directory-invalid')
    }
    if (!options.testOnlyAllowNonRoot) await assertTrustedAncestors(directory)
    return new HostedMemberNetworkProvisioner(options, { dev: stat.dev, ino: stat.ino })
  }

  private async assertStateDirectory(): Promise<void> {
    const directory = this.options.stateDirectory
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.stateIdentity.dev ||
      stat.ino !== this.stateIdentity.ino || stat.uid !== this.uid ||
      (stat.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) {
      throw new Error('hosted-network-state-directory-invalid')
    }
    if (!this.options.testOnlyAllowNonRoot) await assertTrustedAncestors(directory)
  }

  private async syncStateDirectory(): Promise<void> {
    await this.assertStateDirectory()
    await syncDirectory(this.options.stateDirectory)
  }

  private operationPath(operationId: string): string {
    return path.join(this.options.stateDirectory, `network-operation-${operationId}.json`)
  }

  private memberPath(request: HostedMemberNetworkRequest): string {
    return path.join(this.options.stateDirectory,
      `network-member-${sha(`${request.runId}\0${request.teamId}\0${request.memberId}`)}.json`)
  }

  private durablePath(kind: 'result' | 'cleanup-intent' | 'cleanup-terminal', operationId: string): string {
    return path.join(this.options.stateDirectory, `network-${kind}-${operationId}.json`)
  }

  private async admitted(request: HostedMemberNetworkRequest): Promise<void> {
    validRequest(request)
    if (!await this.options.admitMember(request)) throw new Error('hosted-network-member-not-admitted')
  }

  private async readClaim(request: HostedMemberNetworkRequest): Promise<Claim> {
    await this.assertStateDirectory()
    const operation = await open(this.operationPath(request.operationId), constants.O_RDONLY | constants.O_NOFOLLOW)
    let member
    try { member = await open(this.memberPath(request), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { await operation.close(); throw error }
    try {
      await this.assertStateDirectory()
      const [a, b] = await Promise.all([operation.stat(), member.stat()])
      if (!a.isFile() || a.nlink !== 2 || a.uid !== this.uid || (a.mode & 0o777) !== 0o600 ||
        a.size > 256 || a.ino !== b.ino || a.dev !== b.dev) throw new Error('hosted-network-claim-invalid')
      const claim = object(JSON.parse(await operation.readFile('utf8')))
      if (Object.keys(claim).sort().join(',') !== ['requestSha256', 'name', 'nonce'].sort().join(',') ||
        claim.requestSha256 !== requestDigest(request) ||
        typeof claim.name !== 'string' || !/^hat-member-[0-9a-f]{32}$/.test(claim.name) ||
        typeof claim.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(claim.nonce)) {
        throw new Error('hosted-network-claim-invalid')
      }
      return claim as Claim
    } finally { await operation.close(); await member.close() }
  }

  private async readDurableId(kind: 'result' | 'cleanup-intent' | 'cleanup-terminal',
    operationId: string): Promise<string | null> {
    await this.assertStateDirectory()
    let handle
    try { handle = await open(this.durablePath(kind, operationId), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
    try {
      const stat = await handle.stat()
      // A crash after link but before unlink can leave the fully synced staging hardlink.
      if (!stat.isFile() || stat.nlink < 1 || stat.nlink > 2 || stat.uid !== this.uid ||
        (stat.mode & 0o777) !== 0o600 || stat.size !== 64) throw new Error(`hosted-network-${kind}-invalid`)
      const id = await handle.readFile('utf8')
      if (!NETWORK_ID.test(id)) throw new Error(`hosted-network-${kind}-invalid`)
      return id
    } finally { await handle.close() }
  }

  private async writeDurableId(kind: 'result' | 'cleanup-intent' | 'cleanup-terminal',
    operationId: string, id: string): Promise<void> {
    const published = this.durablePath(kind, operationId)
    const existing = await this.readDurableId(kind, operationId)
    if (existing === id) {
      // The final hardlink may be visible after a crash but not yet directory-synced.
      await this.syncStateDirectory()
      return
    }
    if (existing) throw new Error(`hosted-network-${kind}-conflict`)
    const staging = `${published}.stage-${randomBytes(16).toString('hex')}`
    await this.assertStateDirectory()
    const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600)
    try { await handle.writeFile(id); await handle.sync() } finally { await handle.close() }
    await this.options.testOnlyBeforePublish?.(kind)
    await this.assertStateDirectory()
    try { await link(staging, published) }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST' ||
        await this.readDurableId(kind, operationId) !== id) {
        throw new Error(`hosted-network-${kind}-conflict`)
      }
    }
    await this.syncStateDirectory()
    await this.assertStateDirectory()
    await unlink(staging)
    await this.syncStateDirectory()
  }

  private verified(network: Network, claim: Claim, expectedId?: string): string {
    const id = network.Id
    const labels = object(network.Labels)
    const occupants = object(network.Containers ?? {})
    const ipam = object(network.IPAM)
    const options = object(network.Options)
    const config = ipam.Config
    if (typeof id !== 'string' || !NETWORK_ID.test(id) || (expectedId && id !== expectedId) ||
      network.Name !== claim.name || network.Driver !== 'bridge' || network.Scope !== 'local' ||
      network.Internal !== true || network.Ingress === true || network.Attachable === true ||
      network.EnableIPv6 !== false || network.EnableIPv4 === false ||
      options['com.docker.network.bridge.enable_ip_masquerade'] !== 'false' ||
      Object.keys(labels).length !== 1 || labels[MARKER] !== claim.nonce ||
      Object.keys(occupants).length !== 0 || !Array.isArray(config) || config.length !== 1 ||
      typeof object(config[0]).Subnet !== 'string' ||
      !/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(object(config[0]).Subnet as string)) {
      throw new Error('hosted-network-unverified')
    }
    return id
  }

  /** Creates one fresh, unoccupied internal bridge and returns its exact Docker ID. */
  async provision(request: HostedMemberNetworkRequest): Promise<string> {
    await this.admitted(request)
    await this.docker.assertCompatible()
    await this.assertStateDirectory()
    const claim: Claim = {
      requestSha256: requestDigest(request),
      name: `hat-member-${randomBytes(16).toString('hex')}`,
      nonce: randomBytes(32).toString('hex'),
    }
    let handle
    try { handle = await open(this.operationPath(request.operationId),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new Error('hosted-network-operation-already-claimed')
      }
      throw error
    }
    try { await handle.writeFile(JSON.stringify(claim)); await handle.sync() } finally { await handle.close() }
    await this.syncStateDirectory()
    await this.assertStateDirectory()
    try { await link(this.operationPath(request.operationId), this.memberPath(request)) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new Error('hosted-network-member-already-claimed')
      }
      throw error
    }
    await this.syncStateDirectory()
    await this.admitted(request)
    await this.assertStateDirectory()
    const returnedId = await this.docker.create(claim.name, claim.nonce)
    if (!NETWORK_ID.test(returnedId)) throw new Error('hosted-network-create-result-invalid')
    const inspected = await this.docker.inspect(returnedId)
    if (!inspected) throw new Error('hosted-network-create-unresolved')
    const id = this.verified(inspected, claim, returnedId)
    await this.admitted(request)
    await this.writeDurableId('result', request.operationId, id)
    return id
  }

  /** Crash recovery only inspects the claimed random name; it never creates a replacement. */
  async reconcile(request: HostedMemberNetworkRequest): Promise<string> {
    await this.admitted(request)
    const claim = await this.readClaim(request)
    const expectedId = await this.readDurableId('result', request.operationId)
    await this.assertStateDirectory()
    const inspected = await this.docker.inspect(claim.name)
    if (!inspected) throw new Error('hosted-network-unresolved')
    const id = this.verified(inspected, claim, expectedId ?? undefined)
    await this.admitted(request)
    await this.writeDurableId('result', request.operationId, id)
    return id
  }

  /** Removes only an empty network with the claim's exact name, marker and durable ID.
   * Cleanup remains possible after admission is revoked. The root-only caller must
   * establish stop/cleanup authority before calling this method. A claim without
   * a published result ID is ambiguous residue, never authority to choose an ID.
   */
  async cleanup(request: HostedMemberNetworkRequest): Promise<void> {
    validRequest(request)
    const claim = await this.readClaim(request)
    const id = await this.readDurableId('result', request.operationId)
    if (!id) throw new Error('hosted-network-cleanup-id-unresolved')
    await this.writeDurableId('result', request.operationId, id)
    const intent = await this.readDurableId('cleanup-intent', request.operationId)
    const terminal = await this.readDurableId('cleanup-terminal', request.operationId)
    if (intent && intent !== id || terminal && (terminal !== id || intent !== id)) {
      throw new Error('hosted-network-cleanup-record-conflict')
    }
    if (intent) await this.writeDurableId('cleanup-intent', request.operationId, id)
    if (terminal) {
      if (!await this.exactAbsent(claim, id)) throw new Error('hosted-network-cleanup-terminal-conflict')
      await this.writeDurableId('cleanup-terminal', request.operationId, id)
      return
    }
    const inspected = await this.docker.inspect(id)
    if (!inspected) {
      if (!intent || !await this.exactAbsent(claim, id)) throw new Error('hosted-network-unresolved')
      await this.writeDurableId('cleanup-terminal', request.operationId, id)
      return
    }
    this.verified(inspected, claim, id)
    await this.writeDurableId('cleanup-intent', request.operationId, id)
    await this.assertStateDirectory()
    try { await this.docker.remove(id) }
    catch (error) { if (!await this.exactAbsent(claim, id)) throw error }
    if (!await this.exactAbsent(claim, id)) throw new Error('hosted-network-cleanup-unresolved')
    await this.writeDurableId('cleanup-terminal', request.operationId, id)
  }

  private async exactAbsent(claim: Claim, id: string): Promise<boolean> {
    await this.assertStateDirectory()
    const [byId, byName] = await Promise.all([this.docker.inspect(id), this.docker.inspect(claim.name)])
    return byId === null && byName === null
  }
}
