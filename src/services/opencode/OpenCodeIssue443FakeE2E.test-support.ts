import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { OpenCodeHostHandle, OpenCodeInventorySnapshot } from './types.js'
import type {
  StrictAttemptIdentity,
  StrictCommittedMember,
  StrictHost,
  StrictHostLease,
  StrictLaunchPorts,
  StrictLaunchRequest,
  StrictLaunchScheduler,
  StrictMaterializedMember,
  StrictMember,
  StrictPortResult,
  StrictProof,
  StrictProofRequest,
  StrictResource,
} from './OpenCodeStrictLaunchCoordinator.js'

export type Projection = { member: string; hostId: string }

export class ManualScheduler implements StrictLaunchScheduler {
  time = 0
  private waits: Array<{ at: number; signal: AbortSignal; resolve: () => void }> = []

  now(): number { return this.time }
  waitUntil(at: number, signal: AbortSignal): Promise<void> {
    if (this.time >= at) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.waits.push({ at, signal, resolve })
      signal.addEventListener('abort', () => reject(new Error('cancelled fake clock')), { once: true })
    })
  }
  advanceTo(time: number): void {
    this.time = time
    for (const wait of this.waits.splice(0)) {
      if (!wait.signal.aborted && wait.at <= time) wait.resolve()
      else this.waits.push(wait)
    }
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const identity = { attemptId: 'attempt-443', generation: 7 }

export class Issue443Harness implements StrictLaunchPorts<string, string, Projection> {
  readonly timeline: string[] = []
  readonly commands: string[][] = []
  readonly writes: Array<{ path: string; kind: string }> = []
  readonly plugins: string[] = []
  readonly endpoints: Array<{ baseUrl: string; endpoint: string }> = []
  readonly mcp: Array<{ hostId: string; action: 'attach' | 'probe' }> = []
  readonly proofs: Array<{ input: StrictProofRequest; output: StrictProof }> = []
  readonly members: string[] = []
  readonly cleanupEvents: StrictResource[][] = []
  readonly releases: Array<{ leaseId: string; keepAlive: boolean; at: number }> = []
  readonly processTrees: Array<{ pid: number; parentPid: number | null; owner: string }> = []
  readonly hosts: Array<{ hostId: string; baseUrl: string; retained: boolean; purpose: string }> = []
  readonly profiles: Array<{ purpose: string; providerId: string; modelId: string }> = []
  readonly committed = new Map<string, StrictCommittedMember<Projection>>()
  readonly scheduler = new ManualScheduler()
  sandbox = ''
  projectPath = ''
  catalogModel = 'deepinfra/meta-llama/Llama-3.3-70B-Instruct'
  catalogGeneration = 'fresh'
  proofOverride: Partial<StrictProof> = {}
  materializeResults = new Map<string, StrictPortResult<StrictMaterializedMember<Projection>>>()
  catalogGate: ReturnType<typeof deferred<void>> | null = null
  private previousEnv = new Map<string, string | undefined>()

  async open(): Promise<void> {
    this.sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-issue443-fake-'))
    this.projectPath = path.join(this.sandbox, 'project')
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) {
      this.previousEnv.set(key, process.env[key])
      process.env[key] = path.join(this.sandbox, key.toLowerCase())
    }
  }

  async close(): Promise<void> {
    for (const [key, value] of this.previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(this.sandbox, { recursive: true, force: true })
  }

  async sandboxEntries(): Promise<string[]> { return readdir(this.sandbox) }

  recordCommand(...args: string[]): void {
    this.commands.push([...args])
    this.assertSafe()
  }

  recordWrite(kind: string, candidate: string): void {
    const normalized = path.resolve(candidate)
    this.assertSandboxPath(normalized)
    this.writes.push({ path: normalized, kind })
  }

  selectPlugin(plugin: string): void {
    this.plugins.push(plugin)
    this.assertSafe()
  }

  assertSafe(): void {
    const flat = this.commands.flat().join(' ')
    if (/models --verbose|agent list|providers\/auth all|providers all|full inventory/i.test(flat)) {
      throw new Error(`broad inventory command escaped fake harness: ${flat}`)
    }
    if (this.plugins.some(plugin => plugin !== 'deepinfra')) {
      throw new Error(`unrelated plugin selected: ${this.plugins.join(',')}`)
    }
    for (const write of this.writes) this.assertSandboxPath(write.path)
    for (const host of this.hosts) {
      if (host.baseUrl !== 'http://fake-host.invalid') throw new Error('non-fake host escaped harness')
    }
  }

  denyRealInvocation(kind: string): never {
    throw new Error(`issue443 harness forbids real ${kind}`)
  }

  catalogInventory(options?: { mode?: string; prewarm?: boolean }): OpenCodeInventorySnapshot {
    this.recordCommand('inventory', options?.mode ?? 'unknown', 'deepinfra')
    if (options?.prewarm) this.selectPlugin('deepinfra')
    const root = path.join(this.sandbox, 'profile')
    return {
      detected: true,
      binaryPath: path.join(this.sandbox, 'fake-opencode'),
      version: 'fake-443',
      projectPath: this.projectPath,
      profile: {
        projectPath: this.projectPath, canonicalProjectPath: this.projectPath,
        workingDirectoryPath: this.projectPath, scopeToken: null, profileRootKey: 'profile-443',
        profileRootPath: root, projectDefaultModelId: null, allProjectsDefaultModelId: null,
        effectiveManagedDefaultModelId: null, effectiveManagedDefaultSource: null,
        projectBehaviorFingerprint: 'behavior-443', behaviorSources: [], managedConfig: {},
        managedConfigFingerprint: 'config-443', homePath: path.join(root, 'home'),
        tmpPath: path.join(root, 'tmp'), xdgConfigHome: path.join(root, 'config'),
        xdgDataHome: path.join(root, 'data'), xdgCacheHome: path.join(root, 'cache'),
        globalAuthPath: path.join(this.sandbox, 'source-auth.json'),
        managedAuthPath: path.join(root, 'data/opencode/auth.json'),
        sourceAuthPath: path.join(this.sandbox, 'source-auth.json'),
        sourceAuthFingerprint: 'auth-443', managedAuthFingerprint: 'auth-443', authState: 'ok', env: {},
      },
      connectedProviders: [{ id: 'deepinfra', authHint: 'api', source: 'credentials', credentialScopes: ['managed'] }],
      availableProviders: ['deepinfra'], models: [this.catalogModel], agents: [],
      authStorePath: path.join(root, 'data/opencode/auth.json'), probeError: null, diagnostics: [],
    }
  }

  catalogHost(): OpenCodeHostHandle {
    this.hosts.push({ hostId: 'catalog-host', baseUrl: 'http://fake-host.invalid', retained: false, purpose: 'catalog' })
    const inventory = this.catalogInventory()
    this.commands.pop()
    return {
      hostKey: 'catalog-host', profileRootKey: 'profile-443', projectPath: this.projectPath,
      projectBehaviorFingerprint: 'behavior-443', baseUrl: 'http://fake-host.invalid', port: 443,
      pid: 44300, version: 'fake-443', state: 'healthy', profile: inventory.profile!,
      resolvedConfigFingerprint: 'config-443', diagnostics: [],
    }
  }

  catalogClient() {
    return {
      getConfigProviders: async () => {
        this.endpoints.push({ baseUrl: 'http://fake-host.invalid', endpoint: '/config/providers' })
        return { providers: [{ id: 'deepinfra', name: 'DeepInfra', models: { [this.catalogModel.slice(10)]: {} } }], default: {} }
      },
      getProviders: async () => {
        this.endpoints.push({ baseUrl: 'http://fake-host.invalid', endpoint: '/provider' })
        if (this.catalogGate) await this.catalogGate.promise
        return { all: [{ id: 'deepinfra', name: 'DeepInfra', models: { [this.catalogModel.slice(10)]: {} } }], connected: ['deepinfra'], default: {} }
      },
      getProviderAuth: async () => this.denyRealInvocation('all-provider auth endpoint'),
    }
  }

  strictRequest(controller = new AbortController()): StrictLaunchRequest<string, string> {
    return {
      ...identity, nonce: 'nonce-443', providerId: 'deepinfra', modelId: this.catalogModel,
      behaviorFingerprint: 'digest-443', mcpTools: ['app_status'],
      members: [{ memberId: 'one', memberFingerprint: 'member-one' }, { memberId: 'two', memberFingerprint: 'member-two' }],
      workContext: 'work', cleanupContext: 'cleanup',
      hostLease: { ...identity, leaseId: 'lease-443', expectedHostId: 'launch-host' },
      deadlineAt: 100, cleanupReserveMs: 20, signal: controller.signal, scheduler: this.scheduler,
    }
  }

  snapshotProjection(value: Projection): Projection { return { ...value } }
  async acquireHost(_work: string, attempt: StrictAttemptIdentity, lease: StrictHostLease): Promise<StrictPortResult<StrictHost>> {
    this.timeline.push(`host:${lease.expectedHostId}`)
    this.profiles.push({ purpose: 'launch_runtime', providerId: 'deepinfra', modelId: this.catalogModel })
    this.hosts.push({ hostId: lease.expectedHostId, baseUrl: 'http://fake-host.invalid', retained: true, purpose: 'launch_runtime' })
    this.processTrees.push({ pid: 44301, parentPid: null, owner: `${attempt.attemptId}:${attempt.generation}` })
    return { kind: 'ok', value: { hostId: lease.expectedHostId } }
  }
  async requestProof(_work: string, host: StrictHost, input: StrictProofRequest): Promise<StrictPortResult<StrictProof>> {
    this.timeline.push(`mcp:${host.hostId}`, `proof:${input.nonce}`)
    this.mcp.push({ hostId: host.hostId, action: 'attach' }, { hostId: host.hostId, action: 'probe' })
    this.endpoints.push({ baseUrl: 'http://fake-host.invalid', endpoint: '/session/exact-model-proof' })
    const output: StrictProof = { ...input, hostId: host.hostId, ...this.proofOverride }
    this.proofs.push({ input, output })
    return { kind: 'ok', value: output }
  }
  async findCommitted(_work: string, member: StrictMember): Promise<StrictPortResult<StrictCommittedMember<Projection> | null>> {
    return { kind: 'ok', value: this.committed.get(member.memberId) ?? null }
  }
  async projectCommitted(): Promise<StrictPortResult<void>> { return { kind: 'ok', value: undefined } }
  async materialize(_work: string, host: StrictHost, member: StrictMember): Promise<StrictPortResult<StrictMaterializedMember<Projection>>> {
    this.timeline.push(`member:${member.memberId}`)
    this.members.push(member.memberId)
    const configured = this.materializeResults.get(member.memberId)
    if (configured) return configured
    const value = { ...identity, ...member, behaviorFingerprint: 'digest-443', projection: { member: member.memberId, hostId: host.hostId }, resource: { ...identity, resourceId: member.memberId, committed: true } }
    this.committed.set(member.memberId, value)
    return { kind: 'ok', value }
  }
  async cleanup(_cleanup: string, resources: StrictResource[]): Promise<void> { this.cleanupEvents.push(resources) }
  async releaseHost(_cleanup: string, lease: StrictHostLease, keepAlive: boolean): Promise<void> {
    this.releases.push({ leaseId: lease.leaseId, keepAlive, at: this.scheduler.now() })
  }

  private assertSandboxPath(candidate: string): void {
    const relative = path.relative(this.sandbox, path.resolve(candidate))
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`real path escaped harness: ${candidate}`)
  }
}
