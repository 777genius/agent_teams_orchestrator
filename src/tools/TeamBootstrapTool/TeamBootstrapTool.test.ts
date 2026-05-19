import { afterEach, describe, expect, test } from 'bun:test'
import { PROVIDER_DEFAULT_MODEL_SELECTION } from '../../services/teamBootstrap/teamBootstrapModelSelection.js'
import { TeamBootstrapTool, buildToolBootstrapSpec } from './TeamBootstrapTool.js'

const originalDisableDeterministicBootstrap =
  process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP
const originalEnableDeterministicBootstrap =
  process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP
const originalEnableTeamBootstrapTool =
  process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL

afterEach(() => {
  if (originalDisableDeterministicBootstrap === undefined) {
    delete process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP
  } else {
    process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP =
      originalDisableDeterministicBootstrap
  }

  if (originalEnableDeterministicBootstrap === undefined) {
    delete process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP
  } else {
    process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP =
      originalEnableDeterministicBootstrap
  }

  if (originalEnableTeamBootstrapTool === undefined) {
    delete process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL
  } else {
    process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL =
      originalEnableTeamBootstrapTool
  }
})

describe('TeamBootstrapTool.validateInput', () => {
  test('builds hidden tool bootstrap specs with structured events disabled', () => {
    const spec = buildToolBootstrapSpec({
      mode: 'create',
      team_name: 'atlas-hq',
      members: [{ name: 'alice' }],
    })

    expect(spec.ui?.emitStructuredEvents).toBe(false)
  })

  test('omits provider default model sentinel from hidden tool bootstrap specs', () => {
    const spec = buildToolBootstrapSpec({
      mode: 'create',
      team_name: 'atlas-hq',
      members: [
        {
          name: 'alice',
          provider: 'codex',
          model: PROVIDER_DEFAULT_MODEL_SELECTION,
        },
      ],
    })

    expect(spec.members[0]?.provider).toBe('codex')
    expect(spec.members[0]?.model).toBeUndefined()
  })

  test('accepts ten minute bootstrap timeout in hidden tool schema', () => {
    const parsed = TeamBootstrapTool.inputSchema.safeParse({
      mode: 'launch',
      team_name: 'atlas-hq',
      bootstrap_timeout_ms: 600_000,
      members: [{ name: 'alice' }],
    })

    expect(parsed.success).toBe(true)
  })

  test('accepts up to twenty members in hidden tool schema', () => {
    const parsed = TeamBootstrapTool.inputSchema.safeParse({
      mode: 'launch',
      team_name: 'atlas-hq',
      members: Array.from({ length: 20 }, (_, index) => ({
        name: `member-${index + 1}`,
      })),
    })

    expect(parsed.success).toBe(true)
  })

  test('rejects more than twenty members in hidden tool schema', () => {
    const parsed = TeamBootstrapTool.inputSchema.safeParse({
      mode: 'launch',
      team_name: 'atlas-hq',
      members: Array.from({ length: 21 }, (_, index) => ({
        name: `member-${index + 1}`,
      })),
    })

    expect(parsed.success).toBe(false)
  })

  test('rejects OpenCode providers in the hidden primary bootstrap input schema', () => {
    const parsed = TeamBootstrapTool.inputSchema.safeParse({
      mode: 'launch',
      team_name: 'atlas-hq',
      members: [
        {
          name: 'bob',
          provider: 'opencode',
          model: 'openrouter/minimax-m2.5-free',
        },
      ],
    })

    expect(parsed.success).toBe(false)
    if (parsed.success) {
      throw new Error('expected hidden TeamBootstrap schema to reject OpenCode')
    }
    expect(parsed.error.message).toContain('Invalid option')
  })

  test('rejects Windows reserved team and member names', () => {
    expect(
      TeamBootstrapTool.inputSchema.safeParse({
        mode: 'create',
        team_name: 'con',
        members: [{ name: 'alice' }],
      }).success,
    ).toBe(false)

    expect(
      TeamBootstrapTool.inputSchema.safeParse({
        mode: 'create',
        team_name: 'atlas-hq',
        members: [{ name: 'NUL.txt' }],
      }).success,
    ).toBe(false)
  })

  test('disables the hidden tool when deterministic bootstrap kill switch is active', () => {
    process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL = '1'
    process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1'
    process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1'

    expect(TeamBootstrapTool.isEnabled()).toBe(false)
  })

  test('disables the hidden tool when deterministic bootstrap rollout flag is off', () => {
    process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL = '1'
    delete process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP
    delete process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP

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

  test('rejects invocation when deterministic bootstrap rollout flag is off', async () => {
    delete process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP
    delete process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP

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
      expect(result.message).toContain(
        'requires CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP=1',
      )
    }
  })

  test('rejects teammate or nested-agent invocation', async () => {
    process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1'
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
    process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1'
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
    process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1'
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
