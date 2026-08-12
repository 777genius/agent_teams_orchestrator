import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { PrivateFileTeamLifecycleLaunchPlanStore } from './TeamLifecycleLaunchPlan.js'

const scope = { workspaceId: 'workspace_test', teamId: 'team_test' }
const plan = {
  schemaVersion: 1,
  ...scope,
  workspaceRoot: '/tmp/hosted-workspace',
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
