import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { HostedLifecycleProviderSnapshot } from '../hostedControl/HostedLifecycleSnapshot.js'
import type { HostedLifecycleAction } from '../hostedControl/HostedLifecycleSnapshot.js'
import {
  PrivateFileTeamLifecycleLaunchPlanStore,
  parseTeamLifecycleLaunchPlan,
  type TeamLifecycleLaunchPlan,
  type TeamLifecycleLaunchPlanStore,
} from './TeamLifecycleLaunchPlan.js'
import {
  TeamLifecycleOwnerService,
  type TeamLifecycleExecutionPort,
  type TeamLifecycleOwnerEffectInput,
} from './TeamLifecycleOwnerService.js'

const scope = { workspaceId: 'workspace_test', teamId: 'team_test' }
const plan: TeamLifecycleLaunchPlan = {
  schemaVersion: 2,
  ...scope,
  workspaceRoot: '/tmp/hosted-workspace',
  toolApprovalMode: 'manual',
  lanes: [
    { laneId: 'anthropic_lane', kind: 'native', provider: 'anthropic', members: [{ name: 'a', prompt: 'A' }] },
    { laneId: 'codex_lane', kind: 'native', provider: 'codex', members: [{ name: 'c', prompt: 'C' }] },
    { laneId: 'gemini_lane', kind: 'native', provider: 'gemini', members: [{ name: 'g', prompt: 'G' }] },
    {
      laneId: 'opencode_lane', kind: 'opencode', provider: 'opencode', selectedModel: 'provider/model',
      members: [{ name: 'o', prompt: 'O' }],
    },
  ],
}

class MemoryPlanStore implements TeamLifecycleLaunchPlanStore {
  constructor(private readonly value: TeamLifecycleLaunchPlan | null = plan) {}
  async load(input: typeof scope) {
    return input.workspaceId === scope.workspaceId && input.teamId === scope.teamId && this.value
      ? { plan: this.value, planGeneration: `plan-generation_${'a'.repeat(64)}`, isCurrent: async () => true }
      : null
  }
}

class FakeExecution implements TeamLifecycleExecutionPort {
  calls: Array<{ action: string; expected: string; providers: string[] }> = []
  concurrent = 0
  maxConcurrent = 0
  state: HostedLifecycleProviderSnapshot = snapshot('generation_1', 'idle', null)
  confirm = true
  supported = new Set<HostedLifecycleAction>(['launch', 'cancel', 'stop', 'recover'])
  recoverResult: HostedLifecycleProviderSnapshot | null = null

  supports(_plan: TeamLifecycleLaunchPlan, action: HostedLifecycleAction): boolean { return this.supported.has(action) }
  async inspect(): Promise<HostedLifecycleProviderSnapshot> { return this.state }
  async launch(input: TeamLifecycleOwnerEffectInput): Promise<HostedLifecycleProviderSnapshot> {
    return this.apply('launch', input, snapshot('generation_2', 'running', 'run_created'))
  }
  async cancel(input: TeamLifecycleOwnerEffectInput): Promise<HostedLifecycleProviderSnapshot> {
    return this.apply('cancel', input, snapshot('generation_cancel', 'idle', null))
  }
  async stop(input: TeamLifecycleOwnerEffectInput): Promise<HostedLifecycleProviderSnapshot> {
    return this.apply('stop', input, snapshot('generation_stop', 'idle', null))
  }
  async recover(input: TeamLifecycleOwnerEffectInput): Promise<HostedLifecycleProviderSnapshot> {
    return this.apply('recover', input,
      this.recoverResult ?? snapshot('generation_recover', 'running', input.runId ?? 'run_recovered'))
  }
  private async apply(action: string, input: TeamLifecycleOwnerEffectInput, next: HostedLifecycleProviderSnapshot) {
    this.concurrent += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent)
    await Promise.resolve()
    this.calls.push({ action, expected: input.expectedProviderGeneration, providers: input.plan.lanes.map(lane => lane.provider) })
    this.concurrent -= 1
    if (this.confirm) this.state = next
    return next
  }
}

describe('TeamLifecycleOwnerService', () => {
  test('owns a strict private plan covering Anthropic, Codex, Gemini and OpenCode through one composite port', async () => {
    const execution = new FakeExecution()
    const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(), execution })
    const inspection = await service.inspect(scope)
    expect(inspection.kind).toBe('owned')
    if (inspection.kind !== 'owned') throw new Error('expected owner')
    expect(inspection.snapshot).toEqual({
      ...execution.state,
      providerGeneration: expect.stringMatching(/^generation_[0-9a-f]{64}$/),
    })
    const applied = await service.execute({
      scope, action: 'launch', commandId: 'command_1', runId: null,
      expectedProviderGeneration: inspection.snapshot.providerGeneration,
    })
    expect(applied.kind).toBe('applied')
    if (applied.kind !== 'applied') throw new Error('expected applied effect')
    expect(applied.snapshot).toEqual({
      ...snapshot('generation_2', 'running', 'run_created'),
      providerGeneration: expect.stringMatching(/^generation_[0-9a-f]{64}$/),
    })
    expect(execution.calls).toEqual([{
      action: 'launch', expected: 'generation_1',
      providers: ['anthropic', 'codex', 'gemini', 'opencode'],
    }])
  })

  test('serializes effects per team and rechecks the generation before the second command', async () => {
    const execution = new FakeExecution()
    execution.state = snapshot('generation_1', 'running', 'run_one')
    const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(), execution })
    const inspected = await service.inspect(scope)
    if (inspected.kind !== 'owned') throw new Error('expected owner')
    const [first, second] = await Promise.all([
      service.execute({ scope, action: 'stop', commandId: 'command_1', runId: 'run_one', expectedProviderGeneration: inspected.snapshot.providerGeneration }),
      service.execute({ scope, action: 'stop', commandId: 'command_2', runId: 'run_one', expectedProviderGeneration: inspected.snapshot.providerGeneration }),
    ])
    expect(first.kind).toBe('applied')
    expect(second).toEqual({ kind: 'unavailable' })
    expect(execution.maxConcurrent).toBe(1)
    expect(execution.calls).toHaveLength(1)
  })

  test('passes the live plan admission guard through to the deferred effect boundary', async () => {
    let checks = 0; let crossedEffectBoundary = false
    const store: TeamLifecycleLaunchPlanStore = {
      load: async () => ({
        plan, planGeneration: `plan-generation_${'a'.repeat(64)}`,
        isCurrent: async () => ++checks < 3,
      }),
    }
    const execution = new FakeExecution()
    const originalLaunch = execution.launch.bind(execution)
    execution.launch = async input => {
      crossedEffectBoundary = await input.effectGuard?.() ?? true
      if (!crossedEffectBoundary) throw new Error('admission revoked')
      return originalLaunch(input)
    }
    const service = new TeamLifecycleOwnerService({ planStore: store, execution })
    const inspected = await service.inspect(scope)
    if (inspected.kind !== 'owned') throw new Error('expected owner')
    checks = 0
    const result = await service.execute({
      scope, action: 'launch', commandId: 'command_revoked_effect', runId: null,
      expectedProviderGeneration: inspected.snapshot.providerGeneration,
    })
    expect(result).toEqual({ kind: 'unavailable' })
    expect(crossedEffectBoundary).toBe(false)
    expect(execution.calls).toEqual([])
  })

  test('fails closed when the owner does not confirm the post-effect snapshot', async () => {
    const execution = new FakeExecution()
    execution.confirm = false
    const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(), execution })
    const inspected = await service.inspect(scope)
    if (inspected.kind !== 'owned') throw new Error('expected owner')
    expect(await service.execute({ scope, action: 'launch', commandId: 'command_1', runId: null, expectedProviderGeneration: inspected.snapshot.providerGeneration }))
      .toEqual({ kind: 'unavailable' })
  })

  test('accepts the same launched run when an asynchronous owner advances launching to running before confirmation', async () => {
    let state = snapshot('generation_1', 'idle', null)
    const execution: TeamLifecycleExecutionPort = {
      supports: () => true,
      inspect: async () => state,
      launch: async () => {
        const launching = snapshot('generation_2', 'launching', 'run_async')
        state = snapshot('generation_3', 'running', 'run_async')
        return launching
      },
      cancel: async () => { throw new Error('unexpected cancel') },
      stop: async () => { throw new Error('unexpected stop') },
      recover: async () => { throw new Error('unexpected recover') },
    }
    const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(), execution })
    const inspected = await service.inspect(scope)
    if (inspected.kind !== 'owned') throw new Error('expected owner')
    const result = await service.execute({
      scope, action: 'launch', commandId: 'command_async', runId: null,
      expectedProviderGeneration: inspected.snapshot.providerGeneration,
    })
    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') throw new Error('expected applied effect')
    expect(result.snapshot).toMatchObject({ phase: 'running', runId: 'run_async' })
  })

  test('accepts the same launched run when it fails recoverably before confirmation', async () => {
    let state = snapshot('generation_1', 'idle', null)
    const execution: TeamLifecycleExecutionPort = {
      supports: () => true,
      inspect: async () => state,
      launch: async () => {
        const launching = snapshot('generation_2', 'launching', 'run_failed_launch')
        state = snapshot('generation_3', 'failed', 'run_failed_launch')
        return launching
      },
      cancel: async () => { throw new Error('unexpected cancel') },
      stop: async () => { throw new Error('unexpected stop') },
      recover: async () => { throw new Error('unexpected recover') },
    }
    const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(), execution })
    const inspected = await service.inspect(scope)
    if (inspected.kind !== 'owned') throw new Error('expected owner')
    const result = await service.execute({
      scope, action: 'launch', commandId: 'command_failed_launch', runId: null,
      expectedProviderGeneration: inspected.snapshot.providerGeneration,
    })
    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') throw new Error('expected applied effect')
    expect(result.snapshot).toMatchObject({ phase: 'failed', recoverable: true, runId: 'run_failed_launch' })
  })

  test('accepts the same stopping run when it fails recoverably before confirmation', async () => {
    let state = snapshot('generation_1', 'running', 'run_failed_stop')
    const execution: TeamLifecycleExecutionPort = {
      supports: () => true,
      inspect: async () => state,
      launch: async () => { throw new Error('unexpected launch') },
      cancel: async () => { throw new Error('unexpected cancel') },
      stop: async () => {
        const stopping = snapshot('generation_2', 'stopping', 'run_failed_stop')
        state = snapshot('generation_3', 'failed', 'run_failed_stop')
        return stopping
      },
      recover: async () => { throw new Error('unexpected recover') },
    }
    const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(), execution })
    const inspected = await service.inspect(scope)
    if (inspected.kind !== 'owned') throw new Error('expected owner')
    const result = await service.execute({
      scope, action: 'stop', commandId: 'command_failed_stop', runId: 'run_failed_stop',
      expectedProviderGeneration: inspected.snapshot.providerGeneration,
    })
    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') throw new Error('expected applied effect')
    expect(result.snapshot).toMatchObject({ phase: 'failed', recoverable: true, runId: 'run_failed_stop' })
  })

  test('rejects a substituted run in recoverable failed launch and stop confirmations', async () => {
    for (const action of ['launch', 'stop'] as const) {
      const expectedRunId = action === 'launch' ? 'run_expected_launch' : 'run_expected_stop'
      let state = action === 'launch'
        ? snapshot('generation_1', 'idle', null)
        : snapshot('generation_1', 'running', expectedRunId)
      const execution: TeamLifecycleExecutionPort = {
        supports: () => true,
        inspect: async () => state,
        launch: async () => {
          const launching = snapshot('generation_2', 'launching', expectedRunId)
          state = snapshot('generation_3', 'failed', 'run_substituted')
          return launching
        },
        cancel: async () => { throw new Error('unexpected cancel') },
        stop: async () => {
          const stopping = snapshot('generation_2', 'stopping', expectedRunId)
          state = snapshot('generation_3', 'failed', 'run_substituted')
          return stopping
        },
        recover: async () => { throw new Error('unexpected recover') },
      }
      const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(), execution })
      const inspected = await service.inspect(scope)
      if (inspected.kind !== 'owned') throw new Error('expected owner')
      expect(await service.execute({
        scope,
        action,
        commandId: `command_substituted_${action}`,
        runId: action === 'launch' ? null : expectedRunId,
        expectedProviderGeneration: inspected.snapshot.providerGeneration,
      })).toEqual({ kind: 'unavailable' })
    }
  })

  test('rejects recoverable failed launch and stop confirmations without a new generation', async () => {
    for (const action of ['launch', 'stop'] as const) {
      const runId = `run_same_generation_${action}`
      let state = action === 'launch'
        ? snapshot('generation_1', 'idle', null)
        : snapshot('generation_1', 'running', runId)
      const transition = async () => {
        const pending = snapshot('generation_2', action === 'launch' ? 'launching' : 'stopping', runId)
        state = snapshot('generation_2', 'failed', runId)
        return pending
      }
      const execution: TeamLifecycleExecutionPort = {
        supports: () => true,
        inspect: async () => state,
        launch: action === 'launch' ? transition : async () => { throw new Error('unexpected launch') },
        cancel: async () => { throw new Error('unexpected cancel') },
        stop: action === 'stop' ? transition : async () => { throw new Error('unexpected stop') },
        recover: async () => { throw new Error('unexpected recover') },
      }
      const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(), execution })
      const inspected = await service.inspect(scope)
      if (inspected.kind !== 'owned') throw new Error('expected owner')
      expect(await service.execute({
        scope,
        action,
        commandId: `command_same_generation_${action}`,
        runId: action === 'launch' ? null : runId,
        expectedProviderGeneration: inspected.snapshot.providerGeneration,
      })).toEqual({ kind: 'unavailable' })
    }
  })

  test('rejects an unrelated running substitution during asynchronous launch confirmation', async () => {
    let state = snapshot('generation_1', 'idle', null)
    const execution: TeamLifecycleExecutionPort = {
      supports: () => true,
      inspect: async () => state,
      launch: async () => {
        const launching = snapshot('generation_2', 'launching', 'run_expected')
        state = snapshot('generation_3', 'running', 'run_substituted')
        return launching
      },
      cancel: async () => { throw new Error('unexpected cancel') },
      stop: async () => { throw new Error('unexpected stop') },
      recover: async () => { throw new Error('unexpected recover') },
    }
    const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(), execution })
    const inspected = await service.inspect(scope)
    if (inspected.kind !== 'owned') throw new Error('expected owner')
    expect(await service.execute({
      scope, action: 'launch', commandId: 'command_async', runId: null,
      expectedProviderGeneration: inspected.snapshot.providerGeneration,
    })).toEqual({ kind: 'unavailable' })
  })

  test('does not advertise or execute a phase action absent from the installed owner port', async () => {
    const execution = new FakeExecution()
    execution.supported.delete('launch')
    const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(), execution })
    expect(await service.inspect(scope)).toEqual({ kind: 'unavailable' })
    expect(await service.execute({ scope, action: 'launch', commandId: 'command_1', runId: null, expectedProviderGeneration: 'generation_stale' }))
      .toEqual({ kind: 'unavailable' })
    expect(execution.calls).toEqual([])
  })

  test('does not advertise launch when cancel or stop successor capability is absent', async () => {
    const execution = new FakeExecution()
    execution.supported = new Set(['launch', 'recover'])
    const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(), execution })
    expect(await service.inspect(scope)).toEqual({ kind: 'unavailable' })
    expect(await service.execute({ scope, action: 'launch', commandId: 'command_1', runId: null, expectedProviderGeneration: 'generation_stale' }))
      .toEqual({ kind: 'unavailable' })
    expect(execution.calls).toEqual([])
  })

  test('rejects actionable snapshots and recover postimages that omit the required run id', async () => {
    const execution = new FakeExecution()
    execution.state = snapshot('generation_failed', 'failed', 'run_failed')
    execution.recoverResult = snapshot('generation_bad-recover', 'launching', null)
    const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(), execution })
    const inspected = await service.inspect(scope)
    if (inspected.kind !== 'owned') throw new Error('expected recoverable owner')
    expect(await service.execute({
      scope, action: 'recover', commandId: 'command_recover', runId: 'run_failed',
      expectedProviderGeneration: inspected.snapshot.providerGeneration,
    })).toEqual({ kind: 'unavailable' })

    execution.state = snapshot('generation_bad-inspection', 'launching', null)
    expect(await service.inspect(scope)).toEqual({ kind: 'unavailable' })
  })

  test('returns not-owned without consulting runtime for an unadmitted scope', async () => {
    const execution = new FakeExecution()
    const service = new TeamLifecycleOwnerService({ planStore: new MemoryPlanStore(null), execution })
    expect(await service.inspect(scope)).toEqual({ kind: 'not_owned' })
    expect(await service.execute({ scope, action: 'launch', commandId: 'command_1', runId: null, expectedProviderGeneration: 'generation_stale' }))
      .toEqual({ kind: 'not_found' })
    expect(execution.calls).toEqual([])
  })
})

describe('TeamLifecycleLaunchPlan', () => {
  test('rejects unknown fields, provider/kind mismatches and duplicate lanes', () => {
    expect(() => parseTeamLifecycleLaunchPlan({ ...plan, browserSelectedProvider: 'anthropic' })).toThrow('Unexpected')
    expect(() => parseTeamLifecycleLaunchPlan({ ...plan, lanes: [{ laneId: 'lane_a', kind: 'native', provider: 'opencode' }] }))
      .toThrow('Unsupported provider')
    expect(() => parseTeamLifecycleLaunchPlan({ ...plan, lanes: [plan.lanes[0], plan.lanes[0]] })).toThrow('Duplicate')
  })

  test('loads only an owner-private regular snapshot and scope-matches it', async () => {
    const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-lifecycle-plan-'))
    const dir = await fs.realpath(temporaryDir)
    const file = path.join(dir, 'plan.json')
    try {
      await fs.writeFile(file, JSON.stringify(plan), { mode: 0o600 })
      const store = new PrivateFileTeamLifecycleLaunchPlanStore(file)
      const admitted = await store.load(scope)
      expect(admitted?.plan).toEqual(plan)
      expect(admitted?.planGeneration).toMatch(/^plan-generation_[0-9a-f]{64}$/)
      expect(await admitted?.isCurrent()).toBe(true)
      expect(await store.load({ ...scope, teamId: 'team_other' })).toBeNull()
      const replacement = path.join(dir, 'replacement.json')
      await fs.writeFile(replacement, JSON.stringify({
        ...plan,
        lanes: [{
          laneId: 'replacement_lane', kind: 'native', provider: 'anthropic',
          members: [{ name: 'worker', prompt: 'Work on the admitted task.' }],
        }],
      }), { mode: 0o600 })
      await fs.rename(replacement, file)
      expect(await admitted?.isCurrent()).toBe(false)
      await fs.chmod(file, 0o400)
      expect(store.load(scope)).rejects.toThrow('canonical private regular file')
      await fs.chmod(file, 0o700)
      expect(store.load(scope)).rejects.toThrow('canonical private regular file')
      await fs.chmod(file, 0o644)
      expect(store.load(scope)).rejects.toThrow('canonical private regular file')
    } finally {
      await fs.rm(temporaryDir, { recursive: true, force: true })
    }
  })

  test('rejects relative and symlinked admission snapshots', async () => {
    expect(() => new PrivateFileTeamLifecycleLaunchPlanStore('plan.json')).toThrow('path must be absolute')
    const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-lifecycle-plan-link-'))
    const dir = await fs.realpath(temporaryDir)
    const file = path.join(dir, 'plan.json')
    const link = path.join(dir, 'plan-link.json')
    try {
      await fs.writeFile(file, JSON.stringify(plan), { mode: 0o600 })
      await fs.symlink(file, link)
      expect(new PrivateFileTeamLifecycleLaunchPlanStore(link).load(scope)).rejects.toThrow()
    } finally {
      await fs.rm(temporaryDir, { recursive: true, force: true })
    }
  })
})

function snapshot(
  providerGeneration: string,
  phase: HostedLifecycleProviderSnapshot['phase'],
  runId: string | null,
): HostedLifecycleProviderSnapshot {
  return { providerId: 'team-lifecycle-owner', providerGeneration, phase, runId, recoverable: phase === 'failed' }
}
