import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HostedLifecycleAction } from '../hostedControl/HostedLifecycleSnapshot.js'
import { DurableTeamLifecycleExecution } from './DurableTeamLifecycleExecution.js'
import {
  OpenCodeTeamLifecycleLane,
  type TeamLifecycleLaneEffectPort,
  type TeamLifecycleLaneInput,
  type TeamLifecycleLaneObservation,
} from './OpenCodeTeamLifecycleLane.js'
import type { TeamLifecycleLaunchPlan } from './TeamLifecycleLaunchPlan.js'
import { TeamLifecycleJournalTransactions } from './TeamLifecycleJournalTransactions.js'

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

const TEST_RECOVERY_BINDING = `session-set_${'a'.repeat(64)}`

type ExecuteBridge = NonNullable<ConstructorParameters<typeof OpenCodeTeamLifecycleLane>[0]>
type BridgeSuccess = Extract<Awaited<ReturnType<ExecuteBridge>>, { data: unknown }>
type TeamCommandData = Extract<BridgeSuccess['data'], { teamLaunchState: string }>
type TeamCommandMember = TeamCommandData['members'][string]
type StopCommandData = Extract<BridgeSuccess['data'], { stopped: boolean; members: object }>
type LifecycleBridgeCommand = 'opencode.launchTeam' | 'opencode.reconcileTeam' | 'opencode.stopTeam'
type LifecycleBridgeRequest = {
  requestId: string
  command: LifecycleBridgeCommand
  body: object
}

const FIXTURE_OBSERVED_AT = '2026-01-01T00:00:00.000Z'

function bridgeRequest(input: unknown): LifecycleBridgeRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Fixture expected a bridge request')
  if (!('requestId' in input) || typeof input.requestId !== 'string') throw new Error('Fixture expected a bridge request id')
  if (!('command' in input) || (
    input.command !== 'opencode.launchTeam' &&
    input.command !== 'opencode.reconcileTeam' &&
    input.command !== 'opencode.stopTeam'
  )) throw new Error('Fixture received an unexpected bridge command')
  if (!('body' in input) || !input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
    throw new Error('Fixture expected a bridge body')
  }
  return { requestId: input.requestId, command: input.command, body: input.body }
}

function bridgeSuccess(input: unknown, data: BridgeSuccess['data']): BridgeSuccess {
  const request = bridgeRequest(input)
  const command = request.command
  return { ok: true, schemaVersion: 1, requestId: request.requestId, command,
    completedAt: FIXTURE_OBSERVED_AT, durationMs: 0,
    runtime: { providerId: 'opencode', binaryPath: null, binaryFingerprint: null, version: null, capabilitySnapshotId: null },
    diagnostics: [], data }
}

function teamMember(
  sessionId: string,
  launchState: TeamCommandMember['launchState'] = 'confirmed_alive',
): TeamCommandMember {
  const evidenceKind = launchState === 'permission_blocked'
    ? 'permission_blocked'
    : launchState === 'failed'
      ? 'member_launch_failed'
      : launchState === 'created'
        ? 'member_session_recorded'
        : 'member_ready'
  return {
    sessionId,
    launchState,
    model: 'provider/model',
    evidence: [{ kind: evidenceKind, observedAt: FIXTURE_OBSERVED_AT }],
    diagnostics: [],
  }
}

function teamCommandData(
  teamLaunchState: TeamCommandData['teamLaunchState'],
  members: TeamCommandData['members'],
  runId = 'run_fixture',
): TeamCommandData {
  return {
    runId,
    teamLaunchState,
    members,
    warnings: [],
    diagnostics: [],
    manifestHighWatermark: null,
    runtimeStoreManifestHighWatermark: null,
    durableCheckpoints: [{ name: 'delivery_ready', observedAt: FIXTURE_OBSERVED_AT }],
  }
}

function stopCommandData(runId: string): StopCommandData {
  return {
    runId,
    stopped: true,
    members: {
      worker: { sessionId: 'session-worker', stopped: true, diagnostics: [] },
    },
    warnings: [],
    diagnostics: [],
    manifestHighWatermark: null,
    runtimeStoreManifestHighWatermark: null,
  }
}

function bridgeRunId(request: LifecycleBridgeRequest): string {
  if (!('runId' in request.body) || typeof request.body.runId !== 'string') {
    throw new Error('Fixture expected a lifecycle run id')
  }
  return request.body.runId
}

function requiredRunId(value: { runId: string | null }): string {
  if (!value.runId) throw new Error('Fixture expected an active run')
  return value.runId
}

function planWithSelectedModel(selectedModel: string): TeamLifecycleLaunchPlan {
  const lane = plan.lanes[0]
  if (!lane || lane.kind !== 'opencode') throw new Error('Fixture expected an OpenCode lane')
  return { ...plan, lanes: [{ ...lane, selectedModel }] }
}

function running(
  recoveryBinding = TEST_RECOVERY_BINDING,
): TeamLifecycleLaneObservation {
  return { phase: 'running', recoverable: false, recoveryBinding }
}

class FakeLane implements TeamLifecycleLaneEffectPort {
  readonly kind = 'opencode' as const
  launched: Array<{ runId: string; teamId: string; toolApprovalMode: 'manual' | 'auto' }> = []
  stoppedRunIds: string[] = []
  stoppedApprovalModes: Array<'manual' | 'auto'> = []
  actions: string[] = []
  launchResult: TeamLifecycleLaneObservation = running()
  inspectResult: TeamLifecycleLaneObservation | null = null

  supports(_action: HostedLifecycleAction): boolean { return true }
  async inspect(input: { runId: string | null }): Promise<TeamLifecycleLaneObservation> {
    return input.runId ? this.inspectResult ?? this.launchResult : { phase: 'idle', recoverable: false }
  }
  async launch(input: TeamLifecycleLaneInput & { runId: string }): Promise<TeamLifecycleLaneObservation> {
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
  test('mounts caller-supplied same-file journal transactions for the next B composition slice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-shared-transactions-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const transactions = new TeamLifecycleJournalTransactions(statePath)
    const execution = new DurableTeamLifecycleExecution(statePath, [new FakeLane()], 'team-lifecycle-owner', {}, { transactions })
    expect(execution.transactions).toBe(transactions)
    await execution.inspect(plan)
    await expect(execution.journal.snapshotRun('not-a-run')).resolves.toMatchObject({ attempts: [], tombstones: [] })
    expect(() => new DurableTeamLifecycleExecution(join(root, 'other.json'), [new FakeLane()], 'team-lifecycle-owner', {}, { transactions })).toThrow('does not match')
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
      runId: requiredRunId(running),
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
    lane.inspectResult = running()
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
    await expect(restarted.recoverAtStartup(plan, () => true)).rejects.toThrow(
      'Unable to adopt recovered team lifecycle run',
    )
    await expect(restarted.inspect(plan)).resolves.toMatchObject({ phase: 'idle', runId: null })
  })

  test('fails closed when durable state disappears after the namespace was initialized', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-state-deletion-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const execution = new DurableTeamLifecycleExecution(statePath, [new FakeLane()])
    const idle = await execution.inspect(plan)
    await execution.launch({
      plan, commandId: 'command-state-deletion', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    await waitForPhase(execution, 'running')
    await unlink(statePath)
    await expect(execution.inspect(plan)).rejects.toThrow('disappeared after initialization')
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
        return running()
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

  test('bounds a cooperative hung provider launch so lifecycle close cannot wait indefinitely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-close-deadline-'))
    roots.push(root)
    class HungLane extends FakeLane {
      override async launch(input: TeamLifecycleLaneInput & { runId: string }): Promise<TeamLifecycleLaneObservation> {
        this.actions.push('launch')
        return new Promise((_, reject) => {
          const abort = () => reject(input.signal?.reason)
          if (input.signal?.aborted) abort()
          else input.signal?.addEventListener('abort', abort, { once: true })
        })
      }
    }
    const lane = new HungLane()
    const execution = new DurableTeamLifecycleExecution(
      join(root, 'state.json'), [lane], 'team-lifecycle-owner',
      { effectTimeoutMs: 25, compensationTimeoutMs: 25 },
    )
    const idle = await execution.inspect(plan)
    await execution.launch({
      plan, commandId: 'command-hung-launch', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    const startedAt = Date.now()
    await execution.close()
    expect(Date.now() - startedAt).toBeLessThan(500)
    await expect(execution.inspect(plan)).resolves.toMatchObject({ phase: 'failed', recoverable: true })
  })

  test('does not close across a timed-out late launch until exact compensation confirms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-late-launch-fence-'))
    roots.push(root)
    let releaseLaunch!: () => void
    const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve })
    let stopConfirmed = false
    class GatedLateLane extends FakeLane {
      override async launch(): Promise<TeamLifecycleLaneObservation> {
        this.actions.push('launch')
        await launchGate
        return running()
      }
      override async stop(): Promise<TeamLifecycleLaneObservation> {
        this.actions.push('stop')
        stopConfirmed = true
        return { phase: 'idle', recoverable: false }
      }
    }
    const lane = new GatedLateLane()
    const execution = new DurableTeamLifecycleExecution(
      join(root, 'state.json'), [lane], 'team-lifecycle-owner',
      { effectTimeoutMs: 25, compensationTimeoutMs: 250 },
    )
    const idle = await execution.inspect(plan)
    await execution.launch({
      plan, commandId: 'command-late-launch', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    let closed = false
    const closing = execution.close().then(() => { closed = true })
    await Bun.sleep(75)
    expect(closed).toBe(false)
    expect(stopConfirmed).toBe(false)

    releaseLaunch()
    await closing
    expect(stopConfirmed).toBe(true)
    expect(lane.actions).toEqual(['launch', 'stop'])
    await Bun.sleep(25)
    expect(lane.actions).toEqual(['launch', 'stop'])
    await expect(execution.inspect(plan)).resolves.toMatchObject({ phase: 'failed', recoverable: true })
  }, 2_000)

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
    expect(lane.stoppedRunIds).toEqual([requiredRunId(running)])
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
    await replacementOwner.recoverAtStartup(plan, () => true)
    await expect(replacementOwner.inspect(plan)).resolves.toMatchObject({
      phase: 'running',
      runId: persisted.runId,
    })
    await replacementOwner.shutdown()

    expect(lane.stoppedRunIds).toEqual([requiredRunId(persisted)])
    expect(lane.stoppedApprovalModes).toEqual(['manual'])
    await expect(replacementOwner.inspect(plan)).resolves.toMatchObject({
      phase: 'idle',
      runId: null,
    })
  })

  test('rejects recovery when the provider substitutes the exact launched member session set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-session-binding-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const lane = new FakeLane()
    const crashedOwner = new DurableTeamLifecycleExecution(statePath, [lane])
    const idle = await crashedOwner.inspect(plan)
    await crashedOwner.launch({
      plan, commandId: 'command-session-binding', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    const persisted = await waitForPhase(crashedOwner, 'running')
    lane.inspectResult = running(`session-set_${'b'.repeat(64)}`)

    const replacement = new DurableTeamLifecycleExecution(statePath, [lane])
    await expect(replacement.recoverAtStartup(plan, () => true)).rejects.toThrow(
      'Unable to adopt recovered team lifecycle run',
    )
    expect(lane.stoppedRunIds).toEqual([requiredRunId(persisted)])
    await expect(replacement.inspect(plan)).resolves.toMatchObject({ phase: 'idle', runId: null })
  })

  test('atomically transfers a running tuple so stale generation shutdown cannot stop it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-transfer-fence-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const lane = new FakeLane()
    const oldGeneration = new DurableTeamLifecycleExecution(statePath, [lane])
    const idle = await oldGeneration.inspect(plan)
    await oldGeneration.launch({
      plan, commandId: 'command-old-generation', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    const running = await waitForPhase(oldGeneration, 'running')

    const newGeneration = new DurableTeamLifecycleExecution(statePath, [lane])
    await newGeneration.recoverAtStartup(plan, () => true)
    await expect(newGeneration.inspect(plan)).resolves.toMatchObject({
      phase: 'running', runId: running.runId,
    })
    await expect(oldGeneration.inspect(plan)).rejects.toThrow('another incarnation')
    await oldGeneration.shutdown()
    expect(lane.stoppedRunIds).toEqual([])

    await newGeneration.shutdown()
    expect(lane.stoppedRunIds).toEqual([requiredRunId(running)])
  })

  test('shutdown compensates only the exact owned tuple after admitted plan rotation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-plan-rotation-'))
    roots.push(root)
    const lane = new FakeLane()
    const execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane])
    const idleA = await execution.inspect(plan)
    await execution.launch({
      plan, commandId: 'command-plan-a-launch', runId: null,
      expectedProviderGeneration: idleA.providerGeneration,
    })
    const runningA = await waitForPhase(execution, 'running')
    await execution.stop({
      plan, commandId: 'command-plan-a-stop', runId: runningA.runId,
      expectedProviderGeneration: runningA.providerGeneration,
    })
    await waitForPhase(execution, 'idle')

    const planB = planWithSelectedModel('provider/replacement-model')
    const idleB = await execution.inspect(planB)
    await execution.launch({
      plan: planB, commandId: 'command-plan-b-launch', runId: null,
      expectedProviderGeneration: idleB.providerGeneration,
    })
    const runningB = await waitForPhase(execution, 'running', planB)
    await execution.shutdown()

    expect(lane.stoppedRunIds).toEqual([requiredRunId(runningA), requiredRunId(runningB)])
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
    await expect(replacementOwner.recoverAtStartup(plan, () => true)).rejects.toThrow(
      'Unable to adopt recovered team lifecycle run',
    )
    expect(lane.stoppedRunIds).toEqual([requiredRunId(persisted)])

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
        return running()
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
        return running()
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

  test('rejects recovery cross-binding across every effect-bearing admitted plan field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-plan-binding-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const execution = new DurableTeamLifecycleExecution(statePath, [new FakeLane()])
    const idle = await execution.inspect(plan)
    await execution.launch({
      plan, commandId: 'command-plan-binding', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    await waitForPhase(execution, 'running')

    const changedPlans: TeamLifecycleLaunchPlan[] = [
      { ...plan, workspaceRoot: '/sandbox/other-project' },
      { ...plan, toolApprovalMode: 'auto' },
      planWithSelectedModel('provider/other-default'),
      {
        ...plan,
        lanes: [{
          ...plan.lanes[0]!,
          members: [{ ...plan.lanes[0]!.members[0]!, model: 'provider/member-override' }],
        }],
      },
    ]
    for (const changed of changedPlans) {
      const replacement = new DurableTeamLifecycleExecution(statePath, [new FakeLane()])
      await expect(replacement.recoverAtStartup(changed, () => true)).rejects.toThrow(
        /Active team lifecycle plan changed|durable approval mode changed/,
      )
    }
  })
})

describe('OpenCodeTeamLifecycleLane', () => {
  test('maps admitted launch data and requires positive bridge confirmations', async () => {
    const calls: LifecycleBridgeRequest[] = []
    const execute: ExecuteBridge = async (input: unknown) => {
      const request = bridgeRequest(input)
      calls.push(request)
      const command = request.command
      return bridgeSuccess(input, command === 'opencode.stopTeam'
        ? stopCommandData(bridgeRunId(request))
        : teamCommandData(
            command === 'opencode.launchTeam' ? 'permission_blocked' : 'ready',
            { worker: teamMember('session-worker', command === 'opencode.launchTeam' ? 'permission_blocked' : 'confirmed_alive') },
            bridgeRunId(request),
          ))
    }
    const lane = new OpenCodeTeamLifecycleLane(execute, 10_000, () => true)
    const admittedLane = plan.lanes[0]!
    const input = {
      planTeamId: plan.teamId,
      workspaceRoot: plan.workspaceRoot,
      toolApprovalMode: plan.toolApprovalMode,
      lane: admittedLane,
      runId: 'run_test1234',
    }
    await expect(lane.launch(input)).resolves.toMatchObject({
      phase: 'launching', recoverable: false,
      recoveryBinding: expect.stringMatching(/^session-set_[0-9a-f]{64}$/),
    })
    await expect(lane.inspect(input)).resolves.toMatchObject({
      phase: 'running', recoverable: false,
      recoveryBinding: expect.stringMatching(/^session-set_[0-9a-f]{64}$/),
    })
    await expect(lane.stop(input)).resolves.toEqual({ phase: 'idle', recoverable: false })
    expect(calls.map(call => call.command)).toEqual([
      'opencode.launchTeam', 'opencode.reconcileTeam', 'opencode.stopTeam',
    ])
    expect('members' in calls[0]!.body ? calls[0]!.body.members : undefined).toEqual([
      { name: 'worker', prompt: 'Implement the fixture.', effort: 'high' },
    ])
    expect(calls[0]!.body).toMatchObject({ toolApprovalMode: 'manual', skipPermissions: false })
  })

  test('waits for an in-flight launch before stopping the same lane', async () => {
    let releaseLaunch!: () => void
    const launchGate = new Promise<void>(resolve => { releaseLaunch = resolve })
    const calls: string[] = []
    const execute: ExecuteBridge = async (input: unknown) => {
      const request = bridgeRequest(input)
      const command = request.command
      calls.push(command)
      if (command === 'opencode.launchTeam') await launchGate
      return bridgeSuccess(input, command === 'opencode.stopTeam'
        ? stopCommandData(bridgeRunId(request))
        : teamCommandData('ready', { worker: teamMember('session-worker') }, bridgeRunId(request)))
    }
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
    const [launched, stopped] = await Promise.all([launch, stop])
    expect(launched).toMatchObject({
      phase: 'running', recoverable: false,
      recoveryBinding: expect.stringMatching(/^session-set_[0-9a-f]{64}$/),
    })
    expect(stopped).toEqual({ phase: 'idle', recoverable: false })
    expect(calls).toEqual(['opencode.launchTeam', 'opencode.stopTeam'])
  })

  test('rejects substituted, omitted, and duplicate provider session identities', async () => {
    let teamLaunchState: 'launching' | 'ready' = 'launching'
    let members: TeamCommandData['members'] = {
      worker: teamMember('session-worker', 'created'),
      reviewer: teamMember('session-reviewer', 'created'),
    }
    const execute: ExecuteBridge = async input => {
      const request = bridgeRequest(input)
      return bridgeSuccess(input, teamCommandData(teamLaunchState, members, bridgeRunId(request)))
    }
    const lane = new OpenCodeTeamLifecycleLane(execute, 10_000, () => true)
    const admittedLane = {
      ...plan.lanes[0]!,
      members: [
        ...plan.lanes[0]!.members,
        { name: 'reviewer', prompt: 'Review the fixture.' },
      ],
    }
    const input = {
      planTeamId: plan.teamId, workspaceRoot: plan.workspaceRoot,
      toolApprovalMode: plan.toolApprovalMode, lane: admittedLane, runId: 'run_binding',
    }
    const launched = await lane.launch(input)
    expect(launched.phase).toBe('launching')
    expect(launched.recoveryBinding).toMatch(/^session-set_[0-9a-f]{64}$/)

    members = {
      worker: teamMember('session-substituted'),
      reviewer: teamMember('session-reviewer'),
    }
    await expect(lane.inspect({ ...input, recoveryBinding: launched.recoveryBinding }))
      .rejects.toThrow('does not match the durable launch binding')
    teamLaunchState = 'ready'
    members = { worker: teamMember('session-worker') }
    await expect(lane.inspect(input)).rejects.toThrow('changed the exact admitted member set')
    members = {
      worker: teamMember('session-duplicate'),
      reviewer: teamMember('session-duplicate'),
    }
    await expect(lane.inspect(input)).rejects.toThrow('missing or duplicate session id')
  })

  test('revalidates a queued request inside the lane before provider mutation', async () => {
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    const calls: string[] = []
    const execute: ExecuteBridge = async (input: unknown) => {
      const request = bridgeRequest(input)
      calls.push(request.requestId)
      if (calls.length === 1) {
        markFirstStarted()
        await firstGate
      }
      return bridgeSuccess(input, teamCommandData(
        'ready',
        { worker: teamMember(`session-${calls.length}`) },
        bridgeRunId(request),
      ))
    }
    const lane = new OpenCodeTeamLifecycleLane(execute, 10_000, () => true)
    let current = true
    const first = lane.launch({
      planTeamId: plan.teamId, workspaceRoot: plan.workspaceRoot,
      toolApprovalMode: plan.toolApprovalMode, lane: plan.lanes[0]!, runId: 'run_first',
    })
    await firstStarted
    const queued = lane.launch({
      planTeamId: plan.teamId, workspaceRoot: plan.workspaceRoot,
      toolApprovalMode: plan.toolApprovalMode, lane: plan.lanes[0]!, runId: 'run_queued',
      effectGuard: () => current,
    })
    const queuedOutcome = queued.then(
      () => null,
      error => error,
    )
    current = false
    releaseFirst()
    await expect(first).resolves.toMatchObject({
      phase: 'running', recoverable: false,
      recoveryBinding: expect.stringMatching(/^session-set_[0-9a-f]{64}$/),
    })
    const queuedError = await queuedOutcome
    expect(queuedError).toBeInstanceOf(Error)
    if (!(queuedError instanceof Error)) throw new Error('Fixture expected the queued request to fail')
    expect(queuedError.message).toContain('authority changed before provider effect')
    expect(calls).toHaveLength(1)
  })

  test('revalidates startup recovery inspection after its lane queue waits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-queued-recovery-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    const calls: string[] = []
    let blockNext = false
    const execute: ExecuteBridge = async (input: unknown) => {
      const request = bridgeRequest(input)
      calls.push(request.command)
      if (blockNext) {
        blockNext = false
        markFirstStarted()
        await firstGate
      }
      return bridgeSuccess(input, teamCommandData('ready', { worker: teamMember('session-worker') }, bridgeRunId(request)))
    }
    const lane = new OpenCodeTeamLifecycleLane(execute, 10_000, () => true)
    const crashedOwner = new DurableTeamLifecycleExecution(statePath, [lane])
    const idle = await crashedOwner.inspect(plan)
    await crashedOwner.launch({
      plan, commandId: 'command-before-queued-recovery', runId: null,
      expectedProviderGeneration: idle.providerGeneration,
    })
    await waitForPhase(crashedOwner, 'running')

    blockNext = true
    const first = lane.launch({
      planTeamId: plan.teamId, workspaceRoot: plan.workspaceRoot,
      toolApprovalMode: plan.toolApprovalMode, lane: plan.lanes[0]!, runId: 'run_queue_blocker',
    })
    await firstStarted
    const callsBeforeRecovery = [...calls]
    let current = true
    let guardChecks = 0
    let markInspectQueued!: () => void
    const inspectQueued = new Promise<void>(resolve => { markInspectQueued = resolve })
    const replacement = new DurableTeamLifecycleExecution(statePath, [lane])
    const queuedRecovery = replacement.recoverAtStartup(plan, () => {
      guardChecks += 1
      if (guardChecks === 3) markInspectQueued()
      return current
    })
    await inspectQueued
    current = false
    releaseFirst()
    await expect(first).resolves.toMatchObject({ phase: 'running' })
    await expect(queuedRecovery).rejects.toThrow('Unable to adopt recovered team lifecycle run')
    expect(calls).toEqual(callsBeforeRecovery)
  })

  test('maps an admitted auto plan to explicit automatic wire semantics', async () => {
    let launchBody: object | null = null
    const execute: ExecuteBridge = async (input: unknown) => {
      const request = bridgeRequest(input)
      launchBody = request.body
      return bridgeSuccess(input, teamCommandData('ready', { worker: teamMember('session-worker') }, bridgeRunId(request)))
    }
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

  test('never holds the durable transaction lock across launch, inspect, stop, and terminal adapter callbacks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-reentrant-transactions-'))
    roots.push(root)
    let execution!: DurableTeamLifecycleExecution
    const callbacks: string[] = []
    const lane: TeamLifecycleLaneEffectPort = {
      kind: 'opencode',
      supports: () => true,
      inspect: async () => {
        callbacks.push('inspect')
        await execution.transactions.read(state => state.revision)
        return running()
      },
      launch: async () => {
        callbacks.push('launch')
        await execution.transactions.update(state => ({ state, value: undefined }))
        return running()
      },
      cancel: async () => {
        callbacks.push('cancel')
        await execution.transactions.read(state => state.operationEpoch)
        return { phase: 'idle', recoverable: false }
      },
      stop: async () => {
        callbacks.push('stop')
        await execution.transactions.update(state => ({ state, value: undefined }))
        return { phase: 'idle', recoverable: false }
      },
      recover: async () => {
        callbacks.push('recover')
        await execution.transactions.read(state => state.revision)
        return { phase: 'idle', recoverable: false }
      },
    }
    execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane])
    const idle = await execution.inspect(plan)
    const launched = await execution.launch({ plan, commandId: 'reentrant-launch', runId: null,
      expectedProviderGeneration: idle.providerGeneration })
    const ready = await waitForPhase(execution, 'running')
    expect(ready.runId).toBe(launched.runId)
    const stopping = await execution.stop({ plan, commandId: 'reentrant-stop', runId: ready.runId,
      expectedProviderGeneration: ready.providerGeneration })
    expect(stopping.phase).toBe('stopping')
    await expect(waitForPhase(execution, 'idle')).resolves.toMatchObject({ runId: null })
    expect(callbacks).toEqual(['launch', 'inspect', 'stop'])
  })

  test('allows same-file transaction reentry during startup recovery and shutdown teardown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-reentrant-recovery-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const firstLane = new FakeLane()
    const first = new DurableTeamLifecycleExecution(statePath, [firstLane])
    const idle = await first.inspect(plan)
    await first.launch({ plan, commandId: 'startup-fixture', runId: null, expectedProviderGeneration: idle.providerGeneration })
    await waitForPhase(first, 'running')

    let replacement!: DurableTeamLifecycleExecution
    const callbacks: string[] = []
    const reentrantLane: TeamLifecycleLaneEffectPort = {
      kind: 'opencode', supports: () => true,
      inspect: async () => {
        callbacks.push('startup-inspect')
        await replacement.transactions.update(state => ({ state, value: undefined }))
        return running()
      },
      stop: async () => {
        callbacks.push('shutdown-stop')
        await replacement.transactions.read(state => state.revision)
        return { phase: 'idle', recoverable: false }
      },
      launch: async () => ({ phase: 'failed', recoverable: true }),
      cancel: async () => ({ phase: 'idle', recoverable: false }),
      recover: async () => ({ phase: 'idle', recoverable: false }),
    }
    replacement = new DurableTeamLifecycleExecution(statePath, [reentrantLane])
    await replacement.recoverAtStartup(plan, () => true)
    await replacement.shutdown()
    expect(callbacks).toEqual(['startup-inspect', 'shutdown-stop'])
    const state = await replacement.transactions.read(value => value)
    expect(state).toMatchObject({ phase: 'idle', runId: null })
  })

  test('fences late launch publication after a newer same-file operation epoch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-late-publication-'))
    roots.push(root)
    let execution!: DurableTeamLifecycleExecution
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const actions: string[] = []
    const lane: TeamLifecycleLaneEffectPort = {
      kind: 'opencode', supports: () => true,
      launch: async () => { actions.push('launch'); entered(); await gate; return running() },
      stop: async () => { actions.push('stale-stop'); await execution.transactions.read(state => state.revision); return { phase: 'idle', recoverable: false } },
      inspect: async () => ({ phase: 'launching', recoverable: false }),
      cancel: async () => ({ phase: 'idle', recoverable: false }),
      recover: async () => ({ phase: 'idle', recoverable: false }),
    }
    execution = new DurableTeamLifecycleExecution(join(root, 'state.json'), [lane])
    const idle = await execution.inspect(plan)
    await execution.launch({ plan, commandId: 'late-launch', runId: null, expectedProviderGeneration: idle.providerGeneration })
    await started
    await execution.transactions.update(state => ({ state: { ...state, operationEpoch: state.operationEpoch + 1 }, value: undefined }))
    release()
    await execution.close()
    expect(actions).toEqual(['launch', 'stale-stop'])
    expect(await execution.transactions.read(state => state.phase)).toBe('launching')
  })

  test('fails closed without inspect/adopt/stop when a replacement sees a native controller run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-owner-native-nonadoption-'))
    roots.push(root)
    const statePath = join(root, 'state.json')
    const nativePlan: TeamLifecycleLaunchPlan = { ...plan, lanes: [{ ...plan.lanes[0]!, laneId: 'native-lane', kind: 'native', provider: 'codex' }] }
    const calls: string[] = []
    const nativeLane: TeamLifecycleLaneEffectPort = {
      kind: 'native', supports: () => true,
      launch: async () => { calls.push('launch'); return running() },
      inspect: async () => { calls.push('inspect'); return running() },
      stop: async () => { calls.push('stop'); return { phase: 'idle', recoverable: false } },
      cancel: async () => ({ phase: 'idle', recoverable: false }), recover: async () => ({ phase: 'idle', recoverable: false }),
    }
    const first = new DurableTeamLifecycleExecution(statePath, [nativeLane])
    const idle = await first.inspect(nativePlan)
    await first.launch({ plan: nativePlan, commandId: 'native-fixture', runId: null, expectedProviderGeneration: idle.providerGeneration })
    await waitForPhase(first, 'running', nativePlan)
    calls.length = 0
    const replacement = new DurableTeamLifecycleExecution(statePath, [nativeLane])
    await expect(replacement.recoverAtStartup(nativePlan, () => true)).rejects.toThrow('cannot be adopted')
    expect(calls).toEqual([])
    expect(await replacement.transactions.read(state => state)).toMatchObject({ phase: 'failed', recoverable: false,
      disposition: { kind: 'native-controller-replacement-required' } })
  })
})

async function waitForPhase(
  execution: DurableTeamLifecycleExecution,
  phase: 'idle' | 'running' | 'failed',
  admittedPlan: TeamLifecycleLaunchPlan = plan,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await execution.inspect(admittedPlan)
    if (state.phase === phase) return state
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${phase}`)
}
