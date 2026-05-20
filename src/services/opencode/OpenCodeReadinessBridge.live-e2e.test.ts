import { describe, expect, test } from 'bun:test'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { spawnPortableCli, spawnSyncPortableCli } from '../../utils/portableCli.js'

const liveTest =
  process.env.OPENCODE_READINESS_BRIDGE_LIVE_E2E === '1'
    ? test
    : test.skip
const fakeLocalE2ETest =
  process.env.OPENCODE_READINESS_BRIDGE_FAKE_LOCAL_E2E === '1'
    ? test
    : test.skip

const LIVE_MODEL = process.env.OPENCODE_READINESS_BRIDGE_MODEL ?? 'big-pickle'
const SEQUENTIAL_ATTEMPTS = Number(process.env.OPENCODE_READINESS_BRIDGE_SEQUENTIAL_ATTEMPTS ?? '3')
const PARALLEL_ATTEMPTS = Number(process.env.OPENCODE_READINESS_BRIDGE_PARALLEL_ATTEMPTS ?? '2')
const BRIDGE_TIMEOUT_MS = Number(process.env.OPENCODE_READINESS_BRIDGE_TIMEOUT_MS ?? '180000')
const ALLOW_WINDOWS_LOCAL_MCP =
  process.env.OPENCODE_READINESS_BRIDGE_ALLOW_WINDOWS_LOCAL_MCP === '1'
const CLAUDE_TEAM_ROOT =
  process.env.OPENCODE_READINESS_BRIDGE_CLAUDE_TEAM_ROOT
  ?? path.resolve(process.cwd(), '..', 'claude_team')

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
    availableModels?: string[]
    requiredToolsPresent?: boolean
    missing?: string[]
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

async function runBridgeCommandAsync(input: {
  requestId: string
  command: 'opencode.readiness' | 'opencode.cleanupHosts'
  projectPath: string
  body?: Record<string, unknown>
}): Promise<BridgeResult> {
  const cliPath = runtimeCliPath()
  expect(existsSync(cliPath), `Compile the runtime before this live E2E: ${cliPath}`).toBe(true)

  const inputPath = path.join(input.projectPath, `${input.requestId}.json`)
  await writeFile(inputPath, `${JSON.stringify(buildEnvelope(input))}\n`, 'utf8')

  const child = spawnPortableCli(
    cliPath,
    ['runtime', 'opencode-command', '--json', '--input', inputPath],
    {
      cwd: input.projectPath,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  child.stdout?.on('data', chunk => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })
  child.stderr?.on('data', chunk => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })

  const timeout = setTimeout(() => {
    child.kill('SIGTERM')
  }, BRIDGE_TIMEOUT_MS + 30_000)

  const childResult = await Promise.race([
    once(child, 'exit').then(([code, signal]) => ({
      type: 'exit' as const,
      code: code as number | null,
      signal: signal as NodeJS.Signals | null,
    })),
    once(child, 'error').then(([error]) => ({
      type: 'error' as const,
      error: error instanceof Error ? error : new Error(String(error)),
    })),
  ])
  clearTimeout(timeout)
  const stdout = Buffer.concat(stdoutChunks).toString('utf8')
  const stderr = Buffer.concat(stderrChunks).toString('utf8')
  if (childResult.type === 'error') {
    throw new Error(
      `${input.command} failed to start: ${childResult.error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }

  expect(
    childResult.signal,
    `${input.command} exit signal\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  ).toBeNull()
  expect(
    childResult.code,
    `${input.command} exit status\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  ).toBe(0)

  const trimmedStdout = stdout.trim()
  expect(
    trimmedStdout.length,
    `${input.command} must write a non-empty bridge JSON response to stdout`,
  ).toBeGreaterThan(0)

  const parsed = JSON.parse(trimmedStdout) as BridgeResult
  expect(parsed.requestId).toBe(input.requestId)
  expect(parsed.command).toBe(input.command)
  return parsed
}

async function startFakeOpenAiCompatibleServer(): Promise<{
  baseUrl: string
  requests: string[]
  close: () => Promise<void>
}> {
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    requests.push(`${request.method ?? 'GET'} ${request.url ?? '/'}`)
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'qwen-test:0.5b', object: 'model' }],
      }))
      return
    }

    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        stream?: boolean
      }
      if (body.stream) {
        const created = Math.floor(Date.now() / 1000)
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        })
        response.write(`data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created,
          model: 'qwen-test:0.5b',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'PONG' },
              finish_reason: null,
            },
          ],
        })}\n\n`)
        response.write(`data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created,
          model: 'qwen-test:0.5b',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
        })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }

      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'PONG' },
            finish_reason: 'stop',
          },
        ],
      }))
      return
    }

    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Fake OpenAI-compatible server did not bind to a TCP port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

async function configureLocalMcpEnv(): Promise<() => Promise<void>> {
  const previousCommand = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
  const previousEntry = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
  const previousArgsJson = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
  const previousUrl = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
  const previousDataHome = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  const previousCacheHome = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  const previousMcpProofCacheDisabled =
    process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'opencode-readiness-fake-data-'))
  const cacheHome = await mkdtemp(path.join(os.tmpdir(), 'opencode-readiness-fake-cache-'))
  const claudeConfigDir =
    await mkdtemp(path.join(os.tmpdir(), 'opencode-readiness-fake-claude-config-'))
  const tsxPath = path.join(CLAUDE_TEAM_ROOT, 'node_modules', '.bin', 'tsx')
  const mcpEntryPath = path.join(CLAUDE_TEAM_ROOT, 'mcp-server', 'src', 'index.ts')
  expect(existsSync(tsxPath), `Missing tsx for local MCP proof: ${tsxPath}`).toBe(true)
  expect(existsSync(mcpEntryPath), `Missing Agent Teams MCP source entry: ${mcpEntryPath}`).toBe(true)
  process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = tsxPath
  process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = mcpEntryPath
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = dataHome
  process.env.CLAUDE_MULTIMODEL_CACHE_HOME = cacheHome
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
  process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED = '1'
  delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
  delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL

  return async () => {
    if (previousCommand === undefined) {
      delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
    } else {
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = previousCommand
    }
    if (previousEntry === undefined) {
      delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
    } else {
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = previousEntry
    }
    if (previousArgsJson === undefined) {
      delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
    } else {
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = previousArgsJson
    }
    if (previousUrl === undefined) {
      delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    } else {
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = previousUrl
    }
    if (previousDataHome === undefined) {
      delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    } else {
      process.env.CLAUDE_MULTIMODEL_DATA_HOME = previousDataHome
    }
    if (previousCacheHome === undefined) {
      delete process.env.CLAUDE_MULTIMODEL_CACHE_HOME
    } else {
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME = previousCacheHome
    }
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
    }
    if (previousMcpProofCacheDisabled === undefined) {
      delete process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED
    } else {
      process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED =
        previousMcpProofCacheDisabled
    }
    await Promise.all([
      rm(dataHome, { recursive: true, force: true }),
      rm(cacheHome, { recursive: true, force: true }),
      rm(claudeConfigDir, { recursive: true, force: true }),
    ])
  }
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

  fakeLocalE2ETest('returns ready for configured local OpenAI-compatible provider', async () => {
    const restoreMcpEnv = await configureLocalMcpEnv()
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-readiness-local-fake-'))
    const fakeServer = await startFakeOpenAiCompatibleServer()
    try {
      await writeFile(
        path.join(projectPath, 'opencode.json'),
        `${JSON.stringify({
          provider: {
            'llama.cpp': {
              npm: '@ai-sdk/openai-compatible',
              options: {
                baseURL: `${fakeServer.baseUrl}/v1`,
              },
              models: {
                'qwen-test:0.5b': {},
              },
            },
          },
          model: 'llama.cpp/qwen-test:0.5b',
        }, null, 2)}\n`,
        'utf8',
      )

      const result = await runBridgeCommandAsync({
        requestId: `readiness-local-fake-${process.pid}-${Date.now()}`,
        command: 'opencode.readiness',
        projectPath,
        body: {
          selectedModel: 'llama.cpp/qwen-test:0.5b',
          requireExecutionProbe: true,
        },
      })

      const diagnosticContext = [
        result.error?.message,
        result.data?.diagnostics?.join('\n'),
        `state: ${result.data?.state ?? 'none'}`,
        `model: ${result.data?.modelId ?? 'none'}`,
        `missing: ${result.data?.missing?.join(', ') || 'none'}`,
        `available: ${result.data?.availableModels?.join(', ') || 'none'}`,
        `fake requests: ${fakeServer.requests.join(', ') || 'none'}`,
      ].filter(Boolean).join('\n')
      expect(result.ok, diagnosticContext).toBe(true)
      expect(result.data?.state, diagnosticContext).toBe('ready')
      expect(result.data?.launchAllowed, diagnosticContext).toBe(true)
      expect(result.data?.requiredToolsPresent, diagnosticContext).toBe(true)
      expect(fakeServer.requests, diagnosticContext).toContain('POST /v1/chat/completions')
    } finally {
      await runBridgeCommand({
        requestId: `cleanup-local-fake-${process.pid}-${Date.now()}`,
        command: 'opencode.cleanupHosts',
        projectPath,
        body: {
          mode: 'force',
          staleAgeMs: 0,
          leaseStaleAgeMs: 0,
          preflightLeaseStaleAgeMs: 0,
        },
      }).catch(() => undefined)
      await restoreMcpEnv()
      await fakeServer.close().catch(() => undefined)
      await rm(projectPath, { recursive: true, force: true }).catch(() => undefined)
    }
  }, BRIDGE_TIMEOUT_MS + 60_000)
})
