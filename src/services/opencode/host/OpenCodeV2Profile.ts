import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { executionAssert, executionRecord, type ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { OwnedNativeProfile } from './OpenCodeV2ExecutionBinding.js'

/** Derive the selected controller's candidate roots from exact production
 * config/environment joins. POSIX keeps eager canonical checks; Windows returns
 * lexical candidates, whose readers compare paths inside their real root. */
export async function deriveSelectedOpenCodeV2ControllerState(profile: OwnedNativeProfile, context: ExecutionContext): Promise<readonly string[]> {
  const document = executionRecord(JSON.parse(profile.config.content))
  if (document.mcp === undefined) return []
  const servers = executionRecord(executionRecord(document.mcp).servers)
  if (servers['agent-teams'] === undefined) return []
  const server = executionRecord(servers['agent-teams'])
  if (server.type !== 'local') return []
  const environment = executionRecord(server.environment ?? {})
  const claudeDir = environment.AGENT_TEAMS_MCP_CLAUDE_DIR
  executionAssert(typeof claudeDir === 'string' &&
    (process.platform === 'win32' ? path.win32.isAbsolute(claudeDir) : path.isAbsolute(claudeDir)) &&
    profile.env.AGENT_TEAMS_MCP_CLAUDE_DIR === claudeDir, 'controller_state_unowned')
  if (process.platform !== 'win32') executionAssert(await realpath(claudeDir) === claudeDir, 'controller_state_unowned')
  executionAssert(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(context.teamId), 'controller_team_invalid')
  // This process inherited the selected boundary from the production launcher.
  // Public command bodies and profile DTOs cannot select a different base.
  executionAssert(process.env.AGENT_TEAMS_MCP_CLAUDE_DIR === claudeDir, 'controller_state_unowned')
  const roots = [path.join(claudeDir, 'teams', context.teamId), path.join(claudeDir, 'tasks', context.teamId)]
  if (process.platform !== 'win32') {
    for (const root of roots) {
      const stat = await lstat(root)
      executionAssert(await realpath(root) === root && stat.isDirectory() && !stat.isSymbolicLink(), 'controller_state_unowned')
    }
  }
  return Object.freeze(roots)
}

/** POSIX keeps its uid qualification. Windows has no cheap owner check; its
 * profile inherits the user's ACL. */
export async function assertSelectedOpenCodeV2ControllerState(profile: OwnedNativeProfile, context: ExecutionContext,
  candidates?: readonly string[]): Promise<void> {
  const roots = candidates ?? await deriveSelectedOpenCodeV2ControllerState(profile, context)
  if (process.platform === 'win32') return
  for (const root of roots) {
    const stat = await lstat(root)
    executionAssert(stat.uid === process.getuid?.(), 'controller_state_unowned')
  }
}

/** Compatibility entry point preserves the original POSIX caller contract. */
export async function readSelectedOpenCodeV2ControllerState(profile: OwnedNativeProfile, context: ExecutionContext): Promise<readonly string[]> {
  const roots = await deriveSelectedOpenCodeV2ControllerState(profile, context)
  await assertSelectedOpenCodeV2ControllerState(profile, context, roots)
  return roots
}
