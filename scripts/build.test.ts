import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..')

function readBuildPlan(args: string[] = []): {
  compile: boolean
  dev: boolean
  features: string[]
} {
  const result = spawnSync(
    process.execPath,
    ['run', './scripts/build.ts', ...args, '--print-build-plan'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout.trim())
}

describe('release build feature plan', () => {
  test('includes HOSTED_CONTROL and excludes deprecated UDS_INBOX by default', () => {
    const plan = readBuildPlan()

    expect(plan.dev).toBe(false)
    expect(plan.features).toContain('HOSTED_CONTROL')
    expect(plan.features).not.toContain('UDS_INBOX')
  })

  test('includes HOSTED_CONTROL in the complete development feature set', () => {
    const plan = readBuildPlan(['--dev', '--feature-set=dev-full'])

    expect(plan.features).toContain('HOSTED_CONTROL')
    expect(plan.features).not.toContain('UDS_INBOX')
  })

  test('rejects HOSTED_CONTROL and UDS_INBOX together', () => {
    const result = spawnSync(
      process.execPath,
      [
        'run',
        './scripts/build.ts',
        '--dev',
        '--feature=HOSTED_CONTROL',
        '--feature=UDS_INBOX',
        '--print-build-plan',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      'HOSTED_CONTROL and UDS_INBOX cannot own the same UDS listener',
    )
  })
})
