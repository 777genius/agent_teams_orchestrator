import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HostedLifecycleAction } from '../hostedControl/HostedLifecycleSnapshot.js'
import {
  DurableTeamLifecycleExecution,
  type TeamLifecycleRunReservation,
} from './DurableTeamLifecycleExecution.js'
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
  test('drops a delayed trusted reservation after authority loss without writing intent or effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-reservation-authority-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const lane = new FakeLane()
    let resolveReservation!: (reservation: TeamLifecycleRunReservation) => void
    let admittedBinding!: Omit<TeamLifecycleRunReservation, 'runId'>
    let enteredReservation!: () => void
    const entered = new Promise<void>(resolve => { enteredReservation = resolve })
    const pending = new Promise<TeamLifecycleRunReservation>(resolve => { resolveReservation = resolve })
    let authority = true
    const execution = new DurableTeamLifecycleExecution(statePath, [lane], undefined, {
      requireRunReservation: true,
      runReservation: async binding => {
        admittedBinding = binding
        enteredReservation()
        return pending
      },
    })
    const idle = await execution.inspect(plan)
    const launching = execution.launch({
      plan, commandId: 'command-delayed', idempotencyKey: 'idem-delayed', runId: null,
      expectedProviderGeneration: idle.providerGeneration, effectGuard: () => authority,
    })
    await entered
    authority = false
    resolveReservation({ ...admittedBinding, runId: `run_${'b'.repeat(32)}` })
    await expect(launching).rejects.toThrow('authority changed')
    expect(lane.actions).toEqual([])
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('close aborts and releases a hung reservation even when its port ignores the signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-reservation-close-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const lane = new FakeLane()
    let entered!: () => void
    const portEntered = new Promise<void>(resolve => { entered = resolve })
    let release!: (value: TeamLifecycleRunReservation) => void
    const pending = new Promise<TeamLifecycleRunReservation>(resolve => { release = resolve })
    let portSignal!: AbortSignal
    let binding!: Omit<TeamLifecycleRunReservation, 'runId'>
    const execution = new DurableTeamLifecycleExecution(statePath, [lane], undefined, {
      requireRunReservation: true,
      runReservation: async (input, signal) => {
        binding = input
        portSignal = signal
        entered()
        return pending
      },
    })
    const idle = await execution.inspect(plan)
    const launching = execution.launch({
      plan, commandId: 'command-hung', idempotencyKey: 'idem-hung', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    await portEntered
    await execution.close()
    expect(portSignal.aborted).toBe(true)
    await expect(launching).rejects.toThrow('closed')
    release({ ...binding, runId: `run_${'b'.repeat(32)}` })
    await Bun.sleep(0)
    expect(lane.actions).toEqual([])
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('reservation deadline releases serialization and rejects a late result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-reservation-timeout-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const lane = new FakeLane()
    let release!: (value: TeamLifecycleRunReservation) => void
    const pending = new Promise<TeamLifecycleRunReservation>(resolve => { release = resolve })
    let binding!: Omit<TeamLifecycleRunReservation, 'runId'>
    const execution = new DurableTeamLifecycleExecution(statePath, [lane], undefined, {
      reservationTimeoutMs: 10,
      runReservation: async input => { binding = input; return pending },
    })
    const idle = await execution.inspect(plan)
    await expect(execution.launch({
      plan, commandId: 'command-timeout', idempotencyKey: 'idem-timeout', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })).rejects.toThrow('timed out')
    release({ ...binding, runId: `run_${'b'.repeat(32)}` })
    await execution.close()
    expect(lane.actions).toEqual([])
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('replays an identical trusted reservation without allocating another run or lane effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-reservation-replay-'))
    roots.push(root)
    const lane = new FakeLane()
    const runId = `run_${'b'.repeat(32)}`
    const bindings: TeamLifecycleRunReservation[] = []
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane], undefined, {
      requireRunReservation: true,
      runReservation: async binding => {
        const reservation = { ...binding, runId }
        bindings.push(reservation)
        return reservation
      },
    })
    const idle = await execution.inspect(plan)
    const input = {
      plan, commandId: 'command-replay', idempotencyKey: 'idem-replay', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    }
    const launched = await execution.launch(input)
    await waitForPhase(execution, 'running')
    const replayed = await execution.launch(input)
    expect(launched.runId).toBe(runId)
    expect(replayed).toMatchObject({ phase: 'running', runId })
    expect(bindings).toHaveLength(2)
    expect(bindings[0]).toEqual(bindings[1])
    expect(lane.actions).toEqual(['launch'])
  })

  test('rejects a trusted reservation bound to a changed plan or command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-reservation-plan-'))
    roots.push(root)
    const lane = new FakeLane()
    let original: TeamLifecycleRunReservation | null = null
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane], undefined, {
      requireRunReservation: true,
      runReservation: async binding => original ??= { ...binding, runId: `run_${'b'.repeat(32)}` },
    })
    const idle = await execution.inspect(plan)
    const input = {
      plan, commandId: 'command-original', idempotencyKey: 'idem-original', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    }
    const launched = await execution.launch(input)
    await waitForPhase(execution, 'running')
    await expect(execution.launch({ ...input, commandId: 'command-changed' }))
      .rejects.toThrow('reservation changed')
    await expect(execution.launch({ ...input, idempotencyKey: 'idem-changed' }))
      .rejects.toThrow('reservation changed')
    const changedPlan: TeamLifecycleLaunchPlan = { ...plan, workspaceRoot: '/sandbox/changed-project' }
    await expect(execution.launch({ ...input, plan: changedPlan }))
      .rejects.toThrow('Active team lifecycle plan changed')
    expect(launched.runId).toBe(`run_${'b'.repeat(32)}`)
    expect(lane.actions).toEqual(['launch'])
  })

  test('fails closed when a required trusted reservation is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-reservation-absent-'))
    roots.push(root)
    const lane = new FakeLane()
    const statePath = join(root, 'state.json')
    const idleExecution = new DurableTeamLifecycleExecution(statePath, [lane])
    const idle = await idleExecution.inspect(plan)
    const input = {
      plan, commandId: 'command-absent', idempotencyKey: 'idem-absent', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    }
    const unconfigured = new DurableTeamLifecycleExecution(statePath, [lane], undefined, {
      requireRunReservation: true,
    })
    await expect(unconfigured.launch(input)).rejects.toThrow('reservation is required')
    const unavailable = new DurableTeamLifecycleExecution(statePath, [lane], undefined, {
      runReservation: async () => null,
    })
    await expect(unavailable.launch(input)).rejects.toThrow('reservation changed or unavailable')
    await expect(unavailable.launch({ ...input, idempotencyKey: undefined }))
      .rejects.toThrow('idempotency key is required')
    expect(lane.actions).toEqual([])
  })

  test('does not reserve a run for a stale idle generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-reservation-generation-'))
    roots.push(root)
    let reservations = 0
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [new FakeLane()], undefined, {
      runReservation: async binding => {
        reservations++
        return { ...binding, runId: `run_${'b'.repeat(32)}` }
      },
    })
    await expect(execution.launch({
      plan, commandId: 'command-stale', idempotencyKey: 'idem-stale', runId: null,
      expectedProviderGeneration: 'generation_stale',
    })).rejects.toThrow('provider generation changed')
    expect(reservations).toBe(0)
  })

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

  test('records and reports why a lane launch threw, redacted, and drops the reason on recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-failure-reason-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const lane = new FakeLane()
    lane.launch = async () => {
      throw new Error('OpenCode strict launch expectedBehaviorFingerprint must be lowercase SHA-256 token=abc123secret')
    }
    const reports: unknown[] = []
    const execution = new DurableTeamLifecycleExecution(statePath, [lane], 'team-lifecycle-owner', {
      reportLaneFailure: report => reports.push(report),
    })
    const idle = await execution.inspect(plan)
    const launching = await execution.launch({
      plan, commandId: 'command-launch', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    const failed = await waitForPhase(execution, 'failed')
    const failure = {
      action: 'launch', code: 'lane_exception',
      message: 'OpenCode strict launch expectedBehaviorFingerprint must be lowercase SHA-256 token=[redacted]',
    }
    expect(JSON.parse(await readFile(statePath, 'utf8')).failure).toEqual(failure)
    expect(reports).toEqual([{ ...failure, runId: launching.runId, laneKinds: ['opencode'] }])

    // A restarted owner reads the reason back; a confirmed recovery clears it.
    const restarted = new DurableTeamLifecycleExecution(statePath, [lane])
    expect((await restarted.inspect(plan)).phase).toBe('failed')
    await restarted.recover({
      plan, commandId: 'command-recover', runId: launching.runId,
      expectedProviderGeneration: failed.providerGeneration,
    })
    expect(JSON.parse(await readFile(statePath, 'utf8'))).not.toHaveProperty('failure')
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

  test('concurrent inspections share one lane inspection, but never across a later operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-shared-inspect-'))
    roots.push(root)
    const lane = new FakeLane()
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane])
    await execution.launch({
      plan, commandId: 'command-launch', runId: null,
      expectedProviderGeneration: (await execution.inspect(plan)).providerGeneration,
    })
    const running = await waitForPhase(execution, 'running')
    let laneInspections = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const inspect = lane.inspect.bind(lane)
    lane.inspect = async input => {
      laneInspections += 1
      await gate
      return inspect(input)
    }

    const first = execution.inspect(plan)
    expect(execution.inspect(plan)).toBe(first)
    // A stop queued after the shared inspection is observed only by a new one.
    const stopped = execution.stop({
      plan, commandId: 'command-stop', runId: running.runId,
      expectedProviderGeneration: running.providerGeneration,
    })
    const afterStop = execution.inspect(plan)
    expect(afterStop).not.toBe(first)
    release()
    await expect(first).resolves.toMatchObject({ phase: 'running', runId: running.runId })
    await stopped
    await expect(afterStop).resolves.not.toMatchObject({ phase: 'running' })
    expect(laneInspections).toBe(1)
    await execution.close()
  })

  test('shutdown stops a run adopted from a crashed owner, inspected or not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-adopted-shutdown-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const lane = new FakeLane()
    const crashed = new DurableTeamLifecycleExecution(statePath, [lane])
    const idle = await crashed.inspect(plan)
    await crashed.launch({
      plan, commandId: 'command-launch', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    const running = await waitForPhase(crashed, 'running')
    // close() without shutdown leaves the run recorded, as a crash does; its detached host lives on.
    await crashed.close()

    // The next owner adopts the run on its first inspect, then shuts down gracefully.
    const adopting = new DurableTeamLifecycleExecution(statePath, [lane])
    await expect(adopting.inspect(plan)).resolves.toMatchObject({ phase: 'running', runId: running.runId })
    await adopting.shutdown()
    expect(lane.stoppedRunIds).toEqual([running.runId])
    await expect(new DurableTeamLifecycleExecution(statePath, [lane]).inspect(plan))
      .resolves.toMatchObject({ phase: 'idle', runId: null })

    // An owner that never inspected the run still stops it through the admitted plan.
    const relaunching = new DurableTeamLifecycleExecution(statePath, [lane])
    const relaunched = await relaunching.launch({
      plan, commandId: 'command-relaunch', runId: null,
      expectedProviderGeneration: (await relaunching.inspect(plan)).providerGeneration,
    })
    await waitForPhase(relaunching, 'running')
    await relaunching.close()
    const unaware = new DurableTeamLifecycleExecution(statePath, [lane], 'team-lifecycle-owner', {
      loadAdmittedPlan: async () => plan,
    })
    await unaware.shutdown()
    expect(lane.stoppedRunIds).toEqual([running.runId, relaunched.runId])
    await expect(new DurableTeamLifecycleExecution(statePath, [lane]).inspect(plan))
      .resolves.toMatchObject({ phase: 'idle', runId: null })
  })

  test('shutdown stops a failed run and keeps its first cause when the stop fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-failed-shutdown-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const lane = new FakeLane()
    lane.launchResult = { phase: 'failed', recoverable: true }
    const failedRun = async () => {
      const execution = new DurableTeamLifecycleExecution(statePath, [lane])
      const launching = await execution.launch({
        plan, commandId: `command-launch-${lane.launched.length}`, runId: null,
        expectedProviderGeneration: (await execution.inspect(plan)).providerGeneration,
      })
      await waitForPhase(execution, 'failed')
      await execution.close()
      return launching.runId!
    }
    const firstCause = async () => JSON.parse(await readFile(statePath, 'utf8')).failure

    // A failed launch can leave live lane processes; a graceful shutdown stops it to idle.
    const stoppedRun = await failedRun()
    await new DurableTeamLifecycleExecution(statePath, [lane], 'team-lifecycle-owner', {
      loadAdmittedPlan: async () => plan,
    }).shutdown()
    expect(lane.stoppedRunIds).toEqual([stoppedRun])
    await expect(new DurableTeamLifecycleExecution(statePath, [lane]).inspect(plan))
      .resolves.toMatchObject({ phase: 'idle', runId: null })

    // An unconfirmed teardown only reports; the recorded launch failure stays the cause.
    const keptRun = await failedRun()
    const cause = await firstCause()
    expect(cause).toMatchObject({ action: 'launch' })
    lane.stop = async () => { throw new Error('bridge unavailable') }
    const reports: unknown[] = []
    await new DurableTeamLifecycleExecution(statePath, [lane], 'team-lifecycle-owner', {
      loadAdmittedPlan: async () => plan,
      reportLaneFailure: report => reports.push(report),
    }).shutdown()
    expect(await firstCause()).toEqual(cause)
    expect(reports).toEqual([expect.objectContaining({ action: 'teardown', runId: keptRun })])
    await expect(new DurableTeamLifecycleExecution(statePath, [lane]).inspect(plan))
      .resolves.toMatchObject({ phase: 'failed', runId: keptRun, recoverable: true })
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

const attestedFingerprint = 'f'.repeat(64)
const readyReadiness = {
  state: 'ready', launchAllowed: true, missing: [],
  expectedBehaviorEvidence: { expectedBehaviorFingerprint: attestedFingerprint },
}

describe('OpenCodeTeamLifecycleLane', () => {
  test('attests readiness, then launches with strict preconditions bound to that fingerprint', async () => {
    const calls: Array<{ command: string; body: Record<string, unknown> }> = []
    let readiness: Record<string, unknown> = readyReadiness
    const execute = (async (input: unknown) => {
      const request = input as { command: string; body: Record<string, unknown> }
      calls.push(request)
      return {
        ok: true,
        runtime: { capabilitySnapshotId: launchedCapability },
        data: request.command === 'opencode.readiness' ? readiness : { teamLaunchState: 'ready' },
      }
    }) as never
    const launchedCapability = `opencode:${'d'.repeat(32)}`
    // Session records carry no stop authority while a run is still bootstrapping.
    const lane = new OpenCodeTeamLifecycleLane(execute, 10_000, () => true, async () => null)
    const input = {
      planTeamId: 'draft-team', workspaceRoot: plan.workspaceRoot, toolApprovalMode: plan.toolApprovalMode,
      lane: plan.lanes[0]!, runId: 'run_strict',
    }
    await expect(lane.launch(input)).resolves.toEqual({ phase: 'running', recoverable: false })
    await lane.launch(input)
    expect(calls.map(call => call.command)).toEqual([
      'opencode.readiness', 'opencode.launchTeam', 'opencode.readiness', 'opencode.launchTeam',
    ])
    expect(calls[0]!.body).toEqual({
      projectPath: plan.workspaceRoot, selectedModel: 'provider/model', requireExecutionProbe: true,
    })
    const [first, second] = [calls[1]!.body.preconditions, calls[3]!.body.preconditions] as Array<Record<string, unknown>>
    expect(first).toMatchObject({
      laneId: 'opencode-lane', expectedRunId: 'run_strict', expectedBehaviorFingerprint: attestedFingerprint,
      expectedCapabilitySnapshotId: null, expectedManifestHighWatermark: null,
      idempotencyKey: 'hosted-launch:draft-team:opencode-lane:run_strict',
    })
    expect(typeof first!.handshakeIdentityHash).toBe('string')
    // The idempotency key is stable per run; each attempt owns a fresh host lease.
    expect(second!.idempotencyKey).toBe(first!.idempotencyKey)
    expect(second!.commandLeaseId).not.toBe(first!.commandLeaseId)
    // Reconcile reuses the run's launched host instead of a generic probe that could evict it.
    await lane.inspect(input)
    expect(calls.at(-1)).toMatchObject({ command: 'opencode.reconcileTeam',
      body: { expectedCapabilitySnapshotId: launchedCapability,
        preconditions: { expectedCapabilitySnapshotId: launchedCapability, expectedRunId: 'run_strict' } } })

    calls.length = 0
    readiness = { state: 'model_unavailable', launchAllowed: false, missing: ['Selected model is unavailable'] }
    await expect(lane.launch(input)).rejects.toThrow(
      'OpenCode readiness does not allow launch (model_unavailable): Selected model is unavailable')
    readiness = { ...readyReadiness, expectedBehaviorEvidence: {} }
    await expect(lane.launch(input)).rejects.toThrow('did not attest an expected behavior fingerprint')
    expect(calls.map(call => call.command)).toEqual(['opencode.readiness', 'opencode.readiness'])
  })

  test('maps admitted launch data and requires positive bridge confirmations', async () => {
    const calls: Array<Record<string, unknown>> = []
    const execute = (async (input: unknown) => {
      const request = input as Record<string, unknown>
      const command = request.command
      if (command === 'opencode.readiness') return { ok: true, data: readyReadiness }
      calls.push(request)
      return {
        ok: true,
        data: command === 'opencode.stopTeam'
          ? { stopped: true }
          : { teamLaunchState: command === 'opencode.launchTeam' ? 'permission_blocked' : 'ready' },
      }
    }) as never
    const capability = `opencode:${'c'.repeat(32)}`
    const lane = new OpenCodeTeamLifecycleLane(execute, 10_000, () => true, async () => capability)
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
    // Reconcile binds to the run's committed capability so the bridge reuses its host.
    expect(calls[1]!.body).toMatchObject({
      expectedCapabilitySnapshotId: capability,
      preconditions: { expectedRunId: 'run_test1234', expectedCapabilitySnapshotId: capability },
    })
  })

  test('waits for an in-flight launch before stopping the same lane', async () => {
    let releaseLaunch!: () => void
    const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve })
    const calls: string[] = []
    const execute = (async (input: unknown) => {
      const command = String((input as Record<string, unknown>).command)
      if (command === 'opencode.readiness') return { ok: true, data: readyReadiness }
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
      const request = input as { command: string; body: Record<string, unknown> }
      if (request.command === 'opencode.readiness') return { ok: true, data: readyReadiness }
      launchBody = request.body
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
