import { describe, expect, test } from 'bun:test'

import { buildCodexNativeLaunchConfigOverrides } from './launchConfigOverrides.js'

describe('Codex native launch config overrides', () => {
  test('reads safe app-owned launch overrides from settings', () => {
    expect(
      buildCodexNativeLaunchConfigOverrides({
        settingsInline: {
          codex: {
            agent_teams_launch_config: {
              config_overrides: [
                'service_tier="flex"',
                'service_tier="fast"',
                'features.fast_mode=true',
                'forced_login_method="api"',
                'service_tier="fast"',
              ],
            },
          },
        },
      }),
    ).toEqual([
      'service_tier="flex"',
      'service_tier="fast"',
      'features.fast_mode=true',
    ])
  })

  test('ignores malformed settings', () => {
    expect(
      buildCodexNativeLaunchConfigOverrides({
        settingsInline: {
          codex: {
            agent_teams_launch_config: {
              config_overrides: 'service_tier="fast"',
            },
          },
        },
      }),
    ).toEqual([])
  })
})
