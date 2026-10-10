import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { executionAssert, executionRecord, type ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { OwnedNativeProfile } from './OpenCodeV2ExecutionBinding.js'

/** Only the SDK-selected controller's exact owned TEST team/tasks directories.
 * This is derived from the production selected config, never a public mount DTO. */
export async function readSelectedOpenCodeV2ControllerState(profile: OwnedNativeProfile, context: ExecutionContext): Promise<readonly string[]> {
  const document = executionRecord(JSON.parse(profile.config.content))
  if (document.mcp === undefined) return []
  const servers = executionRecord(executionRecord(document.mcp).servers)
  if (servers['agent-teams'] === undefined) return []
  const server = executionRecord(servers['agent-teams'])
  if (server.type !== 'local') return []
  const environment = executionRecord(server.environment ?? {})
  const claudeDir = environment.AGENT_TEAMS_MCP_CLAUDE_DIR
  executionAssert(typeof claudeDir === 'string' && path.isAbsolute(claudeDir) &&
    profile.env.AGENT_TEAMS_MCP_CLAUDE_DIR === claudeDir && await realpath(claudeDir) === claudeDir, 'controller_state_unowned')
  executionAssert(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(context.teamId), 'controller_team_invalid')
  // This process inherited the selected boundary from the production launcher.
  // Public command bodies and profile DTOs cannot select a different base.
  executionAssert(process.env.AGENT_TEAMS_MCP_CLAUDE_DIR === claudeDir, 'controller_state_unowned')
  const roots = [path.join(claudeDir, 'teams', context.teamId), path.join(claudeDir, 'tasks', context.teamId)]
  for (const root of roots) {
    const stat = await lstat(root)
    executionAssert(await realpath(root) === root && stat.isDirectory() && !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.(), 'controller_state_unowned')
  }
  return Object.freeze(roots)
}
