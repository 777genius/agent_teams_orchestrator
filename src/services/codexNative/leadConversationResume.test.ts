import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { realpath } from 'node:fs/promises'
import path from 'node:path'

import { getFlagSettingsInline, getSessionId, setFlagSettingsInline } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { getCwd } from '../../utils/cwd.js'
import type { TeamFile } from '../../utils/swarm/teamHelpers.js'
import { getDynamicTeamContext, setDynamicTeamContext } from '../../utils/teammate.js'
import type { CodexConversationOwner } from './conversationBinding.js'
import { restoreCodexLeadConversationForFullResume } from './leadConversationResume.js'

const envKeys = ['CLAUDE_CODE_ENTRY_PROVIDER', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD', 'CODEX_HOME'] as const
let previousEnv: Record<string, string | undefined>
let previousSettings: ReturnType<typeof getFlagSettingsInline>
let previousIdentity: ReturnType<typeof getDynamicTeamContext>

beforeEach(() => {
  previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  previousSettings = getFlagSettingsInline()
  previousIdentity = getDynamicTeamContext()
  process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'
  process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  process.env.CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD = 'api'
  process.env.CODEX_HOME = path.join(getCwd(), 'TEST-native-resume-profile')
  setFlagSettingsInline({ codex: { forced_login_method: 'api' } })
  setDynamicTeamContext(null)
})

afterEach(() => {
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key]
    else process.env[key] = previousEnv[key]
  }
  setFlagSettingsInline(previousSettings)
  setDynamicTeamContext(previousIdentity)
})

async function fixture() {
  const cwd = await realpath(getCwd())
  const owner: CodexConversationOwner = {
    sessionId: getSessionId(), transcriptPath: path.join(cwd, 'TEST-host.jsonl'), cwd,
    agentId: 'team-lead@TEST-continuity', teamName: 'TEST-continuity',
    sourceProfile: process.env.CODEX_HOME!,
  }
  const team: TeamFile = {
    name: owner.teamName!, createdAt: 1, leadAgentId: owner.agentId!, leadSessionId: owner.sessionId,
    members: [{ agentId: owner.agentId!, name: 'team-lead', agentType: 'team-lead',
      joinedAt: 1, cwd, tmuxPaneId: '', subscriptions: [] }],
  }
  const stateBefore = { tasks: {} } as AppState
  let state = stateBefore
  const params = { isFullResume: true, getAppState: () => state,
    setAppState: (update: (previous: AppState) => AppState) => { state = update(state) } }
  const deps = {
    readOwner: mock(async (_current: Omit<CodexConversationOwner, 'agentId' | 'teamName'>) => owner as CodexConversationOwner | null),
    readTeam: mock(async (_name: string) => team as TeamFile | null),
    setLeaderTeam: mock((_name: string) => {}),
  }
  return { owner, team, stateBefore, params, deps, state: () => state }
}

describe('Codex bootstrapped lead full resume', () => {
  test('restores a create-session lead without member.sessionId from verified owner and exact team', async () => {
    const f = await fixture()
    await restoreCodexLeadConversationForFullResume(f.params, f.deps)
    expect(f.deps.readOwner).toHaveBeenCalledTimes(1)
    expect(f.deps.readOwner.mock.calls[0]?.[0]).toMatchObject({
      sessionId: getSessionId(), cwd: getCwd(), sourceProfile: process.env.CODEX_HOME,
    })
    expect(f.deps.readTeam.mock.calls).toEqual([[f.owner.teamName]])
    expect(f.state().tasks).toBe(f.stateBefore.tasks)
    expect(f.state().teamContext).toMatchObject({ teamName: f.owner.teamName,
      leadAgentId: f.owner.agentId, teammates: { [f.owner.agentId!]: { name: 'team-lead', cwd: f.owner.cwd } } })
    expect(f.deps.setLeaderTeam.mock.calls).toEqual([['test-continuity']])
    expect(f.team.members[0]?.sessionId).toBeUndefined()
  })

  test('accepts the matching member.sessionId written by a launch bootstrap', async () => {
    const f = await fixture()
    f.team.members[0]!.sessionId = f.owner.sessionId
    await restoreCodexLeadConversationForFullResume(f.params, f.deps)
    expect(f.state().teamContext?.leadAgentId).toBe(f.owner.agentId!)
  })

  test.each(['not-full-resume', 'other-provider', 'explicit-teammate', 'current-team'])(
    'does not infer a lead for %s', async scenario => {
      const f = await fixture()
      if (scenario === 'not-full-resume') f.params.isFullResume = false
      if (scenario === 'other-provider') process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
      if (scenario === 'explicit-teammate') setDynamicTeamContext({ agentId: 'nova@TEST-explicit',
        agentName: 'nova', teamName: 'TEST-explicit', planModeRequired: false })
      if (scenario === 'current-team') f.stateBefore.teamContext = {
        teamName: 'TEST-explicit', leadAgentId: 'lead@TEST-explicit', teamFilePath: 'TEST-team-file', teammates: {},
      }
      await restoreCodexLeadConversationForFullResume(f.params, f.deps)
      expect(f.deps.readOwner).not.toHaveBeenCalled()
      expect(f.deps.readTeam).not.toHaveBeenCalled()
      expect(f.deps.setLeaderTeam).not.toHaveBeenCalled()
      expect(f.state()).toBe(f.stateBefore)
    },
  )

  test.each(['legacy', 'standalone'])(
    'leaves a %s session without team context', async scenario => {
      const f = await fixture()
      if (scenario === 'legacy') f.deps.readOwner.mockImplementation(async () => null)
      else { f.owner.agentId = null; f.owner.teamName = null }
      await restoreCodexLeadConversationForFullResume(f.params, f.deps)
      expect(f.state()).toBe(f.stateBefore)
      expect(f.deps.readTeam).not.toHaveBeenCalled()
      expect(f.deps.setLeaderTeam).not.toHaveBeenCalled()
    },
  )

  test.each(['missing-team', 'team-name', 'lead-id', 'lead-session', 'missing-lead',
    'duplicate-lead', 'member-session', 'member-cwd', 'incomplete-owner'])(
    'refuses %s without changing AppState or task ownership', async scenario => {
      const f = await fixture()
      if (scenario === 'missing-team') f.deps.readTeam.mockImplementation(async () => null)
      if (scenario === 'team-name') f.team.name = 'TEST-other'
      if (scenario === 'lead-id') f.team.leadAgentId = 'other@TEST-continuity'
      if (scenario === 'lead-session') f.team.leadSessionId = 'TEST-other-session'
      if (scenario === 'missing-lead') f.team.members = []
      if (scenario === 'duplicate-lead') f.team.members.push({ ...f.team.members[0]! })
      if (scenario === 'member-session') f.team.members[0]!.sessionId = 'TEST-other-session'
      if (scenario === 'member-cwd') f.team.members[0]!.cwd = path.dirname(f.owner.cwd)
      if (scenario === 'incomplete-owner') f.owner.agentId = null
      await expect(restoreCodexLeadConversationForFullResume(f.params, f.deps)).rejects.toThrow('cannot be continued')
      expect(f.state()).toBe(f.stateBefore)
      expect(f.deps.setLeaderTeam).not.toHaveBeenCalled()
    },
  )

  test.each(['binding-read', 'team-read'])(
    'fails closed on %s errors before restoring identity', async scenario => {
      const f = await fixture()
      const fail = async (): Promise<never> => { throw new Error('TEST unreadable persisted state') }
      if (scenario === 'binding-read') f.deps.readOwner.mockImplementation(fail)
      else f.deps.readTeam.mockImplementation(fail)
      await expect(restoreCodexLeadConversationForFullResume(f.params, f.deps)).rejects.toThrow('unreadable persisted state')
      expect(f.state()).toBe(f.stateBefore)
      expect(f.deps.setLeaderTeam).not.toHaveBeenCalled()
    },
  )

  test('does not overwrite an identity installed while the persisted team is loading', async () => {
    const f = await fixture()
    f.deps.readTeam.mockImplementation(async () => {
      setDynamicTeamContext({ agentId: 'nova@TEST-explicit', agentName: 'nova',
        teamName: 'TEST-explicit', planModeRequired: false })
      return f.team
    })
    await expect(restoreCodexLeadConversationForFullResume(f.params, f.deps)).rejects.toThrow('identity changed')
    expect(f.state()).toBe(f.stateBefore)
    expect(f.deps.setLeaderTeam).not.toHaveBeenCalled()
  })
})
