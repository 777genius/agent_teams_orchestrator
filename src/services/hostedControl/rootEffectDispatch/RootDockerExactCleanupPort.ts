import { createHash, randomBytes } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, writeSync } from 'node:fs'
import path from 'node:path'

import { hostedMemberStartOperationId } from '../../teamLifecycleOwner/HostedMemberStartOperationId.js'
import type { HostedProductMemberBinding } from '../productAuthority/HostedProductCurrentMemberDecision.js'
import { withRootDockerContainerOperationLock } from './RootDockerContainerOperationLock.js'
import { RootDockerEngineDispatcher, type RootCurrentMemberDecision,
  type RootDockerOperation } from './RootDockerEngineDispatcher.js'

const SHA = /^[a-f0-9]{64}$/
const GENERATION = /^[a-f0-9]{32}$/
const HANDLE = /^opencode_[a-f0-9]{32}$/
const IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/
const GENERATION_LABEL = 'org.agentteams.hosted-opencode.generation'
const OPERATION_LABEL = 'org.agentteams.hosted-opencode.member-operation-id'
const RUN_LABEL = 'org.agentteams.hosted-opencode.run-id'
const MEMBER_LABEL = 'org.agentteams.hosted-opencode.member-id'
const WORKSPACE_LABEL = 'org.agentteams.hosted-opencode.runtime-workspace-id'
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('root-container-cleanup-proof-invalid')
  }
  return value as Record<string, unknown>
}
const exact = (value: unknown, keys: readonly string[]): boolean => {
  try { return Object.keys(object(value)).sort().join(',') === [...keys].sort().join(',') }
  catch { return false }
}

type Owned = Readonly<{ memberOperationId: string; handle: string; generation: string;
  networkId: string; containerId: string; workspace: string; profile: string; config: string }>
type Options = Readonly<{ stateDirectory: string; effectClaimDirectory: string; socketPath: string;
  binding: HostedProductMemberBinding; image: string; imageId: string; networkId: string;
  workspaceParent: string; profileParent: string; configParent: string;
  testOnlyAllowNonRoot?: boolean }>
type Directory = Readonly<{ name: string; dev: number; ino: number }>

function directories(name: string, uid: number, test: boolean): readonly Directory[] {
  const result: Directory[] = []
  for (let current = name; ; current = path.dirname(current)) {
    const stat = lstatSync(current)
    const leaf = current === name
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current ||
      (leaf ? stat.uid !== uid || (stat.mode & 0o777) !== 0o700 :
        !test && (stat.uid !== 0 || (stat.mode & 0o022) !== 0))) {
      throw new Error('root-container-cleanup-directory-untrusted')
    }
    result.push({ name: current, dev: stat.dev, ino: stat.ino })
    if (current === path.dirname(current)) return result
  }
}

function file(directory: string, name: string, maxBytes: number, uid: number): unknown {
  const fd = openSync(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > maxBytes) {
      throw new Error('root-container-cleanup-claim-invalid')
    }
    const bytes = readFileSync(fd)
    if (bytes.length !== stat.size) throw new Error('root-container-cleanup-claim-invalid')
    return JSON.parse(bytes.toString('utf8')) as unknown
  } finally { closeSync(fd) }
}

function exists(directory: string, name: string): boolean {
  try { lstatSync(path.join(directory, name)); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function boundPath(value: unknown, parent: string): value is string {
  return typeof value === 'string' && path.dirname(value) === parent &&
    GENERATION.test(path.basename(value))
}

function operation(kind: 'inspect_container' | 'inspect_container_absence' |
  'stop_container' | 'remove_container', owned: Owned, probe = ''): RootDockerOperation {
  const id = kind === 'stop_container' ? 'stop' : kind === 'remove_container' ? 'remove' :
    kind === 'inspect_container_absence' ? 'absence' : 'inspect'
  return { kind, containerId: owned.containerId,
    operationId: `cleanup_${id}_${sha(`${owned.memberOperationId}\0${probe}`)}`,
    bodySha256: sha('') }
}

/** Historical root ownership permits cleanup after Product revocation, never a fresh agent effect. */
export class RootDockerExactCleanupPort {
  private readonly dispatcher: RootDockerEngineDispatcher<HostedProductMemberBinding>
  private readonly options: Options
  private readonly uid: number
  private readonly stateDirectories: readonly Directory[]
  private readonly effectDirectories: readonly Directory[]
  private readonly pending = new Map<string, Readonly<{ operation: RootDockerOperation; owned: Owned }>>()

  private constructor(options: Options) {
    const test = options.testOnlyAllowNonRoot === true && process.env.NODE_ENV === 'test'
    if (!test && (process.platform !== 'linux' || process.getuid?.() !== 0) ||
      !IMAGE.test(options.image) || !/^sha256:[a-f0-9]{64}$/.test(options.imageId) ||
      !SHA.test(options.networkId) ||
      ![options.stateDirectory, options.effectClaimDirectory, options.workspaceParent,
        options.profileParent, options.configParent].every(value => typeof value === 'string' &&
        path.isAbsolute(value) && path.normalize(value) === value)) {
      throw new Error('root-container-cleanup-policy-invalid')
    }
    this.uid = process.getuid?.() ?? -1
    this.options = Object.freeze({ ...options, binding: Object.freeze({ ...options.binding }) })
    this.stateDirectories = directories(options.stateDirectory, this.uid, test)
    this.effectDirectories = directories(options.effectClaimDirectory, this.uid, test)
    const decision: RootCurrentMemberDecision<HostedProductMemberBinding> = {
      withCurrentMemberDecision: async <T>(binding: HostedProductMemberBinding,
        _kind: 'prepare' | 'start' | 'observe' | 'stop', callback: (current: unknown) => T): Promise<T> => {
        if (JSON.stringify(binding) !== JSON.stringify(this.options.binding)) {
          throw new Error('root-container-cleanup-binding-invalid')
        }
        // No Product positive grant here: a retired member must still be cleaned up.
        return callback(this.readOwnership())
      },
    }
    this.dispatcher = RootDockerEngineDispatcher.create({ stateDir: options.effectClaimDirectory,
      socketPath: options.socketPath, decision, testOnlyAllowNonRoot: options.testOnlyAllowNonRoot,
      resolveAuthorizedOperation: (_binding, current, id) => {
        const held = this.pending.get(id)
        const actual = this.readOwnership()
        if (!held || JSON.stringify(held.owned) !== JSON.stringify(actual) ||
          JSON.stringify(current) !== JSON.stringify(actual)) {
          throw new Error('root-container-cleanup-owner-changed')
        }
        return held.operation
      },
    })
  }

  static create(options: Options): RootDockerExactCleanupPort { return new RootDockerExactCleanupPort(options) }

  private assertDirectories(): void {
    for (const [name, expected] of [[this.options.stateDirectory, this.stateDirectories],
      [this.options.effectClaimDirectory, this.effectDirectories]] as const) {
      const actual = directories(name, this.uid,
        this.options.testOnlyAllowNonRoot === true && process.env.NODE_ENV === 'test')
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error('root-container-cleanup-directory-substituted')
      }
    }
  }

  private readOwnership(): Owned {
    this.assertDirectories()
    const binding = this.options.binding
    const memberOperationId = hostedMemberStartOperationId(binding.runId, binding.memberId,
      binding.planSha256)
    const manifest = file(this.options.stateDirectory,
      `container-create-${memberOperationId}.json`, 256 * 1024 + 512, this.uid)
    const target = file(this.options.stateDirectory,
      `container-target-${memberOperationId}.json`, 512, this.uid)
    if (!exact(manifest, ['memberOperationId', 'handle', 'generation', 'networkId', 'body']) ||
      !exact(target, ['memberOperationId', 'handle', 'generation', 'networkId', 'containerId'])) {
      throw new Error('root-container-cleanup-ownership-invalid')
    }
    const m = manifest as Record<string, unknown>
    const t = target as Record<string, unknown>
    if (m.memberOperationId !== memberOperationId || t.memberOperationId !== memberOperationId ||
      !HANDLE.test(String(m.handle)) || !GENERATION.test(String(m.generation)) ||
      m.networkId !== this.options.networkId || !SHA.test(String(t.containerId)) ||
      t.handle !== m.handle || t.generation !== m.generation || t.networkId !== m.networkId ||
      typeof m.body !== 'string' || Buffer.byteLength(m.body) > 256 * 1024) {
      throw new Error('root-container-cleanup-ownership-invalid')
    }
    const body = object(JSON.parse(m.body))
    const host = object(body.HostConfig)
    const labels = object(body.Labels)
    const mounts = host.Mounts
    if (body.Image !== this.options.image || labels[GENERATION_LABEL] !== m.generation ||
      labels[OPERATION_LABEL] !== memberOperationId || labels[RUN_LABEL] !== binding.runId ||
      labels[MEMBER_LABEL] !== binding.memberId ||
      labels[WORKSPACE_LABEL] !== binding.runtimeWorkspaceId ||
      host.NetworkMode !== this.options.networkId || !Array.isArray(mounts) || mounts.length !== 3) {
      throw new Error('root-container-cleanup-ownership-invalid')
    }
    const byTarget = new Map(mounts.map(value => {
      const row = object(value)
      return [row.Target, row.Source]
    }))
    const workspace = byTarget.get('/sandbox/workspace')
    const profile = byTarget.get('/sandbox/profile')
    const config = byTarget.get('/sandbox/config')
    if (byTarget.size !== 3 || !boundPath(workspace, this.options.workspaceParent) ||
      !boundPath(profile, this.options.profileParent) ||
      !boundPath(config, this.options.configParent)) {
      throw new Error('root-container-cleanup-ownership-invalid')
    }
    const createId = `container_create_${sha(`${memberOperationId}\0`)}`
    const claim = file(this.options.effectClaimDirectory, `${sha(createId)}.claim`, 2048, this.uid)
    if (!exact(claim, ['operationId', 'kind', 'method', 'uri', 'bodySha256', 'bindingSha256'])) {
      throw new Error('root-container-cleanup-create-claim-invalid')
    }
    const c = claim as Record<string, unknown>
    if (c.operationId !== createId || c.kind !== 'create_container' || c.method !== 'POST' ||
      c.uri !== `/v1.47/containers/create?name=${m.handle}` || !SHA.test(String(c.bodySha256)) ||
      c.bindingSha256 !== sha(JSON.stringify(binding))) {
      throw new Error('root-container-cleanup-create-claim-invalid')
    }
    this.assertDirectories()
    return Object.freeze({ memberOperationId, handle: m.handle as string,
      generation: m.generation as string, networkId: this.options.networkId,
      containerId: t.containerId as string, workspace, profile, config })
  }

  private async send(kind: 'inspect_container' | 'inspect_container_absence' |
    'stop_container' | 'remove_container', owned: Owned): Promise<Buffer> {
    const probe = kind.startsWith('inspect_') ? randomBytes(16).toString('hex') : ''
    const op = operation(kind, owned, probe)
    if (this.pending.has(op.operationId)) throw new Error('root-container-cleanup-operation-busy')
    this.pending.set(op.operationId, { operation: op, owned })
    try {
      const result = await this.dispatcher.dispatch(op, this.options.binding)
      if (result.outcome !== 'responded') throw new Error('root-container-cleanup-unresolved')
      return result.body
    } finally { this.pending.delete(op.operationId) }
  }

  private async inspect(owned: Owned): Promise<Record<string, unknown>> {
    const inspected = object(JSON.parse((await this.send('inspect_container', owned)).toString('utf8')))
    const labels = object(object(inspected.Config).Labels)
    const host = object(inspected.HostConfig)
    const networks = object(object(inspected.NetworkSettings).Networks)
    const attached = Object.values(networks)
    const mounts = inspected.Mounts
    const expected = [[owned.workspace, '/sandbox/workspace', true],
      [owned.profile, '/sandbox/profile', true], [owned.config, '/sandbox/config', false]]
    const actual = Array.isArray(mounts) ? mounts.map(value => {
      const row = object(value)
      return [row.Source, row.Destination, row.RW]
    }) : []
    if (inspected.Id !== owned.containerId || inspected.Name !== `/${owned.handle}` ||
      inspected.Image !== this.options.imageId || object(inspected.Config).Image !== this.options.image ||
      labels[GENERATION_LABEL] !== owned.generation ||
      labels[OPERATION_LABEL] !== owned.memberOperationId ||
      labels[RUN_LABEL] !== this.options.binding.runId ||
      labels[MEMBER_LABEL] !== this.options.binding.memberId ||
      labels[WORKSPACE_LABEL] !== this.options.binding.runtimeWorkspaceId ||
      host.NetworkMode !== owned.networkId ||
      attached.length !== 1 || object(attached[0]).NetworkID !== owned.networkId ||
      JSON.stringify(actual.sort()) !== JSON.stringify(expected.sort()) ||
      typeof object(inspected.State).Running !== 'boolean') {
      throw new Error('root-container-cleanup-docker-identity-invalid')
    }
    return inspected
  }

  private stopReceiptName(owned: Owned): string {
    return `cleanup-stop-responded-${owned.memberOperationId}.json`
  }

  private assertStopResolved(owned: Owned): void {
    this.assertDirectories()
    const stop = operation('stop_container', owned)
    const claimName = `${sha(stop.operationId)}.claim`
    const receiptName = this.stopReceiptName(owned)
    const claimed = exists(this.options.effectClaimDirectory, claimName)
    const acknowledged = exists(this.options.stateDirectory, receiptName)
    if (!claimed && !acknowledged) return
    if (!claimed || !acknowledged) throw new Error('root-container-cleanup-stop-unresolved')
    const claim = file(this.options.effectClaimDirectory, claimName, 2048, this.uid)
    const receipt = file(this.options.stateDirectory, receiptName, 512, this.uid)
    if (!exact(claim, ['operationId', 'kind', 'method', 'uri', 'bodySha256', 'bindingSha256']) ||
      !exact(receipt, ['operationId', 'containerId', 'generation', 'memberOperationId'])) {
      throw new Error('root-container-cleanup-stop-unresolved')
    }
    const c = claim as Record<string, unknown>
    const r = receipt as Record<string, unknown>
    if (c.operationId !== stop.operationId || c.kind !== 'stop_container' || c.method !== 'POST' ||
      c.uri !== `/v1.47/containers/${owned.containerId}/stop` || c.bodySha256 !== sha('') ||
      c.bindingSha256 !== sha(JSON.stringify(this.options.binding)) ||
      r.operationId !== stop.operationId || r.containerId !== owned.containerId ||
      r.generation !== owned.generation || r.memberOperationId !== owned.memberOperationId) {
      throw new Error('root-container-cleanup-stop-unresolved')
    }
    this.assertDirectories()
  }

  private recordStopped(owned: Owned): void {
    this.assertDirectories()
    const payload = Buffer.from(JSON.stringify({ operationId: operation('stop_container', owned).operationId,
      containerId: owned.containerId, generation: owned.generation,
      memberOperationId: owned.memberOperationId }))
    const fd = openSync(path.join(this.options.stateDirectory, this.stopReceiptName(owned)),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      let offset = 0
      while (offset < payload.length) {
        const count = writeSync(fd, payload, offset, payload.length - offset)
        if (count < 1) throw new Error('root-container-cleanup-stop-receipt-unresolved')
        offset += count
      }
      fsyncSync(fd)
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.uid ||
        (stat.mode & 0o777) !== 0o600 || stat.size !== payload.length) {
        throw new Error('root-container-cleanup-stop-receipt-unresolved')
      }
    } finally { closeSync(fd) }
    const dir = openSync(this.options.stateDirectory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(dir)
      if (stat.dev !== this.stateDirectories[0].dev || stat.ino !== this.stateDirectories[0].ino) {
        throw new Error('root-container-cleanup-directory-substituted')
      }
      fsyncSync(dir)
    } finally { closeSync(dir) }
    this.assertStopResolved(owned)
  }

  /** No Owner target, no search, no retry. Ambiguous outcomes require operator reconciliation. */
  async cleanup(): Promise<'removed'> {
    const owned = this.readOwnership()
    return withRootDockerContainerOperationLock(owned.memberOperationId, async () => {
      this.assertStopResolved(owned)
      const first = await this.inspect(owned)
      if (object(first.State).Running === true) {
        await this.send('stop_container', owned)
        this.recordStopped(owned)
      }
      const stopped = await this.inspect(owned)
      if (object(stopped.State).Running !== false) throw new Error('root-container-cleanup-still-running')
      this.assertStopResolved(owned)
      await this.send('remove_container', owned)
      await this.send('inspect_container_absence', owned)
      return 'removed' as const
    })
  }
}
