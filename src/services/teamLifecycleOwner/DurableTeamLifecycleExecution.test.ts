import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HostedLifecycleAction } from '../hostedControl/HostedLifecycleSnapshot.js'
import { DurableTeamLifecycleExecution } from './DurableTeamLifecycleExecution.js'
import {
  OpenCodeTeamLifecycleLane,
  type TeamLifecycleLaneEffectPort,
  type TeamLifecycleLaneObservation,
} from './OpenCodeTeamLifecycleLane.js'
import type { TeamLifecycleLaunchPlan } from './TeamLifecycleLaunchPlan.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const plan: TeamLifecycleLaunchPlan = {
  schemaVersion: 1,
  workspaceId: 'workspace-test',
  teamId: `team_${'a'.repeat(32)}`,
  workspaceRoot: '/sandbox/project',
  lanes: [{
    laneId: 'opencode-lane',
    kind: 'opencode',
    provider: 'opencode',
    selectedModel: 'provider/model',
    effort: 'medium',
    members: [{ name: 'worker', prompt: 'Implement the fixture.', effort: 'high' }],
  }],
}

class FakeLane implements TeamLifecycleLaneEffectPort {
  readonly kind = 'opencode' as const
  launched: Array<{ runId: string; teamId: string }> = []
  actions: string[] = []
  launchResult: TeamLifecycleLaneObservation = { phase: 'running', recoverable: false }
  inspectResult: TeamLifecycleLaneObservation | null = null

  supports(_action: HostedLifecycleAction): boolean { return true }
  async inspect(input: { runId: string | null }): Promise<TeamLifecycleLaneObservation> {
    return input.runId ? this.inspectResult ?? this.launchResult : { phase: 'idle', recoverable: false }
  }
  async launch(input: { runId: string; planTeamId: string }): Promise<TeamLifecycleLaneObservation> {
    this.actions.push('launch')
    this.launched.push({ runId: input.runId, teamId: input.planTeamId })
    return this.launchResult
  }
  async cancel(): Promise<TeamLifecycleLaneObservation> {
    this.actions.push('cancel')
    return { phase: 'idle', recoverable: false }
  }
  async stop(): Promise<TeamLifecycleLaneObservation> {
    this.actions.push('stop')
    return { phase: 'idle', recoverable: false }
  }
  async recover(): Promise<TeamLifecycleLaneObservation> {
    this.actions.push('recover')
    return { phase: 'idle', recoverable: false }
  }
}

describe('DurableTeamLifecycleExecution', () => {
  test('publishes launching before effects, confirms running, then confirms stop to idle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-execution-'))
    roots.push(root)
    const lane = new FakeLane()
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane])

    const idle = await execution.inspect(plan)
    const launching = await execution.launch({
      plan,
      commandId: 'command-launch',
      runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    expect(launching.phase).toBe('launching')
    expect(launching.runId).toMatch(/^run_/)

    const running = await waitForPhase(execution, 'running')
    expect(lane.launched).toEqual([{ runId: running.runId, teamId: plan.teamId }])
    const stopping = await execution.stop({
      plan,
      commandId: 'command-stop',
      runId: running.runId,
      expectedProviderGeneration: running.providerGeneration,
    })
    expect(stopping.phase).toBe('stopping')
    await expect(waitForPhase(execution, 'idle')).resolves.toMatchObject({ runId: null })
    expect(lane.actions).toEqual(['launch', 'stop'])
  })

  test('persists a recoverable failure and only returns idle after lane recovery confirms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-recovery-'))
    roots.push(root)
    const lane = new FakeLane()
    lane.launchResult = { phase: 'failed', recoverable: true }
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane])
    const idle = await execution.inspect(plan)
    const launching = await execution.launch({
      plan, commandId: 'command-launch', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    const failed = await waitForPhase(execution, 'failed')
    const recovered = await execution.recover({
      plan, commandId: 'command-recover', runId: launching.runId,
      expectedProviderGeneration: failed.providerGeneration,
    })
    expect(recovered).toMatchObject({ phase: 'idle', runId: null, recoverable: false })
    expect(lane.actions).toEqual(['launch', 'recover'])
  })

  test('keeps an asynchronously admitted launch durable until inspect confirms running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-async-launch-'))
    roots.push(root)
    const lane = new FakeLane()
    lane.launchResult = { phase: 'launching', recoverable: false }
    lane.inspectResult = { phase: 'running', recoverable: false }
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane])
    const idle = await execution.inspect(plan)

    const launching = await execution.launch({
      plan, commandId: 'command-launch', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    expect(launching.phase).toBe('launching')
    await execution.close()

    await expect(execution.inspect(plan)).resolves.toMatchObject({
      phase: 'running', runId: launching.runId, recoverable: false,
    })
  })

  test('reconciles an asynchronously failed launch without inventing success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-async-failure-'))
    roots.push(root)
    const lane = new FakeLane()
    lane.launchResult = { phase: 'launching', recoverable: false }
    lane.inspectResult = { phase: 'failed', recoverable: true }
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane])
    const idle = await execution.inspect(plan)
    const launching = await execution.launch({
      plan, commandId: 'command-launch', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    await execution.close()

    await expect(execution.inspect(plan)).resolves.toMatchObject({
      phase: 'failed', runId: launching.runId, recoverable: true,
    })
  })

  test('treats an unconfirmed launch from a previous process as recoverable crash evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-crash-evidence-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const lane = new FakeLane()
    lane.launchResult = { phase: 'launching', recoverable: false }
    const firstProcess = new DurableTeamLifecycleExecution(statePath, [lane])
    const idle = await firstProcess.inspect(plan)
    const launching = await firstProcess.launch({
      plan, commandId: 'command-launch', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    await firstProcess.close()

    const restarted = new DurableTeamLifecycleExecution(statePath, [lane])
    await expect(restarted.inspect(plan)).resolves.toMatchObject({
      phase: 'failed', runId: launching.runId, recoverable: true,
    })
  })

  test('close rejects new effects and drains a pending launch before returning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-close-'))
    roots.push(root)
    let releaseLaunch!: () => void
    const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve })
    class PendingLane extends FakeLane {
      override async launch(input: { runId: string; planTeamId: string }): Promise<TeamLifecycleLaneObservation> {
        this.actions.push('launch')
        this.launched.push({ runId: input.runId, teamId: input.planTeamId })
        await launchGate
        return { phase: 'running', recoverable: false }
      }
    }
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [new PendingLane()])
    const idle = await execution.inspect(plan)
    await execution.launch({
      plan, commandId: 'command-launch', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    let closed = false
    const closing = execution.close().then(() => { closed = true })
    await Bun.sleep(0)
    expect(closed).toBe(false)
    expect(execution.supports(plan, 'launch')).toBe(false)

    releaseLaunch()
    await closing
    await expect(execution.inspect(plan)).resolves.toMatchObject({ phase: 'running' })
  })

  test('keeps an in-process launch authoritative until its effect job commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-inflight-'))
    roots.push(root)
    let releaseLaunch!: () => void
    const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve })
    class InFlightLane extends FakeLane {
      inspections = 0
      override async inspect(input: { runId: string | null }): Promise<TeamLifecycleLaneObservation> {
        this.inspections += 1
        return super.inspect(input)
      }
      override async launch(input: { runId: string; planTeamId: string }): Promise<TeamLifecycleLaneObservation> {
        this.actions.push('launch')
        this.launched.push({ runId: input.runId, teamId: input.planTeamId })
        await launchGate
        return { phase: 'running', recoverable: false }
      }
    }
    const lane = new InFlightLane()
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane])
    const idle = await execution.inspect(plan)
    const launching = await execution.launch({
      plan, commandId: 'command-launch', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    expect((await execution.inspect(plan)).phase).toBe('launching')
    expect(lane.inspections).toBe(0)

    releaseLaunch()
    await expect(waitForPhase(execution, 'running')).resolves.toMatchObject({ runId: launching.runId })
    expect(lane.actions).toEqual(['launch'])
  })

  test('fails closed for native plans until the sole native process owner is extracted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-native-'))
    roots.push(root)
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [new FakeLane()])
    const nativePlan: TeamLifecycleLaunchPlan = {
      ...plan,
      lanes: [{
        laneId: 'codex-lane', kind: 'native', provider: 'codex',
        members: [{ name: 'worker', prompt: 'Implement the fixture.' }],
      }],
    }
    expect(execution.supports(nativePlan, 'launch')).toBe(false)
  })
})

describe('OpenCodeTeamLifecycleLane', () => {
  test('maps admitted launch data and requires positive bridge confirmations', async () => {
    const calls: Array<Record<string, unknown>> = []
    const execute = (async (input: unknown) => {
      const request = input as Record<string, unknown>
      calls.push(request)
      const command = request.command
      return {
        ok: true,
        data: command === 'opencode.stopTeam'
          ? { stopped: true }
          : { teamLaunchState: command === 'opencode.launchTeam' ? 'permission_blocked' : 'ready' },
      }
    }) as never
    const lane = new OpenCodeTeamLifecycleLane(execute, 10_000)
    const admittedLane = plan.lanes[0]!
    const input = {
      planTeamId: plan.teamId,
      workspaceRoot: plan.workspaceRoot,
      lane: admittedLane,
      runId: 'run_test1234',
    }
    await expect(lane.launch(input)).resolves.toEqual({ phase: 'launching', recoverable: false })
    await expect(lane.inspect(input)).resolves.toEqual({ phase: 'running', recoverable: false })
    await expect(lane.stop(input)).resolves.toEqual({ phase: 'idle', recoverable: false })
    expect(calls.map(call => call.command)).toEqual([
      'opencode.launchTeam', 'opencode.reconcileTeam', 'opencode.stopTeam',
    ])
    expect((calls[0]!.body as Record<string, unknown>).members).toEqual([
      { name: 'worker', prompt: 'Implement the fixture.', effort: 'high' },
    ])
  })

  test('waits for an in-flight launch before stopping the same lane', async () => {
    let releaseLaunch!: () => void
    const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve })
    const calls: string[] = []
    const execute = (async (input: unknown) => {
      const command = String((input as Record<string, unknown>).command)
      calls.push(command)
      if (command === 'opencode.launchTeam') await launchGate
      return {
        ok: true,
        data: command === 'opencode.stopTeam'
          ? { stopped: true }
          : { teamLaunchState: 'ready' },
      }
    }) as never
    const lane = new OpenCodeTeamLifecycleLane(execute)
    const input = {
      planTeamId: plan.teamId,
      workspaceRoot: plan.workspaceRoot,
      lane: plan.lanes[0]!,
      runId: 'run_serialized',
    }

    const launch = lane.launch(input)
    await Bun.sleep(0)
    const stop = lane.stop(input)
    await Bun.sleep(0)
    expect(calls).toEqual(['opencode.launchTeam'])

    releaseLaunch()
    await expect(Promise.all([launch, stop])).resolves.toEqual([
      { phase: 'running', recoverable: false },
      { phase: 'idle', recoverable: false },
    ])
    expect(calls).toEqual(['opencode.launchTeam', 'opencode.stopTeam'])
  })
})

async function waitForPhase(
  execution: DurableTeamLifecycleExecution,
  phase: 'idle' | 'running' | 'failed',
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await execution.inspect(plan)
    if (state.phase === phase) return state
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${phase}`)
}
