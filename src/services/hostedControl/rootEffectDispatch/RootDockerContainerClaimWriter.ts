import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, writeSync } from 'node:fs'
import path from 'node:path'

import { hostedMemberStartOperationId } from '../../teamLifecycleOwner/HostedMemberStartOperationId.js'
import type { HostedProductMemberBinding } from '../productAuthority/HostedProductCurrentMemberDecision.js'
import { HostedRootSingleMemberAuthority } from './HostedRootSingleMemberAuthority.js'
import type { RootContainerTarget } from './RootDockerContainerPort.js'

const SHA = /^[a-f0-9]{64}$/
const GENERATION = /^[a-f0-9]{32}$/
const HANDLE = /^opencode_[a-f0-9]{32}$/
const IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/
const PROFILE = /^[a-f0-9]{32}$/
const GENERATION_LABEL = 'org.agentteams.hosted-opencode.generation'
const BOOTSTRAP = '/usr/local/bin/hosted-opencode-fd3-bootstrap'

type CreateInput = Readonly<{
  target: RootContainerTarget
  workspace: string
  profile: string
  config: string
  seccomp: Readonly<Record<string, unknown>>
  apparmorProfile: string
}>

type Options = Readonly<{
  stateDirectory: string
  authority: HostedRootSingleMemberAuthority
  binding: HostedProductMemberBinding
  image: string
  networkId: string
  workspaceParent: string
  profileParent: string
  configParent: string
  testOnlyAllowNonRoot?: boolean
}>

function exact(value: unknown, keys: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function pathUnder(value: string, parent: string): boolean {
  return typeof value === 'string' && path.dirname(value) === parent && PROFILE.test(path.basename(value))
}

/** Publishes only root-owned, secret-free launch claims. An existing claim is never overwritten. */
export class RootDockerContainerClaimWriter {
  private readonly identity: Readonly<{ dev: number; ino: number }>
  private readonly uid: number

  private constructor(private readonly options: Options) {
    if (options.testOnlyAllowNonRoot && process.env.NODE_ENV !== 'test' ||
      !options.testOnlyAllowNonRoot && (process.platform !== 'linux' || process.getuid?.() !== 0) ||
      !IMAGE.test(options.image) || !SHA.test(options.networkId) ||
      ![options.stateDirectory, options.workspaceParent, options.profileParent, options.configParent]
        .every(value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value) ||
      new Set([options.stateDirectory, options.workspaceParent, options.profileParent,
        options.configParent]).size !== 4) throw new Error('root-container-writer-policy-invalid')
    this.uid = process.getuid?.() ?? -1
    const stat = lstatSync(options.stateDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid ||
      (stat.mode & 0o777) !== 0o700 || realpathSync(options.stateDirectory) !== options.stateDirectory) {
      throw new Error('root-container-writer-state-invalid')
    }
    this.identity = { dev: stat.dev, ino: stat.ino }
  }

  static create(options: Options): RootDockerContainerClaimWriter {
    return new RootDockerContainerClaimWriter(options)
  }

  private assertDirectory(): void {
    const stat = lstatSync(this.options.stateDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid ||
      (stat.mode & 0o777) !== 0o700 || stat.dev !== this.identity.dev ||
      stat.ino !== this.identity.ino || realpathSync(this.options.stateDirectory) !== this.options.stateDirectory) {
      throw new Error('root-container-writer-state-substituted')
    }
  }

  private claim(name: string, value: unknown): void {
    this.assertDirectory()
    const bytes = Buffer.from(JSON.stringify(value))
    if (bytes.length < 1 || bytes.length > 256 * 1024 + 512) {
      throw new Error('root-container-writer-claim-too-large')
    }
    const fd = openSync(path.join(this.options.stateDirectory, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      let offset = 0
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset)
        if (!Number.isSafeInteger(written) || written < 1) throw new Error('root-container-writer-write-incomplete')
        offset += written
      }
      fsyncSync(fd)
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.uid ||
        (stat.mode & 0o777) !== 0o600 || stat.size !== bytes.length) {
        throw new Error('root-container-writer-claim-invalid')
      }
    } finally { closeSync(fd) }
    const directory = openSync(this.options.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY |
      constants.O_NOFOLLOW)
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }

  private manifest(memberOperationId: string): Record<string, unknown> {
    this.assertDirectory()
    const fd = openSync(path.join(this.options.stateDirectory, `container-create-${memberOperationId}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.uid ||
        (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 256 * 1024 + 512) {
        throw new Error('root-container-writer-manifest-invalid')
      }
      const row: unknown = JSON.parse(readFileSync(fd, 'utf8'))
      if (!exact(row, ['memberOperationId', 'handle', 'generation', 'networkId', 'body'])) {
        throw new Error('root-container-writer-manifest-invalid')
      }
      return row as Record<string, unknown>
    } finally { closeSync(fd) }
  }

  async writeCreate(input: CreateInput): Promise<void> {
    if (!exact(input, ['target', 'workspace', 'profile', 'config', 'seccomp', 'apparmorProfile']) ||
      !exact(input.target, ['memberOperationId', 'handle', 'generation', 'networkId']) ||
      input.target.memberOperationId !== hostedMemberStartOperationId(this.options.binding.runId,
        this.options.binding.memberId, this.options.binding.planSha256) ||
      !HANDLE.test(input.target.handle) || !GENERATION.test(input.target.generation) ||
      input.target.networkId !== this.options.networkId ||
      !pathUnder(input.workspace, this.options.workspaceParent) ||
      !pathUnder(input.profile, this.options.profileParent) ||
      !pathUnder(input.config, this.options.configParent) ||
      !input.seccomp || typeof input.seccomp !== 'object' || Array.isArray(input.seccomp) ||
      !['SCMP_ACT_ERRNO', 'SCMP_ACT_KILL_PROCESS'].includes(String(input.seccomp.defaultAction)) ||
      typeof input.apparmorProfile !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,80}$/.test(input.apparmorProfile)) {
      throw new Error('root-container-writer-create-invalid')
    }
    const body = JSON.stringify({ Image: this.options.image, User: '1000:1000',
      WorkingDir: '/sandbox/workspace',
      Entrypoint: [BOOTSTRAP],
      Cmd: ['--socket-name', `fd3-${input.target.generation}`, '--sender-uid', '0'],
      Env: ['HOME=/sandbox/profile/home', 'XDG_CONFIG_HOME=/sandbox/profile/config',
        'XDG_DATA_HOME=/sandbox/profile/data', 'XDG_CACHE_HOME=/sandbox/profile/cache',
        'XDG_STATE_HOME=/sandbox/profile/state', 'TMPDIR=/sandbox/profile/tmp',
        'OPENCODE_CONFIG_DIR=/sandbox/config', 'OPENCODE_DISABLE_PROJECT_CONFIG=1',
        'OPENCODE_DISABLE_CLAUDE_CODE=1', 'OPENCODE_SERVER_PASSWORD'],
      Labels: { [GENERATION_LABEL]: input.target.generation },
      ExposedPorts: { '4096/tcp': {} },
      HostConfig: { ReadonlyRootfs: true, Privileged: false, NetworkMode: this.options.networkId,
        IpcMode: 'private', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true',
          `seccomp=${JSON.stringify(input.seccomp)}`, `apparmor=${input.apparmorProfile}`],
        PidsLimit: 64, Memory: 1024 * 1024 * 1024, NanoCpus: 1_000_000_000,
        Tmpfs: { '/etc/opencode': 'ro,noexec,nosuid,nodev,size=4096' },
        Mounts: [
          { Type: 'bind', Source: input.workspace, Target: '/sandbox/workspace' },
          { Type: 'bind', Source: input.profile, Target: '/sandbox/profile' },
          { Type: 'bind', Source: input.config, Target: '/sandbox/config', ReadOnly: true },
        ],
        PortBindings: { '4096/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
      },
    })
    if (body.includes('OPENCODE_SERVER_PASSWORD=') || body.length > 256 * 1024) {
      throw new Error('root-container-writer-create-invalid')
    }
    await this.options.authority.withCurrentMemberDecision(this.options.binding, 'prepare', () => {
      this.claim(`container-create-${input.target.memberOperationId}.json`, { ...input.target, body })
    })
  }

  /** Post-create evidence is recorded even after revocation so exact cleanup can locate the resource. */
  writeTarget(target: RootContainerTarget): void {
    if (!exact(target, ['memberOperationId', 'handle', 'generation', 'networkId', 'containerId']) ||
      typeof target.containerId !== 'string' || !SHA.test(target.containerId) ||
      target.memberOperationId !== hostedMemberStartOperationId(this.options.binding.runId,
        this.options.binding.memberId, this.options.binding.planSha256)) {
      throw new Error('root-container-writer-target-invalid')
    }
    const manifest = this.manifest(target.memberOperationId)
    if (target.handle !== manifest.handle || target.generation !== manifest.generation ||
      target.networkId !== manifest.networkId) throw new Error('root-container-writer-target-unbound')
    this.claim(`container-target-${target.memberOperationId}.json`, target)
  }
}
