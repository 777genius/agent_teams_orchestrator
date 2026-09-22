import { describe, expect, test } from 'bun:test'
import { execa } from 'execa'
import { fileURLToPath } from 'url'

import {
  evaluateAnthropicApiSmoke,
  runAnthropicApiKeyPromptSmoke,
} from './anthropicApiSmoke.js'

const ENTRYPOINT_PATH = fileURLToPath(
  new URL('../../entrypoints/cli.tsx', import.meta.url),
)
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SMOKE_MODEL = 'claude-haiku-4-5-20251001'
const SMOKE_PROMPT = 'Reply with exactly OK and nothing else.'

const liveTest =
  process.env.ANTHROPIC_E2E === '1'
    && typeof process.env.ANTHROPIC_API_KEY === 'string'
    && process.env.ANTHROPIC_API_KEY.trim().length > 0
    ? test
    : test.skip

async function runCliCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execa(process.execPath, [ENTRYPOINT_PATH, ...args], {
    cwd: REPO_ROOT,
    env,
    stdin: 'ignore',
    reject: false,
    timeout: 90_000,
  })

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

describe('Anthropic API smoke live e2e', () => {
  liveTest('authenticates via ANTHROPIC_API_KEY and completes a minimal prompt roundtrip', async () => {
    const env = {
      ...process.env,
      CLAUDE_CODE_ENTRY_PROVIDER: 'anthropic',
      CLAUDE_CODE_SIMPLE: '1',
    }

    const [authStatus, promptResult] = await Promise.all([
      runCliCommand(
        ['auth', 'status', '--provider', 'anthropic', '--json'],
        env,
      ),
      runAnthropicApiKeyPromptSmoke({
        apiKey: process.env.ANTHROPIC_API_KEY!,
        model: SMOKE_MODEL,
        prompt: SMOKE_PROMPT,
      }),
    ])

    const report = evaluateAnthropicApiSmoke({
      hasApiKey: true,
      authStatusStdout: authStatus.stdout,
      promptStdout: promptResult.stdout,
      promptStderr: promptResult.stderr,
    })

    expect(report.ok, JSON.stringify(report, null, 2)).toBe(true)
    expect(report.verdict).toBe('ok')
    expect(report.authMethod).toBe('api_key')
    expect(report.promptText).toBe('OK')
  }, 150_000)

  liveTest('reports verified Anthropic auth, model catalog, and runtime status through API key routing', async () => {
    const env = {
      ...process.env,
      CLAUDE_CODE_ENTRY_PROVIDER: 'anthropic',
      CLAUDE_CODE_SIMPLE: '1',
    }

    const [authStatus, modelList, runtimeStatus] = await Promise.all([
      runCliCommand(
        ['auth', 'status', '--provider', 'anthropic', '--json'],
        env,
      ),
      runCliCommand(
        ['model', 'list', '--provider', 'anthropic', '--json'],
        env,
      ),
      runCliCommand(
        ['runtime', 'status', '--provider', 'anthropic', '--json'],
        env,
      ),
    ])

    const authJson = JSON.parse(authStatus.stdout) as {
      provider?: string
      status?: {
        authenticated?: boolean
        authMethod?: string
        verificationState?: string
        capabilities?: {
          teamLaunch?: boolean
          oneShot?: boolean
        }
      }
    }
    const modelJson = JSON.parse(modelList.stdout) as {
      providers?: Record<string, {
        defaultModel?: string
        models?: Array<{ id?: string }>
      }>
    }
    const runtimeJson = JSON.parse(runtimeStatus.stdout) as {
      providers?: Record<string, {
        authenticated?: boolean
        authMethod?: string
        verificationState?: string
        models?: string[]
        modelCatalog?: {
          status?: string
        }
        capabilities?: {
          teamLaunch?: boolean
          oneShot?: boolean
        }
      }>
    }

    expect(authJson.provider).toBe('anthropic')
    expect(authJson.status?.authenticated).toBe(true)
    expect(authJson.status?.authMethod).toBe('api_key')
    expect(authJson.status?.verificationState).toBe('verified')
    expect(authJson.status?.capabilities?.teamLaunch).toBe(true)
    expect(authJson.status?.capabilities?.oneShot).toBe(true)

    const anthropicModels = modelJson.providers?.anthropic
    expect(anthropicModels?.defaultModel).toBeTruthy()
    expect(
      anthropicModels?.models?.some(model => model.id === 'haiku' || model.id === 'claude-haiku-4-5-20251001'),
    ).toBe(true)

    const anthropicRuntime = runtimeJson.providers?.anthropic
    expect(anthropicRuntime?.authenticated).toBe(true)
    expect(anthropicRuntime?.authMethod).toBe('api_key')
    expect(anthropicRuntime?.verificationState).toBe('verified')
    expect(anthropicRuntime?.capabilities?.teamLaunch).toBe(true)
    expect(anthropicRuntime?.capabilities?.oneShot).toBe(true)
    expect(anthropicRuntime?.models?.includes('haiku')).toBe(true)
    expect(['ready', 'fresh', 'degraded', 'stale']).toContain(
      anthropicRuntime?.modelCatalog?.status ?? 'missing',
    )
  }, 60_000)

  liveTest('does not assume the Anthropic haiku alias is a valid raw Messages API model id', async () => {
    const promptResult = await runAnthropicApiKeyPromptSmoke({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: 'haiku',
      prompt: SMOKE_PROMPT,
    })

    const report = evaluateAnthropicApiSmoke({
      hasApiKey: true,
      authStatusStdout: JSON.stringify({
        status: {
          authenticated: true,
          authMethod: 'api_key',
        },
      }),
      promptStdout: promptResult.stdout,
      promptStderr: promptResult.stderr,
    })

    expect(report.ok, JSON.stringify(report, null, 2)).toBe(false)
    expect(report.verdict).toBe('runtime_error')
    expect(report.promptErrorText).toContain('not_found_error')
    expect(report.promptErrorText).toContain('model: haiku')
  }, 60_000)

  liveTest('uses a canonical claude-haiku runtime catalog model id for the raw Messages API path', async () => {
    const env = {
      ...process.env,
      CLAUDE_CODE_ENTRY_PROVIDER: 'anthropic',
      CLAUDE_CODE_SIMPLE: '1',
    }

    const runtimeStatus = await runCliCommand(
      ['runtime', 'status', '--provider', 'anthropic', '--json'],
      env,
    )

    const runtimeJson = JSON.parse(runtimeStatus.stdout) as {
      providers?: Record<string, {
        modelCatalog?: {
          models?: Array<{
            id?: string
          }>
        }
      }>
    }

    const canonicalHaikuModelId =
      runtimeJson.providers?.anthropic?.modelCatalog?.models?.find(model =>
        typeof model.id === 'string' && model.id.startsWith('claude-haiku-'),
      )?.id ?? null

    expect(canonicalHaikuModelId).toBeTruthy()

    const promptResult = await runAnthropicApiKeyPromptSmoke({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: canonicalHaikuModelId!,
      prompt: SMOKE_PROMPT,
    })

    const report = evaluateAnthropicApiSmoke({
      hasApiKey: true,
      authStatusStdout: JSON.stringify({
        status: {
          authenticated: true,
          authMethod: 'api_key',
        },
      }),
      promptStdout: promptResult.stdout,
      promptStderr: promptResult.stderr,
    })

    expect(report.ok, JSON.stringify(report, null, 2)).toBe(true)
    expect(report.verdict).toBe('ok')
    expect(report.promptText).toBe('OK')
  }, 60_000)
})
