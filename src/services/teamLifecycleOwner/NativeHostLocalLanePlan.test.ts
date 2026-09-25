import { describe, expect, test } from 'bun:test'

import {
  buildNativeBootstrapSpec,
  buildNativeLeadEnv,
  buildNativeMcpConfig,
  classifyNativeHostLocalPlan,
  NATIVE_LANE_BASE_ENV_ALLOWLIST,
} from './NativeHostLocalLanePlan.js'
import { assertProviderReady } from './NativeHostLocalLanePreflight.js'
import type { TeamLifecycleLaunchLane, TeamLifecycleLaunchPlan } from './TeamLifecycleLaunchPlan.js'

const both = new Set(['anthropic', 'codex'] as const)
const codexLane: TeamLifecycleLaunchLane = {
  laneId: 'lane_codex',
  kind: 'native',
  provider: 'codex',
  members: [
    { name: 'team-lead', prompt: 'Coordinate.', model: 'gpt-5.6-sol' },
    { name: 'reviewer', prompt: 'Review changes.', effort: 'medium' },
  ],
}

function plan(lanes: TeamLifecycleLaunchLane[]): TeamLifecycleLaunchPlan {
  return { schemaVersion: 2, workspaceId: 'w', teamId: 't', workspaceRoot: '/work', toolApprovalMode: 'auto', lanes }
}

describe('classifyNativeHostLocalPlan', () => {
  const options = { teamName: 'hosted-team', configuredProviders: both, platform: 'linux' as const }

  test('returns typed rejections for topologies outside the MVP slice', () => {
    const openCode: TeamLifecycleLaunchLane = {
      laneId: 'lane_oc', kind: 'opencode', provider: 'opencode', selectedModel: 'opencode/x',
      members: [{ name: 'helper', prompt: 'Help.' }],
    }
    const claudeWorker: TeamLifecycleLaunchLane = {
      laneId: 'lane_claude', kind: 'native', provider: 'anthropic', members: [{ name: 'worker', prompt: 'Work.' }],
    }
    expect(classifyNativeHostLocalPlan(plan([codexLane, openCode]), options)).toBe('native_lane_mixed_with_opencode')
    expect(classifyNativeHostLocalPlan(plan([codexLane, claudeWorker]), options)).toBe('native_lane_multiple_lanes')
    expect(classifyNativeHostLocalPlan(plan([{ ...codexLane, provider: 'gemini' }]), options))
      .toBe('native_lane_provider_unsupported')
    expect(classifyNativeHostLocalPlan(plan([codexLane]), { ...options, configuredProviders: new Set(['anthropic'] as const) }))
      .toBe('native_lane_provider_not_configured')
    expect(classifyNativeHostLocalPlan({ ...plan([codexLane]), toolApprovalMode: 'manual' }, options))
      .toBe('native_lane_manual_approval_unsupported')
    expect(classifyNativeHostLocalPlan(plan([codexLane]), { ...options, teamName: 'Hosted_Team' }))
      .toBe('native_lane_team_name_not_canonical')
    expect(classifyNativeHostLocalPlan(plan([codexLane]), { ...options, platform: 'win32' }))
      .toBe('native_lane_platform_unsupported')
    expect(classifyNativeHostLocalPlan(plan([{ ...codexLane, members: [{ name: 'user', prompt: 'x' },
      { name: 'team-lead', prompt: 'y' }] }]), options)).toBe('native_lane_member_name_invalid')
  })

  test('splits the lead from its teammates', () => {
    const shape = classifyNativeHostLocalPlan(plan([codexLane]), options)
    if (typeof shape === 'string') throw new Error(shape)
    expect(shape.provider).toBe('codex')
    expect(shape.lead.name).toBe('team-lead')
    expect(shape.teammates.map(member => member.name)).toEqual(['reviewer'])
    const spec = buildNativeBootstrapSpec({
      runId: 'run_1', teamName: 'hosted-team', workspaceRoot: '/work', mode: 'create', shape,
    })
    expect(spec.members).toEqual([{
      name: 'reviewer', workflow: 'Review changes.', cwd: '/work', provider: 'codex', effort: 'medium',
    }])
    expect(spec.launch).toEqual({ bootstrapTimeoutMs: 120_000, continueOnPartialFailure: true })
  })
})

describe('buildNativeLeadEnv', () => {
  const hostEnv = {
    HOME: '/home/op', PATH: '/usr/bin', LANG: 'C.UTF-8',
    ANTHROPIC_API_KEY: 'leak', OPENAI_API_KEY: 'leak', CODEX_API_KEY: 'leak', AWS_SECRET_ACCESS_KEY: 'leak',
    CLAUDE_CODE_OAUTH_TOKEN: 'leak', CLAUDE_CODE_USE_BEDROCK: '1', NODE_OPTIONS: '--require /tmp/x.js',
  }

  test('pins Codex routing without inheriting any host credential', () => {
    const env = buildNativeLeadEnv({
      hostEnv,
      claudeRoot: '/srv/claude',
      credentials: { provider: 'codex', codexHome: '/home/op/.codex', codexCliPath: '/opt/codex/bin/codex' },
    })
    expect(env).toEqual({
      HOME: '/home/op', PATH: '/usr/bin', LANG: 'C.UTF-8',
      CLAUDE_CONFIG_DIR: '/srv/claude',
      CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP: '1',
      CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES: '1',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_ENTRY_PROVIDER: 'codex',
      CLAUDE_TEAM_HOSTED_LEAD_INBOX_POLL: '1',
      CODEX_HOME: '/home/op/.codex',
      CODEX_CLI_PATH: '/opt/codex/bin/codex',
      CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
      CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
    })
  })

  test('allowlist never names a credential or runtime routing variable', () => {
    for (const key of NATIVE_LANE_BASE_ENV_ALLOWLIST) {
      expect(key).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CLAUDE|ANTHROPIC|OPENAI|CODEX|NODE_OPTIONS/)
    }
  })

  test('MCP config is stdio and carries the hosted Claude root', () => {
    expect(buildNativeMcpConfig({ command: '/opt/node', args: ['/opt/mcp/index.js'], env: { A: 'b' } }, '/srv/claude'))
      .toEqual({ mcpServers: { 'agent-teams': {
        type: 'stdio', command: '/opt/node', args: ['/opt/mcp/index.js'],
        env: { A: 'b', AGENT_TEAMS_MCP_CLAUDE_DIR: '/srv/claude' },
      } } })
  })
})

describe('assertProviderReady', () => {
  const status = (provider: Record<string, unknown>) => ({ providers: { codex: provider } })

  test('classifies authentication separately from launch capability', () => {
    expect(() => assertProviderReady(status({
      supported: true, authenticated: false, capabilities: { teamLaunch: false },
    }), 'codex')).toThrow(expect.objectContaining({ code: 'native_lane_provider_not_authenticated' }))
    expect(() => assertProviderReady(status({
      supported: true, authenticated: true, capabilities: { teamLaunch: false },
    }), 'codex')).toThrow(expect.objectContaining({ code: 'native_lane_provider_preflight_failed' }))
    expect(() => assertProviderReady({ providers: {} }, 'codex'))
      .toThrow(expect.objectContaining({ code: 'native_lane_provider_preflight_failed' }))
    expect(() => assertProviderReady(status({
      supported: true, authenticated: true, capabilities: { teamLaunch: true },
    }), 'codex')).not.toThrow()
  })
})
