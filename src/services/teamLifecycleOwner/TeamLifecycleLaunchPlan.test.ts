import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  PRODUCT_SCHEMA3_INTERLEAVED_PLAN_JSON,
  PRODUCT_SCHEMA3_INTERLEAVED_PLAN_SHA256,
} from './TeamLifecycleLaunchPlan.schema3.fixture.js'
import {
  parseTeamLifecycleLaunchPlan,
  PrivateFileTeamLifecycleLaunchPlanStore,
} from './TeamLifecycleLaunchPlan.js'

const scope = { workspaceId: 'workspace_test', teamId: 'team_test' }
const plan = {
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
})

describe('schema 3 Product compatibility', () => {
  test('admits the exact real Product projector bytes with interleaved ordinals and later primary', async () => {
    const digest = createHash('sha256').update(PRODUCT_SCHEMA3_INTERLEAVED_PLAN_JSON).digest('hex')
    expect(digest).toBe(PRODUCT_SCHEMA3_INTERLEAVED_PLAN_SHA256)
    const parsed = parseTeamLifecycleLaunchPlan(JSON.parse(PRODUCT_SCHEMA3_INTERLEAVED_PLAN_JSON))
    expect(JSON.stringify(parsed)).toBe(PRODUCT_SCHEMA3_INTERLEAVED_PLAN_JSON)
    expect(parsed).toMatchObject({
      schemaVersion: 3,
      runtimePlanRef: {
        teamId: `team_${'a'.repeat(32)}`,
        runId: `run_${'c'.repeat(32)}`,
        generation: 19,
        planHash: 'sha256:c39a70d448298729bcb10fabfc2503a5e16faa07656909c075b981fd79942834',
      },
      primaryOrdinal: 2,
    })
    if (parsed.schemaVersion !== 3) throw new Error('expected schema 3 fixture')
    expect(parsed.lanes.map(lane => lane.members.map(member => member.ordinal))).toEqual([[1, 2], [0]])

    await withPrivatePlan(async file => {
      await fs.writeFile(file, PRODUCT_SCHEMA3_INTERLEAVED_PLAN_JSON, { mode: 0o600 })
      const admission = await new PrivateFileTeamLifecycleLaunchPlanStore(file).load({
        workspaceId: `workspace_${'b'.repeat(32)}`,
        teamId: `team_${'a'.repeat(32)}`,
      })
      expect(admission?.planGeneration).toBe(
        `plan-generation_${PRODUCT_SCHEMA3_INTERLEAVED_PLAN_SHA256}`,
      )
      expect(admission?.plan).toEqual(parsed)
      const changedIdentity = JSON.parse(PRODUCT_SCHEMA3_INTERLEAVED_PLAN_JSON)
      changedIdentity.runtimePlanRef.generation += 1
      await fs.writeFile(file, JSON.stringify(changedIdentity), { mode: 0o600 })
      expect(await admission?.isCurrent()).toBe(false)
      const replacement = await new PrivateFileTeamLifecycleLaunchPlanStore(file).load({
        workspaceId: `workspace_${'b'.repeat(32)}`,
        teamId: `team_${'a'.repeat(32)}`,
      })
      expect(replacement?.planGeneration).not.toBe(admission?.planGeneration)
    })
  })

  test('keeps schema 2 parsing bytes and optional-property ordering unchanged', () => {
    const parsed = parseTeamLifecycleLaunchPlan(plan)
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(plan))
  })

  test('rejects malformed Product identity, ordinal, primary, approval and shape contracts', () => {
    const golden = JSON.parse(PRODUCT_SCHEMA3_INTERLEAVED_PLAN_JSON) as any
    const cases: any[] = []
    const mutate = (change: (value: any) => void): void => {
      const value = structuredClone(golden)
      change(value)
      cases.push(value)
    }
    mutate(value => { value.toolApprovalMode = 'manual' })
    mutate(value => { value.runtimePlanRef.teamId = `team_${'d'.repeat(32)}` })
    mutate(value => { value.runtimePlanRef.runId = 'run_not-canonical' })
    mutate(value => { value.runtimePlanRef.generation = 0 })
    mutate(value => { value.runtimePlanRef.generation = Number.MAX_SAFE_INTEGER + 1 })
    mutate(value => { value.runtimePlanRef.planHash = `sha256:${'A'.repeat(64)}` })
    mutate(value => { value.primaryOrdinal = 3 })
    mutate(value => { value.primaryOrdinal = -1 })
    mutate(value => { value.lanes[0].members[1].ordinal = 1 })
    mutate(value => { value.lanes[1].members[0].ordinal = 3 })
    mutate(value => { value.lanes[1].members[0].ordinal = 1 })
    mutate(value => { delete value.lanes[0].members[0].ordinal })
    mutate(value => { value.lanes[1].members[0].agentId = value.lanes[0].members[0].agentId })
    mutate(value => { value.lanes[0].members[0].agentId = 'member_not-canonical' })
    mutate(value => { delete value.lanes[0].members[0].agentId })
    mutate(value => { delete value.runtimePlanRef.runId })
    mutate(value => { value.lanes[0].members[0].unexpected = true })
    mutate(value => { value.runtimePlanRef.unexpected = true })
    for (const invalid of cases) expect(() => parseTeamLifecycleLaunchPlan(invalid)).toThrow()
  })
})

async function withPrivatePlan(run: (file: string) => Promise<void>): Promise<void> {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-lifecycle-raw-plan-'))
  try {
    const dir = await fs.realpath(temporaryDir)
    await run(path.join(dir, 'plan.json'))
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true })
  }
}
