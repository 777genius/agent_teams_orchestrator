import { execa } from 'execa'
import { fileURLToPath } from 'url'

import {
  evaluateAnthropicApiSmoke,
  type AnthropicApiSmokeVerdict,
} from '../src/services/runtimeBackends/anthropicApiSmoke.js'

const ENTRYPOINT_PATH = './src/entrypoints/cli.tsx'
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SMOKE_MODEL = 'claude-haiku-4-5-20251001'
const SMOKE_PROMPT = 'Reply with exactly OK and nothing else.'

function getExitCode(verdict: AnthropicApiSmokeVerdict): number {
  switch (verdict) {
    case 'ok':
      return 0
    case 'billing_error':
      return 2
    case 'auth_error':
      return 3
    case 'routing_error':
      return 4
    case 'missing_key':
      return 5
    case 'rate_limit_error':
      return 6
    case 'runtime_error':
      return 7
  }
}

async function runCliCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execa(process.execPath, [ENTRYPOINT_PATH, ...args], {
    cwd: REPO_ROOT,
    env,
    reject: false,
    timeout: 90_000,
  })

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

async function main(): Promise<void> {
  const env = {
    ...process.env,
    CLAUDE_CODE_ENTRY_PROVIDER: 'anthropic',
    CLAUDE_CODE_SIMPLE: '1',
  }

  const hasApiKey =
    typeof process.env.ANTHROPIC_API_KEY === 'string' &&
    process.env.ANTHROPIC_API_KEY.trim().length > 0

  if (!hasApiKey) {
    const report = evaluateAnthropicApiSmoke({
      hasApiKey,
      authStatusStdout: '',
      promptStdout: '',
    })
    console.log(
      JSON.stringify(
        {
          ...report,
          model: SMOKE_MODEL,
        },
        null,
        2,
      ),
    )
    process.exitCode = getExitCode(report.verdict)
    return
  }

  const [authStatus, promptResult] = await Promise.all([
    runCliCommand(['auth', 'status', '--provider', 'anthropic', '--json'], env),
    runCliCommand(
      [
        SMOKE_PROMPT,
        '-p',
        '--output-format',
        'json',
        '--model',
        SMOKE_MODEL,
        '--max-turns',
        '1',
      ],
      env,
    ),
  ])

  const report = evaluateAnthropicApiSmoke({
    hasApiKey,
    authStatusStdout: authStatus.stdout,
    promptStdout: promptResult.stdout,
    promptStderr: promptResult.stderr,
  })

  console.log(
    JSON.stringify(
      {
        ...report,
        model: SMOKE_MODEL,
      },
      null,
      2,
    ),
  )

  process.exitCode = getExitCode(report.verdict)
}

void main()
