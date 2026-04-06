import { afterEach, describe, expect, test } from 'bun:test'
import { TeamBootstrapTool } from './TeamBootstrapTool.js'

const originalDisableDeterministicBootstrap =
  process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP
const originalEnableTeamBootstrapTool =
  process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL

afterEach(() => {
  if (originalDisableDeterministicBootstrap === undefined) {
    delete process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP
  } else {
    process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP =
      originalDisableDeterministicBootstrap
  }

  if (originalEnableTeamBootstrapTool === undefined) {
    delete process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL
  } else {
    process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL =
      originalEnableTeamBootstrapTool
  }
})

describe('TeamBootstrapTool.validateInput', () => {
  test('disables the hidden tool when deterministic bootstrap kill switch is active', () => {
    process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL = '1'
    process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1'

    expect(TeamBootstrapTool.isEnabled()).toBe(false)
  })

  test('rejects invocation when deterministic bootstrap kill switch is active', async () => {
    process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1'

    const result = await TeamBootstrapTool.validateInput(
      {
        mode: 'create',
        team_name: 'atlas-hq',
        members: [{ name: 'alice' }],
      },
      {
        getAppState: () => ({}),
      } as never,
    )

    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.message).toContain('disabled by kill switch')
    }
  })

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
