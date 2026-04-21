import { describe, expect, it } from 'bun:test'

import type { TeamFile } from './teamHelpers.js'
import { upsertTeamMember } from './teamHelpers.js'

function createTeamFile(): TeamFile {
  return {
    name: 'atlas-hq',
    createdAt: 0,
    leadAgentId: 'team-lead@atlas-hq',
    members: [],
  }
}

describe('teamHelpers bootstrapExpectedAfter', () => {
  it('writes bootstrapExpectedAfter for a new member', () => {
    const result = upsertTeamMember(createTeamFile(), {
      agentId: 'alice@atlas-hq',
      name: 'alice',
      joinedAt: 1,
      bootstrapExpectedAfter: '2026-04-08T12:00:00.000Z',
      tmuxPaneId: 'pane-1',
      cwd: '/tmp/project',
      subscriptions: [],
      backendType: 'tmux',
    })

    expect(result.changed).toBe(true)
    expect(result.teamFile.members).toHaveLength(1)
    expect(result.teamFile.members[0]?.bootstrapExpectedAfter).toBe(
      '2026-04-08T12:00:00.000Z',
    )
  })

  it('updates bootstrapExpectedAfter on respawn for an existing member', () => {
    const original = upsertTeamMember(createTeamFile(), {
      agentId: 'alice@atlas-hq',
      name: 'alice',
      joinedAt: 1,
      bootstrapExpectedAfter: '2026-04-08T12:00:00.000Z',
      tmuxPaneId: 'pane-1',
      cwd: '/tmp/project',
      subscriptions: [],
      backendType: 'tmux',
    }).teamFile

    const updated = upsertTeamMember(original, {
      agentId: 'alice@atlas-hq',
      name: 'alice',
      joinedAt: 1,
      bootstrapExpectedAfter: '2026-04-08T12:05:00.000Z',
      tmuxPaneId: 'pane-2',
      cwd: '/tmp/project',
      subscriptions: [],
      backendType: 'tmux',
    })

    expect(updated.changed).toBe(true)
    expect(updated.teamFile.members).toHaveLength(1)
    expect(updated.teamFile.members[0]?.bootstrapExpectedAfter).toBe(
      '2026-04-08T12:05:00.000Z',
    )
  })

  it('treats identical bootstrapExpectedAfter as a no-op', () => {
    const original = upsertTeamMember(createTeamFile(), {
      agentId: 'alice@atlas-hq',
      name: 'alice',
      joinedAt: 1,
      bootstrapExpectedAfter: '2026-04-08T12:00:00.000Z',
      tmuxPaneId: 'pane-1',
      cwd: '/tmp/project',
      subscriptions: [],
      backendType: 'tmux',
    }).teamFile

    const unchanged = upsertTeamMember(original, {
      agentId: 'alice@atlas-hq',
      name: 'alice',
      joinedAt: 1,
      bootstrapExpectedAfter: '2026-04-08T12:00:00.000Z',
      tmuxPaneId: 'pane-1',
      cwd: '/tmp/project',
      subscriptions: [],
      backendType: 'tmux',
    })

    expect(unchanged.changed).toBe(false)
  })

  it('persists teammate worktree cleanup metadata and treats identical metadata as a no-op', () => {
    const member = {
      agentId: 'alice@atlas-hq',
      name: 'alice',
      joinedAt: 1,
      bootstrapExpectedAfter: '2026-04-08T12:00:00.000Z',
      tmuxPaneId: 'pane-1',
      cwd: '/tmp/project/.claude/worktrees/team-atlas-alice-12345678',
      worktreePath: '/tmp/project/.claude/worktrees/team-atlas-alice-12345678',
      worktreeBranch: 'worktree-team-atlas-alice-12345678',
      worktreeHeadCommit: 'abc123',
      worktreeGitRoot: '/tmp/project',
      worktreeBaseWorkspaceRoot: '/tmp/project',
      worktreeDirtyWarning: 'Leader workspace had uncommitted changes.',
      subscriptions: [],
      backendType: 'tmux' as const,
    }
    const original = upsertTeamMember(createTeamFile(), member).teamFile

    expect(original.members[0]?.worktreePath).toBe(member.worktreePath)
    expect(original.members[0]?.worktreeBranch).toBe(member.worktreeBranch)
    expect(original.members[0]?.worktreeHeadCommit).toBe(member.worktreeHeadCommit)
    expect(original.members[0]?.worktreeGitRoot).toBe(member.worktreeGitRoot)
    expect(original.members[0]?.worktreeDirtyWarning).toBe(member.worktreeDirtyWarning)
    expect(upsertTeamMember(original, member).changed).toBe(false)
  })
})
