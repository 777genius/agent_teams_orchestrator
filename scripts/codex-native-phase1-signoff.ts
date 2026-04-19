import { resolve } from 'node:path'

type RuntimeBackendOption = {
  id: string
  selectable: boolean
  available: boolean
  state?: string | null
  audience?: string | null
  statusMessage?: string | null
  detailMessage?: string | null
}

type RuntimeProviderStatus = {
  providerId: string
  selectedBackendId?: string | null
  resolvedBackendId?: string | null
  statusMessage?: string | null
  detailMessage?: string | null
  availableBackends?: RuntimeBackendOption[]
}

type RuntimeStatusPayload = {
  schemaVersion: number
  providers: Record<string, RuntimeProviderStatus | undefined>
}

type ScenarioExpectation = {
  selectedBackendId: string | null
  resolvedBackendId: string | null
  providerStatusMessage: string | null
  nativeOption: {
    selectable: boolean
    available: boolean
    state: string
    audience: string
    statusMessage: string
  }
}

type Scenario = {
  id: string
  env: Record<string, string | undefined>
  expectation: ScenarioExpectation
}

type ScenarioEvidence = {
  id: string
  command: string[]
  selectedBackendId: string | null
  resolvedBackendId: string | null
  providerStatusMessage: string | null
  nativeOption: ScenarioExpectation['nativeOption'] & {
    detailMessage: string | null
  }
}

function readJson(stdout: string): RuntimeStatusPayload {
  const parsed = JSON.parse(stdout) as RuntimeStatusPayload
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 2) {
    throw new Error('runtime status did not return schemaVersion=2')
  }
  return parsed
}

function assertEqual(
  actual: string | boolean | null | undefined,
  expected: string | boolean | null,
  label: string,
) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch - expected ${String(expected)}, received ${String(actual)}`)
  }
}

async function runScenario(
  scenario: Scenario,
  repoRoot: string,
): Promise<ScenarioEvidence> {
  const command = [
    process.execPath,
    'run',
    './src/entrypoints/cli.tsx',
    'runtime',
    'status',
    '--provider',
    'codex',
    '--json',
  ]

  const child = Bun.spawn({
    cmd: command,
    cwd: repoRoot,
    env: {
      ...process.env,
      ...scenario.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const exitCode = await child.exited

  if (exitCode !== 0) {
    throw new Error(
      `scenario ${scenario.id} failed - exit=${exitCode} stderr=${stderr.trim() || 'none'}`,
    )
  }

  const payload = readJson(stdout)
  const codex = payload.providers.codex
  if (!codex) {
    throw new Error(`scenario ${scenario.id} did not include a codex provider`)
  }

  const nativeOption = codex.availableBackends?.find(
    backend => backend.id === 'codex-native',
  )
  if (!nativeOption) {
    throw new Error(`scenario ${scenario.id} did not include the codex-native option`)
  }

  assertEqual(
    codex.selectedBackendId ?? null,
    scenario.expectation.selectedBackendId,
    `${scenario.id}.selectedBackendId`,
  )
  assertEqual(
    codex.resolvedBackendId ?? null,
    scenario.expectation.resolvedBackendId,
    `${scenario.id}.resolvedBackendId`,
  )
  assertEqual(
    codex.statusMessage ?? null,
    scenario.expectation.providerStatusMessage,
    `${scenario.id}.providerStatusMessage`,
  )
  assertEqual(
    nativeOption.selectable,
    scenario.expectation.nativeOption.selectable,
    `${scenario.id}.nativeOption.selectable`,
  )
  assertEqual(
    nativeOption.available,
    scenario.expectation.nativeOption.available,
    `${scenario.id}.nativeOption.available`,
  )
  assertEqual(
    nativeOption.state ?? null,
    scenario.expectation.nativeOption.state,
    `${scenario.id}.nativeOption.state`,
  )
  assertEqual(
    nativeOption.audience ?? null,
    scenario.expectation.nativeOption.audience,
    `${scenario.id}.nativeOption.audience`,
  )
  assertEqual(
    nativeOption.statusMessage ?? null,
    scenario.expectation.nativeOption.statusMessage,
    `${scenario.id}.nativeOption.statusMessage`,
  )

  return {
    id: scenario.id,
    command,
    selectedBackendId: codex.selectedBackendId ?? null,
    resolvedBackendId: codex.resolvedBackendId ?? null,
    providerStatusMessage: codex.statusMessage ?? null,
    nativeOption: {
      selectable: nativeOption.selectable,
      available: nativeOption.available,
      state: nativeOption.state ?? 'unknown',
      audience: nativeOption.audience ?? 'unknown',
      statusMessage: nativeOption.statusMessage ?? 'unknown',
      detailMessage: nativeOption.detailMessage ?? null,
    },
  }
}

const repoRoot = resolve(import.meta.dir, '..')
const runtimeMissingPath = '/usr/bin:/bin'

const scenarios: Scenario[] = [
  {
    id: 'locked',
    env: {
      CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
      CLAUDE_CODE_CODEX_API_KEY_BETA: '1',
      CLAUDE_CODE_CODEX_NATIVE_BETA: '1',
      CLAUDE_CODE_CODEX_NATIVE_INTERNAL_UNLOCK: undefined,
      CODEX_API_KEY: 'sk-phase1-native',
      OPENAI_API_KEY: undefined,
    },
    expectation: {
      selectedBackendId: 'codex-native',
      resolvedBackendId: 'codex-native',
      providerStatusMessage: 'Codex native runtime ready',
      nativeOption: {
        selectable: false,
        available: true,
        state: 'locked',
        audience: 'internal',
        statusMessage: 'Ready but locked',
      },
    },
  },
  {
    id: 'internal-unlock-ready',
    env: {
      CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
      CLAUDE_CODE_CODEX_API_KEY_BETA: '1',
      CLAUDE_CODE_CODEX_NATIVE_BETA: '1',
      CLAUDE_CODE_CODEX_NATIVE_INTERNAL_UNLOCK: '1',
      CODEX_API_KEY: 'sk-phase1-native',
      OPENAI_API_KEY: undefined,
    },
    expectation: {
      selectedBackendId: 'codex-native',
      resolvedBackendId: 'codex-native',
      providerStatusMessage: 'Codex native runtime ready',
      nativeOption: {
        selectable: true,
        available: true,
        state: 'ready',
        audience: 'internal',
        statusMessage: 'Ready for internal use',
      },
    },
  },
  {
    id: 'authentication-required',
    env: {
      CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
      CLAUDE_CODE_CODEX_API_KEY_BETA: '1',
      CLAUDE_CODE_CODEX_NATIVE_BETA: '1',
      CLAUDE_CODE_CODEX_NATIVE_INTERNAL_UNLOCK: undefined,
      CODEX_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    },
    expectation: {
      selectedBackendId: 'codex-native',
      resolvedBackendId: null,
      providerStatusMessage: 'Codex native runtime not ready',
      nativeOption: {
        selectable: false,
        available: false,
        state: 'authentication-required',
        audience: 'internal',
        statusMessage: 'Authentication required',
      },
    },
  },
  {
    id: 'runtime-missing',
    env: {
      CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
      CLAUDE_CODE_CODEX_API_KEY_BETA: '1',
      CLAUDE_CODE_CODEX_NATIVE_BETA: '1',
      CLAUDE_CODE_CODEX_NATIVE_INTERNAL_UNLOCK: undefined,
      CODEX_API_KEY: 'sk-phase1-native',
      OPENAI_API_KEY: undefined,
      PATH: runtimeMissingPath,
    },
    expectation: {
      selectedBackendId: 'codex-native',
      resolvedBackendId: null,
      providerStatusMessage: 'Codex native runtime not ready',
      nativeOption: {
        selectable: false,
        available: false,
        state: 'runtime-missing',
        audience: 'internal',
        statusMessage: 'Codex CLI not found',
      },
    },
  },
  {
    id: 'auto-fallback-stays-old-lane',
    env: {
      CLAUDE_CODE_CODEX_BACKEND: 'auto',
      CLAUDE_CODE_CODEX_API_KEY_BETA: '1',
      CLAUDE_CODE_CODEX_NATIVE_BETA: '1',
      CLAUDE_CODE_CODEX_NATIVE_INTERNAL_UNLOCK: '1',
      CODEX_API_KEY: 'sk-phase1-native',
      OPENAI_API_KEY: 'sk-phase1-openai',
    },
    expectation: {
      selectedBackendId: 'auto',
      resolvedBackendId: 'api',
      providerStatusMessage: 'Resolved to OpenAI API',
      nativeOption: {
        selectable: true,
        available: true,
        state: 'ready',
        audience: 'internal',
        statusMessage: 'Ready for internal use',
      },
    },
  },
]

const evidence = await Promise.all(
  scenarios.map(scenario => runScenario(scenario, repoRoot)),
)

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      runner: 'runtime status --provider codex --json',
      evidence,
    },
    null,
    2,
  ),
)
