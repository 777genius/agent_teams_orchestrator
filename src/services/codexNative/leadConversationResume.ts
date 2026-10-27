import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { getCwd } from '../../utils/cwd.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { getTeamFilePath, readTeamFileAsync, sanitizeName } from '../../utils/swarm/teamHelpers.js'
import { assignTeammateColor } from '../../utils/swarm/teammateLayoutManager.js'
import { setLeaderTeamName } from '../../utils/tasks.js'
import { getAgentId, getTeamName } from '../../utils/teammate.js'
import { readCodexConversationOwnerForFullResume } from './conversationBinding.js'
import { usesCodexNativeConversation } from './conversationHistoryGuard.js'

type ResumeParams = {
  isFullResume: boolean
  getAppState: () => AppState
  setAppState: (update: (previous: AppState) => AppState) => void
}

type ResumeDeps = {
  readOwner?: typeof readCodexConversationOwnerForFullResume
  readTeam?: typeof readTeamFileAsync
  setLeaderTeam?: typeof setLeaderTeamName
}

function refusal(reason: string): Error {
  return new Error(`Codex lead conversation cannot be continued: ${reason}. ` +
    'Restore the matching team/session storage or start an explicitly new conversation.')
}

function hasCurrentIdentity(state: AppState): boolean {
  return Boolean(getAgentId() || getTeamName(state.teamContext) || state.teamContext)
}

/** Restore a bootstrapped lead after the app removes one-shot bootstrap flags.
 * No identity is inferred from prompts or adopted from another native thread.
 * The binding reader verifies the host session/project/profile first; the team
 * file must independently confirm that this exact host session is still lead.
 */
export async function restoreCodexLeadConversationForFullResume(
  params: ResumeParams,
  deps: ResumeDeps = {},
): Promise<void> {
  if (!params.isFullResume || !usesCodexNativeConversation() || hasCurrentIdentity(params.getAppState())) return

  const sessionId = getSessionId()
  const cwd = getCwd()
  const sourceProfile = path.resolve(process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex'))
  const owner = await (deps.readOwner ?? readCodexConversationOwnerForFullResume)({
    sessionId, transcriptPath: getTranscriptPath(), cwd, sourceProfile,
  })
  if (!owner || (owner.agentId === null && owner.teamName === null)) return
  if (typeof owner.agentId !== 'string' || !owner.agentId ||
      typeof owner.teamName !== 'string' || !owner.teamName) {
    throw refusal('the saved lead identity is incomplete')
  }
  const { agentId, teamName } = owner

  const team = await (deps.readTeam ?? readTeamFileAsync)(teamName)
  if (!team || team.name !== teamName || team.leadAgentId !== agentId ||
      team.leadSessionId !== sessionId || !Array.isArray(team.members)) {
    throw refusal('the saved team no longer belongs to this lead session')
  }
  const leads = team.members.filter(member => member?.agentId === agentId)
  const lead = leads[0]
  if (leads.length !== 1 || !lead || typeof lead.cwd !== 'string' || !path.isAbsolute(lead.cwd) ||
      // TeamCreate writes the authoritative top-level leadSessionId but omits
      // member.sessionId; a later launch writes both. Validate it when present.
      (lead.sessionId !== undefined && lead.sessionId !== sessionId) ||
      await realpath(lead.cwd) !== owner.cwd) {
    throw refusal('the saved lead membership or project changed')
  }
  const teammates: NonNullable<AppState['teamContext']>['teammates'] = {}
  for (const member of team.members) {
    if (!member || typeof member.agentId !== 'string' || !member.agentId ||
        typeof member.name !== 'string' || !member.name || typeof member.cwd !== 'string') {
      throw refusal('the saved team membership is invalid')
    }
    teammates[member.agentId] = {
      name: member.name,
      agentType: member.agentType,
      color: member.color ?? assignTeammateColor(member.agentId),
      tmuxSessionName: '',
      tmuxPaneId: member.tmuxPaneId ?? '',
      cwd: member.cwd || owner.cwd,
      worktreePath: member.worktreePath,
      spawnedAt: member.joinedAt,
    }
  }
  if (getSessionId() !== sessionId || getCwd() !== cwd || hasCurrentIdentity(params.getAppState())) {
    throw refusal('the current session identity changed while resuming')
  }
  params.setAppState(previous => {
    if (hasCurrentIdentity(previous)) throw refusal('the current team identity changed while resuming')
    return {
      ...previous,
      teamContext: {
        teamName, teamFilePath: getTeamFilePath(teamName), leadAgentId: agentId, teammates,
      },
    }
  })
  const setLeaderTeam = deps.setLeaderTeam ?? setLeaderTeamName
  setLeaderTeam(sanitizeName(teamName))
}
