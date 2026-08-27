import { expect, test } from 'bun:test'
import path from 'node:path'

type WorkflowStep = {
  name?: string
  shell?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

type WorkflowJob = {
  'runs-on'?: string
  strategy?: {
    matrix?: Record<string, unknown> & {
      include?: Array<Record<string, unknown>>
    }
  }
  steps?: WorkflowStep[]
}

type Workflow = { jobs?: Record<string, WorkflowJob> }

const workflowPath = path.resolve(import.meta.dir, '../.github/workflows/ci.yml')
const portableFiles = [
  'phase0-opencode-tests/FakeOpenCodeRegressionHarness.test.ts',
  'phase0-opencode-tests/PortableOpenCodeAcceptance.e2e.test.ts',
  'phase0-opencode-tests/WorkflowContract.test.ts',
]
const linuxProductionFiles = [
  'src/services/opencode/OpenCodeLaunchAttempt.test.ts',
  'src/services/opencode/OpenCodeLaunchAttemptProduction.test.ts',
  'src/services/opencode/OpenCodeLaunchAttemptProductionComposition.test.ts',
  'src/services/opencode/OpenCodeLaunchAttemptStore.test.ts',
  'src/services/opencode/OpenCodeHostManager.test.ts',
  'src/services/opencode/OpenCodeCatalogCrossPlatformContract.test.ts',
  'src/services/opencode/OpenCodeProviderCatalogService.test.ts',
  'src/utils/processKill.test.ts',
]
const windowsProductionFiles = [
  'src/services/opencode/OpenCodeLaunchAttemptProduction.test.ts',
  'src/services/opencode/OpenCodeLaunchAttemptProductionComposition.test.ts',
  'src/services/opencode/OpenCodeWindowsPassiveProductionComposition.test.ts',
  'src/services/opencode/OpenCodeHostManager.test.ts',
  'src/utils/processKill.test.ts',
]
const windowsPassiveProductionComposition =
  'src/services/opencode/OpenCodeWindowsPassiveProductionComposition.test.ts'

function command(files: string[]): string {
  return ['bun test', ...files].join(' ')
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
  const matches = (job.steps ?? []).filter(step => step.name === name)
  expect(matches).toHaveLength(1)
  return matches[0]!
}

function defaultShells(job: WorkflowJob): Array<'bash' | 'pwsh'> {
  const runsOn = job['runs-on']
  const matrixKey = runsOn?.match(/^\$\{\{ matrix\.([A-Za-z0-9_-]+) \}\}$/)?.[1]
  const matrix = job.strategy?.matrix
  const runners = matrixKey
    ? [
        ...((Array.isArray(matrix?.[matrixKey]) ? matrix[matrixKey] : []) as unknown[]),
        ...(matrix?.include ?? []).map(entry => entry[matrixKey]),
      ].filter((value): value is string => typeof value === 'string')
    : runsOn ? [runsOn] : []
  return [...new Set(runners.map(runner => runner.toLowerCase().startsWith('windows') ? 'pwsh' : 'bash'))]
}

function expectDefaultSingleCommand(
  job: WorkflowJob,
  step: WorkflowStep,
  shell: 'bash' | 'pwsh',
  expected: string,
): void {
  expect(step.shell).toBeUndefined()
  expect(defaultShells(job)).toEqual([shell])
  expect(step.run).toBe(expected)
  expect(step.run).not.toMatch(/[\r\n]/)
}

function expectPinnedBun(job: WorkflowJob): void {
  const setup = (job.steps ?? []).filter(step => step.uses === 'oven-sh/setup-bun@v2')
  expect(setup).toHaveLength(1)
  expect(setup[0]?.with?.['bun-version']).toBe('1.3.11')
}

function rawJob(source: string, jobId: string): string {
  const escaped = jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = source.search(new RegExp(`^  ${escaped}:\\s*$`, 'm'))
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = source.slice(start)
  const next = rest.slice(rest.indexOf('\n') + 1).search(/^  [A-Za-z0-9_-]+:\s*$/m)
  return next < 0 ? rest : rest.slice(0, rest.indexOf('\n') + 1 + next)
}

function rawRunBlocks(jobSource: string): string[] {
  const lines = jobSource.split(/\r?\n/)
  const blocks: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^ {8}run:\s*(.*)$/)
    if (!match) continue
    const block = [match[1] ?? '']
    if (/^(?:\||[>|][+-]?)$/.test(match[1] ?? '')) {
      while (index + 1 < lines.length && (/^\s*$/.test(lines[index + 1]!) || /^ {10,}\S/.test(lines[index + 1]!))) {
        index += 1
        block.push(lines[index]!)
      }
    }
    blocks.push(block.join('\n'))
  }
  return blocks
}

test('portable fake and production-composition gates are one command under their default shells', async () => {
  const source = await Bun.file(workflowPath).text()
  const workflow = Bun.YAML.parse(source) as Workflow
  const posix = workflow.jobs?.['posix-passive-snapshot']
  const windows = workflow.jobs?.['windows-passive-snapshot']
  expect(posix?.['runs-on']).toBe('ubuntu-latest')
  expect(windows?.['runs-on']).toBe('${{ matrix.runner }}')
  expect(posix).toBeDefined()
  expect(windows).toBeDefined()

  expectDefaultSingleCommand(
    posix!,
    namedStep(posix!, 'Test portable fake OpenCode acceptance'),
    'bash', command(portableFiles),
  )
  expectDefaultSingleCommand(
    posix!,
    namedStep(posix!, 'Test real Linux recycled-pid production cleanup across process restart'),
    'bash',
    'sudo unshare --pid --fork --mount-proc ' +
      'native/opencode-host-fixture/target/debug/opencode-host-fixture ' +
      '--pid-namespace-supervisor env "PATH=$PATH" OPENCODE_REQUIRE_NATIVE_PID_RECYCLE=1 ' +
      'bun test src/services/opencode/OpenCodeLaunchAttemptProductionComposition.test.ts ' +
      '--test-name-pattern "native cleanup acquisition and replay use separate OS processes"',
  )
  expectDefaultSingleCommand(
    posix!,
    namedStep(posix!, 'Test production launch cleanup composition and safety contracts'),
    'bash', command(linuxProductionFiles),
  )
  expectDefaultSingleCommand(
    windows!,
    namedStep(windows!, 'Test portable fake OpenCode acceptance'),
    'pwsh', command(portableFiles),
  )
  expectDefaultSingleCommand(
    windows!,
    namedStep(windows!, 'Test Windows production cleanup composition and owned authority'),
    'pwsh', command(windowsProductionFiles),
  )

  const windowsPassiveSelections = Object.entries(workflow.jobs ?? {}).flatMap(([jobId, job]) =>
    (job.steps ?? [])
      .filter(step => step.run?.split(/\s+/).includes(windowsPassiveProductionComposition))
      .map(step => ({ jobId, stepName: step.name })),
  )
  expect(windowsPassiveSelections).toEqual([{
    jobId: 'windows-passive-snapshot',
    stepName: 'Test Windows production cleanup composition and owned authority',
  }])

  expectPinnedBun(posix!)
  expectPinnedBun(windows!)
  expect(windows?.strategy?.matrix?.include).toEqual([
    { runner: 'windows-2022', arch: 'x64' },
    { runner: 'windows-11-arm', arch: 'arm64' },
  ])
})

test('every run block in a Windows-capable job rejects Bash backslash continuation', async () => {
  const source = await Bun.file(workflowPath).text()
  const workflow = Bun.YAML.parse(source) as Workflow
  const windowsJobIds = Object.entries(workflow.jobs ?? {})
    .filter(([, job]) => {
      const matrix = job.strategy?.matrix
      const candidates = [
        job['runs-on'],
        ...(matrix?.include ?? []).flatMap(entry => Object.values(entry)),
        ...Object.values(matrix ?? {}).flatMap(value => Array.isArray(value) ? value : []),
      ]
      return candidates.some(value => typeof value === 'string' && value.toLowerCase().startsWith('windows'))
    })
    .map(([jobId]) => jobId)

  expect(windowsJobIds).toEqual(['windows-passive-snapshot', 'task-change-ledger'])
  for (const jobId of windowsJobIds) {
    const blocks = rawRunBlocks(rawJob(source, jobId))
    const parsedRuns = workflow.jobs?.[jobId]?.steps?.filter(step => step.run !== undefined) ?? []
    expect(blocks).toHaveLength(parsedRuns.length)
    for (const block of blocks) expect(block).not.toMatch(/\\[ \t]*\r?\n/)
  }
})
