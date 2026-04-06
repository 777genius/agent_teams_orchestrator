import { describe, expect, test } from 'bun:test'
import { TeamBootstrapTool } from './TeamBootstrapTool.js'

describe('TeamBootstrapTool.validateInput', () => {
  test('rejects teammate or nested-agent invocation', async () => {
    const result = await TeamBootstrapTool.validateInput(
      {
        mode: 'create',
        team_name: 'atlas-hq',
        members: [{ name: 'alice' }],
      },
      {
        agentId: 'agent-123',
        getAppState: () => ({}),
      } as never,
    )

    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.message).toContain('main lead session')
    }
  })

  test('rejects switching an active lead session to another team', async () => {
    const result = await TeamBootstrapTool.validateInput(
      {
        mode: 'launch',
        team_name: 'signal-ops',
        members: [{ name: 'alice' }],
      },
      {
        getAppState: () => ({
          teamContext: {
            teamName: 'forge-labs',
          },
        }),
      } as never,
    )

    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.message).toContain('cannot switch this lead session')
    }
  })

  test('allows bootstrap in a fresh session', async () => {
    const result = await TeamBootstrapTool.validateInput(
      {
        mode: 'create',
        team_name: 'forge-labs',
        members: [{ name: 'alice' }],
      },
      {
        getAppState: () => ({}),
      } as never,
    )

    expect(result).toEqual({ result: true })
  })
})
