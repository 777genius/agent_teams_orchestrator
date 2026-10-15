import { describe, expect, test } from 'bun:test'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  collectOpenCodeInventoryCommandResults,
  deriveOpenCodeProfileConnectedProviders,
  createOpenCodeInventoryProbeProgressTracker,
  execOpenCodePortableCommand,
  filterOpenCodeConnectedProvidersForRuntime,
  getOpenCodeInventoryCommandTimeoutMs,
  getOpenCodeRefreshModelsArgs,
  getOpenCodeVerboseModelsArgs,
  OPEN_CODE_INVENTORY_FULL_TIMEOUT_MS,
  OPEN_CODE_INVENTORY_SUMMARY_TIMEOUT_MS,
  OPEN_CODE_MODEL_LIST_TIMEOUT_MS,
  OPEN_CODE_PROBE_TIMEOUT_MS,
  isOpenCodeBuiltinFreeModelId,
  isOpenCodeInventoryTimeoutSnapshot,
  parseOpenCodeAgentListOutput,
  isOpenCodeModelFree,
  parseOpenCodeModelsOutput,
  parseOpenCodeModelsVerboseOutput,
  parseOpenCodeProvidersOutput,
  supportsOpenCodeSuperGrokOAuth,
  withOpenCodeInventoryProbeTimeout,
} from './OpenCodeInventoryService.js'

import type { OpenCodeInventorySnapshot, OpenCodePreparedProfile } from './types.js'

function scopedProfile(
  providerId: string,
  identity: 'absent' | 'error' | `known:${string}`,
): OpenCodePreparedProfile {
  const profileScope = {
    purpose: 'launch_runtime' as const,
    providerId,
    configFingerprint: 'config-fingerprint',
    selectedAuthIdentity: identity,
    scopeToken: `scope-${providerId}`,
  }
  return {
    profileScope,
    scopeToken: profileScope.scopeToken,
    selectedSourceAuthIdentity: identity,
    selectedManagedAuthIdentity: identity,
    globalAuthPath: '/poison/global-auth.json',
    sourceAuthPath: '/poison/source-auth.json',
    managedAuthPath: '/poison/managed-auth.json',
  } as unknown as OpenCodePreparedProfile
}

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
    expect(OPEN_CODE_INVENTORY_SUMMARY_TIMEOUT_MS).toBeGreaterThanOrEqual(
      OPEN_CODE_PROBE_TIMEOUT_MS * 3,
    )
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

  test('gives primary and fallback model-list commands the bounded model-list timeout', () => {
    expect(getOpenCodeInventoryCommandTimeoutMs(getOpenCodeVerboseModelsArgs())).toBe(
      OPEN_CODE_MODEL_LIST_TIMEOUT_MS,
    )
    expect(getOpenCodeInventoryCommandTimeoutMs(['models'])).toBe(
      OPEN_CODE_MODEL_LIST_TIMEOUT_MS,
    )
  })

  test('keeps non-model inventory commands on the standard probe timeout', () => {
    expect(getOpenCodeInventoryCommandTimeoutMs(['--version'])).toBe(
      OPEN_CODE_PROBE_TIMEOUT_MS,
    )
    expect(getOpenCodeInventoryCommandTimeoutMs(['providers', 'list'])).toBe(
      OPEN_CODE_PROBE_TIMEOUT_MS,
    )
    expect(getOpenCodeInventoryCommandTimeoutMs(['agent', 'list'])).toBe(
      OPEN_CODE_PROBE_TIMEOUT_MS,
    )
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

  test('profile auth inventory uses only the selected DeepInfra or custom identity', async () => {
    for (const providerId of ['deepinfra', 'my-custom-provider']) {
      const profile = scopedProfile(providerId, 'known:selected-auth')
      const summaryReads: string[] = []
      const result = deriveOpenCodeProfileConnectedProviders({
        profileScope: profile.profileScope!,
        profile,
        readAuthProviderSummaries: async authPath => {
          summaryReads.push(authPath)
          throw new Error('all-provider auth summary reader invoked')
        },
      })
      expect(summaryReads).toEqual([])
      expect(result).toEqual({
        providers: [{ id: providerId, authHint: null, source: 'credentials' }],
        profileScopeError: false,
      })
    }
  })

  test('settings profile retains the admitted version without CLI probes or invented auth', async () => {
    const calls: string[][] = []
    const result = await collectOpenCodeInventoryCommandResults({
      mode: 'profile', verifiedVersion: '1.18.31',
      execOpenCode: async args => {
        calls.push(args)
        throw new Error('settings must read the catalog through its managed HTTP host')
      },
    })
    expect(calls).toEqual([])
    expect(result.versionResult).toEqual({ code: 0, stdout: '1.18.31', stderr: '' })
    const profile = { ...scopedProfile('deepinfra', 'known:auth'), profileScope: null }
    expect(deriveOpenCodeProfileConnectedProviders({ profile, settingsOnly: true }))
      .toEqual({ providers: [], profileScopeError: false })
    expect(deriveOpenCodeProfileConnectedProviders({ profile }))
      .toEqual({ providers: [], profileScopeError: true })
    const scoped = scopedProfile('deepinfra', 'error')
    expect(deriveOpenCodeProfileConnectedProviders({
      profile: scoped, profileScope: scoped.profileScope!, settingsOnly: true,
    })).toEqual({ providers: [], profileScopeError: true })
  })

  test('profile auth inventory accepts explicit selected identity absence', async () => {
    const profile = scopedProfile('opencode', 'absent')
    expect(deriveOpenCodeProfileConnectedProviders({
      profileScope: profile.profileScope!,
      profile,
    })).toEqual({ providers: [], profileScopeError: false })
  })

  test('profile auth inventory fails closed on missing, error, or mismatched evidence', async () => {
    const missingPreparedScope = scopedProfile('deepinfra', 'known:auth')
    missingPreparedScope.profileScope = null
    const errorIdentity = scopedProfile('deepinfra', 'error')
    const providerMismatch = scopedProfile('deepinfra', 'known:auth')
    providerMismatch.profileScope = { ...providerMismatch.profileScope!, providerId: 'cursor' }
    const missingIdentity = scopedProfile('deepinfra', 'known:auth')
    missingIdentity.selectedSourceAuthIdentity = undefined
    const identityMismatch = scopedProfile('deepinfra', 'known:auth')
    identityMismatch.selectedManagedAuthIdentity = 'known:different'
    const cases = [
      { profile: missingPreparedScope, scope: scopedProfile('deepinfra', 'known:auth').profileScope },
      { profile: errorIdentity, scope: errorIdentity.profileScope },
      { profile: providerMismatch, scope: scopedProfile('deepinfra', 'known:auth').profileScope },
      { profile: missingIdentity, scope: missingIdentity.profileScope },
      { profile: identityMismatch, scope: identityMismatch.profileScope },
      { profile: scopedProfile('deepinfra', 'known:auth'), scope: undefined },
    ]
    for (const { profile, scope } of cases) {
      expect(deriveOpenCodeProfileConnectedProviders({
        profileScope: scope ?? undefined,
        profile,
      })).toEqual({ providers: [], profileScopeError: true })
    }
  })

  test('portable inventory command runner captures stdout and stderr', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'opencode-inventory-runner-'))
    try {
      await writeFile(path.join(tempDir, 'cwd-marker'), tempDir, 'utf8')
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
      const output = JSON.parse(result.stdout) as { cwd: string; arg: string; env: string }
      expect(output).toEqual({
        cwd: expect.any(String),
        arg: 'hello',
        env: 'present',
      })
      // Windows may report an 8.3 alias for the same directory (RUNNER~1).
      // Verify the effective cwd through a fixture unique to this directory.
      expect(await readFile(path.join(output.cwd, 'cwd-marker'), 'utf8')).toBe(tempDir)
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
      // Bun 1.3.11 ignores fs.rm retry options; Windows may still hold the cwd.
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          await rm(tempDir, { recursive: true, force: true })
          break
        } catch (error) {
          const busy = error !== null && typeof error === 'object'
            && 'code' in error && error.code === 'EBUSY'
          if (process.platform !== 'win32' || !busy || attempt === 5) throw error
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
        }
      }
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
