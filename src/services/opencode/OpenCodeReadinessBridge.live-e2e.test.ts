import { describe, expect, test } from 'bun:test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
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
const ollamaE2ETest =
  process.env.OPENCODE_READINESS_BRIDGE_OLLAMA_E2E === '1'
    ? test
    : test.skip

const LIVE_MODEL = process.env.OPENCODE_READINESS_BRIDGE_MODEL ?? 'big-pickle'
const OLLAMA_MODEL = process.env.OPENCODE_READINESS_BRIDGE_OLLAMA_MODEL ?? 'qwen2.5-coder:0.5b'
const OLLAMA_BIN = process.env.OLLAMA_BIN?.trim() || 'ollama'
const OLLAMA_BASE_URL =
  process.env.OPENCODE_READINESS_BRIDGE_OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434'
const SEQUENTIAL_ATTEMPTS = Number(process.env.OPENCODE_READINESS_BRIDGE_SEQUENTIAL_ATTEMPTS ?? '3')
const PARALLEL_ATTEMPTS = Number(process.env.OPENCODE_READINESS_BRIDGE_PARALLEL_ATTEMPTS ?? '2')
const BRIDGE_TIMEOUT_MS = Number(process.env.OPENCODE_READINESS_BRIDGE_TIMEOUT_MS ?? '180000')
const ALLOW_WINDOWS_LOCAL_MCP =
  process.env.OPENCODE_READINESS_BRIDGE_ALLOW_WINDOWS_LOCAL_MCP === '1'
const CLAUDE_TEAM_ROOT =
  process.env.OPENCODE_READINESS_BRIDGE_CLAUDE_TEAM_ROOT
  ?? path.resolve(process.cwd(), '..', 'claude_team')

type TestBridgeCommand =
  | 'opencode.cleanupHosts'
  | 'opencode.launchTeam'
  | 'opencode.readiness'
  | 'opencode.reconcileTeam'
  | 'opencode.stopTeam'

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
    teamLaunchState?: string
    stopped?: boolean
    members?: Record<string, {
      sessionId?: string
      launchState?: string
      bootstrapMode?: string
      bootstrapEvidenceSource?: string
      diagnostics?: string[]
      stopped?: boolean
    }>
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
  command: TestBridgeCommand
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
  command: TestBridgeCommand
  projectPath: string
  body?: Record<string, unknown>
}): Promise<BridgeResult> {
  const cliPath = runtimeCliPath()
  expect(existsSync(cliPath), `Compile the runtime before this live E2E: ${cliPath}`).toBe(true)

  const inputDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-input-'))
  try {
    const inputPath = path.join(inputDir, `${input.requestId}.json`)
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
  } finally {
    await rm(inputDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function runBridgeCommandAsync(input: {
  requestId: string
  command: TestBridgeCommand
  projectPath: string
  body?: Record<string, unknown>
}): Promise<BridgeResult> {
  const cliPath = runtimeCliPath()
  expect(existsSync(cliPath), `Compile the runtime before this live E2E: ${cliPath}`).toBe(true)

  const inputDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-input-'))
  try {
    const inputPath = path.join(inputDir, `${input.requestId}.json`)
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
  } finally {
    await rm(inputDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function startFakeOpenAiCompatibleServer(options: {
  chatStatus?: number
  chatErrorMessage?: string
} = {}): Promise<{
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
      if (options.chatStatus && options.chatStatus >= 400) {
        response.writeHead(options.chatStatus, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          error: {
            message: options.chatErrorMessage ?? 'fake local model unavailable',
          },
        }))
        return
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

async function writeFakeLocalOpenCodeConfig(input: {
  projectPath: string
  baseUrl: string
  model?: string
}): Promise<void> {
  const model = input.model ?? 'qwen-test:0.5b'
  await writeFile(
    path.join(input.projectPath, 'opencode.json'),
    `${JSON.stringify({
      provider: {
        'llama.cpp': {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: `${input.baseUrl}/v1`,
          },
          models: {
            [model]: {},
          },
        },
      },
      model: `llama.cpp/${model}`,
    }, null, 2)}\n`,
    'utf8',
  )
}

async function writeOllamaOpenCodeConfig(projectPath: string): Promise<void> {
  await writeFile(
    path.join(projectPath, 'opencode.json'),
    `${JSON.stringify({
      provider: {
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Ollama',
          options: {
            baseURL: `${OLLAMA_BASE_URL.replace(/\/+$/, '')}/v1`,
          },
          models: {
            [OLLAMA_MODEL]: {
              name: OLLAMA_MODEL,
            },
          },
        },
      },
      model: `ollama/${OLLAMA_MODEL}`,
      small_model: `ollama/${OLLAMA_MODEL}`,
    }, null, 2)}\n`,
    'utf8',
  )
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

async function ensureOllamaRuntime(): Promise<{ close: () => Promise<void> }> {
  if (await canReachOllama()) {
    return { close: async () => {} }
  }

  const child = spawn(OLLAMA_BIN, ['serve'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let spawnError: Error | null = null
  child.once('error', error => {
    spawnError = error
  })
  child.stdout?.on('data', chunk => {
    output = `${output}\n${String(chunk)}`.slice(-4_000)
  })
  child.stderr?.on('data', chunk => {
    output = `${output}\n${String(chunk)}`.slice(-4_000)
  })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (spawnError) {
      await stopChildProcess(child)
      throw new Error(`Failed to start ollama serve: ${spawnError.message}`)
    }
    if (await canReachOllama()) {
      return {
        close: async () => {
          await stopChildProcess(child)
        },
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`ollama serve exited with code ${child.exitCode}. Output: ${output}`)
    }
    await sleep(250)
  }

  await stopChildProcess(child)
  throw new Error(`Timed out waiting for ollama serve at ${OLLAMA_BASE_URL}. Output: ${output}`)
}

async function canReachOllama(): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_000)
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/version`, {
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function hasOllamaModel(model: string): boolean {
  const result = spawnSync(OLLAMA_BIN, ['list'], {
    env: process.env,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  })
  expect(
    result.error,
    `ollama list failed to start: ${result.error?.message ?? 'unknown'}`,
  ).toBeUndefined()
  expect(
    result.status,
    `ollama list failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0)
  return String(result.stdout ?? '')
    .split('\n')
    .some(line => line.trim().split(/\s+/)[0] === model)
}

function ensureOllamaModel(model: string): void {
  if (hasOllamaModel(model)) {
    return
  }
  if (process.env.OPENCODE_READINESS_BRIDGE_OLLAMA_PULL !== '1') {
    throw new Error(
      `Ollama model "${model}" is not installed. Run "ollama pull ${model}" first or set OPENCODE_READINESS_BRIDGE_OLLAMA_PULL=1 for this gated smoke.`,
    )
  }

  const result = spawnSync(OLLAMA_BIN, ['pull', model], {
    env: process.env,
    encoding: 'utf8',
    timeout: Number(process.env.OPENCODE_READINESS_BRIDGE_OLLAMA_PULL_TIMEOUT_MS ?? '1200000'),
    maxBuffer: 10 * 1024 * 1024,
  })
  expect(
    result.error,
    `ollama pull failed to start: ${result.error?.message ?? 'unknown'}`,
  ).toBeUndefined()
  expect(
    result.status,
    `ollama pull ${model} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0)
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  child.kill('SIGTERM')
  const closed = await Promise.race([
    once(child, 'close').then(() => true),
    sleep(3_000).then(() => false),
  ])
  if (!closed && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([
      once(child, 'close'),
      sleep(1_000),
    ])
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

async function configureBrokenLocalMcpEnv(): Promise<() => Promise<void>> {
  const previousCommand = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
  const previousEntry = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
  const previousArgsJson = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
  const previousUrl = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
  const previousDataHome = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  const previousCacheHome = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  const previousMcpProofCacheDisabled =
    process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED
  const previousMcpPreflightTimeout = process.env.AGENT_TEAMS_OPENCODE_MCP_PREFLIGHT_TIMEOUT_MS
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'opencode-readiness-broken-mcp-data-'))
  const cacheHome = await mkdtemp(path.join(os.tmpdir(), 'opencode-readiness-broken-mcp-cache-'))
  const claudeConfigDir =
    await mkdtemp(path.join(os.tmpdir(), 'opencode-readiness-broken-mcp-claude-config-'))
  const brokenMcpPath = path.join(dataHome, 'broken-agent-teams-mcp.js')
  await writeFile(brokenMcpPath, 'process.exit(1)\n', 'utf8')

  process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = process.execPath
  process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = brokenMcpPath
  process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = JSON.stringify([brokenMcpPath])
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = dataHome
  process.env.CLAUDE_MULTIMODEL_CACHE_HOME = cacheHome
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
  process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED = '1'
  process.env.AGENT_TEAMS_OPENCODE_MCP_PREFLIGHT_TIMEOUT_MS = '1000'
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
    if (previousMcpPreflightTimeout === undefined) {
      delete process.env.AGENT_TEAMS_OPENCODE_MCP_PREFLIGHT_TIMEOUT_MS
    } else {
      process.env.AGENT_TEAMS_OPENCODE_MCP_PREFLIGHT_TIMEOUT_MS =
        previousMcpPreflightTimeout
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
      await writeFakeLocalOpenCodeConfig({
        projectPath,
        baseUrl: fakeServer.baseUrl,
      })

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
      const requestCountAfterProof = fakeServer.requests.length
      const compatibilityResult = await runBridgeCommandAsync({
        requestId: `readiness-local-no-proof-${process.pid}-${Date.now()}`,
        command: 'opencode.readiness',
        projectPath,
        body: {
          selectedModel: 'llama.cpp/qwen-test:0.5b',
          requireExecutionProbe: false,
        },
      })

      const compatibilityDiagnosticContext = [
        compatibilityResult.error?.message,
        compatibilityResult.data?.diagnostics?.join('\n'),
        `state: ${compatibilityResult.data?.state ?? 'none'}`,
        `missing: ${compatibilityResult.data?.missing?.join(', ') || 'none'}`,
        `fake requests: ${fakeServer.requests.join(', ') || 'none'}`,
      ].filter(Boolean).join('\n')
      expect(compatibilityResult.ok, compatibilityDiagnosticContext).toBe(true)
      expect(compatibilityResult.data?.state, compatibilityDiagnosticContext).toBe(
        'not_authenticated',
      )
      expect(compatibilityResult.data?.launchAllowed, compatibilityDiagnosticContext).toBe(false)
      expect(compatibilityResult.data?.requiredToolsPresent, compatibilityDiagnosticContext).toBe(
        true,
      )
      expect(fakeServer.requests.length, compatibilityDiagnosticContext).toBe(requestCountAfterProof)
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

  fakeLocalE2ETest('returns model unavailable when selected configured local model is unknown', async () => {
    const restoreMcpEnv = await configureLocalMcpEnv()
    const projectPath =
      await mkdtemp(path.join(os.tmpdir(), 'opencode-readiness-local-unknown-model-'))
    const fakeServer = await startFakeOpenAiCompatibleServer()
    try {
      await writeFakeLocalOpenCodeConfig({
        projectPath,
        baseUrl: fakeServer.baseUrl,
      })

      const result = await runBridgeCommandAsync({
        requestId: `readiness-local-unknown-model-${process.pid}-${Date.now()}`,
        command: 'opencode.readiness',
        projectPath,
        body: {
          selectedModel: 'llama.cpp/missing-test:0.5b',
          requireExecutionProbe: true,
        },
      })

      const diagnosticContext = [
        result.error?.message,
        result.data?.diagnostics?.join('\n'),
        `state: ${result.data?.state ?? 'none'}`,
        `missing: ${result.data?.missing?.join(', ') || 'none'}`,
        `fake requests: ${fakeServer.requests.join(', ') || 'none'}`,
      ].filter(Boolean).join('\n')
      expect(result.ok, diagnosticContext).toBe(true)
      expect(result.data?.state, diagnosticContext).toBe('model_unavailable')
      expect(result.data?.launchAllowed, diagnosticContext).toBe(false)
      expect(
        fakeServer.requests.some(request => request === 'POST /v1/chat/completions'),
        diagnosticContext,
      ).toBe(false)
    } finally {
      await runBridgeCommand({
        requestId: `cleanup-local-unknown-model-${process.pid}-${Date.now()}`,
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

  fakeLocalE2ETest('launches, reconciles, and stops a configured local OpenAI-compatible teammate', async () => {
    const restoreMcpEnv = await configureLocalMcpEnv()
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-local-launch-fake-'))
    const fakeServer = await startFakeOpenAiCompatibleServer()
    const teamName = `local-launch-${process.pid}-${Date.now()}`
    const runId = `run-${teamName}`
    const laneId = 'primary'
    try {
      await writeFakeLocalOpenCodeConfig({
        projectPath,
        baseUrl: fakeServer.baseUrl,
      })

      const launchResult = await runBridgeCommandAsync({
        requestId: `launch-local-fake-${process.pid}-${Date.now()}`,
        command: 'opencode.launchTeam',
        projectPath,
        body: {
          runId,
          laneId,
          teamId: teamName,
          teamName,
          selectedModel: 'llama.cpp/qwen-test:0.5b',
          members: [
            {
              name: 'bob',
              role: 'Developer',
              prompt: 'Join the local launch smoke. Wait for app MCP task delivery.',
            },
          ],
        },
      })

      const launchDiagnosticContext = [
        launchResult.error?.message,
        launchResult.data?.diagnostics?.join('\n'),
        `teamLaunchState: ${launchResult.data?.teamLaunchState ?? 'none'}`,
        `bob: ${JSON.stringify(launchResult.data?.members?.bob ?? null)}`,
        `fake requests: ${fakeServer.requests.join(', ') || 'none'}`,
      ].filter(Boolean).join('\n')
      expect(launchResult.ok, launchDiagnosticContext).toBe(true)
      expect(launchResult.data?.teamLaunchState, launchDiagnosticContext).toBe('launching')
      expect(launchResult.data?.members?.bob?.launchState, launchDiagnosticContext).toBe('created')
      expect(launchResult.data?.members?.bob?.bootstrapMode, launchDiagnosticContext).toBe(
        'app_managed_context',
      )
      expect(
        launchResult.data?.members?.bob?.bootstrapEvidenceSource,
        launchDiagnosticContext,
      ).toBe('app_managed_bootstrap')
      expect(fakeServer.requests, launchDiagnosticContext).toContain('POST /v1/chat/completions')

      const reconcileResult = await runBridgeCommandAsync({
        requestId: `reconcile-local-fake-${process.pid}-${Date.now()}`,
        command: 'opencode.reconcileTeam',
        projectPath,
        body: {
          runId,
          laneId,
          teamId: teamName,
          teamName,
          expectedMembers: [{ name: 'bob', model: 'llama.cpp/qwen-test:0.5b' }],
        },
      })

      const reconcileDiagnosticContext = [
        reconcileResult.error?.message,
        reconcileResult.data?.diagnostics?.join('\n'),
        `teamLaunchState: ${reconcileResult.data?.teamLaunchState ?? 'none'}`,
        `bob: ${JSON.stringify(reconcileResult.data?.members?.bob ?? null)}`,
      ].filter(Boolean).join('\n')
      expect(reconcileResult.ok, reconcileDiagnosticContext).toBe(true)
      expect(reconcileResult.data?.teamLaunchState, reconcileDiagnosticContext).toBe('ready')
      expect(reconcileResult.data?.members?.bob?.launchState, reconcileDiagnosticContext).toBe(
        'confirmed_alive',
      )

      const stopResult = await runBridgeCommandAsync({
        requestId: `stop-local-fake-${process.pid}-${Date.now()}`,
        command: 'opencode.stopTeam',
        projectPath,
        body: {
          runId,
          laneId,
          teamId: teamName,
          teamName,
        },
      })

      const stopDiagnosticContext = [
        stopResult.error?.message,
        stopResult.data?.diagnostics?.join('\n'),
        `stopped: ${String(stopResult.data?.stopped)}`,
        `bob: ${JSON.stringify(stopResult.data?.members?.bob ?? null)}`,
      ].filter(Boolean).join('\n')
      expect(stopResult.ok, stopDiagnosticContext).toBe(true)
      expect(stopResult.data?.stopped, stopDiagnosticContext).toBe(true)
      expect(stopResult.data?.members?.bob?.stopped, stopDiagnosticContext).toBe(true)
    } finally {
      await runBridgeCommand({
        requestId: `cleanup-local-launch-${process.pid}-${Date.now()}`,
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
  }, (BRIDGE_TIMEOUT_MS * 2) + 60_000)

  fakeLocalE2ETest('rejects configured local launch for an unknown model before session creation', async () => {
    const restoreMcpEnv = await configureLocalMcpEnv()
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-local-launch-unknown-'))
    const fakeServer = await startFakeOpenAiCompatibleServer()
    const teamName = `local-launch-unknown-${process.pid}-${Date.now()}`
    try {
      await writeFakeLocalOpenCodeConfig({
        projectPath,
        baseUrl: fakeServer.baseUrl,
      })

      const result = await runBridgeCommandAsync({
        requestId: `launch-local-unknown-${process.pid}-${Date.now()}`,
        command: 'opencode.launchTeam',
        projectPath,
        body: {
          runId: `run-${teamName}`,
          laneId: 'primary',
          teamId: teamName,
          teamName,
          selectedModel: 'llama.cpp/missing-test:0.5b',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Should not launch.' }],
        },
      })

      const diagnosticContext = [
        result.error?.message,
        result.data?.diagnostics?.join('\n'),
        `fake requests: ${fakeServer.requests.join(', ') || 'none'}`,
      ].filter(Boolean).join('\n')
      expect(result.ok, diagnosticContext).toBe(false)
      expect(result.error?.message, diagnosticContext).toContain(
        'llama.cpp/missing-test:0.5b',
      )
      expect(
        fakeServer.requests.some(request => request === 'POST /v1/chat/completions'),
        diagnosticContext,
      ).toBe(false)
    } finally {
      await runBridgeCommand({
        requestId: `cleanup-local-launch-unknown-${process.pid}-${Date.now()}`,
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

  fakeLocalE2ETest('returns MCP unavailable quickly for configured local provider when Agent Teams MCP preflight fails', async () => {
    const restoreMcpEnv = await configureBrokenLocalMcpEnv()
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-readiness-local-mcp-fail-'))
    const fakeServer = await startFakeOpenAiCompatibleServer()
    try {
      await writeFakeLocalOpenCodeConfig({
        projectPath,
        baseUrl: fakeServer.baseUrl,
      })

      const startedAt = Date.now()
      const result = await runBridgeCommandAsync({
        requestId: `readiness-local-mcp-fail-${process.pid}-${Date.now()}`,
        command: 'opencode.readiness',
        projectPath,
        body: {
          selectedModel: 'llama.cpp/qwen-test:0.5b',
          requireExecutionProbe: true,
        },
      })
      const elapsedMs = Date.now() - startedAt

      const diagnosticContext = [
        result.error?.message,
        result.data?.diagnostics?.join('\n'),
        `state: ${result.data?.state ?? 'none'}`,
        `missing: ${result.data?.missing?.join(', ') || 'none'}`,
        `elapsedMs: ${elapsedMs}`,
        `fake requests: ${fakeServer.requests.join(', ') || 'none'}`,
      ].filter(Boolean).join('\n')
      expect(result.ok, diagnosticContext).toBe(true)
      expect(result.data?.state, diagnosticContext).toBe('mcp_unavailable')
      expect(result.data?.launchAllowed, diagnosticContext).toBe(false)
      expect(result.data?.requiredToolsPresent, diagnosticContext).toBe(false)
      expect(result.data?.diagnostics?.join('\n'), diagnosticContext).toContain(
        'Skipped OpenCode host startup and model verification because Agent Teams MCP direct preflight failed',
      )
      expect(fakeServer.requests, diagnosticContext).toEqual([])
      expect(elapsedMs, diagnosticContext).toBeLessThan(30_000)
    } finally {
      await runBridgeCommand({
        requestId: `cleanup-local-mcp-fail-${process.pid}-${Date.now()}`,
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

  ollamaE2ETest('returns ready for configured local Ollama provider', async () => {
    const restoreMcpEnv = await configureLocalMcpEnv()
    const ollamaRuntime = await ensureOllamaRuntime()
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-readiness-ollama-'))
    try {
      ensureOllamaModel(OLLAMA_MODEL)
      await writeOllamaOpenCodeConfig(projectPath)

      const result = await runBridgeCommandAsync({
        requestId: `readiness-ollama-${process.pid}-${Date.now()}`,
        command: 'opencode.readiness',
        projectPath,
        body: {
          selectedModel: `ollama/${OLLAMA_MODEL}`,
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
      ].filter(Boolean).join('\n')
      expect(result.ok, diagnosticContext).toBe(true)
      expect(result.data?.state, diagnosticContext).toBe('ready')
      expect(result.data?.launchAllowed, diagnosticContext).toBe(true)
      expect(result.data?.requiredToolsPresent, diagnosticContext).toBe(true)
    } finally {
      await runBridgeCommand({
        requestId: `cleanup-ollama-${process.pid}-${Date.now()}`,
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
      await ollamaRuntime.close().catch(() => undefined)
      await rm(projectPath, { recursive: true, force: true }).catch(() => undefined)
    }
  }, BRIDGE_TIMEOUT_MS + 60_000)

  ollamaE2ETest('keeps configured local Ollama provider ready across repeated deep readiness checks', async () => {
    const restoreMcpEnv = await configureLocalMcpEnv()
    const ollamaRuntime = await ensureOllamaRuntime()
    const projectPath =
      await mkdtemp(path.join(os.tmpdir(), 'opencode-readiness-ollama-repeated-'))
    try {
      ensureOllamaModel(OLLAMA_MODEL)
      await writeOllamaOpenCodeConfig(projectPath)

      for (let index = 0; index < 2; index += 1) {
        const result = await runBridgeCommandAsync({
          requestId: `readiness-ollama-repeated-${index}-${process.pid}-${Date.now()}`,
          command: 'opencode.readiness',
          projectPath,
          body: {
            selectedModel: `ollama/${OLLAMA_MODEL}`,
            requireExecutionProbe: true,
          },
        })

        const diagnosticContext = [
          result.error?.message,
          result.data?.diagnostics?.join('\n'),
          `attempt: ${index}`,
          `state: ${result.data?.state ?? 'none'}`,
          `model: ${result.data?.modelId ?? 'none'}`,
          `missing: ${result.data?.missing?.join(', ') || 'none'}`,
          `available: ${result.data?.availableModels?.join(', ') || 'none'}`,
        ].filter(Boolean).join('\n')
        expect(result.ok, diagnosticContext).toBe(true)
        expect(result.data?.state, diagnosticContext).toBe('ready')
        expect(result.data?.launchAllowed, diagnosticContext).toBe(true)
        expect(result.data?.requiredToolsPresent, diagnosticContext).toBe(true)
      }
    } finally {
      await runBridgeCommand({
        requestId: `cleanup-ollama-repeated-${process.pid}-${Date.now()}`,
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
      await ollamaRuntime.close().catch(() => undefined)
      await rm(projectPath, { recursive: true, force: true }).catch(() => undefined)
    }
  }, (BRIDGE_TIMEOUT_MS * 2) + 60_000)
})
