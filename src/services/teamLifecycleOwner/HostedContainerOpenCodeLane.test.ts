import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'

import type { HostedOpenCodeContainerSupervisor } from '../hostedControl/container/HostedOpenCodeContainerSupervisor.js'
import { HostedMemberSessionBridge, type HostedMemberAttempt } from '../hostedControl/hostedLaneSession/HostedMemberSessionBridge.js'
import { DurableTeamLifecycleExecution } from './DurableTeamLifecycleExecution.js'
import { HostedContainerOpenCodeLane, type HostedContainerAttemptClaims } from './HostedContainerOpenCodeLane.js'
import type { TeamLifecycleLaneInput } from './OpenCodeTeamLifecycleLane.js'

const HANDLE = `opencode_${'a'.repeat(32)}`
const GENERATION = 'b'.repeat(32)
const READY = () => ({ endpoint: true, fd3Handoff: true, providerConfig: true, memberSessions: true })
const RESOLVE = async () => `member_${'f'.repeat(32)}`
function SESSIONS() {
  const receipt = (attempt: HostedMemberAttempt) => ({ ...attempt, state: 'launching',
    sessionId: null, initialMessageId: null, observedInitialMessageId: null })
  return new HostedMemberSessionBridge({
    start: async attempt => receipt(attempt),
    observe: async attempt => receipt(attempt),
    post: async () => null,
    observeDelivery: async () => null,
    observeReply: async () => null,
  }, {
    claimStart: async attempt => ({ created: true, fingerprint: attempt.planFingerprint }),
    claimDelivery: async (_delivery, fingerprint) => ({ created: true, fingerprint }),
    readDelivery: async () => null,
  })
}
function READY_SESSIONS(blockedMember = '') {
  const receipt = (attempt: HostedMemberAttempt) => ({ ...attempt,
    state: attempt.memberName === blockedMember ? 'launching' : 'ready',
    sessionId: `ses_${attempt.memberId.slice(-12)}`, initialMessageId: 'msg_initial12345',
    observedInitialMessageId: 'msg_initial12345' })
  return new HostedMemberSessionBridge({
    start: async attempt => receipt(attempt), observe: async attempt => receipt(attempt),
    post: async () => null, observeDelivery: async () => null, observeReply: async () => null,
  }, {
    claimStart: async attempt => ({ created: true, fingerprint: attempt.planFingerprint }),
    claimDelivery: async (_delivery, fingerprint) => ({ created: true, fingerprint }),
    readDelivery: async () => null,
  })
}

function input(): TeamLifecycleLaneInput & { runId: string } {
  return {
    planTeamId: 'team-one', workspaceRoot: '/sandbox/test-workspace', toolApprovalMode: 'auto',
    runId: 'run_one12345',
    lane: { kind: 'opencode', provider: 'opencode', laneId: 'lane-one', selectedModel: 'qwen/test',
      members: [{ name: 'coder', prompt: 'Test prompt', model: 'qwen/test' }] },
  }
}

class FakeSupervisor {
  starts: Parameters<HostedOpenCodeContainerSupervisor['start']>[0][] = []
  observations: Parameters<HostedOpenCodeContainerSupervisor['observe']>[0][] = []
  stops: Parameters<HostedOpenCodeContainerSupervisor['stop']>[0][] = []
  reconciles: Parameters<HostedOpenCodeContainerSupervisor['reconcile']>[0][] = []
  startStatus: 'started' | 'unresolved' = 'unresolved'
  startFailure = false
  effectEnabled = false
  endpoint = 'http://127.0.0.1:49152'
  stopGeneration = GENERATION
  multi = false
  async start(request: Parameters<HostedOpenCodeContainerSupervisor['start']>[0]) {
    this.starts.push(request)
    if (this.startFailure) throw new Error('Docker reply unknown')
    return { handle: this.multi ? `opencode_${this.starts.length.toString(16).padStart(32, '0')}` : HANDLE,
      generation: GENERATION, status: this.startStatus,
      effectEnabled: this.effectEnabled }
  }
  async observe(request: Parameters<HostedOpenCodeContainerSupervisor['observe']>[0]) {
    this.observations.push(request)
    return { status: 'running' as const, handle: this.multi ? request.handle : HANDLE, generation: GENERATION,
      effectEnabled: this.effectEnabled, endpoint: this.endpoint,
      process: { pid: 1234, startTicks: '123456', pidNamespace: 'pid:[1234]' } }
  }
  async stop(request: Parameters<HostedOpenCodeContainerSupervisor['stop']>[0]) {
    this.stops.push(request)
    return { handle: this.multi ? request.handle : HANDLE, generation: this.stopGeneration, stopped: true, unresolved: false }
  }
  async reconcile(request: Parameters<HostedOpenCodeContainerSupervisor['reconcile']>[0]) {
    this.reconciles.push(request)
    return { handle: this.multi ? request.handle : HANDLE, generation: this.stopGeneration, stopped: true, unresolved: false }
  }
}

class FakeAttempts implements HostedContainerAttemptClaims {
  readonly claimed = new Map<string, string>()
  readonly lanes = new Map<string, string>()
  readonly closedLanes = new Set<string>()
  readonly stopped = new Set<string>()
  async claimLane(binding: { key: string; fingerprint: string }) {
    const original = this.lanes.get(binding.key)
    if (original) return { created: false, fingerprint: original }
    this.lanes.set(binding.key, binding.fingerprint)
    return { created: true, fingerprint: binding.fingerprint }
  }
  async closeLane(binding: { key: string; fingerprint: string }) {
    const original = this.lanes.get(binding.key)
    if (original && original !== binding.fingerprint) return { closed: false, fingerprint: original }
    this.lanes.set(binding.key, binding.fingerprint)
    this.closedLanes.add(binding.key)
    return { closed: true, fingerprint: binding.fingerprint }
  }
  async readLane(key: string) { return this.lanes.get(key) ?? null }
  async claim(binding: { key: string; fingerprint: string }): Promise<{ created: boolean; fingerprint: string }> {
    const original = this.claimed.get(binding.key)
    if (original) return { created: false, fingerprint: original }
    this.claimed.set(binding.key, binding.fingerprint)
    return { created: true, fingerprint: binding.fingerprint }
  }
  async read(binding: { key: string }) {
    const fingerprint = this.claimed.get(binding.key)
    if (!fingerprint) return { state: 'absent' as const }
    return { state: this.stopped.has(binding.key) ? 'stopped' as const : 'claimed' as const, fingerprint }
  }
  async markStopped(binding: { key: string; fingerprint: string }, _container: { handle: string; generation: string }) {
    if (this.claimed.get(binding.key) !== binding.fingerprint) return false
    this.stopped.add(binding.key)
    return true
  }
}

describe('hosted disposable OpenCode lifecycle lane', () => {
  test('stays unavailable without endpoint, FD3, and provider configuration evidence', async () => {
    const supervisor = new FakeSupervisor()
    let leaseCalls = 0
    const lane = new HostedContainerOpenCodeLane(supervisor, async () => {
      leaseCalls++
      return `lease_${'c'.repeat(32)}`
    })
    expect(lane.supports('launch')).toBe(false)
    expect(lane.supports('cancel')).toBe(true)
    expect(lane.supports('stop')).toBe(true)
    expect(lane.supports('recover')).toBe(true)
    await expect(lane.launch(input())).rejects.toThrow('member admission unavailable')
    expect(leaseCalls).toBe(0)
    expect(supervisor.starts).toHaveLength(0)
    const manual = { ...input(), toolApprovalMode: 'manual' as const }
    const testReady = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, new FakeAttempts(), RESOLVE, SESSIONS())
    expect(['launch', 'cancel', 'stop', 'recover'].every(action =>
      testReady.supports(action as 'launch' | 'cancel' | 'stop' | 'recover'))).toBe(true)
    await expect(testReady.launch(manual)).rejects.toThrow('capability unavailable')
  })

  test('unresolved Start keeps exact identity for reconcile and rejects changed members', async () => {
    const supervisor = new FakeSupervisor()
    const issued: unknown[] = []
    const lane = new HostedContainerOpenCodeLane(supervisor, async binding => {
      issued.push(binding)
      return `lease_${'c'.repeat(32)}`
    }, READY, new FakeAttempts(), RESOLVE, SESSIONS())
    const plan = input()
    expect(await lane.launch(plan)).toEqual({ phase: 'failed', recoverable: true })
    expect(await lane.launch(plan)).toEqual({ phase: 'failed', recoverable: true })
    expect(issued).toHaveLength(1)
    expect(supervisor.starts).toHaveLength(1)
    expect(supervisor.starts[0]).toMatchObject({ leaseId: `lease_${'c'.repeat(32)}` })
    expect(await lane.inspect(plan)).toEqual({ phase: 'failed', recoverable: true })
    const changed = { ...plan, lane: { ...plan.lane, members: [{ name: 'coder', prompt: 'Changed prompt' }] } }
    expect(await lane.recover(changed)).toEqual({ phase: 'failed', recoverable: true })
    expect(supervisor.reconciles).toHaveLength(0)
    expect(await lane.recover(plan)).toEqual({ phase: 'idle', recoverable: false })
    expect(supervisor.reconciles).toEqual([{
      operationId: expect.stringMatching(/^reconcile_[0-9a-f]{64}$/),
      handle: HANDLE, generation: GENERATION,
    }])
  })

  test('rejected Start quarantines same-process retry before a second lease', async () => {
    const supervisor = new FakeSupervisor()
    supervisor.startFailure = true
    let leaseCalls = 0
    const lane = new HostedContainerOpenCodeLane(supervisor, async () => {
      leaseCalls++
      return `lease_${'c'.repeat(32)}`
    }, READY, new FakeAttempts(), RESOLVE, SESSIONS())
    await expect(lane.launch(input())).rejects.toThrow('Docker reply unknown')
    await expect(lane.launch(input())).rejects.toThrow('outcome unknown')
    expect(leaseCalls).toBe(1)
    expect(supervisor.starts).toHaveLength(1)
    expect(await lane.recover(input())).toEqual({ phase: 'failed', recoverable: true })
  })

  test('container health never claims member readiness and stop requires exact generation', async () => {
    const supervisor = new FakeSupervisor()
    supervisor.startStatus = 'started'
    supervisor.effectEnabled = true
    const lane = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, new FakeAttempts(), RESOLVE, SESSIONS())
    const plan = input()
    expect(await lane.launch(plan)).toEqual({ phase: 'launching', recoverable: false })
    supervisor.endpoint = 'http://127.0.0.1:49152@foreign.example/'
    expect(await lane.inspect(plan)).toEqual({ phase: 'failed', recoverable: true })
    supervisor.stopGeneration = 'd'.repeat(32)
    expect(await lane.stop(plan)).toEqual({ phase: 'failed', recoverable: true })
    expect(lane.supports('stop')).toBe(true)
    supervisor.stopGeneration = GENERATION
    expect(await lane.stop(plan)).toEqual({ phase: 'idle', recoverable: false })
    expect(lane.supports('stop')).toBe(true)
  })

  test('restart without a durable handle fails closed instead of reissuing Start', async () => {
    const supervisor = new FakeSupervisor()
    const attempts = new FakeAttempts()
    const first = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, attempts, RESOLVE, SESSIONS())
    expect(await first.launch(input())).toEqual({ phase: 'failed', recoverable: true })
    const restarted = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, attempts, RESOLVE, SESSIONS())
    expect(await restarted.inspect(input())).toEqual({ phase: 'failed', recoverable: true })
    expect(await restarted.recover(input())).toEqual({ phase: 'failed', recoverable: true })
    await expect(restarted.launch(input())).rejects.toThrow('already closing')
    const changed = { ...input(), lane: { ...input().lane,
      members: [{ name: 'coder', prompt: 'Changed after restart', model: 'qwen/other' }] } }
    await expect(restarted.launch(changed)).rejects.toThrow('already closing')
    expect(supervisor.starts).toHaveLength(1)
    expect(supervisor.reconciles).toHaveLength(0)
  })

  test('changed roster ID for the same planned member cannot issue a second Start', async () => {
    const supervisor = new FakeSupervisor()
    const attempts = new FakeAttempts()
    const first = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, attempts, RESOLVE, SESSIONS())
    expect(await first.launch(input())).toEqual({ phase: 'failed', recoverable: true })
    const substituted = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, attempts, async () => `member_${'e'.repeat(32)}`, SESSIONS())
    await expect(substituted.launch(input())).rejects.toThrow('plan changed')
    expect(supervisor.starts).toHaveLength(1)
  })

  test('replacing every planned member name cannot bypass the lane claim after restart', async () => {
    const supervisor = new FakeSupervisor()
    const attempts = new FakeAttempts()
    const first = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, attempts, RESOLVE, SESSIONS())
    expect(await first.launch(input())).toEqual({ phase: 'failed', recoverable: true })
    const restarted = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, attempts, async () => `member_${'e'.repeat(32)}`, SESSIONS())
    const changed = input()
    changed.lane.members = [{ name: 'reviewer', prompt: 'Different plan' }]
    await expect(restarted.launch(changed)).rejects.toThrow('plan changed')
    expect(await restarted.recover(changed)).toEqual({ phase: 'failed', recoverable: true })
    expect(supervisor.starts).toHaveLength(1)
    expect(supervisor.reconciles).toHaveLength(0)
  })

  test('concurrent Start deduplicates exact plan and rejects changed member binding', async () => {
    const supervisor = new FakeSupervisor()
    let releaseLease!: (leaseId: string) => void
    const lease = new Promise<string>(resolve => { releaseLease = resolve })
    let leaseCalls = 0
    const lane = new HostedContainerOpenCodeLane(supervisor, () => {
      leaseCalls++
      return lease
    }, READY, new FakeAttempts(), RESOLVE, SESSIONS())
    const plan = input()
    const first = lane.launch(plan)
    const replay = lane.launch(plan)
    const changed = { ...plan, lane: { ...plan.lane, selectedModel: 'qwen/other' } }
    await expect(lane.launch(changed)).rejects.toThrow('plan changed')
    releaseLease(`lease_${'c'.repeat(32)}`)
    expect(await replay).toEqual(await first)
    expect(leaseCalls).toBe(1)
    expect(supervisor.starts).toHaveLength(1)
  })

  test('durable lifecycle sees cleanup support before the first container exists', () => {
    const lane = new HostedContainerOpenCodeLane(new FakeSupervisor(),
      async () => `lease_${'c'.repeat(32)}`, READY, new FakeAttempts(), RESOLVE, SESSIONS())
    const plan = { schemaVersion: 2 as const, workspaceId: 'workspace-one', teamId: 'team-one',
      workspaceRoot: '/sandbox/test-workspace', toolApprovalMode: 'auto' as const,
      lanes: [input().lane] }
    const execution = new DurableTeamLifecycleExecution(path.join(os.tmpdir(), 'inactive-hosted-lane-state.json'), [lane])
    expect(['launch', 'cancel', 'stop', 'recover'].every(action =>
      execution.supports(plan, action as 'launch' | 'cancel' | 'stop' | 'recover'))).toBe(true)
  })

  test('launches and observes each roster-bound member independently', async () => {
    const supervisor = new FakeSupervisor()
    supervisor.multi = true
    supervisor.startStatus = 'started'
    supervisor.effectEnabled = true
    const memberIds = new Map([['coder', `member_${'1'.repeat(32)}`], ['reviewer', `member_${'2'.repeat(32)}`]])
    const lane = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, new FakeAttempts(), async (_plan, name) => memberIds.get(name) ?? null, READY_SESSIONS())
    const plan = input()
    plan.lane.members = [...plan.lane.members, { name: 'reviewer', prompt: 'Review test', model: 'qwen/test' }]
    expect(await lane.launch(plan)).toEqual({ phase: 'running', recoverable: false })
    expect(supervisor.starts.map(request => request.memberId)).toEqual([...memberIds.values()])
    expect(supervisor.starts[0].operationId).not.toBe(supervisor.starts[1].operationId)
    expect(supervisor.observations).toHaveLength(2)
    expect(supervisor.observations[0].operationId).not.toBe(supervisor.observations[1].operationId)
    expect(await lane.stop(plan)).toEqual({ phase: 'idle', recoverable: false })
    expect(supervisor.stops).toHaveLength(2)
    expect(supervisor.stops[0].operationId).not.toBe(supervisor.stops[1].operationId)
  })

  test('a single pending member keeps the whole lane launching', async () => {
    const supervisor = new FakeSupervisor()
    supervisor.multi = true
    supervisor.startStatus = 'started'
    supervisor.effectEnabled = true
    const plan = input()
    plan.lane.members = [...plan.lane.members, { name: 'reviewer', prompt: 'Review test' }]
    const lane = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, new FakeAttempts(), async (_plan, name) => name === 'coder'
        ? `member_${'1'.repeat(32)}` : `member_${'2'.repeat(32)}`, READY_SESSIONS('reviewer'))
    expect(await lane.launch(plan)).toEqual({ phase: 'launching', recoverable: false })
    expect(supervisor.starts).toHaveLength(2)
  })

  test('partial launch cleanup skips never-started members and repeated cleanup stays idle', async () => {
    const supervisor = new FakeSupervisor()
    const lane = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, new FakeAttempts(), async (_plan, name) => name === 'coder'
        ? `member_${'1'.repeat(32)}` : `member_${'2'.repeat(32)}`, SESSIONS())
    const plan = input()
    plan.lane.members = [...plan.lane.members, { name: 'reviewer', prompt: 'Review test' }]
    expect(await lane.launch(plan)).toEqual({ phase: 'failed', recoverable: true })
    expect(supervisor.starts).toHaveLength(1)
    expect(await lane.recover(plan)).toEqual({ phase: 'idle', recoverable: false })
    expect(await lane.recover(plan)).toEqual({ phase: 'idle', recoverable: false })
    expect(supervisor.reconciles).toHaveLength(1)
  })

  test('repeated Stop remains idle after all member stop receipts', async () => {
    const supervisor = new FakeSupervisor()
    supervisor.multi = true
    supervisor.startStatus = 'started'
    supervisor.effectEnabled = true
    const attempts = new FakeAttempts()
    const resolve = async (_plan: ReturnType<typeof input>, name: string) => name === 'coder'
      ? `member_${'1'.repeat(32)}` : `member_${'2'.repeat(32)}`
    const lane = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, attempts, resolve, READY_SESSIONS())
    const plan = input()
    plan.lane.members = [...plan.lane.members, { name: 'reviewer', prompt: 'Review test' }]
    expect(await lane.launch(plan)).toEqual({ phase: 'running', recoverable: false })
    expect(await lane.stop(plan)).toEqual({ phase: 'idle', recoverable: false })
    expect(await lane.stop(plan)).toEqual({ phase: 'idle', recoverable: false })
    expect(supervisor.stops).toHaveLength(2)
    const restarted = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, attempts, resolve, READY_SESSIONS())
    expect(await restarted.stop(plan)).toEqual({ phase: 'idle', recoverable: false })
    expect(supervisor.stops).toHaveLength(2)
  })

  test('cancel drains a delayed lane claim before any member Start', async () => {
    const supervisor = new FakeSupervisor()
    supervisor.multi = true
    supervisor.startStatus = 'started'
    supervisor.effectEnabled = true
    const attempts = new FakeAttempts()
    const claim = attempts.claimLane.bind(attempts)
    let entered!: () => void
    let release!: () => void
    const claimed = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    attempts.claimLane = async binding => { entered(); await gate; return claim(binding) }
    const lane = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, attempts, RESOLVE, READY_SESSIONS())
    const launched = lane.launch(input())
    await claimed
    const cancelled = lane.cancel(input())
    release()
    expect(await cancelled).toEqual({ phase: 'idle', recoverable: false })
    expect(await launched).toEqual({ phase: 'failed', recoverable: true })
    expect(supervisor.starts).toHaveLength(0)
  })

  test('cancel fences launch while member admission is still resolving', async () => {
    const supervisor = new FakeSupervisor()
    supervisor.startStatus = 'started'
    supervisor.effectEnabled = true
    let entered!: () => void
    let release!: () => void
    const resolving = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const resolver = async () => {
      if (++calls === 1) { entered(); await gate }
      return `member_${'f'.repeat(32)}`
    }
    const lane = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, new FakeAttempts(), resolver, READY_SESSIONS())
    const launched = lane.launch(input())
    await resolving
    const cancelled = lane.cancel(input())
    release()
    expect(await cancelled).toEqual({ phase: 'idle', recoverable: false })
    expect(await launched).toEqual({ phase: 'failed', recoverable: true })
    expect(supervisor.starts).toHaveLength(0)
  })

  test('durable close rejects same-run launch after restart even when no Start was claimed', async () => {
    const supervisor = new FakeSupervisor()
    const attempts = new FakeAttempts()
    const first = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, attempts, RESOLVE, SESSIONS())
    expect(await first.cancel(input())).toEqual({ phase: 'idle', recoverable: false })
    const restarted = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, attempts, RESOLVE, SESSIONS())
    await expect(restarted.launch(input())).rejects.toThrow('already claimed')
    expect(supervisor.starts).toHaveLength(0)
  })
})
