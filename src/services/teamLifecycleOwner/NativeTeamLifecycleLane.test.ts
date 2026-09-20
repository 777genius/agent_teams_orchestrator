import { describe, expect, test } from 'bun:test'
import { NativeTeamLifecycleLane, type NativeLaneRequest } from './NativeTeamLifecycleLane.js'
import type { TeamLifecycleLaunchPlanV3 } from './TeamLifecycleLaunchPlan.js'

const plan: TeamLifecycleLaunchPlanV3 = { schemaVersion: 3, workspaceId: 'workspace_test', teamId: 'team_test', workspaceRoot: '/tmp/native-lane-test', toolApprovalMode: 'auto', runtimePlanRef: { teamId: 'team_test', runId: 'run_runtime', generation: 1, planHash: `sha256:${'a'.repeat(64)}` }, primaryOrdinal: 1, lanes: [{ laneId: 'lane_test', kind: 'native', provider: 'anthropic', members: [{ name: 'a', prompt: 'x', ordinal: 1, agentId: 'agent_a' }] }] }
const base = (action: NativeLaneRequest['action'] = 'launch'): NativeLaneRequest => ({ action, plan, planTeamId: plan.teamId, lane: plan.lanes[0] as Extract<typeof plan.lanes[number], { kind: 'native' }>, runId: 'run_owner', workspaceRoot: plan.workspaceRoot })
const identities = (request: NativeLaneRequest) => ({ planTeamId: request.planTeamId, laneId: request.lane.laneId, runId: request.runId, runtimePlanRunId: request.plan.runtimePlanRef.runId })

describe('NativeTeamLifecycleLane', () => {
  test('preserves identities and normalizes a fake native result', async () => {
    let seen!: NativeLaneRequest
    const lane = new NativeTeamLifecycleLane({ execute: async request => { seen = request; return { state: 'ready', planTeamId: 'team_test', laneId: 'lane_test', runtimePlanRunId: 'run_runtime', runId: 'run_owner' } } })
    await expect(lane.launch(base())).resolves.toEqual({ phase: 'running', recoverable: false })
    expect(seen.runId).toBe('run_owner'); expect(seen.plan.runtimePlanRef.runId).toBe('run_runtime'); expect(seen.lane.members[0]?.agentId).toBe('agent_a')
  })
  test('serializes mutations and fails closed on guard/abort or malformed results', async () => {
    let active = 0; let max = 0
    const lane = new NativeTeamLifecycleLane({ execute: async request => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return { phase: 'idle', ...identities(request) } } })
    await Promise.all([lane.stop(base('stop')), lane.cancel(base('cancel'))]); expect(max).toBe(1)
    await expect(lane.launch({ ...base(), signal: AbortSignal.abort() })).rejects.toThrow('aborted')
    await expect(lane.launch({ ...base(), effectGuard: () => false })).rejects.toThrow('revoked')
    const malformed = new NativeTeamLifecycleLane({ execute: async request => ({ phase: 'wat', ...identities(request) }) })
    await expect(malformed.launch(base())).rejects.toThrow('valid phase')
  })

  test('rejects missing response identities before accepting a phase', async () => {
    for (const field of ['planTeamId', 'laneId', 'runId', 'runtimePlanRunId'] as const) {
      const lane = new NativeTeamLifecycleLane({ execute: async request => {
        const result: Record<string, unknown> = { phase: 'running', ...identities(request) }
        delete result[field]
        return result
      } })
      await expect(lane.launch(base())).rejects.toThrow('missing or mismatched')
    }
  })

  test('rejects mismatched response identities before accepting a phase', async () => {
    for (const [field, value] of [
      ['planTeamId', 'team_other'], ['laneId', 'lane_other'],
      ['runId', 'run_other'], ['runtimePlanRunId', 'run_runtime_other'],
    ] as const) {
      const lane = new NativeTeamLifecycleLane({ execute: async request => ({ phase: 'running', ...identities(request), [field]: value }) })
      await expect(lane.launch(base())).rejects.toThrow('missing or mismatched')
    }
  })

  test('binds a null owner identity for idle inspection', async () => {
    const request = { ...base('inspect'), runId: null }
    const lane = new NativeTeamLifecycleLane({ execute: async input => ({ phase: 'idle', ...identities(input) }) })
    await expect(lane.inspect(request)).resolves.toEqual({ phase: 'idle', recoverable: false })
  })
})
