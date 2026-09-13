import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  parseTeamLifecycleLaunchPlan,
  PrivateFileTeamLifecycleLaunchPlanStore,
  type TeamLifecycleLaunchPlanV2,
  type TeamLifecycleLaunchPlanV3,
} from './TeamLifecycleLaunchPlan.js'

const scope = { workspaceId: 'workspace_test', teamId: 'team_test' }
const plan: TeamLifecycleLaunchPlanV2 = {
  schemaVersion: 2,
  ...scope,
  workspaceRoot: '/tmp/hosted-workspace',
  toolApprovalMode: 'manual',
  lanes: [{
    laneId: 'lane_test',
    kind: 'native',
    provider: 'codex',
    members: [{ name: 'worker', prompt: 'Do the admitted work.' }],
  }],
}

describe('PrivateFileTeamLifecycleLaunchPlanStore raw-byte admission', () => {
  test('binds the generation and replacement fence to the exact admitted bytes', async () => {
    await withPrivatePlan(async file => {
      const admittedBytes = Buffer.from(JSON.stringify(plan, null, 2), 'utf8')
      await fs.writeFile(file, admittedBytes, { mode: 0o600 })
      const admitted = await new PrivateFileTeamLifecycleLaunchPlanStore(file).load(scope)
      expect(admitted?.plan).toEqual(plan)
      expect(admitted?.planGeneration).toBe(
        `plan-generation_${createHash('sha256').update(admittedBytes).digest('hex')}`,
      )
      expect(await admitted?.isCurrent()).toBe(true)

      await fs.writeFile(file, Buffer.from(`${JSON.stringify(plan)}\n`, 'utf8'), { mode: 0o600 })
      expect(await admitted?.isCurrent()).toBe(false)
    })
  })

  test('rejects invalid UTF-8 instead of admitting replacement-decoded JSON', async () => {
    await withPrivatePlan(async file => {
      const valid = Buffer.from(JSON.stringify(plan), 'utf8')
      const prompt = valid.indexOf(Buffer.from('Do the admitted work.'))
      expect(prompt).toBeGreaterThanOrEqual(0)
      const invalid = Buffer.concat([
        valid.subarray(0, prompt),
        Buffer.from([0xc0, 0xaf]),
        valid.subarray(prompt + 2),
      ])
      expect(() => JSON.parse(invalid.toString('utf8'))).not.toThrow()
      await fs.writeFile(file, invalid, { mode: 0o600 })
      await expect(new PrivateFileTeamLifecycleLaunchPlanStore(file).load(scope)).rejects.toThrow()
    })
  })

  test('fails closed for legacy or missing approval mode instead of silently enabling auto approval', async () => {
    await withPrivatePlan(async file => {
      const { toolApprovalMode: _mode, ...missingMode } = plan
      await fs.writeFile(file, JSON.stringify(missingMode), { mode: 0o600 })
      await expect(new PrivateFileTeamLifecycleLaunchPlanStore(file).load(scope)).rejects.toThrow()

      await fs.writeFile(file, JSON.stringify({ ...missingMode, schemaVersion: 1 }), { mode: 0o600 })
      await expect(new PrivateFileTeamLifecycleLaunchPlanStore(file).load(scope)).rejects.toThrow(
        'Unexpected launch plan fields',
      )
    })
  })

  test('round-trips a readable schema 3 private file without changing byte-generation semantics', async () => {
    await withPrivatePlan(async file => {
      const bytes = Buffer.from(`${JSON.stringify(schema3Plan, null, 2)}\n`, 'utf8')
      await fs.writeFile(file, bytes, { mode: 0o600 })
      const admitted = await new PrivateFileTeamLifecycleLaunchPlanStore(file).load(schema3Scope)
      expect(admitted?.plan).toEqual(schema3Plan)
      expect(admitted?.plan.schemaVersion).toBe(3)
      expect(admitted?.plan.toolApprovalMode).toBe('manual')
      expect(admitted?.planGeneration).toBe(`plan-generation_${createHash('sha256').update(bytes).digest('hex')}`)
      expect(await admitted?.isCurrent()).toBe(true)
    })
  })
})

const teamId = `team_${'1'.repeat(32)}`
const runId = `run_${'2'.repeat(32)}`
const memberId = (digit: string): string => `member_${digit.repeat(32)}`
const schema3Scope = { workspaceId: 'workspace_test', teamId }
const schema3Plan = {
  schemaVersion: 3,
  ...schema3Scope,
  workspaceRoot: '/tmp/hosted-workspace',
  toolApprovalMode: 'manual',
  runtimePlanRef: { teamId, runId, generation: 7, planHash: `sha256:${'a'.repeat(64)}` },
  primaryOrdinal: 6,
  lanes: [
    { laneId: 'lane_anthropic_a', kind: 'native', provider: 'anthropic', members: [
      { name: 'alpha', prompt: 'Alpha.', model: 'claude', ordinal: 0, agentId: memberId('0') },
      { name: 'echo', prompt: 'Echo.', ordinal: 4, agentId: memberId('4') },
    ] },
    { laneId: 'lane_opencode', kind: 'opencode', provider: 'opencode', selectedModel: 'openai/gpt-5', effort: 'high', members: [
      { name: 'bravo', prompt: 'Bravo.', ordinal: 1, agentId: memberId('1') },
      { name: 'foxtrot', prompt: 'Foxtrot.', ordinal: 5, agentId: memberId('5') },
    ] },
    { laneId: 'lane_codex', kind: 'native', provider: 'codex', members: [
      { name: 'charlie', prompt: 'Charlie.', ordinal: 2, agentId: memberId('2') },
    ] },
    { laneId: 'lane_gemini', kind: 'native', provider: 'gemini', members: [
      { name: 'delta', prompt: 'Delta.', ordinal: 3, agentId: memberId('3') },
    ] },
    { laneId: 'lane_anthropic_b', kind: 'native', provider: 'anthropic', members: [
      { name: 'golf', prompt: 'Golf.', ordinal: 6, agentId: memberId('6') },
    ] },
  ],
} as const

describe('TeamLifecycleLaunchPlan schema 3 parser', () => {
  test('preserves interleaved lanes, repeated providers, all providers, and an explicit later primary', () => {
    const parsed = parseTeamLifecycleLaunchPlan(schema3Plan)
    expect(parsed).toEqual(schema3Plan)
    expect(parsed.schemaVersion).toBe(3)
    if (parsed.schemaVersion !== 3) throw new Error('Expected schema 3')
    expect(parsed.lanes.map(lane => lane.provider)).toEqual(['anthropic', 'opencode', 'codex', 'gemini', 'anthropic'])
    expect(parsed.lanes.flatMap(lane => lane.members.map(member => member.ordinal))).toEqual([0, 4, 1, 5, 2, 3, 6])
    expect(parsed.primaryOrdinal).toBe(6)

    const openCodePrimary = parseTeamLifecycleLaunchPlan({ ...schema3Plan, primaryOrdinal: 5 })
    expect(openCodePrimary.schemaVersion === 3 && openCodePrimary.primaryOrdinal).toBe(5)
  })

  test('requires canonical Product identities', () => {
    const cases = [
      { ...schema3Plan, teamId: 'team_test' },
      { ...schema3Plan, runtimePlanRef: { ...schema3Plan.runtimePlanRef, teamId: `team_${'A'.repeat(32)}` } },
      { ...schema3Plan, runtimePlanRef: { ...schema3Plan.runtimePlanRef, runId: 'run_test' } },
      replaceMember(schema3Plan, 0, { agentId: `member_${'A'.repeat(32)}` }),
      replaceMember(schema3Plan, 0, { agentId: `agent_${'0'.repeat(32)}` }),
    ]
    for (const candidate of cases) expect(() => parseTeamLifecycleLaunchPlan(candidate)).toThrow()
  })

  test('rejects duplicate, gapped, fractional, string, and decreasing ordinals', () => {
    const cases = [
      replaceMember(schema3Plan, 1, { ordinal: 0 }),
      replaceMember(schema3Plan, 6, { ordinal: 8 }),
      replaceMember(schema3Plan, 2, { ordinal: 2.5 }),
      replaceMember(schema3Plan, 3, { ordinal: '3' }),
      replaceMember(schema3Plan, 4, { ordinal: 0 }),
    ]
    for (const candidate of cases) expect(() => parseTeamLifecycleLaunchPlan(candidate)).toThrow()
  })

  test('rejects duplicate identities, globally ambiguous names, and reserved names', () => {
    const cases = [
      replaceMember(schema3Plan, 6, { agentId: memberId('0') }),
      replaceMember(schema3Plan, 6, { name: 'ALPHA' }),
      replaceMember(schema3Plan, 6, { name: 'team-lead' }),
      replaceMember(schema3Plan, 6, { name: 'USER' }),
    ]
    for (const candidate of cases) expect(() => parseTeamLifecycleLaunchPlan(candidate)).toThrow()
  })

  test('rejects exact-key violations, sparse arrays, and malformed direct objects', () => {
    const missingPrimary = { ...schema3Plan } as Record<string, unknown>
    delete missingPrimary.primaryOrdinal
    const unknownMember = replaceMember(schema3Plan, 0, { capability: 'invented' })
    const sparseLanes = { ...schema3Plan, lanes: [...schema3Plan.lanes] as unknown[] }
    delete sparseLanes.lanes[2]
    const sparseMembers = clone(schema3Plan) as unknown as MutableSchema3Fixture
    delete sparseMembers.lanes[0]!.members[0]
    const malformedReference = { ...schema3Plan, runtimePlanRef: new (class {
      teamId = schema3Plan.runtimePlanRef.teamId
      runId = schema3Plan.runtimePlanRef.runId
      generation = schema3Plan.runtimePlanRef.generation
      planHash = schema3Plan.runtimePlanRef.planHash
    })() }
    const unknownReference = { ...schema3Plan, runtimePlanRef: { ...schema3Plan.runtimePlanRef, token: 'forbidden' } }
    for (const candidate of [{ ...schema3Plan, extra: true }, missingPrimary, unknownMember, sparseLanes, sparseMembers, malformedReference, unknownReference]) {
      expect(() => parseTeamLifecycleLaunchPlan(candidate)).toThrow()
    }
  })

  test('rejects a schema 3 roster larger than 256 members', () => {
    let ordinal = 0
    const lanes = Array.from({ length: 64 }, (_, laneIndex) => ({
      laneId: `lane_${laneIndex}`,
      kind: 'native',
      provider: 'codex',
      members: Array.from({ length: laneIndex === 0 ? 5 : 4 }, () => {
        const current = ordinal++
        return {
          name: `member${current}`,
          prompt: 'Work.',
          ordinal: current,
          agentId: `member_${current.toString(16).padStart(32, '0')}`,
        }
      }),
    }))
    expect(ordinal).toBe(257)
    expect(() => parseTeamLifecycleLaunchPlan({ ...schema3Plan, primaryOrdinal: 0, lanes })).toThrow('at most 256')
  })

  test('rejects mismatched team refs, invalid hashes/generations, and absent or invalid explicit primaries', () => {
    const cases = [
      { ...schema3Plan, runtimePlanRef: { ...schema3Plan.runtimePlanRef, teamId: `team_${'3'.repeat(32)}` } },
      { ...schema3Plan, runtimePlanRef: { ...schema3Plan.runtimePlanRef, planHash: `sha256:${'A'.repeat(64)}` } },
      { ...schema3Plan, runtimePlanRef: { ...schema3Plan.runtimePlanRef, planHash: 'a'.repeat(64) } },
      { ...schema3Plan, runtimePlanRef: { ...schema3Plan.runtimePlanRef, generation: 0 } },
      { ...schema3Plan, runtimePlanRef: { ...schema3Plan.runtimePlanRef, generation: Number.MAX_SAFE_INTEGER + 1 } },
      { ...schema3Plan, primaryOrdinal: 7 },
      { ...schema3Plan, primaryOrdinal: 1.5 },
      { ...schema3Plan, primaryOrdinal: '6' },
    ]
    for (const candidate of cases) expect(() => parseTeamLifecycleLaunchPlan(candidate)).toThrow()
  })

  test('returns a copied deeply immutable schema 3 plan', () => {
    const source = clone(schema3Plan) as unknown as MutableSchema3Fixture
    const parsed = parseTeamLifecycleLaunchPlan(source) as TeamLifecycleLaunchPlanV3
    source.lanes[0]!.members[0]!.name = 'changed'
    source.runtimePlanRef.generation = 9
    expect(parsed.lanes[0]!.members[0]!.name).toBe('alpha')
    expect(parsed.runtimePlanRef.generation).toBe(7)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.runtimePlanRef)).toBe(true)
    expect(Object.isFrozen(parsed.lanes)).toBe(true)
    expect(Object.isFrozen(parsed.lanes[0]!.members[0])).toBe(true)
  })
})

function clone<T>(value: T): T {
  return structuredClone(value)
}

function replaceMember<T>(value: T, ordinal: number, patch: Record<string, unknown>): T {
  const copy = clone(value) as unknown as MutableSchema3Fixture
  for (const lane of copy.lanes) {
    const index = lane.members.findIndex(member => member.ordinal === ordinal)
    if (index >= 0) {
      lane.members[index] = { ...lane.members[index], ...patch }
      return copy as unknown as T
    }
  }
  throw new Error(`Missing fixture ordinal ${ordinal}`)
}

type MutableSchema3Fixture = {
  lanes: Array<{ members: Array<Record<string, unknown>> }>
  runtimePlanRef: { generation: number }
  [key: string]: unknown
}

async function withPrivatePlan(run: (file: string) => Promise<void>): Promise<void> {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-lifecycle-raw-plan-'))
  try {
    const dir = await fs.realpath(temporaryDir)
    await run(path.join(dir, 'plan.json'))
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true })
  }
}
