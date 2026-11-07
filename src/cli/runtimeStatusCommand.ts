import path from 'node:path'
import { stat } from 'node:fs/promises'
import { Command, Option } from '@commander-js/extra-typings'

export interface RuntimeStatusOptions {
  json?: boolean
  text?: boolean
  summary?: boolean
  provider?: 'anthropic' | 'codex' | 'gemini' | 'opencode' | 'all'
  projectPath?: string
}

/** Keep status project selection explicit; never canonicalize a File Provider path with Bun. */
export async function normalizeRuntimeStatusProjectPath(projectPath?: string): Promise<string | undefined> {
  if (projectPath === undefined) return undefined
  const value = projectPath.trim()
  if (!value || !path.isAbsolute(value) ||
    path.resolve(value) === path.parse(path.resolve(value)).root) {
    throw new Error('runtime status --project-path requires an absolute, non-root project path')
  }
  const resolved = path.resolve(value)
  const info = await stat(resolved)
  if (!info.isDirectory()) throw new Error('runtime status --project-path must be an existing directory')
  return resolved
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
    .option('--project-path <path>', 'Selected project for OpenCode status without changing the process cwd')
    .action(runStatus)
}
