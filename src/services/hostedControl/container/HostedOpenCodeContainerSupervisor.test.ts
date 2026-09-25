import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  HostedContainerNotFound,
  HostedDockerCliRunner,
  HostedOpenCodeContainerSupervisor,
  type HostedDockerRunner,
} from './HostedOpenCodeContainerSupervisor.js'
import { HostedOpenCodeSupervisorRpcClient, HostedOpenCodeSupervisorRpcServer } from './HostedOpenCodeSupervisorRpc.js'

const IMAGE = `example.invalid/opencode@sha256:${'a'.repeat(64)}`
const IMAGE_ID = `sha256:${'b'.repeat(64)}`
const BOOTSTRAP_SHA = 'e'.repeat(64)
const NETWORK_ID = 'c'.repeat(64)
const CONTAINER_ID = 'd'.repeat(64)
const CONFIG_BYTES = Buffer.from('{"provider":{}}\n')
const ENV = [
  'HOME=/sandbox/profile/home',
  'XDG_CONFIG_HOME=/sandbox/profile/config',
  'XDG_DATA_HOME=/sandbox/profile/data',
  'XDG_CACHE_HOME=/sandbox/profile/cache',
  'XDG_STATE_HOME=/sandbox/profile/state',
  'TMPDIR=/sandbox/profile/tmp',
  'OPENCODE_CONFIG_DIR=/sandbox/config',
  'OPENCODE_DISABLE_PROJECT_CONFIG=1',
  'OPENCODE_DISABLE_CLAUDE_CODE=1',
]

function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

class FakeDocker implements HostedDockerRunner {
  readonly calls: string[][] = []
  created: string[] | null = null
  exists = false
  running = false
  mutate: ((row: Record<string, unknown>) => void) | null = null
  createFailure = false
  uncertainStop = false
  networkOccupied = false
  occupyAfterCreate = false
  networkInternal = true
  serverPassword = ''

  async runWithEnvironment(environment: Readonly<Record<string, string>>, ...args: string[]): Promise<string> {
    this.serverPassword = environment.OPENCODE_SERVER_PASSWORD
    return this.run(...args)
  }

  async run(...args: string[]): Promise<string> {
    this.calls.push(args)
    if (args[0] === 'image') return JSON.stringify({ Id: IMAGE_ID, RepoDigests: [IMAGE],
      Config: { Labels: { 'org.agentteams.hosted-opencode.bootstrap-sha256': BOOTSTRAP_SHA } } })
    if (args[0] === 'network') return JSON.stringify({ Id: NETWORK_ID, Driver: 'bridge', Scope: 'local',
      Internal: this.networkInternal,
      Containers: this.networkOccupied ? { foreign: { Name: 'foreign' } } : this.exists && this.running
        ? { [CONTAINER_ID]: { Name: this.created![this.created!.indexOf('--name') + 1] } } : {} })
    if (args[0] === 'create') {
      this.created = args
      this.exists = true
      if (this.occupyAfterCreate) this.networkOccupied = true
      if (this.createFailure) throw new Error('reply lost')
      return CONTAINER_ID
    }
    if (args[0] === 'inspect') {
      if (!this.exists) throw new HostedContainerNotFound('missing')
      const created = this.created!
      const value = (flag: string) => created[created.indexOf(flag) + 1]
      const values = (flag: string) => created.flatMap((arg, index) => arg === flag ? [created[index + 1]] : [])
      const mounts = values('--mount').map(spec => {
        const fields = Object.fromEntries(spec.split(',').filter(part => part.includes('=')).map(part => part.split('=', 2)))
        return { Source: fields.source, Destination: fields.target, RW: !spec.includes(',readonly') }
      })
      const security = values('--security-opt').map(value =>
        value.startsWith('seccomp=') ? `seccomp=${JSON.stringify({ defaultAction: 'SCMP_ACT_ERRNO', syscalls: [] })}` : value)
      const row: Record<string, unknown> = {
        Id: CONTAINER_ID, Image: IMAGE_ID, Name: `/${value('--name')}`,
        AppArmorProfile: 'agent-teams-test',
        Config: { Image: IMAGE, User: '1000:1000', Entrypoint: ['/usr/local/bin/hosted-opencode-fd3-bootstrap'],
          Cmd: created.slice(created.indexOf(IMAGE) + 1), Env: [...ENV,
            `OPENCODE_SERVER_PASSWORD=${this.serverPassword}`],
          Labels: { 'org.agentteams.hosted-opencode.generation': value('--label').split('=')[1] } },
        HostConfig: { ReadonlyRootfs: true, Privileged: false, NetworkMode: NETWORK_ID,
          PidMode: '', IpcMode: 'private', CapDrop: ['ALL'], CapAdd: [],
          SecurityOpt: security, PidsLimit: 64, Memory: 1024 * 1024 * 1024,
          NanoCpus: 1_000_000_000, Tmpfs: { '/etc/opencode': 'ro,noexec,nosuid,nodev,size=4096' },
          PortBindings: { '4096/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
        NetworkSettings: { Networks: { isolated: { NetworkID: NETWORK_ID } },
          Ports: { '4096/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] } },
        Mounts: mounts, State: { Running: this.running, Pid: this.running ? 99999 : 0 },
      }
      this.mutate?.(row)
      return JSON.stringify(row)
    }
    if (args[0] === 'start') this.running = true
    if (args[0] === 'stop' && !this.uncertainStop) this.running = false
    if (args[0] === 'rm') this.exists = false
    return ''
  }
}

async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hosted-container-supervisor-')))
  const parents = ['workspace', 'profile', 'config', 'state'].map(name => path.join(root, name))
  for (const parent of parents) await mkdir(parent, { mode: 0o700 })
  const [workspaceParent, profileParent, configParent, stateDirectory] = parents
  const workspace = path.join(workspaceParent, '1'.repeat(24))
  const profile = path.join(profileParent, '2'.repeat(24))
  const config = path.join(configParent, '3'.repeat(24))
  await mkdir(workspace, { mode: 0o700 })
  await prepareProfile(profile)
  await mkdir(config, { mode: 0o700 })
  await writeFile(path.join(config, 'opencode.json'), CONFIG_BYTES, { mode: 0o444 })
  await chmod(config, 0o555)
  const seccompPath = path.join(root, 'seccomp.json')
  const seccomp = Buffer.from('{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}')
  await writeFile(seccompPath, seccomp, { mode: 0o400 })
  const docker = new FakeDocker()
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  const options = {
    image: IMAGE, bootstrapSha256: BOOTSTRAP_SHA, networkId: NETWORK_ID, workspaceParent, profileParent, configParent,
    stateDirectory, seccompPath, seccompSha256: sha(seccomp), apparmorProfile: 'agent-teams-test',
    docker, serverPasswordKey: Buffer.alloc(32, 7), testOnlyAllowNonRoot: true, ...overrides,
  }
  const supervisor = await HostedOpenCodeContainerSupervisor.create(options)
  const leaseId = await supervisor.issueLease({ runId: 'run_12345678', teamId: 'team_12345678',
    laneId: 'lane_12345678', memberId: 'member_12345678', workspace, profile, config, configSha256: sha(CONFIG_BYTES) })
  const start = (operationId = 'start_12345678') => supervisor.start({ operationId, leaseId,
    runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678', memberId: 'member_12345678' })
  const cleanup = async () => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    await chmod(config, 0o700)
    await resetProfile(profile)
    await rm(root, { recursive: true, force: true })
  }
  return { root, workspace, profile, config, docker, supervisor, options, leaseId, start, cleanup }
}

async function prepareProfile(profile: string): Promise<void> {
  await mkdir(profile, { mode: 0o700 })
  await mkdir(path.join(profile, 'home'), { mode: 0o555 })
  await mkdir(path.join(profile, 'config'), { mode: 0o700 })
  await mkdir(path.join(profile, 'config', 'opencode'), { mode: 0o555 })
  await chmod(path.join(profile, 'config'), 0o555)
  for (const name of ['data', 'cache', 'state', 'tmp']) await mkdir(path.join(profile, name), { mode: 0o700 })
  await chmod(profile, 0o555)
}

async function resetProfile(profile: string): Promise<void> {
  await chmod(profile, 0o700)
  await chmod(path.join(profile, 'config'), 0o700)
}

describe('disposable hosted OpenCode container supervisor', () => {
  test('credential handoff is unavailable outside the isolated fake-Docker test mode', async () => {
    const evidence = { pid: 99999, startTicks: '123', pidNamespace: 'pid:[456]', netns: 'net:[789]' }
    const f = await fixture({ testOnlyProcessEvidence: async () => evidence,
      testOnlyHandoff: { run: async () => undefined } })
    try {
      const started = await f.supervisor.start({ operationId: 'start_12345678', leaseId: f.leaseId,
        runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678',
        memberId: 'member_12345678', ownerChannel: {
          socketPath: '/tmp/pending-owner-test.sock', challenge: 'a'.repeat(64),
        } })
      process.env.NODE_ENV = 'production'
      await expect(f.supervisor.beginEndpointUse({ operationId: 'use_12345678', handle: started.handle,
        generation: started.generation })).rejects.toThrow('hosted-container-owner-http-credential-disabled')
      expect(f.docker.calls.filter(call => call[0] === 'stop')).toHaveLength(0)
    } finally { await f.cleanup() }
  })

  test('one pending Owner generation becomes ready only after FD3 and independent official proof', async () => {
    const phases: string[] = []
    const evidence = { pid: 99999, startTicks: '123', pidNamespace: 'pid:[456]', netns: 'net:[789]' }
    const f = await fixture({
      testOnlyProcessEvidence: async (_pid: number, phase: string) => { phases.push(phase); return evidence },
      testOnlyHandoff: { run: async () => { phases.push('handoff') } },
    })
    const ownerChannel = { socketPath: '/tmp/pending-owner-test.sock', challenge: 'a'.repeat(64) }
    try {
      const started = await f.supervisor.start({ operationId: 'start_12345678', leaseId: f.leaseId,
        runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678',
        memberId: 'member_12345678', ownerChannel })
      expect(started).toMatchObject({ status: 'started', effectEnabled: true })
      expect(started).not.toHaveProperty('serverPassword')
      expect(phases.slice(0, 3)).toEqual(['bootstrap', 'handoff', 'official'])
      expect(await readFile(path.join(f.options.stateDirectory, 'handoff-start_12345678.json'), 'utf8'))
        .toContain(started.generation)
      expect(await f.supervisor.observe({ operationId: 'observe_12345678', handle: started.handle,
        generation: started.generation })).toMatchObject({ status: 'running', effectEnabled: true })
      const use = await f.supervisor.beginEndpointUse({ operationId: 'use_12345678', handle: started.handle,
        generation: started.generation })
      expect(use.password).toMatch(/^[0-9a-f]{64}$/)
      expect(f.docker.created!.join(' ')).not.toContain(use.password)
      expect(await f.supervisor.endEndpointUse({ operationId: 'end_12345678', handle: started.handle,
        generation: started.generation, token: use.token })).toEqual({ released: true })
      const restarted = await HostedOpenCodeContainerSupervisor.create(f.options)
      expect(await restarted.observe({ operationId: 'observe_87654321', handle: started.handle,
        generation: started.generation })).toMatchObject({ effectEnabled: false })
    } finally { await f.cleanup() }
  })

  test('Stop fences effects and waits for an exact endpoint use before removing the port', async () => {
    const evidence = { pid: 99999, startTicks: '123', pidNamespace: 'pid:[456]', netns: 'net:[789]' }
    const f = await fixture({ testOnlyProcessEvidence: async () => evidence,
      testOnlyHandoff: { run: async () => undefined } })
    try {
      const started = await f.supervisor.start({ operationId: 'start_12345678', leaseId: f.leaseId,
        runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678',
        memberId: 'member_12345678', ownerChannel: {
          socketPath: '/tmp/pending-owner-test.sock', challenge: 'a'.repeat(64),
        } })
      const use = await f.supervisor.beginEndpointUse({ operationId: 'use_12345678', handle: started.handle,
        generation: started.generation })
      expect(await f.supervisor.stop({ operationId: 'stop_12345678', handle: started.handle,
        generation: started.generation })).toMatchObject({ stopped: false, unresolved: true })
      expect(f.docker.calls.filter(call => call[0] === 'stop')).toHaveLength(0)
      expect(await f.supervisor.observe({ operationId: 'observe_12345678', handle: started.handle,
        generation: started.generation })).toMatchObject({ effectEnabled: false })
      expect(await f.supervisor.endEndpointUse({ operationId: 'end_12345678', handle: started.handle,
        generation: started.generation, token: use.token })).toEqual({ released: true })
      expect(f.docker.calls.filter(call => call[0] === 'stop')).toHaveLength(1)
      expect(f.docker.calls.filter(call => call[0] === 'rm')).toHaveLength(1)
    } finally { await f.cleanup() }
  })

  test('Stop racing a blocked endpoint proof drains after Begin rejects', async () => {
    const evidence = { pid: 99999, startTicks: '123', pidNamespace: 'pid:[456]', netns: 'net:[789]' }
    let releaseProof!: () => void
    let proofEntered!: () => void
    const blocked = new Promise<void>(resolve => { releaseProof = resolve })
    const entered = new Promise<void>(resolve => { proofEntered = resolve })
    let official = 0
    const f = await fixture({ testOnlyProcessEvidence: async (_pid: number, phase: string) => {
      if (phase === 'official' && ++official === 2) { proofEntered(); await blocked }
      return evidence
    }, testOnlyHandoff: { run: async () => undefined } })
    try {
      const started = await f.supervisor.start({ operationId: 'start_12345678', leaseId: f.leaseId,
        runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678',
        memberId: 'member_12345678', ownerChannel: {
          socketPath: '/tmp/pending-owner-test.sock', challenge: 'a'.repeat(64),
        } })
      const pending = f.supervisor.beginEndpointUse({ operationId: 'use_12345678', handle: started.handle,
        generation: started.generation })
      await entered
      expect(await f.supervisor.stop({ operationId: 'stop_12345678', handle: started.handle,
        generation: started.generation })).toMatchObject({ stopped: false, unresolved: true })
      releaseProof()
      await expect(pending).rejects.toThrow('endpoint-unverified')
      expect(f.docker.calls.filter(call => call[0] === 'stop')).toHaveLength(1)
      expect(f.docker.calls.filter(call => call[0] === 'rm')).toHaveLength(1)
    } finally { releaseProof(); await f.cleanup() }
  })

  test('Stop racing FD3 handoff cannot leave a newly activated container running', async () => {
    const evidence = { pid: 99999, startTicks: '123', pidNamespace: 'pid:[456]', netns: 'net:[789]' }
    let releaseHandoff!: () => void
    let handoffEntered!: () => void
    const blocked = new Promise<void>(resolve => { releaseHandoff = resolve })
    const entered = new Promise<void>(resolve => { handoffEntered = resolve })
    const f = await fixture({ testOnlyProcessEvidence: async () => evidence,
      testOnlyHandoff: { run: async () => { handoffEntered(); await blocked } } })
    try {
      const pending = f.supervisor.start({ operationId: 'start_12345678', leaseId: f.leaseId,
        runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678',
        memberId: 'member_12345678', ownerChannel: {
          socketPath: '/tmp/pending-owner-test.sock', challenge: 'a'.repeat(64),
        } })
      await entered
      const claimed = await f.supervisor.lookupStart({ operationId: 'start_12345678', leaseId: f.leaseId,
        runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678',
        memberId: 'member_12345678', ownerChannel: {
          socketPath: '/tmp/pending-owner-test.sock', challenge: 'a'.repeat(64),
        } })
      expect(claimed).not.toBeNull()
      expect(await f.supervisor.stop({ operationId: 'stop_12345678', handle: claimed!.handle,
        generation: claimed!.generation })).toMatchObject({ stopped: false, unresolved: true })
      releaseHandoff()
      expect(await pending).toMatchObject({ status: 'unresolved', effectEnabled: false })
      expect(f.docker.calls.filter(call => call[0] === 'stop')).toHaveLength(1)
    } finally { releaseHandoff(); await f.cleanup() }
  })

  test('uncertain FD3 helper result revokes exact generation and never retries', async () => {
    let attempts = 0
    const f = await fixture({
      testOnlyProcessEvidence: async () => ({ pid: 99999, startTicks: '123',
        pidNamespace: 'pid:[456]', netns: 'net:[789]' }),
      testOnlyHandoff: { run: async () => { attempts++; throw new Error('uncertain-send') } },
    })
    const request = { operationId: 'start_12345678', leaseId: f.leaseId,
      runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678',
      memberId: 'member_12345678', ownerChannel: {
        socketPath: '/tmp/pending-owner-test.sock', challenge: 'a'.repeat(64),
      } }
    try {
      const first = await f.supervisor.start(request)
      expect(first).toMatchObject({ status: 'unresolved', effectEnabled: false })
      expect(await f.supervisor.start(request)).toEqual(first)
      expect(attempts).toBe(1)
      expect(f.docker.calls.filter(call => call[0] === 'stop')).toHaveLength(1)
      expect(f.docker.calls.filter(call => call[0] === 'rm')).toHaveLength(1)
    } finally { await f.cleanup() }
  })

  test('helper success cannot enable effects after a generation process swap', async () => {
    let handoffs = 0
    const f = await fixture({
      testOnlyProcessEvidence: async (_pid: number, phase: string) => ({ pid: 99999,
        startTicks: phase === 'bootstrap' ? '123' : '124',
        pidNamespace: 'pid:[456]', netns: 'net:[789]' }),
      testOnlyHandoff: { run: async () => { handoffs++ } },
    })
    try {
      const result = await f.supervisor.start({ operationId: 'start_12345678', leaseId: f.leaseId,
        runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678',
        memberId: 'member_12345678', ownerChannel: {
          socketPath: '/tmp/pending-owner-test.sock', challenge: 'a'.repeat(64),
        } })
      expect(result).toMatchObject({ status: 'unresolved', effectEnabled: false })
      expect(handoffs).toBe(1)
      expect(f.docker.calls.filter(call => call[0] === 'stop')).toHaveLength(1)
    } finally { await f.cleanup() }
  })
  test('recognizes lowercase Docker missing-object diagnostic', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-docker-stub-'))
    try {
      const executable = path.join(root, 'docker')
      await writeFile(executable, '#!/bin/sh\nprintf "error: no such object: missing\\n" >&2\nexit 1\n', { mode: 0o700 })
      await expect(new HostedDockerCliRunner(executable).run('inspect', 'missing'))
        .rejects.toBeInstanceOf(HostedContainerNotFound)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('creates only pinned restricted container and retains uncertainty without a second create', async () => {
    const f = await fixture()
    try {
      f.docker.createFailure = true
      const first = await f.start()
      expect(first).toMatchObject({ status: 'unresolved', effectEnabled: false })
      expect(await f.start()).toEqual(first)
      expect(f.docker.calls.filter(call => call[0] === 'create')).toHaveLength(1)
      const args = f.docker.created!
      expect(args).toContain(IMAGE)
      expect(args).toContain('/usr/local/bin/hosted-opencode-fd3-bootstrap')
      expect(args).toContain(`fd3-${first.generation}`)
      expect(args).toContain('ALL')
      expect(args).not.toContain('--pid')
      expect(args).toContain('127.0.0.1::4096')
      expect(args).toContain('/etc/opencode:ro,noexec,nosuid,nodev,size=4096')
      expect(args.join(' ')).not.toContain('/var/run/docker.sock')
      await expect(f.start('start_87654321')).rejects.toThrow('lease-unavailable')
      const stopped = await f.supervisor.reconcile({ operationId: 'reconcile_12345678',
        handle: first.handle, generation: first.generation })
      expect(stopped).toMatchObject({ stopped: true, unresolved: false })
    } finally { await f.cleanup() }
  })

  test('rejects substituted workspace before Docker create', async () => {
    const f = await fixture()
    try {
      await rm(f.workspace, { recursive: true })
      await symlink(f.profile, f.workspace)
      await expect(f.start()).rejects.toThrow('lease-directory-invalid')
      expect(f.docker.calls.some(call => call[0] === 'create')).toBe(false)
    } finally { await f.cleanup() }
  })

  test('rejects writable config after root lease issuance before Docker create', async () => {
    const f = await fixture()
    try {
      await chmod(path.join(f.config, 'opencode.json'), 0o644)
      await expect(f.start()).rejects.toThrow('config-invalid')
      expect(f.docker.calls.some(call => call[0] === 'create')).toBe(false)
    } finally { await f.cleanup() }
  })

  test('rejects a nonfresh profile before issuing a new lease', async () => {
    const f = await fixture()
    try {
      await writeFile(path.join(f.profile, 'data', 'inherited-secret'), 'secret')
      await expect(f.supervisor.issueLease({ runId: 'run_87654321', teamId: 'team_87654321',
        laneId: 'lane_87654321', memberId: 'member_87654321', workspace: f.workspace, profile: f.profile,
        config: f.config, configSha256: sha(CONFIG_BYTES) })).rejects.toThrow('profile-not-fresh')
    } finally { await f.cleanup() }
  })

  test('rejects writable global config and replaced profile child before Docker create', async () => {
    const writable = await fixture()
    try {
      await chmod(path.join(writable.profile, 'config', 'opencode'), 0o755)
      await expect(writable.start()).rejects.toThrow('profile-invalid')
      expect(writable.docker.calls.some(call => call[0] === 'create')).toBe(false)
    } finally { await writable.cleanup() }

    const replaced = await fixture()
    try {
      await chmod(replaced.profile, 0o700)
      await rename(path.join(replaced.profile, 'data'), path.join(replaced.root, 'retired-data'))
      await mkdir(path.join(replaced.profile, 'data'), { mode: 0o700 })
      await chmod(replaced.profile, 0o555)
      await expect(replaced.start()).rejects.toThrow('lease-substituted')
      expect(replaced.docker.calls.some(call => call[0] === 'create')).toBe(false)
    } finally { await replaced.cleanup() }
  })

  test('rejects a container that joined the private network after supervisor initialization', async () => {
    const f = await fixture()
    try {
      f.docker.networkOccupied = true
      expect(await f.start()).toMatchObject({ status: 'unresolved', effectEnabled: false })
      expect(f.docker.calls.some(call => call[0] === 'create')).toBe(false)
    } finally { await f.cleanup() }
  })

  test('created-container phase still rejects a foreign network endpoint before Start', async () => {
    const f = await fixture()
    try {
      f.docker.occupyAfterCreate = true
      expect(await f.start()).toMatchObject({ status: 'unresolved', effectEnabled: false })
      expect(f.docker.calls.some(call => call[0] === 'start')).toBe(false)
    } finally { await f.cleanup() }
  })

  test('requires an internal network before Docker create', async () => {
    const f = await fixture()
    try {
      f.docker.networkInternal = false
      expect(await f.start()).toMatchObject({ status: 'unresolved', effectEnabled: false })
      expect(f.docker.calls.some(call => call[0] === 'create')).toBe(false)
    } finally { await f.cleanup() }
  })

  test('durably claims fresh roots across concurrent calls and supervisor restart', async () => {
    const f = await fixture()
    const workspace = path.join(f.options.workspaceParent, '4'.repeat(24))
    const profile = path.join(f.options.profileParent, '5'.repeat(24))
    const config = path.join(f.options.configParent, '6'.repeat(24))
    try {
      await mkdir(workspace, { mode: 0o700 })
      await prepareProfile(profile)
      await mkdir(config, { mode: 0o700 })
      await writeFile(path.join(config, 'opencode.json'), CONFIG_BYTES, { mode: 0o444 })
      await chmod(config, 0o555)
      const input = { runId: 'run_87654321', teamId: 'team_87654321', laneId: 'lane_87654321', memberId: 'member_87654321',
        workspace, profile, config, configSha256: sha(CONFIG_BYTES) }
      const second = await HostedOpenCodeContainerSupervisor.create(f.options)
      const results = await Promise.allSettled([f.supervisor.issueLease(input), second.issueLease(input)])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      const restarted = await HostedOpenCodeContainerSupervisor.create(f.options)
      await expect(restarted.issueLease(input)).rejects.toThrow('claim-already-issued')
    } finally { await chmod(config, 0o700).catch(() => undefined); await resetProfile(profile).catch(() => undefined); await f.cleanup() }
  })

  test('restarts with its exact owned network occupant and rejects a foreign occupant', async () => {
    const f = await fixture()
    try {
      const started = await f.start()
      const restarted = await HostedOpenCodeContainerSupervisor.create(f.options)
      f.docker.networkOccupied = true
      await expect(restarted.reconcile({ operationId: 'reconcile_12345678',
        handle: started.handle, generation: started.generation })).rejects.toThrow('foreign-occupant')
      expect(f.docker.calls.some(call => call[0] === 'stop')).toBe(false)
      f.docker.networkOccupied = false
      expect(await restarted.reconcile({ operationId: 'reconcile_87654321',
        handle: started.handle, generation: started.generation })).toMatchObject({ stopped: true, unresolved: false })
    } finally { await f.cleanup() }
  })

  test('concurrent Start replays one operation and cannot consume one lease twice', async () => {
    const f = await fixture()
    try {
      f.docker.createFailure = true
      const [first, replay] = await Promise.all([f.start(), f.start()])
      expect(replay).toEqual(first)
      expect(f.docker.calls.filter(call => call[0] === 'create')).toHaveLength(1)
      await expect(f.start('start_87654321')).rejects.toThrow('lease-unavailable')
    } finally { await f.cleanup() }
  })

  test('restart recovers exact member-bound Start claim without another Docker create', async () => {
    const f = await fixture()
    try {
      const first = await f.start()
      const restarted = await HostedOpenCodeContainerSupervisor.create(f.options)
      const request = { operationId: 'start_12345678', leaseId: f.leaseId,
        runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678', memberId: 'member_12345678' }
      expect(await restarted.lookupStart(request)).toEqual({ ...first, status: 'unresolved' })
      expect(await restarted.start(request)).toEqual({ ...first, status: 'unresolved' })
      expect(f.docker.calls.filter(call => call[0] === 'create')).toHaveLength(1)
      await expect(restarted.lookupStart({ ...request, memberId: 'member_87654321' }))
        .rejects.toThrow('operation-replay-conflict')
      await rm(path.join(f.options.stateDirectory, `${first.handle}.json`))
      const recovered = await HostedOpenCodeContainerSupervisor.create(f.options)
      expect(await recovered.lookupStart(request)).toEqual({ ...first, status: 'unresolved' })
      expect(await recovered.reconcile({ operationId: 'reconcile_12345678',
        handle: first.handle, generation: first.generation })).toMatchObject({ stopped: true, unresolved: false })
    } finally { await f.cleanup() }
  })

  test('root-issued prepare receipt binds authority and permits only one prepared Start', async () => {
    let leaseId = ''
    let memberId = 'member_12345678'
    let startTicks = '12345'
    const operationId = 'start_12345678'
    const authority = async (id: string) => ({ request: { operationId: id, leaseId,
      runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678', memberId,
      ownerChannel: { socketPath: '/tmp/test-pending-owner.sock', challenge: 'a'.repeat(64) } },
      connector: { pid: 99999, startTicks } })
    const f = await fixture({ testOnlyTrustedMember: authority })
    leaseId = f.leaseId
    try {
      const receipt = await f.supervisor.prepareMember({ operationId })
      expect(receipt).toMatchObject({ operationId, connector: { pid: 99999, startTicks } })
      expect(receipt.handle).toMatch(/^opencode_[0-9a-f]{32}$/)
      expect(receipt.generation).toMatch(/^[0-9a-f]{32}$/)
      expect(await f.supervisor.prepareMember({ operationId })).toEqual(receipt)
      expect(f.docker.calls.filter(call => call[0] === 'create')).toHaveLength(0)
      await expect(f.supervisor.prepareMember({ operationId: 'start_87654321' }))
        .rejects.toThrow('prepare-lease-conflict')
      const beforeStartRestart = await HostedOpenCodeContainerSupervisor.create(f.options)
      expect(await beforeStartRestart.prepareMember({ operationId })).toEqual(receipt)
      await expect(beforeStartRestart.startPrepared({ operationId, receiptId: receipt.receiptId }))
        .rejects.toThrow('lease-unavailable')
      expect(f.docker.calls.filter(call => call[0] === 'create')).toHaveLength(0)
      memberId = 'member_87654321'
      await expect(f.supervisor.prepareMember({ operationId })).rejects.toThrow('prepare-replay-conflict')
      await expect(f.supervisor.startPrepared({ operationId, receiptId: receipt.receiptId }))
        .rejects.toThrow('prepare-replay-conflict')
      memberId = 'member_12345678'
      startTicks = '99999'
      await expect(f.supervisor.startPrepared({ operationId, receiptId: receipt.receiptId }))
        .rejects.toThrow('prepare-replay-conflict')
      startTicks = '12345'
      await expect(f.supervisor.startPrepared({ operationId, receiptId: '0'.repeat(32) }))
        .rejects.toThrow('prepare-receipt-invalid')
      await expect(f.start()).rejects.toThrow('prepared-start-required')
      const first = await f.supervisor.startPrepared({ operationId, receiptId: receipt.receiptId })
      expect(first).toMatchObject({ handle: receipt.handle, generation: receipt.generation,
        effectEnabled: false, status: 'unresolved' })
      expect(await f.supervisor.startPrepared({ operationId, receiptId: receipt.receiptId })).toEqual(first)
      expect(f.docker.calls.filter(call => call[0] === 'create')).toHaveLength(1)
      expect(f.docker.calls.filter(call => call[0] === 'start')).toHaveLength(1)
      const restarted = await HostedOpenCodeContainerSupervisor.create(f.options)
      expect(await restarted.startPrepared({ operationId, receiptId: receipt.receiptId }))
        .toEqual({ ...first, status: 'unresolved', effectEnabled: false })
      expect(f.docker.calls.filter(call => call[0] === 'create')).toHaveLength(1)
      expect(f.docker.calls.filter(call => call[0] === 'start')).toHaveLength(1)
    } finally { await f.cleanup() }
  })

  test('prepared Start without a pending Owner channel has no Docker effect', async () => {
    let leaseId = ''
    const operationId = 'start_12345678'
    const f = await fixture({ testOnlyTrustedMember: async () => ({
      request: { operationId, leaseId, runId: 'run_12345678', teamId: 'team_12345678',
        laneId: 'lane_12345678', memberId: 'member_12345678' },
      connector: { pid: 99999, startTicks: '12345' },
    }) })
    leaseId = f.leaseId
    try {
      const receipt = await f.supervisor.prepareMember({ operationId })
      await expect(f.supervisor.startPrepared({ operationId, receiptId: receipt.receiptId }))
        .rejects.toThrow('pending-owner-channel-required')
      expect(f.docker.calls.filter(call => call[0] === 'create')).toHaveLength(0)
    } finally { await f.cleanup() }
  })

  test('dead creator permits pre-create absence reconciliation but never uncertain Docker create', async () => {
    if (process.platform !== 'linux') return
    for (const createIssued of [false, true]) {
      const f = await fixture()
      try {
        if (createIssued) f.docker.createFailure = true
        else f.docker.networkOccupied = true
        const started = await f.start()
        f.docker.networkOccupied = false
        f.docker.exists = false
        const recordPath = path.join(f.options.stateDirectory, `${started.handle}.json`)
        const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
        record.creator = { pid: 99_999_999, startTicks: '1' }
        await writeFile(recordPath, JSON.stringify(record))
        const restarted = await HostedOpenCodeContainerSupervisor.create(f.options)
        const result = await restarted.reconcile({ operationId: 'reconcile_12345678',
          handle: started.handle, generation: started.generation })
        expect(result).toMatchObject(createIssued
          ? { stopped: false, unresolved: true }
          : { stopped: true, unresolved: false })
        expect(f.docker.calls.filter(call => call[0] === 'create')).toHaveLength(createIssued ? 1 : 0)
      } finally { await f.cleanup() }
    }
  })

  test('authenticated local RPC accepts only a member-bound command and signed reply', async () => {
    // Bun 1.3.11 crashes in its macOS Unix listener; the production daemon is Linux-only.
    if (process.platform !== 'linux') return
    const f = await fixture()
    const socketRoot = await realpath(await mkdtemp('/tmp/hcr-'))
    await chmod(socketRoot, 0o700)
    const socketPath = path.join(socketRoot, 's.sock')
    const secret = Buffer.alloc(32, 7)
    const server = new HostedOpenCodeSupervisorRpcServer({ socketPath, secret,
      ownerGid: process.getgid!(), supervisor: f.supervisor, testOnlyAllowNonRoot: true })
    try {
      await server.start()
      const request = { operationId: 'start_12345678', leaseId: f.leaseId,
        runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678', memberId: 'member_12345678' }
      const client = new HostedOpenCodeSupervisorRpcClient({ socketPath, secret,
        ownerGid: process.getgid!(), testOnlyAllowNonRoot: true })
      const wrong = new HostedOpenCodeSupervisorRpcClient({ socketPath, secret: Buffer.alloc(32, 8),
        ownerGid: process.getgid!(), testOnlyAllowNonRoot: true })
      await expect(wrong.command({ operation: 'start', payload: request })).rejects.toThrow()
      expect(f.docker.calls.some(call => call[0] === 'create')).toBe(false)
      const first = await client.command<Awaited<ReturnType<typeof f.start>>>({ operation: 'start', payload: request })
      expect(first).toMatchObject({ status: 'unresolved', effectEnabled: false })
      expect(await client.lookupStart(request))
        .toEqual({ ...first, status: 'unresolved' })
      expect(f.docker.calls.filter(call => call[0] === 'create')).toHaveLength(1)
      await expect(client.command({ operation: 'start', payload: { ...request, memberId: 'member_87654321' } }))
        .rejects.toThrow()
      expect(f.docker.calls.filter(call => call[0] === 'create')).toHaveLength(1)
    } finally { await server.close(); await rm(socketRoot, { recursive: true, force: true }); await f.cleanup() }
  })

  test('durable network claim allows only one Start across distinct leases', async () => {
    const f = await fixture()
    const workspace = path.join(f.options.workspaceParent, '7'.repeat(24))
    const profile = path.join(f.options.profileParent, '8'.repeat(24))
    const config = path.join(f.options.configParent, '9'.repeat(24))
    try {
      await mkdir(workspace, { mode: 0o700 })
      await prepareProfile(profile)
      await mkdir(config, { mode: 0o700 })
      await writeFile(path.join(config, 'opencode.json'), CONFIG_BYTES, { mode: 0o444 })
      await chmod(config, 0o555)
      const leaseId = await f.supervisor.issueLease({ runId: 'run_87654321', teamId: 'team_87654321',
        laneId: 'lane_87654321', memberId: 'member_87654321', workspace, profile, config, configSha256: sha(CONFIG_BYTES) })
      const [first, second] = await Promise.all([f.start(), f.supervisor.start({
        operationId: 'start_87654321', leaseId, runId: 'run_87654321',
        teamId: 'team_87654321', laneId: 'lane_87654321', memberId: 'member_87654321',
      })])
      expect([first.status, second.status]).toEqual(['unresolved', 'unresolved'])
      expect(f.docker.calls.filter(call => call[0] === 'create')).toHaveLength(1)
      const restarted = await HostedOpenCodeContainerSupervisor.create(f.options)
      await expect(restarted.issueLease({ runId: 'run_87654321', teamId: 'team_87654321',
        laneId: 'lane_87654321', memberId: 'member_87654321', workspace, profile, config, configSha256: sha(CONFIG_BYTES) }))
        .rejects.toThrow('claim-already-issued')
    } finally { await chmod(config, 0o700).catch(() => undefined); await resetProfile(profile).catch(() => undefined); await f.cleanup() }
  })

  test('rejects effective privilege, mount, and environment drift before start', async () => {
    for (const mutate of [
      (row: Record<string, unknown>) => { (row.HostConfig as Record<string, unknown>).Privileged = true },
      (row: Record<string, unknown>) => { (row.Mounts as unknown[]).push({ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true }) },
      (row: Record<string, unknown>) => { (row.Config as Record<string, unknown>).Env = [...ENV, 'OPENAI_API_KEY=secret'] },
      (row: Record<string, unknown>) => { ((row.NetworkSettings as Record<string, unknown>).Networks as Record<string, unknown>).foreign = { NetworkID: 'f'.repeat(64) } },
    ]) {
      const f = await fixture()
      try {
        f.docker.mutate = mutate
        const first = await f.start()
        expect(first.status).toBe('unresolved')
        expect(f.docker.calls.some(call => call[0] === 'start')).toBe(false)
      } finally { await f.cleanup() }
    }
  })

  test('uncertain stop preserves exact generation for later reconcile', async () => {
    const f = await fixture()
    try {
      // Fake PID has no real /proc executable, so Start is deliberately unresolved.
      const first = await f.start()
      expect(first.status).toBe('unresolved')
      await expect(f.supervisor.stop({ operationId: 'stop_12345678', handle: first.handle,
        generation: '0'.repeat(32) })).rejects.toThrow('generation-invalid')
      f.docker.uncertainStop = true
      const stopped = await f.supervisor.stop({ operationId: 'stop_87654321',
        handle: first.handle, generation: first.generation })
      expect(stopped).toMatchObject({ stopped: false, unresolved: true })
      expect(f.docker.exists).toBe(true)
      f.docker.uncertainStop = false
      const reconciled = await f.supervisor.reconcile({ operationId: 'reconcile_12345678',
        handle: first.handle, generation: first.generation })
      expect(reconciled).toMatchObject({ stopped: true, unresolved: false })
    } finally { await f.cleanup() }
  })
})
