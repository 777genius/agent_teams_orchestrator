import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { spawnSyncPortableCli } from '../../utils/portableCli.js'

const liveTest =
  process.env.OPENCODE_READINESS_BRIDGE_LIVE_E2E === '1'
    ? test
    : test.skip

const LIVE_MODEL = process.env.OPENCODE_READINESS_BRIDGE_MODEL ?? 'big-pickle'
const SEQUENTIAL_ATTEMPTS = Number(process.env.OPENCODE_READINESS_BRIDGE_SEQUENTIAL_ATTEMPTS ?? '3')
const PARALLEL_ATTEMPTS = Number(process.env.OPENCODE_READINESS_BRIDGE_PARALLEL_ATTEMPTS ?? '2')
const BRIDGE_TIMEOUT_MS = Number(process.env.OPENCODE_READINESS_BRIDGE_TIMEOUT_MS ?? '180000')
const ALLOW_WINDOWS_LOCAL_MCP =
  process.env.OPENCODE_READINESS_BRIDGE_ALLOW_WINDOWS_LOCAL_MCP === '1'

type BridgeResult = {
  ok: boolean
  requestId: string
  command: string
  error?: {
    kind?: string
    message?: string
  }
  data?: {
    state?: string
    launchAllowed?: boolean
    modelId?: string | null
    requiredToolsPresent?: boolean
    diagnostics?: string[]
  }
}

function runtimeCliPath(): string {
  const override = process.env.OPENCODE_READINESS_BRIDGE_RUNTIME_CLI
  if (override?.trim()) {
    return override.trim()
  }
  return path.join(process.cwd(), 'dist', process.platform === 'win32' ? 'cli.exe' : 'cli')
}

function buildEnvelope(input: {
  requestId: string
  command: 'opencode.readiness' | 'opencode.cleanupHosts'
  projectPath: string
  body?: Record<string, unknown>
}) {
  return {
    schemaVersion: 1,
    requestId: input.requestId,
    command: input.command,
    cwd: input.projectPath,
    startedAt: new Date().toISOString(),
    timeoutMs: BRIDGE_TIMEOUT_MS,
    body: {
      projectPath: input.projectPath,
      ...(input.body ?? {}),
    },
  }
}

async function runBridgeCommand(input: {
  requestId: string
  command: 'opencode.readiness' | 'opencode.cleanupHosts'
  projectPath: string
  body?: Record<string, unknown>
}): Promise<BridgeResult> {
  const cliPath = runtimeCliPath()
  expect(existsSync(cliPath), `Compile the runtime before this live E2E: ${cliPath}`).toBe(true)

  const inputPath = path.join(input.projectPath, `${input.requestId}.json`)
  await writeFile(inputPath, `${JSON.stringify(buildEnvelope(input))}\n`, 'utf8')

  const result = spawnSyncPortableCli(
    cliPath,
    ['runtime', 'opencode-command', '--json', '--input', inputPath],
    {
      cwd: input.projectPath,
      env: process.env,
      encoding: 'utf8',
      timeout: BRIDGE_TIMEOUT_MS + 30_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  )

  expect(
    result.error,
    `${input.command} spawn error\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBeUndefined()
  expect(
    result.status,
    `${input.command} exit status\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0)

  const stdout = String(result.stdout ?? '').trim()
  expect(
    stdout.length,
    `${input.command} must write a non-empty bridge JSON response to stdout`,
  ).toBeGreaterThan(0)

  const parsed = JSON.parse(stdout) as BridgeResult
  expect(parsed.requestId).toBe(input.requestId)
  expect(parsed.command).toBe(input.command)
  return parsed
}

async function runReadinessAttempt(index: number): Promise<void> {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), `opencode-readiness-bridge-${index}-`))
  try {
    const result = await runBridgeCommand({
      requestId: `readiness-${process.pid}-${Date.now()}-${index}`,
      command: 'opencode.readiness',
      projectPath,
      body: {
        selectedModel: LIVE_MODEL,
        requireExecutionProbe: true,
      },
    })

    expect(result.ok, result.error?.message ?? result.data?.diagnostics?.join('\n')).toBe(true)
    expect(result.data?.state, result.data?.diagnostics?.join('\n')).toBe('ready')
    expect(result.data?.launchAllowed, result.data?.diagnostics?.join('\n')).toBe(true)
    expect(result.data?.requiredToolsPresent, result.data?.diagnostics?.join('\n')).toBe(true)
  } finally {
    await runBridgeCommand({
      requestId: `cleanup-${process.pid}-${Date.now()}-${index}`,
      command: 'opencode.cleanupHosts',
      projectPath,
      body: {
        mode: 'force',
        staleAgeMs: 0,
        leaseStaleAgeMs: 0,
        preflightLeaseStaleAgeMs: 0,
      },
    }).catch(() => undefined)
    await rm(projectPath, { recursive: true, force: true }).catch(() => undefined)
  }
}

describe('OpenCode readiness bridge live e2e', () => {
  liveTest('returns non-empty ready JSON for deep model checks under repeated bridge launches', async () => {
    if (
      process.platform === 'win32'
      && !process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL?.trim()
      && process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY?.trim()
      && !ALLOW_WINDOWS_LOCAL_MCP
    ) {
      throw new Error(
        [
          'Windows live E2E should use CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL from the app HTTP MCP server.',
          'Using CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY makes OpenCode spawn local node.exe MCP workers, which can show console windows.',
          'Set OPENCODE_READINESS_BRIDGE_ALLOW_WINDOWS_LOCAL_MCP=1 only when intentionally testing that fallback.',
        ].join(' '),
      )
    }

    for (let index = 0; index < SEQUENTIAL_ATTEMPTS; index += 1) {
      await runReadinessAttempt(index)
    }

    await Promise.all(
      Array.from({ length: PARALLEL_ATTEMPTS }, (_unused, index) =>
        runReadinessAttempt(SEQUENTIAL_ATTEMPTS + index),
      ),
    )
  }, (SEQUENTIAL_ATTEMPTS + PARALLEL_ATTEMPTS) * (BRIDGE_TIMEOUT_MS + 60_000))
})
