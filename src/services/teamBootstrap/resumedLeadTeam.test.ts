import { describe, expect, test } from 'bun:test'
import { realpath } from 'node:fs/promises'
import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { getCwd } from '../../utils/cwd.js'
import type { TeamFile } from '../../utils/swarm/teamHelpers.js'
import { restoreResumedLeadTeam } from './resumedLeadTeam.js'

async function team(name: string, leadSessionId: string, dirName = name): Promise<{ dirName: string; team: TeamFile }> {
  const cwd = await realpath(getCwd())
  return { dirName, team: { name, createdAt: 1, leadAgentId: `team-lead@${name}`, leadSessionId,
    members: [{ agentId: `team-lead@${name}`, name: 'team-lead', agentType: 'team-lead', joinedAt: 1, cwd, tmuxPaneId: '', subscriptions: [] },
      { agentId: `alice@${name}`, name: 'alice', agentType: 'general-purpose', joinedAt: 1, cwd, tmuxPaneId: '', subscriptions: [] }] } as TeamFile }
}

function harness() {
  let state = { tasks: {} } as AppState
  return { params: { isFullResume: true, getAppState: () => state, setAppState: (u: (p: AppState) => AppState) => { state = u(state) } }, state: () => state }
}

describe('resumed app lead team context', () => {
  test('re-attaches the single team that names this session as lead', async () => {
    const h = harness()
    await restoreResumedLeadTeam(h.params, { readTeams: async () => [await team('my-team', getSessionId()), await team('other', 'other-session')], setLeaderTeam: () => {} })
    expect(h.state().teamContext).toMatchObject({ teamName: 'my-team', leadAgentId: 'team-lead@my-team' })
    expect(Object.keys(h.state().teamContext!.teammates)).toHaveLength(2)
  })
  test('uses the team directory name, not the display name, as the team identity', async () => {
    const h = harness()
    let leader = ''
    await restoreResumedLeadTeam(h.params, { readTeams: async () => [await team('My Display Name', getSessionId(), 'my-team')], setLeaderTeam: name => { leader = name } })
    expect(h.state().teamContext?.teamName).toBe('my-team')
    expect(h.state().teamContext?.teamFilePath.endsWith('my-team/config.json')).toBe(true)
    expect(leader).toBe('my-team')
  })
  test('leaves state untouched when no or several teams match', async () => {
    for (const teams of [[], [await team('a', getSessionId()), await team('b', getSessionId())]]) {
      const h = harness()
      const before = h.state()
      await restoreResumedLeadTeam(h.params, { readTeams: async () => teams, setLeaderTeam: () => {} })
      expect(h.state()).toBe(before)
    }
  })
})
