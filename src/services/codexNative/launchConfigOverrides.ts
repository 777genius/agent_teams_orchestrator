import { getFlagSettingsInline } from '../../bootstrap/state.js'

const LAUNCH_CONFIG_SETTINGS_KEY = 'agent_teams_launch_config'
const CONFIG_OVERRIDES_KEY = 'config_overrides'
const MAX_LAUNCH_CONFIG_OVERRIDE_COUNT = 8
const SAFE_LAUNCH_CONFIG_OVERRIDES = new Set([
  'service_tier="flex"',
  'service_tier="fast"',
  'features.fast_mode=true',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getLaunchConfigSettings(
  settingsInline: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const codexSettings = asRecord(settingsInline?.codex)
  return asRecord(codexSettings?.[LAUNCH_CONFIG_SETTINGS_KEY])
}

export function buildCodexNativeLaunchConfigOverrides(params?: {
  settingsInline?: Record<string, unknown> | null
}): string[] {
  const settingsInline = params?.settingsInline ?? getFlagSettingsInline()
  const launchConfigSettings = getLaunchConfigSettings(settingsInline)
  const rawOverrides = launchConfigSettings?.[CONFIG_OVERRIDES_KEY]
  if (!Array.isArray(rawOverrides)) {
    return []
  }

  const overrides: string[] = []
  for (const rawOverride of rawOverrides) {
    if (typeof rawOverride !== 'string') {
      continue
    }
    if (!SAFE_LAUNCH_CONFIG_OVERRIDES.has(rawOverride)) {
      continue
    }
    if (overrides.includes(rawOverride)) {
      continue
    }
    overrides.push(rawOverride)
    if (overrides.length >= MAX_LAUNCH_CONFIG_OVERRIDE_COUNT) {
      break
    }
  }
  return overrides
}
