import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'

import type { HostedOpenCodeContainerSupervisor } from '../hostedControl/container/HostedOpenCodeContainerSupervisor.js'
import { DurableTeamLifecycleExecution } from './DurableTeamLifecycleExecution.js'
import { HostedContainerOpenCodeLane, type HostedContainerAttemptClaims } from './HostedContainerOpenCodeLane.js'
import type { TeamLifecycleLaneInput } from './OpenCodeTeamLifecycleLane.js'

const HANDLE = `opencode_${'a'.repeat(32)}`
const GENERATION = 'b'.repeat(32)
const READY = () => ({ endpoint: true, fd3Handoff: true, providerConfig: true, memberSessions: true })

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
  async start(request: Parameters<HostedOpenCodeContainerSupervisor['start']>[0]) {
    this.starts.push(request)
    if (this.startFailure) throw new Error('Docker reply unknown')
    return { handle: HANDLE, generation: GENERATION, status: this.startStatus,
      effectEnabled: this.effectEnabled }
  }
  async observe(request: Parameters<HostedOpenCodeContainerSupervisor['observe']>[0]) {
    this.observations.push(request)
    return { status: 'running' as const, handle: HANDLE, generation: GENERATION,
      effectEnabled: this.effectEnabled, endpoint: this.endpoint,
      process: { pid: 1234, startTicks: '123456', pidNamespace: 'pid:[1234]' } }
  }
  async stop(request: Parameters<HostedOpenCodeContainerSupervisor['stop']>[0]) {
    this.stops.push(request)
    return { handle: HANDLE, generation: this.stopGeneration, stopped: true, unresolved: false }
  }
  async reconcile(request: Parameters<HostedOpenCodeContainerSupervisor['reconcile']>[0]) {
    this.reconciles.push(request)
    return { handle: HANDLE, generation: this.stopGeneration, stopped: true, unresolved: false }
  }
}

class FakeAttempts implements HostedContainerAttemptClaims {
  readonly claimed = new Map<string, string>()
  async claim(binding: { key: string; fingerprint: string }): Promise<{ created: boolean; fingerprint: string }> {
    const original = this.claimed.get(binding.key)
    if (original) return { created: false, fingerprint: original }
    this.claimed.set(binding.key, binding.fingerprint)
    return { created: true, fingerprint: binding.fingerprint }
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
    await expect(lane.launch(input())).rejects.toThrow('capability unavailable')
    expect(leaseCalls).toBe(0)
    expect(supervisor.starts).toHaveLength(0)
    const manual = { ...input(), toolApprovalMode: 'manual' as const }
    const testReady = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, new FakeAttempts())
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
    }, READY, new FakeAttempts())
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
    }, READY, new FakeAttempts())
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
      READY, new FakeAttempts())
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
      READY, attempts)
    expect(await first.launch(input())).toEqual({ phase: 'failed', recoverable: true })
    const restarted = new HostedContainerOpenCodeLane(supervisor, async () => `lease_${'c'.repeat(32)}`,
      READY, attempts)
    expect(await restarted.inspect(input())).toEqual({ phase: 'failed', recoverable: true })
    expect(await restarted.recover(input())).toEqual({ phase: 'failed', recoverable: true })
    await expect(restarted.launch(input())).rejects.toThrow('already claimed')
    const changed = { ...input(), lane: { ...input().lane,
      members: [{ name: 'coder', prompt: 'Changed after restart', model: 'qwen/other' }] } }
    await expect(restarted.launch(changed)).rejects.toThrow('plan changed')
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
    }, READY, new FakeAttempts())
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
      async () => `lease_${'c'.repeat(32)}`, READY, new FakeAttempts())
    const plan = { schemaVersion: 2 as const, workspaceId: 'workspace-one', teamId: 'team-one',
      workspaceRoot: '/sandbox/test-workspace', toolApprovalMode: 'auto' as const,
      lanes: [input().lane] }
    const execution = new DurableTeamLifecycleExecution(path.join(os.tmpdir(), 'inactive-hosted-lane-state.json'), [lane])
    expect(['launch', 'cancel', 'stop', 'recover'].every(action =>
      execution.supports(plan, action as 'launch' | 'cancel' | 'stop' | 'recover'))).toBe(true)
  })
})
