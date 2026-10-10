import { Command, Option } from '@commander-js/extra-typings'

export interface RuntimeStatusOptions {
  json?: boolean
  text?: boolean
  summary?: boolean
  provider?: 'anthropic' | 'codex' | 'gemini' | 'opencode' | 'all'
}

/** Share argument validation between the lean entry path and the full CLI. */
export function createRuntimeStatusCommand(runStatus: (opts: RuntimeStatusOptions) => Promise<void>) {
  return new Command('status')
    .description('Show runtime backend status by provider')
    .addOption(
      new Option('--provider <provider>', 'Provider to inspect').choices([
        'anthropic', 'codex', 'gemini', 'opencode', 'all',
      ]),
    )
    .option('--json', 'Output as JSON (default)')
    .option('--text', 'Output as human-readable text')
    .option('--summary', 'Output fast live status without full model catalog metadata')
    .action(runStatus)
}
