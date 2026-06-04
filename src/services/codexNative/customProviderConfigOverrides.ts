import { getFlagSettingsInline } from '../../bootstrap/state.js'
import { getCodexForcedLoginMethod } from '../runtimeBackends/codexBackendResolver.js'

const CUSTOM_PROVIDER_SETTINGS_KEY = 'agent_teams_custom_provider'
const CONFIG_OVERRIDES_KEY = 'config_overrides'
const CUSTOM_PROVIDER_ID = 'agent_teams_custom'
const CUSTOM_PROVIDER_NAME = 'Agent Teams Custom'
const CODEX_API_KEY_ENV_KEY = 'CODEX_API_KEY'
const MAX_CUSTOM_PROVIDER_OVERRIDE_LENGTH = 2048
const MAX_CUSTOM_PROVIDER_OVERRIDES_TOTAL_LENGTH = 4096

const MODEL_PROVIDER_OVERRIDE = `model_provider="${CUSTOM_PROVIDER_ID}"`
const NAME_OVERRIDE = `model_providers.${CUSTOM_PROVIDER_ID}.name="${CUSTOM_PROVIDER_NAME}"`
const ENV_KEY_OVERRIDE = `model_providers.${CUSTOM_PROVIDER_ID}.env_key="${CODEX_API_KEY_ENV_KEY}"`
const WIRE_API_OVERRIDE = `model_providers.${CUSTOM_PROVIDER_ID}.wire_api="responses"`
const BASE_URL_OVERRIDE_PREFIX = `model_providers.${CUSTOM_PROVIDER_ID}.base_url=`
const JSON_STRING_PATTERN =
  /^"(?:[^"\\\x00-\x1F]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"$/

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getCustomProviderSettings(
  settingsInline: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const codexSettings = asRecord(settingsInline?.codex)
  return asRecord(codexSettings?.[CUSTOM_PROVIDER_SETTINGS_KEY])
}

function parseBaseUrlOverride(value: string): string | null {
  if (!value.startsWith(BASE_URL_OVERRIDE_PREFIX)) {
    return null
  }

  const rawString = value.slice(BASE_URL_OVERRIDE_PREFIX.length)
  if (!JSON_STRING_PATTERN.test(rawString)) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawString)
  } catch {
    return null
  }

  if (typeof parsed !== 'string') {
    return null
  }

  const baseUrl = parsed.trim()
  if (!baseUrl) {
    return null
  }

  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    if (url.username || url.password || url.search || url.hash) {
      return null
    }
  } catch {
    return null
  }

  return `${BASE_URL_OVERRIDE_PREFIX}${JSON.stringify(baseUrl)}`
}

function isBoundedOverride(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_CUSTOM_PROVIDER_OVERRIDE_LENGTH &&
    !value.includes('\0') &&
    !value.includes('\n') &&
    !value.includes('\r')
  )
}

export function buildCodexNativeCustomProviderConfigOverrides(params?: {
  settingsInline?: Record<string, unknown> | null
}): string[] {
  const settingsInline = params?.settingsInline ?? getFlagSettingsInline()
  if (getCodexForcedLoginMethod(settingsInline) !== 'api') {
    return []
  }

  const customProviderSettings = getCustomProviderSettings(settingsInline)
  const rawOverrides = customProviderSettings?.[CONFIG_OVERRIDES_KEY]
  if (!Array.isArray(rawOverrides)) {
    return []
  }

  let modelProviderOverride: string | null = null
  let nameOverride: string | null = null
  let baseUrlOverride: string | null = null
  let wireApiOverride: string | null = null
  let envKeyOverride: string | null = null
  let totalLength = 0

  for (const rawOverride of rawOverrides) {
    if (typeof rawOverride !== 'string' || !isBoundedOverride(rawOverride)) {
      continue
    }

    const nextTotalLength = totalLength + rawOverride.length
    if (nextTotalLength > MAX_CUSTOM_PROVIDER_OVERRIDES_TOTAL_LENGTH) {
      break
    }

    if (rawOverride === MODEL_PROVIDER_OVERRIDE) {
      modelProviderOverride ??= rawOverride
      totalLength = nextTotalLength
      continue
    }

    if (rawOverride === NAME_OVERRIDE) {
      nameOverride ??= rawOverride
      totalLength = nextTotalLength
      continue
    }

    if (rawOverride === WIRE_API_OVERRIDE) {
      wireApiOverride ??= rawOverride
      totalLength = nextTotalLength
      continue
    }

    if (rawOverride === ENV_KEY_OVERRIDE) {
      envKeyOverride ??= rawOverride
      totalLength = nextTotalLength
      continue
    }

    const parsedBaseUrlOverride = parseBaseUrlOverride(rawOverride)
    if (parsedBaseUrlOverride) {
      baseUrlOverride ??= parsedBaseUrlOverride
      totalLength = nextTotalLength
    }
  }

  if (
    !modelProviderOverride ||
    !nameOverride ||
    !baseUrlOverride ||
    !wireApiOverride ||
    !envKeyOverride
  ) {
    return []
  }

  return [
    modelProviderOverride,
    nameOverride,
    baseUrlOverride,
    wireApiOverride,
    envKeyOverride,
  ]
}
