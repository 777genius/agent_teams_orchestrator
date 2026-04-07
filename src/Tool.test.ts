import { describe, expect, it } from 'bun:test'

import { toolMatchesName } from './Tool.js'

describe('toolMatchesName', () => {
  it('matches exact MCP tool names', () => {
    expect(
      toolMatchesName(
        { name: 'mcp__agent-teams__task_create' },
        'mcp__agent-teams__task_create',
      ),
    ).toBe(true)
  })

  it('treats hyphen and underscore server namespaces as equivalent for MCP lookup', () => {
    expect(
      toolMatchesName(
        { name: 'mcp__agent-teams__task_create_from_message' },
        'mcp__agent_teams__task_create_from_message',
      ),
    ).toBe(true)
  })

  it('keeps MCP tool segment matching strict', () => {
    expect(
      toolMatchesName(
        { name: 'mcp__agent-teams__task_create' },
        'mcp__agent_teams__task_complete',
      ),
    ).toBe(false)
  })

  it('does not broaden non-MCP tool matching', () => {
    expect(toolMatchesName({ name: 'TaskCreate' }, 'task_create')).toBe(false)
  })
})
