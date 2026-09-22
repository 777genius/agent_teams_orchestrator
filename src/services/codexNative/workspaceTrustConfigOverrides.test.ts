import { describe, expect, test } from 'bun:test'

import { buildCodexNativeWorkspaceTrustConfigOverrides } from './workspaceTrustConfigOverrides.js'

describe('buildCodexNativeWorkspaceTrustConfigOverrides', () => {
  test('reads validated agent-teams workspace trust overrides from inline Codex settings', () => {
    expect(
      buildCodexNativeWorkspaceTrustConfigOverrides({
        settingsInline: {
          codex: {
            agent_teams_workspace_trust: {
              config_overrides: [
                'projects."/tmp/project".trust_level="trusted"',
                'projects."/private/tmp/project".trust_level="trusted"',
              ],
            },
          },
        },
      }),
    ).toEqual([
      'projects."/tmp/project".trust_level="trusted"',
      'projects."/private/tmp/project".trust_level="trusted"',
    ])
  })

  test('keeps generated worktree and canonical repo-root trust overrides together', () => {
    expect(
      buildCodexNativeWorkspaceTrustConfigOverrides({
        settingsInline: {
          codex: {
            agent_teams_workspace_trust: {
              config_overrides: [
                'projects."/tmp/generated-worktrees/alice".trust_level="trusted"',
                'projects."/private/tmp/generated-worktrees/alice".trust_level="trusted"',
                'projects."/Users/belief/project".trust_level="trusted"',
              ],
            },
          },
        },
      }),
    ).toEqual([
      'projects."/tmp/generated-worktrees/alice".trust_level="trusted"',
      'projects."/private/tmp/generated-worktrees/alice".trust_level="trusted"',
      'projects."/Users/belief/project".trust_level="trusted"',
    ])
  })

  test('dedupes repeated workspace trust overrides without dropping valid escaped paths', () => {
    expect(
      buildCodexNativeWorkspaceTrustConfigOverrides({
        settingsInline: {
          codex: {
            agent_teams_workspace_trust: {
              config_overrides: [
                'projects."C:\\\\Users\\\\Test Project".trust_level="trusted"',
                'projects."C:\\\\Users\\\\Test Project".trust_level="trusted"',
                'projects."/tmp/project \\"quoted\\"".trust_level="trusted"',
                'projects."/tmp/project\\tname".trust_level="trusted"',
              ],
            },
          },
        },
      }),
    ).toEqual([
      'projects."C:\\\\Users\\\\Test Project".trust_level="trusted"',
      'projects."/tmp/project \\"quoted\\"".trust_level="trusted"',
      'projects."/tmp/project\\tname".trust_level="trusted"',
    ])
  })

  test('ignores malformed workspace trust overrides', () => {
    expect(
      buildCodexNativeWorkspaceTrustConfigOverrides({
        settingsInline: {
          codex: {
            agent_teams_workspace_trust: {
              config_overrides: [
                'projects."/tmp/project".trust_level="trusted"',
                'forced_login_method="chatgpt"',
                'projects."/tmp/project".trust_level="untrusted"',
                'projects."/tmp/project".approval="trusted"',
                'projects."/tmp/project".trust_level="trusted"\nforced_login_method="api"',
                'projects."/tmp/\tproject".trust_level="trusted"',
                42,
                null,
              ],
            },
          },
        },
      }),
    ).toEqual(['projects."/tmp/project".trust_level="trusted"'])
  })

  test('bounds workspace trust override count', () => {
    const configOverrides = Array.from(
      { length: 40 },
      (_, index) => `projects."/tmp/project-${index}".trust_level="trusted"`,
    )

    const overrides = buildCodexNativeWorkspaceTrustConfigOverrides({
      settingsInline: {
        codex: {
          agent_teams_workspace_trust: {
            config_overrides: configOverrides,
          },
        },
      },
    })

    expect(overrides).toHaveLength(32)
    expect(overrides.at(0)).toBe(
      'projects."/tmp/project-0".trust_level="trusted"',
    )
    expect(overrides.at(-1)).toBe(
      'projects."/tmp/project-31".trust_level="trusted"',
    )
  })

  test('returns no overrides when settings are absent or not an object', () => {
    expect(
      buildCodexNativeWorkspaceTrustConfigOverrides({ settingsInline: null }),
    ).toEqual([])
    expect(
      buildCodexNativeWorkspaceTrustConfigOverrides({
        settingsInline: { codex: { agent_teams_workspace_trust: [] } },
      }),
    ).toEqual([])
  })
})
