import { createHash, createHmac, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { hostedMemberStartOperationId } from '../../teamLifecycleOwner/HostedMemberStartOperationId.js'
import type { HostedProductMemberBinding } from '../productAuthority/HostedProductCurrentMemberDecision.js'
import { HostedRootSingleMemberAuthority } from './HostedRootSingleMemberAuthority.js'
import { RootDockerEngineDispatcher, type RootDockerOperation } from './RootDockerEngineDispatcher.js'

const SHA = /^[a-f0-9]{64}$/
const GENERATION = /^[a-f0-9]{32}$/
const HANDLE = /^opencode_[a-f0-9]{32}$/
const OPERATION = /^[a-z][a-z0-9_-]{7,95}$/
const IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/
const GENERATION_LABEL = 'org.agentteams.hosted-opencode.generation'
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

export type RootContainerTarget = Readonly<{
  memberOperationId: string
  handle: string
  generation: string
  networkId: string
  containerId?: string
}>

type Manifest = RootContainerTarget & Readonly<{ body: string }>
type Effect = 'create' | 'start' | 'inspect' | 'stop'

function validTarget(target: RootContainerTarget, withId: boolean): boolean {
  return !!target && Object.keys(target).sort().join(',') ===
    ['memberOperationId', 'handle', 'generation', 'networkId', ...(withId ? ['containerId'] : [])]
      .sort().join(',') && OPERATION.test(target.memberOperationId) && HANDLE.test(target.handle) &&
    GENERATION.test(target.generation) && SHA.test(target.networkId) &&
    (!withId || typeof target.containerId === 'string' && SHA.test(target.containerId))
}

function snapshotTarget(input: RootContainerTarget, withId: boolean): RootContainerTarget {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).some(key => typeof key !== 'string')) {
    throw new Error('root-container-port-target-invalid')
  }
  const copy: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(input) as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('root-container-port-target-invalid')
    }
    copy[key] = descriptor.value
  }
  if (!validTarget(copy as RootContainerTarget, withId)) {
    throw new Error('root-container-port-target-invalid')
  }
  return Object.freeze(copy) as RootContainerTarget
}

function sameTarget(left: RootContainerTarget, right: RootContainerTarget): boolean {
  return Object.keys(left).length === Object.keys(right).length &&
    (Object.keys(left) as Array<keyof RootContainerTarget>).every(key => left[key] === right[key])
}

function operationId(effect: Effect, memberOperationId: string, probe = ''): string {
  return `container_${effect}_${sha(`${memberOperationId}\0${probe}`)}`
}

function operation(effect: Effect, target: RootContainerTarget, body = '', probe = ''): RootDockerOperation {
  const common = { operationId: operationId(effect, target.memberOperationId, probe), bodySha256: sha(body) }
  switch (effect) {
    case 'create': return { ...common, kind: 'create_container', containerName: target.handle, body }
    case 'start': return { ...common, kind: 'start_container', containerId: target.containerId! }
    case 'inspect': return { ...common, kind: 'inspect_container', containerId: target.containerId! }
    case 'stop': return { ...common, kind: 'stop_container', containerId: target.containerId! }
  }
}

/** Inactive typed Docker routes. Root-written manifests are re-read under Product's write lock. */
export class RootDockerContainerPort {
  private readonly dispatcher: RootDockerEngineDispatcher<HostedProductMemberBinding>
  private readonly identity: Readonly<{ dev: number; ino: number }>
  private readonly uid: number
  private readonly binding: HostedProductMemberBinding
  private readonly passwordKey: Buffer

  private constructor(private readonly stateDirectory: string,
    authority: HostedRootSingleMemberAuthority,
    binding: HostedProductMemberBinding,
    private readonly options: { effectClaimDirectory: string; socketPath: string; image: string;
      serverPasswordKey: Uint8Array;
      networkId: string; testOnlyAllowNonRoot?: boolean }) {
    if (!path.isAbsolute(stateDirectory) || path.normalize(stateDirectory) !== stateDirectory ||
      !IMAGE.test(options.image) || !SHA.test(options.networkId) ||
      !options.serverPasswordKey || options.serverPasswordKey.length !== 32) {
      throw new Error('root-container-port-state-invalid')
    }
    this.passwordKey = Buffer.from(options.serverPasswordKey)
    this.uid = process.getuid?.() ?? -1
    const stat = lstatSync(stateDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid ||
      (stat.mode & 0o777) !== 0o700 || realpathSync(stateDirectory) !== stateDirectory) {
      throw new Error('root-container-port-state-invalid')
    }
    this.identity = { dev: stat.dev, ino: stat.ino }
    this.binding = Object.freeze({ ...binding })
    this.dispatcher = RootDockerEngineDispatcher.create({ stateDir: options.effectClaimDirectory,
      socketPath: options.socketPath, decision: authority, testOnlyAllowNonRoot: options.testOnlyAllowNonRoot,
      resolveAuthorizedOperation: (_binding, _current, id) => this.resolve(id),
    })
  }

  static create(options: { stateDirectory: string; effectClaimDirectory: string; socketPath: string;
    authority: HostedRootSingleMemberAuthority; binding: HostedProductMemberBinding;
    image: string; networkId: string; serverPasswordKey: Uint8Array;
    testOnlyAllowNonRoot?: boolean }): RootDockerContainerPort {
    return new RootDockerContainerPort(options.stateDirectory, options.authority,
      options.binding, options)
  }

  private read<T>(fileName: string, maxBytes: number): T {
    const directory = lstatSync(this.stateDirectory)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== this.uid ||
      (directory.mode & 0o777) !== 0o700 || directory.dev !== this.identity.dev ||
      directory.ino !== this.identity.ino || realpathSync(this.stateDirectory) !== this.stateDirectory) {
      throw new Error('root-container-port-state-substituted')
    }
    const fd = openSync(path.join(this.stateDirectory, fileName), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.uid ||
        (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > maxBytes) {
        throw new Error('root-container-port-claim-invalid')
      }
      const bytes = readFileSync(fd)
      if (bytes.length !== stat.size) throw new Error('root-container-port-claim-invalid')
      return JSON.parse(bytes.toString('utf8')) as T
    } finally { closeSync(fd) }
  }

  private manifest(memberOperationId: string): Manifest {
    if (!OPERATION.test(memberOperationId)) throw new Error('root-container-port-target-invalid')
    const value = this.read<Manifest>(`container-create-${memberOperationId}.json`, 256 * 1024 + 512)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('root-container-port-manifest-invalid')
    }
    const { body, ...target } = value
    if (Object.keys(value).sort().join(',') !==
      ['memberOperationId', 'handle', 'generation', 'networkId', 'body'].sort().join(',') ||
      !validTarget(target, false) || target.memberOperationId !== memberOperationId ||
      memberOperationId !== hostedMemberStartOperationId(this.binding.runId, this.binding.memberId,
        this.binding.planSha256) || target.networkId !== this.options.networkId ||
      typeof body !== 'string' || Buffer.byteLength(body) > 256 * 1024) {
      throw new Error('root-container-port-manifest-invalid')
    }
    const spec: unknown = JSON.parse(body)
    const row = spec as Record<string, unknown>
    const labels = row?.Labels as Record<string, unknown> | undefined
    const host = row?.HostConfig as Record<string, unknown> | undefined
    const env = row?.Env
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
      row.Image !== this.options.image || !labels || typeof labels !== 'object' ||
      labels[GENERATION_LABEL] !== target.generation || !host || typeof host !== 'object' ||
      host.NetworkMode !== this.options.networkId || host.ReadonlyRootfs !== true ||
      host.Privileged !== false || !Array.isArray(host.CapDrop) ||
      host.CapDrop.length !== 1 || host.CapDrop[0] !== 'ALL' || !Array.isArray(env) ||
      env.filter(value => value === 'OPENCODE_SERVER_PASSWORD').length !== 1 ||
      env.some(value => typeof value !== 'string' || value.startsWith('OPENCODE_SERVER_PASSWORD='))) {
      throw new Error('root-container-port-manifest-invalid')
    }
    return value
  }

  private createBody(manifest: Manifest): string {
    const spec = JSON.parse(manifest.body) as Record<string, unknown>
    const password = createHmac('sha256', this.passwordKey)
      .update(`agent-teams.hosted-opencode-server/v1\0${manifest.generation}`).digest('hex')
    spec.Env = (spec.Env as string[]).map(value => value === 'OPENCODE_SERVER_PASSWORD'
      ? `OPENCODE_SERVER_PASSWORD=${password}` : value)
    return JSON.stringify(spec)
  }

  private target(memberOperationId: string): RootContainerTarget {
    if (!OPERATION.test(memberOperationId)) throw new Error('root-container-port-target-invalid')
    const value = this.read<RootContainerTarget>(`container-target-${memberOperationId}.json`, 512)
    if (!validTarget(value, true) || value.memberOperationId !== memberOperationId) {
      throw new Error('root-container-port-target-invalid')
    }
    const manifest = this.manifest(memberOperationId)
    if (value.handle !== manifest.handle || value.generation !== manifest.generation ||
      value.networkId !== manifest.networkId) throw new Error('root-container-port-target-conflict')
    return value
  }

  private resolve(id: string): RootDockerOperation {
    // No general Docker proxy: only an operation derived from this root-owned claim can be dispatched.
    const name = /^container_(create|start|stop|inspect)_([a-f0-9]{64})$/.exec(id)
    if (!name) throw new Error('root-container-port-operation-invalid')
    const original = this.operationTargets.get(id)
    if (!original) throw new Error('root-container-port-operation-invalid')
    const memberOperationId = original.memberOperationId
    const effect = name[1] as Effect
    const probe = effect === 'inspect' ? this.inspectProbes.get(id) : ''
    if (effect === 'inspect' && !probe) throw new Error('root-container-port-probe-invalid')
    const target = effect === 'create' ? this.manifest(memberOperationId) : this.target(memberOperationId)
    const { body: _body, ...resolvedTarget } = target as Manifest
    if (!sameTarget(original, resolvedTarget)) throw new Error('root-container-port-target-changed')
    const candidate = operation(effect, target,
      effect === 'create' ? this.createBody(target as Manifest) : '', probe)
    if (candidate.operationId !== id) throw new Error('root-container-port-operation-unbound')
    return candidate
  }

  private readonly inspectProbes = new Map<string, string>()
  private readonly operationTargets = new Map<string, RootContainerTarget>()

  private assertCaller(target: RootContainerTarget, withId: boolean): void {
    if (!validTarget(target, withId)) throw new Error('root-container-port-target-invalid')
    const root = withId ? this.target(target.memberOperationId) : this.manifest(target.memberOperationId)
    for (const key of ['memberOperationId', 'handle', 'generation', 'networkId',
      ...(withId ? ['containerId'] : [])] as const) {
      if (target[key as keyof RootContainerTarget] !== root[key as keyof RootContainerTarget]) {
        throw new Error('root-container-port-target-unbound')
      }
    }
  }

  private async send(effect: Effect, target: RootContainerTarget): Promise<Buffer> {
    const withId = effect !== 'create'
    const stableTarget = snapshotTarget(target, withId)
    this.assertCaller(stableTarget, withId)
    const probe = effect === 'inspect' ? randomBytes(16).toString('hex') : ''
    const manifest = effect === 'create' ? this.manifest(stableTarget.memberOperationId) : undefined
    const op = operation(effect, stableTarget, manifest ? this.createBody(manifest) : '', probe)
    if (this.operationTargets.has(op.operationId)) throw new Error('root-container-port-operation-busy')
    this.operationTargets.set(op.operationId, stableTarget)
    if (effect === 'inspect') this.inspectProbes.set(op.operationId, probe)
    try {
      const result = await this.dispatcher.dispatch(op, this.binding)
      if (result.outcome !== 'responded') throw new Error(`root-container-port-${effect}-unresolved`)
      return result.body
    } finally {
      this.operationTargets.delete(op.operationId)
      if (effect === 'inspect') this.inspectProbes.delete(op.operationId)
    }
  }

  async createContainer(target: RootContainerTarget): Promise<string> {
    const body = await this.send('create', target)
    let value: unknown
    try { value = JSON.parse(body.toString('utf8')) } catch { throw new Error('root-container-port-create-unresolved') }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof (value as Record<string, unknown>).Id !== 'string' ||
      !SHA.test((value as Record<string, string>).Id)) throw new Error('root-container-port-create-unresolved')
    return (value as { Id: string }).Id
  }

  async startContainer(target: RootContainerTarget): Promise<void> { await this.send('start', target) }
  async inspectContainer(target: RootContainerTarget): Promise<Record<string, unknown>> {
    const body = await this.send('inspect', target)
    let value: unknown
    try { value = JSON.parse(body.toString('utf8')) } catch { throw new Error('root-container-port-inspect-unresolved') }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value as Record<string, unknown>).Id !== target.containerId) {
      throw new Error('root-container-port-inspect-unresolved')
    }
    return value as Record<string, unknown>
  }
  async stopCurrentContainer(target: RootContainerTarget): Promise<void> { await this.send('stop', target) }
  async inspectImage(): Promise<never> { throw new Error('root-container-port-image-inspect-unavailable') }
  async inspectNetwork(): Promise<never> { throw new Error('root-container-port-network-inspect-unavailable') }
  async removeContainer(): Promise<never> { throw new Error('root-container-port-remove-unavailable') }
}
