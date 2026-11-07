import { Command, Option } from '@commander-js/extra-typings'

export type ModelListOptions = {
  json?: boolean
  text?: boolean
  provider?: 'anthropic' | 'codex' | 'gemini' | 'opencode' | 'all'
  projectPath?: string
}

/** One Commander contract for packaged/source CLI and the lightweight entrypoint. */
export function createModelListCommand(run: (opts: ModelListOptions) => Promise<void>): Command {
  return new Command('list')
    .description('List available models by provider')
    .addOption(new Option('--provider <provider>', 'Provider to inspect').choices(['anthropic', 'codex', 'gemini', 'opencode', 'all']))
    .option('--json', 'Output as JSON (default)')
    .option('--text', 'Output as human-readable text')
    .option('--project-path <path>', 'Selected OpenCode project for model inventory')
    .action(run)
}
