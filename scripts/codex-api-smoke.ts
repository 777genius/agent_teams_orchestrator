import { execa } from 'execa'
import { fileURLToPath } from 'url'

import {
  evaluateCodexApiSmoke,
  type CodexApiSmokeVerdict,
} from '../src/services/runtimeBackends/codexApiSmoke.js'
import {
  CODEX_API_KEY_BETA_ENV_VAR,
  CODEX_API_KEY_ENV_VAR,
  CODEX_RUNTIME_BACKEND_ENV_VAR,
} from '../src/services/runtimeBackends/codexBackendResolver.js'

const ENTRYPOINT_PATH = './src/entrypoints/cli.tsx'
const SMOKE_MODEL = 'gpt-5.4-mini'
const SMOKE_PROMPT = 'Reply with exactly OK and nothing else.'
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

function getExitCode(verdict: CodexApiSmokeVerdict): number {
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
    CLAUDE_CODE_ENTRY_PROVIDER: 'codex',
    [CODEX_API_KEY_BETA_ENV_VAR]: '1',
    [CODEX_RUNTIME_BACKEND_ENV_VAR]: 'api',
  }

  const hasApiKey =
    typeof process.env[CODEX_API_KEY_ENV_VAR] === 'string' &&
    process.env[CODEX_API_KEY_ENV_VAR]!.trim().length > 0

  if (!hasApiKey) {
    const report = evaluateCodexApiSmoke({
      hasApiKey,
      authStatusStdout: '',
      runtimeStatusStdout: '',
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

  const [authStatus, runtimeStatus, promptResult] = await Promise.all([
    runCliCommand(['auth', 'status', '--provider', 'codex', '--json'], env),
    runCliCommand(['runtime', 'status', '--provider', 'codex', '--json'], env),
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

  const report = evaluateCodexApiSmoke({
    hasApiKey,
    authStatusStdout: authStatus.stdout,
    runtimeStatusStdout: runtimeStatus.stdout,
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
