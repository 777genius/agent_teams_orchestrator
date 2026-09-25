import { describe, expect, test } from 'bun:test'

import { isHostedTeamDraftPlaceholder } from './hostedTeamDraftPlaceholder.js'

describe('isHostedTeamDraftPlaceholder', () => {
  test('matches only the exact Product draft shape for the same team', () => {
    expect(isHostedTeamDraftPlaceholder({ name: 'team-a', pendingCreate: true }, 'team-a')).toBe(true)
    expect(isHostedTeamDraftPlaceholder({ name: 'team-b', pendingCreate: true }, 'team-a')).toBe(false)
    expect(isHostedTeamDraftPlaceholder({ name: 'team-a', pendingCreate: false }, 'team-a')).toBe(false)
    // A real team file, even one still marked pending, is never replaced.
    expect(isHostedTeamDraftPlaceholder({ name: 'team-a', pendingCreate: true, members: [] }, 'team-a')).toBe(false)
    expect(isHostedTeamDraftPlaceholder({ name: 'team-a', leadAgentId: 'team-lead@team-a', members: [] }, 'team-a'))
      .toBe(false)
    expect(isHostedTeamDraftPlaceholder(null, 'team-a')).toBe(false)
  })
})
