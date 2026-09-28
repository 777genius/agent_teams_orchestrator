import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, realpath, readdir } from 'node:fs/promises'
import path from 'node:path'

import type { HostedOpenCodeContainerSupervisor } from '../container/HostedOpenCodeContainerSupervisor.js'

const ID = /^[a-z0-9][a-z0-9_-]{7,95}$/
const SHA = /^[0-9a-f]{64}$/

export type HostedMemberProvisionRequest = Readonly<{
  operationId: string
  planTeamId: string
  planFingerprint: string
  runId: string
  teamId: string
  laneId: string
  memberId: string
}>

type LeaseInput = Parameters<HostedOpenCodeContainerSupervisor['issueLease']>[0]
export type HostedMemberLeasePort = Readonly<{ issueLease(input: LeaseInput): Promise<string> }>

export type HostedMemberProvisionerOptions = Readonly<{
  workspaceParent: string
  profileParent: string
  configParent: string
  stateDirectory: string
  /** Installed root-owned source, never supplied in an Owner request. */
  configTemplatePath: string
  configTemplateSha256: string
  /** Only an independent authority can admit the exact Owner plan/member tuple. */
  admitMember(request: HostedMemberProvisionRequest): Promise<boolean>
  supervisor: HostedMemberLeasePort
  /** Fixture only. Production requires root and provisions UID 1000. */
  testOnlyAllowNonRoot?: boolean
}>

export type HostedMemberProvisionClaim = Readonly<{
  requestSha256: string
  workspace: string
  profile: string
  config: string
}>

function sha(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function ownedUid(test: boolean): number { return test ? process.getuid!() : 0 }
function writableUid(test: boolean): number { return test ? process.getuid!() : 1000 }

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function checkedParent(directory: string, uid: number): Promise<void> {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || /[,=]/.test(directory)) {
    throw new Error('hosted-provision-parent-path-invalid')
  }
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) {
    throw new Error('hosted-provision-parent-invalid')
  }
}

async function checkedTemplate(filePath: string, expectedSha: string, uid: number): Promise<Buffer> {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath || !SHA.test(expectedSha)) {
    throw new Error('hosted-provision-template-policy-invalid')
  }
  const parent = path.dirname(filePath)
  const [entry, directory] = await Promise.all([lstat(filePath), lstat(parent)])
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== uid ||
    (entry.mode & 0o777) !== 0o400 || entry.size < 2 || entry.size > 65_536 ||
    !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid ||
    (directory.mode & 0o022) !== 0 || await realpath(filePath) !== filePath) {
    throw new Error('hosted-provision-template-invalid')
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      throw new Error('hosted-provision-template-substituted')
    }
    const bytes = await handle.readFile()
    if (sha(bytes) !== expectedSha) throw new Error('hosted-provision-template-digest-invalid')
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('hosted-provision-template-json-invalid')
    }
    return bytes
  } finally { await handle.close() }
}

function validateRequest(request: HostedMemberProvisionRequest): void {
  if (Object.keys(request).sort().join(',') !==
    ['operationId', 'planTeamId', 'planFingerprint', 'runId', 'teamId', 'laneId', 'memberId'].sort().join(',') ||
    ![request.operationId, request.planTeamId, request.runId, request.teamId, request.laneId,
      request.memberId].every(value => typeof value === 'string' && ID.test(value)) ||
    !SHA.test(request.planFingerprint)) {
    throw new Error('hosted-provision-request-invalid')
  }
}

/** One claim is one attempt. A crash or uncertain lease outcome never creates another layout. */
export class HostedOpenCodeMemberProvisioner {
  private readonly uid: number
  private readonly writable: number

  private constructor(private readonly options: HostedMemberProvisionerOptions) {
    this.uid = ownedUid(!!options.testOnlyAllowNonRoot)
    this.writable = writableUid(!!options.testOnlyAllowNonRoot)
  }

  static async create(options: HostedMemberProvisionerOptions): Promise<HostedOpenCodeMemberProvisioner> {
    if (options.testOnlyAllowNonRoot) {
      if (process.env.NODE_ENV !== 'test') throw new Error('hosted-provision-test-mode-forbidden')
    } else if (process.platform !== 'linux' || process.getuid?.() !== 0) {
      throw new Error('hosted-provision-root-required')
    }
    const uid = ownedUid(!!options.testOnlyAllowNonRoot)
    const parents = [options.workspaceParent, options.profileParent, options.configParent, options.stateDirectory]
    if (new Set(parents).size !== parents.length) throw new Error('hosted-provision-parents-overlap')
    for (const parent of parents) await checkedParent(parent, uid)
    if (typeof options.admitMember !== 'function' || !options.supervisor ||
      typeof options.supervisor.issueLease !== 'function') throw new Error('hosted-provision-authority-required')
    await checkedTemplate(options.configTemplatePath, options.configTemplateSha256, uid)
    return new HostedOpenCodeMemberProvisioner(options)
  }

  private claimPath(operationId: string): string {
    return path.join(this.options.stateDirectory, `provision-${operationId}.json`)
  }

  /** Read-only recovery evidence. A prior claim must be reconciled out of band. */
  async readClaim(operationId: string): Promise<HostedMemberProvisionClaim | null> {
    if (!ID.test(operationId)) throw new Error('hosted-provision-request-invalid')
    let handle
    try { handle = await open(this.claimPath(operationId), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.uid ||
        (stat.mode & 0o777) !== 0o600 || stat.size > 1024) {
        throw new Error('hosted-provision-claim-invalid')
      }
      const claim: unknown = JSON.parse(await handle.readFile('utf8'))
      if (!claim || typeof claim !== 'object' || Array.isArray(claim) ||
        Object.keys(claim).sort().join(',') !== ['requestSha256', 'workspace', 'profile', 'config'].sort().join(',')) {
        throw new Error('hosted-provision-claim-invalid')
      }
      const value = claim as Record<string, unknown>
      if (!SHA.test(String(value.requestSha256)) ||
        ![[value.workspace, this.options.workspaceParent], [value.profile, this.options.profileParent],
          [value.config, this.options.configParent]].every(([entry, parent]) =>
          typeof entry === 'string' && path.dirname(entry) === parent && /^[0-9a-f]{32}$/.test(path.basename(entry)))) {
        throw new Error('hosted-provision-claim-invalid')
      }
      return value as HostedMemberProvisionClaim
    } finally { await handle.close() }
  }

  async issueLease(request: HostedMemberProvisionRequest): Promise<string> {
    validateRequest(request)
    if (!await this.options.admitMember(request)) throw new Error('hosted-provision-member-not-admitted')
    const bytes = await checkedTemplate(this.options.configTemplatePath,
      this.options.configTemplateSha256, this.uid)
    for (const parent of [this.options.workspaceParent, this.options.profileParent,
      this.options.configParent, this.options.stateDirectory]) await checkedParent(parent, this.uid)

    const names = Array.from({ length: 3 }, () => randomBytes(16).toString('hex'))
    const claim: HostedMemberProvisionClaim = {
      requestSha256: sha(JSON.stringify(request)),
      workspace: path.join(this.options.workspaceParent, names[0]),
      profile: path.join(this.options.profileParent, names[1]),
      config: path.join(this.options.configParent, names[2]),
    }
    let handle
    try {
      handle = await open(this.claimPath(request.operationId),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new Error('hosted-provision-operation-already-claimed')
      }
      throw error
    }
    try { await handle.writeFile(JSON.stringify(claim)); await handle.sync() }
    finally { await handle.close() }
    await syncDirectory(this.options.stateDirectory)

    // A claim remains if any mutation or supervisor call fails. Never provision a second member
    // for an operation whose first outcome could have reached Docker.
    await mkdir(claim.workspace, { mode: 0o700 })
    if (!this.options.testOnlyAllowNonRoot) await chown(claim.workspace, this.writable, this.writable)
    await syncDirectory(claim.workspace)
    await syncDirectory(this.options.workspaceParent)

    await mkdir(claim.profile, { mode: 0o700 })
    for (const name of ['home', 'config', 'data', 'cache', 'state', 'tmp']) {
      await mkdir(path.join(claim.profile, name), { mode: 0o700 })
    }
    await mkdir(path.join(claim.profile, 'config', 'opencode'), { mode: 0o700 })
    for (const name of ['data', 'cache', 'state', 'tmp']) {
      const directory = path.join(claim.profile, name)
      if (!this.options.testOnlyAllowNonRoot) await chown(directory, this.writable, this.writable)
      await syncDirectory(directory)
    }
    for (const directory of [path.join(claim.profile, 'config', 'opencode'),
      path.join(claim.profile, 'config'), path.join(claim.profile, 'home')]) {
      await chmod(directory, 0o555)
      await syncDirectory(directory)
    }
    await chmod(claim.profile, 0o555)
    await syncDirectory(claim.profile)
    await syncDirectory(this.options.profileParent)

    await mkdir(claim.config, { mode: 0o700 })
    const configFile = path.join(claim.config, 'opencode.json')
    const configHandle = await open(configFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444)
    try { await configHandle.writeFile(bytes); await configHandle.chmod(0o444); await configHandle.sync() }
    finally { await configHandle.close() }
    await chmod(claim.config, 0o555)
    await syncDirectory(claim.config)
    await syncDirectory(this.options.configParent)

    if ((await readdir(claim.workspace)).length !== 0) throw new Error('hosted-provision-workspace-not-fresh')
    return this.options.supervisor.issueLease({ runId: request.runId, teamId: request.teamId,
      laneId: request.laneId, memberId: request.memberId,
      workspace: claim.workspace, profile: claim.profile, config: claim.config,
      configSha256: sha(bytes) })
  }
}
