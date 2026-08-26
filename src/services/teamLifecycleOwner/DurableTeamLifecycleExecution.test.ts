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
  schemaVersion: 2,
  workspaceId: 'workspace-test',
  teamId: `team_${'a'.repeat(32)}`,
  workspaceRoot: '/sandbox/project',
  toolApprovalMode: 'manual',
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
  launched: Array<{ runId: string; teamId: string; toolApprovalMode: 'manual' | 'auto' }> = []
  stoppedRunIds: string[] = []
  stoppedApprovalModes: Array<'manual' | 'auto'> = []
  actions: string[] = []
  launchResult: TeamLifecycleLaneObservation = { phase: 'running', recoverable: false }
  inspectResult: TeamLifecycleLaneObservation | null = null

  supports(_action: HostedLifecycleAction): boolean { return true }
  async inspect(input: { runId: string | null }): Promise<TeamLifecycleLaneObservation> {
    return input.runId ? this.inspectResult ?? this.launchResult : { phase: 'idle', recoverable: false }
  }
  async launch(input: { runId: string; planTeamId: string; toolApprovalMode: 'manual' | 'auto' }): Promise<TeamLifecycleLaneObservation> {
    this.actions.push('launch')
    this.launched.push({ runId: input.runId, teamId: input.planTeamId, toolApprovalMode: input.toolApprovalMode })
    return this.launchResult
  }
  async cancel(): Promise<TeamLifecycleLaneObservation> {
    this.actions.push('cancel')
    return { phase: 'idle', recoverable: false }
  }
  async stop(input: { runId: string; toolApprovalMode: 'manual' | 'auto' }): Promise<TeamLifecycleLaneObservation> {
    this.actions.push('stop')
    this.stoppedRunIds.push(input.runId)
    this.stoppedApprovalModes.push(input.toolApprovalMode)
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
    expect(lane.launched).toEqual([{
      runId: running.runId,
      teamId: plan.teamId,
      toolApprovalMode: 'manual',
    }])
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
      override async launch(input: { runId: string; planTeamId: string; toolApprovalMode: 'manual' | 'auto' }): Promise<TeamLifecycleLaneObservation> {
        this.actions.push('launch')
        this.launched.push({ runId: input.runId, teamId: input.planTeamId, toolApprovalMode: input.toolApprovalMode })
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

  test('shutdown compensates the exact running run and cannot settle before stop confirms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-running-close-'))
    roots.push(root)
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    let enteredStop!: () => void
    const stopEntered = new Promise<void>(resolve => { enteredStop = resolve })
    class PendingStopLane extends FakeLane {
      override async stop(input: { runId: string; toolApprovalMode: 'manual' | 'auto' }): Promise<TeamLifecycleLaneObservation> {
        this.actions.push('stop')
        this.stoppedRunIds.push(input.runId)
        this.stoppedApprovalModes.push(input.toolApprovalMode)
        enteredStop()
        await stopGate
        return { phase: 'idle', recoverable: false }
      }
    }
    const lane = new PendingStopLane()
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane])
    const idle = await execution.inspect(plan)
    const launching = await execution.launch({
      plan, commandId: 'command-launch-before-loss', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    const running = await waitForPhase(execution, 'running')

    let closed = false
    const closing = execution.shutdown().then(() => { closed = true })
    await stopEntered
    expect(closed).toBe(false)
    expect(lane.actions).toEqual(['launch', 'stop'])
    expect(lane.stoppedRunIds).toEqual([running.runId])
    expect(lane.stoppedApprovalModes).toEqual(['manual'])
    expect(execution.supports(plan, 'launch')).toBe(false)

    releaseStop()
    await closing
    await expect(execution.launch({
      plan, commandId: 'command-after-loss', runId: null,
      expectedProviderGeneration: launching.providerGeneration,
    })).rejects.toThrow('closed')
    await expect(execution.inspect(plan)).resolves.toMatchObject({ phase: 'idle', runId: null })
  })

  test('replacement owner adopts a persisted running tuple and shutdown stops that exact run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-restart-shutdown-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const lane = new FakeLane()
    const crashedOwner = new DurableTeamLifecycleExecution(statePath, [lane])
    const idle = await crashedOwner.inspect(plan)
    const launching = await crashedOwner.launch({
      plan,
      commandId: 'command-before-crash',
      runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    const persisted = await waitForPhase(crashedOwner, 'running')
    expect(persisted.runId).toBe(launching.runId)

    // Do not close or shut down the first instance: abandoning it models a
    // process crash while the provider run and durable running tuple survive.
    const replacementOwner = new DurableTeamLifecycleExecution(statePath, [lane])
    await expect(replacementOwner.inspect(plan)).resolves.toMatchObject({
      phase: 'running',
      runId: persisted.runId,
    })
    await replacementOwner.shutdown()

    expect(lane.stoppedRunIds).toEqual([persisted.runId])
    expect(lane.stoppedApprovalModes).toEqual(['manual'])
    await expect(replacementOwner.inspect(plan)).resolves.toMatchObject({
      phase: 'idle',
      runId: null,
    })
  })

  test('replacement owner cleans the exact persisted tuple when running adoption fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-restart-failed-adoption-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const lane = new FakeLane()
    const crashedOwner = new DurableTeamLifecycleExecution(statePath, [lane])
    const idle = await crashedOwner.inspect(plan)
    await crashedOwner.launch({
      plan,
      commandId: 'command-before-failed-adoption',
      runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    const persisted = await waitForPhase(crashedOwner, 'running')
    lane.inspectResult = { phase: 'failed', recoverable: true }

    const replacementOwner = new DurableTeamLifecycleExecution(statePath, [lane])
    await expect(replacementOwner.inspect(plan)).rejects.toThrow(
      'Unable to adopt recovered team lifecycle run',
    )
    expect(lane.stoppedRunIds).toEqual([persisted.runId])

    lane.inspectResult = null
    await expect(replacementOwner.inspect(plan)).resolves.toMatchObject({
      phase: 'idle',
      runId: null,
    })
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
      override async launch(input: { runId: string; planTeamId: string; toolApprovalMode: 'manual' | 'auto' }): Promise<TeamLifecycleLaneObservation> {
        this.actions.push('launch')
        this.launched.push({ runId: input.runId, teamId: input.planTeamId, toolApprovalMode: input.toolApprovalMode })
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

  test('revalidates authority inside a scheduled lane effect after the admitting request returns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-expired-effect-'))
    roots.push(root)
    const lane = new FakeLane()
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane])
    const idle = await execution.inspect(plan)
    let resolveGuard!: (allowed: boolean) => void
    const guardDecision = new Promise<boolean>(resolve => { resolveGuard = resolve })

    const launching = await execution.launch({
      plan,
      commandId: 'command-launch-expired',
      runId: null,
      expectedProviderGeneration: idle.providerGeneration,
      effectGuard: () => guardDecision,
    })
    expect(launching.phase).toBe('launching')
    expect(lane.actions).toEqual([])

    // Simulate losing the root-owner lease while the durable launch job waits
    // in the scheduler, before it crosses the provider effect boundary.
    resolveGuard(false)
    await expect(waitForPhase(execution, 'failed')).resolves.toMatchObject({
      runId: launching.runId,
      recoverable: true,
    })
    expect(lane.actions).toEqual([])
  })

  test('compensates an exact launched run when authority is lost while launch awaits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-post-effect-loss-'))
    roots.push(root)
    let releaseLaunch!: () => void
    const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve })
    let authority = true
    class BlockedLaunchLane extends FakeLane {
      override async launch(input: { runId: string; planTeamId: string; toolApprovalMode: 'manual' | 'auto' }): Promise<TeamLifecycleLaneObservation> {
        this.actions.push('launch')
        this.launched.push({
          runId: input.runId,
          teamId: input.planTeamId,
          toolApprovalMode: input.toolApprovalMode,
        })
        await launchGate
        return { phase: 'running', recoverable: false }
      }
    }
    const lane = new BlockedLaunchLane()
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane])
    const idle = await execution.inspect(plan)
    await execution.launch({
      plan,
      commandId: 'command-post-effect-loss',
      runId: null,
      expectedProviderGeneration: idle.providerGeneration,
      effectGuard: () => authority,
    })
    await Bun.sleep(0)
    authority = false
    releaseLaunch()
    await execution.close()

    expect(lane.actions).toEqual(['launch', 'stop'])
    await expect(execution.inspect(plan)).resolves.toMatchObject({
      phase: 'failed',
      recoverable: true,
    })
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

  test('binds recovered durable state to the admitted approval mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-approval-mode-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const execution = new DurableTeamLifecycleExecution(statePath, [new FakeLane()])
    const idle = await execution.inspect(plan)
    await execution.launch({
      plan,
      commandId: 'command-mode-binding',
      runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    await waitForPhase(execution, 'running')

    const changedMode: TeamLifecycleLaunchPlan = { ...plan, toolApprovalMode: 'auto' }
    await expect(execution.inspect(changedMode)).rejects.toThrow(
      'Team lifecycle durable approval mode changed',
    )
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
    const lane = new OpenCodeTeamLifecycleLane(execute, 10_000, () => true)
    const admittedLane = plan.lanes[0]!
    const input = {
      planTeamId: plan.teamId,
      workspaceRoot: plan.workspaceRoot,
      toolApprovalMode: plan.toolApprovalMode,
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
    expect(calls[0]!.body).toMatchObject({ toolApprovalMode: 'manual', skipPermissions: false })
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
    const lane = new OpenCodeTeamLifecycleLane(execute, 300_000, () => true)
    const input = {
      planTeamId: plan.teamId,
      workspaceRoot: plan.workspaceRoot,
      toolApprovalMode: plan.toolApprovalMode,
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

  test('maps an admitted auto plan to explicit automatic wire semantics', async () => {
    let launchBody: Record<string, unknown> | null = null
    const execute = (async (input: unknown) => {
      launchBody = (input as { body: Record<string, unknown> }).body
      return { ok: true, data: { teamLaunchState: 'ready' } }
    }) as never
    const lane = new OpenCodeTeamLifecycleLane(execute, 10_000, () => true)
    await lane.launch({
      planTeamId: plan.teamId,
      workspaceRoot: plan.workspaceRoot,
      toolApprovalMode: 'auto',
      lane: plan.lanes[0]!,
      runId: 'run_auto',
    })
    expect(launchBody).toMatchObject({ toolApprovalMode: 'auto', skipPermissions: true })
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
