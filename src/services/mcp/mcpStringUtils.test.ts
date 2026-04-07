import { describe, expect, it } from 'bun:test'

import {
  buildMcpToolAliases,
  buildMcpToolName,
} from './mcpStringUtils.js'

describe('buildMcpToolAliases', () => {
  it('adds underscore alias for hyphenated server names', () => {
    expect(buildMcpToolName('agent-teams', 'task_create')).toBe(
      'mcp__agent-teams__task_create',
    )
    expect(buildMcpToolAliases('agent-teams', 'task_create')).toEqual([
      'mcp__agent_teams__task_create',
    ])
  })

  it('adds hyphen alias for underscored server names', () => {
    expect(buildMcpToolAliases('agent_teams', 'task_create')).toEqual([
      'mcp__agent-teams__task_create',
    ])
  })

  it('returns no aliases when namespace already has no separator drift', () => {
    expect(buildMcpToolAliases('github', 'list_issues')).toEqual([])
  })
})
