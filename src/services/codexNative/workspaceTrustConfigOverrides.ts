import { getFlagSettingsInline } from '../../bootstrap/state.js'

const WORKSPACE_TRUST_SETTINGS_KEY = 'agent_teams_workspace_trust'
const CONFIG_OVERRIDES_KEY = 'config_overrides'
const MAX_WORKSPACE_TRUST_OVERRIDE_COUNT = 32
const MAX_WORKSPACE_TRUST_OVERRIDE_LENGTH = 1024
const MAX_WORKSPACE_TRUST_OVERRIDES_TOTAL_LENGTH = 8192

const CODEX_TRUSTED_PROJECT_OVERRIDE_PATTERN =
  /^projects\."(?:[^"\\\x00-\x1F]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))+?"\.trust_level="trusted"$/

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getWorkspaceTrustSettings(
  settingsInline: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const codexSettings = asRecord(settingsInline?.codex)
  return asRecord(codexSettings?.[WORKSPACE_TRUST_SETTINGS_KEY])
}

function isSafeWorkspaceTrustOverride(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_WORKSPACE_TRUST_OVERRIDE_LENGTH &&
    !value.includes('\0') &&
    !value.includes('\n') &&
    !value.includes('\r') &&
    CODEX_TRUSTED_PROJECT_OVERRIDE_PATTERN.test(value)
  )
}

export function buildCodexNativeWorkspaceTrustConfigOverrides(params?: {
  settingsInline?: Record<string, unknown> | null
}): string[] {
  const settingsInline = params?.settingsInline ?? getFlagSettingsInline()
  const workspaceTrustSettings = getWorkspaceTrustSettings(settingsInline)
  const rawOverrides = workspaceTrustSettings?.[CONFIG_OVERRIDES_KEY]
  if (!Array.isArray(rawOverrides)) {
    return []
  }

  const overrides: string[] = []
  let totalLength = 0
  for (const rawOverride of rawOverrides) {
    if (typeof rawOverride !== 'string') {
      continue
    }
    if (!isSafeWorkspaceTrustOverride(rawOverride)) {
      continue
    }
    if (overrides.includes(rawOverride)) {
      continue
    }
    const nextTotalLength = totalLength + rawOverride.length
    if (nextTotalLength > MAX_WORKSPACE_TRUST_OVERRIDES_TOTAL_LENGTH) {
      break
    }
    overrides.push(rawOverride)
    totalLength = nextTotalLength
    if (overrides.length >= MAX_WORKSPACE_TRUST_OVERRIDE_COUNT) {
      break
    }
  }
  return overrides
}
