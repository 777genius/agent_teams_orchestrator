import { describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  collectOpenCodeInventoryCommandResults,
  createOpenCodeInventoryProbeProgressTracker,
  execOpenCodePortableCommand,
  filterOpenCodeConnectedProvidersForRuntime,
  getOpenCodeRefreshModelsArgs,
  getOpenCodeVerboseModelsArgs,
  OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS,
  OPEN_CODE_INVENTORY_SUMMARY_TIMEOUT_MS,
  OPEN_CODE_PROBE_TIMEOUT_MS,
  OpenCodeInventoryService,
  isOpenCodeBuiltinFreeModelId,
  isOpenCodeInventoryTimeoutSnapshot,
  parseOpenCodeAgentListOutput,
  isOpenCodeModelFree,
  parseOpenCodeModelsOutput,
  parseOpenCodeModelsVerboseOutput,
  parseOpenCodeProvidersOutput,
  resolveOpenCodeModelsWithFallback,
  runOpenCodeInventoryPreparedProfileProbe,
  supportsOpenCodeSuperGrokOAuth,
  withOpenCodeInventoryProbeTimeout,
} from './OpenCodeInventoryService.js'

import type { OpenCodeInventorySnapshot, OpenCodePreparedProfile } from './types.js'

async function waitForFile(filePath: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(filePath)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

function inventorySnapshot(
  overrides: Partial<OpenCodeInventorySnapshot> = {},
): OpenCodeInventorySnapshot {
  return {
    detected: true,
    binaryPath: '/tmp/opencode',
    version: '1.15.6',
    projectPath: '/tmp/project',
    profile: null,
    connectedProviders: [],
    availableProviders: [],
    models: [],
    modelMetadata: [],
    agents: [],
    authStorePath: null,
    probeError: null,
    diagnostics: [],
    ...overrides,
  }
}

describe('OpenCodeInventoryService parsers', () => {
  test('publishes one canonical project identity for a symlink alias', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'opencode-inventory-canonical-'))
    try {
      const project = path.join(root, 'project')
      const alias = path.join(root, 'alias')
      await mkdir(project)
      await symlink(project, alias, 'dir')
      const snapshot = await new OpenCodeInventoryService().probe(alias, { mode: 'summary' })
      expect(snapshot.projectPath).toBe(await realpath(project))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('requires an OpenCode version with native SuperGrok OAuth support', () => {
    expect(supportsOpenCodeSuperGrokOAuth('1.15.6')).toBe(false)
    expect(supportsOpenCodeSuperGrokOAuth('v1.15.7')).toBe(true)
    expect(supportsOpenCodeSuperGrokOAuth('opencode 1.17.18')).toBe(true)
    expect(supportsOpenCodeSuperGrokOAuth(null)).toBe(false)
  })

  test('filters unsupported SuperGrok OAuth without hiding xAI API credentials', () => {
    const providers = [
      { id: 'xai', authHint: 'oauth', source: 'credentials' as const },
      { id: 'xai', authHint: 'xai_api_key', source: 'environment' as const },
      { id: 'openai', authHint: 'oauth', source: 'credentials' as const },
    ]

    expect(filterOpenCodeConnectedProvidersForRuntime({
      providers,
      version: '1.15.6',
    })).toEqual({
      connectedProviders: [providers[1], providers[2]],
      unsupportedSuperGrokOAuth: true,
    })
    expect(filterOpenCodeConnectedProvidersForRuntime({
      providers,
      version: '1.15.7',
    })).toEqual({
      connectedProviders: providers,
      unsupportedSuperGrokOAuth: false,
    })
    expect(filterOpenCodeConnectedProvidersForRuntime({
      providers,
      version: null,
    })).toEqual({
      connectedProviders: providers,
      unsupportedSuperGrokOAuth: false,
    })
  })

  test('keeps the full inventory timeout aligned with sequential OpenCode probes', () => {
    expect(OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS).toBeGreaterThan(
      OPEN_CODE_INVENTORY_SUMMARY_TIMEOUT_MS,
    )
    expect(OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS).toBeGreaterThanOrEqual(
      OPEN_CODE_PROBE_TIMEOUT_MS * 5,
    )
  })

  test('queries the full OpenCode model inventory, not only the opencode provider', () => {
    expect(getOpenCodeVerboseModelsArgs()).toEqual(['models', '--verbose'])
    expect(getOpenCodeRefreshModelsArgs()).toEqual(['models', 'opencode', '--refresh'])
  })

  test('forces OpenCode to refresh models instead of reusing a prewarmed catalog result', async () => {
    const calls: string[] = []
    const result = await collectOpenCodeInventoryCommandResults({
      mode: 'full',
      refreshModels: true,
      modelsResult: { stdout: 'stale/prewarmed-model', stderr: '', code: 0 },
      execOpenCode: async args => {
        calls.push(args.join(' '))
        return { stdout: args.join(' '), stderr: '', code: 0 }
      },
    })

    expect(calls).toEqual(['providers list', 'models opencode --refresh'])
    expect(result.versionResult.stdout).toBe('')
    expect(result.modelsResult.stdout).toBe('models opencode --refresh')
    expect(result.agentsResult.stdout).toBe('')
  })

  test('collects inventory commands sequentially to avoid OpenCode profile contention', async () => {
    const calls: string[] = []
    let active = 0
    let maxActive = 0

    const result = await collectOpenCodeInventoryCommandResults({
      mode: 'full',
      execOpenCode: async args => {
        active += 1
        maxActive = Math.max(maxActive, active)
        calls.push(args.join(' '))
        await new Promise(resolve => setTimeout(resolve, 5))
        active -= 1
        return {
          stdout: args.join(' '),
          stderr: '',
          code: 0,
        }
      },
    })

    expect(maxActive).toBe(1)
    expect(calls).toEqual(['--version', 'providers list', 'models --verbose', 'agent list'])
    expect(result.modelsResult.stdout).toBe('models --verbose')
    expect(result.agentsResult.stdout).toBe('agent list')
  })

  test('preserves a failed verbose models result without running the plain fallback', async () => {
    const original = {
      stdout: '',
      stderr: 'verbose probe failed',
      code: 1,
      error: 'OpenCode command timed out after 15000ms',
    }
    let fallbackCalls = 0

    const result = await resolveOpenCodeModelsWithFallback({
      mode: 'full',
      modelsResult: original,
      execOpenCode: async () => {
        fallbackCalls += 1
        return { stdout: 'openai/gpt-5.4', stderr: '', code: 0 }
      },
    })

    expect(fallbackCalls).toBe(0)
    expect(result.modelsResult).toBe(original)
    expect(result.modelsResult.error).toBe('OpenCode command timed out after 15000ms')
  })

  test('preserves a non-timeout verbose models failure without running the plain fallback', async () => {
    const original = { stdout: '', stderr: 'provider catalog failed', code: 1 }
    let fallbackCalls = 0

    const result = await resolveOpenCodeModelsWithFallback({
      mode: 'full',
      modelsResult: original,
      execOpenCode: async () => {
        fallbackCalls += 1
        return { stdout: 'openai/gpt-5.4', stderr: '', code: 0 }
      },
    })

    expect(fallbackCalls).toBe(0)
    expect(result.modelsResult).toBe(original)
    expect(result.modelsResult.stderr).toBe('provider catalog failed')
  })

  test('runs the plain models fallback only for a successful empty verbose result', async () => {
    const calls: string[] = []
    const result = await resolveOpenCodeModelsWithFallback({
      mode: 'full',
      modelsResult: { stdout: '', stderr: '', code: 0 },
      execOpenCode: async args => {
        calls.push(args.join(' '))
        return { stdout: 'openai/gpt-5.4', stderr: '', code: 0 }
      },
    })

    expect(calls).toEqual(['models'])
    expect(result.models).toEqual(['openai/gpt-5.4'])
  })

  test('does not treat an empty refresh result as an empty verbose probe', async () => {
    let fallbackCalls = 0
    const result = await resolveOpenCodeModelsWithFallback({
      mode: 'full',
      refreshModels: true,
      modelsResult: { stdout: '', stderr: '', code: 0 },
      execOpenCode: async () => {
        fallbackCalls += 1
        return { stdout: 'openai/gpt-5.4', stderr: '', code: 0 }
      },
    })

    expect(fallbackCalls).toBe(0)
    expect(result.models).toEqual([])
  })

  test('returns a degraded inventory snapshot when OpenCode probing stalls', async () => {
    const result = await withOpenCodeInventoryProbeTimeout(new Promise(() => {}), {
      projectPath: '/tmp/project',
      timeoutMs: 1,
    })

    expect(isOpenCodeInventoryTimeoutSnapshot(result)).toBe(true)
    expect(result.projectPath).toBe(path.resolve('/tmp/project'))
    expect(result.probeError).toBe('OpenCode inventory probe timed out after 1ms')
    expect(result.models).toEqual([])
    expect(result.diagnostics).toContain(
      'Agent Teams runtime stayed alive, but OpenCode did not finish inventory probing before the UI timeout budget.',
    )
    expect(result.diagnostics.join('\n')).toContain('Common causes:')
  })

  test('keeps the completed inventory snapshot when probing finishes before the timeout', async () => {
    let timedOut = false
    const completed = inventorySnapshot({
      connectedProviders: [{ id: 'openrouter', authHint: 'api', source: 'credentials' }],
      models: ['openrouter/openai/gpt-5.4'],
    })

    const result = await withOpenCodeInventoryProbeTimeout(Promise.resolve(completed), {
      projectPath: '/tmp/project',
      timeoutMs: 50,
      onTimeout: () => {
        timedOut = true
      },
    })

    expect(result).toBe(completed)
    expect(timedOut).toBe(false)
    expect(isOpenCodeInventoryTimeoutSnapshot(result)).toBe(false)
  })

  test('reports the active OpenCode inventory step and aborts on probe timeout', async () => {
    let now = 100
    const progress = createOpenCodeInventoryProbeProgressTracker(() => now)
    let aborted = false
    const leavePrepare = progress.enterStep('prepare managed OpenCode profile')
    now += 3
    leavePrepare()
    progress.enterStep('opencode providers list')
    now += 41

    const result = await withOpenCodeInventoryProbeTimeout(new Promise(() => {}), {
      projectPath: '/tmp/project',
      timeoutMs: 1,
      progress,
      onTimeout: () => {
        aborted = true
      },
    })

    expect(aborted).toBe(true)
    expect(result.probeError).toBe(
      'OpenCode inventory probe timed out after 1ms during opencode providers list',
    )
    expect(result.diagnostics).toContain(
      'Current OpenCode inventory step: opencode providers list has been running for 41ms.',
    )
    expect(result.diagnostics).toContain(
      'Completed OpenCode inventory steps before timeout: prepare managed OpenCode profile (3ms).',
    )
  })

  test('summary inventory skips model and agent commands', async () => {
    const calls: string[] = []

    const result = await collectOpenCodeInventoryCommandResults({
      mode: 'summary',
      execOpenCode: async args => {
        calls.push(args.join(' '))
        return {
          stdout: args.join(' '),
          stderr: '',
          code: 0,
        }
      },
    })

    expect(calls).toEqual(['--version', 'providers list'])
    expect(result.modelsResult.stdout).toBe('')
    expect(result.agentsResult.stdout).toBe('')
  })

  test('profile inventory prepares auth and config state without spawning OpenCode CLI probes', async () => {
    const calls: string[] = []

    const result = await collectOpenCodeInventoryCommandResults({
      mode: 'profile',
      execOpenCode: async args => {
        calls.push(args.join(' '))
        return { stdout: args.join(' '), stderr: '', code: 0 }
      },
    })

    expect(calls).toEqual([])
    expect(result.versionResult.stdout).toBe('')
    expect(result.providersResult.stdout).toBe('')
    expect(result.modelsResult.stdout).toBe('')
    expect(result.agentsResult.stdout).toBe('')
  })

  test('profile inventory does not enter the inventory command lock', async () => {
    let lockCalls = 0
    let probeCalls = 0
    const result = await runOpenCodeInventoryPreparedProfileProbe({
      mode: 'profile',
      profile: {} as OpenCodePreparedProfile,
      probe: async () => {
        probeCalls += 1
        return 'prepared'
      },
      withCommandLock: async (_profile, callback) => {
        lockCalls += 1
        return callback()
      },
    })

    expect(result).toBe('prepared')
    expect(probeCalls).toBe(1)
    expect(lockCalls).toBe(0)
  })

  test('portable inventory command runner captures stdout and stderr', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'opencode-inventory-runner-'))
    try {
      const scriptPath = path.join(tempDir, 'echo-env.js')
      await writeFile(
        scriptPath,
        [
          'process.stdout.write(JSON.stringify({',
          '  cwd: process.cwd(),',
          '  arg: process.argv[2],',
          '  env: process.env.OPENCODE_TEST_ENV,',
          '}) + "\\n")',
          'process.stderr.write("inventory warning\\n")',
          '',
        ].join('\n'),
        'utf8',
      )
      const result = await execOpenCodePortableCommand({
        binaryPath: process.execPath,
        args: [scriptPath, 'hello'],
        profile: {
          projectPath: tempDir,
          env: {
            ...process.env,
            OPENCODE_TEST_ENV: 'present',
          },
        } as unknown as OpenCodePreparedProfile,
      })

      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        cwd: await realpath(tempDir),
        arg: 'hello',
        env: 'present',
      })
      expect(result.stderr).toBe('inventory warning')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('portable inventory command runner times out with partial diagnostics', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'opencode-inventory-timeout-'))
    try {
      const scriptPath = path.join(tempDir, 'hang.js')
      await writeFile(
        scriptPath,
        [
          'const fs = require("node:fs")',
          'fs.writeSync(1, "started\\n")',
          'fs.writeSync(2, "warming up\\n")',
          'setTimeout(() => {}, 5000)',
          '',
        ].join('\n'),
        'utf8',
      )

      const result = await execOpenCodePortableCommand({
        binaryPath: process.execPath,
        args: [scriptPath],
        profile: {
          projectPath: tempDir,
          env: process.env,
        } as OpenCodePreparedProfile,
        timeoutMs: 2_000,
      })

      expect(result.code).toBe(1)
      expect(result.error).toBe('OpenCode command timed out after 2000ms')
      expect(result.stdout).toBe('started')
      expect(result.stderr).toBe('warming up')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('portable inventory command runner honors a pre-aborted signal before spawning', async () => {
    const abortController = new AbortController()
    abortController.abort()

    const result = await execOpenCodePortableCommand({
      binaryPath: path.join(tmpdir(), 'missing-opencode-binary'),
      args: ['--version'],
      profile: {
        projectPath: tmpdir(),
        env: process.env,
      } as unknown as OpenCodePreparedProfile,
      abortSignal: abortController.signal,
      timeoutMs: 5_000,
    })

    expect(result.code).toBe(1)
    expect(result.error).toBe('OpenCode command aborted')
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  test('portable inventory command runner surfaces spawn failures', async () => {
    const result = await execOpenCodePortableCommand({
      binaryPath: path.join(tmpdir(), 'missing-opencode-binary'),
      args: ['--version'],
      profile: {
        projectPath: tmpdir(),
        env: process.env,
      } as unknown as OpenCodePreparedProfile,
      timeoutMs: 5_000,
    })

    expect(result.code).toBe(1)
    expect(result.error).toContain('ENOENT')
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  test('portable inventory command runner aborts with partial diagnostics', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'opencode-inventory-abort-'))
    try {
      const scriptPath = path.join(tempDir, 'abort.js')
      const readyPath = path.join(tempDir, 'ready')
      await writeFile(
        scriptPath,
        [
          'const fs = require("node:fs")',
          'fs.writeSync(1, "started\\n")',
          'fs.writeSync(2, "waiting\\n")',
          `fs.writeFileSync(${JSON.stringify(readyPath)}, "1")`,
          'setInterval(() => {}, 1000)',
          '',
        ].join('\n'),
        'utf8',
      )
      const abortController = new AbortController()
      const resultPromise = execOpenCodePortableCommand({
        binaryPath: process.execPath,
        args: [scriptPath],
        profile: {
          projectPath: tempDir,
          env: process.env,
        } as OpenCodePreparedProfile,
        abortSignal: abortController.signal,
        timeoutMs: 5_000,
      })

      await waitForFile(readyPath)
      abortController.abort()
      const result = await resultPromise

      expect(result.code).toBe(1)
      expect(result.error).toBe('OpenCode command aborted')
      expect(result.stdout).toBe('started')
      expect(result.stderr).toBe('waiting')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('parses provider credentials from boxed CLI output', () => {
    const output = `
┌  Credentials /tmp/opencode/auth.json
│
●  OpenAI oauth
│
●  OpenRouter api
│
●  Cloudflare Workers AI
│
●  MiniMax Token Plan (minimax.io) api
│
●  Xiaomi Token Plan (Singapore) api
│
●  Z.AI Coding Plan api
│
└  1 credentials

┌  Environment
│
●  OpenAI OPENAI_API_KEY
│
└  1 environment variable
`

    const parsed = parseOpenCodeProvidersOutput(output)

    expect(parsed.authStorePath).toBe('/tmp/opencode/auth.json')
    expect(parsed.connectedProviders).toEqual([
      {
        id: 'openai',
        authHint: 'oauth',
        source: 'credentials',
      },
      {
        id: 'openrouter',
        authHint: 'api',
        source: 'credentials',
      },
      {
        id: 'cloudflare-workers-ai',
        authHint: null,
        source: 'credentials',
      },
      {
        id: 'minimax-coding-plan',
        authHint: 'api',
        source: 'credentials',
      },
      {
        id: 'xiaomi-token-plan-sgp',
        authHint: 'api',
        source: 'credentials',
      },
      {
        id: 'zai-coding-plan',
        authHint: 'api',
        source: 'credentials',
      },
      {
        id: 'openai',
        authHint: 'openai_api_key',
        source: 'environment',
      },
    ])
  })

  test('parses model and agent output', () => {
    expect(
      parseOpenCodeModelsOutput(
        [
          'openai/gpt-5.4',
          'openrouter/moonshotai/kimi-k2',
          'opencode/qwen3.6-plus-free',
          'llama.cpp/qwen3-coder:a3b Local model',
          'ollama/qwen2.5-coder:0.5b 12 GB',
          'ollama/kimi-k2.6:cloud Ollama Cloud model',
          'lmstudio/google/gemma-3n-e4b ready',
        ].join('\n'),
      ),
    ).toEqual([
      'openai/gpt-5.4',
      'openrouter/moonshotai/kimi-k2',
      'opencode/qwen3.6-plus-free',
      'llama.cpp/qwen3-coder:a3b',
      'ollama/qwen2.5-coder:0.5b',
      'ollama/kimi-k2.6:cloud',
      'lmstudio/google/gemma-3n-e4b',
    ])

    expect(parseOpenCodeAgentListOutput('build (primary)\nexplore (subagent)\n')).toEqual([
      { id: 'build', mode: 'primary' },
      { id: 'explore', mode: 'subagent' },
    ])
  })

  test('parses verbose model metadata and detects free cost', () => {
    const parsed = parseOpenCodeModelsVerboseOutput(`
opencode/big-pickle
{
  "status": "beta",
  "cost": {
    "input": 0,
    "output": 0,
    "cache": { "read": 0, "write": 0 }
  },
  "limit": { "context": 200000 }
}
openai/gpt-5.4
{
  "deprecated": true,
  "cost": {
    "input": 0.25,
    "output": 1
  }
}
openrouter/anthropic/claude-haiku-4.5
{
  "cost": {
    "input": 0,
    "output": 0
  }
}
openrouter/openai/gpt-oss-20b:free
{
  "cost": {
    "input": 0,
    "output": 0
  }
}
llama.cpp/qwen3-coder:a3b local
{
  "cost": {
    "input": 0,
    "output": 0
  },
  "limits": { "context": 32768 }
}
`)

    expect(parsed.models).toEqual([
      'opencode/big-pickle',
      'openai/gpt-5.4',
      'openrouter/anthropic/claude-haiku-4.5',
      'openrouter/openai/gpt-oss-20b:free',
      'llama.cpp/qwen3-coder:a3b',
    ])
    expect(parsed.modelMetadata[0]?.context).toBe(200000)
    expect(parsed.modelMetadata[0]?.limits).toEqual({ context: 200000 })
    expect(parsed.modelMetadata[0]?.catalogStatus).toBe('beta')
    expect(parsed.modelMetadata[1]?.catalogStatus).toBe('deprecated')
    expect(parsed.modelMetadata[2]?.catalogStatus).toBe('active')
    expect(isOpenCodeBuiltinFreeModelId('opencode/big-pickle', parsed.modelMetadata)).toBe(true)
    expect(isOpenCodeBuiltinFreeModelId(' openai/gpt-5.4 ', parsed.modelMetadata)).toBe(false)
    expect(isOpenCodeModelFree('opencode/big-pickle', parsed.modelMetadata)).toBe(true)
    expect(isOpenCodeModelFree('openai/gpt-5.4', parsed.modelMetadata)).toBe(false)
    expect(isOpenCodeModelFree('openrouter/anthropic/claude-haiku-4.5', parsed.modelMetadata)).toBe(
      true,
    )
    expect(isOpenCodeModelFree('openrouter/openai/gpt-oss-20b:free', parsed.modelMetadata)).toBe(
      true,
    )
    expect(
      isOpenCodeModelFree('kimi-for-coding/k2p7', [
        {
          id: 'kimi-for-coding/k2p7',
          cost: { input: 0, output: 0 },
          context: 262_144,
          limits: { context: 262_144 },
          free: true,
          raw: {},
        },
      ]),
    ).toBe(false)
    expect(
      parsed.modelMetadata.find(item => item.id === 'llama.cpp/qwen3-coder:a3b')?.context,
    ).toBe(32768)
    expect(isOpenCodeModelFree('opencode/qwen3.6-plus-free', [])).toBe(false)
  })
})
