import { Command, Option } from '@commander-js/extra-typings'
import { startRuntimeCommandKeepAlive } from './handlers/runtimeOpenCodeCommand.js'

export type RuntimeTranscriptOptions = {
  json?: boolean; text?: boolean; provider?: 'opencode' | 'all'
  team: string; member: string; lane?: string; sessionId?: string; runId?: string
  projectionOnly?: boolean; output?: string; limit?: number
}

/** This read command never needs the interactive CLI's global initialization. */
export function createRuntimeTranscriptCommand(read: (opts: RuntimeTranscriptOptions) => Promise<void>) {
  return new Command('transcript')
    .description('Project a stored provider-backed session into canonical transcript items')
    .requiredOption('--team <teamId>', 'Team identifier used in the stored session record')
    .requiredOption('--member <memberName>', 'Member name used in the stored session record')
    .option('--lane <laneId>', 'Lane identifier used in the stored session record when multiple lanes share a member name')
    .option('--session-id <sessionId>', 'Exact OpenCode runtime session id to project')
    .option('--run-id <runId>', 'Exact original run identifier; requires --lane and --session-id')
    .option('--projection-only', 'Omit raw canonical messages and return only the log projection payload')
    .option('--output <path>', 'Write JSON output to a file instead of stdout')
    .addOption(new Option('--provider <provider>', 'Provider to inspect').choices(['opencode', 'all']))
    .addOption(new Option('--limit <count>', 'Limit session messages fetch to the latest N entries').argParser(Number))
    .option('--json', 'Output as JSON (default)')
    .option('--text', 'Output as human-readable text')
    .action(read)
}

export async function runRuntimeTranscriptCommand(args: string[]): Promise<void> {
  // The entrypoint owns this referenced timer until the actual read and output
  // settle, including waits whose underlying handles do not keep Bun alive.
  const stopKeepAlive = startRuntimeCommandKeepAlive()
  try {
    const { runtimeTranscript } = await import('./handlers/runtime.js')
    await createRuntimeTranscriptCommand(opts => runtimeTranscript(opts, { exit: () => undefined }))
      .parseAsync(args, { from: 'user' })
  } finally { stopKeepAlive() }
}
