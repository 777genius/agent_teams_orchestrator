import { readdir } from 'node:fs/promises'

import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { getTeamsDir } from '../../utils/envUtils.js'
import { getTeamFilePath, readTeamFileAsync, sanitizeName, type TeamFile } from '../../utils/swarm/teamHelpers.js'
import { assignTeammateColor } from '../../utils/swarm/teammateLayoutManager.js'
import { setLeaderTeamName } from '../../utils/tasks.js'
import { getAgentId, getTeamName } from '../../utils/teammate.js'
import { usesCodexNativeConversation } from '../codexNative/conversationHistoryGuard.js'

type TeamEntry = { dirName: string; team: TeamFile }

// The team directory name is the team's identity everywhere (inbox, task list, agent ids);
// config.name is only a display name and may differ from it.
async function readAllTeamFiles(): Promise<TeamEntry[]> {
  const entries = await readdir(getTeamsDir(), { withFileTypes: true }).catch(() => [])
  const teams: TeamEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || sanitizeName(entry.name) !== entry.name) continue
    const team = await readTeamFileAsync(entry.name).catch(() => null)
    if (team) teams.push({ dirName: entry.name, team })
  }
  return teams
}

/** A bootstrapped lead relaunched by the app with --resume (lead runtime restart) has no bootstrap
 * flags, so nothing re-attaches it to its team. Re-attach it only to the single team whose config
 * names this exact session as lead. Codex-native leads use leadConversationResume. */
export async function restoreResumedLeadTeam(
  params: {
    isFullResume: boolean
    getAppState: () => AppState
    setAppState: (update: (previous: AppState) => AppState) => void
  },
  deps: { readTeams?: () => Promise<TeamEntry[]>; setLeaderTeam?: typeof setLeaderTeamName } = {},
): Promise<void> {
  if (!params.isFullResume || !isAgentSwarmsEnabled() || usesCodexNativeConversation()) return
  const state = params.getAppState()
  if (getAgentId() || getTeamName(state.teamContext) || state.teamContext) return
  const sessionId = getSessionId()
  const owned = (await (deps.readTeams ?? readAllTeamFiles)()).filter(
    ({ team }) => team.leadSessionId === sessionId,
  )
  const found = owned.length === 1 ? owned[0] : undefined
  const team = found?.team
  if (!found || !team || !Array.isArray(team.members) || !team.members.some(member => member.agentId === team.leadAgentId)) {
    logForDebugging(`[resumed-lead] no unique team led by session ${sessionId}; team context not restored`)
    return
  }
  const teamName = found.dirName
  params.setAppState(previous => ({
    ...previous,
    teamContext: {
      teamName,
      teamFilePath: getTeamFilePath(teamName),
      leadAgentId: team.leadAgentId,
      teammates: Object.fromEntries(team.members.map(member => [member.agentId, {
        name: member.name,
        agentType: member.agentType,
        color: member.color ?? assignTeammateColor(member.agentId),
        tmuxSessionName: '',
        tmuxPaneId: member.tmuxPaneId ?? '',
        cwd: member.cwd || getCwd(),
        worktreePath: member.worktreePath,
        spawnedAt: member.joinedAt,
      }])),
    },
  }))
  ;(deps.setLeaderTeam ?? setLeaderTeamName)(teamName)
}
