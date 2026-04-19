import { resolve } from 'node:path'

type ParsedArgs = {
  cwd: string
  prompt: string
  model: string | null
  reasoningEffort:
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | null
  ephemeral: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  let cwd = process.cwd()
  let prompt = 'Reply only with OK'
  let model: string | null = null
  let reasoningEffort: ParsedArgs['reasoningEffort'] = null
  let ephemeral = true

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--cwd') {
      cwd = resolve(argv[index + 1] ?? cwd)
      index += 1
    } else if (arg === '--prompt') {
      prompt = argv[index + 1] ?? prompt
      index += 1
    } else if (arg === '--model') {
      model = argv[index + 1] ?? null
      index += 1
    } else if (arg === '--reasoning-effort') {
      reasoningEffort =
        (argv[index + 1] as ParsedArgs['reasoningEffort']) ?? null
      index += 1
    } else if (arg === '--persistent') {
      ephemeral = false
    } else if (arg === '--ephemeral') {
      ephemeral = true
    } else if (arg === '--help') {
      console.log(
        [
          'Usage: bun run ./scripts/codex-native-phase0-signoff.ts [options]',
          '',
          'Options:',
          '  --cwd <path>                Working directory for codex exec',
          '  --prompt <text>             Prompt to run',
          '  --model <id>                Optional model override',
          '  --reasoning-effort <value>  Optional reasoning effort override',
          '  --ephemeral                 Use ephemeral thread mode (default)',
          '  --persistent                Use persistent thread mode',
        ].join('\n'),
      )
      process.exit(0)
    }
  }

  return { cwd, prompt, model, reasoningEffort, ephemeral }
}

const parsed = parseArgs(process.argv.slice(2))
const apiKey = process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || null

if (!apiKey) {
  console.error(
    'codex-native phase-0 sign-off requires CODEX_API_KEY or OPENAI_API_KEY.',
  )
  process.exit(1)
}

const {
  runCodexNativePhase0SignOffHarness,
} = await import('../src/services/codexNative/signOffHarness.js')

const evidence = await runCodexNativePhase0SignOffHarness({
  cwd: parsed.cwd,
  prompt: parsed.prompt,
  model: parsed.model,
  reasoningEffort: parsed.reasoningEffort,
  ephemeral: parsed.ephemeral,
  apiKey,
})

console.log(JSON.stringify(evidence, null, 2))
