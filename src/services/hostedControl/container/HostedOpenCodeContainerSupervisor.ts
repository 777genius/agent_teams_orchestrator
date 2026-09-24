import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, readFile, readdir, readlink, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'

import { resolveExecutingOpenCodeArtifactDigest } from '../../opencode/OpenCodeArtifactDigest.js'

const execFileAsync = promisify(execFile)
const SHA = /^[0-9a-f]{64}$/
const IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/
const ID = /^[a-z0-9][a-z0-9_-]{7,95}$/
const CONTAINER_ID = /^[0-9a-f]{64}$/
const OFFICIAL_BINARY_SHA = '513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080'
const GENERATION_LABEL = 'org.agentteams.hosted-opencode.generation'
const BOOTSTRAP_SHA_LABEL = 'org.agentteams.hosted-opencode.bootstrap-sha256'
const CONTAINER_PORT = '4096/tcp'
const BOOTSTRAP_PATH = '/usr/local/bin/hosted-opencode-fd3-bootstrap'

export class HostedContainerNotFound extends Error {}

export interface HostedDockerRunner {
  run(...args: string[]): Promise<string>
}

/** This process must be isolated from Owner. It alone may access Docker. */
export class HostedDockerCliRunner implements HostedDockerRunner {
  constructor(private readonly executable = '/usr/bin/docker') {
    if (!path.isAbsolute(executable)) throw new Error('hosted-container-docker-path-invalid')
  }

  async run(...args: string[]): Promise<string> {
    try {
      const result = await execFileAsync(this.executable, args, {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { PATH: '/usr/bin:/bin', HOME: '/root', DOCKER_HOST: 'unix:///var/run/docker.sock' },
      })
      return result.stdout.trim()
    } catch (error) {
      const stderr = error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr).slice(-300) : ''
      if (args[0] === 'inspect' && /no such (?:object|container):/i.test(stderr)) {
        throw new HostedContainerNotFound('hosted-container-not-found')
      }
      throw new Error('hosted-container-docker-command-failed')
    }
  }
}

type FileIdentity = Readonly<{ device: string; inode: string }>
type Lease = Readonly<{
  runId: string
  teamId: string
  laneId: string
  workspace: string
  profile: string
  config: string
  configSha256: string
  workspaceIdentity: FileIdentity
  profileIdentity: FileIdentity
  configIdentity: FileIdentity
}>
type ContainerRecord = {
  handle: string
  generation: string
  operationId: string
  lease: Lease
  containerId: string | null
  stopped: boolean
}
type StartResult = { handle: string; generation: string; status: 'started' | 'unresolved'; effectEnabled: false }

export interface HostedOpenCodeContainerSupervisorOptions {
  readonly image: string
  /** Digest of the reviewed FD3 bootstrap in the immutable image. */
  readonly bootstrapSha256: string
  readonly networkId: string
  readonly workspaceParent: string
  readonly profileParent: string
  readonly configParent: string
  readonly stateDirectory: string
  readonly seccompPath: string
  readonly seccompSha256: string
  readonly apparmorProfile: string
  readonly docker?: HostedDockerRunner
  /** Test-only injection. Production always requires root and the real Docker runner. */
  readonly testOnlyAllowNonRoot?: boolean
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hosted-container-inspect-invalid')
  }
  return value as Record<string, unknown>
}

function identity(stat: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return { device: String(stat.dev), inode: String(stat.ino) }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function boundedId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('hosted-container-id-invalid')
}

function hexName(): string { return randomBytes(16).toString('hex') }

export class HostedOpenCodeContainerSupervisor {
  private readonly leases = new Map<string, Lease>()
  private readonly consumed = new Set<string>()
  private readonly records = new Map<string, ContainerRecord>()
  private readonly persistedRecords = new Set<string>()
  private readonly operations = new Map<string, { request: string; result: unknown }>()
  private readonly pendingStarts = new Map<string, { request: string; result: Promise<StartResult> }>()
  private readonly busy = new Set<string>()
  private readonly docker: HostedDockerRunner
  private seccomp!: unknown
  private imageId!: string

  private constructor(private readonly options: HostedOpenCodeContainerSupervisorOptions) {
    this.docker = options.docker ?? new HostedDockerCliRunner()
  }

  static async create(options: HostedOpenCodeContainerSupervisorOptions): Promise<HostedOpenCodeContainerSupervisor> {
    if (process.platform !== 'linux' && !options.testOnlyAllowNonRoot) {
      throw new Error('hosted-container-linux-required')
    }
    if (options.testOnlyAllowNonRoot && (!options.docker || process.env.NODE_ENV !== 'test')) {
      throw new Error('hosted-container-test-runner-required')
    }
    if (!options.testOnlyAllowNonRoot && (process.getuid?.() !== 0 || options.docker)) {
      throw new Error('hosted-container-root-supervisor-required')
    }
    if (!IMAGE.test(options.image) || !SHA.test(options.bootstrapSha256) || !CONTAINER_ID.test(options.networkId) ||
      !SHA.test(options.seccompSha256) || !/^[A-Za-z0-9_.-]{1,80}$/.test(options.apparmorProfile)) {
      throw new Error('hosted-container-policy-invalid')
    }
    const supervisor = new HostedOpenCodeContainerSupervisor(options)
    await supervisor.initialize()
    return supervisor
  }

  private async initialize(): Promise<void> {
    for (const parent of [this.options.workspaceParent, this.options.profileParent,
      this.options.configParent, this.options.stateDirectory]) {
      const stat = await lstat(parent)
      if (!path.isAbsolute(parent) || /[,=]/.test(parent) || await realpath(parent) !== parent || !stat.isDirectory() ||
        stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        stat.uid !== (this.options.testOnlyAllowNonRoot ? process.getuid?.() : 0)) {
        throw new Error('hosted-container-root-directory-invalid')
      }
    }
    const seccompParent = path.dirname(this.options.seccompPath)
    const [seccompStat, seccompParentStat] = await Promise.all([
      lstat(this.options.seccompPath), lstat(seccompParent),
    ])
    if (!path.isAbsolute(this.options.seccompPath) || await realpath(seccompParent) !== seccompParent ||
      !seccompParentStat.isDirectory() || seccompParentStat.isSymbolicLink() ||
      seccompParentStat.uid !== (this.options.testOnlyAllowNonRoot ? process.getuid?.() : 0) ||
      (seccompParentStat.mode & 0o022) !== 0) {
      throw new Error('hosted-container-seccomp-parent-invalid')
    }
    if (!seccompStat.isFile() || seccompStat.isSymbolicLink() || seccompStat.nlink !== 1 ||
      (seccompStat.mode & 0o022) !== 0 ||
      seccompStat.uid !== (this.options.testOnlyAllowNonRoot ? process.getuid?.() : 0)) {
      throw new Error('hosted-container-seccomp-file-invalid')
    }
    const bytes = await readFile(this.options.seccompPath)
    if (bytes.length > 65_536 || digest(bytes) !== this.options.seccompSha256) {
      throw new Error('hosted-container-seccomp-digest-invalid')
    }
    const profile = object(JSON.parse(bytes.toString('utf8')))
    if (!['SCMP_ACT_ERRNO', 'SCMP_ACT_KILL_PROCESS'].includes(String(profile.defaultAction))) {
      throw new Error('hosted-container-seccomp-not-deny-default')
    }
    this.seccomp = profile
    const image = object(JSON.parse(await this.docker.run('image', 'inspect', '--format', '{{json .}}', this.options.image)))
    if (typeof image.Id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(image.Id) ||
      !Array.isArray(image.RepoDigests) || !image.RepoDigests.includes(this.options.image) ||
      object(object(image.Config).Labels)[BOOTSTRAP_SHA_LABEL] !== this.options.bootstrapSha256) {
      throw new Error('hosted-container-image-unverified')
    }
    this.imageId = image.Id
    await this.networkContainers()
  }

  private async networkContainers(): Promise<Record<string, unknown>> {
    const network = object(JSON.parse(await this.docker.run('network', 'inspect', '--format', '{{json .}}', this.options.networkId)))
    // Provider egress requires a separately reviewed Qwen-only gateway. This checkpoint has none.
    if (network.Id !== this.options.networkId || network.Driver !== 'bridge' || network.Scope !== 'local' ||
      network.Internal !== true || network.Ingress === true) {
      throw new Error('hosted-container-network-unverified')
    }
    return object(network.Containers ?? {})
  }

  private async assertNetworkEmpty(): Promise<void> {
    if (Object.keys(await this.networkContainers()).length !== 0) {
      throw new Error('hosted-container-network-occupied')
    }
  }

  private async assertNetworkOwned(record: ContainerRecord): Promise<void> {
    const containers = await this.networkContainers()
    const ids = Object.keys(containers)
    if (ids.length > 1 || ids.length === 1 && (ids[0] !== record.containerId ||
      object(containers[ids[0]]).Name !== record.handle)) {
      throw new Error('hosted-container-network-foreign-occupant')
    }
  }

  private async durableClaim(name: string, payload: unknown): Promise<void> {
    const claim = path.join(this.options.stateDirectory, name)
    let file
    try { file = await open(claim, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new Error('hosted-container-claim-already-issued')
      }
      throw error
    }
    try { await file.writeFile(JSON.stringify(payload)); await file.sync() } finally { await file.close() }
    const directory = await open(this.options.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY)
    try { await directory.sync() } finally { await directory.close() }
  }

  private async assertNetworkClaim(record: ContainerRecord): Promise<void> {
    const file = await open(path.join(this.options.stateDirectory, `network-${this.options.networkId}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 || (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== (this.options.testOnlyAllowNonRoot ? process.getuid?.() : 0)) {
        throw new Error('hosted-container-network-claim-invalid')
      }
      const claim = object(JSON.parse(await file.readFile('utf8')))
      if (!exactKeys(claim, ['handle', 'generation']) || claim.handle !== record.handle ||
        claim.generation !== record.generation) {
        throw new Error('hosted-container-network-claim-invalid')
      }
    } finally { await file.close() }
  }

  private async assertSeccompUnchanged(): Promise<void> {
    const stat = await lstat(this.options.seccompPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.uid !== (this.options.testOnlyAllowNonRoot ? process.getuid?.() : 0) ||
      (stat.mode & 0o022) !== 0 ||
      digest(await readFile(this.options.seccompPath)) !== this.options.seccompSha256) {
      throw new Error('hosted-container-seccomp-substituted')
    }
  }

  private async checkedDirectory(value: string, parent: string, owner: number, mode = 0o700): Promise<FileIdentity> {
    if (!path.isAbsolute(value) || path.dirname(value) !== parent || !/^[0-9a-f]{24,64}$/.test(path.basename(value))) {
      throw new Error('hosted-container-lease-path-invalid')
    }
    const [stat, parentStat] = await Promise.all([lstat(value), lstat(parent)])
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner ||
      (stat.mode & 0o777) !== mode || stat.dev !== parentStat.dev || await realpath(value) !== value) {
      throw new Error('hosted-container-lease-directory-invalid')
    }
    return identity(stat)
  }

  private async checkedConfig(lease: Pick<Lease, 'config' | 'configSha256'>): Promise<void> {
    const names = await readdir(lease.config)
    if (names.length !== 1 || names[0] !== 'opencode.json') {
      throw new Error('hosted-container-config-directory-invalid')
    }
    const configFile = path.join(lease.config, 'opencode.json')
    const [stat, directory] = await Promise.all([lstat(configFile), lstat(lease.config)])
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.dev !== directory.dev ||
      stat.uid !== (this.options.testOnlyAllowNonRoot ? process.getuid?.() : 0) ||
      (stat.mode & 0o777) !== 0o444 || stat.size > 65_536 ||
      digest(await readFile(configFile)) !== lease.configSha256) {
      throw new Error('hosted-container-config-invalid')
    }
  }

  /** Root-only provisioning API. An Owner-facing RPC must accept opaque lease IDs, never paths. */
  async issueLease(input: { runId: string; teamId: string; laneId: string;
    workspace: string; profile: string; config: string; configSha256: string }): Promise<string> {
    for (const id of [input.runId, input.teamId, input.laneId]) boundedId(id)
    if (!SHA.test(input.configSha256)) throw new Error('hosted-container-config-digest-invalid')
    const [workspaceIdentity, profileIdentity, configIdentity] = await Promise.all([
      this.checkedDirectory(input.workspace, this.options.workspaceParent,
        this.options.testOnlyAllowNonRoot ? process.getuid!() : 1000),
      this.checkedDirectory(input.profile, this.options.profileParent,
        this.options.testOnlyAllowNonRoot ? process.getuid!() : 1000),
      this.checkedDirectory(input.config, this.options.configParent,
        this.options.testOnlyAllowNonRoot ? process.getuid!() : 0, 0o555),
    ])
    if ((await readdir(input.workspace)).length !== 0) {
      throw new Error('hosted-container-workspace-not-fresh')
    }
    if ((await readdir(input.profile)).length !== 0) {
      throw new Error('hosted-container-profile-not-fresh')
    }
    if ([...this.leases.values()].some(lease => lease.workspace === input.workspace ||
      lease.profile === input.profile || lease.config === input.config)) {
      throw new Error('hosted-container-lease-root-reused')
    }
    await this.checkedConfig(input)
    const leaseId = `lease_${hexName()}`
    for (const [kind, root] of [['workspace', input.workspace], ['profile', input.profile],
      ['config', input.config]] as const) {
      await this.durableClaim(`root-${kind}-${digest(Buffer.from(root))}.json`, { leaseId, root })
    }
    this.leases.set(leaseId, { ...input, workspaceIdentity, profileIdentity, configIdentity })
    return leaseId
  }

  private async checkedLease(leaseId: string, reserved = false): Promise<Lease> {
    boundedId(leaseId)
    const lease = this.leases.get(leaseId)
    if (!lease || (!reserved && this.consumed.has(leaseId))) throw new Error('hosted-container-lease-unavailable')
    const [workspace, profile, config] = await Promise.all([
      this.checkedDirectory(lease.workspace, this.options.workspaceParent,
        this.options.testOnlyAllowNonRoot ? process.getuid!() : 1000),
      this.checkedDirectory(lease.profile, this.options.profileParent,
        this.options.testOnlyAllowNonRoot ? process.getuid!() : 1000),
      this.checkedDirectory(lease.config, this.options.configParent,
        this.options.testOnlyAllowNonRoot ? process.getuid!() : 0, 0o555),
    ])
    if (!sameIdentity(workspace, lease.workspaceIdentity) || !sameIdentity(profile, lease.profileIdentity) ||
      !sameIdentity(config, lease.configIdentity)) {
      throw new Error('hosted-container-lease-substituted')
    }
    await this.checkedConfig(lease)
    return lease
  }

  private recordPath(handle: string): string { return path.join(this.options.stateDirectory, `${handle}.json`) }

  private async persist(record: ContainerRecord): Promise<void> {
    const destination = this.recordPath(record.handle)
    const temporary = `${destination}.${hexName()}.tmp`
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
    try {
      if (!this.persistedRecords.has(record.handle)) {
        await link(temporary, destination)
        this.persistedRecords.add(record.handle)
      } else {
        const existing = await lstat(destination)
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 ||
          existing.uid !== (this.options.testOnlyAllowNonRoot ? process.getuid?.() : 0) ||
          (existing.mode & 0o777) !== 0o600) {
          throw new Error('hosted-container-record-substituted')
        }
        await rename(temporary, destination)
      }
    } finally { await unlink(temporary).catch(() => undefined) }
    const directory = await open(this.options.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY)
    try { await directory.sync() } finally { await directory.close() }
  }

  private async load(handle: string, generation: string): Promise<ContainerRecord> {
    boundedId(handle)
    if (!/^[0-9a-f]{32}$/.test(generation)) throw new Error('hosted-container-generation-invalid')
    const cached = this.records.get(handle)
    if (cached) {
      if (cached.generation !== generation) throw new Error('hosted-container-generation-invalid')
      return cached
    }
    const file = await open(this.recordPath(handle), constants.O_RDONLY | constants.O_NOFOLLOW)
    let raw: string
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== (this.options.testOnlyAllowNonRoot ? process.getuid?.() : 0)) {
        throw new Error('hosted-container-record-invalid')
      }
      raw = await file.readFile('utf8')
    } finally { await file.close() }
    const row = object(JSON.parse(raw))
    if (!exactKeys(row, ['handle', 'generation', 'operationId', 'lease', 'containerId', 'stopped']) ||
      row.handle !== handle || row.generation !== generation || typeof row.stopped !== 'boolean' ||
      row.containerId !== null && (typeof row.containerId !== 'string' || !CONTAINER_ID.test(row.containerId))) {
      throw new Error('hosted-container-record-invalid')
    }
    boundedId(row.operationId)
    const lease = object(row.lease)
    if (!exactKeys(lease, ['runId', 'teamId', 'laneId', 'workspace', 'profile', 'config',
      'configSha256', 'workspaceIdentity', 'profileIdentity', 'configIdentity']) ||
      typeof lease.configSha256 !== 'string' || !SHA.test(lease.configSha256)) {
      throw new Error('hosted-container-record-lease-invalid')
    }
    for (const key of ['runId', 'teamId', 'laneId']) boundedId(lease[key])
    for (const [key, parent] of [['workspace', this.options.workspaceParent],
      ['profile', this.options.profileParent], ['config', this.options.configParent]] as const) {
      if (typeof lease[key] !== 'string' || path.dirname(lease[key]) !== parent ||
        !/^[0-9a-f]{24,64}$/.test(path.basename(lease[key]))) {
        throw new Error('hosted-container-record-lease-invalid')
      }
    }
    for (const key of ['workspaceIdentity', 'profileIdentity', 'configIdentity']) {
      const fileIdentity = object(lease[key])
      if (!exactKeys(fileIdentity, ['device', 'inode']) ||
        typeof fileIdentity.device !== 'string' || !/^\d+$/.test(fileIdentity.device) ||
        typeof fileIdentity.inode !== 'string' || !/^\d+$/.test(fileIdentity.inode)) {
        throw new Error('hosted-container-record-lease-invalid')
      }
    }
    const record = row as unknown as ContainerRecord
    this.records.set(handle, record)
    this.persistedRecords.add(handle)
    return record
  }

  private async inspect(record: ContainerRecord): Promise<Record<string, unknown>> {
    const inspected = object(JSON.parse(await this.docker.run('inspect', '--format', '{{json .}}', record.containerId ?? record.handle)))
    const labels = object(object(inspected.Config).Labels)
    if (typeof inspected.Id !== 'string' || !CONTAINER_ID.test(inspected.Id) ||
      record.containerId !== null && inspected.Id !== record.containerId ||
      inspected.Name !== `/${record.handle}` || labels[GENERATION_LABEL] !== record.generation) {
      throw new Error('hosted-container-inspect-identity-invalid')
    }
    if (record.containerId === null) { record.containerId = inspected.Id; await this.persist(record) }
    return inspected
  }

  private assertEffective(inspected: Record<string, unknown>, record: ContainerRecord): void {
    const host = object(inspected.HostConfig)
    const config = object(inspected.Config)
    const attachedNetworks = Object.values(object(object(inspected.NetworkSettings).Networks))
    const security = host.SecurityOpt
    const mounts = inspected.Mounts
    const expectedMounts = [
      [record.lease.workspace, '/sandbox/workspace', true],
      [record.lease.profile, '/sandbox/profile', true],
      [record.lease.config, '/sandbox/config', false],
    ]
    const mountRows = Array.isArray(mounts) ? mounts.map(item => {
      const row = object(item)
      return [row.Source, row.Destination, row.RW]
    }) : []
    const seccomp = Array.isArray(security)
      ? security.filter(value => typeof value === 'string' && value.startsWith('seccomp=')) : []
    let seccompValid = false
    try { seccompValid = seccomp.length === 1 && isDeepStrictEqual(JSON.parse(seccomp[0].slice(8)), this.seccomp) }
    catch { seccompValid = false }
    const tmpfs = object(host.Tmpfs)
    const portBindings = object(host.PortBindings)
    const binding = portBindings[CONTAINER_PORT]
    const requiredEnv = new Map([
      ['HOME', '/sandbox/profile/home'],
      ['XDG_CONFIG_HOME', '/sandbox/profile/config'],
      ['XDG_DATA_HOME', '/sandbox/profile/data'],
      ['XDG_CACHE_HOME', '/sandbox/profile/cache'],
      ['OPENCODE_CONFIG_DIR', '/sandbox/config'],
      ['OPENCODE_DISABLE_PROJECT_CONFIG', '1'],
      ['OPENCODE_DISABLE_CLAUDE_CODE', '1'],
    ])
    const allowedEnv = new Set([...requiredEnv.keys(), 'PATH', 'LANG', 'TZ'])
    const actualEnv = Array.isArray(config.Env) ? config.Env : []
    const parsedEnv = new Map<string, string>()
    for (const entry of actualEnv) {
      if (typeof entry !== 'string' || !entry.includes('=')) throw new Error('hosted-container-env-invalid')
      const separator = entry.indexOf('=')
      const key = entry.slice(0, separator)
      if (!allowedEnv.has(key) || parsedEnv.has(key)) throw new Error('hosted-container-env-invalid')
      parsedEnv.set(key, entry.slice(separator + 1))
    }
    for (const [key, value] of requiredEnv) {
      if (parsedEnv.get(key) !== value) throw new Error('hosted-container-env-invalid')
    }
    if (config.Image !== this.options.image || inspected.Image !== this.imageId ||
      config.User !== '1000:1000' || JSON.stringify(config.Entrypoint) !== JSON.stringify([BOOTSTRAP_PATH]) ||
      JSON.stringify(config.Cmd) !== JSON.stringify(['--socket-name', `fd3-${record.generation}`, '--sender-uid', '0']) ||
      inspected.AppArmorProfile !== this.options.apparmorProfile || host.ReadonlyRootfs !== true ||
      host.Privileged !== false || host.NetworkMode !== this.options.networkId ||
      attachedNetworks.length !== 1 || object(attachedNetworks[0]).NetworkID !== this.options.networkId ||
      String(host.PidMode ?? '') !== '' || host.IpcMode !== 'private' ||
      !Array.isArray(host.CapDrop) || !host.CapDrop.includes('ALL') ||
      Array.isArray(host.CapAdd) && host.CapAdd.length > 0 ||
      !Array.isArray(security) || !security.includes('no-new-privileges:true') ||
      !security.includes(`apparmor=${this.options.apparmorProfile}`) || !seccompValid ||
      !isDeepStrictEqual(mountRows.sort(), expectedMounts.sort()) ||
      typeof tmpfs['/etc/opencode'] !== 'string' || !tmpfs['/etc/opencode'].includes('ro') ||
      !Array.isArray(binding) || binding.length !== 1 || object(binding[0]).HostIp !== '127.0.0.1' ||
      Number(host.PidsLimit) < 1 || Number(host.PidsLimit) > 64 ||
      Number(host.Memory) < 64 * 1024 * 1024 || Number(host.Memory) > 1024 * 1024 * 1024 ||
      Number(host.NanoCpus) < 100_000_000 || Number(host.NanoCpus) > 1_000_000_000) {
      throw new Error('hosted-container-effective-policy-mismatch')
    }
  }

  private endpoint(inspected: Record<string, unknown>): string {
    const network = object(inspected.NetworkSettings)
    const ports = object(network.Ports)
    const bindings = ports[CONTAINER_PORT]
    if (!Array.isArray(bindings) || bindings.length !== 1) {
      throw new Error('hosted-container-endpoint-invalid')
    }
    const binding = object(bindings[0])
    const port = Number(binding.HostPort)
    if (binding.HostIp !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
      throw new Error('hosted-container-endpoint-invalid')
    }
    return `http://127.0.0.1:${port}`
  }

  private async processEvidence(inspected: Record<string, unknown>): Promise<{ pid: number; startTicks: string; pidNamespace: string }> {
    const state = object(inspected.State)
    const pid = state.Pid
    if (state.Running !== true || !Number.isSafeInteger(pid) || Number(pid) < 1 ||
      resolveExecutingOpenCodeArtifactDigest(Number(pid)) !== `sha256:${OFFICIAL_BINARY_SHA}`) {
      throw new Error('hosted-container-executable-unverified')
    }
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    const startTicks = fields[19]
    const pidNamespace = await readlink(`/proc/${pid}/ns/pid`)
    const mountInfo = await readFile(`/proc/${pid}/mountinfo`, 'utf8')
    const systemConfigMount = mountInfo.split('\n').find(line => line.split(' ')[4] === '/etc/opencode')
    const mountParts = systemConfigMount?.split(' - ')
    const mountOptions = systemConfigMount?.split(' ')[5]?.split(',') ?? []
    const secondStat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const secondStartTicks = secondStat.slice(secondStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
    if (!/^\d+$/.test(startTicks) || !/^pid:\[\d+\]$/.test(pidNamespace)) {
      throw new Error('hosted-container-process-identity-invalid')
    }
    if (secondStartTicks !== startTicks ||
      resolveExecutingOpenCodeArtifactDigest(Number(pid)) !== `sha256:${OFFICIAL_BINARY_SHA}` ||
      mountParts?.[1]?.split(' ')[0] !== 'tmpfs' ||
      !['ro', 'nosuid', 'nodev', 'noexec'].every(option => mountOptions.includes(option))) {
      throw new Error('hosted-container-process-policy-unverified')
    }
    return { pid: Number(pid), startTicks, pidNamespace }
  }

  /**
   * Inactive staging seam. Release order: create/inspect, start/bootstrap attestation,
   * trusted FD3 handoff, post-exec official digest, then ready. No handoff exists here,
   * so this class never enables Owner effects or claims a usable runtime.
   */
  async start(request: { operationId: string; leaseId: string; runId: string; teamId: string; laneId: string }): Promise<StartResult> {
    boundedId(request.operationId)
    boundedId(request.leaseId)
    for (const id of [request.runId, request.teamId, request.laneId]) boundedId(id)
    const requestKey = JSON.stringify(request)
    const previous = this.operations.get(request.operationId)
    if (previous) {
      if (previous.request !== requestKey) throw new Error('hosted-container-operation-replay-conflict')
      return previous.result as StartResult
    }
    const pending = this.pendingStarts.get(request.operationId)
    if (pending) {
      if (pending.request !== requestKey) throw new Error('hosted-container-operation-replay-conflict')
      return pending.result
    }
    if (!this.leases.has(request.leaseId) || this.consumed.has(request.leaseId)) {
      throw new Error('hosted-container-lease-unavailable')
    }
    this.consumed.add(request.leaseId)
    const result = this.startReserved(request, requestKey)
    this.pendingStarts.set(request.operationId, { request: requestKey, result })
    try { return await result } finally { this.pendingStarts.delete(request.operationId) }
  }

  private async startReserved(request: { operationId: string; leaseId: string; runId: string;
    teamId: string; laneId: string }, requestKey: string): Promise<StartResult> {
    const lease = await this.checkedLease(request.leaseId, true)
    if (lease.runId !== request.runId || lease.teamId !== request.teamId || lease.laneId !== request.laneId) {
      throw new Error('hosted-container-lease-binding-invalid')
    }
    const record: ContainerRecord = { handle: `opencode_${hexName()}`, generation: hexName(),
      operationId: request.operationId, lease, containerId: null, stopped: false }
    this.records.set(record.handle, record)
    this.busy.add(record.handle)
    try { await this.persist(record) }
    catch (error) { this.busy.delete(record.handle); throw error }
    const result = (status: 'started' | 'unresolved') => ({ handle: record.handle,
      generation: record.generation, status, effectEnabled: false as const })
    try {
      await this.checkedLeaseIdentityWithoutFreshness(lease)
      await this.assertSeccompUnchanged()
      await this.durableClaim(`network-${this.options.networkId}.json`,
        { handle: record.handle, generation: record.generation })
      await this.assertNetworkEmpty()
      const created = await this.docker.run('create', '--name', record.handle, '--label', `${GENERATION_LABEL}=${record.generation}`,
        '--user', '1000:1000', '--read-only', '--network', this.options.networkId,
        '--ipc', 'private', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--security-opt', `seccomp=${this.options.seccompPath}`,
        '--security-opt', `apparmor=${this.options.apparmorProfile}`, '--pids-limit', '64',
        '--memory', '1g', '--cpus', '1', '--tmpfs', '/etc/opencode:ro,noexec,nosuid,nodev,size=4096',
        '--mount', `type=bind,source=${lease.workspace},target=/sandbox/workspace`,
        '--mount', `type=bind,source=${lease.profile},target=/sandbox/profile`,
        '--mount', `type=bind,source=${lease.config},target=/sandbox/config,readonly`,
        '--publish', '127.0.0.1::4096', '--workdir', '/sandbox/workspace',
        '--env', 'HOME=/sandbox/profile/home', '--env', 'XDG_CONFIG_HOME=/sandbox/profile/config',
        '--env', 'XDG_DATA_HOME=/sandbox/profile/data', '--env', 'XDG_CACHE_HOME=/sandbox/profile/cache',
        '--env', 'OPENCODE_CONFIG_DIR=/sandbox/config', '--env', 'OPENCODE_DISABLE_PROJECT_CONFIG=1',
        '--env', 'OPENCODE_DISABLE_CLAUDE_CODE=1', '--entrypoint', BOOTSTRAP_PATH,
        this.options.image, '--socket-name', `fd3-${record.generation}`, '--sender-uid', '0')
      if (!CONTAINER_ID.test(created)) throw new Error('hosted-container-create-id-invalid')
      record.containerId = created
      await this.persist(record)
      this.assertEffective(await this.inspect(record), record)
      await this.assertNetworkOwned(record)
      await this.checkedLeaseIdentityWithoutFreshness(lease)
      await this.docker.run('start', created)
      const inspected = await this.inspect(record)
      this.assertEffective(inspected, record)
      await this.assertNetworkOwned(record)
      this.endpoint(inspected)
      await this.processEvidence(inspected)
      const started = result('started')
      this.operations.set(request.operationId, { request: requestKey, result: started })
      return started
    } catch {
      const unresolved = result('unresolved')
      this.operations.set(request.operationId, { request: requestKey, result: unresolved })
      return unresolved
    } finally { this.busy.delete(record.handle) }
  }

  private async checkedLeaseIdentityWithoutFreshness(lease: Lease): Promise<void> {
    const [workspace, profile, config] = await Promise.all([
      this.checkedDirectory(lease.workspace, this.options.workspaceParent,
        this.options.testOnlyAllowNonRoot ? process.getuid!() : 1000),
      this.checkedDirectory(lease.profile, this.options.profileParent,
        this.options.testOnlyAllowNonRoot ? process.getuid!() : 1000),
      this.checkedDirectory(lease.config, this.options.configParent,
        this.options.testOnlyAllowNonRoot ? process.getuid!() : 0, 0o555),
    ])
    if (!sameIdentity(workspace, lease.workspaceIdentity) || !sameIdentity(profile, lease.profileIdentity) ||
      !sameIdentity(config, lease.configIdentity)) {
      throw new Error('hosted-container-lease-substituted')
    }
    await this.checkedConfig(lease)
  }

  async observe(request: { operationId: string; handle: string; generation: string }): Promise<{
    status: 'running' | 'stopped'; handle: string; generation: string; effectEnabled: false;
    endpoint?: string; process?: { pid: number; startTicks: string; pidNamespace: string }
  }> {
    boundedId(request.operationId)
    const record = await this.load(request.handle, request.generation)
    const inspected = await this.inspect(record)
    await this.assertNetworkClaim(record)
    await this.assertNetworkOwned(record)
    this.assertEffective(inspected, record)
    const state = object(inspected.State)
    if (state.Running !== true) {
      if (state.Running !== false || state.Pid !== 0) throw new Error('hosted-container-state-invalid')
      return { status: 'stopped', handle: record.handle, generation: record.generation, effectEnabled: false }
    }
    await this.checkedLeaseIdentityWithoutFreshness(record.lease)
    return { status: 'running', handle: record.handle, generation: record.generation,
      endpoint: this.endpoint(inspected), process: await this.processEvidence(inspected), effectEnabled: false }
  }

  async stop(request: { operationId: string; handle: string; generation: string }): Promise<{
    handle: string; generation: string; stopped: boolean; unresolved: boolean
  }> {
    boundedId(request.operationId)
    const record = await this.load(request.handle, request.generation)
    if (this.busy.has(record.handle)) throw new Error('hosted-container-operation-busy')
    this.busy.add(record.handle)
    try {
      if (record.stopped) {
        await this.assertNetworkClaim(record)
        await this.assertNetworkEmpty()
        return { handle: record.handle, generation: record.generation, stopped: true, unresolved: false }
      }
      let inspected: Record<string, unknown>
      try { inspected = await this.inspect(record) }
      catch (error) {
        if (!(error instanceof HostedContainerNotFound) || record.containerId === null) {
          return { handle: record.handle, generation: record.generation, stopped: false, unresolved: true }
        }
        try { await this.inspect(record); throw new Error('hosted-container-stop-state-changed') }
        catch (again) {
          if (!(again instanceof HostedContainerNotFound)) throw again
          await this.assertNetworkClaim(record)
          await this.assertNetworkEmpty()
          record.stopped = true; await this.persist(record)
          return { handle: record.handle, generation: record.generation, stopped: true, unresolved: false }
        }
      }
      await this.assertNetworkClaim(record)
      await this.assertNetworkOwned(record)
      const state = object(inspected.State)
      if (state.Running === true) {
        await this.docker.run('stop', '--time', '2', record.containerId!).catch(() => undefined)
        inspected = await this.inspect(record)
      }
      const stoppedState = object(inspected.State)
      if (stoppedState.Running !== false || stoppedState.Pid !== 0) {
        return { handle: record.handle, generation: record.generation, stopped: false, unresolved: true }
      }
      await this.docker.run('rm', record.containerId!).catch(() => undefined)
      try { await this.inspect(record); return { handle: record.handle, generation: record.generation, stopped: false, unresolved: true } }
      catch (error) {
        if (!(error instanceof HostedContainerNotFound)) throw error
      }
      await this.assertNetworkEmpty()
      record.stopped = true; await this.persist(record)
      return { handle: record.handle, generation: record.generation, stopped: true, unresolved: false }
    } finally { this.busy.delete(record.handle) }
  }

  reconcile(request: { operationId: string; handle: string; generation: string }): ReturnType<typeof this.stop> {
    return this.stop(request)
  }
}
