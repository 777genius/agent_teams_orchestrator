import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

// These checks inspect planning/rejection only. Root separately qualifies the
// compiled closure and actual selected Owner spawning its same-image broker.
function hostedPlan(args: string[] = [], target = '', env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    ['run', './scripts/build.ts', ...args, '--print-build-plan'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...env, BUN_COMPILE_TARGET: target },
    },
  )
}

const hostedArgs = ['--profile=hosted-owner', '--compile']

describe('Hosted-only compiled profile', () => {
  test('plans a fixed Linux x64 native image with no desktop externals', () => {
    const result = hostedPlan(hostedArgs)
    expect(result.status).toBe(0)
    const plan = JSON.parse(result.stdout.trim())
    expect(plan).toEqual({
      profile: 'hosted-owner', compile: true, dev: false,
      entrypoint: './scripts/e2e/hosted-actual-owner-owner.ts',
      outfile: './dist/hosted-owner', target: 'bun-linux-x64',
      features: ['HOSTED_CONTROL'],
      defines: {
        HOSTED_ACTUAL_OWNER_NATIVE_BUILD: 'true',
        'process.env.USER_TYPE': JSON.stringify('external'),
      },
      command: [
        process.execPath, 'build', './scripts/e2e/hosted-actual-owner-owner.ts',
        '--compile', '--target', 'bun-linux-x64', '--format', 'esm',
        '--outfile', './dist/hosted-owner', '--minify', '--packages', 'bundle',
        '--conditions', 'bun', '--feature=HOSTED_CONTROL',
        '--define', 'HOSTED_ACTUAL_OWNER_NATIVE_BUILD=true',
        '--define', 'process.env.USER_TYPE="external"',
      ],
    })
    expect(hostedPlan(hostedArgs, 'bun-linux-x64').status).toBe(0)
  })

  test('pins external build identity even under an inherited internal identity', () => {
    const plans = ['ant', 'external'].map(USER_TYPE => {
      const result = hostedPlan(hostedArgs, '', { USER_TYPE })
      expect(result.status).toBe(0)
      return JSON.parse(result.stdout.trim())
    })
    expect(plans[0]).toEqual(plans[1])
    const plan = plans[0]
    // Check the actual argv expression, including string quoting; a plan-only
    // field or a bare external identifier does not eliminate the internal arm.
    const expressions = plan.command.flatMap((arg: string, index: number) =>
      arg === '--define' ? [plan.command[index + 1]] : [],
    )
    expect(expressions).toEqual([
      'HOSTED_ACTUAL_OWNER_NATIVE_BUILD=true',
      'process.env.USER_TYPE="external"',
    ])
    expect(JSON.parse(plan.defines['process.env.USER_TYPE'])).toBe('external')
    expect(plan.command.some((arg: string) => arg.startsWith('--external'))).toBe(false)
  })

  test('requires compilation and rejects unknown or repeated profiles', () => {
    for (const args of [
      ['--profile=hosted-owner'], ['--profile=desktop', '--compile'],
      ['--profile', 'hosted-owner', '--compile'],
      [...hostedArgs, '--profile=hosted-owner'],
    ]) {
      const result = hostedPlan(args)
      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/requires --compile|Expected exactly one/)
    }
  })

  test('rejects desktop features and all entry, output, or compiler overrides', () => {
    for (const option of [
      '--dev', '--feature-set=dev-full', '--feature=VOICE_MODE',
      '--feature=UDS_INBOX', '--feature=HOSTED_CONTROL', '--feature',
      '--feature-set', '--target=bun-linux-x64', '--outfile=/dev/null',
      '--outdir=dist/local-cli', '--external=protectedNamespace.js',
      '--define=HOSTED_ACTUAL_OWNER_NATIVE_BUILD=false', './src/entrypoints/cli.tsx',
      '--define=process.env.USER_TYPE="ant"',
    ]) {
      const result = hostedPlan([...hostedArgs, option])
      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Unsupported hosted-owner option:')
    }
  })

  test('rejects host-dependent, Darwin, Windows, ARM, and unknown targets', () => {
    for (const target of [
      'bun', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64',
      'bun-windows-x64', 'bun-windows-arm64', 'bun-linux-x64-baseline', 'unknown',
    ]) {
      const result = hostedPlan(hostedArgs, target)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Unsupported hosted-owner BUN_COMPILE_TARGET:')
    }
  })

  test('dispatches and exits before desktop mutation and launcher paths', () => {
    const source = readFileSync(resolve(repoRoot, 'scripts/build.ts'), 'utf8')
    const start = source.indexOf('if (profileArgs.length > 0)')
    const end = source.indexOf('const compileTarget =', start)
    const branch = source.slice(start, end)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(branch).toContain('runBuild(cmd)')
    expect(branch).toContain('chmodSync(outfile, 0o500)')
    expect(branch.trimEnd().endsWith('process.exit(0)\n}')).toBe(true)
    expect(branch).not.toContain('patchGeminiCliCoreWasmImports')
    expect(branch).not.toContain('writeLauncher')
    expect(source.indexOf('patchGeminiCliCoreWasmImports()')).toBeGreaterThan(end)
    expect(source.indexOf('function writeLauncher(')).toBeGreaterThan(end)
  })

  test('keeps the old source check distinct from artifact compilation and pins intact', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
    expect(pkg.scripts['compile:hosted-owner']).toBe(
      'bun run ./scripts/build.ts --profile=hosted-owner --compile',
    )
    expect(pkg.scripts['compile:hosted-actual-owner']).toBe(
      "bun build scripts/e2e/hosted-actual-owner-owner.ts --target=bun --define=HOSTED_ACTUAL_OWNER_NATIVE_BUILD=true --outfile=/dev/null --external='*/protectedNamespace.js'",
    )
    expect(pkg.scripts.compile).toBe('bun run ./scripts/build.ts --compile')
    expect(pkg.packageManager).toBe('bun@1.4.0')
    expect(pkg.engines.bun).toBe('>=1.4.0')
  })
})
