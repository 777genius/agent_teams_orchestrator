import { getFlagSettingsInline } from '../../bootstrap/state.js'

const LAUNCH_CONFIG_SETTINGS_KEY = 'agent_teams_launch_config'
const CONFIG_OVERRIDES_KEY = 'config_overrides'
const FAST_SERVICE_TIER_OVERRIDE = 'service_tier="fast"'
const FAST_MODE_FEATURE_OVERRIDE = 'features.fast_mode=true'
const SAFE_LAUNCH_CONFIG_OVERRIDES = new Set([
  FAST_SERVICE_TIER_OVERRIDE,
  FAST_MODE_FEATURE_OVERRIDE,
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

  let hasFastServiceTier = false
  let hasFastModeFeature = false
  for (const rawOverride of rawOverrides) {
    if (typeof rawOverride !== 'string') {
      continue
    }
    if (!SAFE_LAUNCH_CONFIG_OVERRIDES.has(rawOverride)) {
      continue
    }
    if (rawOverride === FAST_SERVICE_TIER_OVERRIDE) {
      hasFastServiceTier = true
    }
    if (rawOverride === FAST_MODE_FEATURE_OVERRIDE) {
      hasFastModeFeature = true
    }
  }

  return hasFastServiceTier && hasFastModeFeature
    ? [FAST_SERVICE_TIER_OVERRIDE, FAST_MODE_FEATURE_OVERRIDE]
    : []
}
