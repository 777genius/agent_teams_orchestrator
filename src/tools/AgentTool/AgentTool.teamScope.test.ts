import { describe, expect, it } from 'bun:test'
import { AgentTool } from './AgentTool.js'

function ctx(teamName?: string) {
  return { getAppState: () => ({ teamContext: teamName ? { teamName } : undefined }) } as any
}

describe('AgentTool team scope', () => {
  it('rejects a team_name that is not the current team', async () => {
    const r = await AgentTool.validateInput!({ prompt: 'p', description: 'd', name: 'x', team_name: 'session-a9ac8ea7' } as any, ctx('my-team'))
    expect(r).toMatchObject({ result: false, errorCode: 1 })
    expect((r as any).message).toContain('TEAM_NAME_MISMATCH')
    expect((r as any).message).toContain('"my-team"')
    expect((r as any).message).toContain('Retry with team_name: "my-team"')
  })
  it('accepts own team (case/sanitize-insensitive), no team context, or omitted team_name', async () => {
    expect(await AgentTool.validateInput!({ prompt: 'p', description: 'd', name: 'x', team_name: 'My-Team' } as any, ctx('my-team'))).toEqual({ result: true })
    expect(await AgentTool.validateInput!({ prompt: 'p', description: 'd', name: 'x', team_name: 'other' } as any, ctx())).toEqual({ result: true })
    expect(await AgentTool.validateInput!({ prompt: 'p', description: 'd', name: 'x' } as any, ctx('my-team'))).toEqual({ result: true })
  })
})
